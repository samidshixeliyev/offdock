// Package mailer sends emails via SMTP (Exchange/Outlook on-prem or any SMTP).
// Uses only Go stdlib — no external dependencies, safe for offline deployments.
package mailer

import (
	"crypto/tls"
	"fmt"
	"net"
	"net/smtp"
	"strings"
	"time"
)

// Mailer holds SMTP configuration.
type Mailer struct {
	host       string
	port       int
	username   string
	password   string
	from       string
	startTLS   bool
	skipVerify bool
}

// New creates a Mailer. port=0 defaults to 587 (STARTTLS).
func New(host string, port int, username, password, from string, startTLS, skipVerify bool) *Mailer {
	if port == 0 {
		port = 587
	}
	return &Mailer{
		host:       host,
		port:       port,
		username:   username,
		password:   password,
		from:       from,
		startTLS:   startTLS,
		skipVerify: skipVerify,
	}
}

// Configured reports whether the mailer has a host set.
func (m *Mailer) Configured() bool {
	return m != nil && strings.TrimSpace(m.host) != ""
}

// Send sends a plain-text email. to may be a single address or comma-separated list.
func (m *Mailer) Send(to, subject, body string) error {
	if !m.Configured() {
		return fmt.Errorf("SMTP not configured — set smtp_host in /etc/offdock/config.yaml")
	}

	addr := fmt.Sprintf("%s:%d", m.host, m.port)
	msg := buildMessage(m.from, to, subject, body)

	if m.startTLS {
		return m.sendStartTLS(addr, to, msg)
	}
	return m.sendPlain(addr, to, msg)
}

func (m *Mailer) sendStartTLS(addr, to string, msg []byte) error {
	tlsCfg := &tls.Config{
		ServerName:         m.host,
		InsecureSkipVerify: m.skipVerify, //nolint:gosec
	}

	conn, err := net.DialTimeout("tcp", addr, 10*time.Second)
	if err != nil {
		return fmt.Errorf("dial %s: %w", addr, err)
	}

	c, err := smtp.NewClient(conn, m.host)
	if err != nil {
		conn.Close() //nolint:errcheck
		return fmt.Errorf("smtp client: %w", err)
	}
	defer c.Close() //nolint:errcheck

	if ok, _ := c.Extension("STARTTLS"); ok {
		if err := c.StartTLS(tlsCfg); err != nil {
			return fmt.Errorf("STARTTLS: %w", err)
		}
	}

	if m.username != "" {
		auth := smtp.PlainAuth("", m.username, m.password, m.host)
		if err := c.Auth(auth); err != nil {
			// Exchange sometimes needs LOGIN auth — try it
			auth = loginAuth(m.username, m.password)
			if err2 := c.Auth(auth); err2 != nil {
				return fmt.Errorf("smtp auth: %w", err)
			}
		}
	}

	if err := c.Mail(m.from); err != nil {
		return fmt.Errorf("MAIL FROM: %w", err)
	}
	for _, r := range strings.Split(to, ",") {
		r = strings.TrimSpace(r)
		if r == "" {
			continue
		}
		if err := c.Rcpt(r); err != nil {
			return fmt.Errorf("RCPT TO %s: %w", r, err)
		}
	}

	w, err := c.Data()
	if err != nil {
		return fmt.Errorf("DATA: %w", err)
	}
	if _, err := w.Write(msg); err != nil {
		return fmt.Errorf("write body: %w", err)
	}
	return w.Close()
}

func (m *Mailer) sendPlain(addr, to string, msg []byte) error {
	var auth smtp.Auth
	if m.username != "" {
		auth = smtp.PlainAuth("", m.username, m.password, m.host)
	}
	recipients := strings.Split(to, ",")
	for i, r := range recipients {
		recipients[i] = strings.TrimSpace(r)
	}
	return smtp.SendMail(addr, auth, m.from, recipients, msg)
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

// loginAuth implements the SMTP LOGIN auth mechanism used by some Exchange servers.
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
