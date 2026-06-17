package backup

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"time"

	"offdock/internal/store"
)

// Scheduler runs automatic backups according to the saved BackupSchedule.
type Scheduler struct {
	db        *store.DB
	builder   *Builder
	backupDir string
}

// NewScheduler returns a Scheduler. backupDir is where archives are written.
func NewScheduler(db *store.DB, builder *Builder, backupDir string) *Scheduler {
	return &Scheduler{db: db, builder: builder, backupDir: backupDir}
}

// Run starts the scheduler loop. It checks once a minute whether a backup is due
// for the current local time-of-day and that one has not already run today.
// Blocks until ctx is cancelled; intended to run in its own goroutine.
func (s *Scheduler) Run(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.tick()
		}
	}
}

func (s *Scheduler) tick() {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("backup scheduler panic", "recover", r)
		}
	}()

	sched, err := s.db.BackupSchedule.FindByID("default")
	if err != nil || !sched.Enabled {
		return
	}
	now := time.Now()
	if now.Format("15:04") != sched.TimeOfDay {
		return
	}
	// Skip if already run today.
	if sched.LastRunAt != nil && sameDay(*sched.LastRunAt, now) {
		return
	}

	slog.Info("scheduled backup starting", "scope", sched.Scope)
	id := store.NewULID()
	outPath := filepath.Join(s.backupDir, "offdock-backup-"+id+".tar.gz")
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Minute)
	defer cancel()

	res, err := s.builder.Create(ctx, outPath, Options{
		Scope:          sched.Scope,
		IncludeVolumes: sched.IncludeVolumes,
		IncludeConfig:  sched.IncludeConfig,
		Encrypt:        sched.Encrypt,
	})
	if err != nil {
		slog.Error("scheduled backup failed", "err", err)
		return
	}

	rec := store.BackupRecord{
		ID: id, CreatedAt: time.Now().UTC(), Scope: sched.Scope,
		Path: res.Path, SizeBytes: res.Size, Contents: res.Contents,
		Volumes: res.Volumes, Encrypted: res.Encrypted, Sensitive: res.Sensitive,
		TriggeredBy: "scheduler", Status: res.Status, Note: res.Note,
	}
	_ = s.db.Backups.Save(rec)

	// Optional off-box copy.
	if sched.DestPath != "" {
		if err := copyToDir(res.Path, sched.DestPath); err != nil {
			slog.Warn("backup off-box copy failed", "dest", sched.DestPath, "err", err)
		}
	}

	// Retention: keep the newest N scheduled backups.
	if sched.Retention > 0 {
		s.applyRetention(sched.Retention)
	}

	t := time.Now().UTC()
	sched.LastRunAt = &t
	_ = s.db.BackupSchedule.Save(sched)
	slog.Info("scheduled backup complete", "size", res.Size, "status", res.Status)
}

func (s *Scheduler) applyRetention(keep int) {
	all, _ := s.db.Backups.FindAll()
	// Only auto-trim scheduler-created backups.
	var scheduled []store.BackupRecord
	for _, b := range all {
		if b.TriggeredBy == "scheduler" {
			scheduled = append(scheduled, b)
		}
	}
	sort.Slice(scheduled, func(i, j int) bool { return scheduled[i].CreatedAt.After(scheduled[j].CreatedAt) })
	for _, b := range scheduled[min(keep, len(scheduled)):] {
		_ = os.Remove(b.Path)
		_ = s.db.Backups.Delete(b.ID)
	}
}

func sameDay(a, b time.Time) bool {
	ay, am, ad := a.Local().Date()
	by, bm, bd := b.Local().Date()
	return ay == by && am == bm && ad == bd
}

func copyToDir(src, destDir string) error {
	if err := os.MkdirAll(destDir, 0o700); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	dest := filepath.Join(destDir, filepath.Base(src))
	out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}
