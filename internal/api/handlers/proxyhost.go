package handlers

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	nginxpkg "offdock/internal/nginx"
	"offdock/internal/store"
)

// proxyHostInput is the shared request body for create/update proxy hosts.
type proxyHostInput struct {
	Domain            string                `json:"domain"`
	Aliases           []string              `json:"aliases"`
	UpstreamHost      string                `json:"upstream_host"`
	UpstreamPort      int                   `json:"upstream_port"`
	SSLEnabled        bool                  `json:"ssl_enabled"`
	SSLPEMPath        string                `json:"ssl_pem_path"`
	ClientMaxBodySize string                `json:"client_max_body_size"`
	ProxyReadTimeout  int                   `json:"proxy_read_timeout"`
	GzipEnabled       bool                  `json:"gzip_enabled"`
	CustomDirectives  string                `json:"custom_directives"`
	Locations         []store.ProxyLocation `json:"locations"`
	AccessLog         bool                  `json:"access_log"`
}

// ListProxyHosts returns all proxy hosts.
func (h *H) ListProxyHosts(w http.ResponseWriter, r *http.Request) {
	hosts, err := h.db.ProxyHosts.FindAll()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not list hosts")
		return
	}
	if hosts == nil {
		hosts = []store.ProxyHost{}
	}
	writeJSON(w, http.StatusOK, hosts)
}

// CreateProxyHost adds a new proxy host and immediately applies the config.
func (h *H) CreateProxyHost(w http.ResponseWriter, r *http.Request) {
	var req proxyHostInput
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Domain = nginxpkg.SanitizeDomain(req.Domain)
	if req.Domain == "" || req.UpstreamHost == "" || req.UpstreamPort == 0 {
		writeError(w, http.StatusBadRequest, "domain, upstream_host, and upstream_port are required")
		return
	}
	if req.ClientMaxBodySize == "" {
		req.ClientMaxBodySize = "10m"
	}
	if req.ProxyReadTimeout == 0 {
		req.ProxyReadTimeout = 60
	}

	host := store.ProxyHost{
		ID:                store.NewULID(),
		Domain:            req.Domain,
		Aliases:           req.Aliases,
		UpstreamHost:      strings.TrimSpace(req.UpstreamHost),
		UpstreamPort:      req.UpstreamPort,
		SSLEnabled:        req.SSLEnabled,
		SSLPEMPath:        req.SSLPEMPath,
		ClientMaxBodySize: req.ClientMaxBodySize,
		ProxyReadTimeout:  req.ProxyReadTimeout,
		GzipEnabled:       req.GzipEnabled,
		CustomDirectives:  req.CustomDirectives,
		Locations:         req.Locations,
		AccessLog:         req.AccessLog,
		Enabled:           true,
		CreatedAt:         time.Now().UTC(),
		UpdatedAt:         time.Now().UTC(),
	}

	var applyErr error
	if nginxpkg.SystemAvailable() {
		_, applyErr = nginxpkg.ApplyProxyHostSystem(host)
	} else {
		_, applyErr = nginxpkg.ApplyProxyHost(host)
	}
	if applyErr != nil {
		writeError(w, http.StatusUnprocessableEntity, applyErr.Error())
		return
	}

	if err := h.db.ProxyHosts.Save(host); err != nil {
		writeError(w, http.StatusInternalServerError, "could not save host")
		return
	}
	h.logAudit(r, "create_proxy_host", "proxy_host", host.ID, host.Domain, "")
	writeJSON(w, http.StatusCreated, host)
}

// UpdateProxyHost replaces a proxy host's config and re-applies it.
func (h *H) UpdateProxyHost(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	host, err := h.db.ProxyHosts.FindByID(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "host not found")
		return
	}

	var req proxyHostInput
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Domain = nginxpkg.SanitizeDomain(req.Domain)
	if req.Domain == "" || req.UpstreamHost == "" || req.UpstreamPort == 0 {
		writeError(w, http.StatusBadRequest, "domain, upstream_host, and upstream_port are required")
		return
	}

	// If domain changed, remove the old config file.
	if req.Domain != host.Domain {
		if nginxpkg.SystemAvailable() {
			nginxpkg.RemoveProxyHostSystem(host.Domain) //nolint:errcheck
		} else {
			nginxpkg.RemoveProxyHost(host.Domain) //nolint:errcheck
		}
	}

	host.Domain = req.Domain
	host.Aliases = req.Aliases
	host.UpstreamHost = strings.TrimSpace(req.UpstreamHost)
	host.UpstreamPort = req.UpstreamPort
	host.SSLEnabled = req.SSLEnabled
	host.SSLPEMPath = req.SSLPEMPath
	host.ClientMaxBodySize = req.ClientMaxBodySize
	host.ProxyReadTimeout = req.ProxyReadTimeout
	host.GzipEnabled = req.GzipEnabled
	host.CustomDirectives = req.CustomDirectives
	host.Locations = req.Locations
	host.AccessLog = req.AccessLog
	host.UpdatedAt = time.Now().UTC()

	if host.Enabled {
		var applyErr error
		if nginxpkg.SystemAvailable() {
			_, applyErr = nginxpkg.ApplyProxyHostSystem(host)
		} else {
			_, applyErr = nginxpkg.ApplyProxyHost(host)
		}
		if applyErr != nil {
			writeError(w, http.StatusUnprocessableEntity, applyErr.Error())
			return
		}
	}

	if err := h.db.ProxyHosts.Save(host); err != nil {
		writeError(w, http.StatusInternalServerError, "could not save host")
		return
	}
	h.logAudit(r, "update_proxy_host", "proxy_host", id, host.Domain, "")
	writeJSON(w, http.StatusOK, host)
}

// DeleteProxyHost removes a proxy host and its nginx config.
func (h *H) DeleteProxyHost(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	host, err := h.db.ProxyHosts.FindByID(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "host not found")
		return
	}
	if nginxpkg.SystemAvailable() {
		nginxpkg.RemoveProxyHostSystem(host.Domain) //nolint:errcheck
	} else {
		nginxpkg.RemoveProxyHost(host.Domain) //nolint:errcheck
	}
	if err := h.db.ProxyHosts.Delete(id); err != nil {
		writeError(w, http.StatusInternalServerError, "could not delete host")
		return
	}
	h.logAudit(r, "delete_proxy_host", "proxy_host", id, "", "")
	w.WriteHeader(http.StatusNoContent)
}

// ToggleProxyHost enables or disables a host (writes/removes its config file).
func (h *H) ToggleProxyHost(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	host, err := h.db.ProxyHosts.FindByID(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "host not found")
		return
	}

	host.Enabled = !host.Enabled
	host.UpdatedAt = time.Now().UTC()

	if host.Enabled {
		var applyErr error
		if nginxpkg.SystemAvailable() {
			_, applyErr = nginxpkg.ApplyProxyHostSystem(host)
		} else {
			_, applyErr = nginxpkg.ApplyProxyHost(host)
		}
		if applyErr != nil {
			writeError(w, http.StatusUnprocessableEntity, applyErr.Error())
			return
		}
	} else {
		if nginxpkg.SystemAvailable() {
			nginxpkg.RemoveProxyHostSystem(host.Domain) //nolint:errcheck
		} else {
			nginxpkg.RemoveProxyHost(host.Domain) //nolint:errcheck
		}
	}

	if err := h.db.ProxyHosts.Save(host); err != nil {
		writeError(w, http.StatusInternalServerError, "could not save host")
		return
	}
	state := "disabled"
	if host.Enabled {
		state = "enabled"
	}
	h.logAudit(r, "toggle_proxy_host", "proxy_host", id, host.Domain, state)
	writeJSON(w, http.StatusOK, host)
}

// TestProxyHost runs a full diagnostic on a proxy host:
// 1. DNS — does the domain resolve? does it point to this server?
// 2. nginx — does a request through nginx reach the upstream?
func (h *H) TestProxyHost(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	host, err := h.db.ProxyHosts.FindByID(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "host not found")
		return
	}

	type result struct {
		OK          bool     `json:"ok"`
		StatusCode  int      `json:"status_code,omitempty"`
		Status      string   `json:"status,omitempty"`
		Error       string   `json:"error,omitempty"`
		DNSResolved bool     `json:"dns_resolved"`
		DNSAddrs    []string `json:"dns_addrs,omitempty"`
		DNSPointsHere bool   `json:"dns_points_here"`
		ServerIP    string   `json:"server_ip"`
		NginxOK     bool     `json:"nginx_ok"`
		NginxError  string   `json:"nginx_error,omitempty"`
		Hints       []string `json:"hints,omitempty"`
	}

	res := result{ServerIP: r.Host}
	if idx := strings.LastIndex(res.ServerIP, ":"); idx != -1 {
		res.ServerIP = res.ServerIP[:idx]
	}

	var hints []string

	// ── 1. DNS check ──────────────────────────────────────────────────────────
	dnsCtx, dnsCancel := context.WithTimeout(r.Context(), 5*time.Second)
	addrs, dnsErr := net.DefaultResolver.LookupHost(dnsCtx, host.Domain)
	dnsCancel()

	if dnsErr != nil {
		res.DNSResolved = false
		hints = append(hints, fmt.Sprintf("DNS: %q has no A record — add an A record pointing to %s in your DNS provider", host.Domain, res.ServerIP))
	} else {
		res.DNSResolved = true
		res.DNSAddrs = addrs
		for _, a := range addrs {
			if a == res.ServerIP {
				res.DNSPointsHere = true
				break
			}
		}
		if !res.DNSPointsHere {
			hints = append(hints, fmt.Sprintf("DNS: %q resolves to %v, but this server is %s — update the A record", host.Domain, addrs, res.ServerIP))
		}
	}

	// ── 2. nginx proxy check ──────────────────────────────────────────────────
	if !host.Enabled {
		res.NginxError = "host is disabled"
		hints = append(hints, "Enable the host using the toggle in the Proxy Hosts table")
	} else {
		target := "http://127.0.0.1"
		if host.SSLEnabled {
			target = "https://127.0.0.1"
		}

		tr := http.DefaultTransport.(*http.Transport).Clone()
		tr.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} //nolint:gosec
		client := &http.Client{
			Timeout:   10 * time.Second,
			Transport: tr,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}

		req, _ := http.NewRequestWithContext(r.Context(), "GET", target+"/", nil)
		req.Host = host.Domain

		resp, proxyErr := client.Do(req)
		if proxyErr != nil {
			res.NginxError = proxyErr.Error()
			if strings.Contains(proxyErr.Error(), "connection refused") {
				hints = append(hints, "nginx container is not running — click 'Start nginx' in the Reverse Proxy page")
			} else {
				hints = append(hints, "nginx → upstream error: make sure the container is running and connected to the offdock-external network")
			}
		} else {
			resp.Body.Close() //nolint:errcheck
			res.NginxOK = resp.StatusCode < 500
			res.StatusCode = resp.StatusCode
			res.Status = resp.Status
			if !res.NginxOK {
				hints = append(hints, fmt.Sprintf("upstream returned %s — check the container logs", resp.Status))
			}
		}
	}

	// ── Overall verdict ───────────────────────────────────────────────────────
	res.OK = res.DNSResolved && res.DNSPointsHere && res.NginxOK

	if host.SSLEnabled && res.DNSResolved && res.DNSPointsHere && res.NginxOK {
		hints = append(hints, "SSL is enabled with a self-signed cert — your browser will show a security warning. Click 'Advanced' → 'Proceed' to continue.")
	}
	if len(hints) == 0 && res.OK {
		hints = append(hints, "Everything looks good! Open http"+func() string {
			if host.SSLEnabled { return "s" }
			return ""
		}()+"://"+host.Domain+"/ in your browser.")
	}

	res.Hints = hints
	writeJSON(w, http.StatusOK, res)
}

// ServerIP returns the outward-facing IP address that OffDock is bound to,
// derived from the incoming request's Host header.
func (h *H) ServerIP(w http.ResponseWriter, r *http.Request) {
	host := r.Host
	if idx := strings.LastIndex(host, ":"); idx != -1 {
		host = host[:idx]
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"ip":  host,
		"tip": fmt.Sprintf("Point your domain's A record to %s", host),
	})
}

// PreviewProxyHost returns the generated nginx config without writing it to disk.
func (h *H) PreviewProxyHost(w http.ResponseWriter, r *http.Request) {
	var req proxyHostInput
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	host := store.ProxyHost{
		Domain:            nginxpkg.SanitizeDomain(req.Domain),
		Aliases:           req.Aliases,
		UpstreamHost:      strings.TrimSpace(req.UpstreamHost),
		UpstreamPort:      req.UpstreamPort,
		SSLEnabled:        req.SSLEnabled,
		SSLPEMPath:        req.SSLPEMPath,
		ClientMaxBodySize: req.ClientMaxBodySize,
		ProxyReadTimeout:  req.ProxyReadTimeout,
		GzipEnabled:       req.GzipEnabled,
		CustomDirectives:  req.CustomDirectives,
		Locations:         req.Locations,
		AccessLog:         req.AccessLog,
	}
	config, err := nginxpkg.GenerateProxyHost(host)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"config": config})
}
