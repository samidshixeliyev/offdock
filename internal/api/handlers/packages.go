package handlers

import (
	"context"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	authmw "offdock/internal/middleware"
	"offdock/internal/system"
)

// PackageSimulation is the parsed result of an apt simulate run.
type PackageSimulation struct {
	Install  []string `json:"install"`
	Upgrade  []string `json:"upgrade"`
	Remove   []string `json:"remove"`
	Protected []string `json:"protected_removals"` // protected pkgs that would be removed
	Raw      string   `json:"raw"`
}

// GetPackageStatus reports which protected packages are currently held.
// GET /api/v1/system/packages/status
func (h *H) GetPackageStatus(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	writeJSON(w, http.StatusOK, map[string]any{
		"protected": system.ProtectedPackages,
		"held":      system.HeldPackages(ctx),
	})
}

// EnsurePackageHolds re-applies apt-mark hold on all protected packages.
// POST /api/v1/system/packages/hold
func (h *H) EnsurePackageHolds(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	held := system.EnsureHolds(ctx)
	h.logAudit(r, "package_hold", "system", "", "", strings.Join(held, ","))
	writeJSON(w, http.StatusOK, map[string]any{"held": held})
}

// InstallPackages installs one or more .deb files safely. It first simulates the
// install and ABORTS if any protected package (Docker, nginx, etc.) would be
// removed — the exact failure mode that has taken containers down via
// `apt --fix-broken install`. Only on a clean simulation does it apply.
// POST /api/v1/system/packages/install  {paths:[...], force:bool}
func (h *H) InstallPackages(w http.ResponseWriter, r *http.Request) {
	claims := authmw.ClaimsFromContext(r.Context())
	var req struct {
		Paths []string `json:"paths"`
		Force bool     `json:"force"` // override protected-removal abort (still logged)
	}
	if err := decodeJSON(r, &req); err != nil || len(req.Paths) == 0 {
		writeError(w, http.StatusBadRequest, "paths (one or more .deb files) required")
		return
	}

	debs, err := resolveDebPaths(req.Paths)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	// Step 1: simulate.
	sim, err := simulateApt(r.Context(), append([]string{"install", "-s", "--no-download"}, debs...))
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "could not simulate install: "+err.Error()+"\n"+sim.Raw)
		return
	}

	// Step 2: abort if a protected package would be removed.
	if len(sim.Protected) > 0 && !req.Force {
		h.logAudit(r, "package_install_blocked", "system", "", strings.Join(debs, ","), strings.Join(sim.Protected, ","))
		writeJSON(w, http.StatusConflict, map[string]any{
			"error":     "refused: this install would remove protected packages",
			"protected": sim.Protected,
			"simulation": sim,
		})
		return
	}

	// Step 3: apply.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	args := append([]string{"install", "-y", "--no-download"}, debs...)
	cmd := exec.CommandContext(ctx, "apt-get", args...)
	cmd.Env = append(cmd.Environ(), "DEBIAN_FRONTEND=noninteractive")
	out, runErr := cmd.CombinedOutput()
	// Always run dpkg --configure -a to settle any half-configured state.
	configCtx, cancel2 := context.WithTimeout(context.Background(), 2*time.Minute)
	exec.CommandContext(configCtx, "dpkg", "--configure", "-a").Run() //nolint:errcheck
	cancel2()

	by := ""
	if claims != nil {
		by = claims.Username
	}
	h.logAudit(r, "package_install", "system", "", strings.Join(debs, ","), by)

	status := http.StatusOK
	if runErr != nil {
		status = http.StatusUnprocessableEntity
	}
	writeJSON(w, status, map[string]any{
		"applied":    runErr == nil,
		"output":     string(out),
		"simulation": sim,
	})
}

// FixBroken runs `apt-get -f install` but, like InstallPackages, simulates first
// and refuses if the fix would remove a protected package.
// POST /api/v1/system/packages/fix-broken  {force:bool}
func (h *H) FixBroken(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Force bool `json:"force"`
	}
	_ = decodeJSON(r, &req)

	sim, err := simulateApt(r.Context(), []string{"-f", "install", "-s"})
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "could not simulate fix-broken: "+err.Error()+"\n"+sim.Raw)
		return
	}
	if len(sim.Protected) > 0 && !req.Force {
		h.logAudit(r, "fix_broken_blocked", "system", "", "", strings.Join(sim.Protected, ","))
		writeJSON(w, http.StatusConflict, map[string]any{
			"error":      "refused: fix-broken would remove protected packages",
			"protected":  sim.Protected,
			"simulation": sim,
		})
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "apt-get", "-f", "install", "-y")
	cmd.Env = append(cmd.Environ(), "DEBIAN_FRONTEND=noninteractive")
	out, runErr := cmd.CombinedOutput()
	h.logAudit(r, "fix_broken", "system", "", "", "")
	status := http.StatusOK
	if runErr != nil {
		status = http.StatusUnprocessableEntity
	}
	writeJSON(w, status, map[string]any{
		"applied":    runErr == nil,
		"output":     string(out),
		"simulation": sim,
	})
}

// --- helpers ----------------------------------------------------------------

// resolveDebPaths validates that each path is an existing .deb file. Bare
// filenames are resolved against the uploads staging dir.
func resolveDebPaths(paths []string) ([]string, error) {
	out := make([]string, 0, len(paths))
	for _, p := range paths {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if !filepath.IsAbs(p) {
			p = filepath.Join("/var/offdock/uploads", filepath.Base(p))
		}
		p = cleanPath(p)
		if !strings.HasSuffix(strings.ToLower(p), ".deb") {
			return nil, &debError{"not a .deb file: " + p}
		}
		if _, err := os.Stat(p); err != nil {
			return nil, &debError{"file not found: " + p}
		}
		out = append(out, p)
	}
	if len(out) == 0 {
		return nil, &debError{"no valid .deb paths provided"}
	}
	return out, nil
}

type debError struct{ msg string }

func (e *debError) Error() string { return e.msg }

// simulateApt runs apt-get with the given args (which must include -s) and parses
// the install/upgrade/remove sets, flagging any protected-package removals.
func simulateApt(parent context.Context, args []string) (PackageSimulation, error) {
	ctx, cancel := context.WithTimeout(parent, 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "apt-get", args...)
	cmd.Env = append(cmd.Environ(), "DEBIAN_FRONTEND=noninteractive")
	out, err := cmd.CombinedOutput()
	sim := PackageSimulation{Raw: string(out)}
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		name := fields[1]
		switch fields[0] {
		case "Inst":
			sim.Install = append(sim.Install, name)
		case "Upgrade", "Upg":
			sim.Upgrade = append(sim.Upgrade, name)
		case "Remv":
			sim.Remove = append(sim.Remove, name)
			if system.IsProtected(name) {
				sim.Protected = append(sim.Protected, name)
			}
		}
	}
	return sim, err
}
