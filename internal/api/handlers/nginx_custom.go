package handlers

import (
	"net/http"
	"regexp"
	"strings"

	"github.com/go-chi/chi/v5"

	authmw "offdock/internal/middleware"
	nginxpkg "offdock/internal/nginx"
	"offdock/internal/store"
)

var nginxCustomNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,48}$`)

// ListNginxCustom returns all custom nginx configs (raw operator-authored blocks).
func (h *H) ListNginxCustom(w http.ResponseWriter, r *http.Request) {
	cfgs, err := h.db.NginxCustom.FindAll()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not list custom configs")
		return
	}
	if cfgs == nil {
		cfgs = []store.NginxCustomConfig{}
	}
	writeJSON(w, http.StatusOK, cfgs)
}

// ListAllNginxConfigs returns every OffDock-managed nginx config file on disk
// (project + proxy-host + self vhosts and custom http/stream) so the operator
// can see and review everything nginx is serving in one place.
func (h *H) ListAllNginxConfigs(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"configs": nginxpkg.ListManagedConfigs()})
}

// SaveNginxCustom creates or updates a custom nginx config, writes it to disk,
// validates with `nginx -t`, and reloads. A failing config is rolled back.
func (h *H) SaveNginxCustom(w http.ResponseWriter, r *http.Request) {
	claims := authmw.ClaimsFromContext(r.Context())
	var req struct {
		ID      string `json:"id"`
		Name    string `json:"name"`
		Kind    string `json:"kind"`
		Content string `json:"content"`
		Enabled bool   `json:"enabled"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request")
		return
	}
	req.Name = strings.ToLower(strings.TrimSpace(req.Name))
	if !nginxCustomNameRe.MatchString(req.Name) {
		writeError(w, http.StatusBadRequest, "name must be lowercase letters, digits and dashes (max 49 chars)")
		return
	}
	if req.Kind != "http" && req.Kind != "stream" {
		writeError(w, http.StatusBadRequest, "kind must be \"http\" or \"stream\"")
		return
	}
	if strings.TrimSpace(req.Content) == "" {
		writeError(w, http.StatusBadRequest, "content is required")
		return
	}

	if !nginxpkg.SystemAvailable() {
		writeError(w, http.StatusUnprocessableEntity, "nginx is not installed on this host")
		return
	}

	now := timeNow()
	cfg := store.NginxCustomConfig{
		ID:        req.ID,
		Name:      req.Name,
		Kind:      req.Kind,
		Content:   req.Content,
		Enabled:   req.Enabled,
		CreatedBy: claims.Username,
		UpdatedAt: now,
	}
	if cfg.ID == "" {
		// New: reject duplicate name within the same kind.
		existing, _ := h.db.NginxCustom.FindWhere(func(c store.NginxCustomConfig) bool {
			return c.Name == req.Name && c.Kind == req.Kind
		})
		if len(existing) > 0 {
			writeError(w, http.StatusConflict, "a "+req.Kind+" config named "+req.Name+" already exists")
			return
		}
		cfg.ID = store.NewULID()
		cfg.CreatedAt = now
	} else if prev, err := h.db.NginxCustom.FindByID(cfg.ID); err == nil {
		cfg.CreatedAt = prev.CreatedAt
		// If the operator renamed/changed kind, clean up the old file first.
		if prev.Name != cfg.Name || prev.Kind != cfg.Kind {
			nginxpkg.RemoveCustom(prev.Name, prev.Kind) //nolint:errcheck
		}
	}

	// Apply to disk + validate + reload. A bad config is rolled back inside Apply.
	if _, err := nginxpkg.ApplyCustom(cfg); err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	if err := h.db.NginxCustom.Save(cfg); err != nil {
		writeError(w, http.StatusInternalServerError, "could not save config record")
		return
	}
	h.logAudit(r, "save_nginx_custom", "nginx", cfg.ID, cfg.Name, cfg.Kind)
	writeJSON(w, http.StatusOK, cfg)
}

// DeleteNginxCustom removes a custom nginx config (file + DB record) and reloads.
func (h *H) DeleteNginxCustom(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	cfg, err := h.db.NginxCustom.FindByID(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "config not found")
		return
	}
	nginxpkg.RemoveCustom(cfg.Name, cfg.Kind) //nolint:errcheck — best-effort + reload
	if err := h.db.NginxCustom.Delete(id); err != nil {
		writeError(w, http.StatusInternalServerError, "could not delete config")
		return
	}
	h.logAudit(r, "delete_nginx_custom", "nginx", id, cfg.Name, cfg.Kind)
	w.WriteHeader(http.StatusNoContent)
}
