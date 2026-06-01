package handlers

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
)

// pwdSentinel marks the line that carries the new working directory.
const pwdSentinel = "OFFDOCK_CWD:"

var wsUpgrader = websocket.Upgrader{
	CheckOrigin:     func(r *http.Request) bool { return true },
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
}

// ExecCommand runs a shell command on the host and returns stdout/stderr/exit_code/cwd.
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
		startDir = os.Getenv("HOME")
		if startDir == "" {
			startDir = "/root"
		}
	}

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

	newCwd := startDir
	outStr := stdout.String()
	if idx := strings.LastIndex(outStr, "\n"+pwdSentinel); idx >= 0 {
		sentinelLine := outStr[idx+1:]
		rest := strings.TrimPrefix(sentinelLine, pwdSentinel)
		newCwd = strings.TrimSpace(rest)
		outStr = outStr[:idx]
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"stdout":    outStr,
		"stderr":    stderr.String(),
		"exit_code": exitCode,
		"cwd":       newCwd,
	})
}

// ExecContainerWS opens a WebSocket connection and starts a docker exec PTY session
// inside the named container. The WebSocket carries raw terminal bytes in both directions.
//
// Query params:
//   - container: container name (required)
//   - shell: shell to run, defaults to sh (bash tried first)
//   - cols, rows: initial terminal size
func (h *H) ExecContainerWS(w http.ResponseWriter, r *http.Request) {
	container := strings.TrimSpace(r.URL.Query().Get("container"))
	if container == "" {
		http.Error(w, "container param required", http.StatusBadRequest)
		return
	}

	// Upgrade to WebSocket.
	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	// Determine best shell available in the container.
	shell := r.URL.Query().Get("shell")
	if shell == "" {
		shell = "sh"
		// Probe for bash — ignore error, fall back to sh.
		probe := exec.Command("docker", "exec", container, "which", "bash")
		if out, err := probe.Output(); err == nil && strings.TrimSpace(string(out)) != "" {
			shell = "bash"
		}
	}

	cmd := exec.Command("docker", "exec", "-it", container, shell)
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")

	ptmx, err := pty.Start(cmd)
	if err != nil {
		conn.WriteMessage(websocket.TextMessage, []byte("\r\nFailed to start: "+err.Error()+"\r\n")) //nolint:errcheck
		return
	}
	defer func() {
		ptmx.Close()
		cmd.Process.Kill() //nolint:errcheck
	}()

	// Apply initial window size from query params.
	setSize(ptmx, r.URL.Query().Get("cols"), r.URL.Query().Get("rows"))

	// PTY → WebSocket (output).
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				if err2 := conn.WriteMessage(websocket.BinaryMessage, buf[:n]); err2 != nil {
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()

	// WebSocket → PTY (input + resize messages).
	for {
		mt, msg, err := conn.ReadMessage()
		if err != nil {
			return
		}
		switch mt {
		case websocket.TextMessage:
			// Resize message: "resize:cols:rows"
			if bytes.HasPrefix(msg, []byte("resize:")) {
				parts := strings.SplitN(string(msg), ":", 3)
				if len(parts) == 3 {
					setSize(ptmx, parts[1], parts[2])
				}
			}
		case websocket.BinaryMessage:
			ptmx.Write(msg) //nolint:errcheck
		}
	}
}

// setSize resizes the PTY to the given dimensions (strings, silently ignores parse errors).
func setSize(ptmx *os.File, colsStr, rowsStr string) {
	cols := uint16(80)
	rows := uint16(24)
	if c := parseUint16(colsStr); c > 0 {
		cols = c
	}
	if r := parseUint16(rowsStr); r > 0 {
		rows = r
	}
	type winsize struct{ Rows, Cols, Xpix, Ypix uint16 }
	ws := winsize{Rows: rows, Cols: cols}
	syscall.Syscall(syscall.SYS_IOCTL, ptmx.Fd(), syscall.TIOCSWINSZ, uintptr(unsafe.Pointer(&ws))) //nolint:errcheck
}

func parseUint16(s string) uint16 {
	var n int
	fmt.Sscanf(s, "%d", &n)
	if n < 1 || n > 9999 {
		return 0
	}
	return uint16(n)
}

// HostShellWS opens a WebSocket PTY session running bash on the host.
// Used by the Terminal page for a full root shell experience.
func (h *H) HostShellWS(w http.ResponseWriter, r *http.Request) {
	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	shell := "/bin/bash"
	if _, err := os.Stat(shell); err != nil {
		shell = "/bin/sh"
	}

	cmd := exec.Command(shell, "-i")
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "PS1=\\u@\\h:\\w\\$ ")

	ptmx, err := pty.Start(cmd)
	if err != nil {
		conn.WriteMessage(websocket.TextMessage, []byte("\r\nFailed to start shell: "+err.Error()+"\r\n")) //nolint:errcheck
		return
	}
	defer func() {
		ptmx.Close()
		cmd.Process.Kill() //nolint:errcheck
	}()

	setSize(ptmx, r.URL.Query().Get("cols"), r.URL.Query().Get("rows"))

	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				if err2 := conn.WriteMessage(websocket.BinaryMessage, buf[:n]); err2 != nil {
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()

	for {
		mt, msg, err := conn.ReadMessage()
		if err != nil {
			return
		}
		switch mt {
		case websocket.TextMessage:
			if bytes.HasPrefix(msg, []byte("resize:")) {
				parts := strings.SplitN(string(msg), ":", 3)
				if len(parts) == 3 {
					setSize(ptmx, parts[1], parts[2])
				}
			} else {
				io.WriteString(ptmx, string(msg)) //nolint:errcheck
			}
		case websocket.BinaryMessage:
			ptmx.Write(msg) //nolint:errcheck
		}
	}
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'"
}
