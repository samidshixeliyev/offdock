package nginx

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"offdock/internal/store"
)

const (
	sitesAvailable = "/etc/nginx/sites-available"
	sitesEnabled   = "/etc/nginx/sites-enabled"

	defaultSiteEnabled = "/etc/nginx/sites-enabled/default"

	catchAllAvail   = "/etc/nginx/sites-available/offdock-default.conf"
	catchAllEnabled = "/etc/nginx/sites-enabled/offdock-default.conf"

	// Drop unmatched HTTP connections; never proxy unknown hosts.
	catchAllContent = `# Managed by OffDock — do not edit
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    return 444;
}
`
)

// ApplyResult is returned by Apply describing what was done.
type ApplyResult struct {
	ConfigPath      string
	SymlinkPath     string
	NginxTestOutput string
}

// Apply writes the nginx config for the project, tests it with nginx -t,
// and reloads nginx if the test passes.  It returns an error with nginx's
// stderr if the test fails (leaving the old config untouched).
func Apply(cfg store.NginxConfig, projectName string) (*ApplyResult, error) {
	content, err := Generate(cfg)
	if err != nil {
		return nil, fmt.Errorf("generate config: %w", err)
	}

	// Ensure OffDock owns the default server slot before writing project config.
	if err := ensureGlobalDefaults(); err != nil {
		return nil, fmt.Errorf("install global defaults: %w", err)
	}

	fileName := fmt.Sprintf("offdock-%s.conf", sanitizeName(projectName))
	availPath := filepath.Join(sitesAvailable, fileName)
	enabledPath := filepath.Join(sitesEnabled, fileName)

	// Write to temp file, rename atomically.
	tmpPath := availPath + ".tmp"
	if err := os.WriteFile(tmpPath, []byte(content), 0o644); err != nil {
		return nil, fmt.Errorf("write config tmp: %w", err)
	}
	if err := os.Rename(tmpPath, availPath); err != nil {
		os.Remove(tmpPath) //nolint:errcheck
		return nil, fmt.Errorf("install config: %w", err)
	}

	// Create or update symlink in sites-enabled first so nginx -t sees it.
	os.Remove(enabledPath) //nolint:errcheck
	if err := os.Symlink(availPath, enabledPath); err != nil {
		return nil, fmt.Errorf("create symlink: %w", err)
	}

	testOut, testErr := nginxTest()
	if testErr != nil {
		os.Remove(enabledPath) //nolint:errcheck
		os.Remove(availPath)   //nolint:errcheck
		return nil, fmt.Errorf("nginx -t failed: %w\n%s", testErr, testOut)
	}

	if err := nginxReload(); err != nil {
		return nil, fmt.Errorf("nginx reload: %w", err)
	}

	return &ApplyResult{
		ConfigPath:      availPath,
		SymlinkPath:     enabledPath,
		NginxTestOutput: testOut,
	}, nil
}

// ensureGlobalDefaults disables the stock nginx default site and installs
// OffDock's catch-all that returns 444 for unmatched hostnames.
func ensureGlobalDefaults() error {
	// Disable stock nginx default site (serves nginx welcome page).
	os.Remove(defaultSiteEnabled) //nolint:errcheck

	// Write catch-all config atomically.
	tmp := catchAllAvail + ".tmp"
	if err := os.WriteFile(tmp, []byte(catchAllContent), 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, catchAllAvail); err != nil {
		os.Remove(tmp) //nolint:errcheck
		return err
	}

	// Symlink into sites-enabled if not already present.
	if _, err := os.Lstat(catchAllEnabled); err != nil {
		return os.Symlink(catchAllAvail, catchAllEnabled)
	}
	return nil
}

// Remove deletes the nginx config and symlink for a project and reloads nginx.
func Remove(projectName string) error {
	fileName := fmt.Sprintf("offdock-%s.conf", sanitizeName(projectName))
	os.Remove(filepath.Join(sitesEnabled, fileName))  //nolint:errcheck
	os.Remove(filepath.Join(sitesAvailable, fileName)) //nolint:errcheck
	return nginxReload()
}

func nginxTest() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var out bytes.Buffer
	cmd := exec.CommandContext(ctx, "nginx", "-t")
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()
	return out.String(), err
}

func nginxReload() error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "systemctl", "reload", "nginx").CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w: %s", err, string(out))
	}
	return nil
}

func sanitizeName(name string) string {
	r := strings.NewReplacer(" ", "-", "/", "-", "\\", "-", ".", "-")
	return strings.ToLower(r.Replace(name))
}
