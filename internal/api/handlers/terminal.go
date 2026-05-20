package handlers

import (
	"bytes"
	"context"
	"net/http"
	"os/exec"
	"strings"
	"time"
)

// ExecCommand runs a shell command on the host and returns stdout/stderr/exit_code/cwd.
// Only admin+ roles may call this (enforced in the router).
//
// Commands run via bash -c so pipes, redirects, and multi-command chains work.
// cwd is tracked by wrapping the command: run it, then echo the new pwd.
func (h *H) ExecCommand(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Command string `json:"command"`
		Cwd     string `json:"cwd"` // optional: carry working directory across calls
	}
	if err := decodeJSON(r, &req); err != nil || strings.TrimSpace(req.Command) == "" {
		writeError(w, http.StatusBadRequest, "command is required")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()

	// cd into the client's cwd before running the command, then print new pwd.
	startDir := req.Cwd
	if startDir == "" {
		startDir = "/root"
	}

	// Wrap: cd to last dir, run the user command, print new pwd to a sentinel line.
	const sentinel = "\x00__PWD__\x00"
	wrapped := "cd " + shellQuote(startDir) + " 2>/dev/null; " +
		req.Command + "; " +
		"echo '" + sentinel + "'\"$PWD\""

	cmd := exec.CommandContext(ctx, "bash", "-c", wrapped)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	exitCode := 0
	if err := cmd.Run(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = 1
		}
	}

	// Extract new cwd from sentinel line at end of stdout.
	newCwd := startDir
	outStr := stdout.String()
	if idx := strings.LastIndex(outStr, sentinel); idx >= 0 {
		newCwd = strings.TrimSpace(outStr[idx+len(sentinel):])
		outStr = outStr[:idx]
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"stdout":    outStr,
		"stderr":    stderr.String(),
		"exit_code": exitCode,
		"cwd":       newCwd,
	})
}

// shellQuote single-quotes a path so it is safe to embed in a shell command.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'"
}
