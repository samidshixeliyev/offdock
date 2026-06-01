package middleware

import (
	"net/http"
	"strings"
	"sync"
	"time"
)

// LoginLimiter is a simple in-memory per-IP rate limiter for the login endpoint.
// It allows up to maxAttempts per window per IP.
type LoginLimiter struct {
	mu          sync.Mutex
	attempts    map[string][]time.Time
	maxAttempts int
	window      time.Duration
}

// NewLoginLimiter creates a new rate limiter.
func NewLoginLimiter(maxAttempts int, window time.Duration) *LoginLimiter {
	ll := &LoginLimiter{
		attempts:    make(map[string][]time.Time),
		maxAttempts: maxAttempts,
		window:      window,
	}
	go ll.cleanup()
	return ll
}

func (ll *LoginLimiter) Allow(ip string) bool {
	ll.mu.Lock()
	defer ll.mu.Unlock()
	now := time.Now()
	cutoff := now.Add(-ll.window)
	recent := ll.attempts[ip][:0]
	for _, t := range ll.attempts[ip] {
		if t.After(cutoff) {
			recent = append(recent, t)
		}
	}
	if len(recent) >= ll.maxAttempts {
		ll.attempts[ip] = recent
		return false
	}
	ll.attempts[ip] = append(recent, now)
	return true
}

func (ll *LoginLimiter) cleanup() {
	for range time.Tick(5 * time.Minute) {
		ll.mu.Lock()
		cutoff := time.Now().Add(-ll.window)
		for ip, times := range ll.attempts {
			var keep []time.Time
			for _, t := range times {
				if t.After(cutoff) {
					keep = append(keep, t)
				}
			}
			if len(keep) == 0 {
				delete(ll.attempts, ip)
			} else {
				ll.attempts[ip] = keep
			}
		}
		ll.mu.Unlock()
	}
}

// RealIP extracts the real client IP from the request.
func RealIP(r *http.Request) string {
	if ip := r.Header.Get("X-Real-IP"); ip != "" {
		return ip
	}
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		return strings.Split(fwd, ",")[0]
	}
	ip := r.RemoteAddr
	if i := strings.LastIndex(ip, ":"); i >= 0 {
		return ip[:i]
	}
	return ip
}
