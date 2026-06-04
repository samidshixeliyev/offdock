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

// ApplyResult describes what Apply wrote.
type ApplyResult struct {
	ConfigPath      string
	NginxTestOutput string
}

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
// to OffDock on localhost:port. If pemPath is provided the block uses HTTPS
// (port 443 with HTTP→HTTPS redirect). Otherwise plain HTTP port 80.
// pemPath is a combined PEM file containing the cert chain and private key.
func GenerateSelfConfig(domain string, port int, pemPath string) string {
	locationBlock := fmt.Sprintf(`    location / {
        proxy_pass http://127.0.0.1:%d;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
    }`, port)

	if pemPath != "" {
		return fmt.Sprintf(`server {
    listen 80;
    server_name %s;
    server_tokens off;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name %s;
    server_tokens off;
    client_max_body_size 6g;

    ssl_certificate     %s;
    ssl_certificate_key %s;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_connect_timeout 10s;

%s
}
`, domain, domain, pemPath, pemPath, locationBlock)
	}

	return fmt.Sprintf(`server {
    listen 80;
    server_name %s;
    server_tokens off;
    client_max_body_size 6g;

    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_connect_timeout 10s;

%s
}
`, domain, locationBlock)
}

// ApplySelfConfig writes the OffDock self-hosting nginx config to sites-available.
// pemPath is a combined PEM file (cert chain + private key) — optional, HTTP-only if empty.
func ApplySelfConfig(domain string, port int, pemPath string) (*ApplyResult, error) {
	content := GenerateSelfConfig(domain, port, pemPath)
	return applySystemConfig("offdock-self", content)
}

// WriteSystemDefaultServer writes the catch-all 444 default server config.
// Covers both port 80 and port 443 so unknown-host HTTPS requests are also
// dropped rather than leaking a response from the first configured SSL vhost.
func WriteSystemDefaultServer() error {
	return WriteSystemDefaultServerWithSSL("")
}

// WriteSystemDefaultServerWithSSL writes the catch-all 444 config.
// When pemPath is non-empty the 443 default_server block uses SSL.
func WriteSystemDefaultServerWithSSL(pemPath string) error {
	confPath := filepath.Join(SystemSitesAvailable, "00-offdock-default.conf")
	var content string
	if pemPath != "" {
		content = fmt.Sprintf(`# offdock-generated — drop all unmatched requests
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    server_tokens off;
    return 444;
}

server {
    listen 443 ssl http2 default_server;
    server_name _;
    server_tokens off;

    ssl_certificate     %s;
    ssl_certificate_key %s;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    return 444;
}
`, pemPath, pemPath)
	} else {
		content = `# offdock-generated — drop all unmatched requests
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    server_tokens off;
    return 444;
}
`
	}
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

// OffDockLogFormat is the nginx log_format name used by all OffDock-managed vhosts.
// It extends the standard combined format with a trailing "$host" field so the
// traffic analyser can identify per-virtual-host traffic even in a shared log file.
const OffDockLogFormat = "offdock_main"

// logFormatConf is the content written to /etc/nginx/conf.d/offdock-logformat.conf.
const logFormatConf = `# OffDock extended log format — DO NOT EDIT (managed by OffDock)
# Extends combined with: $host, $request_time, $upstream_response_time, $upstream_addr
log_format offdock_main '$remote_addr - $remote_user [$time_local] "$request" '
                        '$status $body_bytes_sent "$http_referer" '
                        '"$http_user_agent" "$host" $request_time $upstream_response_time $upstream_addr';
`

// EnsureLogFormat writes the OffDock log_format definition to conf.d if it is
// absent or outdated. Safe to call on every nginx config apply.
func EnsureLogFormat() {
	const path = "/etc/nginx/conf.d/offdock-logformat.conf"
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(logFormatConf), 0o644); err != nil {
		return // non-fatal — fall back to "combined" format in configs
	}
	os.Rename(tmp, path) //nolint:errcheck
}

// --- helpers ---

func applySystemConfig(name, content string) (*ApplyResult, error) {
	EnsureLogFormat()

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
		// nginx -t passed but reload failed — roll back so the next reload
		// doesn't pick up a potentially problematic config.
		os.Remove(enabled)  //nolint:errcheck
		os.Remove(confPath) //nolint:errcheck
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
