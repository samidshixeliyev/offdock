# OffDock

**Offline-first Docker deployment manager** — a single statically-linked Go binary with an
embedded React UI that runs natively on Ubuntu/Debian. It manages Docker containers, Compose
stacks, environment variables, nginx reverse-proxy configs, backups, and live network/app
tracing — entirely on **air-gapped machines** where images arrive via USB as `.tar` files.

No internet. No external database. No cloud. One binary.

---

## Why OffDock

Most deployment tools assume a registry, a package mirror, and an external database are one
network hop away. On an isolated production network none of that exists. OffDock is built for
exactly that environment:

- **No internet at runtime** — no CDN, no registry, no cloud APIs.
- **Single artifact** — one Go binary with the frontend embedded (`//go:embed`).
- **No external DB** — a custom CRC32-checked append-log store on local disk.
- **Docker via the CLI** — controls `docker` / `docker compose` through `os/exec`, never the SDK.
- **Offline bundle** — Docker, nginx, and network tooling ship as bundled `.deb` packages.

---

## Features

| Area | What you get |
|------|--------------|
| **Deployments** | Compose-based deploys with health-verified rollout, manual tags (GitLab-style), version dedup, image-override rollback, scheduled deploys, pre/post hooks, and a "what will deploy" confirmation. |
| **Self-healing** | Boot-time + on-demand reconciler re-`compose up`s every running project and re-applies all nginx vhosts from the DB. |
| **Images** | Upload `.tar` / `.tar.gz` images from your computer or a server path, **tag images on load**, in-use detection, and type-to-confirm deletes. |
| **Backups** | Archive DB + projects + certs + nginx + Docker **volumes** + **images** (+ optional encrypted `config.yaml`), with dry-run restore, a daily scheduler, retention, and off-box copy. |
| **Network tracing** | Live per-container HTTP/SQL/Redis trace via `tcpdump` — full query text for PostgreSQL, MySQL, MSSQL, MongoDB, Redis. |
| **App tracing** | Native OpenTelemetry OTLP receiver with zero-code language tracers (Java, Node, Python, PHP, Ruby) injected at deploy time. No Jaeger, no collector. |
| **Traffic logs** | Captured HTTP request/response payloads with a trie-indexed fast search, binary-safe storage, and configurable retention. |
| **Storage explorer** | Browse, download, and manage all OffDock data — backups, configs, image tars. |
| **nginx** | Templated reverse-proxy generation with atomic write → `nginx -t` → reload. |
| **Auth** | JWT sessions, role-based access (superadmin/admin/user), and optional OAuth2 / OIDC SSO. |
| **Updates** | Upload a new bundle in the UI (or `install.sh --update`); automatic binary backup + one-click rollback. |

---

## Quick start (offline install)

The offline bundle (`offdock-offline.tar.gz`) contains the binary, an installer, the systemd
unit, and all required `.deb` packages (Docker, nginx, tcpdump, …) for **Ubuntu 22.04 (jammy)**.

```bash
# 1. Transfer the bundle to the target machine (USB, scp, …)
# 2. Extract
tar -xzf offdock-offline.tar.gz
cd offdock-offline

# 3a. Simple install (uses the server IP, HTTP)
sudo bash install.sh --full

# 3b. …or with a domain + TLS and bundled deps
sudo bash install.sh --full --domain deploy.example.com --ssl

# 4. Open the URL shown at the end, go to /setup, and create your admin account.
```

The installer loads bundled images, installs Docker/nginx from the bundled debs,
`apt-mark hold`s the core packages so a later `apt --fix-broken` can't remove them, deploys the
OTel language tracers to `/var/offdock/otel/`, and starts the `offdock` systemd service.

### Updating

```bash
# Either: drop the new bundle on the machine and run
sudo bash install.sh --update          # replace binary + restart

# Or: System → Update in the UI (uploads a .tar.gz, backs up the old binary, restarts)
```

If an update misbehaves, roll back from **System → Update** or:

```bash
mv /usr/local/bin/offdock.bak /usr/local/bin/offdock && systemctl restart offdock
```

---

## Install command reference

| Command | Action |
|---------|--------|
| `sudo bash install.sh --full [--domain D] [--port N] [--ssl] [--no-nginx]` | Non-interactive offline install (debs + images + service). |
| `sudo bash install.sh` | Interactive install. |
| `sudo bash install.sh --update` | Replace the binary + restart. |
| `sudo bash install.sh --restore ARCHIVE` | Restore a backup (`data/`, `projects/`, `certs/`, `nginx/`, `config/`, volumes, images). |
| `sudo bash install.sh --uninstall` | Remove OffDock (keeps `/var/offdock`). |
| `bash install.sh --bundle [OUT]` | **Build the offline bundle** (no root needed). |

See **[OFFLINE_INSTALL_GUIDE.md](OFFLINE_INSTALL_GUIDE.md)** for the full walkthrough
(domains, TLS/PEM, custom nginx vhosts, troubleshooting).

---

## Build from source

Requires Go 1.22+ and Node 18+.

```bash
make all            # frontend (Vite + tsc) → Go binary with embedded web/dist
# or step by step:
make frontend       # cd web && npm run build
make build          # go build -o offdock ./cmd/offdock
make test           # go test ./... -v -race
```

Dev mode:

```bash
make dev-backend            # backend on :7070
cd web && npm run dev       # Vite dev server on :5173 (proxies to :7070)
```

Build the shippable offline bundle:

```bash
bash install.sh --bundle offdock-offline.tar.gz
```

---

## Architecture

```
Browser (React 18 + Vite + TS + Tailwind)   ── embedded via //go:embed web/dist
        │  HTTP (REST + SSE)
        ▼
Go HTTP server (chi router, JWT auth, SSE hub)
   /api/v1/*  → handlers           /*  → embedded SPA
        │
   ┌────┼─────────────┬──────────────┐
   ▼    ▼             ▼              ▼
 store/  docker/    nginx/        deploy/ + selfheal/ + backup/
 append  os/exec    template +    health-verified rollout,
 -log DB  CLI        atomic writer  reconcile, archive/restore
        │
        ▼
 /var/offdock/{data,logs,projects,certs,otel}   /etc/offdock/config.yaml
```

**Storage engine** — one append-log `.db` file per entity type under `/var/offdock/data/`.
Record format: `[4B len][1B type][4B CRC32][JSON]`. Full replay into an in-memory `map` at
startup; mutations append, deletes append a tombstone; `Compact()` reclaims space. All file
writes use the write-then-rename atomic pattern.

---

## Directory layout on the host

```
/usr/local/bin/offdock          ← binary
/usr/local/bin/offdock.bak      ← backup (post-update rollback)
/etc/offdock/config.yaml        ← config (never touched by updates)
/etc/systemd/system/offdock.service
/var/offdock/
  data/        ← *.db collection files
  logs/        ← offdock.log (dual stdout + file)
  projects/    ← docker-compose.yml + .env per project
  certs/       ← TLS PEM bundles
  otel/        ← bundled OpenTelemetry language tracers
```

---

## Configuration

OffDock reads `/etc/offdock/config.yaml` (override the path with `OFFDOCK_CONFIG` for dev/WSL).
Key settings: `port`, `data_dir`, `log_dir`, `jwt_secret`, `default_pem_path` (HTTPS), SMTP
(Exchange/Outlook on-prem), and OAuth2/OIDC. The update process **never** touches this file, so
settings persist across upgrades.

> ⚠️ Keep `jwt_secret` safe — changing it invalidates all sessions.

---

## Requirements

- **Target OS:** Ubuntu 22.04 LTS (jammy) — the bundled `.deb` packages are release-specific.
- **Privileges:** root (or `CAP_NET_RAW` for the network tracer).
- **Optional:** `tcpdump` (bundled) for tracing; a domain + TLS cert for HTTPS.

---

## License

Proprietary — internal deployment tooling. Contact the maintainers before redistribution.
