package handlers

import (
	"context"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	nginxpkg "offdock/internal/nginx"
	"offdock/internal/store"
)

// GetNginx returns the active nginx config for a project.
func (h *H) GetNginx(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	cfgs, err := h.db.Nginx.FindWhere(func(n store.NginxConfig) bool {
		return n.ProjectID == projectID && n.Active
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not fetch nginx config")
		return
	}
	if len(cfgs) == 0 {
		writeJSON(w, http.StatusOK, nil)
		return
	}
	writeJSON(w, http.StatusOK, cfgs[0])
}

// SaveNginx persists a nginx config (without applying it to the host).
func (h *H) SaveNginx(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")

	var req store.NginxConfig
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.ProjectID = projectID

	// Validate and pre-generate config text.
	generated, err := nginxpkg.Generate(req)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	req.GeneratedConfig = generated

	// Deactivate any existing config for this project.
	existing, _ := h.db.Nginx.FindWhere(func(n store.NginxConfig) bool {
		return n.ProjectID == projectID && n.Active
	})
	for _, old := range existing {
		old.Active = false
		h.db.Nginx.Save(old) //nolint:errcheck
	}

	req.ID = store.NewULID()
	req.Active = true
	req.CreatedAt = timeNow()
	if err := h.db.Nginx.Save(req); err != nil {
		writeError(w, http.StatusInternalServerError, "could not save nginx config")
		return
	}
	writeJSON(w, http.StatusCreated, req)
}

// ApplyNginx writes the nginx config to disk and reloads nginx.
func (h *H) ApplyNginx(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")

	project, err := h.db.Projects.FindByID(projectID)
	if err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}

	cfgs, _ := h.db.Nginx.FindWhere(func(n store.NginxConfig) bool {
		return n.ProjectID == projectID && n.Active
	})
	if len(cfgs) == 0 {
		writeError(w, http.StatusNotFound, "no active nginx config for project")
		return
	}

	result, err := nginxpkg.Apply(cfgs[0], project.Name)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"config_path":       result.ConfigPath,
		"symlink_path":      result.SymlinkPath,
		"nginx_test_output": result.NginxTestOutput,
	})
}

// GenerateCert generates a self-signed SSL certificate for a project using openssl.
func (h *H) GenerateCert(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")

	var req struct {
		Domain string `json:"domain"`
		Days   int    `json:"days"`
	}
	if err := decodeJSON(r, &req); err != nil || strings.TrimSpace(req.Domain) == "" {
		writeError(w, http.StatusBadRequest, "domain is required")
		return
	}
	domain := nginxpkg.SanitizeDomain(req.Domain)
	if domain == "" {
		writeError(w, http.StatusBadRequest, "invalid domain")
		return
	}
	days := req.Days
	if days <= 0 {
		days = 365
	}

	certsDir := "/var/offdock/certs"
	if err := os.MkdirAll(certsDir, 0o700); err != nil {
		writeError(w, http.StatusInternalServerError, "could not create certs directory")
		return
	}

	keyPath := filepath.Join(certsDir, projectID+".key")
	certPath := filepath.Join(certsDir, projectID+".crt")

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "openssl", "req", "-x509", "-nodes",
		"-days", strconv.Itoa(days),
		"-newkey", "rsa:2048",
		"-keyout", keyPath,
		"-out", certPath,
		"-subj", "/CN="+domain,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "openssl failed: "+strings.TrimSpace(string(out)))
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"cert_path": certPath,
		"key_path":  keyPath,
		"domain":    domain,
		"days":      strconv.Itoa(days),
	})
}

// PreviewNginx returns the generated nginx config text without writing it to disk.
func (h *H) PreviewNginx(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")

	cfgs, _ := h.db.Nginx.FindWhere(func(n store.NginxConfig) bool {
		return n.ProjectID == projectID && n.Active
	})
	if len(cfgs) == 0 {
		writeJSON(w, http.StatusOK, map[string]string{"config": ""})
		return
	}

	gen, err := nginxpkg.Generate(cfgs[0])
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"config": gen})
}
