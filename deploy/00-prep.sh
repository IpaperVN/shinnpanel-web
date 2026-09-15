#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# 00-prep.sh — cài MỌI thứ cần thiết trước khi chạy các script khác.
# Chạy TRƯỚC 00-tunnel.sh.
#
# Máy Debian tối giản thường thiếu: sudo, curl, git, gnupg, openssl…
# QUAN TRỌNG: web + mcagent cần Go >= 1.26 (go.mod go 1.26.0) — apt của
# Debian chỉ có Go cũ, nên script tải Go mới nhất từ go.dev (không qua apt).
# Java: nếu chưa có sẽ cài openjdk-17-jre-headless (bot AuthBot cần 17+).
#
# CHẠY:  chạy trực tiếp bằng root (không cần sudo — sudo có thể chưa được cài):
#        su -   rồi   bash /opt/shinnpanel-deploy/00-prep.sh
# ═══════════════════════════════════════════════════════════════════════
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

info() { printf '\033[1;36m[00-prep]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[00-prep]\033[0m ✓ %s\n' "$*"; }
die()  { printf '\033[1;31m[00-prep]\033[0m ✗ %s\n' "$*" >&2; exit 1; }

# ── phải chạy root (sửa luôn trường hợp không CÓ sudo) ─────────────────
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    exec sudo bash "$0"
  fi
  die "phải chạy bằng root (su - rồi bash $0)"
fi

info "─ 1. apt update + cài base tools ─"
PKGS=(curl git ca-certificates gnupg openssl wget tar gzip coreutils findutils sudo systemd procps)
missing=()
for p in "${PKGS[@]}"; do
  dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p")
done
if [ "${#missing[@]}" -gt 0 ]; then
  apt-get update -qq
  apt-get install -y "${missing[@]}"
  ok "apt đã cài: ${missing[*]}"
else
  ok "base tools đã đủ"
fi

# ── 2. Go >= 1.26 (go.mod yêu cầu, apt quá cũ) ─────────────────────────
need_go=1
if command -v go >/dev/null 2>&1; then
  cur="$(go version | grep -oE 'go[0-9]+\.[0-9]+' | head -1 | tr -d go)"
  maj="${cur%%.*}"; min="${cur##*.}"
  if [ "$maj" -gt 1 ] || { [ "$maj" -eq 1 ] && [ "$min" -ge 26 ]; }; then
    need_go=0
    ok "Go $cur đã đủ (>= 1.26)"
  else
    warn_go="go $cur quá cũ — cần >= 1.26"
  fi
fi

if [ "$need_go" -eq 1 ] || [ ! -x /usr/local/go/bin/go ]; then
  NO_PROXY_DONE=0
  # lấy version stable mới nhất từ go.dev (không cần jq)
  latest="$(curl -fsSL https://go.dev/dl/?mode=json \
    | grep -oE '"version":"go[0-9.]+"' | head -1 | grep -oE 'go[0-9.]+' || true)"
  [ -n "${latest}" ] || latest="go1.26.5"      # fallback nếu không lấy được
  info "cài Go ${latest} → /usr/local/go (tải từ go.dev, không qua apt vì apt quá cũ)…"
  rm -rf /usr/local/go
  curl -fsSL "https://go.dev/dl/${latest}.linux-amd64.tar.gz" -o /tmp/go.tar.gz
  tar -C /usr/local -xzf /tmp/go.tar.gz
  rm -f /tmp/go.tar.gz
  # PATH dành cho shell sau này
  printf 'export PATH="/usr/local/go/bin:$PATH"\n' > /etc/profile.d/03-go.sh
  ok "${latest} đã cài — shell mở mới sẽ có sẵn; nếu đang ở shell cũ: export PATH=/usr/local/go/bin:\$PATH"
fi

# ── 3. Java (bot AuthBot cần 17+) ──────────────────────────────────────
if ! java -version 2>&1 | grep -qiE '17|18|19|2[0-9]'; then
  info "chưa thấy Java 17+ — cài openjdk-17-jre-headless…"
  apt-get install -y openjdk-17-jre-headless
  ok "Java đã cài"
else
  ok "Java: $(java -version 2>&1 | head -1)"
fi

# ── 4. Đảm bảo /opt/shinnpanel-deploy có sẵn (nơi bạn copy script) ─────
[ -d /opt/shinnpanel-deploy ] || install -d /opt/shinnpanel-deploy

info ""
ok "✅ XONG 00-prep. Bây giờ chạy theo thứ tự:"
info "   bash /opt/shinnpanel-deploy/00-tunnel.sh      (tunnel — cần COPY URL ra browser máy khác)"
info "   bash /opt/shinnpanel-deploy/01-provision.sh   (clone + secret + build AuthBot)"
info "   bash /opt/shinnpanel-deploy/02-services.sh    (build Go + services + user admin)"
info "   bash /opt/shinnpanel-deploy/03-verify.sh      (kiểm tra toàn bộ)"