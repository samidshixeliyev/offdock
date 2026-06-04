package handlers

import (
	"net/http"
	"time"

	authmw "offdock/internal/middleware"
	"offdock/internal/auth"
	"offdock/internal/store"
)

// Login authenticates a user by username/password and sets an httpOnly JWT cookie.
func (h *H) Login(w http.ResponseWriter, r *http.Request) {
	if !h.limiter.Allow(authmw.RealIP(r)) {
		writeError(w, http.StatusTooManyRequests, "too many login attempts — try again in a minute")
		return
	}
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	users, err := h.db.Users.FindWhere(func(u store.User) bool {
		return u.Username == req.Username && u.Active
	})
	if err != nil || len(users) == 0 {
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}

	user := users[0]
	if err := auth.CheckPassword(req.Password, user.PasswordHash); err != nil {
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}

	// Create a server-side session so the token can be revoked / audited.
	now := timeNow()
	session := store.Session{
		ID:        store.NewULID(),
		UserID:    user.ID,
		Username:  user.Username,
		IP:        authmw.RealIP(r),
		UserAgent: r.UserAgent(),
		CreatedAt: now,
		LastSeen:  now,
	}
	if err := h.db.Sessions.Save(session); err != nil {
		writeError(w, http.StatusInternalServerError, "could not create session")
		return
	}

	token, err := h.auth.Issue(user, session.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not issue token")
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     auth.TokenCookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Expires:  time.Now().Add(8 * time.Hour),
	})

	h.logAudit(r, "login", "user", user.ID, user.Username, "")

	writeJSON(w, http.StatusOK, map[string]any{
		"id":       user.ID,
		"username": user.Username,
		"role":     user.Role,
	})
}

// Logout clears the JWT cookie and revokes the server-side session.
func (h *H) Logout(w http.ResponseWriter, r *http.Request) {
	if claims := authmw.ClaimsFromContext(r.Context()); claims != nil && claims.SessionID != "" {
		if sess, err := h.db.Sessions.FindByID(claims.SessionID); err == nil {
			sess.Revoked = true
			h.db.Sessions.Save(sess) //nolint:errcheck
		}
	}
	http.SetCookie(w, &http.Cookie{
		Name:     auth.TokenCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Expires:  time.Unix(0, 0),
		MaxAge:   -1,
	})
	h.logAudit(r, "logout", "user", "", "", "")
	writeJSON(w, http.StatusOK, map[string]string{"status": "logged_out"})
}

// Me returns the current user's profile + effective permissions and project scope.
func (h *H) Me(w http.ResponseWriter, r *http.Request) {
	claims := authmw.ClaimsFromContext(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "unauthenticated")
		return
	}
	user, err := h.db.Users.FindByID(claims.UserID)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "user not found")
		return
	}
	roles, _ := h.db.CustomRoles.FindAll()
	writeJSON(w, http.StatusOK, map[string]any{
		"id":             user.ID,
		"username":       user.Username,
		"email":          user.Email,
		"role":           user.Role,
		"permissions":    store.EffectivePermissions(user, roles),
		"project_ids":    user.ProjectIDs,
		"oauth_subject":  user.OAuthSubject,
		"oauth_provider": user.OAuthProvider,
	})
}

// SetupStatus reports whether first-run setup has been completed.
func (h *H) SetupStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{
		"setup_required": h.db.Users.Count() == 0,
	})
}

// SetupCreate creates the initial superadmin account (only works when no users exist).
func (h *H) SetupCreate(w http.ResponseWriter, r *http.Request) {
	if h.db.Users.Count() > 0 {
		writeError(w, http.StatusConflict, "setup already completed")
		return
	}

	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Email    string `json:"email"`
	}
	if err := decodeJSON(r, &req); err != nil || req.Username == "" || req.Password == "" {
		writeError(w, http.StatusBadRequest, "username and password are required")
		return
	}

	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not hash password")
		return
	}

	now := timeNow()
	user := store.User{
		ID:           store.NewULID(),
		Username:     req.Username,
		Email:        req.Email,
		PasswordHash: hash,
		Role:         store.RoleSuperAdmin,
		CreatedAt:    now,
		UpdatedAt:    now,
		Active:       true,
	}

	if err := h.db.Users.Save(user); err != nil {
		writeError(w, http.StatusInternalServerError, "could not save user")
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"id":       user.ID,
		"username": user.Username,
		"role":     user.Role,
	})
}
