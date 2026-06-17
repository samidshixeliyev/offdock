// Package selfheal implements the boot-time and on-demand reconciler that
// restores OffDock after host churn: a reboot, a Docker reinstall, or an nginx
// purge. It ensures Docker is running, brings every project marked "running"
// back up from the DB, and re-applies all active nginx vhosts from the DB to
// /etc/nginx — fixing the "containers down / nginx configs broken" failure mode.
package selfheal

import (
	"context"
	"fmt"
	"log/slog"
	"os/exec"
	"time"

	"offdock/internal/deploy"
	"offdock/internal/docker"
	nginxpkg "offdock/internal/nginx"
	"offdock/internal/store"
)

// Reconciler holds the dependencies needed to restore desired state.
type Reconciler struct {
	db       *store.DB
	docker   *docker.Client
	deployer *deploy.Engine
}

// New returns a Reconciler.
func New(db *store.DB, dockerClient *docker.Client, deployer *deploy.Engine) *Reconciler {
	return &Reconciler{db: db, docker: dockerClient, deployer: deployer}
}

// Report summarises a reconcile run for logging and the API response.
type Report struct {
	DockerReady   bool      `json:"docker_ready"`
	ProjectsUp    []string  `json:"projects_up"`
	ProjectErrors []ItemErr `json:"project_errors"`
	NginxApplied  []string  `json:"nginx_applied"`
	NginxErrors   []ItemErr `json:"nginx_errors"`
	StartedAt     time.Time `json:"started_at"`
	FinishedAt    time.Time `json:"finished_at"`
}

// ItemErr is a named error for a single project or vhost.
type ItemErr struct {
	Name string `json:"name"`
	Err  string `json:"err"`
}

// Run executes a full reconcile: Docker → projects → nginx. It never panics and
// returns a Report describing what was restored and what failed.
func (rc *Reconciler) Run(ctx context.Context) Report {
	rep := Report{StartedAt: time.Now().UTC()}
	defer func() { rep.FinishedAt = time.Now().UTC() }()

	// 1. Ensure Docker daemon is reachable.
	rep.DockerReady = rc.ensureDocker(ctx)
	if !rep.DockerReady {
		slog.Warn("reconcile: docker not reachable — skipping project bring-up")
	} else {
		// 2. Bring every "running" project back up.
		projects, _ := rc.db.Projects.FindAll()
		for _, p := range projects {
			if p.Status != store.ProjectStatusRunning {
				continue
			}
			out, err := rc.deployer.EnsureUp(ctx, p.ID)
			if err != nil {
				rep.ProjectErrors = append(rep.ProjectErrors, ItemErr{Name: p.Name, Err: err.Error()})
				slog.Warn("reconcile: project ensure-up failed", "project", p.Name, "err", err, "out", out)
				continue
			}
			rep.ProjectsUp = append(rep.ProjectsUp, p.Name)
			slog.Info("reconcile: project ensured up", "project", p.Name)
		}
	}

	// 3. Re-apply nginx vhosts from the DB (independent of Docker state).
	if nginxpkg.SystemAvailable() {
		nginxpkg.EnsureLogFormat()

		nginxCfgs, _ := rc.db.Nginx.FindWhere(func(n store.NginxConfig) bool { return n.Active })
		for _, cfg := range nginxCfgs {
			proj, err := rc.db.Projects.FindByID(cfg.ProjectID)
			name := cfg.Domain
			if err == nil {
				name = proj.Name
			}
			if _, err := nginxpkg.ApplySystem(cfg, name); err != nil {
				rep.NginxErrors = append(rep.NginxErrors, ItemErr{Name: name, Err: err.Error()})
				slog.Warn("reconcile: nginx apply failed", "vhost", name, "err", err)
				continue
			}
			rep.NginxApplied = append(rep.NginxApplied, name)
		}

		hosts, _ := rc.db.ProxyHosts.FindWhere(func(h store.ProxyHost) bool { return h.Enabled })
		for _, host := range hosts {
			if _, err := nginxpkg.ApplyProxyHostSystem(host); err != nil {
				rep.NginxErrors = append(rep.NginxErrors, ItemErr{Name: host.Domain, Err: err.Error()})
				slog.Warn("reconcile: proxy host apply failed", "host", host.Domain, "err", err)
				continue
			}
			rep.NginxApplied = append(rep.NginxApplied, host.Domain)
		}
	}

	slog.Info("reconcile complete",
		"docker", rep.DockerReady,
		"projects_up", len(rep.ProjectsUp),
		"project_errors", len(rep.ProjectErrors),
		"nginx_applied", len(rep.NginxApplied),
		"nginx_errors", len(rep.NginxErrors))
	return rep
}

// ensureDocker tries to bring the Docker daemon up and waits (bounded) for it to
// answer. Returns true once `docker info` succeeds.
func (rc *Reconciler) ensureDocker(ctx context.Context) bool {
	if rc.docker.Info(ctx) == nil {
		return true
	}
	// Try to start the service, then poll for readiness.
	startCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	_ = exec.CommandContext(startCtx, "systemctl", "start", "docker").Run()
	cancel()

	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		if rc.docker.Info(ctx) == nil {
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(3 * time.Second):
		}
	}
	return false
}

// RunInBackground launches a reconcile asynchronously so startup is not blocked.
func (rc *Reconciler) RunInBackground() {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		defer func() {
			if r := recover(); r != nil {
				slog.Error("reconcile panicked", "recover", fmt.Sprint(r))
			}
		}()
		rc.Run(ctx)
	}()
}
