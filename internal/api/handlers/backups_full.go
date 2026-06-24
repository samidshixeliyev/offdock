package handlers

import (
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/go-chi/chi/v5"

	"offdock/internal/backup"
	"offdock/internal/deploy"
	authmw "offdock/internal/middleware"
	"offdock/internal/store"
)

const defaultConfigPath = "/etc/offdock/config.yaml"

// backupsDir returns the directory where backup archives are stored.
func (h *H) backupsDir() string {
	return filepath.Join(filepath.Dir(h.dataDir), "backups")
}

// backupBuilder constructs a backup.Builder from handler state.
func (h *H) backupBuilder() *backup.Builder {
	base := filepath.Dir(h.dataDir)
	return &backup.Builder{
		DataDir:     h.dataDir,
		ProjectsDir: h.projectsDir,
		CertsDir:    filepath.Join(base, "certs"),
		ConfigPath:  defaultConfigPath,
		NginxAvail:  "/etc/nginx/sites-available",
		Docker:      h.docker,
		Enc:         h.enc,
	}
}

// trackedImageRefs returns the name:tag of tracked Docker images to export with a
// backup. For project scope only that project's images are included; otherwise
// all tracked images. Refs missing a name are skipped (cannot `docker save`).
func (h *H) trackedImageRefs(scope, projectID string) []string {
	images, _ := h.db.Images.FindAll()
	refs := make([]string, 0, len(images))
	seen := map[string]bool{}
	for _, img := range images {
		if scope == "project" && projectID != "" && img.ProjectID != projectID {
			continue
		}
		if img.ImageName == "" || img.ImageName == "unknown" || img.ImageName == "<none>" {
			continue
		}
		tag := img.ImageTag
		if tag == "" {
			tag = "latest"
		}
		ref := img.ImageName + ":" + tag
		if seen[ref] {
			continue
		}
		seen[ref] = true
		refs = append(refs, ref)
	}
	return refs
}

// CreateBackup builds a new backup archive and records it.
// POST /api/v1/system/backups  {scope, project_id, include_volumes, include_config, encrypt}
func (h *H) CreateBackup(w http.ResponseWriter, r *http.Request) {
	claims := authmw.ClaimsFromContext(r.Context())
	var req struct {
		Scope          string `json:"scope"`
		ProjectID      string `json:"project_id"`
		IncludeVolumes bool   `json:"include_volumes"`
		IncludeConfig  bool   `json:"include_config"`
		IncludeImages  bool   `json:"include_images"`
		Encrypt        bool   `json:"encrypt"`
	}
	_ = decodeJSON(r, &req)
	if req.Scope == "" {
		req.Scope = "full"
	}

	opts := backup.Options{
		Scope:          req.Scope,
		ProjectID:      req.ProjectID,
		IncludeVolumes: req.IncludeVolumes,
		IncludeConfig:  req.IncludeConfig,
		IncludeImages:  req.IncludeImages,
		Encrypt:        req.Encrypt,
	}
	if req.IncludeImages {
		opts.ImageRefs = h.trackedImageRefs(req.Scope, req.ProjectID)
	}
	// For project scope, derive the docker compose volume prefix.
	if req.Scope == "project" && req.ProjectID != "" {
		if proj, err := h.db.Projects.FindByID(req.ProjectID); err == nil {
			opts.VolumePrefix = deploy.ComposeProjectName(proj.Name) + "_"
		}
	}

	id := store.NewULID()
	outPath := filepath.Join(h.backupsDir(), "offdock-backup-"+id+".tar.gz")

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Minute)
	defer cancel()
	result, err := h.backupBuilder().Create(ctx, outPath, opts)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "backup failed: "+err.Error())
		return
	}

	rec := store.BackupRecord{
		ID:          id,
		CreatedAt:   time.Now().UTC(),
		Scope:       req.Scope,
		ProjectID:   req.ProjectID,
		Path:        result.Path,
		SizeBytes:   result.Size,
		Contents:    result.Contents,
		Volumes:     result.Volumes,
		Images:      result.Images,
		Encrypted:   result.Encrypted,
		Sensitive:   result.Sensitive,
		TriggeredBy: claims.Username,
		Status:      result.Status,
		Note:        result.Note,
	}
	if err := h.db.Backups.Save(rec); err != nil {
		writeError(w, http.StatusInternalServerError, "could not record backup")
		return
	}
	h.logAudit(r, "backup_create", "system", id, req.Scope, result.Status)
	writeJSON(w, http.StatusCreated, rec)
}

// ListBackups returns all backup records, newest first.
func (h *H) ListBackups(w http.ResponseWriter, r *http.Request) {
	recs, _ := h.db.Backups.FindAll()
	sortByCreatedDesc(recs)
	if recs == nil {
		recs = []store.BackupRecord{}
	}
	writeJSON(w, http.StatusOK, recs)
}

// DownloadBackupFile streams a stored backup archive.
func (h *H) DownloadBackupFile(w http.ResponseWriter, r *http.Request) {
	rec, err := h.db.Backups.FindByID(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusNotFound, "backup not found")
		return
	}
	f, err := os.Open(rec.Path)
	if err != nil {
		writeError(w, http.StatusNotFound, "archive file missing on disk")
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filepath.Base(rec.Path)+`"`)
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, f)
	h.logAudit(r, "backup_download", "system", rec.ID, "", "")
}

// DeleteBackup removes a backup record and its archive file.
func (h *H) DeleteBackup(w http.ResponseWriter, r *http.Request) {
	rec, err := h.db.Backups.FindByID(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusNotFound, "backup not found")
		return
	}
	_ = os.Remove(rec.Path)
	if err := h.db.Backups.Delete(rec.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "could not delete record")
		return
	}
	h.logAudit(r, "backup_delete", "system", rec.ID, "", "")
	w.WriteHeader(http.StatusNoContent)
}

// InspectBackup returns the dry-run restore plan for a stored backup.
// GET /api/v1/system/backups/{id}/inspect
func (h *H) InspectBackup(w http.ResponseWriter, r *http.Request) {
	rec, err := h.db.Backups.FindByID(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusNotFound, "backup not found")
		return
	}
	plan, err := h.backupBuilder().Inspect(rec.Path)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "inspect failed: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, plan)
}

// RestoreBackup restores selected categories from a stored backup.
// POST /api/v1/system/backups/{id}/restore  {volumes, projects, config, db, nginx, certs}
func (h *H) RestoreBackup(w http.ResponseWriter, r *http.Request) {
	rec, err := h.db.Backups.FindByID(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusNotFound, "backup not found")
		return
	}
	var opts backup.RestoreOptions
	if err := decodeJSON(r, &opts); err != nil {
		writeError(w, http.StatusBadRequest, "invalid options")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Minute)
	defer cancel()
	result, err := h.backupBuilder().Restore(ctx, rec.Path, opts)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "restore failed: "+err.Error())
		return
	}
	h.logAudit(r, "backup_restore", "system", rec.ID, "", "")
	// If projects/volumes were restored, reconcile to bring them up.
	resp := map[string]any{"result": result}
	if result.RestoredDB {
		resp["warning"] = "Database files were restored on disk. Restart OffDock for the changes to take effect."
	}
	writeJSON(w, http.StatusOK, resp)
}

// GetBackupSchedule returns the current schedule (defaults if unset).
func (h *H) GetBackupSchedule(w http.ResponseWriter, r *http.Request) {
	s, err := h.db.BackupSchedule.FindByID("default")
	if err != nil {
		writeJSON(w, http.StatusOK, store.BackupSchedule{ID: "default", TimeOfDay: "03:00", Scope: "full", Retention: 7})
		return
	}
	writeJSON(w, http.StatusOK, s)
}

// SaveBackupSchedule persists the automatic backup schedule.
func (h *H) SaveBackupSchedule(w http.ResponseWriter, r *http.Request) {
	var s store.BackupSchedule
	if err := decodeJSON(r, &s); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	s.ID = "default"
	if s.Scope == "" {
		s.Scope = "full"
	}
	s.UpdatedAt = time.Now().UTC()
	if err := h.db.BackupSchedule.Save(s); err != nil {
		writeError(w, http.StatusInternalServerError, "could not save schedule")
		return
	}
	h.logAudit(r, "backup_schedule_save", "system", "", "", s.TimeOfDay)
	writeJSON(w, http.StatusOK, s)
}

func sortByCreatedDesc(recs []store.BackupRecord) {
	for i := 0; i < len(recs); i++ {
		for j := i + 1; j < len(recs); j++ {
			if recs[j].CreatedAt.After(recs[i].CreatedAt) {
				recs[i], recs[j] = recs[j], recs[i]
			}
		}
	}
}
