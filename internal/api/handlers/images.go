package handlers

import (
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"offdock/internal/docker"
	"offdock/internal/store"
)

// resolveImageID maps a container's .Image reference (repo:tag, repo@sha256:…,
// or a bare image ID / short-ID prefix) to a concrete docker image ID using the
// daemon's image list. Returns "" when it can't be resolved. This is the correct
// way to decide image usage — comparing a container's ref string against image
// IDs directly does not work (refs are repo:tag, IDs are hashes).
func resolveImageID(ref string, images []docker.ImageSummary, byTag map[string]string) string {
	if ref == "" {
		return ""
	}
	if id, ok := byTag[ref]; ok {
		return id
	}
	bare := strings.TrimPrefix(ref, "sha256:")
	for _, img := range images {
		idBare := strings.TrimPrefix(img.ID, "sha256:")
		if img.ID == ref || idBare == bare {
			return img.ID
		}
		// Container started by short ID prefix (docker run a1b2c3d4e5f6).
		if len(bare) >= 8 && (strings.HasPrefix(idBare, bare) || strings.HasPrefix(bare, idBare)) {
			return img.ID
		}
	}
	return ""
}

// imageUsageMap returns imageID → container names that run that image, resolving
// each container's image reference to a real image ID.
func imageUsageMap(containers []docker.ContainerInfo, images []docker.ImageSummary) map[string][]string {
	byTag := map[string]string{}
	for _, img := range images {
		if img.Repository != "" && img.Repository != "<none>" && img.Tag != "" && img.Tag != "<none>" {
			byTag[img.Repository+":"+img.Tag] = img.ID
		}
	}
	usage := map[string][]string{}
	for _, c := range containers {
		if id := resolveImageID(c.Image, images, byTag); id != "" {
			usage[id] = append(usage[id], c.Names)
		}
	}
	return usage
}

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

// ImageUsage returns every image in the Docker daemon annotated with whether it
// is used by any container (running OR stopped) and by which containers, plus
// the OffDock DB record id (if tracked) for deletion. Lets the UI surface images
// that are safe to delete (unused) vs. in-use.
func (h *H) ImageUsage(w http.ResponseWriter, r *http.Request) {
	images, err := h.docker.ImageList()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "docker images: "+err.Error())
		return
	}
	// If we cannot enumerate containers we MUST NOT report images as unused —
	// that would invite a mass-delete of in-use images. Fail loudly instead.
	containers, err := h.docker.PS(r.Context(), "") // all containers (-a)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not determine image usage (docker ps failed): "+err.Error())
		return
	}

	usage := imageUsageMap(containers, images)

	// Build a DB lookup: docker image ID → OffDock record id.
	dbImages, _ := h.db.Images.FindAll()
	dbByDockerID := map[string]store.DockerImage{}
	for _, di := range dbImages {
		if di.DockerImageID != "" {
			dbByDockerID[di.DockerImageID] = di
		}
	}

	type imageUsage struct {
		ImageID    string   `json:"image_id"`
		Repository string   `json:"repository"`
		Tag        string   `json:"tag"`
		Size       string   `json:"size"`
		CreatedAt  string   `json:"created_at"`
		InUse      bool     `json:"in_use"`
		UsedBy     []string `json:"used_by"`
		Tracked    bool     `json:"tracked"`
		DBID       string   `json:"db_id"`
	}

	out := make([]imageUsage, 0, len(images))
	inUseCount := 0
	for _, img := range images {
		names := dedupStrings(usage[img.ID])
		iu := imageUsage{
			ImageID:    img.ID,
			Repository: img.Repository,
			Tag:        img.Tag,
			Size:       img.Size,
			CreatedAt:  img.CreatedAt,
			InUse:      len(names) > 0,
			UsedBy:     names,
		}
		if rec, ok := dbByDockerID[img.ID]; ok {
			iu.Tracked = true
			iu.DBID = rec.ID
		}
		if iu.InUse {
			inUseCount++
		}
		out = append(out, iu)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"images":       out,
		"total":        len(out),
		"in_use":       inUseCount,
		"unused":       len(out) - inUseCount,
	})
}

func dedupStrings(in []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, s := range in {
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
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

// RemoveImageByRef force-removes a Docker image by repository:tag or image ID,
// reconciling any matching OffDock DB record. Used by the image-usage view where
// not every image is tracked in the DB. Refuses if the image is in use by a
// container unless force=true. The UI requires typing the image ref to confirm.
func (h *H) RemoveImageByRef(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Ref     string `json:"ref"`      // repository:tag or image ID
		ImageID string `json:"image_id"` // optional explicit docker image ID
		Force   bool   `json:"force"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request")
		return
	}
	target := strings.TrimSpace(req.ImageID)
	if target == "" {
		target = strings.TrimSpace(req.Ref)
	}
	if target == "" {
		writeError(w, http.StatusBadRequest, "ref or image_id is required")
		return
	}

	// Resolve the target to a concrete image ID so the in-use guard and DB
	// reconcile compare image identity, not raw ref strings.
	images, _ := h.docker.ImageList()
	byTag := map[string]string{}
	for _, img := range images {
		if img.Repository != "" && img.Repository != "<none>" && img.Tag != "" && img.Tag != "<none>" {
			byTag[img.Repository+":"+img.Tag] = img.ID
		}
	}
	targetID := req.ImageID
	if targetID == "" {
		targetID = resolveImageID(req.Ref, images, byTag)
	}

	// Guard: refuse to remove an image still referenced by a container (running
	// OR stopped) unless force=true. We must be able to enumerate containers to
	// make this guarantee — if docker ps fails, refuse rather than risk it.
	if !req.Force {
		containers, psErr := h.docker.PS(r.Context(), "")
		if psErr != nil {
			writeError(w, http.StatusInternalServerError,
				"could not verify image is unused (docker ps failed) — retry, or force delete: "+psErr.Error())
			return
		}
		usage := imageUsageMap(containers, images)
		var users []string
		if targetID != "" {
			users = usage[targetID]
		}
		// Also match a container whose ref equals the requested ref directly.
		for _, c := range containers {
			if req.Ref != "" && c.Image == req.Ref {
				users = append(users, c.Names)
			}
		}
		if len(dedupStrings(users)) > 0 {
			writeError(w, http.StatusConflict,
				"image is in use by: "+strings.Join(dedupStrings(users), ", ")+" — stop/remove them first, or force delete")
			return
		}
	}

	if err := h.docker.RemoveImage(target); err != nil {
		writeError(w, http.StatusInternalServerError, "docker rmi failed: "+err.Error())
		return
	}

	// Reconcile DB: drop any record pointing at this image (by resolved ID or ref).
	if dbImages, err := h.db.Images.FindAll(); err == nil {
		for _, img := range dbImages {
			if (targetID != "" && img.DockerImageID == targetID) ||
				img.DockerImageID == req.ImageID ||
				img.ImageName+":"+img.ImageTag == req.Ref ||
				img.ImageName+":"+img.ImageTag == target {
				h.db.Images.Delete(img.ID) //nolint:errcheck
			}
		}
	}
	h.logAudit(r, "delete_image", "image", targetID, req.Ref, "")
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
