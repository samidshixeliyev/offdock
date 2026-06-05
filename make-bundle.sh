#!/usr/bin/env bash
# make-bundle.sh — Creates the OffDock offline deployment bundle.
#
# Usage:
#   bash make-bundle.sh                           → UI-update bundle (~10 MB, binary only)
#   bash make-bundle.sh --full                    → Full install bundle (~170 MB, includes deb packages)
#   bash make-bundle.sh /path/to/output.tar.gz    → Custom output path
#
# Resulting tar.gz canonical structure:
#   offdock-bundle/
#     offdock          ← ELF binary (required by UI update)
#     VERSION          ← version string shown in UI
#     offdock.service  ← systemd unit
#     install.sh       ← full offline installer
#     uninstall.sh
#     INSTALL.md
#     debs/            ← only in --full bundles
#       docker/*.deb
#       nginx/*.deb
#       tcpdump/*.deb  ← tcpdump + libpcap0.8 + libdbus-1-3
#
# Install on offline machine:
#   tar -xzf offdock-*.tar.gz
#   cd offdock-bundle
#   sudo bash install.sh              # fresh install (needs debs)
#   sudo bash install.sh --update     # update running service (binary only, safe)
#
# UI update (System page → Update OffDock):
#   Works with both UI-update and full bundles — only the binary is used.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="${VERSION:-$(date +%Y-%m-%d)}"
INCLUDE_DEBS=0
OUT=""

# Parse arguments
for arg in "$@"; do
  case "$arg" in
    --full)       INCLUDE_DEBS=1 ;;
    --*)          echo "Unknown flag: $arg" >&2; exit 1 ;;
    *)            OUT="$arg" ;;
  esac
done

BUNDLE_TYPE=$([[ $INCLUDE_DEBS -eq 1 ]] && echo "full" || echo "ui-update")
[[ -z "$OUT" ]] && OUT="/tmp/offdock-offline-${VERSION}-${BUNDLE_TYPE}.tar.gz"
BUNDLE_DIR="/tmp/offdock-bundle"

echo "=== OffDock Bundle Builder ==="
echo "  Type:    $BUNDLE_TYPE"
echo "  Version: $VERSION"
echo "  Output:  $OUT"
echo ""

# Verify binary exists
if [[ ! -f "${SCRIPT_DIR}/offdock" ]]; then
  echo "ERROR: offdock binary not found — run 'make all' first" >&2
  exit 1
fi

# Create clean bundle dir
rm -rf "$BUNDLE_DIR"
mkdir -p "$BUNDLE_DIR"

# ── Required: binary ──────────────────────────────────────────────────────────
cp "${SCRIPT_DIR}/offdock" "$BUNDLE_DIR/offdock"
chmod 755 "$BUNDLE_DIR/offdock"
echo "  ✓ offdock binary  ($(du -sh "${SCRIPT_DIR}/offdock" | cut -f1))"

# ── Required: VERSION file ────────────────────────────────────────────────────
echo "$VERSION" > "$BUNDLE_DIR/VERSION"
echo "  ✓ VERSION = $VERSION"

# ── Scripts and service ───────────────────────────────────────────────────────
cp "${SCRIPT_DIR}/offdock.service" "$BUNDLE_DIR/"
cp "${SCRIPT_DIR}/install.sh"      "$BUNDLE_DIR/"
cp "${SCRIPT_DIR}/uninstall.sh"    "$BUNDLE_DIR/"
[[ -f "${SCRIPT_DIR}/nginx-setup.sh" ]]           && cp "${SCRIPT_DIR}/nginx-setup.sh" "$BUNDLE_DIR/"
[[ -f "${SCRIPT_DIR}/OFFLINE_INSTALL_GUIDE.md" ]] && cp "${SCRIPT_DIR}/OFFLINE_INSTALL_GUIDE.md" "$BUNDLE_DIR/INSTALL.md"
echo "  ✓ install.sh, offdock.service, uninstall.sh"

# ── Optional: deb packages (--full only) ─────────────────────────────────────
if [[ $INCLUDE_DEBS -eq 1 ]]; then
  mkdir -p "$BUNDLE_DIR/debs/docker" "$BUNDLE_DIR/debs/nginx" "$BUNDLE_DIR/debs/tcpdump"

  # Search for pre-downloaded deb packages in common locations.
  # Each component (docker, nginx, tcpdump) is located independently so a
  # partial pre-download still produces a valid bundle for the components found.
  find_debs() {
    local component="$1"
    for candidate in \
      "${SCRIPT_DIR}/debs/${component}" \
      "/home/ubuntu/offdock-offline/debs/${component}" \
      "${SCRIPT_DIR}/../offdock-offline/debs/${component}"; do
      if [[ -d "$candidate" ]] && ls "$candidate"/*.deb &>/dev/null 2>&1; then
        echo "$candidate"
        return
      fi
    done
  }

  _copy_debs() {
    local component="$1" label="$2"
    local src
    src=$(find_debs "$component")
    if [[ -n "$src" ]]; then
      cp "${src}"/*.deb "$BUNDLE_DIR/debs/${component}/" 2>/dev/null || true
      local count
      count=$(ls "$BUNDLE_DIR/debs/${component}" 2>/dev/null | grep -c '\.deb$' || true)
      echo "  ✓ ${label} debs: ${count} packages  (from ${src})"
    else
      echo "  WARNING: ${label} debs not found — run prepare-usb.sh on an internet machine to download them."
      rmdir "$BUNDLE_DIR/debs/${component}" 2>/dev/null || true
    fi
  }

  _copy_debs docker  "Docker"
  _copy_debs nginx   "nginx"
  _copy_debs tcpdump "tcpdump"

  # Remove empty debs/ dir if no component was found at all.
  rmdir "$BUNDLE_DIR/debs" 2>/dev/null || true
else
  echo "  ℹ  Skipping deb packages (UI-update bundle). Use --full for fresh-install bundle."
fi

# ── Pack ──────────────────────────────────────────────────────────────────────
cd /tmp
tar -czf "$OUT" offdock-bundle/

echo ""
echo "=== Bundle ready ==="
echo "  File:   $OUT"
echo "  Size:   $(du -sh "$OUT" | cut -f1)"
echo ""
echo "Contents:"
tar -tzf "$OUT" | sed 's/^/  /'
echo ""
echo "=== How to use ==="
echo "  UI update (drag & drop in System page):"
echo "    → $OUT"
echo ""
echo "  Server-side update (binary only, no downtime beyond restart):"
echo "    tar -xzf $OUT && sudo bash offdock-bundle/install.sh --update"
echo ""
if [[ $INCLUDE_DEBS -eq 1 ]]; then
  echo "  Fresh install on offline machine:"
  echo "    tar -xzf $OUT"
  echo "    cd offdock-bundle"
  echo "    sudo bash install.sh"
fi
