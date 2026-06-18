// Package security implements the command-execution policy for the host
// terminal exec endpoint. A denylist on a raw interactive shell is only
// advisory, but the non-PTY exec endpoint runs one command at a time and CAN be
// reliably vetted server-side — that is what this package enforces.
package security

import (
	"regexp"
	"strings"
)

// DefaultDenyPatterns are the always-on dangerous-command patterns. They block
// the most destructive operations regardless of any saved policy: removing
// Docker/nginx, wiping OffDock's data, formatting disks, fork bombs, and raw
// device writes.
var DefaultDenyPatterns = []string{
	`(?i)\bapt(-get)?\b.*\b(remove|purge|autoremove)\b`,
	`(?i)\bdpkg\b.*\b(-r|-P|--remove|--purge)\b`,
	`(?i)\bsnap\s+remove\b`,
	`(?i)\brm\b\s+(-[a-z]*\s+)*(/|/etc|/var/offdock|/usr/local/bin/offdock)(\s|$)`,
	`(?i)\bmkfs(\.\w+)?\b`,
	`(?i)\bdd\b.*\bof=/dev/`,
	`(?i)>\s*/dev/(sd|nvme|vd|xvd)`,
	`:\(\)\s*\{.*\}\s*;`, // classic fork bomb :(){ :|:& };:
	`(?i)\bsystemctl\s+(stop|disable|mask)\s+(docker|offdock|nginx)\b`,
	`(?i)\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b`,
}

// Policy is the resolved, compiled command policy.
type Policy struct {
	Mode            string // "denylist" (default) | "allowlist"
	deny            []*regexp.Regexp
	allow           []*regexp.Regexp
	restrictedPaths []string
}

// Compile builds a Policy from the built-in defaults plus the operator-provided
// extra patterns. Invalid regexes are skipped (never make the whole policy fail
// open or closed because of one typo).
func Compile(mode string, extraDeny, allow, restrictedPaths []string) *Policy {
	p := &Policy{Mode: mode, restrictedPaths: restrictedPaths}
	all := append([]string{}, DefaultDenyPatterns...)
	all = append(all, extraDeny...)
	for _, s := range all {
		if re, err := regexp.Compile(s); err == nil {
			p.deny = append(p.deny, re)
		}
	}
	for _, s := range allow {
		if re, err := regexp.Compile(s); err == nil {
			p.allow = append(p.allow, re)
		}
	}
	return p
}

// Check evaluates a command and working directory against the policy.
// Returns ok=false with a human-readable reason when the command is blocked.
func (p *Policy) Check(command, cwd string) (ok bool, reason string) {
	cmd := strings.TrimSpace(command)
	if cmd == "" {
		return true, ""
	}

	// Restricted path access (cwd or referenced in the command text).
	for _, rp := range p.restrictedPaths {
		rp = strings.TrimSpace(rp)
		if rp == "" {
			continue
		}
		if cwd == rp || strings.HasPrefix(cwd, rp+"/") || strings.Contains(cmd, rp) {
			return false, "access to restricted path is blocked: " + rp
		}
	}

	if p.Mode == "allowlist" {
		for _, re := range p.allow {
			if re.MatchString(cmd) {
				return true, ""
			}
		}
		return false, "command not in the allowlist"
	}

	// Denylist mode (default).
	for _, re := range p.deny {
		if re.MatchString(cmd) {
			return false, "command blocked by terminal policy: matches " + re.String()
		}
	}
	return true, ""
}
