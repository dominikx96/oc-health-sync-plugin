#!/usr/bin/env bash
set -euo pipefail

: "${INGEST_API_KEY:?must be set}"
: "${MCP_API_KEY:?must be set}"
: "${MCP_PORT:=3737}"

INGEST_URL="${INGEST_URL:-http://127.0.0.1:8000/functions/v1/ingest}"
MCP_URL="${MCP_URL:-http://127.0.0.1:$MCP_PORT/mcp}"

echo "→ Ingest a test sample"
TODAY="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RESPONSE=$(curl -sS -X POST "$INGEST_URL" \
  -H "Authorization: Bearer $INGEST_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"device_id\": \"smoke-test\",
    \"new_samples\": [{
      \"uuid\": \"smoke-$RANDOM\",
      \"sample_kind\": \"quantity\",
      \"data_type\": \"HKQuantityTypeIdentifierStepCount\",
      \"value\": 4242,
      \"unit\": \"count\",
      \"start_date\": \"$TODAY\",
      \"end_date\":   \"$TODAY\",
      \"source_name\": \"smoke\"
    }],
    \"deleted_ids\": []
  }")
echo "  $RESPONSE"
echo "$RESPONSE" | grep -q '"received":1' || { echo "FAIL: ingest did not receive the sample"; exit 1; }

echo "→ Initialize MCP session"
INIT=$(curl -sS -i -X POST "$MCP_URL" \
  -H "Authorization: Bearer $MCP_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}')
SESSION_ID=$(echo "$INIT" | tr -d '\r' | awk -F': ' 'tolower($1)=="mcp-session-id" {print $2; exit}')
[[ -n "$SESSION_ID" ]] || { echo "FAIL: no session id"; exit 1; }
echo "  session $SESSION_ID"

echo "→ Call health_summary tool"
SUMMARY=$(curl -sS -X POST "$MCP_URL" \
  -H "Authorization: Bearer $MCP_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"health_summary\",\"arguments\":{\"period\":\"day\",\"tz\":\"UTC\"}}}")
echo "  $SUMMARY" | head -c 200
echo
echo "$SUMMARY" | grep -qi 'daily summary' || { echo "FAIL: health_summary did not return markdown"; exit 1; }

echo "✓ smoke test passed"
