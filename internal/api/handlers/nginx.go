package handlers

import (
	"context"
	"fmt"
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

// ListAllNginx returns every project paired with its active nginx config (null if unconfigured).
func (h *H) ListAllNginx(w http.ResponseWriter, r *http.Request) {
	projects, err := h.db.Projects.FindAll()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not list projects")
		return
	}

	type entry struct {
		Project store.Project      `json:"project"`
		Config  *store.NginxConfig `json:"config"`
	}

	result := make([]entry, 0, len(projects))
	for _, p := range projects {
		cfgs, _ := h.db.Nginx.FindWhere(func(n store.NginxConfig) bool {
			return n.ProjectID == p.ID && n.Active
		})
		var cfg *store.NginxConfig
		if len(cfgs) > 0 {
			c := cfgs[0]
			cfg = &c
		}
		result = append(result, entry{Project: p, Config: cfg})
	}
	writeJSON(w, http.StatusOK, result)
}

// RemoveNginx deactivates the nginx config for a project and removes its file from the host.
func (h *H) RemoveNginx(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	project, err := h.db.Projects.FindByID(projectID)
	if err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
	cfgs, _ := h.db.Nginx.FindWhere(func(n store.NginxConfig) bool {
		return n.ProjectID == projectID && n.Active
	})
	for _, cfg := range cfgs {
		cfg.Active = false
		h.db.Nginx.Save(cfg) //nolint:errcheck
	}
	nginxpkg.Remove(project.Name) //nolint:errcheck
	w.WriteHeader(http.StatusNoContent)
}

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

	generated, err := nginxpkg.Generate(req)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	req.GeneratedConfig = generated

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

// ApplyNginx writes the nginx config to disk and reloads system nginx.
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

	now := timeNow()
	cfg := cfgs[0]
	cfg.Applied = true
	cfg.AppliedAt = &now
	h.db.Nginx.Save(cfg) //nolint:errcheck

	h.logAudit(r, "apply_nginx", "project", projectID, project.Name, "")

	writeJSON(w, http.StatusOK, map[string]string{
		"config_path":       result.ConfigPath,
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

	certsDir := nginxpkg.NginxCertsDir
	if err := os.MkdirAll(certsDir, 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, "could not create certs directory")
		return
	}

	filename := projectID
	keyPath := filepath.Join(certsDir, filename+".key")
	certPath := filepath.Join(certsDir, filename+".crt")

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

// NginxSystemStatus returns whether system nginx is available and its status.
func (h *H) NginxSystemStatus(w http.ResponseWriter, r *http.Request) {
	available := nginxpkg.SystemAvailable()
	var statusText string
	if available {
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		out, err := exec.CommandContext(ctx, "systemctl", "is-active", "nginx").Output()
		if err == nil {
			statusText = strings.TrimSpace(string(out))
		} else {
			statusText = "inactive"
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"available": available,
		"status":    statusText,
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

// SelfNginxConfig returns the generated nginx config for OffDock itself.
func (h *H) SelfNginxConfig(w http.ResponseWriter, r *http.Request) {
	domain := r.URL.Query().Get("domain")
	if domain == "" {
		domain = "localhost"
	}
	port := 7070
	if p, err := strconv.Atoi(r.URL.Query().Get("port")); err == nil && p > 0 {
		port = p
	}
	config := nginxpkg.GenerateSelfConfig(domain, port, h.defaultCertPath, h.defaultCertKeyPath)
	ssl := h.defaultCertPath != "" && h.defaultCertKeyPath != ""
	writeJSON(w, http.StatusOK, map[string]any{
		"config":    config,
		"domain":    domain,
		"port":      strconv.Itoa(port),
		"ssl":       ssl,
		"cert_path": h.defaultCertPath,
		"key_path":  h.defaultCertKeyPath,
	})
}

// ApplySelfNginxConfig writes the OffDock self-hosting nginx config to the system.
func (h *H) ApplySelfNginxConfig(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Domain   string `json:"domain"`
		Port     int    `json:"port"`
		CertPath string `json:"cert_path"`
		KeyPath  string `json:"key_path"`
	}
	if err := decodeJSON(r, &req); err != nil || req.Domain == "" {
		writeError(w, http.StatusBadRequest, "domain is required")
		return
	}
	if req.Port == 0 {
		req.Port = 7070
	}
	certPath := req.CertPath
	keyPath := req.KeyPath
	if certPath == "" {
		certPath = h.defaultCertPath
	}
	if keyPath == "" {
		keyPath = h.defaultCertKeyPath
	}
	if !nginxpkg.SystemAvailable() {
		writeError(w, http.StatusUnprocessableEntity, "system nginx is not installed — install nginx first")
		return
	}
	result, err := nginxpkg.ApplySelfConfig(req.Domain, req.Port, certPath, keyPath)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	ssl := certPath != "" && keyPath != ""
	h.logAudit(r, "apply_nginx_self", "system", "", req.Domain, fmt.Sprintf("port:%d ssl:%v", req.Port, ssl))
	writeJSON(w, http.StatusOK, map[string]any{
		"status":      "applied",
		"config_path": result.ConfigPath,
		"test_output": result.NginxTestOutput,
		"ssl":         ssl,
	})
}
