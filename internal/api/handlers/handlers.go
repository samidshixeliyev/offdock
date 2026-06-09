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
	"offdock/internal/mailer"
	authmw "offdock/internal/middleware"
	"offdock/internal/store"
	"offdock/internal/system"
)

// H bundles all dependencies required by handlers.
type H struct {
	db             *store.DB
	auth           *auth.Service
	enc            *crypto.Encryptor
	docker         *docker.Client
	deployer       *deploy.Engine
	stats          *system.Collector
	hub            *sse.Hub
	projectsDir    string
	dataDir        string
	logDir         string
	defaultPEMPath string
	mailer         *mailer.Mailer
	// settingsMu guards smtpSettings and oauthSettings — both can be read by
	// concurrent HTTP requests and written by their respective Save handlers.
	settingsMu    sync.RWMutex
	smtpSettings  store.SMTPSettings
	oauthSettings store.OAuthSettings
	deployCancels  sync.Map  // streamKey → context.CancelFunc
	limiter        *authmw.LoginLimiter
	spanPruneMu    sync.Mutex // prevents concurrent PruneOTelSpans goroutines
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
	logDir string,
	defaultPEMPath string,
	m *mailer.Mailer,
	smtpSettings store.SMTPSettings,
	oauthSettings store.OAuthSettings,
) *H {
	return &H{
		db:             db,
		auth:           authSvc,
		enc:            enc,
		docker:         dockerClient,
		deployer:       deployer,
		stats:          stats,
		hub:            hub,
		projectsDir:    projectsDir,
		dataDir:        dataDir,
		logDir:         logDir,
		defaultPEMPath: defaultPEMPath,
		mailer:         m,
		smtpSettings:   smtpSettings,
		oauthSettings:  oauthSettings,
		limiter:        authmw.NewLoginLimiter(10, time.Minute),
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
