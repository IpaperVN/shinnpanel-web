//go:build linux

package main

import (
	"os"

	"golang.org/x/term"
)

// readNoEcho reads one line of terminal input without echoing it back.
func readNoEcho() ([]byte, error) {
	fd := int(os.Stdin.Fd())
	if !term.IsTerminal(fd) {
		// Non-interactive (e.g. systemd, script): read a line plainly.
		var b []byte
		buf := make([]byte, 1)
		for {
			n, err := os.Stdin.Read(buf)
			if err != nil {
				return b, err
			}
			if n == 0 {
				continue
			}
			if buf[0] == '\n' {
				return b, nil
			}
			b = append(b, buf[0])
		}
	}
	return term.ReadPassword(fd)
}
