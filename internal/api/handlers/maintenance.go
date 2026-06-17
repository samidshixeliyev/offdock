package handlers

import (
	"context"
	"net/http"
	"time"

	"offdock/internal/selfheal"
	"offdock/internal/store"
	"offdock/internal/system"
)

// Reconcile re-runs the self-heal reconciler on demand: ensure Docker is up,
// bring running projects back, and re-apply nginx vhosts from the DB.
// POST /api/v1/system/reconcile
func (h *H) Reconcile(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	rc := selfheal.New(h.db, h.docker, h.deployer)
	rep := rc.Run(ctx)
	h.logAudit(r, "system_reconcile", "system", "", "", "")
	writeJSON(w, http.StatusOK, rep)
}

// OptimizeResult is the response from the memory-optimize endpoint.
type OptimizeResult struct {
	RAMUsedBefore   uint64               `json:"ram_used_before"`
	RAMUsedAfter    uint64               `json:"ram_used_after"`
	RAMFreed        int64                `json:"ram_freed_bytes"`
	Compacted       []store.CompactResult `json:"compacted"`
	DiskReclaimed   int64                `json:"disk_reclaimed_bytes"`
	DroppedCaches   bool                 `json:"dropped_caches"`
	DockerPruneOut  string               `json:"docker_prune_output,omitempty"`
	Errors          []string             `json:"errors,omitempty"`
}

// Optimize reclaims memory and disk: compacts the append-log DBs (dropping
// tombstones + superseded versions), optionally drops kernel page cache, and
// optionally runs `docker system prune` (never volumes).
// POST /api/v1/system/optimize  {compact, drop_caches, docker_prune}
func (h *H) Optimize(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Compact     *bool `json:"compact"`
		DropCaches  *bool `json:"drop_caches"`
		DockerPrune bool  `json:"docker_prune"`
	}
	_ = decodeJSON(r, &req)
	// Default compact + drop_caches to true when omitted.
	doCompact := req.Compact == nil || *req.Compact
	doDrop := req.DropCaches == nil || *req.DropCaches

	res := OptimizeResult{}
	_, res.RAMUsedBefore = system.MemSnapshot()

	if doCompact {
		results, total := h.db.CompactAll()
		res.Compacted = results
		res.DiskReclaimed = total
		for _, c := range results {
			if c.Err != "" {
				res.Errors = append(res.Errors, c.Collection+": "+c.Err)
			}
		}
	}

	if doDrop {
		if err := system.DropCaches(); err != nil {
			res.Errors = append(res.Errors, "drop_caches: "+err.Error())
		} else {
			res.DroppedCaches = true
		}
	}

	if req.DockerPrune {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		out, err := h.docker.SystemPrune(ctx)
		cancel()
		res.DockerPruneOut = out
		if err != nil {
			res.Errors = append(res.Errors, "docker_prune: "+err.Error())
		}
	}

	// Give the kernel a moment to settle freed pages before re-reading.
	time.Sleep(200 * time.Millisecond)
	_, res.RAMUsedAfter = system.MemSnapshot()
	res.RAMFreed = int64(res.RAMUsedBefore) - int64(res.RAMUsedAfter)

	h.logAudit(r, "system_optimize", "system", "", "", "")
	writeJSON(w, http.StatusOK, res)
}
