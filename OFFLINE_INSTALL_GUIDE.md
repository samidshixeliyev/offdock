# OffDock — Offline Installation Guide

This guide explains how to install OffDock on an **air-gapped Ubuntu machine**
(no internet access). Everything you need is downloaded once on an internet-connected
machine and then transferred via USB.

---

## What you need

| Item | Where it comes from |
|------|---------------------|
| `offdock` binary | Built on an internet machine (this guide) |
| `offdock.service` | From the GitHub repo |
| `install.sh` | From the GitHub repo |

The binary already contains the entire React web UI — no separate frontend files needed.

---

## Part 1 — Prepare on an internet-connected machine

### 1.1 Install build tools (one time)

```bash
# Ubuntu / Debian
sudo apt-get install -y golang-go nodejs npm git

# Or install Go manually (required: Go 1.22+)
wget https://go.dev/dl/go1.22.5.linux-amd64.tar.gz
sudo tar -C /usr/local -xzf go1.22.5.linux-amd64.tar.gz
export PATH=$PATH:/usr/local/go/bin
```

### 1.2 Clone the repository

```bash
git clone https://github.com/samidshixeliyev/ao-deploy.git offdock
cd offdock
```

### 1.3 Build the binary

```bash
# Install Node deps and build React frontend
cd web && npm install && npm run build && cd ..

# Download Go dependencies
go mod download

# Compile — single static binary with embedded frontend
go build -ldflags "-X main.Version=1.0.0 -s -w" -o offdock ./cmd/offdock

# Verify
file offdock
# → ELF 64-bit LSB executable ...
ls -lh offdock
# → ~8 MB
```

### 1.4 Copy files to USB

Copy these **three files** to a USB drive:

```
offdock          ← the compiled binary (~8 MB)
offdock.service  ← systemd unit file
install.sh       ← installer script
```

```bash
# Example: USB mounted at /media/$USER/USB
cp offdock offdock.service install.sh /media/$USER/USB/
```

---

## Part 2 — Install on the air-gapped Ubuntu machine

### 2.1 Prerequisites on target machine

The target machine needs:
- **Docker CE** — install from a Docker offline bundle or Docker's apt mirror
- **Nginx** — `sudo apt-get install -y nginx` (or from an offline apt mirror)
- **Ubuntu 20.04 / 22.04 / 24.04 / 26.04** (amd64)

> **Docker offline install:** Download `docker-ce_*.deb`, `docker-ce-cli_*.deb`,
> `containerd.io_*.deb`, and `docker-compose-plugin_*.deb` from
> `https://download.docker.com/linux/ubuntu/dists/` while online,
> copy to USB, install with `sudo dpkg -i *.deb`.

### 2.2 Mount the USB and run the installer

```bash
# Mount USB (if not auto-mounted)
sudo mount /dev/sdb1 /mnt/usb

# Copy files from USB
cp /mnt/usb/offdock /mnt/usb/offdock.service /mnt/usb/install.sh ~/

# Run installer (must be root)
cd ~/
sudo bash install.sh
```

The installer will:
1. Generate a random JWT secret in `/etc/offdock/config.yaml`
2. Create runtime directories under `/var/offdock/`
3. Install the binary to `/usr/local/bin/offdock`
4. Install and start the systemd service

### 2.3 First-time setup

Open a browser on any machine on the same network:

```
http://<target-machine-ip>:7070/setup
```

Create your **superadmin** account. You will not be able to access any other
page until this is done.

---

## Part 3 — Loading Docker images from USB

OffDock manages images loaded as `.tar` archives. To export an image on an
internet-connected machine and load it on the air-gapped target:

### Export on internet machine

```bash
# Pull the image (while online)
docker pull nginx:1.27-alpine

# Export to tar
docker save nginx:1.27-alpine -o nginx-1.27-alpine.tar

# Copy to USB
cp nginx-1.27-alpine.tar /media/$USER/USB/
```

### Load on air-gapped machine via OffDock UI

1. Go to **USB Import** in the sidebar
2. Select your USB drive
3. Click **Load Image** next to the `.tar` file
4. The image appears in **Images** page and is ready to reference in compose configs

---

## Configuration reference

Config file: `/etc/offdock/config.yaml`

```yaml
port: 7070           # listening port (change if needed)
data_dir: /var/offdock/data
log_dir: /var/offdock/logs
log_level: info      # debug | info | warn | error
jwt_secret: "..."    # auto-generated — do NOT change after first login
```

After changing config: `sudo systemctl restart offdock`

---

## Useful commands on the target machine

```bash
# Service management
sudo systemctl status offdock
sudo systemctl restart offdock
sudo systemctl stop offdock

# Live logs
sudo journalctl -u offdock -f

# Upgrade binary (copy new offdock to USB, then)
sudo systemctl stop offdock
sudo cp /mnt/usb/offdock /usr/local/bin/offdock
sudo systemctl start offdock

# Uninstall (data is preserved)
sudo bash install.sh --uninstall
# To also remove data:
sudo rm -rf /var/offdock
```

---

## Directory layout on target machine

```
/usr/local/bin/offdock              ← binary
/etc/offdock/config.yaml            ← config (600 permissions)
/etc/systemd/system/offdock.service

/var/offdock/
  data/           ← *.db files (custom append-log store)
  projects/       ← compose + .env written at deploy time
  certs/          ← SSL certs copied from USB
  logs/offdock.log

/etc/nginx/sites-available/offdock-<name>.conf   ← managed by OffDock
/etc/nginx/sites-enabled/offdock-<name>.conf     ← symlink
```

---

## Security notes

- OffDock binds to `0.0.0.0:7070`. Restrict access with UFW:
  ```bash
  sudo ufw allow from 192.168.1.0/24 to any port 7070
  sudo ufw deny 7070
  ```
- Env var values are encrypted with AES-256-GCM using a key derived from
  `/etc/machine-id`. The `.db` files are not portable between machines.
- Nginx configs are written to `/etc/nginx/sites-available/` by the offdock
  process (runs as root via systemd). Do not expose port 7070 to the internet.
