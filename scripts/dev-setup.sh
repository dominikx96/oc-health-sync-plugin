#!/bin/bash
# First-time dev setup: link plugin to OpenClaw and start watch mode
# Usage: ./scripts/dev-setup.sh

set -e

echo "[setup] Building plugin..."
npm run build

echo "[setup] Removing old install (if any)..."
rm -rf ~/.openclaw/extensions/health-sync
openclaw plugins uninstall health-sync 2>/dev/null || true

echo "[setup] Installing with --link (symlink, no copy)..."
openclaw plugins install -l .

echo "[setup] Restarting gateway..."
openclaw gateway restart

echo ""
echo "[setup] Done! Dev workflow:"
echo "  1. Run 'npm run dev' in one terminal (tsc watch mode)"
echo "  2. Gateway auto-reloads on changes"
echo "  3. Check logs: openclaw gateway logs 2>&1 | grep health-sync"
