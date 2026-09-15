// Package session implements HMAC-signed cookies for ShinnPanel:
//   - SHINNPANEL_SESSION — the full authenticated session (set after OAuth)
//   - SHINNPANEL_PREAUTH — short-lived proof that the panel account login
//     succeeded (step 1 of the CLI login), required before OAuth (step 2)
//
// Payload is {username, kind, issuedAt}; the cookie value is
// base64url(payload) + "." + base64url(HMAC-SHA256(payload, secret)).
// Stateless on purpose — any instance sharing the secret can verify.
package session

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

const (
	// SessionCookie is the long-lived AUTH cookie (set at the end of OAuth).
	SessionCookie = "SHINNPANEL_SESSION"
	// PreauthCookie is the short-lived step-1 login proof.
	PreauthCookie = "SHINNPANEL_PREAUTH"

	// SessionTTL — 7 days.
	SessionTTL = 7 * 24 * time.Hour
	// PreauthTTL — 5 minutes: time to complete Discord OAuth.
	PreauthTTL = 5 * time.Minute
)

var (
	ErrNoCookie  = errors.New("session: no cookie")
	ErrBadFormat = errors.New("session: malformed cookie")
	ErrBadSig    = errors.New("session: bad signature")
	ErrExpired   = errors.New("session: expired")
)

// Data is the signed payload carried by cookies.
type Data struct {
	Username  string `json:"username"`
	Kind      string `json:"kind"` // "session" or "preauth"
	Guilds    []string `json:"guilds,omitempty"`
	IssuedAt  int64  `json:"issuedAt"` // unix seconds
}

// Manager signs and verifies cookies with an HMAC-SHA256 secret.
type Manager struct {
	secret []byte
}

func NewManager(secret string) *Manager {
	return &Manager{secret: []byte(secret)}
}

func (m *Manager) sign(payload []byte) []byte {
	mac := hmac.New(sha256.New, m.secret)
	mac.Write(payload)
	return mac.Sum(nil)
}

// Encode serializes and signs d, returning the cookie value.
func (m *Manager) Encode(d Data) (string, error) {
	payload, err := json.Marshal(d)
	if err != nil {
		return "", err
	}
	b64 := base64.RawURLEncoding.EncodeToString(payload)
	sig := base64.RawURLEncoding.EncodeToString(m.sign(payload))
	return b64 + "." + sig, nil
}

// Decode verifies the cookie value (any kind) and returns the payload.
func (m *Manager) Decode(value string) (Data, error) {
	var d Data
	b64, sig, ok := strings.Cut(value, ".")
	if !ok || b64 == "" || sig == "" {
		return d, ErrBadFormat
	}
	payload, err := base64.RawURLEncoding.DecodeString(b64)
	if err != nil {
		return d, ErrBadFormat
	}
	want, err := base64.RawURLEncoding.DecodeString(sig)
	if err != nil {
		return d, ErrBadFormat
	}
	if !hmac.Equal(want, m.sign(payload)) {
		return d, ErrBadSig
	}
	if err := json.Unmarshal(payload, &d); err != nil {
		return d, ErrBadFormat
	}
	return d, nil
}

// TTL returns the lifetime for a cookie kind ("" defaults to session).
func TTL(kind string) time.Duration {
	if kind == "preauth" {
		return PreauthTTL
	}
	return SessionTTL
}

// FromRequest extracts and verifies name from r's cookies, checking kind.
func (m *Manager) FromRequest(r *http.Request, name, kind string) (Data, error) {
	c, err := r.Cookie(name)
	if err != nil {
		return Data{}, ErrNoCookie
	}
	d, err := m.Decode(c.Value)
	if err != nil {
		return Data{}, err
	}
	if kind != "" && d.Kind != kind {
		return Data{}, ErrBadFormat
	}
	if time.Since(time.Unix(d.IssuedAt, 0)) > TTL(d.Kind) {
		return Data{}, ErrExpired
	}
	return d, nil
}

// SetCookie writes a cookie with the given name (HttpOnly, Secure, SameSite=Lax).
func SetCookie(w http.ResponseWriter, name, value, kind string, secure bool) {
	ttl := TTL(kind)
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		MaxAge:   int(ttl.Seconds()),
		SameSite: http.SameSiteLaxMode,
	})
}

// ClearCookie expires a cookie by name.
func ClearCookie(w http.ResponseWriter, name string) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		MaxAge:   -1,
		SameSite: http.SameSiteLaxMode,
	})
}