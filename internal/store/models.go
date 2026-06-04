package store

import "time"

// --- User -------------------------------------------------------------------

type Role string

const (
	RoleSuperAdmin Role = "superadmin"
	RoleAdmin      Role = "admin"
	RoleViewer     Role = "viewer"
)

// Permission is a granular capability that can be granted to a user/role.
type Permission string

const (
	PermDeploy         Permission = "deploy"           // trigger/cancel deployments
	PermEditCompose    Permission = "edit_compose"     // edit compose configs
	PermEditEnv        Permission = "edit_env"         // edit env vars
	PermManageProxy    Permission = "manage_proxy"     // proxy hosts + nginx
	PermManageNetwork  Permission = "manage_network"   // docker networks/volumes
	PermManageImages   Permission = "manage_images"    // load/delete images
	PermContainerOps   Permission = "container_ops"    // start/stop/restart/delete containers
	PermTerminal       Permission = "terminal"         // exec shells / run commands
	PermManageFiles    Permission = "manage_files"     // write/delete files
	PermManageProjects Permission = "manage_projects"  // create/delete projects
	PermManageDNS      Permission = "manage_dns"       // create/manage DNS tickets
)

// AllPermissions lists every grantable capability (for UI + validation).
var AllPermissions = []Permission{
	PermManageProjects, PermDeploy, PermEditCompose, PermEditEnv,
	PermManageProxy, PermManageNetwork, PermManageImages,
	PermContainerOps, PermTerminal, PermManageFiles, PermManageDNS,
}

// User represents an OffDock operator account.
type User struct {
	ID           string    `json:"id"`
	Username     string    `json:"username"`
	Email        string    `json:"email"`
	PasswordHash string    `json:"password_hash"`
	Role         Role      `json:"role"`
	// CustomRoleID, when set, points to a CustomRole whose permissions apply.
	CustomRoleID string `json:"custom_role_id"`
	// Permissions, when non-empty, are explicit per-user grants that override
	// both the built-in role defaults and any custom role.
	Permissions []Permission `json:"permissions"`
	// ProjectIDs scopes the user to specific projects. Empty = all projects.
	ProjectIDs []string `json:"project_ids"`
	// OAuthSubject is the IdP "sub" claim used to link OAuth2 logins to this account.
	OAuthSubject  string `json:"oauth_subject"`
	OAuthProvider string `json:"oauth_provider"` // e.g. "ao_id"
	CreatedBy     string `json:"created_by"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
	Active        bool      `json:"active"`
}

func (u User) GetID() string { return u.ID }

// CustomRole is a named, superadmin-defined permission set.
type CustomRole struct {
	ID          string       `json:"id"`
	Name        string       `json:"name"`
	Permissions []Permission `json:"permissions"`
	CreatedAt   time.Time    `json:"created_at"`
	UpdatedAt   time.Time    `json:"updated_at"`
}

func (c CustomRole) GetID() string { return c.ID }

// Session is a server-side record of an issued JWT, enabling revocation and
// active-session auditing. The session ID is embedded in the JWT ("sid").
type Session struct {
	ID        string    `json:"id"`
	UserID    string    `json:"user_id"`
	Username  string    `json:"username"`
	IP        string    `json:"ip"`
	UserAgent string    `json:"user_agent"`
	CreatedAt time.Time `json:"created_at"`
	LastSeen  time.Time `json:"last_seen"`
	Revoked   bool      `json:"revoked"`
}

func (s Session) GetID() string { return s.ID }

// --- Project ----------------------------------------------------------------

type ProjectStatus string

const (
	ProjectStatusRunning  ProjectStatus = "running"
	ProjectStatusStopped  ProjectStatus = "stopped"
	ProjectStatusError    ProjectStatus = "error"
	ProjectStatusDegraded ProjectStatus = "degraded"
)

// Project is a logical grouping of Docker compose services.
type Project struct {
	ID          string        `json:"id"`
	Name        string        `json:"name"`
	Description string        `json:"description"`
	Status      ProjectStatus `json:"status"`
	CreatedAt   time.Time     `json:"created_at"`
	UpdatedAt   time.Time     `json:"updated_at"`
}

func (p Project) GetID() string { return p.ID }

// --- DockerImage ------------------------------------------------------------

// DockerImage records a tar image that has been loaded into the Docker daemon.
type DockerImage struct {
	ID            string    `json:"id"`
	ProjectID     string    `json:"project_id"`
	ImageName     string    `json:"image_name"`
	ImageTag      string    `json:"image_tag"`
	TarFilePath   string    `json:"tar_file_path"`
	LoadedAt      time.Time `json:"loaded_at"`
	SizeBytes     int64     `json:"size_bytes"`
	DockerImageID string    `json:"docker_image_id"`
}

func (d DockerImage) GetID() string { return d.ID }

// --- ComposeConfig ----------------------------------------------------------

// ComposeConfig holds a versioned docker-compose YAML for a project.
type ComposeConfig struct {
	ID        string    `json:"id"`
	ProjectID string    `json:"project_id"`
	Version   int       `json:"version"`
	RawYAML   string    `json:"raw_yaml"`
	CreatedAt time.Time `json:"created_at"`
	CreatedBy string    `json:"created_by"`
}

func (c ComposeConfig) GetID() string { return c.ID }

// --- EnvVarSet --------------------------------------------------------------

// EnvVar is a single key/value pair; Value is AES-256-GCM encrypted at rest.
type EnvVar struct {
	Key      string `json:"key"`
	Value    string `json:"value"`
	IsSecret bool   `json:"is_secret"`
}

// EnvVarSet holds a versioned snapshot of environment variables for a project.
type EnvVarSet struct {
	ID        string    `json:"id"`
	ProjectID string    `json:"project_id"`
	Version   int       `json:"version"`
	Vars      []EnvVar  `json:"vars"`
	CreatedAt time.Time `json:"created_at"`
	CreatedBy string    `json:"created_by"`
}

func (e EnvVarSet) GetID() string { return e.ID }

// --- NginxConfig ------------------------------------------------------------

// NginxConfig holds the nginx reverse-proxy settings for a project.
type NginxConfig struct {
	ID                string     `json:"id"`
	ProjectID         string     `json:"project_id"`
	Domain            string     `json:"domain"`
	Aliases           []string   `json:"aliases"`
	SSLEnabled        bool       `json:"ssl_enabled"`
	SSLPEMPath        string     `json:"ssl_pem_path"`  // combined cert+key PEM; takes priority over cert/key
	SSLCertPath       string     `json:"ssl_cert_path"` // legacy — use SSLPEMPath instead
	SSLKeyPath        string     `json:"ssl_key_path"`  // legacy — use SSLPEMPath instead
	UpstreamHost      string     `json:"upstream_host"`
	UpstreamPort      int        `json:"upstream_port"`
	ClientMaxBodySize string     `json:"client_max_body_size"` // e.g. "10m", "1g"; empty = "1m"
	ProxyReadTimeout  int        `json:"proxy_read_timeout"`   // seconds; 0 = 60
	GzipEnabled       bool       `json:"gzip_enabled"`
	CustomDirectives  string     `json:"custom_directives"`
	AccessLog         bool       `json:"access_log"`
	GeneratedConfig   string     `json:"generated_config"`
	Active            bool       `json:"active"`
	Applied           bool       `json:"applied"`    // true once written to /etc/nginx and reloaded
	AppliedAt         *time.Time `json:"applied_at"` // nil if never applied
	CreatedAt         time.Time  `json:"created_at"`
}

func (n NginxConfig) GetID() string { return n.ID }

// --- DeploymentRecord -------------------------------------------------------

type DeploymentStatus string

const (
	DeployStatusPending   DeploymentStatus = "pending"
	DeployStatusRunning   DeploymentStatus = "running"
	DeployStatusSuccess   DeploymentStatus = "success"
	DeployStatusFailed    DeploymentStatus = "failed"
	DeployStatusCancelled DeploymentStatus = "cancelled"
)

// DeploymentRecord tracks a single deployment attempt for a project.
type DeploymentRecord struct {
	ID                string           `json:"id"`
	ProjectID         string           `json:"project_id"`
	TriggeredBy       string           `json:"triggered_by"`
	Strategy          string           `json:"strategy"`
	OldComposeVersion int              `json:"old_compose_version"`
	NewComposeVersion int              `json:"new_compose_version"`
	EnvVersion        int              `json:"env_version"` // env snapshot used; 0 = none
	Status            DeploymentStatus `json:"status"`
	StartedAt         time.Time        `json:"started_at"`
	FinishedAt        *time.Time       `json:"finished_at"`
	LogText           string           `json:"log_text"`
}

func (d DeploymentRecord) GetID() string { return d.ID }

// --- DeploySettings ---------------------------------------------------------

// DeploySettings holds per-project deployment behaviour configuration.
// ID is always equal to ProjectID (one record per project).
type DeploySettings struct {
	ID                string `json:"id"`
	ProjectID         string `json:"project_id"`
	HealthTimeoutSecs int    `json:"health_timeout_secs"` // default 120
	DeployTimeoutSecs int    `json:"deploy_timeout_secs"` // default 300
	HealthStableSecs  int    `json:"health_stable_secs"`  // default 5
}

func (d DeploySettings) GetID() string { return d.ID }

// --- ProxyHost ---------------------------------------------------------------

// ProxyLocation is a path-based routing rule within a ProxyHost virtual host.
type ProxyLocation struct {
	Path         string `json:"path" msgpack:"path"`
	UpstreamHost string `json:"upstream_host" msgpack:"upstream_host"`
	UpstreamPort int    `json:"upstream_port" msgpack:"upstream_port"`
	StripPrefix  bool   `json:"strip_prefix" msgpack:"strip_prefix"`
	WSEnabled    bool   `json:"ws_enabled" msgpack:"ws_enabled"`
}

// ProxyHost is an nginx reverse-proxy virtual host managed directly by OffDock.
// It is independent of any project and maps a domain to an upstream container.
type ProxyHost struct {
	ID                string          `json:"id" msgpack:"id"`
	Domain            string          `json:"domain" msgpack:"domain"`
	Aliases           []string        `json:"aliases" msgpack:"aliases"`
	UpstreamHost      string          `json:"upstream_host" msgpack:"upstream_host"`
	UpstreamPort      int             `json:"upstream_port" msgpack:"upstream_port"`
	SSLEnabled        bool            `json:"ssl_enabled" msgpack:"ssl_enabled"`
	SSLPEMPath        string          `json:"ssl_pem_path" msgpack:"ssl_pem_path"`   // combined cert+key PEM
	SSLCertPath       string          `json:"ssl_cert_path" msgpack:"ssl_cert_path"`  // legacy
	SSLKeyPath        string          `json:"ssl_key_path" msgpack:"ssl_key_path"`    // legacy
	ClientMaxBodySize string          `json:"client_max_body_size" msgpack:"client_max_body_size"`
	ProxyReadTimeout  int             `json:"proxy_read_timeout" msgpack:"proxy_read_timeout"`
	GzipEnabled       bool            `json:"gzip_enabled" msgpack:"gzip_enabled"`
	CustomDirectives  string          `json:"custom_directives" msgpack:"custom_directives"`
	Locations         []ProxyLocation `json:"locations" msgpack:"locations"`
	AccessLog         bool            `json:"access_log" msgpack:"access_log"`
	Enabled           bool            `json:"enabled" msgpack:"enabled"`
	CreatedAt         time.Time       `json:"created_at" msgpack:"created_at"`
	UpdatedAt         time.Time       `json:"updated_at" msgpack:"updated_at"`
}

func (p ProxyHost) GetID() string { return p.ID }

// --- AuditEvent -------------------------------------------------------------

// AuditEvent records a user action for the audit trail.
type AuditEvent struct {
	ID           string    `json:"id" msgpack:"id"`
	UserID       string    `json:"user_id" msgpack:"user_id"`
	Username     string    `json:"username" msgpack:"username"`
	Action       string    `json:"action" msgpack:"action"`               // e.g. "login", "deploy", "create_project"
	ResourceType string    `json:"resource_type" msgpack:"resource_type"` // "project", "user", "proxy_host", etc.
	ResourceID   string    `json:"resource_id" msgpack:"resource_id"`
	ResourceName string    `json:"resource_name" msgpack:"resource_name"`
	Details      string    `json:"details" msgpack:"details"`
	IPAddr       string    `json:"ip_addr" msgpack:"ip_addr"`
	CreatedAt    time.Time `json:"created_at" msgpack:"created_at"`
}

func (a AuditEvent) GetID() string { return a.ID }

// --- OTPChallenge -----------------------------------------------------------

// OTPChallenge stores a one-time password issued for root terminal access.
// The code is stored as a bcrypt-style hash; plaintext is emailed and never persisted.
type OTPChallenge struct {
	ID        string    `json:"id" msgpack:"id"`
	UserID    string    `json:"user_id" msgpack:"user_id"`
	CodeHash  string    `json:"code_hash" msgpack:"code_hash"`
	Purpose   string    `json:"purpose" msgpack:"purpose"` // "terminal"
	ExpiresAt time.Time `json:"expires_at" msgpack:"expires_at"`
	Used      bool      `json:"used" msgpack:"used"`
	CreatedAt time.Time `json:"created_at" msgpack:"created_at"`
}

func (o OTPChallenge) GetID() string { return o.ID }

// --- DNSTicket --------------------------------------------------------------

type DNSTicketStatus string

const (
	DNSTicketPending  DNSTicketStatus = "pending"
	DNSTicketSent     DNSTicketStatus = "sent"
	DNSTicketApproved DNSTicketStatus = "approved"
	DNSTicketRejected DNSTicketStatus = "rejected"
)

// DNSTicket is a request to create a DNS record, emailed to the DNS admin.
type DNSTicket struct {
	ID          string          `json:"id" msgpack:"id"`
	RecordType  string          `json:"record_type" msgpack:"record_type"` // A, CNAME, TXT, MX, SRV...
	Hostname    string          `json:"hostname" msgpack:"hostname"`
	Value       string          `json:"value" msgpack:"value"`
	TTL         int             `json:"ttl" msgpack:"ttl"` // seconds, 0 = default
	Priority    int             `json:"priority" msgpack:"priority"` // for MX/SRV
	Notes       string          `json:"notes" msgpack:"notes"`
	Status      DNSTicketStatus `json:"status" msgpack:"status"`
	RequestedBy string          `json:"requested_by" msgpack:"requested_by"`
	EmailSentTo string          `json:"email_sent_to" msgpack:"email_sent_to"`
	CreatedAt   time.Time       `json:"created_at" msgpack:"created_at"`
	UpdatedAt   time.Time       `json:"updated_at" msgpack:"updated_at"`
}

func (d DNSTicket) GetID() string { return d.ID }

// --- TraceSession -----------------------------------------------------------

// TraceEvent mirrors a single TraceSpan captured during a container trace.
// It is persisted as part of a TraceSession so traces survive browser close.
type TraceEvent struct {
	Time       string  `json:"time" msgpack:"time"`
	Type       string  `json:"type" msgpack:"type"`
	Method     string  `json:"method,omitempty" msgpack:"method,omitempty"`
	Path       string  `json:"path,omitempty" msgpack:"path,omitempty"`
	Host       string  `json:"host,omitempty" msgpack:"host,omitempty"`
	Status     int     `json:"status,omitempty" msgpack:"status,omitempty"`
	DurationMs float64 `json:"duration_ms,omitempty" msgpack:"duration_ms,omitempty"`
	Query      string  `json:"query,omitempty" msgpack:"query,omitempty"`
	DBType     string  `json:"db_type,omitempty" msgpack:"db_type,omitempty"`
	Src        string  `json:"src,omitempty" msgpack:"src,omitempty"`
	Dst        string  `json:"dst,omitempty" msgpack:"dst,omitempty"`
	DstPort    int     `json:"dst_port,omitempty" msgpack:"dst_port,omitempty"`
	Message    string  `json:"message,omitempty" msgpack:"message,omitempty"`
}

// TraceSession is a persisted record of a container trace session, including
// every captured event. Created when a trace stream opens, finalised on close.
type TraceSession struct {
	ID            string       `json:"id" msgpack:"id"`
	ContainerName string       `json:"container_name" msgpack:"container_name"`
	StartedAt     time.Time    `json:"started_at" msgpack:"started_at"`
	EndedAt       *time.Time   `json:"ended_at" msgpack:"ended_at"`
	EventCount    int          `json:"event_count" msgpack:"event_count"`
	Events        []TraceEvent `json:"events" msgpack:"events"`
}

func (t TraceSession) GetID() string { return t.ID }

// --- SMTPConfig (runtime, from config.yaml via handlers) --------------------

// SMTPSettings mirrors the SMTP fields from Config for passing to handlers.
type SMTPSettings struct {
	Host           string
	Port           int
	Username       string
	Password       string
	From           string
	Mode           string // "starttls" | "implicit" | "plain"
	StartTLS       bool   // legacy
	SkipVerify     bool
	CACertFile     string // path to custom CA cert PEM
	ClientCertFile string // path to client cert PEM (mutual TLS)
	ClientKeyFile  string // path to client key PEM (mutual TLS)
	AdminEmail     string
}

// SMTPMode returns the effective connection mode.
func (s SMTPSettings) SMTPMode() string {
	if s.Mode != "" {
		return s.Mode
	}
	if s.StartTLS {
		return "starttls"
	}
	return "plain"
}

// DeployTag is a named label attached to a specific compose+env version combination
// for easy identification and rollback targeting.
type DeployTag struct {
	ID             string    `json:"id" msgpack:"id"`
	ProjectID      string    `json:"project_id" msgpack:"project_id"`
	Name           string    `json:"name" msgpack:"name"`               // e.g. "v1.0.0", "stable"
	Description    string    `json:"description" msgpack:"description"` // optional notes
	ComposeVersion int       `json:"compose_version" msgpack:"compose_version"`
	EnvVersion     int       `json:"env_version" msgpack:"env_version"`
	CreatedBy      string    `json:"created_by" msgpack:"created_by"`
	CreatedAt      time.Time `json:"created_at" msgpack:"created_at"`
}

func (d DeployTag) GetID() string { return d.ID }

// OAuthSettings mirrors the OAuth2 fields from Config for passing to handlers.
type OAuthSettings struct {
	Enabled      bool
	Issuer       string
	ClientID     string
	ClientSecret string
	RedirectURI  string
	Scope        string
	// Claim mappings — configurable JWT/userinfo claim names.
	ClaimSub      string // default "sub"
	ClaimEmail    string // default "email"
	ClaimUsername string // default "ldap_username"
	ClaimName     string // default "display_name"
	// TLS
	CACertFile    string // path to custom CA cert for IdP (self-signed Exchange/internal)
	TLSSkipVerify bool   // skip TLS verification
}

// EffectiveClaimNames returns the resolved claim names, applying defaults
// when a field is empty.
func (s OAuthSettings) EffectiveClaimNames() (sub, email, username, name string) {
	sub = s.ClaimSub
	if sub == "" {
		sub = "sub"
	}
	email = s.ClaimEmail
	if email == "" {
		email = "email"
	}
	username = s.ClaimUsername
	if username == "" {
		username = "ldap_username"
	}
	name = s.ClaimName
	if name == "" {
		name = "display_name"
	}
	return
}
