// Package ratelimit provides a small in-memory sliding-window rate limiter
// used for login brute-force protection (per IP and per username). It is
// deliberately simple: single admin, loopback services, no persistence.
package ratelimit

import (
	"sync"
	"time"
)

// Limiter is a fixed-window rate limiter keyed by string.
type Limiter struct {
	mu sync.Mutex
	m  map[string]*bucket
}

type bucket struct {
	count  int
	window time.Time
}

// New returns an empty Limiter.
func New() *Limiter { return &Limiter{m: make(map[string]*bucket)} }

// Allow reports whether key may proceed: at most max hits per window.
func (l *Limiter) Allow(key string, max int, window time.Duration) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	b, ok := l.m[key]
	if !ok || now.Sub(b.window) >= window {
		l.m[key] = &bucket{count: 1, window: now}
		if len(l.m) > 4096 {
			l.m = make(map[string]*bucket) // bounded: reset when flooded
		}
		return true
	}
	b.count++
	return b.count <= max
}