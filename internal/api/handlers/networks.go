package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	nginxpkg "offdock/internal/nginx"
)

// ListNetworks returns the state of both offdock Docker networks.
func (h *H) ListNetworks(w http.ResponseWriter, r *http.Request) {
	external := nginxpkg.GetNetworkInfo(nginxpkg.ExternalNetwork)
	internal := nginxpkg.GetNetworkInfo(nginxpkg.InternalNetwork)
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"external": external,
		"internal": internal,
	})
}

// NetworkConnect connects a container to a network (external or internal).
func (h *H) NetworkConnect(w http.ResponseWriter, r *http.Request) {
	network := chi.URLParam(r, "network")
	container := chi.URLParam(r, "container")
	if network != nginxpkg.ExternalNetwork && network != nginxpkg.InternalNetwork {
		writeError(w, http.StatusBadRequest, "network must be offdock-external or offdock-internal")
		return
	}
	if err := nginxpkg.ConnectContainer(network, container); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "connected"})
}

// NetworkDisconnect disconnects a container from a network.
func (h *H) NetworkDisconnect(w http.ResponseWriter, r *http.Request) {
	network := chi.URLParam(r, "network")
	container := chi.URLParam(r, "container")
	if network != nginxpkg.ExternalNetwork && network != nginxpkg.InternalNetwork {
		writeError(w, http.StatusBadRequest, "network must be offdock-external or offdock-internal")
		return
	}
	if err := nginxpkg.DisconnectContainer(network, container); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "disconnected"})
}

// ContainerNetworks returns which offdock networks a container belongs to.
func (h *H) ContainerNetworks(w http.ResponseWriter, r *http.Request) {
	container := chi.URLParam(r, "container")
	nets := nginxpkg.ContainerNetworks(container)
	if nets == nil {
		nets = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"networks": nets})
}
