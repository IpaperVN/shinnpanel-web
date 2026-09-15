//go:build linux

package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/IpaperVN/shinnpanel/web/internal/config"
	"github.com/IpaperVN/shinnpanel/web/internal/panelusers"
	"github.com/IpaperVN/shinnpanel/web/internal/server"
)

// runServer loads config, opens the panel store, and runs the HTTP server
// until SIGTERM/SIGINT.
func runServer() error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("config: %w", err)
	}

	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))

	store, err := panelusers.Open(cfg.PanelUsersDB)
	if err != nil {
		return fmt.Errorf("open panel_users db %q: %w", cfg.PanelUsersDB, err)
	}
	defer store.Close()

	srv := server.New(cfg, log, store)
	httpSrv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       time.Minute,
		MaxHeaderBytes:    1 << 20,
	}

	errCh := make(chan error, 1)
	go func() {
		log.Info("shinnpanel listening", "addr", cfg.Listen)
		errCh <- httpSrv.ListenAndServe()
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	select {
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return fmt.Errorf("http: %w", err)
	case <-stop:
		log.Info("shutting down")
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return httpSrv.Shutdown(ctx)
	}
}