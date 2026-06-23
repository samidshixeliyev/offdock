package handlers

import (
	"net/http"
	"sort"
	"strconv"

	"github.com/go-chi/chi/v5"

	"offdock/internal/store"
)

// traceSessionSummary is a TraceSession without its (potentially large) event
// slice — used for the list view.
type traceSessionSummary struct {
	ID            string  `json:"id"`
	ContainerName string  `json:"container_name"`
	StartedAt     string  `json:"started_at"`
	EndedAt       *string `json:"ended_at"`
	EventCount    int     `json:"event_count"`
	HTTPCount     int     `json:"http_count"`
	SQLCount      int     `json:"sql_count"`
	RedisCount    int     `json:"redis_count"`
}

// ListTraceSessions returns all stored trace sessions, newest first, without events.
func (h *H) ListTraceSessions(w http.ResponseWriter, r *http.Request) {
	sessions, err := h.db.TraceSessions.FindAll()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not list trace sessions")
		return
	}
	sort.Slice(sessions, func(i, j int) bool {
		return sessions[i].StartedAt.After(sessions[j].StartedAt)
	})

	// Optional pagination. Without limit/offset the full list is returned
	// inside the envelope (total == len), so older callers still work.
	total := len(sessions)
	q := r.URL.Query()
	limit := total
	if l, err := strconv.Atoi(q.Get("limit")); err == nil && l > 0 {
		limit = l
	}
	offset := 0
	if o, err := strconv.Atoi(q.Get("offset")); err == nil && o > 0 {
		offset = o
	}
	if offset > total {
		offset = total
	}
	end := offset + limit
	if end > total {
		end = total
	}
	sessions = sessions[offset:end]

	out := make([]traceSessionSummary, 0, len(sessions))
	for _, s := range sessions {
		var httpN, sqlN, redisN int
		for _, e := range s.Events {
			switch e.Type {
			case "http_req", "http_resp":
				httpN++
			case "sql":
				sqlN++
			case "redis":
				redisN++
			}
		}
		var ended *string
		if s.EndedAt != nil {
			v := s.EndedAt.Format("2006-01-02T15:04:05Z07:00")
			ended = &v
		}
		out = append(out, traceSessionSummary{
			ID:            s.ID,
			ContainerName: s.ContainerName,
			StartedAt:     s.StartedAt.Format("2006-01-02T15:04:05Z07:00"),
			EndedAt:       ended,
			EventCount:    s.EventCount,
			HTTPCount:     httpN,
			SQLCount:      sqlN,
			RedisCount:    redisN,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"data":   out,
		"total":  total,
		"limit":  limit,
		"offset": offset,
	})
}

// GetTraceSession returns a single trace session including all events.
func (h *H) GetTraceSession(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	session, err := h.db.TraceSessions.FindByID(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "trace session not found")
		return
	}
	if session.Events == nil {
		session.Events = []store.TraceEvent{}
	}
	writeJSON(w, http.StatusOK, session)
}

// DeleteTraceSession removes a stored trace session.
func (h *H) DeleteTraceSession(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.db.TraceSessions.Delete(id); err != nil {
		writeError(w, http.StatusNotFound, "trace session not found")
		return
	}
	h.logAudit(r, "delete_trace_session", "trace_session", id, "", "")
	w.WriteHeader(http.StatusNoContent)
}
