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
	ContainerName   = "offdock-nginx"
	ContainerImage  = "uozi-lab/nginx-ui:latest"
	UIPort          = 9000
	NginxBaseDir    = "/var/offdock/nginx"
	NginxConfdDir   = "/var/offdock/nginx/conf.d"
	NginxCertsDir   = "/var/offdock/nginx/certs"
	NginxUIDataDir  = "/var/offdock/nginx-ui"
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

// StartNginxContainer creates (if needed) and starts the offdock-nginx container.
func StartNginxContainer() error {
	if err := ensureNginxFiles(); err != nil {
		return fmt.Errorf("setup: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// If the container exists, check it's using the right image; remove if not.
	imgOut, existErr := exec.CommandContext(ctx, "docker", "inspect",
		"--format", "{{.Config.Image}}", ContainerName).Output()
	if existErr == nil {
		if strings.TrimSpace(string(imgOut)) == ContainerImage {
			// Correct image — just start it.
			out, err := exec.CommandContext(ctx, "docker", "start", ContainerName).CombinedOutput()
			if err != nil {
				return fmt.Errorf("docker start: %w — %s", err, strings.TrimSpace(string(out)))
			}
			if err := EnsureNetworks(); err == nil {
				ConnectContainer(ExternalNetwork, ContainerName) //nolint:errcheck
			}
			return nil
		}
		// Wrong image (e.g. old nginx:alpine) — remove and recreate.
		exec.CommandContext(ctx, "docker", "rm", "-f", ContainerName).Run() //nolint:errcheck
	}

	// Check the image is available locally (air-gapped safety).
	imgCtx, imgCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer imgCancel()
	if err := exec.CommandContext(imgCtx, "docker", "image", "inspect", ContainerImage).Run(); err != nil {
		return fmt.Errorf("image %q not found — load it via the Import page first", ContainerImage)
	}

	// Create and start.
	args := []string{
		"run", "-d",
		"--name", ContainerName,
		"--restart", "unless-stopped",
		"-p", "80:80",
		"-p", "443:443",
		"-p", "9000:9000",
		"-e", "NGINX_UI_IGNORE_DOCKER_SOCKET=true",
		"-v", NginxUIDataDir + ":/etc/nginx-ui",
		"-v", NginxConfdDir + ":/etc/nginx/conf.d",
		"-v", NginxCertsDir + ":/etc/nginx/certs:ro",
		ContainerImage,
	}
	out, err := exec.CommandContext(ctx, "docker", args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("docker run: %w — %s", err, strings.TrimSpace(string(out)))
	}

	// Connect nginx-ui to the external network so it can proxy to project containers.
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

// TestContainerConfig runs nginx -t inside the container and returns its output.
func TestContainerConfig() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", "exec", ContainerName, "nginx", "-t").CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

// ensureNginxFiles creates the required host directories.
func ensureNginxFiles() error {
	for _, dir := range []string{NginxConfdDir, NginxCertsDir, NginxUIDataDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	return nil
}

