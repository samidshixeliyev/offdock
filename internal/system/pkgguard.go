package system

import (
	"context"
	"os/exec"
	"strings"
	"time"
)

// ProtectedPackages are the apt packages OffDock depends on. They are held
// (apt-mark hold) so that `apt --fix-broken install` or a careless dependency
// resolution can never remove Docker, the container runtime, or nginx and take
// every running container down with them.
var ProtectedPackages = []string{
	"docker-ce",
	"docker-ce-cli",
	"containerd.io",
	"docker-compose-plugin",
	"docker-buildx-plugin",
	"nginx",
	"nginx-core",
	"nginx-common",
}

// EnsureHolds marks every installed protected package as "hold" so apt/dpkg
// refuse to remove or upgrade it automatically. Idempotent and best-effort:
// packages that are not installed are skipped, and errors are returned only for
// diagnostics — callers typically log and continue.
func EnsureHolds(ctx context.Context) []string {
	var held []string
	for _, pkg := range ProtectedPackages {
		if !packageInstalled(ctx, pkg) {
			continue
		}
		ctx2, cancel := context.WithTimeout(ctx, 10*time.Second)
		if err := exec.CommandContext(ctx2, "apt-mark", "hold", pkg).Run(); err == nil {
			held = append(held, pkg)
		}
		cancel()
	}
	return held
}

// HeldPackages returns the subset of protected packages currently on hold.
func HeldPackages(ctx context.Context) []string {
	ctx2, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx2, "apt-mark", "showhold").Output()
	if err != nil {
		return nil
	}
	onHold := map[string]bool{}
	for _, line := range strings.Fields(string(out)) {
		onHold[line] = true
	}
	var result []string
	for _, pkg := range ProtectedPackages {
		if onHold[pkg] {
			result = append(result, pkg)
		}
	}
	return result
}

// IsProtected reports whether a package name is in the protected set.
func IsProtected(pkg string) bool {
	for _, p := range ProtectedPackages {
		if p == pkg {
			return true
		}
	}
	return false
}

func packageInstalled(ctx context.Context, pkg string) bool {
	ctx2, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx2, "dpkg-query", "-W", "-f=${Status}", pkg).Output()
	if err != nil {
		return false
	}
	return strings.Contains(string(out), "install ok installed")
}
