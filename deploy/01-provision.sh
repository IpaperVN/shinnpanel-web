#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# 01-provision.sh — user, thư mục, secrets (.env) + build AuthBot.
# Chạy SAU 00-tunnel.sh.
#
# Làm gì:
#   1. Tạo user hệ thống `shinnpanel` (chạy web + mcagent + authbot)
#   2. Tạo /opt/shinnpanel/{bin,etc,data,logs,repos,opt}
#   3. Clone 3 repo từ GitHub → /opt/shinnpanel/repos/
#      (shinnpanel-web, mcagent, authbot)
#   4. Sinh /opt/shinnpanel/etc/.env.{panel,mcagent,authbot} — secret bằng
#      openssl rand (≥32 ký tự), KHÔNG đè file đã tồn tại.
#      OAUTH_CLIENT_ID/SECRET được hỏi nếu chưa có (web bắt buộc).
#   5. Cài JDK 17 nếu thiếu (authbot cần Java 17+)
#   6. Build authbot.jar (./gradlew shadowJar) → /opt/shinnpanel/opt/authbot.jar
#
# Không ghi BOT_TOKEN vào config.yml — bot đọc qua env BOT_TOKEN.
# ═══════════════════════════════════════════════════════════════════════
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

PANEL_DIR="/opt/shinnpanel"
REPOS_DIR="${PANEL_DIR}/repos"
ETC_DIR="${PANEL_DIR}/etc"
BIN_DIR="${PANEL_DIR}/bin"
DATA_DIR="${PANEL_DIR}/data"
LOG_DIR="${PANEL_DIR}/logs"
OPT_DIR="${PANEL_DIR}/opt"
AUTHBOT_DIR="${REPOS_DIR}/authbot"
DISCORD_REDIRECT="https://panel.ipapervn.site/oauth/callback"

# ── Đặt đúng URL repo thật (đổi nếu cần) ───────────────────────────────
WEB_REPO="https://github.com/IpaperVN/shinnpanel.git"
MCAGENT_REPO="https://github.com/IpaperVN/shinnpanel-mcagent.git"
AUTHBOT_REPO="https://github.com/IpaperVN/AuthBot.git"

info()  { printf '\033[1;36m[01-provision]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[01-provision]\033[0m ⚠ %s\n' "$*"; }
die()   { printf '\033[1;31m[01-provision]\033[0m ✗ %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "chạy bằng root: sudo $0"

# ── 1. user hệ thống ───────────────────────────────────────────────────
if ! id -u shinnpanel >/dev/null 2>&1; then
  useradd -r -m -d /var/lib/shinnpanel -s /usr/sbin/nologin shinnpanel
  info "đã tạo user hệ thống 'shinnpanel' (no-login)"
fi

# ── 2. thư mục ─────────────────────────────────────────────────────────
install -d -o shinnpanel -g shinnpanel \
  "${BIN_DIR}" "${DATA_DIR}" "${LOG_DIR}" "${ETC_DIR}" "${REPOS_DIR}" "${OPT_DIR}"

# ── 3. clone repos ─────────────────────────────────────────────────────
clone() { # name url dir
  if [ -d "$3/.git" ]; then
    info "$1: repo đã có — pull mới nhất"
    git -C "$3" pull --ff-only 2>/dev/null | tail -1 || true
  else
    info "$1: clone từ $2"
    git clone --depth 1 "$2" "$3"
  fi
}
clone "shinnpanel-web"  "${WEB_REPO}"       "${REPOS_DIR}/shinnpanel-web"
clone "mcagent"         "${MCAGENT_REPO}"   "${REPOS_DIR}/mcagent"
clone "authbot"         "${AUTHBOT_REPO}"   "${AUTHBOT_DIR}"

# ── 4a. helper sinh secret ─────────────────────────────────────────────
get_val() { # file var  → in ra giá trị (rỗng nếu chưa có)
  [ -f "$1" ] && grep "^${2}=" "$1" 2>/dev/null | head -1 | cut -d= -f2- || true
}
set_val() { # file var value (không ghi đè nếu đã tồn tại)
  if [ -z "$(get_val "$1" "$2")" ]; then
    printf '%s=%s\n' "$2" "$3" >> "$1"
    chmod 600 "$1"
  fi
}
gen_secret() { # file var  (openssl rand 48 base64)
  local v; v="$(openssl rand -base64 48 | tr -d '\n')"
  set_val "$1" "$2" "$v"
}
prompt_val() { # file var label default  ← hỏi nếu chưa có
  local cur; cur="$(get_val "$1" "$2")"
  if [ -z "$cur" ] && [ -t 0 ]; then
    printf '\033[1;36m[01-provision]\033[0m %s [%s]: ' "$3" "$4"
    read -r v
    v="${v:-$4}"
    set_val "$1" "$2" "$v"
  elif [ -z "$cur" ]; then
    warn "$2 chưa có và không ở TTY — bỏ qua. Web sẽ từ chối khởi động cho đến khi đặt."
    set_val "$1" "$2" "$4"
  fi
}

# ── 4b. .env.panel ─────────────────────────────────────────────────────
ENV_PANEL="${ETC_DIR}/.env.panel"
touch "${ENV_PANEL}"; chmod 600 "${ENV_PANEL}"
gen_secret "${ENV_PANEL}" "SESSION_SECRET"
gen_secret "${ENV_PANEL}" "INTERNAL_KEY"
gen_secret "${ENV_PANEL}" "MC_AGENT_KEY"
set_val "${ENV_PANEL}" "OAUTH_REDIRECT_URI" "${DISCORD_REDIRECT}"
prompt_val "${ENV_PANEL}" "OAUTH_CLIENT_ID"     "Discord OAuth Client ID"     ""
prompt_val "${ENV_PANEL}" "OAUTH_CLIENT_SECRET" "Discord OAuth Client Secret" ""

# ── 4c. .env.mcagent ───────────────────────────────────────────────────
ENV_MC="${ETC_DIR}/.env.mcagent"
touch "${ENV_MC}"; chmod 600 "${ENV_MC}"
# MC_AGENT_KEY GIỐNG giữa web + mcagent (cùng secret), khác INTERNAL_KEY.
set_val "${ENV_MC}" "MC_AGENT_KEY" "$(get_val "${ENV_PANEL}" "MC_AGENT_KEY")"

# ── 4d. .env.authbot ───────────────────────────────────────────────────
ENV_AUTH="${ETC_DIR}/.env.authbot"
touch "${ENV_AUTH}"; chmod 600 "${ENV_AUTH}"
set_val "${ENV_AUTH}" "BOT_TOKEN"        "$(get_val "${ENV_AUTH}" "BOT_TOKEN")"       # giữ y như có
prompt_val "${ENV_AUTH}" "BOT_TOKEN"     "Discord Bot Token (từ Developer Portal)"   ""
if [ -z "$(get_val "${ENV_AUTH}" "BOT_TOKEN")" ]; then
  warn "BOT_TOKEN chưa có — bot sẽ không lên Discord. Thêm vào ${ENV_AUTH} rồi restart."
fi
set_val "${ENV_AUTH}" "INTERNAL_KEY"     "$(get_val "${ENV_PANEL}" "INTERNAL_KEY")"
set_val "${ENV_AUTH}" "HTTP_INTERNAL_PORT" "3001"

# ── 5. Java (authbot cần 17+) ──────────────────────────────────────────
if ! java -version 2>&1 | grep -qiE '17|18|19|2[0-9]'; then
  info "cài OpenJDK 17 headless…"
  apt-get install -y openjdk-17-jre-headless
else
  info "đã có Java: $(java -version 2>&1 | head -1)"
fi

# ── 6. Build authbot.jar ───────────────────────────────────────────────
if [ -f "${OPT_DIR}/authbot.jar" ]; then
  info "authbot.jar đã có — bỏ qua build"
else
  info "build AuthBot (gradlew shadowJar → build/libs/authbot.jar)…"
  ( cd "${AUTHBOT_DIR}" && ./gradlew shadowJar --console=plain )
  install -o shinnpanel -g shinnpanel "${AUTHBOT_DIR}/build/libs/authbot.jar" "${OPT_DIR}/authbot.jar"
  chmod 644 "${OPT_DIR}/authbot.jar"
fi

info ""
info "✅ XONG 01-provision. Secret/setting trong:"
echo "   ${ENV_PANEL}   ${ENV_MC}   ${ENV_AUTH}"
info ""
info "Bước tiếp: sudo ./02-services.sh  (build Go + enable services + tạo user panel)"