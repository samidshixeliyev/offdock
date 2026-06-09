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

Healthcheck-cutover strategy: brings up `<project>_next` stack → polls health every 3s
(120s timeout) → cuts over by stopping old stack → re-runs as canonical name → reloads nginx.
Streams log lines to SSE clients via the hub.

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

### Bundle structure (canonical)

```
./                                         ← GNU tar root entry
./unzip_6.0-26ubuntu3.2_amd64.deb         ← loose deb at archive root
./offdock-offline/
./offdock-offline/offdock                 ← ELF binary (embedded React UI)
./offdock-offline/install.sh
./offdock-offline/uninstall.sh
./offdock-offline/nginx-setup.sh
./offdock-offline/prepare-usb.sh
./offdock-offline/offdock.service
./offdock-offline/INSTALL.md
./offdock-offline/debs/docker/            ← 43 .deb files (Docker CE + deps)
./offdock-offline/debs/nginx/             ← 107 .deb files (nginx + deps)
./offdock-offline/debs/unzip/             ← 6 .deb files (unzip + deps)
```

Total: 170 entries. Size: ~168MB compressed.

**Output file**: `/home/ubuntu/offdock-complete/offdock-offline-2026-06-04.tar.gz`

### Memory files written

- `~/.claude/projects/-home-ubuntu-offdock-complete/memory/tracing-requirements.md`
- `~/.claude/projects/-home-ubuntu-offdock-complete/memory/sse-reconnection.md`
- `~/.claude/projects/-home-ubuntu-offdock-complete/memory/connection-loss.md`
- `~/.claude/projects/-home-ubuntu-offdock-complete/memory/MEMORY.md` (index)
