# OffDock Go auto-instrumentation

Go binaries are statically compiled and have **no runtime preload hook** (no
equivalent of `NODE_OPTIONS`, `JAVA_TOOL_OPTIONS`, or a CLR profiler), so there
is no single "drop-in agent" that works for every Go container the way the
Node/Java/.NET agents do. OffDock gives Go three layers of coverage:

## 1. Zero-config, if the app uses the OpenTelemetry-Go SDK (recommended)

Most production Go services already build in the OpenTelemetry-Go SDK. When they
do, OffDock needs **no code change** — it injects the standard env so the SDK
exports straight to OffDock's native OTLP receiver:

```
OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:7070
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_SERVICE_NAME=<project>-<service>
OTEL_TRACES_SAMPLER=parentbased_traceidratio
```

This happens automatically once a service is detected as `go` (or pinned via the
per-service language override).

## 2. Wire-level network tracer (works for ANY Go app, no code change)

For Go apps that do **not** embed the SDK, OffDock's built-in network tracer
(tcpdump-based, see the "Net Traces" page) captures HTTP and SQL at the wire
level on the container's bridge interface. No agent, no rebuild.

## 3. One-line manual span helper (`tracer.go`)

`tracer.go` in this directory is a **zero-dependency** helper (stdlib only) that
sends spans to OffDock's simple ingest endpoint `POST /v1/span`. Copy it into a
package and wrap an `http.Handler` / `http.RoundTripper` to emit spans without
pulling the full OTel SDK. OffDock mounts this directory at `/otel/go` inside
detected Go containers for convenience.

## eBPF auto-instrumentation (optional, advanced)

True zero-code Go tracing is possible with eBPF
(`go.opentelemetry.io/auto`) running as a **privileged sidecar** that attaches
uprobes to the target binary. It requires a recent kernel, `privileged: true`,
and `pid: "service:<svc>"` sharing. OffDock does not enable this automatically
because it can destabilise deploys on restricted kernels; add it manually to a
compose override if you need it, pointing `OTEL_EXPORTER_OTLP_ENDPOINT` at
`http://host.docker.internal:7070`.
