package handlers

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
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

	if req.SSLEnabled && req.SSLPEMPath == "" && req.SSLCertPath == "" {
		req.SSLPEMPath = h.defaultPEMPath
	}

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

// GenerateCert generates a self-signed SSL certificate using Go's crypto/x509
// (no openssl dependency). Supports full DN fields and multiple SANs.
// Writes a combined PEM file (EC private key + certificate).
func (h *H) GenerateCert(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")

	var req struct {
		Domain       string   `json:"domain"`
		DNSNames     []string `json:"dns_names"`    // additional SAN DNS entries
		IPAddresses  []string `json:"ip_addresses"` // SAN IP entries
		Organization string   `json:"organization"`
		Country      string   `json:"country"` // 2-letter ISO code
		Days         int      `json:"days"`
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

	// Build deduplicated SAN list: primary domain is always first.
	seen := map[string]bool{domain: true}
	dnsNames := []string{domain}
	var ipAddrs []net.IP

	addDNS := func(s string) {
		s = strings.TrimSpace(s)
		if s == "" || seen[s] {
			return
		}
		seen[s] = true
		if ip := net.ParseIP(s); ip != nil {
			ipAddrs = append(ipAddrs, ip)
		} else {
			dnsNames = append(dnsNames, s)
		}
	}
	for _, d := range req.DNSNames {
		addDNS(d)
	}
	for _, ipStr := range req.IPAddresses {
		ipStr = strings.TrimSpace(ipStr)
		if ipStr == "" {
			continue
		}
		if ip := net.ParseIP(ipStr); ip != nil {
			ipAddrs = append(ipAddrs, ip)
		}
	}

	// Build subject Distinguished Name.
	subject := pkix.Name{CommonName: domain}
	if org := strings.TrimSpace(req.Organization); org != "" {
		subject.Organization = []string{org}
	}
	if c := strings.ToUpper(strings.TrimSpace(req.Country)); len(c) == 2 {
		subject.Country = []string{c}
	}

	// Generate RSA-2048 key — universally compatible with Cloudflare and all TLS clients.
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "generate key: "+err.Error())
		return
	}

	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "generate serial: "+err.Error())
		return
	}

	tmpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               subject,
		NotBefore:             time.Now().Add(-time.Minute),
		NotAfter:              time.Now().AddDate(0, 0, days),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:              dnsNames,
		IPAddresses:           ipAddrs,
		BasicConstraintsValid: true,
	}

	certDER, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "create certificate: "+err.Error())
		return
	}
	keyDER := x509.MarshalPKCS1PrivateKey(key)

	var pemBuf bytes.Buffer
	pem.Encode(&pemBuf, &pem.Block{Type: "CERTIFICATE", Bytes: certDER})     //nolint:errcheck
	pem.Encode(&pemBuf, &pem.Block{Type: "RSA PRIVATE KEY", Bytes: keyDER}) //nolint:errcheck

	certsDir := nginxpkg.NginxCertsDir
	if err := os.MkdirAll(certsDir, 0o700); err != nil {
		writeError(w, http.StatusInternalServerError, "create certs dir: "+err.Error())
		return
	}
	pemPath := filepath.Join(certsDir, projectID+".pem")
	if err := os.WriteFile(pemPath, pemBuf.Bytes(), 0o600); err != nil {
		writeError(w, http.StatusInternalServerError, "write pem: "+err.Error())
		return
	}

	ipStrs := make([]string, len(ipAddrs))
	for i, ip := range ipAddrs {
		ipStrs[i] = ip.String()
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"pem_path":    pemPath,
		"domain":      domain,
		"dns_names":   dnsNames,
		"ip_addresses": ipStrs,
		"days":        strconv.Itoa(days),
		"valid_until": time.Now().AddDate(0, 0, days).Format("2006-01-02"),
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

// NginxSystemControl starts / restarts / reloads / stops the system nginx service.
// POST /api/v1/nginx/system/control  {action: "start"|"restart"|"reload"|"stop"}
// For reload/restart it first runs `nginx -t` so a bad config doesn't take nginx
// down. Returns the resulting active status + any command output.
func (h *H) NginxSystemControl(w http.ResponseWriter, r *http.Request) {
	if !nginxpkg.SystemAvailable() {
		writeError(w, http.StatusUnprocessableEntity, "nginx is not installed on this host")
		return
	}
	var req struct {
		Action string `json:"action"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request")
		return
	}
	action := strings.ToLower(strings.TrimSpace(req.Action))
	switch action {
	case "start", "restart", "reload", "stop":
	default:
		writeError(w, http.StatusBadRequest, "action must be start | restart | reload | stop")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	// Validate config before reload/restart so a broken vhost can't down nginx.
	if action == "reload" || action == "restart" {
		if out, err := exec.CommandContext(ctx, "nginx", "-t").CombinedOutput(); err != nil {
			writeError(w, http.StatusUnprocessableEntity, "nginx config test failed — fix it before "+action+":\n"+strings.TrimSpace(string(out)))
			return
		}
	}

	out, err := exec.CommandContext(ctx, "systemctl", action, "nginx").CombinedOutput()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "systemctl "+action+" nginx failed: "+err.Error()+"\n"+strings.TrimSpace(string(out)))
		return
	}

	// Report the resulting status.
	statusOut, _ := exec.CommandContext(ctx, "systemctl", "is-active", "nginx").Output()
	h.logAudit(r, "nginx_"+action, "system", "", "nginx", "")
	writeJSON(w, http.StatusOK, map[string]any{
		"status":  strings.TrimSpace(string(statusOut)),
		"action":  action,
		"output":  strings.TrimSpace(string(out)),
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
	config := nginxpkg.GenerateSelfConfig(domain, port, h.defaultPEMPath)
	writeJSON(w, http.StatusOK, map[string]any{
		"config":   config,
		"domain":   domain,
		"port":     strconv.Itoa(port),
		"ssl":      h.defaultPEMPath != "",
		"pem_path": h.defaultPEMPath,
	})
}

// ApplySelfNginxConfig writes the OffDock self-hosting nginx config to the system.
func (h *H) ApplySelfNginxConfig(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Domain  string `json:"domain"`
		Port    int    `json:"port"`
		PEMPath string `json:"pem_path"`
	}
	if err := decodeJSON(r, &req); err != nil || req.Domain == "" {
		writeError(w, http.StatusBadRequest, "domain is required")
		return
	}
	if req.Port == 0 {
		req.Port = 7070
	}
	pemPath := req.PEMPath
	if pemPath == "" {
		pemPath = h.defaultPEMPath
	}
	if !nginxpkg.SystemAvailable() {
		writeError(w, http.StatusUnprocessableEntity, "system nginx is not installed — install nginx first")
		return
	}
	result, err := nginxpkg.ApplySelfConfig(req.Domain, req.Port, pemPath)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	h.logAudit(r, "apply_nginx_self", "system", "", req.Domain, fmt.Sprintf("port:%d ssl:%v", req.Port, pemPath != ""))
	writeJSON(w, http.StatusOK, map[string]any{
		"status":      "applied",
		"config_path": result.ConfigPath,
		"test_output": result.NginxTestOutput,
		"ssl":         pemPath != "",
	})
}
