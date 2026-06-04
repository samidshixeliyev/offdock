package nginx

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

const (
	ExternalNetwork = "offdock-external" // nginx-ui + containers to be proxied
	InternalNetwork = "offdock-internal" // isolated backend containers (DBs, caches)
)

// NetworkContainer is a container attached to a Docker network.
type NetworkContainer struct {
	Name string `json:"name"`
	ID   string `json:"id"`
}

// NetworkInfo describes one of the offdock networks.
type NetworkInfo struct {
	Name       string             `json:"name"`
	Exists     bool               `json:"exists"`
	Containers []NetworkContainer `json:"containers"`
}

// EnsureNetworks creates the offdock-external and offdock-internal networks if absent.
func EnsureNetworks() error {
	for _, name := range []string{ExternalNetwork, InternalNetwork} {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		err := exec.CommandContext(ctx, "docker", "network", "inspect", name).Run()
		cancel()
		if err == nil {
			continue // already exists
		}
		ctx2, cancel2 := context.WithTimeout(context.Background(), 15*time.Second)
		out, err2 := exec.CommandContext(ctx2, "docker", "network", "create", "--driver", "bridge", name).CombinedOutput()
		cancel2()
		if err2 != nil {
			return fmt.Errorf("create network %s: %w — %s", name, err2, strings.TrimSpace(string(out)))
		}
	}
	return nil
}

// GetNetworkInfo returns containers attached to a given network.
func GetNetworkInfo(network string) NetworkInfo {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	out, err := exec.CommandContext(ctx, "docker", "network", "inspect",
		"--format", `{{json .Containers}}`, network).Output()
	if err != nil {
		return NetworkInfo{Name: network, Exists: false, Containers: []NetworkContainer{}}
	}

	// Containers is map[id]{"Name":..., ...}
	var raw map[string]struct {
		Name string `json:"Name"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(out))), &raw); err != nil {
		return NetworkInfo{Name: network, Exists: true, Containers: []NetworkContainer{}}
	}

	containers := make([]NetworkContainer, 0, len(raw))
	for id, c := range raw {
		containers = append(containers, NetworkContainer{Name: c.Name, ID: id[:12]})
	}
	return NetworkInfo{Name: network, Exists: true, Containers: containers}
}

// ConnectContainer connects a container to a network. Idempotent.
func ConnectContainer(network, containerName string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", "network", "connect", network, containerName).CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		// Already connected is not an error.
		if strings.Contains(msg, "already exists") {
			return nil
		}
		return fmt.Errorf("%s", msg)
	}
	return nil
}

// DisconnectContainer disconnects a container from a network.
func DisconnectContainer(network, containerName string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", "network", "disconnect", network, containerName).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s", strings.TrimSpace(string(out)))
	}
	return nil
}

// ContainerNetworks returns the names of all networks a container belongs to.
func ContainerNetworks(containerName string) []string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", "inspect",
		"--format", `{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}`,
		containerName).Output()
	if err != nil {
		return nil
	}
	var nets []string
	for _, n := range strings.Fields(string(out)) {
		nets = append(nets, n)
	}
	return nets
}
