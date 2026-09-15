// Package oauth implements the Discord OAuth2 login for ShinnPanel.
//
// Flow: the CLI login (step 1) is already vouched by a SHINNPANEL_PREAUTH
// cookie before OAuth (step 2) runs. After the code → token → identity
// exchange, the panel calls the AuthBot's GET /internal/auth/check?user=<id>
// which returns {allowed, guilds} — the bot knows link state + allow-lists +
// per-guild admin roles for ALL configured guilds, so the web layer never
// needs the bot token or any per-guild role logic.
package oauth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	authorizeURL = "https://discord.com/api/oauth2/authorize"
	tokenURL     = "https://discord.com/api/oauth2/token"
	meURL        = "https://discord.com/api/users/@me"
	stateTTL     = 5 * time.Minute
	checkTTL     = 60 * time.Second
	maxPendingStates = 4096
	maxBodyBytes     = 1 << 20
)

var defaultHTTPClient = &http.Client{Timeout: 15 * time.Second}

// Deps carries what the OAuth flow needs.
type Deps struct {
	ClientID     string
	ClientSecret string
	RedirectURI  string // absolute URL of /oauth/callback
	BotPublicURL string // base URL of the bot (http://127.0.0.1:3001 on Debian)
	InternalKey  string // X-Internal-Key
	HTTPClient   *http.Client
}

// stateStore holds pending CSRF states until consumed or expired.
type stateStore struct {
	mu      sync.Mutex
	entries map[string]time.Time
}

func newStateStore() *stateStore { return &stateStore{entries: map[string]time.Time{}} }

func (s *stateStore) put(state string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	for k, exp := range s.entries {
		if now.After(exp) {
			delete(s.entries, k)
		}
	}
	if len(s.entries) >= maxPendingStates {
		type entry struct {
			k   string
			exp time.Time
		}
		all := make([]entry, 0, len(s.entries))
		for k, exp := range s.entries {
			all = append(all, entry{k, exp})
		}
		for i := 0; i < len(all); i++ {
			for j := i + 1; j < len(all); j++ {
				if all[j].exp.Before(all[i].exp) {
					all[i], all[j] = all[j], all[i]
				}
			}
		}
		for i := 0; i < len(all)/2; i++ {
			delete(s.entries, all[i].k)
		}
	}
	s.entries[state] = now.Add(stateTTL)
}

// consume returns true when state was present and unexpired; always removes it.
func (s *stateStore) consume(state string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	exp, ok := s.entries[state]
	if !ok {
		return false
	}
	delete(s.entries, state)
	return time.Now().Before(exp)
}

type Handlers struct {
	deps  Deps
	state *stateStore

	checkMu    sync.Mutex
	checkCache map[string]checkEntry
}

type checkEntry struct {
	allowed bool
	guilds  []string
	expires time.Time
}

func New(deps Deps) *Handlers {
	if deps.HTTPClient == nil {
		deps.HTTPClient = defaultHTTPClient
	}
	return &Handlers{
		deps:       deps,
		state:      newStateStore(),
		checkCache: map[string]checkEntry{},
	}
}

func newState() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		panic("oauth: crypto/rand unavailable: " + err.Error())
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// LoginHandler starts the OAuth flow. It requires a valid SHINNPANEL_PREAUTH
// cookie (step 1 of the CLI login) — without it we redirect back to /login.
func (h *Handlers) LoginHandler(redirectOverride string, preauthOK func(r *http.Request) bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !preauthOK(r) {
			http.Redirect(w, r, "/login", http.StatusFound)
			return
		}
		state := newState()
		h.state.put(state)
		redirect := redirectOverride
		if redirect == "" {
			redirect = requestOrigin(r) + "/oauth/callback"
		}
		q := url.Values{}
		q.Set("client_id", h.deps.ClientID)
		q.Set("redirect_uri", redirect)
		q.Set("response_type", "code")
		q.Set("scope", "identify")
		q.Set("state", state)
		http.Redirect(w, r, authorizeURL+"?"+q.Encode(), http.StatusFound)
	}
}

// LogoutHandler clears both cookies and returns to the landing page.
func LogoutHandler(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: "SHINNPANEL_SESSION", Value: "", Path: "/", HttpOnly: true, MaxAge: -1})
	http.SetCookie(w, &http.Cookie{Name: "SHINNPANEL_PREAUTH", Value: "", Path: "/", HttpOnly: true, MaxAge: -1})
	http.Redirect(w, r, "/", http.StatusFound)
}

type tokenResponse struct {
	AccessToken string `json:"access_token"`
}

type discordUser struct {
	ID         string `json:"id"`
	Username   string `json:"username"`
	GlobalName string `json:"global_name"`
}

// CheckResult is the bot's verdict on a user.
type CheckResult struct {
	Allowed bool
	Guilds  []string
}

// CheckBotVerdict asks the bot /internal/auth/check?user= with a 60s cache.
func (h *Handlers) CheckBotVerdict(ctx context.Context, userID string) (CheckResult, error) {
	h.checkMu.Lock()
	if e, ok := h.checkCache[userID]; ok && time.Now().Before(e.expires) {
		h.checkMu.Unlock()
		return CheckResult{Allowed: e.allowed, Guilds: e.guilds}, nil
	}
	h.checkMu.Unlock()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		h.deps.BotPublicURL+"/internal/auth/check?user="+url.QueryEscape(userID), nil)
	if err != nil {
		return CheckResult{}, err
	}
	req.Header.Set("X-Internal-Key", h.deps.InternalKey)
	req.Header.Set("Accept", "application/json")

	resp, err := h.deps.HTTPClient.Do(req)
	if err != nil {
		return CheckResult{}, fmt.Errorf("bot unreachable: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return CheckResult{}, fmt.Errorf("auth/check status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
	if err != nil {
		return CheckResult{}, err
	}
	var parsed struct {
		Allowed bool     `json:"allowed"`
		Guilds  []string `json:"guilds"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return CheckResult{}, err
	}

	h.checkMu.Lock()
	h.checkCache[userID] = checkEntry{allowed: parsed.Allowed, guilds: parsed.Guilds, expires: time.Now().Add(checkTTL)}
	h.checkMu.Unlock()
	return CheckResult{Allowed: parsed.Allowed, Guilds: parsed.Guilds}, nil
}

// CallbackHandler completes the OAuth flow:
// code → token → identity → bot verdict → session cookie.
// setSession is provided by the server package.
func (h *Handlers) CallbackHandler(redirectOverride string, setSession func(w http.ResponseWriter, userID, username string, guilds []string)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		code := r.URL.Query().Get("code")
		state := r.URL.Query().Get("state")
		if code == "" || state == "" || !h.state.consume(state) {
			jsonError(w, http.StatusBadRequest, "invalid_state")
			return
		}

		accessToken, err := h.exchangeCode(r.Context(), code, redirectOverride)
		if err != nil {
			jsonError(w, http.StatusBadGateway, "token_exchange_failed")
			return
		}

		user, err := h.fetchUser(r.Context(), accessToken)
		if err != nil || user.ID == "" {
			jsonError(w, http.StatusBadGateway, "invalid_user")
			return
		}

		verdict, err := h.CheckBotVerdict(r.Context(), user.ID)
		if err != nil || !verdict.Allowed {
			jsonError(w, http.StatusForbidden, "not_authorized")
			return
		}

		name := user.GlobalName
		if name == "" {
			name = user.Username
		}
		setSession(w, user.ID, name, verdict.Guilds)
		http.Redirect(w, r, "/", http.StatusFound)
	}
}

// requestOrigin derives scheme+host from the incoming request.
func requestOrigin(r *http.Request) string {
	scheme := "https"
	if r.TLS != nil {
		scheme = "https"
	} else if proto := r.Header.Get("X-Forwarded-Proto"); proto != "" {
		scheme = proto
	} else if r.Host != "" && (strings.HasPrefix(r.Host, "localhost") || strings.HasPrefix(r.Host, "127.0.0.1")) {
		scheme = "http"
	}
	host := r.Header.Get("X-Forwarded-Host")
	if host == "" {
		host = r.Host
	}
	return scheme + "://" + host
}

func (h *Handlers) exchangeCode(ctx context.Context, code, redirectOverride string) (string, error) {
	redirect := redirectOverride
	if redirect == "" {
		redirect = h.deps.RedirectURI
	}
	form := url.Values{}
	form.Set("client_id", h.deps.ClientID)
	form.Set("client_secret", h.deps.ClientSecret)
	form.Set("grant_type", "authorization_code")
	form.Set("code", code)
	form.Set("redirect_uri", redirect)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenURL,
		strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := h.deps.HTTPClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("token status %d", resp.StatusCode)
	}
	var tr tokenResponse
	if err := json.Unmarshal(body, &tr); err != nil {
		return "", err
	}
	return tr.AccessToken, nil
}

func (h *Handlers) fetchUser(ctx context.Context, accessToken string) (discordUser, error) {
	var u discordUser
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, meURL, nil)
	if err != nil {
		return u, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	resp, err := h.deps.HTTPClient.Do(req)
	if err != nil {
		return u, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return u, fmt.Errorf("me status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
	if err != nil {
		return u, err
	}
	if err := json.Unmarshal(body, &u); err != nil {
		return u, err
	}
	return u, nil
}

func jsonError(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(`{"error":"` + code + `"}`))
}