package handlers

import (
	"archive/zip"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// DownloadBackup streams a ZIP archive of all OffDock .db files.
// GET /api/v1/system/backup
func (h *H) DownloadBackup(w http.ResponseWriter, r *http.Request) {
	dataDir := h.dataDir
	if dataDir == "" {
		writeError(w, http.StatusInternalServerError, "data dir not configured")
		return
	}

	filename := fmt.Sprintf("offdock-backup-%s.zip", time.Now().UTC().Format("20060102-150405"))
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	w.WriteHeader(http.StatusOK)

	zw := zip.NewWriter(w)
	defer zw.Close()

	filepath.WalkDir(dataDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if !strings.HasSuffix(path, ".db") {
			return nil
		}
		rel, err := filepath.Rel(dataDir, path)
		if err != nil {
			return nil
		}
		f, err := os.Open(path)
		if err != nil {
			return nil
		}
		defer f.Close()
		zf, err := zw.Create(rel)
		if err != nil {
			return nil
		}
		io.Copy(zf, f) //nolint:errcheck
		return nil
	})

	h.logAudit(r, "backup_download", "system", "", "", "")
}
