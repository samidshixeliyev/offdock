// Package config loads and exposes OffDock runtime configuration.
package config

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

// Config holds all runtime-configurable options.
type Config struct {
	Port    int    `yaml:"port"`
	DataDir string `yaml:"data_dir"`
	LogDir  string `yaml:"log_dir"`
	LogLevel string `yaml:"log_level"`
	JWTSecret string `yaml:"jwt_secret"`
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
		return cfg, nil
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
		Port:     7070,
		DataDir:  "/var/offdock/data",
		LogDir:   "/var/offdock/logs",
		LogLevel: "info",
	}
}
