package handlers

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math/big"
	"net/http"
	"strings"
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

	code := generateOTPCode()
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

	subject := "OffDock Root Terminal — OTP Code"
	body := fmt.Sprintf(`Hello %s,

A root terminal session was requested on OffDock.

Your one-time password is:

    %s

This code expires in 5 minutes. If you did not request this, ignore this email.

— OffDock`, user.Username, code)

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
		writeError(w, http.StatusUnprocessableEntity, "incorrect OTP code")
		return
	}

	// Mark used.
	challenge.Used = true
	h.db.OTPChallenges.Save(challenge) //nolint:errcheck

	// Issue a short-lived terminal token (signed JWT with 10-min expiry, stored in DB).
	token := generateTerminalToken()
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

// ValidateTerminalToken checks a terminal token from the WS query param.
// Returns the user ID if valid, empty string otherwise.
func (h *H) ValidateTerminalToken(token string) bool {
	if token == "" {
		return false
	}
	hash := hashOTP(token)
	challenges, _ := h.db.OTPChallenges.FindWhere(func(o store.OTPChallenge) bool {
		return o.CodeHash == hash && o.Purpose == "terminal_token" && !o.Used
	})
	if len(challenges) == 0 {
		return false
	}
	c := challenges[0]
	if time.Now().UTC().After(c.ExpiresAt) {
		return false
	}
	// Consume the token — one use only.
	c.Used = true
	h.db.OTPChallenges.Save(c) //nolint:errcheck
	return true
}

// --- helpers ----------------------------------------------------------------

func generateOTPCode() string {
	max := big.NewInt(1000000)
	n, err := rand.Int(rand.Reader, max)
	if err != nil {
		n = big.NewInt(123456)
	}
	return fmt.Sprintf("%06d", n.Int64())
}

func generateTerminalToken() string {
	b := make([]byte, 32)
	rand.Read(b) //nolint:errcheck
	return hex.EncodeToString(b)
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
