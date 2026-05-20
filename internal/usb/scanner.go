// Package usb scans the host for mounted removable media and provides a
// path-traversal-safe file browser limited to relevant file types.
package usb

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// Drive represents a mounted filesystem that may be a USB drive.
type Drive struct {
	MountPoint string `json:"mount_point"`
	Label      string `json:"label"`
	FreeBytes  uint64 `json:"free_bytes"`
	TotalBytes uint64 `json:"total_bytes"`
}

// FileEntry is a file or directory visible through the browser.
type FileEntry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	IsDir bool   `json:"is_dir"`
	Size  int64  `json:"size"`
}

// allowedExtensions are the only file extensions shown in the browser.
var allowedExtensions = map[string]bool{
	".tar":  true,
	".yml":  true,
	".yaml": true,
	".env":  true,
	".crt":  true,
	".key":  true,
	".pem":  true,
}

// ScanDrives scans /media and /mnt for real (non-virtual) mounted filesystems
// by reading /proc/mounts and filtering out virtual fs types.
func ScanDrives() ([]Drive, error) {
	mounts, err := parseMounts()
	if err != nil {
		return nil, err
	}

	var drives []Drive
	for _, m := range mounts {
		if !isRealFS(m.fsType) {
			continue
		}
		if !strings.HasPrefix(m.mountPoint, "/media/") && !strings.HasPrefix(m.mountPoint, "/mnt/") {
			continue
		}

		var st syscall.Statfs_t
		if err := syscall.Statfs(m.mountPoint, &st); err != nil {
			continue
		}
		total := st.Blocks * uint64(st.Bsize)
		free := st.Bfree * uint64(st.Bsize)

		drives = append(drives, Drive{
			MountPoint: m.mountPoint,
			Label:      filepath.Base(m.mountPoint),
			FreeBytes:  free,
			TotalBytes: total,
		})
	}
	return drives, nil
}

// Browse lists files and directories at path, restricted to allowedExtensions
// for files.  The path must reside within mountPoint to prevent traversal.
func Browse(mountPoint, path string) ([]FileEntry, error) {
	if err := validatePath(mountPoint, path); err != nil {
		return nil, err
	}

	entries, err := os.ReadDir(path)
	if err != nil {
		return nil, fmt.Errorf("read dir: %w", err)
	}

	var result []FileEntry
	for _, e := range entries {
		fi, err := e.Info()
		if err != nil {
			continue
		}
		if !e.IsDir() && !allowedExtensions[strings.ToLower(filepath.Ext(e.Name()))] {
			continue
		}
		result = append(result, FileEntry{
			Name:  e.Name(),
			Path:  filepath.Join(path, e.Name()),
			IsDir: e.IsDir(),
			Size:  fi.Size(),
		})
	}
	return result, nil
}

// validatePath ensures that target is a clean path within mountPoint.
func validatePath(mountPoint, target string) error {
	clean := filepath.Clean(target)
	mountClean := filepath.Clean(mountPoint)
	if !strings.HasPrefix(clean+"/", mountClean+"/") && clean != mountClean {
		return fmt.Errorf("path %q is outside mount point %q", target, mountPoint)
	}
	return nil
}

type mountEntry struct {
	mountPoint string
	fsType     string
}

func parseMounts() ([]mountEntry, error) {
	f, err := os.Open("/proc/mounts")
	if err != nil {
		return nil, fmt.Errorf("open /proc/mounts: %w", err)
	}
	defer f.Close()

	var entries []mountEntry
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 3 {
			continue
		}
		entries = append(entries, mountEntry{
			mountPoint: fields[1],
			fsType:     fields[2],
		})
	}
	return entries, sc.Err()
}

var virtualFS = map[string]bool{
	"tmpfs": true, "sysfs": true, "proc": true, "devtmpfs": true,
	"devpts": true, "cgroup": true, "cgroup2": true, "pstore": true,
	"bpf": true, "tracefs": true, "securityfs": true, "configfs": true,
	"hugetlbfs": true, "mqueue": true, "fusectl": true,
}

func isRealFS(fsType string) bool {
	return !virtualFS[fsType]
}
