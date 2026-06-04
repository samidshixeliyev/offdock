package handlers

import (
	"net/http"
	"sort"

	"github.com/go-chi/chi/v5"

	authmw "offdock/internal/middleware"
	"offdock/internal/store"
)

// GetCompose returns the latest compose config for a project.
func (h *H) GetCompose(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	cfgs, err := h.db.Compose.FindWhere(func(c store.ComposeConfig) bool {
		return c.ProjectID == projectID
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not fetch compose configs")
		return
	}
	if len(cfgs) == 0 {
		writeJSON(w, http.StatusOK, nil)
		return
	}
	sort.Slice(cfgs, func(i, j int) bool { return cfgs[i].Version > cfgs[j].Version })
	writeJSON(w, http.StatusOK, cfgs[0])
}

// SaveCompose stores a new compose config version for a project.
func (h *H) SaveCompose(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	claims := authmw.ClaimsFromContext(r.Context())

	var req struct {
		RawYAML string `json:"raw_yaml"`
	}
	if err := decodeJSON(r, &req); err != nil || req.RawYAML == "" {
		writeError(w, http.StatusBadRequest, "raw_yaml is required")
		return
	}

	// Determine next version number.
	existing, _ := h.db.Compose.FindWhere(func(c store.ComposeConfig) bool {
		return c.ProjectID == projectID
	})
	version := 1
	for _, c := range existing {
		if c.Version >= version {
			version = c.Version + 1
		}
	}

	cfg := store.ComposeConfig{
		ID:        store.NewULID(),
		ProjectID: projectID,
		Version:   version,
		RawYAML:   req.RawYAML,
		CreatedAt: timeNow(),
		CreatedBy: claims.UserID,
	}
	if err := h.db.Compose.Save(cfg); err != nil {
		writeError(w, http.StatusInternalServerError, "could not save compose config")
		return
	}
	writeJSON(w, http.StatusCreated, cfg)
}

// ComposeHistory returns all compose config versions for a project, newest first.
func (h *H) ComposeHistory(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	cfgs, err := h.db.Compose.FindWhere(func(c store.ComposeConfig) bool {
		return c.ProjectID == projectID
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not fetch compose history")
		return
	}
	sort.Slice(cfgs, func(i, j int) bool { return cfgs[i].Version > cfgs[j].Version })
	writeJSON(w, http.StatusOK, cfgs)
}
