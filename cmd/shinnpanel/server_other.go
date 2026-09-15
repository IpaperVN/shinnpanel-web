//go:build !linux

package main

import "errors"

// runServer is the Windows dev fallback: the panel is designed for Debian.
// This keeps `go build ./...` working on a Windows checkout for tests, but
// the real server runs on Linux.
func runServer() error {
	return errors.New("shinnpanel server chỉ chạy trên Linux (Debian); dùng `shinnpanel user add` để quản lý tài khoản")
}