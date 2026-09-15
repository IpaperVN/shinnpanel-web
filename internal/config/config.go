// Package config loads the ShinnPanel web server settings from environment
// variables. Secrets come from env (systemd Environment= on Debian, .env
// locally). Two internal services are reached over loopback:
//
//	AuthBot     BOT_INTERNAL_URL   (mặc định http://127.0.0.1:3001)
//	MC agent    MC_AGENT_URL       (mặc định http://127.0.0.1:3002)
package config

import (
	"fmt"
	"os"
	"strings"
)

// Config holds every setting the web layer needs.
type Config struct {
	// Listen is the bind address (loopback in production: 127.0.0.1:3000).
	Listen string
	// Secure forces Secure on cookies (true when served over HTTPS).
	Secure bool

	// Panels users DB (SQLite).
	PanelUsersDB string

	// AuthBot (loopback).
	BotURL      string // base URL: http://127.0.0.1:3001
	InternalKey string // X-Internal-Key for /internal/* calls to AuthBot

	// MC agent (loopback).
	McURL      string // http://127.0.0.1:3002
	McAgentKey string // X-Mc-Agent-Key

	// OAuth (Discord).
	OAuthClientID     string
	OAuthClientSecret string
	OAuthRedirectURI  string // absolute URL of /oauth/callback

	// SessionSecret — HMAC key (>= 32 chars). Same secret signs both cookies.
	SessionSecret string
}

// Load reads env vars and validates the result.
func Load() (*Config, error) {
	cfg := &Config{
		Listen:           getenv("PANEL_LISTEN", "127.0.0.1:3000"),
		Secure:           getenv("PANEL_SECURE", "true") == "true",
		PanelUsersDB:     getenv("PANEL_USERS_DB", "/opt/shinnpanel/panel_users.db"),
		BotURL:           strings.TrimRight(getenv("BOT_INTERNAL_URL", "http://127.0.0.1:3001"), "/"),
		InternalKey:      os.Getenv("INTERNAL_KEY"),
		McURL:            strings.TrimRight(getenv("MC_AGENT_URL", "http://127.0.0.1:3002"), "/"),
		McAgentKey:       os.Getenv("MC_AGENT_KEY"),
		OAuthClientID:     os.Getenv("OAUTH_CLIENT_ID"),
		OAuthClientSecret: os.Getenv("OAUTH_CLIENT_SECRET"),
		OAuthRedirectURI:  strings.TrimRight(os.Getenv("OAUTH_REDIRECT_URI"), "/"),
		SessionSecret:     os.Getenv("SESSION_SECRET"),
	}
	if err := validate(cfg); err != nil {
		return nil, err
	}
	return cfg, nil
}

func getenv(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

func validate(cfg *Config) error {
	if len(cfg.SessionSecret) < 32 {
		return fmt.Errorf("SESSION_SECRET must be >= 32 chars")
	}
	if cfg.BotURL != "" && !strings.HasPrefix(cfg.BotURL, "http://") && !strings.HasPrefix(cfg.BotURL, "https://") {
		return fmt.Errorf("BOT_INTERNAL_URL must start with http:// or https://")
	}
	if cfg.McURL != "" && !strings.HasPrefix(cfg.McURL, "http://") && !strings.HasPrefix(cfg.McURL, "https://") {
		return fmt.Errorf("MC_AGENT_URL must start with http:// or https://")
	}
	if cfg.McURL != "" && len(cfg.McAgentKey) < 32 {
		return fmt.Errorf("MC_AGENT_KEY must be >= 32 chars and different from INTERNAL_KEY")
	}
	if cfg.BotURL != "" && cfg.McURL != "" && cfg.McAgentKey == cfg.InternalKey {
		return fmt.Errorf("INTERNAL_KEY and MC_AGENT_KEY must be two different secrets")
	}
	if cfg.BotURL != "" && (cfg.OAuthClientID == "" || cfg.OAuthClientSecret == "") {
		return fmt.Errorf("OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET required")
	}
	if cfg.PanelUsersDB == "" {
		return fmt.Errorf("PANEL_USERS_DB required")
	}
	return nil
}