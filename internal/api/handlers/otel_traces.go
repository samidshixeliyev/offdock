package handlers

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"offdock/internal/store"
)

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

// ReceiveOTLPTraces accepts OTLP HTTP JSON traces from instrumented applications.
// No authentication required — this endpoint is called by OTel agents inside containers.
// Pruning keeps at most 50,000 spans (≈ ~50 MB at ~1 KB/span).
func (h *H) ReceiveOTLPTraces(w http.ResponseWriter, r *http.Request) {
	var req otlpRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid body"}`, http.StatusBadRequest)
		return
	}

	now := time.Now().UTC()
	saved := 0

	for _, rs := range req.ResourceSpans {
		// Extract service.name from resource attributes.
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
				if err := h.db.OTelSpans.Save(ospan); err != nil {
					slog.Warn("otel: save span", "err", err)
				} else {
					saved++
				}
			}
		}
	}

	// Prune asynchronously.
	if saved > 0 {
		go h.db.PruneOTelSpans(50_000)
	}

	// OTLP success response.
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, `{"partialSuccess":{}}`)
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
// Accepts: service, limit, operation query params.
func (h *H) OTelTraces(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	svc := q.Get("service")
	op := q.Get("operation")
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
		return true
	})

	// Group by traceID.
	byTrace := make(map[string][]store.OTelSpan)
	for _, s := range spans {
		byTrace[s.TraceID] = append(byTrace[s.TraceID], s)
	}

	// Sort traces newest-first (by earliest span start time).
	type traceSummary struct {
		id    string
		start int64
	}
	var summaries []traceSummary
	for tid, tspans := range byTrace {
		minStart := tspans[0].StartTimeUs
		for _, s := range tspans[1:] {
			if s.StartTimeUs < minStart {
				minStart = s.StartTimeUs
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
