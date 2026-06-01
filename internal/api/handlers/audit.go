package handlers

import (
	"net/http"
	"sort"
	"strconv"
	"time"

	authmw "offdock/internal/middleware"
	"offdock/internal/store"
)

// ListAuditEvents returns recent audit events, newest first.
// Query params: limit (default 100, max 500), resource_type, action
func (h *H) ListAuditEvents(w http.ResponseWriter, r *http.Request) {
	limit := 100
	if l, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && l > 0 && l <= 500 {
		limit = l
	}
	filterType := r.URL.Query().Get("resource_type")
	filterAction := r.URL.Query().Get("action")

	events, err := h.db.AuditEvents.FindAll()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not list audit events")
		return
	}

	// Filter
	if filterType != "" || filterAction != "" {
		var filtered []store.AuditEvent
		for _, e := range events {
			if filterType != "" && e.ResourceType != filterType {
				continue
			}
			if filterAction != "" && e.Action != filterAction {
				continue
			}
			filtered = append(filtered, e)
		}
		events = filtered
	}

	sort.Slice(events, func(i, j int) bool {
		return events[i].CreatedAt.After(events[j].CreatedAt)
	})
	if len(events) > limit {
		events = events[:limit]
	}
	if events == nil {
		events = []store.AuditEvent{}
	}
	writeJSON(w, http.StatusOK, events)
}

// logAudit records an audit event. Silently discards errors (audit must not block operations).
func (h *H) logAudit(r *http.Request, action, resourceType, resourceID, resourceName, details string) {
	claims := authmw.ClaimsFromContext(r.Context())
	event := store.AuditEvent{
		ID:           store.NewULID(),
		Action:       action,
		ResourceType: resourceType,
		ResourceID:   resourceID,
		ResourceName: resourceName,
		Details:      details,
		IPAddr:       authmw.RealIP(r),
		CreatedAt:    time.Now().UTC(),
	}
	if claims != nil {
		event.UserID = claims.UserID
		event.Username = claims.Username
	}
	_ = h.db.AuditEvents.Save(event)
}
