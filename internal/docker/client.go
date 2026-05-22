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
// For containers with a HEALTHCHECK it returns "healthy"/"unhealthy"/"starting".
// For containers without one it returns the raw State.Status ("running", "exited", …).
func (c *Client) HealthStatus(ctx context.Context, containerName string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()

	// Use a conditional template so nil Health doesn't cause an error.
	out, err := run(ctx, "inspect",
		"--format", `{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}`,
		containerName,
	)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
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

// RestartContainer runs docker restart on a single container.
func (c *Client) RestartContainer(ctx context.Context, name string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()
	_, err := run(ctx, "restart", name)
	return err
}

// StopContainer runs docker stop on a single container.
func (c *Client) StopContainer(ctx context.Context, name string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()
	_, err := run(ctx, "stop", name)
	return err
}

// StartContainer runs docker start on a single container.
func (c *Client) StartContainer(ctx context.Context, name string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()
	_, err := run(ctx, "start", name)
	return err
}

// ComposeUp runs docker compose up -d. forceRecreate ensures containers are
// always rebuilt even when the image digest has not changed.
func (c *Client) ComposeUp(ctx context.Context, project, composePath string, forceRecreate bool) (string, error) {
	args := []string{"compose", "-p", project, "-f", composePath, "up", "-d", "--remove-orphans"}
	if forceRecreate {
		args = append(args, "--force-recreate")
	}
	cmd := exec.CommandContext(ctx, "docker", args...)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()
	return out.String(), err
}

// DeleteContainer force-removes a container by name or short ID.
func (c *Client) DeleteContainer(ctx context.Context, name string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()
	_, err := run(ctx, "rm", "-f", name)
	return err
}

// ComposeDown stops and removes containers for a project.
func (c *Client) ComposeDown(ctx context.Context, project, composePath string) (string, error) {
	cmd := exec.CommandContext(ctx, "docker", "compose", "-p", project, "-f", composePath, "down", "--remove-orphans")
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()
	return out.String(), err
}

// ComposePS returns container info for a specific compose project.
//
// docker compose ps --format json uses "Name" (singular) and a Publishers array for
// ports, which differs from the "Names"/string-ports format of plain docker ps.
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

	type publisher struct {
		TargetPort    int    `json:"TargetPort"`
		PublishedPort int    `json:"PublishedPort"`
		Protocol      string `json:"Protocol"`
	}
	type entry struct {
		ID         string      `json:"ID"`
		Name       string      `json:"Name"`       // docker compose ps uses singular Name
		Names      string      `json:"Names"`      // plain docker ps uses plural Names
		Image      string      `json:"Image"`
		Status     string      `json:"Status"`
		State      string      `json:"State"`
		Publishers []publisher `json:"Publishers"` // compose ps ports as objects
		Ports      string      `json:"Ports"`      // plain docker ps ports as string
	}

	toInfo := func(e entry) ContainerInfo {
		name := e.Names
		if name == "" {
			name = e.Name
		}
		ports := e.Ports
		if ports == "" && len(e.Publishers) > 0 {
			var parts []string
			for _, p := range e.Publishers {
				if p.PublishedPort > 0 {
					parts = append(parts, fmt.Sprintf("%d->%d/%s", p.PublishedPort, p.TargetPort, p.Protocol))
				}
			}
			ports = strings.Join(parts, ", ")
		}
		return ContainerInfo{ID: e.ID, Names: name, Image: e.Image, Status: e.Status, State: e.State, Ports: ports}
	}

	var result []ContainerInfo
	var entries []entry
	if err := json.Unmarshal(out.Bytes(), &entries); err == nil {
		for _, e := range entries {
			result = append(result, toInfo(e))
		}
		return result, nil
	}

	// Fallback: JSONL (one JSON object per line).
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		if line == "" {
			continue
		}
		var e entry
		if err := json.Unmarshal([]byte(line), &e); err == nil {
			result = append(result, toInfo(e))
		}
	}
	return result, nil
}
