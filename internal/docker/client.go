// Package docker wraps the docker and docker-compose CLI tools.
// All calls that are long-running use context.Background() so that HTTP request
// context cancellation (client disconnect, SSE interference) cannot abort them.
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

// run executes the given docker command and returns combined stdout+stderr.
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

// LoadImage loads a .tar archive into Docker.
// Uses its own context so HTTP request cancellation cannot abort a long load.
func (c *Client) LoadImage(tarPath string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	return run(ctx, "load", "-i", tarPath)
}

// RemoveImage removes a Docker image by ID or name:tag.
func (c *Client) RemoveImage(imageRef string) error {
	ctx, cancel := context.WithTimeout(context.Background(), defaultTimeout)
	defer cancel()
	_, err := run(ctx, "rmi", "-f", imageRef)
	return err
}

// ImageSummary is a row from docker images output.
type ImageSummary struct {
	ID         string `json:"ID"`
	Repository string `json:"Repository"`
	Tag        string `json:"Tag"`
	Size       string `json:"Size"`
	CreatedAt  string `json:"CreatedAt"`
}

// ImageList returns all images currently in the Docker daemon.
func (c *Client) ImageList() ([]ImageSummary, error) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultTimeout)
	defer cancel()

	out, err := run(ctx, "images", "--format",
		`{"ID":"{{.ID}}","Repository":"{{.Repository}}","Tag":"{{.Tag}}","Size":"{{.Size}}","CreatedAt":"{{.CreatedAt}}"}`)
	if err != nil {
		return nil, err
	}

	var result []ImageSummary
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		var s ImageSummary
		if err := json.Unmarshal([]byte(line), &s); err == nil {
			result = append(result, s)
		}
	}
	return result, nil
}

// ContainerInfo holds key fields from docker ps output.
type ContainerInfo struct {
	ID     string `json:"ID"`
	Names  string `json:"Names"`
	Image  string `json:"Image"`
	Status string `json:"Status"`
	Ports  string `json:"Ports"`
	State  string `json:"State"`
}

// PS returns containers for the given compose project (empty = all).
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

// HealthStatus returns the health/running status of a container.
func (c *Client) HealthStatus(ctx context.Context, containerName string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()

	out, err := run(ctx, "inspect", "--format", "{{.State.Health.Status}}", containerName)
	if err != nil {
		return "", err
	}
	status := strings.TrimSpace(out)
	if status == "" || status == "<no value>" {
		stateOut, err := run(ctx, "inspect", "--format", "{{.State.Status}}", containerName)
		if err != nil {
			return "", err
		}
		return strings.TrimSpace(stateOut), nil
	}
	return status, nil
}

// Logs returns a streaming docker logs command (caller must start and manage it).
func (c *Client) Logs(ctx context.Context, containerName string, tail int) *exec.Cmd {
	tailStr := "all"
	if tail > 0 {
		tailStr = fmt.Sprintf("%d", tail)
	}
	return exec.CommandContext(ctx, "docker", "logs", "--follow", "--tail", tailStr, "--timestamps", containerName)
}

// ContainerStats holds per-container resource usage.
type ContainerStats struct {
	Name     string `json:"name"`
	CPUPerc  string `json:"CPUPerc"`
	MemUsage string `json:"MemUsage"`
	MemPerc  string `json:"MemPerc"`
	NetIO    string `json:"NetIO"`
	BlockIO  string `json:"BlockIO"`
	PIDs     string `json:"PIDs"`
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

// ComposeUp runs docker compose up -d.
func (c *Client) ComposeUp(ctx context.Context, project, composePath string) (string, error) {
	cmd := exec.CommandContext(ctx, "docker", "compose", "-p", project, "-f", composePath, "up", "-d", "--remove-orphans")
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	return out.String(), cmd.Run()
}

// ComposeDown stops and removes containers for a project.
func (c *Client) ComposeDown(ctx context.Context, project, composePath string) (string, error) {
	cmd := exec.CommandContext(ctx, "docker", "compose", "-p", project, "-f", composePath, "down", "--remove-orphans")
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	return out.String(), cmd.Run()
}

// ComposePS returns container info for a specific compose project.
func (c *Client) ComposePS(ctx context.Context, project, composePath string) ([]ContainerInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "docker", "compose", "-p", project, "-f", composePath, "ps", "--format", "json")
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("compose ps: %w: %s", err, out.String())
	}

	var result []ContainerInfo
	if err := json.Unmarshal(out.Bytes(), &result); err != nil {
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
