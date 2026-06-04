// Package sse provides a per-stream SSE broadcaster used by log tailing,
// deploy progress, and system stats endpoints.
package sse

import (
	"fmt"
	"net/http"
	"sync"
	"time"
)

const (
	replayBufSize  = 512           // max messages kept per stream for late subscribers
	streamTTL      = 2 * time.Minute // how long a closed stream's buffer is kept
)

// Client is a single connected SSE subscriber.
type Client struct {
	ch   chan string
	done <-chan struct{}
}

type stream struct {
	clients map[*Client]struct{}
	buf     []string  // replay buffer for late subscribers
	closed  bool
	closedAt time.Time
}

// Hub manages a set of SSE clients for a single logical stream identified
// by a string key (e.g. deployment ID or container name).
type Hub struct {
	mu      sync.Mutex
	streams map[string]*stream
}

// New returns a Hub ready for use.
func New() *Hub {
	h := &Hub{streams: make(map[string]*stream)}
	go h.gc()
	return h
}

// gc periodically removes streams that have been closed long enough.
func (h *Hub) gc() {
	for range time.Tick(30 * time.Second) {
		h.mu.Lock()
		for k, s := range h.streams {
			if s.closed && time.Since(s.closedAt) > streamTTL {
				delete(h.streams, k)
			}
		}
		h.mu.Unlock()
	}
}

// Subscribe registers a new SSE client for the given streamKey and serves
// it until the client disconnects or the context is done.
func (h *Hub) Subscribe(w http.ResponseWriter, r *http.Request, streamKey string) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	client := &Client{
		ch:   make(chan string, 128),
		done: r.Context().Done(),
	}

	h.mu.Lock()
	s := h.getOrCreate(streamKey)
	// Replay buffered messages to late subscriber.
	replay := make([]string, len(s.buf))
	copy(replay, s.buf)
	alreadyClosed := s.closed
	if !alreadyClosed {
		s.clients[client] = struct{}{}
	}
	h.mu.Unlock()

	// Send replayed messages before blocking.
	for _, msg := range replay {
		fmt.Fprintf(w, "data: %s\n\n", msg)
	}
	flusher.Flush()

	if alreadyClosed {
		return
	}

	defer h.remove(streamKey, client)

	for {
		select {
		case <-client.done:
			return
		case msg, ok := <-client.ch:
			if !ok {
				return
			}
			fmt.Fprintf(w, "data: %s\n\n", msg)
			flusher.Flush()
		}
	}
}

// Publish sends a message to all subscribers of streamKey and appends it to the replay buffer.
func (h *Hub) Publish(streamKey, message string) {
	h.mu.Lock()
	s := h.getOrCreate(streamKey)
	if len(s.buf) < replayBufSize {
		s.buf = append(s.buf, message)
	}
	clients := make([]*Client, 0, len(s.clients))
	for c := range s.clients {
		clients = append(clients, c)
	}
	h.mu.Unlock()

	for _, c := range clients {
		select {
		case c.ch <- message:
		default:
		}
	}
}

// Close closes all clients subscribed to streamKey and marks the stream done.
func (h *Hub) Close(streamKey string) {
	h.mu.Lock()
	s := h.streams[streamKey]
	if s == nil {
		h.mu.Unlock()
		return
	}
	s.closed = true
	s.closedAt = time.Now()
	clients := make([]*Client, 0, len(s.clients))
	for c := range s.clients {
		clients = append(clients, c)
	}
	s.clients = make(map[*Client]struct{})
	h.mu.Unlock()

	for _, c := range clients {
		close(c.ch)
	}
}

func (h *Hub) getOrCreate(key string) *stream {
	s := h.streams[key]
	if s == nil {
		s = &stream{clients: make(map[*Client]struct{})}
		h.streams[key] = s
	}
	return s
}

func (h *Hub) remove(key string, c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.streams[key]
	if s == nil {
		return
	}
	delete(s.clients, c)
}
