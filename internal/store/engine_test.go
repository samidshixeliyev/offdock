package store_test

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"offdock/internal/store"
)

type testEntity struct {
	ID   string    `json:"id"`
	Name string    `json:"name"`
	TS   time.Time `json:"ts"`
}

func (e testEntity) GetID() string { return e.ID }

func tempCollection(t *testing.T) (*store.Collection[testEntity], string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "test.db")
	col, err := store.NewCollection[testEntity](path)
	if err != nil {
		t.Fatalf("NewCollection: %v", err)
	}
	return col, path
}

func TestSaveAndFind(t *testing.T) {
	col, _ := tempCollection(t)
	defer col.Close()

	e := testEntity{ID: "01ABC", Name: "alpha", TS: time.Now().UTC().Truncate(time.Second)}
	if err := col.Save(e); err != nil {
		t.Fatal(err)
	}

	got, err := col.FindByID(e.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != e.Name {
		t.Fatalf("got %q want %q", got.Name, e.Name)
	}
}

func TestUpdate(t *testing.T) {
	col, _ := tempCollection(t)
	defer col.Close()

	e := testEntity{ID: "02ABC", Name: "beta"}
	_ = col.Save(e)

	e.Name = "beta-updated"
	_ = col.Save(e)

	got, _ := col.FindByID(e.ID)
	if got.Name != "beta-updated" {
		t.Fatalf("got %q", got.Name)
	}
	if col.Count() != 1 {
		t.Fatalf("expected 1 entity, got %d", col.Count())
	}
}

func TestDelete(t *testing.T) {
	col, _ := tempCollection(t)
	defer col.Close()

	e := testEntity{ID: "03ABC", Name: "gamma"}
	_ = col.Save(e)
	if err := col.Delete(e.ID); err != nil {
		t.Fatal(err)
	}

	_, err := col.FindByID(e.ID)
	if err != store.ErrNotFound {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestFindAll(t *testing.T) {
	col, _ := tempCollection(t)
	defer col.Close()

	for i, name := range []string{"a", "b", "c"} {
		_ = col.Save(testEntity{ID: string(rune('A' + i)), Name: name})
	}
	all, err := col.FindAll()
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 3 {
		t.Fatalf("want 3, got %d", len(all))
	}
}

func TestFindWhere(t *testing.T) {
	col, _ := tempCollection(t)
	defer col.Close()

	_ = col.Save(testEntity{ID: "1", Name: "match"})
	_ = col.Save(testEntity{ID: "2", Name: "no"})
	_ = col.Save(testEntity{ID: "3", Name: "match"})

	res, _ := col.FindWhere(func(e testEntity) bool { return e.Name == "match" })
	if len(res) != 2 {
		t.Fatalf("want 2, got %d", len(res))
	}
}

func TestCRCRecovery(t *testing.T) {
	col, path := tempCollection(t)
	_ = col.Save(testEntity{ID: "ok", Name: "good"})
	col.Close()

	// Corrupt the last 4 bytes of the file (part of payload).
	f, _ := os.OpenFile(path, os.O_RDWR, 0o600)
	fi, _ := f.Stat()
	f.WriteAt([]byte{0xFF, 0xFF, 0xFF, 0xFF}, fi.Size()-4)
	f.Close()

	col2, _ := store.NewCollection[testEntity](path)
	defer col2.Close()

	// The corrupted record should be discarded.
	all, _ := col2.FindAll()
	if len(all) != 0 {
		t.Fatalf("corrupted record should have been discarded, got %d", len(all))
	}
}

func TestPersistenceReopen(t *testing.T) {
	col, path := tempCollection(t)
	_ = col.Save(testEntity{ID: "persist", Name: "hello"})
	_ = col.Save(testEntity{ID: "del", Name: "gone"})
	_ = col.Delete("del")
	col.Close()

	col2, _ := store.NewCollection[testEntity](path)
	defer col2.Close()

	if _, err := col2.FindByID("persist"); err != nil {
		t.Fatalf("persist not found after reopen: %v", err)
	}
	if _, err := col2.FindByID("del"); err != store.ErrNotFound {
		t.Fatalf("deleted entity should not exist after reopen")
	}
}
