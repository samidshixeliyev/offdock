// Package store implements a generic append-log storage engine backed by
// JSON-encoded records with CRC32 integrity checks.
package store

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"sync"
)

const (
	recordTypeActive  = byte(0)
	recordTypeDeleted = byte(1)
	// headerSize = 4 (payload len) + 1 (type) + 4 (CRC32) = 9 bytes
	headerSize = 9
)

// ErrNotFound is returned when an entity does not exist in the collection.
var ErrNotFound = errors.New("entity not found")

// Entity is the constraint satisfied by all storable types.
type Entity interface {
	GetID() string
}

// Collection is a typed, append-log backed persistent store for entities of type T.
//
// On-disk record format (little-endian):
//
//	[4 bytes: payload length uint32][1 byte: record type][4 bytes: CRC32][N bytes: JSON payload]
//
// Reads are served from the in-memory map; mutations append to the log file.
// Startup scans the full file and discards records whose CRC32 does not match.
type Collection[T Entity] struct {
	path string
	mu   sync.RWMutex
	data map[string]T
	f    *os.File // kept open for appends
}

// NewCollection opens (or creates) the collection file at path and replays all
// records into the in-memory map.
func NewCollection[T Entity](path string) (*Collection[T], error) {
	c := &Collection[T]{
		path: path,
		data: make(map[string]T),
	}
	if err := c.load(); err != nil {
		return nil, fmt.Errorf("store load %s: %w", path, err)
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return nil, fmt.Errorf("store open %s: %w", path, err)
	}
	c.f = f
	return c, nil
}

// Close releases the file handle. The collection must not be used after Close.
func (c *Collection[T]) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.f != nil {
		return c.f.Close()
	}
	return nil
}

// Save persists entity (insert or update) and updates the in-memory map.
func (c *Collection[T]) Save(entity T) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.appendRecord(recordTypeActive, entity); err != nil {
		return err
	}
	c.data[entity.GetID()] = entity
	return nil
}

// FindByID returns the entity with the given id or ErrNotFound.
func (c *Collection[T]) FindByID(id string) (T, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	e, ok := c.data[id]
	if !ok {
		var zero T
		return zero, ErrNotFound
	}
	return e, nil
}

// FindAll returns every active entity in undefined order.
func (c *Collection[T]) FindAll() ([]T, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := make([]T, 0, len(c.data))
	for _, v := range c.data {
		out = append(out, v)
	}
	return out, nil
}

// FindWhere returns all entities for which predicate returns true.
// Always returns a non-nil slice so JSON encoding produces [] not null.
func (c *Collection[T]) FindWhere(predicate func(T) bool) ([]T, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := []T{} // never nil
	for _, v := range c.data {
		if predicate(v) {
			out = append(out, v)
		}
	}
	return out, nil
}

// Delete appends a tombstone record and removes the entity from the in-memory map.
func (c *Collection[T]) Delete(id string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	entity, ok := c.data[id]
	if !ok {
		return ErrNotFound
	}
	if err := c.appendRecord(recordTypeDeleted, entity); err != nil {
		return err
	}
	delete(c.data, id)
	return nil
}

// Count returns the number of active entities.
func (c *Collection[T]) Count() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return len(c.data)
}

// Compact rewrites the log file containing only the live (active) records,
// discarding all tombstones and superseded versions. This reclaims disk space
// and shrinks startup replay time/memory for append-heavy collections.
//
// It writes a fresh file atomically (write-then-rename) per the project's file
// constraint, then reopens the append handle on the new file. Returns the number
// of bytes reclaimed (old size minus new size).
func (c *Collection[T]) Compact() (int64, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	oldSize := int64(0)
	if fi, err := os.Stat(c.path); err == nil {
		oldSize = fi.Size()
	}

	tmp := c.path + ".compact"
	out, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return 0, fmt.Errorf("compact open tmp: %w", err)
	}

	for _, entity := range c.data {
		payload, err := json.Marshal(entity)
		if err != nil {
			out.Close()
			os.Remove(tmp) //nolint:errcheck
			return 0, fmt.Errorf("compact marshal: %w", err)
		}
		header := make([]byte, headerSize)
		binary.LittleEndian.PutUint32(header[0:4], uint32(len(payload)))
		header[4] = recordTypeActive
		binary.LittleEndian.PutUint32(header[5:9], crc32.ChecksumIEEE(payload))
		if _, err := out.Write(append(header, payload...)); err != nil {
			out.Close()
			os.Remove(tmp) //nolint:errcheck
			return 0, fmt.Errorf("compact write: %w", err)
		}
	}
	if err := out.Sync(); err != nil {
		out.Close()
		os.Remove(tmp) //nolint:errcheck
		return 0, fmt.Errorf("compact sync: %w", err)
	}
	out.Close()

	// Swap the append handle to the new file. Close the current handle first so
	// the rename succeeds on platforms that lock open files.
	if c.f != nil {
		c.f.Close() //nolint:errcheck
		c.f = nil
	}
	if err := os.Rename(tmp, c.path); err != nil {
		// Best effort: reopen original so the collection stays usable.
		c.f, _ = os.OpenFile(c.path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
		os.Remove(tmp) //nolint:errcheck
		return 0, fmt.Errorf("compact rename: %w", err)
	}
	f, err := os.OpenFile(c.path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return 0, fmt.Errorf("compact reopen: %w", err)
	}
	c.f = f

	newSize := int64(0)
	if fi, err := os.Stat(c.path); err == nil {
		newSize = fi.Size()
	}
	reclaimed := oldSize - newSize
	if reclaimed < 0 {
		reclaimed = 0
	}
	return reclaimed, nil
}

// --- internal ------------------------------------------------------------------

func (c *Collection[T]) load() error {
	f, err := os.OpenFile(c.path, os.O_RDONLY|os.O_CREATE, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()

	header := make([]byte, headerSize)
	for {
		if _, err := io.ReadFull(f, header); err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
				break
			}
			return err
		}

		payloadLen := binary.LittleEndian.Uint32(header[0:4])
		recordType := header[4]
		expectedCRC := binary.LittleEndian.Uint32(header[5:9])

		payload := make([]byte, payloadLen)
		if _, err := io.ReadFull(f, payload); err != nil {
			// Truncated record at end of file — safe to stop.
			break
		}

		if crc32.ChecksumIEEE(payload) != expectedCRC {
			// Corrupted record — skip silently; next record may be valid.
			continue
		}

		var entity T
		if err := json.Unmarshal(payload, &entity); err != nil {
			continue
		}

		if recordType == recordTypeActive {
			c.data[entity.GetID()] = entity
		} else {
			delete(c.data, entity.GetID())
		}
	}
	return nil
}

func (c *Collection[T]) appendRecord(recordType byte, entity T) error {
	payload, err := json.Marshal(entity)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}

	header := make([]byte, headerSize)
	binary.LittleEndian.PutUint32(header[0:4], uint32(len(payload)))
	header[4] = recordType
	binary.LittleEndian.PutUint32(header[5:9], crc32.ChecksumIEEE(payload))

	record := append(header, payload...) //nolint:gocritic
	if _, err := c.f.Write(record); err != nil {
		return fmt.Errorf("write record: %w", err)
	}
	return c.f.Sync()
}
