package handlers

import (
	"encoding/json"
	"net/http"
	"sort"

	"github.com/go-chi/chi/v5"

	authmw "offdock/internal/middleware"
	"offdock/internal/store"
)

// TriggerDeploy starts an async deployment and returns an SSE stream URL.
func (h *H) TriggerDeploy(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	claims := authmw.ClaimsFromContext(r.Context())

	if _, err := h.db.Projects.FindByID(projectID); err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}

	depID := store.NewULID()
	streamKey := "deploy:" + depID

	go func() {
		logFn := func(line string) {
			msg, _ := json.Marshal(map[string]string{"log": line})
			h.hub.Publish(streamKey, string(msg))
		}
		rec, err := h.deployer.Deploy(r.Context(), projectID, claims.UserID, logFn)
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
