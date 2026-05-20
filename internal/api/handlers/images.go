package handlers

import (
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"offdock/internal/store"
)

// ListImages returns all tracked Docker images.
func (h *H) ListImages(w http.ResponseWriter, r *http.Request) {
	images, err := h.db.Images.FindAll()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not list images")
		return
	}
	if images == nil {
		images = []store.DockerImage{}
	}
	writeJSON(w, http.StatusOK, images)
}

// LoadImage loads a .tar file into the Docker daemon and records it in the DB.
func (h *H) LoadImage(w http.ResponseWriter, r *http.Request) {
	var req struct {
		TarFilePath string `json:"tar_file_path"`
		ProjectID   string `json:"project_id"`
		ImageName   string `json:"image_name"`
		ImageTag    string `json:"image_tag"`
	}
	if err := decodeJSON(r, &req); err != nil || req.TarFilePath == "" {
		writeError(w, http.StatusBadRequest, "tar_file_path is required")
		return
	}

	out, err := h.docker.LoadImage(r.Context(), req.TarFilePath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "docker load failed: "+err.Error())
		return
	}

	// Parse the image ID from docker load output (e.g. "Loaded image ID: sha256:abc...")
	dockerImageID := parseLoadedImageID(out)
	if req.ImageName == "" {
		req.ImageName = dockerImageID
	}
	if req.ImageTag == "" {
		req.ImageTag = "latest"
	}

	img := store.DockerImage{
		ID:            store.NewULID(),
		ProjectID:     req.ProjectID,
		ImageName:     req.ImageName,
		ImageTag:      req.ImageTag,
		TarFilePath:   req.TarFilePath,
		LoadedAt:      time.Now().UTC(),
		DockerImageID: dockerImageID,
	}
	if err := h.db.Images.Save(img); err != nil {
		writeError(w, http.StatusInternalServerError, "could not record image")
		return
	}
	writeJSON(w, http.StatusCreated, img)
}

// DeleteImage removes an image from the Docker daemon and the database.
func (h *H) DeleteImage(w http.ResponseWriter, r *http.Request) {
	img, err := h.db.Images.FindByID(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusNotFound, "image not found")
		return
	}

	ref := img.ImageName + ":" + img.ImageTag
	if img.DockerImageID != "" {
		ref = img.DockerImageID
	}

	if err := h.docker.RemoveImage(r.Context(), ref); err != nil {
		// Log but don't block DB cleanup.
		_ = err
	}

	if err := h.db.Images.Delete(img.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "could not delete image record")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func parseLoadedImageID(output string) string {
	for _, line := range strings.Split(output, "\n") {
		if strings.Contains(line, "Loaded image ID:") {
			parts := strings.SplitN(line, ":", 2)
			if len(parts) == 2 {
				return strings.TrimSpace(parts[1])
			}
		}
		if strings.Contains(line, "Loaded image:") {
			parts := strings.SplitN(line, "Loaded image:", 2)
			if len(parts) == 2 {
				return strings.TrimSpace(parts[1])
			}
		}
	}
	return ""
}
