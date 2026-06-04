#!/usr/bin/env bash
# OffDock nginx manual setup — run this if nginx wasn't configured during install,
# or to reconfigure it after changing domain / port / SSL certificate.
#
# Usage:
#   sudo bash nginx-setup.sh                   — reads settings from /etc/offdock/config.yaml
#   sudo bash nginx-setup.sh --domain example.com
#   sudo bash nginx-setup.sh --domain example.com --port 7070 --pem /path/to/cert.pem
#   sudo bash nginx-setup.sh --status          — show current nginx / OffDock status
#   sudo bash nginx-setup.sh --remove          — remove OffDock nginx configs and reload

set -euo pipefail

CONFIG_FILE="/etc/offdock/config.yaml"

# ── defaults (overridden by config.yaml then CLI flags) ─────────────────────
PORT=7070
DOMAIN=""
PEM_PATH=""
MODE="setup"   # setup | status | remove

if [[ "$EUID" -ne 0 ]]; then
  echo "ERROR: Run as root: sudo bash nginx-setup.sh" >&2; exit 1
fi

# ── parse CLI flags ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --domain) DOMAIN="$2";   shift 2 ;;
    --port)   PORT="$2";     shift 2 ;;
    --pem)    PEM_PATH="$2"; shift 2 ;;
    --status) MODE="status"; shift ;;
    --remove) MODE="remove"; shift ;;
    *) echo "Unknown argument: $1" >&2
       echo "Usage: sudo bash nginx-setup.sh [--domain D] [--port P] [--pem /path] [--status] [--remove]" >&2
       exit 1 ;;
  esac
done

# ── read existing OffDock config.yaml (non-fatal if absent) ─────────────────
if [[ -f "$CONFIG_FILE" ]]; then
  _cfg_port=$(grep    '^port:'             "$CONFIG_FILE" | awk '{print $2}' | tr -d '"' || true)
  _cfg_pem=$(grep     '^default_pem_path:' "$CONFIG_FILE" | awk '{print $2}' | tr -d '"' || true)
  [[ -n "$_cfg_port" ]] && PORT="$_cfg_port"
  [[ -n "$_cfg_pem"  ]] && PEM_PATH="$_cfg_pem"
fi

SERVER_IP=$(hostname -I | awk '{print $1}')

# ── STATUS mode ──────────────────────────────────────────────────────────────
if [[ "$MODE" == "status" ]]; then
  echo "=== OffDock nginx status ==="
  echo ""
  echo "  nginx binary:  $(command -v nginx &>/dev/null && nginx -v 2>&1 || echo 'NOT INSTALLED')"
  echo "  nginx running: $(systemctl is-active nginx 2>/dev/null || echo 'unknown')"
  echo "  nginx config:  $(nginx -t 2>&1 | tr '\n' ' ')"
  echo ""
  echo "  OffDock service: $(systemctl is-active offdock 2>/dev/null || echo 'unknown')"
  echo "  OffDock port:    ${PORT}"
  echo "  Config file:     ${CONFIG_FILE}"
  echo ""
  echo "  Active nginx sites:"
  ls /etc/nginx/sites-enabled/ 2>/dev/null | sed 's/^/    /' || echo "    (none)"
  echo ""
  echo "  OffDock nginx files:"
  for _f in \
      /etc/nginx/sites-available/offdock-self.conf \
      /etc/nginx/sites-available/00-offdock-default.conf; do
    if [[ -f "$_f" ]]; then
      echo "    $_f  ✓"
    else
      echo "    $_f  (missing)"
    fi
  done
  exit 0
fi

# ── REMOVE mode ──────────────────────────────────────────────────────────────
if [[ "$MODE" == "remove" ]]; then
  echo "=== Removing OffDock nginx configs ==="
  _removed=0
  for _f in \
      /etc/nginx/sites-enabled/offdock-self.conf \
      /etc/nginx/sites-available/offdock-self.conf \
      /etc/nginx/sites-enabled/00-offdock-default.conf \
      /etc/nginx/sites-available/00-offdock-default.conf; do
    if [[ -f "$_f" || -L "$_f" ]]; then
      rm -f "$_f" && echo "  Removed: $_f"
      ((_removed++)) || true
    fi
  done
  # Restore stock default site if it was removed
  if [[ ! -e /etc/nginx/sites-enabled/default && \
        -f /etc/nginx/sites-available/default ]]; then
    ln -sf /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default
    echo "  Restored nginx default site."
  fi
  if [[ $_removed -gt 0 ]] && command -v nginx &>/dev/null; then
    if nginx -t 2>/dev/null; then
      systemctl reload nginx 2>/dev/null || nginx -s reload 2>/dev/null || true
      echo "  nginx reloaded."
    fi
  fi
  echo "Done."
  exit 0
fi

# ── SETUP mode ───────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║         OffDock nginx Manual Setup               ║"
echo "╚══════════════════════════════════════════════════╝"

# Check nginx is installed
if ! command -v nginx &>/dev/null; then
  echo "ERROR: nginx is not installed." >&2
  echo "       Install it first, or re-run install.sh which bundles nginx .debs." >&2
  exit 1
fi

# Prompt for any values not already set via flags or config
if [[ -z "$DOMAIN" ]]; then
  echo ""
  echo "  Domain for OffDock UI (e.g. deploy.example.com)"
  echo "  Leave blank to use server IP (${SERVER_IP})."
  read -rp "  Domain [${SERVER_IP}]: " _input
  DOMAIN="${_input:-}"
fi

NGINX_DOMAIN="${DOMAIN:-${SERVER_IP}}"

if [[ -z "$PEM_PATH" ]]; then
  echo ""
  echo "  Path to combined PEM file (cert + key) for HTTPS."
  echo "  Leave blank for HTTP only."
  read -rp "  PEM path [none]: " _input
  PEM_PATH="${_input:-}"
fi

if [[ -n "$PEM_PATH" && ! -f "$PEM_PATH" ]]; then
  echo "  WARNING: PEM file not found at '${PEM_PATH}' — falling back to HTTP only." >&2
  PEM_PATH=""
fi

echo ""
echo "  Settings:"
echo "    Domain : ${NGINX_DOMAIN}"
echo "    Port   : ${PORT}"
echo "    SSL    : ${PEM_PATH:-none (HTTP only)}"
echo ""

# ── Detect existing default_server ──────────────────────────────────────────
EXISTING_DEFAULT=$(grep -RlE 'listen[^;]*default_server' \
    /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ /etc/nginx/nginx.conf 2>/dev/null \
    | grep -vE 'offdock' || true)
MANAGE_DEFAULT=true
if [[ -n "$EXISTING_DEFAULT" ]]; then
  MANAGE_DEFAULT=false
  echo "  Existing default_server found — only adding named vhost for ${NGINX_DOMAIN}:"
  echo "$EXISTING_DEFAULT" | sed 's/^/    /'
fi

# ── Remove stock default site if we're taking over ──────────────────────────
_removed_default_symlink=false
if [[ "$MANAGE_DEFAULT" == "true" && -f /etc/nginx/sites-enabled/default ]]; then
  rm -f /etc/nginx/sites-enabled/default
  echo "  Disabled nginx stock default site."
  _removed_default_symlink=true
fi

# ── Write catch-all default server ──────────────────────────────────────────
if [[ "$MANAGE_DEFAULT" == "true" ]]; then
  if [[ -n "$PEM_PATH" ]]; then
    cat > /etc/nginx/sites-available/00-offdock-default.conf <<NGINXEOF
# Catch-all: HTTP → redirect to OffDock HTTPS
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    server_tokens off;
    return 301 https://${NGINX_DOMAIN}\$request_uri;
}

# Catch-all: HTTPS → proxy to OffDock (covers direct-IP access)
server {
    listen 443 ssl http2 default_server;
    server_name _;
    server_tokens off;
    client_max_body_size 6g;

    ssl_certificate     ${PEM_PATH};
    ssl_certificate_key ${PEM_PATH};
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_connect_timeout 10s;

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
    }
}
NGINXEOF
  else
    cat > /etc/nginx/sites-available/00-offdock-default.conf <<NGINXEOF
# Catch-all: any unrecognised host → proxy to OffDock
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    server_tokens off;
    client_max_body_size 6g;

    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_connect_timeout 10s;

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
    }
}
NGINXEOF
  fi
  ln -sf /etc/nginx/sites-available/00-offdock-default.conf \
         /etc/nginx/sites-enabled/00-offdock-default.conf
fi

# ── Write named vhost ────────────────────────────────────────────────────────
if [[ -n "$PEM_PATH" ]]; then
  cat > /etc/nginx/sites-available/offdock-self.conf <<NGINXEOF
# OffDock UI — HTTP → HTTPS redirect
server {
    listen 80;
    server_name ${NGINX_DOMAIN};
    server_tokens off;
    return 301 https://\$host\$request_uri;
}

# OffDock UI — HTTPS
server {
    listen 443 ssl http2;
    server_name ${NGINX_DOMAIN};
    server_tokens off;
    client_max_body_size 6g;

    ssl_certificate     ${PEM_PATH};
    ssl_certificate_key ${PEM_PATH};
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_connect_timeout 10s;

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
    }
}
NGINXEOF
  echo "  HTTPS enabled — PEM: ${PEM_PATH}"
else
  cat > /etc/nginx/sites-available/offdock-self.conf <<NGINXEOF
# OffDock UI — HTTP
server {
    listen 80;
    server_name ${NGINX_DOMAIN};
    server_tokens off;
    client_max_body_size 6g;

    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_connect_timeout 10s;

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
    }
}
NGINXEOF
  echo "  HTTP only — no certificate configured."
fi
ln -sf /etc/nginx/sites-available/offdock-self.conf \
       /etc/nginx/sites-enabled/offdock-self.conf

# ── Test and reload ──────────────────────────────────────────────────────────
echo ""
echo "  Testing nginx configuration..."
if _test_out=$(nginx -t 2>&1); then
  echo "  Config valid ✓"
  systemctl reload nginx 2>/dev/null || nginx -s reload 2>/dev/null || true
  echo "  nginx reloaded ✓"
  echo ""
  _proto="http"; [[ -n "$PEM_PATH" ]] && _proto="https"
  echo "╔══════════════════════════════════════════════════╗"
  echo "║        nginx configured successfully             ║"
  echo "╠══════════════════════════════════════════════════╣"
  printf "║  UI:     %-39s ║\n" "${_proto}://${NGINX_DOMAIN}/"
  printf "║  Direct: %-39s ║\n" "http://${SERVER_IP}:${PORT}"
  echo "╚══════════════════════════════════════════════════╝"
else
  echo "ERROR: nginx config test failed — rolling back." >&2
  echo "$_test_out" | sed 's/^/  /' >&2
  rm -f /etc/nginx/sites-enabled/offdock-self.conf \
        /etc/nginx/sites-available/offdock-self.conf \
        /etc/nginx/sites-enabled/00-offdock-default.conf \
        /etc/nginx/sites-available/00-offdock-default.conf
  if [[ "$_removed_default_symlink" == "true" ]]; then
    ln -sf /etc/nginx/sites-available/default \
           /etc/nginx/sites-enabled/default 2>/dev/null || true
    echo "  Restored nginx default site." >&2
  fi
  echo "" >&2
  echo "  OffDock is still reachable directly at http://${SERVER_IP}:${PORT}" >&2
  echo "  Check the error above, fix it, then re-run this script." >&2
  exit 1
fi
