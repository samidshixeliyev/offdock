package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"

	"github.com/go-chi/chi/v5"

	authmw "offdock/internal/middleware"
	"offdock/internal/store"
)

// ListAllDeployments returns the 25 most recent deployments across all projects, enriched with project name.
func (h *H) ListAllDeployments(w http.ResponseWriter, r *http.Request) {
	all, err := h.db.Deployments.FindAll()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not list deployments")
		return
	}
	sort.Slice(all, func(i, j int) bool { return all[i].StartedAt.After(all[j].StartedAt) })
	if len(all) > 25 {
		all = all[:25]
	}

	type enriched struct {
		store.DeploymentRecord
		ProjectName string `json:"project_name"`
	}
	result := make([]enriched, 0, len(all))
	for _, d := range all {
		name := ""
		if p, err := h.db.Projects.FindByID(d.ProjectID); err == nil {
			name = p.Name
		}
		result = append(result, enriched{DeploymentRecord: d, ProjectName: name})
	}
	writeJSON(w, http.StatusOK, result)
}

// TriggerDeploy starts an async deployment and returns an SSE stream URL.
// Optional body: { "compose_version": N } — if omitted, the latest version is used (rollback support).
func (h *H) TriggerDeploy(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	claims := authmw.ClaimsFromContext(r.Context())

	if _, err := h.db.Projects.FindByID(projectID); err != nil {
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
		ComposeVersion int `json:"compose_version"`
	}
	// Ignore decode errors — body is optional.
	decodeJSON(r, &req) //nolint:errcheck

	depID := store.NewULID()
	streamKey := "deploy:" + depID
	composeVersion := req.ComposeVersion // 0 means use latest

	go func() {
		logFn := func(line string) {
			msg, _ := json.Marshal(map[string]string{"log": line})
			h.hub.Publish(streamKey, string(msg))
		}
		rec, err := h.deployer.DeployVersion(context.Background(), projectID, claims.UserID, composeVersion, logFn)
		if err != nil {
			msg, _ := json.Marshal(map[string]string{"error": err.Error()})
			h.hub.Publish(streamKey, string(msg))
		}
		if rec != nil {
			msg, _ := json.Marshal(map[string]any{"status": rec.Status, "deployment_id": rec.ID})
			h.hub.Publish(streamKey, string(msg))
		}
		h.hub.Close(streamKey)
	}()

	writeJSON(w, http.StatusAccepted, map[string]string{
		"deployment_id": depID,
		"stream":        "/api/v1/projects/" + projectID + "/deployments/" + depID + "/stream",
	})
}

// ListDeployments returns all deployments for a project, newest first.
func (h *H) ListDeployments(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	deps, err := h.db.Deployments.FindWhere(func(d store.DeploymentRecord) bool {
		return d.ProjectID == projectID
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not list deployments")
		return
	}
	if deps == nil {
		deps = []store.DeploymentRecord{}
	}
	sort.Slice(deps, func(i, j int) bool { return deps[i].StartedAt.After(deps[j].StartedAt) })
	writeJSON(w, http.StatusOK, deps)
}

// GetDeployment returns a single deployment record by ID.
func (h *H) GetDeployment(w http.ResponseWriter, r *http.Request) {
	dep, err := h.db.Deployments.FindByID(chi.URLParam(r, "dep_id"))
	if err != nil {
		writeError(w, http.StatusNotFound, "deployment not found")
		return
	}
	writeJSON(w, http.StatusOK, dep)
}

// DeployStream is an SSE endpoint that streams live deployment log lines.
func (h *H) DeployStream(w http.ResponseWriter, r *http.Request) {
	depID := chi.URLParam(r, "dep_id")
	h.hub.Subscribe(w, r, "deploy:"+depID)
}

// DeleteDeployment removes a deployment record. Running/pending deployments cannot be deleted.
func (h *H) DeleteDeployment(w http.ResponseWriter, r *http.Request) {
	depID := chi.URLParam(r, "dep_id")
	dep, err := h.db.Deployments.FindByID(depID)
	if err != nil {
		writeError(w, http.StatusNotFound, "deployment not found")
		return
	}
	if dep.Status == store.DeployStatusRunning || dep.Status == store.DeployStatusPending {
		writeError(w, http.StatusConflict, "cannot delete a running deployment")
		return
	}
	if err := h.db.Deployments.Delete(depID); err != nil {
		writeError(w, http.StatusInternalServerError, "could not delete deployment")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
