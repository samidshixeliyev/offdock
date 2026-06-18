package backup

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// RestorePlan is the dry-run summary of what an archive would restore.
type RestorePlan struct {
	Manifest  Manifest `json:"manifest"`
	Projects  []string `json:"projects"`
	Volumes   []string `json:"volumes"`
	HasConfig bool     `json:"has_config"`
	HasDB     bool     `json:"has_db"`
	HasNginx  bool     `json:"has_nginx"`
}

// RestoreOptions selects which categories to restore.
type RestoreOptions struct {
	Volumes  bool
	Projects bool
	Config   bool
	DB       bool
	Nginx    bool
	Certs    bool
}

// RestoreResult reports what was restored.
type RestoreResult struct {
	RestoredProjects []string `json:"restored_projects"`
	RestoredVolumes  []string `json:"restored_volumes"`
	RestoredConfig   bool     `json:"restored_config"`
	RestoredDB       bool     `json:"restored_db"`
	Errors           []string `json:"errors"`
}

// Inspect scans an archive without writing anything (dry-run).
func (b *Builder) Inspect(archivePath string) (RestorePlan, error) {
	plan := RestorePlan{}
	err := walkArchive(archivePath, func(hdr *tar.Header, r io.Reader) error {
		name := hdr.Name
		switch {
		case name == "MANIFEST.json":
			data, _ := io.ReadAll(r)
			_ = json.Unmarshal(data, &plan.Manifest)
		case strings.HasPrefix(name, "data/"):
			plan.HasDB = true
		case strings.HasPrefix(name, "config/"):
			plan.HasConfig = true
		case strings.HasPrefix(name, "nginx/"):
			plan.HasNginx = true
		case strings.HasPrefix(name, "projects/"):
			if p := secondSegment(name); p != "" {
				plan.Projects = appendUnique(plan.Projects, p)
			}
		case strings.HasPrefix(name, "volumes/"):
			base := strings.TrimSuffix(filepath.Base(name), ".tar.gz")
			plan.Volumes = appendUnique(plan.Volumes, base)
		}
		return nil
	})
	return plan, err
}

// Restore extracts the selected categories from an archive to their live
// locations. DB restore overwrites the .db files on disk; the caller MUST
// restart OffDock afterwards for the in-memory store to pick them up.
func (b *Builder) Restore(ctx context.Context, archivePath string, opts RestoreOptions) (RestoreResult, error) {
	res := RestoreResult{}
	tmpDir, _ := os.MkdirTemp("", "offdock-restore-*")
	defer os.RemoveAll(tmpDir)

	err := walkArchive(archivePath, func(hdr *tar.Header, r io.Reader) error {
		name := hdr.Name
		switch {
		case opts.DB && strings.HasPrefix(name, "data/"):
			if writeUnder(b.DataDir, strings.TrimPrefix(name, "data/"), r) == nil {
				res.RestoredDB = true
			}
		case opts.Projects && strings.HasPrefix(name, "projects/"):
			if writeUnder(b.ProjectsDir, strings.TrimPrefix(name, "projects/"), r) == nil {
				if p := secondSegment(name); p != "" {
					res.RestoredProjects = appendUnique(res.RestoredProjects, p)
				}
			}
		case opts.Certs && strings.HasPrefix(name, "certs/"):
			_ = writeUnder(b.CertsDir, strings.TrimPrefix(name, "certs/"), r)
		case opts.Nginx && strings.HasPrefix(name, "nginx/") && b.NginxAvail != "":
			_ = writeUnder(b.NginxAvail, strings.TrimPrefix(name, "nginx/"), r)
		case opts.Config && name == "config/config.yaml":
			data, _ := io.ReadAll(r)
			backupExistingConfig(b.ConfigPath) // preserve prior config (jwt_secret etc.)
			if writeFileAtomic(b.ConfigPath, data, 0o600) == nil {
				res.RestoredConfig = true
			}
		case opts.Config && name == "config/config.yaml.enc":
			data, _ := io.ReadAll(r)
			if b.Enc != nil {
				if plain, err := b.Enc.Decrypt(string(data)); err == nil {
					backupExistingConfig(b.ConfigPath) // preserve prior config (jwt_secret etc.)
					if writeFileAtomic(b.ConfigPath, []byte(plain), 0o600) == nil {
						res.RestoredConfig = true
					}
				} else {
					res.Errors = append(res.Errors, "config decrypt failed (different machine key?): "+err.Error())
				}
			}
		case opts.Volumes && strings.HasPrefix(name, "volumes/"):
			// Stage the volume tarball to a temp file, then import.
			vol := strings.TrimSuffix(filepath.Base(name), ".tar.gz")
			tmpFile := filepath.Join(tmpDir, filepath.Base(name))
			if err := stageFile(tmpFile, r); err != nil {
				res.Errors = append(res.Errors, "stage "+vol+": "+err.Error())
				return nil
			}
			if b.Docker != nil {
				if err := b.Docker.ImportVolume(ctx, vol, tmpFile); err != nil {
					res.Errors = append(res.Errors, "import "+vol+": "+err.Error())
				} else {
					res.RestoredVolumes = appendUnique(res.RestoredVolumes, vol)
				}
			}
		}
		return nil
	})
	return res, err
}

// --- helpers --------------------------------------------------------------------

// backupExistingConfig copies the current config.yaml to config.yaml.bak before a
// restore overwrites it, so a bad restore (e.g. config from a different machine,
// clobbering jwt_secret/SMTP/oauth secrets) can be rolled back. Best-effort.
func backupExistingConfig(configPath string) {
	if configPath == "" {
		return
	}
	data, err := os.ReadFile(configPath)
	if err != nil {
		return // no existing config to preserve
	}
	_ = os.WriteFile(configPath+".bak", data, 0o600)
}

func walkArchive(path string, fn func(*tar.Header, io.Reader) error) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return fmt.Errorf("gzip: %w", err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		// Reject path traversal.
		clean := filepath.Clean(hdr.Name)
		if strings.HasPrefix(clean, "..") || filepath.IsAbs(clean) {
			continue
		}
		if err := fn(hdr, tr); err != nil {
			return err
		}
	}
}

// writeUnder writes content to base/rel, guarding against traversal.
func writeUnder(base, rel string, r io.Reader) error {
	clean := filepath.Clean(rel)
	if strings.HasPrefix(clean, "..") || filepath.IsAbs(clean) {
		return fmt.Errorf("unsafe path: %s", rel)
	}
	dest := filepath.Join(base, clean)
	if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
		return err
	}
	data, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	return writeFileAtomic(dest, data, 0o600)
}

func stageFile(path string, r io.Reader) error {
	out, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, r)
	return err
}

func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, mode); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func secondSegment(name string) string {
	parts := strings.Split(name, "/")
	if len(parts) >= 2 {
		return parts[1]
	}
	return ""
}

func appendUnique(s []string, v string) []string {
	for _, x := range s {
		if x == v {
			return s
		}
	}
	return append(s, v)
}
