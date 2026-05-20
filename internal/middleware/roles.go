package middleware

import (
	"net/http"

	"offdock/internal/store"
)

// RequireRole rejects requests whose JWT role is lower than minRole.
// Role hierarchy: superadmin > admin > viewer.
func RequireRole(minRole store.Role) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			claims := ClaimsFromContext(r.Context())
			if claims == nil {
				http.Error(w, `{"error":"unauthenticated"}`, http.StatusUnauthorized)
				return
			}
			if !roleAtLeast(claims.Role, minRole) {
				http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// roleAtLeast returns true if actual is at least as privileged as required.
func roleAtLeast(actual, required store.Role) bool {
	return roleRank(actual) >= roleRank(required)
}

func roleRank(r store.Role) int {
	switch r {
	case store.RoleSuperAdmin:
		return 3
	case store.RoleAdmin:
		return 2
	case store.RoleViewer:
		return 1
	default:
		return 0
	}
}
