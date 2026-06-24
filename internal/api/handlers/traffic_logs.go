package handlers

import (
	"encoding/base64"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"offdock/internal/store"
	"offdock/internal/trafficindex"
)

// trafficBodyCap bounds how many body bytes we persist per request/response.
const trafficBodyCap = 1 << 20 // 1 MB

const trafficLogRetention = 5000 // keep newest N exchanges

// splitHTTPMessage splits captured HTTP wire text into (headers, body) at the
// first blank line. tcpdump -A output uses CRLF; fall back to LF.
func splitHTTPMessage(payload string) (headers, body string) {
	if i := strings.Index(payload, "\r\n\r\n"); i >= 0 {
		return payload[:i], payload[i+4:]
	}
	if i := strings.Index(payload, "\n\n"); i >= 0 {
		return payload[:i], payload[i+2:]
	}
	return payload, ""
}

// httpHeaderValue returns the value of a header (case-insensitive) from a header block.
func httpHeaderValue(headers, key string) string {
	lk := strings.ToLower(key)
	for _, line := range strings.Split(headers, "\n") {
		line = strings.TrimRight(line, "\r")
		if i := strings.Index(line, ":"); i > 0 && strings.ToLower(strings.TrimSpace(line[:i])) == lk {
			return strings.TrimSpace(line[i+1:])
		}
	}
	return ""
}

// contentLength parses the Content-Length header (0 if absent/invalid).
func contentLength(headers string) int {
	if v := httpHeaderValue(headers, "Content-Length"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return 0
}

// isBinaryContent decides whether a body should be stored base64. The content
// type is the reliable signal (tcpdump -A already mangles raw bytes); the byte
// heuristic is a fallback for unlabeled content.
func isBinaryContent(contentType string, b []byte) bool {
	ct := strings.ToLower(contentType)
	if ct != "" {
		if strings.HasPrefix(ct, "text/") || strings.Contains(ct, "json") ||
			strings.Contains(ct, "xml") || strings.Contains(ct, "x-www-form-urlencoded") ||
			strings.Contains(ct, "javascript") || strings.Contains(ct, "html") ||
			strings.Contains(ct, "yaml") || strings.Contains(ct, "csv") {
			return false
		}
		return true // declared a non-text content type
	}
	if len(b) == 0 {
		return false
	}
	if !utf8.Valid(b) {
		return true
	}
	nonPrint := 0
	for _, c := range b {
		if c < 9 || (c > 13 && c < 32) {
			nonPrint++
		}
	}
	return nonPrint*100/len(b) > 30
}

// encodeTrafficBody caps + encodes a captured body for storage. declaredLen is
// the Content-Length if known (to flag truncation when the wire payload is short).
func encodeTrafficBody(body, contentType string, declaredLen int) (stored string, binary, truncated bool) {
	raw := []byte(body)
	if declaredLen > 0 && declaredLen > len(raw) {
		truncated = true
	}
	if len(raw) > trafficBodyCap {
		raw = raw[:trafficBodyCap]
		truncated = true
	}
	if isBinaryContent(contentType, raw) {
		return base64.StdEncoding.EncodeToString(raw), true, truncated
	}
	return string(raw), false, truncated
}

// saveTrafficLog persists a captured exchange, indexes it for fast search, and
// prunes to the retention cap.
func (h *H) saveTrafficLog(tl store.TrafficLog) {
	if err := h.db.TrafficLogs.Save(tl); err != nil {
		slog.Warn("traffic log save", "err", err)
		return
	}
	h.trafficIdx.Add(trafficindex.Entry{
		ID: tl.ID, Time: tl.Time, Container: tl.Container, Method: tl.Method,
		Host: tl.Host, Path: tl.Path, Status: tl.Status, DurationMs: tl.DurationMs,
		ReqBytes: tl.ReqBytes, RespBytes: tl.RespBytes,
	})
	if h.trafficPruneMu.TryLock() {
		go func() {
			defer h.trafficPruneMu.Unlock()
			h.pruneTrafficLogs()
		}()
	}
}

// pruneTrafficLogs enforces the configured traffic-log retention (newest-N count
// + optional max-age) against the DB and keeps the in-memory trie index in sync.
// Caller must hold trafficPruneMu. Runs compaction when records were removed.
func (h *H) pruneTrafficLogs() {
	rs := store.LoadRetentionSettings(h.dataDir)
	keep := rs.TrafficLogsMaxCount
	if keep <= 0 {
		keep = trafficLogRetention
	}
	all, _ := h.db.TrafficLogs.FindAll()
	sort.Slice(all, func(i, j int) bool { return all[i].Time.After(all[j].Time) })

	var cutoff time.Time
	if rs.TrafficLogsMaxAgeDays > 0 {
		cutoff = time.Now().AddDate(0, 0, -rs.TrafficLogsMaxAgeDays)
	}

	deleted := 0
	for i, rec := range all {
		expired := i >= keep || (!cutoff.IsZero() && rec.Time.Before(cutoff))
		if !expired {
			continue
		}
		if h.db.TrafficLogs.Delete(rec.ID) == nil {
			h.trafficIdx.Remove(rec.ID)
			deleted++
		}
	}
	if deleted > 0 {
		_, _ = h.db.TrafficLogs.Compact()
	}
}

// ─── API ──────────────────────────────────────────────────────────────────────

// ListTrafficLogs returns captured exchanges (metadata only — bodies are fetched
// per-record via GetTrafficLog) using the in-memory trie+time index for fast
// search and paginated load. Query: container, search, status, limit, offset.
func (h *H) ListTrafficLogs(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit := 100
	if l, err := strconv.Atoi(q.Get("limit")); err == nil && l > 0 {
		limit = l
	}
	offset := 0
	if o, err := strconv.Atoi(q.Get("offset")); err == nil && o > 0 {
		offset = o
	}
	page, total := h.trafficIdx.Query(trafficindex.Query{
		Search:    q.Get("search"),
		Container: q.Get("container"),
		ErrorOnly: q.Get("status") == "error",
		Limit:     limit,
		Offset:    offset,
	})
	writeJSON(w, http.StatusOK, map[string]any{"data": page, "total": total, "limit": limit, "offset": offset})
}

// GetTrafficLog returns a single exchange with full headers + bodies.
func (h *H) GetTrafficLog(w http.ResponseWriter, r *http.Request) {
	tl, err := h.db.TrafficLogs.FindByID(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusNotFound, "traffic log not found")
		return
	}
	writeJSON(w, http.StatusOK, tl)
}

// ClearTrafficLogs deletes all captured exchanges.
func (h *H) ClearTrafficLogs(w http.ResponseWriter, r *http.Request) {
	all, _ := h.db.TrafficLogs.FindAll()
	deleted := 0
	for _, t := range all {
		if h.db.TrafficLogs.Delete(t.ID) == nil {
			deleted++
		}
	}
	_, _ = h.db.TrafficLogs.Compact()
	h.trafficIdx.Clear()
	h.logAudit(r, "clear_traffic_logs", "system", "", "", "")
	writeJSON(w, http.StatusOK, map[string]any{"deleted": deleted})
}
