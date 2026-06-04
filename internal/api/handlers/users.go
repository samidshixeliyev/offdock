package handlers

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	authmw "offdock/internal/middleware"
	"offdock/internal/auth"
	"offdock/internal/store"
)

func timeNow() time.Time { return time.Now().UTC() }

// ListUsers returns all users (superadmin sees all; admin/viewer see only themselves).
func (h *H) ListUsers(w http.ResponseWriter, r *http.Request) {
	claims := authmw.ClaimsFromContext(r.Context())
	all, err := h.db.Users.FindAll()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not list users")
		return
	}

	if claims.Role != store.RoleSuperAdmin {
		for _, u := range all {
			if u.ID == claims.UserID {
				writeJSON(w, http.StatusOK, []any{safeUser(u)})
				return
			}
		}
		writeJSON(w, http.StatusOK, []any{})
		return
	}

	out := make([]any, 0, len(all))
	for _, u := range all {
		out = append(out, safeUser(u))
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateUser creates a new user account.  Only superadmin may call this.
func (h *H) CreateUser(w http.ResponseWriter, r *http.Request) {
	claims := authmw.ClaimsFromContext(r.Context())

	var req struct {
		Username     string             `json:"username"`
		Email        string             `json:"email"`
		Password     string             `json:"password"`
		Role         store.Role         `json:"role"`
		CustomRoleID string             `json:"custom_role_id"`
		Permissions  []store.Permission `json:"permissions"`
		ProjectIDs   []string           `json:"project_ids"`
	}
	if err := decodeJSON(r, &req); err != nil || req.Username == "" || req.Password == "" {
		writeError(w, http.StatusBadRequest, "username, password, and role are required")
		return
	}

	if req.Role == "" {
		req.Role = store.RoleViewer
	}

	// Superadmin can only be created by themselves (not demoted to admin).
	if req.Role == store.RoleSuperAdmin && claims.Role != store.RoleSuperAdmin {
		writeError(w, http.StatusForbidden, "cannot create superadmin")
		return
	}

	existing, _ := h.db.Users.FindWhere(func(u store.User) bool {
		return u.Username == req.Username
	})
	if len(existing) > 0 {
		writeError(w, http.StatusConflict, "username already exists")
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
		Role:         req.Role,
		CustomRoleID: req.CustomRoleID,
		Permissions:  req.Permissions,
		ProjectIDs:   req.ProjectIDs,
		CreatedBy:    claims.UserID,
		CreatedAt:    now,
		UpdatedAt:    now,
		Active:       true,
	}
	if err := h.db.Users.Save(user); err != nil {
		writeError(w, http.StatusInternalServerError, "could not save user")
		return
	}
	h.logAudit(r, "create_user", "user", user.ID, user.Username, string(user.Role))
	writeJSON(w, http.StatusCreated, safeUser(user))
}

// UpdateUser patches a user's role or active status.
func (h *H) UpdateUser(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	user, err := h.db.Users.FindByID(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "user not found")
		return
	}

	var req struct {
		Role         *store.Role         `json:"role"`
		Email        *string             `json:"email"`
		Active       *bool               `json:"active"`
		CustomRoleID *string             `json:"custom_role_id"`
		Permissions  *[]store.Permission `json:"permissions"`
		ProjectIDs   *[]string           `json:"project_ids"`
		Password     *string             `json:"password"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request")
		return
	}

	if req.Role != nil {
		user.Role = *req.Role
	}
	if req.Email != nil {
		user.Email = *req.Email
	}
	if req.Active != nil {
		user.Active = *req.Active
	}
	if req.CustomRoleID != nil {
		user.CustomRoleID = *req.CustomRoleID
	}
	if req.Permissions != nil {
		user.Permissions = *req.Permissions
	}
	if req.ProjectIDs != nil {
		user.ProjectIDs = *req.ProjectIDs
	}
	if req.Password != nil && *req.Password != "" {
		if hash, err := auth.HashPassword(*req.Password); err == nil {
			user.PasswordHash = hash
		}
	}
	user.UpdatedAt = timeNow()

	if err := h.db.Users.Save(user); err != nil {
		writeError(w, http.StatusInternalServerError, "could not update user")
		return
	}
	h.logAudit(r, "update_user", "user", id, "", "")
	writeJSON(w, http.StatusOK, safeUser(user))
}

// DeleteUser removes a user account.
func (h *H) DeleteUser(w http.ResponseWriter, r *http.Request) {
	claims := authmw.ClaimsFromContext(r.Context())
	id := chi.URLParam(r, "id")

	if id == claims.UserID {
		writeError(w, http.StatusBadRequest, "cannot delete yourself")
		return
	}

	if err := h.db.Users.Delete(id); err != nil {
		writeError(w, http.StatusNotFound, "user not found")
		return
	}
	h.logAudit(r, "delete_user", "user", id, "", "")
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func safeUser(u store.User) map[string]any {
	perms := u.Permissions
	if perms == nil {
		perms = []store.Permission{}
	}
	pids := u.ProjectIDs
	if pids == nil {
		pids = []string{}
	}
	return map[string]any{
		"id":             u.ID,
		"username":       u.Username,
		"email":          u.Email,
		"role":           u.Role,
		"custom_role_id": u.CustomRoleID,
		"permissions":    perms,
		"project_ids":    pids,
		"created_by":     u.CreatedBy,
		"created_at":     u.CreatedAt,
		"updated_at":     u.UpdatedAt,
		"active":         u.Active,
	}
}
