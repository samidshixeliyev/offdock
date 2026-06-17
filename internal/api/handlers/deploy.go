package handlers

import (
	"context"
	"encoding/json"
	"fmt"
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

	// Build project name map once instead of one query per deployment.
	projects, _ := h.db.Projects.FindAll()
	nameByID := make(map[string]string, len(projects))
	for _, p := range projects {
		nameByID[p.ID] = p.Name
	}

	type enriched struct {
		store.DeploymentRecord
		ProjectName string `json:"project_name"`
	}
	result := make([]enriched, 0, len(all))
	for _, d := range all {
		result = append(result, enriched{DeploymentRecord: d, ProjectName: nameByID[d.ProjectID]})
	}
	writeJSON(w, http.StatusOK, result)
}

// TriggerDeploy starts an async deployment and returns an SSE stream URL.
// Optional body: { "compose_version": N } — if omitted, the latest version is used (rollback support).
func (h *H) TriggerDeploy(w http.ResponseWriter, r *http.Request) {
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
		ComposeVersion int `json:"compose_version"`
		EnvVersion     int `json:"env_version"`
	}
	// Ignore decode errors — body is optional.
	decodeJSON(r, &req) //nolint:errcheck

	depID := store.NewULID()
	streamKey := "deploy:" + depID
	composeVersion := req.ComposeVersion // 0 = latest
	envVersion := req.EnvVersion         // 0 = latest

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
			// Auto-create a deploy tag for every successful deployment (like GitLab pipeline tags).
			if rec.Status == store.DeployStatusSuccess {
				tagName := fmt.Sprintf("deploy-%s", timeNow().Format("2006-01-02-150405"))
				tag := store.DeployTag{
					ID:             store.NewULID(),
					ProjectID:      projectID,
					Name:           tagName,
					Description:    fmt.Sprintf("Auto-tagged from deployment by %s", claims.Username),
					ComposeVersion: rec.NewComposeVersion,
					EnvVersion:     rec.EnvVersion,
					CreatedBy:      claims.Username,
					CreatedAt:      timeNow(),
				}
				h.db.DeployTags.Save(tag) //nolint:errcheck
				h.trimAutoTags(projectID, 20)
			}
			statusPayload := map[string]any{
				"status":        rec.Status,
				"deployment_id": rec.ID,
			}
			if rec.Status == store.DeployStatusSuccess {
				statusPayload["tag"] = fmt.Sprintf("deploy-%s", rec.StartedAt.Format("2006-01-02-150405"))
			}
			msg, _ := json.Marshal(statusPayload)
			h.hub.Publish(streamKey, string(msg))
		}
		h.hub.Close(streamKey)
	}()

	h.logAudit(r, "deploy_triggered", "project", projectID, project.Name, fmt.Sprintf("compose_v%d env_v%d", composeVersion, envVersion))

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

// CancelDeploy signals a running deployment to stop.
// The deploy goroutine will clean up the _next stack and mark the record as cancelled.
func (h *H) CancelDeploy(w http.ResponseWriter, r *http.Request) {
	depID := chi.URLParam(r, "dep_id")
	streamKey := "deploy:" + depID
	v, ok := h.deployCancels.Load(streamKey)
	if !ok {
		writeError(w, http.StatusNotFound, "no active deployment with that id")
		return
	}
	v.(context.CancelFunc)()
	writeJSON(w, http.StatusOK, map[string]string{"status": "cancelling"})
}

// GetDeploySettings returns the deploy settings for a project, with defaults filled in.
func (h *H) GetDeploySettings(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	if _, err := h.db.Projects.FindByID(projectID); err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
	sets, _ := h.db.DeploySettings.FindWhere(func(s store.DeploySettings) bool {
		return s.ProjectID == projectID
	})
	if len(sets) > 0 {
		s := sets[0]
		if s.HealthTimeoutSecs <= 0 { s.HealthTimeoutSecs = 120 }
		if s.DeployTimeoutSecs <= 0 { s.DeployTimeoutSecs = 300 }
		if s.HealthStableSecs <= 0 { s.HealthStableSecs = 5 }
		writeJSON(w, http.StatusOK, s)
		return
	}
	writeJSON(w, http.StatusOK, store.DeploySettings{
		ID: projectID, ProjectID: projectID,
		HealthTimeoutSecs: 120, DeployTimeoutSecs: 300, HealthStableSecs: 5,
	})
}

// SaveDeploySettings creates or replaces the deploy settings for a project.
func (h *H) SaveDeploySettings(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	if _, err := h.db.Projects.FindByID(projectID); err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
	var s store.DeploySettings
	if err := decodeJSON(r, &s); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	if s.HealthTimeoutSecs <= 0 { s.HealthTimeoutSecs = 120 }
	if s.DeployTimeoutSecs <= 0 { s.DeployTimeoutSecs = 300 }
	if s.HealthStableSecs <= 0 { s.HealthStableSecs = 5 }
	// The overall deploy timeout must leave room for the health check, otherwise
	// the deploy context cancels mid-health and a healthy stack is reported as
	// cancelled. Require a 30s buffer above the health timeout.
	if s.DeployTimeoutSecs < s.HealthTimeoutSecs+30 {
		writeError(w, http.StatusBadRequest,
			fmt.Sprintf("deploy_timeout_secs (%d) must be at least 30s greater than health_timeout_secs (%d)",
				s.DeployTimeoutSecs, s.HealthTimeoutSecs))
		return
	}
	s.ID = projectID
	s.ProjectID = projectID
	if err := h.db.DeploySettings.Save(s); err != nil {
		writeError(w, http.StatusInternalServerError, "could not save settings")
		return
	}
	writeJSON(w, http.StatusOK, s)
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
