package handlers

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"path/filepath"
	"strconv"
	"time"

	"offdock/internal/store"
)

// RetentionDefaults are the default keep limits for each collection.
// These are applied when PruneAll is called without explicit overrides.
const (
	DefaultKeepTraceSessions = 500
	DefaultKeepOTelSpans     = 50_000
	DefaultKeepAuditEvents   = 10_000
	DefaultKeepDeployments   = 200
)

// PruneAll enforces retention limits on all data collections.
// Called on demand (POST /api/v1/system/prune) or by the scheduled pruner.
// Query params: sessions=N, otel_spans=N, audit=N, deployments=N.
func (h *H) PruneAll(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	parseInt := func(key string, def int) int {
		if v := q.Get(key); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				return n
			}
		}
		return def
	}

	keepSessions := parseInt("sessions", DefaultKeepTraceSessions)
	keepOTel := parseInt("otel_spans", DefaultKeepOTelSpans)
	keepAudit := parseInt("audit", DefaultKeepAuditEvents)
	keepDeploy := parseInt("deployments", DefaultKeepDeployments)

	sessionsDel := h.db.PruneTraceSessions(keepSessions)
	otelDel := h.db.PruneOTelSpans(keepOTel)

	// Prune audit events.
	auditDel := 0
	if events, _ := h.db.AuditEvents.FindAll(); len(events) > keepAudit {
		type ae struct{ id string; t int64 }
		pairs := make([]ae, 0, len(events))
		for _, e := range events {
			pairs = append(pairs, ae{id: e.ID, t: e.CreatedAt.UnixNano()})
		}
		// Sort by time ascending.
		for i := 1; i < len(pairs); i++ {
			for j := i; j > 0 && pairs[j].t < pairs[j-1].t; j-- {
				pairs[j], pairs[j-1] = pairs[j-1], pairs[j]
			}
		}
		toDelete := len(pairs) - keepAudit
		for _, p := range pairs[:toDelete] {
			if h.db.AuditEvents.Delete(p.id) == nil {
				auditDel++
			}
		}
		if auditDel > 0 {
			_, _ = h.db.AuditEvents.Compact()
		}
	}

	// Prune deployment records.
	deployDel := 0
	if deps, _ := h.db.Deployments.FindAll(); len(deps) > keepDeploy {
		type dep struct{ id string; t int64 }
		pairs := make([]dep, 0, len(deps))
		for _, d := range deps {
			pairs = append(pairs, dep{id: d.ID, t: d.StartedAt.UnixNano()})
		}
		for i := 1; i < len(pairs); i++ {
			for j := i; j > 0 && pairs[j].t < pairs[j-1].t; j-- {
				pairs[j], pairs[j-1] = pairs[j-1], pairs[j]
			}
		}
		toDelete := len(pairs) - keepDeploy
		for _, p := range pairs[:toDelete] {
			if h.db.Deployments.Delete(p.id) == nil {
				deployDel++
			}
		}
		if deployDel > 0 {
			_, _ = h.db.Deployments.Compact()
		}
	}

	// Prune log file if retention is configured.
	s := store.LoadRetentionSettings(h.dataDir)
	if s.AppLogsMaxLines > 0 && h.logDir != "" {
		truncateLogFile(filepath.Join(h.logDir, "offdock.log"), s.AppLogsMaxLines)
	}

	slog.Info("prune_all",
		"sessions_deleted", sessionsDel, "otel_spans_deleted", otelDel,
		"audit_deleted", auditDel, "deployments_deleted", deployDel,
	)
	h.logAudit(r, "prune_all", "system", "", "", "")
	writeJSON(w, http.StatusOK, map[string]any{
		"status":              "ok",
		"sessions_deleted":    sessionsDel,
		"otel_spans_deleted":  otelDel,
		"audit_deleted":       auditDel,
		"deployments_deleted": deployDel,
		"limits": map[string]int{
			"trace_sessions": keepSessions,
			"otel_spans":     keepOTel,
			"audit_events":   keepAudit,
			"deployments":    keepDeploy,
		},
	})
}

// SystemDiskUsage returns docker system df — disk space used by images,
// containers, volumes, and build cache. Used by the System page disk panel.
func (h *H) SystemDiskUsage(w http.ResponseWriter, r *http.Request) {
	rows, err := h.docker.SystemDiskUsage()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "docker system df: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"rows": rows})
}

// SystemStats is an SSE endpoint that emits host + container resource stats every 3 seconds.
func (h *H) SystemStats(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()

	emit := func() {
		s, err := h.stats.Collect()
		if err != nil {
			msg, _ := json.Marshal(map[string]string{"error": err.Error()})
			fmt.Fprintf(w, "data: %s\n\n", msg)
			flusher.Flush()
			return
		}
		msg, _ := json.Marshal(s)
		fmt.Fprintf(w, "data: %s\n\n", msg)
		flusher.Flush()
	}

	// Emit immediately on connect, then on each tick.
	emit()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			emit()
		}
	}
}
