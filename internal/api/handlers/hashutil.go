package handlers

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strings"
)

// composeContentHash returns a stable hash of a compose YAML document.
// Line endings are normalized and trailing whitespace trimmed so cosmetic-only
// differences (CRLF vs LF, a trailing newline) do not create a new version.
func composeContentHash(raw string) string {
	normalized := strings.ReplaceAll(raw, "\r\n", "\n")
	normalized = strings.TrimRight(normalized, "\n \t")
	sum := sha256.Sum256([]byte(normalized))
	return hex.EncodeToString(sum[:])
}

// envVarForHash is the canonical, decrypted view of a single env var used for
// content hashing. Value MUST be the plaintext (decrypted) value, never ciphertext,
// because AES-GCM ciphertext is non-deterministic and would defeat dedup.
type envVarForHash struct {
	Key      string
	Value    string
	IsSecret bool
}

// envContentHash returns a stable hash over the canonical plaintext form of an
// env var set. Vars are sorted by key so reordering in the UI does not create a
// new version; a genuine value change does.
func envContentHash(vars []envVarForHash) string {
	sorted := make([]envVarForHash, len(vars))
	copy(sorted, vars)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Key < sorted[j].Key })

	var sb strings.Builder
	for _, v := range sorted {
		sb.WriteString(v.Key)
		sb.WriteByte(0)
		sb.WriteString(v.Value)
		sb.WriteByte(0)
		if v.IsSecret {
			sb.WriteByte('1')
		} else {
			sb.WriteByte('0')
		}
		sb.WriteByte('\n')
	}
	sum := sha256.Sum256([]byte(sb.String()))
	return hex.EncodeToString(sum[:])
}
