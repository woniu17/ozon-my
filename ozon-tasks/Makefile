# Go 工具链在本机装在 ~/.local/go（brew 装不动）；proxy.golang.org 连不通，模块一律走 goproxy.cn
export PATH := $(HOME)/.local/go/bin:$(PATH)
export GOPROXY := https://goproxy.cn,direct
# 锁死本地工具链：go.mod 里的 go 指令若比已装的 new，go 会悄悄去下载 toolchain，那台机器一旦没网就崩
export GOTOOLCHAIN := local

BIN     := bin/ozon-tasks
LDFLAGS := -trimpath
# nuc 是 linux/amd64；modernc.org/sqlite 是纯 Go 驱动，所以 CGO_ENABLED=0 也能静态编译
XCG     := CGO_ENABLED=0 GOOS=linux GOARCH=amd64

.PHONY: all build test race vet fmt clean linux

all: fmt vet test build

build:
	go build $(LDFLAGS) -o $(BIN) ./cmd/ozon-tasks

linux:
	$(XCG) go build $(LDFLAGS) -o bin/ozon-tasks-linux-amd64 ./cmd/ozon-tasks

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
