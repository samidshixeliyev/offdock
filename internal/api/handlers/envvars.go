package handlers

import (
	"net/http"
	"sort"

	"github.com/go-chi/chi/v5"

	authmw "offdock/internal/middleware"
	"offdock/internal/store"
)

// GetEnv returns the latest env var set for a project.
// Non-secret values are decrypted; secret values are returned as "********".
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
	writeJSON(w, http.StatusOK, h.marshalEnvSet(sets[0]))
}

// SaveEnv stores a new env var set version.
// All values are encrypted at rest. For secret vars whose value is the
// placeholder "********", the existing encrypted value is preserved so that
// the user can save without re-entering secrets they haven't changed.
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

	// Load existing versions to preserve encrypted values for unchanged secrets.
	existing, _ := h.db.EnvVars.FindWhere(func(s store.EnvVarSet) bool {
		return s.ProjectID == projectID
	})
	existingEncrypted := make(map[string]string)
	if len(existing) > 0 {
		best := existing[0]
		for _, s := range existing[1:] {
			if s.Version > best.Version {
				best = s
			}
		}
		for _, v := range best.Vars {
			existingEncrypted[v.Key] = v.Value
		}
	}

	vars := make([]store.EnvVar, 0, len(req.Vars))
	for _, v := range req.Vars {
		var encrypted string
		// Preserve existing ciphertext when a secret has not been changed.
		if v.IsSecret && v.Value == "********" {
			enc, ok := existingEncrypted[v.Key]
			if !ok {
				writeError(w, http.StatusBadRequest, "secret "+v.Key+" has no stored value; enter the actual value")
				return
			}
			encrypted = enc
		} else {
			var err error
			encrypted, err = h.enc.Encrypt(v.Value)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "could not encrypt value for key "+v.Key)
				return
			}
		}
		vars = append(vars, store.EnvVar{
			Key:      v.Key,
			Value:    encrypted,
			IsSecret: v.IsSecret,
		})
	}

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
	writeJSON(w, http.StatusCreated, h.marshalEnvSet(set))
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
		out[i] = h.marshalEnvSet(s)
	}
	writeJSON(w, http.StatusOK, out)
}

// marshalEnvSet returns a JSON-safe map with non-secret values decrypted
// and secret values replaced by the sentinel "********".
func (h *H) marshalEnvSet(set store.EnvVarSet) map[string]any {
	vars := make([]map[string]any, len(set.Vars))
	for i, v := range set.Vars {
		var val string
		if v.IsSecret {
			val = "********"
		} else {
			plain, err := h.enc.Decrypt(v.Value)
			if err != nil {
				val = "" // decryption error — surface as empty so the UI shows clearly
			} else {
				val = plain
			}
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
