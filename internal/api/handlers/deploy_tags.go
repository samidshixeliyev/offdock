package handlers

import (
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/go-chi/chi/v5"
	authmw "offdock/internal/middleware"
	"offdock/internal/store"
)

// trimAutoTags keeps only the most recent `keep` auto-generated tags (name
// prefixed "deploy-") for a project, deleting the oldest beyond that to avoid
// list clutter. Errors are best-effort — trimming never blocks a deploy.
func (h *H) trimAutoTags(projectID string, keep int) {
	tags, err := h.db.DeployTags.FindWhere(func(t store.DeployTag) bool {
		return t.ProjectID == projectID && strings.HasPrefix(t.Name, "deploy-")
	})
	if err != nil || len(tags) <= keep {
		return
	}
	sort.Slice(tags, func(i, j int) bool { return tags[i].CreatedAt.After(tags[j].CreatedAt) })
	for _, t := range tags[keep:] {
		h.db.DeployTags.Delete(t.ID) //nolint:errcheck
	}
}

// ListDeployTags returns all tags for a project.
func (h *H) ListDeployTags(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	tags, err := h.db.DeployTags.FindWhere(func(t store.DeployTag) bool {
		return t.ProjectID == projectID
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not list tags")
		return
	}
	if tags == nil {
		tags = []store.DeployTag{}
	}
	writeJSON(w, http.StatusOK, tags)
}

// CreateDeployTag creates a named tag for a specific compose+env version pair.
func (h *H) CreateDeployTag(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	claims := authmw.ClaimsFromContext(r.Context())

	var req struct {
		Name           string `json:"name"`
		Description    string `json:"description"`
		ComposeVersion int    `json:"compose_version"`
		EnvVersion     int    `json:"env_version"`
	}
	if err := decodeJSON(r, &req); err != nil || req.Name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}

	// Verify compose version exists.
	if req.ComposeVersion > 0 {
		cv, _ := h.db.Compose.FindWhere(func(c store.ComposeConfig) bool {
			return c.ProjectID == projectID && c.Version == req.ComposeVersion
		})
		if len(cv) == 0 {
			writeError(w, http.StatusBadRequest, "compose version not found")
			return
		}
	}

	// Verify env version exists.
	if req.EnvVersion > 0 {
		ev, _ := h.db.EnvVars.FindWhere(func(v store.EnvVarSet) bool {
			return v.ProjectID == projectID && v.Version == req.EnvVersion
		})
		if len(ev) == 0 {
			writeError(w, http.StatusBadRequest, "env version not found")
			return
		}
	}

	tag := store.DeployTag{
		ID:             store.NewULID(),
		ProjectID:      projectID,
		Name:           req.Name,
		Description:    req.Description,
		ComposeVersion: req.ComposeVersion,
		EnvVersion:     req.EnvVersion,
		CreatedBy:      claims.Username,
		CreatedAt:      timeNow(),
	}
	if err := h.db.DeployTags.Save(tag); err != nil {
		writeError(w, http.StatusInternalServerError, "could not save tag")
		return
	}
	h.logAudit(r, "create_deploy_tag", "project", projectID, req.Name,
		"compose_v"+itoa(req.ComposeVersion)+" env_v"+itoa(req.EnvVersion))
	writeJSON(w, http.StatusCreated, tag)
}

// DeleteDeployTag removes a deploy tag.
func (h *H) DeleteDeployTag(w http.ResponseWriter, r *http.Request) {
	tagID := chi.URLParam(r, "tag_id")
	if err := h.db.DeployTags.Delete(tagID); err != nil {
		writeError(w, http.StatusNotFound, "tag not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func itoa(n int) string {
	if n == 0 {
		return "latest"
	}
	return fmt.Sprintf("%d", n)
}
