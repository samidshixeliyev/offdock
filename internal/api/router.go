// Package api wires the HTTP router and all middleware together.
package api

import (
	"bufio"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	chimiddleware "github.com/go-chi/chi/v5/middleware"

	"offdock/internal/api/handlers"
	"offdock/internal/api/sse"
	authmw "offdock/internal/middleware"
	"offdock/internal/auth"
	"offdock/internal/crypto"
	"offdock/internal/deploy"
	"offdock/internal/docker"
	"offdock/internal/mailer"
	"offdock/internal/store"
	"offdock/internal/system"
)

// Deps bundles all service dependencies passed to handler constructors.
type Deps struct {
	DB             *store.DB
	Auth           *auth.Service
	Encryptor      *crypto.Encryptor
	Docker         *docker.Client
	Deployer       *deploy.Engine
	Stats          *system.Collector
	SSEHub         *sse.Hub
	ProjectsDir    string
	DataDir        string
	LogDir         string
	DefaultPEMPath string
	Mailer         *mailer.Mailer
	SMTPSettings   store.SMTPSettings
	OAuthSettings  store.OAuthSettings
}

// NewRouter builds and returns the fully configured Chi router.
// The static filesystem (React build) is served on all non-API routes by the caller.
func NewRouter(deps Deps) http.Handler {
	r := chi.NewRouter()

	// Global middleware
	r.Use(chimiddleware.RealIP)
	r.Use(chimiddleware.RequestID)
	r.Use(slogRequestLogger) // structured JSON access log via slog (replaces chimiddleware.Logger)
	r.Use(chimiddleware.Recoverer)
	r.Use(jsonContentType)

	h := handlers.New(deps.DB, deps.Auth, deps.Encryptor, deps.Docker, deps.Deployer, deps.Stats, deps.SSEHub, deps.ProjectsDir, deps.DataDir, deps.LogDir, deps.DefaultPEMPath, deps.Mailer, deps.SMTPSettings, deps.OAuthSettings)

	// --- OTLP receivers (public — no auth, called by OTel agents inside containers) ---
	r.Post("/v1/traces", h.ReceiveOTLPTraces)   // OTLP JSON traces (Java agent, Node SDK, etc.)
	r.Post("/v1/logs", h.ReceiveOTLPNoOp)       // Accept logs — return 200, not stored
	r.Post("/v1/metrics", h.ReceiveOTLPNoOp)    // Accept metrics — return 200, not stored
	r.Post("/v1/span", h.ReceiveSimpleSpan)     // Simple JSON — any language, no SDK
	r.Post("/v1/spans", h.ReceiveSimpleSpans)   // Batch version

	// --- Public routes ---
	r.Post("/api/v1/auth/login", h.Login)
	// Logout is best-effort — also works without a valid token (clears cookie).
	// But we register it in *both* groups: authenticated (revokes session) and
	// public (fallback if token already expired/missing so the cookie is still cleared).
	r.Post("/api/v1/auth/logout", h.Logout)
	// OAuth2 / OIDC — public; callback uses redirects, not JSON.
	r.Get("/api/v1/auth/oauth/start", h.OAuthStart)
	r.Get("/api/v1/auth/oauth/callback", h.OAuthCallback)
	r.Get("/api/v1/auth/oauth/logout", h.OAuthLogout)
	// Public status endpoint — login page uses this to decide whether to show the SSO button.
	r.Get("/api/v1/auth/oauth/status", h.OAuthStatus)
	// Setup endpoints live under /api/v1 so the /setup path is served
	// by the SPA handler (index.html), not the API router.
	r.Get("/api/v1/setup", h.SetupStatus)
	r.Post("/api/v1/setup", h.SetupCreate)

	// --- Authenticated routes ---
	r.Group(func(r chi.Router) {
		r.Use(authmw.Authenticate(deps.Auth, deps.DB))

		r.Post("/api/v1/auth/logout", h.Logout) // also authenticated so context claims revoke session
		r.Get("/api/v1/auth/me", h.Me)

		// Users — superadmin only for write operations
		r.Get("/api/v1/users", h.ListUsers)
		r.With(authmw.RequireRoleLive(deps.DB, store.RoleSuperAdmin)).Post("/api/v1/users", h.CreateUser)
		r.With(authmw.RequireRoleLive(deps.DB, store.RoleSuperAdmin)).Patch("/api/v1/users/{id}", h.UpdateUser)
		r.With(authmw.RequireRoleLive(deps.DB, store.RoleSuperAdmin)).Delete("/api/v1/users/{id}", h.DeleteUser)
		r.With(authmw.RequireRoleLive(deps.DB, store.RoleSuperAdmin)).Get("/api/v1/users/{id}/audit", h.UserAudit)

		// Permission catalog + custom roles (superadmin manages roles)
		r.Get("/api/v1/permissions", h.ListPermissions)
		r.Get("/api/v1/roles", h.ListCustomRoles)
		r.With(authmw.RequireRoleLive(deps.DB, store.RoleSuperAdmin)).Post("/api/v1/roles", h.CreateCustomRole)
		r.With(authmw.RequireRoleLive(deps.DB, store.RoleSuperAdmin)).Patch("/api/v1/roles/{id}", h.UpdateCustomRole)
		r.With(authmw.RequireRoleLive(deps.DB, store.RoleSuperAdmin)).Delete("/api/v1/roles/{id}", h.DeleteCustomRole)

		// Sessions (own; superadmin sees all)
		r.Get("/api/v1/sessions", h.ListSessions)
		r.Delete("/api/v1/sessions/{id}", h.RevokeSession)

		// Projects
		r.Get("/api/v1/projects", h.ListProjects)
		r.Post("/api/v1/projects/sync-all", h.SyncAllProjectStatus)
		r.With(authmw.RequirePermission(deps.DB, store.PermManageProjects)).Post("/api/v1/projects", h.CreateProject)
		r.Get("/api/v1/projects/{id}", h.GetProject)
		r.With(authmw.RequirePermission(deps.DB, store.PermManageProjects)).Patch("/api/v1/projects/{id}", h.UpdateProject)
		r.With(authmw.RequirePermission(deps.DB, store.PermManageProjects)).Delete("/api/v1/projects/{id}", h.DeleteProject)
		r.With(authmw.RequirePermission(deps.DB, store.PermManageProjects)).Post("/api/v1/projects/{id}/clone", h.CloneProject)

		// Compose
		r.Get("/api/v1/projects/{id}/compose", h.GetCompose)
		r.With(authmw.RequirePermission(deps.DB, store.PermEditCompose)).Post("/api/v1/projects/{id}/compose", h.SaveCompose)
		r.Get("/api/v1/projects/{id}/compose/history", h.ComposeHistory)
		r.Get("/api/v1/projects/{id}/compose/services", h.GetComposeServices)

		// Env vars
		r.Get("/api/v1/projects/{id}/env", h.GetEnv)
		r.With(authmw.RequirePermission(deps.DB, store.PermEditEnv)).Post("/api/v1/projects/{id}/env", h.SaveEnv)
		r.Get("/api/v1/projects/{id}/env/history", h.EnvHistory)
		r.With(authmw.RequirePermission(deps.DB, store.PermEditEnv)).Post("/api/v1/projects/{id}/env/restore", h.RestoreEnv)

		// OffDock managed networks (offdock-external / offdock-internal)
		r.Get("/api/v1/networks", h.ListNetworks)
		r.With(authmw.RequirePermission(deps.DB, store.PermManageNetwork)).Post("/api/v1/networks/{network}/containers/{container}", h.NetworkConnect)
		r.With(authmw.RequirePermission(deps.DB, store.PermManageNetwork)).Delete("/api/v1/networks/{network}/containers/{container}", h.NetworkDisconnect)

		// Full Docker network management
		r.Route("/api/v1/docker/networks", func(r chi.Router) {
			r.Get("/", h.ListAllDockerNetworks)
			r.With(authmw.RequirePermission(deps.DB, store.PermManageNetwork)).Post("/", h.CreateDockerNetwork)
			r.With(authmw.RequirePermission(deps.DB, store.PermManageNetwork)).Delete("/{name}", h.DeleteDockerNetwork)
			r.With(authmw.RequirePermission(deps.DB, store.PermManageNetwork)).Post("/{name}/connect", h.DockerNetworkConnect)
			r.With(authmw.RequirePermission(deps.DB, store.PermManageNetwork)).Post("/{name}/disconnect", h.DockerNetworkDisconnect)
		})

		// Docker volume management
		r.Route("/api/v1/docker/volumes", func(r chi.Router) {
			r.Get("/", h.ListVolumes)
			r.With(authmw.RequirePermission(deps.DB, store.PermManageNetwork)).Post("/prune", h.PruneVolumes)
			r.With(authmw.RequirePermission(deps.DB, store.PermManageNetwork)).Post("/", h.CreateVolume)
			r.With(authmw.RequirePermission(deps.DB, store.PermManageNetwork)).Delete("/{name}", h.DeleteVolume)
		})

		// Global containers (all projects) — sub-router isolates the trie so
		// literal "stats" sub-path does not conflict with {name} param routes.
		r.Route("/api/v1/containers", func(r chi.Router) {
			r.Get("/", h.ListAllContainers)
			r.Get("/stats", h.ContainerStats)
			r.Get("/{container}/networks", h.ContainerNetworks)
			r.Get("/{name}/logs", h.ContainerLogs)
			r.With(authmw.RequirePermission(deps.DB, store.PermContainerOps)).Post("/{name}/{action}", h.ContainerAction)
			r.With(authmw.RequirePermission(deps.DB, store.PermContainerOps)).Delete("/{name}", h.DeleteContainer)
		})

		// Nginx — system nginx status + self-config
		r.Get("/api/v1/nginx/system/status", h.NginxSystemStatus)
		r.Get("/api/v1/nginx/system/self-config", h.SelfNginxConfig)
		r.With(authmw.RequirePermission(deps.DB, store.PermManageProxy)).Post("/api/v1/nginx/system/self-config", h.ApplySelfNginxConfig)

		// Proxy hosts — managed reverse-proxy virtual hosts
		r.Get("/api/v1/proxy/hosts", h.ListProxyHosts)
		r.With(authmw.RequirePermission(deps.DB, store.PermManageProxy)).Post("/api/v1/proxy/hosts", h.CreateProxyHost)
		r.With(authmw.RequirePermission(deps.DB, store.PermManageProxy)).Post("/api/v1/proxy/hosts/preview", h.PreviewProxyHost)
		r.With(authmw.RequirePermission(deps.DB, store.PermManageProxy)).Patch("/api/v1/proxy/hosts/{id}", h.UpdateProxyHost)
		r.With(authmw.RequirePermission(deps.DB, store.PermManageProxy)).Post("/api/v1/proxy/hosts/{id}/toggle", h.ToggleProxyHost)
		r.With(authmw.RequirePermission(deps.DB, store.PermManageProxy)).Delete("/api/v1/proxy/hosts/{id}", h.DeleteProxyHost)
		r.Get("/api/v1/proxy/hosts/{id}/test", h.TestProxyHost)
		r.Get("/api/v1/proxy/server-ip", h.ServerIP)

		// Nginx — global view + per-project management
		r.Get("/api/v1/nginx", h.ListAllNginx)
		r.Get("/api/v1/projects/{id}/nginx", h.GetNginx)
		r.With(authmw.RequirePermission(deps.DB, store.PermManageProxy)).Post("/api/v1/projects/{id}/nginx", h.SaveNginx)
		r.With(authmw.RequirePermission(deps.DB, store.PermManageProxy)).Post("/api/v1/projects/{id}/nginx/apply", h.ApplyNginx)
		r.With(authmw.RequirePermission(deps.DB, store.PermManageProxy)).Delete("/api/v1/projects/{id}/nginx", h.RemoveNginx)
		r.Get("/api/v1/projects/{id}/nginx/preview", h.PreviewNginx)
		r.With(authmw.RequirePermission(deps.DB, store.PermManageProxy)).Post("/api/v1/projects/{id}/nginx/cert", h.GenerateCert)

		// Deploy — global recent list + per-project
		r.Get("/api/v1/deployments", h.ListAllDeployments)
		r.With(authmw.RequirePermission(deps.DB, store.PermDeploy)).Post("/api/v1/projects/{id}/deploy", h.TriggerDeploy)
		r.Get("/api/v1/projects/{id}/deployments", h.ListDeployments)
		r.Get("/api/v1/projects/{id}/deployments/{dep_id}", h.GetDeployment)
		r.Get("/api/v1/projects/{id}/deployments/{dep_id}/stream", h.DeployStream) // SSE
		r.With(authmw.RequirePermission(deps.DB, store.PermDeploy)).Post("/api/v1/projects/{id}/deployments/{dep_id}/cancel", h.CancelDeploy)
		r.With(authmw.RequirePermission(deps.DB, store.PermDeploy)).Delete("/api/v1/projects/{id}/deployments/{dep_id}", h.DeleteDeployment)
			
			// Deploy settings
			r.Get("/api/v1/projects/{id}/deploy-settings", h.GetDeploySettings)
			r.With(authmw.RequirePermission(deps.DB, store.PermDeploy)).Put("/api/v1/projects/{id}/deploy-settings", h.SaveDeploySettings)

			// Deploy tags — named labels for specific compose+env version pairs
			r.Get("/api/v1/projects/{id}/deploy-tags", h.ListDeployTags)
			r.With(authmw.RequirePermission(deps.DB, store.PermDeploy)).Post("/api/v1/projects/{id}/deploy-tags", h.CreateDeployTag)
			r.With(authmw.RequirePermission(deps.DB, store.PermDeploy)).Post("/api/v1/projects/{id}/deploy-tags/{tag_id}/protect", h.ToggleTagProtected)
			r.With(authmw.RequirePermission(deps.DB, store.PermDeploy)).Delete("/api/v1/projects/{id}/deploy-tags/{tag_id}", h.DeleteDeployTag)

			// Rollback — re-deploy a project to a tagged/historical version pair.
			r.With(authmw.RequirePermission(deps.DB, store.PermDeploy)).Post("/api/v1/projects/{id}/rollback", h.Rollback)

		// Containers & logs
		r.Get("/api/v1/projects/{id}/containers", h.ListContainers)
		r.With(authmw.RequirePermission(deps.DB, store.PermContainerOps)).Post("/api/v1/projects/{id}/sync", h.SyncProjectStatus)
		r.With(authmw.RequirePermission(deps.DB, store.PermContainerOps)).Post("/api/v1/projects/{id}/containers/{name}/{action}", h.ContainerAction)
		r.Get("/api/v1/projects/{id}/containers/{name}/logs", h.ContainerLogs) // SSE

		// Images
		r.Get("/api/v1/images", h.ListImages)
		r.With(authmw.RequirePermission(deps.DB, store.PermManageImages)).Post("/api/v1/images/load", h.LoadImage)
		r.With(authmw.RequirePermission(deps.DB, store.PermManageImages)).Post("/api/v1/images/sync", h.SyncImages)
		r.With(authmw.RequirePermission(deps.DB, store.PermManageImages)).Post("/api/v1/images/prune", h.PruneImages)
		r.With(authmw.RequirePermission(deps.DB, store.PermManageImages)).Delete("/api/v1/images/{id}", h.DeleteImage)

		// System stats (SSE) + disk usage
		r.Get("/api/v1/system/stats", h.SystemStats)
		r.Get("/api/v1/system/df", h.SystemDiskUsage)

		// Audit log — admin+ only (contains usernames, IPs, resource names)
		r.With(authmw.RequireRole(store.RoleAdmin)).Get("/api/v1/audit", h.ListAuditEvents)

		// Traffic analytics (nginx access-log metrics + live network connections)
		r.Get("/api/v1/traffic", h.Traffic)
		r.Get("/api/v1/traffic/connections", h.TrafficConnections)

		// Container deep tracing (HTTP + SQL + Redis) via nsenter + tcpdump — SSE stream.
		// Enable/disable toggle persisted in-memory per container.
		r.Get("/api/v1/trace/status", h.GetTraceStatus)
		r.With(authmw.RequirePermission(deps.DB, store.PermTerminal)).
			Post("/api/v1/containers/{name}/trace/enable", h.EnableContainerTrace)
		r.With(authmw.RequirePermission(deps.DB, store.PermTerminal)).
			Delete("/api/v1/containers/{name}/trace/enable", h.DisableContainerTrace)
		r.With(authmw.RequirePermission(deps.DB, store.PermTerminal)).
			Get("/api/v1/containers/{name}/trace", h.ContainerTrace)

		// Persisted trace sessions — list, replay, delete.
		r.Get("/api/v1/trace/sessions", h.ListTraceSessions)
		r.Get("/api/v1/trace/sessions/{id}", h.GetTraceSession)
		r.With(authmw.RequirePermission(deps.DB, store.PermTerminal)).
			Delete("/api/v1/trace/sessions/{id}", h.DeleteTraceSession)

		// DNS ticket management
		r.Get("/api/v1/dns/tickets", h.ListDNSTickets)
		r.With(authmw.RequirePermission(deps.DB, store.PermManageDNS)).Post("/api/v1/dns/tickets", h.CreateDNSTicket)
		r.With(authmw.RequirePermission(deps.DB, store.PermManageDNS)).Patch("/api/v1/dns/tickets/{id}", h.UpdateDNSTicket)
		r.With(authmw.RequirePermission(deps.DB, store.PermManageDNS)).Delete("/api/v1/dns/tickets/{id}", h.DeleteDNSTicket)
		r.With(authmw.RequirePermission(deps.DB, store.PermManageDNS)).Post("/api/v1/dns/tickets/{id}/send", h.SendDNSTicket)
		r.Get("/api/v1/dns/settings", h.GetSMTPSettings)
		r.With(authmw.RequireRoleLive(deps.DB, store.RoleSuperAdmin)).Post("/api/v1/dns/settings", h.SaveSMTPSettings)
		r.With(authmw.RequireRoleLive(deps.DB, store.RoleSuperAdmin)).Post("/api/v1/dns/settings/test", h.TestSMTPSettings)

		// OAuth2 / SSO settings — any authenticated user can read (needed for login page); superadmin writes.
		r.Get("/api/v1/settings/oauth", h.GetOAuthSettings)
		r.With(authmw.RequireRoleLive(deps.DB, store.RoleSuperAdmin)).Post("/api/v1/settings/oauth", h.SaveOAuthSettings)

		// Retention settings — any authenticated user can read; superadmin writes.
		r.Get("/api/v1/settings/retention", h.GetRetentionSettings)
		r.With(authmw.RequireRoleLive(deps.DB, store.RoleSuperAdmin)).Put("/api/v1/settings/retention", h.SaveRetentionSettings)

		// OpenTelemetry — native receiver (spans stored in OffDock DB).
		r.Get("/api/v1/otel/status", h.OTelStatus)
		r.Get("/api/v1/otel/services", h.OTelServices)
		r.Get("/api/v1/otel/operations", h.OTelOperations)
		r.Get("/api/v1/otel/traces", h.OTelTraces)
		r.Get("/api/v1/otel/traces/{id}", h.OTelTrace)
		r.With(authmw.RequireRoleLive(deps.DB, store.RoleAdmin)).Delete("/api/v1/otel/traces", h.OTelDeleteTraces)

		// OffDock application logs (recent lines + live SSE stream) — admin+ only; clear — superadmin only.
		r.With(authmw.RequireRole(store.RoleAdmin)).Get("/api/v1/system/app-logs", h.GetAppLogs)
		r.With(authmw.RequireRole(store.RoleAdmin)).Get("/api/v1/system/app-logs/stream", h.StreamAppLogs)
		r.With(authmw.RequireRoleLive(deps.DB, store.RoleSuperAdmin)).Delete("/api/v1/system/app-logs", h.ClearAppLogs)

		// Backup — superadmin only
		r.With(authmw.RequireRoleLive(deps.DB, store.RoleSuperAdmin)).Get("/api/v1/system/backup", h.DownloadBackup)

		// Full backup/restore + schedule — superadmin only.
		r.With(authmw.RequirePermission(deps.DB, store.PermManageBackups)).Get("/api/v1/system/backups", h.ListBackups)
		r.With(authmw.RequirePermission(deps.DB, store.PermManageBackups)).Post("/api/v1/system/backups", h.CreateBackup)
		r.With(authmw.RequirePermission(deps.DB, store.PermManageBackups)).Get("/api/v1/system/backups/{id}/download", h.DownloadBackupFile)
		r.With(authmw.RequirePermission(deps.DB, store.PermManageBackups)).Get("/api/v1/system/backups/{id}/inspect", h.InspectBackup)
		r.With(authmw.RequireRoleLive(deps.DB, store.RoleSuperAdmin)).Post("/api/v1/system/backups/{id}/restore", h.RestoreBackup)
		r.With(authmw.RequirePermission(deps.DB, store.PermManageBackups)).Delete("/api/v1/system/backups/{id}", h.DeleteBackup)
		r.With(authmw.RequirePermission(deps.DB, store.PermManageBackups)).Get("/api/v1/system/backups-schedule", h.GetBackupSchedule)
		r.With(authmw.RequireRoleLive(deps.DB, store.RoleSuperAdmin)).Post("/api/v1/system/backups-schedule", h.SaveBackupSchedule)

		// Self-update, rollback, and DB compaction — superadmin only.
		r.Get("/api/v1/system/update/status", h.GetSystemUpdateStatus)
		r.With(authmw.RequireRoleLive(deps.DB, store.RoleSuperAdmin)).Post("/api/v1/system/update", h.SystemUpdate)
		r.With(authmw.RequireRoleLive(deps.DB, store.RoleSuperAdmin)).Post("/api/v1/system/update/schedule", h.ScheduleSystemUpdate)
		r.With(authmw.RequireRoleLive(deps.DB, store.RoleSuperAdmin)).Get("/api/v1/system/update/scheduled", h.GetScheduledUpdate)
		r.With(authmw.RequireRoleLive(deps.DB, store.RoleSuperAdmin)).Delete("/api/v1/system/update/scheduled", h.CancelScheduledUpdate)
		r.With(authmw.RequireRoleLive(deps.DB, store.RoleSuperAdmin)).Post("/api/v1/system/rollback", h.SystemRollback)
		r.With(authmw.RequireRoleLive(deps.DB, store.RoleSuperAdmin)).Post("/api/v1/system/compact", h.CompactDB)
		r.With(authmw.RequireRoleLive(deps.DB, store.RoleSuperAdmin)).Post("/api/v1/system/prune", h.PruneAll)

		// Host package safety — install .deb files / fix-broken without removing
		// Docker or nginx; manage apt holds on protected packages.
		r.With(authmw.RequirePermission(deps.DB, store.PermManagePackages)).Get("/api/v1/system/packages/status", h.GetPackageStatus)
		r.With(authmw.RequirePermission(deps.DB, store.PermManagePackages)).Post("/api/v1/system/packages/hold", h.EnsurePackageHolds)
		r.With(authmw.RequirePermission(deps.DB, store.PermManagePackages)).Post("/api/v1/system/packages/install", h.InstallPackages)
		r.With(authmw.RequirePermission(deps.DB, store.PermManagePackages)).Post("/api/v1/system/packages/fix-broken", h.FixBroken)

		// System maintenance — reconcile (self-heal) + memory/disk optimize.
		r.With(authmw.RequirePermission(deps.DB, store.PermSystemMaint)).Post("/api/v1/system/reconcile", h.Reconcile)
		r.With(authmw.RequirePermission(deps.DB, store.PermSystemMaint)).Post("/api/v1/system/optimize", h.Optimize)

		// Reverse proxy status probe (server-side to avoid CORS)
		r.Get("/api/v1/proxy/status", h.ProxyStatus)

		// Terminal command policy — read by terminal users, written by superadmin.
		r.With(authmw.RequirePermission(deps.DB, store.PermTerminal)).Get("/api/v1/terminal/policy", h.GetTerminalPolicy)
		r.With(authmw.RequirePermission(deps.DB, store.PermTerminal)).Get("/api/v1/terminal/policy/defaults", h.GetTerminalPolicyDefaults)
		r.With(authmw.RequireRoleLive(deps.DB, store.RoleSuperAdmin)).Post("/api/v1/terminal/policy", h.SaveTerminalPolicy)

		// Terminal — admin+ only
		r.With(authmw.RequirePermission(deps.DB, store.PermTerminal)).Post("/api/v1/terminal/exec", h.ExecCommand)
		// OTP for root shell (request sends email, verify returns short-lived token)
		r.With(authmw.RequirePermission(deps.DB, store.PermTerminal)).Post("/api/v1/terminal/otp/request", h.OTPRequest)
		r.With(authmw.RequirePermission(deps.DB, store.PermTerminal)).Post("/api/v1/terminal/otp/verify", h.OTPVerify)
		// WebSocket PTY terminals (auth checked via cookie in the upgrade handler)
		r.With(authmw.RequirePermission(deps.DB, store.PermTerminal)).Get("/api/v1/terminal/container/ws", h.ExecContainerWS)
		r.With(authmw.RequirePermission(deps.DB, store.PermTerminal)).Get("/api/v1/terminal/shell/ws", h.HostShellWS)

		// File upload (any file type)
		r.With(authmw.RequirePermission(deps.DB, store.PermManageFiles)).Post("/api/v1/upload", h.UploadFile)
		// File import — move/copy an uploaded file into a target path
		r.With(authmw.RequirePermission(deps.DB, store.PermManageFiles)).Post("/api/v1/files/import", h.FileImport)
		// List files in the uploads staging area
		r.Get("/api/v1/uploads", h.ListUploads)

		// File system explorer — all operations require PermManageFiles.
		// Read operations also enforce isSensitivePath() to block credential files.
		r.Route("/api/v1/files", func(r chi.Router) {
			r.With(authmw.RequirePermission(deps.DB, store.PermManageFiles)).Get("/browse", h.FileBrowse)
			r.With(authmw.RequirePermission(deps.DB, store.PermManageFiles)).Get("/read", h.FileRead)
			r.With(authmw.RequirePermission(deps.DB, store.PermManageFiles)).Get("/search", h.FileSearch)
			r.With(authmw.RequirePermission(deps.DB, store.PermManageFiles)).Post("/write", h.FileWrite)
			r.With(authmw.RequirePermission(deps.DB, store.PermManageFiles)).Post("/mkdir", h.FileMkdir)
			r.With(authmw.RequirePermission(deps.DB, store.PermManageFiles)).Post("/rename", h.FileRename)
			r.With(authmw.RequirePermission(deps.DB, store.PermManageFiles)).Delete("/delete", h.FileDelete)
		})
	})

	return r
}

// jsonContentType sets the default response content type to JSON.
func jsonContentType(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		next.ServeHTTP(w, r)
	})
}

// statusRecorder wraps http.ResponseWriter to capture the status code and bytes written.
// It must forward Flush (SSE) and Hijack (WebSocket) to the underlying writer so that
// those interfaces remain usable through the middleware chain.
type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (sr *statusRecorder) WriteHeader(code int) {
	sr.status = code
	sr.ResponseWriter.WriteHeader(code)
}
func (sr *statusRecorder) Write(b []byte) (int, error) {
	n, err := sr.ResponseWriter.Write(b)
	sr.bytes += n
	return n, err
}

// Flush forwards to the underlying Flusher so SSE streams work through this middleware.
func (sr *statusRecorder) Flush() {
	if f, ok := sr.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Hijack forwards to the underlying Hijacker so WebSocket upgrades work through this middleware.
func (sr *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if h, ok := sr.ResponseWriter.(http.Hijacker); ok {
		return h.Hijack()
	}
	return nil, nil, fmt.Errorf("hijack not supported")
}

// slogRequestLogger is a chi-compatible middleware that emits one structured JSON
// log line per request: method, path, status, duration, remote IP, and request ID.
// SSE endpoints (text/event-stream) are logged when the stream ends.
func slogRequestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sr := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sr, r)
		ms := time.Since(start).Milliseconds()
		reqID := chimiddleware.GetReqID(r.Context())
		lvl := slog.LevelInfo
		if sr.status >= 500 {
			lvl = slog.LevelError
		} else if sr.status >= 400 {
			lvl = slog.LevelWarn
		}
		slog.Log(r.Context(), lvl, "http",
			"method", r.Method,
			"path", r.URL.Path,
			"status", sr.status,
			"ms", ms,
			"bytes", sr.bytes,
			"ip", r.RemoteAddr,
			"req_id", reqID,
		)
	})
}

