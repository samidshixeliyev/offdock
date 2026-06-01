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

	return db, nil
}

// Close releases all file handles. Must be called on shutdown.
func (db *DB) Close() error {
	closers := []interface{ Close() error }{
		db.Users, db.Projects, db.Images, db.Compose,
		db.EnvVars, db.Nginx, db.Deployments, db.ProxyHosts, db.DeploySettings,
		db.AuditEvents,
	}
	for _, c := range closers {
		if err := c.Close(); err != nil {
			return err
		}
	}
	return nil
}
