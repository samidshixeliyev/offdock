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
	if nginxpkg.SystemAvailable() {
		nginxpkg.RemoveSystem(project.Name) //nolint:errcheck
	} else {
		nginxpkg.Remove(project.Name) //nolint:errcheck
	}
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

	var result *nginxpkg.ApplyResult
	if nginxpkg.SystemAvailable() {
		result, err = nginxpkg.ApplySystem(cfgs[0], project.Name)
	} else {
		result, err = nginxpkg.Apply(cfgs[0], project.Name)
	}
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}

	// Mark config as applied.
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

	// Certs must live in the nginx container's mounted directory so nginx can read them.
	// NginxCertsDir (/var/offdock/nginx/certs) is mounted as /etc/nginx/certs inside the container.
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

	// Return the container-visible paths so they can be used directly in nginx config.
	writeJSON(w, http.StatusOK, map[string]string{
		"cert_path": "/etc/nginx/certs/" + filename + ".crt",
		"key_path":  "/etc/nginx/certs/" + filename + ".key",
		"domain":    domain,
		"days":      strconv.Itoa(days),
	})
}

// NginxContainerStatus returns the live status of the offdock-nginx Docker container.
func (h *H) NginxContainerStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, nginxpkg.GetContainerStatus())
}


// NginxContainerStart creates (if needed) and starts the offdock-nginx container.
// Always writes the default catch-all server block first so raw-IP requests return 444.
func (h *H) NginxContainerStart(w http.ResponseWriter, r *http.Request) {
	nginxpkg.WriteDefaultServer() //nolint:errcheck
	if err := nginxpkg.StartNginxContainer(); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "started"})
}

// NginxContainerStop stops the offdock-nginx container.
func (h *H) NginxContainerStop(w http.ResponseWriter, r *http.Request) {
	if err := nginxpkg.StopNginxContainer(); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "stopped"})
}

// NginxContainerReload sends nginx -s reload inside the running container.
func (h *H) NginxContainerReload(w http.ResponseWriter, r *http.Request) {
	out, err := nginxpkg.ReloadNginxContainer()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "reload failed: "+out)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "reloaded", "output": out})
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
// Query param: domain (default "localhost"), port (default 7070)
func (h *H) SelfNginxConfig(w http.ResponseWriter, r *http.Request) {
	domain := r.URL.Query().Get("domain")
	if domain == "" {
		domain = "localhost"
	}
	port := 7070
	if p, err := strconv.Atoi(r.URL.Query().Get("port")); err == nil && p > 0 {
		port = p
	}
	config := nginxpkg.GenerateSelfConfig(domain, port)
	writeJSON(w, http.StatusOK, map[string]string{"config": config, "domain": domain, "port": strconv.Itoa(port)})
}

// ApplySelfNginxConfig writes the OffDock self-hosting nginx config to the system.
// Body: { "domain": "deploy.ao.az", "port": 7070 }
func (h *H) ApplySelfNginxConfig(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Domain string `json:"domain"`
		Port   int    `json:"port"`
	}
	if err := decodeJSON(r, &req); err != nil || req.Domain == "" {
		writeError(w, http.StatusBadRequest, "domain is required")
		return
	}
	if req.Port == 0 {
		req.Port = 7070
	}
	if !nginxpkg.SystemAvailable() {
		writeError(w, http.StatusUnprocessableEntity, "system nginx is not installed — install nginx first")
		return
	}
	result, err := nginxpkg.ApplySelfConfig(req.Domain, req.Port)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	h.logAudit(r, "apply_nginx_self", "system", "", req.Domain, fmt.Sprintf("port:%d", req.Port))
	writeJSON(w, http.StatusOK, map[string]string{
		"status":      "applied",
		"config_path": result.ConfigPath,
		"test_output": result.NginxTestOutput,
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
