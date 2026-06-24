package handlers

import (
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	authmw "offdock/internal/middleware"
	"offdock/internal/store"
)

// DeleteComposeVersion deletes a single historical compose version. Guards:
// refuses the latest version (it is what deploys use), the only version, and any
// version referenced by a deploy tag (the tag must be deleted first).
func (h *H) DeleteComposeVersion(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	ver, err := strconv.Atoi(chi.URLParam(r, "version"))
	if err != nil || ver <= 0 {
		writeError(w, http.StatusBadRequest, "invalid version")
		return
	}
	all, _ := h.db.Compose.FindWhere(func(c store.ComposeConfig) bool { return c.ProjectID == projectID })
	if len(all) <= 1 {
		writeError(w, http.StatusConflict, "cannot delete the only compose version")
		return
	}
	var target *store.ComposeConfig
	latest := 0
	for i := range all {
		if all[i].Version > latest {
			latest = all[i].Version
		}
		if all[i].Version == ver {
			target = &all[i]
		}
	}
	if target == nil {
		writeError(w, http.StatusNotFound, "compose version not found")
		return
	}
	if ver == latest {
		writeError(w, http.StatusConflict, "cannot delete the latest compose version (it is what deploys use)")
		return
	}
	tags, _ := h.db.DeployTags.FindWhere(func(t store.DeployTag) bool {
		return t.ProjectID == projectID && t.ComposeVersion == ver
	})
	if len(tags) > 0 {
		names := make([]string, 0, len(tags))
		for _, t := range tags {
			names = append(names, t.Name)
		}
		writeError(w, http.StatusConflict, "compose v"+strconv.Itoa(ver)+" is referenced by tag(s): "+strings.Join(names, ", ")+" — delete those tags first")
		return
	}
	// Protect versions still referenced by deployment history so a
	// "roll back to this deployment" never hits a missing version.
	deps, _ := h.db.Deployments.FindWhere(func(d store.DeploymentRecord) bool {
		return d.ProjectID == projectID && d.NewComposeVersion == ver
	})
	if len(deps) > 0 {
		writeError(w, http.StatusConflict, "compose v"+strconv.Itoa(ver)+" is used by "+strconv.Itoa(len(deps))+" deployment record(s) — delete those from the history first to keep rollback valid")
		return
	}
	if err := h.db.Compose.Delete(target.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "could not delete compose version")
		return
	}
	h.logAudit(r, "delete_compose_version", "project", projectID, "v"+strconv.Itoa(ver), "")
	w.WriteHeader(http.StatusNoContent)
}

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

	// Determine next version number and the current latest version.
	existing, _ := h.db.Compose.FindWhere(func(c store.ComposeConfig) bool {
		return c.ProjectID == projectID
	})
	version := 1
	var latest *store.ComposeConfig
	for i := range existing {
		c := existing[i]
		if c.Version >= version {
			version = c.Version + 1
		}
		if latest == nil || c.Version > latest.Version {
			latest = &existing[i]
		}
	}

	hash := composeContentHash(req.RawYAML)

	// Dedup: if the incoming content matches the latest version, don't create a
	// new version. Backfill the hash on the legacy record if it was empty.
	if latest != nil {
		latestHash := latest.ContentHash
		if latestHash == "" {
			latestHash = composeContentHash(latest.RawYAML)
		}
		if latestHash == hash {
			if latest.ContentHash == "" {
				latest.ContentHash = hash
				_ = h.db.Compose.Save(*latest)
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"unchanged": true,
				"config":    *latest,
			})
			return
		}
	}

	cfg := store.ComposeConfig{
		ID:          store.NewULID(),
		ProjectID:   projectID,
		Version:     version,
		RawYAML:     req.RawYAML,
		ContentHash: hash,
		CreatedAt:   timeNow(),
		CreatedBy:   claims.UserID,
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
