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

	h := handlers.New(deps.DB, deps.Auth, deps.Encryptor, deps.Docker, deps.Deployer, deps.Stats, deps.SSEHub, deps.ProjectsDir)

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

		// Nginx
		r.Get("/api/v1/projects/{id}/nginx", h.GetNginx)
		r.With(authmw.RequireRole(store.RoleAdmin)).Post("/api/v1/projects/{id}/nginx", h.SaveNginx)
		r.With(authmw.RequireRole(store.RoleAdmin)).Post("/api/v1/projects/{id}/nginx/apply", h.ApplyNginx)
		r.Get("/api/v1/projects/{id}/nginx/preview", h.PreviewNginx)

		// Deploy
		r.With(authmw.RequireRole(store.RoleAdmin)).Post("/api/v1/projects/{id}/deploy", h.TriggerDeploy)
		r.Get("/api/v1/projects/{id}/deployments", h.ListDeployments)
		r.Get("/api/v1/projects/{id}/deployments/{dep_id}", h.GetDeployment)
		r.Get("/api/v1/projects/{id}/deployments/{dep_id}/stream", h.DeployStream) // SSE

		// Containers & logs
		r.Get("/api/v1/projects/{id}/containers", h.ListContainers)
		r.Get("/api/v1/projects/{id}/containers/{name}/logs", h.ContainerLogs) // SSE

		// Images
		r.Get("/api/v1/images", h.ListImages)
		r.With(authmw.RequireRole(store.RoleAdmin)).Post("/api/v1/images/load", h.LoadImage)
		r.With(authmw.RequireRole(store.RoleAdmin)).Delete("/api/v1/images/{id}", h.DeleteImage)

		// USB
		r.Get("/api/v1/usb/drives", h.ListDrives)
		r.Get("/api/v1/usb/browse", h.BrowseDrive)

		// System stats (SSE)
		r.Get("/api/v1/system/stats", h.SystemStats)
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

