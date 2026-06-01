#!/usr/bin/env bash
# OffDock offline installer — supports fully air-gapped Ubuntu servers.
#
# Usage:
#   sudo bash install.sh            — interactive setup (recommended)
#   sudo bash install.sh --uninstall — remove OffDock

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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Runtime values — filled interactively or from existing config
PORT=7070
DOMAIN=""
PEM_PATH=""
SKIP_NGINX=false
UNINSTALL=false

# --- argument parsing (only --uninstall remains as a flag) ------------------
while [[ $# -gt 0 ]]; do
  case $1 in
    --uninstall) UNINSTALL=true; shift ;;
    *) echo "Unknown argument: $1  (only --uninstall is accepted)" >&2; exit 1 ;;
  esac
done

if [[ "$EUID" -ne 0 ]]; then
  echo "ERROR: Run as root: sudo bash install.sh" >&2; exit 1
fi

# --- uninstall path ---------------------------------------------------------
if [[ "$UNINSTALL" == "true" ]]; then
  echo "Removing OffDock..."
  systemctl stop  "${BINARY_NAME}" 2>/dev/null || true
  systemctl disable "${BINARY_NAME}" 2>/dev/null || true
  rm -f "${INSTALL_BIN}" "${SERVICE_FILE}"
  rm -f /etc/nginx/sites-available/offdock-self.conf \
        /etc/nginx/sites-enabled/offdock-self.conf \
        /etc/nginx/sites-available/00-offdock-default.conf \
        /etc/nginx/sites-enabled/00-offdock-default.conf
  systemctl daemon-reload 2>/dev/null || true
  echo "OffDock removed. Data in /var/offdock/ and config in /etc/offdock/ preserved."
  echo "To also remove data: sudo rm -rf /var/offdock /etc/offdock"
  exit 0
fi

# --- check required files ---------------------------------------------------
if [[ ! -f "${SCRIPT_DIR}/${BINARY_NAME}" ]]; then
  echo "ERROR: '${BINARY_NAME}' binary not found in ${SCRIPT_DIR}" >&2
  echo "       Build it first: make all" >&2; exit 1
fi
if [[ ! -f "${SCRIPT_DIR}/offdock.service" ]]; then
  echo "ERROR: offdock.service not found in ${SCRIPT_DIR}" >&2; exit 1
fi

SERVER_IP=$(hostname -I | awk '{print $1}')

# ============================================================================
# INTERACTIVE SETUP
# ============================================================================
echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║           OffDock Interactive Setup              ║"
echo "╚══════════════════════════════════════════════════╝"
echo "  Press Enter to accept the default shown in [brackets]."
echo ""

# --- Port ---
read -rp "  Listen port [7070]: " _input
PORT="${_input:-7070}"

# --- Domain ---
echo ""
echo "  Domain for OffDock UI (e.g. deploy.ao.az, offdock.dedyn.io)"
echo "  Leave blank to use server IP (${SERVER_IP}) — no DNS record needed."
read -rp "  Domain [${SERVER_IP}]: " _input
DOMAIN="${_input:-}"

# --- Data directory ---
echo ""
read -rp "  Data directory [/var/offdock/data]: " _input
DATA_DIR="${_input:-/var/offdock/data}"
LOG_DIR="$(dirname "${DATA_DIR}")/logs"
CERTS_DIR="$(dirname "${DATA_DIR}")/certs"
PROJECTS_DIR="$(dirname "${DATA_DIR}")/projects"

# --- nginx ---
echo ""
read -rp "  Configure nginx reverse proxy? [Y/n]: " _input
if [[ "${_input,,}" == "n" || "${_input,,}" == "no" ]]; then
  SKIP_NGINX=true
fi

# --- SSL certificate --------------------------------------------------------
echo ""
echo "──────────────────────────────────────────────────"
echo "  SSL / HTTPS Setup"
echo "──────────────────────────────────────────────────"

GEN_CERT=false
HAVE_OPENSSL=false
command -v openssl &>/dev/null && HAVE_OPENSSL=true

if [[ "$HAVE_OPENSSL" == "false" ]]; then
  echo "  openssl not found — skipping SSL certificate generation."
  echo "  Install openssl and re-run to enable HTTPS."
else
  echo "  Options:"
  echo "    1) Generate a new self-signed certificate (recommended for testing)"
  echo "    2) Provide path to an existing PEM file"
  echo "    3) Skip — HTTP only"
  echo ""
  read -rp "  Choice [1]: " _input
  _ssl_choice="${_input:-1}"

  case "$_ssl_choice" in
    1)
      GEN_CERT=true
      ;;
    2)
      read -rp "  PEM file path (cert chain + private key combined): " _input
      PEM_PATH="${_input:-}"
      if [[ -n "$PEM_PATH" && ! -f "$PEM_PATH" ]]; then
        echo "  WARNING: file not found at ${PEM_PATH} — continuing without SSL" >&2
        PEM_PATH=""
      fi
      ;;
    3)
      echo "  Skipping SSL — OffDock will run over HTTP only."
      ;;
    *)
      echo "  Invalid choice — skipping SSL."
      ;;
  esac
fi

# --- SSL cert generation wizard ---------------------------------------------
if [[ "$GEN_CERT" == "true" ]]; then
  echo ""
  echo "  Self-signed certificate details"
  echo "  ─────────────────────────────────────────────"

  # CN
  _cn_default="${DOMAIN:-${SERVER_IP}}"
  read -rp "  Common Name (CN) [${_cn_default}]: " _input
  CERT_CN="${_input:-${_cn_default}}"

  # Organization
  read -rp "  Organization (optional): " _input
  CERT_ORG="${_input:-}"

  # Country
  read -rp "  Country code, 2 letters (optional, e.g. AZ): " _input
  CERT_COUNTRY="${_input:-}"
  CERT_COUNTRY="${CERT_COUNTRY^^}"  # uppercase

  # DNS SANs — suggest wildcard of the domain
  _dns_default=""
  if [[ -n "$CERT_CN" && "$CERT_CN" != "$SERVER_IP" ]]; then
    # Suggest wildcard of the primary domain
    _dns_default="*.${CERT_CN}"
  fi
  echo "  Additional DNS names, comma-separated (wildcards OK)"
  read -rp "  DNS names [${_dns_default}]: " _input
  CERT_DNS_EXTRA="${_input:-${_dns_default}}"

  # IP SANs — suggest server IP
  read -rp "  IP addresses for HTTPS by IP, comma-separated [${SERVER_IP}]: " _input
  CERT_IPS="${_input:-${SERVER_IP}}"

  # Validity
  echo ""
  echo "  Validity period:"
  echo "    1) 90 days      3) 2 years"
  echo "    2) 1 year       4) 10 years"
  read -rp "  Choice [2]: " _input
  case "${_input:-2}" in
    1) CERT_DAYS=90   ;;
    3) CERT_DAYS=730  ;;
    4) CERT_DAYS=3650 ;;
    *) CERT_DAYS=365  ;;
  esac

  # ── Generate the certificate ──────────────────────────────────────────────
  echo ""
  echo "  Generating certificate..."

  mkdir -p "${CERTS_DIR}"
  chmod 700 "${CERTS_DIR}"

  # Build alt_names block
  _san_block="DNS.1 = ${CERT_CN}"
  _san_idx=2

  IFS=',' read -ra _extra_dns <<< "$CERT_DNS_EXTRA"
  for _d in "${_extra_dns[@]}"; do
    _d="${_d// /}"
    [[ -z "$_d" || "$_d" == "$CERT_CN" ]] && continue
    _san_block="${_san_block}
DNS.${_san_idx} = ${_d}"
    ((_san_idx++))
  done

  _ip_idx=1
  IFS=',' read -ra _ips <<< "$CERT_IPS"
  for _ip in "${_ips[@]}"; do
    _ip="${_ip// /}"
    [[ -z "$_ip" ]] && continue
    _san_block="${_san_block}
IP.${_ip_idx} = ${_ip}"
    ((_ip_idx++))
  done

  # Build DN section
  _dn_section="CN = ${CERT_CN}"
  [[ -n "$CERT_ORG" ]]     && _dn_section="${_dn_section}
O  = ${CERT_ORG}"
  [[ -n "$CERT_COUNTRY" ]] && _dn_section="${_dn_section}
C  = ${CERT_COUNTRY}"

  # Write openssl config
  _cnf=$(mktemp /tmp/offdock-cert.XXXXXX.cnf)
  cat > "$_cnf" <<CNFEOF
[req]
prompt             = no
default_bits       = 2048
default_md         = sha256
distinguished_name = dn
x509_extensions    = v3_req

[dn]
${_dn_section}

[v3_req]
subjectAltName      = @alt_names
keyUsage            = critical, digitalSignature, keyEncipherment
extendedKeyUsage    = serverAuth
basicConstraints    = CA:FALSE

[alt_names]
${_san_block}
CNFEOF

  _tmpkey=$(mktemp /tmp/offdock-key.XXXXXX.pem)
  _tmpcrt=$(mktemp /tmp/offdock-crt.XXXXXX.pem)

  openssl req -x509 -nodes \
    -newkey rsa:2048 \
    -days   "${CERT_DAYS}" \
    -keyout "${_tmpkey}" \
    -out    "${_tmpcrt}" \
    -config "${_cnf}" 2>/dev/null

  PEM_PATH="${CERTS_DIR}/offdock.pem"
  cat "${_tmpkey}" "${_tmpcrt}" > "${PEM_PATH}"
  chmod 600 "${PEM_PATH}"
  rm -f "${_cnf}" "${_tmpkey}" "${_tmpcrt}"

  echo "  Certificate written to: ${PEM_PATH}"
  echo "  CN:         ${CERT_CN}"
  [[ -n "$CERT_ORG" ]]     && echo "  Org:        ${CERT_ORG}"
  [[ -n "$CERT_COUNTRY" ]] && echo "  Country:    ${CERT_COUNTRY}"
  echo "  DNS SANs:   ${CERT_CN}$([ -n "$CERT_DNS_EXTRA" ] && echo ", ${CERT_DNS_EXTRA}")"
  [[ -n "$CERT_IPS" ]]     && echo "  IP SANs:    ${CERT_IPS}"
  echo "  Valid for:  ${CERT_DAYS} days"
fi

# ============================================================================
# INSTALL DOCKER
# ============================================================================
echo ""
echo "=== Checking Docker ==="
if command -v docker &>/dev/null; then
  echo "  Docker already installed: $(docker --version)"
elif [[ -d "${SCRIPT_DIR}/debs/docker" ]] && ls "${SCRIPT_DIR}/debs/docker"/*.deb &>/dev/null; then
  echo "  Installing Docker from bundled packages..."
  dpkg --force-confold --skip-same-version -i "${SCRIPT_DIR}/debs/docker/"*.deb 2>&1 || apt-get install -f -y
  echo "  Docker installed."
else
  echo "ERROR: Docker not installed and no offline packages found in ./debs/docker/" >&2
  echo "       Run: bash prepare-usb.sh --only-docker  (on an internet machine)" >&2
  exit 1
fi
systemctl enable docker 2>/dev/null || true
systemctl start  docker 2>/dev/null || true

# Load any bundled Docker images
if [[ -d "${SCRIPT_DIR}/images" ]] && ls "${SCRIPT_DIR}/images"/*.tar &>/dev/null 2>&1; then
  echo "  Loading bundled Docker images..."
  for _img in "${SCRIPT_DIR}/images/"*.tar; do
    docker load -i "${_img}" && echo "    Loaded: ${_img}" || echo "    WARNING: failed to load ${_img}" >&2
  done
fi

# ============================================================================
# INSTALL NGINX
# ============================================================================
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
    echo "  WARNING: nginx not installed and no offline packages found — skipping nginx setup." >&2
    SKIP_NGINX=true
  fi
  if [[ "$SKIP_NGINX" == "false" ]]; then
    systemctl enable nginx 2>/dev/null || true
    systemctl start  nginx 2>/dev/null || true
    echo "  nginx running."
  fi
fi

# ============================================================================
# WRITE CONFIG
# ============================================================================
echo ""
echo "=== Configuring OffDock ==="
if [[ ! -f "${CONFIG_FILE}" ]]; then
  mkdir -p "${CONFIG_DIR}"
  JWT_SECRET=$(tr -dc 'A-Za-z0-9!@#$%^&*' </dev/urandom 2>/dev/null | head -c 64 || openssl rand -base64 48)
  cat > "${CONFIG_FILE}" <<EOF
# OffDock configuration

port: ${PORT}
data_dir: ${DATA_DIR}
log_dir: ${LOG_DIR}
log_level: info

# KEEP THIS SECRET — changing it invalidates all existing sessions.
jwt_secret: "${JWT_SECRET}"

# Combined PEM file (private key + cert chain) used for HTTPS on deployed apps.
# A wildcard cert (e.g. *.ao.az) covers all subdomains managed by OffDock.
# Leave empty to use HTTP only.
default_pem_path: "${PEM_PATH}"
EOF
  chmod 600 "${CONFIG_FILE}"
  echo "  Config written to ${CONFIG_FILE}"
else
  echo "  Config already exists — not overwriting."
fi

# ============================================================================
# RUNTIME DIRECTORIES
# ============================================================================
for _dir in "${DATA_DIR}" "${LOG_DIR}" "${CERTS_DIR}" "${PROJECTS_DIR}"; do
  mkdir -p "${_dir}"; chmod 700 "${_dir}"
done

# ============================================================================
# INSTALL BINARY + SERVICE
# ============================================================================
echo "  Installing ${INSTALL_BIN}..."
cp  "${SCRIPT_DIR}/${BINARY_NAME}" "${INSTALL_BIN}"
chmod 755 "${INSTALL_BIN}"
cp  "${SCRIPT_DIR}/offdock.service" "${SERVICE_FILE}"
chmod 644 "${SERVICE_FILE}"
systemctl daemon-reload 2>/dev/null || true
systemctl enable "${BINARY_NAME}" 2>/dev/null || true

# ============================================================================
# CONFIGURE NGINX
# ============================================================================
if [[ "$SKIP_NGINX" == "false" ]] && command -v nginx &>/dev/null; then
  echo ""
  echo "=== Configuring nginx for OffDock ==="

  [[ -f /etc/nginx/sites-enabled/default ]] && rm -f /etc/nginx/sites-enabled/default && echo "  Disabled nginx default site."

  NGINX_DOMAIN="${DOMAIN:-${SERVER_IP}}"

  # ── Catch-all default server ─────────────────────────────────────────────
  if [[ -n "${PEM_PATH}" ]]; then
    cat > /etc/nginx/sites-available/00-offdock-default.conf <<NGINXEOF
# Catch-all: HTTP → redirect to OffDock HTTPS
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    server_tokens off;
    return 301 https://${NGINX_DOMAIN}\$request_uri;
}

# Catch-all: HTTPS → proxy to OffDock (covers direct IP access)
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
    cat > /etc/nginx/sites-available/00-offdock-default.conf <<NGINXEOF
# Catch-all: any unrecognised host → proxy to OffDock
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

  # ── Named vhost for OffDock domain ───────────────────────────────────────
  if [[ -n "${PEM_PATH}" ]]; then
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
    echo "  HTTPS enabled — PEM: ${PEM_PATH}"
  else
    cat > /etc/nginx/sites-available/offdock-self.conf <<NGINXEOF
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
    echo "  HTTP only — no certificate configured."
  fi
  ln -sf /etc/nginx/sites-available/offdock-self.conf \
         /etc/nginx/sites-enabled/offdock-self.conf

  if nginx -t 2>/dev/null; then
    systemctl reload nginx
    echo "  nginx configured: ${NGINX_DOMAIN} → :${PORT}"
  else
    echo "WARNING: nginx config test failed — check /etc/nginx/sites-available/offdock-self.conf" >&2
  fi
fi

# ============================================================================
# START OFFDOCK
# ============================================================================
echo ""
echo "=== Starting OffDock ==="
systemctl daemon-reload 2>/dev/null || true
if systemctl is-active --quiet "${BINARY_NAME}" 2>/dev/null; then
  systemctl restart "${BINARY_NAME}"
  echo "  OffDock restarted."
else
  systemctl start "${BINARY_NAME}"
  echo "  OffDock started."
fi
sleep 2

if systemctl is-active --quiet "${BINARY_NAME}" 2>/dev/null; then
  _proto="http"
  [[ -n "$PEM_PATH" ]] && _proto="https"
  _display_domain="${DOMAIN:-${SERVER_IP}}"

  echo ""
  echo "╔══════════════════════════════════════════════════╗"
  echo "║         OffDock installed successfully           ║"
  echo "╠══════════════════════════════════════════════════╣"
  printf  "║  UI:     %-39s ║\n" "${_proto}://${_display_domain}/"
  printf  "║  Direct: %-39s ║\n" "http://${SERVER_IP}:${PORT}"
  printf  "║  Config: %-39s ║\n" "${CONFIG_FILE}"
  printf  "║  Logs:   %-39s ║\n" "journalctl -u offdock -f"
  echo "╠══════════════════════════════════════════════════╣"
  echo "║  NEXT STEPS:                                     ║"
  echo "║  1. Open the UI URL above                        ║"
  echo "║  2. Go to /setup and create your admin account   ║"
  if [[ -z "$DOMAIN" ]]; then
    echo "║  3. Point a DNS A record to ${SERVER_IP}        ║"
    echo "║     then re-run install.sh to set the domain    ║"
  fi
  echo "╚══════════════════════════════════════════════════╝"
else
  echo "ERROR: OffDock failed to start." >&2
  echo "       Check logs: journalctl -u offdock -n 50" >&2
  exit 1
fi
