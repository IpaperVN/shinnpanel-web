// Command shinnpanel runs the ShinnPanel web server (Phase 2):
// panel login (CLI 2-step) + OAuth + /api/mc + /api/authbot proxies,
// bound to 127.0.0.1:3000. Production runs it behind a Cloudflare tunnel.
//
// Subcommands:
//
//	shinnpanel             run the web server (default)
//	shinnpanel user add    create (or reset) the panel admin password
package main

import (
	"errors"
	"fmt"
	"os"

	"github.com/IpaperVN/shinnpanel/web/internal/config"
	"github.com/IpaperVN/shinnpanel/web/internal/panelusers"
)

func main() {
	args := os.Args[1:]
	if len(args) > 0 && args[0] == "user" {
		if err := runUserCmd(args[1:]); err != nil {
			fmt.Fprintln(os.Stderr, "✗", err)
			os.Exit(1)
		}
		return
	}
	if len(args) > 0 && (args[0] == "-h" || args[0] == "--help" || args[0] == "help") {
		usage()
		return
	}
	if err := runServer(); err != nil {
		fmt.Fprintln(os.Stderr, "✗", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Print(`ShinnPanel — panel điều khiển Minecraft server + AuthBot.

Cách dùng:
  shinnpanel                  chạy web server (127.0.0.1:3000)
  shinnpanel user add <name>  tạo/kích hoạt tài khoản panel (hỏi mật khẩu)

Env bắt buộc (xem internal/config/config.go):
  SESSION_SECRET, INTERNAL_KEY, MC_AGENT_KEY, OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET
`)
}

// runUserCmd handles `shinnpanel user add <username>`.
func runUserCmd(args []string) error {
	if len(args) != 2 || args[0] != "add" {
		return errors.New("cách dùng: shinnpanel user add <tên-tài-khoản>")
	}
	username := panelusers.CleanupUsername(args[1])
	if username == "" {
		return errors.New("tên tài khoản không hợp lệ (trống)")
	}
	pw1, err := readSecret("Mật khẩu mới (tối thiểu 12 ký tự): ")
	if err != nil {
		return err
	}
	if len(pw1) < panelusers.MinPasswordLen {
		return fmt.Errorf("mật khẩu phải >= %d ký tự", panelusers.MinPasswordLen)
	}
	pw2, err := readSecret("Nhập lại mật khẩu: ")
	if err != nil {
		return err
	}
	if pw1 != pw2 {
		return errors.New("hai lần nhập không khớp")
	}

	// Load config to find the DB path (env or the default).
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	store, err := panelusers.Open(cfg.PanelUsersDB)
	if err != nil {
		return fmt.Errorf("mở db: %w", err)
	}
	defer store.Close()

	hash, err := panelusers.HashPassword(pw1)
	if err != nil {
		return fmt.Errorf("hash: %w", err)
	}
	created, err := store.EnsureUser(username, hash)
	if err != nil {
		return fmt.Errorf("lưu user: %w", err)
	}
	if created {
		fmt.Printf("✓ Tạo tài khoản %q (admin đầu tiên)\n", username)
	} else {
		fmt.Printf("✓ Cập nhật mật khẩu cho %q\n", username)
	}
	return nil
}

// readSecret reads one line from the terminal without echoing.
func readSecret(prompt string) (string, error) {
	fmt.Fprint(os.Stderr, prompt)
	b, err := readNoEcho()
	fmt.Fprintln(os.Stderr)
	if err != nil {
		return "", err
	}
	return string(b), nil
}