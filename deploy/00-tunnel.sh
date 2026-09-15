#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# 00-tunnel.sh — Cloudflare Tunnel cho ShinnPanel.
# Chạy TRƯỚC khi có bất kỳ service nào. Tương tác ở bước login.
#
# Làm gì:
#   1. Cài cloudflared (repo chính thức của Cloudflare)
#   2. cloudflared tunnel login  → in URL, mở ở browser máy khác (không cần browser Debian)
#      (Nếu máy Debian là VPS không có TTY đẹp: dùng API token tạo cert.pem — xem README)
#   3. cloudflared tunnel create shinnpanel
#   4. route DNS: panel.ipapervn.site → <TUNNEL-ID>.cfargotunnel.com
#   5. Ghi ~/.cloudflared/config.yml (chỉ ingress :3000 — KHÔNG :3001)
#   6. systemd: cloudflared.service (chạy lại cùng boot)
#
# Idempotent: bỏ qua bước đã làm. KHÔNG xoá tunnel cũ nếu đã tồn tại.
# ═══════════════════════════════════════════════════════════════════════
set -euo pipefail

DOMAIN="panel.ipapervn.site"
TUNNEL_NAME="shinnpanel"
BACKEND="http://127.0.0.1:3000"     # web panel — service duy nhất ra ngoài
CFD_DIR="${HOME}/.cloudflared"
CONFIG="${CFD_DIR}/config.yml"

info()  { printf '\033[1;36m[00-tunnel]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[00-tunnel]\033[0m ⚠ %s\n' "$*"; }
die()   { printf '\033[1;31m[00-tunnel]\033[0m ✗ %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "chạy bằng root: sudo $0"

# ── 1. Cài cloudflared ────────────────────────────────────────────────
if ! command -v cloudflared >/dev/null 2>&1; then
  info "cài cloudflared (repo Cloudflare)…"
  apt-get update -qq
  install -d /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
    -o /usr/share/keyrings/cloudflare-main.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
    > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -qq
  apt-get install -y cloudflared
else
  info "cloudflared đã cài: $(cloudflared --version | head -1)"
fi

# ── 2. Login (một lần duy nhất) ─────────────────────────────────────────
mkdir -p "${CFD_DIR}"
if [ ! -f "${CFD_DIR}/cert.pem" ]; then
  if [ ! -t 0 ]; then
    die "đang chạy không phải TTY — 'cloudflared tunnel login' cần tương tác.
         Hãy mở terminal SSH bình thường rồi chạy lại."
  fi
  info "──────────────────────────────────────────────────────────────"
  info " KHÔNG cần browser trên máy Debian này."
  info " Lệnh bên dưới sẽ in ra một URL  ->  COPY URL đó."
  info " Mở URL đó ở BROWSER CỦA MÁY WINDOWS (hoặc điện thoại),"
  info " đăng nhập Cloudflare, chọn zone ipapervn.site rồi Authorize."
  info " Lệnh sẽ TỰ ĐỀN xong khi authorize — không cần chạm lại SSH."
  info " Thu hạn: phải bấm trong ~10 phút, không thì chạy lại."
  info "──────────────────────────────────────────────────────────────"
  timeout 600 cloudflared tunnel login || {
    warn "login thất bại/hết giờ. Chạy lại 'sudo ./00-tunnel.sh' và nhớ mở URL trong 10 phút."
    warn "Cách khác (không cần login lần đầu): tạo cert.pem bằng API token — xem README."
    die "cloudflared tunnel login chưa hoàn tất."
  }
fi
[ -f "${CFD_DIR}/cert.pem" ] || die "thiếu ${CFD_DIR}/cert.pem — tunnel login chưa hoàn tất"

# ── 3. Tạo tunnel (nếu chưa có) ───────────────────────────────────────
TUNNEL_ID=""
if [ -f "${CONFIG}" ] && grep -q "^tunnel:" "${CONFIG}"; then
  TUNNEL_ID="$(awk '/^tunnel:/{print $2; exit}' "${CONFIG}")"
fi
if [ -z "${TUNNEL_ID}" ]; then
  if [ -f "${CFD_DIR}/credentials.json" ] || ls "${CFD_DIR}"/shinnpanel-*.json >/dev/null 2>&1; then
    TUNNEL_ID="$(ls "${CFD_DIR}"/shinnpanel-*.json 2>/dev/null | head -1 | xargs -r basename | sed 's/\.json$//')"
  fi
fi
if [ -z "${TUNNEL_ID}" ]; then
  info "tạo tunnel '${TUNNEL_NAME}'…"
  out="$(cloudflared tunnel create "${TUNNEL_NAME}" 2>&1)"
  echo "$out"
  TUNNEL_ID="$(echo "$out" | grep -oE '[0-9a-f]{8}-[0-9a-f-]{27}' | head -1 || true)"
  [ -n "${TUNNEL_ID}" ] || die "không tìm thấy TUNNEL_ID trong output của tunnel create"
  info "TUNNEL_ID = ${TUNNEL_ID}"
else
  info "dùng tunnel đã có: ${TUNNEL_ID}"
fi

# ── 4. DNS route ───────────────────────────────────────────────────────
if ! cloudflared tunnel route dns "${TUNNEL_ID}" "${DOMAIN}" 2>/dev/null; then
  warn "route dns đã tồn tại hoặc thất bại — kiểm tra Cloudflare dashboard: ${DOMAIN} → CNAME"
else
  info "DNS route: ${DOMAIN} → ${TUNNEL_ID}.cfargotunnel.com"
fi

# ── 5. config.yml (chỉ :3000) ──────────────────────────────────────────
if [ ! -f "${CONFIG}" ]; then
  cat > "${CONFIG}" <<EOF
tunnel: ${TUNNEL_ID}
credentials-file: ${CFD_DIR}/${TUNNEL_ID}.json

ingress:
  - hostname: ${DOMAIN}
    service: ${BACKEND}
  - service: http_status:404
EOF
  info "đã ghi ${CONFIG} (chỉ ingress :3000 — bot/mcagent không lộ ra ngoài)"
else
  info "giữ nguyên ${CONFIG} hiện có"
fi

# ── 6. systemd ─────────────────────────────────────────────────────────
UNIT="/etc/systemd/system/cloudflared.service"
if [ ! -f "${UNIT}" ]; then
  cat > "${UNIT}" <<EOF
[Unit]
Description=Cloudflare Tunnel (ShinnPanel)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
ExecStart=/usr/local/bin/cloudflared tunnel run ${TUNNEL_ID}
Restart=on-failure
RestartSec=5
# chạy ra ngoài chỉ 1 cổng :3000 — không mở port nào khác
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=${CFD_DIR}

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  info "đã tạo ${UNIT}"
else
  info "giữ nguyên ${UNIT}"
fi

systemctl enable cloudflared.service >/dev/null 2>&1 || true
systemctl restart cloudflared.service

sleep 3
info "── kiểm tra tunnel (từ máy này + từ ngoài) ──"
info "curl http://127.0.0.1:3000/health → (panel chưa chạy thì vẫn 502/refuse, là bình thường)"
info "curl https://${DOMAIN}/health   → phải thấy panel (sau bước 02-services.sh)"

info "✅ XONG 00-tunnel. Bước tiếp theo: sudo ./01-provision.sh"
