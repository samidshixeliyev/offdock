# OffDock .NET / C# auto-instrumentation

OffDock traces .NET (C#, ASP.NET Core, F#) applications with the **official
OpenTelemetry .NET Automatic Instrumentation** — a CLR profiler that does
zero-code tracing of ASP.NET Core, HttpClient, Entity Framework Core,
gRPC, SqlClient, and more.

Unlike the Node/Python/PHP/Ruby tracers (single zero-dependency script files),
the .NET agent is a **native binary package** that must be downloaded once on an
internet-connected machine and dropped into this directory before building the
offline bundle — exactly like `opentelemetry-javaagent.jar`.

## How OffDock injects it

When a service is detected as `dotnet` (or pinned via the per-service language
override) and the agent is present, OffDock's deploy engine mounts this whole
directory read-only at `/otel/dotnet` inside the container and injects:

```
CORECLR_ENABLE_PROFILER=1
CORECLR_PROFILER={918728DD-259F-4A6A-AC2B-B85E1B658318}
CORECLR_PROFILER_PATH=/otel/dotnet/linux-x64/OpenTelemetry.AutoInstrumentation.Native.so
DOTNET_ADDITIONAL_DEPS=/otel/dotnet/AdditionalDeps
DOTNET_SHARED_STORE=/otel/dotnet/store
DOTNET_STARTUP_HOOKS=/otel/dotnet/net/OpenTelemetry.AutoInstrumentation.StartupHook.dll
OTEL_DOTNET_AUTO_HOME=/otel/dotnet
OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:7070
```

Spans flow to OffDock's native OTLP receiver at `POST /v1/traces`.

Injection only activates when
`dotnet/net/OpenTelemetry.AutoInstrumentation.StartupHook.dll` exists, so an
empty/absent agent never breaks a deploy — the service just isn't traced.

## Populating the agent (run once, online, then commit/bundle)

Pick the build matching the container's libc. Most images are glibc (`x64`);
Alpine images are musl (`musl-x64`).

```bash
VER=1.9.0   # check github.com/open-telemetry/opentelemetry-dotnet-instrumentation/releases
cd otel/dotnet
curl -fsSL -O \
  https://github.com/open-telemetry/opentelemetry-dotnet-instrumentation/releases/download/v${VER}/opentelemetry-dotnet-instrumentation-linux-glibc-x64.zip
unzip -o opentelemetry-dotnet-instrumentation-linux-glibc-x64.zip
rm opentelemetry-dotnet-instrumentation-linux-glibc-x64.zip
# Result: linux-x64/  net/  netfx/  AdditionalDeps/  store/  integrations.json …
```

After this, `bash install.sh --bundle` includes the agent and
`install.sh --full|--update|--deps` deploys it to `/var/offdock/otel/dotnet`.

> Note: the container must run a glibc-based .NET image for the `x64` build.
> For Alpine images, fetch `…-linux-musl-x64.zip` instead.
