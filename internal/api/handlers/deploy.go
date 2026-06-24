package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	authmw "offdock/internal/middleware"
	"offdock/internal/deploy"
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
		ComposeVersion int    `json:"compose_version"`
		EnvVersion     int    `json:"env_version"`
		TagID          string `json:"tag_id"`
	}
	// Ignore decode errors — body is optional.
	decodeJSON(r, &req) //nolint:errcheck

	depID := store.NewULID()
	streamKey := "deploy:" + depID
	composeVersion := req.ComposeVersion // 0 = latest
	envVersion := req.EnvVersion         // 0 = latest

	// Deploying a tag: use the tag's recorded compose/env versions and pin the
	// exact images it captured (true image rollback).
	var imagePins map[string]string
	if req.TagID != "" {
		tag, terr := h.db.DeployTags.FindByID(req.TagID)
		if terr != nil || tag.ProjectID != projectID {
			writeError(w, http.StatusNotFound, "tag not found")
			return
		}
		composeVersion = tag.ComposeVersion
		envVersion = tag.EnvVersion
		imagePins = tag.ImagePins
	}

	ctx, cancel := context.WithCancel(context.Background())
	h.deployCancels.Store(streamKey, cancel)

	go func() {
		defer cancel()
		defer h.deployCancels.Delete(streamKey)

		logFn := func(line string) {
			msg, _ := json.Marshal(map[string]string{"log": line})
			h.hub.Publish(streamKey, string(msg))
		}
		rec, err := h.deployer.DeployVersion(ctx, projectID, claims.UserID, depID, composeVersion, envVersion, imagePins, logFn)
		if err != nil {
			msg, _ := json.Marshal(map[string]string{"error": err.Error()})
			h.hub.Publish(streamKey, string(msg))
		}
		if rec != nil {
			// Tags are created MANUALLY only (GitLab-style) — no auto-tagging on
			// deploy. The UI offers a one-click "tag last successful deploy" that
			// calls POST /deploy-tags with the deployed compose+env versions.
			statusPayload := map[string]any{
				"status":        rec.Status,
				"deployment_id": rec.ID,
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

// DeployDiff previews what a deploy will change vs the currently-running version:
// env var add/remove/change (secret values masked) and compose YAML before/after.
// Query: compose_version, env_version (0 = latest target).
func (h *H) DeployDiff(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	if _, err := h.db.Projects.FindByID(projectID); err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
	q := r.URL.Query()
	targetCompose, _ := strconv.Atoi(q.Get("compose_version"))
	targetEnv, _ := strconv.Atoi(q.Get("env_version"))

	// Current = last successful deployment's versions (what's live).
	deps, _ := h.db.Deployments.FindWhere(func(d store.DeploymentRecord) bool {
		return d.ProjectID == projectID && d.Status == store.DeployStatusSuccess
	})
	sort.Slice(deps, func(i, j int) bool { return deps[i].StartedAt.After(deps[j].StartedAt) })
	curCompose, curEnv := 0, 0
	if len(deps) > 0 {
		curCompose = deps[0].NewComposeVersion
		curEnv = deps[0].EnvVersion
	}

	composes, _ := h.db.Compose.FindWhere(func(c store.ComposeConfig) bool { return c.ProjectID == projectID })
	pickCompose := func(ver int) *store.ComposeConfig {
		var latest *store.ComposeConfig
		for i := range composes {
			if ver > 0 && composes[i].Version == ver {
				return &composes[i]
			}
			if latest == nil || composes[i].Version > latest.Version {
				latest = &composes[i]
			}
		}
		return latest
	}
	tgtC, curC := pickCompose(targetCompose), pickCompose(curCompose)
	tgtYAML, curYAML := "", ""
	if tgtC != nil {
		tgtYAML = tgtC.RawYAML
	}
	if curC != nil && curCompose > 0 {
		curYAML = curC.RawYAML
	}

	// Env diff (decrypt to compare; mask secret values).
	envs, _ := h.db.EnvVars.FindWhere(func(v store.EnvVarSet) bool { return v.ProjectID == projectID })
	pickEnv := func(ver int) *store.EnvVarSet {
		var latest *store.EnvVarSet
		for i := range envs {
			if ver > 0 && envs[i].Version == ver {
				return &envs[i]
			}
			if latest == nil || envs[i].Version > latest.Version {
				latest = &envs[i]
			}
		}
		return latest
	}
	toMap := func(set *store.EnvVarSet) (map[string]string, map[string]bool) {
		vals := map[string]string{}
		secret := map[string]bool{}
		if set == nil {
			return vals, secret
		}
		for _, v := range set.Vars {
			p, err := h.enc.Decrypt(v.Value)
			if err != nil {
				p = ""
			}
			vals[v.Key] = p
			secret[v.Key] = v.IsSecret
		}
		return vals, secret
	}
	curVals, curSec := toMap(pickEnv(curEnv))
	if curEnv == 0 {
		curVals, curSec = map[string]string{}, map[string]bool{}
	}
	tgtVals, tgtSec := toMap(pickEnv(targetEnv))
	mask := func(key, val string, secret bool) string {
		if secret {
			return "••••••••"
		}
		_ = key
		return val
	}
	type envChange struct {
		Key string `json:"key"`
		Old string `json:"old,omitempty"`
		New string `json:"new,omitempty"`
	}
	added, removed, changed := []envChange{}, []envChange{}, []envChange{}
	for k, nv := range tgtVals {
		if ov, ok := curVals[k]; !ok {
			added = append(added, envChange{Key: k, New: mask(k, nv, tgtSec[k])})
		} else if ov != nv {
			changed = append(changed, envChange{Key: k, Old: mask(k, ov, curSec[k]), New: mask(k, nv, tgtSec[k])})
		}
	}
	for k, ov := range curVals {
		if _, ok := tgtVals[k]; !ok {
			removed = append(removed, envChange{Key: k, Old: mask(k, ov, curSec[k])})
		}
	}
	sortByKey := func(s []envChange) { sort.Slice(s, func(i, j int) bool { return s[i].Key < s[j].Key }) }
	sortByKey(added)
	sortByKey(removed)
	sortByKey(changed)

	writeJSON(w, http.StatusOK, map[string]any{
		"current":        map[string]int{"compose_version": curCompose, "env_version": curEnv},
		"target":         map[string]int{"compose_version": targetCompose, "env_version": targetEnv},
		"compose_changed": strings.TrimSpace(tgtYAML) != strings.TrimSpace(curYAML),
		"compose_current": curYAML,
		"compose_target":  tgtYAML,
		"env_added":       added,
		"env_removed":     removed,
		"env_changed":     changed,
		"first_deploy":    len(deps) == 0,
	})
}

// DeployMetrics returns aggregate deployment analytics for a project:
// totals by status, success rate, average/median duration, MTTR (mean time to
// recovery), deploy frequency, and the current streak.
func (h *H) DeployMetrics(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	if _, err := h.db.Projects.FindByID(projectID); err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
	deps, _ := h.db.Deployments.FindWhere(func(d store.DeploymentRecord) bool {
		return d.ProjectID == projectID
	})
	sort.Slice(deps, func(i, j int) bool { return deps[i].StartedAt.Before(deps[j].StartedAt) })

	var success, failed, cancelled, rollbacks int
	var durs []float64 // seconds, finished deploys only
	now := time.Now()
	var last7, last30 int
	for _, d := range deps {
		switch d.Status {
		case store.DeployStatusSuccess:
			success++
		case store.DeployStatusFailed:
			failed++
		case store.DeployStatusCancelled:
			cancelled++
		}
		if d.IsRollback {
			rollbacks++
		}
		if d.FinishedAt != nil {
			durs = append(durs, d.FinishedAt.Sub(d.StartedAt).Seconds())
		}
		if now.Sub(d.StartedAt) <= 7*24*time.Hour {
			last7++
		}
		if now.Sub(d.StartedAt) <= 30*24*time.Hour {
			last30++
		}
	}
	total := len(deps)
	finished := success + failed + cancelled
	var successRate float64
	if finished > 0 {
		successRate = float64(success) / float64(finished) * 100
	}

	// Duration stats.
	var avgDur, medDur, maxDur float64
	if len(durs) > 0 {
		sorted := append([]float64(nil), durs...)
		sort.Float64s(sorted)
		var sum float64
		for _, v := range sorted {
			sum += v
		}
		avgDur = sum / float64(len(sorted))
		medDur = sorted[len(sorted)/2]
		maxDur = sorted[len(sorted)-1]
	}

	// MTTR: mean gap from a failed deploy to the next successful one.
	var recoveries []float64
	for i := 0; i < len(deps); i++ {
		if deps[i].Status != store.DeployStatusFailed || deps[i].FinishedAt == nil {
			continue
		}
		for j := i + 1; j < len(deps); j++ {
			if deps[j].Status == store.DeployStatusSuccess && deps[j].FinishedAt != nil {
				recoveries = append(recoveries, deps[j].FinishedAt.Sub(*deps[i].FinishedAt).Seconds())
				break
			}
		}
	}
	var mttr float64
	if len(recoveries) > 0 {
		var sum float64
		for _, v := range recoveries {
			sum += v
		}
		mttr = sum / float64(len(recoveries))
	}

	// Current streak: consecutive same-status outcomes from the newest end.
	streak := 0
	streakKind := ""
	for i := len(deps) - 1; i >= 0; i-- {
		s := string(deps[i].Status)
		if s != string(store.DeployStatusSuccess) && s != string(store.DeployStatusFailed) {
			continue
		}
		if streakKind == "" {
			streakKind = s
			streak = 1
		} else if s == streakKind {
			streak++
		} else {
			break
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"total":          total,
		"success":        success,
		"failed":         failed,
		"cancelled":      cancelled,
		"rollbacks":      rollbacks,
		"success_rate":   successRate,
		"avg_duration_s": avgDur,
		"med_duration_s": medDur,
		"max_duration_s": maxDur,
		"mttr_s":         mttr,
		"deploys_7d":     last7,
		"deploys_30d":    last30,
		"streak":         streak,
		"streak_kind":    streakKind,
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

// CancelDeploy signals a running deployment to stop. The engine uses a
// direct in-place `--force-recreate` strategy (no _next stack), so on cancel the
// goroutine marks the record cancelled and — if RollbackOnFailure is enabled —
// the engine restores and health-verifies the previous good version. Otherwise
// the stack is left as-is and a warning is logged so the operator can redeploy.
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

// GetComposeServices parses the project's current compose file and returns
// per-service metadata: name, image, and auto-detected language runtimes.
// Used by the Deploy settings page to populate the OTel language picker.
func (h *H) GetComposeServices(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	if _, err := h.db.Projects.FindByID(projectID); err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
	composePath := filepath.Join(h.projectsDir, projectID, "docker-compose.yml")
	services, err := deploy.ParseComposeServices(composePath)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"services": []any{}})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"services": services})
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
