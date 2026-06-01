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

// ApplyResult describes what Apply wrote.
type ApplyResult struct {
	ConfigPath      string
	NginxTestOutput string
}

// Apply writes the generated nginx config for the project into the Docker-managed
// conf.d directory, tests it inside the offdock-nginx container, and reloads nginx.
//
// If the container is not running the config is still written so it takes effect
// automatically when the container is started.
func Apply(cfg store.NginxConfig, projectName string) (*ApplyResult, error) {
	content, err := Generate(cfg)
	if err != nil {
		return nil, fmt.Errorf("generate config: %w", err)
	}

	if err := ensureNginxFiles(); err != nil {
		return nil, fmt.Errorf("ensure dirs: %w", err)
	}

	fileName := fmt.Sprintf("offdock-%s.conf", sanitizeName(projectName))
	confPath := filepath.Join(NginxConfdDir, fileName)

	tmp := confPath + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o644); err != nil {
		return nil, fmt.Errorf("write config: %w", err)
	}
	if err := os.Rename(tmp, confPath); err != nil {
		os.Remove(tmp) //nolint:errcheck
		return nil, fmt.Errorf("install config: %w", err)
	}

	result := &ApplyResult{ConfigPath: confPath}

	// Only test+reload when the container is actually running.
	status := GetContainerStatus()
	if !status.Running {
		result.NginxTestOutput = "config saved — nginx container not running, will apply on start"
		return result, nil
	}

	testOut, testErr := TestContainerConfig()
	result.NginxTestOutput = testOut
	if testErr != nil {
		// Roll back on test failure.
		os.Remove(confPath) //nolint:errcheck
		return nil, fmt.Errorf("nginx -t failed: %w\n%s", testErr, testOut)
	}

	if _, err := ReloadNginxContainer(); err != nil {
		return nil, fmt.Errorf("nginx reload: %w", err)
	}

	return result, nil
}

// ApplyProxyHost writes and activates a nginx config for a ProxyHost.
func ApplyProxyHost(h store.ProxyHost) (*ApplyResult, error) {
	content, err := GenerateProxyHost(h)
	if err != nil {
		return nil, fmt.Errorf("generate config: %w", err)
	}
	if err := ensureNginxFiles(); err != nil {
		return nil, fmt.Errorf("ensure dirs: %w", err)
	}

	fileName := fmt.Sprintf("offdock-host-%s.conf", sanitizeName(SanitizeDomain(h.Domain)))
	confPath := filepath.Join(NginxConfdDir, fileName)

	tmp := confPath + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o644); err != nil {
		return nil, fmt.Errorf("write config: %w", err)
	}
	if err := os.Rename(tmp, confPath); err != nil {
		os.Remove(tmp) //nolint:errcheck
		return nil, fmt.Errorf("install config: %w", err)
	}

	result := &ApplyResult{ConfigPath: confPath}

	status := GetContainerStatus()
	if !status.Running {
		result.NginxTestOutput = "config saved — nginx not running, will apply on start"
		return result, nil
	}

	testOut, testErr := TestContainerConfig()
	result.NginxTestOutput = testOut
	if testErr != nil {
		os.Remove(confPath) //nolint:errcheck
		return nil, fmt.Errorf("nginx -t failed: %w\n%s", testErr, testOut)
	}

	if _, err := ReloadNginxContainer(); err != nil {
		return nil, fmt.Errorf("nginx reload: %w", err)
	}
	return result, nil
}

// RemoveProxyHost deletes the nginx config file for a ProxyHost and reloads nginx.
func RemoveProxyHost(domain string) error {
	fileName := fmt.Sprintf("offdock-host-%s.conf", sanitizeName(SanitizeDomain(domain)))
	confPath := filepath.Join(NginxConfdDir, fileName)
	os.Remove(confPath) //nolint:errcheck

	status := GetContainerStatus()
	if !status.Running {
		return nil
	}
	_, err := ReloadNginxContainer()
	return err
}

// WriteDefaultServer writes the catch-all 00-default.conf that returns 444 for
// requests that do not match any configured server_name. This prevents raw-IP
// or unknown-Host requests from hitting a real site.
func WriteDefaultServer() error {
	if err := ensureNginxFiles(); err != nil {
		return err
	}

	// Ensure the catch-all self-signed cert exists for the HTTPS default_server block.
	catchAllCert := filepath.Join(NginxCertsDir, "catch-all.crt")
	catchAllKey := filepath.Join(NginxCertsDir, "catch-all.key")
	if _, err := os.Stat(catchAllCert); os.IsNotExist(err) {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, "openssl", "req", "-x509", "-nodes",
			"-days", "3650", "-newkey", "rsa:2048",
			"-keyout", catchAllKey, "-out", catchAllCert,
			"-subj", "/CN=offdock-catch-all",
		)
		if out, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("generate catch-all cert: %w: %s", err, out)
		}
	}

	confPath := filepath.Join(NginxConfdDir, "00-default.conf")
	tmp := confPath + ".tmp"
	if err := os.WriteFile(tmp, []byte(GenerateDefaultServer()), 0o644); err != nil {
		return fmt.Errorf("write default server: %w", err)
	}
	if err := os.Rename(tmp, confPath); err != nil {
		os.Remove(tmp) //nolint:errcheck
		return fmt.Errorf("install default server: %w", err)
	}
	return nil
}

// Remove deletes the nginx config file for a project and reloads the container.
func Remove(projectName string) error {
	fileName := fmt.Sprintf("offdock-%s.conf", sanitizeName(projectName))
	confPath := filepath.Join(NginxConfdDir, fileName)
	os.Remove(confPath) //nolint:errcheck

	status := GetContainerStatus()
	if !status.Running {
		return nil
	}
	_, err := ReloadNginxContainer()
	return err
}

func sanitizeName(name string) string {
	r := strings.NewReplacer(" ", "-", "/", "-", "\\", "-", ".", "-")
	return strings.ToLower(r.Replace(name))
}
