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
	"offdock/internal/store"
	"offdock/internal/system"
)

// Deps bundles all service dependencies passed to handler constructors.
type Deps struct {
	DB          *store.DB
	Auth        *auth.Service
	Encryptor   *crypto.Encryptor
	Docker      *docker.Client
	Deployer    *deploy.Engine
	Stats       *system.Collector
	SSEHub      *sse.Hub
	ProjectsDir string
	DataDir     string
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

	h := handlers.New(deps.DB, deps.Auth, deps.Encryptor, deps.Docker, deps.Deployer, deps.Stats, deps.SSEHub, deps.ProjectsDir, deps.DataDir)

	// --- Public routes ---
	r.Post("/api/v1/auth/login", h.Login)
	r.Post("/api/v1/auth/logout", h.Logout)
	// Setup endpoints live under /api/v1 so the /setup path is served
	// by the SPA handler (index.html), not the API router.
	r.Get("/api/v1/setup", h.SetupStatus)
	r.Post("/api/v1/setup", h.SetupCreate)

	// --- Authenticated routes ---
	r.Group(func(r chi.Router) {
		r.Use(authmw.Authenticate(deps.Auth))

		r.Get("/api/v1/auth/me", h.Me)

		// Users — superadmin only for write operations
		r.Get("/api/v1/users", h.ListUsers)
		r.With(authmw.RequireRole(store.RoleSuperAdmin)).Post("/api/v1/users", h.CreateUser)
		r.With(authmw.RequireRole(store.RoleSuperAdmin)).Patch("/api/v1/users/{id}", h.UpdateUser)
		r.With(authmw.RequireRole(store.RoleSuperAdmin)).Delete("/api/v1/users/{id}", h.DeleteUser)

		// Projects
		r.Get("/api/v1/projects", h.ListProjects)
		r.With(authmw.RequireRole(store.RoleAdmin)).Post("/api/v1/projects", h.CreateProject)
		r.Get("/api/v1/projects/{id}", h.GetProject)
		r.With(authmw.RequireRole(store.RoleAdmin)).Patch("/api/v1/projects/{id}", h.UpdateProject)
		r.With(authmw.RequireRole(store.RoleSuperAdmin)).Delete("/api/v1/projects/{id}", h.DeleteProject)

		// Compose
		r.Get("/api/v1/projects/{id}/compose", h.GetCompose)
		r.With(authmw.RequireRole(store.RoleAdmin)).Post("/api/v1/projects/{id}/compose", h.SaveCompose)
		r.Get("/api/v1/projects/{id}/compose/history", h.ComposeHistory)

		// Env vars
		r.Get("/api/v1/projects/{id}/env", h.GetEnv)
		r.With(authmw.RequireRole(store.RoleAdmin)).Post("/api/v1/projects/{id}/env", h.SaveEnv)
		r.Get("/api/v1/projects/{id}/env/history", h.EnvHistory)

		// OffDock managed networks (offdock-external / offdock-internal)
		r.Get("/api/v1/networks", h.ListNetworks)
		r.With(authmw.RequireRole(store.RoleAdmin)).Post("/api/v1/networks/{network}/containers/{container}", h.NetworkConnect)
		r.With(authmw.RequireRole(store.RoleAdmin)).Delete("/api/v1/networks/{network}/containers/{container}", h.NetworkDisconnect)

		// Full Docker network management
		r.Route("/api/v1/docker/networks", func(r chi.Router) {
			r.Get("/", h.ListAllDockerNetworks)
			r.With(authmw.RequireRole(store.RoleAdmin)).Post("/", h.CreateDockerNetwork)
			r.With(authmw.RequireRole(store.RoleAdmin)).Delete("/{name}", h.DeleteDockerNetwork)
			r.With(authmw.RequireRole(store.RoleAdmin)).Post("/{name}/connect", h.DockerNetworkConnect)
			r.With(authmw.RequireRole(store.RoleAdmin)).Post("/{name}/disconnect", h.DockerNetworkDisconnect)
		})

		// Docker volume management
		r.Route("/api/v1/docker/volumes", func(r chi.Router) {
			r.Get("/", h.ListVolumes)
			r.With(authmw.RequireRole(store.RoleAdmin)).Post("/prune", h.PruneVolumes)
			r.With(authmw.RequireRole(store.RoleAdmin)).Post("/", h.CreateVolume)
			r.With(authmw.RequireRole(store.RoleAdmin)).Delete("/{name}", h.DeleteVolume)
		})

		// Global containers (all projects) — sub-router isolates the trie so
		// literal "stats" sub-path does not conflict with {name} param routes.
		r.Route("/api/v1/containers", func(r chi.Router) {
			r.Get("/", h.ListAllContainers)
			r.Get("/stats", h.ContainerStats)
			r.Get("/{container}/networks", h.ContainerNetworks)
			r.Get("/{name}/logs", h.ContainerLogs)
			r.With(authmw.RequireRole(store.RoleAdmin)).Post("/{name}/{action}", h.ContainerAction)
			r.With(authmw.RequireRole(store.RoleAdmin)).Delete("/{name}", h.DeleteContainer)
		})

		// Nginx — system nginx status + self-config
		r.Get("/api/v1/nginx/system/status", h.NginxSystemStatus)
		r.Get("/api/v1/nginx/system/self-config", h.SelfNginxConfig)
		r.With(authmw.RequireRole(store.RoleAdmin)).Post("/api/v1/nginx/system/self-config", h.ApplySelfNginxConfig)

		// Nginx — Docker container control (nginx:alpine)
		r.Get("/api/v1/nginx/container", h.NginxContainerStatus)
		r.With(authmw.RequireRole(store.RoleAdmin)).Post("/api/v1/nginx/container/start", h.NginxContainerStart)
		r.With(authmw.RequireRole(store.RoleAdmin)).Post("/api/v1/nginx/container/stop", h.NginxContainerStop)
		r.With(authmw.RequireRole(store.RoleAdmin)).Post("/api/v1/nginx/container/reload", h.NginxContainerReload)

		// Proxy hosts — managed reverse-proxy virtual hosts
		r.Get("/api/v1/proxy/hosts", h.ListProxyHosts)
		r.With(authmw.RequireRole(store.RoleAdmin)).Post("/api/v1/proxy/hosts", h.CreateProxyHost)
		r.With(authmw.RequireRole(store.RoleAdmin)).Post("/api/v1/proxy/hosts/preview", h.PreviewProxyHost)
		r.With(authmw.RequireRole(store.RoleAdmin)).Patch("/api/v1/proxy/hosts/{id}", h.UpdateProxyHost)
		r.With(authmw.RequireRole(store.RoleAdmin)).Post("/api/v1/proxy/hosts/{id}/toggle", h.ToggleProxyHost)
		r.With(authmw.RequireRole(store.RoleAdmin)).Delete("/api/v1/proxy/hosts/{id}", h.DeleteProxyHost)
		r.Get("/api/v1/proxy/hosts/{id}/test", h.TestProxyHost)
		r.Get("/api/v1/proxy/server-ip", h.ServerIP)

		// Nginx — global view + per-project management
		r.Get("/api/v1/nginx", h.ListAllNginx)
		r.Get("/api/v1/projects/{id}/nginx", h.GetNginx)
		r.With(authmw.RequireRole(store.RoleAdmin)).Post("/api/v1/projects/{id}/nginx", h.SaveNginx)
		r.With(authmw.RequireRole(store.RoleAdmin)).Post("/api/v1/projects/{id}/nginx/apply", h.ApplyNginx)
		r.With(authmw.RequireRole(store.RoleAdmin)).Delete("/api/v1/projects/{id}/nginx", h.RemoveNginx)
		r.Get("/api/v1/projects/{id}/nginx/preview", h.PreviewNginx)
		r.With(authmw.RequireRole(store.RoleAdmin)).Post("/api/v1/projects/{id}/nginx/cert", h.GenerateCert)

		// Deploy — global recent list + per-project
		r.Get("/api/v1/deployments", h.ListAllDeployments)
		r.With(authmw.RequireRole(store.RoleAdmin)).Post("/api/v1/projects/{id}/deploy", h.TriggerDeploy)
		r.Get("/api/v1/projects/{id}/deployments", h.ListDeployments)
		r.Get("/api/v1/projects/{id}/deployments/{dep_id}", h.GetDeployment)
		r.Get("/api/v1/projects/{id}/deployments/{dep_id}/stream", h.DeployStream) // SSE
		r.With(authmw.RequireRole(store.RoleAdmin)).Post("/api/v1/projects/{id}/deployments/{dep_id}/cancel", h.CancelDeploy)
		r.With(authmw.RequireRole(store.RoleAdmin)).Delete("/api/v1/projects/{id}/deployments/{dep_id}", h.DeleteDeployment)
			
			// Deploy settings
			r.Get("/api/v1/projects/{id}/deploy-settings", h.GetDeploySettings)
			r.With(authmw.RequireRole(store.RoleAdmin)).Put("/api/v1/projects/{id}/deploy-settings", h.SaveDeploySettings)

		// Containers & logs
		r.Get("/api/v1/projects/{id}/containers", h.ListContainers)
		r.With(authmw.RequireRole(store.RoleAdmin)).Post("/api/v1/projects/{id}/sync", h.SyncProjectStatus)
		r.With(authmw.RequireRole(store.RoleAdmin)).Post("/api/v1/projects/{id}/containers/{name}/{action}", h.ContainerAction)
		r.Get("/api/v1/projects/{id}/containers/{name}/logs", h.ContainerLogs) // SSE

		// Images
		r.Get("/api/v1/images", h.ListImages)
		r.With(authmw.RequireRole(store.RoleAdmin)).Post("/api/v1/images/load", h.LoadImage)
		r.With(authmw.RequireRole(store.RoleAdmin)).Post("/api/v1/images/sync", h.SyncImages)
		r.With(authmw.RequireRole(store.RoleAdmin)).Delete("/api/v1/images/{id}", h.DeleteImage)

		// USB
		r.Get("/api/v1/usb/drives", h.ListDrives)
		r.Get("/api/v1/usb/browse", h.BrowseDrive)
		r.Get("/api/v1/usb/file", h.ReadFile)

		// System stats (SSE)
		r.Get("/api/v1/system/stats", h.SystemStats)

		// Audit log — admin+ read
		r.Get("/api/v1/audit", h.ListAuditEvents)

		// Backup — superadmin only
		r.With(authmw.RequireRole(store.RoleSuperAdmin)).Get("/api/v1/system/backup", h.DownloadBackup)

		// Reverse proxy status probe (server-side to avoid CORS)
		r.Get("/api/v1/proxy/status", h.ProxyStatus)

		// Terminal — admin+ only
		r.With(authmw.RequireRole(store.RoleAdmin)).Post("/api/v1/terminal/exec", h.ExecCommand)
		// WebSocket PTY terminals (auth checked via cookie in the upgrade handler)
		r.With(authmw.RequireRole(store.RoleAdmin)).Get("/api/v1/terminal/container/ws", h.ExecContainerWS)
		r.With(authmw.RequireRole(store.RoleAdmin)).Get("/api/v1/terminal/shell/ws", h.HostShellWS)

		// File upload
		r.With(authmw.RequireRole(store.RoleAdmin)).Post("/api/v1/upload", h.UploadFile)

		// File system explorer — admin-only writes, read for authenticated users
		r.Route("/api/v1/files", func(r chi.Router) {
			r.Get("/browse", h.FileBrowse)
			r.Get("/read", h.FileRead)
			r.Get("/search", h.FileSearch)
			r.With(authmw.RequireRole(store.RoleAdmin)).Post("/write", h.FileWrite)
			r.With(authmw.RequireRole(store.RoleAdmin)).Post("/mkdir", h.FileMkdir)
			r.With(authmw.RequireRole(store.RoleAdmin)).Post("/rename", h.FileRename)
			r.With(authmw.RequireRole(store.RoleAdmin)).Delete("/delete", h.FileDelete)
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

