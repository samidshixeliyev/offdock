package handlers

import (
	"net/http"

	"offdock/internal/store"
)

// GetRetentionSettings returns the current retention settings.
func (h *H) GetRetentionSettings(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, store.LoadRetentionSettings(h.dataDir))
}

// SaveRetentionSettings writes new retention settings (superadmin only — enforced by router middleware).
func (h *H) SaveRetentionSettings(w http.ResponseWriter, r *http.Request) {
	var s store.RetentionSettings
	if err := decodeJSON(r, &s); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if err := store.SaveRetentionSettings(h.dataDir, s); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save retention settings")
		return
	}
	h.logAudit(r, "save_retention_settings", "system", "", "", "")
	writeJSON(w, http.StatusOK, store.LoadRetentionSettings(h.dataDir))
}
