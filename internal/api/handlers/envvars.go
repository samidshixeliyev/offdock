package handlers

import (
	"net/http"
	"sort"

	"github.com/go-chi/chi/v5"

	authmw "offdock/internal/middleware"
	"offdock/internal/store"
)

// GetEnv returns the latest env var set for a project (secrets masked).
func (h *H) GetEnv(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	sets, err := h.db.EnvVars.FindWhere(func(s store.EnvVarSet) bool {
		return s.ProjectID == projectID
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not fetch env vars")
		return
	}
	if len(sets) == 0 {
		writeJSON(w, http.StatusOK, nil)
		return
	}
	sort.Slice(sets, func(i, j int) bool { return sets[i].Version > sets[j].Version })
	writeJSON(w, http.StatusOK, maskSecrets(sets[0]))
}

// SaveEnv stores a new env var set version (encrypts all values at rest).
func (h *H) SaveEnv(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	claims := authmw.ClaimsFromContext(r.Context())

	var req struct {
		Vars []struct {
			Key      string `json:"key"`
			Value    string `json:"value"`
			IsSecret bool   `json:"is_secret"`
		} `json:"vars"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	vars := make([]store.EnvVar, 0, len(req.Vars))
	for _, v := range req.Vars {
		encrypted, err := h.enc.Encrypt(v.Value)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "could not encrypt value for key "+v.Key)
			return
		}
		vars = append(vars, store.EnvVar{
			Key:      v.Key,
			Value:    encrypted,
			IsSecret: v.IsSecret,
		})
	}

	existing, _ := h.db.EnvVars.FindWhere(func(s store.EnvVarSet) bool {
		return s.ProjectID == projectID
	})
	version := 1
	for _, s := range existing {
		if s.Version >= version {
			version = s.Version + 1
		}
	}

	set := store.EnvVarSet{
		ID:        store.NewULID(),
		ProjectID: projectID,
		Version:   version,
		Vars:      vars,
		CreatedAt: timeNow(),
		CreatedBy: claims.UserID,
	}
	if err := h.db.EnvVars.Save(set); err != nil {
		writeError(w, http.StatusInternalServerError, "could not save env vars")
		return
	}
	writeJSON(w, http.StatusCreated, maskSecrets(set))
}

// EnvHistory returns all env var set versions for a project, newest first.
func (h *H) EnvHistory(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	sets, err := h.db.EnvVars.FindWhere(func(s store.EnvVarSet) bool {
		return s.ProjectID == projectID
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not fetch env history")
		return
	}
	sort.Slice(sets, func(i, j int) bool { return sets[i].Version > sets[j].Version })

	out := make([]any, len(sets))
	for i, s := range sets {
		out[i] = maskSecrets(s)
	}
	writeJSON(w, http.StatusOK, out)
}

// maskSecrets returns a copy of the set with secret values replaced by "********".
func maskSecrets(set store.EnvVarSet) map[string]any {
	vars := make([]map[string]any, len(set.Vars))
	for i, v := range set.Vars {
		val := v.Value
		if v.IsSecret {
			val = "********"
		}
		vars[i] = map[string]any{
			"key":       v.Key,
			"value":     val,
			"is_secret": v.IsSecret,
		}
	}
	return map[string]any{
		"id":         set.ID,
		"project_id": set.ProjectID,
		"version":    set.Version,
		"vars":       vars,
		"created_at": set.CreatedAt,
		"created_by": set.CreatedBy,
	}
}
