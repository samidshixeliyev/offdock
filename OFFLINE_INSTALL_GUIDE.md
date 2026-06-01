# OffDock — Offline Installation Guide

OffDock runs as a native Go binary + systemd service on Ubuntu. The offline bundle
ships with everything needed: the binary, Docker .deb packages, and nginx .deb packages.
No internet access is required on the target machine.

---

## What is in the bundle

```
offdock-bundle/
  offdock              ← compiled binary (frontend embedded)
  offdock.service      ← systemd unit file
  install.sh           ← installer (run this)
  uninstall.sh         ← uninstaller
  debs/
    docker/            ← Docker CE .deb packages
    nginx/             ← nginx .deb packages
```

---

## Quick install (most common case)

```bash
cd ~
unzip offdock-offline.zip
cd offdock-bundle

# With domain + wildcard TLS cert (recommended):
sudo bash install.sh --domain deploy.ao.az --pem /path/to/wildcard.pem

# Without domain (uses server IP, HTTP only):
sudo bash install.sh
```

Then open a browser and go to `http(s)://deploy.ao.az/setup` to create your admin account.

---

## Install options

| Flag | Description | Example |
|------|-------------|---------|
| `--domain DOMAIN` | Domain for the OffDock UI | `--domain deploy.ao.az` |
| `--pem PATH` | Combined PEM file (cert chain + private key). Enables HTTPS. A wildcard cert (*.ao.az) covers OffDock UI + all deployed app subdomains. | `--pem /etc/ssl/wildcard.ao.az.pem` |
| `--port PORT` | OffDock listen port (default 7070) | `--port 8080` |
| `--data-dir DIR` | Data directory (default `/var/offdock/data`) | |
| `--no-nginx` | Skip nginx configuration | |
| `--uninstall` | Remove OffDock (preserves data) | |

---

## What the installer does

1. Installs Docker CE from bundled `.deb` packages (skips if already installed)
2. Installs nginx from bundled `.deb` packages (skips if already installed)
3. Generates a random JWT secret and writes `/etc/offdock/config.yaml`
4. Creates runtime directories under `/var/offdock/`
5. Copies the binary to `/usr/local/bin/offdock`
6. Installs and starts the `offdock` systemd service
7. Configures nginx with two vhosts:
   - **`00-offdock-default.conf`** — catch-all: any unrecognised domain/IP is
     redirected to the OffDock UI (HTTP → HTTPS if PEM provided, HTTP otherwise)
   - **`offdock-self.conf`** — explicit vhost for the OffDock domain/IP

---

## nginx layout after install

```
/etc/nginx/sites-available/
  00-offdock-default.conf   ← catch-all → redirect to OffDock
  offdock-self.conf         ← OffDock UI (deploy.ao.az or server IP)
  offdock-<project>.conf    ← per-project vhosts (added by OffDock at deploy time)

/etc/nginx/sites-enabled/
  00-offdock-default.conf → (symlink)
  offdock-self.conf        → (symlink)
```

**With `--pem` provided:**
- Port 80 (any host) → redirect to `https://deploy.ao.az`
- Port 443 `deploy.ao.az` → proxy to OffDock on `:7070`
- Port 443 (any other host/IP) → proxy to OffDock on `:7070` (fallback)

**Without `--pem`:**
- Port 80 (any host) → proxy to OffDock on `:7070` directly

---

## PEM file format

OffDock uses a **single combined PEM file** containing both the private key and the
full certificate chain concatenated. nginx uses the same file path for both
`ssl_certificate` and `ssl_certificate_key`.

```bash
# Combine key + cert into one file:
cat private.key fullchain.crt > wildcard.ao.az.pem

# Copy to server:
sudo cp wildcard.ao.az.pem /var/offdock/certs/wildcard.ao.az.pem
sudo chmod 600 /var/offdock/certs/wildcard.ao.az.pem
```

A wildcard cert (`*.ao.az`) automatically covers:
- `deploy.ao.az` — OffDock UI
- `app1.ao.az`, `grafana.ao.az`, etc. — deployed apps added via Reverse Proxy

---

## First-time setup

1. Open `https://deploy.ao.az/setup` in a browser
2. Create your **superadmin** account (username + password)
3. Log in — you now have full access

> If you see a TLS warning, your cert is self-signed. Click Advanced → Proceed.
> For a trusted cert, use a proper CA-signed wildcard cert in the `--pem` flag.

---

## Deploying apps

1. Go to **Projects** → **New Project**
2. Paste a `docker-compose.yml` in the Compose tab
3. Add environment variables in the Env tab
4. Click **Deploy** — OffDock brings up the stack and streams logs live
5. Go to **Reverse Proxy** → **Add Host** to expose the app on a subdomain

---

## Loading Docker images (air-gapped workflow)

On an internet-connected machine:

```bash
docker pull myapp:1.2.3
docker save myapp:1.2.3 -o myapp-1.2.3.tar
# Copy myapp-1.2.3.tar to USB
```

On the air-gapped server via OffDock UI:

1. Plug in the USB drive
2. Go to **USB Import** in the sidebar
3. Browse to the `.tar` file and click **Load Image**
4. Reference it in your compose: `image: myapp:1.2.3`

---

## Upgrading OffDock

```bash
# Copy new offdock-offline.zip to the server, then:
cd ~
unzip -o offdock-offline.zip
cd offdock-bundle
sudo bash install.sh   # restarts the service with the new binary
```

The installer only overwrites the binary and service file — config and data are preserved.

---

## Service management

```bash
sudo systemctl status offdock        # check status
sudo systemctl restart offdock       # restart
sudo systemctl stop offdock          # stop
sudo journalctl -u offdock -f        # follow live logs
sudo journalctl -u offdock -n 100    # last 100 log lines
```

---

## Uninstall

```bash
# Remove OffDock (preserves data in /var/offdock)
sudo bash uninstall.sh

# Also remove all data, certs, and projects:
sudo bash uninstall.sh --purge
```

---

## Directory layout

```
/usr/local/bin/offdock              ← binary
/etc/offdock/config.yaml            ← config (root:root 600)
/etc/systemd/system/offdock.service

/var/offdock/
  data/           ← *.db files (append-log store, AES-256-GCM encrypted env vars)
  projects/       ← docker-compose.yml + .env written at deploy time
  certs/          ← SSL PEM files
  logs/offdock.log

/etc/nginx/sites-available/         ← managed by OffDock
```

---

## Config file reference

`/etc/offdock/config.yaml`

```yaml
port: 7070
data_dir: /var/offdock/data
log_dir: /var/offdock/logs
log_level: info          # debug | info | warn | error
jwt_secret: "..."        # auto-generated — changing this logs everyone out
default_pem_path: ""     # path to combined PEM; enables HTTPS on deployed apps
```

After editing: `sudo systemctl restart offdock`

---

## Troubleshooting

**OffDock fails to start**
```bash
sudo journalctl -u offdock -n 50
# Check: /etc/offdock/config.yaml exists and has a jwt_secret
```

**nginx config test fails**
```bash
sudo nginx -t
sudo cat /etc/nginx/sites-available/offdock-self.conf
```

**Can't reach OffDock UI**
```bash
# Check service is running:
sudo systemctl is-active offdock

# Check nginx is running:
sudo systemctl is-active nginx

# Check firewall:
sudo ufw status
# Allow HTTP/HTTPS if needed:
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

**Docker images not loading**
```bash
docker load -i /path/to/image.tar
docker images | grep myapp
```
