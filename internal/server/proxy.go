package server

import (
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/IpaperVN/shinnpanel/web/internal/session"
)

// securityHeaders adds the strict header set to every response (both pages
// and API). Applied at the outer layer so nothing can bypass it.
func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		// Self + Google Fonts (the login/dashboard use JetBrains Mono from
		// fonts.googleapis.com). No 'unsafe-inline' for scripts.
		h.Set("Content-Security-Policy",
			"default-src 'self'; "+
				"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "+
				"font-src https://fonts.gstatic.com; "+
				"script-src 'self'; "+
				"connect-src 'self'; "+
				"img-src 'self' data:; "+
				"base-uri 'none'; form-action 'self'")
		next.ServeHTTP(w, r)
	})
}

// requireCSRF rejects state-changing requests that don't carry the custom
// header (defence-in-depth; the browser cannot forge X-Requested-With from
// a cross-site form).
func (s *Server) requireCSRF(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions {
			if r.Header.Get("X-Requested-With") == "" {
				writeJSONError(w, http.StatusForbidden, "csrf_required")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// proxyAuthBot forwards /api/authbot/<rest> → BOT_INTERNAL_URL/internal/<rest>,
// adding X-Internal-Key and X-Acting-User. The acting user is taken from the
// session so the bot can attribute audit entries.
func (s *Server) proxyAuthBot(w http.ResponseWriter, r *http.Request) {
	if s.botURL == "" {
		writeJSONError(w, http.StatusServiceUnavailable, "authbot_unconfigured")
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/api/authbot")
	s.proxy(w, r, s.botURL, rest, s.cfg.InternalKey, "X-Internal-Key")
}

// proxyMc forwards /api/mc/<rest> → MC_AGENT_URL/internal/<rest> with the
// agent key. Acting user is passed too so the agent can log who acted.
func (s *Server) proxyMc(w http.ResponseWriter, r *http.Request) {
	if s.mcURL == "" {
		writeJSONError(w, http.StatusServiceUnavailable, "mc_unconfigured")
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/api/mc")
	s.proxy(w, r, s.mcURL, rest, s.cfg.McAgentKey, "X-Mc-Agent-Key")
}

// proxy performs the actual reverse proxy to base + path.
func (s *Server) proxy(w http.ResponseWriter, r *http.Request, base, path, secret, secretHeader string) {
	target := base + "/internal" + path
	u, err := url.Parse(target)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "proxy_target")
		return
	}
	// Keep the original query string (?path=, ?lines=, ?last=, …).
	if q := r.URL.RawQuery; q != "" {
		u.RawQuery = q
	}

	out := r.Clone(r.Context())
	out.URL = u
	out.RequestURI = ""
	out.Host = u.Host
	// Only forward the session identity, never client-side headers.
	out.Header.Del("Cookie")
	if d, err := s.sess.FromRequest(r, session.SessionCookie, "session"); err == nil {
		out.Header.Set("X-Acting-User", d.Username)
	}
	out.Header.Set(secretHeader, secret)
	out.Header.Set("X-Requested-With", "XMLHttpRequest")

	resp, err := http.DefaultTransport.RoundTrip(out)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "upstream_unreachable")
		return
	}
	defer resp.Body.Close()

	// Copy selected response headers.
	for _, k := range []string{"Content-Type", "Cache-Control", "X-Acting-User"} {
		if v := resp.Header.Get(k); v != "" {
			w.Header().Set(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	flushCopy(w, resp.Body)
}

// flushCopy streams the upstream body to the client, flushing after each chunk
// so SSE events (console stream) arrive live instead of being buffered.
func flushCopy(w http.ResponseWriter, body io.Reader) {
	fl, ok := w.(http.Flusher)
	if !ok {
		_, _ = io.Copy(w, body)
		return
	}
	buf := make([]byte, 32*1024)
	for {
		n, rerr := body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			fl.Flush()
		}
		if rerr == io.EOF {
			return
		}
		if rerr != nil {
			return
		}
	}
}
