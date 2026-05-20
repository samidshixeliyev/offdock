package handlers

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
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

// ListContainers returns all running containers for a project.
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
	writeJSON(w, http.StatusOK, containers)
}
