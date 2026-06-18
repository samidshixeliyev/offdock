package handlers

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	authmw "offdock/internal/middleware"
	"offdock/internal/store"
)

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
		Protected      bool   `json:"protected"`
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

	// Reject duplicate tag names within the same project.
	existingTags, _ := h.db.DeployTags.FindWhere(func(t store.DeployTag) bool {
		return t.ProjectID == projectID && strings.EqualFold(t.Name, req.Name)
	})
	if len(existingTags) > 0 {
		writeError(w, http.StatusConflict, "a tag with this name already exists — choose a different name")
		return
	}

	tag := store.DeployTag{
		ID:             store.NewULID(),
		ProjectID:      projectID,
		Name:           req.Name,
		Description:    req.Description,
		ComposeVersion: req.ComposeVersion,
		EnvVersion:     req.EnvVersion,
		Protected:      req.Protected,
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

// ToggleTagProtected flips the Protected flag on a tag so it is (or is not)
// exempt from auto-tag trimming.
func (h *H) ToggleTagProtected(w http.ResponseWriter, r *http.Request) {
	tagID := chi.URLParam(r, "tag_id")
	tag, err := h.db.DeployTags.FindByID(tagID)
	if err != nil {
		writeError(w, http.StatusNotFound, "tag not found")
		return
	}
	tag.Protected = !tag.Protected
	if err := h.db.DeployTags.Save(tag); err != nil {
		writeError(w, http.StatusInternalServerError, "could not update tag")
		return
	}
	writeJSON(w, http.StatusOK, tag)
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
