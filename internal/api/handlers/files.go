package handlers

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const maxInlineBytes = 2 << 20 // 2 MB — larger files are streamed as download

// FileEntry is the JSON shape returned by browse and stat endpoints.
type FileEntry struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	IsDir     bool   `json:"is_dir"`
	IsSymlink bool   `json:"is_symlink"`
	Size      int64  `json:"size"`
	Mode      string `json:"mode"`
	ModTime   string `json:"mod_time"`
	Mime      string `json:"mime"`
}

// FileBrowse lists the contents of a directory.
func (h *H) FileBrowse(w http.ResponseWriter, r *http.Request) {
	path := cleanPath(r.URL.Query().Get("path"))
	if path == "" {
		path = "/"
	}

	entries, err := os.ReadDir(path)
	if err != nil {
		writeError(w, http.StatusBadRequest, "cannot read directory: "+err.Error())
		return
	}

	result := make([]FileEntry, 0, len(entries))
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			continue
		}
		fe := FileEntry{
			Name:      e.Name(),
			Path:      filepath.Join(path, e.Name()),
			IsDir:     e.IsDir(),
			IsSymlink: e.Type()&os.ModeSymlink != 0,
			Size:      info.Size(),
			Mode:      info.Mode().String(),
			ModTime:   info.ModTime().UTC().Format(time.RFC3339),
			Mime:      guessMime(e.Name()),
		}
		result = append(result, fe)
	}

	// Dirs first, then alphabetical within each group.
	sort.Slice(result, func(i, j int) bool {
		if result[i].IsDir != result[j].IsDir {
			return result[i].IsDir
		}
		return strings.ToLower(result[i].Name) < strings.ToLower(result[j].Name)
	})

	writeJSON(w, http.StatusOK, result)
}

// FileRead returns the content of a file as JSON, or streams it as a download
// for binary/large files or when ?download=1 is set.
func (h *H) FileRead(w http.ResponseWriter, r *http.Request) {
	path := cleanPath(r.URL.Query().Get("path"))
	if path == "" {
		writeError(w, http.StatusBadRequest, "path required")
		return
	}

	info, err := os.Stat(path)
	if err != nil {
		writeError(w, http.StatusNotFound, "not found: "+err.Error())
		return
	}
	if info.IsDir() {
		writeError(w, http.StatusBadRequest, "path is a directory — use /files/browse")
		return
	}

	forceDownload := r.URL.Query().Get("download") == "1"
	large := info.Size() > maxInlineBytes

	if forceDownload || large {
		f, err := os.Open(path)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		defer f.Close()
		mime := guessMime(path)
		if forceDownload || !strings.HasPrefix(mime, "text/") {
			w.Header().Set("Content-Disposition", `attachment; filename="`+filepath.Base(path)+`"`)
			w.Header().Set("Content-Type", "application/octet-stream")
		} else {
			w.Header().Set("Content-Type", mime)
		}
		w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
		w.WriteHeader(http.StatusOK)
		io.Copy(w, f) //nolint:errcheck
		return
	}

	data, err := os.ReadFile(path)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "read failed: "+err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"path":      path,
		"name":      filepath.Base(path),
		"content":   string(data),
		"size":      info.Size(),
		"mode":      info.Mode().String(),
		"mod_time":  info.ModTime().UTC().Format(time.RFC3339),
		"is_binary": isBinary(data),
		"mime":      guessMime(path),
		"truncated": false,
	})
}

// FileWrite creates or overwrites a file with the provided content.
func (h *H) FileWrite(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 10<<20) // 10 MB
	var req struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := decodeJSON(r, &req); err != nil || req.Path == "" {
		writeError(w, http.StatusBadRequest, "path and content required")
		return
	}
	path := cleanPath(req.Path)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, "mkdir: "+err.Error())
		return
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(req.Content), 0o644); err != nil {
		writeError(w, http.StatusInternalServerError, "write: "+err.Error())
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp) //nolint:errcheck
		writeError(w, http.StatusInternalServerError, "rename: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "path": path})
}

// FileMkdir creates a directory (and all parents).
func (h *H) FileMkdir(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
	}
	if err := decodeJSON(r, &req); err != nil || req.Path == "" {
		writeError(w, http.StatusBadRequest, "path required")
		return
	}
	path := cleanPath(req.Path)
	if err := os.MkdirAll(path, 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, "mkdir: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "path": path})
}

// FileDelete removes a file or directory. Blocked for critical system paths.
func (h *H) FileDelete(w http.ResponseWriter, r *http.Request) {
	path := cleanPath(r.URL.Query().Get("path"))
	if path == "" || path == "/" {
		writeError(w, http.StatusBadRequest, "cannot delete root")
		return
	}
	if isBlockedPath(path) {
		writeError(w, http.StatusForbidden, "cannot delete system path: "+path)
		return
	}
	if err := os.RemoveAll(path); err != nil {
		writeError(w, http.StatusInternalServerError, "delete: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "path": path})
}

// FileRename moves or renames a file or directory.
func (h *H) FileRename(w http.ResponseWriter, r *http.Request) {
	var req struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if err := decodeJSON(r, &req); err != nil || req.From == "" || req.To == "" {
		writeError(w, http.StatusBadRequest, "from and to required")
		return
	}
	if err := os.Rename(cleanPath(req.From), cleanPath(req.To)); err != nil {
		writeError(w, http.StatusInternalServerError, "rename: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// FileSearch does a recursive name search within a directory (depth-limited).
func (h *H) FileSearch(w http.ResponseWriter, r *http.Request) {
	base := cleanPath(r.URL.Query().Get("path"))
	query := strings.ToLower(r.URL.Query().Get("q"))
	if base == "" || query == "" {
		writeError(w, http.StatusBadRequest, "path and q required")
		return
	}

	const maxResults = 200
	const maxDepth = 6
	var results []FileEntry

	var walk func(dir string, depth int)
	walk = func(dir string, depth int) {
		if depth > maxDepth || len(results) >= maxResults {
			return
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		for _, e := range entries {
			if len(results) >= maxResults {
				return
			}
			if strings.Contains(strings.ToLower(e.Name()), query) {
				info, _ := e.Info()
				fe := FileEntry{
					Name:  e.Name(),
					Path:  filepath.Join(dir, e.Name()),
					IsDir: e.IsDir(),
					Mime:  guessMime(e.Name()),
				}
				if info != nil {
					fe.Size = info.Size()
					fe.Mode = info.Mode().String()
					fe.ModTime = info.ModTime().UTC().Format(time.RFC3339)
				}
				results = append(results, fe)
			}
			if e.IsDir() {
				walk(filepath.Join(dir, e.Name()), depth+1)
			}
		}
	}
	walk(base, 0)

	writeJSON(w, http.StatusOK, results)
}

// --- helpers -------------------------------------------------------------------

func cleanPath(p string) string {
	if p == "" {
		return ""
	}
	return filepath.Clean("/" + strings.TrimLeft(p, "/"))
}

var blockedPrefixes = []string{
	"/bin", "/sbin", "/usr/bin", "/usr/sbin",
	"/lib", "/lib64", "/lib32",
	"/boot", "/dev", "/proc", "/sys",
	"/var/offdock",        // OffDock data
	"/etc/offdock",        // OffDock config
	"/root/.ssh",          // SSH keys
	"/home/ubuntu/.ssh",   // SSH keys
	"/root/.docker",       // Docker credentials
	"/etc/shadow",         // Password hashes
	"/etc/sudoers",        // Sudo config
	"/etc/sudoers.d",      // Sudo config dir
	"/etc/systemd/system", // Systemd units
}

func isBlockedPath(p string) bool {
	for _, b := range blockedPrefixes {
		if p == b || strings.HasPrefix(p, b+"/") {
			return true
		}
	}
	return false
}

func guessMime(name string) string {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".yml", ".yaml":
		return "text/yaml"
	case ".json":
		return "application/json"
	case ".sh", ".bash":
		return "text/x-shellscript"
	case ".conf", ".cfg", ".ini":
		return "text/plain"
	case ".toml":
		return "text/toml"
	case ".py":
		return "text/x-python"
	case ".go":
		return "text/x-go"
	case ".ts", ".tsx":
		return "text/typescript"
	case ".js", ".jsx":
		return "text/javascript"
	case ".html", ".htm":
		return "text/html"
	case ".css":
		return "text/css"
	case ".md":
		return "text/markdown"
	case ".txt", ".log", ".env", ".gitignore", ".dockerignore":
		return "text/plain"
	case ".xml":
		return "text/xml"
	case ".sql":
		return "text/x-sql"
	case ".dockerfile":
		return "text/x-dockerfile"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".svg":
		return "image/svg+xml"
	case ".webp":
		return "image/webp"
	case ".pdf":
		return "application/pdf"
	case ".tar", ".gz", ".tgz", ".zip", ".bz2", ".xz":
		return "application/octet-stream"
	default:
		// Files without extension that are commonly text
		base := strings.ToLower(filepath.Base(name))
		switch base {
		case "dockerfile", "makefile", "jenkinsfile", "vagrantfile":
			return "text/plain"
		}
		return "application/octet-stream"
	}
}

func isBinary(data []byte) bool {
	check := data
	if len(check) > 512 {
		check = check[:512]
	}
	for _, b := range check {
		if b == 0 {
			return true
		}
	}
	return false
}
