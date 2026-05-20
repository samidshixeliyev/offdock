// Package docker wraps the docker and docker-compose CLI tools.
// All calls set an explicit timeout via context to prevent hangs.
package docker

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

const defaultTimeout = 30 * time.Second

// Client executes docker CLI commands against the host daemon.
type Client struct{}

// New returns a new Client.
func New() *Client { return &Client{} }

// run executes the given docker command and returns combined stdout/stderr.
func run(ctx context.Context, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "docker", args...)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Run(); err != nil {
		return out.String(), fmt.Errorf("docker %s: %w\n%s", args[0], err, out.String())
	}
	return out.String(), nil
}

// LoadImage loads a .tar image archive into the Docker daemon.
func (c *Client) LoadImage(ctx context.Context, tarPath string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	return run(ctx, "load", "-i", tarPath)
}

// RemoveImage removes a Docker image by ID or name:tag.
func (c *Client) RemoveImage(ctx context.Context, imageRef string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()
	_, err := run(ctx, "rmi", "-f", imageRef)
	return err
}

// ContainerInfo holds key fields from docker ps output.
type ContainerInfo struct {
	ID      string `json:"ID"`
	Names   string `json:"Names"`
	Image   string `json:"Image"`
	Status  string `json:"Status"`
	Ports   string `json:"Ports"`
	State   string `json:"State"`
}

// PS returns all containers (running and stopped) for the given compose project.
// Pass an empty project to list all containers.
func (c *Client) PS(ctx context.Context, project string) ([]ContainerInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()

	args := []string{"ps", "-a", "--format", "{{json .}}"}
	if project != "" {
		args = append(args, "--filter", "label=com.docker.compose.project="+project)
	}

	out, err := run(ctx, args...)
	if err != nil {
		return nil, err
	}

	var result []ContainerInfo
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		var ci ContainerInfo
		if err := json.Unmarshal([]byte(line), &ci); err == nil {
			result = append(result, ci)
		}
	}
	return result, nil
}

// HealthStatus returns the health status string for a container (e.g. "healthy", "unhealthy", "starting").
// Returns "running" if the container has no health check but is in the running state.
func (c *Client) HealthStatus(ctx context.Context, containerName string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()

	out, err := run(ctx, "inspect", "--format", "{{.State.Health.Status}}", containerName)
	if err != nil {
		return "", err
	}
	status := strings.TrimSpace(out)
	if status == "" || status == "<no value>" {
		// No healthcheck configured — check raw state
		stateOut, err := run(ctx, "inspect", "--format", "{{.State.Status}}", containerName)
		if err != nil {
			return "", err
		}
		return strings.TrimSpace(stateOut), nil
	}
	return status, nil
}

// Logs streams container logs and writes them to the provided writer.
// tail controls how many historical lines to include (0 = all).
func (c *Client) Logs(ctx context.Context, containerName string, tail int) *exec.Cmd {
	tailStr := "all"
	if tail > 0 {
		tailStr = fmt.Sprintf("%d", tail)
	}
	return exec.CommandContext(ctx, "docker", "logs", "--follow", "--tail", tailStr, "--timestamps", containerName)
}

// ContainerStats holds per-container resource usage returned by docker stats.
type ContainerStats struct {
	Name      string  `json:"name"`
	CPUPerc   string  `json:"CPUPerc"`
	MemUsage  string  `json:"MemUsage"`
	MemPerc   string  `json:"MemPerc"`
	NetIO     string  `json:"NetIO"`
	BlockIO   string  `json:"BlockIO"`
	PIDs      string  `json:"PIDs"`
}

// Stats returns a single snapshot of resource usage for all running containers.
func (c *Client) Stats(ctx context.Context) ([]ContainerStats, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()

	out, err := run(ctx, "stats", "--no-stream", "--format",
		`{"name":"{{.Name}}","CPUPerc":"{{.CPUPerc}}","MemUsage":"{{.MemUsage}}","MemPerc":"{{.MemPerc}}","NetIO":"{{.NetIO}}","BlockIO":"{{.BlockIO}}","PIDs":"{{.PIDs}}"}`)
	if err != nil {
		return nil, err
	}

	var result []ContainerStats
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		var s ContainerStats
		if err := json.Unmarshal([]byte(line), &s); err == nil {
			result = append(result, s)
		}
	}
	return result, nil
}

// ComposeUp runs docker compose up -d for the given project and compose file path.
func (c *Client) ComposeUp(ctx context.Context, project, composePath string) (string, error) {
	cmd := exec.CommandContext(ctx, "docker", "compose",
		"-p", project, "-f", composePath, "up", "-d", "--remove-orphans")
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()
	return out.String(), err
}

// ComposeDown stops and removes containers for the given project.
func (c *Client) ComposeDown(ctx context.Context, project, composePath string) (string, error) {
	cmd := exec.CommandContext(ctx, "docker", "compose",
		"-p", project, "-f", composePath, "down", "--remove-orphans")
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()
	return out.String(), err
}

// ComposePS returns container info for a specific compose project.
func (c *Client) ComposePS(ctx context.Context, project, composePath string) ([]ContainerInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "docker", "compose",
		"-p", project, "-f", composePath, "ps", "--format", "json")
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("compose ps: %w: %s", err, out.String())
	}

	var result []ContainerInfo
	if err := json.Unmarshal(out.Bytes(), &result); err != nil {
		// docker compose ps may return one JSON object per line
		for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
			if line == "" {
				continue
			}
			var ci ContainerInfo
			if err := json.Unmarshal([]byte(line), &ci); err == nil {
				result = append(result, ci)
			}
		}
	}
	return result, nil
}

// ImageList returns a list of {ID, Repository, Tag, Size} for all local images.
func (c *Client) ImageList(ctx context.Context) ([]map[string]string, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()

	out, err := run(ctx, "images", "--format",
		`{"id":"{{.ID}}","repo":"{{.Repository}}","tag":"{{.Tag}}","size":"{{.Size}}"}`)
	if err != nil {
		return nil, err
	}

	var result []map[string]string
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		var m map[string]string
		if err := json.Unmarshal([]byte(line), &m); err == nil {
			result = append(result, m)
		}
	}
	return result, nil
}
