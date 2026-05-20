package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"offdock/internal/store"
)

// ListProjects returns all projects.
func (h *H) ListProjects(w http.ResponseWriter, r *http.Request) {
	projects, err := h.db.Projects.FindAll()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not list projects")
		return
	}
	writeJSON(w, http.StatusOK, projects)
}

// CreateProject creates a new project.
func (h *H) CreateProject(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	if err := decodeJSON(r, &req); err != nil || req.Name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}

	now := timeNow()
	p := store.Project{
		ID:          store.NewULID(),
		Name:        req.Name,
		Description: req.Description,
		Status:      store.ProjectStatusStopped,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if err := h.db.Projects.Save(p); err != nil {
		writeError(w, http.StatusInternalServerError, "could not save project")
		return
	}
	writeJSON(w, http.StatusCreated, p)
}

// GetProject returns a single project by ID.
func (h *H) GetProject(w http.ResponseWriter, r *http.Request) {
	p, err := h.db.Projects.FindByID(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// UpdateProject patches name or description.
func (h *H) UpdateProject(w http.ResponseWriter, r *http.Request) {
	p, err := h.db.Projects.FindByID(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}

	var req struct {
		Name        *string `json:"name"`
		Description *string `json:"description"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request")
		return
	}
	if req.Name != nil {
		p.Name = *req.Name
	}
	if req.Description != nil {
		p.Description = *req.Description
	}
	p.UpdatedAt = timeNow()

	if err := h.db.Projects.Save(p); err != nil {
		writeError(w, http.StatusInternalServerError, "could not update project")
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// DeleteProject removes a project and all its associated data.
func (h *H) DeleteProject(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.db.Projects.Delete(id); err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
	// Best-effort cleanup of associated records.
	cleanProjectRecords(h.db, id)
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func cleanProjectRecords(db *store.DB, projectID string) {
	clean := func(ids []string, delFn func(string) error) {
		for _, id := range ids {
			delFn(id) //nolint:errcheck
		}
	}

	if cfgs, _ := db.Compose.FindWhere(func(c store.ComposeConfig) bool { return c.ProjectID == projectID }); len(cfgs) > 0 {
		ids := make([]string, len(cfgs))
		for i, c := range cfgs { ids[i] = c.ID }
		clean(ids, db.Compose.Delete)
	}
	if sets, _ := db.EnvVars.FindWhere(func(e store.EnvVarSet) bool { return e.ProjectID == projectID }); len(sets) > 0 {
		ids := make([]string, len(sets))
		for i, s := range sets { ids[i] = s.ID }
		clean(ids, db.EnvVars.Delete)
	}
}
