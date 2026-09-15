//go:build !linux

package main

import "os"

// readNoEcho reads one line from stdin. On non-Linux (dev on Windows) we
// cannot easily disable echo; simply read a plain line.
func readNoEcho() ([]byte, error) {
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