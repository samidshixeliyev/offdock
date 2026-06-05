package store

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
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

	return db, nil
}

// Compact rewrites every collection file to remove tombstones and superseded
// records. Safe to call online; each collection is locked only for its own
// rewrite. Returns the first error encountered (remaining collections still run).
func (db *DB) Compact() error {
	collections := []interface{ Compact() error }{
		db.Users, db.Projects, db.Images, db.Compose,
		db.EnvVars, db.Nginx, db.Deployments, db.ProxyHosts, db.DeploySettings,
		db.AuditEvents, db.CustomRoles, db.Sessions,
		db.OTPChallenges, db.DNSTickets, db.DeployTags, db.TraceSessions,
	}
	for _, c := range collections {
		if err := c.Compact(); err != nil {
			return err
		}
	}
	return nil
}

// PruneTraceSessions deletes the oldest trace sessions, keeping at most `keep`
// sessions. Runs compaction afterward to reclaim disk space. Returns the count
// of sessions deleted. Safe to call concurrently.
func (db *DB) PruneTraceSessions(keep int) int {
	sessions, _ := db.TraceSessions.FindAll()
	if len(sessions) <= keep {
		return 0
	}
	sort.Slice(sessions, func(i, j int) bool {
		return sessions[i].StartedAt.Before(sessions[j].StartedAt)
	})
	deleted := 0
	for _, s := range sessions[:len(sessions)-keep] {
		if db.TraceSessions.Delete(s.ID) == nil {
			deleted++
		}
	}
	if deleted > 0 {
		_ = db.TraceSessions.Compact()
	}
	return deleted
}

// Close releases all file handles. Must be called on shutdown.
func (db *DB) Close() error {
	closers := []interface{ Close() error }{
		db.Users, db.Projects, db.Images, db.Compose,
		db.EnvVars, db.Nginx, db.Deployments, db.ProxyHosts, db.DeploySettings,
		db.AuditEvents, db.CustomRoles, db.Sessions,
		db.OTPChallenges, db.DNSTickets, db.DeployTags, db.TraceSessions,
	}
	for _, c := range closers {
		if err := c.Close(); err != nil {
			return err
		}
	}
	return nil
}
