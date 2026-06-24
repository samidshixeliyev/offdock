// Package trafficindex is an in-memory index for captured HTTP traffic that
// gives fast search and fast paginated load without scanning the whole store.
//
// Two tree structures back it:
//   - a PREFIX TREE (trie) over lowercased path/method/host tokens → entry IDs,
//     so search is O(len(term)) plus the size of the matching set, not O(n).
//   - a time-ORDERED index (kept sorted newest-first, binary-inserted) so the
//     common "newest N" / pagination query is O(log n) to locate + O(k) to read.
package trafficindex

import (
	"sort"
	"strings"
	"sync"
	"time"
)

// Entry is the light metadata the index keeps in memory (no bodies).
type Entry struct {
	ID         string    `json:"id"`
	Time       time.Time `json:"time"`
	Container  string    `json:"container"`
	Method     string    `json:"method"`
	Host       string    `json:"host"`
	Path       string    `json:"path"`
	Status     int       `json:"status"`
	DurationMs float64   `json:"duration_ms"`
	ReqBytes   int       `json:"req_bytes"`
	RespBytes  int       `json:"resp_bytes"`
}

// trieNode is a node in the prefix tree. ids is the set of entry IDs whose
// indexed tokens pass through this node (i.e. share this prefix).
type trieNode struct {
	children map[rune]*trieNode
	ids      map[string]struct{}
}

func newTrieNode() *trieNode {
	return &trieNode{children: make(map[rune]*trieNode), ids: make(map[string]struct{})}
}

// Index is the concurrency-safe traffic index.
type Index struct {
	mu      sync.RWMutex
	byID    map[string]*Entry
	order   []*Entry // sorted by Time descending (newest first)
	root    *trieNode
}

// New returns an empty index.
func New() *Index {
	return &Index{byID: make(map[string]*Entry), root: newTrieNode()}
}

// tokens returns the lowercased search tokens for an entry: path segments plus
// method and host. Each token is inserted into the trie under its full spelling.
func tokens(e *Entry) []string {
	var out []string
	for _, seg := range strings.FieldsFunc(strings.ToLower(e.Path), func(r rune) bool { return r == '/' || r == '?' || r == '&' || r == '=' }) {
		if seg != "" {
			out = append(out, seg)
		}
	}
	if e.Method != "" {
		out = append(out, strings.ToLower(e.Method))
	}
	if e.Host != "" {
		out = append(out, strings.ToLower(e.Host))
	}
	return out
}

func (ix *Index) trieInsert(token, id string) {
	n := ix.root
	for _, r := range token {
		c := n.children[r]
		if c == nil {
			c = newTrieNode()
			n.children[r] = c
		}
		n = c
		n.ids[id] = struct{}{}
	}
}

// trieCollect returns the IDs whose token has the given prefix.
func (ix *Index) trieCollect(prefix string) map[string]struct{} {
	n := ix.root
	for _, r := range prefix {
		c := n.children[r]
		if c == nil {
			return nil
		}
		n = c
	}
	return n.ids
}

// Add inserts (or replaces) an entry. O(log n) for the ordered index + O(total
// token length) for the trie.
func (ix *Index) Add(e Entry) {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	if _, ok := ix.byID[e.ID]; ok {
		ix.removeLocked(e.ID)
	}
	cp := e
	ix.byID[e.ID] = &cp
	// Binary-insert into the newest-first ordered slice.
	i := sort.Search(len(ix.order), func(i int) bool { return ix.order[i].Time.Before(cp.Time) })
	ix.order = append(ix.order, nil)
	copy(ix.order[i+1:], ix.order[i:])
	ix.order[i] = &cp
	for _, tok := range tokens(&cp) {
		ix.trieInsert(tok, e.ID)
	}
}

func (ix *Index) removeLocked(id string) {
	e, ok := ix.byID[id]
	if !ok {
		return
	}
	delete(ix.byID, id)
	for i, x := range ix.order {
		if x.ID == id {
			ix.order = append(ix.order[:i], ix.order[i+1:]...)
			break
		}
	}
	// Remove the id from every trie node along its tokens.
	for _, tok := range tokens(e) {
		n := ix.root
		for _, r := range tok {
			c := n.children[r]
			if c == nil {
				break
			}
			delete(c.ids, id)
			n = c
		}
	}
}

// Remove deletes an entry by ID.
func (ix *Index) Remove(id string) {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	ix.removeLocked(id)
}

// Clear empties the index.
func (ix *Index) Clear() {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	ix.byID = make(map[string]*Entry)
	ix.order = nil
	ix.root = newTrieNode()
}

// Query filters by an optional search term (prefix-matched via the trie),
// container, and error-only, then returns a page newest-first plus the total
// number of matches.
type Query struct {
	Search    string
	Container string
	ErrorOnly bool
	Limit     int
	Offset    int
}

func (ix *Index) Query(q Query) (page []Entry, total int) {
	ix.mu.RLock()
	defer ix.mu.RUnlock()

	var match map[string]struct{} // nil = match-all
	if term := strings.ToLower(strings.TrimSpace(q.Search)); term != "" {
		ids := ix.trieCollect(term)
		match = make(map[string]struct{}, len(ids))
		for id := range ids {
			match[id] = struct{}{}
		}
	}

	if q.Limit <= 0 {
		q.Limit = 100
	}
	results := make([]Entry, 0, q.Limit)
	for _, e := range ix.order { // already newest-first
		if match != nil {
			if _, ok := match[e.ID]; !ok {
				continue
			}
		}
		if q.Container != "" && e.Container != q.Container {
			continue
		}
		if q.ErrorOnly && e.Status < 400 {
			continue
		}
		total++
		if total <= q.Offset || len(results) >= q.Limit {
			continue
		}
		results = append(results, *e)
	}
	return results, total
}

// Len returns the number of indexed entries.
func (ix *Index) Len() int {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	return len(ix.byID)
}
