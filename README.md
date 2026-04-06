# oc-health-sync — OpenClaw Plugin

Receives Apple HealthKit data from the [oc-health-sync iOS app](../), stores it in a local SQLite database, and exposes agent tools for querying and summarizing health data. **All data stays on the machine running OpenClaw** — nothing leaves your network.

Uses Node's built-in `node:sqlite` module — **no native bindings**, no build toolchain needed, no post-install steps.

---

## Before you install

You need all of the following on the **server** that will run the plugin (this can be your laptop, a home server, or a VPS):

| Requirement | Why | How to get it |
|---|---|---|
| **OpenClaw** ≥ `2026.2.0` with the gateway running | The plugin is hosted inside OpenClaw's gateway process. | `npm install -g openclaw@latest` then `openclaw gateway start` |
| **Node.js 24+** | Required for the stable built-in `node:sqlite` module. | [nodejs.org](https://nodejs.org) or `nvm install 24` |
| **The oc-health-sync iOS app** | The plugin is the receiver — it needs data from the iOS app. | [Repo / TestFlight link](../) |

If the server is a **remote VPS**, you also need a private tunnel from your iPhone to the gateway (it only binds to `localhost`). See [Connecting from a remote server](#connecting-from-a-remote-server) below — Tailscale is the recommended route.

---

## Install

> The plugin is currently pre-1.0 and published under the `next` dist-tag. Use `@next` explicitly until a stable `latest` is promoted.

### 1. Install the package

```bash
openclaw plugins install @oc-health-sync/openclaw-plugin@next
```

### 2. Restart the gateway + grab the API key

```bash
openclaw gateway restart
openclaw gateway logs 2>&1 | grep "health-sync"
```

### 3. Connect the iOS app

- **Server URL:** `http://127.0.0.1:18789` (local) or `http://<tailscale-ip>:18789` (remote)
- **API key:** paste the key from the logs
- Tap **Test Connection**.

That's it — the app will start uploading samples on its next sync.

### Install from source

```bash
git clone https://github.com/dominikx96/oc-health-sync-plugin.git
cd oc-health-sync-plugin
npm install
npm run build
openclaw plugins install .
openclaw gateway restart
```

---

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
- **Zero native dependencies** — uses Node's built-in `node:sqlite`, works with OpenClaw's `--ignore-scripts` install

---

## Connecting from a remote server

The OpenClaw gateway only listens on `localhost`, so the iOS app can't reach it directly over the network. [Tailscale](https://tailscale.com) creates an encrypted WireGuard tunnel between your devices and proxies the localhost service to your private network. No port forwarding, no firewall changes, works from anywhere.

### 1. Install Tailscale

**On your VPS (Ubuntu/Debian):**

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

**On a macOS server:** install from the [Mac App Store](https://apps.apple.com/app/tailscale/id1475387142) or `brew install tailscale`, then sign in.

**On your iPhone:** install from the [App Store](https://apps.apple.com/app/tailscale/id1470499037) and sign in with the same Tailscale account.

Verify both devices see each other:

```bash
tailscale status
```

### 2. Expose the gateway to your tailnet

Run this on the machine where OpenClaw is running. It makes `localhost:18789` reachable from your other Tailscale devices — and **only** from them (not the public internet):

```bash
tailscale serve --bg --tcp 18789 18789
tailscale serve status
```

The `--bg` flag persists the configuration across reboots. On a VPS, Tailscale runs as a systemd service, so this works unattended. On macOS, Tailscale must be running (add it to Login Items). To stop serving later: `tailscale serve --tcp=18789 off`.

### 3. Point the iOS app at the tailnet IP

```bash
tailscale ip -4
# e.g. 100.64.1.42
```

In the iOS app, set the server URL to `http://<tailscale-ip>:18789`, paste your API key, and tap **Test Connection**.

> **Security:** all traffic is encrypted end-to-end by Tailscale's WireGuard tunnel. `tailscale serve` exposes the port **only** to your private tailnet. Do **not** use `tailscale funnel`, which would expose it to the public internet.

---

## Optional: Health Coach agent

Create a dedicated OpenClaw agent with a health-analyst persona that uses this plugin's tools and skill.

```bash
./scripts/setup-agent.sh
```

This creates the agent workspace at `~/.openclaw/agents/health-coach/` with an `IDENTITY.md` defining the persona.

Then add the agent to `~/.openclaw/openclaw.json`:

```json
{
  "agents": {
    "list": [
      { "id": "health-coach", "skills": ["health-sync"] }
    ]
  }
}
```

Talk to it:

```bash
# Single message
openclaw agent --agent health-coach -m "How was my health this week?"

# Interactive terminal UI
openclaw tui
```

The agent has access to all four health tools (`health_summary`, `health_query`, `health_anomalies`, `health_raw`) and knows how to analyze your data.

---

## Manual configuration (optional)

The plugin runs with zero config. If you want to override defaults, add this to `~/.openclaw/config.yaml`:

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

---

## Troubleshooting

**No API key shows in the logs**
The key is printed once on first load. Restart the gateway: `openclaw gateway restart && openclaw gateway logs 2>&1 | grep "health-sync"`. Or set `apiKey` explicitly in `config.yaml` (see above).

**iOS app says "Test Connection failed"**
1. From the server, confirm the gateway is reachable: `curl -s http://127.0.0.1:18789/api/v1/health -H "Authorization: Bearer $API_KEY"` should return 200.
2. If the server is remote: `tailscale serve status` must show port 18789 exposed, and the iPhone must be signed into the **same** tailnet.
3. Double-check the URL in the app uses `http://` (not `https://`) and includes the port.

**Ingest succeeds but no data in queries**
Confirm rows landed in SQLite:
```bash
sqlite3 ~/.openclaw/state/health-sync/health.sqlite \
  "SELECT data_type, COUNT(*) FROM health_samples WHERE deleted_at IS NULL GROUP BY data_type;"
```
If empty, check the ingest logs for schema/validation errors.

**Plugin fails to load with "Cannot find module 'node:sqlite'"**
You need Node 24+. Check your version: `node --version`. Update via `nvm install 24` or [nodejs.org](https://nodejs.org).

---

## Development

### Prerequisites

- Node.js 24+
- OpenClaw installed (`npm install -g openclaw@latest`)
- OpenClaw gateway running (`openclaw gateway start`)

### First-time setup

```bash
npm install
./scripts/dev-setup.sh
```

This builds the plugin, symlinks it into OpenClaw (no copying), and restarts the gateway.

### Dev workflow

Run TypeScript in watch mode — the gateway auto-reloads when `dist/` changes:

```bash
npm run dev
```

Save a `.ts` file → `tsc` recompiles → gateway hot-reloads. No manual steps.

If hot reload misses a change:

```bash
./scripts/dev-reload.sh
```

### Testing with curl

```bash
API_KEY="<key-from-logs>"

# Health check
curl -s http://127.0.0.1:18789/api/v1/health \
  -H "Authorization: Bearer $API_KEY"

# Send a test sample
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
```

### Checking logs

```bash
openclaw gateway logs 2>&1 | grep "health-sync"
```

Ingest logs show sample counts and type breakdowns:

```
[health-sync] 📥 Ingest request from device A1B2C3: 142 samples, 0 deletes
[health-sync] ✅ Stored 142 samples, soft-deleted 0 | Dates: 2026-04-02, 2026-04-03 | HeartRate: 87, StepCount: 34
```

### Releasing to npm

See [RELEASING.md](./RELEASING.md) for the full publish flow (pre-publish checks, `next` vs `latest` tags, rollback).

---

## Project Structure

```
src/
├── index.ts                    # Plugin entry point
├── db/
│   ├── connection.ts           # SQLite connection (node:sqlite) + WAL mode
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
                                 SQLite DB (node:sqlite, WAL mode)
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
- No native dependencies — pure JS/TS plugin, safe with OpenClaw's `--ignore-scripts`
- SQLite WAL mode for concurrent reads during writes
- Soft-delete semantics — no data permanently lost
