// Package traffic parses nginx access logs (combined format) and aggregates
// them into metrics for the Traffic dashboard. No external dependencies — the
// logs are read directly from /var/log/nginx.
package traffic

import (
	"bufio"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// LogDir is where nginx writes its access logs.
const LogDir = "/var/log/nginx"

// maxLinesPerFile caps how much of each log we read (tail) to stay fast.
const maxLinesPerFile = 50000

// Standard nginx combined format:
//   addr - user [time] "METHOD path proto" status bytes "ref" "ua"
// OffDock extended format (same + optional host field at end):
//   addr - user [time] "METHOD path proto" status bytes "ref" "ua" "host"
var lineRe = regexp.MustCompile(`^(\S+) \S+ \S+ \[([^\]]+)\] "([A-Z]+) ([^ "]+)[^"]*" (\d{3}) (\d+|-) "([^"]*)" "([^"]*)"(?:\s+"?([^"]+)"?)?`)

const timeLayout = "02/Jan/2006:15:04:05 -0700"

// Entry is one parsed access-log line.
type Entry struct {
	Time   time.Time `json:"time"`
	IP     string    `json:"ip"`
	Method string    `json:"method"`
	Path   string    `json:"path"`
	Status int       `json:"status"`
	Bytes  int64     `json:"bytes"`
	Ref    string    `json:"referer"`
	UA     string    `json:"user_agent"`
	Host   string    `json:"host"`
}

// Count is a generic key/count pair for top-N lists.
type Count struct {
	Key   string `json:"key"`
	Count int    `json:"count"`
}

// Bucket is one point in the time series.
type Bucket struct {
	T     time.Time `json:"t"`
	Count int       `json:"count"`
	Bytes int64     `json:"bytes"`
	Err   int       `json:"err"` // 4xx+5xx in this bucket
}

// Summary is the headline metric block.
type Summary struct {
	Total     int     `json:"total"`
	Bytes     int64   `json:"bytes"`
	Status2xx int     `json:"status_2xx"`
	Status3xx int     `json:"status_3xx"`
	Status4xx int     `json:"status_4xx"`
	Status5xx int     `json:"status_5xx"`
	UniqueIPs int     `json:"unique_ips"`
	RPS       float64 `json:"rps"`
	WindowHrs int     `json:"window_hours"`
}

// Report is the full aggregated response.
type Report struct {
	Summary  Summary  `json:"summary"`
	Series   []Bucket `json:"series"`
	TopPaths []Count  `json:"top_paths"`
	TopIPs   []Count  `json:"top_ips"`
	ByHost   []Count  `json:"by_host"`
	ByStatus []Count  `json:"by_status"`
	Methods  []Count  `json:"methods"`
	Recent   []Entry  `json:"recent"`
	Hosts    []string `json:"hosts"`
}

// hostFromFilename derives a vhost label from a per-domain log filename.
// "kafka-ui-mndev-uk.access.log" → "kafka-ui-mndev-uk"; "access.log" → "nginx-default".
func hostFromFilename(name string) string {
	base := strings.TrimSuffix(filepath.Base(name), ".log")
	base = strings.TrimSuffix(base, ".log.1") // rotated file
	base = strings.TrimSuffix(base, ".access")
	if base == "access" || base == "" {
		return "nginx-default"
	}
	return base
}

// parseFile reads up to maxLinesPerFile tail lines from one log file.
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
		// m[9] is the optional $host field from the OffDock extended log format.
		// If present and non-empty, use it; otherwise fall back to the filename-derived label.
		host := filenameHost
		if len(m) > 9 && strings.TrimSpace(m[9]) != "" {
			host = strings.TrimSpace(m[9])
		}
		out = append(out, Entry{
			Time: t, IP: m[1], Method: m[3], Path: m[4],
			Status: status, Bytes: bytes, Ref: m[7], UA: m[8], Host: host,
		})
	}
	return out
}

// Collect reads all access logs under LogDir, optionally filtered by host,
// within the last `hours`, and returns an aggregated Report.
// For windows > 24h, also reads .log.1 rotated files.
func Collect(hours int, hostFilter string) (*Report, error) {
	if hours <= 0 {
		hours = 24
	}
	since := time.Now().Add(-time.Duration(hours) * time.Hour)

	// Always read current logs; include rotated .log.1 for windows > 24h.
	patterns := []string{filepath.Join(LogDir, "*.log")}
	if hours > 24 {
		patterns = append(patterns, filepath.Join(LogDir, "*.log.1"))
	}

	seen := map[string]bool{} // deduplicate paths
	var logFiles []string
	for _, pat := range patterns {
		m, _ := filepath.Glob(pat)
		for _, p := range m {
			if !seen[p] {
				seen[p] = true
				logFiles = append(logFiles, p)
			}
		}
	}

	var entries []Entry
	hostSet := map[string]bool{}
	for _, p := range logFiles {
		base := filepath.Base(p)
		if strings.Contains(base, "error") {
			continue
		}
		fileEntries := parseFile(p, since)
		// Collect all distinct hosts seen across entries (may differ from filename if $host is used).
		for _, e := range fileEntries {
			hostSet[e.Host] = true
			if hostFilter != "" && e.Host != hostFilter {
				continue
			}
			entries = append(entries, e)
		}
		// Also register the filename-derived host even if the file had no matching entries.
		if len(fileEntries) > 0 {
			hostSet[hostFromFilename(p)] = true
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

	// Bucket size: minute for ≤2h, else hourly.
	bucketDur := time.Hour
	if hours <= 2 {
		bucketDur = time.Minute
	}
	bucketMap := map[int64]*Bucket{}

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
	}

	r.Summary.UniqueIPs = len(ips)
	if hours > 0 {
		r.Summary.RPS = float64(r.Summary.Total) / (float64(hours) * 3600.0)
	}

	// Series — ordered by time.
	for _, b := range bucketMap {
		r.Series = append(r.Series, *b)
	}
	sort.Slice(r.Series, func(i, j int) bool { return r.Series[i].T.Before(r.Series[j].T) })

	r.TopPaths = topN(paths, 12)
	r.TopIPs = topN(ips, 12)
	r.ByStatus = topN(statuses, 8)
	r.Methods = topN(methods, 8)
	r.ByHost = topN(hostCounts, 20)

	// Recent — last 100, newest first.
	n := len(entries)
	start := n - 100
	if start < 0 {
		start = 0
	}
	recent := make([]Entry, 0, n-start)
	for i := n - 1; i >= start; i-- {
		recent = append(recent, entries[i])
	}
	r.Recent = recent

	for h := range hostSet {
		r.Hosts = append(r.Hosts, h)
	}
	sort.Strings(r.Hosts)

	// Never return nil slices (cleaner JSON for the frontend).
	if r.Series == nil {
		r.Series = []Bucket{}
	}
	if r.Recent == nil {
		r.Recent = []Entry{}
	}
	return r
}

func topN(m map[string]int, n int) []Count {
	out := make([]Count, 0, len(m))
	for k, v := range m {
		out = append(out, Count{Key: k, Count: v})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Key < out[j].Key
	})
	if len(out) > n {
		out = out[:n]
	}
	return out
}
