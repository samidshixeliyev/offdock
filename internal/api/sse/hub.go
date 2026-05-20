// Package sse provides a per-stream SSE broadcaster used by log tailing,
// deploy progress, and system stats endpoints.
package sse

import (
	"fmt"
	"net/http"
	"sync"
)

// Client is a single connected SSE subscriber.
type Client struct {
	ch     chan string
	done   <-chan struct{}
}

// Hub manages a set of SSE clients for a single logical stream identified
// by a string key (e.g. deployment ID or container name).
type Hub struct {
	mu      sync.Mutex
	streams map[string]map[*Client]struct{}
}

// New returns a Hub ready for use.
func New() *Hub {
	return &Hub{streams: make(map[string]map[*Client]struct{})}
}

// Subscribe registers a new SSE client for the given streamKey and serves
// it until the client disconnects or the context is done.
// The HTTP headers must not have been written before calling Subscribe.
func (h *Hub) Subscribe(w http.ResponseWriter, r *http.Request, streamKey string) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // disable nginx buffering

	client := &Client{
		ch:   make(chan string, 64),
		done: r.Context().Done(),
	}

	h.add(streamKey, client)
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

// Publish sends a message to all subscribers of streamKey.
func (h *Hub) Publish(streamKey, message string) {
	h.mu.Lock()
	clients := h.streams[streamKey]
	h.mu.Unlock()

	for c := range clients {
		select {
		case c.ch <- message:
		default:
			// Slow client — drop message to avoid blocking publisher.
		}
	}
}

// Close closes all clients subscribed to streamKey and removes the stream.
func (h *Hub) Close(streamKey string) {
	h.mu.Lock()
	clients := h.streams[streamKey]
	delete(h.streams, streamKey)
	h.mu.Unlock()

	for c := range clients {
		close(c.ch)
	}
}

func (h *Hub) add(key string, c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.streams[key] == nil {
		h.streams[key] = make(map[*Client]struct{})
	}
	h.streams[key][c] = struct{}{}
}

func (h *Hub) remove(key string, c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.streams[key], c)
	if len(h.streams[key]) == 0 {
		delete(h.streams, key)
	}
}
