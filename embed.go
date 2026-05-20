// Package offdock exports the compiled React frontend for embedding into the binary.
package offdock

import "embed"

// Static holds the compiled React frontend served for all non-API routes.
//
//go:embed web/dist
var Static embed.FS
