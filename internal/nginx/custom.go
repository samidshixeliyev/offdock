package nginx

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"offdock/internal/store"
)

const (
	// StreamsEnabledDir holds raw TCP/UDP stream configs. nginx must include it
	// from a top-level `stream {}` block (EnsureStreamInclude wires that up).
	StreamsEnabledDir = "/etc/nginx/streams-enabled"
	nginxMainConf     = "/etc/nginx/nginx.conf"
)

// customFileName builds the on-disk filename for a custom config.
func customFileName(name string) string {
	return "offdock-custom-" + sanitizeName(name) + ".conf"
}

// EnsureStreamInclude makes sure nginx.conf loads stream configs from
// StreamsEnabledDir. nginx only allows ONE top-level stream{} block, so:
//   - if nginx.conf already references streams-enabled → nothing to do
//   - if it has a stream{} block already but not our include → we refuse and ask
//     the operator to add the include line (don't risk corrupting their block)
//   - otherwise → append a fresh `stream { include …; }` block
func EnsureStreamInclude() error {
	if err := os.MkdirAll(StreamsEnabledDir, 0o755); err != nil {
		return fmt.Errorf("ensure streams dir: %w", err)
	}
	data, err := os.ReadFile(nginxMainConf)
	if err != nil {
		return fmt.Errorf("read nginx.conf: %w", err)
	}
	conf := string(data)
	if strings.Contains(conf, "streams-enabled") {
		return nil // already wired
	}
	// nginx allows only ONE top-level stream{} block. If one already exists we must
	// NOT append a second (nginx would refuse to start) — ask the operator to add
	// the include line themselves.
	if hasTopLevelStreamBlock(conf) {
		return fmt.Errorf("nginx.conf already has a stream {} block — add this line inside it manually:\n    include %s/*.conf;", StreamsEnabledDir)
	}
	block := fmt.Sprintf("\n# OffDock TCP/UDP stream configs\nstream {\n    include %s/*.conf;\n}\n", StreamsEnabledDir)

	// Write atomically (temp + rename), then validate. If nginx -t fails, restore
	// the original nginx.conf so a bad edit can never take nginx down host-wide.
	tmp := nginxMainConf + ".offdock.tmp"
	if err := os.WriteFile(tmp, []byte(conf+block), 0o644); err != nil {
		return fmt.Errorf("write nginx.conf: %w", err)
	}
	if err := os.Rename(tmp, nginxMainConf); err != nil {
		os.Remove(tmp) //nolint:errcheck
		return fmt.Errorf("install nginx.conf: %w", err)
	}
	if _, testErr := TestSystem(); testErr != nil {
		// Roll back to the original content.
		os.WriteFile(nginxMainConf, data, 0o644) //nolint:errcheck
		return fmt.Errorf("adding the stream{} block broke nginx -t; reverted nginx.conf: %w", testErr)
	}
	return nil
}

// hasTopLevelStreamBlock reports whether the conf already opens a stream{} block
// at the top level (ignoring commented lines). Matches `stream` followed by `{`
// with any whitespace between, on the same line, including `stream{}`/`stream {`.
func hasTopLevelStreamBlock(conf string) bool {
	for _, line := range strings.Split(conf, "\n") {
		t := strings.TrimSpace(line)
		if strings.HasPrefix(t, "#") {
			continue
		}
		// strip a trailing line comment
		if i := strings.Index(t, "#"); i >= 0 {
			t = strings.TrimSpace(t[:i])
		}
		if t == "stream" {
			return true // block opens on the next line
		}
		if rest, ok := strings.CutPrefix(t, "stream"); ok {
			if strings.HasPrefix(strings.TrimSpace(rest), "{") {
				return true
			}
		}
	}
	return false
}

// ApplyCustom writes a custom config to the right directory, validates the whole
// nginx config, and reloads. On `nginx -t` failure it rolls back the file so a
// bad snippet never takes nginx down. Returns the config path.
func ApplyCustom(cfg store.NginxCustomConfig) (*ApplyResult, error) {
	name := customFileName(cfg.Name)

	var dir string
	switch cfg.Kind {
	case "stream":
		if err := EnsureStreamInclude(); err != nil {
			return nil, err
		}
		dir = StreamsEnabledDir
	default: // "http"
		dir = SystemSitesAvailable
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("ensure dir: %w", err)
	}

	confPath := filepath.Join(dir, name)
	// Keep a backup of any previous content for rollback.
	prev, hadPrev := os.ReadFile(confPath)

	if !cfg.Enabled {
		// Disabled → remove the file (and stream/http symlink), then reload.
		_ = removeCustomFiles(cfg.Name, cfg.Kind)
		if err := reloadSystem(); err != nil {
			return nil, err
		}
		return &ApplyResult{ConfigPath: confPath}, nil
	}

	tmp := confPath + ".tmp"
	if err := os.WriteFile(tmp, []byte(cfg.Content), 0o644); err != nil {
		return nil, fmt.Errorf("write config: %w", err)
	}
	if err := os.Rename(tmp, confPath); err != nil {
		os.Remove(tmp) //nolint:errcheck
		return nil, fmt.Errorf("install config: %w", err)
	}

	// http configs are loaded from sites-enabled via symlink.
	if cfg.Kind != "stream" {
		enabled := filepath.Join(SystemSitesEnabled, name)
		os.Remove(enabled) //nolint:errcheck
		if err := os.Symlink(confPath, enabled); err != nil && !os.IsExist(err) {
			return nil, fmt.Errorf("enable config: %w", err)
		}
	}

	testOut, testErr := TestSystem()
	if testErr != nil {
		// Roll back to the previous content (or remove if new).
		rollbackCustom(confPath, name, cfg.Kind, prev, hadPrev == nil)
		return nil, fmt.Errorf("nginx -t failed — config not applied:\n%s", strings.TrimSpace(testOut))
	}
	if err := reloadSystem(); err != nil {
		rollbackCustom(confPath, name, cfg.Kind, prev, hadPrev == nil)
		return nil, fmt.Errorf("nginx reload: %w", err)
	}
	return &ApplyResult{ConfigPath: confPath, NginxTestOutput: testOut}, nil
}

func rollbackCustom(confPath, name, kind string, prev []byte, hadPrev bool) {
	if hadPrev {
		os.WriteFile(confPath, prev, 0o644) //nolint:errcheck
	} else {
		removeCustomFiles(name, kind) //nolint:errcheck
	}
}

// removeCustomFiles deletes the config file (and http symlink) for a custom config.
func removeCustomFiles(name, kind string) error {
	file := customFileName(name)
	if kind == "stream" {
		return os.Remove(filepath.Join(StreamsEnabledDir, file))
	}
	os.Remove(filepath.Join(SystemSitesEnabled, file)) //nolint:errcheck
	return os.Remove(filepath.Join(SystemSitesAvailable, file))
}

// RemoveCustom deletes a custom config and reloads nginx.
func RemoveCustom(name, kind string) error {
	removeCustomFiles(name, kind) //nolint:errcheck
	return reloadSystem()
}

// ListManagedConfigs returns every OffDock-managed nginx config file on disk
// (project vhosts, proxy hosts, self, and custom http+stream) with its content,
// so the UI can show "all nginx configs in one place".
type ManagedConfig struct {
	File    string `json:"file"`
	Dir     string `json:"dir"`
	Kind    string `json:"kind"` // "http" | "stream"
	Content string `json:"content"`
}

func ListManagedConfigs() []ManagedConfig {
	var out []ManagedConfig
	add := func(dir, kind string) {
		entries, _ := os.ReadDir(dir)
		for _, e := range entries {
			if e.IsDir() || !strings.HasPrefix(e.Name(), "offdock-") || !strings.HasSuffix(e.Name(), ".conf") {
				continue
			}
			data, _ := os.ReadFile(filepath.Join(dir, e.Name()))
			out = append(out, ManagedConfig{File: e.Name(), Dir: dir, Kind: kind, Content: string(data)})
		}
	}
	add(SystemSitesAvailable, "http")
	add(StreamsEnabledDir, "stream")
	return out
}
