#!/usr/bin/env bash
# prepare-usb.sh — Run this on an internet-connected Ubuntu machine to download
# all packages needed for offline OffDock deployment.
#
# Usage: bash prepare-usb.sh [--output-dir DIR]
# The output directory can then be copied to a USB drive.
#
# After copying to USB:
#   sudo bash /media/usb/offdock-usb/install.sh --domain deploy.ao.az

set -euo pipefail

OUTPUT_DIR="./offdock-usb"

while [[ $# -gt 0 ]]; do
  case $1 in
    --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

echo "Preparing OffDock USB deployment package in: ${OUTPUT_DIR}"
mkdir -p "${OUTPUT_DIR}/debs/docker" "${OUTPUT_DIR}/debs/nginx"

# --- Download Docker CE packages --------------------------------------------
echo ""
echo "=== Downloading Docker CE packages ==="
# Add Docker repo key and source for offline download
if ! command -v docker &>/dev/null; then
  apt-get install -y curl gnupg
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /tmp/docker.gpg
  install -o root -g root -m 644 /tmp/docker.gpg /etc/apt/keyrings/docker.gpg
  ARCH=$(dpkg --print-architecture)
  CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")
  echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
fi

cd "${OUTPUT_DIR}/debs/docker"
apt-get download \
  docker-ce \
  docker-ce-cli \
  containerd.io \
  docker-buildx-plugin \
  docker-compose-plugin 2>/dev/null || true

# Also download libseccomp2 which Docker needs
apt-get download libseccomp2 2>/dev/null || true
cd - >/dev/null

echo "  Docker packages downloaded to ${OUTPUT_DIR}/debs/docker/"

# --- Download nginx packages -------------------------------------------------
echo ""
echo "=== Downloading nginx packages ==="
cd "${OUTPUT_DIR}/debs/nginx"
apt-get download nginx nginx-core nginx-common nginx-full 2>/dev/null || \
apt-get download nginx 2>/dev/null || true
# Dependencies
apt-get download \
  libpcre3 \
  libssl3 \
  zlib1g \
  libnginx-mod-http-gzip-static 2>/dev/null || true
cd - >/dev/null
echo "  nginx packages downloaded to ${OUTPUT_DIR}/debs/nginx/"

# --- Build OffDock binary ----------------------------------------------------
echo ""
echo "=== Building OffDock binary ==="
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Build frontend first
if command -v npm &>/dev/null; then
  echo "  Building frontend..."
  cd "${SCRIPT_DIR}/web" && npm install && npm run build && cd - >/dev/null
else
  echo "WARNING: npm not found - using existing web/dist if present"
fi

# Build Go binary
if command -v go &>/dev/null; then
  echo "  Building Go binary..."
  cd "${SCRIPT_DIR}"
  go build -o "${OUTPUT_DIR}/offdock" ./cmd/offdock
  echo "  Binary built: ${OUTPUT_DIR}/offdock"
elif [[ -f "${SCRIPT_DIR}/offdock" ]]; then
  cp "${SCRIPT_DIR}/offdock" "${OUTPUT_DIR}/offdock"
  echo "  Copied existing binary"
else
  echo "WARNING: Go not found and no binary exists - build offdock manually and copy to ${OUTPUT_DIR}/"
fi

# --- Copy installer files ---------------------------------------------------
echo ""
echo "=== Copying installer files ==="
cp "${SCRIPT_DIR}/install.sh"       "${OUTPUT_DIR}/"
cp "${SCRIPT_DIR}/offdock.service"  "${OUTPUT_DIR}/"

# --- Summary ----------------------------------------------------------------
echo ""
echo "============================================================"
echo "           USB package ready: ${OUTPUT_DIR}"
echo "============================================================"
echo "  Copy this entire directory to your USB drive."
echo ""
echo "  On the target server:"
echo "    sudo bash install.sh --domain deploy.ao.az"
echo ""
echo "  DNS records to create:"
echo "    deploy.ao.az  A  <server-ip>   (OffDock UI)"
echo "    *.ao.az       A  <server-ip>   (wildcard, optional)"
echo "============================================================"
