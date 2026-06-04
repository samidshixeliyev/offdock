package crypto

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"os"
)

// LoadCACertPool reads a certificate file (PEM, CRT, CER, or DER-encoded)
// and returns an x509.CertPool containing it.
// Returns nil if the file cannot be read or parsed.
func LoadCACertPool(path string) *x509.CertPool {
	if path == "" {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	pool := x509.NewCertPool()

	// Try PEM first (most common: .pem, .crt, .cer).
	if pool.AppendCertsFromPEM(data) {
		return pool
	}

	// Try DER (binary .cer / .der).
	// Strip any PEM headers if AppendCertsFromPEM failed (file may be raw DER).
	for len(data) > 0 {
		var block *pem.Block
		block, data = pem.Decode(data)
		if block == nil {
			// No PEM block — try as raw DER.
			cert, err := x509.ParseCertificate(data)
			if err == nil {
				pool.AddCert(cert)
				return pool
			}
			break
		}
		if block.Type != "CERTIFICATE" {
			continue
		}
		cert, err := x509.ParseCertificate(block.Bytes)
		if err == nil {
			pool.AddCert(cert)
		}
	}

	if len(pool.Subjects()) == 0 { //nolint:staticcheck
		return nil
	}
	return pool
}

// LoadClientCertificate loads a client certificate + private key pair (PEM)
// for use in mutual TLS. Both paths must be non-empty. Returns an error if the
// pair cannot be loaded so callers can surface configuration mistakes.
func LoadClientCertificate(certFile, keyFile string) (tls.Certificate, error) {
	if certFile == "" || keyFile == "" {
		return tls.Certificate{}, fmt.Errorf("both client cert and key files are required")
	}
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("load client cert/key: %w", err)
	}
	return cert, nil
}
