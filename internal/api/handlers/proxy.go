package handlers

import (
	"context"
	"net/http"
	"time"
)

// ProxyStatus performs a server-side HTTP probe so the frontend can check
// whether Nginx Proxy Manager (or any service) is reachable without CORS issues.
func (h *H) ProxyStatus(w http.ResponseWriter, r *http.Request) {
	target := r.URL.Query().Get("url")
	if target == "" {
		writeError(w, http.StatusBadRequest, "url parameter is required")
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

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"accessible": false})
		return
	}
	resp.Body.Close()
	writeJSON(w, http.StatusOK, map[string]any{"accessible": true, "status": resp.StatusCode})
}
