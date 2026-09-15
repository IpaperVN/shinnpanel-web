package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/IpaperVN/shinnpanel/web/internal/panelusers"
	"github.com/IpaperVN/shinnpanel/web/internal/session"
)

// LoginHandler serves POST /api/login (public, rate-limited + lockout).
func (s *Server) loginHandler(w http.ResponseWriter, r *http.Request) {
	// rate limit per IP: 5 attempts/min
	if !s.accounts.AllowLoginIP(remoteIP(r)) {
		writeJSONError(w, http.StatusTooManyRequests, "too_many_attempts")
		return
	}

	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeJSONError(w, http.StatusBadRequest, "bad_json")
		return
	}
	username := panelusers.CleanupUsername(body.Username)
	if username == "" || body.Password == "" {
		writeJSONError(w, http.StatusBadRequest, "missing_fields")
		return
	}
	// Play nice with frontend typing: require not-too-short pw
	if len(body.Password) < panelusers.MinPasswordLen {
		writeJSONError(w, http.StatusUnprocessableEntity, "password_too_short")
		return
	}

	if !s.accounts.AllowLoginUser(username) {
		writeJSONError(w, http.StatusTooManyRequests, "too_many_attempts")
		return
	}

	u, err := s.storage.GetByUsername(username)
	if err != nil {
		s.logError("login db", err)
		writeJSONError(w, http.StatusInternalServerError, "db_error")
		return
	}

	// Locked or not, the response must not hint which usernames exist, but a
	// locked account is reported as locked (423) so the UI can show a countdown.
	if u != nil && !u.LockedUntil.IsZero() && u.LockedUntil.After(time.Now()) {
		retry := time.Until(u.LockedUntil)
		w.Header().Set("X-RateLimit-Reset", fmt.Sprintf("%d", time.Now().Add(retry).Unix()))
		writeJSONError(w, http.StatusLocked, "account_locked")
		return
	}

	// Uniform response for "no such user" vs "wrong password".
	if u == nil || !panelusers.CheckPassword(u.PasswordHash, body.Password) {
		if u != nil {
			// 5th consecutive failure locks the account; surface it as 423 so
			// the login page can start the countdown immediately.
			if err := s.storage.RecordFailure(u); err == nil &&
				!u.LockedUntil.IsZero() && u.LockedUntil.After(time.Now()) {
				w.Header().Set("X-RateLimit-Reset", fmt.Sprintf("%d", u.LockedUntil.Unix()))
				writeJSONError(w, http.StatusLocked, "account_locked")
				return
			}
		}
		writeJSONError(w, http.StatusUnauthorized, "invalid_credentials")
		return
	}

	// success: reset counter, set preauth cookie
	_ = s.storage.SetFailed(u, 0)
	session.SetCookie(w, session.PreauthCookie, mustEncode(s.sess, session.Data{
		Username: u.Username, Kind: "preauth", IssuedAt: time.Now().Unix(),
	}), "preauth", s.cookieSecure)

	writeJSON(w, map[string]any{"ok": true, "username": u.Username})
}

// setMcSession drops the long-lived session cookie after OAuth.
func (s *Server) setMcSession(w http.ResponseWriter, _, username string, _ []string) {
	val := mustEncode(s.sess, session.Data{
		Username: username, Kind: "session", IssuedAt: time.Now().Unix(),
	})
	session.SetCookie(w, session.SessionCookie, val, "session", s.cookieSecure)
	session.ClearCookie(w, session.PreauthCookie) // consume the one-time step1 proof
}

func (s *Server) logoutHandler(w http.ResponseWriter, r *http.Request) {
	session.ClearCookie(w, session.SessionCookie)
	session.ClearCookie(w, session.PreauthCookie)
	http.Redirect(w, r, "/", http.StatusFound)
}

// requirePreauth guards OAuth login: SHINNPANEL_PREAUTH must be valid.
func (s *Server) requirePreauth(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.hasPreauth(r) {
			http.Redirect(w, r, "/login", http.StatusFound)
			return
		}
		h(w, r)
	}
}

// requireSession guards the dashboard API.
func (s *Server) requireSession(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, err := s.sess.FromRequest(r, session.SessionCookie, "session"); err != nil {
			writeJSONError(w, http.StatusUnauthorized, "not_authenticated")
			return
		}
		h(w, r)
	}
}

// apiMe answers /api/me from the session cookie (doubles as preauth check).
func (s *Server) apiMe(w http.ResponseWriter, r *http.Request) {
	// Prefer the full session; fall back to preauth so the login page can
	// show "step 1 ok" — the dashboard gates on the session anyway.
	d, err := s.sess.FromRequest(r, session.SessionCookie, "session")
	if err == nil {
		writeJSON(w, map[string]any{"username": d.Username, "authenticated": true, "step": 2})
		return
	}
	pd, err := s.sess.FromRequest(r, session.PreauthCookie, "preauth")
	if err == nil {
		writeJSON(w, map[string]any{"username": pd.Username, "authenticated": false, "step": 1})
		return
	}
	writeJSONError(w, http.StatusUnauthorized, "not_logged_in")
}

// remoteIP prefers CF-Connecting-IP (set by Cloudflare tunnel) over
// X-Forwarded-For, so a direct attacker can't spoof a free pass.
func remoteIP(r *http.Request) string {
	if cf := r.Header.Get("CF-Connecting-IP"); cf != "" {
		return strings.TrimSpace(cf)
	}
	if xf := r.Header.Get("X-Forwarded-For"); xf != "" {
		if i := strings.IndexByte(xf, ','); i >= 0 {
			return strings.TrimSpace(xf[:i])
		}
		return strings.TrimSpace(xf)
	}
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return ip
}

func decodeJSON(r *http.Request, v any) error {
	defer r.Body.Close()
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		return err
	}
	return json.Unmarshal(body, v)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func writeJSONError(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": code})
}

func mustEncode(m *session.Manager, d session.Data) string {
	v, err := m.Encode(d)
	if err != nil {
		panic("session encode: " + err.Error())
	}
	return v
}

// accountLimiter groups the two brute-force limiters.
type accountLimiter struct {
	ip   loginLimiter
	user loginLimiter
}

// AllowLoginIP rate-limits login attempts per source IP.
func (a *accountLimiter) AllowLoginIP(ip string) bool {
	return a.ip.Allow(ip, loginPerIP, loginWindow)
}

// AllowLoginUser rate-limits login attempts per username.
func (a *accountLimiter) AllowLoginUser(username string) bool {
	return a.user.Allow(username, loginPerUser, loginWindow)
}

type loginLimiter interface {
	Allow(key string, max int, window time.Duration) bool
}

func (s *Server) logError(msg string, err error) {
	if s.log != nil {
		s.log.Error(msg, "err", err.Error())
	}
}