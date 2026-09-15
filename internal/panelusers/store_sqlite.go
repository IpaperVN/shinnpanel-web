package panelusers

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// sqliteStore is a Store backed by a SQLite database.
type sqliteStore struct {
	db *sql.DB
}

// DefaultLockThreshold is how many consecutive failures trigger a lockout.
const DefaultLockThreshold = 5

// DefaultLockDuration is how long an account stays locked.
const DefaultLockDuration = 15 * time.Minute

// Open opens (creating if needed) the SQLite database at path.
func Open(path string) (Store, error) {
	if path == "" {
		return nil, errors.New("panel_users db path empty")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // sqlite: single writer

	// schema
	const schema = `
CREATE TABLE IF NOT EXISTS panel_users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    username        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash   TEXT NOT NULL,
    is_admin        INTEGER NOT NULL DEFAULT 0,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until    INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL
);`
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, err
	}
	return &sqliteStore{db: db}, nil
}

// Close implements Store.
func (s *sqliteStore) Close() error { return s.db.Close() }

// GetByUsername implements Store.
func (s *sqliteStore) GetByUsername(username string) (*User, error) {
	var (
		u     User
		until int64
		at    int64
	)
	row := s.db.QueryRow(
		`SELECT id, username, password_hash, is_admin, failed_attempts, locked_until, created_at
		 FROM panel_users WHERE username = ? COLLATE NOCASE`, username)
	err := row.Scan(&u.ID, &u.Username, &u.PasswordHash, &u.IsAdmin,
		&u.FailedAttempts, &until, &at)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	u.LockedUntil = time.Unix(until, 0)
	u.CreatedAt = time.Unix(at, 0)
	return &u, nil
}

// RecordFailure increments the failed counter and locks once at threshold.
func (s *sqliteStore) RecordFailure(u *User) error {
	if u == nil {
		return errors.New("nil user")
	}
	u.FailedAttempts++
	until := int64(0)
	if u.FailedAttempts >= DefaultLockThreshold {
		u.LockedUntil = time.Now().Add(DefaultLockDuration)
		until = u.LockedUntil.Unix()
	}
	_, err := s.db.Exec(
		`UPDATE panel_users SET failed_attempts = ?, locked_until = ? WHERE id = ?`,
		u.FailedAttempts, until, u.ID)
	return err
}

// SetFailed sets the failed-attempt counter (used to reset on success).
func (s *sqliteStore) SetFailed(u *User, attempts int) error {
	if u == nil {
		return errors.New("nil user")
	}
	u.FailedAttempts = attempts
	_, err := s.db.Exec(
		`UPDATE panel_users SET failed_attempts = ?, locked_until = 0 WHERE id = ?`,
		attempts, u.ID)
	return err
}

// EnsureUser creates the first admin (idempotent). Returns true if created.
func (s *sqliteStore) EnsureUser(username, hash string) (bool, error) {
	u, err := s.GetByUsername(username)
	if err != nil {
		return false, err
	}
	if u != nil {
		return false, nil
	}
	_, err = s.db.Exec(
		`INSERT INTO panel_users (username, password_hash, is_admin, created_at)
		 VALUES (?, ?, 1, ?)`, username, hash, time.Now().Unix())
	return err == nil, err
}

// CleanupUsername normalises a username for storage/comparison.
func CleanupUsername(name string) string {
	return strings.TrimSpace(name)
}

var _ Store = (*sqliteStore)(nil)

// Re-export for callers who want the concrete type.
type StoreIfc = Store

var _ = fmt.Sprintf // keep fmt if not used elsewhere later
