#!/usr/bin/env bash
# OffDock uninstaller — removes all OffDock files, configs, nginx vhosts, and data.
# Does NOT remove Docker or nginx themselves (system packages).
#
# Usage:
#   sudo bash uninstall.sh           # removes everything except /var/offdock data
#   sudo bash uninstall.sh --purge   # removes everything including /var/offdock data

set -euo pipefail

PURGE=false
for arg in "$@"; do
  [[ "$arg" == "--purge" ]] && PURGE=true
done

if [[ "$EUID" -ne 0 ]]; then
  echo "ERROR: Run as root: sudo bash uninstall.sh" >&2; exit 1
fi

echo "=== Uninstalling OffDock ==="

# Stop and disable service
if systemctl is-active --quiet offdock 2>/dev/null; then
  systemctl stop offdock
  echo "  Service stopped."
fi
systemctl disable offdock 2>/dev/null || true

# Remove binary and service file
rm -f /usr/local/bin/offdock
rm -f /etc/systemd/system/offdock.service
systemctl daemon-reload 2>/dev/null || true
echo "  Binary and service removed."

# Remove nginx vhosts
removed_nginx=0
for f in \
  /etc/nginx/sites-enabled/offdock-self.conf \
  /etc/nginx/sites-enabled/00-offdock-default.conf \
  /etc/nginx/sites-available/offdock-self.conf \
  /etc/nginx/sites-available/00-offdock-default.conf; do
  if [[ -f "$f" ]]; then
    rm -f "$f"
    removed_nginx=$((removed_nginx + 1))
  fi
done
# Remove any per-project offdock-*.conf files
for f in /etc/nginx/sites-enabled/offdock-*.conf /etc/nginx/sites-available/offdock-*.conf; do
  [[ -f "$f" ]] && rm -f "$f" && removed_nginx=$((removed_nginx + 1))
done
if [[ $removed_nginx -gt 0 ]]; then
  echo "  Removed $removed_nginx nginx config(s)."
  if command -v nginx &>/dev/null && systemctl is-active --quiet nginx 2>/dev/null; then
    nginx -t 2>/dev/null && systemctl reload nginx 2>/dev/null || true
    echo "  nginx reloaded."
  fi
fi

# Remove OffDock config
rm -rf /etc/offdock
echo "  Config directory removed."

if [[ "$PURGE" == "true" ]]; then
  rm -rf /var/offdock
  echo "  Data directory /var/offdock removed."
else
  echo "  Data preserved at /var/offdock (run with --purge to delete)"
fi

echo ""
echo "============================================================"
echo "  OffDock uninstalled."
if [[ "$PURGE" != "true" ]]; then
  echo "  To also delete all data:  sudo bash uninstall.sh --purge"
fi
echo "============================================================"
