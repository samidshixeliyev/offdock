package handlers

import (
	"compress/gzip"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	commonv1 "go.opentelemetry.io/proto/otlp/common/v1"
	tracev1 "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/proto"

	"offdock/internal/store"
)

// ─── Simple span API — universal, no SDK, any language ────────────────────────
//
// POST /v1/span   — single span
// POST /v1/spans  — batch (array of spans)
//
// Minimal JSON that any language can produce with 5 lines of code:
//   {"service":"my-app","name":"processOrder","start_ms":1234,"end_ms":1290,"tags":{"user.id":"42"}}
//
// All fields except service and name are optional. The server auto-generates
// trace_id and span_id when missing, and returns them so the caller can chain spans.

type simpleSpan struct {
	TraceID    string            `json:"trace_id"`    // optional — auto-generated if absent
	SpanID     string            `json:"span_id"`     // optional — auto-generated if absent
	ParentID   string            `json:"parent_id"`   // optional — links this span to a parent
	Service    string            `json:"service"`     // required — "php-app", "node-api", "go-worker" …
	Name       string            `json:"name"`        // required — operation name
	StartMs    int64             `json:"start_ms"`    // Unix milliseconds; defaults to now
	EndMs      int64             `json:"end_ms"`      // Unix milliseconds; defaults to now
	DurationMs float64           `json:"duration_ms"` // alternative to start+end
	Status     string            `json:"status"`      // "ok" | "error"  (default "ok")
	Error      string            `json:"error"`       // error message if status=error
	Tags       map[string]string `json:"tags"`        // any key/value pairs
}

func (h *H) ingestSimpleSpan(sp simpleSpan) store.OTelSpan {
	now := time.Now()
	nowMs := now.UnixMilli()

	if sp.Service == "" {
		sp.Service = "unknown"
	}
	if sp.Name == "" {
		sp.Name = "span"
	}
	if sp.TraceID == "" {
		sp.TraceID = store.NewULID()
	}
	if sp.SpanID == "" {
		sp.SpanID = store.NewULID()
	}

	startMs := sp.StartMs
	if startMs == 0 {
		startMs = nowMs
	}
	endMs := sp.EndMs
	if endMs == 0 {
		if sp.DurationMs > 0 {
			endMs = startMs + int64(sp.DurationMs)
		} else {
			endMs = nowMs
		}
	}
	durUs := (endMs - startMs) * 1000
	if durUs < 0 {
		durUs = 0
	}

	status := sp.Status
	if status == "" {
		status = "ok"
	}
	if sp.Error != "" {
		status = "error"
	}

	tags := sp.Tags
	if tags == nil {
		tags = map[string]string{}
	}
	if sp.Error != "" {
		tags["error.message"] = sp.Error
	}

	return store.OTelSpan{
		ID:           store.NewULID(),
		TraceID:      sp.TraceID,
		SpanID:       sp.SpanID,
		ParentSpanID: sp.ParentID,
		Service:      sp.Service,
		Name:         sp.Name,
		Kind:         "server",
		StartTimeUs:  startMs * 1000,
		EndTimeUs:    endMs * 1000,
		DurationUs:   durUs,
		StatusCode:   status,
		StatusMsg:    sp.Error,
		Attributes:   tags,
		ReceivedAt:   now,
	}
}

// ReceiveOTLPNoOp accepts OTLP logs and metrics — returns 200 without storing.
// This prevents 404 spam from OTel agents that also try to export logs/metrics.
func (h *H) ReceiveOTLPNoOp(w http.ResponseWriter, r *http.Request) {
	// Drain the body so the client doesn't get a connection reset.
	_, _ = io.Copy(io.Discard, r.Body)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, `{"partialSuccess":{}}`)
}

// ReceiveSimpleSpan accepts a single span from any language — no SDK required.
func (h *H) ReceiveSimpleSpan(w http.ResponseWriter, r *http.Request) {
	var sp simpleSpan
	if err := json.NewDecoder(r.Body).Decode(&sp); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}
	ospan := h.ingestSimpleSpan(sp)
	if err := h.db.OTelSpans.Save(ospan); err != nil {
		slog.Warn("simple span: save", "err", err)
	} else {
		if h.spanPruneMu.TryLock() {
		go func() {
			defer h.spanPruneMu.Unlock()
			h.db.PruneOTelSpans(50_000)
		}()
	}
	}
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"trace_id":%q,"span_id":%q}`, ospan.TraceID, ospan.SpanID)
}

// ReceiveSimpleSpans accepts a batch of spans — one HTTP call for multiple spans.
func (h *H) ReceiveSimpleSpans(w http.ResponseWriter, r *http.Request) {
	var spans []simpleSpan
	if err := json.NewDecoder(r.Body).Decode(&spans); err != nil {
		// Try single span wrapped in array.
		http.Error(w, `{"error":"expected JSON array"}`, http.StatusBadRequest)
		return
	}
	saved := 0
	for _, sp := range spans {
		ospan := h.ingestSimpleSpan(sp)
		if h.db.OTelSpans.Save(ospan) == nil {
			saved++
		}
	}
	if saved > 0 {
		if h.spanPruneMu.TryLock() {
		go func() {
			defer h.spanPruneMu.Unlock()
			h.db.PruneOTelSpans(50_000)
		}()
	}
	}
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"saved":%d}`, saved)
}

// ─── OTLP HTTP receiver ───────────────────────────────────────────────────────

// otlpRequest is the top-level OTLP JSON trace payload.
type otlpRequest struct {
	ResourceSpans []otlpResourceSpans `json:"resourceSpans"`
}
type otlpResourceSpans struct {
	Resource   otlpResource    `json:"resource"`
	ScopeSpans []otlpScopeSpan `json:"scopeSpans"`
}
type otlpResource struct {
	Attributes []otlpKV `json:"attributes"`
}
type otlpScopeSpan struct {
	Scope otlpScope  `json:"scope"`
	Spans []otlpSpan `json:"spans"`
}
type otlpScope struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}
type otlpSpan struct {
	TraceID      string    `json:"traceId"`
	SpanID       string    `json:"spanId"`
	ParentSpanID string    `json:"parentSpanId"`
	Name         string    `json:"name"`
	Kind         int       `json:"kind"`
	StartTime    otlpNanos `json:"startTimeUnixNano"`
	EndTime      otlpNanos `json:"endTimeUnixNano"`
	Attributes   []otlpKV  `json:"attributes"`
	Status       otlpStatus `json:"status"`
}

// otlpNanos handles OTLP time fields that are either JSON strings or numbers.
type otlpNanos int64

func (n *otlpNanos) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return err
	}
	*n = otlpNanos(v)
	return nil
}

type otlpKV struct {
	Key   string    `json:"key"`
	Value otlpValue `json:"value"`
}
type otlpValue struct {
	StringValue *string          `json:"stringValue"`
	IntValue    *json.RawMessage `json:"intValue"` // can be number or string
	DoubleValue *float64         `json:"doubleValue"`
	BoolValue   *bool            `json:"boolValue"`
}
type otlpStatus struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func kvToString(v otlpValue) string {
	if v.StringValue != nil {
		return *v.StringValue
	}
	if v.IntValue != nil {
		raw := strings.Trim(string(*v.IntValue), `"`)
		return raw
	}
	if v.DoubleValue != nil {
		return strconv.FormatFloat(*v.DoubleValue, 'f', -1, 64)
	}
	if v.BoolValue != nil {
		if *v.BoolValue {
			return "true"
		}
		return "false"
	}
	return ""
}

func spanKindName(k int) string {
	switch k {
	case 2:
		return "server"
	case 3:
		return "client"
	case 4:
		return "producer"
	case 5:
		return "consumer"
	default:
		return "internal"
	}
}

func statusCodeName(c int) string {
	switch c {
	case 1:
		return "ok"
	case 2:
		return "error"
	default:
		return "unset"
	}
}

// readBody reads and optionally decompresses the request body.
func readBody(r *http.Request) ([]byte, error) {
	if strings.EqualFold(r.Header.Get("Content-Encoding"), "gzip") {
		gz, err := gzip.NewReader(r.Body)
		if err != nil {
			return nil, err
		}
		defer gz.Close()
		return io.ReadAll(gz)
	}
	return io.ReadAll(r.Body)
}

// ReceiveOTLPTraces accepts OTLP HTTP traces from OTel agents inside containers.
// Handles both application/x-protobuf (Java/Go/Python agents) and application/json.
func (h *H) ReceiveOTLPTraces(w http.ResponseWriter, r *http.Request) {
	body, err := readBody(r)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"partialSuccess":{}}`)
		return
	}

	ct := r.Header.Get("Content-Type")
	var saved int

	if strings.Contains(ct, "application/x-protobuf") || strings.Contains(ct, "protobuf") {
		// Decode real OTLP protobuf binary.
		// ExportTraceServiceRequest has one field: repeated ResourceSpans resource_spans = 1;
		// We decode it as a TracesData (same wire format) from the trace/v1 package.
		var td tracev1.TracesData
		if err := proto.Unmarshal(body, &td); err == nil {
			saved = h.saveProtoSpans(td.ResourceSpans)
		}
		// If unmarshal fails, still return 200 to prevent agent retry storms.
	} else {
		// JSON path (also handles gzip+json).
		var req otlpRequest
		if json.Unmarshal(body, &req) == nil {
			saved = h.saveJSONSpans(req.ResourceSpans)
		}
	}

	if saved > 0 {
		if h.spanPruneMu.TryLock() {
		go func() {
			defer h.spanPruneMu.Unlock()
			h.db.PruneOTelSpans(50_000)
		}()
	}
	}
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprint(w, `{"partialSuccess":{}}`)
}

// saveProtoSpans stores spans decoded from OTLP protobuf (Java agent, Go SDK, etc.).
func (h *H) saveProtoSpans(rss []*tracev1.ResourceSpans) int {
	now := time.Now().UTC()
	saved := 0
	for _, rs := range rss {
		service := "unknown"
		if rs.Resource != nil {
			service = protoAttrStr(rs.Resource.Attributes, "service.name", service)
		}
		for _, ss := range rs.ScopeSpans {
			for _, sp := range ss.Spans {
				attrs := make(map[string]string, len(sp.Attributes))
				for _, kv := range sp.Attributes {
					if kv.Value != nil {
						attrs[kv.Key] = protoAnyValueStr(kv.Value)
					}
				}
				startUs := int64(sp.StartTimeUnixNano) / 1000
				endUs := int64(sp.EndTimeUnixNano) / 1000
				durUs := endUs - startUs
				if durUs < 0 {
					durUs = 0
				}
				statusCode := "unset"
				statusMsg := ""
				if sp.Status != nil {
					statusCode = protoStatusCode(sp.Status.Code)
					statusMsg = sp.Status.Message
				}
				ospan := store.OTelSpan{
					ID:           store.NewULID(),
					TraceID:      hex.EncodeToString(sp.TraceId),
					SpanID:       hex.EncodeToString(sp.SpanId),
					ParentSpanID: hex.EncodeToString(sp.ParentSpanId),
					Service:      service,
					Name:         sp.Name,
					Kind:         protoSpanKind(sp.Kind),
					StartTimeUs:  startUs,
					EndTimeUs:    endUs,
					DurationUs:   durUs,
					StatusCode:   statusCode,
					StatusMsg:    statusMsg,
					Attributes:   attrs,
					ReceivedAt:   now,
				}
				if h.db.OTelSpans.Save(ospan) == nil {
					saved++
				}
			}
		}
	}
	return saved
}

// saveJSONSpans stores spans decoded from OTLP JSON (Node.js SDK, custom senders, etc.).
func (h *H) saveJSONSpans(rss []otlpResourceSpans) int {
	now := time.Now().UTC()
	saved := 0
	for _, rs := range rss {
		service := "unknown"
		for _, kv := range rs.Resource.Attributes {
			if kv.Key == "service.name" && kv.Value.StringValue != nil {
				service = *kv.Value.StringValue
			}
		}
		for _, ss := range rs.ScopeSpans {
			for _, sp := range ss.Spans {
				attrs := make(map[string]string, len(sp.Attributes))
				for _, kv := range sp.Attributes {
					if v := kvToString(kv.Value); v != "" {
						attrs[kv.Key] = v
					}
				}
				startUs := int64(sp.StartTime) / 1000
				endUs := int64(sp.EndTime) / 1000
				durUs := endUs - startUs
				if durUs < 0 {
					durUs = 0
				}
				ospan := store.OTelSpan{
					ID:           store.NewULID(),
					TraceID:      sp.TraceID,
					SpanID:       sp.SpanID,
					ParentSpanID: sp.ParentSpanID,
					Service:      service,
					Name:         sp.Name,
					Kind:         spanKindName(sp.Kind),
					StartTimeUs:  startUs,
					EndTimeUs:    endUs,
					DurationUs:   durUs,
					StatusCode:   statusCodeName(sp.Status.Code),
					StatusMsg:    sp.Status.Message,
					Attributes:   attrs,
					ReceivedAt:   now,
				}
				if h.db.OTelSpans.Save(ospan) == nil {
					saved++
				}
			}
		}
	}
	return saved
}

// ── protobuf helpers ─────────────────────────────────────────────────────────

func protoAttrStr(attrs []*commonv1.KeyValue, key, def string) string {
	for _, kv := range attrs {
		if kv.Key == key && kv.Value != nil {
			if sv := kv.Value.GetStringValue(); sv != "" {
				return sv
			}
		}
	}
	return def
}

func protoAnyValueStr(v *commonv1.AnyValue) string {
	switch x := v.Value.(type) {
	case *commonv1.AnyValue_StringValue:
		return x.StringValue
	case *commonv1.AnyValue_IntValue:
		return strconv.FormatInt(x.IntValue, 10)
	case *commonv1.AnyValue_DoubleValue:
		return strconv.FormatFloat(x.DoubleValue, 'f', -1, 64)
	case *commonv1.AnyValue_BoolValue:
		if x.BoolValue {
			return "true"
		}
		return "false"
	}
	return ""
}

func protoSpanKind(k tracev1.Span_SpanKind) string {
	switch k {
	case tracev1.Span_SPAN_KIND_SERVER:
		return "server"
	case tracev1.Span_SPAN_KIND_CLIENT:
		return "client"
	case tracev1.Span_SPAN_KIND_PRODUCER:
		return "producer"
	case tracev1.Span_SPAN_KIND_CONSUMER:
		return "consumer"
	default:
		return "internal"
	}
}

func protoStatusCode(c tracev1.Status_StatusCode) string {
	switch c {
	case tracev1.Status_STATUS_CODE_OK:
		return "ok"
	case tracev1.Status_STATUS_CODE_ERROR:
		return "error"
	default:
		return "unset"
	}
}

// ─── Query API ────────────────────────────────────────────────────────────────

// OTelStatus returns whether the OTLP receiver is ready and what endpoint to use.
func (h *H) OTelStatus(w http.ResponseWriter, r *http.Request) {
	hostIP := hostIP()
	writeJSON(w, http.StatusOK, map[string]any{
		"available":  true,
		"otlp_http":  fmt.Sprintf("http://%s:7070/v1/traces", hostIP),
		"span_count": h.db.OTelSpans.Count(),
	})
}

// OTelServices returns the list of services that have sent traces.
func (h *H) OTelServices(w http.ResponseWriter, r *http.Request) {
	spans, _ := h.db.OTelSpans.FindAll()
	seen := make(map[string]bool)
	var services []string
	for _, s := range spans {
		if !seen[s.Service] {
			seen[s.Service] = true
			services = append(services, s.Service)
		}
	}
	sort.Strings(services)
	writeJSON(w, http.StatusOK, map[string]any{"data": services})
}

// OTelOperations returns the distinct operation names for a given service.
func (h *H) OTelOperations(w http.ResponseWriter, r *http.Request) {
	svc := r.URL.Query().Get("service")
	spans, _ := h.db.OTelSpans.FindWhere(func(s store.OTelSpan) bool {
		return svc == "" || s.Service == svc
	})
	seen := make(map[string]bool)
	type op struct {
		Name     string `json:"name"`
		SpanKind string `json:"spanKind"`
	}
	var ops []op
	for _, s := range spans {
		if !seen[s.Name] {
			seen[s.Name] = true
			ops = append(ops, op{Name: s.Name, SpanKind: s.Kind})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": ops})
}

// jaegerSpan mirrors the Jaeger HTTP API span format the frontend expects.
type jaegerSpan struct {
	TraceID       string         `json:"traceID"`
	SpanID        string         `json:"spanID"`
	OperationName string         `json:"operationName"`
	References    []jaegerRef    `json:"references"`
	StartTime     int64          `json:"startTime"`   // microseconds epoch
	Duration      int64          `json:"duration"`    // microseconds
	Tags          []jaegerTag    `json:"tags"`
	ProcessID     string         `json:"processID"`
	Warnings      []string       `json:"warnings"`
}
type jaegerRef struct {
	RefType string `json:"refType"`
	TraceID string `json:"traceID"`
	SpanID  string `json:"spanID"`
}
type jaegerTag struct {
	Key   string `json:"key"`
	Type  string `json:"type"`
	Value string `json:"value"`
}
type jaegerProcess struct {
	ServiceName string       `json:"serviceName"`
	Tags        []jaegerTag  `json:"tags"`
}
type jaegerTrace struct {
	TraceID   string                    `json:"traceID"`
	Spans     []jaegerSpan              `json:"spans"`
	Processes map[string]jaegerProcess  `json:"processes"`
	Warnings  []string                  `json:"warnings"`
}

// toJaegerTrace converts OffDock OTelSpans for a single trace to Jaeger API format.
func toJaegerTrace(traceID string, spans []store.OTelSpan) jaegerTrace {
	processes := make(map[string]jaegerProcess)
	pidMap := make(map[string]string) // service → processID

	getPID := func(service string) string {
		if pid, ok := pidMap[service]; ok {
			return pid
		}
		pid := fmt.Sprintf("p%d", len(pidMap)+1)
		pidMap[service] = pid
		processes[pid] = jaegerProcess{ServiceName: service}
		return pid
	}

	jspans := make([]jaegerSpan, 0, len(spans))
	for _, sp := range spans {
		pid := getPID(sp.Service)
		var refs []jaegerRef
		if sp.ParentSpanID != "" {
			refs = append(refs, jaegerRef{
				RefType: "CHILD_OF",
				TraceID: sp.TraceID,
				SpanID:  sp.ParentSpanID,
			})
		}
		tags := make([]jaegerTag, 0, len(sp.Attributes)+2)
		tags = append(tags, jaegerTag{Key: "span.kind", Type: "string", Value: sp.Kind})
		if sp.StatusCode != "unset" {
			tags = append(tags, jaegerTag{Key: "otel.status_code", Type: "string", Value: sp.StatusCode})
		}
		for k, v := range sp.Attributes {
			tags = append(tags, jaegerTag{Key: k, Type: "string", Value: v})
		}
		jspans = append(jspans, jaegerSpan{
			TraceID:       sp.TraceID,
			SpanID:        sp.SpanID,
			OperationName: sp.Name,
			References:    refs,
			StartTime:     sp.StartTimeUs,
			Duration:      sp.DurationUs,
			Tags:          tags,
			ProcessID:     pid,
			Warnings:      []string{},
		})
	}

	return jaegerTrace{
		TraceID:   traceID,
		Spans:     jspans,
		Processes: processes,
		Warnings:  []string{},
	}
}

// OTelTraces returns recent traces in Jaeger-compatible format.
// Accepts: service, operation, limit, search, status, min_duration_ms, time_range query params.
func (h *H) OTelTraces(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	svc := q.Get("service")
	op := q.Get("operation")
	search := strings.ToLower(strings.TrimSpace(q.Get("search")))
	statusFilter := q.Get("status") // "error" or ""
	minDurMs := 0
	if d, err := strconv.Atoi(q.Get("min_duration_ms")); err == nil && d > 0 {
		minDurMs = d
	}

	// time_range: "1h" | "6h" | "24h" | "7d" → compute sinceTime
	var sinceTime time.Time
	switch q.Get("time_range") {
	case "1h":
		sinceTime = time.Now().Add(-time.Hour)
	case "6h":
		sinceTime = time.Now().Add(-6 * time.Hour)
	case "24h":
		sinceTime = time.Now().Add(-24 * time.Hour)
	case "7d":
		sinceTime = time.Now().AddDate(0, 0, -7)
	}

	limit := 20
	if l, err := strconv.Atoi(q.Get("limit")); err == nil && l > 0 {
		limit = l
	}

	spans, _ := h.db.OTelSpans.FindWhere(func(s store.OTelSpan) bool {
		if svc != "" && s.Service != svc {
			return false
		}
		if op != "" && s.Name != op {
			return false
		}
		if !sinceTime.IsZero() && s.ReceivedAt.Before(sinceTime) {
			return false
		}
		if search != "" {
			if !strings.Contains(strings.ToLower(s.Name), search) &&
				!strings.Contains(strings.ToLower(s.Service), search) {
				found := false
				for k, v := range s.Attributes {
					if strings.Contains(strings.ToLower(k), search) ||
						strings.Contains(strings.ToLower(v), search) {
						found = true
						break
					}
				}
				if !found {
					return false
				}
			}
		}
		return true
	})

	// Group by traceID.
	byTrace := make(map[string][]store.OTelSpan)
	for _, s := range spans {
		byTrace[s.TraceID] = append(byTrace[s.TraceID], s)
	}

	// Build summaries, applying per-trace filters (status, min_duration_ms).
	type traceSummary struct {
		id    string
		start int64
	}
	var summaries []traceSummary
	for tid, tspans := range byTrace {
		minStart := tspans[0].StartTimeUs
		maxEnd := tspans[0].EndTimeUs
		hasError := false
		for _, s := range tspans {
			if s.StartTimeUs < minStart {
				minStart = s.StartTimeUs
			}
			if s.EndTimeUs > maxEnd {
				maxEnd = s.EndTimeUs
			}
			if s.StatusCode == "error" {
				hasError = true
			}
		}
		if statusFilter == "error" && !hasError {
			continue
		}
		if minDurMs > 0 {
			traceDurMs := (maxEnd - minStart) / 1000
			if traceDurMs < int64(minDurMs) {
				continue
			}
		}
		summaries = append(summaries, traceSummary{id: tid, start: minStart})
	}
	sort.Slice(summaries, func(i, j int) bool { return summaries[i].start > summaries[j].start })

	if len(summaries) > limit {
		summaries = summaries[:limit]
	}

	traces := make([]jaegerTrace, 0, len(summaries))
	for _, s := range summaries {
		traces = append(traces, toJaegerTrace(s.id, byTrace[s.id]))
	}

	writeJSON(w, http.StatusOK, map[string]any{"data": traces})
}

// OTelTrace returns all spans for a single trace.
func (h *H) OTelTrace(w http.ResponseWriter, r *http.Request) {
	traceID := chi.URLParam(r, "id")
	spans, _ := h.db.OTelSpans.FindWhere(func(s store.OTelSpan) bool {
		return s.TraceID == traceID
	})
	if len(spans) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"data": []jaegerTrace{}})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": []jaegerTrace{
		toJaegerTrace(traceID, spans),
	}})
}

// OTelDeleteTraces removes all stored OTel spans.
func (h *H) OTelDeleteTraces(w http.ResponseWriter, r *http.Request) {
	spans, _ := h.db.OTelSpans.FindAll()
	deleted := 0
	for _, s := range spans {
		if h.db.OTelSpans.Delete(s.ID) == nil {
			deleted++
		}
	}
	_ = h.db.OTelSpans.Compact()
	h.logAudit(r, "delete_otel_traces", "system", "", "", "")
	writeJSON(w, http.StatusOK, map[string]any{"deleted": deleted})
}

// hostIP returns the server's first non-loopback IPv4 address.
// Containers use this to send OTLP to OffDock on the host.
func hostIP() string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return "localhost"
	}
	for _, addr := range addrs {
		if ipnet, ok := addr.(*net.IPNet); ok && !ipnet.IP.IsLoopback() {
			if v4 := ipnet.IP.To4(); v4 != nil {
				return v4.String()
			}
		}
	}
	return "localhost"
}
