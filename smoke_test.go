//go:build smoke

// Smoke test for the Phase-3 frontend + Phase-2 auth stack.
// Run: go test -tags smoke ./ -run TestPhase3FrontendServe -v
package smoke

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/IpaperVN/shinnpanel/web/internal/config"
	"github.com/IpaperVN/shinnpanel/web/internal/panelusers"
	"github.com/IpaperVN/shinnpanel/web/internal/server"
	"github.com/IpaperVN/shinnpanel/web/internal/session"
)

func TestPhase3FrontendServe(t *testing.T) {
	dbPath := filepath.Join(filepath.Dir(os.Args[0]), "smoke_users.db")
	store, err := panelusers.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	defer os.Remove(dbPath)

	s := server.New(smokeCfg(), nil, store)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	jar, _ := cookiejar.New(nil)
	cl := &http.Client{Jar: jar}

	// ── login ──
	hash, _ := panelusers.HashPassword("correct-horse-battery-staple")
	if _, err := store.EnsureUser("admin", hash); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]string{"username": "admin", "password": "correct-horse-battery-staple"})
	req, _ := http.NewRequest("POST", ts.URL+"/api/login", bytes.NewReader(body))
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	resp, err := cl.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("login: %d", resp.StatusCode)
	}
	resp.Body.Close()

	// ── static frontend files are embedded + served ──
	for _, p := range []string{"/", "/login", "/style.css", "/authbot.css", "/api.js", "/util.js", "/app.js", "/editor.js"} {
		r, _ := http.NewRequest("GET", ts.URL+p, nil)
		rr, err := cl.Do(r)
		if err != nil {
			t.Fatalf("%s: %v", p, err)
		}
		data, _ := io.ReadAll(rr.Body)
		rr.Body.Close()
		if rr.StatusCode != 200 {
			t.Fatalf("%s: %d", p, rr.StatusCode)
		}
		if len(data) == 0 {
			t.Fatalf("%s: empty body", p)
		}
		if rr.Header.Get("Content-Security-Policy") == "" {
			t.Fatalf("%s: missing CSP header", p)
		}
		t.Logf("%s → %d (%d B) %s", p, rr.StatusCode, len(data), rr.Header.Get("Content-Type"))
	}

	// inline code must not violate CSP: check index.html has no inline onclick
	idx, _ := http.Get(ts.URL + "/")
	if idx != nil {
		idx.Body.Close()
	}

	// ── /api/mc requires session + CSRF; agent down → 502 ──
	// The login only issues a PREAUTH cookie; mint a real session for the
	// session+CSRF gate checks.
	sm := session.NewManager(smokeCfg().SessionSecret)
	sessVal, _ := sm.Encode(session.Data{Username: "admin", Kind: "session", IssuedAt: time.Now().Unix()})
	u, _ := url.Parse(ts.URL)
	jar.SetCookies(u, []*http.Cookie{{Name: session.SessionCookie, Value: sessVal, Path: "/", HttpOnly: true, Secure: true, SameSite: http.SameSiteLaxMode}})

	r, _ := http.NewRequest("POST", ts.URL+"/api/mc/process/start", nil)
	rr, _ := cl.Do(r)
	if rr.StatusCode != 403 {
		t.Fatalf("POST /api/mc without CSRF: %d", rr.StatusCode)
	}
	rr.Body.Close()

	r2, _ := http.NewRequest("GET", ts.URL+"/api/mc/process", nil)
	r2.Header.Set("X-Requested-With", "XMLHttpRequest")
	rr2, err := cl.Do(r2)
	if err != nil {
		t.Fatalf("/api/mc/process: %v", err)
	}
	rr2.Body.Close()
	if rr2.StatusCode != 502 {
		t.Fatalf("GET /api/mc/process (agent down): %d", rr2.StatusCode)
	}

	// ── fresh client (no session) → 401 ──
	freshJar, _ := cookiejar.New(nil)
	fresh := &http.Client{Jar: freshJar}
	r3, _ := http.NewRequest("GET", ts.URL+"/api/mc/process", nil)
	r3.Header.Set("X-Requested-With", "XMLHttpRequest")
	rr3, _ := fresh.Do(r3)
	if rr3.StatusCode != 401 {
		t.Fatalf("unauth /api/mc: %d", rr3.StatusCode)
	}
	var e map[string]string
	_ = json.NewDecoder(rr3.Body).Decode(&e)
	rr3.Body.Close()
	if e["error"] != "not_authenticated" {
		t.Fatalf("unauth error: %q", e["error"])
	}

	// ── inline CSP check (script-src must block inline onclick in raw HTML) ──
	rawIdx, _ := os.ReadFile("web/index.html")
	if bytes.Contains(rawIdx, []byte("onclick=")) {
		t.Fatalf("web/index.html contains inline onclick (violates script-src 'self')")
	}

	t.Log("OK: static served, CSP present, CSRF/session enforced, agent-down → 502")
}

func smokeCfg() *config.Config {
	return &config.Config{
		Listen:            "127.0.0.1:0",
		Secure:            true,
		PanelUsersDB:      "smoke_users.db",
		BotURL:            "http://127.0.0.1:3001",
		InternalKey:       "internal-secret-0123456789abcdefghijklmnopqrstuvwxyz",
		McURL:             "http://127.0.0.1:3002",
		McAgentKey:        "mcagent-secret-0123456789abcdefghijklmnopqrstuvwxyz",
		OAuthClientID:     "clientid",
		OAuthClientSecret: "clientsecret",
		OAuthRedirectURI:  "http://x/oauth/callback",
		SessionSecret:     "session-secret-0123456789abcdefghijklmnopqrstuvwxyz",
	}
}
