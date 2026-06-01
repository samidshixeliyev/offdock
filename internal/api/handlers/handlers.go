// Package handlers contains all HTTP request handlers for the OffDock API.
package handlers

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"offdock/internal/api/sse"
	"offdock/internal/auth"
	"offdock/internal/crypto"
	"offdock/internal/deploy"
	"offdock/internal/docker"
	authmw "offdock/internal/middleware"
	"offdock/internal/store"
	"offdock/internal/system"
)

// H bundles all dependencies required by handlers.
type H struct {
	db                 *store.DB
	auth               *auth.Service
	enc                *crypto.Encryptor
	docker             *docker.Client
	deployer           *deploy.Engine
	stats              *system.Collector
	hub                *sse.Hub
	projectsDir        string
	dataDir            string
	defaultCertPath    string
	defaultCertKeyPath string
	deployCancels      sync.Map // streamKey → context.CancelFunc
	limiter            *authmw.LoginLimiter
}

// New returns an initialised handler bundle.
func New(
	db *store.DB,
	authSvc *auth.Service,
	enc *crypto.Encryptor,
	dockerClient *docker.Client,
	deployer *deploy.Engine,
	stats *system.Collector,
	hub *sse.Hub,
	projectsDir string,
	dataDir string,
	defaultCertPath string,
	defaultCertKeyPath string,
) *H {
	return &H{
		db:                 db,
		auth:               authSvc,
		enc:                enc,
		docker:             dockerClient,
		deployer:           deployer,
		stats:              stats,
		hub:                hub,
		projectsDir:        projectsDir,
		dataDir:            dataDir,
		defaultCertPath:    defaultCertPath,
		defaultCertKeyPath: defaultCertKeyPath,
		limiter:            authmw.NewLoginLimiter(10, time.Minute),
	}
}

// --- helpers ----------------------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v) //nolint:errcheck
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func decodeJSON(r *http.Request, v any) error {
	return json.NewDecoder(r.Body).Decode(v)
}
