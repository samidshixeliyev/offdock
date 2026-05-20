package store

import "time"

// --- User -------------------------------------------------------------------

type Role string

const (
	RoleSuperAdmin Role = "superadmin"
	RoleAdmin      Role = "admin"
	RoleViewer     Role = "viewer"
)

// User represents an OffDock operator account.
type User struct {
	ID           string    `json:"id"`
	Username     string    `json:"username"`
	PasswordHash string    `json:"password_hash"`
	Role         Role      `json:"role"`
	CreatedBy    string    `json:"created_by"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
	Active       bool      `json:"active"`
}

func (u User) GetID() string { return u.ID }

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
	ID               string    `json:"id"`
	ProjectID        string    `json:"project_id"`
	Domain           string    `json:"domain"`
	SSLEnabled       bool      `json:"ssl_enabled"`
	SSLCertPath      string    `json:"ssl_cert_path"`
	SSLKeyPath       string    `json:"ssl_key_path"`
	UpstreamHost     string    `json:"upstream_host"`
	UpstreamPort     int       `json:"upstream_port"`
	CustomDirectives string    `json:"custom_directives"`
	GeneratedConfig  string    `json:"generated_config"`
	Active           bool      `json:"active"`
	CreatedAt        time.Time `json:"created_at"`
}

func (n NginxConfig) GetID() string { return n.ID }

// --- DeploymentRecord -------------------------------------------------------

type DeploymentStatus string

const (
	DeployStatusPending DeploymentStatus = "pending"
	DeployStatusRunning DeploymentStatus = "running"
	DeployStatusSuccess DeploymentStatus = "success"
	DeployStatusFailed  DeploymentStatus = "failed"
)

// DeploymentRecord tracks a single deployment attempt for a project.
type DeploymentRecord struct {
	ID                string           `json:"id"`
	ProjectID         string           `json:"project_id"`
	TriggeredBy       string           `json:"triggered_by"`
	Strategy          string           `json:"strategy"`
	OldComposeVersion int              `json:"old_compose_version"`
	NewComposeVersion int              `json:"new_compose_version"`
	Status            DeploymentStatus `json:"status"`
	StartedAt         time.Time        `json:"started_at"`
	FinishedAt        *time.Time       `json:"finished_at"`
	LogText           string           `json:"log_text"`
}

func (d DeploymentRecord) GetID() string { return d.ID }
