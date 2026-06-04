package handlers

import (
	"net/http"
	"strconv"

	"offdock/internal/traffic"
)

// TrafficConnections returns a live snapshot of TCP/UDP connections and
// interface stats from the host OS (via ss + /proc/net/dev).
func (h *H) TrafficConnections(w http.ResponseWriter, r *http.Request) {
	report, err := traffic.CollectConnections()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not collect connections: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, report)
}

// Traffic returns aggregated nginx access-log metrics.
// Query params: hours (default 24), host (optional vhost filter).
func (h *H) Traffic(w http.ResponseWriter, r *http.Request) {
	hours := 24
	if v := r.URL.Query().Get("hours"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 720 {
			hours = n
		}
	}
	host := r.URL.Query().Get("host")

	report, err := traffic.Collect(hours, host)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not read traffic logs: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, report)
}
