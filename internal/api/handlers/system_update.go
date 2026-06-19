package handlers

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	authmw "offdock/internal/middleware"
)

// SystemUpdateStatus is the response to GET /api/v1/system/update/status.
type SystemUpdateStatus struct {
	CanUpdate      bool   `json:"can_update"`
	CanRollback    bool   `json:"can_rollback"`    // true if a .bak binary exists
	InstallPath    string `json:"install_path"`    // e.g. /usr/local/bin/offdock
	BackupPath     string `json:"backup_path"`     // e.g. /usr/local/bin/offdock.bak
}

// currentBinaryPath returns the absolute, symlink-resolved path of the running
// offdock binary. Falls back to /usr/local/bin/offdock if detection fails.
func currentBinaryPath() string {
	if p, err := os.Executable(); err == nil {
		if resolved, err := filepath.EvalSymlinks(p); err == nil {
			return resolved
		}
		return p
	}
	// Fallback: standard install location used by install.sh
	return "/usr/local/bin/offdock"
}

// GetSystemUpdateStatus returns whether the system supports self-update and rollback.
func (h *H) GetSystemUpdateStatus(w http.ResponseWriter, r *http.Request) {
	installPath := currentBinaryPath()
	bakPath := installPath + ".bak"
	_, bakErr := os.Stat(bakPath)
	writeJSON(w, http.StatusOK, SystemUpdateStatus{
		CanUpdate:   true,
		CanRollback: bakErr == nil,
		InstallPath: installPath,
		BackupPath:  bakPath,
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

	// Extract to temp directory.
	tmpDir, err := os.MkdirTemp("", "offdock-update-*")
	if err != nil {
		send("error", "Cannot create temp dir: "+err.Error())
		return
	}
	defer os.RemoveAll(tmpDir)

	// Source the archive either from a server-side path (?path=… — preferred for
	// large offline bundles already transferred via USB/scp; no browser upload)
	// or from a multipart file upload.
	srcLabel := ""
	if srcPath := strings.TrimSpace(r.URL.Query().Get("path")); srcPath != "" {
		srcLabel = srcPath
		send("info", "Reading archive from server path: "+srcPath)
		if !strings.HasSuffix(strings.ToLower(srcPath), ".tar.gz") && !strings.HasSuffix(strings.ToLower(srcPath), ".tgz") {
			send("error", "path must point to a .tar.gz / .tgz archive")
			return
		}
		f, err := os.Open(srcPath)
		if err != nil {
			send("error", "cannot open archive: "+err.Error())
			return
		}
		defer f.Close()
		if fi, err := f.Stat(); err == nil {
			send("info", fmt.Sprintf("Archive %.1f MB — extracting…", float64(fi.Size())/1e6))
		}
		if err := extractTarGz(f, tmpDir); err != nil {
			send("error", "Extract failed: "+err.Error())
			return
		}
	} else {
		send("info", "Receiving update archive…")
		// Parse multipart form (32 MB in-memory; larger files spill to disk temp files).
		if err := r.ParseMultipartForm(32 << 20); err != nil {
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

		srcLabel = header.Filename
		send("info", fmt.Sprintf("Received %s (%.1f MB) — extracting…", header.Filename, float64(header.Size)/1e6))
		if err := extractTarGz(file, tmpDir); err != nil {
			send("error", "Extract failed: "+err.Error())
			return
		}
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

	// Atomic binary replacement with rollback support.
	// Steps: (1) save old binary as .bak, (2) copy new to .new, (3) rename .new → install.
	// If anything fails after step 1 we can restore from .bak.
	installPath := currentBinaryPath()
	newPath := installPath + ".new"
	bakPath := installPath + ".bak"

	// Step 1: save old binary for rollback.
	if _, statErr := os.Stat(installPath); statErr == nil {
		if cpErr := copyBinary(installPath, bakPath); cpErr != nil {
			send("error", "Cannot back up existing binary: "+cpErr.Error())
			return
		}
		send("info", "Previous binary saved as offdock.bak (rollback available).")
	}

	// Step 2: copy new binary to .new temp path.
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

	// Step 3: atomic rename .new → install path.
	if err := os.Rename(newPath, installPath); err != nil {
		os.Remove(newPath)
		send("error", "Rename failed: "+err.Error())
		return
	}

	// Refresh OpenTelemetry language tracers from the uploaded bundle (if it
	// carries an otel/ directory). This mirrors what install.sh --update does, so
	// updating through the UI keeps the agents in sync with the new binary.
	// Best-effort: any failure is reported but never aborts the update.
	if otelSrc := filepath.Join(tmpDir, "otel"); dirExists(otelSrc) {
		if n, err := refreshOTelAgents(otelSrc, "/var/offdock/otel"); err != nil {
			send("info", "OpenTelemetry agents not refreshed: "+err.Error())
		} else if n > 0 {
			send("info", fmt.Sprintf("OpenTelemetry agents refreshed (%d files).", n))
		}
	}

	send("info", "Binary replaced — scheduling restart…")
	slog.Info("system_update", "install_path", installPath, "file", srcLabel, "user", claims.Username)
	h.logAudit(r, "system_update", "system", "", srcLabel, claims.Username)

	// Schedule the restart in a detached process that survives after systemd
	// kills this offdock process. systemd-run creates a new transient unit in
	// its own cgroup, so it is not killed when the offdock cgroup is torn down
	// during restart. Fall back to setsid if systemd-run is unavailable.
	//
	// Sleep 2s first so the SSE success message has time to reach the browser.
	restartScript := `sleep 2 && systemctl daemon-reload 2>/dev/null; systemctl restart offdock`
	cmd := exec.Command("systemd-run", "--no-block", "--collect", "sh", "-c", restartScript)
	cmd.Stdout = nil
	cmd.Stderr = nil
	cmd.Stdin = nil
	if err := cmd.Start(); err != nil {
		// systemd-run not available — fall back to setsid-detached shell
		cmd2 := exec.Command("sh", "-c", restartScript)
		cmd2.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		cmd2.Stdout = nil
		cmd2.Stderr = nil
		cmd2.Stdin = nil
		if err2 := cmd2.Start(); err2 != nil {
			exec.Command("sh", "-c", //nolint:errcheck
				`(sleep 2; systemctl daemon-reload 2>/dev/null; systemctl restart offdock) &`).Start()
		}
	}

	send("success", "Update complete — service restarting in ~2 seconds. Reconnect shortly.")
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// dirExists reports whether path exists and is a directory.
func dirExists(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && fi.IsDir()
}

// refreshOTelAgents copies the language tracers from an extracted bundle's otel/
// directory into the live /var/offdock/otel tree, so OTel injection at deploy
// time uses the up-to-date agents. Returns the number of files copied. Every
// step is guarded; a missing/partial source never crashes the caller.
func refreshOTelAgents(srcDir, destDir string) (int, error) {
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		return 0, err
	}
	copied := 0
	err := filepath.Walk(srcDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // skip unreadable entries rather than abort
		}
		rel, rerr := filepath.Rel(srcDir, path)
		if rerr != nil || rel == "." {
			return nil
		}
		dest := filepath.Join(destDir, rel)
		if info.IsDir() {
			os.MkdirAll(dest, 0o755) //nolint:errcheck
			return nil
		}
		if !info.Mode().IsRegular() {
			return nil // ignore symlinks/devices from the archive
		}
		in, oerr := os.Open(path)
		if oerr != nil {
			return nil
		}
		defer in.Close()
		os.MkdirAll(filepath.Dir(dest), 0o755) //nolint:errcheck
		out, cerr := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
		if cerr != nil {
			return nil
		}
		if _, werr := io.Copy(out, in); werr == nil {
			copied++
		}
		out.Close()
		return nil
	})
	return copied, err
}

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

// CompactDB rewrites all store files removing tombstones + superseded records.
// Safe to call online. Returns 200 with before/after byte counts.
func (h *H) CompactDB(w http.ResponseWriter, r *http.Request) {
	// Collect sizes before compaction.
	before := dirSize(h.dataDir)

	if err := h.db.Compact(); err != nil {
		writeError(w, http.StatusInternalServerError, "compaction failed: "+err.Error())
		return
	}

	after := dirSize(h.dataDir)
	h.logAudit(r, "compact_db", "system", "", "", "")
	writeJSON(w, http.StatusOK, map[string]any{
		"status":        "ok",
		"bytes_before":  before,
		"bytes_after":   after,
		"bytes_freed":   before - after,
	})
}

func dirSize(path string) int64 {
	var total int64
	filepath.Walk(path, func(_ string, info os.FileInfo, err error) error { //nolint:errcheck
		if err == nil && !info.IsDir() {
			total += info.Size()
		}
		return nil
	})
	return total
}

// copyBinary copies src to dst, preserving file mode (used for update/rollback).
func copyBinary(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode())
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(dst)
		return err
	}
	return out.Close()
}

// SystemRollback restores the previous binary backup and restarts the service.
// Only available to superadmin. Returns SSE progress.
func (h *H) SystemRollback(w http.ResponseWriter, r *http.Request) {
	claims := authmw.ClaimsFromContext(r.Context())
	if claims == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

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

	installPath := currentBinaryPath()
	bakPath := installPath + ".bak"

	if _, err := os.Stat(bakPath); err != nil {
		send("error", "No rollback backup found (offdock.bak does not exist).")
		return
	}

	if err := validateBinary(bakPath); err != nil {
		send("error", "Backup binary is invalid: "+err.Error())
		return
	}

	send("info", "Restoring previous binary…")
	newPath := installPath + ".new"
	if err := copyBinary(bakPath, newPath); err != nil {
		send("error", "Cannot copy backup: "+err.Error())
		return
	}
	if err := os.Rename(newPath, installPath); err != nil {
		os.Remove(newPath)
		send("error", "Rename failed: "+err.Error())
		return
	}

	h.logAudit(r, "system_rollback", "system", "", bakPath, claims.Username)
	send("info", "Binary restored — scheduling restart…")

	restartScript := `sleep 2 && systemctl daemon-reload 2>/dev/null; systemctl restart offdock`
	cmd := exec.Command("systemd-run", "--no-block", "--collect", "sh", "-c", restartScript)
	cmd.Stdout = nil
	cmd.Stderr = nil
	cmd.Stdin = nil
	if err := cmd.Start(); err != nil {
		cmd2 := exec.Command("sh", "-c", restartScript)
		cmd2.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		cmd2.Stdout = nil
		cmd2.Stderr = nil
		cmd2.Stdin = nil
		if err2 := cmd2.Start(); err2 != nil {
			exec.Command("sh", "-c", //nolint:errcheck
				`(sleep 2; systemctl daemon-reload 2>/dev/null; systemctl restart offdock) &`).Start()
		}
	}

	send("success", "Rollback complete — service restarting in ~2 seconds. Reconnect shortly.")
}

// ─── Scheduled updates ───────────────────────────────────────────────────────
//
// A scheduled update runs the exact same binary swap as the immediate
// SystemUpdate above — same validation pipeline, same atomic .bak/.new/rename
// sequence — just deferred to a chosen time. The deferral is handed off to a
// transient systemd timer unit (owned by PID 1), so it fires reliably even if
// the offdock process restarts or crashes between now and then. The uploaded
// binary and a small metadata file are staged under dataDir/pending-update so
// status survives process restarts too; systemd owns only the "when".

const scheduledUpdateUnit = "offdock-scheduled-update"

// ScheduledUpdateMeta persists the details of a pending scheduled update.
type ScheduledUpdateMeta struct {
	RunAt      string `json:"run_at"` // RFC3339 — when the swap will run
	Filename   string `json:"filename"`
	Version    string `json:"version,omitempty"`
	UploadedBy string `json:"uploaded_by"`
	UploadedAt string `json:"uploaded_at"` // RFC3339
}

// ScheduledUpdateInfo is the response to GET /api/v1/system/update/scheduled.
type ScheduledUpdateInfo struct {
	Scheduled  bool   `json:"scheduled"`
	RunAt      string `json:"run_at,omitempty"`
	Filename   string `json:"filename,omitempty"`
	Version    string `json:"version,omitempty"`
	UploadedBy string `json:"uploaded_by,omitempty"`
	UploadedAt string `json:"uploaded_at,omitempty"`
	Active     bool   `json:"active"`                // timer still armed in systemd
	LastResult string `json:"last_result,omitempty"` // "ok" | "error" | "" (none yet)
	LastLog    string `json:"last_log,omitempty"`
}

func (h *H) pendingUpdateDir() string      { return filepath.Join(h.dataDir, "pending-update") }
func (h *H) pendingUpdateMetaPath() string { return filepath.Join(h.pendingUpdateDir(), "meta.json") }
func (h *H) lastScheduledUpdateLogPath() string {
	return filepath.Join(h.dataDir, "last-scheduled-update.log")
}

// cancelScheduledUpdateUnit stops and fully removes the transient timer if one
// is armed. Safe to call when nothing is scheduled — systemctl just reports
// the unit as not found and we ignore the error.
func cancelScheduledUpdateUnit() {
	exec.Command("systemctl", "stop", scheduledUpdateUnit+".timer").Run() //nolint:errcheck
}

// scheduledUpdateUnitActive reports whether the transient timer is still armed
// (i.e. the scheduled update hasn't fired or been cancelled yet). Transient
// units are garbage-collected by systemd once they finish, so "not found"
// after a scheduled time has passed simply means it already ran.
func scheduledUpdateUnitActive() bool {
	out, err := exec.Command("systemctl", "show", scheduledUpdateUnit+".timer", "--property=ActiveState", "--value").Output()
	if err != nil {
		return false
	}
	return strings.TrimSpace(string(out)) == "active"
}

// buildScheduledApplyScript renders the POSIX sh script the timer will run
// when it fires. It mirrors the atomic .bak/.new/rename swap used by the
// immediate SystemUpdate, then restarts the service. All paths are baked in
// at scheduling time (from the currently-running process), so the swap
// targets the right binary regardless of what else changes before it fires.
//
// It also writes a short result log — by the time this runs, the SSE stream
// from the original request is long gone, so this is the only way the admin
// can later see whether the scheduled install actually succeeded.
func buildScheduledApplyScript(installPath, stagedBinary, pendingDir, logPath string) string {
	bakPath := installPath + ".bak"
	newPath := installPath + ".new"
	return fmt.Sprintf(`#!/bin/sh
INSTALL_PATH="%s"
STAGED="%s"
BAK="%s"
NEW="%s"
PENDING_DIR="%s"
LOGFILE="%s"

apply() {
  echo "=== OffDock scheduled update - $(date -u '+%%Y-%%m-%%dT%%H:%%M:%%SZ') ==="
  if [ -f "$INSTALL_PATH" ]; then
    cp -f "$INSTALL_PATH" "$BAK" || { echo "ERROR: backup failed"; return 1; }
    echo "backed up current binary to $BAK"
  fi
  cp -f "$STAGED" "$NEW" || { echo "ERROR: staging copy failed"; return 1; }
  chmod 0755 "$NEW"
  mv -f "$NEW" "$INSTALL_PATH" || { echo "ERROR: swap failed"; return 1; }
  echo "binary replaced at $INSTALL_PATH"
}

if apply > "$LOGFILE" 2>&1; then
  echo "RESULT=ok" >> "$LOGFILE"
else
  echo "RESULT=error" >> "$LOGFILE"
fi

rm -rf "$PENDING_DIR"
systemctl daemon-reload 2>/dev/null
systemctl restart offdock
`, installPath, stagedBinary, bakPath, newPath, pendingDir, logPath)
}

// ScheduleSystemUpdate accepts a tar.gz upload plus a "run_at" RFC3339
// timestamp, runs it through the exact same extract/find/validate pipeline as
// the immediate SystemUpdate, stages the binary persistently, and arms a
// transient systemd timer to perform the swap + restart at that time. Only
// one scheduled update can be pending at a time — uploading a new one cancels
// and replaces any existing one. Streams progress via SSE.
func (h *H) ScheduleSystemUpdate(w http.ResponseWriter, r *http.Request) {
	claims := authmw.ClaimsFromContext(r.Context())
	if claims == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

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

	if err := r.ParseMultipartForm(32 << 20); err != nil {
		send("error", "Failed to parse upload: "+err.Error())
		return
	}

	runAtStr := strings.TrimSpace(r.FormValue("run_at"))
	if runAtStr == "" {
		send("error", "Missing run_at (scheduled time)")
		return
	}
	runAt, err := time.Parse(time.RFC3339, runAtStr)
	if err != nil {
		send("error", "Invalid run_at — expected an RFC3339 timestamp: "+err.Error())
		return
	}
	if runAt.Before(time.Now().Add(2 * time.Minute)) {
		send("error", "Scheduled time must be at least 2 minutes from now (uploading and staging takes a moment).")
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

	binaryPath, err := findBinary(tmpDir, "offdock")
	if err != nil {
		send("error", "offdock binary not found in archive: "+err.Error())
		return
	}

	versionInfo := ""
	if vdata, err := os.ReadFile(filepath.Join(tmpDir, "VERSION")); err == nil {
		versionInfo = strings.TrimSpace(string(vdata))
	}
	if versionInfo != "" {
		send("info", fmt.Sprintf("Found binary (version: %s) — validating…", versionInfo))
	} else {
		send("info", "Found binary — validating…")
	}

	if err := validateBinary(binaryPath); err != nil {
		send("error", "Invalid binary: "+err.Error())
		return
	}

	send("info", "Binary validated — staging for scheduled install…")

	// Replace any previously-scheduled update: cancel its timer and clear
	// its staged files before laying down the new ones.
	cancelScheduledUpdateUnit()
	pendingDir := h.pendingUpdateDir()
	os.RemoveAll(pendingDir)
	if err := os.MkdirAll(pendingDir, 0o755); err != nil {
		send("error", "Cannot create staging directory: "+err.Error())
		return
	}

	stagedBinary := filepath.Join(pendingDir, "offdock.new")
	if err := copyBinary(binaryPath, stagedBinary); err != nil {
		os.RemoveAll(pendingDir)
		send("error", "Cannot stage binary: "+err.Error())
		return
	}
	os.Chmod(stagedBinary, 0o755) //nolint:errcheck

	meta := ScheduledUpdateMeta{
		RunAt:      runAt.UTC().Format(time.RFC3339),
		Filename:   header.Filename,
		Version:    versionInfo,
		UploadedBy: claims.Username,
		UploadedAt: time.Now().UTC().Format(time.RFC3339),
	}
	metaBytes, _ := json.MarshalIndent(meta, "", "  ")
	if err := os.WriteFile(h.pendingUpdateMetaPath(), metaBytes, 0o644); err != nil {
		os.RemoveAll(pendingDir)
		send("error", "Cannot write metadata: "+err.Error())
		return
	}

	installPath := currentBinaryPath()
	scriptPath := filepath.Join(pendingDir, "apply.sh")
	script := buildScheduledApplyScript(installPath, stagedBinary, pendingDir, h.lastScheduledUpdateLogPath())
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		os.RemoveAll(pendingDir)
		send("error", "Cannot write apply script: "+err.Error())
		return
	}

	// systemd calendar specs use a space-separated "YYYY-MM-DD HH:MM:SS TZ"
	// form (no numeric UTC offsets) — normalise to UTC so it's unambiguous.
	calSpec := runAt.UTC().Format("2006-01-02 15:04:05") + " UTC"
	cmd := exec.Command("systemd-run",
		"--on-calendar="+calSpec,
		"--unit="+scheduledUpdateUnit,
		"--description=OffDock scheduled self-update",
		"/bin/sh", scriptPath,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		os.RemoveAll(pendingDir)
		send("error", fmt.Sprintf("Failed to schedule job: %s — %s", err.Error(), strings.TrimSpace(string(out))))
		return
	}

	when := runAt.UTC().Format("Jan 2, 2006 15:04 UTC")
	slog.Info("system_update_scheduled", "install_path", installPath, "file", header.Filename, "run_at", meta.RunAt, "user", claims.Username)
	h.logAudit(r, "system_update_scheduled", "system", "", fmt.Sprintf("%s @ %s", header.Filename, meta.RunAt), claims.Username)

	send("success", fmt.Sprintf("Scheduled — OffDock will install this update automatically on %s and restart.", when))
}

// GetScheduledUpdate reports the currently pending scheduled update (if any)
// plus the result of the most recently completed one, read from the staged
// metadata and result log respectively — both of which survive process
// restarts since systemd (not offdock) owns the actual timing.
func (h *H) GetScheduledUpdate(w http.ResponseWriter, r *http.Request) {
	info := ScheduledUpdateInfo{}

	if data, err := os.ReadFile(h.pendingUpdateMetaPath()); err == nil {
		var meta ScheduledUpdateMeta
		if err := json.Unmarshal(data, &meta); err == nil {
			info.Scheduled = true
			info.RunAt = meta.RunAt
			info.Filename = meta.Filename
			info.Version = meta.Version
			info.UploadedBy = meta.UploadedBy
			info.UploadedAt = meta.UploadedAt
			info.Active = scheduledUpdateUnitActive()
		}
	}

	if data, err := os.ReadFile(h.lastScheduledUpdateLogPath()); err == nil {
		log := string(data)
		info.LastLog = log
		switch {
		case strings.Contains(log, "RESULT=ok"):
			info.LastResult = "ok"
		case strings.Contains(log, "RESULT=error"):
			info.LastResult = "error"
		}
	}

	writeJSON(w, http.StatusOK, info)
}

// CancelScheduledUpdate stops the pending update's timer (if armed) and clears
// its staged files. Returns 200 even if nothing was scheduled, so the UI can
// call it idempotently.
func (h *H) CancelScheduledUpdate(w http.ResponseWriter, r *http.Request) {
	claims := authmw.ClaimsFromContext(r.Context())
	if claims == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	_, hadPending := os.Stat(h.pendingUpdateMetaPath())
	cancelScheduledUpdateUnit()
	os.RemoveAll(h.pendingUpdateDir())

	if hadPending == nil {
		h.logAudit(r, "system_update_schedule_cancelled", "system", "", "", claims.Username)
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "cancelled"})
}
