#!/usr/bin/env bash
# OffDock offline installer
# Run this script on the target air-gapped Ubuntu machine.
# Assumes the offdock binary and offdock.service are in the same directory.
#
# Usage:
#   sudo bash install.sh
#
# Flags:
#   --port PORT       Override listen port (default 7070)
#   --data-dir DIR    Override data directory (default /var/offdock/data)
#   --uninstall       Remove OffDock from the system

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

# --- argument parsing -------------------------------------------------------
UNINSTALL=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --port) PORT="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --uninstall) UNINSTALL=true; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# --- must be root -----------------------------------------------------------
if [[ "$EUID" -ne 0 ]]; then
  echo "ERROR: This script must be run as root (sudo bash install.sh)" >&2
  exit 1
fi

# --- uninstall path ---------------------------------------------------------
if [[ "$UNINSTALL" == "true" ]]; then
  echo "Removing OffDock…"
  systemctl stop "${BINARY_NAME}" 2>/dev/null || true
  systemctl disable "${BINARY_NAME}" 2>/dev/null || true
  rm -f "${INSTALL_BIN}" "${SERVICE_FILE}"
  systemctl daemon-reload
  echo "OffDock removed. Data in /var/offdock/ was NOT deleted."
  echo "To remove data: sudo rm -rf /var/offdock"
  exit 0
fi

# --- pre-flight checks ------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -f "${SCRIPT_DIR}/${BINARY_NAME}" ]]; then
  echo "ERROR: Binary '${BINARY_NAME}' not found in ${SCRIPT_DIR}." >&2
  echo "       Run 'make all' on a machine with Go and Node.js, then copy the binary here." >&2
  exit 1
fi

if [[ ! -f "${SCRIPT_DIR}/offdock.service" ]]; then
  echo "ERROR: offdock.service not found in ${SCRIPT_DIR}." >&2
  exit 1
fi

# Check docker is available
if ! command -v docker &>/dev/null; then
  echo "ERROR: docker is not installed. Install Docker CE first:" >&2
  echo "       https://docs.docker.com/engine/install/ubuntu/" >&2
  exit 1
fi

# Check nginx is available (optional — warn only)
if ! command -v nginx &>/dev/null; then
  echo "WARNING: nginx is not installed. Nginx config management will not work." >&2
  echo "         Install with: apt-get install nginx" >&2
fi

# --- generate jwt secret if needed ------------------------------------------
if [[ ! -f "${CONFIG_FILE}" ]]; then
  echo "Generating configuration…"
  mkdir -p "${CONFIG_DIR}"
  JWT_SECRET=$(tr -dc 'A-Za-z0-9!@#$%^&*' </dev/urandom 2>/dev/null | head -c 64 || openssl rand -base64 48)
  cat >"${CONFIG_FILE}" <<EOF
# OffDock configuration
# See /usr/local/bin/offdock --help for all options.

port: ${PORT}
data_dir: ${DATA_DIR}
log_dir: ${LOG_DIR}
log_level: info

# KEEP THIS SECRET — changing it invalidates all existing sessions.
jwt_secret: "${JWT_SECRET}"
EOF
  chmod 600 "${CONFIG_FILE}"
  echo "  Config written to ${CONFIG_FILE}"
else
  echo "  Config already exists at ${CONFIG_FILE} — not overwriting."
fi

# --- create runtime directories ---------------------------------------------
echo "Creating runtime directories…"
for dir in "${DATA_DIR}" "${LOG_DIR}" "${CERTS_DIR}" "${PROJECTS_DIR}"; do
  mkdir -p "${dir}"
  chmod 700 "${dir}"
done

# --- install binary ---------------------------------------------------------
echo "Installing binary to ${INSTALL_BIN}…"
cp "${SCRIPT_DIR}/${BINARY_NAME}" "${INSTALL_BIN}"
chmod 755 "${INSTALL_BIN}"

# --- install systemd service -------------------------------------------------
echo "Installing systemd service…"
cp "${SCRIPT_DIR}/offdock.service" "${SERVICE_FILE}"
chmod 644 "${SERVICE_FILE}"
systemctl daemon-reload
systemctl enable "${BINARY_NAME}"

# --- start (or restart) ------------------------------------------------------
if systemctl is-active --quiet "${BINARY_NAME}"; then
  echo "Restarting OffDock…"
  systemctl restart "${BINARY_NAME}"
else
  echo "Starting OffDock…"
  systemctl start "${BINARY_NAME}"
fi

sleep 1

if systemctl is-active --quiet "${BINARY_NAME}"; then
  echo ""
  echo "╔══════════════════════════════════════════════════════╗"
  echo "║  OffDock installed and running                       ║"
  echo "║                                                      ║"
  printf "║  URL:    http://$(hostname -I | awk '{print $1}'):%-5s             ║\n" "${PORT}"
  echo "║  Config: ${CONFIG_FILE}                    ║"
  echo "║  Data:   ${DATA_DIR}                       ║"
  echo "║  Logs:   journalctl -u offdock -f                    ║"
  echo "╚══════════════════════════════════════════════════════╝"
  echo ""
  echo "First time? Visit http://$(hostname -I | awk '{print $1}'):${PORT}/setup to create your admin account."
else
  echo "ERROR: OffDock failed to start. Check logs:" >&2
  journalctl -u "${BINARY_NAME}" -n 30 --no-pager >&2
  exit 1
fi
