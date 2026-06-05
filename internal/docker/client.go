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
	Labels string `json:"Labels"`
}

// ComposeProject extracts the docker-compose project label from the comma-
// separated Labels string, or "" if the container is not part of a project.
func (ci ContainerInfo) ComposeProject() string {
	for _, kv := range strings.Split(ci.Labels, ",") {
		if strings.HasPrefix(kv, "com.docker.compose.project=") {
			return strings.TrimPrefix(kv, "com.docker.compose.project=")
		}
	}
	return ""
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

// ─── Networks ─────────────────────────────────────────────────────────────────

// NetworkSummary is one row from docker network ls.
type NetworkSummary struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Driver   string `json:"driver"`
	Scope    string `json:"scope"`
	Internal bool   `json:"internal"`
}

// NetworkDetail is the full inspect output for a single network.
type NetworkDetail struct {
	ID         string                       `json:"Id"`
	Name       string                       `json:"Name"`
	Driver     string                       `json:"Driver"`
	Scope      string                       `json:"Scope"`
	Internal   bool                         `json:"Internal"`
	Labels     map[string]string            `json:"Labels"`
	Containers map[string]NetworkContainerD `json:"Containers"`
	IPAM       struct {
		Config []struct {
			Subnet  string `json:"Subnet"`
			Gateway string `json:"Gateway"`
		} `json:"Config"`
	} `json:"IPAM"`
}

// NetworkContainerD is a container entry inside a network inspect result.
type NetworkContainerD struct {
	Name string `json:"Name"`
	IPv4 string `json:"IPv4Address"`
}

// ListNetworks returns all Docker networks with their attached containers.
func (c *Client) ListNetworks(ctx context.Context) ([]NetworkDetail, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()

	// Get all network names first.
	out, err := run(ctx, "network", "ls", "--format", "{{.Name}}")
	if err != nil {
		return nil, err
	}
	names := strings.Fields(strings.TrimSpace(out))
	if len(names) == 0 {
		return []NetworkDetail{}, nil
	}

	// Inspect all networks in one call (returns JSON array).
	args := append([]string{"network", "inspect"}, names...)
	ctx2, cancel2 := context.WithTimeout(context.Background(), defaultTimeout)
	defer cancel2()
	cmd := exec.CommandContext(ctx2, "docker", args...)
	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	cmd.Run() //nolint:errcheck — partial results are still useful

	var result []NetworkDetail
	if err := json.Unmarshal(buf.Bytes(), &result); err != nil {
		return []NetworkDetail{}, nil
	}
	return result, nil
}

// CreateNetwork creates a Docker network with the given driver (default: bridge).
func (c *Client) CreateNetwork(ctx context.Context, name, driver string) error {
	if driver == "" {
		driver = "bridge"
	}
	ctx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()
	out, err := run(ctx, "network", "create", "--driver", driver, name)
	if err != nil {
		return fmt.Errorf("%s", strings.TrimSpace(out))
	}
	return nil
}

// DeleteNetwork removes a Docker network by name.
func (c *Client) DeleteNetwork(ctx context.Context, name string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()
	out, err := run(ctx, "network", "rm", name)
	if err != nil {
		return fmt.Errorf("%s", strings.TrimSpace(out))
	}
	return nil
}

// NetworkConnect connects a container to a network. Idempotent.
func (c *Client) NetworkConnect(ctx context.Context, network, container string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()
	out, err := run(ctx, "network", "connect", network, container)
	if err != nil {
		msg := strings.TrimSpace(out)
		if strings.Contains(msg, "already exists") {
			return nil
		}
		return fmt.Errorf("%s", msg)
	}
	return nil
}

// NetworkDisconnect disconnects a container from a network.
func (c *Client) NetworkDisconnect(ctx context.Context, network, container string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()
	out, err := run(ctx, "network", "disconnect", network, container)
	if err != nil {
		return fmt.Errorf("%s", strings.TrimSpace(out))
	}
	return nil
}

// ─── Volumes ──────────────────────────────────────────────────────────────────

// VolumeSummary is one row from docker volume ls.
type VolumeSummary struct {
	Name       string            `json:"Name"`
	Driver     string            `json:"Driver"`
	Scope      string            `json:"Scope"`
	Mountpoint string            `json:"Mountpoint"`
	Labels     map[string]string `json:"Labels"`
	CreatedAt  string            `json:"CreatedAt"`
}

// ListVolumes returns all Docker volumes.
func (c *Client) ListVolumes(ctx context.Context) ([]VolumeSummary, error) {
	ctx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()

	// docker volume ls gives limited info; use inspect for full details.
	out, err := run(ctx, "volume", "ls", "--format", "{{.Name}}")
	if err != nil {
		return nil, err
	}
	names := strings.Fields(strings.TrimSpace(out))
	if len(names) == 0 {
		return []VolumeSummary{}, nil
	}

	args := append([]string{"volume", "inspect"}, names...)
	ctx2, cancel2 := context.WithTimeout(context.Background(), defaultTimeout)
	defer cancel2()
	cmd := exec.CommandContext(ctx2, "docker", args...)
	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	cmd.Run() //nolint:errcheck

	var result []VolumeSummary
	if err := json.Unmarshal(buf.Bytes(), &result); err != nil {
		// Fall back to name-only list.
		for _, n := range names {
			result = append(result, VolumeSummary{Name: n, Driver: "local"})
		}
	}
	return result, nil
}

// CreateVolume creates a Docker volume.
func (c *Client) CreateVolume(ctx context.Context, name, driver string) (*VolumeSummary, error) {
	if driver == "" {
		driver = "local"
	}
	ctx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()
	out, err := run(ctx, "volume", "create", "--driver", driver, name)
	if err != nil {
		return nil, fmt.Errorf("%s", strings.TrimSpace(out))
	}
	return &VolumeSummary{Name: strings.TrimSpace(out), Driver: driver}, nil
}

// DeleteVolume removes a Docker volume by name.
func (c *Client) DeleteVolume(ctx context.Context, name string) error {
	ctx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()
	out, err := run(ctx, "volume", "rm", name)
	if err != nil {
		return fmt.Errorf("%s", strings.TrimSpace(out))
	}
	return nil
}

// PruneVolumes removes all unused Docker volumes and returns (names, spaceReclaimed).
func (c *Client) PruneVolumes(ctx context.Context) ([]string, string, error) {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	out, err := run(ctx, "volume", "prune", "-f")
	if err != nil {
		return nil, "", fmt.Errorf("%s", strings.TrimSpace(out))
	}
	// Parse output: "Deleted Volumes:\nname1\nname2\n\nTotal reclaimed space: 1.2GB"
	var names []string
	space := ""
	inList := false
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "Deleted Volumes:") {
			inList = true
			continue
		}
		if strings.HasPrefix(line, "Total reclaimed space:") {
			space = strings.TrimPrefix(line, "Total reclaimed space: ")
			inList = false
			continue
		}
		if inList && line != "" {
			names = append(names, line)
		}
	}
	return names, space, nil
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

// ─── Disk usage + image prune ────────────────────────────────────────────────

// DiskUsageRow is one row from docker system df output.
type DiskUsageRow struct {
	Type        string `json:"type"`
	Total       string `json:"total"`
	Active      string `json:"active"`
	Size        string `json:"size"`
	Reclaimable string `json:"reclaimable"`
}

// SystemDiskUsage runs docker system df and returns per-type disk usage.
func (c *Client) SystemDiskUsage() ([]DiskUsageRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultTimeout)
	defer cancel()
	out, err := run(ctx, "system", "df")
	if err != nil {
		return nil, err
	}
	return parseDFOutput(out), nil
}

// parseDFOutput converts docker system df plain-text into typed rows.
// Handles multi-word types like "Local Volumes" by splitting on ≥2 spaces.
func parseDFOutput(out string) []DiskUsageRow {
	var rows []DiskUsageRow
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if strings.HasPrefix(line, "TYPE") || strings.TrimSpace(line) == "" {
			continue
		}
		parts := splitOnMultiSpace(line)
		if len(parts) < 4 {
			continue
		}
		row := DiskUsageRow{Type: parts[0], Total: parts[1], Active: parts[2], Size: parts[3]}
		if len(parts) > 4 {
			row.Reclaimable = parts[4]
		}
		rows = append(rows, row)
	}
	return rows
}

func splitOnMultiSpace(s string) []string {
	var parts []string
	cur := ""
	spaces := 0
	for _, ch := range s {
		if ch == ' ' {
			spaces++
			if spaces >= 2 {
				if t := strings.TrimSpace(cur); t != "" {
					parts = append(parts, t)
					cur = ""
				}
				spaces = 0
			} else {
				cur += string(ch)
			}
		} else {
			spaces = 0
			cur += string(ch)
		}
	}
	if t := strings.TrimSpace(cur); t != "" {
		parts = append(parts, t)
	}
	return parts
}

// PruneImages removes dangling Docker images (all=false) or all images not
// referenced by any running container (all=true).
func (c *Client) PruneImages(all bool) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	args := []string{"image", "prune", "-f"}
	if all {
		args = append(args, "-a")
	}
	return run(ctx, args...)
}
