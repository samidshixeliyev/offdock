// Command offdock starts the OffDock offline Docker deployment manager.
package main

import (
	"context"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	offdock "offdock"
	"offdock/internal/api"
	"offdock/internal/api/sse"
	"offdock/internal/auth"
	"offdock/internal/config"
	"offdock/internal/crypto"
	"offdock/internal/deploy"
	"offdock/internal/docker"
	nginxpkg "offdock/internal/nginx"
	"offdock/internal/store"
	"offdock/internal/system"
)

// Version is set at build time via -ldflags.
var Version = "dev"

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "offdock: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	// 1. Load config.
	cfg, err := config.Load("")
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	// 2. Set up structured logging.
	if err := os.MkdirAll(cfg.LogDir, 0o700); err != nil {
		return fmt.Errorf("create log dir: %w", err)
	}
	logFile, err := os.OpenFile(
		filepath.Join(cfg.LogDir, "offdock.log"),
		os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600,
	)
	if err != nil {
		return fmt.Errorf("open log file: %w", err)
	}
	defer logFile.Close()

	level := slog.LevelInfo
	if cfg.LogLevel == "debug" {
		level = slog.LevelDebug
	}
	slog.SetDefault(slog.New(slog.NewJSONHandler(logFile, &slog.HandlerOptions{Level: level})))

	slog.Info("starting offdock", "version", Version, "port", cfg.Port)

	// 3. Open storage.
	db, err := store.Open(cfg.DataDir)
	if err != nil {
		return fmt.Errorf("open store: %w", err)
	}
	defer db.Close()

	// 4. Derive encryption key from machine ID.
	enc, err := crypto.NewFromMachineID()
	if err != nil {
		slog.Warn("machine-id unavailable; falling back to config secret for encryption",
			"err", err)
		enc, err = crypto.NewFromSecret(cfg.JWTSecret)
		if err != nil {
			return fmt.Errorf("init encryptor: %w", err)
		}
	}

	// 5. Auth service.
	authSvc := auth.New(cfg.JWTSecret)

	// 6. Service dependencies.
	dockerClient := docker.New()
	projectsDir := filepath.Join(filepath.Dir(cfg.DataDir), "projects")

	deployer := deploy.New(db, dockerClient, enc, projectsDir)
	statsCollector := system.New(dockerClient, cfg.DataDir)
	hub := sse.New()

	// 7. Mark any deployments stuck in "running" state as failed (crash recovery).
	markStuckDeployments(db)

	// 8. Bootstrap nginx: load bundled image → start container → apply project configs.
	go bootstrapNginx(db)

	// 8. Build router.
	router := api.NewRouter(api.Deps{
		DB:          db,
		Auth:        authSvc,
		Encryptor:   enc,
		Docker:      dockerClient,
		Deployer:    deployer,
		Stats:       statsCollector,
		SSEHub:      hub,
		ProjectsDir: projectsDir,
	})

	// 9. Serve embedded React frontend for all non-API routes.
	staticFS, err := fs.Sub(offdock.Static, "web/dist")
	if err != nil {
		return fmt.Errorf("static fs: %w", err)
	}
	mux := http.NewServeMux()
	// Only /api/ routes go to the Chi router; everything else (including /setup,
	// /login, /projects/...) is served as index.html for client-side routing.
	mux.Handle("/api/", router)
	mux.Handle("/", spaHandler(staticFS))

	// 10. HTTP server with graceful shutdown.
	srv := &http.Server{
		Addr: fmt.Sprintf("0.0.0.0:%d", cfg.Port),
		Handler: mux,
		// ReadHeaderTimeout only — ReadTimeout is intentionally omitted so
		// large uploads (up to 5 GB) are not killed mid-transfer.
		ReadHeaderTimeout: 15 * time.Second,
		WriteTimeout:      0, // SSE streams must not time out
		IdleTimeout:       120 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		slog.Info("offdock listening", "addr", srv.Addr)
		errCh <- srv.ListenAndServe()
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	select {
	case err := <-errCh:
		return fmt.Errorf("server error: %w", err)
	case sig := <-quit:
		slog.Info("shutting down", "signal", sig)
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		return srv.Shutdown(ctx)
	}
}

// markStuckDeployments finds deployments left in "running" state from a previous
// process and marks them failed so new deploys are not blocked.
func markStuckDeployments(db *store.DB) {
	all, err := db.Deployments.FindWhere(func(d store.DeploymentRecord) bool {
		return d.Status == store.DeployStatusRunning
	})
	if err != nil || len(all) == 0 {
		return
	}
	now := time.Now().UTC()
	for _, d := range all {
		d.Status = store.DeployStatusFailed
		d.FinishedAt = &now
		d.LogText += "\nFAILED: process restarted — deployment interrupted"
		db.Deployments.Save(d) //nolint:errcheck
		slog.Warn("startup: marked stuck deployment as failed", "id", d.ID, "project", d.ProjectID)
	}
}

// bootstrapNginx runs at startup in a goroutine.
// It starts the offdock-nginx container (nginx-ui) if the image is already present
// and the container is not yet running. If the image is absent the user must
// import uozi-lab/nginx-ui:latest via the Import page first.
func bootstrapNginx(db *store.DB) {
	slog.Info("nginx bootstrap: starting")

	// ── Step 0: ensure Docker networks exist ──────────────────────────────────
	if err := nginxpkg.EnsureNetworks(); err != nil {
		slog.Warn("nginx bootstrap: could not create networks", "err", err)
	} else {
		slog.Info("nginx bootstrap: networks ready")
	}

	// ── Step 1: check that the nginx-ui image is present ──────────────────────
	imgCtx, imgCancel := context.WithTimeout(context.Background(), 10*time.Second)
	imgErr := exec.CommandContext(imgCtx, "docker", "image", "inspect", nginxpkg.ContainerImage).Run()
	imgCancel()

	if imgErr != nil {
		slog.Info("nginx bootstrap: image not found — import uozi-lab/nginx-ui:latest via the Import page")
		return
	}

	// ── Step 2: start offdock-nginx if not running ────────────────────────────
	status := nginxpkg.GetContainerStatus()
	if status.Running {
		slog.Info("nginx bootstrap: container already running")
	} else {
		slog.Info("nginx bootstrap: starting offdock-nginx container")
		if err := nginxpkg.StartNginxContainer(); err != nil {
			slog.Warn("nginx bootstrap: container start failed", "err", err)
		} else {
			slog.Info("nginx bootstrap: container started")
		}
	}

	// ── Step 3: re-apply all active project configs ────────────────────────────
	projects, err := db.Projects.FindAll()
	if err != nil {
		slog.Warn("nginx bootstrap: could not list projects", "err", err)
		return
	}
	applied := 0
	for _, project := range projects {
		cfgs, err := db.Nginx.FindWhere(func(n store.NginxConfig) bool {
			return n.ProjectID == project.ID && n.Active
		})
		if err != nil || len(cfgs) == 0 {
			continue
		}
		if _, err := nginxpkg.Apply(cfgs[0], project.Name); err != nil {
			slog.Warn("nginx bootstrap: apply failed", "project", project.Name, "err", err)
		} else {
			applied++
			slog.Info("nginx bootstrap: applied", "project", project.Name, "domain", cfgs[0].Domain)
		}
	}
	slog.Info("nginx bootstrap: complete", "configs_applied", applied)
}

// spaHandler serves the React SPA, falling back to index.html for unknown paths
// so that client-side routing works correctly.
//
// fs.FS paths must NOT start with "/" — strip it before stat-ing.
func spaHandler(fsys fs.FS) http.Handler {
	fileServer := http.FileServer(http.FS(fsys))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Normalise to a clean fs.FS-compatible path (no leading slash).
		name := strings.TrimPrefix(r.URL.Path, "/")
		if name == "" {
			name = "."
		}
		if _, err := fs.Stat(fsys, name); err != nil {
			// Path not found in embedded FS → serve index.html for SPA routes.
			r2 := r.Clone(r.Context())
			r2.URL.Path = "/"
			fileServer.ServeHTTP(w, r2)
			return
		}
		fileServer.ServeHTTP(w, r)
	})
}
