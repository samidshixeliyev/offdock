package handlers

import (
	"net/http"

	"offdock/internal/usb"
)

// ListDrives returns all detected USB / removable drives.
func (h *H) ListDrives(w http.ResponseWriter, r *http.Request) {
	drives, err := usb.ScanDrives()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not scan drives: "+err.Error())
		return
	}
	if drives == nil {
		drives = []usb.Drive{}
	}
	writeJSON(w, http.StatusOK, drives)
}

// BrowseDrive lists files at the given path within a known mount point.
// Query params:
//   - mount: security boundary / base directory (e.g. /media/usb0 or /home/ubuntu)
//   - path:  sub-path within mount (defaults to mount)
func (h *H) BrowseDrive(w http.ResponseWriter, r *http.Request) {
	mount := r.URL.Query().Get("mount")
	path := r.URL.Query().Get("path")

	if mount == "" {
		writeError(w, http.StatusBadRequest, "mount query parameter is required")
		return
	}
	if path == "" {
		path = mount
	}

	entries, err := usb.Browse(mount, path)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if entries == nil {
		entries = []usb.FileEntry{}
	}
	writeJSON(w, http.StatusOK, entries)
}
