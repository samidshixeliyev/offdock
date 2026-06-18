package handlers

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"offdock/internal/deploy"
	"offdock/internal/docker"
	"offdock/internal/store"
)

// ContainerLogs streams container logs via SSE using docker logs --follow.
func (h *H) ContainerLogs(w http.ResponseWriter, r *http.Request) {
	containerName := chi.URLParam(r, "name")
	tail, _ := strconv.Atoi(r.URL.Query().Get("tail"))
	if tail <= 0 {
		tail = 200
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	cmd := h.docker.Logs(ctx, containerName, tail)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		http.Error(w, "could not open log stream", http.StatusInternalServerError)
		return
	}
	cmd.Stderr = cmd.Stdout // merge stderr

	if err := cmd.Start(); err != nil {
		http.Error(w, "could not start docker logs: "+err.Error(), http.StatusInternalServerError)
		return
	}

	defer func() {
		cancel()
		cmd.Process.Kill() //nolint:errcheck
		cmd.Wait()         //nolint:errcheck — must Wait() to reap child; omitting causes zombie
	}()

	sc := bufio.NewScanner(stdout)
	for sc.Scan() {
		line := sc.Text()
		msg, _ := json.Marshal(map[string]string{"line": line})
		fmt.Fprintf(w, "data: %s\n\n", msg)
		flusher.Flush()
	}
}

// ListAllContainers returns every Docker container on the host (all projects).
func (h *H) ListAllContainers(w http.ResponseWriter, r *http.Request) {
	containers, err := h.docker.PS(r.Context(), "")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not list containers: "+err.Error())
		return
	}
	if containers == nil {
		containers = []docker.ContainerInfo{}
	}
	writeJSON(w, http.StatusOK, containers)
}

// ListContainers returns all containers for a project.
func (h *H) ListContainers(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	project, err := h.db.Projects.FindByID(projectID)
	if err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}

	containers, err := h.docker.PS(r.Context(), deploy.ComposeProjectName(project.Name))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not list containers: "+err.Error())
		return
	}
	if containers == nil {
		containers = []docker.ContainerInfo{}
	}
	writeJSON(w, http.StatusOK, containers)
}

// computeProjectStatus derives a project's status from its containers' states.
// A "restarting" (crash-looping) or "unhealthy" container makes the project
// degraded — it is NOT counted as running. This fixes the bug where a project
// with a restarting container kept showing "running".
func computeProjectStatus(containers []docker.ContainerInfo) store.ProjectStatus {
	total := len(containers)
	if total == 0 {
		return store.ProjectStatusStopped
	}
	running, unhealthy := 0, 0
	for _, c := range containers {
		switch strings.ToLower(c.State) {
		case "running":
			if strings.Contains(strings.ToLower(c.Status), "unhealthy") {
				unhealthy++
			} else {
				running++
			}
		case "restarting", "removing":
			unhealthy++
		case "dead":
			unhealthy++
		}
	}
	switch {
	case unhealthy > 0:
		return store.ProjectStatusDegraded
	case running == 0:
		return store.ProjectStatusStopped
	case running < total:
		return store.ProjectStatusDegraded
	default:
		return store.ProjectStatusRunning
	}
}

// SyncProjectStatus queries Docker and updates the project status to reflect actual container state.
func (h *H) SyncProjectStatus(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	project, err := h.db.Projects.FindByID(projectID)
	if err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}

	containers, _ := h.docker.PS(r.Context(), deploy.ComposeProjectName(project.Name))
	project.Status = computeProjectStatus(containers)
	project.UpdatedAt = timeNow()
	h.db.Projects.Save(project) //nolint:errcheck
	writeJSON(w, http.StatusOK, project)
}

// SyncAllProjectStatus refreshes every project's status from live container
// state in a single `docker ps` call, then returns the updated project list.
// This keeps the dashboard accurate without N per-project docker calls.
func (h *H) SyncAllProjectStatus(w http.ResponseWriter, r *http.Request) {
	projects, err := h.db.Projects.FindAll()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not list projects")
		return
	}

	// One docker ps for all containers, grouped by compose project label.
	all, _ := h.docker.PS(r.Context(), "")
	byProject := map[string][]docker.ContainerInfo{}
	for _, c := range all {
		if p := c.ComposeProject(); p != "" {
			byProject[p] = append(byProject[p], c)
		}
	}

	for i := range projects {
		// Match on the canonical compose project name (lowercased/sanitized),
		// which is what the deploy engine labels containers with.
		status := computeProjectStatus(byProject[deploy.ComposeProjectName(projects[i].Name)])
		if projects[i].Status != status {
			projects[i].Status = status
			projects[i].UpdatedAt = timeNow()
			h.db.Projects.Save(projects[i]) //nolint:errcheck
		}
	}
	writeJSON(w, http.StatusOK, projects)
}

// ContainerAction performs restart, stop, or start on a named container.
func (h *H) ContainerAction(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	action := chi.URLParam(r, "action")

	var err error
	switch action {
	case "restart":
		err = h.docker.RestartContainer(r.Context(), name)
	case "stop":
		err = h.docker.StopContainer(r.Context(), name)
	case "start":
		err = h.docker.StartContainer(r.Context(), name)
	default:
		writeError(w, http.StatusBadRequest, "unknown action: "+action)
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, action+" failed: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "action": action, "container": name})
}

// DeleteContainer force-removes a container by name.
func (h *H) DeleteContainer(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if err := h.docker.DeleteContainer(r.Context(), name); err != nil {
		writeError(w, http.StatusInternalServerError, "delete failed: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "container": name})
}

// ContainerStats returns a single snapshot of resource usage for all running containers.
func (h *H) ContainerStats(w http.ResponseWriter, r *http.Request) {
	stats, err := h.docker.Stats(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "stats failed: "+err.Error())
		return
	}
	if stats == nil {
		stats = []docker.ContainerStats{}
	}
	writeJSON(w, http.StatusOK, stats)
}
