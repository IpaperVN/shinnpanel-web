package session

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestEncodeDecodeRoundTrip(t *testing.T) {
	m := NewManager("test-secret-key-that-is-long-enough-12345")
	val, err := m.Encode(Data{Username: "admin", Kind: "session", IssuedAt: time.Now().Unix()})
	if err != nil {
		t.Fatal(err)
	}
	d, err := m.Decode(val)
	if err != nil {
		t.Fatal(err)
	}
	if d.Username != "admin" || d.Kind != "session" {
		t.Fatalf("round-trip: %+v", d)
	}
}

func TestTamperRejected(t *testing.T) {
	m := NewManager("test-secret-key-that-is-long-enough-12345")
	val, _ := m.Encode(Data{Username: "admin", Kind: "session", IssuedAt: time.Now().Unix()})
	if _, err := m.Decode(val + "x"); err == nil {
		t.Fatal("tampered cookie accepted")
	}
	if _, err := m.Decode("garbage"); err == nil {
		t.Fatal("garbage accepted")
	}
}

func TestWrongSecretRejected(t *testing.T) {
	m := NewManager("test-secret-key-that-is-long-enough-12345")
	val, _ := m.Encode(Data{Username: "admin", Kind: "session", IssuedAt: time.Now().Unix()})
	other := NewManager("another-secret-key-just-as-long-4321")
	if _, err := other.Decode(val); err == nil {
		t.Fatal("wrong secret accepted")
	}
}

func TestKindCheck(t *testing.T) {
	m := NewManager("test-secret-key-that-is-long-enough-12345")
	pre, _ := m.Encode(Data{Username: "admin", Kind: "preauth", IssuedAt: time.Now().Unix()})
	ses, _ := m.Encode(Data{Username: "admin", Kind: "session", IssuedAt: time.Now().Unix()})

	// Both kinds decode fine (Decode is kind-agnostic)…
	if _, err := m.Decode(pre); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Decode(ses); err != nil {
		t.Fatal(err)
	}
	// …and TTL maps correctly per kind.
	if TTL("preauth") != PreauthTTL || TTL("session") != SessionTTL {
		t.Fatalf("TTL mapping wrong")
	}

	// FromRequest enforces kind + expiry. Build a request with the cookie set.
	rr := httptest.NewRequest("GET", "/", nil)
	rr.AddCookie(&http.Cookie{Name: PreauthCookie, Value: pre})
	rr.AddCookie(&http.Cookie{Name: SessionCookie, Value: ses})
	if d, err := m.FromRequest(rr, PreauthCookie, "preauth"); err != nil || d.Username != "admin" {
		t.Fatalf("preauth from request: %v %v", d, err)
	}
	if _, err := m.FromRequest(rr, SessionCookie, "session"); err != nil {
		t.Fatalf("session from request: %v", err)
	}
	// kind mismatch
	if _, err := m.FromRequest(rr, SessionCookie, "preauth"); err == nil {
		t.Fatal("kind mismatch accepted")
	}
}

func TestExpired(t *testing.T) {
	m := NewManager("test-secret-key-that-is-long-enough-12345")
	val, _ := m.Encode(Data{Username: "admin", Kind: "session", IssuedAt: time.Now().Add(-10 * 24 * time.Hour).Unix()})
	rr := httptest.NewRequest("GET", "/", nil)
	rr.AddCookie(&http.Cookie{Name: SessionCookie, Value: val})
	if _, err := m.FromRequest(rr, SessionCookie, "session"); err == nil {
		t.Fatal("expired cookie accepted")
	}
}