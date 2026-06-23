package handlers

import (
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"offdock/internal/store"
)

// OffDock "Database" view — a Dynatrace-style aggregation of every captured
// database span. Spans carrying db.statement / db.query.text are grouped by
// their normalized statement so the same query with different literals collapses
// into one row with execution count + timing percentiles + sample full text.

var (
	reSQLSingleQuoted = regexp.MustCompile(`'[^']*'`)
	reSQLInList       = regexp.MustCompile(`(?i)\bIN\s*\(\s*[^)]*\)`)
	reSQLNumber       = regexp.MustCompile(`\b\d+(\.\d+)?\b`)
	reSQLValuesList   = regexp.MustCompile(`(?i)\bVALUES\s*\([^)]*\)(\s*,\s*\([^)]*\))*`)
	reSQLWhitespace   = regexp.MustCompile(`\s+`)
	reSQLParam        = regexp.MustCompile(`[$:@]\w+|\?`)
)

// normalizeSQL strips literals so structurally-identical queries group together.
func normalizeSQL(q string) string {
	s := strings.TrimSpace(q)
	if s == "" {
		return s
	}
	s = reSQLInList.ReplaceAllString(s, "IN (?)")
	s = reSQLValuesList.ReplaceAllString(s, "VALUES (?)")
	s = reSQLSingleQuoted.ReplaceAllString(s, "?")
	s = reSQLParam.ReplaceAllString(s, "?")
	s = reSQLNumber.ReplaceAllString(s, "?")
	s = reSQLWhitespace.ReplaceAllString(s, " ")
	return strings.TrimSpace(s)
}

// firstKeyword returns the leading SQL verb (SELECT/INSERT/…), uppercased.
func sqlOperation(stmt, attrOp string) string {
	if attrOp != "" {
		return strings.ToUpper(attrOp)
	}
	s := strings.TrimSpace(stmt)
	if s == "" {
		return "OTHER"
	}
	// skip a leading comment / paren
	for len(s) > 0 && (s[0] == '(' || s[0] == ' ') {
		s = s[1:]
	}
	fields := strings.Fields(s)
	if len(fields) == 0 {
		return "OTHER"
	}
	verb := strings.ToUpper(fields[0])
	switch verb {
	case "SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "BEGIN", "COMMIT", "ROLLBACK", "SET", "CALL", "WITH", "EXPLAIN":
		return verb
	}
	return "OTHER"
}

// dbStatement extracts the statement text from a span, covering OTel semconv
// variations across instrumentation versions.
func dbStatement(s store.OTelSpan) string {
	for _, k := range []string{"db.statement", "db.query.text", "db.operation.statement"} {
		if v := s.Attributes[k]; v != "" {
			return v
		}
	}
	return ""
}

func dbSystem(s store.OTelSpan) string {
	for _, k := range []string{"db.system", "db.system.name"} {
		if v := s.Attributes[k]; v != "" {
			return v
		}
	}
	return ""
}

func dbTable(s store.OTelSpan) string {
	for _, k := range []string{"db.sql.table", "db.collection.name", "db.mongodb.collection", "db.cassandra.table"} {
		if v := s.Attributes[k]; v != "" {
			return v
		}
	}
	return ""
}

type dbQueryAgg struct {
	Normalized   string   `json:"normalized"`
	Sample       string   `json:"sample"`         // a full example statement
	DBSystem     string   `json:"db_system"`
	DBName       string   `json:"db_name"`
	Table        string   `json:"table"`
	Operation    string   `json:"operation"`
	Count        int      `json:"count"`
	TotalMs      float64  `json:"total_ms"`
	AvgMs        float64  `json:"avg_ms"`
	MaxMs        float64  `json:"max_ms"`
	MinMs        float64  `json:"min_ms"`
	Errors       int      `json:"errors"`
	Services     []string `json:"services"`
	LastSeenUs   int64    `json:"last_seen_us"`
	ExampleTrace string   `json:"example_trace_id"`
}

// OTelDatabase aggregates DB spans into grouped query statistics.
// Query params: service, db_system, search, time_range, min_duration_ms,
// sort (total|avg|max|count|last), limit, offset.
func (h *H) OTelDatabase(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	svc := q.Get("service")
	sys := strings.ToLower(q.Get("db_system"))
	search := strings.ToLower(strings.TrimSpace(q.Get("search")))
	sortBy := q.Get("sort")
	minDurMs := 0
	if d, err := strconv.Atoi(q.Get("min_duration_ms")); err == nil && d > 0 {
		minDurMs = d
	}

	var sinceTime time.Time
	switch q.Get("time_range") {
	case "1h":
		sinceTime = time.Now().Add(-time.Hour)
	case "6h":
		sinceTime = time.Now().Add(-6 * time.Hour)
	case "24h":
		sinceTime = time.Now().Add(-24 * time.Hour)
	case "7d":
		sinceTime = time.Now().AddDate(0, 0, -7)
	}

	spans, _ := h.db.OTelSpans.FindWhere(func(s store.OTelSpan) bool {
		if dbStatement(s) == "" && dbSystem(s) == "" {
			return false
		}
		if svc != "" && s.Service != svc {
			return false
		}
		if !sinceTime.IsZero() && s.ReceivedAt.Before(sinceTime) {
			return false
		}
		return true
	})

	groups := make(map[string]*dbQueryAgg)
	svcSets := make(map[string]map[string]bool)
	systems := make(map[string]bool)

	for _, s := range spans {
		stmt := dbStatement(s)
		system := dbSystem(s)
		if system != "" {
			systems[system] = true
		}
		if sys != "" && strings.ToLower(system) != sys {
			continue
		}

		norm := normalizeSQL(stmt)
		if norm == "" {
			// No statement text (e.g. Redis/Mongo without query) — group by operation+name.
			norm = strings.TrimSpace(system + " " + s.Name)
		}
		if search != "" && !strings.Contains(strings.ToLower(stmt), search) &&
			!strings.Contains(strings.ToLower(norm), search) {
			continue
		}

		durMs := float64(s.EndTimeUs-s.StartTimeUs) / 1000.0
		if durMs < 0 {
			durMs = 0
		}

		key := system + "||" + norm
		g := groups[key]
		if g == nil {
			g = &dbQueryAgg{
				Normalized:   norm,
				Sample:       stmt,
				DBSystem:     system,
				DBName:       s.Attributes["db.name"],
				Table:        dbTable(s),
				Operation:    sqlOperation(stmt, s.Attributes["db.operation"]),
				MinMs:        durMs,
				LastSeenUs:   s.StartTimeUs,
				ExampleTrace: s.TraceID,
			}
			groups[key] = g
			svcSets[key] = make(map[string]bool)
		}
		if g.Sample == "" && stmt != "" {
			g.Sample = stmt
		}
		g.Count++
		g.TotalMs += durMs
		if durMs > g.MaxMs {
			g.MaxMs = durMs
			g.ExampleTrace = s.TraceID // example points at the slowest execution
		}
		if durMs < g.MinMs {
			g.MinMs = durMs
		}
		if s.StatusCode == "error" {
			g.Errors++
		}
		if s.StartTimeUs > g.LastSeenUs {
			g.LastSeenUs = s.StartTimeUs
		}
		if s.Service != "" {
			svcSets[key][s.Service] = true
		}
	}

	out := make([]dbQueryAgg, 0, len(groups))
	var totalExec int
	var totalMs, slowest float64
	for key, g := range groups {
		if g.Count > 0 {
			g.AvgMs = g.TotalMs / float64(g.Count)
		}
		for s := range svcSets[key] {
			g.Services = append(g.Services, s)
		}
		sort.Strings(g.Services)
		if minDurMs > 0 && g.MaxMs < float64(minDurMs) {
			continue
		}
		totalExec += g.Count
		totalMs += g.TotalMs
		if g.MaxMs > slowest {
			slowest = g.MaxMs
		}
		out = append(out, *g)
	}

	// Default sort: most total time consumed (Dynatrace's default "impact" order).
	less := func(i, j int) bool { return out[i].TotalMs > out[j].TotalMs }
	switch sortBy {
	case "avg":
		less = func(i, j int) bool { return out[i].AvgMs > out[j].AvgMs }
	case "max":
		less = func(i, j int) bool { return out[i].MaxMs > out[j].MaxMs }
	case "count":
		less = func(i, j int) bool { return out[i].Count > out[j].Count }
	case "last":
		less = func(i, j int) bool { return out[i].LastSeenUs > out[j].LastSeenUs }
	}
	sort.Slice(out, less)

	total := len(out)
	limit := 50
	if l, err := strconv.Atoi(q.Get("limit")); err == nil && l > 0 {
		limit = l
	}
	offset := 0
	if o, err := strconv.Atoi(q.Get("offset")); err == nil && o > 0 {
		offset = o
	}
	if offset > total {
		offset = total
	}
	end := offset + limit
	if end > total {
		end = total
	}

	sysList := make([]string, 0, len(systems))
	for s := range systems {
		sysList = append(sysList, s)
	}
	sort.Strings(sysList)

	writeJSON(w, http.StatusOK, map[string]any{
		"data":    out[offset:end],
		"total":   total,
		"limit":   limit,
		"offset":  offset,
		"systems": sysList,
		"totals": map[string]any{
			"queries":    total,
			"executions": totalExec,
			"total_ms":   totalMs,
			"slowest_ms": slowest,
		},
	})
}
