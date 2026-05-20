package handlers

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// maxUploadBytes is the hard ceiling enforced before any disk I/O starts.
const maxUploadBytes = 5 << 30 // 5 GB

// allowedUploadExt lists file types the upload endpoint accepts.
var allowedUploadExt = map[string]bool{
	".tar":  true,
	".yml":  true,
	".yaml": true,
	".env":  true,
	".crt":  true,
	".key":  true,
	".pem":  true,
}

// UploadFile streams a multipart file upload directly to /var/offdock/uploads/
// without buffering the body in a temp file first.
//
// Uses r.MultipartReader() instead of ParseMultipartForm so a 5 GB .tar
// results in exactly 5 GB of disk I/O (direct stream to destination),
// not 10 GB (temp file + copy).
func (h *H) UploadFile(w http.ResponseWriter, r *http.Request) {
	// Enforce size limit before reading anything.
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)

	mr, err := r.MultipartReader()
	if err != nil {
		writeError(w, http.StatusBadRequest, "expected multipart/form-data: "+err.Error())
		return
	}

	uploadDir := "/var/offdock/uploads"
	if err := os.MkdirAll(uploadDir, 0o700); err != nil {
		writeError(w, http.StatusInternalServerError, "create upload dir: "+err.Error())
		return
	}

	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			writeError(w, http.StatusBadRequest, "read multipart: "+err.Error())
			return
		}

		// Skip non-file fields.
		if part.FileName() == "" {
			continue
		}

		name := filepath.Base(part.FileName())
		ext := strings.ToLower(filepath.Ext(name))
		if !allowedUploadExt[ext] {
			writeError(w, http.StatusBadRequest, "unsupported file type: "+ext)
			return
		}

		destPath := filepath.Join(uploadDir, name)

		// Write-then-rename: stream to .tmp, sync, rename atomically.
		tmpPath := destPath + ".tmp"
		out, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "create file: "+err.Error())
			return
		}

		written, copyErr := io.Copy(out, part) // streams chunk-by-chunk, never fully in RAM
		syncErr := out.Sync()
		out.Close()

		if copyErr != nil {
			os.Remove(tmpPath)
			// MaxBytesReader wraps the error when the limit is exceeded.
			if strings.Contains(copyErr.Error(), "request body too large") {
				writeError(w, http.StatusRequestEntityTooLarge,
					fmt.Sprintf("file exceeds %d GB limit", maxUploadBytes>>30))
				return
			}
			writeError(w, http.StatusInternalServerError, "write file: "+copyErr.Error())
			return
		}
		if syncErr != nil {
			os.Remove(tmpPath)
			writeError(w, http.StatusInternalServerError, "sync file: "+syncErr.Error())
			return
		}

		if err := os.Rename(tmpPath, destPath); err != nil {
			os.Remove(tmpPath)
			writeError(w, http.StatusInternalServerError, "finalize file: "+err.Error())
			return
		}

		writeJSON(w, http.StatusCreated, map[string]any{
			"path": destPath,
			"name": name,
			"size": written,
		})
		return // one file per request
	}

	writeError(w, http.StatusBadRequest, "no file found in request")
}
