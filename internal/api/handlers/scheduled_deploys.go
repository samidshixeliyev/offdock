package handlers

import (
	"net/http"
	"sort"
	"time"

	"github.com/go-chi/chi/v5"

	authmw "offdock/internal/middleware"
	"offdock/internal/store"
)

// ListScheduledDeploys returns a project's scheduled deploys, newest run-time first.
func (h *H) ListScheduledDeploys(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	items, _ := h.db.ScheduledDeploys.FindWhere(func(s store.ScheduledDeploy) bool {
		return s.ProjectID == projectID
	})
	if items == nil {
		items = []store.ScheduledDeploy{}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].RunAt.After(items[j].RunAt) })
	writeJSON(w, http.StatusOK, items)
}

// CreateScheduledDeploy queues a one-shot deploy for a future time.
func (h *H) CreateScheduledDeploy(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	project, err := h.db.Projects.FindByID(projectID)
	if err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
	claims := authmw.ClaimsFromContext(r.Context())

	var req struct {
		RunAt          time.Time `json:"run_at"`
		ComposeVersion int       `json:"compose_version"`
		EnvVersion     int       `json:"env_version"`
		TagID          string    `json:"tag_id"`
		Note           string    `json:"note"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.RunAt.IsZero() {
		writeError(w, http.StatusBadRequest, "run_at is required")
		return
	}
	if req.RunAt.Before(time.Now().Add(-time.Minute)) {
		writeError(w, http.StatusBadRequest, "run_at must be in the future")
		return
	}
	if req.TagID != "" {
		if tag, terr := h.db.DeployTags.FindByID(req.TagID); terr != nil || tag.ProjectID != projectID {
			writeError(w, http.StatusNotFound, "tag not found")
			return
		}
	}

	sd := store.ScheduledDeploy{
		ID:             store.NewULID(),
		ProjectID:      projectID,
		RunAt:          req.RunAt.UTC(),
		ComposeVersion: req.ComposeVersion,
		EnvVersion:     req.EnvVersion,
		TagID:          req.TagID,
		Note:           req.Note,
		Status:         "pending",
		CreatedBy:      claims.Username,
		CreatedAt:      time.Now().UTC(),
	}
	if err := h.db.ScheduledDeploys.Save(sd); err != nil {
		writeError(w, http.StatusInternalServerError, "could not save schedule")
		return
	}
	h.logAudit(r, "schedule_deploy", "project", projectID, project.Name, sd.RunAt.Format(time.RFC3339))
	writeJSON(w, http.StatusCreated, sd)
}

// DeleteScheduledDeploy cancels/removes a scheduled deploy.
func (h *H) DeleteScheduledDeploy(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	id := chi.URLParam(r, "sched_id")
	sd, err := h.db.ScheduledDeploys.FindByID(id)
	if err != nil || sd.ProjectID != projectID {
		writeError(w, http.StatusNotFound, "schedule not found")
		return
	}
	if err := h.db.ScheduledDeploys.Delete(id); err != nil {
		writeError(w, http.StatusInternalServerError, "could not delete schedule")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
