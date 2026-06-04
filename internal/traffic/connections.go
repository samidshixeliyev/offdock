package traffic

import (
	"bufio"
	"context"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// Connection is one active TCP/UDP network connection on the host.
type Connection struct {
	Proto      string `json:"proto"`
	LocalAddr  string `json:"local_addr"`
	LocalPort  int    `json:"local_port"`
	RemoteAddr string `json:"remote_addr"`
	RemotePort int    `json:"remote_port"`
	State      string `json:"state"`
	PID        int    `json:"pid"`
	Program    string `json:"program"`
}

// InterfaceStat is per-network-interface rx/tx counters.
type InterfaceStat struct {
	Name    string `json:"name"`
	RxBytes int64  `json:"rx_bytes"`
	TxBytes int64  `json:"tx_bytes"`
	RxPkts  int64  `json:"rx_pkts"`
	TxPkts  int64  `json:"tx_pkts"`
}

// ConnectionsReport is the full real-time network snapshot.
type ConnectionsReport struct {
	Connections []Connection    `json:"connections"`
	Interfaces  []InterfaceStat `json:"interfaces"`
	ListenPorts []ListenPort    `json:"listen_ports"`
	Snapshot    time.Time       `json:"snapshot"`
}

// ListenPort describes a port the host is actively listening on.
type ListenPort struct {
	Proto   string `json:"proto"`
	Addr    string `json:"addr"`
	Port    int    `json:"port"`
	Program string `json:"program"`
	PID     int    `json:"pid"`
}

// CollectConnections gathers live TCP/UDP connections and interface stats.
func CollectConnections() (*ConnectionsReport, error) {
	report := &ConnectionsReport{
		Snapshot:    time.Now().UTC(),
		Connections: []Connection{},
		Interfaces:  []InterfaceStat{},
		ListenPorts: []ListenPort{},
	}

	// Try ss first (always available on Ubuntu), fall back to netstat.
	conns, listen := collectSS()
	report.Connections = conns
	report.ListenPorts = listen

	// Read interface stats from /proc/net/dev (always available, no root needed).
	report.Interfaces = collectInterfaces()

	return report, nil
}

// collectSS uses `ss -tunap` to get connections.
func collectSS() ([]Connection, []ListenPort) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	out, err := exec.CommandContext(ctx, "ss", "-tunap", "--no-header").CombinedOutput()
	if err != nil {
		return nil, nil
	}

	var conns []Connection
	var listen []ListenPort

	sc := bufio.NewScanner(strings.NewReader(string(out)))
	for sc.Scan() {
		line := sc.Text()
		fields := strings.Fields(line)
		if len(fields) < 5 {
			continue
		}
		proto := fields[0]
		state := fields[1]
		local := fields[4]
		var remote string
		if len(fields) > 5 {
			remote = fields[5]
		}

		lAddr, lPort := splitAddrPort(local)
		rAddr, rPort := splitAddrPort(remote)

		pid, prog := extractPIDProgram(fields)

		if state == "LISTEN" || remote == "*:*" || remote == "" {
			listen = append(listen, ListenPort{
				Proto:   proto,
				Addr:    lAddr,
				Port:    lPort,
				Program: prog,
				PID:     pid,
			})
			continue
		}

		conns = append(conns, Connection{
			Proto:      proto,
			LocalAddr:  lAddr,
			LocalPort:  lPort,
			RemoteAddr: rAddr,
			RemotePort: rPort,
			State:      state,
			PID:        pid,
			Program:    prog,
		})
	}
	return conns, listen
}

func splitAddrPort(s string) (string, int) {
	if s == "" || s == "*:*" {
		return "*", 0
	}
	// IPv6: [::1]:8080
	if strings.HasPrefix(s, "[") {
		if idx := strings.LastIndex(s, "]:"); idx >= 0 {
			addr := s[1:idx]
			port, _ := strconv.Atoi(s[idx+2:])
			return addr, port
		}
		return s, 0
	}
	// IPv4: 127.0.0.1:8080 or *:8080
	if idx := strings.LastIndex(s, ":"); idx >= 0 {
		addr := s[:idx]
		port, _ := strconv.Atoi(s[idx+1:])
		return addr, port
	}
	return s, 0
}

func extractPIDProgram(fields []string) (int, string) {
	// ss output last field may be: users:(("nginx",pid=12345,fd=6))
	for _, f := range fields {
		if !strings.HasPrefix(f, "users:") {
			continue
		}
		// Extract program name and PID from users:(("name",pid=N,fd=M))
		inner := strings.TrimPrefix(f, "users:((")
		inner = strings.TrimSuffix(inner, "))")
		parts := strings.Split(inner, ",")
		prog := ""
		pid := 0
		for _, p := range parts {
			if strings.HasPrefix(p, "\"") {
				prog = strings.Trim(p, "\"")
			} else if strings.HasPrefix(p, "pid=") {
				pid, _ = strconv.Atoi(strings.TrimPrefix(p, "pid="))
			}
		}
		return pid, prog
	}
	return 0, ""
}

// collectInterfaces reads /proc/net/dev for interface counters.
func collectInterfaces() []InterfaceStat {
	f, err := os.Open("/proc/net/dev")
	if err != nil {
		return nil
	}
	defer f.Close()

	var stats []InterfaceStat
	sc := bufio.NewScanner(f)
	lineNum := 0
	for sc.Scan() {
		lineNum++
		if lineNum <= 2 { // skip headers
			continue
		}
		line := sc.Text()
		// Format: "  eth0: 1234 567 ..."
		colon := strings.Index(line, ":")
		if colon < 0 {
			continue
		}
		name := strings.TrimSpace(line[:colon])
		fields := strings.Fields(line[colon+1:])
		if len(fields) < 10 {
			continue
		}
		rxBytes, _ := strconv.ParseInt(fields[0], 10, 64)
		rxPkts, _ := strconv.ParseInt(fields[1], 10, 64)
		txBytes, _ := strconv.ParseInt(fields[8], 10, 64)
		txPkts, _ := strconv.ParseInt(fields[9], 10, 64)

		// Skip loopback and zero-traffic virtual interfaces.
		if name == "lo" || (rxBytes == 0 && txBytes == 0) {
			continue
		}

		stats = append(stats, InterfaceStat{
			Name:    name,
			RxBytes: rxBytes,
			TxBytes: txBytes,
			RxPkts:  rxPkts,
			TxPkts:  txPkts,
		})
	}
	return stats
}
