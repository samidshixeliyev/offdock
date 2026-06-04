package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

// ListVolumes returns all Docker volumes.
func (h *H) ListVolumes(w http.ResponseWriter, r *http.Request) {
	vols, err := h.docker.ListVolumes(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, vols)
}

// CreateVolume creates a new Docker volume.
func (h *H) CreateVolume(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name   string `json:"name"`
		Driver string `json:"driver"`
	}
	if err := decodeJSON(r, &req); err != nil || req.Name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	vol, err := h.docker.CreateVolume(r.Context(), req.Name, req.Driver)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, vol)
}

// DeleteVolume removes a Docker volume by name.
func (h *H) DeleteVolume(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if err := h.docker.DeleteVolume(r.Context(), name); err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// PruneVolumes removes all unused Docker volumes.
func (h *H) PruneVolumes(w http.ResponseWriter, r *http.Request) {
	names, space, err := h.docker.PruneVolumes(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if names == nil {
		names = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"pruned":          names,
		"space_reclaimed": space,
	})
}
