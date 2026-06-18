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

// containerPID returns the host PID of the container's init process.
func containerPID(containerName string) (int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", "inspect",
		"--format", "{{.State.Pid}}", containerName,
	).Output()
	if err != nil {
		return 0, err
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil || pid == 0 {
		return 0, fmt.Errorf("invalid pid")
	}
	return pid, nil
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

	// SSE setup first — so the client always receives onopen and error
	// messages are delivered as TraceError events rather than HTTP errors.
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	// Verify container is running.
	checkCtx, checkCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer checkCancel()
	pidOut, err := exec.CommandContext(checkCtx, "docker", "inspect",
		"--format", "{{.State.Running}}", name).Output()
	if err != nil || strings.TrimSpace(string(pidOut)) != "true" {
		// Send error via SSE so the frontend can display it, then close.
		fmt.Fprintf(w, "data: {\"type\":\"error\",\"message\":\"container %s is not running\"}\n\n", name)
		flusher.Flush()
		return
	}

	// Find bridge interface and container IP (used for bridge-mode capture / info).
	iface, containerIP, bridgeErr := containerBridgeIface(name)

	// Try nsenter into the container's network namespace so we capture loopback
	// traffic too. This is required when services share a container (e.g. a Java
	// app with an embedded PostgreSQL): those connections use 127.0.0.1 and never
	// cross the bridge interface.
	pid, pidErr := containerPID(name)
	_, nsenterLookErr := exec.LookPath("nsenter")
	useNsenter := pidErr == nil && nsenterLookErr == nil

	if bridgeErr != nil && !useNsenter {
		fmt.Fprintf(w, "data: {\"type\":\"error\",\"message\":\"could not find container network: %s — container may use host networking or a non-standard bridge\"}\n\n",
			strings.ReplaceAll(bridgeErr.Error(), `"`, `\"`))
		flusher.Flush()
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
		h.db.PruneTraceSessions(500)
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

	traceCtx, traceCancel := context.WithCancel(r.Context())
	defer traceCancel()

	var cmd *exec.Cmd
	if useNsenter {
		// nsenter: captures bridge + loopback (e.g. same-container postgres on 127.0.0.1).
		infoMsg := fmt.Sprintf("Tracing %s via netns PID %d — bridge + loopback (SQL, Redis, HTTP)", name, pid)
		if containerIP != "" {
			infoMsg = fmt.Sprintf("Tracing %s on %s via netns — bridge + loopback (SQL, Redis, HTTP)", name, containerIP)
		}
		send(TraceSpan{Type: TraceInfo, Message: infoMsg})
		// Capture ALL TCP in the container's netns (not just canonical ports) so
		// apps/DBs on custom ports (e.g. HTTP on :3000, Postgres on :5433) are
		// traced too. Protocol is detected from the payload, not the port.
		// Exclude OffDock's own OTLP/SSE port to cut self-noise.
		cmd = exec.CommandContext(traceCtx,
			"nsenter", "-t", strconv.Itoa(pid), "-n", "--",
			"tcpdump", "-i", "any", "-l", "-s", "0", "-A", "-nn",
			"tcp", "and", "not", "port", "7070",
		)
	} else {
		// Bridge-mode: captures only traffic that crosses the container's bridge veth.
		send(TraceSpan{
			Type:    TraceInfo,
			Message: fmt.Sprintf("Tracing %s on %s (IP: %s)", name, iface, containerIP),
		})
		cmd = exec.CommandContext(traceCtx,
			"tcpdump", "-i", iface, "-l", "-s", "0", "-A", "-nn",
			"host", containerIP, "and", "tcp",
		)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		send(TraceSpan{Type: TraceError, Message: "pipe error: " + err.Error()})
		return
	}
	stderrPipe, _ := cmd.StderrPipe()

	if err := cmd.Start(); err != nil {
		if stderrPipe != nil {
			stderrPipe.Close() //nolint:errcheck
		}
		send(TraceSpan{Type: TraceError, Message: "tcpdump failed to start: " + err.Error() +
			" — install tcpdump and ensure offdock runs as root or has CAP_NET_RAW"})
		return
	}
	defer func() {
		traceCancel()
		cmd.Process.Kill() //nolint:errcheck
		cmd.Wait()         //nolint:errcheck
	}()

	// Collect tcpdump stderr in background. Errors (permission denied, bad
	// interface, etc.) go there and would otherwise be silently swallowed.
	var stderrBuf strings.Builder
	stderrDone := make(chan struct{})
	go func() {
		defer close(stderrDone)
		if stderrPipe == nil {
			return
		}
		sc := bufio.NewScanner(stderrPipe)
		for sc.Scan() {
			line := sc.Text()
			// Skip the normal startup messages tcpdump prints to stderr.
			if strings.Contains(line, "listening on") || strings.Contains(line, "verbose output") {
				continue
			}
			stderrBuf.WriteString(strings.TrimPrefix(line, "tcpdump: "))
			stderrBuf.WriteByte(' ')
		}
	}()

	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()

	lines := make(chan string, 512)
	go func() {
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 262144), 262144)
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

		// Expire stale open requests and their activeSpan entries.
		for k, v := range openReqs {
			if time.Since(v.t) > 30*time.Second {
				delete(openReqs, k)
			}
		}
		// activeSpan grows unboundedly (one entry per src endpoint, never deleted).
		// Prune entries that have no corresponding open request to prevent memory leak.
		if len(activeSpan) > 1000 {
			activeSpan = make(map[string]string)
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
				// stdout closed — tcpdump exited. Flush the last in-flight packet
				// (otherwise the final request/query captured is silently dropped),
				// then wait briefly for stderr to drain.
				flush(cur)
				cur = nil
				select {
				case <-stderrDone:
				case <-time.After(500 * time.Millisecond):
				}
				if msg := strings.TrimSpace(stderrBuf.String()); msg != "" {
					send(TraceSpan{Type: TraceError, Message: "tcpdump: " + msg})
				}
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

	// In tcpdump -A output, non-printable bytes are shown as '.'.
	// Runs of 3+ dots therefore represent binary protocol data, not literal SQL.
	pgBinaryRunRe = regexp.MustCompile(`\.{3,}`)
	// $N parameter placeholders in SQL text.
	pgParamNumRe = regexp.MustCompile(`\$(\d+)`)
	// PostgreSQL protocol noise: statement/portal names, single-byte message types.
	// e.g. "C_5", "S1", "PC_5", "9C_5", "__asyncpg_stmt_0__"
	pgNoiseRe = regexp.MustCompile(`^(?:\d{0,3}[A-Z][A-Z_]?\d*|__[a-z_0-9]+__)$`)
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

	// For DB protocols we now also try NON-standard ports (a DB on a custom port,
	// e.g. Postgres on 5433): the per-protocol extractors all require a strong
	// signature (SQL keywords, COM_QUERY byte, RESP/OP_MSG framing), so trying
	// them on an unknown port rarely yields a false positive. `nonStd` is a port
	// that is neither a known HTTP port nor another DB's canonical port.
	nonStd := !isHTTPPort(dstPort) && !isHTTPPort(srcPort) &&
		dstPort != 5432 && dstPort != 3306 && dstPort != 1433 && dstPort != 6379 && dstPort != 27017 &&
		srcPort != 6379 && srcPort != 27017

	// ── PostgreSQL (port 5432, or a custom port) — client→server only ──────────
	if dstPort == 5432 || nonStd {
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

	// ── MySQL (port 3306, or custom) — client→server only ──────────────────────
	if dstPort == 3306 || nonStd {
		if q := extractMySQL(payload); q != "" {
			return &TraceSpan{Type: TraceSQL, DBType: "mysql", Query: cleanSQL(q), Src: src, Dst: dst, DstPort: dstPort}
		}
	}

	// ── MSSQL / SQL Server (port 1433, or custom) — client→server only ─────────
	if dstPort == 1433 || nonStd {
		if q := extractMSSQL(payload); q != "" {
			return &TraceSpan{Type: TraceSQL, DBType: "mssql", Query: cleanSQL(q), Src: src, Dst: dst, DstPort: dstPort}
		}
	}

	// ── Redis (port 6379, or custom) ───────────────────────────────────────────
	if dstPort == 6379 || srcPort == 6379 || nonStd {
		if cmd := extractRedis(payload); cmd != "" {
			return &TraceSpan{Type: TraceRedis, DBType: "redis", Query: cmd, Src: src, Dst: dst, DstPort: dstPort}
		}
	}

	// ── MongoDB (port 27017, or custom) — detect OP_MSG queries ────────────────
	if dstPort == 27017 || srcPort == 27017 || nonStd {
		if q := extractMongoDB(payload); q != "" {
			return &TraceSpan{Type: TraceSQL, DBType: "mongodb", Query: q, Src: src, Dst: dst, DstPort: dstPort}
		}
	}

	return nil
}

// isHTTPPort reports whether a port is a common plaintext-HTTP port (handled by
// the payload-based HTTP detector above, so DB extractors should skip it).
func isHTTPPort(p int) bool {
	switch p {
	case 80, 443, 8080, 8443, 8000, 3000, 5000, 8888:
		return true
	}
	return false
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
		if m := pgBinaryRunRe.FindStringIndex(q); m != nil {
			q = q[:m[0]]
		}
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
		if m := pgBinaryRunRe.FindStringIndex(q); m != nil {
			q = q[:m[0]]
		}
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
// extractPostgresExtended handles the PostgreSQL Extended Query Protocol.
//
// In tcpdump -A output non-printable bytes appear as '.' so a packet like:
//   P\x00\x00\x00NstmtName\x00INSERT INTO t VALUES ($1,$2)\x00...B\x00\x00\x00H...\x00stmtName\x00...\x24UUID1\x00\x00\x00\x24UUID2
// looks like:
//   P....stmtName.INSERT INTO t VALUES ($1,$2)...B...`.......stmtName......$UUID1...$UUID2
//
// The function:
//  1. Finds the SQL keyword and extracts clean SQL (stops at first 3+ dot run)
//  2. Finds the Bind message ('B...') in the binary noise after the SQL
//  3. Extracts parameter values from the Bind section
//  4. Substitutes $1,$2,... with the actual extracted values
func extractPostgresExtended(payload string, keywords []string) string {
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
			if prev != '.' && prev != 0 && prev != ' ' && prev != '\n' && prev != '\r' {
				start := idx - 32
				if start < 0 {
					start = 0
				}
				if !strings.ContainsRune(payload[start:idx], 'P') {
					continue
				}
			}
		}

		raw := extractPrintableFrom(payload[idx:], 32768)
		if len(raw) < 3 {
			continue
		}

		// ── Step 1: Extract clean SQL text ───────────────────────────────────
		// SQL text ends where binary protocol bytes begin (3+ consecutive dots).
		sql, noise := raw, ""
		if m := pgBinaryRunRe.FindStringIndex(raw); m != nil {
			sql = strings.TrimSpace(raw[:m[0]])
			noise = raw[m[0]:]
		}
		if sql = strings.TrimSpace(sql); len(sql) < 3 {
			continue
		}

		// ── Step 2: Count parameters and look for Bind values ────────────────
		paramCount := pgCountParams(sql)
		if paramCount > 0 && noise != "" {
			if values := pgExtractBindValues(noise, paramCount); len(values) > 0 {
				sql = pgSubstituteParams(sql, values)
			}
		}

		return sql
	}
	return ""
}

// pgCountParams returns the highest $N placeholder number found in sql.
func pgCountParams(sql string) int {
	max := 0
	for _, m := range pgParamNumRe.FindAllStringSubmatch(sql, -1) {
		if n, err := strconv.Atoi(m[1]); err == nil && n > max {
			max = n
		}
	}
	return max
}

// pgExtractBindValues extracts actual parameter values from the binary noise
// section that follows an SQL text in a tcpdump -A PostgreSQL payload.
//
// PostgreSQL Bind message format (in tcpdump -A):
//   B [4-byte length as dots][portal\0][stmt\0][format-codes][param-count][len1][val1][len2][val2]...
//
// 36-byte values (UUIDs) have length byte 0x24 = '$' which IS printable, so they
// appear as "$UUID" in the output — we strip the leading '$'.
func pgExtractBindValues(noise string, paramCount int) []string {
	// Find the Bind message: 'B' followed immediately by binary bytes.
	bindPos := strings.Index(noise, "B...")
	section := noise
	if bindPos >= 0 {
		section = noise[bindPos+1:] // skip past 'B'
	}

	var values []string
	// Split on binary runs (3+ dots) and collect printable blobs.
	for _, part := range pgBinaryRunRe.Split(section, -1) {
		part = strings.TrimSpace(part)
		if len(part) < 1 {
			continue
		}
		if pgIsProtocolNoise(part) {
			continue
		}

		// 36-byte UUID: the 4-byte length field ends in 0x24='$', so the blob
		// appears as "$<UUID>" — strip the leading '$' to get the raw UUID.
		if len(part) == 37 && part[0] == '$' && pgIsHexUUID(part[1:]) {
			part = part[1:]
		} else if len(part) < 1 {
			continue
		}

		values = append(values, part)
		if len(values) >= paramCount {
			break
		}
	}
	return values
}

// pgIsProtocolNoise returns true for blobs that are PostgreSQL protocol metadata
// rather than actual parameter values: statement names, portal names, message
// type bytes that happen to be printable.
func pgIsProtocolNoise(s string) bool {
	if len(s) <= 2 {
		return true
	}
	// Statement/portal name patterns: "C_5", "S1", "PC_5", "9C_5", "__asyncpg_stmt_0__"
	return pgNoiseRe.MatchString(s)
}

// pgIsHexUUID returns true if s looks like a PostgreSQL UUID value.
func pgIsHexUUID(s string) bool {
	if len(s) < 32 || len(s) > 36 {
		return false
	}
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') ||
			(c >= 'A' && c <= 'F') || c == '-') {
			return false
		}
	}
	return true
}

// pgSubstituteParams replaces $1, $2, ... in sql with quoted extracted values.
func pgSubstituteParams(sql string, values []string) string {
	for i, v := range values {
		placeholder := fmt.Sprintf("$%d", i+1)
		if !strings.Contains(sql, placeholder) {
			continue
		}
		// Quote non-numeric values.
		quoted := v
		if _, err := strconv.ParseFloat(v, 64); err != nil {
			quoted = "'" + v + "'"
		}
		sql = strings.Replace(sql, placeholder, quoted, 1)
	}
	return sql
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
		q := extractPrintableFrom(payload[idx:], 32768)
		// Strip binary protocol noise (3+ dots from tcpdump -A) and everything after.
		if m := pgBinaryRunRe.FindStringIndex(q); m != nil {
			q = q[:m[0]]
		}
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
