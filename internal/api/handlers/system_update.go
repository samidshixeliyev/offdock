package handlers

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	authmw "offdock/internal/middleware"
)

// SystemUpdateStatus is the response to GET /api/v1/system/update/status.
type SystemUpdateStatus struct {
	CanUpdate   bool   `json:"can_update"`
	InstallPath string `json:"install_path"` // e.g. /usr/local/bin/offdock
	ScriptPath  string `json:"script_path"`  // install.sh path if found
}

// GetSystemUpdateStatus returns whether the system supports self-update.
func (h *H) GetSystemUpdateStatus(w http.ResponseWriter, r *http.Request) {
	installPath, _ := exec.LookPath("offdock")
	if installPath == "" {
		installPath = "/usr/local/bin/offdock"
	}
	writeJSON(w, http.StatusOK, SystemUpdateStatus{
		CanUpdate:   true,
		InstallPath: installPath,
	})
}

// SystemUpdate handles a tar.gz upload containing an OffDock bundle.
// It extracts the archive to a temp directory, validates it contains the
// offdock binary, then performs an atomic binary replacement + service restart.
// Streams progress via SSE.
func (h *H) SystemUpdate(w http.ResponseWriter, r *http.Request) {
	claims := authmw.ClaimsFromContext(r.Context())
	if claims == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	// Set up SSE for progress streaming.
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	send := func(status, msg string) {
		b, _ := json.Marshal(map[string]string{"status": status, "message": msg})
		fmt.Fprintf(w, "data: %s\n\n", b)
		flusher.Flush()
	}

	send("info", "Receiving update archive…")

	// Parse multipart form (max 500 MB).
	if err := r.ParseMultipartForm(500 << 20); err != nil {
		send("error", "Failed to parse upload: "+err.Error())
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		send("error", "No file in request: "+err.Error())
		return
	}
	defer file.Close()

	if !strings.HasSuffix(strings.ToLower(header.Filename), ".tar.gz") &&
		!strings.HasSuffix(strings.ToLower(header.Filename), ".tgz") {
		send("error", "File must be a .tar.gz archive")
		return
	}

	send("info", fmt.Sprintf("Received %s (%.1f MB) — extracting…", header.Filename, float64(header.Size)/1e6))

	// Extract to temp directory.
	tmpDir, err := os.MkdirTemp("", "offdock-update-*")
	if err != nil {
		send("error", "Cannot create temp dir: "+err.Error())
		return
	}
	defer os.RemoveAll(tmpDir)

	if err := extractTarGz(file, tmpDir); err != nil {
		send("error", "Extract failed: "+err.Error())
		return
	}

	// Find the offdock binary in the extracted tree.
	binaryPath, err := findBinary(tmpDir, "offdock")
	if err != nil {
		send("error", "offdock binary not found in archive: "+err.Error())
		return
	}

	// Read VERSION file if present.
	versionInfo := ""
	if vdata, err := os.ReadFile(filepath.Join(tmpDir, "VERSION")); err == nil {
		versionInfo = " (version: " + strings.TrimSpace(string(vdata)) + ")"
	}
	send("info", fmt.Sprintf("Found binary%s — validating…", versionInfo))

	// Sanity check: must be an ELF executable.
	if err := validateBinary(binaryPath); err != nil {
		send("error", "Invalid binary: "+err.Error())
		return
	}

	send("info", "Binary validated — performing atomic replacement…")

	// Atomic binary replacement: copy to .new then rename.
	installPath := "/usr/local/bin/offdock"
	newPath := installPath + ".new"

	input, err := os.Open(binaryPath)
	if err != nil {
		send("error", "Cannot open binary: "+err.Error())
		return
	}
	defer input.Close()

	output, err := os.OpenFile(newPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		send("error", "Cannot write new binary: "+err.Error())
		return
	}
	if _, err := io.Copy(output, input); err != nil {
		output.Close()
		os.Remove(newPath)
		send("error", "Copy failed: "+err.Error())
		return
	}
	output.Close()

	if err := os.Rename(newPath, installPath); err != nil {
		os.Remove(newPath)
		send("error", "Rename failed: "+err.Error())
		return
	}

	send("info", "Binary replaced — scheduling restart…")
	h.logAudit(r, "system_update", "system", "", header.Filename, claims.Username)

	// Schedule the restart in a fully detached child process so the restart
	// survives after systemd kills this offdock process. We use a shell
	// one-liner with `setsid` (new session, no controlling terminal) and
	// `nohup` to ensure the child is not killed when the parent process group
	// is terminated by systemd during restart.
	//
	// Sleep 2s first so the SSE success message has time to reach the browser.
	restartScript := `sleep 2 && systemctl daemon-reload 2>/dev/null; systemctl restart offdock`
	cmd := exec.Command("setsid", "sh", "-c", restartScript)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setsid: true, // detach from current process group
	}
	cmd.Stdout = nil
	cmd.Stderr = nil
	cmd.Stdin = nil
	if err := cmd.Start(); err != nil {
		// Fallback: use at(1) if available, or a background subshell
		fallback := exec.Command("sh", "-c",
			`(sleep 2; systemctl daemon-reload 2>/dev/null; systemctl restart offdock) &`)
		fallback.Start() //nolint:errcheck
	}

	send("success", "Update complete — service restarting in ~2 seconds. Reconnect shortly.")
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

func extractTarGz(r io.Reader, destDir string) error {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return fmt.Errorf("gzip: %w", err)
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("tar: %w", err)
		}

		// Security: reject absolute paths, path traversal, and symlinks.
		if hdr.Typeflag == tar.TypeSymlink || hdr.Typeflag == tar.TypeLink {
			continue // never follow symlinks from untrusted archives
		}
		if filepath.IsAbs(hdr.Name) {
			continue
		}
		name := filepath.Clean(hdr.Name)
		if strings.HasPrefix(name, "..") || strings.Contains(name, "../") {
			continue
		}
		// Strip any single top-level directory (works regardless of bundle name,
		// e.g. "offdock-bundle/", "offdock-offline-20260604/", "dist/", etc.).
		parts := strings.SplitN(name, "/", 2)
		if len(parts) == 2 && parts[1] != "" {
			name = parts[1]
		} else if len(parts) == 1 {
			// Top-level directory entry — skip it.
			continue
		}
		if name == "" || name == "." {
			continue
		}
		// Final safety check: resolved path must stay within destDir.
		dest := filepath.Join(destDir, name)
		if !strings.HasPrefix(dest, destDir+string(filepath.Separator)) {
			continue
		}

		switch hdr.Typeflag {
		case tar.TypeDir:
			os.MkdirAll(dest, 0o755) //nolint:errcheck
		case tar.TypeReg:
			os.MkdirAll(filepath.Dir(dest), 0o755) //nolint:errcheck
			f, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, os.FileMode(hdr.Mode)|0o600)
			if err != nil {
				continue
			}
			io.Copy(f, tr) //nolint:errcheck
			f.Close()
		}
	}
	return nil
}

func findBinary(dir, name string) (string, error) {
	var found string
	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		if info.Name() == name && (info.Mode()&0o111) != 0 {
			found = path
			return filepath.SkipAll
		}
		return nil
	})
	if err != nil && err != filepath.SkipAll {
		return "", err
	}
	if found == "" {
		return "", fmt.Errorf("no executable named %q found", name)
	}
	return found, nil
}

func validateBinary(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	// Check ELF magic bytes: 0x7f 'E' 'L' 'F'
	magic := make([]byte, 4)
	if _, err := f.Read(magic); err != nil {
		return fmt.Errorf("cannot read binary: %w", err)
	}
	if magic[0] != 0x7f || magic[1] != 'E' || magic[2] != 'L' || magic[3] != 'F' {
		return fmt.Errorf("not an ELF binary (wrong magic bytes)")
	}
	return nil
}
