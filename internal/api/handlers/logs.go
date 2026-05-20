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

	go func() {
		<-ctx.Done()
		cmd.Process.Kill() //nolint:errcheck
	}()

	sc := bufio.NewScanner(stdout)
	for sc.Scan() {
		line := sc.Text()
		msg, _ := json.Marshal(map[string]string{"line": line})
		fmt.Fprintf(w, "data: %s\n\n", msg)
		flusher.Flush()
	}
}

// ListContainers returns all containers for a project.
func (h *H) ListContainers(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	project, err := h.db.Projects.FindByID(projectID)
	if err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}

	containers, err := h.docker.PS(r.Context(), project.Name)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not list containers: "+err.Error())
		return
	}
	if containers == nil {
		containers = []docker.ContainerInfo{}
	}
	writeJSON(w, http.StatusOK, containers)
}

// SyncProjectStatus queries Docker and updates the project status to reflect actual container state.
func (h *H) SyncProjectStatus(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	project, err := h.db.Projects.FindByID(projectID)
	if err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}

	containers, _ := h.docker.PS(r.Context(), project.Name)
	total := len(containers)
	running := 0
	for _, c := range containers {
		if strings.ToLower(c.State) == "running" {
			running++
		}
	}

	switch {
	case total == 0:
		project.Status = store.ProjectStatusStopped
	case running == 0:
		project.Status = store.ProjectStatusStopped
	case running < total:
		project.Status = store.ProjectStatusDegraded
	default:
		project.Status = store.ProjectStatusRunning
	}
	project.UpdatedAt = timeNow()
	h.db.Projects.Save(project) //nolint:errcheck
	writeJSON(w, http.StatusOK, project)
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
