// Package deploy implements a direct-replacement deployment strategy.
// Containers are force-recreated in place using the latest compose + env version.
package deploy

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"offdock/internal/crypto"
	"offdock/internal/docker"
	nginxpkg "offdock/internal/nginx"
	"offdock/internal/store"
)

const (
	healthPollInterval     = 3 * time.Second
	defaultHealthTimeout   = 120 * time.Second
	defaultStableFor       = 5 * time.Second
	defaultDeployTimeout   = 300 * time.Second
)

// LogFunc is a callback invoked with each log line during deployment.
type LogFunc func(line string)

// Engine orchestrates deployments for a project.
type Engine struct {
	db          *store.DB
	docker      *docker.Client
	enc         *crypto.Encryptor
	projectsDir string
	locks       sync.Map // projectID → *sync.Mutex, serialises deploys per project
}

// projectLock returns the per-project mutex, creating it on first use.
func (e *Engine) projectLock(projectID string) *sync.Mutex {
	m, _ := e.locks.LoadOrStore(projectID, &sync.Mutex{})
	return m.(*sync.Mutex)
}

// composeForDisk applies per-project network injection (dns/dns_search/
// extra_hosts) to the raw compose YAML before it is written to disk. The raw
// YAML in the DB is never changed. Transform errors fall back to the raw YAML.
func (e *Engine) composeForDisk(settings store.DeploySettings, raw string) string {
	out, err := injectNetworkConfig(raw, settings.DNSServers, settings.DNSSearch, settings.ExtraHosts)
	if err != nil {
		slog.Warn("compose network injection failed; using raw compose", "err", err)
		return raw
	}
	return out
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

// resolveSettings returns per-project deploy settings, falling back to defaults.
func (e *Engine) resolveSettings(projectID string) store.DeploySettings {
	sets, _ := e.db.DeploySettings.FindWhere(func(s store.DeploySettings) bool {
		return s.ProjectID == projectID
	})
	if len(sets) > 0 {
		s := sets[0]
		if s.HealthTimeoutSecs <= 0 {
			s.HealthTimeoutSecs = int(defaultHealthTimeout.Seconds())
		}
		if s.DeployTimeoutSecs <= 0 {
			s.DeployTimeoutSecs = int(defaultDeployTimeout.Seconds())
		}
		if s.HealthStableSecs <= 0 {
			s.HealthStableSecs = int(defaultStableFor.Seconds())
		}
		return s
	}
	return store.DeploySettings{
		ProjectID:         projectID,
		HealthTimeoutSecs: int(defaultHealthTimeout.Seconds()),
		DeployTimeoutSecs: int(defaultDeployTimeout.Seconds()),
		HealthStableSecs:  int(defaultStableFor.Seconds()),
	}
}

// Deploy runs a deployment using the latest compose + env version.
func (e *Engine) Deploy(ctx context.Context, projectID, triggeredBy string, logFn LogFunc) (*store.DeploymentRecord, error) {
	return e.DeployVersion(ctx, projectID, triggeredBy, 0, 0, logFn)
}

// DeployVersion deploys a specific compose+env version combination.
// Pass 0 for either to use the latest. Used for rollbacks.
//
// Strategy: direct in-place replacement.
//  1. Write compose + env to disk.
//  2. docker compose up -d --force-recreate --remove-orphans
//  3. Poll health until stable or timeout (per-project settings).
//  4. Reload nginx if a config is active.
func (e *Engine) DeployVersion(ctx context.Context, projectID, triggeredBy string, composeVersion, envVersion int, logFn LogFunc) (*store.DeploymentRecord, error) {
	// Serialise deploys per project so two concurrent triggers cannot race on
	// `compose up` and the project directory.
	lock := e.projectLock(projectID)
	if !lock.TryLock() {
		return nil, fmt.Errorf("a deployment is already in progress for this project")
	}
	defer lock.Unlock()

	settings := e.resolveSettings(projectID)
	deployTimeoutDur := time.Duration(settings.DeployTimeoutSecs) * time.Second

	ctx, cancel := context.WithTimeout(ctx, deployTimeoutDur)
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

	// ── Resolve compose version ──────────────────────────────────────────────
	composeVersions, err := e.db.Compose.FindWhere(func(c store.ComposeConfig) bool {
		return c.ProjectID == projectID
	})
	if err != nil || len(composeVersions) == 0 {
		return nil, fmt.Errorf("no compose config saved for project %q — save one first", project.Name)
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

	// ── Resolve env version ──────────────────────────────────────────────────
	allEnvSets, _ := e.db.EnvVars.FindWhere(func(v store.EnvVarSet) bool {
		return v.ProjectID == projectID
	})
	var selectedEnv *store.EnvVarSet
	if envVersion > 0 {
		for i, s := range allEnvSets {
			if s.Version == envVersion {
				selectedEnv = &allEnvSets[i]
				break
			}
		}
		if selectedEnv == nil {
			return nil, fmt.Errorf("env version %d not found", envVersion)
		}
	} else {
		selectedEnv = latestEnvSet(allEnvSets)
	}

	// ── Capture previous good version for auto-rollback ──────────────────────
	var prevComposeV, prevEnvV int
	if settings.RollbackOnFailure {
		successDeps, _ := e.db.Deployments.FindWhere(func(d store.DeploymentRecord) bool {
			return d.ProjectID == projectID && d.Status == store.DeployStatusSuccess
		})
		var latest *store.DeploymentRecord
		for i := range successDeps {
			if latest == nil || successDeps[i].StartedAt.After(latest.StartedAt) {
				latest = &successDeps[i]
			}
		}
		if latest != nil {
			prevComposeV = latest.NewComposeVersion
			prevEnvV = latest.EnvVersion
		}
	}

	// ── Create deployment record ─────────────────────────────────────────────
	envVerUsed := 0
	if selectedEnv != nil {
		envVerUsed = selectedEnv.Version
	}
	rec := store.DeploymentRecord{
		ID:                store.NewULID(),
		ProjectID:         projectID,
		TriggeredBy:       triggeredBy,
		Strategy:          "direct-replace",
		NewComposeVersion: selectedCompose.Version,
		EnvVersion:        envVerUsed,
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
			log("[STAGE:ERROR] Cancelled")
			rec.LogText += "\n[STAGE:ERROR] Cancelled"
			rec.LogText += "\nCANCELLED"
		} else {
			rec.Status = store.DeployStatusFailed
			log("[STAGE:ERROR] " + reason.Error())
			rec.LogText += "\n[STAGE:ERROR] " + reason.Error()
			rec.LogText += "\nFAILED: " + reason.Error()

			// Auto-rollback to the previous good version, if enabled and one
			// exists that differs from the failed attempt.
			if settings.RollbackOnFailure && prevComposeV > 0 &&
				(prevComposeV != selectedCompose.Version || prevEnvV != envVerUsed) {
				log("[STAGE] Auto-rollback to compose v%d, env v%d", prevComposeV, prevEnvV)
				rec.LogText += fmt.Sprintf("\n[STAGE] Auto-rollback to compose v%d, env v%d", prevComposeV, prevEnvV)
				rbCtx, rbCancel := context.WithTimeout(context.Background(), defaultDeployTimeout)
				out, rbErr := e.applyVersionFiles(rbCtx, projectID, project.Name, prevComposeV, prevEnvV)
				rbCancel()
				if rbErr != nil {
					rec.LogText += "\nAuto-rollback FAILED: " + rbErr.Error() + "\n" + strings.TrimSpace(out)
					log("Auto-rollback failed: %v", rbErr)
				} else {
					rec.LogText += "\nAuto-rolled back to previous good version."
					log("Auto-rolled back to compose v%d, env v%d", prevComposeV, prevEnvV)
				}
			}
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

	// ── Prepare project directory ────────────────────────────────────────────
	projectDir := filepath.Join(e.projectsDir, projectID)
	if err := os.MkdirAll(projectDir, 0o700); err != nil {
		return fail(fmt.Errorf("create project dir: %w", err))
	}

	appendLog("[STAGE] Resolving versions")
	appendLog("Deploy started — compose v%d, env v%d, project %q", selectedCompose.Version, envVerUsed, project.Name)
	appendLog("Settings — health timeout %ds, deploy timeout %ds, stable %ds",
		settings.HealthTimeoutSecs, settings.DeployTimeoutSecs, settings.HealthStableSecs)

	// ── Step 1: Write docker-compose.yml ─────────────────────────────────────
	composePath := filepath.Join(projectDir, "docker-compose.yml")
	appendLog("[STAGE] Writing compose + env")
	appendLog("[1/4] Writing docker-compose.yml (compose v%d)", selectedCompose.Version)
	if err := atomicWrite(composePath, []byte(e.composeForDisk(settings, selectedCompose.RawYAML))); err != nil {
		return fail(fmt.Errorf("write compose: %w", err))
	}

	// ── Step 2: Write .env ───────────────────────────────────────────────────
	if selectedEnv != nil {
		appendLog("[2/4] Writing .env (env v%d — %d variables)", selectedEnv.Version, len(selectedEnv.Vars))
	} else {
		appendLog("[2/4] Writing .env (no env vars configured)")
	}
	envContent, err := e.buildEnvFile(selectedEnv)
	if err != nil {
		return fail(fmt.Errorf("build env file: %w", err))
	}
	if err := atomicWrite(filepath.Join(projectDir, ".env"), []byte(envContent)); err != nil {
		return fail(fmt.Errorf("write .env: %w", err))
	}

	safeProject := composeProjectName(project.Name)

	// ── Step 3: Force-recreate all containers ────────────────────────────────
	// --force-recreate rebuilds every container even when the image digest
	// hasn't changed, ensuring env vars, ports, volumes, and config are applied.
	appendLog("[STAGE] Running docker compose")
	appendLog("[3/4] Applying compose v%d (force-recreate, remove-orphans)…", selectedCompose.Version)
	upOut, err := e.docker.ComposeUp(ctx, safeProject, composePath, true)
	if t := strings.TrimSpace(upOut); t != "" {
		appendLog("  %s", t)
	}
	if err != nil {
		return fail(fmt.Errorf("compose up: %w\n%s", err, strings.TrimSpace(upOut)))
	}

	// ── Step 4: Health check ─────────────────────────────────────────────────
	healthTimeout := time.Duration(settings.HealthTimeoutSecs) * time.Second
	stableFor := time.Duration(settings.HealthStableSecs) * time.Second
	appendLog("[STAGE] Health check")
	appendLog("[4/4] Waiting for containers to become healthy (timeout %s, stable %s)…", healthTimeout, stableFor)
	if err := e.waitHealthy(ctx, safeProject, composePath, healthTimeout, stableFor, appendLog); err != nil {
		return fail(fmt.Errorf("health check failed: %w", err))
	}

	// ── Nginx reload (if configured) ─────────────────────────────────────────
	nginxCfgs, _ := e.db.Nginx.FindWhere(func(n store.NginxConfig) bool {
		return n.ProjectID == projectID && n.Active
	})
	if len(nginxCfgs) > 0 {
		appendLog("[STAGE] Nginx reload")
		appendLog("Reloading nginx config…")
		if _, err := nginxpkg.Apply(nginxCfgs[0], project.Name); err != nil {
			appendLog("  WARNING: nginx reload failed: %v", err)
		}
	}

	// ── Finish ───────────────────────────────────────────────────────────────
	now := time.Now().UTC()
	rec.Status = store.DeployStatusSuccess
	rec.FinishedAt = &now
	_ = e.db.Deployments.Save(rec)

	project.Status = store.ProjectStatusRunning
	project.UpdatedAt = time.Now().UTC()
	_ = e.db.Projects.Save(project)

	appendLog("[STAGE] Complete")
	appendLog("Deployment complete in %s", time.Since(rec.StartedAt).Round(time.Millisecond))
	return &rec, nil
}

// applyVersionFiles writes a specific compose+env version pair to disk and
// force-recreates the stack. Used by the auto-rollback path. It does NOT take
// the per-project lock (the caller already holds it) and does not wait for health.
func (e *Engine) applyVersionFiles(ctx context.Context, projectID, projectName string, composeVer, envVer int) (string, error) {
	composeVersions, err := e.db.Compose.FindWhere(func(c store.ComposeConfig) bool {
		return c.ProjectID == projectID && c.Version == composeVer
	})
	if err != nil || len(composeVersions) == 0 {
		return "", fmt.Errorf("compose version %d not found", composeVer)
	}
	var selectedEnv *store.EnvVarSet
	if envVer > 0 {
		envs, _ := e.db.EnvVars.FindWhere(func(v store.EnvVarSet) bool {
			return v.ProjectID == projectID && v.Version == envVer
		})
		if len(envs) > 0 {
			selectedEnv = &envs[0]
		}
	}

	projectDir := filepath.Join(e.projectsDir, projectID)
	if err := os.MkdirAll(projectDir, 0o700); err != nil {
		return "", err
	}
	composePath := filepath.Join(projectDir, "docker-compose.yml")
	settings := e.resolveSettings(projectID)
	if err := atomicWrite(composePath, []byte(e.composeForDisk(settings, composeVersions[0].RawYAML))); err != nil {
		return "", err
	}
	envContent, err := e.buildEnvFile(selectedEnv)
	if err != nil {
		return "", err
	}
	if err := atomicWrite(filepath.Join(projectDir, ".env"), []byte(envContent)); err != nil {
		return "", err
	}
	return e.docker.ComposeUp(ctx, composeProjectName(projectName), composePath, true)
}

// EnsureUp writes the latest compose+env for a project to disk and runs
// `docker compose up -d` WITHOUT --force-recreate or --remove-orphans. It is
// used by the boot reconciler to bring running projects back after host churn
// (Docker reinstall, reboot) without disrupting healthy containers or deleting
// orphans. It does not poll health or touch deployment records.
func (e *Engine) EnsureUp(ctx context.Context, projectID string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultDeployTimeout)
	defer cancel()

	project, err := e.db.Projects.FindByID(projectID)
	if err != nil {
		return "", fmt.Errorf("project not found: %w", err)
	}

	composeVersions, err := e.db.Compose.FindWhere(func(c store.ComposeConfig) bool {
		return c.ProjectID == projectID
	})
	if err != nil || len(composeVersions) == 0 {
		return "", fmt.Errorf("no compose config for project %q", project.Name)
	}
	selectedCompose := latestComposeConfig(composeVersions)

	allEnvSets, _ := e.db.EnvVars.FindWhere(func(v store.EnvVarSet) bool {
		return v.ProjectID == projectID
	})
	selectedEnv := latestEnvSet(allEnvSets)

	projectDir := filepath.Join(e.projectsDir, projectID)
	if err := os.MkdirAll(projectDir, 0o700); err != nil {
		return "", fmt.Errorf("create project dir: %w", err)
	}
	composePath := filepath.Join(projectDir, "docker-compose.yml")
	settings := e.resolveSettings(projectID)
	if err := atomicWrite(composePath, []byte(e.composeForDisk(settings, selectedCompose.RawYAML))); err != nil {
		return "", fmt.Errorf("write compose: %w", err)
	}
	envContent, err := e.buildEnvFile(selectedEnv)
	if err != nil {
		return "", fmt.Errorf("build env file: %w", err)
	}
	if err := atomicWrite(filepath.Join(projectDir, ".env"), []byte(envContent)); err != nil {
		return "", fmt.Errorf("write .env: %w", err)
	}

	safeProject := composeProjectName(project.Name)
	return e.docker.ComposeUpOpts(ctx, safeProject, composePath, false, false)
}

func (e *Engine) waitHealthy(ctx context.Context, project, composePath string, healthTimeout, stableFor time.Duration, log func(string, ...any)) error {
	deadline := time.Now().Add(healthTimeout)
	// Per-container timestamp of when it was first seen "running" without a
	// healthcheck, so the stable-window is tracked independently per container
	// rather than sharing a single timer across the whole stack.
	runningSince := make(map[string]time.Time)

	for {
		if time.Now().After(deadline) {
			return fmt.Errorf("timeout after %s", healthTimeout)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(healthPollInterval):
		}

		containers, err := e.docker.ComposePS(ctx, project, composePath)
		if err != nil || len(containers) == 0 {
			log("  waiting for containers to start…")
			continue
		}

		allHealthy := true
		for _, c := range containers {
			status, exitCode, err := e.docker.HealthDetail(ctx, c.Names)
			if err != nil {
				allHealthy = false
				break
			}
			switch status {
			case "healthy":
				// good — explicit healthcheck passed
			case "running":
				if runningSince[c.Names].IsZero() {
					runningSince[c.Names] = time.Now()
				}
				if time.Since(runningSince[c.Names]) < stableFor {
					allHealthy = false
				}
			case "exited":
				// A one-shot/init/migration container that completed cleanly is
				// healthy; a non-zero exit is a real failure.
				if exitCode != 0 {
					return fmt.Errorf("container %s exited with code %d", c.Names, exitCode)
				}
			default:
				// starting, restarting, created, unhealthy, paused, dead…
				allHealthy = false
				delete(runningSince, c.Names)
			}
		}

		if allHealthy {
			log("  all containers healthy ✓")
			return nil
		}
		log("  not yet healthy — retrying…")
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
		sb.WriteString(quoteEnvValue(plain))
		sb.WriteByte('\n')
	}
	return sb.String(), nil
}

// quoteEnvValue renders a value safe for a docker-compose .env file. Values with
// newlines, surrounding whitespace, '#', or quote characters are wrapped in
// double quotes with backslash/quote/newline escaped — which Docker Compose v2
// decodes back to the original. Plain values are written verbatim so existing
// behaviour is unchanged for the common case.
func quoteEnvValue(v string) string {
	needsQuote := strings.ContainsAny(v, "\n\r\"#") ||
		v != strings.TrimSpace(v) ||
		strings.Contains(v, "\\")
	if !needsQuote {
		return v
	}
	r := strings.NewReplacer(
		"\\", "\\\\",
		"\"", "\\\"",
		"\n", "\\n",
		"\r", "\\r",
	)
	return "\"" + r.Replace(v) + "\""
}

// composeProjectName converts a project name to a valid Docker Compose project name.
func composeProjectName(name string) string { return ComposeProjectName(name) }

// ComposeProjectName converts a project name to the canonical Docker Compose
// project name used as the `com.docker.compose.project` label. The deploy
// engine names stacks with this, so status/listing code MUST use the same
// transform when matching containers to a project (otherwise a project like
// "Keycloak" never matches its lowercased "keycloak" containers).
func ComposeProjectName(name string) string {
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
