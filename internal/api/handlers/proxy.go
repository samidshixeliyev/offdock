package handlers

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ProxyStatus performs a server-side HTTP probe so the frontend can check
// whether a proxy host is reachable without CORS issues.
// SSRF mitigation: only public routable addresses are allowed — RFC-1918,
// loopback, link-local, cloud-metadata, and non-http(s) schemes are blocked.
func (h *H) ProxyStatus(w http.ResponseWriter, r *http.Request) {
	target := r.URL.Query().Get("url")
	if target == "" {
		writeError(w, http.StatusBadRequest, "url parameter is required")
		return
	}

	if err := validateProbeTarget(target); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 4*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "GET", target, nil)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"accessible": false, "error": "invalid url"})
		return
	}
	req.Header.Set("User-Agent", "OffDock-ProbeAgent/1.0")

	// Use a transport that doesn't follow redirects to internal addresses.
	client := &http.Client{
		Timeout: 4 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if err := validateProbeTarget(req.URL.String()); err != nil {
				return fmt.Errorf("redirect to blocked target: %w", err)
			}
			if len(via) >= 3 {
				return http.ErrUseLastResponse
			}
			return nil
		},
	}

	resp, err := client.Do(req)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"accessible": false})
		return
	}
	resp.Body.Close()
	writeJSON(w, http.StatusOK, map[string]any{"accessible": true, "status": resp.StatusCode})
}

// validateProbeTarget rejects non-http(s) schemes, private/loopback/link-local
// IPs, and known cloud metadata endpoints.
func validateProbeTarget(target string) error {
	u, err := url.Parse(target)
	if err != nil {
		return fmt.Errorf("invalid URL")
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return fmt.Errorf("only http/https URLs are allowed")
	}

	host := u.Hostname()
	if host == "" {
		return fmt.Errorf("missing host")
	}

	// Block cloud metadata IPs explicitly.
	blocked := []string{
		"169.254.169.254", // AWS/GCP/Azure instance metadata
		"metadata.google.internal",
		"metadata.internal",
	}
	for _, b := range blocked {
		if strings.EqualFold(host, b) {
			return fmt.Errorf("target is a restricted address")
		}
	}

	// Resolve hostname and check each IP.
	addrs, err := net.LookupHost(host)
	if err != nil {
		// Treat resolution failures as allowed (the probe will fail at connect time).
		return nil
	}
	for _, addr := range addrs {
		ip := net.ParseIP(addr)
		if ip == nil {
			continue
		}
		if isPrivateIP(ip) {
			return fmt.Errorf("target resolves to a private/restricted address")
		}
	}
	return nil
}

var privateRanges = func() []*net.IPNet {
	var nets []*net.IPNet
	for _, cidr := range []string{
		"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
		"127.0.0.0/8", "::1/128",
		"169.254.0.0/16", "fe80::/10",
		"100.64.0.0/10", // Shared address space (RFC 6598)
		"fc00::/7",      // Unique local IPv6
		"0.0.0.0/8",
		"240.0.0.0/4", // Reserved
	} {
		_, n, _ := net.ParseCIDR(cidr)
		if n != nil {
			nets = append(nets, n)
		}
	}
	return nets
}()

func isPrivateIP(ip net.IP) bool {
	for _, r := range privateRanges {
		if r.Contains(ip) {
			return true
		}
	}
	return false
}
