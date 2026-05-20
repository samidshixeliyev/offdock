package store

import (
	"crypto/rand"
	"encoding/binary"
	"sync/atomic"
	"time"
)

var ulidCounter uint32

// NewULID returns a new Crockford base32-encoded ULID.
func NewULID() string {
	ms := uint64(time.Now().UnixMilli())
	cnt := atomic.AddUint32(&ulidCounter, 1)

	var rnd [10]byte
	rand.Read(rnd[:]) //nolint:errcheck
	binary.BigEndian.PutUint32(rnd[6:], cnt)

	var b [16]byte
	b[0] = byte(ms >> 40)
	b[1] = byte(ms >> 32)
	b[2] = byte(ms >> 24)
	b[3] = byte(ms >> 16)
	b[4] = byte(ms >> 8)
	b[5] = byte(ms)
	copy(b[6:], rnd[:10])

	return encodeCrockford(b)
}

const crockfordAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

func encodeCrockford(b [16]byte) string {
	// 128 bits → 26 Crockford base32 characters (5 bits each, 26*5=130 ≥ 128).
	const chars = 26
	out := make([]byte, chars)
	for i := 0; i < chars; i++ {
		// Extract 5-bit group starting at bit position i*5.
		pos := i * 5
		byteIdx := pos / 8
		bitIdx := pos % 8
		var val byte
		if byteIdx < 16 {
			val = b[byteIdx] << bitIdx
			if bitIdx > 3 && byteIdx+1 < 16 {
				val |= b[byteIdx+1] >> (8 - bitIdx)
			}
		}
		out[i] = crockfordAlphabet[(val>>3)&0x1F]
	}
	return string(out)
}
