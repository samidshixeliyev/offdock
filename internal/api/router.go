// Package api wires the HTTP router and all middleware together.
package api

import (
	"net/http"

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
	r.Use(chimiddleware.Logger)
	r.Use(chimiddleware.Recoverer)
	r.Use(jsonContentType)

	h := handlers.New(deps.DB, deps.Auth, deps.Encryptor, deps.Docker, deps.Deployer, deps.Stats, deps.SSEHub, deps.ProjectsDir, deps.DataDir, deps.DefaultPEMPath, deps.Mailer, deps.SMTPSettings, deps.OAuthSettings)

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

		// Compose
		r.Get("/api/v1/projects/{id}/compose", h.GetCompose)
		r.With(authmw.RequirePermission(deps.DB, store.PermEditCompose)).Post("/api/v1/projects/{id}/compose", h.SaveCompose)
		r.Get("/api/v1/projects/{id}/compose/history", h.ComposeHistory)

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
			r.With(authmw.RequirePermission(deps.DB, store.PermDeploy)).Delete("/api/v1/projects/{id}/deploy-tags/{tag_id}", h.DeleteDeployTag)

		// Containers & logs
		r.Get("/api/v1/projects/{id}/containers", h.ListContainers)
		r.With(authmw.RequirePermission(deps.DB, store.PermContainerOps)).Post("/api/v1/projects/{id}/sync", h.SyncProjectStatus)
		r.With(authmw.RequirePermission(deps.DB, store.PermContainerOps)).Post("/api/v1/projects/{id}/containers/{name}/{action}", h.ContainerAction)
		r.Get("/api/v1/projects/{id}/containers/{name}/logs", h.ContainerLogs) // SSE

		// Images
		r.Get("/api/v1/images", h.ListImages)
		r.With(authmw.RequirePermission(deps.DB, store.PermManageImages)).Post("/api/v1/images/load", h.LoadImage)
		r.With(authmw.RequirePermission(deps.DB, store.PermManageImages)).Post("/api/v1/images/sync", h.SyncImages)
		r.With(authmw.RequirePermission(deps.DB, store.PermManageImages)).Delete("/api/v1/images/{id}", h.DeleteImage)

		// System stats (SSE)
		r.Get("/api/v1/system/stats", h.SystemStats)

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

		// Backup — superadmin only
		r.With(authmw.RequireRoleLive(deps.DB, store.RoleSuperAdmin)).Get("/api/v1/system/backup", h.DownloadBackup)

		// Self-update — superadmin only: upload tar.gz bundle, atomic binary replace + restart
		r.Get("/api/v1/system/update/status", h.GetSystemUpdateStatus)
		r.With(authmw.RequireRoleLive(deps.DB, store.RoleSuperAdmin)).Post("/api/v1/system/update", h.SystemUpdate)

		// Reverse proxy status probe (server-side to avoid CORS)
		r.Get("/api/v1/proxy/status", h.ProxyStatus)

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

