# oc-health-sync — OpenClaw Plugin Spec

> Companion spec to the iOS app spec. This plugin receives health data from the app,
> stores it in a local SQLite database, and exposes agent tools for querying and summarizing.
> All data stays on the user's machine. Zero external dependencies.

---

## Overview

The plugin does four things:

1. **Receives** health data from the iOS app via an HTTP ingest endpoint
2. **Stores** raw samples in a local SQLite database with UPSERT/soft-delete semantics
3. **Generates** daily markdown summaries from the raw data (on-demand, cached)
4. **Exposes** agent tools so the OpenClaw agent can answer health questions without loading raw samples into context

```
iOS App                          OpenClaw Plugin
────────                         ───────────────
POST /health/ingest  ──────────► HTTP Route Handler
                                      │
                                      ▼
                                 SQLite DB (raw samples)
                                      │
                                      ▼
Agent asks                       Summary Generator
"How was my sleep?"                   │
      │                               ▼
      ▼                          Markdown Summary
health.summary tool  ◄────────  (cached in DB)
      │
      ▼
Agent responds with
compact, accurate answer
```

---

## Plugin Package Structure

```
oc-health-sync-plugin/
├── package.json
├── openclaw.plugin.json              # Plugin manifest
├── tsconfig.json
├── src/
│   ├── index.ts                      # Plugin entry: register(api) — routes, tools, services
│   ├── db/
│   │   ├── schema.ts                 # SQLite schema + migration logic
│   │   ├── connection.ts             # Database connection helper (better-sqlite3)
│   │   └── queries.ts                # Typed query helpers (insert, upsert, soft-delete, select)
│   ├── routes/
│   │   ├── ingest.ts                 # POST /health/ingest handler
│   │   └── healthcheck.ts           # GET /health handler (for app connection test)
│   ├── tools/
│   │   ├── summary.ts                # health.summary tool implementation
│   │   ├── query.ts                  # health.query tool implementation
│   │   ├── anomalies.ts              # health.anomalies tool implementation
│   │   └── raw.ts                    # health.raw tool implementation
│   ├── summary/
│   │   ├── generator.ts              # Summary generation logic (SQL → markdown)
│   │   └── templates.ts              # Markdown templates for daily/weekly summaries
│   └── utils/
│       ├── auth.ts                   # API key validation
│       └── constants.ts              # Sleep value enums, workout type names, etc.
└── skills/
    └── health/
        └── SKILL.md                  # Agent skill file — teaches the agent when/how to use tools
```

---

## Plugin Manifest

`openclaw.plugin.json`:

```json
{
  "id": "health-sync",
  "name": "Health Sync",
  "description": "Receives Apple HealthKit data from the oc-health-sync iOS app, stores it locally in SQLite, and provides agent tools for health data analysis.",
  "version": "0.1.0",
  "configSchema": {
    "type": "object",
    "properties": {
      "apiKey": {
        "type": "string",
        "description": "API key for authenticating ingest requests from the iOS app. Generate any random string."
      },
      "storagePath": {
        "type": "string",
        "description": "Path to the SQLite database file.",
        "default": "~/.openclaw/state/health-sync/health.sqlite"
      },
      "summaryCacheTtlMinutes": {
        "type": "number",
        "description": "How long to cache daily summaries before regenerating. 0 = always regenerate.",
        "default": 60
      }
    },
    "required": ["apiKey"]
  },
  "uiHints": {
    "apiKey": {
      "label": "API Key (share this with the iOS app)",
      "sensitive": true
    }
  }
}
```

`package.json`:

```json
{
  "name": "@oc-health-sync/openclaw-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "openclaw": {
    "extensions": ["./dist/index.js"]
  },
  "files": ["dist", "openclaw.plugin.json", "skills", "README.md"],
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch"
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0"
  },
  "peerDependencies": {
    "openclaw": ">=2026.2.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^20.0.0",
    "openclaw": "latest",
    "typescript": "^5.3.0"
  }
}
```

---

## Plugin Entry Point

`src/index.ts`:

```typescript
import { definePluginEntry } from 'openclaw/plugin-sdk/core';
import { initDatabase } from './db/schema';
import { registerIngestRoute, registerHealthcheckRoute } from './routes';
import { registerHealthTools } from './tools';

export default definePluginEntry({
  id: 'health-sync',
  name: 'Health Sync',

  register(api) {
    const config = api.config;
    const dbPath = config.storagePath || '~/.openclaw/state/health-sync/health.sqlite';
    const db = initDatabase(dbPath);

    // HTTP routes (called by the iOS app)
    registerHealthcheckRoute(api);
    registerIngestRoute(api, db, config.apiKey);

    // Agent tools (called by the OpenClaw agent during conversations)
    registerHealthTools(api, db, config);

    // Background service (cleanup, optional maintenance)
    api.registerService({
      id: 'health-sync-db',
      start: () => api.logger.info('[health-sync] SQLite database ready at ' + dbPath),
      stop: () => db.close(),
    });
  },
});
```

---

## SQLite Database Schema

One universal table for all sample types. Workout-specific and metadata fields stored as JSON.

### Table: `health_samples`

```sql
CREATE TABLE IF NOT EXISTS health_samples (
  -- Identity
  uuid            TEXT PRIMARY KEY,                          -- HealthKit sample UUID (globally unique)
  device_id       TEXT NOT NULL,                             -- iOS device identifier (from app)

  -- Classification
  sample_kind     TEXT NOT NULL CHECK(sample_kind IN ('quantity', 'category', 'workout')),
  data_type       TEXT NOT NULL,                             -- e.g. "HKQuantityTypeIdentifierHeartRate"

  -- Timing
  start_date      TEXT NOT NULL,                             -- ISO 8601 UTC
  end_date        TEXT NOT NULL,                             -- ISO 8601 UTC

  -- Values (interpretation depends on sample_kind)
  --   quantity samples: numeric value (72 bpm, 8432 steps)
  --   category samples: enum int (0=inBed, 3=asleepCore, 4=asleepDeep, 5=asleepREM)
  --   workout samples: workout activity type enum (37=running, 52=walking)
  value           REAL,
  unit            TEXT,                                      -- "count/min", "count", "kcal", "%", etc.

  -- Source
  source_name     TEXT,                                      -- "Apple Watch", "iPhone"
  source_bundle   TEXT,                                      -- "com.apple.health.EA4F..."
  device_name     TEXT,                                      -- "Apple Watch"
  device_model    TEXT,                                      -- "Watch6,2"

  -- Workout-specific (NULL for non-workout samples)
  workout_duration_seconds    REAL,
  workout_total_energy_kcal   REAL,
  workout_total_distance_m    REAL,
  workout_activity_name       TEXT,                          -- human-readable: "Running", "Cycling"

  -- Flexible overflow (anything not in a dedicated column)
  metadata_json   TEXT DEFAULT '{}',                         -- JSON: events, activities, extra HK metadata

  -- Lifecycle
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at      TEXT DEFAULT NULL,                         -- soft-delete timestamp (NULL = active)

  -- Indexes for common queries
  -- (created below)
);

-- Fast lookups for summary generation and agent queries
CREATE INDEX IF NOT EXISTS idx_samples_type_date
  ON health_samples(data_type, start_date) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_samples_kind_date
  ON health_samples(sample_kind, start_date) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_samples_deleted
  ON health_samples(deleted_at) WHERE deleted_at IS NOT NULL;
```

### Table: `daily_summaries` (cache)

```sql
CREATE TABLE IF NOT EXISTS daily_summaries (
  date            TEXT PRIMARY KEY,                          -- "2025-01-15"
  device_id       TEXT NOT NULL,
  markdown        TEXT NOT NULL,                             -- generated summary content
  generated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  data_hash       TEXT NOT NULL                              -- hash of input data; regenerate if changed
);
```

### Table: `sync_metadata`

```sql
CREATE TABLE IF NOT EXISTS sync_metadata (
  key             TEXT PRIMARY KEY,
  value           TEXT NOT NULL,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Stores: last_ingest_at, total_samples_received, etc.
```

### UPSERT Logic

```sql
INSERT INTO health_samples (
  uuid, device_id, sample_kind, data_type,
  start_date, end_date, value, unit,
  source_name, source_bundle, device_name, device_model,
  workout_duration_seconds, workout_total_energy_kcal,
  workout_total_distance_m, workout_activity_name,
  metadata_json, updated_at, deleted_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), NULL)
ON CONFLICT(uuid) DO UPDATE SET
  value = excluded.value,
  unit = excluded.unit,
  start_date = excluded.start_date,
  end_date = excluded.end_date,
  source_name = excluded.source_name,
  source_bundle = excluded.source_bundle,
  device_name = excluded.device_name,
  device_model = excluded.device_model,
  workout_duration_seconds = excluded.workout_duration_seconds,
  workout_total_energy_kcal = excluded.workout_total_energy_kcal,
  workout_total_distance_m = excluded.workout_total_distance_m,
  workout_activity_name = excluded.workout_activity_name,
  metadata_json = excluded.metadata_json,
  updated_at = datetime('now'),
  deleted_at = NULL;  -- un-delete if previously soft-deleted
```

### Soft-Delete Logic

```sql
UPDATE health_samples
SET deleted_at = datetime('now'), updated_at = datetime('now')
WHERE uuid IN (?, ?, ?);
```

---

## HTTP Routes

### `GET /health` — Connection Test

Used by the iOS app's "Test Connection" button.

```
GET /health
Authorization: Bearer <api_key>

Response 200:
{
  "status": "ok",
  "plugin": "health-sync",
  "version": "0.1.0",
  "samples_count": 14832,
  "last_ingest": "2025-01-15T14:32:01Z"
}

Response 401:
{
  "error": "unauthorized",
  "message": "Invalid API key"
}
```

Implementation uses `api.registerHttpRoute` with `auth: "plugin"` (plugin handles its own API key validation).

### `POST /health/ingest` — Receive Health Data

Receives batches of samples from the iOS app. This is the primary endpoint.

```
POST /health/ingest
Authorization: Bearer <api_key>
Content-Type: application/json

{
  "device_id": "A1B2C3D4-...",
  "data_type": "heart_rate",
  "new_samples": [
    {
      "uuid": "AB12CD34-...",
      "sample_kind": "quantity",
      "data_type": "HKQuantityTypeIdentifierHeartRate",
      "value": 72,
      "unit": "count/min",
      "start_date": "2025-01-15T10:30:00Z",
      "end_date": "2025-01-15T10:30:00Z",
      "source_name": "Apple Watch",
      "source_bundle": "com.apple.health.D4A2...",
      "device_name": "Apple Watch",
      "device_model": "Watch6,2",
      "metadata": {}
    }
  ],
  "deleted_ids": [
    "EF56GH78-...",
    "IJ90KL12-..."
  ]
}
```

```
Response 200:
{
  "received": 142,
  "deleted": 2,
  "timestamp": "2025-01-15T14:32:01Z"
}
```

**Handler logic:**

```
1. Validate API key
2. Parse and validate request body
3. Begin SQLite transaction
4. For each sample in new_samples:
   a. Map to health_samples row
   b. For workouts: extract duration/energy/distance into dedicated columns,
      store events/activities in metadata_json
   c. UPSERT by uuid
5. For each uuid in deleted_ids:
   a. Soft-delete (set deleted_at)
6. Commit transaction
7. Invalidate daily_summaries cache for affected dates
8. Return counts
```

All operations happen in a single SQLite transaction — either the whole batch succeeds or nothing is written. This is safe because the iOS app only advances its anchor after receiving a 200 OK.

### Workout Data Mapping

When `sample_kind === 'workout'`, the app sends additional fields. The plugin maps them:

| App field | DB column | Notes |
|---|---|---|
| `value` | `value` | WorkoutActivityType enum (37 = running) |
| `workout_duration` | `workout_duration_seconds` | In seconds |
| `workout_energy` | `workout_total_energy_kcal` | In kcal |
| `workout_distance` | `workout_total_distance_m` | In meters |
| `workout_activity_name` | `workout_activity_name` | Human-readable name from enum |
| `events`, `activities` | `metadata_json` | Stored as JSON |

### Sleep Data Mapping

When `data_type === 'HKCategoryTypeIdentifierSleepAnalysis'`, the `value` field is a sleep stage enum:

| Value | Meaning | DB `value` |
|---|---|---|
| 0 | In Bed | 0 |
| 1 | Asleep (unspecified) | 1 |
| 2 | Awake | 2 |
| 3 | Asleep Core (light) | 3 |
| 4 | Asleep Deep | 4 |
| 5 | Asleep REM | 5 |

Each sleep stage is stored as a separate row with its own time range. The summary generator aggregates these into total sleep duration, per-stage durations, and sleep/wake time.

---

## Agent Tools

Registered via `api.registerTool()`. These are functions the OpenClaw agent calls during conversations.

### `health.summary` — Daily/Weekly/Monthly Summary

The primary tool. Returns a markdown summary for a date range.

**Input:**
```typescript
{
  from: string,      // ISO date: "2025-01-08"
  to: string,        // ISO date: "2025-01-15"
  type?: 'daily' | 'weekly' | 'monthly'  // default: inferred from range
}
```

**Output:** Markdown string. Example for a daily summary:

```markdown
# Health Summary — 2025-01-15 (Wednesday)

## Activity
- Steps: 8,432
- Active energy: 485 kcal
- Distance: 6.2 km

## Workouts
- Running: 42 min, 5.8 km, 412 kcal (avg HR 156 bpm)

## Vitals
- Resting heart rate: 58 bpm (7-day avg: 60)
- HRV (SDNN): 42 ms (7-day avg: 45) ⚠️ below 7-day trend
- SpO2: 97%
- Respiratory rate: 14 breaths/min

## Body
- Weight: 78.2 kg (last recorded)

## Sleep (previous night)
- Total: 7h 12m (11:24 PM – 6:36 AM)
- Deep: 1h 48m | REM: 1h 32m | Core: 3h 52m | Awake: 0h 18m

## Notable
- HRV declined 3 consecutive days (45 → 43 → 42 ms)
- Resting HR trending up +2 bpm over 7 days
```

For weekly/monthly ranges, the tool returns aggregated stats with daily breakdowns.

**Caching:** Summaries for past dates (not today) are cached in `daily_summaries` table. If the cache is stale (data_hash changed because new samples arrived for that date), it regenerates.

**Implementation: SQL queries that power the summary:**

```sql
-- Steps for a day
SELECT SUM(value) as total_steps
FROM health_samples
WHERE data_type = 'HKQuantityTypeIdentifierStepCount'
  AND date(start_date) = ?
  AND deleted_at IS NULL;

-- Heart rate stats for a day
SELECT
  ROUND(AVG(value), 1) as avg_hr,
  MIN(value) as min_hr,
  MAX(value) as max_hr,
  COUNT(*) as sample_count
FROM health_samples
WHERE data_type = 'HKQuantityTypeIdentifierHeartRate'
  AND date(start_date) = ?
  AND deleted_at IS NULL;

-- Resting heart rate (usually one per day)
SELECT value as resting_hr
FROM health_samples
WHERE data_type = 'HKQuantityTypeIdentifierRestingHeartRate'
  AND date(start_date) = ?
  AND deleted_at IS NULL
ORDER BY start_date DESC LIMIT 1;

-- 7-day average for trend comparison
SELECT ROUND(AVG(value), 1) as avg_7d
FROM health_samples
WHERE data_type = 'HKQuantityTypeIdentifierRestingHeartRate'
  AND date(start_date) BETWEEN date(?, '-7 days') AND date(?)
  AND deleted_at IS NULL;

-- Sleep analysis: aggregate stage durations
SELECT
  value as stage,
  SUM((julianday(end_date) - julianday(start_date)) * 24 * 60) as minutes
FROM health_samples
WHERE data_type = 'HKCategoryTypeIdentifierSleepAnalysis'
  AND date(start_date) = ?
  AND deleted_at IS NULL
GROUP BY value;

-- Sleep window (earliest in-bed to latest awake)
SELECT
  MIN(start_date) as sleep_start,
  MAX(end_date) as sleep_end
FROM health_samples
WHERE data_type = 'HKCategoryTypeIdentifierSleepAnalysis'
  AND date(start_date) = ?
  AND value != 2  -- exclude "awake" for determining sleep window
  AND deleted_at IS NULL;

-- Workouts for a day
SELECT
  workout_activity_name,
  workout_duration_seconds,
  workout_total_energy_kcal,
  workout_total_distance_m,
  start_date,
  end_date
FROM health_samples
WHERE sample_kind = 'workout'
  AND date(start_date) = ?
  AND deleted_at IS NULL
ORDER BY start_date;

-- Weight (most recent up to this date)
SELECT value, unit, start_date
FROM health_samples
WHERE data_type = 'HKQuantityTypeIdentifierBodyMass'
  AND date(start_date) <= ?
  AND deleted_at IS NULL
ORDER BY start_date DESC LIMIT 1;
```

### `health.query` — Specific Metric Query

For precise questions. Returns a single value or small dataset.

**Input:**
```typescript
{
  metric: string,    // "resting_hr" | "steps" | "weight" | "hrv" | "sleep_duration" | ...
  from: string,      // ISO date
  to: string,        // ISO date
  aggregation?: 'avg' | 'sum' | 'min' | 'max' | 'latest' | 'daily_breakdown'
}
```

**Output:** JSON with the result:
```json
{
  "metric": "resting_hr",
  "from": "2025-01-08",
  "to": "2025-01-15",
  "aggregation": "avg",
  "value": 59.3,
  "unit": "bpm",
  "data_points": 7
}
```

Or for `daily_breakdown`:
```json
{
  "metric": "steps",
  "from": "2025-01-08",
  "to": "2025-01-15",
  "aggregation": "daily_breakdown",
  "days": [
    { "date": "2025-01-08", "value": 9230 },
    { "date": "2025-01-09", "value": 6102 },
    { "date": "2025-01-10", "value": 11450 }
  ],
  "unit": "count"
}
```

**Metric → SQL mapping** (internal lookup table in the tool):

| Metric key | data_type identifier | Aggregation default |
|---|---|---|
| `steps` | `HKQuantityTypeIdentifierStepCount` | `sum` per day |
| `active_energy` | `HKQuantityTypeIdentifierActiveEnergyBurned` | `sum` per day |
| `distance` | `HKQuantityTypeIdentifierDistanceWalkingRunning` | `sum` per day |
| `heart_rate` | `HKQuantityTypeIdentifierHeartRate` | `avg` |
| `resting_hr` | `HKQuantityTypeIdentifierRestingHeartRate` | `latest` per day |
| `hrv` | `HKQuantityTypeIdentifierHeartRateVariabilitySDNN` | `avg` |
| `spo2` | `HKQuantityTypeIdentifierOxygenSaturation` | `avg` |
| `respiratory_rate` | `HKQuantityTypeIdentifierRespiratoryRate` | `avg` |
| `weight` | `HKQuantityTypeIdentifierBodyMass` | `latest` |
| `body_fat` | `HKQuantityTypeIdentifierBodyFatPercentage` | `latest` |
| `sleep_duration` | `HKCategoryTypeIdentifierSleepAnalysis` | custom (sum non-awake stages) |

### `health.anomalies` — Trend Detection

Detects notable patterns in recent data. The agent calls this for proactive insights.

**Input:**
```typescript
{
  days?: number,     // lookback window, default: 14
  sensitivity?: 'low' | 'medium' | 'high'  // default: medium
}
```

**Output:** Markdown string listing detected anomalies:
```markdown
## Anomalies Detected (last 14 days)

⚠️ **HRV declining trend**: 3 consecutive days of decline (48 → 45 → 42 ms). 7-day avg is 44 ms vs 14-day avg of 49 ms.

⚠️ **Resting HR elevated**: Today 62 bpm vs 7-day avg 58 bpm (+6.9%).

ℹ️ **Sleep duration below average**: 3 of last 7 nights below 7 hours. Average 6h 28m vs 14-day avg 7h 15m.

✅ **Steps on track**: 7-day avg 8,942 steps, consistent with 14-day trend.
```

**Detection rules** (hardcoded for POC, can be made configurable later):

| Anomaly | Logic |
|---|---|
| HR/HRV trend | 3+ consecutive days of monotonic increase/decrease |
| Metric deviation | Current 7-day avg differs from 14-day avg by >10% |
| Sleep deficit | 3+ of last 7 nights below configurable threshold (default: 7h) |
| Missing data | No samples for an expected type in last 48h |
| Workout spike | Total workout duration this week >150% of 4-week avg |

### `health.raw` — Raw Sample Access (Escape Hatch)

For when the agent needs actual sample data. Use sparingly — this can return large datasets.

**Input:**
```typescript
{
  data_type: string,   // HK identifier or short name
  from: string,        // ISO datetime
  to: string,          // ISO datetime
  limit?: number       // default: 100, max: 500
}
```

**Output:** JSON array of raw samples (same shape as stored in DB).

The agent should prefer `health.summary` and `health.query` over this tool. The SKILL.md instructs accordingly.

---

## SKILL.md

Located at `skills/health/SKILL.md`. This file teaches the OpenClaw agent when and how to use the health tools.

```markdown
---
name: health-sync
description: Query and analyze Apple HealthKit data synced from the user's iPhone.
  Use when the user asks about their health, fitness, sleep, workouts, vitals,
  body metrics, or trends. Covers steps, heart rate, HRV, sleep stages, workouts,
  weight, SpO2, respiratory rate, and more.
tools:
  - health.summary
  - health.query
  - health.anomalies
  - health.raw
---

# Health Data Analysis

You have access to the user's Apple HealthKit data via four tools.
Data is synced from their iPhone/Apple Watch and stored locally.

## Tool Selection Guide

**Start with `health.summary`** for broad questions:
- "How was my health this week?"
- "Summarize yesterday"
- "Give me a weekly report"

**Use `health.query`** for specific metrics:
- "What was my average resting heart rate last week?"
- "How many steps did I take on Monday?"
- "Show me my weight trend for January"

**Use `health.anomalies`** for trend detection:
- "Anything unusual in my health data?"
- "Am I overtraining?"
- "How's my recovery looking?"

**Use `health.raw` only as a last resort** when other tools don't have the detail needed.
It returns raw samples and can be large. Prefer summary and query first.

## Available Metrics

Activity: steps, active_energy, distance
Vitals: heart_rate, resting_hr, hrv, spo2, respiratory_rate
Body: weight, body_fat
Sleep: sleep_duration (plus full stage breakdown via summary)
Workouts: accessible via summary (type, duration, energy, distance)

## Date Handling

- Use ISO dates: "2025-01-15"
- For "today", "yesterday", "this week" — calculate the actual dates
- Sleep data: a night's sleep is dated to the day it started
  (sleep starting 2025-01-14 at 11pm belongs to 2025-01-14)

## Response Style

When presenting health data to the user:
- Lead with the most relevant finding, not a data dump
- Compare to recent trends when available (the summary tool includes 7-day averages)
- Flag anomalies proactively when they appear
- Use plain language, not medical jargon
- Never diagnose — say "your HRV has been declining" not "you may be ill"
- If data is missing or sparse, say so honestly
```

---

## Config & Installation

### User installation flow

```bash
# Install the plugin
openclaw plugins install @oc-health-sync/openclaw-plugin

# Restart gateway
openclaw gateway restart

# Configure (generates and shows API key)
openclaw configure --section plugins.entries.health-sync
```

Or in `~/.openclaw/config.yaml`:

```yaml
plugins:
  entries:
    health-sync:
      enabled: true
      config:
        apiKey: "your-random-api-key-here"
        storagePath: "~/.openclaw/state/health-sync/health.sqlite"
        summaryCacheTtlMinutes: 60
```

### First-run behavior

On first gateway start with the plugin enabled:

1. Create directory `~/.openclaw/state/health-sync/` if it doesn't exist
2. Create SQLite database and run schema migrations
3. Register HTTP routes and agent tools
4. Log: `[health-sync] Ready. Ingest endpoint: POST /health/ingest`

---

## Summary Generation — Implementation Detail

The summary generator is NOT a background cron. It runs **on-demand** when the agent calls `health.summary`, with caching.

### Flow:

```
1. Agent calls health.summary({ from: "2025-01-15", to: "2025-01-15" })
2. For each date in range:
   a. Compute data_hash = SHA256 of (count + max updated_at) for that date's samples
   b. Check daily_summaries cache:
      - If cached AND data_hash matches AND age < summaryCacheTtlMinutes → return cached
      - Otherwise → regenerate
   c. Run SQL queries for all metric categories
   d. Apply markdown template
   e. Store in daily_summaries cache
3. If range is multi-day: compose individual summaries + add aggregated stats header
4. Return combined markdown
```

### Data hash (cache invalidation):

```sql
SELECT COUNT(*) || '-' || MAX(updated_at) as hash
FROM health_samples
WHERE date(start_date) = ?
  AND deleted_at IS NULL;
```

If new samples arrive for a past date (late sync, modified sample), the hash changes and the summary regenerates on next request.

---

## Workout Activity Type Mapping

The plugin includes a lookup table for translating workout enum values to human-readable names:

```typescript
const WORKOUT_NAMES: Record<number, string> = {
  1: 'American Football', 2: 'Archery', 6: 'Basketball', 8: 'Boxing',
  9: 'Climbing', 13: 'Cycling', 14: 'Dance', 16: 'Elliptical',
  20: 'Functional Strength', 21: 'Golf', 24: 'Hiking', 37: 'Running',
  46: 'Swimming', 48: 'Tennis', 50: 'Traditional Strength', 52: 'Walking',
  57: 'Yoga', 58: 'Barre', 59: 'Core Training', 63: 'HIIT',
  64: 'Jump Rope', 66: 'Pilates', 73: 'Mixed Cardio', 79: 'Pickleball',
  80: 'Cooldown', 82: 'Swim-Bike-Run', 84: 'Underwater Diving',
  3000: 'Other',
  // ... full enum from the library's WorkoutActivityType
};
```

---

## Security Considerations

- **API key validation** on every ingest request. Key is stored in OpenClaw config (not in the plugin code).
- **No outbound network requests.** The plugin only receives data and reads/writes to local SQLite.
- **SQLite WAL mode** enabled for concurrent read performance (agent tools can read while an ingest is writing).
- **No data leaves the machine.** This is the core differentiator vs. the competitor's Supabase approach.
- **Plugin runs in-process** with the OpenClaw Gateway. It has the same trust boundary as core code.

---

## What's Explicitly Out of Scope (POC)

- No data visualization / charts (the agent describes data in text)
- No data export (CSV, JSON export endpoints)
- No multi-device reconciliation (assumes single iPhone; device_id tracked but not deduplicated)
- No data retention / auto-cleanup policies
- No webhook notifications (e.g., "alert me if resting HR > 80")
- No migration from competitor's plugin or CSV imports
- No automated tests

---

## Definition of Done (Plugin POC)

The plugin is complete when:

1. ✅ `openclaw plugins install` installs cleanly, creates DB on first run
2. ✅ `GET /health` returns status and sample count (app can test connection)
3. ✅ `POST /health/ingest` accepts samples, performs UPSERT, handles deletes
4. ✅ Duplicate UUIDs are updated, not duplicated
5. ✅ Deleted UUIDs are soft-deleted (deleted_at set)
6. ✅ `health.summary` returns daily markdown with all metric categories
7. ✅ `health.query` returns specific metric values with aggregation options
8. ✅ `health.anomalies` detects basic trends (HR/HRV decline, sleep deficit)
9. ✅ `health.raw` returns raw samples with limit
10. ✅ Agent can answer "How was my sleep last night?" using only the tools
11. ✅ Agent can answer "What's my step trend this week?" using only the tools
12. ✅ Summary cache works (repeat queries don't regenerate)
13. ✅ All data stays in local SQLite — zero outbound network calls