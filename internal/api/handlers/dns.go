package handlers

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"offdock/internal/mailer"
	authmw "offdock/internal/middleware"
	"offdock/internal/store"
)

// ListDNSTickets returns all DNS tickets, newest first.
func (h *H) ListDNSTickets(w http.ResponseWriter, r *http.Request) {
	tickets, err := h.db.DNSTickets.FindAll()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not list tickets")
		return
	}
	if tickets == nil {
		tickets = []store.DNSTicket{}
	}
	writeJSON(w, http.StatusOK, tickets)
}

// CreateDNSTicket creates a new DNS record request ticket.
func (h *H) CreateDNSTicket(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RecordType string `json:"record_type"`
		Hostname   string `json:"hostname"`
		Value      string `json:"value"`
		TTL        int    `json:"ttl"`
		Priority   int    `json:"priority"`
		Notes      string `json:"notes"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.RecordType = strings.ToUpper(strings.TrimSpace(req.RecordType))
	req.Hostname = strings.TrimSpace(req.Hostname)
	req.Value = strings.TrimSpace(req.Value)
	if req.RecordType == "" || req.Hostname == "" || req.Value == "" {
		writeError(w, http.StatusBadRequest, "record_type, hostname, and value are required")
		return
	}

	claims := authmw.ClaimsFromContext(r.Context())
	requestedBy := ""
	if claims != nil {
		requestedBy = claims.Username
	}

	now := timeNow()
	ticket := store.DNSTicket{
		ID:          store.NewULID(),
		RecordType:  req.RecordType,
		Hostname:    req.Hostname,
		Value:       req.Value,
		TTL:         req.TTL,
		Priority:    req.Priority,
		Notes:       req.Notes,
		Status:      store.DNSTicketPending,
		RequestedBy: requestedBy,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if err := h.db.DNSTickets.Save(ticket); err != nil {
		writeError(w, http.StatusInternalServerError, "could not save ticket")
		return
	}
	h.logAudit(r, "create_dns_ticket", "dns_ticket", ticket.ID, ticket.Hostname, ticket.RecordType)
	writeJSON(w, http.StatusCreated, ticket)
}

// UpdateDNSTicket updates the status or notes of a ticket.
func (h *H) UpdateDNSTicket(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	ticket, err := h.db.DNSTickets.FindByID(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "ticket not found")
		return
	}

	var req struct {
		Status store.DNSTicketStatus `json:"status"`
		Notes  string                `json:"notes"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Status != "" {
		ticket.Status = req.Status
	}
	if req.Notes != "" {
		ticket.Notes = req.Notes
	}
	ticket.UpdatedAt = timeNow()

	if err := h.db.DNSTickets.Save(ticket); err != nil {
		writeError(w, http.StatusInternalServerError, "could not update ticket")
		return
	}
	writeJSON(w, http.StatusOK, ticket)
}

// DeleteDNSTicket removes a DNS ticket.
func (h *H) DeleteDNSTicket(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.db.DNSTickets.Delete(id); err != nil {
		writeError(w, http.StatusNotFound, "ticket not found")
		return
	}
	h.logAudit(r, "delete_dns_ticket", "dns_ticket", id, "", "")
	w.WriteHeader(http.StatusNoContent)
}

// SendDNSTicket emails the DNS ticket to the configured admin address.
func (h *H) SendDNSTicket(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	ticket, err := h.db.DNSTickets.FindByID(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "ticket not found")
		return
	}

	if !h.mailer.Configured() {
		writeError(w, http.StatusUnprocessableEntity, "SMTP not configured — go to DNS Settings to configure")
		return
	}

	// Allow override recipient in request body, fall back to config.
	var req struct {
		To       string `json:"to"`
		Template string `json:"template"` // optional custom message body
	}
	decodeJSON(r, &req) //nolint:errcheck

	to := strings.TrimSpace(req.To)
	if to == "" {
		to = h.smtpSettings.AdminEmail
	}
	if to == "" {
		writeError(w, http.StatusUnprocessableEntity, "no recipient — set dns_admin_email in config or provide 'to' in request")
		return
	}

	body := buildDNSTicketEmail(ticket, req.Template)
	subject := fmt.Sprintf("[DNS Request] %s %s → %s", ticket.RecordType, ticket.Hostname, ticket.Value)

	if err := h.mailer.Send(to, subject, body); err != nil {
		writeError(w, http.StatusInternalServerError, "send email: "+err.Error())
		return
	}

	ticket.Status = store.DNSTicketSent
	ticket.EmailSentTo = to
	ticket.UpdatedAt = timeNow()
	h.db.DNSTickets.Save(ticket) //nolint:errcheck

	h.logAudit(r, "send_dns_ticket", "dns_ticket", id, ticket.Hostname, to)
	writeJSON(w, http.StatusOK, map[string]any{
		"status":  "sent",
		"sent_to": to,
		"ticket":  ticket,
	})
}

// GetSMTPSettings returns current SMTP configuration (password masked).
func (h *H) GetSMTPSettings(w http.ResponseWriter, r *http.Request) {
	h.settingsMu.RLock()
	s := h.smtpSettings
	h.settingsMu.RUnlock()
	writeJSON(w, http.StatusOK, map[string]any{
		"host":                 s.Host,
		"port":                 s.Port,
		"username":             s.Username,
		"password_set":         s.Password != "",
		"from":                 s.From,
		"mode":                 s.SMTPMode(),
		"starttls":             s.StartTLS,
		"insecure_skip_verify": s.SkipVerify,
		"ca_cert_file":         s.CACertFile,
		"client_cert_file":     s.ClientCertFile,
		"client_key_file":      s.ClientKeyFile,
		"dns_admin_email":      s.AdminEmail,
		"configured":           h.mailer.Configured(),
	})
}

// SaveSMTPSettings updates SMTP configuration at runtime and persists to config.yaml.
func (h *H) SaveSMTPSettings(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Host          string `json:"host"`
		Port          int    `json:"port"`
		Username      string `json:"username"`
		Password      string `json:"password"`
		From          string `json:"from"`
		Mode          string `json:"mode"`              // "starttls" | "implicit" | "plain"
		StartTLS      bool   `json:"starttls"`          // legacy
		SkipVerify     bool   `json:"insecure_skip_verify"`
		CACertFile     string `json:"ca_cert_file"`
		ClientCertFile string `json:"client_cert_file"`
		ClientKeyFile  string `json:"client_key_file"`
		DNSAdminEmail  string `json:"dns_admin_email"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Host == "" {
		writeError(w, http.StatusBadRequest, "host is required")
		return
	}
	// Derive mode from legacy starttls flag if not set explicitly.
	mode := req.Mode
	if mode == "" && req.StartTLS {
		mode = "starttls"
	}
	if req.Port == 0 {
		switch mode {
		case "implicit":
			req.Port = 465
		default:
			req.Port = 587
		}
	}

	h.settingsMu.RLock()
	existingSMTPPwd := h.smtpSettings.Password
	h.settingsMu.RUnlock()
	password := req.Password
	if password == "" {
		password = existingSMTPPwd
	}

	newSMTP := store.SMTPSettings{
		Host:           req.Host,
		Port:           req.Port,
		Username:       req.Username,
		Password:       password,
		From:           req.From,
		Mode:           mode,
		StartTLS:       req.StartTLS,
		SkipVerify:     req.SkipVerify,
		CACertFile:     req.CACertFile,
		ClientCertFile: req.ClientCertFile,
		ClientKeyFile:  req.ClientKeyFile,
		AdminEmail:     req.DNSAdminEmail,
	}
	newMailer := mailer.NewWithClientCert(req.Host, req.Port, req.Username, password, req.From, mode, req.SkipVerify, req.CACertFile, req.ClientCertFile, req.ClientKeyFile)

	// Persist to config.yaml.
	if err := updateConfigYAML(newSMTP); err != nil {
		// Non-fatal — in-memory update still works.
		writeJSON(w, http.StatusOK, map[string]any{
			"status":  "applied (could not persist: " + err.Error() + ")",
			"warning": "settings will reset on service restart — fix /etc/offdock/config.yaml permissions",
		})
		return
	}

	h.settingsMu.Lock()
	h.smtpSettings = newSMTP
	h.mailer = newMailer
	h.settingsMu.Unlock()

	h.logAudit(r, "update_smtp_settings", "system", "", req.Host, "")
	writeJSON(w, http.StatusOK, map[string]string{"status": "saved"})
}

// TestSMTPSettings sends a test email to verify configuration.
func (h *H) TestSMTPSettings(w http.ResponseWriter, r *http.Request) {
	var req struct {
		To string `json:"to"`
	}
	decodeJSON(r, &req) //nolint:errcheck
	to := strings.TrimSpace(req.To)
	if to == "" {
		to = h.smtpSettings.AdminEmail
	}
	if to == "" {
		writeError(w, http.StatusBadRequest, "provide 'to' address or set dns_admin_email")
		return
	}
	if !h.mailer.Configured() {
		writeError(w, http.StatusUnprocessableEntity, "SMTP not configured")
		return
	}

	body := "This is a test email from OffDock.\n\nIf you received this, your SMTP configuration is working correctly.\n\nSent at: " + time.Now().Format(time.RFC1123)
	if err := h.mailer.Send(to, "[OffDock] SMTP Test", body); err != nil {
		writeError(w, http.StatusInternalServerError, "test email failed: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "sent", "to": to})
}

// --- helpers ----------------------------------------------------------------

func buildDNSTicketEmail(t store.DNSTicket, customTemplate string) string {
	if customTemplate != "" {
		// Replace template variables.
		body := customTemplate
		body = strings.ReplaceAll(body, "{{record_type}}", t.RecordType)
		body = strings.ReplaceAll(body, "{{hostname}}", t.Hostname)
		body = strings.ReplaceAll(body, "{{value}}", t.Value)
		body = strings.ReplaceAll(body, "{{ttl}}", fmt.Sprintf("%d", t.TTL))
		body = strings.ReplaceAll(body, "{{priority}}", fmt.Sprintf("%d", t.Priority))
		body = strings.ReplaceAll(body, "{{notes}}", t.Notes)
		body = strings.ReplaceAll(body, "{{requested_by}}", t.RequestedBy)
		body = strings.ReplaceAll(body, "{{created_at}}", t.CreatedAt.Format(time.RFC1123))
		return body
	}

	ttlStr := "default"
	if t.TTL > 0 {
		ttlStr = fmt.Sprintf("%d seconds", t.TTL)
	}
	priorityLine := ""
	if t.Priority > 0 {
		priorityLine = fmt.Sprintf("Priority:     %d\n", t.Priority)
	}
	notesLine := ""
	if t.Notes != "" {
		notesLine = fmt.Sprintf("\nNotes:\n%s\n", t.Notes)
	}

	return fmt.Sprintf(`DNS Record Creation Request
===========================

Please create the following DNS record:

Type:         %s
Hostname:     %s
Value:        %s
TTL:          %s
%s
Requested by: %s
Requested at: %s
Ticket ID:    %s
%s
---
This request was created via OffDock.
Please reply to this email or update the ticket status in the OffDock UI.
`,
		t.RecordType, t.Hostname, t.Value, ttlStr,
		priorityLine, t.RequestedBy,
		t.CreatedAt.Format(time.RFC1123), t.ID,
		notesLine)
}

// updateConfigYAML writes SMTP settings back to /etc/offdock/config.yaml
// using a targeted key-by-key update (preserves all other keys including jwt_secret).
func updateConfigYAML(s store.SMTPSettings) error {
	const configPath = "/etc/offdock/config.yaml"
	data, err := readFileString(configPath)
	if err != nil {
		return err
	}

	updates := map[string]string{
		"smtp_host":                 s.Host,
		"smtp_port":                 fmt.Sprintf("%d", s.Port),
		"smtp_username":             s.Username,
		"smtp_from":                 s.From,
		"smtp_mode":                 s.Mode,
		"smtp_starttls":             boolStr(s.StartTLS),
		"smtp_insecure_skip_verify": boolStr(s.SkipVerify),
		"smtp_ca_cert_file":         s.CACertFile,
		"smtp_client_cert_file":     s.ClientCertFile,
		"smtp_client_key_file":      s.ClientKeyFile,
		"dns_admin_email":           s.AdminEmail,
	}
	if s.Password != "" {
		updates["smtp_password"] = s.Password
	}

	lines := strings.Split(data, "\n")
	set := make(map[string]bool)
	for i, line := range lines {
		for k, v := range updates {
			if strings.HasPrefix(strings.TrimSpace(line), k+":") {
				lines[i] = k + ": " + v
				set[k] = true
			}
		}
	}
	// Append any keys not yet present.
	for k, v := range updates {
		if !set[k] {
			lines = append(lines, k+": "+v)
		}
	}

	return writeFileAtomic(configPath, strings.Join(lines, "\n"))
}

func boolStr(b bool) string {
	if b {
		return "true"
	}
	return "false"
}
