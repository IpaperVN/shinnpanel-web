#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# 03-verify.sh — kiểm tra toàn bộ hệ thống + in checklist còn thiếu.
# Chạy SAU 02-services.sh. Không đổi trạng thái gì (read-only).
# ═══════════════════════════════════════════════════════════════════════
set -uo pipefail

info()  { printf '\033[1;36m[03-verify]\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m   ✓\033[0m %s\n' "$*"; }
bad()   { printf '\033[1;31m   ✗\033[0m %s\n' "$*"; }
todo()  { printf '\033[1;33m   ▸ còn thiếu:\033[0m %s\n' "$*"; }

PASS=0; FAIL=0
check() { # name url [--code N]
  local name="$1" url="$2" code="${3:-200}"
  local got
  got="$(curl -sS -m 6 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || echo 000)"
  if [ "$got" = "$code" ]; then ok "$name → $got"; PASS=$((PASS+1));
  else bad "$name → $got (kỳ vọng $code)"; FAIL=$((FAIL+1)); fi
}

info "── 1. /health 3 service ──"
check "authbot"    "http://127.0.0.1:3001/health"
check "shinnpanel" "http://127.0.0.1:3000/health"
check "mcagent"    "http://127.0.0.1:3002/health"

info "── 2. /internal/* bị chặn khi thiếu key ──"
bad_ok() { # name url
  local got
  got="$(curl -sS -m 6 -o /dev/null -w '%{http_code}' "$2" 2>/dev/null || echo 000)"
  if [ "$got" != "200" ]; then ok "$1 → $got (bị chặn đúng)"; PASS=$((PASS+1));
  else bad "$1 → 200 (ĐÁNG NGẠI — thiếu key vẫn mở!)"; FAIL=$((FAIL+1)); fi
}
bad_ok "authbot /internal/channels thiếu key" "http://127.0.0.1:3001/internal/channels"
bad_ok "mcagent /internal/process thiếu key"   "http://127.0.0.1:3002/internal/process"

info "── 3. endpoint có key (lấy từ .env) ──"
IC="$(grep '^INTERNAL_KEY=' /opt/shinnpanel/etc/.env.panel | cut -d= -f2-)"
MCK="$(grep '^MC_AGENT_KEY=' /opt/shinnpanel/etc/.env.mcagent | cut -d= -f2-)"
if [ -n "${IC}" ] && curl -fsS -m 6 -H "X-Internal-Key: ${IC}" "http://127.0.0.1:3001/internal/health" >/dev/null 2>&1; then
  ok "authbot /internal/health (X-Internal-Key) OK"
else
  bad "authbot /internal/health (X-Internal-Key) — nếu bot chưa đọc INTERNAL_KEY thì đây là bình thường"
fi
if [ -n "${MCK}" ] && curl -fsS -m 6 -H "X-Mc-Agent-Key: ${MCK}" "http://127.0.0.1:3002/internal/process" >/dev/null 2>&1; then
  ok "mcagent /internal/process (X-Mc-Agent-Key) OK"
else
  bad "mcagent /internal/process (X-Mc-Agent-Key) — kiểm MC_AGENT_KEY trong .env.mcagent"
fi

info "── 4. web panel ──"
check "panel / (index)" "http://127.0.0.1:3000/" 200
check "panel /login"    "http://127.0.0.1:3000/login" 200
check "panel /api/me"   "http://127.0.0.1:3000/api/me" 401   # chưa login → 401 (kỳ vọng)
check "panel static /app.js" "http://127.0.0.1:3000/app.js" 200

info "── 5. tunnel public ──"
if command -v cloudflared >/dev/null 2>&1; then
  got="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "https://panel.ipapervn.site/health" 2>/dev/null || echo 000)"
  if [ "$got" = "200" ]; then ok "https://panel.ipapervn.site/health → 200 (tunnel hoạt động)";
  elif [ "$got" = "000" ]; then todo "từ máy này chưa ra được internet — thử từ điện thoại 4G";
  else bad "https://panel.ipapervn.site/health → $got — kiểm cloudflared.service + DNS"; fi
else
  todo "cloudflared chưa cài — chạy 00-tunnel.sh trước"
fi

info ""
info "──────────── KẾT QUẢ: ${PASS} ✓ / ${FAIL} ✗ ────────────"

info ""
info "──── checklist việc CÒN LÀM sau deploy ────"
todo "Cloudflare Access (Zero Trust): Deny mặc định / Allow email admin — chặn người lạ tại edge"
todo "WAF: bật Cloudflare Managed Rules cho panel.ipapervn.site"
todo "Xoá ingress :3001 khỏi tunnel cũ — giờ chỉ còn :3000"
todo "Plugin MC (ChunkBox/ESPaper) đổi URL sang http://127.0.0.1:3001 (loopback, cùng key)"
todo "Xoá BOT_TOKEN khỏi config.yml repo AuthBot — chuyển qua env (BOT_TOKEN trong .env.authbot)"
todo "Rotate Discord token: Developer Portal → Reset Token → cập nhật .env.authbot"
todo "ESPaper: điền espaper.url + espaper.token trong config.yml bot (tab ESPaper mới mở)"
todo "MC server first-run: tạo /opt/mc/server/run.sh + logs/ (xem README deploy)"
if [ "$FAIL" -gt 0 ]; then
  info "Có ${FAIL} lỗi — xem journalctl -u <svc> -n 50 để chẩn đoán"
  exit 1
fi
info "✅ HỆ THỐNG OK — còn lại là các việc 'còn thiếu' phía trên (tùy chọn/ngoài script)"
