// Command offdock starts the OffDock offline Docker deployment manager.
package main

import (
	"context"
	"fmt"
	"io/fs"
	"log/slog"
	"strings"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
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

	// 7. Build router.
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

	// 8. Serve embedded React frontend for all non-API routes.
	staticFS, err := fs.Sub(offdock.Static, "web/dist")
	if err != nil {
		return fmt.Errorf("static fs: %w", err)
	}
	mux := http.NewServeMux()
	// Only /api/ routes go to the Chi router; everything else (including /setup,
	// /login, /projects/...) is served as index.html for client-side routing.
	mux.Handle("/api/", router)
	mux.Handle("/", spaHandler(staticFS))

	// 9. HTTP server with graceful shutdown.
	srv := &http.Server{
		Addr:         fmt.Sprintf("0.0.0.0:%d", cfg.Port),
		Handler:      mux,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 0, // SSE streams must not time out
		IdleTimeout:  120 * time.Second,
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
