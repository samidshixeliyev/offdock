package handlers

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	authmw "offdock/internal/middleware"
	"offdock/internal/store"
)

func newSpanID() string {
	b := make([]byte, 4)
	rand.Read(b) //nolint:errcheck
	return hex.EncodeToString(b)
}

// toTraceEvent converts an ephemeral TraceSpan into a persistable store.TraceEvent.
func toTraceEvent(ev TraceSpan) store.TraceEvent {
	return store.TraceEvent{
		Time:         ev.Time,
		Type:         string(ev.Type),
		Method:       ev.Method,
		Path:         ev.Path,
		Host:         ev.Host,
		Status:       ev.Status,
		DurationMs:   ev.DurationMs,
		Query:        ev.Query,
		DBType:       ev.DBType,
		Src:          ev.Src,
		Dst:          ev.Dst,
		DstPort:      ev.DstPort,
		Message:      ev.Message,
		SpanID:       ev.SpanID,
		ParentSpanID: ev.ParentSpanID,
		TableName:    ev.TableName,
		RowsAffected: ev.RowsAffected,
	}
}

// ─── Types ────────────────────────────────────────────────────────────────────

type TraceEventType string

const (
	TraceHTTPReq  TraceEventType = "http_req"
	TraceHTTPResp TraceEventType = "http_resp"
	TraceSQL      TraceEventType = "sql"
	TraceRedis    TraceEventType = "redis"
	TraceInfo     TraceEventType = "info"
	TraceError    TraceEventType = "error"
)

type TraceSpan struct {
	Time         string         `json:"time"`
	Type         TraceEventType `json:"type"`
	Method       string         `json:"method,omitempty"`
	Path         string         `json:"path,omitempty"`
	Host         string         `json:"host,omitempty"`
	Status       int            `json:"status,omitempty"`
	DurationMs   float64        `json:"duration_ms,omitempty"`
	Query        string         `json:"query,omitempty"`
	DBType       string         `json:"db_type,omitempty"`
	Src          string         `json:"src,omitempty"`
	Dst          string         `json:"dst,omitempty"`
	DstPort      int            `json:"dst_port,omitempty"`
	Message      string         `json:"message,omitempty"`
	// Span correlation
	SpanID       string         `json:"span_id,omitempty"`
	ParentSpanID string         `json:"parent_span_id,omitempty"`
	// SQL enrichment
	TableName    string         `json:"table_name,omitempty"`
	RowsAffected int            `json:"rows_affected,omitempty"`
}

// ─── In-memory trace enable/disable registry ─────────────────────────────────

var traceRegistry = struct {
	mu      sync.RWMutex
	enabled map[string]bool
}{enabled: make(map[string]bool)}

func (h *H) EnableContainerTrace(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	traceRegistry.mu.Lock()
	traceRegistry.enabled[name] = true
	traceRegistry.mu.Unlock()
	h.logAudit(r, "enable_trace", "container", name, name, "")
	writeJSON(w, http.StatusOK, map[string]any{"status": "enabled", "container": name})
}

func (h *H) DisableContainerTrace(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	traceRegistry.mu.Lock()
	delete(traceRegistry.enabled, name)
	traceRegistry.mu.Unlock()
	h.logAudit(r, "disable_trace", "container", name, name, "")
	w.WriteHeader(http.StatusNoContent)
}

func (h *H) GetTraceStatus(w http.ResponseWriter, r *http.Request) {
	traceRegistry.mu.RLock()
	names := make([]string, 0, len(traceRegistry.enabled))
	for k, v := range traceRegistry.enabled {
		if v {
			names = append(names, k)
		}
	}
	traceRegistry.mu.RUnlock()
	writeJSON(w, http.StatusOK, map[string]any{"traced": names})
}

// ─── Discover container bridge interface ──────────────────────────────────────

// containerBridgeIface finds the host-side bridge interface for a container
// by inspecting its network and matching to bridge interfaces on the host.
// Returns the bridge interface name (e.g. "br-cff92ed07dc1") and the
// container's IP address.
func containerBridgeIface(containerName string) (iface, containerIP string, err error) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	// Get network ID and IP from docker inspect.
	out, err := exec.CommandContext(ctx, "docker", "inspect",
		"--format", "{{range .NetworkSettings.Networks}}{{.NetworkID}} {{.IPAddress}}\n{{end}}",
		containerName,
	).Output()
	if err != nil {
		return "", "", fmt.Errorf("docker inspect: %w", err)
	}

	var networkID, containerIPAddr string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		parts := strings.Fields(line)
		if len(parts) == 2 && parts[1] != "" {
			networkID = parts[0][:12] // short network ID (12 chars)
			containerIPAddr = parts[1]
			break
		}
	}
	if networkID == "" || containerIPAddr == "" {
		return "", "", fmt.Errorf("container has no network or IP")
	}

	// The bridge interface is named "br-<12-char-network-id>".
	bridgeIface := "br-" + networkID

	// Verify the interface exists.
	checkCtx, checkCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer checkCancel()
	if out, err := exec.CommandContext(checkCtx, "ip", "link", "show", bridgeIface).Output(); err != nil || len(out) == 0 {
		// Try docker0 as fallback for default bridge.
		if _, err2 := exec.CommandContext(checkCtx, "ip", "link", "show", "docker0").Output(); err2 == nil {
			bridgeIface = "docker0"
		} else {
			return "", "", fmt.Errorf("bridge interface %s not found", bridgeIface)
		}
	}

	return bridgeIface, containerIPAddr, nil
}

// ─── SSE trace stream ─────────────────────────────────────────────────────────

var ipHdrRe = regexp.MustCompile(`IP (\d+\.\d+\.\d+\.\d+)\.(\S+) > (\d+\.\d+\.\d+\.\d+)\.(\S+):`)

var portNames = map[string]int{
	"http": 80, "https": 443, "http-alt": 8080,
	"mysql": 3306, "postgresql": 5432, "postgres": 5432,
	"redis": 6379, "mongodb": 27017,
}

func resolvePort(s string) int {
	if n, err := strconv.Atoi(s); err == nil {
		return n
	}
	return portNames[strings.ToLower(s)]
}

// ContainerTrace streams live multi-protocol traces from a container's network
// traffic. Uses tcpdump on the container's bridge interface — no nsenter needed,
// works on standard Linux without special capabilities beyond CAP_NET_RAW (root).
func (h *H) ContainerTrace(w http.ResponseWriter, r *http.Request) {
	if authmw.ClaimsFromContext(r.Context()) == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	name := chi.URLParam(r, "name")

	// Verify container is running.
	checkCtx, checkCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer checkCancel()
	pidOut, err := exec.CommandContext(checkCtx, "docker", "inspect",
		"--format", "{{.State.Running}}", name).Output()
	if err != nil || strings.TrimSpace(string(pidOut)) != "true" {
		http.Error(w, "container not found or not running", http.StatusNotFound)
		return
	}

	// Find bridge interface and container IP.
	iface, containerIP, err := containerBridgeIface(name)
	if err != nil {
		http.Error(w, "could not find container network: "+err.Error(), http.StatusUnprocessableEntity)
		return
	}

	// SSE setup.
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	// Build a persistent trace session that captures every event. It is saved
	// to the DB when the stream closes (client disconnect, stop, or error).
	session := store.TraceSession{
		ID:            store.NewULID(),
		ContainerName: name,
		StartedAt:     time.Now().UTC(),
	}
	var sessionMu sync.Mutex
	saved := false
	saveSession := func() {
		sessionMu.Lock()
		defer sessionMu.Unlock()
		if saved {
			return
		}
		saved = true
		now := time.Now().UTC()
		session.EndedAt = &now
		session.EventCount = len(session.Events)
		// Only persist sessions that captured real protocol events (skip
		// sessions that only ever saw the info banner).
		if session.EventCount == 0 {
			return
		}
		_ = h.db.TraceSessions.Save(session)
	}
	defer saveSession()

	send := func(ev TraceSpan) {
		if ev.Time == "" {
			ev.Time = time.Now().UTC().Format("15:04:05.000")
		}
		// Persist every captured protocol event (skip the info banner / heartbeats).
		if ev.Type != TraceInfo {
			sessionMu.Lock()
			session.Events = append(session.Events, toTraceEvent(ev))
			sessionMu.Unlock()
		}
		b, _ := json.Marshal(ev)
		fmt.Fprintf(w, "data: %s\n\n", b)
		flusher.Flush()
	}

	send(TraceSpan{
		Type:    TraceInfo,
		Message: fmt.Sprintf("Tracing %s on %s (IP: %s)", name, iface, containerIP),
	})

	traceCtx, traceCancel := context.WithCancel(r.Context())
	defer traceCancel()

	// Run tcpdump on the bridge interface, filtering only this container's IP.
	// -A: ASCII output; -nn: no name resolution; -s 2048: capture 2KB per packet.
	cmd := exec.CommandContext(traceCtx,
		"tcpdump", "-i", iface, "-l", "-s", "2048", "-A", "-nn",
		"host", containerIP, "and", "tcp",
	)
	cmd.Stderr = nil
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		send(TraceSpan{Type: TraceError, Message: "pipe error: " + err.Error()})
		return
	}
	if err := cmd.Start(); err != nil {
		send(TraceSpan{Type: TraceError, Message: "tcpdump failed to start: " + err.Error() +
			" (offdock must run as root or have CAP_NET_RAW)"})
		return
	}
	defer func() {
		traceCancel()
		cmd.Process.Kill() //nolint:errcheck
		cmd.Wait()         //nolint:errcheck
	}()

	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()

	lines := make(chan string, 512)
	go func() {
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 131072), 131072)
		for sc.Scan() {
			select {
			case lines <- sc.Text():
			case <-traceCtx.Done():
				return
			}
		}
		close(lines)
	}()

	// Request correlator for HTTP timing and span correlation.
	type openReq struct {
		method, path, host string
		spanID             string
		t                  time.Time
	}
	openReqs := make(map[string]openReq)
	// activeSpan tracks the most recent http_req span_id per src endpoint,
	// so SQL/Redis spans can be parented to it.
	activeSpan := make(map[string]string) // srcIP:srcPort -> spanID

	type pkt struct {
		srcIP, dstIP     string
		srcPort, dstPort int
		lines            []string
		ts               string
		wallT            time.Time
	}
	var cur *pkt
	done := r.Context().Done()

	flush := func(p *pkt) {
		if p == nil || len(p.lines) == 0 {
			return
		}
		payload := strings.Join(p.lines, "\n")
		ev := analyze(payload, p.srcIP, p.srcPort, p.dstIP, p.dstPort)
		if ev == nil {
			return
		}
		ev.Time = p.ts

		connKey := fmt.Sprintf("%s:%d->%s:%d", p.srcIP, p.srcPort, p.dstIP, p.dstPort)
		revKey := fmt.Sprintf("%s:%d->%s:%d", p.dstIP, p.dstPort, p.srcIP, p.srcPort)
		srcEndpoint := fmt.Sprintf("%s:%d", p.srcIP, p.srcPort)

		switch ev.Type {
		case TraceHTTPReq:
			ev.SpanID = newSpanID()
			openReqs[connKey] = openReq{
				method: ev.Method, path: ev.Path, host: ev.Host,
				spanID: ev.SpanID, t: p.wallT,
			}
			activeSpan[srcEndpoint] = ev.SpanID

		case TraceHTTPResp:
			if req, ok := openReqs[revKey]; ok {
				ev.DurationMs = float64(p.wallT.Sub(req.t).Milliseconds())
				ev.ParentSpanID = req.spanID
				delete(openReqs, revKey)
			}
			// Parse rows_affected from PostgreSQL CommandComplete e.g. "C....SELECT 4"
			if rows := parseRowsAffected(payload); rows > 0 {
				ev.RowsAffected = rows
			}

		case TraceSQL:
			// Attach to the most recent active HTTP span for the connection.
			if spanID, ok := activeSpan[srcEndpoint]; ok {
				ev.ParentSpanID = spanID
			}
			ev.SpanID = newSpanID()
			// Extract table name and rows affected.
			ev.TableName = extractTableName(ev.Query)
			if rows := parseRowsAffectedFromSQL(payload); rows > 0 {
				ev.RowsAffected = rows
			}
		}

		// Expire stale open requests.
		for k, v := range openReqs {
			if time.Since(v.t) > 30*time.Second {
				delete(openReqs, k)
			}
		}
		send(*ev)
	}

	for {
		select {
		case <-done:
			return
		case <-heartbeat.C:
			fmt.Fprintf(w, ": ping\n\n")
			flusher.Flush()
		case line, ok := <-lines:
			if !ok {
				return
			}
			if m := ipHdrRe.FindStringSubmatch(line); m != nil {
				flush(cur)
				cur = &pkt{
					srcIP:   m[1],
					srcPort: resolvePort(m[2]),
					dstIP:   m[3],
					dstPort: resolvePort(m[4]),
					ts:      extractTimestamp(line),
					wallT:   time.Now(),
				}
			} else if cur != nil && isPrintablish(line) {
				cur.lines = append(cur.lines, line)
				if len(cur.lines) > 100 {
					flush(cur)
					cur = nil
				}
			}
		}
	}
}

// ─── Multi-protocol analysis ──────────────────────────────────────────────────

var (
	httpReqRe  = regexp.MustCompile(`(?m)(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|CONNECT) (/\S*) HTTP/[\d.]+`)
	httpRespRe = regexp.MustCompile(`(?m)HTTP/[\d.]+ (\d{3})`)
	hostHdrRe  = regexp.MustCompile(`(?im)^Host:\s*(\S+)`)
	// PostgreSQL CommandComplete: "C....<command> <rows>" e.g. "C....SELECT 4" "C....UPDATE 3"
	pgCmdRe = regexp.MustCompile(`C\.*\s*(SELECT|INSERT\s+\d+|UPDATE|DELETE)\s+(\d+)`)
	// Table name extraction
	tableRe = regexp.MustCompile(`(?i)(?:FROM|INTO|UPDATE|JOIN)\s+["` + "`" + `]?(\w+)["` + "`" + `]?`)
)

func analyze(payload, srcIP string, srcPort int, dstIP string, dstPort int) *TraceSpan {
	src := fmt.Sprintf("%s:%d", srcIP, srcPort)
	dst := fmt.Sprintf("%s:%d", dstIP, dstPort)

	// ── HTTP ──────────────────────────────────────────────────────────────────
	if m := httpReqRe.FindStringSubmatch(payload); m != nil {
		ev := &TraceSpan{Type: TraceHTTPReq, Method: m[1], Path: m[2], Src: src, Dst: dst}
		if hm := hostHdrRe.FindStringSubmatch(payload); hm != nil {
			ev.Host = hm[1]
		}
		return ev
	}
	if m := httpRespRe.FindStringSubmatch(payload); m != nil {
		status, _ := strconv.Atoi(m[1])
		return &TraceSpan{Type: TraceHTTPResp, Status: status, Src: src, Dst: dst}
	}

	// ── PostgreSQL (port 5432) ─────────────────────────────────────────────────
	if dstPort == 5432 || srcPort == 5432 {
		pgKeywords := []string{
			"SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER",
			"BEGIN", "COMMIT", "ROLLBACK", "WITH", "CALL", "EXECUTE", "MERGE",
			"TRUNCATE", "EXPLAIN",
		}
		if q := extractPostgresExtended(payload, pgKeywords); q != "" {
			return &TraceSpan{Type: TraceSQL, DBType: "postgresql", Query: cleanSQL(q), Src: src, Dst: dst, DstPort: dstPort}
		}
		if q := extractSQL(payload, pgKeywords); q != "" {
			return &TraceSpan{Type: TraceSQL, DBType: "postgresql", Query: cleanSQL(q), Src: src, Dst: dst, DstPort: dstPort}
		}
	}

	// ── MySQL (port 3306) ──────────────────────────────────────────────────────
	if dstPort == 3306 || srcPort == 3306 {
		if q := extractMySQL(payload); q != "" {
			return &TraceSpan{Type: TraceSQL, DBType: "mysql", Query: cleanSQL(q), Src: src, Dst: dst, DstPort: dstPort}
		}
	}

	// ── MSSQL / SQL Server (port 1433) ─────────────────────────────────────────
	if dstPort == 1433 || srcPort == 1433 {
		if q := extractMSSQL(payload); q != "" {
			return &TraceSpan{Type: TraceSQL, DBType: "mssql", Query: cleanSQL(q), Src: src, Dst: dst, DstPort: dstPort}
		}
	}

	// ── Redis (port 6379) ──────────────────────────────────────────────────────
	if dstPort == 6379 || srcPort == 6379 {
		if cmd := extractRedis(payload); cmd != "" {
			return &TraceSpan{Type: TraceRedis, DBType: "redis", Query: cmd, Src: src, Dst: dst, DstPort: dstPort}
		}
	}

	// ── MongoDB (port 27017) — detect OP_MSG queries ─────────────────────────
	if dstPort == 27017 || srcPort == 27017 {
		if q := extractMongoDB(payload); q != "" {
			return &TraceSpan{Type: TraceSQL, DBType: "mongodb", Query: q, Src: src, Dst: dst, DstPort: dstPort}
		}
	}

	return nil
}

// cleanSQL normalizes whitespace. Does NOT truncate — full queries are always shown.
// String literals and numbers are NOT masked here so the user can see exact queries
// and procedure calls. The frontend handles display length.
func cleanSQL(q string) string {
	return strings.Join(strings.Fields(q), " ")
}

// extractTableName extracts the first table name from a SQL query.
func extractTableName(query string) string {
	if m := tableRe.FindStringSubmatch(query); len(m) > 1 {
		t := strings.ToLower(m[1])
		// Skip PostgreSQL catalog/system tables.
		if strings.HasPrefix(t, "pg_") || t == "information_schema" {
			return ""
		}
		return t
	}
	return ""
}

// parseRowsAffected parses row counts from PostgreSQL CommandComplete messages.
// Format in tcpdump: "C....UPDATE 3" "C....SELECT 4" "C....INSERT 0 1"
func parseRowsAffected(payload string) int {
	if m := pgCmdRe.FindStringSubmatch(payload); len(m) > 2 {
		// For INSERT the format is "INSERT 0 N", we want N.
		parts := strings.Fields(m[0])
		last := parts[len(parts)-1]
		n, _ := strconv.Atoi(last)
		return n
	}
	return 0
}

// parseRowsAffectedFromSQL tries to parse rows affected from the query result payload.
func parseRowsAffectedFromSQL(payload string) int {
	return parseRowsAffected(payload)
}

// extractMySQL handles MySQL wire protocol COM_QUERY (0x03) and
// COM_STMT_PREPARE (0x16) packets.
// MySQL packet: [3B len][1B seq][1B cmd][query text]
// In ASCII tcpdump the 0x03 byte appears as a non-printable, followed by SQL text.
func extractMySQL(payload string) string {
	mysqlKeywords := []string{
		"SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER",
		"BEGIN", "COMMIT", "ROLLBACK", "SHOW", "USE", "DESCRIBE", "EXPLAIN",
		"SET", "CALL", "START TRANSACTION", "TRUNCATE",
	}
	upper := strings.ToUpper(payload)
	for _, kw := range mysqlKeywords {
		idx := strings.Index(upper, kw)
		if idx < 0 {
			continue
		}
		if idx > 0 {
			prev := payload[idx-1]
			if (prev >= 'A' && prev <= 'Z') || (prev >= 'a' && prev <= 'z') || (prev >= '0' && prev <= '9') {
				continue
			}
		}
		// For MySQL, the query starts right after the command byte (0x03).
		// Check the preceding byte — it should be 0x03 or a non-printable.
		if idx >= 1 {
			pre := payload[idx-1]
			// Accept if preceded by non-alphanumeric (header byte, dot, space).
			isValid := !((pre >= 'A' && pre <= 'Z') || (pre >= 'a' && pre <= 'z') || (pre >= '0' && pre <= '9'))
			if !isValid {
				continue
			}
		}
		q := extractPrintableFrom(payload[idx:], 16384)
		if q = strings.TrimSpace(q); len(q) > 3 {
			return q
		}
	}
	return ""
}

// extractMSSQL handles Microsoft TDS (Tabular Data Stream) protocol.
// TDS SQL Batch (type 0x01): 8-byte header then raw UTF-16LE or ASCII SQL.
// TDS RPC (type 0x03): stored procedure call.
// In tcpdump ASCII output, the SQL text appears after header bytes.
func extractMSSQL(payload string) string {
	mssqlKeywords := []string{
		"SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER",
		"EXEC", "EXECUTE", "MERGE", "WITH", "BEGIN TRAN", "COMMIT TRAN",
		"ROLLBACK", "TRUNCATE", "DECLARE", "SET", "IF ", "WHILE",
	}
	upper := strings.ToUpper(payload)

	// TDS packets often contain UTF-16LE encoded SQL — detect by looking for
	// interleaved null bytes: "S\x00E\x00L\x00E\x00C\x00T\x00"
	if strings.Contains(payload, "\x00S\x00E\x00L\x00") ||
		strings.Contains(payload, "\x00I\x00N\x00S\x00") ||
		strings.Contains(payload, "\x00U\x00P\x00D\x00") {
		// Decode UTF-16LE by keeping only the ASCII bytes (skip nulls).
		var decoded strings.Builder
		for i := 0; i < len(payload)-1; i += 2 {
			c := payload[i]
			if c >= 0x20 && c <= 0x7e {
				decoded.WriteByte(c)
			} else if c == '\n' || c == '\r' || c == '\t' {
				decoded.WriteByte(' ')
			}
		}
		decoded16 := decoded.String()
		upper16 := strings.ToUpper(decoded16)
		for _, kw := range mssqlKeywords {
			idx := strings.Index(upper16, kw)
			if idx < 0 {
				continue
			}
			if idx > 0 {
				prev := decoded16[idx-1]
				if (prev >= 'A' && prev <= 'Z') || (prev >= 'a' && prev <= 'z') || (prev >= '0' && prev <= '9') {
					continue
				}
			}
			q := strings.TrimSpace(decoded16[idx:])
			if len(q) > 3 {
				return q
			}
		}
	}

	// ASCII / single-byte SQL (some MSSQL drivers send ASCII).
	for _, kw := range mssqlKeywords {
		idx := strings.Index(upper, kw)
		if idx < 0 {
			continue
		}
		if idx > 0 {
			prev := payload[idx-1]
			if (prev >= 'A' && prev <= 'Z') || (prev >= 'a' && prev <= 'z') || (prev >= '0' && prev <= '9') {
				continue
			}
		}
		q := extractPrintableFrom(payload[idx:], 16384)
		if q = strings.TrimSpace(q); len(q) > 3 {
			return q
		}
	}
	return ""
}

// extractMongoDB detects MongoDB OP_MSG queries in payload.
// OP_MSG opcode = 2013 (0x7DD in little-endian). In ASCII we look for
// "find", "insert", "update", "delete", "aggregate" collection operation keys.
func extractMongoDB(payload string) string {
	mongoKeywords := []string{`"find"`, `"insert"`, `"update"`, `"delete"`, `"aggregate"`, `"count"`, `"distinct"`}
	for _, kw := range mongoKeywords {
		if idx := strings.Index(payload, kw); idx >= 0 {
			// Extract up to 500 chars of the JSON body.
			end := idx + 500
			if end > len(payload) {
				end = len(payload)
			}
			q := extractPrintableFrom(payload[idx:end], 500)
			if q = strings.TrimSpace(q); len(q) > 3 {
				return q
			}
		}
	}
	return ""
}

// extractPostgresExtended handles the PostgreSQL Extended Query Protocol
// used by asyncpg, psycopg3, JDBC, and most modern drivers.
// Format: P<len4><stmt_name>\0<sql_text>\0
// In ASCII tcpdump output this appears as: P...__stmt_name__.<SQL text>
// We strip the statement name prefix to return clean SQL.
func extractPostgresExtended(payload string, keywords []string) string {
	// Look for the pattern: after "P" and some binary bytes, find an asyncpg/JDBC
	// statement name like "__asyncpg_stmt_N__." or "S1." or just a null-byte boundary.
	// Strategy: find the keyword in the payload, then walk backwards to confirm
	// we're past a statement-name boundary (null byte or known prefix).
	upper := strings.ToUpper(payload)
	for _, kw := range keywords {
		idx := strings.Index(upper, kw)
		if idx < 0 {
			continue
		}
		if idx > 0 {
			prev := payload[idx-1]
			// Check prev char is not alphanumeric (avoid false positives mid-word)
			if (prev >= 'A' && prev <= 'Z') || (prev >= 'a' && prev <= 'z') || (prev >= '0' && prev <= '9') {
				continue
			}
			// Must be preceded by a dot, null, or whitespace (statement name boundary)
			if prev != '.' && prev != 0 && prev != ' ' && prev != '\n' && prev != '\r' {
				// Relax: also allow if within 32 bytes of a 'P' byte (Parse message start)
				start := idx - 32
				if start < 0 {
					start = 0
				}
				hasPMsg := strings.ContainsRune(payload[start:idx], 'P')
				if !hasPMsg {
					continue
				}
			}
		}
		q := extractPrintableFrom(payload[idx:], 16384)
		// Clean up: remove trailing asyncpg metadata that follows the null-terminated SQL
		if q = strings.TrimSpace(q); len(q) > 3 {
			// Remove any trailing "...D....S__asyncpg_stmt_..." noise
			if cut := strings.Index(q, "...D"); cut > 10 {
				q = strings.TrimSpace(q[:cut])
			}
			if cut := strings.Index(q, "\x00"); cut > 3 {
				q = strings.TrimSpace(q[:cut])
			}
			return q
		}
	}
	return ""
}

func extractSQL(payload string, keywords []string) string {
	upper := strings.ToUpper(payload)
	for _, kw := range keywords {
		idx := strings.Index(upper, kw)
		if idx < 0 {
			continue
		}
		if idx > 0 {
			prev := payload[idx-1]
			if (prev >= 'A' && prev <= 'Z') || (prev >= 'a' && prev <= 'z') || (prev >= '0' && prev <= '9') {
				continue
			}
		}
		q := extractPrintableFrom(payload[idx:], 16384)
		if q = strings.TrimSpace(q); len(q) > 3 {
			return q
		}
	}
	return ""
}

func extractPrintableFrom(s string, maxLen int) string {
	var b strings.Builder
	nonPrint := 0
	for i, c := range s {
		if i > maxLen {
			break
		}
		if c == 0 {
			break
		}
		if c >= 0x20 && c <= 0x7e {
			b.WriteRune(c)
			nonPrint = 0
		} else if c == '\r' {
			b.WriteRune(' ')
		} else if c == '\n' {
			b.WriteRune('\n')
			nonPrint = 0
		} else if c == '\t' {
			b.WriteRune(' ')
		} else {
			if nonPrint++; nonPrint > 3 {
				break
			}
		}
	}
	return b.String()
}

func extractRedis(payload string) string {
	var tokens []string
	for _, l := range strings.Split(payload, "\n") {
		l = strings.TrimRight(l, "\r\n ")
		if l == "" || l[0] == '*' || l[0] == '$' || l[0] == '+' || l[0] == '-' || l[0] == ':' {
			continue
		}
		if len(l) <= 256 && isPrintablish(l) {
			tokens = append(tokens, l)
		}
		if len(tokens) >= 8 {
			break
		}
	}
	if len(tokens) == 0 {
		return ""
	}
	cmd := strings.ToUpper(tokens[0])
	known := map[string]bool{
		"GET": true, "SET": true, "DEL": true, "HGET": true, "HSET": true,
		"HMGET": true, "HMSET": true, "LPUSH": true, "RPUSH": true, "LRANGE": true,
		"SADD": true, "SMEMBERS": true, "ZADD": true, "ZRANGE": true,
		"EXPIRE": true, "TTL": true, "EXISTS": true, "INCR": true, "DECR": true,
		"KEYS": true, "SCAN": true, "PUBLISH": true, "SUBSCRIBE": true,
		"SELECT": true, "PING": true, "AUTH": true, "MULTI": true, "EXEC": true,
		"MGET": true, "MSET": true, "GETSET": true, "SETNX": true,
	}
	if !known[cmd] {
		return ""
	}
	if cmd == "AUTH" {
		return "AUTH ***"
	}
	out := []string{cmd}
	for _, t := range tokens[1:] {
		if len(t) > 64 {
			out = append(out, t[:64]+"…")
		} else {
			out = append(out, t)
		}
	}
	return strings.Join(out, " ")
}

func isPrintablish(s string) bool {
	if len(s) == 0 {
		return false
	}
	printable := 0
	for _, c := range []byte(s) {
		if c >= 0x20 && c <= 0x7e || c == '\t' {
			printable++
		}
	}
	return float64(printable)/float64(len(s)) > 0.4
}

func extractTimestamp(line string) string {
	if len(line) > 15 && line[2] == ':' && line[5] == ':' {
		return line[:15]
	}
	return time.Now().UTC().Format("15:04:05.000")
}
