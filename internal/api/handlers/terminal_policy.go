package handlers

import (
	"net/http"
	"time"

	"offdock/internal/security"
	"offdock/internal/store"
)

const termPolicyID = "default"

// resolveTermPolicy loads the saved terminal policy (if any) and compiles it on
// top of the built-in defaults. Always returns a usable policy.
func (h *H) resolveTermPolicy() *security.Policy {
	saved, err := h.db.TermPolicy.FindByID(termPolicyID)
	if err != nil {
		return security.Compile("denylist", nil, nil, nil)
	}
	mode := saved.Mode
	if mode == "" {
		mode = "denylist"
	}
	return security.Compile(mode, saved.Deny, saved.Allow, saved.RestrictedPaths)
}

// GetTerminalPolicy returns the saved policy record (or defaults if none saved).
// GET /api/v1/terminal/policy
func (h *H) GetTerminalPolicy(w http.ResponseWriter, r *http.Request) {
	saved, err := h.db.TermPolicy.FindByID(termPolicyID)
	if err != nil {
		writeJSON(w, http.StatusOK, store.TerminalPolicy{ID: termPolicyID, Mode: "denylist"})
		return
	}
	writeJSON(w, http.StatusOK, saved)
}

// SaveTerminalPolicy persists the command-execution policy (superadmin).
// POST /api/v1/terminal/policy
func (h *H) SaveTerminalPolicy(w http.ResponseWriter, r *http.Request) {
	var req store.TerminalPolicy
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	if req.Mode != "allowlist" {
		req.Mode = "denylist"
	}
	req.ID = termPolicyID
	req.UpdatedAt = time.Now().UTC()
	if err := h.db.TermPolicy.Save(req); err != nil {
		writeError(w, http.StatusInternalServerError, "could not save policy")
		return
	}
	h.logAudit(r, "terminal_policy_save", "system", "", "", req.Mode)
	writeJSON(w, http.StatusOK, req)
}

// DefaultDenyPatterns exposes the built-in denylist to the UI for display.
// GET /api/v1/terminal/policy/defaults
func (h *H) GetTerminalPolicyDefaults(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"default_deny": security.DefaultDenyPatterns})
}
