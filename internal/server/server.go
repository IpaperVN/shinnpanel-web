// Package server wires the ShinnPanel HTTP handlers: static frontend,
// OAuth (Discord), /api/login (panel account + brute-force protection),
// and the /api/authbot/* + /api/mc/* proxies to the internal services.
package server

import (
	"io/fs"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/IpaperVN/shinnpanel/web/internal/config"
	"github.com/IpaperVN/shinnpanel/web/internal/oauth"
	"github.com/IpaperVN/shinnpanel/web/internal/panelusers"
	"github.com/IpaperVN/shinnpanel/web/internal/ratelimit"
	"github.com/IpaperVN/shinnpanel/web/internal/session"
	"github.com/IpaperVN/shinnpanel/web/web"
)

// Rate limits (login brute-force).
const (
	loginPerIP   = 5
	loginPerUser = 5
	loginWindow  = time.Minute
)

// Server owns every handler.
type Server struct {
	cfg          *config.Config
	log          *slog.Logger
	sess         *session.Manager
	oauth        *oauth.Handlers
	storage      panelusers.Store
	accounts     *accountLimiter
	cookieSecure bool
	botURL       string
	mcURL        string
}

// New builds the server. store may be nil only for tests that don't use login.
func New(cfg *config.Config, log *slog.Logger, store panelusers.Store) *Server {
	s := &Server{
		cfg:          cfg,
		log:          log,
		sess:         session.NewManager(cfg.SessionSecret),
		storage:      store,
		cookieSecure: cfg.Secure,
		accounts:     &accountLimiter{ip: ratelimit.New(), user: ratelimit.New()},
	}
	if cfg.BotURL != "" {
		s.oauth = oauth.New(oauth.Deps{
			ClientID:     cfg.OAuthClientID,
			ClientSecret: cfg.OAuthClientSecret,
			RedirectURI:  cfg.OAuthRedirectURI,
			BotPublicURL: cfg.BotURL,
			InternalKey:  cfg.InternalKey,
		})
	}
	s.botURL = cfg.BotURL
	s.mcURL = cfg.McURL
	return s
}

// Handler returns the root mux with all ShinnPanel routes.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// ── Login (public but rate-limited + lockout) ──
	mux.Handle("/api/login", s.requireCSRF(http.HandlerFunc(s.loginHandler)))

	// ── Session introspection ──
	mux.HandleFunc("/api/me", s.requireSessionOrPreauth(s.apiMe))

	// ── OAuth (preauth-gated) ──
	if s.oauth != nil {
		mux.HandleFunc("/oauth/login", s.requirePreauth(s.oauth.LoginHandler("", s.hasPreauth)))
		mux.HandleFunc("/oauth/callback", s.oauth.CallbackHandler("", s.setMcSession))
	}
	mux.HandleFunc("/oauth/logout", s.logoutHandler)

	// ── Proxies to internal services (CSRF + session) ──
	mux.Handle("/api/authbot/", s.requireSession(s.requireCSRF(http.HandlerFunc(s.proxyAuthBot)).ServeHTTP))
	mux.Handle("/api/mc/", s.requireSession(s.requireCSRF(http.HandlerFunc(s.proxyMc)).ServeHTTP))

	// ── Static frontend ──
	mux.Handle("/", s.securityHeaders(s.staticHandler()))

	// Security headers on every response.
	return s.securityHeaders(mux)
}

// hasPreauth reports whether the request carries a valid preauth cookie.
func (s *Server) hasPreauth(r *http.Request) bool {
	_, err := s.sess.FromRequest(r, session.PreauthCookie, "preauth")
	return err == nil
}

// requireSessionOrPreauth lets the login page know which step is active.
func (s *Server) requireSessionOrPreauth(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		h(w, r)
	}
}

// staticHandler serves the embedded frontend at /.
//   /        → index.html  (dashboard)
//   /login   → login.html  (CLI 2-step login)
//   anything else → static file from the embed, else index.html (SPA).
func (s *Server) staticHandler() http.Handler {
	fsys := web.FS()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		switch path {
		case "/":
			serveEmbed(w, r, fsys, "index.html")
			return
		case "/login":
			serveEmbed(w, r, fsys, "login.html")
			return
		}
		if path != "" && !strings.Contains(path, ".") {
			// SPA fallback: unknown route → dashboard shell
			serveEmbed(w, r, fsys, "index.html")
			return
		}
		http.FileServer(http.FS(fsys)).ServeHTTP(w, r)
	})
}

// serveEmbed writes one embedded file.
func serveEmbed(w http.ResponseWriter, r *http.Request, fsys fs.FS, name string) {
	b, err := fs.ReadFile(fsys, name)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(b)
}
