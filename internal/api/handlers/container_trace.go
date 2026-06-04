package handlers

import (
	"bufio"
	"context"
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
)

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
	Time       string         `json:"time"`
	Type       TraceEventType `json:"type"`
	Method     string         `json:"method,omitempty"`
	Path       string         `json:"path,omitempty"`
	Host       string         `json:"host,omitempty"`
	Status     int            `json:"status,omitempty"`
	DurationMs float64        `json:"duration_ms,omitempty"`
	Query      string         `json:"query,omitempty"`
	DBType     string         `json:"db_type,omitempty"`
	Src        string         `json:"src,omitempty"`
	Dst        string         `json:"dst,omitempty"`
	DstPort    int            `json:"dst_port,omitempty"`
	Message    string         `json:"message,omitempty"`
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

	send := func(ev TraceSpan) {
		if ev.Time == "" {
			ev.Time = time.Now().UTC().Format("15:04:05.000")
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

	// Request correlator for HTTP timing.
	type openReq struct {
		method, path, host string
		t                  time.Time
	}
	openReqs := make(map[string]openReq)

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

		if ev.Type == TraceHTTPReq {
			openReqs[connKey] = openReq{method: ev.Method, path: ev.Path, host: ev.Host, t: p.wallT}
		} else if ev.Type == TraceHTTPResp {
			if req, ok := openReqs[revKey]; ok {
				ev.DurationMs = float64(p.wallT.Sub(req.t).Milliseconds())
				delete(openReqs, revKey)
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
	httpReqRe = regexp.MustCompile(`(?m)(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|CONNECT) (/\S*) HTTP/[\d.]+`)
	httpRespRe = regexp.MustCompile(`(?m)HTTP/[\d.]+ (\d{3})`)
	hostHdrRe  = regexp.MustCompile(`(?im)^Host:\s*(\S+)`)
)

func analyze(payload, srcIP string, srcPort int, dstIP string, dstPort int) *TraceSpan {
	src := fmt.Sprintf("%s:%d", srcIP, srcPort)
	dst := fmt.Sprintf("%s:%d", dstIP, dstPort)

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

	if dstPort == 5432 || srcPort == 5432 {
		if q := extractSQL(payload, []string{"SELECT", "INSERT", "UPDATE", "DELETE",
			"CREATE", "DROP", "ALTER", "BEGIN", "COMMIT", "ROLLBACK", "WITH", "CALL"}); q != "" {
			return &TraceSpan{Type: TraceSQL, DBType: "postgresql", Query: q, Src: src, Dst: dst, DstPort: dstPort}
		}
	}
	if dstPort == 3306 || srcPort == 3306 {
		if q := extractSQL(payload, []string{"SELECT", "INSERT", "UPDATE", "DELETE",
			"CREATE", "DROP", "ALTER", "BEGIN", "COMMIT", "SET "}); q != "" {
			return &TraceSpan{Type: TraceSQL, DBType: "mysql", Query: q, Src: src, Dst: dst, DstPort: dstPort}
		}
	}
	if dstPort == 6379 || srcPort == 6379 {
		if cmd := extractRedis(payload); cmd != "" {
			return &TraceSpan{Type: TraceRedis, DBType: "redis", Query: cmd, Src: src, Dst: dst, DstPort: dstPort}
		}
	}
	return nil
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
		q := extractPrintableFrom(payload[idx:], 4096)
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
