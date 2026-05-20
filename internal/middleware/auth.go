// Package middleware provides HTTP middleware for authentication and authorisation.
package middleware

import (
	"context"
	"net/http"
	"strings"

	"offdock/internal/auth"
)

type contextKey string

const claimsKey contextKey = "claims"

// Authenticate validates the JWT carried either in the Authorization header
// (Bearer scheme) or in the httpOnly cookie.  Unauthenticated requests receive
// 401; the validated Claims are stored in the request context.
func Authenticate(svc *auth.Service) func(http.Handler) http.Handler {
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
