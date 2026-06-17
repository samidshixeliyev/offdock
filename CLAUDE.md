# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

OffDock is an offline Docker deployment manager: a single Go binary + systemd service that runs **natively on Ubuntu** (not inside Docker). It manages Docker containers, compose configs, env vars, and nginx — all on air-gapped machines where images arrive via USB as `.tar` files.

## Build commands

```bash
# Full build (frontend → Go binary)
make all

# Frontend only (requires Node.js)
make frontend          # cd web && npm run build

# Backend only (assumes web/dist already built)
make build             # go build -o offdock ./cmd/offdock

# Run tests (Go only)
make test              # go test ./... -v -race

# Single package test
go test ./internal/store/... -v -race

# Dev mode (backend on :7070, Vite dev server on :5173 with proxy)
make dev-backend       # in one terminal
cd web && npm run dev  # in another terminal

# Install to system (must be root, Ubuntu only)
sudo bash install.sh
```

## Architecture

### Storage engine (`internal/store/`)
Custom append-log binary DB — **no external DB libraries**. Each entity type has its own `.db` file under `/var/offdock/data/`. Record format: `[4B payload_len][1B type: 0=active 1=tombstone][4B CRC32][N bytes: MessagePack payload]`. On startup, all records are replayed into an in-memory `map[string]T`; CRC mismatches are silently discarded (crash recovery). All mutations append a record; deletes append a tombstone. Thread-safe via `sync.RWMutex` per `Collection[T]`.

The generic `Collection[T Entity]` in `engine.go` implements `Save`, `FindByID`, `FindAll`, `FindWhere`, `Delete`, `Count`. All entity types implement `GetID() string`.

### Encryption (`internal/crypto/`)
AES-256-GCM. Key derived from `/etc/machine-id` via HKDF-SHA256. Env var values are always stored encrypted; the API never returns decrypted secret values (returns `"********"` instead). Decryption only happens at deploy time when writing `.env` to disk.

### Docker control (`internal/docker/`)
All Docker operations go through `os/exec` CLI calls (`docker`, `docker compose`). Never use the Docker SDK. All calls have explicit `context.WithTimeout`.

### Deployment engine (`internal/deploy/engine.go`)
Healthcheck-cutover strategy: brings up `<project>_next` stack, polls health every 3s (120s timeout), cuts over by stopping old stack and re-running new one as canonical name, reloads nginx if active. Streams all log lines to SSE clients via the hub. All steps are written to `DeploymentRecord.LogText`.

### Nginx control (`internal/nginx/`)
`generator.go` renders Go templates to produce nginx server blocks. `writer.go` uses write-then-rename for atomic config updates, then calls `nginx -t` (fails fast) and `systemctl reload nginx`.

### API (`internal/api/`)
Chi router. All routes under `/api/v1/` except `/api/v1/auth/login` and `/setup` require valid JWT in httpOnly cookie or `Authorization: Bearer` header. Role enforcement: `superadmin > admin > viewer` — viewers get GET-only access. SSE hub (`internal/api/sse/hub.go`) streams deploy logs, container logs, and system stats.

### Frontend (`web/`)
React 18 + Vite + TypeScript + TailwindCSS. Compiled to `web/dist/` and embedded into the Go binary via `//go:embed web/dist`. **No CDN or external resources at runtime.** All API calls go through `web/src/api/client.ts` — no raw `fetch` calls elsewhere.

## Key constraints (never violate)

1. No internet dependencies at runtime — no CDN, no package fetching.
2. The tool runs as a native Go binary, not inside Docker.
3. Docker controlled via `os/exec` CLI only.
4. No SQLite/PostgreSQL/Redis — storage engine is the custom append-log only.
5. No ORM.
6. Single deployable artifact: one Go binary (with embedded frontend).
7. All file writes use write-then-rename atomic pattern.
8. No `panic()` in production paths — return errors.
9. All `os/exec` calls must have `context.WithTimeout` (30s default, 300s for deploy ops).
10. Frontend: no `any` TypeScript types; all API responses have typed interfaces in `client.ts`.

## Directory layout on host

```
/var/offdock/
  data/                 ← .db files
  projects/<id>/        ← docker-compose.yml + .env written at deploy time
  certs/                ← optional SSL certs
  logs/offdock.log
/usr/local/bin/offdock
/etc/offdock/config.yaml
/etc/systemd/system/offdock.service
/etc/nginx/sites-available/offdock-<name>.conf
```

## Config file (`/etc/offdock/config.yaml`)

```yaml
port: 7070
data_dir: /var/offdock/data
log_dir: /var/offdock/logs
log_level: info
jwt_secret: "..."   # required; changing invalidates all sessions
```

## Adding a new entity type

1. Add struct with `GetID() string` to `internal/store/models.go`
2. Add `*Collection[YourType]` field to `DB` struct in `internal/store/store.go`
3. Open it in `store.Open()` with a new `.db` filename
4. Add API handlers, wire routes in `internal/api/router.go`
5. Add TypeScript interface and API method to `web/src/api/client.ts`

## msgpack package

Uses `github.com/vmihaiela/msgpack/v5`. Run `go get github.com/vmihaiela/msgpack/v5@latest` if the module path is wrong — it is the most widely used Go msgpack library. For offline builds, run `go mod vendor` while online and commit the `vendor/` directory.

## Offline build workflow

```bash
# On an internet-connected machine:
go mod download
go mod vendor
cd web && npm install && npm run build && cd ..
make build

# Copy to target machine via USB:
# - offdock (binary)
# - offdock.service
# - install.sh

# On target machine:
sudo bash install.sh
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

## Docs page
`web/src/pages/DocsPage.tsx` (`/docs`) — operator/developer guide (images,
offdock-external network, compose, envs, resource limits, backup/recovery) with
a **Download PDF** button (browser print, no external lib — offline-safe).
