// Package nginx generates, validates, and applies nginx reverse-proxy configs.
package nginx

import (
	"fmt"
	"strings"
	"text/template"
	"bytes"

	"offdock/internal/store"
)

var httpTmpl = template.Must(template.New("http").Parse(`server {
    listen 80;
    server_name {{ .Domain }};

    location / {
        proxy_pass http://{{ .UpstreamHost }}:{{ .UpstreamPort }};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
        proxy_connect_timeout 60s;
{{ if .CustomDirectives }}        {{ .CustomDirectives }}
{{ end }}    }
}
`))

var httpsTmpl = template.Must(template.New("https").Parse(`server {
    listen 80;
    server_name {{ .Domain }};
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name {{ .Domain }};

    ssl_certificate     {{ .SSLCertPath }};
    ssl_certificate_key {{ .SSLKeyPath }};
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 10m;

    location / {
        proxy_pass http://{{ .UpstreamHost }}:{{ .UpstreamPort }};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 60s;
        proxy_connect_timeout 60s;
{{ if .CustomDirectives }}        {{ .CustomDirectives }}
{{ end }}    }
}
`))

// Generate produces a nginx server block config string from cfg.
// Returns an error if required fields are missing or invalid.
func Generate(cfg store.NginxConfig) (string, error) {
	if err := validate(cfg); err != nil {
		return "", err
	}

	var buf bytes.Buffer
	tmpl := httpTmpl
	if cfg.SSLEnabled {
		tmpl = httpsTmpl
	}

	// Indent CustomDirectives properly
	cfg.CustomDirectives = strings.TrimSpace(cfg.CustomDirectives)

	if err := tmpl.Execute(&buf, cfg); err != nil {
		return "", fmt.Errorf("render nginx template: %w", err)
	}
	return buf.String(), nil
}

func validate(cfg store.NginxConfig) error {
	if strings.TrimSpace(cfg.Domain) == "" {
		return fmt.Errorf("domain is required")
	}
	if cfg.UpstreamPort < 1 || cfg.UpstreamPort > 65535 {
		return fmt.Errorf("upstream_port must be 1-65535, got %d", cfg.UpstreamPort)
	}
	if strings.TrimSpace(cfg.UpstreamHost) == "" {
		return fmt.Errorf("upstream_host is required")
	}
	if cfg.SSLEnabled {
		if strings.TrimSpace(cfg.SSLCertPath) == "" {
			return fmt.Errorf("ssl_cert_path is required when ssl_enabled")
		}
		if strings.TrimSpace(cfg.SSLKeyPath) == "" {
			return fmt.Errorf("ssl_key_path is required when ssl_enabled")
		}
	}
	return nil
}
