// Package web embeds the ShinnPanel static frontend. The Phase-2 build ships a
// minimal working login (CLI 2-step flow) + a placeholder dashboard so the
// server can serve the real API contract end-to-end. Phase 3 replaces the
// placeholder with the ported dashboard (port of shinnpanel-ui/index.html).
package web

import (
	"embed"
	"io/fs"
)

//go:embed login.html index.html style.css authbot.css api.js util.js app.js editor.js
var content embed.FS

// FS returns the static filesystem served at /.
func FS() fs.FS {
	sub, err := fs.Sub(content, ".")
	if err != nil {
		// embed: paths are built into the binary; this cannot fail
		panic("web: " + err.Error())
	}
	return sub
}