# oc-health-sync — OpenClaw Plugin

Receives Apple HealthKit data from the [oc-health-sync iOS app](../), stores it in a local SQLite database, and exposes agent tools for querying and summarizing health data. All data stays on your machine.

## Features

- **Ingest endpoint** — receives health samples from the iOS app via `POST /api/v1/health/ingest`
- **Health check** — `GET /api/v1/health` for connection testing
- **Agent tools** — 4 tools the OpenClaw agent uses to answer health questions:
  - `health_summary` — daily/weekly/monthly markdown summaries
  - `health_query` — specific metric queries with aggregation
  - `health_anomalies` — trend detection (HRV decline, sleep deficit, etc.)
  - `health_raw` — raw sample access
- **Auto-generated API key** — zero-config install, key generated on first run
- **Summary caching** — repeat queries are fast, cache invalidates when new data arrives

## Install (for users)

```bash
openclaw plugins install @oc-health-sync/openclaw-plugin
openclaw gateway restart
```

Check the gateway logs for your auto-generated API key:

```bash
openclaw gateway logs 2>&1 | grep "health-sync"
```

Configure your iOS app with the displayed API key and your server URL.

### Manual configuration (optional)

In `~/.openclaw/config.yaml`:

```yaml
plugins:
  entries:
    health-sync:
      enabled: true
      config:
        apiKey: "your-custom-key-here"          # optional, auto-generated if omitted
        storagePath: "~/.openclaw/state/health-sync/health.sqlite"  # default
        summaryCacheTtlMinutes: 60              # default
```

## Development

### Prerequisites

- Node.js 22+
- OpenClaw installed (`npm install -g openclaw@latest`)
- OpenClaw gateway running (`openclaw gateway start`)

### First-time setup

```bash
npm install
./scripts/dev-setup.sh
```

This builds the plugin, symlinks it into OpenClaw (no copying), and restarts the gateway.

### Dev workflow (recommended)

Run TypeScript in watch mode — the gateway auto-reloads when `dist/` changes:

```bash
npm run dev
```

Save a `.ts` file → tsc recompiles → gateway hot-reloads. No manual steps.

### Manual reload (fallback)

If hot reload doesn't pick up a change:

```bash
./scripts/dev-reload.sh
```

### Testing with curl

```bash
API_KEY="<key-from-logs>"

# Health check
curl -s http://127.0.0.1:18789/api/v1/health \
  -H "Authorization: Bearer $API_KEY"

# Send test data
curl -s http://127.0.0.1:18789/api/v1/health/ingest \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "device_id": "test-device",
    "new_samples": [{
      "uuid": "test-001",
      "sample_kind": "quantity",
      "data_type": "HKQuantityTypeIdentifierStepCount",
      "value": 8432,
      "unit": "count",
      "start_date": "2026-04-03T10:00:00Z",
      "end_date": "2026-04-03T10:00:00Z",
      "source_name": "iPhone"
    }],
    "deleted_ids": []
  }'

# Check data landed
sqlite3 ~/.openclaw/state/health-sync/health.sqlite \
  "SELECT data_type, COUNT(*) FROM health_samples WHERE deleted_at IS NULL GROUP BY data_type;"
```

### Connecting the iOS app

The OpenClaw gateway only listens on `localhost`, so the iOS app can't reach it directly over the network. [Tailscale](https://tailscale.com) creates an encrypted WireGuard tunnel between your devices and proxies the localhost service to your private network. No port forwarding, no firewall changes, works from anywhere.

#### 1. Install Tailscale

**On your server (VPS — Ubuntu/Debian):**

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

**On your server (macOS):**

Install from the [Mac App Store](https://apps.apple.com/app/tailscale/id1475387142) or `brew install tailscale`, then sign in.

**On your iPhone:**

Install from the [App Store](https://apps.apple.com/app/tailscale/id1470499037) and sign in with the same Tailscale account.

Verify all devices see each other:

```bash
tailscale status
```

#### 2. Expose the gateway to your tailnet

Run this on the machine where OpenClaw is running. It makes `localhost:18789` reachable from your other Tailscale devices — and **only** from them (not the public internet):

```bash
tailscale serve --bg --tcp 18789 18789
```

Verify it's active:

```bash
tailscale serve status
```

The `--bg` flag persists the configuration across reboots. On a VPS, Tailscale runs as a systemd service, so this works unattended. On macOS, Tailscale must be running (add it to Login Items). To stop serving later: `tailscale serve --tcp=18789 off`.

#### 3. Connect from the iOS app

Find your server's Tailscale IP:

```bash
tailscale ip -4
# e.g. 100.64.1.42
```

In the iOS app, set the server URL to `http://<tailscale-ip>:18789`, paste your API key, and tap "Test Connection".

> **Security note:** All traffic is encrypted end-to-end by Tailscale's WireGuard tunnel. The `tailscale serve` command exposes the port **only** to your private tailnet. Do **not** use `tailscale funnel`, which would expose it to the public internet.

### Checking logs

```bash
openclaw gateway logs 2>&1 | grep "health-sync"
```

Ingest logs show sample counts and type breakdowns:

```
[health-sync] 📥 Ingest request from device A1B2C3: 142 samples, 0 deletes
[health-sync] ✅ Stored 142 samples, soft-deleted 0 | Dates: 2026-04-02, 2026-04-03 | HeartRate: 87, StepCount: 34
```

## Health Coach agent (optional)

You can create a dedicated agent with a health analyst persona that uses the plugin's tools and skill.

### Setup

```bash
./scripts/setup-agent.sh
```

This creates the agent workspace at `~/.openclaw/agents/health-coach/` with an `IDENTITY.md` defining the persona.

### Assign the health skill

Add the agent to your `~/.openclaw/openclaw.json`:

```json
{
  "agents": {
    "list": [
      {
        "id": "health-coach",
        "skills": ["health-sync"]
      }
    ]
  }
}
```

### Talk to it

```bash
# Single message
openclaw agent --agent health-coach -m "How was my health this week?"

# Interactive terminal UI
openclaw tui
```

The agent has access to all four health tools (`health_summary`, `health_query`, `health_anomalies`, `health_raw`) and knows how to analyze your data.

## Project Structure

```
src/
├── index.ts                    # Plugin entry point
├── db/
│   ├── connection.ts           # SQLite connection + WAL mode
│   ├── schema.ts               # 3 tables + indexes
│   └── queries.ts              # Typed query helpers
├── routes/
│   ├── healthcheck.ts          # GET /api/v1/health
│   └── ingest.ts               # POST /api/v1/health/ingest
├── tools/
│   ├── summary.ts              # health_summary tool
│   ├── query.ts                # health_query tool
│   ├── anomalies.ts            # health_anomalies tool
│   └── raw.ts                  # health_raw tool
├── summary/
│   ├── generator.ts            # SQL → markdown with caching
│   └── templates.ts            # Markdown rendering
└── utils/
    ├── auth.ts                 # API key validation
    ├── http.ts                 # JSON body parsing
    ├── config.ts               # Config resolution + auto-gen key
    └── constants.ts            # Sleep stages, workout names, metrics
skills/health/SKILL.md          # Agent skill instructions
```

## How It Works

```
iOS App                          OpenClaw Plugin
────────                         ───────────────
POST /api/v1/health/ingest  ──────────► HTTP Route Handler
                                      │
                                      ▼
                                 SQLite DB (raw samples)
                                      │
Agent asks                            ▼
"How was my sleep?"              Summary Generator
      │                               │
      ▼                               ▼
health_summary tool  ◄────────  Markdown Summary (cached)
      │
      ▼
Agent responds with
compact, accurate answer
```

## Security

- API key validated on every request (timing-safe comparison)
- No outbound network requests — data stays local
- SQLite WAL mode for concurrent reads during writes
- Soft-delete semantics — no data permanently lost
