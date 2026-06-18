package handlers

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// GetAppLogs returns recent OffDock application log lines.
// Source priority: journalctl (systemd) → log file.
// Query params: n=<lines> (default 500, max 5000).
func (h *H) GetAppLogs(w http.ResponseWriter, r *http.Request) {
	n := 500
	if v := r.URL.Query().Get("n"); v != "" {
		if parsed, err := strconv.Atoi(v); err == nil && parsed > 0 && parsed <= 5000 {
			n = parsed
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Try journalctl first (production systemd service).
	out, err := exec.CommandContext(ctx, "journalctl",
		"-u", "offdock",
		fmt.Sprintf("-n%d", n),
		"--no-pager",
		"--output=short-iso",
	).Output()
	if err == nil {
		lines := splitLines(string(out))
		writeJSON(w, http.StatusOK, map[string]any{
			"source": "journald",
			"lines":  lines,
		})
		return
	}

	// Fall back to reading the log file if it exists.
	logPath := "/var/offdock/logs/offdock.log"
	fileCtx, fileCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer fileCancel()

	tailOut, tailErr := exec.CommandContext(fileCtx, "tail", "-n", strconv.Itoa(n), logPath).Output()
	if tailErr == nil {
		lines := splitLines(string(tailOut))
		writeJSON(w, http.StatusOK, map[string]any{
			"source": "file",
			"lines":  lines,
		})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"source": "unavailable",
		"lines":  []string{"Log source unavailable. Run: journalctl -u offdock -f"},
	})
}

// StreamAppLogs streams new OffDock application log lines via SSE.
// Uses journalctl -f for live following.
func (h *H) StreamAppLogs(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	cmd := exec.CommandContext(ctx,
		"journalctl", "-u", "offdock", "-f", "--no-pager", "--output=short-iso",
	)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		b, _ := json.Marshal(map[string]string{"line": "journalctl unavailable: " + err.Error()})
		fmt.Fprintf(w, "data: %s\n\n", b)
		flusher.Flush()
		return
	}
	if err := cmd.Start(); err != nil {
		b, _ := json.Marshal(map[string]string{"line": "journalctl start failed: " + err.Error()})
		fmt.Fprintf(w, "data: %s\n\n", b)
		flusher.Flush()
		return
	}
	defer func() {
		cancel()
		cmd.Process.Kill() //nolint:errcheck
		cmd.Wait()         //nolint:errcheck
	}()

	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()

	lines := make(chan string, 256)
	go func() {
		sc := bufio.NewScanner(stdout)
		for sc.Scan() {
			select {
			case lines <- sc.Text():
			case <-ctx.Done():
				return
			}
		}
		close(lines)
	}()

	done := r.Context().Done()
	for {
		select {
		case <-done:
			return
		case <-heartbeat.C:
			fmt.Fprintf(w, ": ping\n\n")
			flusher.Flush()
		case line, ok := <-lines:
			if !ok {
				return
			}
			// Use json.Marshal for correct escaping of all control characters,
			// backslashes, quotes, etc. that appear in log lines.
			b, err := json.Marshal(map[string]string{"line": line})
			if err != nil {
				continue
			}
			fmt.Fprintf(w, "data: %s\n\n", b)
			flusher.Flush()
		}
	}
}

// ClearAppLogs truncates the OffDock log file to zero bytes.
// Superadmin only (enforced by router middleware).
func (h *H) ClearAppLogs(w http.ResponseWriter, r *http.Request) {
	logPath := filepath.Join(h.logDir, "offdock.log")
	if err := os.Truncate(logPath, 0); err != nil && !os.IsNotExist(err) {
		writeError(w, http.StatusInternalServerError, "clear log: "+err.Error())
		return
	}
	h.logAudit(r, "clear_app_logs", "system", "", "", "")
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}

// truncateLogFile keeps the last maxLines lines of the named file.
// If maxLines == 0 the file is cleared entirely.
// Called during scheduled retention pruning.
func truncateLogFile(path string, maxLines int) {
	if maxLines == 0 {
		_ = os.Truncate(path, 0)
		return
	}
	data, err := os.ReadFile(path)
	if err != nil || len(data) == 0 {
		return
	}
	raw := strings.TrimRight(string(data), "\n")
	lines := strings.Split(raw, "\n")
	if len(lines) <= maxLines {
		return
	}
	kept := strings.Join(lines[len(lines)-maxLines:], "\n") + "\n"
	_ = os.WriteFile(path, []byte(kept), 0o600)
}

func splitLines(s string) []string {
	s = strings.TrimSpace(s)
	if s == "" {
		return []string{}
	}
	return strings.Split(s, "\n")
}
