#!/usr/bin/env bash
set -euo pipefail

AGENT_NAME="health-coach"
AGENT_DIR="$HOME/.openclaw/agents/$AGENT_NAME"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(dirname "$SCRIPT_DIR")"

echo "[health-sync] Setting up Health Coach agent..."

# 1. Create workspace
mkdir -p "$AGENT_DIR"

# 2. Copy identity file
cp "$PLUGIN_DIR/agent/IDENTITY.md" "$AGENT_DIR/IDENTITY.md"
echo "[health-sync] Copied IDENTITY.md to $AGENT_DIR"

# 3. Register agent (skip if already exists)
if openclaw agents list --json 2>/dev/null | grep -q "\"$AGENT_NAME\""; then
  echo "[health-sync] Agent '$AGENT_NAME' already exists, updating identity..."
else
  openclaw agents add "$AGENT_NAME" \
    --workspace "$AGENT_DIR" \
    --non-interactive
  echo "[health-sync] Created agent '$AGENT_NAME'"
fi

# 4. Set identity from file
openclaw agents set-identity \
  --agent "$AGENT_NAME" \
  --workspace "$AGENT_DIR" \
  --from-identity

echo "[health-sync] Agent '$AGENT_NAME' is ready."
echo ""
echo "To assign the health skill, add this to ~/.openclaw/openclaw.json under agents.list:"
echo ""
echo '  {'
echo '    "id": "health-coach",'
echo '    "skills": ["health-sync"]'
echo '  }'
echo ""
echo "Then chat with it:"
echo "  openclaw chat --agent health-coach"
