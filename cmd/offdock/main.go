package main

import (
	"context"
	"fmt"
	"io"
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
	"offdock/internal/nginx"
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

	// Dual-output logging: stdout (captured by journald when run under systemd)
	// + rotate-safe log file (for non-systemd environments and log viewers).
	logOpts := &slog.HandlerOptions{
		Level: logLevel,
		// Add source file:line for Error and above to aid debugging.
		AddSource: logLevel == slog.LevelDebug,
	}
	var logWriter io.Writer = os.Stdout
	if cfg.LogDir != "" {
		if err := os.MkdirAll(cfg.LogDir, 0o700); err == nil {
			if lf, err := os.OpenFile(
				filepath.Join(cfg.LogDir, "offdock.log"),
				os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600,
			); err == nil {
				defer lf.Close()
				logWriter = io.MultiWriter(os.Stdout, lf)
			}
		}
	}
	// JSON format: structured, parseable by log aggregators (journald, ELK, etc.).
	// Use text format only when log_level=debug for human-readable dev output.
	var logHandler slog.Handler
	if cfg.LogLevel == "debug" {
		logHandler = slog.NewTextHandler(logWriter, logOpts)
	} else {
		logHandler = slog.NewJSONHandler(logWriter, logOpts)
	}
	slog.SetDefault(slog.New(logHandler))

	db, err := store.Open(cfg.DataDir)
	if err != nil {
		slog.Error("open store", "err", err)
		os.Exit(1)
	}
	defer db.Close()

	// Enforce retention limits on startup to reclaim space from previous runs.
	go func() {
		db.PruneTraceSessions(500)
		db.PruneOTelSpans(50_000)
	}()

	enc, err := crypto.NewFromMachineID()
	if err != nil {
		slog.Error("init crypto", "err", err)
		os.Exit(1)
	}

	authSvc := auth.New(cfg.JWTSecret)
	dockerClient := docker.New()

	// Ensure the OffDock nginx log format definition is installed on every startup.
	nginx.EnsureLogFormat()

	// Migration: enable access_log on all proxy hosts that have it disabled.
	// This ensures traffic analytics works for all hosts without manual intervention.
	if hosts, err := db.ProxyHosts.FindAll(); err == nil {
		for _, h := range hosts {
			if !h.AccessLog {
				h.AccessLog = true
				if saveErr := db.ProxyHosts.Save(h); saveErr == nil {
					if _, applyErr := nginx.ApplyProxyHost(h); applyErr != nil {
						slog.Warn("access_log migration: could not apply nginx config", "host", h.Domain, "err", applyErr)
					} else {
						slog.Info("access_log enabled for proxy host", "host", h.Domain)
					}
				}
			}
		}
	}

	projectsDir := filepath.Join(filepath.Dir(cfg.DataDir), "projects")
	if err := os.MkdirAll(projectsDir, 0o700); err != nil {
		slog.Error("create projects dir", "err", err)
		os.Exit(1)
	}

	deployer := deploy.New(db, dockerClient, enc, projectsDir)
	stats := system.New(dockerClient, cfg.DataDir)
	hub := sse.New()

	smtpMode := cfg.SMTPMode
	if smtpMode == "" && cfg.SMTPStartTLS {
		smtpMode = "starttls"
	}
	m := mailer.NewWithClientCert(cfg.SMTPHost, cfg.SMTPPort, cfg.SMTPUsername, cfg.SMTPPassword,
		cfg.SMTPFrom, smtpMode, cfg.SMTPSkipVerify, cfg.SMTPCACertFile,
		cfg.SMTPClientCertFile, cfg.SMTPClientKeyFile)

	smtpSettings := store.SMTPSettings{
		Host:           cfg.SMTPHost,
		Port:           cfg.SMTPPort,
		Username:       cfg.SMTPUsername,
		Password:       cfg.SMTPPassword,
		From:           cfg.SMTPFrom,
		Mode:           smtpMode,
		StartTLS:       cfg.SMTPStartTLS,
		SkipVerify:     cfg.SMTPSkipVerify,
		CACertFile:     cfg.SMTPCACertFile,
		ClientCertFile: cfg.SMTPClientCertFile,
		ClientKeyFile:  cfg.SMTPClientKeyFile,
		AdminEmail:     cfg.DNSAdminEmail,
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
		ClaimFirst:    cfg.OAuthClaimFirst,
		ClaimLast:     cfg.OAuthClaimLast,
		CACertFile:    cfg.OAuthCACertFile,
		TLSSkipVerify: cfg.OAuthTLSSkipVerify,
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
		// Route /api/* and /v1/* (OTLP + simple span paths) to the API router.
		if (len(r.URL.Path) >= 4 && r.URL.Path[:4] == "/api") ||
			(len(r.URL.Path) >= 3 && r.URL.Path[:3] == "/v1") {
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
