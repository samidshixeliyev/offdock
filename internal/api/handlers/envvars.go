package handlers

import (
	"net/http"
	"sort"
	"strconv"

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
	if _, err := h.db.Projects.FindByID(projectID); err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
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
	plainForHash := make([]envVarForHash, 0, len(req.Vars))
	for _, v := range req.Vars {
		var encrypted string
		var plaintext string
		// Preserve existing ciphertext when a secret has not been changed.
		if v.IsSecret && v.Value == "********" {
			enc, ok := existingEncrypted[v.Key]
			if !ok {
				writeError(w, http.StatusBadRequest, "secret "+v.Key+" has no stored value; enter the actual value")
				return
			}
			encrypted = enc
			// Decrypt the preserved value so the content hash reflects the real
			// (unchanged) secret rather than non-deterministic ciphertext.
			if dec, err := h.enc.Decrypt(enc); err == nil {
				plaintext = dec
			}
		} else {
			var err error
			encrypted, err = h.enc.Encrypt(v.Value)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "could not encrypt value for key "+v.Key)
				return
			}
			plaintext = v.Value
		}
		vars = append(vars, store.EnvVar{
			Key:      v.Key,
			Value:    encrypted,
			IsSecret: v.IsSecret,
		})
		plainForHash = append(plainForHash, envVarForHash{Key: v.Key, Value: plaintext, IsSecret: v.IsSecret})
	}

	hash := envContentHash(plainForHash)

	// Find the latest existing version for both numbering and dedup.
	version := 1
	var latest *store.EnvVarSet
	for i := range existing {
		s := existing[i]
		if s.Version >= version {
			version = s.Version + 1
		}
		if latest == nil || s.Version > latest.Version {
			latest = &existing[i]
		}
	}

	// Dedup: skip creating a new version when content matches the latest.
	if latest != nil {
		latestHash := latest.ContentHash
		if latestHash == "" {
			latestHash = h.envSetContentHash(*latest)
		}
		if latestHash == hash {
			if latest.ContentHash == "" {
				latest.ContentHash = hash
				_ = h.db.EnvVars.Save(*latest)
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"unchanged": true,
				"env":       h.marshalEnvSet(*latest),
			})
			return
		}
	}

	set := store.EnvVarSet{
		ID:          store.NewULID(),
		ProjectID:   projectID,
		Version:     version,
		Vars:        vars,
		ContentHash: hash,
		CreatedAt:   timeNow(),
		CreatedBy:   claims.UserID,
	}
	if err := h.db.EnvVars.Save(set); err != nil {
		writeError(w, http.StatusInternalServerError, "could not save env vars")
		return
	}
	h.logAudit(r, "save_env", "project", projectID, "", "v"+strconv.Itoa(version))
	writeJSON(w, http.StatusCreated, h.marshalEnvSet(set))
}

// EnvHistory returns all env var set versions for a project, newest first.
// With ?reveal=true AND a superadmin caller, secret values are decrypted
// (audited) so an operator can inspect what a past version actually contained.
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

	reveal := false
	if r.URL.Query().Get("reveal") == "true" {
		if claims := authmw.ClaimsFromContext(r.Context()); claims != nil && claims.Role == store.RoleSuperAdmin {
			reveal = true
			h.logAudit(r, "env_reveal_secrets", "project", projectID, "", "env history")
		}
	}

	out := make([]any, len(sets))
	for i, s := range sets {
		out[i] = h.marshalEnvSetOpts(s, reveal)
	}
	writeJSON(w, http.StatusOK, out)
}

// RestoreEnv creates a new env version that is a copy of an older version,
// preserving encrypted secret values exactly (true restore, including secrets).
func (h *H) RestoreEnv(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "id")
	claims := authmw.ClaimsFromContext(r.Context())

	var req struct {
		Version int `json:"version"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	sets, _ := h.db.EnvVars.FindWhere(func(s store.EnvVarSet) bool {
		return s.ProjectID == projectID
	})
	if len(sets) == 0 {
		writeError(w, http.StatusNotFound, "no env versions for project")
		return
	}

	var source *store.EnvVarSet
	nextVersion := 1
	for i := range sets {
		if sets[i].Version >= nextVersion {
			nextVersion = sets[i].Version + 1
		}
		if sets[i].Version == req.Version {
			source = &sets[i]
		}
	}
	if source == nil {
		writeError(w, http.StatusNotFound, "version not found")
		return
	}

	// Copy ciphertext as-is — preserves secrets exactly.
	set := store.EnvVarSet{
		ID:          store.NewULID(),
		ProjectID:   projectID,
		Version:     nextVersion,
		Vars:        append([]store.EnvVar(nil), source.Vars...),
		ContentHash: h.envSetContentHash(*source),
		CreatedAt:   timeNow(),
		CreatedBy:   claims.UserID,
	}
	if err := h.db.EnvVars.Save(set); err != nil {
		writeError(w, http.StatusInternalServerError, "could not restore env vars")
		return
	}
	h.logAudit(r, "restore_env", "project", projectID, "", "v"+strconv.Itoa(req.Version)+"→v"+strconv.Itoa(nextVersion))
	writeJSON(w, http.StatusCreated, h.marshalEnvSet(set))
}

// envSetContentHash computes the canonical content hash of a stored env set by
// decrypting each value to plaintext. Used to backfill the hash on legacy
// records (saved before ContentHash existed) so dedup works retroactively.
func (h *H) envSetContentHash(set store.EnvVarSet) string {
	plain := make([]envVarForHash, 0, len(set.Vars))
	for _, v := range set.Vars {
		val, err := h.enc.Decrypt(v.Value)
		if err != nil {
			val = ""
		}
		plain = append(plain, envVarForHash{Key: v.Key, Value: val, IsSecret: v.IsSecret})
	}
	return envContentHash(plain)
}

// marshalEnvSet returns a JSON-safe map with non-secret values decrypted
// and secret values replaced by the sentinel "********".
func (h *H) marshalEnvSet(set store.EnvVarSet) map[string]any {
	return h.marshalEnvSetOpts(set, false)
}

// marshalEnvSetOpts is like marshalEnvSet but, when reveal is true, decrypts
// secret values too (used only for superadmin "reveal" requests, which are
// audited by the caller).
func (h *H) marshalEnvSetOpts(set store.EnvVarSet, reveal bool) map[string]any {
	vars := make([]map[string]any, len(set.Vars))
	for i, v := range set.Vars {
		var val string
		if v.IsSecret && !reveal {
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
