---
name: health-sync
description: Query and analyze Apple HealthKit data synced from the user's iPhone.
  Use when the user asks about their health, fitness, sleep, workouts, vitals,
  body metrics, or trends. Covers steps, heart rate, HRV, sleep stages, workouts,
  weight, SpO2, respiratory rate, and more.
tools:
  - health_summary
  - health_query
  - health_anomalies
  - health_raw
  - health_compare
---

# MANDATORY RULES

**You MUST follow these rules for EVERY health-related question. No exceptions.**

1. **ALWAYS fetch data from the API before answering.** Use `exec` with `curl` to call the health endpoints below. Do NOT skip this step.
2. **NEVER generate, estimate, invent, or recall health data from memory.** Every number you present must come from an API response you received in this conversation turn.
3. **If an API call returns no data or an error, tell the user honestly.** Say "No data found for [period]" — do not fill in gaps with guesses.
4. **Do NOT use data from previous conversation turns.** Always make a fresh API call. Health data may have been updated.
5. **Show the source.** When presenting numbers, they must match what the API returned.

If you cannot call `exec` for any reason, tell the user: "I can't access the health data API right now. Please try again or check that the gateway is running."

---

# Resolve the Gateway Base URL

Before making your first health API call, determine the gateway base URL. Run this once per conversation:

```
exec: PORT=${OPENCLAW_GATEWAY_PORT:-18789}; echo "http://127.0.0.1:$PORT"
```

Use the returned URL as the base for all endpoints below. The default is `http://127.0.0.1:18789`, but the port may differ if the user configured `OPENCLAW_GATEWAY_PORT` or `gateway.port` in their OpenClaw config.

Throughout this document, `$BASE` refers to this resolved URL (e.g., `http://127.0.0.1:18789`). When constructing `exec` calls, substitute `$BASE` with the actual resolved URL.

---

# How to fetch health data

Use your `exec` tool with `curl -s` to call these endpoints.

**Important:** Do NOT use `web_fetch` — it blocks localhost connections. Always use `exec` with `curl -s`.

## 1. Health Summary

**URL:** `$BASE/api/v1/health/summary?from=YYYY-MM-DD&to=YYYY-MM-DD&mode=MODE`

Returns a markdown summary with activity, workouts, vitals, sleep, and anomalies.

**Mode** (optional): `auto` (default), `rollup`, or `daily`
- `auto` — rollup aggregate view for ranges >3 days, per-day breakdown otherwise
- `rollup` — always aggregate: totals, averages, workout counts, weight change over the period
- `daily` — always per-day breakdown (concatenated daily summaries)

**Examples:**
```
exec: curl -s "$BASE/api/v1/health/summary?from=2026-04-01&to=2026-04-03"
exec: curl -s "$BASE/api/v1/health/summary?from=2026-03-01&to=2026-03-31&mode=rollup"
exec: curl -s "$BASE/api/v1/health/summary?from=2026-04-01&to=2026-04-07&mode=daily"
```

**Response:** `{ "markdown": "# Health Summary — 2026-04-01 ..." }`

**When to use:** Broad questions — "How was my day?", "Summarize this week", "Weekly health report". Start here unless the user asks for a specific number. For weekly/monthly reports, `rollup` gives a cleaner aggregate view.

## 2. Health Query

**URL:** `$BASE/api/v1/health/query?metric=METRIC&from=YYYY-MM-DD&to=YYYY-MM-DD&aggregation=AGG`

Returns a specific metric with aggregation.

**Available metrics:** `steps`, `active_energy`, `distance`, `heart_rate`, `resting_hr`, `hrv`, `spo2`, `respiratory_rate`, `weight`, `body_fat`, `vo2_max`, `flights_climbed`, `basal_energy`, `walking_speed`, `sleep_duration`

**Available aggregations:** `avg`, `sum`, `min`, `max`, `latest`, `daily_breakdown`

The `aggregation` parameter is optional — each metric has a sensible default:
- **Sum** metrics: steps, active_energy, distance, flights_climbed, basal_energy
- **Avg** metrics: heart_rate, hrv, spo2, respiratory_rate, sleep_duration, walking_speed
- **Latest** metrics: resting_hr, weight, body_fat, vo2_max

**Examples:**
```
exec: curl -s "$BASE/api/v1/health/query?metric=steps&from=2026-04-01&to=2026-04-07&aggregation=sum"
exec: curl -s "$BASE/api/v1/health/query?metric=hrv&from=2026-04-01&to=2026-04-07&aggregation=daily_breakdown"
exec: curl -s "$BASE/api/v1/health/query?metric=weight&from=2026-03-01&to=2026-04-07&aggregation=daily_breakdown"
```

**Response (single value):**
```json
{ "metric": "steps", "from": "2026-04-01", "to": "2026-04-07", "aggregation": "sum", "value": 62341, "unit": "count", "data_points": 1542 }
```

**Response (daily_breakdown):**
```json
{ "metric": "steps", "aggregation": "daily_breakdown", "days": [{"date": "2026-04-01", "value": 8432}, ...], "unit": "count" }
```

**When to use:** Specific number questions — "How many steps this week?", "Average HRV?", "Weight trend this month" (use daily_breakdown).

## 3. Health Anomalies

**URL:** `$BASE/api/v1/health/anomalies?days=14&sensitivity=medium`

Scans recent data for notable patterns. Both parameters are optional.

**Sensitivity levels:** `low`, `medium` (default), `high`

**Example:**
```
exec: curl -s "$BASE/api/v1/health/anomalies?days=14&sensitivity=high"
```

**Response:** `{ "markdown": "## Anomalies Detected ...\n⚠️ **HRV declining trend**: ..." }`

**When to use:** "Anything unusual?", "Am I overtraining?", "How's my recovery?"

## 4. Health Raw

**URL:** `$BASE/api/v1/health/raw?data_type=TYPE&from=DATETIME&to=DATETIME&limit=100`

Returns individual sample records. Uses full ISO datetimes (not just dates).

**data_type:** Short name (`heart_rate`, `steps`, etc.) or full HK identifier (`HKQuantityTypeIdentifierHeartRate`)

**Example:**
```
exec: curl -s "$BASE/api/v1/health/raw?data_type=heart_rate&from=2026-04-03T10:00:00&to=2026-04-03T12:00:00&limit=50"
```

**Response:**
```json
{ "data_type": "HKQuantityTypeIdentifierHeartRate", "count": 42, "limit": 50, "samples": [{"value": 72, "unit": "bpm", "start_date": "...", ...}] }
```

**When to use:** Last resort for detail — "Show me HR samples during my run", "What were my exact sleep stages?" Use summary or query first.

## 5. Health Compare

**URL:** `$BASE/api/v1/health/compare?period_a_from=YYYY-MM-DD&period_a_to=YYYY-MM-DD&period_b_from=YYYY-MM-DD&period_b_to=YYYY-MM-DD&metrics=METRIC1,METRIC2`

Compares two time periods side by side. Returns each metric's value for both periods with absolute delta and percentage change.

**`metrics`** (optional): Comma-separated list. Defaults to all: steps, active_energy, distance, flights_climbed, basal_energy, resting_hr, hrv, spo2, respiratory_rate, walking_speed, sleep_duration

**Example:**
```
exec: curl -s "$BASE/api/v1/health/compare?period_a_from=2026-03-24&period_a_to=2026-03-30&period_b_from=2026-03-31&period_b_to=2026-04-06"
exec: curl -s "$BASE/api/v1/health/compare?period_a_from=2026-03-01&period_a_to=2026-03-31&period_b_from=2026-04-01&period_b_to=2026-04-06&metrics=steps,hrv,sleep_duration"
```

**Response:**
```json
{
  "period_a": { "from": "2026-03-24", "to": "2026-03-30" },
  "period_b": { "from": "2026-03-31", "to": "2026-04-06" },
  "comparison": [
    { "metric": "steps", "unit": "count", "period_a": 62341, "period_b": 58102, "delta": -4239, "delta_percent": -6.8 },
    { "metric": "hrv", "unit": "ms", "period_a": 42.5, "period_b": 45.2, "delta": 2.7, "delta_percent": 6.4 }
  ]
}
```

**When to use:** "Compare this week vs last week", "How did March compare to February?", "Am I improving?". Period A is the baseline, Period B is the current/comparison period.

---

# Analysis Scenarios

### "How was my sleep last night?"
1. Call summary for yesterday: `exec: curl -s "$BASE/api/v1/health/summary?from=YYYY-MM-DD&to=YYYY-MM-DD"` (use yesterday's date)
2. Present duration, stages, and sleep window from the response

### "Am I overtraining?"
1. Call anomalies with high sensitivity: `exec: curl -s "$BASE/api/v1/health/anomalies?days=14&sensitivity=high"`
2. Call HRV daily breakdown: `exec: curl -s "$BASE/api/v1/health/query?metric=hrv&from=...&to=...&aggregation=daily_breakdown"`
3. Analyze the trends from actual data

### "How many steps this week?"
1. Call query: `exec: curl -s "$BASE/api/v1/health/query?metric=steps&from=YYYY-MM-DD&to=YYYY-MM-DD&aggregation=sum"`
2. Present the `value` from the response

### "Compare this week vs last week"
1. Call compare: `exec: curl -s "$BASE/api/v1/health/compare?period_a_from=LAST_MONDAY&period_a_to=LAST_SUNDAY&period_b_from=THIS_MONDAY&period_b_to=TODAY"`
2. Present the comparison table with deltas from the response

### "Give me a weekly report"
1. Call summary with rollup: `exec: curl -s "$BASE/api/v1/health/summary?from=MONDAY&to=SUNDAY&mode=rollup"`
2. Call anomalies: `exec: curl -s "$BASE/api/v1/health/anomalies"`
3. Combine the actual data from both responses

---

# Date Handling

- Calculate actual dates for relative references:
  - "today" = current date (YYYY-MM-DD)
  - "yesterday" = current date minus 1
  - "this week" = Monday through today
  - "last 7 days" = today minus 6 through today
- Date ranges are inclusive on both ends
- `health/raw` uses full datetimes (YYYY-MM-DDTHH:MM:SS), all others use dates only (YYYY-MM-DD)

# Response Style

- Lead with the insight, not a data dump
- Compare to trends when available (the summary includes 7-day averages)
- Present numbers with units: "8,432 steps", "72 bpm", "6h 45m sleep"
- Never diagnose — say "your HRV has been declining" not "you may be getting sick"
- Acknowledge missing data honestly

# Important Notes

- Sleep is dated to the start day (sleep starting April 3rd 11pm = April 3rd)
- Weight searches backward — if no reading for a specific date, shows most recent prior reading
- Missing data does not equal zero — if data_points is 0, the user didn't record data, not that the value was 0
- daily_breakdown may have gaps — days with no data are omitted
