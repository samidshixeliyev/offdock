package handlers

import (
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
)

// storageRoot describes one browsable OffDock storage location.
type storageRoot struct {
	Key    string `json:"key"`
	Label  string `json:"label"`
	Path   string `json:"path"`
	Desc   string `json:"desc"`
	Size   int64  `json:"size"`
	Files  int    `json:"files"`
	Exists bool   `json:"exists"`
}

// dirSize returns the total bytes and file count under a directory (recursive),
// and whether the path exists.
func dirUsage(root string) (int64, int, bool) {
	info, err := os.Stat(root)
	if err != nil {
		return 0, 0, false
	}
	if !info.IsDir() {
		return info.Size(), 1, true
	}
	var total int64
	var count int
	_ = filepath.WalkDir(root, func(_ string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if fi, e := d.Info(); e == nil {
			total += fi.Size()
			count++
		}
		return nil
	})
	return total, count, true
}

// StorageOverview returns OffDock's storage roots with recursive sizes so the
// Storage explorer can show a usage summary and quick-access entries.
func (h *H) StorageOverview(w http.ResponseWriter, r *http.Request) {
	base := filepath.Dir(h.dataDir) // /var/offdock
	defs := []struct{ key, label, path, desc string }{
		{"backups", "Backups", filepath.Join(base, "backups"), "Backup archives (.tar.gz)"},
		{"data", "Database", h.dataDir, "Append-log collection files (*.db)"},
		{"projects", "Projects", h.projectsDir, "Per-project compose + .env files"},
		{"images", "Image tars", filepath.Join(base, "uploads"), "Uploaded Docker image .tar files"},
		{"certs", "Certificates", filepath.Join(base, "certs"), "TLS PEM bundles"},
		{"otel", "OTel tracers", filepath.Join(base, "otel"), "Language tracers injected into containers"},
		{"logs", "Logs", h.logDir, "OffDock application logs"},
		{"config", "Config", "/etc/offdock", "config.yaml (secrets masked on read)"},
	}
	roots := make([]storageRoot, 0, len(defs))
	for _, d := range defs {
		size, files, exists := dirUsage(d.path)
		roots = append(roots, storageRoot{
			Key: d.key, Label: d.label, Path: d.path, Desc: d.desc,
			Size: size, Files: files, Exists: exists,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"roots": roots})
}
