package handlers

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

	authmw "offdock/internal/middleware"
	"offdock/internal/store"
)

const otpTTL = 5 * time.Minute

// OTPRequest generates a 6-digit OTP, hashes it, stores it, and emails it to
// the requesting user. The OTP gates access to the root host terminal.
func (h *H) OTPRequest(w http.ResponseWriter, r *http.Request) {
	user := currentUser(r, h.db.Users)
	if user == nil {
		writeError(w, http.StatusUnauthorized, "not authenticated")
		return
	}
	// Respect the per-user host-terminal gate set by superadmin.
	switch user.EffectiveHostTerminalMode() {
	case store.HostTermDisabled:
		writeError(w, http.StatusForbidden, "host terminal access is disabled for your account")
		return
	case store.HostTermBypass:
		writeJSON(w, http.StatusOK, map[string]any{"bypass": true, "message": "no OTP required for your account"})
		return
	}
	if strings.TrimSpace(user.Email) == "" {
		writeError(w, http.StatusUnprocessableEntity, "your account has no email address — ask an admin to set one before using the root terminal")
		return
	}
	if !h.mailer.Configured() {
		writeError(w, http.StatusUnprocessableEntity, "SMTP not configured — set smtp_host in /etc/offdock/config.yaml")
		return
	}

	// Invalidate any previous unused OTPs for this user+purpose.
	existing, _ := h.db.OTPChallenges.FindWhere(func(o store.OTPChallenge) bool {
		return o.UserID == user.ID && o.Purpose == "terminal" && !o.Used
	})
	for _, old := range existing {
		old.Used = true
		h.db.OTPChallenges.Save(old) //nolint:errcheck
	}

	code, err := generateOTPCode()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not generate OTP")
		return
	}
	hash := hashOTP(code)

	challenge := store.OTPChallenge{
		ID:        store.NewULID(),
		UserID:    user.ID,
		CodeHash:  hash,
		Purpose:   "terminal",
		ExpiresAt: time.Now().UTC().Add(otpTTL),
		Used:      false,
		CreatedAt: time.Now().UTC(),
	}
	if err := h.db.OTPChallenges.Save(challenge); err != nil {
		writeError(w, http.StatusInternalServerError, "could not create OTP")
		return
	}

	h.settingsMu.RLock()
	otpSubjectTpl := h.smtpSettings.OTPSubject
	otpBodyTpl := h.smtpSettings.OTPBody
	h.settingsMu.RUnlock()

	if otpSubjectTpl == "" {
		otpSubjectTpl = "OffDock Root Terminal — OTP Code"
	}
	if otpBodyTpl == "" {
		otpBodyTpl = `Hello {{username}},

A root terminal session was requested on OffDock.

Your one-time password is:

    {{code}}

This code expires in {{expires_minutes}} minutes. If you did not request this, ignore this email.

— OffDock`
	}
	expiresMin := fmt.Sprintf("%d", int(otpTTL.Minutes()))
	subject := otpSubjectTpl
	body := strings.ReplaceAll(otpBodyTpl, "{{username}}", user.Username)
	body = strings.ReplaceAll(body, "{{code}}", code)
	body = strings.ReplaceAll(body, "{{expires_minutes}}", expiresMin)

	if err := h.mailer.Send(user.Email, subject, body); err != nil {
		writeError(w, http.StatusInternalServerError, "could not send OTP email: "+err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"challenge_id": challenge.ID,
		"email":        maskEmail(user.Email),
		"expires_in":   int(otpTTL.Seconds()),
	})
}

// OTPVerify checks the submitted code and returns a short-lived terminal token.
func (h *H) OTPVerify(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ChallengeID string `json:"challenge_id"`
		Code        string `json:"code"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request")
		return
	}
	req.Code = strings.TrimSpace(req.Code)
	if req.Code == "" || req.ChallengeID == "" {
		writeError(w, http.StatusBadRequest, "challenge_id and code are required")
		return
	}

	user := currentUser(r, h.db.Users)
	if user == nil {
		writeError(w, http.StatusUnauthorized, "not authenticated")
		return
	}

	challenge, err := h.db.OTPChallenges.FindByID(req.ChallengeID)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "invalid or expired OTP")
		return
	}
	if challenge.UserID != user.ID || challenge.Purpose != "terminal" {
		writeError(w, http.StatusUnprocessableEntity, "invalid or expired OTP")
		return
	}
	if challenge.Used {
		writeError(w, http.StatusUnprocessableEntity, "OTP already used")
		return
	}
	if time.Now().UTC().After(challenge.ExpiresAt) {
		writeError(w, http.StatusUnprocessableEntity, "OTP expired — request a new one")
		return
	}
	if hashOTP(req.Code) != challenge.CodeHash {
		challenge.Attempts++
		h.db.OTPChallenges.Save(challenge) //nolint:errcheck
		if challenge.Attempts >= 5 {
			challenge.Used = true
			h.db.OTPChallenges.Save(challenge) //nolint:errcheck
			writeError(w, http.StatusUnprocessableEntity, "too many incorrect attempts — request a new OTP")
			return
		}
		writeError(w, http.StatusUnprocessableEntity, "incorrect OTP code")
		return
	}

	// Mark used.
	challenge.Used = true
	h.db.OTPChallenges.Save(challenge) //nolint:errcheck

	// Issue a short-lived terminal token (32-byte random token, stored as hash in DB).
	token, err := generateTerminalToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not generate terminal token")
		return
	}
	termChallenge := store.OTPChallenge{
		ID:        store.NewULID(),
		UserID:    user.ID,
		CodeHash:  hashOTP(token),
		Purpose:   "terminal_token",
		ExpiresAt: time.Now().UTC().Add(10 * time.Minute),
		Used:      false,
		CreatedAt: time.Now().UTC(),
	}
	h.db.OTPChallenges.Save(termChallenge) //nolint:errcheck

	writeJSON(w, http.StatusOK, map[string]any{
		"terminal_token": token,
		"expires_in":     600,
	})
}

// terminalTokenMu serializes validate-and-consume so two concurrent WebSocket
// upgrades presenting the same token cannot both succeed (the append-log store
// has no compare-and-swap of its own).
var terminalTokenMu sync.Mutex

// ValidateTerminalToken checks a single-use terminal token from the WS query
// param and, when valid, atomically consumes it. The token MUST belong to userID
// (the authenticated caller) so a leaked/observed token can't be replayed by a
// different account.
func (h *H) ValidateTerminalToken(token, userID string) bool {
	if token == "" || userID == "" {
		return false
	}
	terminalTokenMu.Lock()
	defer terminalTokenMu.Unlock()

	hash := hashOTP(token)
	challenges, _ := h.db.OTPChallenges.FindWhere(func(o store.OTPChallenge) bool {
		return o.CodeHash == hash && o.Purpose == "terminal_token" && !o.Used
	})
	if len(challenges) == 0 {
		return false
	}
	c := challenges[0]
	if c.UserID != userID {
		return false // token belongs to a different account
	}
	if time.Now().UTC().After(c.ExpiresAt) {
		return false
	}
	// Consume the token — one use only.
	c.Used = true
	h.db.OTPChallenges.Save(c) //nolint:errcheck
	return true
}

// --- helpers ----------------------------------------------------------------

func generateOTPCode() (string, error) {
	max := big.NewInt(1000000)
	n, err := rand.Int(rand.Reader, max)
	if err != nil {
		return "", fmt.Errorf("failed to generate OTP: %w", err)
	}
	return fmt.Sprintf("%06d", n.Int64()), nil
}

func generateTerminalToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("failed to generate terminal token: %w", err)
	}
	return hex.EncodeToString(b), nil
}

func hashOTP(code string) string {
	h := sha256.Sum256([]byte(code))
	return hex.EncodeToString(h[:])
}

func maskEmail(email string) string {
	parts := strings.SplitN(email, "@", 2)
	if len(parts) != 2 {
		return "***"
	}
	local := parts[0]
	if len(local) <= 2 {
		return "**@" + parts[1]
	}
	return string(local[0]) + strings.Repeat("*", len(local)-2) + string(local[len(local)-1]) + "@" + parts[1]
}

// currentUser extracts the authenticated user from request context via JWT claims.
func currentUser(r *http.Request, db interface {
	FindByID(id string) (store.User, error)
}) *store.User {
	claims := authmw.ClaimsFromContext(r.Context())
	if claims == nil {
		return nil
	}
	u, err := db.FindByID(claims.UserID)
	if err != nil {
		return nil
	}
	return &u
}
