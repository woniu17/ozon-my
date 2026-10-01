# Go 工具链在本机是 ~/.local/go（brew 装不动，见 README）
export PATH := $(HOME)/.local/go/bin:$(PATH)

BIN     := bin/webhook-proxy
LDFLAGS := -trimpath
# 交叉编译用：纯 Go 静态二进制，服务器上不需要 glibc 之外的任何东西
XCG     := CGO_ENABLED=0 GOOS=linux GOARCH=amd64

.PHONY: all build test race vet fmt clean linux

all: fmt vet test build

build:
	go build $(LDFLAGS) -o $(BIN) ./cmd/webhook-proxy

# 服务器是 linux/amd64，本地 mac 交叉编译后 scp 上去
linux:
	$(XCG) go build $(LDFLAGS) -o bin/webhook-proxy-linux-amd64 ./cmd/webhook-proxy

test:
	go test ./...

race:
	go test -race -count=1 ./...

vet:
	go vet ./...

fmt:
	gofmt -l -w .

clean:
	rm -rf bin
