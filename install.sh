#!/usr/bin/env bash
# OffDock offline installer — supports fully air-gapped Ubuntu servers.
#
# Usage:
#   sudo bash install.sh            — interactive setup (recommended)
#   sudo bash install.sh --update   — replace binary + restart service
#   sudo bash install.sh --deps     — install bundled packages + OTel only (no binary swap)
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
UPDATE=false        # --update:  replace binary only, brief restart
FULL=false          # --full:    non-interactive full offline install
NONINTERACTIVE=false
RESTORE_ARCHIVE=""  # --restore <archive.tar.gz>
BUNDLE=false        # --bundle [outdir]: build the offline tar.gz
BUNDLE_OUT=""
WANT_SSL=false      # --ssl with --full: generate self-signed cert
NGINX_CONF=""       # --nginx-conf PATH: install a custom vhost instead of generated
DEPS=false          # --deps:    install bundled packages + OTel agents only, no binary swap/restart

usage() {
  cat <<USAGE
OffDock installer — one script for install, update, restore, and bundling.

  sudo bash install.sh                      Interactive install (asks about SSL)
  sudo bash install.sh --full [--domain D]  Non-interactive full offline install
                                            (installs Docker+nginx+tools from ./debs,
                                             loads ./images, verifies everything works)
      SSL/nginx options (all optional):
        --ssl                Generate a self-signed cert and serve HTTPS
        --pem PATH           Use an existing combined PEM (cert chain + key) for HTTPS
        --nginx-conf PATH    Install your own nginx vhost instead of the generated one
        --port N  --no-nginx
  sudo bash install.sh --update             Replace binary + restart (no downtime setup)
  sudo bash install.sh --restore ARCHIVE    Restore an OffDock backup .tar.gz
  sudo bash install.sh --uninstall          Remove OffDock (keeps /var/offdock data)
       bash install.sh --bundle [OUTDIR]    Build the offline tar.gz bundle (no root)

Bundle conventions (auto-detected for --full):
  certs/offdock.pem   → used as the HTTPS PEM if present (no --pem needed)
  nginx/*.conf        → installed as custom vhost(s) if present

Docs: System → System Update section, or the Docs page, in the OffDock UI.
USAGE
}

# --- argument parsing -------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case $1 in
    --uninstall) UNINSTALL=true; shift ;;
    --update)    UPDATE=true; shift ;;
    --full)      FULL=true; NONINTERACTIVE=true; shift ;;
    --deps)      DEPS=true;   shift ;;
    --restore)   RESTORE_ARCHIVE="${2:-}"; shift 2 ;;
    --bundle)    BUNDLE=true; if [[ -n "${2:-}" && "${2:-}" != --* ]]; then BUNDLE_OUT="$2"; shift 2; else shift; fi ;;
    --domain)    DOMAIN="${2:-}"; shift 2 ;;
    --port)      PORT="${2:-7070}"; shift 2 ;;
    --no-nginx)  SKIP_NGINX=true; shift ;;
    --ssl)       WANT_SSL=true; shift ;;
    --pem)       PEM_PATH="${2:-}"; shift 2 ;;
    --nginx-conf) NGINX_CONF="${2:-}"; shift 2 ;;
    -h|--help)   usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

# Auto-detect update mode (interactive only): if a running service + existing
# config found, offer a quick update instead of full interactive setup.
if [[ "$UPDATE" == "false" && "$UNINSTALL" == "false" && "$NONINTERACTIVE" == "false" \
      && "$BUNDLE" == "false" && -z "$RESTORE_ARCHIVE" ]]; then
  if systemctl is-active --quiet "${BINARY_NAME}" 2>/dev/null && [[ -f "${CONFIG_FILE}" ]]; then
    echo ""
    echo "  Existing OffDock service detected and running."
    read -rp "  Run as quick update (replace binary + restart)? [Y/n]: " _upd_input
    if [[ "${_upd_input,,}" != "n" && "${_upd_input,,}" != "no" ]]; then
      UPDATE=true
    fi
  fi
fi

# --bundle builds the offline archive and needs no root; everything else does.
if [[ "$EUID" -ne 0 && "$BUNDLE" == "false" ]]; then
  echo "ERROR: Run as root: sudo bash install.sh" >&2; exit 1
fi

# _install_debs_safe DIR LABEL
# Installs .deb files from DIR, skipping packages already at the same or newer
# version. This prevents accidental downgrades of core system packages (libc6,
# dpkg, coreutils, etc.) that the dependency resolver pulled into the bundle
# but are already present on the target server.
_install_debs_safe() {
  local _dir="$1" _label="$2"
  local -a _install=()
  local _skip=0
  for _deb in "${_dir}"/*.deb; do
    [[ -f "$_deb" ]] || continue
    local _pkg _ver _installed
    _pkg=$(dpkg-deb -f "$_deb" Package 2>/dev/null) || { _install+=("$_deb"); continue; }
    _ver=$(dpkg-deb -f "$_deb" Version 2>/dev/null) || { _install+=("$_deb"); continue; }
    _installed=$(dpkg-query -W -f='${Version}' "$_pkg" 2>/dev/null || true)
    if [[ -n "$_installed" ]] && dpkg --compare-versions "$_installed" ge "$_ver" 2>/dev/null; then
      ((_skip++)) || true
      continue
    fi
    _install+=("$_deb")
  done
  if [[ ${#_install[@]} -eq 0 ]]; then
    echo "  All $_label packages already up to date."
    return 0
  fi
  [[ $_skip -gt 0 ]] && echo "  Skipped $_skip already-up-to-date packages."
  dpkg --force-confold -i "${_install[@]}" 2>&1 || true
  dpkg --configure -a 2>&1 || true
}

# _hold_core_packages marks Docker + nginx packages as "hold" so that a later
# `apt --fix-broken install` (or any dependency resolution) can never remove
# them and take every running container down. This is the persistent guard for
# the most common air-gapped outage. OffDock also re-asserts these holds on
# every startup, so this is belt-and-suspenders.
_hold_core_packages() {
  local _pkgs=(docker-ce docker-ce-cli containerd.io docker-compose-plugin \
               docker-buildx-plugin nginx nginx-core nginx-common)
  local _held=()
  for _p in "${_pkgs[@]}"; do
    if dpkg-query -W -f='${Status}' "$_p" 2>/dev/null | grep -q "install ok installed"; then
      apt-mark hold "$_p" >/dev/null 2>&1 && _held+=("$_p")
    fi
  done
  [[ ${#_held[@]} -gt 0 ]] && echo "  Protected packages held: ${_held[*]}"
  return 0   # never let a false [[ ]] abort the caller under set -e
}

# _deploy_otel_agents copies the bundled OpenTelemetry language tracers into
# /var/offdock/otel so the deploy engine can mount them into containers when a
# project enables OTel. Every copy is guarded — a missing tracer is skipped, not
# fatal — so this can never crash an install/update. Idempotent (refresh-safe).
_deploy_otel_agents() {
  local OTEL_DIR="/var/offdock/otel"
  [[ -d "${SCRIPT_DIR}/otel" ]] || { echo "  No bundled otel/ — skipping tracer deploy."; return 0; }
  mkdir -p "${OTEL_DIR}"/{node,php,python,ruby,dotnet,go} 2>/dev/null || true
  # Mirror the whole tree (preserves dotnet/<rid> native libs and any new langs)
  # then normalise perms. cp failures are non-fatal.
  cp -a "${SCRIPT_DIR}/otel/." "${OTEL_DIR}/" 2>/dev/null || true
  find "${OTEL_DIR}" -type f -exec chmod 644 {} \; 2>/dev/null || true
  find "${OTEL_DIR}" -type d -exec chmod 755 {} \; 2>/dev/null || true
  local _n
  _n=$(find "${OTEL_DIR}" -type f 2>/dev/null | wc -l | tr -d ' ')
  echo "  OpenTelemetry agents deployed to ${OTEL_DIR} (${_n} files)."
  return 0
}

# _gen_self_signed PEM_OUT CN — generate a self-signed combined PEM (key+cert)
# covering the given CN plus the server IP. Best-effort; needs openssl.
_gen_self_signed() {
  local _out="$1" _cn="$2"
  command -v openssl &>/dev/null || { echo "  openssl missing — cannot generate cert" >&2; return 1; }
  local _ip; _ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  local _k _c; _k="$(mktemp)"; _c="$(mktemp)"
  local _cnf; _cnf="$(mktemp)"
  cat > "$_cnf" <<CNF
[req]
prompt=no
default_bits=2048
default_md=sha256
distinguished_name=dn
x509_extensions=v3
[dn]
CN=${_cn}
[v3]
subjectAltName=@alt
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
basicConstraints=CA:FALSE
[alt]
DNS.1=${_cn}
IP.1=${_ip:-127.0.0.1}
CNF
  openssl req -x509 -nodes -newkey rsa:2048 -days 3650 -keyout "$_k" -out "$_c" -config "$_cnf" 2>/dev/null || { rm -f "$_k" "$_c" "$_cnf"; return 1; }
  mkdir -p "$(dirname "$_out")"
  cat "$_k" "$_c" > "$_out"; chmod 600 "$_out"
  rm -f "$_k" "$_c" "$_cnf"
  echo "  generated self-signed cert: $_out (CN=${_cn})"
}

# _install_network_tools — install bundled network/dev tool debs (tcpdump for
# tracing, dnsutils, iproute2, iptables, conntrack, socat, etc.). Best-effort.
_install_network_tools() {
  if [[ -d "${SCRIPT_DIR}/debs/network" ]] && ls "${SCRIPT_DIR}/debs/network"/*.deb &>/dev/null; then
    echo "=== Installing network/dev tools from bundle ==="
    _install_debs_safe "${SCRIPT_DIR}/debs/network" "network tools"
  fi
}

# _verify_tools — confirm the runtime dependencies actually work. Prints a status
# line per tool and returns non-zero if a critical tool (docker) is broken.
_verify_tools() {
  echo ""
  echo "=== Verifying tools ==="
  local _crit_ok=true
  if command -v docker &>/dev/null && docker info &>/dev/null; then
    echo "  [ok]   docker runtime ($(docker --version | awk '{print $3}' | tr -d ,))"
  else
    echo "  [FAIL] docker not running — run: systemctl start docker" >&2; _crit_ok=false
  fi
  if docker compose version &>/dev/null; then
    echo "  [ok]   docker compose plugin"
  else
    echo "  [warn] docker compose plugin missing — deploys will fail" >&2
  fi
  if command -v nginx &>/dev/null && nginx -t &>/dev/null; then
    echo "  [ok]   nginx config valid"
  elif command -v nginx &>/dev/null; then
    echo "  [warn] nginx installed but 'nginx -t' failed" >&2
  else
    echo "  [warn] nginx not installed (reverse proxy disabled)"
  fi
  for _t in tcpdump nsenter ip iptables dig; do
    if command -v "$_t" &>/dev/null; then echo "  [ok]   $_t"; else echo "  [warn] $_t missing (some features limited)"; fi
  done
  $_crit_ok
}

# do_restore ARCHIVE — restore an OffDock backup .tar.gz produced by the UI.
# Archive layout: data/*.db, projects/<id>/, certs/, nginx/, config/config.yaml,
# volumes/<name>.tar.gz, MANIFEST.json.
do_restore() {
  set +e   # explicit error handling below; don't abort on benign non-zero
  local _arc="$1"
  [[ -f "$_arc" ]] || { echo "ERROR: archive not found: $_arc" >&2; exit 1; }
  echo "=== Restoring OffDock backup: $_arc ==="
  local _tmp; _tmp="$(mktemp -d)"
  trap 'rm -rf "$_tmp"' EXIT
  tar xzf "$_arc" -C "$_tmp" || { echo "ERROR: extract failed" >&2; exit 1; }

  systemctl stop "${BINARY_NAME}" 2>/dev/null || true

  # Database + projects + certs.
  [[ -d "$_tmp/data"     ]] && { mkdir -p "$DATA_DIR";     cp -a "$_tmp/data/."     "$DATA_DIR/"     && echo "  restored database"; }
  [[ -d "$_tmp/projects" ]] && { mkdir -p "$PROJECTS_DIR"; cp -a "$_tmp/projects/." "$PROJECTS_DIR/" && echo "  restored projects"; }
  [[ -d "$_tmp/certs"    ]] && { mkdir -p "$CERTS_DIR";    cp -a "$_tmp/certs/."    "$CERTS_DIR/"    && echo "  restored certs"; }
  # nginx vhosts.
  if [[ -d "$_tmp/nginx" ]]; then
    mkdir -p /etc/nginx/sites-available
    cp -a "$_tmp/nginx/." /etc/nginx/sites-available/ && echo "  restored nginx vhosts"
  fi
  # config.yaml (plaintext only; encrypted .enc must be restored from the UI).
  if [[ -f "$_tmp/config/config.yaml" ]]; then
    mkdir -p "$CONFIG_DIR"; cp -a "$_tmp/config/config.yaml" "$CONFIG_FILE" && chmod 600 "$CONFIG_FILE" && echo "  restored config.yaml"
  elif [[ -f "$_tmp/config/config.yaml.enc" ]]; then
    echo "  note: config is encrypted (config.yaml.enc) — restore it from the UI on the original machine."
  fi
  # Docker volumes.
  if [[ -d "$_tmp/volumes" ]] && command -v docker &>/dev/null; then
    for _vt in "$_tmp/volumes"/*.tar.gz; do
      [[ -f "$_vt" ]] || continue
      local _vn; _vn="$(basename "$_vt" .tar.gz)"
      docker volume create "$_vn" >/dev/null 2>&1 || true
      if docker run --rm -v "$_vn":/to -v "$_tmp/volumes":/backup:ro alpine \
           sh -c "rm -rf /to/* 2>/dev/null; tar xzf /backup/$(basename "$_vt") -C /to" 2>/dev/null; then
        echo "  restored volume: $_vn"
      else
        echo "  WARN: could not restore volume $_vn (is the 'alpine' image loaded?)" >&2
      fi
    done
  fi

  systemctl start "${BINARY_NAME}" 2>/dev/null || true
  echo "Restore complete. OffDock will reconcile projects + nginx on startup."
  exit 0
}

# do_bundle [OUTDIR] — assemble the offline tar.gz (binary + frontend embedded,
# install.sh, service, debs/, images/, VERSION). Runs without root.
do_bundle() {
  local _out="${1:-./offdock-offline-$(date +%Y%m%d)}"
  echo "=== Building offline bundle: ${_out}.tar.gz ==="
  local _stage; _stage="$(mktemp -d)"
  local _dst="$_stage/offdock-bundle"
  mkdir -p "$_dst"

  if [[ ! -f "${SCRIPT_DIR}/${BINARY_NAME}" ]]; then
    echo "ERROR: ${BINARY_NAME} binary not built. Run: make all (or go build -o offdock ./cmd/offdock)" >&2
    exit 1
  fi
  cp "${SCRIPT_DIR}/${BINARY_NAME}"      "$_dst/"
  cp "${SCRIPT_DIR}/install.sh"          "$_dst/"
  cp "${SCRIPT_DIR}/offdock.service"     "$_dst/"
  [[ -d "${SCRIPT_DIR}/debs"   ]] && cp -a "${SCRIPT_DIR}/debs"   "$_dst/"
  [[ -d "${SCRIPT_DIR}/images" ]] && cp -a "${SCRIPT_DIR}/images" "$_dst/"
  # OpenTelemetry language tracers (node/python/php/ruby/dotnet/go + Java agent jar).
  [[ -d "${SCRIPT_DIR}/otel"   ]] && cp -a "${SCRIPT_DIR}/otel"   "$_dst/"
  [[ -d "${SCRIPT_DIR}/assets" ]] && { mkdir -p "$_dst/images"; cp -a "${SCRIPT_DIR}/assets/"*.tar "$_dst/images/" 2>/dev/null || true; }
  # Optional: bundle a custom PEM (certs/offdock.pem) and/or custom nginx
  # vhost(s) (nginx/*.conf). --full auto-detects and uses them.
  [[ -d "${SCRIPT_DIR}/certs" ]] && cp -a "${SCRIPT_DIR}/certs" "$_dst/"
  [[ -d "${SCRIPT_DIR}/nginx" ]] && cp -a "${SCRIPT_DIR}/nginx" "$_dst/"
  ( cd "${SCRIPT_DIR}" && git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d ) > "$_dst/VERSION"

  mkdir -p "$(dirname "$_out")"
  tar czf "${_out}.tar.gz" -C "$_stage" offdock-bundle
  rm -rf "$_stage"
  echo "  Bundle: ${_out}.tar.gz ($(du -h "${_out}.tar.gz" | cut -f1))"
  echo "  Install on target:  sudo bash install.sh --full --domain <your-domain>"
  exit 0
}

# do_full_install — non-interactive full offline install. Installs Docker, nginx,
# and network tools from ./debs, loads ./images, writes config, installs the
# binary + service, configures nginx, verifies everything, and starts OffDock.
do_full_install() {
  # This installer handles its own errors (|| true, explicit checks). Disable
  # set -e so a single benign non-zero (e.g. nothing-to-hold, inactive service
  # during the wait loop) cannot abort the whole install midway.
  set +e
  local _ip; _ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [[ -z "$DOMAIN" ]] && DOMAIN="$_ip"
  echo ""
  echo "╔══════════════════════════════════════════════════╗"
  echo "║        OffDock Full Offline Install              ║"
  echo "╚══════════════════════════════════════════════════╝"
  echo "  Domain: ${DOMAIN}   Port: ${PORT}   nginx: $([[ "$SKIP_NGINX" == true ]] && echo off || echo on)"

  # Required artifacts.
  [[ -f "${SCRIPT_DIR}/${BINARY_NAME}" ]] || { echo "ERROR: ${BINARY_NAME} binary missing in bundle" >&2; exit 1; }

  # Docker.
  echo "=== Docker ==="
  if command -v docker &>/dev/null && docker info &>/dev/null; then
    echo "  Docker already running: $(docker --version)"
  elif [[ -d "${SCRIPT_DIR}/debs/docker" ]] && ls "${SCRIPT_DIR}/debs/docker"/*.deb &>/dev/null; then
    _install_debs_safe "${SCRIPT_DIR}/debs/docker" "Docker"
  else
    echo "ERROR: Docker not available and no debs/docker bundled." >&2; exit 1
  fi
  systemctl enable --now docker 2>/dev/null || true
  _hold_core_packages

  # Bundled images.
  if [[ -d "${SCRIPT_DIR}/images" ]] && ls "${SCRIPT_DIR}/images"/*.tar &>/dev/null 2>&1; then
    echo "=== Loading bundled images ==="
    for _img in "${SCRIPT_DIR}/images/"*.tar; do docker load -i "${_img}" 2>/dev/null && echo "  loaded $(basename "$_img")" || true; done
  fi

  # nginx.
  if [[ "$SKIP_NGINX" == false ]]; then
    echo "=== nginx ==="
    if command -v nginx &>/dev/null; then
      echo "  nginx already installed"
    elif [[ -d "${SCRIPT_DIR}/debs/nginx" ]] && ls "${SCRIPT_DIR}/debs/nginx"/*.deb &>/dev/null; then
      _install_debs_safe "${SCRIPT_DIR}/debs/nginx" "nginx"
    fi
    command -v nginx &>/dev/null && { systemctl enable --now nginx 2>/dev/null || true; _hold_core_packages; } || SKIP_NGINX=true
  fi

  # Network/dev tools.
  _install_network_tools

  # ── Resolve SSL/PEM ───────────────────────────────────────────────────────
  # Priority: --pem PATH  >  bundle certs/offdock.pem  >  --ssl (generate).
  for _d in "${DATA_DIR}" "${LOG_DIR}" "${CERTS_DIR}" "${PROJECTS_DIR}"; do mkdir -p "$_d"; chmod 700 "$_d"; done
  if [[ -n "$PEM_PATH" ]]; then
    if [[ -f "$PEM_PATH" ]]; then echo "=== SSL: using provided PEM $PEM_PATH ==="
    else echo "  WARNING: --pem $PEM_PATH not found — continuing HTTP only" >&2; PEM_PATH=""; fi
  elif [[ -f "${SCRIPT_DIR}/certs/offdock.pem" ]]; then
    PEM_PATH="${CERTS_DIR}/offdock.pem"; cp "${SCRIPT_DIR}/certs/offdock.pem" "$PEM_PATH"; chmod 600 "$PEM_PATH"
    echo "=== SSL: using bundled certs/offdock.pem ==="
  elif [[ "$WANT_SSL" == true ]]; then
    echo "=== SSL: generating self-signed cert ==="
    _gen_self_signed "${CERTS_DIR}/offdock.pem" "${DOMAIN}" && PEM_PATH="${CERTS_DIR}/offdock.pem" || PEM_PATH=""
  fi

  # Config (generate jwt secret if new).
  echo "=== Config ==="
  mkdir -p "${CONFIG_DIR}"
  if [[ ! -f "${CONFIG_FILE}" ]]; then
    local _jwt; _jwt="$(head -c48 /dev/urandom | base64 | tr -d '\n/+=')"
    cat > "${CONFIG_FILE}" <<EOF
port: ${PORT}
data_dir: ${DATA_DIR}
log_dir: ${LOG_DIR}
log_level: info
jwt_secret: "${_jwt}"
default_pem_path: "${PEM_PATH}"
EOF
    chmod 600 "${CONFIG_FILE}"
    echo "  wrote ${CONFIG_FILE}"
  else
    echo "  keeping existing ${CONFIG_FILE}"
  fi
  for _d in "${DATA_DIR}" "${LOG_DIR}" "${CERTS_DIR}" "${PROJECTS_DIR}"; do mkdir -p "$_d"; chmod 700 "$_d"; done

  # OpenTelemetry language tracers (node/python/php/ruby/dotnet/go + Java agent).
  echo "=== OpenTelemetry agents ==="
  _deploy_otel_agents

  # Binary + service (atomic replace).
  echo "=== Binary + service ==="
  systemctl stop "${BINARY_NAME}" 2>/dev/null || true
  cp "${SCRIPT_DIR}/${BINARY_NAME}" "${INSTALL_BIN}.tmp"; chmod 755 "${INSTALL_BIN}.tmp"; mv -f "${INSTALL_BIN}.tmp" "${INSTALL_BIN}"
  cp "${SCRIPT_DIR}/offdock.service" "${SERVICE_FILE}"; chmod 644 "${SERVICE_FILE}"
  systemctl daemon-reload 2>/dev/null || true
  systemctl enable "${BINARY_NAME}" 2>/dev/null || true

  # nginx vhost — custom file, or generated HTTP/HTTPS. Name-based, so it never
  # collides with an existing default_server.
  if [[ "$SKIP_NGINX" == false ]] && command -v nginx &>/dev/null; then
    echo "=== nginx vhost ==="
    mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled
    local _proxy="    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \"upgrade\";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
    }"

    # 1) A user-provided custom vhost (--nginx-conf or bundle nginx/*.conf) wins.
    local _custom=""
    [[ -n "$NGINX_CONF" && -f "$NGINX_CONF" ]] && _custom="$NGINX_CONF"
    if [[ -z "$_custom" && -d "${SCRIPT_DIR}/nginx" ]]; then
      _custom="$(ls "${SCRIPT_DIR}/nginx/"*.conf 2>/dev/null | head -1)"
    fi

    if [[ -n "$_custom" ]]; then
      cp "$_custom" /etc/nginx/sites-available/offdock-self.conf
      echo "  using custom nginx vhost: $_custom"
    elif [[ -n "$PEM_PATH" ]]; then
      # 2) HTTPS vhost (HTTP → HTTPS redirect + 443 ssl).
      cat > /etc/nginx/sites-available/offdock-self.conf <<NGX
server {
    listen 80;
    server_name ${DOMAIN};
    server_tokens off;
    return 301 https://\$host\$request_uri;
}
server {
    listen 443 ssl http2;
    server_name ${DOMAIN};
    server_tokens off;
    client_max_body_size 6g;
    ssl_certificate     ${PEM_PATH};
    ssl_certificate_key ${PEM_PATH};
    ssl_protocols       TLSv1.2 TLSv1.3;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
${_proxy}
}
NGX
      echo "  HTTPS vhost → ${DOMAIN} (PEM ${PEM_PATH})"
    else
      # 3) Plain HTTP vhost.
      cat > /etc/nginx/sites-available/offdock-self.conf <<NGX
server {
    listen 80;
    server_name ${DOMAIN};
    server_tokens off;
    client_max_body_size 6g;
${_proxy}
}
NGX
      echo "  HTTP vhost → ${DOMAIN}:${PORT}"
    fi

    ln -sf /etc/nginx/sites-available/offdock-self.conf /etc/nginx/sites-enabled/offdock-self.conf
    # Disable the stock default site (it also grabs :80 with its own server).
    [[ -L /etc/nginx/sites-enabled/default ]] && rm -f /etc/nginx/sites-enabled/default

    if nginx -t 2>/dev/null; then
      systemctl reload nginx 2>/dev/null || systemctl restart nginx 2>/dev/null || true
      # Verify nginx actually came up — the usual failure is another process
      # (often a published Docker container) already holding :80/:443.
      if ! systemctl is-active --quiet nginx 2>/dev/null; then
        local _busy; _busy="$(ss -ltnp 2>/dev/null | grep -E ':80 |:443 ' | grep -v nginx | head -2)"
        echo "  WARNING: nginx could not start — ports 80/443 appear to be in use:" >&2
        [[ -n "$_busy" ]] && echo "$_busy" | sed 's/^/    /' >&2
        echo "    Free those ports (e.g. stop the container publishing them) and run:" >&2
        echo "      systemctl restart nginx" >&2
        echo "    OffDock is still reachable directly at http://${_ip}:${PORT}" >&2
      fi
    else
      echo "  WARNING: nginx -t failed; removing OffDock vhost to protect your config" >&2
      rm -f /etc/nginx/sites-enabled/offdock-self.conf /etc/nginx/sites-available/offdock-self.conf
    fi
  fi

  # Start + wait.
  echo "=== Starting OffDock ==="
  systemctl start "${BINARY_NAME}" 2>/dev/null || true
  local _up=false
  for _i in $(seq 1 15); do sleep 1; systemctl is-active --quiet "${BINARY_NAME}" 2>/dev/null && { _up=true; break; }; done

  _verify_tools || true

  if [[ "$_up" == true ]]; then
    local _proto="http"; [[ -n "$PEM_PATH" ]] && _proto="https"
    echo ""
    echo "OffDock running:  ${_proto}://${DOMAIN}/   (direct: http://${_ip}:${PORT})"
    echo "Next: open the UI and go to /setup to create the admin account."
  else
    echo "ERROR: OffDock failed to start — journalctl -u offdock -n 50" >&2; exit 1
  fi
  exit 0
}

# --- bundle path (no root) --------------------------------------------------
if [[ "$BUNDLE" == "true" ]]; then
  do_bundle "$BUNDLE_OUT"
fi

# --- restore path -----------------------------------------------------------
if [[ -n "$RESTORE_ARCHIVE" ]]; then
  do_restore "$RESTORE_ARCHIVE"
fi

# --- uninstall path ---------------------------------------------------------
if [[ "$UNINSTALL" == "true" ]]; then
  echo "Removing OffDock..."
  systemctl stop    "${BINARY_NAME}" 2>/dev/null || true
  systemctl disable "${BINARY_NAME}" 2>/dev/null || true
  rm -f "${INSTALL_BIN}" "${SERVICE_FILE}"
  systemctl daemon-reload 2>/dev/null || true
  # Remove all OffDock nginx configs (self-hosting + per-project + proxy-hosts).
  _nginx_removed=0
  for _f in \
      /etc/nginx/sites-available/offdock-self.conf \
      /etc/nginx/sites-enabled/offdock-self.conf \
      /etc/nginx/sites-available/00-offdock-default.conf \
      /etc/nginx/sites-enabled/00-offdock-default.conf; do
    [[ -f "$_f" || -L "$_f" ]] && rm -f "$_f" && ((_nginx_removed++)) || true
  done
  shopt -s nullglob
  for _f in /etc/nginx/sites-enabled/offdock-*.conf \
            /etc/nginx/sites-available/offdock-*.conf; do
    rm -f "$_f" && ((_nginx_removed++)) || true
  done
  shopt -u nullglob
  # Restore the stock default site if it was removed by the installer.
  if [[ ! -e /etc/nginx/sites-enabled/default && \
        -f /etc/nginx/sites-available/default ]]; then
    ln -sf /etc/nginx/sites-available/default \
           /etc/nginx/sites-enabled/default 2>/dev/null || true
    echo "  Restored nginx default site."
  fi
  if [[ $_nginx_removed -gt 0 ]] && command -v nginx &>/dev/null; then
    nginx -t 2>/dev/null && { systemctl reload nginx 2>/dev/null || nginx -s reload 2>/dev/null || true; }
  fi
  echo "OffDock removed. Data in /var/offdock/ and config in /etc/offdock/ preserved."
  echo "To also remove data: sudo rm -rf /var/offdock /etc/offdock"
  exit 0
fi

# --- check required files ---------------------------------------------------
# --deps skips the binary entirely; only needs the debs/ and otel/ directories.
if [[ "$DEPS" == "false" ]]; then
  if [[ ! -f "${SCRIPT_DIR}/${BINARY_NAME}" ]]; then
    echo "ERROR: '${BINARY_NAME}' binary not found in ${SCRIPT_DIR}" >&2
    echo "       Build it first: make all" >&2; exit 1
  fi
  if [[ ! -f "${SCRIPT_DIR}/offdock.service" ]]; then
    echo "ERROR: offdock.service not found in ${SCRIPT_DIR}" >&2; exit 1
  fi
fi

# ============================================================================
# DEPS PATH — install bundled packages + OTel agents, no binary/service change
# ============================================================================
# Use this to install docker/nginx/tcpdump and refresh OTel agents without
# touching the running OffDock service. Safe to run independently on any
# machine that has the bundle extracted — OffDock does not need to be installed.
if [[ "$DEPS" == "true" ]]; then
  echo ""
  echo "╔══════════════════════════════════════════════════╗"
  echo "║         OffDock Dependency Setup                 ║"
  echo "╚══════════════════════════════════════════════════╝"

  echo ""
  echo "=== Installing bundled packages ==="
  for _component in docker nginx tcpdump; do
    if [[ -d "${SCRIPT_DIR}/debs/${_component}" ]] && ls "${SCRIPT_DIR}/debs/${_component}"/*.deb &>/dev/null 2>&1; then
      echo "  Installing ${_component}..."
      _install_debs_safe "${SCRIPT_DIR}/debs/${_component}" "${_component}"
    else
      echo "  No debs for ${_component} — skipping."
    fi
  done

  # Ensure docker and nginx start if they were just installed.
  command -v docker &>/dev/null && { systemctl enable docker 2>/dev/null || true; systemctl start docker 2>/dev/null || true; }
  command -v nginx  &>/dev/null && { systemctl enable nginx  2>/dev/null || true; systemctl start nginx  2>/dev/null || true; }

  # Install OpenTelemetry agent files.
  echo ""
  echo "=== Installing OpenTelemetry agents ==="
  _deploy_otel_agents

  echo ""
  echo "  Done. Packages and OTel agents are ready."
  echo "  Run 'sudo bash install.sh' to complete OffDock setup, or '--update' to swap the binary."
  exit 0
fi

# ============================================================================
# UPDATE PATH — replace binary + restart, skip all interactive setup
# ============================================================================
if [[ "$UPDATE" == "true" ]]; then
  echo ""
  echo "╔══════════════════════════════════════════════════╗"
  echo "║             OffDock Update                       ║"
  echo "╚══════════════════════════════════════════════════╝"

  # Atomic binary replacement: copy to temp, rename (avoids "Text file busy").
  # The running service keeps using the old executable until it restarts.
  echo "  Replacing binary..."
  cp "${SCRIPT_DIR}/${BINARY_NAME}" "${INSTALL_BIN}.new"
  chmod 755 "${INSTALL_BIN}.new"
  mv -f "${INSTALL_BIN}.new" "${INSTALL_BIN}"

  # Update service file if changed.
  if ! diff -q "${SCRIPT_DIR}/offdock.service" "${SERVICE_FILE}" &>/dev/null; then
    echo "  Updating service file..."
    cp "${SCRIPT_DIR}/offdock.service" "${SERVICE_FILE}"
    chmod 644 "${SERVICE_FILE}"
    systemctl daemon-reload 2>/dev/null || true
  fi

  # Graceful restart: systemd sends SIGTERM, waits for clean shutdown, then starts fresh.
  # If the service doesn't exist yet (first binary drop), install the service file and enable it.
  echo "  Restarting service (brief downtime expected — a few seconds)..."
  if ! systemctl is-enabled --quiet "${BINARY_NAME}" 2>/dev/null; then
    echo "  Service not found — installing service file..."
    if [[ -f "${SCRIPT_DIR}/offdock.service" ]]; then
      cp "${SCRIPT_DIR}/offdock.service" "${SERVICE_FILE}"
      chmod 644 "${SERVICE_FILE}"
    fi
    systemctl daemon-reload 2>/dev/null || true
    systemctl enable "${BINARY_NAME}" 2>/dev/null || true
  fi
  systemctl restart "${BINARY_NAME}" 2>/dev/null || {
    echo "ERROR: restart failed — check: journalctl -u offdock -n 30" >&2; exit 1
  }

  # Verify service came back up.
  _up=false
  for _i in $(seq 1 15); do
    sleep 1
    if systemctl is-active --quiet "${BINARY_NAME}" 2>/dev/null; then
      _up=true; break
    fi
  done

  if [[ "$_up" == "true" ]]; then
    echo ""
    echo "  OffDock updated and running."
    echo "  Logs: journalctl -u offdock -f"
  else
    echo "ERROR: OffDock did not start after update." >&2
    echo "       Check: journalctl -u offdock -n 50" >&2
    exit 1
  fi

  # Install any bundled deb packages that are not yet present on the system.
  # This handles tcpdump (tracing), docker (container runtime), nginx (reverse proxy)
  # — _install_debs_safe skips packages already at the same or newer version.
  echo ""
  echo "=== Installing bundled packages (if missing) ==="
  for _component in docker nginx tcpdump; do
    if [[ -d "${SCRIPT_DIR}/debs/${_component}" ]] && ls "${SCRIPT_DIR}/debs/${_component}"/*.deb &>/dev/null 2>&1; then
      _install_debs_safe "${SCRIPT_DIR}/debs/${_component}" "${_component}"
    fi
  done
  # Ensure docker and nginx services are running if they were just installed.
  command -v docker &>/dev/null && { systemctl enable docker 2>/dev/null || true; systemctl start docker 2>/dev/null || true; }
  command -v nginx  &>/dev/null && { systemctl enable nginx  2>/dev/null || true; systemctl start nginx  2>/dev/null || true; }

  # Refresh OpenTelemetry agent files so new/updated tracers take effect.
  echo ""
  echo "=== Refreshing OpenTelemetry agents ==="
  _deploy_otel_agents
  exit 0
fi

# ============================================================================
# FULL OFFLINE INSTALL (non-interactive) — exits when done
# ============================================================================
if [[ "$FULL" == "true" ]]; then
  do_full_install
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
  _install_debs_safe "${SCRIPT_DIR}/debs/docker" "Docker"
  if ! command -v docker &>/dev/null; then
    echo "ERROR: Docker not available after install attempt." >&2
    echo "       Run: dpkg --configure -a  then retry." >&2
    exit 1
  fi
  echo "  Docker installed: $(docker --version)"
else
  echo "ERROR: Docker not installed and no offline packages found in ./debs/docker/" >&2
  echo "       Build a bundle on an internet machine: bash install.sh --bundle" >&2
  exit 1
fi
systemctl enable docker 2>/dev/null || true
systemctl start  docker 2>/dev/null || true
_hold_core_packages

# Load any bundled Docker images
if [[ -d "${SCRIPT_DIR}/images" ]] && ls "${SCRIPT_DIR}/images"/*.tar &>/dev/null 2>&1; then
  echo "  Loading bundled Docker images..."
  for _img in "${SCRIPT_DIR}/images/"*.tar; do
    docker load -i "${_img}" && echo "    Loaded: ${_img}" || echo "    WARNING: failed to load ${_img}" >&2
  done
fi

# ============================================================================
# INSTALL OPENTELEMETRY AGENTS (for auto-instrumentation of deployed containers)
# ============================================================================
OTEL_DIR="/var/offdock/otel"
mkdir -p "${OTEL_DIR}" "${OTEL_DIR}/node" "${OTEL_DIR}/php" "${OTEL_DIR}/python" "${OTEL_DIR}/ruby"

# Java agent
if [[ -f "${SCRIPT_DIR}/otel/opentelemetry-javaagent.jar" ]]; then
  cp "${SCRIPT_DIR}/otel/opentelemetry-javaagent.jar" "${OTEL_DIR}/opentelemetry-javaagent.jar"
  chmod 644 "${OTEL_DIR}/opentelemetry-javaagent.jar"
  AGENT_VER=$(cat "${SCRIPT_DIR}/otel/VERSION" 2>/dev/null | head -1 || echo "unknown")
  echo "  Java agent: ${OTEL_DIR}/opentelemetry-javaagent.jar (v${AGENT_VER})"
else
  echo "  WARNING: OpenTelemetry Java agent not found — skipping." >&2
fi

# Node.js zero-dependency auto-tracer
if [[ -f "${SCRIPT_DIR}/otel/node/tracer.js" ]]; then
  cp "${SCRIPT_DIR}/otel/node/tracer.js" "${OTEL_DIR}/node/tracer.js"
  chmod 644 "${OTEL_DIR}/node/tracer.js"
  echo "  Node.js tracer: ${OTEL_DIR}/node/tracer.js"
fi

# PHP zero-dependency auto-tracer
if [[ -f "${SCRIPT_DIR}/otel/php/tracer.php" ]]; then
  cp "${SCRIPT_DIR}/otel/php/tracer.php" "${OTEL_DIR}/php/tracer.php"
  cp "${SCRIPT_DIR}/otel/php/offdock.ini"  "${OTEL_DIR}/php/offdock.ini"
  chmod 644 "${OTEL_DIR}/php/tracer.php" "${OTEL_DIR}/php/offdock.ini"
  echo "  PHP tracer: ${OTEL_DIR}/php/tracer.php"
fi

# Python zero-dependency auto-tracer (sitecustomize.py — auto-imported by Python)
if [[ -f "${SCRIPT_DIR}/otel/python/sitecustomize.py" ]]; then
  cp "${SCRIPT_DIR}/otel/python/sitecustomize.py" "${OTEL_DIR}/python/sitecustomize.py"
  chmod 644 "${OTEL_DIR}/python/sitecustomize.py"
  echo "  Python tracer: ${OTEL_DIR}/python/sitecustomize.py"
fi

# Ruby zero-dependency auto-tracer
if [[ -f "${SCRIPT_DIR}/otel/ruby/tracer.rb" ]]; then
  cp "${SCRIPT_DIR}/otel/ruby/tracer.rb" "${OTEL_DIR}/ruby/tracer.rb"
  chmod 644 "${OTEL_DIR}/ruby/tracer.rb"
  echo "  Ruby tracer: ${OTEL_DIR}/ruby/tracer.rb"
fi

# OffDock itself is the OTLP receiver — no separate collector needed.
echo "  OpenTelemetry receiver: built into OffDock at :7070/v1/traces"
echo "  App Traces page: visible in the OffDock UI → App Traces"

# ============================================================================
# INSTALL TCPDUMP (required for container network tracing)
# ============================================================================
echo ""
echo "=== Checking tcpdump ==="
if command -v tcpdump &>/dev/null; then
  echo "  tcpdump already installed: $(tcpdump --version 2>&1 | head -1)"
elif [[ -d "${SCRIPT_DIR}/debs/tcpdump" ]] && ls "${SCRIPT_DIR}/debs/tcpdump"/*.deb &>/dev/null 2>&1; then
  echo "  Installing tcpdump from bundled packages..."
  _install_debs_safe "${SCRIPT_DIR}/debs/tcpdump" "tcpdump"
  if command -v tcpdump &>/dev/null; then
    echo "  tcpdump installed: $(tcpdump --version 2>&1 | head -1)"
  else
    echo "  WARNING: tcpdump not available after install — container tracing will not work." >&2
  fi
else
  echo "  WARNING: tcpdump not installed and no offline packages found in ./debs/tcpdump/" >&2
  echo "  Container network tracing will not work. Install tcpdump to enable it." >&2
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
    _install_debs_safe "${SCRIPT_DIR}/debs/nginx" "nginx"
    if command -v nginx &>/dev/null; then
      echo "  nginx installed: $(nginx -v 2>&1)"
    else
      echo "  WARNING: nginx not available after install attempt — skipping nginx setup." >&2
      SKIP_NGINX=true
    fi
  else
    echo "  WARNING: nginx not installed and no offline packages found — skipping nginx setup." >&2
    SKIP_NGINX=true
  fi
  if [[ "$SKIP_NGINX" == "false" ]]; then
    systemctl enable nginx 2>/dev/null || true
    systemctl start  nginx 2>/dev/null || true
    _hold_core_packages
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
  JWT_SECRET=$(head -c48 /dev/urandom | base64 | tr -d '\n/+=')
  if [[ ${#JWT_SECRET} -lt 32 ]]; then
    echo "ERROR: failed to generate JWT secret — /dev/urandom not available?" >&2; exit 1
  fi
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

# SMTP — configure for OTP terminal access and DNS ticket emails (Exchange/Outlook).
# smtp_host: mail.corp.local
# smtp_port: 587
# smtp_username: user@corp.local
# smtp_password: secret
# smtp_from: offdock@corp.local
# smtp_starttls: true
# smtp_insecure_skip_verify: false
# dns_admin_email: dns-admin@corp.local
EOF
  chmod 600 "${CONFIG_FILE}"
  echo "  Config written to ${CONFIG_FILE}"
else
  # Config exists — preserve jwt_secret, update port and pem_path in-place.
  _existing_secret=$(grep '^jwt_secret:' "${CONFIG_FILE}" | sed 's/jwt_secret:[[:space:]]*//' | tr -d '"')
  if [[ -n "$_existing_secret" ]]; then
    # Update port, data_dir, log_dir, default_pem_path while preserving everything else.
    _tmpconf="${CONFIG_FILE}.tmp"
    sed \
      -e "s|^port:.*|port: ${PORT}|" \
      -e "s|^data_dir:.*|data_dir: ${DATA_DIR}|" \
      -e "s|^log_dir:.*|log_dir: ${LOG_DIR}|" \
      -e "s|^default_pem_path:.*|default_pem_path: \"${PEM_PATH}\"|" \
      "${CONFIG_FILE}" > "${_tmpconf}" && mv -f "${_tmpconf}" "${CONFIG_FILE}"
    echo "  Config updated (port=${PORT}, pem=${PEM_PATH:-none})."
  else
    echo "  Config already exists — not overwriting (could not read jwt_secret)."
  fi
fi

# ============================================================================
# RUNTIME DIRECTORIES + LOG ROTATION
# ============================================================================
for _dir in "${DATA_DIR}" "${LOG_DIR}" "${CERTS_DIR}" "${PROJECTS_DIR}"; do
  mkdir -p "${_dir}"; chmod 700 "${_dir}"
done

# Install logrotate config so /var/offdock/logs/offdock.log doesn't grow unbounded.
if command -v logrotate &>/dev/null; then
  cat > /etc/logrotate.d/offdock <<'LOGROTATEOF'
/var/offdock/logs/offdock.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
LOGROTATEOF
  echo "  Log rotation configured: daily, 14 days retention."
fi

# ============================================================================
# INSTALL BINARY + SERVICE
# ============================================================================
echo "  Installing ${INSTALL_BIN}..."
# Full install: stop service if running, replace binary, reconfigure, then start.
# For updates to an existing live service use --update (or answer Y to the prompt above)
# which does an atomic replacement with only a brief restart downtime.
if systemctl is-active --quiet "${BINARY_NAME}" 2>/dev/null; then
  systemctl stop "${BINARY_NAME}" 2>/dev/null || true
fi
# Atomic replace: write to a temp file then rename.
cp "${SCRIPT_DIR}/${BINARY_NAME}" "${INSTALL_BIN}.tmp"
chmod 755 "${INSTALL_BIN}.tmp"
mv -f "${INSTALL_BIN}.tmp" "${INSTALL_BIN}"
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

  NGINX_DOMAIN="${DOMAIN:-${SERVER_IP}}"

  # ── Safety: detect a pre-existing default_server we don't own ─────────────
  # On a server that already runs nginx, adding our own `default_server` would
  # cause a "duplicate default server" error. Detect that and, if found, skip
  # both the catch-all and the stock-default removal — we then only add a
  # name-based vhost for the OffDock domain, which never collides.
  # -R (not -r) so symlinked sites-enabled/* entries are followed.
  EXISTING_DEFAULT=$(grep -RlE 'listen[^;]*default_server' \
      /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ /etc/nginx/nginx.conf 2>/dev/null \
      | grep -vE 'offdock' || true)
  MANAGE_DEFAULT=true
  if [[ -n "$EXISTING_DEFAULT" ]]; then
    MANAGE_DEFAULT=false
    echo "  Existing default_server detected — leaving your nginx default untouched:"
    echo "$EXISTING_DEFAULT" | sed 's/^/    /'
    echo "  OffDock will add ONLY a name-based vhost for ${NGINX_DOMAIN} (no catch-all)."
  fi

  # Only disable the stock default site when we're taking over the default role.
  _removed_default_symlink=false
  if [[ "$MANAGE_DEFAULT" == "true" && -f /etc/nginx/sites-enabled/default ]]; then
    rm -f /etc/nginx/sites-enabled/default && echo "  Disabled nginx stock default site."
    _removed_default_symlink=true
  fi

  # ── Catch-all default server (only when no other default_server exists) ───
  if [[ "$MANAGE_DEFAULT" == "true" ]]; then
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
  fi  # end MANAGE_DEFAULT

  # ── Named vhost for OffDock domain (always safe — name-based) ────────────
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

  if _nginx_test_out=$(nginx -t 2>&1); then
    systemctl reload nginx 2>/dev/null || nginx -s reload 2>/dev/null || true
    echo "  nginx configured: ${NGINX_DOMAIN} → :${PORT}"
  else
    # Roll back ONLY the files we just added, so the operator's existing nginx
    # is never left in a broken state (a later reload would otherwise fail).
    echo "WARNING: nginx config test failed — rolling back OffDock's nginx changes to protect your existing setup." >&2
    echo "$_nginx_test_out" | sed 's/^/  /' >&2
    rm -f /etc/nginx/sites-enabled/offdock-self.conf \
          /etc/nginx/sites-available/offdock-self.conf \
          /etc/nginx/sites-enabled/00-offdock-default.conf \
          /etc/nginx/sites-available/00-offdock-default.conf
    if [[ "$_removed_default_symlink" == "true" ]]; then
      ln -sf /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default 2>/dev/null || true
      echo "  Restored nginx default site." >&2
    fi
    if nginx -t 2>/dev/null; then
      echo "  Rolled back cleanly — your existing nginx is untouched." >&2
    fi
    echo "  OffDock is still reachable directly at http://${SERVER_IP}:${PORT}" >&2
    echo "  To proxy it yourself, add a name-based vhost forwarding to 127.0.0.1:${PORT}." >&2
  fi
fi

# ============================================================================
# START OFFDOCK
# ============================================================================
echo ""
echo "=== Starting OffDock ==="
systemctl daemon-reload 2>/dev/null || true
if systemctl is-active --quiet "${BINARY_NAME}" 2>/dev/null; then
  systemctl restart "${BINARY_NAME}" 2>/dev/null || true
  echo "  OffDock restarted."
else
  systemctl start "${BINARY_NAME}" 2>/dev/null || true
  echo "  OffDock starting..."
fi

# Wait up to 15 s for the service to become active.
_started=false
for _i in $(seq 1 15); do
  sleep 1
  if systemctl is-active --quiet "${BINARY_NAME}" 2>/dev/null; then
    _started=true
    break
  fi
done

if [[ "$_started" == "true" ]]; then
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
