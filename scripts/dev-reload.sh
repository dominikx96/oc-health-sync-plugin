#!/bin/bash
# Quick rebuild and reload the plugin in OpenClaw gateway
# Usage: ./scripts/dev-reload.sh

set -e

echo "[dev] Building TypeScript..."
npm run build

echo "[dev] Restarting gateway..."
openclaw gateway restart

echo "[dev] Done. Check logs:"
echo "  openclaw gateway logs 2>&1 | grep health-sync"
