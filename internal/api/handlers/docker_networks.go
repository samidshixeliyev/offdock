package handlers

import (
	"net"
	"net/http"

	"github.com/go-chi/chi/v5"

	"offdock/internal/docker"
)

// ListAllDockerNetworks returns all Docker networks with attached containers.
func (h *H) ListAllDockerNetworks(w http.ResponseWriter, r *http.Request) {
	nets, err := h.docker.ListNetworks(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, nets)
}

// CreateDockerNetwork creates a new Docker network.
func (h *H) CreateDockerNetwork(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name       string `json:"name"`
		Driver     string `json:"driver"`
		Subnet     string `json:"subnet"`
		Gateway    string `json:"gateway"`
		IPRange    string `json:"ip_range"`
		Internal   bool   `json:"internal"`
		Attachable bool   `json:"attachable"`
	}
	if err := decodeJSON(r, &req); err != nil || req.Name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	if req.Driver == "" {
		req.Driver = "bridge"
	}
	// Validate CIDR / IP inputs before handing them to docker.
	if req.Subnet != "" {
		if _, _, err := net.ParseCIDR(req.Subnet); err != nil {
			writeError(w, http.StatusBadRequest, "invalid subnet (expected CIDR like 172.28.0.0/16)")
			return
		}
	}
	if req.IPRange != "" {
		if _, _, err := net.ParseCIDR(req.IPRange); err != nil {
			writeError(w, http.StatusBadRequest, "invalid ip_range (expected CIDR)")
			return
		}
	}
	if req.Gateway != "" && net.ParseIP(req.Gateway) == nil {
		writeError(w, http.StatusBadRequest, "invalid gateway IP")
		return
	}
	if err := h.docker.CreateNetworkOpts(r.Context(), docker.NetworkCreateOpts{
		Name:       req.Name,
		Driver:     req.Driver,
		Subnet:     req.Subnet,
		Gateway:    req.Gateway,
		IPRange:    req.IPRange,
		Internal:   req.Internal,
		Attachable: req.Attachable,
	}); err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	// Return fresh state.
	nets, _ := h.docker.ListNetworks(r.Context())
	for _, n := range nets {
		if n.Name == req.Name {
			writeJSON(w, http.StatusCreated, n)
			return
		}
	}
	writeJSON(w, http.StatusCreated, map[string]string{"name": req.Name, "driver": req.Driver})
}

// DeleteDockerNetwork removes a Docker network by name.
func (h *H) DeleteDockerNetwork(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	// Protect OffDock-managed and system networks.
	protected := map[string]bool{"bridge": true, "host": true, "none": true}
	if protected[name] {
		writeError(w, http.StatusForbidden, "cannot delete system network "+name)
		return
	}
	if err := h.docker.DeleteNetwork(r.Context(), name); err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// DockerNetworkConnect connects a container to any Docker network.
func (h *H) DockerNetworkConnect(w http.ResponseWriter, r *http.Request) {
	network := chi.URLParam(r, "name")
	var req struct {
		Container string `json:"container"`
	}
	if err := decodeJSON(r, &req); err != nil || req.Container == "" {
		writeError(w, http.StatusBadRequest, "container is required")
		return
	}
	if err := h.docker.NetworkConnect(r.Context(), network, req.Container); err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "connected"})
}

// DockerNetworkDisconnect disconnects a container from any Docker network.
func (h *H) DockerNetworkDisconnect(w http.ResponseWriter, r *http.Request) {
	network := chi.URLParam(r, "name")
	var req struct {
		Container string `json:"container"`
	}
	if err := decodeJSON(r, &req); err != nil || req.Container == "" {
		writeError(w, http.StatusBadRequest, "container is required")
		return
	}
	if err := h.docker.NetworkDisconnect(r.Context(), network, req.Container); err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "disconnected"})
}
