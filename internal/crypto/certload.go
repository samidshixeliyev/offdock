package crypto

import (
	"crypto/x509"
	"encoding/pem"
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
