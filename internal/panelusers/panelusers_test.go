package panelusers

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func testStore(t *testing.T) Store {
	t.Helper()
	db := filepath.Join(t.TempDir(), "panel.db")
	s, err := Open(db)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

// helper to create a user directly (hash made with the exported helper).
func createUser(t *testing.T, s Store, username, pw string) *User {
	t.Helper()
	hash, err := HashPassword(pw)
	if err != nil {
		t.Fatal(err)
	}
	sqlStore := s.(*sqliteStore)
	if _, err := sqlStore.EnsureUser(username, hash); err != nil {
		t.Fatal(err)
	}
	u, err := s.GetByUsername(username)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func TestHashAndCheck(t *testing.T) {
	hash, err := HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if !CheckPassword(hash, "correct horse battery staple") {
		t.Fatal("valid password rejected")
	}
	if CheckPassword(hash, "wrong") {
		t.Fatal("wrong password accepted")
	}
}

func TestOpenCreatesSchema(t *testing.T) {
	s := testStore(t)
	if _, err := s.GetByUsername("nobody"); err != nil {
		t.Fatalf("query empty store: %v", err)
	}
}

func TestCreateAndGetUser(t *testing.T) {
	s := testStore(t)
	u := createUser(t, s, "admin", "a-very-strong-password!")
	if u == nil || u.Username != "admin" || !u.IsAdmin {
		t.Fatalf("user = %+v", u)
	}
	got, err := s.GetByUsername("ADMIN") // NOCASE
	if err != nil || got == nil {
		t.Fatalf("case-insensitive lookup failed: %v %v", got, err)
	}
}

func TestLockoutAfterThreshold(t *testing.T) {
	s := testStore(t)
	u := createUser(t, s, "admin", "a-very-strong-password!")
	for i := 0; i < DefaultLockThreshold-1; i++ {
		if err := s.RecordFailure(u); err != nil {
			t.Fatal(err)
		}
	}
	if u.FailedAttempts != DefaultLockThreshold-1 {
		t.Fatalf("attempts = %d", u.FailedAttempts)
	}
	if u.LockedUntil.After(time.Now()) {
		t.Fatalf("locked too early: %v", u.LockedUntil)
	}

	if err := s.RecordFailure(u); err != nil {
		t.Fatal(err)
	}
	if u.FailedAttempts != DefaultLockThreshold {
		t.Fatalf("attempts = %d", u.FailedAttempts)
	}
	if u.LockedUntil.Before(time.Now()) {
		t.Fatalf("not locked after threshold: %v", u.LockedUntil)
	}
}

func TestSetFailedResetsLock(t *testing.T) {
	s := testStore(t)
	u := createUser(t, s, "admin", "a-very-strong-password!")
	for i := 0; i < DefaultLockThreshold; i++ {
		s.RecordFailure(u)
	}
	if u.LockedUntil.IsZero() {
		t.Fatal("expected lock")
	}
	if err := s.SetFailed(u, 0); err != nil {
		t.Fatal(err)
	}
	if u.FailedAttempts != 0 {
		t.Fatalf("attempts = %d, want 0", u.FailedAttempts)
	}
	got, _ := s.GetByUsername("admin")
	if got.FailedAttempts != 0 {
		t.Fatalf("not reset: %+v", got)
	}
	if got.LockedUntil.After(time.Now()) {
		t.Fatalf("still locked: %+v", got)
	}
}

func TestEnsureUserIdempotent(t *testing.T) {
	s := testStore(t)
	hash, _ := HashPassword("x-password-long-enough!")
	sqlStore := s.(*sqliteStore)
	created, err := sqlStore.EnsureUser("admin", hash)
	if err != nil || !created {
		t.Fatalf("first ensure: %v %v", created, err)
	}
	created, err = sqlStore.EnsureUser("admin", hash)
	if err != nil || created {
		t.Fatalf("second ensure should be no-op: %v %v", created, err)
	}
}

// Verify the db file actually exists on disk after Open.
func TestDBFileOnDisk(t *testing.T) {
	db := filepath.Join(t.TempDir(), "sub", "panel.db")
	s, err := Open(db)
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	if _, err := os.Stat(db); err != nil {
		t.Fatalf("db file missing: %v", err)
	}
}
