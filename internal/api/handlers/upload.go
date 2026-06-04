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

// UploadFile streams a multipart file upload directly to /var/offdock/uploads/.
// Accepts any file type — no extension restriction.
// Uses r.MultipartReader() instead of ParseMultipartForm so a 5 GB file
// results in exactly 5 GB of disk I/O (direct stream), not 10 GB (temp + copy).
func (h *H) UploadFile(w http.ResponseWriter, r *http.Request) {
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
		if part.FileName() == "" {
			continue
		}

		name := filepath.Base(part.FileName())
		destPath := filepath.Join(uploadDir, name)

		tmpPath := destPath + ".tmp"
		out, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "create file: "+err.Error())
			return
		}

		written, copyErr := io.Copy(out, part)
		syncErr := out.Sync()
		out.Close()

		if copyErr != nil {
			os.Remove(tmpPath)
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
		return
	}

	writeError(w, http.StatusBadRequest, "no file found in request")
}
