#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# 02-services.sh — build Go web + mcagent, cài systemd units, enable.
# Chạy SAU 01-provision.sh.
#
# Làm gì:
#   1. Build web → /opt/shinnpanel/bin/shinnpanel-web
#   2. Build mcagent → /opt/shinnpanel/bin/mcagent
#   3. Ghi 3 systemd unit (authbot / shinnpanel-web / shinnpanel-mcagent)
#   4. enable + start; tạo user panel admin nếu chưa có (tương tác)
#   5. Verify /health mỗi service
#
# Không build lại nếu binary đã mới hơn source (dùng --force để ép build).
# ═══════════════════════════════════════════════════════════════════════
set -euo pipefail

PANEL_DIR="/opt/shinnpanel"
REPOS_DIR="${PANEL_DIR}/repos"
BIN_DIR="${PANEL_DIR}/bin"
ETC_DIR="${PANEL_DIR}/etc"
DATA_DIR="${PANEL_DIR}/data"
AUTHBOT_DIR="${REPOS_DIR}/authbot"
WEB_SRC="${REPOS_DIR}/shinnpanel-web"
MC_SRC="${REPOS_DIR}/mcagent"
WEB_BIN="${BIN_DIR}/shinnpanel-web"
MC_BIN="${BIN_DIR}/mcagent"
JAR="${PANEL_DIR}/opt/authbot.jar"

info()  { printf '\033[1;36m[02-services]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[02-services]\033[0m ⚠ %s\n' "$*"; }
die()   { printf '\033[1;31m[02-services]\033[0m ✗ %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "chạy bằng root: sudo $0"
command -v go >/dev/null 2>&1 || die "thiếu Go — cài golang ≥ 1.22 trước, hoặc đặt binary sẵn vào ${BIN_DIR}/"
[ -f "${JAR}" ] || die "thiếu ${JAR} — 01-provision chưa build xong?"

FORCE="${1:-}"

# ── 1+2. build Go binary ───────────────────────────────────────────────
build_go() { # src out name
  local src="$1" out="$2" name="$3"
  local newest newest_src
  if [ -d "$src" ]; then
    newest_src="$(find "$src" -name '*.go' -type f -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)"
  fi
  newest="$out"
  if [ -n "${FORCE}" ] || [ ! -x "$out" ] || [ -z "$newest_src" ] || [ "$out" -ot "$newest_src" ]; then
    info "build $name…"
    ( cd "$src" && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o "$out" . )
    chmod 755 "$out"
  else
    info "$name: binary đã mới — bỏ qua (dùng 'sudo $0 --force' để build lại)"
  fi
}
build_go "${WEB_SRC}" "${WEB_BIN}" "shinnpanel-web"
build_go "${MC_SRC}"  "${MC_BIN}"  "mcagent"

# ── quyền cho các file/dir runtime ─────────────────────────────────────
chown -R shinnpanel:shinnpanel "${PANEL_DIR}" 2>/dev/null || true
# authbot cần ghi data/authbot.db trong thư mục repo
chown -R shinnpanel:shinnpanel "${AUTHBOT_DIR}" 2>/dev/null || true

# ── 3. systemd units (secret chỉ qua EnvironmentFile, unit không chứa secret) ──
gen_unit() { # name description envfile exec extra
  local unit="/etc/systemd/system/${1}.service" desc="$2" envf="$3" cmd="$4" extra="$5"
  cat > "${unit}" <<EOF
[Unit]
Description=${desc}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=shinnpanel
Group=shinnpanel
EnvironmentFile=${envf}
ExecStart=${cmd}
Restart=on-failure
RestartSec=5
${extra}
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
}

gen_unit "shinnpanel-authbot" "AuthBot Discord bot (loopback :3001)" \
  "${ETC_DIR}/.env.authbot" \
  "/usr/bin/java -Xmx512M -jar ${JAR}" \
  "WorkingDirectory=${AUTHBOT_DIR}\n"

gen_unit "shinnpanel-web" "ShinnPanel web (loopback :3000)" \
  "${ETC_DIR}/.env.panel" \
  "${WEB_BIN}" \
  "Environment=PANEL_USERS_DB=${DATA_DIR}/panel_users.db\n"

gen_unit "shinnpanel-mcagent" "MC agent (loopback :3002)" \
  "${ETC_DIR}/.env.mcagent" \
  "${MC_BIN}" \
  "Environment=MC_AGENT_SERVER_ROOT=/opt/mc/server\n"

# ── 4. enable + start ──────────────────────────────────────────────────
systemctl daemon-reload
for u in shinnpanel-authbot shinnpanel-web shinnpanel-mcagent; do
  systemctl enable "$u" >/dev/null 2>&1 || true
  systemctl restart "$u" || warn "$u start thất bại — journalctl -u $u -n 30"
done
sleep 2

# ── tạo user panel admin (chỉ khi DB chưa có) ───────────────────────────
if [ ! -f "${DATA_DIR}/panel_users.db" ]; then
  info "chưa có user panel — tạo tài khoản admin đầu tiên (mật khẩu ≥ 12 ký tự, hash bcrypt):"
  "${WEB_BIN}" user add admin || warn "không tạo được — chạy tay: ${WEB_BIN} user add <tên>"
else
  info "đã có ${DATA_DIR}/panel_users.db — bỏ qua tạo user"
fi

# ── 5. verify ──────────────────────────────────────────────────────────
info "── verify /health ──"
check() { # name url
  if curl -fsS -m 5 "$2" >/dev/null 2>&1; then info "✓ $1: $2 OK";
  else warn "✗ $1: $2 chưa phản hồi — journalctl -u $1 -n 30"; fi
}
check shinnpanel-authbot  "http://127.0.0.1:3001/health"
check shinnpanel-web      "http://127.0.0.1:3000/health"
check shinnpanel-mcagent  "http://127.0.0.1:3002/health"

info ""
info "✅ XONG 02-services. Bước cuối: bash ./03-verify.sh"