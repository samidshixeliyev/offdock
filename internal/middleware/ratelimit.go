package middleware

import (
	"fmt"
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

// RealIP extracts the client IP from RemoteAddr.
// X-Real-IP / X-Forwarded-For are intentionally ignored: trusting client-supplied
// headers allows trivial rate-limit bypass and audit-log IP spoofing.
// nginx (or another trusted reverse proxy) should rewrite RemoteAddr itself.
func RealIP(r *http.Request) string {
	ip := r.RemoteAddr
	// RemoteAddr is host:port for IPv4 and [::1]:port for IPv6.
	host, _, err := splitHostPort(ip)
	if err != nil {
		// No port — use as-is (shouldn't happen in practice).
		return ip
	}
	return host
}

func splitHostPort(addr string) (host, port string, err error) {
	if len(addr) == 0 {
		return "", "", fmt.Errorf("empty addr")
	}
	// IPv6 bracketed: [::1]:port
	if addr[0] == '[' {
		end := strings.LastIndex(addr, "]")
		if end < 0 {
			return "", "", fmt.Errorf("bad addr: %s", addr)
		}
		host = addr[1:end]
		if end+1 < len(addr) && addr[end+1] == ':' {
			port = addr[end+2:]
		}
		return host, port, nil
	}
	// IPv4: host:port
	i := strings.LastIndex(addr, ":")
	if i < 0 {
		return addr, "", nil
	}
	return addr[:i], addr[i+1:], nil
}

