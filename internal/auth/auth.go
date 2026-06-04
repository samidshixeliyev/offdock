// Package auth handles JWT issuance/verification and password hashing.
package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"

	"offdock/internal/store"
)

const (
	jwtExpiry    = 8 * time.Hour
	bcryptCost   = 12
	tokenCookieN = "offdock_token"
)

// TokenCookieName is the name of the httpOnly cookie carrying the JWT.
const TokenCookieName = tokenCookieN

// Claims is the JWT payload.
type Claims struct {
	UserID    string     `json:"uid"`
	Username  string     `json:"sub"`
	Role      store.Role `json:"role"`
	SessionID string     `json:"sid"`
	jwt.RegisteredClaims
}

// Service provides stateless authentication helpers.
type Service struct {
	secret []byte
}

// New returns an auth.Service using secret for HMAC-SHA256 signing.
func New(secret string) *Service {
	return &Service{secret: []byte(secret)}
}

// Issue signs and returns a JWT for the given user, bound to a session ID.
func (s *Service) Issue(user store.User, sessionID string) (string, error) {
	claims := Claims{
		UserID:    user.ID,
		Username:  user.Username,
		Role:      user.Role,
		SessionID: sessionID,
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(jwtExpiry)),
		},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return tok.SignedString(s.secret)
}

// Verify parses and validates a JWT, returning its claims on success.
func (s *Service) Verify(tokenStr string) (*Claims, error) {
	tok, err := jwt.ParseWithClaims(tokenStr, &Claims{}, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return s.secret, nil
	})
	if err != nil {
		return nil, err
	}
	claims, ok := tok.Claims.(*Claims)
	if !ok || !tok.Valid {
		return nil, errors.New("invalid token")
	}
	return claims, nil
}

// HMACSign returns a hex-encoded HMAC-SHA256 of data using the service secret.
func (s *Service) HMACSign(data string) string {
	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte(data))
	return hex.EncodeToString(mac.Sum(nil))
}

// HMACVerify returns true when sig matches HMAC-SHA256(data, secret).
func (s *Service) HMACVerify(data, sig string) bool {
	expected := s.HMACSign(data)
	eSig, err := hex.DecodeString(sig)
	if err != nil {
		return false
	}
	eExp, err := hex.DecodeString(expected)
	if err != nil {
		return false
	}
	return hmac.Equal(eSig, eExp)
}

// HashPassword returns a bcrypt hash of plain.
func HashPassword(plain string) (string, error) {
	h, err := bcrypt.GenerateFromPassword([]byte(plain), bcryptCost)
	if err != nil {
		return "", err
	}
	return string(h), nil
}

// CheckPassword returns nil if plain matches hash.
func CheckPassword(plain, hash string) error {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(plain))
}
