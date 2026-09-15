# ShinnPanel Deploy Scripts — dùng sau: `./00-prep.sh`

Bộ 5 file trong thư mục này, chạy **đúng thứ tự** từ máy Debian trống (đã cài Java hoặc chưa cũng được — `00-prep` tự lo):

```text
00-prep.sh       1. CÀI TRƯỚC: alphabetic, phải chạy này đầu (dù tên số nhỏ hơn)
00-tunnel.sh     2. tunnel Cloudflare (copy URL ra browser máy khác)
01-provision.sh  3. user + dirs + secrets + build AuthBot
02-services.sh   4. build Go + systemd units + tạo user admin
03-verify.sh     5. kiểm tra toàn bộ
```

---

## ⚠️ 00-prep — chạy TRƯỚC HẾT, vì các script sau dùng những lệnh này

Máy Debian tối giản gần như chắc chắn **thiếu** một số lệnh (`curl`, `git`, `gnupg`, `openssl`, `go`, `java`…). `00-prep.sh` cài tất cả:

| Cần cho | Quyết định |
|---|---|
| `curl git gnupg openssl wget tar gzip sudo systemd` | `apt-get install` (base) |
| **`go` ≥ 1.26** | **KHÔNG qua apt** (apt Debian chỉ có Go rất cũ) → tải **từ go.dev** (`go1.26.x.linux-amd64.tar.gz`) về `/usr/local/go` |
| **`java` 17+** | apt `openjdk-17-jre-headless` (bot AuthBot cần 17+) |

Chạy bằng root (sudo có thể chưa cài!):

```bash
su -     # đăng nhập root
bash /opt/shinnpanel-deploy/00-prep.sh
```

Script tự cài `sudo` nếu thiếu; các script sau sẽ tự gọi `sudo` khi cần.

---

## Tóm tắt các file

| Script | Nội dung |
|---|---|
| `00-prep.sh` | apt base tools + **Go từ go.dev** (≥1.26) + Java 17 + `sudo` |
| `00-tunnel.sh` | Cài cloudflared, `cloudflared tunnel login` — **in URL → copy ra browser máy Windows/điện thoại → authorize**; tạo tunnel `shinnpanel`, DNS `panel.ipapervn.site` → CNAME, ghi `~/.cloudflared/config.yml` (chỉ ingress `:3000`), enable `cloudflared.service` |
| `01-provision.sh` | User `shinnpanel`, thư mục `/opt/shinnpanel/`, clone 3 repo, sinh `.env.panel/.env.mcagent/.env.authbot` (secret openssl đủ 48 base64, không đè), build `authbot.jar` |
| `02-services.sh` | Build 2 Go binary → `/opt/shinnpanel/bin/`, ghi 3 systemd unit, enable + start, tạo user admin panel, verify `/health` |
| `03-verify.sh` | `/health` + `/internal/*` chặn khi thiếu key + web serve + tunnel + in checklist còn thiếu |

---

## Các chi tiết nhỏ phải nhớ (đã đọc code thật để chốt)

1. **Lệnh `cloudflared tunnel login` mở browser ở máy KHÁC** — Debian không có browser. Nó in URL, bạn dán sang Windows, authorize, lệnh SSH tự đề n.
2. **`MC_AGENT_KEY` giống nhau giữa web + mcagent** (cùng 1 secret), nhưng **khác `INTERNAL_KEY`** — web `config.go` chặn nếu trùng (`validate()`).
3. **`BOT_TOKEN` / `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET`**: các script hỏi bạn nhập lần đầu (không auto-sinh). Web từ chối khởi động nếu thiếu `OAUTH_*` hoặc `SESSION_SECRET` (`config.go` validate).
4. **AuthBot jar** build từ `./gradlew shadowJar` → `build/libs/authbot.jar` (Main-Class `MainKt`) — tốn RAM/băng thông, kiên nhẫn.
5. **MC server chạy `setsid` orphan re-parent về PID 1** — dừng web/agent KHÔNG dừng server MC (`mcagent/internal/process`).
6. **Chỉ tunnel outbound tới `:3000`** — bot :3001 + mcagent :3002 là loopback thuần, không mở port, không firewall rule.
7. **Có `/opt/shinnpanel-deploy/` làm nơi copy script** — chạy `bash <file>` từ đó.

---

## Lệnh chạy đầy đủ (sau khi copy toàn bộ thư mục này lên Debian)

```bash
sudo mkdir -p /opt/shinnpanel-deploy
sudo cp -r deploy/* /opt/shinnpanel-deploy/     # (hoặc đã copy rồi thì bỏ qua)
sudo chmod +x /opt/shinnpanel-deploy/*.sh
su -   # hoặc login root
bash /opt/shinnpanel-deploy/00-prep.sh          # [1] cài Go + Java + tools
bash /opt/shinnpanel-deploy/00-tunnel.sh        # [2] tunnel (copy URL ra ngoài)
bash /opt/shinnpanel-deploy/01-provision.sh     # [3] clone + secret + build bot
bash /opt/shinnpanel-deploy/02-services.sh      # [4] build Go + services + user admin
bash /opt/shinnpanel-deploy/03-verify.sh        # [5] verify + checklist
```

> Nếu bạn **đã cài Java** như đã nói, `00-prep` không cài lại. Nó chỉ thiếu gì mới cài đó.
>
> 🚨 Phải để `00-prep.sh` **ĐỨNG ĐẦU DANH SÁCH** — dù tên nó là `00-prep` (bé hơn `00-tunnel` về alphabet vì `p` < `t`). Các script khác KHÔNG tự cài Go/Java/tools cho bạn.