.PHONY: all frontend embed build install dev-backend vendor test clean

BINARY  := offdock
VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
LDFLAGS := -ldflags "-X main.Version=$(VERSION) -s -w"

all: frontend embed build

frontend:
	cd web && npm run build

embed:
	@echo "web/dist is referenced via go:embed in embed.go — no copy needed"

build:
	go build $(LDFLAGS) -o $(BINARY) ./cmd/offdock

vendor:
	go mod vendor

test:
	go test ./... -v -race

install: build
	install -m 0755 $(BINARY) /usr/local/bin/$(BINARY)
	install -m 0644 offdock.service /etc/systemd/system/offdock.service
	systemctl daemon-reload
	@echo "Run: systemctl enable --now offdock"

dev-backend:
	go run ./cmd/offdock

clean:
	rm -f $(BINARY)
	rm -rf web/dist
