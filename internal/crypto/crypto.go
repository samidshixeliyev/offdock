// Package crypto provides AES-256-GCM encryption for env var values at rest.
// The encryption key is derived from the host machine UUID so that the data
// files are not portable between machines.
package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"golang.org/x/crypto/hkdf"
)

const appSalt = "offdock-env-secrets-v1"

// Encryptor provides authenticated encryption of arbitrary strings.
type Encryptor struct {
	gcm cipher.AEAD
}

// NewFromMachineID derives a 256-bit key from /etc/machine-id using HKDF-SHA256
// and returns an Encryptor ready for use.
func NewFromMachineID() (*Encryptor, error) {
	raw, err := os.ReadFile("/etc/machine-id")
	if err != nil {
		return nil, fmt.Errorf("read machine-id: %w", err)
	}
	machineID := strings.TrimSpace(string(raw))
	return newEncryptor([]byte(machineID))
}

// NewFromSecret creates an Encryptor from an arbitrary secret (useful in tests).
func NewFromSecret(secret string) (*Encryptor, error) {
	return newEncryptor([]byte(secret))
}

func newEncryptor(ikm []byte) (*Encryptor, error) {
	h := hkdf.New(sha256.New, ikm, []byte(appSalt), []byte("aes-256-gcm"))
	key := make([]byte, 32)
	if _, err := io.ReadFull(h, key); err != nil {
		return nil, fmt.Errorf("hkdf derive key: %w", err)
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Encryptor{gcm: gcm}, nil
}

// Encrypt encrypts plaintext and returns a base64url-encoded ciphertext of the
// form: nonce || ciphertext (both opaque; must be decrypted with Decrypt).
func (e *Encryptor) Encrypt(plaintext string) (string, error) {
	nonce := make([]byte, e.gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", fmt.Errorf("generate nonce: %w", err)
	}
	ct := e.gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return base64.RawURLEncoding.EncodeToString(ct), nil
}

// Decrypt reverses Encrypt and returns the original plaintext.
func (e *Encryptor) Decrypt(encoded string) (string, error) {
	data, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return "", fmt.Errorf("decode ciphertext: %w", err)
	}
	ns := e.gcm.NonceSize()
	if len(data) < ns {
		return "", errors.New("ciphertext too short")
	}
	nonce, ct := data[:ns], data[ns:]
	plain, err := e.gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		return "", fmt.Errorf("decrypt: %w", err)
	}
	return string(plain), nil
}
