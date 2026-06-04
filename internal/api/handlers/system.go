package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

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
