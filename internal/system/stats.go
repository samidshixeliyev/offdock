// Package system reads host-level resource metrics without external tooling.
package system

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"

	"offdock/internal/docker"
)

// Stats is a point-in-time snapshot of host and container resource usage.
type Stats struct {
	CPU        float64               `json:"cpu_percent"`
	RAMTotal   uint64                `json:"ram_total_bytes"`
	RAMUsed    uint64                `json:"ram_used_bytes"`
	DiskTotal  uint64                `json:"disk_total_bytes"`
	DiskUsed   uint64                `json:"disk_used_bytes"`
	Containers []docker.ContainerStats `json:"containers"`
	Timestamp  time.Time             `json:"timestamp"`
}

// Collector gathers system stats on demand.
type Collector struct {
	docker   *docker.Client
	diskPath string
}

// New returns a Collector using the given disk path for df-style metrics.
func New(dockerClient *docker.Client, diskPath string) *Collector {
	return &Collector{docker: dockerClient, diskPath: diskPath}
}

// Collect reads CPU (over ~1 s), RAM, disk, and container stats.
func (c *Collector) Collect() (*Stats, error) {
	cpu, err := cpuPercent()
	if err != nil {
		return nil, fmt.Errorf("cpu: %w", err)
	}

	ramTotal, ramUsed, err := ramBytes()
	if err != nil {
		return nil, fmt.Errorf("ram: %w", err)
	}

	diskTotal, diskUsed, err := diskBytes(c.diskPath)
	if err != nil {
		return nil, fmt.Errorf("disk: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	containers, _ := c.docker.Stats(ctx)

	return &Stats{
		CPU:        cpu,
		RAMTotal:   ramTotal,
		RAMUsed:    ramUsed,
		DiskTotal:  diskTotal,
		DiskUsed:   diskUsed,
		Containers: containers,
		Timestamp:  time.Now().UTC(),
	}, nil
}

// cpuPercent calculates CPU usage by reading /proc/stat twice with a 1-second gap.
func cpuPercent() (float64, error) {
	s1, err := readProcStat()
	if err != nil {
		return 0, err
	}
	time.Sleep(time.Second)
	s2, err := readProcStat()
	if err != nil {
		return 0, err
	}

	deltaTotal := s2.total - s1.total
	deltaIdle := s2.idle - s1.idle
	if deltaTotal == 0 {
		return 0, nil
	}
	return float64(deltaTotal-deltaIdle) / float64(deltaTotal) * 100, nil
}

type cpuStat struct{ idle, total uint64 }

func readProcStat() (cpuStat, error) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return cpuStat{}, err
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "cpu ") {
			continue
		}
		fields := strings.Fields(line)[1:] // skip "cpu"
		var vals [10]uint64
		for i := 0; i < len(fields) && i < 10; i++ {
			vals[i], _ = strconv.ParseUint(fields[i], 10, 64)
		}
		idle := vals[3] + vals[4]
		var total uint64
		for _, v := range vals {
			total += v
		}
		return cpuStat{idle: idle, total: total}, nil
	}
	return cpuStat{}, fmt.Errorf("cpu line not found in /proc/stat")
}

// ramBytes reads MemTotal and MemAvailable from /proc/meminfo.
func ramBytes() (total, used uint64, err error) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, 0, err
	}
	defer f.Close()

	kv := make(map[string]uint64)
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		parts := strings.Fields(sc.Text())
		if len(parts) < 2 {
			continue
		}
		key := strings.TrimRight(parts[0], ":")
		val, _ := strconv.ParseUint(parts[1], 10, 64)
		kv[key] = val * 1024 // kB → bytes
	}

	totalMem := kv["MemTotal"]
	avail := kv["MemAvailable"]
	return totalMem, totalMem - avail, nil
}

// diskBytes uses syscall.Statfs on the given path.
func diskBytes(path string) (total, used uint64, err error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0, fmt.Errorf("statfs %s: %w", path, err)
	}
	total = st.Blocks * uint64(st.Bsize)
	free := st.Bfree * uint64(st.Bsize)
	return total, total - free, nil
}
