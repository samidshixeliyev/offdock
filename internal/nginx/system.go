package nginx

import (
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
	SystemSitesAvailable = "/etc/nginx/sites-available"
	SystemSitesEnabled   = "/etc/nginx/sites-enabled"
)

// SystemAvailable reports whether system nginx (not the Docker container) is installed.
func SystemAvailable() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, "nginx", "-v").Run() == nil
}

// ApplySystem writes an nginx config for a project to /etc/nginx/sites-available/,
// enables it via symlink, tests the config, and reloads nginx.
func ApplySystem(cfg store.NginxConfig, projectName string) (*ApplyResult, error) {
	content, err := Generate(cfg)
	if err != nil {
		return nil, fmt.Errorf("generate config: %w", err)
	}
	return applySystemConfig(fmt.Sprintf("offdock-%s", sanitizeName(projectName)), content)
}

// ApplyProxyHostSystem writes a ProxyHost config to /etc/nginx/sites-available/.
func ApplyProxyHostSystem(h store.ProxyHost) (*ApplyResult, error) {
	content, err := GenerateProxyHost(h)
	if err != nil {
		return nil, fmt.Errorf("generate config: %w", err)
	}
	return applySystemConfig(fmt.Sprintf("offdock-host-%s", sanitizeName(SanitizeDomain(h.Domain))), content)
}

// RemoveSystem removes a project's nginx config from sites-available/enabled and reloads.
func RemoveSystem(projectName string) error {
	name := fmt.Sprintf("offdock-%s", sanitizeName(projectName))
	avail := filepath.Join(SystemSitesAvailable, name+".conf")
	enabled := filepath.Join(SystemSitesEnabled, name+".conf")
	os.Remove(enabled) //nolint:errcheck
	os.Remove(avail)   //nolint:errcheck
	return reloadSystem()
}

// RemoveProxyHostSystem removes a ProxyHost nginx config and reloads.
func RemoveProxyHostSystem(domain string) error {
	name := fmt.Sprintf("offdock-host-%s", sanitizeName(SanitizeDomain(domain)))
	avail := filepath.Join(SystemSitesAvailable, name+".conf")
	enabled := filepath.Join(SystemSitesEnabled, name+".conf")
	os.Remove(enabled) //nolint:errcheck
	os.Remove(avail)   //nolint:errcheck
	return reloadSystem()
}

// GenerateSelfConfig returns an nginx server block that proxies the given domain
// to OffDock running on localhost:port. Includes WebSocket support for SSE/terminals.
func GenerateSelfConfig(domain string, port int) string {
	return fmt.Sprintf(`server {
    listen 80;
    server_name %s;
    server_tokens off;
    client_max_body_size 100m;

    # WebSocket / SSE / terminal support
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_connect_timeout 10s;

    location / {
        proxy_pass http://127.0.0.1:%d;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
    }
}
`, domain, port)
}

// ApplySelfConfig writes the OffDock self-hosting nginx config to sites-available.
func ApplySelfConfig(domain string, port int) (*ApplyResult, error) {
	content := GenerateSelfConfig(domain, port)
	return applySystemConfig("offdock-self", content)
}

// WriteSystemDefaultServer writes the catch-all 444 default server config.
func WriteSystemDefaultServer() error {
	confPath := filepath.Join(SystemSitesAvailable, "00-offdock-default.conf")
	content := `server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    server_tokens off;
    return 444;
}
`
	tmp := confPath + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o644); err != nil {
		return fmt.Errorf("write default config: %w", err)
	}
	if err := os.Rename(tmp, confPath); err != nil {
		os.Remove(tmp) //nolint:errcheck
		return fmt.Errorf("install default config: %w", err)
	}
	// Enable it
	enabled := filepath.Join(SystemSitesEnabled, "00-offdock-default.conf")
	os.Remove(enabled) //nolint:errcheck
	if err := os.Symlink(confPath, enabled); err != nil && !os.IsExist(err) {
		return fmt.Errorf("enable default config: %w", err)
	}
	return reloadSystem()
}

// TestSystem runs nginx -t to validate config.
func TestSystem() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "nginx", "-t").CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

// --- helpers ---

func applySystemConfig(name, content string) (*ApplyResult, error) {
	if err := os.MkdirAll(SystemSitesAvailable, 0o755); err != nil {
		return nil, fmt.Errorf("ensure sites-available: %w", err)
	}
	if err := os.MkdirAll(SystemSitesEnabled, 0o755); err != nil {
		return nil, fmt.Errorf("ensure sites-enabled: %w", err)
	}

	confPath := filepath.Join(SystemSitesAvailable, name+".conf")
	tmp := confPath + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o644); err != nil {
		return nil, fmt.Errorf("write config: %w", err)
	}
	if err := os.Rename(tmp, confPath); err != nil {
		os.Remove(tmp) //nolint:errcheck
		return nil, fmt.Errorf("install config: %w", err)
	}

	// Create symlink in sites-enabled (idempotent).
	enabled := filepath.Join(SystemSitesEnabled, name+".conf")
	os.Remove(enabled) //nolint:errcheck
	if err := os.Symlink(confPath, enabled); err != nil && !os.IsExist(err) {
		return nil, fmt.Errorf("enable config: %w", err)
	}

	// Test the config.
	testOut, testErr := TestSystem()
	if testErr != nil {
		// Roll back.
		os.Remove(enabled)  //nolint:errcheck
		os.Remove(confPath) //nolint:errcheck
		return nil, fmt.Errorf("nginx -t failed: %w\n%s", testErr, testOut)
	}

	if err := reloadSystem(); err != nil {
		return nil, fmt.Errorf("nginx reload: %w", err)
	}

	return &ApplyResult{ConfigPath: confPath, NginxTestOutput: testOut}, nil
}

func reloadSystem() error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "systemctl", "reload", "nginx").CombinedOutput()
	if err != nil {
		return fmt.Errorf("systemctl reload nginx: %w — %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}
