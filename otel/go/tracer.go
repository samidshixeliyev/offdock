//go:build ignore

// Package offdocktrace is OffDock's zero-dependency Go tracer helper.
//
// Go cannot be auto-instrumented at runtime (statically compiled, no preload
// hook), so unlike the Node/Python/PHP/Ruby tracers this is NOT loaded
// automatically. Copy it into your service (or import the mounted /otel/go copy)
// and wrap your HTTP handler and/or http.Client transport to emit spans to
// OffDock's simple ingest endpoint POST /v1/span — no OpenTelemetry SDK needed.
//
// Endpoint resolution mirrors the other OffDock tracers: it reads
// OTEL_EXPORTER_OTLP_ENDPOINT (or OTEL_EXPORTER_OTLP_TRACES_ENDPOINT), strips any
// /v1/traces suffix, and posts to <base>/v1/span. Defaults to
// http://host.docker.internal:7070 when unset.
//
// Usage:
//
//	mux := http.NewServeMux()
//	mux.Handle("/", offdocktrace.Middleware(myHandler))     // incoming spans
//	client := &http.Client{Transport: offdocktrace.Transport(nil)} // outgoing spans
package offdocktrace

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"time"
)

const defaultEndpoint = "http://host.docker.internal:7070"

func serviceName() string {
	if s := os.Getenv("OTEL_SERVICE_NAME"); s != "" {
		return s
	}
	return "go-service"
}

func spanEndpoint() string {
	base := os.Getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
	if base == "" {
		base = os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
	}
	if base == "" {
		base = defaultEndpoint
	}
	base = strings.TrimRight(base, "/")
	base = strings.TrimSuffix(base, "/v1/traces")
	return base + "/v1/span"
}

type span struct {
	TraceID      string  `json:"trace_id"`
	SpanID       string  `json:"span_id"`
	ParentSpanID string  `json:"parent_span_id,omitempty"`
	Service      string  `json:"service"`
	Name         string  `json:"name"`
	Kind         string  `json:"kind"`
	StartUs      int64   `json:"start_us"`
	DurationUs   int64   `json:"duration_us"`
	StatusCode   string  `json:"status_code"`
	Attributes   map[string]string `json:"attributes,omitempty"`
}

func genID(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// send posts a span to OffDock without blocking the caller. Failures are ignored
// — tracing must never break the traced application.
func send(s span) {
	go func() {
		body, err := json.Marshal(s)
		if err != nil {
			return
		}
		req, err := http.NewRequest(http.MethodPost, spanEndpoint(), bytes.NewReader(body))
		if err != nil {
			return
		}
		req.Header.Set("Content-Type", "application/json")
		client := &http.Client{Timeout: 3 * time.Second}
		resp, err := client.Do(req)
		if err == nil {
			_ = resp.Body.Close()
		}
	}()
}

// Middleware wraps an http.Handler and emits a server span per request.
func Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: 200}
		next.ServeHTTP(rec, r)
		send(span{
			TraceID:    genID(16),
			SpanID:     genID(8),
			Service:    serviceName(),
			Name:       r.Method + " " + r.URL.Path,
			Kind:       "server",
			StartUs:    start.UnixMicro(),
			DurationUs: time.Since(start).Microseconds(),
			StatusCode: statusFor(rec.status),
			Attributes: map[string]string{
				"http.method": r.Method,
				"http.target": r.URL.Path,
				"http.host":   r.Host,
			},
		})
	})
}

// Transport wraps an http.RoundTripper and emits a client span per outgoing call.
// Pass nil to wrap http.DefaultTransport.
func Transport(rt http.RoundTripper) http.RoundTripper {
	if rt == nil {
		rt = http.DefaultTransport
	}
	return roundTripper{rt}
}

type roundTripper struct{ next http.RoundTripper }

func (t roundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	start := time.Now()
	resp, err := t.next.RoundTrip(req)
	status := "ok"
	code := 0
	if resp != nil {
		code = resp.StatusCode
		status = statusFor(code)
	}
	if err != nil {
		status = "error"
	}
	send(span{
		TraceID:    genID(16),
		SpanID:     genID(8),
		Service:    serviceName(),
		Name:       req.Method + " " + req.URL.Host,
		Kind:       "client",
		StartUs:    start.UnixMicro(),
		DurationUs: time.Since(start).Microseconds(),
		StatusCode: status,
		Attributes: map[string]string{
			"http.method": req.Method,
			"http.url":    req.URL.String(),
		},
	})
	return resp, err
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func statusFor(code int) string {
	if code >= 500 {
		return "error"
	}
	return "ok"
}
