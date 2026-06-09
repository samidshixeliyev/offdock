// Package config loads and exposes OffDock runtime configuration.
package config

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

// Config holds all runtime-configurable options.
type Config struct {
	Port           int    `yaml:"port"`
	DataDir        string `yaml:"data_dir"`
	LogDir         string `yaml:"log_dir"`
	LogLevel       string `yaml:"log_level"`
	JWTSecret      string `yaml:"jwt_secret"`
	DefaultPEMPath string `yaml:"default_pem_path"`

	// SMTP — used for OTP emails and DNS ticket notifications.
	// Supports Exchange/Outlook on-prem.
	// Mode: "starttls" (default, port 587), "implicit" (TLS from start, port 465), "plain" (no TLS)
	SMTPHost       string `yaml:"smtp_host"`
	SMTPPort       int    `yaml:"smtp_port"`
	SMTPUsername   string `yaml:"smtp_username"`
	SMTPPassword   string `yaml:"smtp_password"`
	SMTPFrom       string `yaml:"smtp_from"`
	SMTPMode       string `yaml:"smtp_mode"`              // "starttls" | "implicit" | "plain"
	SMTPStartTLS   bool   `yaml:"smtp_starttls"`          // legacy — maps to mode=starttls
	SMTPSkipVerify bool   `yaml:"smtp_insecure_skip_verify"`
	SMTPCACertFile string `yaml:"smtp_ca_cert_file"`      // path to custom CA cert PEM (Exchange self-signed)
	// Mutual TLS — some Exchange servers require a client certificate.
	SMTPClientCertFile string `yaml:"smtp_client_cert_file"`
	SMTPClientKeyFile  string `yaml:"smtp_client_key_file"`
	DNSAdminEmail      string `yaml:"dns_admin_email"`

	// OAuth2 / OIDC — AO ID identity provider integration.
	OAuthEnabled      bool   `yaml:"oauth_enabled"`
	OAuthIssuer       string `yaml:"oauth_issuer"`        // e.g. https://auth.ao.az
	OAuthClientID     string `yaml:"oauth_client_id"`
	OAuthClientSecret string `yaml:"oauth_client_secret"` // empty = public PKCE client
	OAuthRedirectURI  string `yaml:"oauth_redirect_uri"`  // must match IdP registration
	OAuthScope        string `yaml:"oauth_scope"`         // default "openid profile email"

	// Claim mapping — the minimal set OffDock needs: username, email, full name.
	// "sub" is always the standard OIDC subject claim and isn't configurable —
	// every compliant IdP, including AO IDP, returns it unconditionally.
	// Defaults match AO IDP's fixed /oauth2/userinfo response shape.
	OAuthClaimEmail    string `yaml:"oauth_claim_email"`    // default "email"
	OAuthClaimUsername string `yaml:"oauth_claim_username"` // default "ldap_username"
	OAuthClaimName     string `yaml:"oauth_claim_name"`     // default "display_name"

	// OAuth2 TLS — for IdP servers with self-signed / internal CA certificates.
	OAuthCACertFile    string `yaml:"oauth_ca_cert_file"`         // path to CA cert PEM
	OAuthTLSSkipVerify bool   `yaml:"oauth_tls_skip_verify"`      // skip TLS verify (not recommended)

	// OAuthPostLogoutRedirectURI is where the IdP redirects after RP-initiated logout.
	// Must be registered in the IdP's "Allowed logout URLs". If empty, derived from OAuthRedirectURI.
	OAuthPostLogoutRedirectURI string `yaml:"oauth_post_logout_redirect_uri"`
}

const defaultConfigPath = "/etc/offdock/config.yaml"

// Load reads the config file at path (falls back to defaults if the file is absent).
func Load(path string) (*Config, error) {
	cfg := defaults()

	if path == "" {
		path = defaultConfigPath
	}

	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		// Config file absent — enforce JWT secret requirement; empty secret allows token forgery.
		return nil, fmt.Errorf("config file not found at %s — run install.sh to initialise", path)
	}
	if err != nil {
		return nil, fmt.Errorf("reading config %s: %w", path, err)
	}

	if err := yaml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("parsing config %s: %w", path, err)
	}

	if cfg.JWTSecret == "" {
		return nil, fmt.Errorf("jwt_secret must be set in %s", path)
	}

	return cfg, nil
}

func defaults() *Config {
	return &Config{
		Port:         7070,
		DataDir:      "/var/offdock/data",
		LogDir:       "/var/offdock/logs",
		LogLevel:     "info",
		SMTPPort:     587,
		SMTPStartTLS: true,
	}
}
