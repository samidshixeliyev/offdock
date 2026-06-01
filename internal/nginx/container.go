package nginx

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

const (
	ContainerName  = "offdock-nginx"
	ContainerImage = "nginx:alpine"
	NginxBaseDir   = "/var/offdock/nginx"
	NginxConfdDir  = "/var/offdock/nginx/conf.d"
	NginxCertsDir  = "/var/offdock/nginx/certs"

	// BundledTarPath is the expected location of the pre-bundled nginx:alpine image.
	// install.sh copies assets/nginx-alpine.tar here.
	BundledTarPath = "/var/offdock/nginx-alpine.tar"
)

// ContainerStatus is the live state of the nginx Docker container.
type ContainerStatus struct {
	Running    bool   `json:"running"`
	State      string `json:"state"`       // running | exited | not_found | unknown
	StatusText string `json:"status_text"` // human-readable ("Up 2 hours", etc.)
	Image      string `json:"image"`
}

// GetContainerStatus inspects the nginx container without failing if absent.
func GetContainerStatus() *ContainerStatus {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	out, err := exec.CommandContext(ctx, "docker", "inspect",
		"--format", `{{.State.Status}}|{{.State.Running}}|{{.Config.Image}}`,
		ContainerName,
	).Output()
	if err != nil {
		return &ContainerStatus{Running: false, State: "not_found", StatusText: "Not created"}
	}

	parts := strings.SplitN(strings.TrimSpace(string(out)), "|", 3)
	if len(parts) < 3 {
		return &ContainerStatus{Running: false, State: "unknown", StatusText: "Unknown"}
	}
	state := parts[0]
	running := parts[1] == "true"
	statusText := state
	if running {
		statusText = "Running"
	}
	return &ContainerStatus{
		Running:    running,
		State:      state,
		StatusText: statusText,
		Image:      parts[2],
	}
}

// EnsureImage checks that nginx:alpine is present in Docker; if not, loads the
// bundled tar (installed by install.sh at BundledTarPath). Returns an error
// only when the image is unavailable and cannot be loaded.
func EnsureImage() error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := exec.CommandContext(ctx, "docker", "image", "inspect", ContainerImage).Run(); err == nil {
		return nil // already present
	}
	// Try to load from bundled tar.
	for _, path := range []string{BundledTarPath, "assets/nginx-alpine.tar"} {
		if _, statErr := os.Stat(path); statErr != nil {
			continue
		}
		lCtx, lCancel := context.WithTimeout(context.Background(), 2*time.Minute)
		out, loadErr := exec.CommandContext(lCtx, "docker", "load", "-i", path).CombinedOutput()
		lCancel()
		if loadErr != nil {
			return fmt.Errorf("load nginx image from %s: %w — %s", path, loadErr, strings.TrimSpace(string(out)))
		}
		return nil
	}
	return fmt.Errorf("nginx:alpine image not found — copy nginx-alpine.tar to %s or import it via the Import page", BundledTarPath)
}

// StartNginxContainer creates (if needed) and starts the offdock-nginx container.
func StartNginxContainer() error {
	if err := ensureNginxFiles(); err != nil {
		return fmt.Errorf("setup: %w", err)
	}
	if err := EnsureImage(); err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// If container already exists start it; if image mismatch recreate.
	imgOut, existErr := exec.CommandContext(ctx, "docker", "inspect",
		"--format", "{{.Config.Image}}", ContainerName).Output()
	if existErr == nil {
		if strings.TrimSpace(string(imgOut)) == ContainerImage {
			out, err := exec.CommandContext(ctx, "docker", "start", ContainerName).CombinedOutput()
			if err != nil {
				return fmt.Errorf("docker start: %w — %s", err, strings.TrimSpace(string(out)))
			}
			if err := EnsureNetworks(); err == nil {
				ConnectContainer(ExternalNetwork, ContainerName) //nolint:errcheck
			}
			return nil
		}
		exec.CommandContext(ctx, "docker", "rm", "-f", ContainerName).Run() //nolint:errcheck
	}

	args := []string{
		"run", "-d",
		"--name", ContainerName,
		"--restart", "unless-stopped",
		"-p", "80:80",
		"-p", "443:443",
		"-v", NginxConfdDir + ":/etc/nginx/conf.d",
		"-v", NginxCertsDir + ":/etc/nginx/certs:ro",
		ContainerImage,
	}
	out, err := exec.CommandContext(ctx, "docker", args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("docker run: %w — %s", err, strings.TrimSpace(string(out)))
	}

	if err := EnsureNetworks(); err == nil {
		ConnectContainer(ExternalNetwork, ContainerName) //nolint:errcheck
	}
	return nil
}

// StopNginxContainer stops the offdock-nginx container.
func StopNginxContainer() error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", "stop", ContainerName).CombinedOutput()
	if err != nil {
		return fmt.Errorf("docker stop: %w — %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// ReloadNginxContainer sends nginx -s reload inside the container.
func ReloadNginxContainer() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", "exec", ContainerName, "nginx", "-s", "reload").CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

// TestContainerConfig runs nginx -t inside the container.
func TestContainerConfig() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", "exec", ContainerName, "nginx", "-t").CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func ensureNginxFiles() error {
	for _, dir := range []string{NginxConfdDir, NginxCertsDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	return nil
}
