// Package deploy implements a direct-replacement deployment strategy.
// Containers are force-recreated in place using the latest compose + env version.
package deploy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"gopkg.in/yaml.v3"

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
		}
		rec.FinishedAt = &now
		_ = e.db.Deployments.Save(rec)
		project.Status = store.ProjectStatusError
		project.UpdatedAt = time.Now().UTC()
		_ = e.db.Projects.Save(project)
		webhookStatus := "failed"
		if errors.Is(reason, context.Canceled) {
			webhookStatus = "cancelled"
		}
		go fireWebhook(settings.WebhookURL, webhookStatus, project.Name, rec.ID)
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
	if err := atomicWrite(composePath, []byte(selectedCompose.RawYAML)); err != nil {
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
	isFile := func(p string) bool {
		info, err := os.Stat(p)
		return err == nil && !info.IsDir() && info.Size() > 0
	}
	if settings.OTelEnabled {
		envContent = appendOTelEnv(envContent, project.Name)
		appendLog("  OpenTelemetry: OTEL_* vars injected (per-service tracers via compose override)")
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
	// Generate OTel compose override (agent volume mount + offdock-otel network)
	// when auto-instrumentation is enabled.
	otelOverridePath := ""
	if settings.OTelEnabled {
		overridePath := filepath.Join(projectDir, ".otel-override.yml")
		if err := writeOTelComposeOverride(composePath, overridePath, envContent, project.Name, isFile); err != nil {
			appendLog("  WARNING: could not generate OTel compose override: %v", err)
		} else {
			otelOverridePath = overridePath
		}
	}

	upOut, err := e.docker.ComposeUp(ctx, safeProject, composePath, true, otelOverridePath)
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
	go fireWebhook(settings.WebhookURL, "success", project.Name, rec.ID)
	return &rec, nil
}

func (e *Engine) waitHealthy(ctx context.Context, project, composePath string, healthTimeout, stableFor time.Duration, log func(string, ...any)) error {
	deadline := time.Now().Add(healthTimeout)
	firstRunning := make(map[string]time.Time)

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
			status, err := e.docker.HealthStatus(ctx, c.Names)
			if err != nil {
				allHealthy = false
				break
			}
			switch status {
			case "healthy":
				// good
			case "running":
				if firstRunning[c.Names].IsZero() {
					firstRunning[c.Names] = time.Now()
				}
				if time.Since(firstRunning[c.Names]) < stableFor {
					allHealthy = false
				}
			default:
				allHealthy = false
				delete(firstRunning, c.Names)
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
		sb.WriteString(plain)
		sb.WriteByte('\n')
	}
	return sb.String(), nil
}

// appendOTelEnv injects universal OpenTelemetry env vars into the .env file.
// Only safe, language-agnostic vars go here (OTEL_* are ignored by runtimes
// that don't use them). Language-specific loader vars (NODE_OPTIONS,
// JAVA_TOOL_OPTIONS, etc.) are injected per-service in the compose override
// by writeOTelComposeOverride, so each container only gets what it needs.
func appendOTelEnv(envContent, projectName string) string {
	var sb strings.Builder
	sb.WriteString(envContent)
	sb.WriteString("\n# OpenTelemetry auto-instrumentation — injected by OffDock (do not edit)\n")
	sb.WriteString("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://host.docker.internal:7070/v1/traces\n")
	sb.WriteString("OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf\n")
	sb.WriteString("OTEL_SERVICE_NAME=" + projectName + "\n")
	sb.WriteString("OTEL_TRACES_SAMPLER=parentbased_traceidratio\n")
	sb.WriteString("OTEL_TRACES_SAMPLER_ARG=1.0\n")
	sb.WriteString("OTEL_RESOURCE_ATTRIBUTES=deployment.environment=production\n")
	sb.WriteString("OTEL_METRICS_EXPORTER=none\n")
	sb.WriteString("OTEL_LOGS_EXPORTER=none\n")
	return sb.String()
}

// resolveHostIP returns the server's first non-loopback IPv4 address.
func resolveHostIP() string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return "localhost"
	}
	for _, a := range addrs {
		if ip, ok := a.(*net.IPNet); ok && !ip.IP.IsLoopback() {
			if v4 := ip.IP.To4(); v4 != nil {
				return v4.String()
			}
		}
	}
	return "localhost"
}

// writeOTelComposeOverride generates a docker-compose override that:
//   - injects per-service tracer mounts and language-specific env vars based on
//     detected language from the service's image name
//   - merges language loader flags with any existing user-set env vars (e.g.
//     NODE_OPTIONS, JAVA_TOOL_OPTIONS) to avoid clobbering them
//   - injects host.docker.internal so containers can reach OffDock at :7070
//   - only mounts tracer files that actually exist on the host
func writeOTelComposeOverride(composePath, overridePath, envContent, projectName string, isFile func(string) bool) error {
	info, err := parseComposeInfo(composePath)
	if err != nil {
		return fmt.Errorf("parse compose: %w", err)
	}
	if len(info.ServiceNames) == 0 {
		return fmt.Errorf("no services found in compose file")
	}

	hostIP := resolveHostIP()

	type vol struct{ host, container string }

	var sb strings.Builder
	sb.WriteString("# Auto-generated by OffDock OTel injection — do not edit\n")
	sb.WriteString("services:\n")

	for _, svc := range info.Services {
		sb.WriteString("  " + svc.Name + ":\n")

		var mounts []vol
		var envVars []string

		for _, lang := range svc.Languages {
			switch lang {
			case "java":
				if isFile("/var/offdock/otel/opentelemetry-javaagent.jar") {
					mounts = append(mounts, vol{"/var/offdock/otel/opentelemetry-javaagent.jar", "/otel/opentelemetry-javaagent.jar"})
					agent := "-javaagent:/otel/opentelemetry-javaagent.jar"
					if existing := parseEnvValue(envContent, "JAVA_TOOL_OPTIONS"); existing != "" {
						envVars = append(envVars, "JAVA_TOOL_OPTIONS="+agent+" "+existing)
					} else {
						envVars = append(envVars, "JAVA_TOOL_OPTIONS="+agent)
					}
				}
			case "nodejs":
				if isFile("/var/offdock/otel/node/tracer.js") {
					mounts = append(mounts, vol{"/var/offdock/otel/node/tracer.js", "/otel/node/tracer.js"})
					flag := "--require /otel/node/tracer.js"
					if existing := parseEnvValue(envContent, "NODE_OPTIONS"); existing != "" {
						envVars = append(envVars, "NODE_OPTIONS="+flag+" "+existing)
					} else {
						envVars = append(envVars, "NODE_OPTIONS="+flag)
					}
				}
			case "php":
				if isFile("/var/offdock/otel/php/offdock.ini") {
					mounts = append(mounts, vol{"/var/offdock/otel/php/tracer.php", "/otel/php/tracer.php"})
					mounts = append(mounts, vol{"/var/offdock/otel/php/offdock.ini", "/otel/php/offdock.ini"})
					envVars = append(envVars, "PHP_INI_SCAN_DIR=/otel/php")
				}
			case "python":
				if isFile("/var/offdock/otel/python/sitecustomize.py") {
					mounts = append(mounts, vol{"/var/offdock/otel/python/sitecustomize.py", "/otel/python/sitecustomize.py"})
					if existing := parseEnvValue(envContent, "PYTHONPATH"); existing != "" {
						envVars = append(envVars, "PYTHONPATH=/otel/python:"+existing)
					} else {
						envVars = append(envVars, "PYTHONPATH=/otel/python")
					}
				}
			case "ruby":
				if isFile("/var/offdock/otel/ruby/tracer.rb") {
					mounts = append(mounts, vol{"/var/offdock/otel/ruby/tracer.rb", "/otel/ruby/tracer.rb"})
					flag := "-r /otel/ruby/tracer.rb"
					if existing := parseEnvValue(envContent, "RUBYOPT"); existing != "" {
						envVars = append(envVars, "RUBYOPT="+flag+" "+existing)
					} else {
						envVars = append(envVars, "RUBYOPT="+flag)
					}
				}
			}
		}

		// Per-service service name overrides the project-level default in .env.
		envVars = append(envVars, "OTEL_SERVICE_NAME="+projectName+"-"+svc.Name)

		if len(mounts) > 0 {
			sb.WriteString("    volumes:\n")
			for _, m := range mounts {
				sb.WriteString("      - " + m.host + ":" + m.container + ":ro\n")
			}
		}
		if len(envVars) > 0 {
			sb.WriteString("    environment:\n")
			for _, e := range envVars {
				sb.WriteString("      - " + e + "\n")
			}
		}
		sb.WriteString("    extra_hosts:\n")
		sb.WriteString("      - \"host.docker.internal:" + hostIP + "\"\n")
		if len(info.ExternalNetworks) > 0 {
			sb.WriteString("    networks:\n")
			sb.WriteString("      - default\n")
			for _, net := range info.ExternalNetworks {
				sb.WriteString("      - " + net + "\n")
			}
		}
	}

	if len(info.ExternalNetworks) > 0 {
		sb.WriteString("networks:\n")
		for _, net := range info.ExternalNetworks {
			sb.WriteString("  " + net + ":\n")
			sb.WriteString("    external: true\n")
		}
	}

	return atomicWrite(overridePath, []byte(sb.String()))
}

// parseEnvValue finds the value of key in an env file string (KEY=value lines).
// Returns "" if not found. Strips surrounding single/double quotes.
func parseEnvValue(content, key string) string {
	prefix := key + "="
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if len(line) == 0 || line[0] == '#' {
			continue
		}
		if strings.HasPrefix(line, prefix) {
			v := strings.TrimPrefix(line, prefix)
			if len(v) >= 2 && ((v[0] == '"' && v[len(v)-1] == '"') || (v[0] == '\'' && v[len(v)-1] == '\'')) {
				v = v[1 : len(v)-1]
			}
			return v
		}
	}
	return ""
}

// composeBuild handles both the string form (build: .) and the map form
// (build: {context: ., dockerfile: Dockerfile}).
type composeBuild struct {
	Context    string
	Dockerfile string
}

func (b *composeBuild) UnmarshalYAML(value *yaml.Node) error {
	if value.Kind == yaml.ScalarNode {
		b.Context = value.Value
		return nil
	}
	type plain struct {
		Context    string `yaml:"context"`
		Dockerfile string `yaml:"dockerfile"`
	}
	var p plain
	if err := value.Decode(&p); err != nil {
		return err
	}
	b.Context = p.Context
	b.Dockerfile = p.Dockerfile
	return nil
}

// composeService holds the fields we need from a docker-compose service definition.
type composeService struct {
	Image string        `yaml:"image"`
	Build *composeBuild `yaml:"build"`
}

// composeFile parses docker-compose.yml to extract service names and external networks.
type composeFile struct {
	Services map[string]*composeService `yaml:"services"`
	Networks map[string]struct {
		External bool `yaml:"external"`
	} `yaml:"networks"`
}

// serviceInfo holds per-service metadata used for per-container OTel injection.
type serviceInfo struct {
	Name      string
	Image     string
	Languages []string // detected: "java", "nodejs", "php", "python", "ruby"
}

type composeInfo struct {
	Services         []serviceInfo
	ServiceNames     []string
	ExternalNetworks []string
}

// detectServiceLanguages infers which language runtimes a container image runs
// from its image name and optional build context hint (Dockerfile or context path).
// Returns nil for infrastructure images (postgres, redis, etc.) that should not
// receive tracer injection.
func detectServiceLanguages(image string, buildHint ...string) []string {
	hint := ""
	if len(buildHint) > 0 {
		hint = strings.ToLower(buildHint[0])
	}
	// When there's no image name and no useful build hint, skip injection.
	if image == "" && hint == "" {
		return nil
	}
	img := strings.ToLower(image)
	// Strip tag (last colon after the last slash).
	if i := strings.LastIndex(img, ":"); i > strings.LastIndex(img, "/") {
		img = img[:i]
	}
	// Use only the image name, not registry/org prefix.
	if i := strings.LastIndex(img, "/"); i >= 0 {
		img = img[i+1:]
	}

	// Skip known infra images — injecting tracers into these causes startup errors.
	infraKeywords := []string{
		"postgres", "mysql", "mariadb", "redis", "mongo", "nginx", "caddy",
		"traefik", "rabbitmq", "kafka", "zookeeper", "elasticsearch", "kibana",
		"grafana", "prometheus", "mssql", "sqlserver", "memcached", "nats",
		"vault", "consul", "etcd", "haproxy",
	}
	for _, kw := range infraKeywords {
		if strings.Contains(img, kw) {
			return nil
		}
	}

	// combined is what we search — image name + any build context hint (dockerfile/context path).
	combined := img + " " + hint

	type entry struct {
		keywords []string
		lang     string
	}
	checks := []entry{
		{[]string{"java", "spring", "tomcat", "wildfly", "jboss", "quarkus", "micronaut", "openjdk", "eclipse-temurin", "corretto", "zulu", "graalvm"}, "java"},
		{[]string{"node", "nodejs"}, "nodejs"},
		{[]string{"php", "wordpress", "magento", "drupal", "joomla", "laravel"}, "php"},
		{[]string{"python", "django", "flask", "fastapi", "gunicorn", "uvicorn"}, "python"},
		{[]string{"ruby", "rails"}, "ruby"},
	}

	var langs []string
	for _, c := range checks {
		for _, kw := range c.keywords {
			if strings.Contains(combined, kw) {
				langs = append(langs, c.lang)
				break
			}
		}
	}
	return langs
}

func parseComposeInfo(path string) (composeInfo, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return composeInfo{}, err
	}
	var cf composeFile
	if err := yaml.Unmarshal(data, &cf); err != nil {
		return composeInfo{}, err
	}

	services := make([]serviceInfo, 0, len(cf.Services))
	names := make([]string, 0, len(cf.Services))
	for k, svc := range cf.Services {
		names = append(names, k)
		img := ""
		buildHint := ""
		if svc != nil {
			img = svc.Image
			if svc.Build != nil {
				// Use dockerfile name + context path as language hint for build: services.
				buildHint = svc.Build.Dockerfile + " " + svc.Build.Context
			}
		}
		services = append(services, serviceInfo{
			Name:      k,
			Image:     img,
			Languages: detectServiceLanguages(img, buildHint),
		})
	}
	sort.Strings(names)
	sort.Slice(services, func(i, j int) bool { return services[i].Name < services[j].Name })

	var extNets []string
	for netName, netCfg := range cf.Networks {
		if netCfg.External {
			extNets = append(extNets, netName)
		}
	}
	sort.Strings(extNets)

	return composeInfo{Services: services, ServiceNames: names, ExternalNetworks: extNets}, nil
}

func parseComposeServiceNames(path string) ([]string, error) {
	info, err := parseComposeInfo(path)
	return info.ServiceNames, err
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

// fireWebhook sends a JSON POST to url with deploy result. Runs in a goroutine
// so it never blocks the deployment path. Failures are logged but not fatal.
func fireWebhook(webhookURL, status, projectName, deployID string) {
	if webhookURL == "" {
		return
	}
	payload, _ := json.Marshal(map[string]string{
		"status":     status,
		"project":    projectName,
		"deploy_id":  deployID,
		"timestamp":  time.Now().UTC().Format(time.RFC3339),
	})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, webhookURL, bytes.NewReader(payload))
	if err != nil {
		slog.Warn("webhook: build request failed", "url", webhookURL, "err", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "OffDock/1.0")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		slog.Warn("webhook: request failed", "url", webhookURL, "err", err)
		return
	}
	resp.Body.Close()
	slog.Info("webhook: sent", "url", webhookURL, "status", resp.StatusCode, "deploy_status", status)
}
