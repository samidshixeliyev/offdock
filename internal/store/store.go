package store

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"
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
	OTelSpans      *Collection[OTelSpan]
	TermPolicy     *Collection[TerminalPolicy]
	Backups        *Collection[BackupRecord]
	BackupSchedule *Collection[BackupSchedule]
	NginxCustom    *Collection[NginxCustomConfig]
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
	if db.OTelSpans, err = NewCollection[OTelSpan](open("otel_spans")); err != nil {
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
	if db.NginxCustom, err = NewCollection[NginxCustomConfig](open("nginx_custom")); err != nil {
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
		{"otel_spans", db.OTelSpans.Compact},
		{"term_policy", db.TermPolicy.Compact},
		{"backups", db.Backups.Compact},
		{"backup_schedule", db.BackupSchedule.Compact},
		{"nginx_custom", db.NginxCustom.Compact},
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

// Compact rewrites every collection file to remove tombstones and superseded
// records. Safe to call online; each collection is locked only for its own
// rewrite. Returns the first error encountered (remaining collections still run).
func (db *DB) Compact() error {
	collections := []interface{ Compact() (int64, error) }{
		db.Users, db.Projects, db.Images, db.Compose,
		db.EnvVars, db.Nginx, db.Deployments, db.ProxyHosts, db.DeploySettings,
		db.AuditEvents, db.CustomRoles, db.Sessions,
		db.OTPChallenges, db.DNSTickets, db.DeployTags, db.TraceSessions, db.OTelSpans,
		db.TermPolicy, db.Backups, db.BackupSchedule, db.NginxCustom,
	}
	for _, c := range collections {
		if _, err := c.Compact(); err != nil {
			return err
		}
	}
	return nil
}

// PruneOTelSpans deletes the oldest OTel spans keeping at most `keep`.
func (db *DB) PruneOTelSpans(keep int) int {
	spans, _ := db.OTelSpans.FindAll()
	if len(spans) <= keep {
		return 0
	}
	sort.Slice(spans, func(i, j int) bool {
		return spans[i].ReceivedAt.Before(spans[j].ReceivedAt)
	})
	deleted := 0
	for _, s := range spans[:len(spans)-keep] {
		if db.OTelSpans.Delete(s.ID) == nil {
			deleted++
		}
	}
	if deleted > 0 {
		_, _ = db.OTelSpans.Compact()
	}
	return deleted
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
		_, _ = db.TraceSessions.Compact()
	}
	return deleted
}

// PruneOTelSpansByAge deletes OTel spans older than maxDays. Returns deleted count.
func (db *DB) PruneOTelSpansByAge(maxDays int) int {
	if maxDays <= 0 {
		return 0
	}
	cutoff := time.Now().AddDate(0, 0, -maxDays)
	spans, _ := db.OTelSpans.FindAll()
	deleted := 0
	for _, s := range spans {
		if s.ReceivedAt.Before(cutoff) {
			if db.OTelSpans.Delete(s.ID) == nil {
				deleted++
			}
		}
	}
	if deleted > 0 {
		_, _ = db.OTelSpans.Compact()
	}
	return deleted
}

// PruneTraceSessionsByAge deletes trace sessions older than maxDays. Returns deleted count.
func (db *DB) PruneTraceSessionsByAge(maxDays int) int {
	if maxDays <= 0 {
		return 0
	}
	cutoff := time.Now().AddDate(0, 0, -maxDays)
	sessions, _ := db.TraceSessions.FindAll()
	deleted := 0
	for _, s := range sessions {
		if s.StartedAt.Before(cutoff) {
			if db.TraceSessions.Delete(s.ID) == nil {
				deleted++
			}
		}
	}
	if deleted > 0 {
		_, _ = db.TraceSessions.Compact()
	}
	return deleted
}

// PruneAuditEvents deletes the oldest audit events keeping at most `keep`.
func (db *DB) PruneAuditEvents(keep int) int {
	events, _ := db.AuditEvents.FindAll()
	if len(events) <= keep {
		return 0
	}
	sort.Slice(events, func(i, j int) bool {
		return events[i].CreatedAt.Before(events[j].CreatedAt)
	})
	deleted := 0
	for _, e := range events[:len(events)-keep] {
		if db.AuditEvents.Delete(e.ID) == nil {
			deleted++
		}
	}
	if deleted > 0 {
		_, _ = db.AuditEvents.Compact()
	}
	return deleted
}

// PruneAuditEventsByAge deletes audit events older than maxDays. Returns deleted count.
func (db *DB) PruneAuditEventsByAge(maxDays int) int {
	if maxDays <= 0 {
		return 0
	}
	cutoff := time.Now().AddDate(0, 0, -maxDays)
	events, _ := db.AuditEvents.FindAll()
	deleted := 0
	for _, e := range events {
		if e.CreatedAt.Before(cutoff) {
			if db.AuditEvents.Delete(e.ID) == nil {
				deleted++
			}
		}
	}
	if deleted > 0 {
		_, _ = db.AuditEvents.Compact()
	}
	return deleted
}

// retentionFilePath returns the path to the retention settings JSON file.
func retentionFilePath(dataDir string) string {
	return filepath.Join(dataDir, "retention.json")
}

// defaultRetention returns built-in retention defaults.
func defaultRetention() RetentionSettings {
	return RetentionSettings{
		OTelSpansMaxCount:     50_000,
		TraceSessionsMaxCount: 500,
		AuditEventsMaxCount:   10_000,
	}
}

// LoadRetentionSettings reads retention settings from dataDir/retention.json.
// Returns defaults if the file is absent or unreadable. Count fields are
// clamped to their defaults when the stored value is 0 (prevents accidental deletion of everything).
func LoadRetentionSettings(dataDir string) RetentionSettings {
	data, err := os.ReadFile(retentionFilePath(dataDir))
	if err != nil {
		return defaultRetention()
	}
	var s RetentionSettings
	if err := json.Unmarshal(data, &s); err != nil {
		return defaultRetention()
	}
	d := defaultRetention()
	if s.OTelSpansMaxCount <= 0 {
		s.OTelSpansMaxCount = d.OTelSpansMaxCount
	}
	if s.TraceSessionsMaxCount <= 0 {
		s.TraceSessionsMaxCount = d.TraceSessionsMaxCount
	}
	if s.AuditEventsMaxCount <= 0 {
		s.AuditEventsMaxCount = d.AuditEventsMaxCount
	}
	return s
}

// SaveRetentionSettings writes retention settings to dataDir/retention.json atomically.
func SaveRetentionSettings(dataDir string, s RetentionSettings) error {
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp := retentionFilePath(dataDir) + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, retentionFilePath(dataDir))
}

// Close releases all file handles. Must be called on shutdown.
func (db *DB) Close() error {
	closers := []interface{ Close() error }{
		db.Users, db.Projects, db.Images, db.Compose,
		db.EnvVars, db.Nginx, db.Deployments, db.ProxyHosts, db.DeploySettings,
		db.AuditEvents, db.CustomRoles, db.Sessions,
		db.OTPChallenges, db.DNSTickets, db.DeployTags, db.TraceSessions, db.OTelSpans,
		db.TermPolicy, db.Backups, db.BackupSchedule, db.NginxCustom,
	}
	for _, c := range closers {
		if err := c.Close(); err != nil {
			return err
		}
	}
	return nil
}
