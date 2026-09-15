package ratelimit

import (
	"testing"
	"time"
)

func TestAllowWithinWindow(t *testing.T) {
	l := New()
	if !l.Allow("ip", 5, time.Minute) {
		t.Fatal("first allow")
	}
	for i := 0; i < 4; i++ {
		if !l.Allow("ip", 5, time.Minute) {
			t.Fatalf("allow %d", i)
		}
	}
	if l.Allow("ip", 5, time.Minute) {
		t.Fatal("6th should be denied")
	}
}

func TestWindowResets(t *testing.T) {
	l := New()
	l.Allow("a", 2, 30*time.Millisecond)
	l.Allow("a", 2, 30*time.Millisecond)
	if l.Allow("a", 2, 30*time.Millisecond) {
		t.Fatal("should be denied before window resets")
	}
	time.Sleep(40 * time.Millisecond)
	if !l.Allow("a", 2, 30*time.Millisecond) {
		t.Fatal("window should have reset")
	}
}

func TestKeysIndependent(t *testing.T) {
	l := New()
	for i := 0; i < 50; i++ {
		l.Allow("x", 200, time.Minute) // key x never exhausted in this loop
		if !l.Allow("y", 200, time.Minute) {
			t.Fatalf("y denied at %d", i)
		}
	}
	// exhaust x beyond its own limit; y unaffected.
	l.Allow("x", 1, time.Minute)
	if l.Allow("x", 1, time.Minute) {
		t.Fatal("x should be exhausted")
	}
	if !l.Allow("y", 200, time.Minute) {
		t.Fatal("y should still be allowed")
	}
}