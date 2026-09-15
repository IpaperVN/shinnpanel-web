// Package panelusers manages the ShinnPanel admin accounts: SQLite storage,
// bcrypt password hashing (constant-time compare), per-user brute-force
// lockout, and IP rate limiting. There is exactly one admin ("single admin,
// no registration").
package panelusers

import (
	"crypto/subtle"
	"errors"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// Config carries the store settings.
type Config struct {
	DBPath string // SQLite database path (e.g. /opt/shinnpanel/panel_users.db)
}

// User is one admin account row.
type User struct {
	ID             int64
	Username       string
	PasswordHash   string
	IsAdmin        bool
	FailedAttempts int
	LockedUntil    time.Time
	CreatedAt      time.Time
}

// Store is the panel_users store.
type Store interface {
	// GetByUsername returns the user or nil (plus error on failure).
	GetByUsername(username string) (*User, error)
	// RecordFailure increments the failed-attempt counter and applies lockout
	// once the threshold is hit. SetFailed resets it on a successful login.
	RecordFailure(u *User) error
	SetFailed(u *User, attempts int) error
	// EnsureUser creates the first admin (idempotent). Returns true if created.
	EnsureUser(username, hash string) (bool, error)
	// Close releases the underlying DB handle.
	Close() error
}

// ErrLocked is returned when the account is locked out.
var ErrLocked = errors.New("account locked")

// MinPasswordLen is the minimum accepted password length.
const MinPasswordLen = 12

// HashPassword bcrypt-hashes a password (cost 12).
func HashPassword(pw string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(pw), 12)
	return string(b), err
}

// CheckPassword compares a password against its hash in constant time.
// Returns ErrLocked if the account is locked.
func CheckPassword(hash, pw string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(pw)) == nil
}

// ConstantEqual compares two strings in constant time.
func ConstantEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
