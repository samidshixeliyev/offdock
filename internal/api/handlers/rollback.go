package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"

	authmw "offdock/internal/middleware"
	"offdock/internal/store"
)

// Rollback re-deploys a project to a specific compose+env version pair, resolved
// from one of: a deploy tag, a past deployment, or explicit version numbers.
// It runs the same deploy flow as TriggerDeploy but marks the resulting record
// as a rollback for clear history.
//
// POST /api/v1/projects/{id}/rollback
//
//	{ "tag_id": "..." }                       — restore the pair a tag points at
//	{ "deployment_id": "..." }                — restore the pair a deployment used
//	{ "compose_version": N, "env_version": M } — explicit pin (0 = latest)
func (h *H) Rollback(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	claims := authmw.ClaimsFromContext(r.Context())

	project, err := h.db.Projects.FindByID(projectID)
	if err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}

	// Reject if a deployment is already running for this project.
	running, _ := h.db.Deployments.FindWhere(func(d store.DeploymentRecord) bool {
		return d.ProjectID == projectID && d.Status == store.DeployStatusRunning
	})
	if len(running) > 0 {
		writeError(w, http.StatusConflict, "a deployment is already running for this project")
		return
	}

	var req struct {
		TagID          string `json:"tag_id"`
		DeploymentID   string `json:"deployment_id"`
		ComposeVersion int    `json:"compose_version"`
		EnvVersion     int    `json:"env_version"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	composeVersion := req.ComposeVersion
	envVersion := req.EnvVersion
	rollbackOf := ""

	switch {
	case req.TagID != "":
		tag, err := h.db.DeployTags.FindByID(req.TagID)
		if err != nil || tag.ProjectID != projectID {
			writeError(w, http.StatusNotFound, "tag not found")
			return
		}
		composeVersion = tag.ComposeVersion
		envVersion = tag.EnvVersion
		rollbackOf = "tag:" + tag.Name
	case req.DeploymentID != "":
		dep, err := h.db.Deployments.FindByID(req.DeploymentID)
		if err != nil || dep.ProjectID != projectID {
			writeError(w, http.StatusNotFound, "deployment not found")
			return
		}
		composeVersion = dep.NewComposeVersion
		envVersion = dep.EnvVersion
		rollbackOf = "deployment:" + dep.ID
	default:
		rollbackOf = fmt.Sprintf("compose_v%d/env_v%d", composeVersion, envVersion)
	}

	depID := store.NewULID()
	streamKey := "deploy:" + depID

	ctx, cancel := context.WithCancel(context.Background())
	h.deployCancels.Store(streamKey, cancel)

	go func() {
		defer cancel()
		defer h.deployCancels.Delete(streamKey)

		logFn := func(line string) {
			msg, _ := json.Marshal(map[string]string{"log": line})
			h.hub.Publish(streamKey, string(msg))
		}
		rec, err := h.deployer.DeployVersion(ctx, projectID, claims.UserID, composeVersion, envVersion, logFn)
		if err != nil {
			msg, _ := json.Marshal(map[string]string{"error": err.Error()})
			h.hub.Publish(streamKey, string(msg))
		}
		if rec != nil {
			// Mark the record as a rollback for history readability.
			rec.IsRollback = true
			rec.RollbackOf = rollbackOf
			h.db.Deployments.Save(*rec) //nolint:errcheck

			statusPayload := map[string]any{
				"status":        rec.Status,
				"deployment_id": rec.ID,
				"rollback_of":   rollbackOf,
			}
			msg, _ := json.Marshal(statusPayload)
			h.hub.Publish(streamKey, string(msg))
		}
		h.hub.Close(streamKey)
	}()

	h.logAudit(r, "rollback", "project", projectID, project.Name, rollbackOf)

	writeJSON(w, http.StatusAccepted, map[string]string{
		"deployment_id": depID,
		"stream":        "/api/v1/projects/" + projectID + "/deployments/" + depID + "/stream",
	})
}
