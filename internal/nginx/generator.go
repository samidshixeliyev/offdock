// Package nginx generates, validates, and applies nginx reverse-proxy configs.
package nginx

import (
	"bytes"
	"fmt"
	"strings"
	"text/template"

	"offdock/internal/store"
)

// templateData is passed to nginx templates; extends NginxConfig with derived fields.
type templateData struct {
	store.NginxConfig
	ReadTimeout string // formatted, e.g. "60"
	MaxBodySize string // e.g. "10m"
	CustomBlock string // indented, semicolon-normalised custom directives
}

var httpTmpl = template.Must(template.New("http").Parse(`server {
    listen 80;
    server_name {{ .Domain }};
    server_tokens off;
    client_max_body_size {{ .MaxBodySize }};
{{ if .GzipEnabled }}
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml image/svg+xml;
    gzip_vary on;
    gzip_min_length 1024;
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
    server_name {{ .Domain }};
    server_tokens off;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name {{ .Domain }};
    server_tokens off;
    client_max_body_size {{ .MaxBodySize }};

    ssl_certificate     {{ .SSLCertPath }};
    ssl_certificate_key {{ .SSLKeyPath }};
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;
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
    location / {
        proxy_pass http://{{ .UpstreamHost }}:{{ .UpstreamPort }};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout {{ .ReadTimeout }}s;
        proxy_connect_timeout 10s;
        proxy_send_timeout {{ .ReadTimeout }}s;
        proxy_buffering off;
{{ if .CustomBlock }}{{ .CustomBlock }}
{{ end }}    }
}
`))

// Generate produces a nginx server block config string from cfg.
// The domain is sanitized (protocol stripped) and custom directives are
// normalised (semicolons added, lines indented to 8 spaces).
func Generate(cfg store.NginxConfig) (string, error) {
	cfg.Domain = SanitizeDomain(cfg.Domain)
	if err := validate(cfg); err != nil {
		return "", err
	}

	timeout := cfg.ProxyReadTimeout
	if timeout <= 0 {
		timeout = 60
	}
	maxBody := strings.TrimSpace(cfg.ClientMaxBodySize)
	if maxBody == "" {
		maxBody = "1m"
	}

	data := templateData{
		NginxConfig: cfg,
		ReadTimeout: fmt.Sprintf("%d", timeout),
		MaxBodySize: maxBody,
		CustomBlock: indentDirectives(normalizeDirectives(cfg.CustomDirectives)),
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

// SanitizeDomain strips protocol prefixes (http://, https://) and trailing slashes/spaces.
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

// normalizeDirectives ensures each nginx directive line ends with a semicolon.
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
		// Don't add semicolons to block starters/enders.
		if !strings.HasSuffix(line, ";") &&
			!strings.HasSuffix(line, "{") &&
			!strings.HasSuffix(line, "}") {
			line += ";"
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n")
}

// indentDirectives adds 8-space indent to each non-empty line.
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

func validate(cfg store.NginxConfig) error {
	if strings.TrimSpace(cfg.Domain) == "" {
		return fmt.Errorf("domain is required")
	}
	// Reject any remaining protocol/path markers after sanitization.
	if strings.ContainsAny(cfg.Domain, ":/\\") {
		return fmt.Errorf("domain %q must not contain protocol or path — enter only the hostname, e.g. app.example.com", cfg.Domain)
	}
	if cfg.UpstreamPort < 1 || cfg.UpstreamPort > 65535 {
		return fmt.Errorf("upstream_port must be 1–65535, got %d", cfg.UpstreamPort)
	}
	if strings.TrimSpace(cfg.UpstreamHost) == "" {
		return fmt.Errorf("upstream_host is required")
	}
	if cfg.SSLEnabled {
		if strings.TrimSpace(cfg.SSLCertPath) == "" {
			return fmt.Errorf("ssl_cert_path is required when SSL is enabled")
		}
		if strings.TrimSpace(cfg.SSLKeyPath) == "" {
			return fmt.Errorf("ssl_key_path is required when SSL is enabled")
		}
	}
	return nil
}
