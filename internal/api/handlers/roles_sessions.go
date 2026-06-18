package handlers

import (
	"net/http"
	"sort"

	"github.com/go-chi/chi/v5"

	authmw "offdock/internal/middleware"
	"offdock/internal/store"
)

// ─── Permission catalog ─────────────────────────────────────────────────────

// ListPermissions returns the catalog of grantable capabilities (for the UI).
func (h *H) ListPermissions(w http.ResponseWriter, r *http.Request) {
	type permInfo struct {
		Key   store.Permission `json:"key"`
		Label string           `json:"label"`
	}
	labels := map[store.Permission]string{
		store.PermManageProjects: "Manage projects",
		store.PermDeploy:         "Deploy",
		store.PermEditCompose:    "Edit compose",
		store.PermEditEnv:        "Edit env vars",
		store.PermManageProxy:    "Manage reverse proxy",
		store.PermManageNetwork:  "Manage networks & volumes",
		store.PermManageImages:   "Manage images",
		store.PermContainerOps:   "Container operations",
		store.PermTerminal:       "Terminal / exec",
		store.PermManageFiles:    "Manage files",
		store.PermManageDNS:      "Manage DNS tickets",
	}
	out := make([]permInfo, 0, len(store.AllPermissions))
	for _, p := range store.AllPermissions {
		out = append(out, permInfo{Key: p, Label: labels[p]})
	}
	writeJSON(w, http.StatusOK, out)
}

// ─── Custom roles CRUD (superadmin) ─────────────────────────────────────────

func (h *H) ListCustomRoles(w http.ResponseWriter, r *http.Request) {
	roles, err := h.db.CustomRoles.FindAll()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not list roles")
		return
	}
	if roles == nil {
		roles = []store.CustomRole{}
	}
	sort.Slice(roles, func(i, j int) bool { return roles[i].Name < roles[j].Name })
	writeJSON(w, http.StatusOK, roles)
}

func (h *H) CreateCustomRole(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name        string             `json:"name"`
		Permissions []store.Permission `json:"permissions"`
	}
	if err := decodeJSON(r, &req); err != nil || req.Name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	now := timeNow()
	role := store.CustomRole{
		ID:          store.NewULID(),
		Name:        req.Name,
		Permissions: req.Permissions,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if err := h.db.CustomRoles.Save(role); err != nil {
		writeError(w, http.StatusInternalServerError, "could not save role")
		return
	}
	h.logAudit(r, "create_role", "role", role.ID, role.Name, "")
	writeJSON(w, http.StatusCreated, role)
}

func (h *H) UpdateCustomRole(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	role, err := h.db.CustomRoles.FindByID(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "role not found")
		return
	}
	var req struct {
		Name        *string             `json:"name"`
		Permissions *[]store.Permission `json:"permissions"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request")
		return
	}
	if req.Name != nil {
		role.Name = *req.Name
	}
	if req.Permissions != nil {
		role.Permissions = *req.Permissions
	}
	role.UpdatedAt = timeNow()
	if err := h.db.CustomRoles.Save(role); err != nil {
		writeError(w, http.StatusInternalServerError, "could not update role")
		return
	}
	h.logAudit(r, "update_role", "role", role.ID, role.Name, "")
	writeJSON(w, http.StatusOK, role)
}

func (h *H) DeleteCustomRole(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.db.CustomRoles.Delete(id); err != nil {
		writeError(w, http.StatusNotFound, "role not found")
		return
	}
	// Detach the role from any users referencing it.
	users, _ := h.db.Users.FindWhere(func(u store.User) bool { return u.CustomRoleID == id })
	for _, u := range users {
		u.CustomRoleID = ""
		u.UpdatedAt = timeNow()
		h.db.Users.Save(u) //nolint:errcheck
	}
	h.logAudit(r, "delete_role", "role", id, "", "")
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// ─── Sessions ────────────────────────────────────────────────────────────────

// ListSessions returns active (non-revoked, recent) sessions. superadmin sees
// all; other users see only their own.
func (h *H) ListSessions(w http.ResponseWriter, r *http.Request) {
	claims := authmw.ClaimsFromContext(r.Context())
	all, err := h.db.Sessions.FindAll()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not list sessions")
		return
	}
	userFilter := r.URL.Query().Get("user_id")
	out := make([]store.Session, 0, len(all))
	for _, s := range all {
		if s.Revoked {
			continue
		}
		if claims.Role != store.RoleSuperAdmin && s.UserID != claims.UserID {
			continue
		}
		if userFilter != "" && s.UserID != userFilter {
			continue
		}
		// Never expose the captured OIDC id_token to clients — it is a sensitive
		// credential persisted only so OAuthLogout can send id_token_hint.
		s.IDToken = ""
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].LastSeen.After(out[j].LastSeen) })
	writeJSON(w, http.StatusOK, out)
}

// RevokeSession marks a session revoked (remote logout). superadmin may revoke
// any; others only their own.
func (h *H) RevokeSession(w http.ResponseWriter, r *http.Request) {
	claims := authmw.ClaimsFromContext(r.Context())
	id := chi.URLParam(r, "id")
	sess, err := h.db.Sessions.FindByID(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "session not found")
		return
	}
	if claims.Role != store.RoleSuperAdmin && sess.UserID != claims.UserID {
		writeError(w, http.StatusForbidden, "forbidden")
		return
	}
	sess.Revoked = true
	if err := h.db.Sessions.Save(sess); err != nil {
		writeError(w, http.StatusInternalServerError, "could not revoke session")
		return
	}
	h.logAudit(r, "revoke_session", "session", id, sess.Username, "")
	writeJSON(w, http.StatusOK, map[string]string{"status": "revoked"})
}

// UserAudit returns recent audit events for a single user (superadmin only via route).
func (h *H) UserAudit(w http.ResponseWriter, r *http.Request) {
	userID := chi.URLParam(r, "id")
	events, err := h.db.AuditEvents.FindWhere(func(e store.AuditEvent) bool {
		return e.UserID == userID
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not fetch audit")
		return
	}
	sort.Slice(events, func(i, j int) bool { return events[i].CreatedAt.After(events[j].CreatedAt) })
	if len(events) > 200 {
		events = events[:200]
	}
	if events == nil {
		events = []store.AuditEvent{}
	}
	writeJSON(w, http.StatusOK, events)
}
