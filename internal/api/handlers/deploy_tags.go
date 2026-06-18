package handlers

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"offdock/internal/deploy"
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

	// Capture the exact image each running service uses (sha256:…) so the tag can
	// be re-deployed with those exact images (true image rollback). Best-effort —
	// a tag is still useful (compose+env) even if images can't be read.
	var pins map[string]string
	if proj, err := h.db.Projects.FindByID(projectID); err == nil {
		pctx, pcancel := context.WithTimeout(r.Context(), 15*time.Second)
		pins, _ = h.docker.ProjectServiceImages(pctx, deploy.ComposeProjectName(proj.Name))
		pcancel()
	}

	tag := store.DeployTag{
		ID:             store.NewULID(),
		ProjectID:      projectID,
		Name:           req.Name,
		Description:    req.Description,
		ComposeVersion: req.ComposeVersion,
		EnvVersion:     req.EnvVersion,
		Protected:      req.Protected,
		ImagePins:      pins,
		CreatedBy:      claims.Username,
		CreatedAt:      timeNow(),
	}
	if err := h.db.DeployTags.Save(tag); err != nil {
		writeError(w, http.StatusInternalServerError, "could not save tag")
		return
	}

	// Apply the per-project tag-retention policy (keep last N non-protected tags).
	if sets, _ := h.db.DeploySettings.FindWhere(func(s store.DeploySettings) bool {
		return s.ProjectID == projectID
	}); len(sets) > 0 && sets[0].TagRetention > 0 {
		h.trimTagsByRetention(projectID, sets[0].TagRetention)
	}

	h.logAudit(r, "create_deploy_tag", "project", projectID, req.Name,
		"compose_v"+itoa(req.ComposeVersion)+" env_v"+itoa(req.EnvVersion)+" pins="+itoa(len(pins)))
	writeJSON(w, http.StatusCreated, tag)
}

// trimTagsByRetention deletes the oldest non-protected tags beyond `keep` for a
// project. Protected tags are never counted toward the limit or deleted.
func (h *H) trimTagsByRetention(projectID string, keep int) {
	tags, err := h.db.DeployTags.FindWhere(func(t store.DeployTag) bool {
		return t.ProjectID == projectID && !t.Protected
	})
	if err != nil || len(tags) <= keep {
		return
	}
	sort.Slice(tags, func(i, j int) bool { return tags[i].CreatedAt.After(tags[j].CreatedAt) })
	for _, t := range tags[keep:] {
		h.db.DeployTags.Delete(t.ID) //nolint:errcheck
	}
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
