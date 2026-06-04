// Package middleware provides HTTP middleware for authentication and authorisation.
package middleware

import (
	"context"
	"net/http"
	"strings"
	"time"

	"offdock/internal/auth"
	"offdock/internal/store"
)

type contextKey string

const claimsKey contextKey = "claims"

// Authenticate validates the JWT carried either in the Authorization header
// (Bearer scheme) or in the httpOnly cookie.  Unauthenticated requests receive
// 401; the validated Claims are stored in the request context.
//
// When db is non-nil and the token carries a session ID, the session is checked
// for revocation (revoked → 401) and its LastSeen timestamp is refreshed,
// enabling active-session auditing and remote logout.
func Authenticate(svc *auth.Service, db *store.DB) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token := tokenFromRequest(r)
			if token == "" {
				http.Error(w, `{"error":"unauthenticated"}`, http.StatusUnauthorized)
				return
			}

			claims, err := svc.Verify(token)
			if err != nil {
				http.Error(w, `{"error":"invalid or expired token"}`, http.StatusUnauthorized)
				return
			}

			if db != nil && claims.SessionID != "" {
				if sess, err := db.Sessions.FindByID(claims.SessionID); err == nil {
					if sess.Revoked {
						http.Error(w, `{"error":"session revoked"}`, http.StatusUnauthorized)
						return
					}
					if time.Since(sess.LastSeen) > time.Minute {
						sess.LastSeen = time.Now().UTC()
						db.Sessions.Save(sess) //nolint:errcheck
					}
				}
			}

			ctx := context.WithValue(r.Context(), claimsKey, claims)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// ClaimsFromContext returns the JWT claims stored by Authenticate, or nil.
func ClaimsFromContext(ctx context.Context) *auth.Claims {
	v, _ := ctx.Value(claimsKey).(*auth.Claims)
	return v
}

func tokenFromRequest(r *http.Request) string {
	// Cookie takes precedence (set by login endpoint).
	if c, err := r.Cookie(auth.TokenCookieName); err == nil {
		return c.Value
	}
	// Fall back to Authorization: Bearer <token>
	h := r.Header.Get("Authorization")
	if after, ok := strings.CutPrefix(h, "Bearer "); ok {
		return after
	}
	return ""
}
