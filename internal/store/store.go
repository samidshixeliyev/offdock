package store

import (
	"fmt"
	"os"
	"path/filepath"
)

// DB aggregates all typed collections and is the sole entry point for
// persistent storage across the application.
type DB struct {
	Users          *Collection[User]
	Projects       *Collection[Project]
	Images         *Collection[DockerImage]
	Compose        *Collection[ComposeConfig]
	EnvVars        *Collection[EnvVarSet]
	Nginx          *Collection[NginxConfig]
	Deployments    *Collection[DeploymentRecord]
	ProxyHosts     *Collection[ProxyHost]
	DeploySettings *Collection[DeploySettings]
	AuditEvents    *Collection[AuditEvent]
	CustomRoles    *Collection[CustomRole]
	Sessions       *Collection[Session]
	OTPChallenges  *Collection[OTPChallenge]
	DNSTickets     *Collection[DNSTicket]
	DeployTags     *Collection[DeployTag]
	TraceSessions  *Collection[TraceSession]
	TermPolicy     *Collection[TerminalPolicy]
	Backups        *Collection[BackupRecord]
	BackupSchedule *Collection[BackupSchedule]
}

// Open initialises all collections, creating data files if they do not exist.
func Open(dataDir string) (*DB, error) {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}

	open := func(name string) string {
		return filepath.Join(dataDir, name+".db")
	}

	db := &DB{}
	var err error

	if db.Users, err = NewCollection[User](open("users")); err != nil {
		return nil, err
	}
	if db.Projects, err = NewCollection[Project](open("projects")); err != nil {
		return nil, err
	}
	if db.Images, err = NewCollection[DockerImage](open("images")); err != nil {
		return nil, err
	}
	if db.Compose, err = NewCollection[ComposeConfig](open("compose")); err != nil {
		return nil, err
	}
	if db.EnvVars, err = NewCollection[EnvVarSet](open("envvars")); err != nil {
		return nil, err
	}
	if db.Nginx, err = NewCollection[NginxConfig](open("nginx")); err != nil {
		return nil, err
	}
	if db.Deployments, err = NewCollection[DeploymentRecord](open("deployments")); err != nil {
		return nil, err
	}
	if db.ProxyHosts, err = NewCollection[ProxyHost](open("proxyhosts")); err != nil {
		return nil, err
	}
	if db.DeploySettings, err = NewCollection[DeploySettings](open("deploy_settings")); err != nil {
		return nil, err
	}
	if db.AuditEvents, err = NewCollection[AuditEvent](open("audit_events")); err != nil {
		return nil, err
	}
	if db.CustomRoles, err = NewCollection[CustomRole](open("custom_roles")); err != nil {
		return nil, err
	}
	if db.Sessions, err = NewCollection[Session](open("sessions")); err != nil {
		return nil, err
	}
	if db.OTPChallenges, err = NewCollection[OTPChallenge](open("otp_challenges")); err != nil {
		return nil, err
	}
	if db.DNSTickets, err = NewCollection[DNSTicket](open("dns_tickets")); err != nil {
		return nil, err
	}
	if db.DeployTags, err = NewCollection[DeployTag](open("deploy_tags")); err != nil {
		return nil, err
	}
	if db.TraceSessions, err = NewCollection[TraceSession](open("trace_sessions")); err != nil {
		return nil, err
	}
	if db.TermPolicy, err = NewCollection[TerminalPolicy](open("term_policy")); err != nil {
		return nil, err
	}
	if db.Backups, err = NewCollection[BackupRecord](open("backups")); err != nil {
		return nil, err
	}
	if db.BackupSchedule, err = NewCollection[BackupSchedule](open("backup_schedule")); err != nil {
		return nil, err
	}

	return db, nil
}

// CompactResult reports the bytes reclaimed per collection during CompactAll.
type CompactResult struct {
	Collection string `json:"collection"`
	Reclaimed  int64  `json:"reclaimed_bytes"`
	Err        string `json:"error,omitempty"`
}

// CompactAll compacts every collection, dropping tombstones and superseded
// records. Errors on individual collections are reported but do not abort the
// rest. Returns per-collection results and the total bytes reclaimed.
func (db *DB) CompactAll() ([]CompactResult, int64) {
	type compactor struct {
		name string
		fn   func() (int64, error)
	}
	cs := []compactor{
		{"users", db.Users.Compact},
		{"projects", db.Projects.Compact},
		{"images", db.Images.Compact},
		{"compose", db.Compose.Compact},
		{"envvars", db.EnvVars.Compact},
		{"nginx", db.Nginx.Compact},
		{"deployments", db.Deployments.Compact},
		{"proxyhosts", db.ProxyHosts.Compact},
		{"deploy_settings", db.DeploySettings.Compact},
		{"audit_events", db.AuditEvents.Compact},
		{"custom_roles", db.CustomRoles.Compact},
		{"sessions", db.Sessions.Compact},
		{"otp_challenges", db.OTPChallenges.Compact},
		{"dns_tickets", db.DNSTickets.Compact},
		{"deploy_tags", db.DeployTags.Compact},
		{"trace_sessions", db.TraceSessions.Compact},
		{"term_policy", db.TermPolicy.Compact},
		{"backups", db.Backups.Compact},
		{"backup_schedule", db.BackupSchedule.Compact},
	}
	results := make([]CompactResult, 0, len(cs))
	var total int64
	for _, c := range cs {
		reclaimed, err := c.fn()
		res := CompactResult{Collection: c.name, Reclaimed: reclaimed}
		if err != nil {
			res.Err = err.Error()
		}
		total += reclaimed
		results = append(results, res)
	}
	return results, total
}

// Close releases all file handles. Must be called on shutdown.
func (db *DB) Close() error {
	closers := []interface{ Close() error }{
		db.Users, db.Projects, db.Images, db.Compose,
		db.EnvVars, db.Nginx, db.Deployments, db.ProxyHosts, db.DeploySettings,
		db.AuditEvents, db.CustomRoles, db.Sessions,
		db.OTPChallenges, db.DNSTickets, db.DeployTags, db.TraceSessions,
		db.TermPolicy, db.Backups, db.BackupSchedule,
	}
	for _, c := range closers {
		if err := c.Close(); err != nil {
			return err
		}
	}
	return nil
}
