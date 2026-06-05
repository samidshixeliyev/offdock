package handlers

import (
	"net/http"
	"sort"

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
	h.logAudit(r, "create_project", "project", p.ID, p.Name, "")
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
	h.logAudit(r, "delete_project", "project", id, "", "")
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// CloneProject creates a new project by copying the name, latest compose
// config, and latest env vars from an existing source project.
func (h *H) CloneProject(w http.ResponseWriter, r *http.Request) {
	srcID := chi.URLParam(r, "id")
	src, err := h.db.Projects.FindByID(srcID)
	if err != nil {
		writeError(w, http.StatusNotFound, "source project not found")
		return
	}

	var req struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	if err := decodeJSON(r, &req); err != nil || req.Name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}

	desc := req.Description
	if desc == "" {
		desc = "Cloned from " + src.Name
	}
	now := timeNow()
	dst := store.Project{
		ID:          store.NewULID(),
		Name:        req.Name,
		Description: desc,
		Status:      store.ProjectStatusStopped,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if err := h.db.Projects.Save(dst); err != nil {
		writeError(w, http.StatusInternalServerError, "could not save project")
		return
	}

	// Copy latest compose config.
	if composes, _ := h.db.Compose.FindWhere(func(c store.ComposeConfig) bool {
		return c.ProjectID == srcID
	}); len(composes) > 0 {
		sort.Slice(composes, func(i, j int) bool { return composes[i].Version > composes[j].Version })
		c := composes[0]
		c.ID = store.NewULID()
		c.ProjectID = dst.ID
		c.Version = 1
		c.CreatedAt = now
		h.db.Compose.Save(c) //nolint:errcheck
	}

	// Copy latest env vars.
	if envs, _ := h.db.EnvVars.FindWhere(func(v store.EnvVarSet) bool {
		return v.ProjectID == srcID
	}); len(envs) > 0 {
		sort.Slice(envs, func(i, j int) bool { return envs[i].Version > envs[j].Version })
		e := envs[0]
		e.ID = store.NewULID()
		e.ProjectID = dst.ID
		e.Version = 1
		e.CreatedAt = now
		h.db.EnvVars.Save(e) //nolint:errcheck
	}

	h.logAudit(r, "clone_project", "project", dst.ID, dst.Name, "cloned_from:"+src.Name)
	writeJSON(w, http.StatusCreated, dst)
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
