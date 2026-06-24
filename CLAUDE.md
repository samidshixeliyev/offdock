# CLAUDE.md — OffDock System Reference

## What this project is

OffDock is an **offline-first Docker deployment manager**: a single statically-linked Go binary
with an embedded React UI that runs natively on Ubuntu/Debian Linux.  It manages Docker
containers, compose stacks, env-vars, nginx reverse-proxy configs, and a container network
tracer — all on air-gapped machines where images arrive via USB as `.tar` files.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Browser (React 18 + Vite + TypeScript + TailwindCSS)   │
│  Embedded in Go binary via //go:embed web/dist          │
└────────────────────┬────────────────────────────────────┘
                     │  HTTP (REST + SSE)
                     ▼
┌─────────────────────────────────────────────────────────┐
│  Go HTTP server  (chi router, JWT auth, SSE hub)        │
│  /api/v1/*  ──  Handlers (handlers/ package)            │
│  /*         ──  Embedded SPA (index.html fallback)      │
└────┬───────────────┬──────────────┬─────────────────────┘
     │               │              │
     ▼               ▼              ▼
  store/         docker/        nginx/
  append-log     os/exec CLI    generator +
  binary DB      (no SDK)       atomic writer
     │
     ▼
/var/offdock/data/*.db   (CRC32-protected append-log files)
/var/offdock/logs/offdock.log  (dual stdout+file logging)
/var/offdock/projects/         (compose + .env files)
/var/offdock/certs/            (TLS PEM bundles)
```

### Storage Engine (`internal/store/`)

Custom **append-log binary DB** — no SQLite, no PostgreSQL, no Redis, no external DB.

- Each entity type: one `.db` file under `/var/offdock/data/`
- Record format: `[4B payload_len][1B type: 0=active 1=tombstone][4B CRC32][N bytes: JSON]`
- Startup: full replay into `map[string]T` in memory; CRC mismatches silently skipped
- Mutations: append a record; deletes append a tombstone
- Thread-safe via `sync.RWMutex` per `Collection[T]`
- **Compaction**: `Collection.Compact()` rewrites the file keeping only live records.
  Call `POST /api/v1/system/compact` (superadmin) to shrink disk usage.

### Docker Control (`internal/docker/`)

All Docker operations use `os/exec` CLI calls (`docker`, `docker compose`).
**Never uses the Docker SDK.** All calls have explicit `context.WithTimeout`.

### Deployment Engine (`internal/deploy/engine.go`)

**Direct in-place replacement** strategy (NOT blue-green — there is no `_next` stack):
1. Write compose + env to disk (atomic).
2. `docker compose up -d --force-recreate --remove-orphans`.
3. Poll health every 3s until all containers are healthy/stable or timeout (per-project
   settings, default 120s). One-shot/init containers that exited 0 count as healthy.
4. Reload nginx if a config is active. Streams log lines to SSE clients via the hub.

Per-project mutex serialises deploys. `DeployVersion(... deployID ...)` uses the caller's
ID so the SSE stream key and the persisted record correlate. On failure OR cancel, if
`RollbackOnFailure` is set the engine restores the previous good version **and health-verifies
it** (project goes back to `running`); otherwise it logs that the in-place stack may be in a
partial state. This strategy has brief downtime during recreate — acceptable for the
air-gapped deployment cadence.

### Nginx Control (`internal/nginx/`)

- `generator.go` renders Go templates → nginx server blocks
- `writer.go` uses write-then-rename for atomic config updates, then `nginx -t` + `systemctl reload nginx`

### Network Tracer (`internal/api/handlers/container_trace.go`)

Live per-container HTTP/SQL/Redis trace via `tcpdump` on the container's bridge interface.
- Requires `CAP_NET_RAW` (root or privileged service)
- SSE stream: events delivered as JSON `TraceSpan` objects
- Sessions auto-saved to `TraceSessions` collection when stream closes
- Full SQL text captured from tcpdump packet payload (PostgreSQL, MySQL, MSSQL, MongoDB, Redis)

### Logging (`cmd/offdock/main.go`)

Dual-output: `io.MultiWriter(os.Stdout, logFile)`.
- stdout → captured by journald when running under systemd
- `/var/offdock/logs/offdock.log` → always written for non-systemd and log viewer access
- App logs UI: `GET /api/v1/system/app-logs` (snapshot) + `GET /api/v1/system/app-logs/stream` (SSE)

---

## Key Constraints — Never Violate

1. **No internet at runtime** — no CDN, no external package registry, no cloud APIs
2. **Native Go binary** — not inside Docker; controls Docker via CLI
3. **Docker via `os/exec` only** — never the Docker SDK
4. **No external DB** — custom append-log only
5. **No ORM**
6. **Single deployable artifact** — one binary (embedded frontend)
7. **All file writes** — write-then-rename atomic pattern
8. **No `panic()`** in production paths — return errors
9. **All `os/exec` calls** — must have `context.WithTimeout` (30s default, 300s for deploys)
10. **Frontend** — no `any` TypeScript types; all API responses typed in `client.ts`

---

## Phase 1: Offline-First Risk Assessment

| Risk | Cause | Mitigation |
|------|-------|-----------|
| Docker pull fails | No registry access | Load images from USB `.tar` files via `docker load` |
| nginx install fails | No apt repos | Bundle all `.deb` packages in `debs/nginx/` |
| Docker install fails | No apt repos | Bundle all `.deb` packages in `debs/docker/` |
| SMTP DNS resolution hangs | No DNS server | Use IP address for `smtp_host`; 15s dial timeout now enforced on all modes |
| SMTP 5.7.4 auth error | Exchange prefers LOGIN over PLAIN | LOGIN tried first; falls back to PLAIN based on server advertisement |
| JWT expiry wrong | NTP absent, clock drift | Set system time manually; JWT uses relative TTL not absolute timestamps |
| TLS cert rejection | Self-signed CA not trusted | Set `smtp_insecure_skip_verify: true` or provide `smtp_ca_cert_file` |
| Disk full | Large trace sessions | Run `POST /api/v1/system/compact` to reclaim space |
| Log file grows | High-volume logging | journald rotation handles stdout; log file grows without rotation — add logrotate config |
| `tcpdump` fails | Missing binary or permissions | Install `tcpdump` package; run offdock as root or grant `CAP_NET_RAW` |
| Container network not found | Host networking mode | Error returned via SSE; container must use bridge networking |

---

## Phase 2: SMTP Deep Diagnostics

### Why SMTP fails offline

**DNS failures**: `smtp_host` may be a hostname that resolves via corporate DNS.  On an
air-gapped machine with no DNS server, `net.Dial` hangs until timeout (was: unlimited for
`sendPlain`; fixed to 15s across all modes).

**TLS failures**: Corporate Exchange uses self-signed or internal-CA certificates.  Go's
default TLS verifies the certificate chain.  Fix: set `smtp_insecure_skip_verify: true`
in config, or provide `smtp_ca_cert_file: /path/to/corp-ca.pem`.

**Authentication 5.7.4**: Exchange on-prem advertises only `LOGIN` auth, not `PLAIN`.
Go's `smtp.PlainAuth` sends a `PLAIN` `AUTH` command → server rejects with 5.7.4.
Fix (implemented): check `AUTH` extension advertisement after STARTTLS; try `LOGIN`
first, fall back to `PLAIN` only if LOGIN is not offered or fails.

**No relay access**: Some Exchange deployments require the sender IP to be whitelisted.
Use `smtp_from` that matches a permitted sender address.

### Config reference

```yaml
smtp_host: 192.168.1.100     # IP preferred — no DNS needed
smtp_port: 587
smtp_mode: starttls           # starttls | implicit | plain
smtp_username: offdock@corp.local
smtp_password: secret
smtp_from: offdock@corp.local
smtp_insecure_skip_verify: true   # for self-signed Exchange certs
# smtp_ca_cert_file: /var/offdock/certs/exchange-ca.pem
dns_admin_email: dns-admin@corp.local
```

---

## Phase 3: Tracing — SQL Full Query

The tracer uses `tcpdump` to capture raw TCP payloads on the container's bridge interface.
SQL text is extracted directly from the unencrypted wire protocol:

- **PostgreSQL**: Extended Query Protocol (`P` parse message) + Simple Query (`Q`)
- **MySQL**: COM_QUERY (0x03) packet
- **MSSQL**: TDS SQL Batch (type 0x01), including UTF-16LE decoded
- **Redis**: RESP protocol command tokens
- **MongoDB**: OP_MSG `find`/`insert`/`aggregate` detection

**Full query text is captured** — not just parameter values.  Parameter bindings appear
inline in the captured SQL (they are transmitted as part of the statement text in most
wire protocols at the query boundary).

**Limitation**: Encrypted connections (TLS/SSL) are not visible to tcpdump at the
network layer.  Containers using TLS-encrypted DB connections will show no SQL spans.

---

## Phase 4: Storage — No Redis Dependency

OffDock **does not use Redis**.  The storage engine is a custom append-log binary DB
implemented in `internal/store/engine.go`.

Characteristics:
- Zero external dependencies — no Redis, no SQLite, no PostgreSQL
- CRC32 integrity checking on every record
- Startup replay into in-memory `map[string]T` — all reads from memory
- Compaction via `Collection.Compact()` — online, safe, < 50ms even for large files
- Suitable for the scale: hundreds of deployments, thousands of audit events

---

## Phase 8: Update Mechanism

### Current mechanism (implemented)

1. **Upload** `POST /api/v1/system/update` (multipart, `.tar.gz` of the full offline bundle)
2. Extract to temp dir → find `offdock` ELF binary → validate magic bytes
3. **Backup** current binary to `offdock.bak` ← **new** (rollback support)
4. Atomic replace: copy to `offdock.new` → `rename(new → install)`
5. Detached restart: `setsid sh -c 'sleep 2 && systemctl restart offdock'`

### Rollback

If the new binary crashes:
- `POST /api/v1/system/rollback` (superadmin): restores `offdock.bak` + restarts
- `GET /api/v1/system/update/status`: returns `can_rollback: true` when `.bak` exists
- Manual: `mv /usr/local/bin/offdock.bak /usr/local/bin/offdock && systemctl restart offdock`

### Config preservation

The update process **never touches `/etc/offdock/config.yaml`**.  All settings persist
across updates.  The service restarts with the existing config.

### Zero-downtime

The current mechanism has ~2–5 seconds of downtime during `systemctl restart`.
True zero-downtime would require a second listening socket and process hand-off
(not implemented — unnecessary for the deployment cadence of an air-gapped system).

---

## Build Commands

```bash
# Full build (frontend → Go binary with embedded web/dist)
make all

# Frontend only
make frontend          # cd web && npm run build

# Backend only (assumes web/dist already built)
make build             # go build -o offdock ./cmd/offdock

# Tests
make test              # go test ./... -v -race

# Dev mode
make dev-backend       # backend on :7070
cd web && npm run dev  # Vite dev server on :5173 with proxy
```

---

## Offline Installation

### Prerequisites

The offline bundle (`offdock-offline.tar.gz`) contains:

- `offdock` — compiled Go binary (embedded frontend)
- `install.sh` — fully automated installer
- `offdock.service` — systemd unit file
- `debs/docker/` — Docker CE + containerd .deb packages (Ubuntu 22.04 amd64)
- `debs/nginx/` — nginx .deb packages (Ubuntu 22.04 amd64)
- `debs/unzip/` — unzip + dependencies
- `nginx-setup.sh`, `uninstall.sh`, `prepare-usb.sh`

### Install steps

```bash
# 1. Transfer the bundle to the target machine (USB, scp, etc.)
# 2. Extract
tar -xzf offdock-offline.tar.gz
cd offdock-offline

# 3. Run installer as root
sudo bash install.sh

# 4. Follow prompts: port, domain, SSL cert, nginx
# 5. Open the UI URL shown at the end
# 6. Go to /setup and create your admin account
```

### Update steps

```bash
# Place new offdock-offline.tar.gz on the machine, then:
sudo bash install.sh --update
# — or upload via the UI at System → Update
```

---

## Troubleshooting

### Service not starting

```bash
journalctl -u offdock -n 50 --no-pager
# Or check the log file directly:
tail -100 /var/offdock/logs/offdock.log
```

### Permission denied on /var/offdock

```bash
chown -R root:root /var/offdock && chmod 700 /var/offdock/data
systemctl restart offdock
```

### Tracing shows "disconnected"

1. Container must be running: `docker inspect --format '{{.State.Running}}' <name>`
2. Container must use bridge networking (not `--network host`)
3. `tcpdump` must be installed: `which tcpdump`
4. OffDock must run as root or have `CAP_NET_RAW`

### SMTP fails with 5.7.4

Set `smtp_mode: starttls` and ensure the Exchange server's AUTH advertisement is visible.
If it persists, check: `openssl s_client -starttls smtp -connect host:587` and look for
`250-AUTH` in the server greeting.

### Disk growing unexpectedly

Trace sessions with many events are stored in `trace_sessions.db`.  Compact the DB:

```bash
# Via API (superadmin):
curl -X POST -b 'offdock_token=...' http://localhost:7070/api/v1/system/compact
# Returns: {"status":"ok","bytes_before":...,"bytes_after":...,"bytes_freed":...}
```

### JWT secret lost

If `/etc/offdock/config.yaml` is deleted, all sessions become invalid.
Generate a new secret and restart: `head -c48 /dev/urandom | base64`.

### Rollback after bad update

```bash
# Via API (if service is still running):
curl -X POST -b 'offdock_token=...' http://localhost:7070/api/v1/system/rollback

# Manually (if service is down):
mv /usr/local/bin/offdock.bak /usr/local/bin/offdock
systemctl restart offdock
```

---

## Directory Layout on Host

```
/usr/local/bin/offdock          ← binary
/usr/local/bin/offdock.bak      ← backup (post-update rollback)
/etc/offdock/config.yaml        ← config (never touched by updates)
/etc/systemd/system/offdock.service
/var/offdock/
  data/                         ← *.db collection files
  logs/offdock.log              ← log file (dual with journald)
  certs/                        ← TLS PEM bundles
  projects/<id>/                ← docker-compose.yml + .env
/etc/nginx/sites-available/offdock-self.conf
/etc/nginx/sites-available/offdock-<name>.conf
```

---

## Config File (`/etc/offdock/config.yaml`)

```yaml
port: 7070
data_dir: /var/offdock/data
log_dir: /var/offdock/logs
log_level: info          # info | debug

jwt_secret: "..."        # KEEP SECRET — changing invalidates all sessions

default_pem_path: ""     # combined PEM (key + cert chain) for HTTPS

# SMTP (Exchange/Outlook on-prem)
smtp_host: 192.168.1.100
smtp_port: 587
smtp_mode: starttls      # starttls | implicit | plain
smtp_username: offdock@corp.local
smtp_password: secret
smtp_from: offdock@corp.local
smtp_insecure_skip_verify: false
smtp_ca_cert_file: ""
dns_admin_email: dns-admin@corp.local

# OAuth2 / AO ID SSO
oauth_enabled: false
oauth_issuer: ""
oauth_client_id: ""
oauth_client_secret: ""
oauth_redirect_uri: ""
oauth_scope: "openid profile email"
# Claim mapping — OffDock needs exactly three things from userinfo: username,
# email, full name. The subject is always the standard OIDC "sub" claim and
# isn't configurable (every compliant IdP, including AO IDP, returns it
# unconditionally). Defaults below match AO IDP's fixed /oauth2/userinfo
# response shape (UserInfoResponse: sub, ldap_username, email, display_name).
# AO IDP's admin-side claim mappings only affect its JWT access token, not this
# endpoint, so these names are effectively constants for AO ID — only override
# for a different IdP.
oauth_claim_email: email
oauth_claim_username: ldap_username
oauth_claim_name: display_name
oauth_tls_skip_verify: false
```

---

## Phase 9: Recent Changes (2026-06-04 session)

### Tracing — SSE reconnection + error UX

**Problem**: Silent failures when `tcpdump` was missing, permissions were wrong,
or the container used host networking. Errors showed in a tiny truncated
`max-w-xs` span.

**Changes to `web/src/pages/TracingPage.tsx`**:

- `LiveTracePanel` SSE auto-reconnect: `reconnectKey` state (bumped on retry)
  drives a new `EventSource` in the effect; `permanentErrorRef` (ref, not state)
  prevents reconnect loops on permanent errors; up to `MAX_RECONNECTS=5` retries
  with `RECONNECT_DELAY_MS=3000` delay; status label shows `reconnecting N/5`.
- `isPermanentTraceError(msg)` classifies errors that must never auto-reconnect:
  `tcpdump failed to start`, `tcpdump not found`, `executable file not found`,
  `cap_net_raw`, `permission denied`, `could not find container network`,
  `host networking`, `is not running`, `non-standard bridge`.
- `TraceErrorCard` component: full-width card with `AlertTriangle` icon +
  requirements checklist (`TRACE_REQUIREMENTS` constant). Replaces old inline
  truncated span. Shows when `status === 'error'`.
- Sidebar footer: "System requirements" section listing all three prerequisites
  (tcpdump, root/CAP_NET_RAW, bridge networking) alongside the existing
  "Captured protocols" legend.

### Tracing — mobile sidebar fix

**Problem**: Sidebar was hardcoded `w-72 shrink-0` — on mobile it consumed
288px leaving almost no space.

**Changes**:

- `sidebarOpen` state (default `false`) added to `TracingPage`.
- Mobile backdrop: `fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-30 md:hidden`
  rendered when `sidebarOpen === true`.
- `<aside>` classes: `fixed inset-y-0 left-0 z-40 transition-transform
  duration-300 ease-in-out md:relative md:translate-x-0` + `-translate-x-full`
  / `translate-x-0` based on `sidebarOpen`.
- Mobile toggle `<button>` with `Menu` icon added to:
  - `LiveTracePanel` header (always visible on mobile)
  - `SessionsListPanel` header (prop `onOpenSidebar` added to its type — was
    previously missing, causing a TypeScript build error)
  - Empty-state panel (absolute-positioned top-left button)
- Waterfall column headers + `TransactionRow`: `Time`, `Spans`, `Timeline bar`
  columns use `hidden sm:inline` / `hidden sm:flex` / `hidden sm:block`.
- Sessions table wrapped in `overflow-x-auto` + `min-w-[640px]`.

### Other pages — mobile fixes

- **`DeployPage.tsx`**: deploy-settings `grid-cols-3` → `grid-cols-1
  sm:grid-cols-3`; tag-form and version-picker `grid-cols-2` →
  `grid-cols-1 sm:grid-cols-2`.
- **`EnvPage.tsx`**: variable row `flex` → `flex-wrap sm:flex-nowrap`; key
  input `w-52 shrink-0` → `w-full sm:w-52 shrink-0`.
- **`LogsPage.tsx`**: log body `overflow-y-auto` → `overflow-auto` (both axes).
- **`ImagesPage.tsx`**, **`NginxPage.tsx`**, **`USBPage.tsx`**: already
  responsive — no changes needed.

### TypeScript fix

Removed unused `Terminal` icon import from `TracingPage.tsx` (was imported
from lucide-react but only used as plain text in JSX, not as an icon component).
`tsc --noEmit` now exits 0 with no errors.

### Build & deployment

```bash
# Rebuild everything
cd source/web && npm run build      # Vite + tsc → web/dist/
cd source && make build              # go build → offdock binary (17MB, stripped)

# Deploy on this machine (service is active at /usr/local/bin/offdock)
sudo systemctl stop offdock
sudo cp source/offdock /usr/local/bin/offdock
sudo systemctl start offdock
# Verify:
systemctl is-active offdock

# Create offline bundle (matching offdock-offline.tar.gz structure exactly)
# Bundle must have: ./offdock-offline/ root + debs/docker/ debs/nginx/ debs/unzip/
# + loose unzip_*.deb at archive root. Reuse debs from existing offdock-offline.tar.gz.
cd /tmp && tar -xzf /home/ubuntu/offdock-complete/offdock-offline.tar.gz
# Replace binary, keep all debs, repack:
cp source/offdock /tmp/offdock-offline/offdock
cp source/install.sh source/uninstall.sh source/nginx-setup.sh source/prepare-usb.sh source/offdock.service /tmp/offdock-offline/
cd /tmp && tar --format=gnu -czf /home/ubuntu/offdock-complete/offdock-offline-YYYY-MM-DD.tar.gz \
  unzip_6.0-26ubuntu3.2_amd64.deb offdock-offline/
```

## install.sh — the ONE script (no other .sh files)

All install/build/restore operations live in `install.sh`. `make-bundle.sh`,
`prepare-usb.sh`, `nginx-setup.sh`, `uninstall.sh` were removed. Flags:

| Command | Action |
|---|---|
| `bash install.sh --bundle [OUT]` | Build the offline `.tar.gz` (no root). Bundles binary + frontend + `debs/{docker,nginx,network}` + `images/*.tar` + VERSION. |
| `sudo bash install.sh --full [--domain D] [--port N] [--no-nginx] [--ssl]` | Non-interactive offline install: installs Docker/nginx/network tools from bundled debs, loads images, `apt-mark hold`s core packages, verifies tools, starts the service. Runs under `set +e` (handles its own errors). |
| `sudo bash install.sh` | Interactive install. |
| `sudo bash install.sh --update` | Replace binary + restart. |
| `sudo bash install.sh --restore ARCHIVE` | Restore a backup (`data/`, `projects/`, `certs/`, `nginx/`, `config/`, Docker `volumes/`). |
| `sudo bash install.sh --uninstall` | Remove (keeps `/var/offdock`). |

Shell scripts MUST be LF (enforced by `.gitattributes`) — CRLF breaks them on Linux.

### Offline deb bundle
`debs/` is split by category: `docker/` (docker-ce, cli, containerd, buildx,
compose), `nginx/` (core/common/full), `network/` (tcpdump, dnsutils, iproute2,
iptables, conntrack, socat, curl, jq…). Debs are **release-specific** — gather on
a host matching the target release. **Production target is Ubuntu 22.04 (jammy)**;
gather/build on 22.04. Gather full recursive closures via
`apt-cache depends --recurse … | apt-get download --print-uris` then parallel
`curl`. Do NOT include `gnupg` in the network set — it pulls GTK/Qt GUI bloat.

## Self-healing, backup, and maintenance subsystems

- `internal/selfheal/` — boot-time + on-demand reconciler (`POST /system/reconcile`):
  ensures Docker is up, re-`compose up`s every `running` project, re-applies all
  active nginx vhosts/proxy hosts from the DB. Runs in the background at startup.
- `internal/system/pkgguard.go` — `apt-mark hold` of Docker/nginx, re-asserted at
  startup so `apt --fix-broken install` can never remove them.
- `internal/api/handlers/packages.go` — safe `.deb` install / fix-broken that
  simulates first and **refuses** any operation that would remove a protected pkg.
- `internal/backup/` — archive (db + projects + certs + nginx + optional encrypted
  `config.yaml` + Docker volume data), restore (dry-run inspect), and a daily
  scheduler with retention + off-box copy. Volume export/import uses an `alpine`
  helper image — keep it loaded.
- `internal/security/cmdpolicy.go` — deny/allow command policy enforced + audited
  on the terminal exec endpoint; built-in dangerous-command denylist always on.
- Storage compaction: `Collection.Compact()` / `DB.CompactAll()`; memory optimize
  via `POST /system/optimize` (compact + drop_caches + optional docker prune).

## Versioning, dedup, rollback

- Compose + env are content-hashed; saving identical content returns
  `{unchanged:true}` instead of bumping the version. Env hash is over **decrypted**
  plaintext (ciphertext is non-deterministic).
- `POST /projects/{id}/rollback` re-deploys a tag / past deployment / explicit
  version pair. `DeploySettings.RollbackOnFailure` auto-reverts a failed deploy.
- `OFFDOCK_CONFIG` env var overrides the `/etc/offdock/config.yaml` path (dev/WSL).

## Deployment UX (2026-06-18 session)

- **Tags are manual only (GitLab-style)** — deploys no longer auto-create a
  `deploy-<ts>` tag (`deploy.go`). The DeployPage has "Create tag" + a one-click
  "Tag last deploy" (pins the last successful compose+env). `trimAutoTags` removed.
- **"What will deploy" confirmation** — every deploy/rollback funnels through a
  modal showing the target compose+env version, image overrides, and a compose
  preview before going live.
- **Version content viewer** — compose YAML + env vars per version inline in the
  deploy page. Superadmins can **reveal secret values** via
  `GET /env/history?reveal=true` (server decrypts, audited `env_reveal_secrets`).
- **Image override deploy** — `DeploySettings.ImageOverrides` (service→repo:tag)
  applied to the compose at deploy time via `applyComposeOverrides` (same path as
  DNS injection); lets a project deploy a previously-loaded image (image rollback)
  without editing the YAML. UI in the deploy settings card.
- **Image management** — `GET /images/usage` annotates every docker image with
  in-use/used-by (cross-refs `docker ps -a`); ImagesPage has an "unused only"
  filter and a **type-the-name-to-confirm** delete modal. `POST /images/remove`
  deletes by ref/ID (refuses in-use unless `force`).
- **Backup fix** — volume export/import tars the volume's host mountpoint
  directly (`docker volume inspect` → host `tar`), so backups no longer need the
  `alpine` helper image; the container helper remains a fallback for
  rootless/remote daemons. A volume that can't be read → `partial`, not failure.
- **Host-terminal bypass fix** — TerminalPage now honours the `{bypass:true}`
  OTP response and opens the shell with no token (backend already allowed it).

## Docs page
`web/src/pages/DocsPage.tsx` (`/docs`) — operator/developer guide (images,
offdock-external network, compose, envs, resource limits, backup/recovery) with
a **Download PDF** button (browser print, no external lib — offline-safe).

## OpenTelemetry app tracing (merged from main)

- `internal/api/handlers/otel_traces.go` — native OTLP receiver + query API
  (`/api/v1/otel/{status,services,operations,traces,traces/{id}}`) plus the span
  ingest endpoints `POST /v1/traces` (OTLP) and `POST /v1/span` (OffDock simple).
  Spans persist to the `otel_spans` collection; retention trims by count/age.
- `internal/api/handlers/app_logs.go` — `/api/v1/system/app-logs` snapshot + SSE.
- `otel/` — zero-dependency, offline language tracers shipped in the bundle and
  deployed to `/var/offdock/otel/` by install.sh (node, python, php, ruby +
  `opentelemetry-javaagent.jar`). Injected into containers at deploy time when
  `DeploySettings.OTelEnabled` is set — `appendOTelEnv` adds `OTEL_*` env and
  `writeOTelComposeOverride` mounts the right tracer per detected/overridden
  service language. No Jaeger, no external collector.
- `web/src/pages/OTelTracesPage.tsx` (`/otel-traces`, "App Traces") +
  `AppLogsPage.tsx` (`/app-logs`).
- `install.sh` deploys/refreshes `/var/offdock/otel/` on `--full` and `--update`
  (and `--deps`) so the tracers are always present without a full reinstall.
