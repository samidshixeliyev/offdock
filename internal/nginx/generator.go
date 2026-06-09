// Package nginx generates, validates, and applies nginx reverse-proxy configs.
package nginx

import (
	"bytes"
	"fmt"
	"strings"
	"text/template"

	"offdock/internal/store"
)

// extraLoc is a single extra location block used inside a template.
type extraLoc struct {
	Path          string
	PathTrimSlash string // path without trailing slash (for rewrite rule)
	VarName       string // nginx variable name, e.g. upstream_loc0
	Host          string
	Port          int
	Strip         bool
	WS            bool
	Timeout       string
}

// templateData is passed to nginx templates; extends NginxConfig with derived fields.
type templateData struct {
	store.NginxConfig
	ReadTimeout    string
	MaxBodySize    string
	CustomBlock    string
	AllServerNames string    // "domain alias1 alias2"
	ExtraLocations []extraLoc
	AccessLogLine  string
}

var httpTmpl = template.Must(template.New("http").Parse(`server {
    listen 80;
    server_name {{ .AllServerNames }};
    server_tokens off;
    client_max_body_size {{ .MaxBodySize }};
    {{ .AccessLogLine }}
{{ if .GzipEnabled }}
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml image/svg+xml;
    gzip_vary on;
    gzip_min_length 1024;
{{ end }}
{{ range .ExtraLocations }}    location {{ .Path }} {
{{ if .Strip }}        rewrite ^{{ .PathTrimSlash }}/?(.*)$ /$1 break;
{{ end }}        proxy_pass http://{{ .Host }}:{{ .Port }};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection {{ if .WS }}"upgrade"{{ else }}""{{ end }};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Port $server_port;
        proxy_read_timeout {{ .Timeout }}s;
        proxy_connect_timeout 10s;
        proxy_send_timeout {{ .Timeout }}s;
        proxy_buffering off;
    }
{{ end }}
    location / {
        proxy_pass http://{{ .UpstreamHost }}:{{ .UpstreamPort }};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Port $server_port;
        proxy_read_timeout {{ .ReadTimeout }}s;
        proxy_connect_timeout 10s;
        proxy_send_timeout {{ .ReadTimeout }}s;
        proxy_buffering off;
{{ if .CustomBlock }}{{ .CustomBlock }}
{{ end }}    }
}
`))

var httpsTmpl = template.Must(template.New("https").Parse(`server {
    listen 80;
    server_name {{ .AllServerNames }};
    server_tokens off;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name {{ .AllServerNames }};
    server_tokens off;
    client_max_body_size {{ .MaxBodySize }};
    {{ .AccessLogLine }}

    ssl_certificate     {{ .SSLCertPath }};
    ssl_certificate_key {{ .SSLKeyPath }};
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;
    ssl_prefer_server_ciphers off;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 10m;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options SAMEORIGIN always;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
{{ if .GzipEnabled }}
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml image/svg+xml;
    gzip_vary on;
    gzip_min_length 1024;
{{ end }}
{{ range .ExtraLocations }}    location {{ .Path }} {
{{ if .Strip }}        rewrite ^{{ .PathTrimSlash }}/?(.*)$ /$1 break;
{{ end }}        proxy_pass http://{{ .Host }}:{{ .Port }};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection {{ if .WS }}"upgrade"{{ else }}""{{ end }};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Port 443;
        proxy_read_timeout {{ .Timeout }}s;
        proxy_connect_timeout 10s;
        proxy_send_timeout {{ .Timeout }}s;
        proxy_buffering off;
    }
{{ end }}
    location / {
        proxy_pass http://{{ .UpstreamHost }}:{{ .UpstreamPort }};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Port 443;
        proxy_read_timeout {{ .ReadTimeout }}s;
        proxy_connect_timeout 10s;
        proxy_send_timeout {{ .ReadTimeout }}s;
        proxy_buffering off;
{{ if .CustomBlock }}{{ .CustomBlock }}
{{ end }}    }
}
`))

// Generate produces a nginx server block config string from cfg.
func Generate(cfg store.NginxConfig) (string, error) {
	cfg.Domain = SanitizeDomain(cfg.Domain)
	if err := validate(cfg); err != nil {
		return "", err
	}

	timeout := cfg.ProxyReadTimeout
	if timeout <= 0 {
		timeout = 60
	}
	timeoutStr := fmt.Sprintf("%d", timeout)

	maxBody := strings.TrimSpace(cfg.ClientMaxBodySize)
	if maxBody == "" {
		maxBody = "100m"
	}

	// Build server_name string — sanitize aliases to prevent template injection.
	serverNames := []string{cfg.Domain}
	for _, a := range cfg.Aliases {
		a = SanitizeDomain(a)
		if a != "" {
			serverNames = append(serverNames, a)
		}
	}
	allServerNames := strings.Join(serverNames, " ")

	// Build access_log directive.
	accessLogLine := "access_log off;"
	if cfg.AccessLog {
		accessLogLine = "access_log /var/log/nginx/" + sanitizeName(cfg.Domain) + ".access.log " + OffDockLogFormat + ";"
	}

	// Resolve PEM → cert/key before building template data so the template
	// renders the correct paths.
	if cfg.SSLEnabled {
		cfg.SSLCertPath, cfg.SSLKeyPath = resolveSSLPaths(cfg.SSLPEMPath, cfg.SSLCertPath, cfg.SSLKeyPath)
	}

	data := templateData{
		NginxConfig:    cfg,
		ReadTimeout:    timeoutStr,
		MaxBodySize:    maxBody,
		CustomBlock:    indentDirectives(normalizeDirectives(sanitizeDirectives(cfg.CustomDirectives))),
		AllServerNames: allServerNames,
		AccessLogLine:  accessLogLine,
	}

	var buf bytes.Buffer
	tmpl := httpTmpl
	if cfg.SSLEnabled {
		tmpl = httpsTmpl
	}
	if err := tmpl.Execute(&buf, data); err != nil {
		return "", fmt.Errorf("render nginx template: %w", err)
	}
	return buf.String(), nil
}

// GenerateProxyHost converts a ProxyHost to a NginxConfig and renders its config.
func GenerateProxyHost(h store.ProxyHost) (string, error) {
	certPath, keyPath := resolveSSLPaths(h.SSLPEMPath, h.SSLCertPath, h.SSLKeyPath)
	cfg := store.NginxConfig{
		Domain:            h.Domain,
		Aliases:           h.Aliases,
		UpstreamHost:      h.UpstreamHost,
		UpstreamPort:      h.UpstreamPort,
		SSLEnabled:        h.SSLEnabled,
		SSLCertPath:       certPath,
		SSLKeyPath:        keyPath,
		ClientMaxBodySize: h.ClientMaxBodySize,
		ProxyReadTimeout:  h.ProxyReadTimeout,
		GzipEnabled:       h.GzipEnabled,
		CustomDirectives:  h.CustomDirectives,
		AccessLog:         h.AccessLog,
	}
	cfg.Domain = SanitizeDomain(cfg.Domain)
	if err := validate(cfg); err != nil {
		return "", err
	}

	timeout := cfg.ProxyReadTimeout
	if timeout <= 0 {
		timeout = 60
	}
	timeoutStr := fmt.Sprintf("%d", timeout)

	maxBody := strings.TrimSpace(cfg.ClientMaxBodySize)
	if maxBody == "" {
		maxBody = "100m"
	}

	serverNames := []string{cfg.Domain}
	for _, a := range h.Aliases {
		a = SanitizeDomain(a)
		if a != "" {
			serverNames = append(serverNames, a)
		}
	}

	accessLogLine := "access_log off;"
	if cfg.AccessLog {
		accessLogLine = "access_log /var/log/nginx/" + sanitizeName(cfg.Domain) + ".access.log " + OffDockLogFormat + ";"
	}

	// Build extra location blocks.
	locs := make([]extraLoc, 0, len(h.Locations))
	for i, l := range h.Locations {
		path := strings.TrimSpace(l.Path)
		if path == "" || path == "/" {
			continue // skip — that's the default location
		}
		if !strings.HasPrefix(path, "/") {
			path = "/" + path
		}
		trimmed := strings.TrimRight(path, "/")
		if trimmed == "" {
			trimmed = "/"
		}
		locs = append(locs, extraLoc{
			Path:          path,
			PathTrimSlash: trimmed,
			VarName:       fmt.Sprintf("upstream_loc%d", i),
			Host:          strings.TrimSpace(l.UpstreamHost),
			Port:          l.UpstreamPort,
			Strip:         l.StripPrefix,
			WS:            l.WSEnabled,
			Timeout:       timeoutStr,
		})
	}

	data := templateData{
		NginxConfig:    cfg,
		ReadTimeout:    timeoutStr,
		MaxBodySize:    maxBody,
		CustomBlock:    indentDirectives(normalizeDirectives(sanitizeDirectives(cfg.CustomDirectives))),
		AllServerNames: strings.Join(serverNames, " "),
		ExtraLocations: locs,
		AccessLogLine:  accessLogLine,
	}

	var buf bytes.Buffer
	tmpl := httpTmpl
	if cfg.SSLEnabled {
		tmpl = httpsTmpl
	}
	if err := tmpl.Execute(&buf, data); err != nil {
		return "", fmt.Errorf("render nginx template: %w", err)
	}
	return buf.String(), nil
}

// GenerateDefaultServer returns a catch-all server block that drops unknown requests.
func GenerateDefaultServer() string {
	return `# offdock-generated — default catch-all server
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    server_tokens off;
    return 444;
}
`
}

// SanitizeDomain strips protocol prefixes and trailing slashes.
func SanitizeDomain(d string) string {
	d = strings.TrimSpace(d)
	lower := strings.ToLower(d)
	for _, pfx := range []string{"https://", "http://", "https//", "http//"} {
		if strings.HasPrefix(lower, pfx) {
			d = d[len(pfx):]
			break
		}
	}
	return strings.TrimRight(strings.TrimSpace(d), "/")
}

// sanitizeDirectives strips nginx directives that could expose files or bypass
// the proxy config. Admins can still add valid tuning directives.
func sanitizeDirectives(s string) string {
	blocked := []string{"include", "alias", "root", "auth_basic", "lua_", "perl_", "map "}
	var out []string
	for _, line := range strings.Split(s, "\n") {
		trimmed := strings.TrimSpace(strings.ToLower(line))
		safe := true
		for _, b := range blocked {
			if strings.HasPrefix(trimmed, b) {
				safe = false
				break
			}
		}
		if safe {
			out = append(out, line)
		}
	}
	return strings.Join(out, "\n")
}

func normalizeDirectives(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	var out []string
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			out = append(out, line)
			continue
		}
		if !strings.HasSuffix(line, ";") &&
			!strings.HasSuffix(line, "{") &&
			!strings.HasSuffix(line, "}") {
			line += ";"
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n")
}

func indentDirectives(s string) string {
	if s == "" {
		return ""
	}
	var out []string
	for _, line := range strings.Split(s, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		out = append(out, "        "+line)
	}
	return strings.Join(out, "\n")
}

// resolveSSLPaths returns (certPath, keyPath) from a config, preferring the
// combined PEM file over separate cert/key files.
func resolveSSLPaths(pemPath, certPath, keyPath string) (string, string) {
	if strings.TrimSpace(pemPath) != "" {
		return pemPath, pemPath
	}
	return certPath, keyPath
}

func validate(cfg store.NginxConfig) error {
	if strings.TrimSpace(cfg.Domain) == "" {
		return fmt.Errorf("domain is required")
	}
	if strings.ContainsAny(cfg.Domain, ":/\\ \t\n;{}") {
		return fmt.Errorf("domain %q must not contain special characters — enter only the hostname, e.g. app.example.com", cfg.Domain)
	}
	if cfg.UpstreamPort < 1 || cfg.UpstreamPort > 65535 {
		return fmt.Errorf("upstream_port must be 1–65535, got %d", cfg.UpstreamPort)
	}
	if strings.TrimSpace(cfg.UpstreamHost) == "" {
		return fmt.Errorf("upstream_host is required")
	}
	if strings.ContainsAny(cfg.UpstreamHost, "\n;{}") {
		return fmt.Errorf("upstream_host %q contains invalid characters", cfg.UpstreamHost)
	}
	if cfg.SSLEnabled {
		cert, key := resolveSSLPaths(cfg.SSLPEMPath, cfg.SSLCertPath, cfg.SSLKeyPath)
		if strings.TrimSpace(cert) == "" || strings.TrimSpace(key) == "" {
			return fmt.Errorf("ssl_pem_path (or ssl_cert_path + ssl_key_path) is required when SSL is enabled")
		}
	}
	return nil
}
