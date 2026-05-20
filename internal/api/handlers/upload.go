package handlers

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

const maxUploadSize = 4 << 30 // 4 GB

// UploadFile accepts a multipart file upload and saves it to a configured
// directory on the server, making it available for docker load or compose import.
func (h *H) UploadFile(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		writeError(w, http.StatusBadRequest, "parse form: "+err.Error())
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "file field is required")
		return
	}
	defer file.Close()

	if header.Size > maxUploadSize {
		writeError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("file too large (max %d GB)", maxUploadSize>>30))
		return
	}

	// Validate extension.
	name := filepath.Base(header.Filename)
	ext := strings.ToLower(filepath.Ext(name))
	allowed := map[string]bool{".tar": true, ".yml": true, ".yaml": true, ".env": true, ".pem": true, ".crt": true, ".key": true}
	if !allowed[ext] {
		writeError(w, http.StatusBadRequest, "unsupported file type: "+ext)
		return
	}

	// Save to /var/offdock/uploads/ (create if needed).
	uploadDir := "/var/offdock/uploads"
	if err := os.MkdirAll(uploadDir, 0o700); err != nil {
		writeError(w, http.StatusInternalServerError, "create upload dir: "+err.Error())
		return
	}

	destPath := filepath.Join(uploadDir, name)
	out, err := os.OpenFile(destPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "create file: "+err.Error())
		return
	}
	defer out.Close()

	written, err := io.Copy(out, file)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "write file: "+err.Error())
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"path":     destPath,
		"name":     name,
		"size":     written,
	})
}
