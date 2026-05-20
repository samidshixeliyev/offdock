package handlers

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"os/exec"
	"strings"
	"time"
)

// pwdSentinel marks the line that carries the new working directory.
// Must be safe in all shell contexts (no spaces, no special chars).
const pwdSentinel = "OFFDOCK_CWD:"

// ExecCommand runs a shell command on the host and returns stdout/stderr/exit_code/cwd.
// Only admin+ roles may call this (enforced in the router).
func (h *H) ExecCommand(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Command string `json:"command"`
		Cwd     string `json:"cwd"`
	}
	if err := decodeJSON(r, &req); err != nil || strings.TrimSpace(req.Command) == "" {
		writeError(w, http.StatusBadRequest, "command is required")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()

	startDir := req.Cwd
	if startDir == "" {
		startDir = "/root"
	}

	// Wrap the user command so we can capture the final working directory.
	// The sentinel line is printed AFTER the command so we can strip it from stdout.
	// We preserve the command's original exit code via __ec.
	script := fmt.Sprintf(
		`cd %s 2>/dev/null
%s
__ec=$?
printf '\n%s%%s\n' "$PWD"
exit $__ec`,
		shellQuote(startDir),
		req.Command,
		pwdSentinel,
	)

	cmd := exec.CommandContext(ctx, "bash", "-c", script)
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

	// Strip the sentinel line from stdout and extract the cwd.
	newCwd := startDir
	outStr := stdout.String()

	if idx := strings.LastIndex(outStr, "\n"+pwdSentinel); idx >= 0 {
		sentinelLine := outStr[idx+1:]                        // "OFFDOCK_CWD:/some/path\n"
		rest := strings.TrimPrefix(sentinelLine, pwdSentinel) // "/some/path\n"
		newCwd = strings.TrimSpace(rest)
		outStr = outStr[:idx] // everything before the sentinel
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"stdout":    outStr,
		"stderr":    stderr.String(),
		"exit_code": exitCode,
		"cwd":       newCwd,
	})
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'"
}
