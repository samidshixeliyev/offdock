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
#   --data-dir DIR       Data directory (default /var/offdock/data)
#   --no-nginx           Skip nginx configuration
#   --uninstall          Remove OffDock

set -euo pipefail

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
SKIP_NGINX=false
UNINSTALL=false

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- argument parsing -------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case $1 in
    --port)      PORT="$2";    shift 2 ;;
    --domain)    DOMAIN="$2";  shift 2 ;;
    --data-dir)  DATA_DIR="$2"; shift 2 ;;
    --no-nginx)  SKIP_NGINX=true; shift ;;
    --uninstall) UNINSTALL=true; shift ;;
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
  dpkg -i "${SCRIPT_DIR}/debs/docker/"*.deb || apt-get install -f -y
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

# --- install nginx (offline if debs present) --------------------------------
if [[ "$SKIP_NGINX" == "false" ]]; then
  echo ""
  echo "=== Checking nginx ==="
  if command -v nginx &>/dev/null; then
    echo "  nginx already installed: $(nginx -v 2>&1)"
  elif [[ -d "${SCRIPT_DIR}/debs/nginx" ]] && ls "${SCRIPT_DIR}/debs/nginx"/*.deb &>/dev/null; then
    echo "  Installing nginx from bundled packages..."
    dpkg -i "${SCRIPT_DIR}/debs/nginx/"*.deb || apt-get install -f -y
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
systemctl daemon-reload
systemctl enable "${BINARY_NAME}"

# --- configure nginx for OffDock UI -----------------------------------------
if [[ "$SKIP_NGINX" == "false" ]] && command -v nginx &>/dev/null; then
  echo ""
  echo "=== Configuring nginx for OffDock ==="

  # Disable default site if it conflicts
  if [[ -f /etc/nginx/sites-enabled/default ]]; then
    rm -f /etc/nginx/sites-enabled/default
    echo "  Disabled nginx default site."
  fi

  # Write catch-all default server (returns 444 for unknown hosts)
  cat >/etc/nginx/sites-available/00-offdock-default.conf <<'NGINXEOF'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    server_tokens off;
    return 444;
}
NGINXEOF
  ln -sf /etc/nginx/sites-available/00-offdock-default.conf \
         /etc/nginx/sites-enabled/00-offdock-default.conf

  # Write OffDock UI server block
  if [[ -n "${DOMAIN}" ]]; then
    NGINX_DOMAIN="${DOMAIN}"
  else
    SERVER_IP=$(hostname -I | awk '{print $1}')
    NGINX_DOMAIN="${SERVER_IP}"
  fi

  cat >/etc/nginx/sites-available/offdock-self.conf <<NGINXEOF
server {
    listen 80;
    server_name ${NGINX_DOMAIN};
    server_tokens off;
    client_max_body_size 100m;

    # WebSocket, SSE, and terminal support
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
if systemctl is-active --quiet "${BINARY_NAME}"; then
  systemctl restart "${BINARY_NAME}"
  echo "  OffDock restarted."
else
  systemctl start "${BINARY_NAME}"
  echo "  OffDock started."
fi
sleep 1

SERVER_IP=$(hostname -I | awk '{print $1}')

if systemctl is-active --quiet "${BINARY_NAME}"; then
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
