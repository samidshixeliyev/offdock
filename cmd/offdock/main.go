package main

import (
	"context"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
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
	"offdock/internal/mailer"
	"offdock/internal/store"
	"offdock/internal/system"
)

// Version is set at build time via -ldflags.
var Version = "dev"

func main() {
	cfg, err := config.Load("")
	if err != nil {
		fmt.Fprintf(os.Stderr, "config: %v\n", err)
		os.Exit(1)
	}

	logLevel := slog.LevelInfo
	if cfg.LogLevel == "debug" {
		logLevel = slog.LevelDebug
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: logLevel})))

	db, err := store.Open(cfg.DataDir)
	if err != nil {
		slog.Error("open store", "err", err)
		os.Exit(1)
	}
	defer db.Close()

	enc, err := crypto.NewFromMachineID()
	if err != nil {
		slog.Error("init crypto", "err", err)
		os.Exit(1)
	}

	authSvc := auth.New(cfg.JWTSecret)
	dockerClient := docker.New()

	projectsDir := filepath.Join(filepath.Dir(cfg.DataDir), "projects")
	if err := os.MkdirAll(projectsDir, 0o700); err != nil {
		slog.Error("create projects dir", "err", err)
		os.Exit(1)
	}

	deployer := deploy.New(db, dockerClient, enc, projectsDir)
	stats := system.New(dockerClient, cfg.DataDir)
	hub := sse.New()

	m := mailer.New(cfg.SMTPHost, cfg.SMTPPort, cfg.SMTPUsername, cfg.SMTPPassword,
		cfg.SMTPFrom, cfg.SMTPStartTLS, cfg.SMTPSkipVerify)

	smtpSettings := store.SMTPSettings{
		Host:       cfg.SMTPHost,
		Port:       cfg.SMTPPort,
		Username:   cfg.SMTPUsername,
		Password:   cfg.SMTPPassword,
		From:       cfg.SMTPFrom,
		StartTLS:   cfg.SMTPStartTLS,
		SkipVerify: cfg.SMTPSkipVerify,
		AdminEmail: cfg.DNSAdminEmail,
	}

	oauthSettings := store.OAuthSettings{
		Enabled:       cfg.OAuthEnabled,
		Issuer:        cfg.OAuthIssuer,
		ClientID:      cfg.OAuthClientID,
		ClientSecret:  cfg.OAuthClientSecret,
		RedirectURI:   cfg.OAuthRedirectURI,
		Scope:         cfg.OAuthScope,
		ClaimSub:      cfg.OAuthClaimSub,
		ClaimEmail:    cfg.OAuthClaimEmail,
		ClaimUsername: cfg.OAuthClaimUsername,
		ClaimName:     cfg.OAuthClaimName,
	}
	if oauthSettings.Scope == "" {
		oauthSettings.Scope = "openid profile email"
	}

	apiRouter := api.NewRouter(api.Deps{
		DB:             db,
		Auth:           authSvc,
		Encryptor:      enc,
		Docker:         dockerClient,
		Deployer:       deployer,
		Stats:          stats,
		SSEHub:         hub,
		ProjectsDir:    projectsDir,
		DataDir:        cfg.DataDir,
		DefaultPEMPath: cfg.DefaultPEMPath,
		Mailer:         m,
		SMTPSettings:   smtpSettings,
		OAuthSettings:  oauthSettings,
	})

	staticFS, err := fs.Sub(offdock.Static, "web/dist")
	if err != nil {
		slog.Error("sub static fs", "err", err)
		os.Exit(1)
	}

	srv := &http.Server{
		Addr:    ":" + strconv.Itoa(cfg.Port),
		Handler: newHandler(apiRouter, staticFS),
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	slog.Info("offdock starting", "version", Version, "port", cfg.Port)

	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("server", "err", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()
	slog.Info("shutting down")
	shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutCtx)
}

// newHandler routes /api/ to the API router and everything else to the
// embedded React SPA, falling back to index.html for client-side routes.
func newHandler(apiRouter http.Handler, staticFS fs.FS) http.Handler {
	fileServer := http.FileServer(http.FS(staticFS))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if len(r.URL.Path) >= 4 && r.URL.Path[:4] == "/api" {
			apiRouter.ServeHTTP(w, r)
			return
		}
		// Try to serve the file; fall back to index.html for SPA routing.
		_, err := fs.Stat(staticFS, r.URL.Path[1:])
		if err != nil {
			r2 := r.Clone(r.Context())
			r2.URL.Path = "/"
			fileServer.ServeHTTP(w, r2)
			return
		}
		fileServer.ServeHTTP(w, r)
	})
}
