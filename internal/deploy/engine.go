// Package deploy implements the healthcheck-cutover deployment strategy.
package deploy

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"offdock/internal/crypto"
	"offdock/internal/docker"
	nginxpkg "offdock/internal/nginx"
	"offdock/internal/store"
)

const (
	healthPollInterval = 3 * time.Second
	defaultTimeout     = 120 * time.Second
	runningStableFor   = 5 * time.Second
	deployTimeout      = 300 * time.Second
)

// LogFunc is a callback invoked with each log line during deployment.
type LogFunc func(line string)

// Engine orchestrates deployments for a project.
type Engine struct {
	db          *store.DB
	docker      *docker.Client
	enc         *crypto.Encryptor
	projectsDir string
}

// New returns an Engine ready to deploy projects.
func New(db *store.DB, dockerClient *docker.Client, enc *crypto.Encryptor, projectsDir string) *Engine {
	return &Engine{
		db:          db,
		docker:      dockerClient,
		enc:         enc,
		projectsDir: projectsDir,
	}
}

// Deploy runs a full healthcheck-cutover deployment using the latest compose version.
func (e *Engine) Deploy(ctx context.Context, projectID, triggeredBy string, logFn LogFunc) (*store.DeploymentRecord, error) {
	return e.DeployVersion(ctx, projectID, triggeredBy, 0, logFn)
}

// DeployVersion deploys a specific compose version (0 = latest). Used for rollbacks.
func (e *Engine) DeployVersion(ctx context.Context, projectID, triggeredBy string, composeVersion int, logFn LogFunc) (*store.DeploymentRecord, error) {
	ctx, cancel := context.WithTimeout(ctx, deployTimeout)
	defer cancel()

	log := func(msg string, args ...any) {
		line := fmt.Sprintf(msg, args...)
		slog.Info("deploy", "project", projectID, "msg", line)
		if logFn != nil {
			logFn(line)
		}
	}

	project, err := e.db.Projects.FindByID(projectID)
	if err != nil {
		return nil, fmt.Errorf("project not found: %w", err)
	}

	// Fetch the specified compose config version (or latest if version == 0).
	composeVersions, err := e.db.Compose.FindWhere(func(c store.ComposeConfig) bool {
		return c.ProjectID == projectID
	})
	if err != nil || len(composeVersions) == 0 {
		return nil, fmt.Errorf("no compose config for project %s", projectID)
	}

	var selectedCompose store.ComposeConfig
	if composeVersion > 0 {
		found := false
		for _, c := range composeVersions {
			if c.Version == composeVersion {
				selectedCompose = c
				found = true
				break
			}
		}
		if !found {
			return nil, fmt.Errorf("compose version %d not found", composeVersion)
		}
	} else {
		selectedCompose = latestComposeConfig(composeVersions)
	}
	latestCompose := selectedCompose

	envSets, _ := e.db.EnvVars.FindWhere(func(v store.EnvVarSet) bool {
		return v.ProjectID == projectID
	})
	latestEnv := latestEnvSet(envSets)

	rec := store.DeploymentRecord{
		ID:                store.NewULID(),
		ProjectID:         projectID,
		TriggeredBy:       triggeredBy,
		Strategy:          "healthcheck-cutover",
		NewComposeVersion: latestCompose.Version,
		Status:            store.DeployStatusRunning,
		StartedAt:         time.Now().UTC(),
	}
	if err := e.db.Deployments.Save(rec); err != nil {
		return nil, err
	}

	fail := func(reason error) (*store.DeploymentRecord, error) {
		now := time.Now().UTC()
		if errors.Is(reason, context.Canceled) {
			rec.Status = store.DeployStatusCancelled
			rec.LogText += "\nCANCELLED"
		} else {
			rec.Status = store.DeployStatusFailed
			rec.LogText += "\nFAILED: " + reason.Error()
		}
		rec.FinishedAt = &now
		_ = e.db.Deployments.Save(rec)
		project.Status = store.ProjectStatusError
		project.UpdatedAt = time.Now().UTC()
		_ = e.db.Projects.Save(project)
		return &rec, reason
	}

	appendLog := func(msg string, args ...any) {
		line := fmt.Sprintf(msg, args...)
		rec.LogText += line + "\n"
		log(line)
	}

	projectDir := filepath.Join(e.projectsDir, projectID)
	if err := os.MkdirAll(projectDir, 0o700); err != nil {
		return fail(fmt.Errorf("create project dir: %w", err))
	}

	// Step 1: Write docker-compose.yml.
	composePath := filepath.Join(projectDir, "docker-compose.yml")
	appendLog("[1/7] Writing docker-compose.yml (version %d)", latestCompose.Version)
	if err := atomicWrite(composePath, []byte(latestCompose.RawYAML)); err != nil {
		return fail(fmt.Errorf("write compose: %w", err))
	}

	// Step 2: Write decrypted .env.
	appendLog("[2/7] Writing .env")
	envContent, err := e.buildEnvFile(latestEnv)
	if err != nil {
		return fail(fmt.Errorf("build env file: %w", err))
	}
	envPath := filepath.Join(projectDir, ".env")
	if err := atomicWrite(envPath, []byte(envContent)); err != nil {
		return fail(fmt.Errorf("write .env: %w", err))
	}

	safeProject := composeProjectName(project.Name)
	nextProject := safeProject + "_next"

	// Step 3: Bring up _next stack with force-recreate so stale containers from
	// a previous failed deploy are always replaced.
	appendLog("[3/7] Starting %s stack (force-recreate)", nextProject)
	upOut, err := e.docker.ComposeUp(ctx, nextProject, composePath, true)
	if t := strings.TrimSpace(upOut); t != "" {
		appendLog("  docker output: %s", t)
	}
	if err != nil {
		appendLog("  [cleanup] Tearing down %s stack", nextProject)
		e.docker.ComposeDown(context.Background(), nextProject, composePath) //nolint:errcheck
		return fail(fmt.Errorf("compose up: %w\n%s", err, strings.TrimSpace(upOut)))
	}

	// Step 4: Health polling.
	appendLog("[4/7] Polling container health (timeout %s)", defaultTimeout)
	if err := e.waitHealthy(ctx, nextProject, composePath, appendLog); err != nil {
		appendLog("  [rollback] Tearing down failed %s stack", nextProject)
		e.docker.ComposeDown(context.Background(), nextProject, composePath) //nolint:errcheck
		return fail(fmt.Errorf("health check: %w", err))
	}

	// Steps 5-6 use context.Background() so a user cancel cannot interrupt
	// the cutover once it has started — partial cutover would leave both stacks down.
	cutoverCtx := context.Background()

	// Step 5: Cutover — bring down old stack.
	appendLog("[5/7] Cutting over — stopping %s", safeProject)
	downOut, _ := e.docker.ComposeDown(cutoverCtx, safeProject, composePath)
	if t := strings.TrimSpace(downOut); t != "" {
		appendLog("  docker output: %s", t)
	}

	// Step 6: Free ports by tearing down _next, then start canonical.
	appendLog("[6/7] Releasing %s ports", nextProject)
	e.docker.ComposeDown(cutoverCtx, nextProject, composePath) //nolint:errcheck

	appendLog("[7/7] Starting %s (canonical)", safeProject)
	promoteOut, err := e.docker.ComposeUp(cutoverCtx, safeProject, composePath, true)
	if t := strings.TrimSpace(promoteOut); t != "" {
		appendLog("  docker output: %s", t)
	}
	if err != nil {
		return fail(fmt.Errorf("promote: %w\n%s", err, strings.TrimSpace(promoteOut)))
	}

	// Step 7: Reload nginx if config exists.
	nginxCfgs, _ := e.db.Nginx.FindWhere(func(n store.NginxConfig) bool {
		return n.ProjectID == projectID && n.Active
	})
	if len(nginxCfgs) > 0 {
		appendLog("[7/7] Reloading nginx config")
		if _, err := nginxpkg.Apply(nginxCfgs[0], project.Name); err != nil {
			appendLog("  WARNING: nginx reload failed: %v", err)
		}
	} else {
		appendLog("[7/7] No active nginx config — skipping")
	}

	// Success.
	now := time.Now().UTC()
	rec.Status = store.DeployStatusSuccess
	rec.FinishedAt = &now
	_ = e.db.Deployments.Save(rec)

	project.Status = store.ProjectStatusRunning
	project.UpdatedAt = time.Now().UTC()
	_ = e.db.Projects.Save(project)

	appendLog("Deployment complete in %s", time.Since(rec.StartedAt).Round(time.Millisecond))
	return &rec, nil
}

func (e *Engine) waitHealthy(ctx context.Context, project, composePath string, log func(string, ...any)) error {
	deadline := time.Now().Add(defaultTimeout)
	var firstRunning time.Time

	for {
		if time.Now().After(deadline) {
			return fmt.Errorf("health check timeout after %s", defaultTimeout)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(healthPollInterval):
		}

		containers, err := e.docker.ComposePS(ctx, project, composePath)
		if err != nil || len(containers) == 0 {
			log("  waiting for containers to start...")
			continue
		}

		allHealthy := true
		for _, c := range containers {
			status, err := e.docker.HealthStatus(ctx, c.Names)
			if err != nil {
				allHealthy = false
				break
			}
			switch status {
			case "healthy":
				// good
			case "running":
				// no healthcheck — track stable running period
				if firstRunning.IsZero() {
					firstRunning = time.Now()
				}
				if time.Since(firstRunning) < runningStableFor {
					allHealthy = false
				}
			default:
				allHealthy = false
				firstRunning = time.Time{}
			}
		}

		if allHealthy {
			log("  all containers healthy")
			return nil
		}
		log("  containers not yet healthy — retrying...")
	}
}

func (e *Engine) buildEnvFile(set *store.EnvVarSet) (string, error) {
	if set == nil {
		return "", nil
	}
	var sb strings.Builder
	for _, v := range set.Vars {
		plain, err := e.enc.Decrypt(v.Value)
		if err != nil {
			return "", fmt.Errorf("decrypt %s: %w", v.Key, err)
		}
		sb.WriteString(v.Key)
		sb.WriteByte('=')
		sb.WriteString(plain)
		sb.WriteByte('\n')
	}
	return sb.String(), nil
}

// composeProjectName converts an arbitrary project name to a valid Docker
// Compose project name: lowercase, spaces→hyphens, non-alphanumeric stripped.
func composeProjectName(name string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(name) {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' || r == '_' {
			b.WriteRune(r)
		} else if r == ' ' {
			b.WriteByte('-')
		}
	}
	return b.String()
}

func atomicWrite(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func latestComposeConfig(cfgs []store.ComposeConfig) store.ComposeConfig {
	best := cfgs[0]
	for _, c := range cfgs[1:] {
		if c.Version > best.Version {
			best = c
		}
	}
	return best
}

func latestEnvSet(sets []store.EnvVarSet) *store.EnvVarSet {
	if len(sets) == 0 {
		return nil
	}
	best := sets[0]
	for _, s := range sets[1:] {
		if s.Version > best.Version {
			best = s
		}
	}
	return &best
}

