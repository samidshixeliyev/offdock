// Package traffic parses nginx access logs (extended offdock_main format) and
// aggregates them into metrics for the Traffic dashboard.
package traffic

import (
	"bufio"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const LogDir = "/var/log/nginx"
const maxLinesPerFile = 50_000

// Extended offdock_main format:
//   addr - user [time] "METHOD path proto" status bytes "ref" "ua" "host" req_time upstream_time upstream_addr
// Falls back to standard combined (no timing/upstream fields).
var lineRe = regexp.MustCompile(
	`^(\S+) \S+ \S+ \[([^\]]+)\] "([A-Z]+) ([^ "]+)[^"]*" (\d{3}) (\d+|-) "([^"]*)" "([^"]*)"` +
		`(?:\s+"?([^"]+)"?)?` + // group 9:  $host  (quoted, optional)
		`(?:\s+([\d.]+) ([\d.-]+) (\S+))?`, // groups 10-12: req_time upstream_time upstream_addr
)

const timeLayout = "02/Jan/2006:15:04:05 -0700"

// Entry is one parsed access-log line.
type Entry struct {
	Time         time.Time `json:"time"`
	IP           string    `json:"ip"`
	Method       string    `json:"method"`
	Path         string    `json:"path"`
	Status       int       `json:"status"`
	Bytes        int64     `json:"bytes"`
	Ref          string    `json:"referer"`
	UA           string    `json:"user_agent"`
	Host         string    `json:"host"`
	ResponseMs   float64   `json:"response_ms"`   // $request_time * 1000 (0 = not present)
	UpstreamMs   float64   `json:"upstream_ms"`   // $upstream_response_time * 1000
	UpstreamAddr string    `json:"upstream_addr"` // e.g. "172.17.0.3:3000"
}

// Count is a generic key/count pair.
type Count struct {
	Key   string `json:"key"`
	Count int    `json:"count"`
}

// Bucket is one time-series point.
type Bucket struct {
	T     time.Time `json:"t"`
	Count int       `json:"count"`
	Bytes int64     `json:"bytes"`
	Err   int       `json:"err"`
	AvgMs float64   `json:"avg_ms"` // avg response time for this bucket (0 if not available)
}

// HostStat holds per-virtual-host detailed metrics.
type HostStat struct {
	Host      string  `json:"host"`
	Total     int     `json:"total"`
	Bytes     int64   `json:"bytes"`
	Errors    int     `json:"errors"`
	ErrorRate float64 `json:"error_rate"` // 0–100
	AvgMs     float64 `json:"avg_ms"`
	P95Ms     float64 `json:"p95_ms"`
}

// Summary is the headline metric block.
type Summary struct {
	Total         int     `json:"total"`
	Bytes         int64   `json:"bytes"`
	Status2xx     int     `json:"status_2xx"`
	Status3xx     int     `json:"status_3xx"`
	Status4xx     int     `json:"status_4xx"`
	Status5xx     int     `json:"status_5xx"`
	UniqueIPs     int     `json:"unique_ips"`
	RPS           float64 `json:"rps"`
	WindowHrs     int     `json:"window_hours"`
	AvgResponseMs  float64 `json:"avg_response_ms"`
	P95ResponseMs  float64 `json:"p95_response_ms"`
	P99ResponseMs  float64 `json:"p99_response_ms"`
	AvgBytesPerReq float64 `json:"avg_bytes_per_req"`
}

// Report is the full aggregated response.
type Report struct {
	Summary      Summary    `json:"summary"`
	Series       []Bucket   `json:"series"`
	TopPaths     []Count    `json:"top_paths"`
	TopIPs       []Count    `json:"top_ips"`
	ByHost       []Count    `json:"by_host"`
	ByStatus     []Count    `json:"by_status"`
	Methods      []Count    `json:"methods"`
	Recent       []Entry    `json:"recent"`
	Hosts        []string   `json:"hosts"`
	SlowRequests []Entry    `json:"slow_requests"` // top 15 slowest (requires timing fields)
	ByUpstream    []Count    `json:"by_upstream"`     // per upstream container
	HostStats     []HostStat `json:"host_stats"`      // per-host detailed breakdown
	TopUserAgents []Count    `json:"top_user_agents"` // top 10 user agents
}

// hostFromFilename derives a vhost label from a log filename.
func hostFromFilename(name string) string {
	base := filepath.Base(name)
	base = strings.TrimSuffix(base, ".log.1")
	base = strings.TrimSuffix(base, ".log")
	base = strings.TrimSuffix(base, ".access")
	if base == "access" || base == "" {
		return "nginx-default"
	}
	return base
}

func parseFile(path string, since time.Time) []Entry {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()

	filenameHost := hostFromFilename(path)
	var lines []string
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1024*1024), 1024*1024)
	for sc.Scan() {
		lines = append(lines, sc.Text())
		if len(lines) > maxLinesPerFile {
			lines = lines[1:]
		}
	}

	out := make([]Entry, 0, len(lines))
	for _, line := range lines {
		m := lineRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		t, err := time.Parse(timeLayout, m[2])
		if err != nil || t.Before(since) {
			continue
		}
		status, _ := strconv.Atoi(m[5])
		var bytes int64
		if m[6] != "-" {
			bytes, _ = strconv.ParseInt(m[6], 10, 64)
		}
		host := filenameHost
		if len(m) > 9 && strings.TrimSpace(m[9]) != "" {
			host = strings.TrimSpace(m[9])
		}

		e := Entry{
			Time: t, IP: m[1], Method: m[3], Path: m[4],
			Status: status, Bytes: bytes, Ref: m[7], UA: m[8], Host: host,
		}

		// Extended timing fields (groups 10–12, only present in offdock_main format).
		if len(m) > 12 {
			if v, err := strconv.ParseFloat(m[10], 64); err == nil {
				e.ResponseMs = math.Round(v*1000*10) / 10 // ms, 1 decimal
			}
			if m[11] != "-" && m[11] != "" {
				if v, err := strconv.ParseFloat(m[11], 64); err == nil {
					e.UpstreamMs = math.Round(v*1000*10) / 10
				}
			}
			if m[12] != "-" && m[12] != "" {
				e.UpstreamAddr = m[12]
			}
		}

		out = append(out, e)
	}
	return out
}

// Collect reads all nginx access logs and returns an aggregated Report.
func Collect(hours int, hostFilter string) (*Report, error) {
	if hours <= 0 {
		hours = 24
	}
	since := time.Now().Add(-time.Duration(hours) * time.Hour)

	patterns := []string{filepath.Join(LogDir, "*.log")}
	if hours > 24 {
		patterns = append(patterns, filepath.Join(LogDir, "*.log.1"))
	}

	seen := map[string]bool{}
	var logFiles []string
	for _, pat := range patterns {
		ms, _ := filepath.Glob(pat)
		for _, p := range ms {
			if !seen[p] {
				seen[p] = true
				logFiles = append(logFiles, p)
			}
		}
	}

	var entries []Entry
	hostSet := map[string]bool{}
	for _, p := range logFiles {
		if strings.Contains(filepath.Base(p), "error") {
			continue
		}
		fe := parseFile(p, since)
		for _, e := range fe {
			hostSet[e.Host] = true
			if hostFilter != "" && e.Host != hostFilter {
				continue
			}
			entries = append(entries, e)
		}
	}

	sort.Slice(entries, func(i, j int) bool { return entries[i].Time.Before(entries[j].Time) })
	return aggregate(entries, hours, hostSet), nil
}

func aggregate(entries []Entry, hours int, hostSet map[string]bool) *Report {
	r := &Report{Summary: Summary{WindowHrs: hours}}

	ips := map[string]int{}
	paths := map[string]int{}
	statuses := map[string]int{}
	methods := map[string]int{}
	hostCounts := map[string]int{}
	upstreamCounts := map[string]int{}
	userAgents := map[string]int{}

	bucketDur := time.Hour
	if hours <= 2 {
		bucketDur = time.Minute
	}
	bucketMap := map[int64]*Bucket{}
	bucketMs := map[int64][]float64{}

	// Per-host accumulators for HostStats.
	type hostAcc struct {
		total  int
		bytes  int64
		errors int
		ms     []float64
	}
	hostAccMap := map[string]*hostAcc{}

	var responseMsAll []float64

	for _, e := range entries {
		r.Summary.Total++
		r.Summary.Bytes += e.Bytes
		switch {
		case e.Status >= 500:
			r.Summary.Status5xx++
		case e.Status >= 400:
			r.Summary.Status4xx++
		case e.Status >= 300:
			r.Summary.Status3xx++
		case e.Status >= 200:
			r.Summary.Status2xx++
		}
		ips[e.IP]++
		paths[e.Path]++
		statuses[strconv.Itoa(e.Status)]++
		methods[e.Method]++
		hostCounts[e.Host]++
		if e.UpstreamAddr != "" {
			upstreamCounts[e.UpstreamAddr]++
		}
		if ua := e.UA; ua != "" && ua != "-" {
			userAgents[ua]++
		}

		key := e.Time.Truncate(bucketDur).Unix()
		b := bucketMap[key]
		if b == nil {
			b = &Bucket{T: e.Time.Truncate(bucketDur)}
			bucketMap[key] = b
		}
		b.Count++
		b.Bytes += e.Bytes
		if e.Status >= 400 {
			b.Err++
		}
		if e.ResponseMs > 0 {
			responseMsAll = append(responseMsAll, e.ResponseMs)
			bucketMs[key] = append(bucketMs[key], e.ResponseMs)
		}

		ha := hostAccMap[e.Host]
		if ha == nil {
			ha = &hostAcc{}
			hostAccMap[e.Host] = ha
		}
		ha.total++
		ha.bytes += e.Bytes
		if e.Status >= 400 {
			ha.errors++
		}
		if e.ResponseMs > 0 {
			ha.ms = append(ha.ms, e.ResponseMs)
		}
	}

	r.Summary.UniqueIPs = len(ips)
	if hours > 0 {
		r.Summary.RPS = float64(r.Summary.Total) / (float64(hours) * 3600.0)
	}
	if r.Summary.Total > 0 {
		r.Summary.AvgBytesPerReq = round1(float64(r.Summary.Bytes) / float64(r.Summary.Total))
	}

	// Response time percentiles (global).
	if len(responseMsAll) > 0 {
		sorted := make([]float64, len(responseMsAll))
		copy(sorted, responseMsAll)
		sort.Float64s(sorted)
		r.Summary.AvgResponseMs = round1(avg(sorted))
		r.Summary.P95ResponseMs = round1(percentile(sorted, 95))
		r.Summary.P99ResponseMs = round1(percentile(sorted, 99))
	}

	// Series.
	for key, b := range bucketMap {
		if ms := bucketMs[key]; len(ms) > 0 {
			b.AvgMs = round1(avg(ms))
		}
		r.Series = append(r.Series, *b)
	}
	sort.Slice(r.Series, func(i, j int) bool { return r.Series[i].T.Before(r.Series[j].T) })

	r.TopPaths = topN(paths, 15)
	r.TopIPs = topN(ips, 15)
	r.ByStatus = topN(statuses, 10)
	r.Methods = topN(methods, 10)
	r.ByHost = topN(hostCounts, 30)
	r.ByUpstream = topN(upstreamCounts, 20)
	r.TopUserAgents = topN(userAgents, 10)

	// Recent — last 200, newest first.
	n := len(entries)
	start := n - 200
	if start < 0 {
		start = 0
	}
	r.Recent = make([]Entry, 0, n-start)
	for i := n - 1; i >= start; i-- {
		r.Recent = append(r.Recent, entries[i])
	}

	// Slow requests — top 15 by ResponseMs (only when timing data available).
	var timed []Entry
	for _, e := range entries {
		if e.ResponseMs > 0 {
			timed = append(timed, e)
		}
	}
	sort.Slice(timed, func(i, j int) bool { return timed[i].ResponseMs > timed[j].ResponseMs })
	if len(timed) > 15 {
		timed = timed[:15]
	}
	r.SlowRequests = timed

	// HostStats.
	for host, ha := range hostAccMap {
		hs := HostStat{
			Host:   host,
			Total:  ha.total,
			Bytes:  ha.bytes,
			Errors: ha.errors,
		}
		if ha.total > 0 {
			hs.ErrorRate = round1(float64(ha.errors) / float64(ha.total) * 100)
		}
		if len(ha.ms) > 0 {
			sort.Float64s(ha.ms)
			hs.AvgMs = round1(avg(ha.ms))
			hs.P95Ms = round1(percentile(ha.ms, 95))
		}
		r.HostStats = append(r.HostStats, hs)
	}
	sort.Slice(r.HostStats, func(i, j int) bool { return r.HostStats[i].Total > r.HostStats[j].Total })

	for h := range hostSet {
		r.Hosts = append(r.Hosts, h)
	}
	sort.Strings(r.Hosts)

	if r.Series == nil {
		r.Series = []Bucket{}
	}
	if r.Recent == nil {
		r.Recent = []Entry{}
	}
	if r.SlowRequests == nil {
		r.SlowRequests = []Entry{}
	}
	if r.ByUpstream == nil {
		r.ByUpstream = []Count{}
	}
	if r.HostStats == nil {
		r.HostStats = []HostStat{}
	}
	if r.TopUserAgents == nil {
		r.TopUserAgents = []Count{}
	}
	return r
}

// ─── helpers ─────────────────────────────────────────────────────────────────

func topN(m map[string]int, n int) []Count {
	out := make([]Count, 0, len(m))
	for k, v := range m {
		out = append(out, Count{Key: k, Count: v})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Count > out[j].Count })
	if len(out) > n {
		out = out[:n]
	}
	return out
}

func avg(sorted []float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	var sum float64
	for _, v := range sorted {
		sum += v
	}
	return sum / float64(len(sorted))
}

func percentile(sorted []float64, p float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	idx := int(math.Ceil(float64(len(sorted))*p/100)) - 1
	if idx < 0 {
		idx = 0
	}
	if idx >= len(sorted) {
		idx = len(sorted) - 1
	}
	return sorted[idx]
}

func round1(v float64) float64 {
	return math.Round(v*10) / 10
}
