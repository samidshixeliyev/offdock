#!/usr/bin/env bash
# OffDock offline installer — supports fully air-gapped Ubuntu servers.
# All dependencies can be bundled on the USB (see prepare-usb.sh).
#
# Usage:
#   sudo bash install.sh [OPTIONS]
#
# Options:
#   --port PORT          OffDock listen port (default 7070)
#   --domain DOMAIN      Domain for OffDock UI (e.g. deploy.ao.az)
#   --pem PATH           Path to combined PEM file (cert chain + private key)
#                        A wildcard cert (*.ao.az) covers OffDock + all deployed apps.
#   --data-dir DIR       Data directory (default /var/offdock/data)
#   --no-nginx           Skip nginx configuration
#   --uninstall          Remove OffDock
#
# Examples:
#   sudo bash install.sh
#   sudo bash install.sh --domain deploy.ao.az --pem /etc/ssl/ao.az/wildcard.pem

set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

BINARY_NAME="offdock"
INSTALL_BIN="/usr/local/bin/${BINARY_NAME}"
SERVICE_FILE="/etc/systemd/system/${BINARY_NAME}.service"
CONFIG_DIR="/etc/offdock"
CONFIG_FILE="${CONFIG_DIR}/config.yaml"
DATA_DIR="/var/offdock/data"
LOG_DIR="/var/offdock/logs"
CERTS_DIR="/var/offdock/certs"
PROJECTS_DIR="/var/offdock/projects"

PORT=7070
DOMAIN=""
PEM_PATH=""
SKIP_NGINX=false
UNINSTALL=false

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- argument parsing -------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case $1 in
    --port)      PORT="$2";       shift 2 ;;
    --domain)    DOMAIN="$2";     shift 2 ;;
    --pem)       PEM_PATH="$2";   shift 2 ;;
    --data-dir)  DATA_DIR="$2";   shift 2 ;;
    --no-nginx)  SKIP_NGINX=true; shift ;;
    --uninstall) UNINSTALL=true;  shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ "$EUID" -ne 0 ]]; then
  echo "ERROR: Run as root: sudo bash install.sh" >&2; exit 1
fi

# --- uninstall path ---------------------------------------------------------
if [[ "$UNINSTALL" == "true" ]]; then
  echo "Removing OffDock..."
  systemctl stop "${BINARY_NAME}" 2>/dev/null || true
  systemctl disable "${BINARY_NAME}" 2>/dev/null || true
  rm -f "${INSTALL_BIN}" "${SERVICE_FILE}"
  rm -f /etc/nginx/sites-available/offdock-self.conf
  rm -f /etc/nginx/sites-enabled/offdock-self.conf
  systemctl daemon-reload
  echo "OffDock removed. Data in /var/offdock/ preserved."
  echo "To remove data: sudo rm -rf /var/offdock"
  exit 0
fi

# --- check binary -----------------------------------------------------------
if [[ ! -f "${SCRIPT_DIR}/${BINARY_NAME}" ]]; then
  echo "ERROR: '${BINARY_NAME}' not found in ${SCRIPT_DIR}" >&2
  echo "       Build it first: make all" >&2
  exit 1
fi
if [[ ! -f "${SCRIPT_DIR}/offdock.service" ]]; then
  echo "ERROR: offdock.service not found in ${SCRIPT_DIR}" >&2; exit 1
fi

# --- install Docker (offline if debs present) -------------------------------
echo ""
echo "=== Checking Docker ==="
if command -v docker &>/dev/null; then
  echo "  Docker already installed: $(docker --version)"
elif [[ -d "${SCRIPT_DIR}/debs/docker" ]] && ls "${SCRIPT_DIR}/debs/docker"/*.deb &>/dev/null; then
  echo "  Installing Docker from bundled packages..."
  dpkg --force-confold --skip-same-version -i "${SCRIPT_DIR}/debs/docker/"*.deb 2>&1 || apt-get install -f -y
  echo "  Docker installed."
else
  echo "ERROR: Docker is not installed and no offline packages found in ./debs/docker/" >&2
  echo "       On an internet machine: bash prepare-usb.sh --only-docker" >&2
  echo "       Or install Docker manually first." >&2
  exit 1
fi

# Start and enable Docker
systemctl enable docker 2>/dev/null || true
systemctl start docker  2>/dev/null || true

# Load bundled Docker images (nginx:alpine etc.)
if [[ -d "${SCRIPT_DIR}/images" ]] && ls "${SCRIPT_DIR}/images"/*.tar &>/dev/null; then
  echo "  Loading bundled Docker images..."
  for img in "${SCRIPT_DIR}/images/"*.tar; do
    echo "    Loading ${img}..."
    docker load -i "${img}" && echo "    Loaded: ${img}" || echo "    WARNING: failed to load ${img}" >&2
  done
fi

# --- install nginx (offline if debs present) --------------------------------
if [[ "$SKIP_NGINX" == "false" ]]; then
  echo ""
  echo "=== Checking nginx ==="
  if command -v nginx &>/dev/null; then
    echo "  nginx already installed: $(nginx -v 2>&1)"
  elif [[ -d "${SCRIPT_DIR}/debs/nginx" ]] && ls "${SCRIPT_DIR}/debs/nginx"/*.deb &>/dev/null; then
    echo "  Installing nginx from bundled packages..."
    dpkg --force-confold --skip-same-version -i "${SCRIPT_DIR}/debs/nginx/"*.deb 2>&1 || apt-get install -f -y
    echo "  nginx installed."
  else
    echo "WARNING: nginx is not installed and no offline packages found in ./debs/nginx/" >&2
    echo "         Nginx config management will not work until nginx is installed." >&2
    echo "         To install offline: copy debs from an internet machine using prepare-usb.sh" >&2
    SKIP_NGINX=true
  fi

  if [[ "$SKIP_NGINX" == "false" ]]; then
    systemctl enable nginx 2>/dev/null || true
    systemctl start nginx  2>/dev/null || true
    echo "  nginx is running."
  fi
fi

# --- generate config --------------------------------------------------------
echo ""
echo "=== Configuring OffDock ==="
if [[ ! -f "${CONFIG_FILE}" ]]; then
  mkdir -p "${CONFIG_DIR}"
  JWT_SECRET=$(cat /dev/urandom | tr -dc 'A-Za-z0-9!@#$%^&*' 2>/dev/null | head -c 64 || openssl rand -base64 48)
  cat >"${CONFIG_FILE}" <<EOF
# OffDock configuration

port: ${PORT}
data_dir: ${DATA_DIR}
log_dir: ${LOG_DIR}
log_level: info

# KEEP THIS SECRET — changing it invalidates all sessions.
jwt_secret: "${JWT_SECRET}"

# Combined PEM file (cert chain + private key) for HTTPS.
# A wildcard cert (e.g. *.ao.az) covers OffDock UI + all deployed apps.
# Leave empty to use HTTP only.
default_pem_path: "${PEM_PATH}"
EOF
  chmod 600 "${CONFIG_FILE}"
  echo "  Config written to ${CONFIG_FILE}"
else
  echo "  Config already exists — not overwriting."
fi

# --- runtime directories ----------------------------------------------------
for dir in "${DATA_DIR}" "${LOG_DIR}" "${CERTS_DIR}" "${PROJECTS_DIR}"; do
  mkdir -p "${dir}"; chmod 700 "${dir}"
done

# --- install binary + service -----------------------------------------------
echo "  Installing ${INSTALL_BIN}..."
cp "${SCRIPT_DIR}/${BINARY_NAME}" "${INSTALL_BIN}"
chmod 755 "${INSTALL_BIN}"

cp "${SCRIPT_DIR}/offdock.service" "${SERVICE_FILE}"
chmod 644 "${SERVICE_FILE}"
systemctl daemon-reload 2>/dev/null || systemctl --system daemon-reload 2>/dev/null || true
systemctl enable "${BINARY_NAME}" 2>/dev/null || true

# --- configure nginx for OffDock UI -----------------------------------------
if [[ "$SKIP_NGINX" == "false" ]] && command -v nginx &>/dev/null; then
  echo ""
  echo "=== Configuring nginx for OffDock ==="

  # Disable default site if it conflicts
  if [[ -f /etc/nginx/sites-enabled/default ]]; then
    rm -f /etc/nginx/sites-enabled/default
    echo "  Disabled nginx default site."
  fi

  # Determine server name and redirect target
  if [[ -n "${DOMAIN}" ]]; then
    NGINX_DOMAIN="${DOMAIN}"
  else
    SERVER_IP=$(hostname -I | awk '{print $1}')
    NGINX_DOMAIN="${SERVER_IP}"
  fi

  # Catch-all default server: any unrecognised host redirects to OffDock.
  # With PEM: redirect to https://DOMAIN; without: redirect to http://DOMAIN.
  if [[ -n "${PEM_PATH}" ]]; then
    cat >/etc/nginx/sites-available/00-offdock-default.conf <<NGINXEOF
# Catch-all port 80 → redirect to OffDock HTTPS
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    server_tokens off;
    return 301 https://${NGINX_DOMAIN}\$request_uri;
}

# Catch-all port 443 → proxy to OffDock (handles direct IP HTTPS access)
server {
    listen 443 ssl default_server;
    http2 on;
    server_name _;
    server_tokens off;
    client_max_body_size 100m;

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
    cat >/etc/nginx/sites-available/00-offdock-default.conf <<NGINXEOF
# Catch-all port 80 → proxy to OffDock directly
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    server_tokens off;
    client_max_body_size 100m;

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

  # Named server block for the OffDock domain/IP — same as catch-all but
  # explicit server_name so deployed app configs don't conflict.
  if [[ -n "${PEM_PATH}" ]]; then
    cat >/etc/nginx/sites-available/offdock-self.conf <<NGINXEOF
# OffDock UI — HTTP → HTTPS redirect
server {
    listen 80;
    server_name ${NGINX_DOMAIN};
    server_tokens off;
    return 301 https://\$host\$request_uri;
}

# OffDock UI — HTTPS
server {
    listen 443 ssl;
    http2 on;
    server_name ${NGINX_DOMAIN};
    server_tokens off;
    client_max_body_size 100m;

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
    echo "  HTTPS enabled with PEM: ${PEM_PATH}"
  else
    cat >/etc/nginx/sites-available/offdock-self.conf <<NGINXEOF
# OffDock UI — HTTP
server {
    listen 80;
    server_name ${NGINX_DOMAIN};
    server_tokens off;
    client_max_body_size 100m;

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
    echo "  HTTP only (no --pem provided)"
  fi
  ln -sf /etc/nginx/sites-available/offdock-self.conf \
         /etc/nginx/sites-enabled/offdock-self.conf

  if nginx -t 2>/dev/null; then
    systemctl reload nginx
    echo "  nginx configured for ${NGINX_DOMAIN} -> :${PORT}"
  else
    echo "WARNING: nginx config test failed - check /etc/nginx/sites-available/offdock-self.conf" >&2
  fi
fi

# --- start OffDock ----------------------------------------------------------
echo ""
echo "=== Starting OffDock ==="
# Reload daemon again in case earlier reload failed (e.g. dbus wasn't ready yet)
systemctl daemon-reload 2>/dev/null || true
if systemctl is-active --quiet "${BINARY_NAME}" 2>/dev/null; then
  systemctl restart "${BINARY_NAME}"
  echo "  OffDock restarted."
else
  systemctl start "${BINARY_NAME}"
  echo "  OffDock started."
fi
sleep 2

SERVER_IP=$(hostname -I | awk '{print $1}')

if systemctl is-active --quiet "${BINARY_NAME}" 2>/dev/null; then
  echo ""
  echo "============================================================"
  echo "             OffDock installed successfully"
  echo "============================================================"
  if [[ -n "${DOMAIN}" ]]; then
    echo "  UI:     http://${DOMAIN}/"
  fi
  echo "  Direct: http://${SERVER_IP}:${PORT}"
  echo "  Config: ${CONFIG_FILE}"
  echo "  Data:   ${DATA_DIR}"
  echo "  Logs:   journalctl -u offdock -f"
  echo "------------------------------------------------------------"
  echo "  NEXT STEPS:"
  echo "  1. Visit the URL above and go to /setup"
  echo "  2. Create your admin account"
  if [[ -n "${DOMAIN}" ]]; then
    echo "  3. DNS A record already set? Access via domain above"
  else
    echo "  3. Set DNS A record: yourdomain.az -> ${SERVER_IP}"
    echo "     Then run: sudo bash install.sh --domain yourdomain.az"
  fi
  echo "============================================================"
else
  echo "ERROR: OffDock failed to start. Check: journalctl -u offdock -n 50" >&2
  exit 1
fi
