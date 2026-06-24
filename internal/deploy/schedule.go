package deploy

import (
	"context"
	"log/slog"
	"time"

	"offdock/internal/store"
)

// Scheduler triggers ScheduledDeploy entries when they come due. It runs in its
// own goroutine and polls every 30s. One-shot: each entry fires once, then is
// marked done/failed.
type Scheduler struct {
	db     *store.DB
	engine *Engine
}

// NewScheduler returns a deploy scheduler bound to the engine.
func NewScheduler(db *store.DB, engine *Engine) *Scheduler {
	return &Scheduler{db: db, engine: engine}
}

// Run blocks until ctx is cancelled, polling for due scheduled deploys.
func (s *Scheduler) Run(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
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
			slog.Error("deploy scheduler panic", "recover", r)
		}
	}()

	now := time.Now()
	due, _ := s.db.ScheduledDeploys.FindWhere(func(d store.ScheduledDeploy) bool {
		return d.Status == "pending" && !d.RunAt.After(now)
	})
	for _, sd := range due {
		// Skip (leave pending) if a deploy is already running for this project —
		// it will fire on a later tick.
		running, _ := s.db.Deployments.FindWhere(func(d store.DeploymentRecord) bool {
			return d.ProjectID == sd.ProjectID && d.Status == store.DeployStatusRunning
		})
		if len(running) > 0 {
			continue
		}

		composeVer, envVer := sd.ComposeVersion, sd.EnvVersion
		var imagePins map[string]string
		if sd.TagID != "" {
			if tag, err := s.db.DeployTags.FindByID(sd.TagID); err == nil && tag.ProjectID == sd.ProjectID {
				composeVer, envVer, imagePins = tag.ComposeVersion, tag.EnvVersion, tag.ImagePins
			}
		}

		slog.Info("scheduled deploy firing", "project", sd.ProjectID, "schedule", sd.ID)
		ctx, cancel := context.WithTimeout(context.Background(), defaultDeployTimeout+time.Minute)
		rec, err := s.engine.DeployVersion(ctx, sd.ProjectID, "scheduler", "", composeVer, envVer, imagePins, nil)
		cancel()

		if err != nil {
			sd.Status = "failed"
			sd.Result = err.Error()
		} else {
			sd.Status = "done"
			if rec != nil {
				sd.DeploymentID = rec.ID
				sd.Result = string(rec.Status)
			}
		}
		_ = s.db.ScheduledDeploys.Save(sd)
	}
}
