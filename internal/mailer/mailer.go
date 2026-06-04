// Package mailer sends emails via SMTP.
// Supports Exchange/Outlook on-prem with STARTTLS, implicit TLS (port 465),
// plain (no TLS), custom CA certificates, and LOGIN auth.
package mailer

import (
	"crypto/tls"
	"fmt"
	"net"
	"net/smtp"
	"strings"
	"time"

	"offdock/internal/crypto"
)

// Mode controls the connection security model.
type Mode string

const (
	ModeSTARTTLS Mode = "starttls" // plain TCP → STARTTLS upgrade (port 587)
	ModeImplicit Mode = "implicit" // TLS from the start (port 465)
	ModePlain    Mode = "plain"    // no TLS (dev/internal only)
)

// Mailer holds SMTP configuration.
type Mailer struct {
	host       string
	port       int
	username   string
	password   string
	from       string
	mode       Mode
	skipVerify bool
	caCertFile string
}

// New creates a Mailer.
// mode: "starttls" | "implicit" | "plain" — defaults to "starttls" if empty.
func New(host string, port int, username, password, from string, mode string, skipVerify bool, caCertFile string) *Mailer {
	m := mode
	if m == "" {
		m = string(ModeSTARTTLS)
	}
	if port == 0 {
		switch Mode(m) {
		case ModeImplicit:
			port = 465
		default:
			port = 587
		}
	}
	return &Mailer{
		host:       host,
		port:       port,
		username:   username,
		password:   password,
		from:       from,
		mode:       Mode(m),
		skipVerify: skipVerify,
		caCertFile: caCertFile,
	}
}

// Configured reports whether the mailer has a host set.
func (m *Mailer) Configured() bool {
	return m != nil && strings.TrimSpace(m.host) != ""
}

// Send sends a plain-text email.
func (m *Mailer) Send(to, subject, body string) error {
	if !m.Configured() {
		return fmt.Errorf("SMTP not configured")
	}
	addr := fmt.Sprintf("%s:%d", m.host, m.port)
	msg := buildMessage(m.from, to, subject, body)

	switch m.mode {
	case ModeImplicit:
		return m.sendImplicit(addr, to, msg)
	case ModePlain:
		return m.sendPlain(addr, to, msg)
	default:
		return m.sendSTARTTLS(addr, to, msg)
	}
}

func (m *Mailer) tlsConfig() *tls.Config {
	cfg := &tls.Config{
		ServerName:         m.host,
		InsecureSkipVerify: m.skipVerify, //nolint:gosec
	}
	if m.caCertFile != "" && !m.skipVerify {
		if pool := crypto.LoadCACertPool(m.caCertFile); pool != nil {
			cfg.RootCAs = pool
		}
	}
	return cfg
}

// sendSTARTTLS — plain TCP then STARTTLS upgrade (Exchange port 587).
func (m *Mailer) sendSTARTTLS(addr, to string, msg []byte) error {
	conn, err := net.DialTimeout("tcp", addr, 15*time.Second)
	if err != nil {
		return fmt.Errorf("dial %s: %w", addr, err)
	}
	c, err := smtp.NewClient(conn, m.host)
	if err != nil {
		conn.Close() //nolint:errcheck
		return fmt.Errorf("smtp client: %w", err)
	}
	defer c.Close() //nolint:errcheck

	ok, _ := c.Extension("STARTTLS")
	if !ok {
		// Refuse to send credentials over a plaintext connection when STARTTLS mode
		// was explicitly configured. Use mode="plain" if TLS is genuinely not needed.
		return fmt.Errorf("server did not advertise STARTTLS — credentials would be sent in plaintext; use mode=implicit (port 465) or mode=plain")
	}
	if err := c.StartTLS(m.tlsConfig()); err != nil {
		return fmt.Errorf("STARTTLS: %w", err)
	}
	return m.doSend(c, to, msg)
}

// sendImplicit — TLS from connection start (Exchange port 465).
func (m *Mailer) sendImplicit(addr, to string, msg []byte) error {
	tlsConn, err := tls.DialWithDialer(
		&net.Dialer{Timeout: 15 * time.Second},
		"tcp", addr, m.tlsConfig(),
	)
	if err != nil {
		return fmt.Errorf("tls dial %s: %w", addr, err)
	}
	c, err := smtp.NewClient(tlsConn, m.host)
	if err != nil {
		tlsConn.Close() //nolint:errcheck
		return fmt.Errorf("smtp client: %w", err)
	}
	defer c.Close() //nolint:errcheck
	return m.doSend(c, to, msg)
}

// sendPlain — no TLS (plain TCP).
func (m *Mailer) sendPlain(addr, to string, msg []byte) error {
	var auth smtp.Auth
	if m.username != "" {
		auth = smtp.PlainAuth("", m.username, m.password, m.host)
	}
	recipients := splitAddrs(to)
	return smtp.SendMail(addr, auth, m.from, recipients, msg)
}

// doSend handles auth + send on an already-connected smtp.Client.
func (m *Mailer) doSend(c *smtp.Client, to string, msg []byte) error {
	if m.username != "" {
		// Try PLAIN first, fall back to LOGIN (Exchange often needs LOGIN).
		auth := smtp.PlainAuth("", m.username, m.password, m.host)
		if err := c.Auth(auth); err != nil {
			if err2 := c.Auth(loginAuth(m.username, m.password)); err2 != nil {
				return fmt.Errorf("smtp auth: %w", err)
			}
		}
	}
	if err := c.Mail(m.from); err != nil {
		return fmt.Errorf("MAIL FROM: %w", err)
	}
	for _, r := range splitAddrs(to) {
		if err := c.Rcpt(r); err != nil {
			return fmt.Errorf("RCPT TO %s: %w", r, err)
		}
	}
	w, err := c.Data()
	if err != nil {
		return fmt.Errorf("DATA: %w", err)
	}
	if _, err := w.Write(msg); err != nil {
		return fmt.Errorf("write: %w", err)
	}
	return w.Close()
}

func splitAddrs(s string) []string {
	var out []string
	for _, a := range strings.Split(s, ",") {
		if a = strings.TrimSpace(a); a != "" {
			out = append(out, a)
		}
	}
	return out
}

func buildMessage(from, to, subject, body string) []byte {
	now := time.Now().Format(time.RFC1123Z)
	var sb strings.Builder
	sb.WriteString("From: " + from + "\r\n")
	sb.WriteString("To: " + to + "\r\n")
	sb.WriteString("Subject: " + subject + "\r\n")
	sb.WriteString("Date: " + now + "\r\n")
	sb.WriteString("MIME-Version: 1.0\r\n")
	sb.WriteString("Content-Type: text/plain; charset=UTF-8\r\n")
	sb.WriteString("\r\n")
	sb.WriteString(body)
	return []byte(sb.String())
}

// loginAuth implements the SMTP LOGIN auth mechanism used by Exchange.
type loginAuthImpl struct{ username, password string }

func loginAuth(username, password string) smtp.Auth {
	return &loginAuthImpl{username, password}
}
func (a *loginAuthImpl) Start(_ *smtp.ServerInfo) (string, []byte, error) {
	return "LOGIN", nil, nil
}
func (a *loginAuthImpl) Next(fromServer []byte, more bool) ([]byte, error) {
	if !more {
		return nil, nil
	}
	prompt := strings.ToLower(strings.TrimSpace(string(fromServer)))
	switch {
	case strings.Contains(prompt, "username"):
		return []byte(a.username), nil
	case strings.Contains(prompt, "password"):
		return []byte(a.password), nil
	default:
		return nil, fmt.Errorf("unexpected server prompt: %s", fromServer)
	}
}
