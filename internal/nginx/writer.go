package nginx

import (
	"strings"

	"offdock/internal/store"
)

// Apply writes the generated nginx config for the project to the system nginx
// sites-available directory, enables it, tests, and reloads nginx.
func Apply(cfg store.NginxConfig, projectName string) (*ApplyResult, error) {
	return ApplySystem(cfg, projectName)
}

// ApplyProxyHost writes and activates a nginx config for a ProxyHost.
func ApplyProxyHost(h store.ProxyHost) (*ApplyResult, error) {
	return ApplyProxyHostSystem(h)
}

// RemoveProxyHost deletes the nginx config for a ProxyHost and reloads nginx.
func RemoveProxyHost(domain string) error {
	return RemoveProxyHostSystem(domain)
}

// Remove deletes the nginx config for a project and reloads nginx.
func Remove(projectName string) error {
	return RemoveSystem(projectName)
}

// WriteDefaultServer writes the catch-all 444 default server to sites-available.
func WriteDefaultServer() error {
	return WriteSystemDefaultServer()
}

func sanitizeName(name string) string {
	r := strings.NewReplacer(" ", "-", "/", "-", "\\", "-", ".", "-")
	return strings.ToLower(r.Replace(name))
}
