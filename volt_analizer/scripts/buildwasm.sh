#!/bin/sh

set -e

GOARCH=wasm GOOS=js go build -o lib.wasm ./cmd/wasm/main.go
cp "$(go env GOROOT)/misc/wasm/wasm_exec.js" ./wasm_exec.js
