package nginx

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

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
