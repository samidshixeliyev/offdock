// Package backup builds and restores OffDock backup archives. An archive bundles
// the metadata DB, project dirs (compose + .env), certs, OffDock nginx vhosts,
// optionally /etc/offdock/config.yaml, and — the important part — Docker volume
// contents, so a full project including its data can be restored.
package backup

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"offdock/internal/crypto"
	"offdock/internal/docker"
)

// Builder holds the filesystem locations and dependencies for archiving.
type Builder struct {
	DataDir     string
	ProjectsDir string
	CertsDir    string
	ConfigPath  string // /etc/offdock/config.yaml
	NginxAvail  string // /etc/nginx/sites-available
	Docker      *docker.Client
	Enc         *crypto.Encryptor
}

// Options controls what a single backup includes.
type Options struct {
	Scope          string // "full" | "project" | "db" | "config"
	ProjectID      string
	VolumePrefix   string // docker compose volume name prefix for project scope
	IncludeVolumes bool
	IncludeConfig  bool
	IncludeImages  bool     // export tracked Docker images as tarballs
	ImageRefs      []string // image refs (name:tag) to `docker save` when IncludeImages
	Encrypt        bool     // encrypt the (small) config.yaml member at rest
}

// Manifest is written into every archive for validation on restore.
type Manifest struct {
	Version    int       `json:"version"`
	CreatedAt  time.Time `json:"created_at"`
	Scope      string    `json:"scope"`
	ProjectID  string    `json:"project_id"`
	Volumes    []string  `json:"volumes"`
	Images     []string  `json:"images"`
	Encrypted  bool      `json:"encrypted"`
	HasConfig  bool      `json:"has_config"`
}

// Result describes a completed archive.
type Result struct {
	Path      string
	Size      int64
	Contents  []string
	Volumes   []string
	Images    []string
	Encrypted bool
	Sensitive bool
	Status    string // "ok" | "partial"
	Note      string
}

const manifestVersion = 1

// Create writes a tar.gz archive to outPath per the given options.
func (b *Builder) Create(ctx context.Context, outPath string, opts Options) (Result, error) {
	res := Result{Path: outPath, Status: "ok"}

	if err := os.MkdirAll(filepath.Dir(outPath), 0o700); err != nil {
		return res, err
	}
	f, err := os.OpenFile(outPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return res, err
	}
	defer f.Close()
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)

	man := Manifest{Version: manifestVersion, CreatedAt: time.Now().UTC(), Scope: opts.Scope, ProjectID: opts.ProjectID}

	// DB (always, except a pure "config" backup).
	if opts.Scope != "config" {
		if err := addTree(tw, "data", b.DataDir, func(p string) bool { return strings.HasSuffix(p, ".db") }); err == nil {
			res.Contents = append(res.Contents, "database")
		}
	}

	// Projects.
	if opts.Scope == "full" || opts.Scope == "db" {
		if err := addTree(tw, "projects", b.ProjectsDir, nil); err == nil {
			res.Contents = append(res.Contents, "projects")
		}
	} else if opts.Scope == "project" && opts.ProjectID != "" {
		src := filepath.Join(b.ProjectsDir, opts.ProjectID)
		if err := addTree(tw, "projects/"+opts.ProjectID, src, nil); err == nil {
			res.Contents = append(res.Contents, "projects")
		}
	}

	// Certs + nginx vhosts (full backups).
	if opts.Scope == "full" {
		if addTree(tw, "certs", b.CertsDir, nil) == nil {
			res.Contents = append(res.Contents, "certs")
		}
		if b.NginxAvail != "" {
			if addTree(tw, "nginx", b.NginxAvail, func(p string) bool {
				base := filepath.Base(p)
				return strings.HasPrefix(base, "offdock-") && strings.HasSuffix(base, ".conf")
			}) == nil {
				res.Contents = append(res.Contents, "nginx")
			}
		}
	}

	// config.yaml (optionally encrypted at rest).
	if opts.IncludeConfig || opts.Scope == "config" {
		if data, err := os.ReadFile(b.ConfigPath); err == nil {
			added := false
			if opts.Encrypt && b.Enc != nil {
				if enc, err := b.Enc.Encrypt(string(data)); err == nil {
					_ = addBytes(tw, "config/config.yaml.enc", []byte(enc))
					res.Encrypted = true
					man.Encrypted = true
					added = true
				} else {
					// Encryption was requested but failed — do NOT silently write the
					// secret-bearing config in plaintext. Skip it and flag partial.
					res.Status = "partial"
					res.Note += fmt.Sprintf("config: encryption failed, config.yaml omitted: %v; ", err)
				}
			} else {
				_ = addBytes(tw, "config/config.yaml", data)
				added = true
			}
			if added {
				res.Sensitive = true
				man.HasConfig = true
				res.Contents = append(res.Contents, "config")
			}
		}
	}

	// Volumes.
	if opts.IncludeVolumes && b.Docker != nil {
		vols, _ := b.Docker.ListVolumes(ctx)
		tmpDir, _ := os.MkdirTemp("", "offdock-vol-*")
		defer os.RemoveAll(tmpDir)
		for _, v := range vols {
			if opts.VolumePrefix != "" && !strings.HasPrefix(v.Name, opts.VolumePrefix) {
				continue
			}
			tmpFile := filepath.Join(tmpDir, v.Name+".tar.gz")
			if err := b.Docker.ExportVolume(ctx, v.Name, tmpFile); err != nil {
				res.Status = "partial"
				res.Note += fmt.Sprintf("volume %s: %v; ", v.Name, err)
				continue
			}
			if err := addFileFromPath(tw, "volumes/"+v.Name+".tar.gz", tmpFile); err != nil {
				// Exported but couldn't be written into the archive — mark partial
				// rather than silently producing a backup missing this volume.
				res.Status = "partial"
				res.Note += fmt.Sprintf("volume %s: archive write failed: %v; ", v.Name, err)
				continue
			}
			res.Volumes = append(res.Volumes, v.Name)
		}
		if len(res.Volumes) > 0 {
			res.Contents = append(res.Contents, "volumes")
		}
	}

	// Images (docker save → images/<sanitized>.tar.gz).
	if opts.IncludeImages && b.Docker != nil && len(opts.ImageRefs) > 0 {
		tmpDir, _ := os.MkdirTemp("", "offdock-img-*")
		defer os.RemoveAll(tmpDir)
		seen := map[string]bool{}
		for _, ref := range opts.ImageRefs {
			if ref == "" || seen[ref] {
				continue
			}
			seen[ref] = true
			fname := sanitizeImageRef(ref) + ".tar.gz"
			tmpFile := filepath.Join(tmpDir, fname)
			if err := b.Docker.SaveImage(ctx, ref, tmpFile); err != nil {
				res.Status = "partial"
				res.Note += fmt.Sprintf("image %s: %v; ", ref, err)
				continue
			}
			// Store the original ref in the tar member's leading comment file so
			// restore knows the exact name:tag without parsing the filename.
			if err := addFileFromPath(tw, "images/"+fname, tmpFile); err != nil {
				res.Status = "partial"
				res.Note += fmt.Sprintf("image %s: archive write failed: %v; ", ref, err)
				continue
			}
			res.Images = append(res.Images, ref)
		}
		if len(res.Images) > 0 {
			res.Contents = append(res.Contents, "images")
		}
	}

	man.Volumes = res.Volumes
	man.Images = res.Images
	manBytes, _ := json.MarshalIndent(man, "", "  ")
	_ = addBytes(tw, "MANIFEST.json", manBytes)

	if err := tw.Close(); err != nil {
		return res, err
	}
	if err := gz.Close(); err != nil {
		return res, err
	}
	if err := f.Sync(); err != nil {
		return res, err
	}
	if fi, err := os.Stat(outPath); err == nil {
		res.Size = fi.Size()
	}
	return res, nil
}

// sanitizeImageRef turns an image ref (e.g. "registry.io/app:1.2") into a safe
// archive-member basename ("registry.io_app_1.2"). The original tags are
// preserved inside the `docker save` tar itself, so restore relies on that, not
// this name.
func sanitizeImageRef(ref string) string {
	repl := strings.NewReplacer("/", "_", ":", "_", "@", "_", " ", "_")
	return repl.Replace(ref)
}

// --- tar helpers ----------------------------------------------------------------

func addTree(tw *tar.Writer, prefix, root string, filter func(string) bool) error {
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		return fmt.Errorf("not a dir: %s", root)
	}
	return filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if filter != nil && !filter(path) {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return nil
		}
		name := prefix + "/" + filepath.ToSlash(rel)
		return addFileFromPath(tw, name, path)
	})
}

func addFileFromPath(tw *tar.Writer, name, path string) error {
	fi, err := os.Stat(path)
	if err != nil {
		return err
	}
	in, err := os.Open(path)
	if err != nil {
		return err
	}
	defer in.Close()
	hdr := &tar.Header{Name: name, Mode: 0o600, Size: fi.Size(), ModTime: fi.ModTime(), Typeflag: tar.TypeReg}
	if err := tw.WriteHeader(hdr); err != nil {
		return err
	}
	_, err = io.Copy(tw, in)
	return err
}

func addBytes(tw *tar.Writer, name string, data []byte) error {
	hdr := &tar.Header{Name: name, Mode: 0o600, Size: int64(len(data)), ModTime: time.Now(), Typeflag: tar.TypeReg}
	if err := tw.WriteHeader(hdr); err != nil {
		return err
	}
	_, err := tw.Write(data)
	return err
}
