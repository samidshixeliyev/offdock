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

// LoadImage loads a .tar file into Docker and records it in the DB.
// Uses before/after image list diff so the exact newly-loaded image is captured
// regardless of docker output format differences across versions.
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

	// Snapshot existing image IDs before load.
	before, _ := h.docker.ImageList()
	beforeIDs := make(map[string]bool, len(before))
	for _, img := range before {
		beforeIDs[img.ID] = true
	}

	// Run docker load — uses context.Background() internally, immune to request cancellation.
	out, err := h.docker.LoadImage(req.TarFilePath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "docker load failed: "+err.Error())
		return
	}

	// Find newly added images by diffing the image list.
	after, _ := h.docker.ImageList()

	// Build a set of already-tracked Docker image IDs to prevent duplicates.
	existingImages, _ := h.db.Images.FindAll()
	trackedDockerIDs := make(map[string]bool, len(existingImages))
	for _, img := range existingImages {
		trackedDockerIDs[img.DockerImageID] = true
	}

	var newImages []store.DockerImage
	for _, img := range after {
		if beforeIDs[img.ID] {
			continue // existed before load
		}
		if img.Repository == "<none>" && img.Tag == "<none>" {
			continue // untagged intermediate layer artifact
		}
		if trackedDockerIDs[img.ID] {
			continue // already tracked (e.g. re-loading same tar)
		}
		name, tag := splitImageRef(img.Repository + ":" + img.Tag)
		if req.ImageName != "" {
			name = req.ImageName
		}
		if req.ImageTag != "" {
			tag = req.ImageTag
		}
		newImages = append(newImages, store.DockerImage{
			ID:            store.NewULID(),
			ProjectID:     req.ProjectID,
			ImageName:     name,
			ImageTag:      tag,
			TarFilePath:   req.TarFilePath,
			LoadedAt:      time.Now().UTC(),
			DockerImageID: img.ID,
		})
	}

	// Fallback: if diff found nothing (image was pre-loaded), parse docker output.
	if len(newImages) == 0 {
		ref := parseLoadedImageRef(out)
		name, tag := splitImageRef(ref)
		if req.ImageName != "" {
			name = req.ImageName
		}
		if req.ImageTag != "" {
			tag = req.ImageTag
		}
		if name == "" {
			name = "unknown"
		}
		newImages = append(newImages, store.DockerImage{
			ID:            store.NewULID(),
			ProjectID:     req.ProjectID,
			ImageName:     name,
			ImageTag:      tag,
			TarFilePath:   req.TarFilePath,
			LoadedAt:      time.Now().UTC(),
			DockerImageID: parseLoadedImageID(out),
		})
	}

	// Save all new images to DB.
	saved := make([]store.DockerImage, 0, len(newImages))
	for _, img := range newImages {
		if err := h.db.Images.Save(img); err == nil {
			saved = append(saved, img)
		}
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"loaded": len(saved),
		"images": saved,
	})
}

// SyncImages scans all images currently in the Docker daemon and registers
// any that are not already tracked in the OffDock database.
func (h *H) SyncImages(w http.ResponseWriter, r *http.Request) {
	dockerImages, err := h.docker.ImageList()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "docker images: "+err.Error())
		return
	}

	existing, _ := h.db.Images.FindAll()
	tracked := make(map[string]bool, len(existing))
	for _, img := range existing {
		tracked[img.DockerImageID] = true
	}

	var synced []store.DockerImage
	for _, di := range dockerImages {
		if tracked[di.ID] {
			continue
		}
		name, tag := splitImageRef(di.Repository + ":" + di.Tag)
		img := store.DockerImage{
			ID:            store.NewULID(),
			ImageName:     name,
			ImageTag:      tag,
			LoadedAt:      time.Now().UTC(),
			DockerImageID: di.ID,
		}
		if err := h.db.Images.Save(img); err == nil {
			synced = append(synced, img)
		}
	}

	if synced == nil {
		synced = []store.DockerImage{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"synced": len(synced),
		"images": synced,
	})
}

// DeleteImage removes an image from Docker and the database.
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
	h.docker.RemoveImage(ref) //nolint:errcheck — best-effort

	if err := h.db.Images.Delete(img.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "could not delete image record")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// PruneImages removes unused Docker images and reconciles the DB.
// Query param ?all=true removes ALL images not referenced by any container
// (not just dangling ones). Default: dangling only.
func (h *H) PruneImages(w http.ResponseWriter, r *http.Request) {
	all := r.URL.Query().Get("all") == "true"
	out, err := h.docker.PruneImages(all)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "prune failed: "+err.Error())
		return
	}

	// Reconcile DB: remove records for images that no longer exist in Docker.
	removed := 0
	if dbImages, err := h.db.Images.FindAll(); err == nil {
		dockerImages, _ := h.docker.ImageList()
		activeIDs := make(map[string]bool, len(dockerImages))
		for _, di := range dockerImages {
			activeIDs[di.ID] = true
		}
		for _, img := range dbImages {
			if img.DockerImageID != "" && !activeIDs[img.DockerImageID] {
				if h.db.Images.Delete(img.ID) == nil {
					removed++
				}
			}
		}
	}

	h.logAudit(r, "prune_images", "system", "", "", "")
	writeJSON(w, http.StatusOK, map[string]any{
		"output":          strings.TrimSpace(out),
		"removed_records": removed,
	})
}

// --- helpers ----------------------------------------------------------------

func splitImageRef(ref string) (name, tag string) {
	if ref == "" || ref == "<none>:<none>" {
		return "unknown", "latest"
	}
	if idx := strings.LastIndex(ref, ":"); idx > 0 {
		return ref[:idx], ref[idx+1:]
	}
	return ref, "latest"
}

func parseLoadedImageRef(output string) string {
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if after, ok := strings.CutPrefix(line, "Loaded image: "); ok {
			return strings.TrimSpace(after)
		}
	}
	return ""
}

func parseLoadedImageID(output string) string {
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if after, ok := strings.CutPrefix(line, "Loaded image ID: "); ok {
			return strings.TrimSpace(after)
		}
		if after, ok := strings.CutPrefix(line, "Loaded image: "); ok {
			return strings.TrimSpace(after)
		}
	}
	return ""
}
