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
---

# MANDATORY RULES

**You MUST follow these rules for EVERY health-related question. No exceptions.**

1. **ALWAYS fetch data from the API before answering.** Use `web_fetch` to call the health endpoints below. Do NOT skip this step.
2. **NEVER generate, estimate, invent, or recall health data from memory.** Every number you present must come from an API response you received in this conversation turn.
3. **If an API call returns no data or an error, tell the user honestly.** Say "No data found for [period]" — do not fill in gaps with guesses.
4. **Do NOT use data from previous conversation turns.** Always make a fresh API call. Health data may have been updated.
5. **Show the source.** When presenting numbers, they must match what the API returned.

If you cannot call `web_fetch` for any reason, tell the user: "I can't access the health data API right now. Please try again or check that the gateway is running."

---

# How to fetch health data

Use your `web_fetch` tool to call these endpoints. The base URL is always `http://127.0.0.1:18789`.

## 1. Health Summary

**URL:** `http://127.0.0.1:18789/api/v1/health/summary?from=YYYY-MM-DD&to=YYYY-MM-DD`

Returns a markdown summary with activity, workouts, vitals, sleep, and anomalies for each day in the range.

**Example:**
```
web_fetch("http://127.0.0.1:18789/api/v1/health/summary?from=2026-04-01&to=2026-04-03")
```

**Response:** `{ "markdown": "# Health Summary — 2026-04-01 ..." }`

**When to use:** Broad questions — "How was my day?", "Summarize this week", "Weekly health report". Start here unless the user asks for a specific number.

## 2. Health Query

**URL:** `http://127.0.0.1:18789/api/v1/health/query?metric=METRIC&from=YYYY-MM-DD&to=YYYY-MM-DD&aggregation=AGG`

Returns a specific metric with aggregation.

**Available metrics:** `steps`, `active_energy`, `distance`, `heart_rate`, `resting_hr`, `hrv`, `spo2`, `respiratory_rate`, `weight`, `body_fat`, `sleep_duration`

**Available aggregations:** `avg`, `sum`, `min`, `max`, `latest`, `daily_breakdown`

The `aggregation` parameter is optional — each metric has a sensible default:
- **Sum** metrics: steps, active_energy, distance
- **Avg** metrics: heart_rate, hrv, spo2, respiratory_rate, sleep_duration
- **Latest** metrics: resting_hr, weight, body_fat

**Examples:**
```
web_fetch("http://127.0.0.1:18789/api/v1/health/query?metric=steps&from=2026-04-01&to=2026-04-07&aggregation=sum")
web_fetch("http://127.0.0.1:18789/api/v1/health/query?metric=hrv&from=2026-04-01&to=2026-04-07&aggregation=daily_breakdown")
web_fetch("http://127.0.0.1:18789/api/v1/health/query?metric=weight&from=2026-03-01&to=2026-04-07&aggregation=daily_breakdown")
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

**URL:** `http://127.0.0.1:18789/api/v1/health/anomalies?days=14&sensitivity=medium`

Scans recent data for notable patterns. Both parameters are optional.

**Sensitivity levels:** `low`, `medium` (default), `high`

**Example:**
```
web_fetch("http://127.0.0.1:18789/api/v1/health/anomalies?days=14&sensitivity=high")
```

**Response:** `{ "markdown": "## Anomalies Detected ...\n⚠️ **HRV declining trend**: ..." }`

**When to use:** "Anything unusual?", "Am I overtraining?", "How's my recovery?"

## 4. Health Raw

**URL:** `http://127.0.0.1:18789/api/v1/health/raw?data_type=TYPE&from=DATETIME&to=DATETIME&limit=100`

Returns individual sample records. Uses full ISO datetimes (not just dates).

**data_type:** Short name (`heart_rate`, `steps`, etc.) or full HK identifier (`HKQuantityTypeIdentifierHeartRate`)

**Example:**
```
web_fetch("http://127.0.0.1:18789/api/v1/health/raw?data_type=heart_rate&from=2026-04-03T10:00:00&to=2026-04-03T12:00:00&limit=50")
```

**Response:**
```json
{ "data_type": "HKQuantityTypeIdentifierHeartRate", "count": 42, "limit": 50, "samples": [{"value": 72, "unit": "bpm", "start_date": "...", ...}] }
```

**When to use:** Last resort for detail — "Show me HR samples during my run", "What were my exact sleep stages?" Use summary or query first.

---

# Analysis Scenarios

### "How was my sleep last night?"
1. Call summary for yesterday: `web_fetch("http://127.0.0.1:18789/api/v1/health/summary?from=YYYY-MM-DD&to=YYYY-MM-DD")` (use yesterday's date)
2. Present duration, stages, and sleep window from the response

### "Am I overtraining?"
1. Call anomalies with high sensitivity: `web_fetch("http://127.0.0.1:18789/api/v1/health/anomalies?days=14&sensitivity=high")`
2. Call HRV daily breakdown: `web_fetch("http://127.0.0.1:18789/api/v1/health/query?metric=hrv&from=...&to=...&aggregation=daily_breakdown")`
3. Analyze the trends from actual data

### "How many steps this week?"
1. Call query: `web_fetch("http://127.0.0.1:18789/api/v1/health/query?metric=steps&from=YYYY-MM-DD&to=YYYY-MM-DD&aggregation=sum")`
2. Present the `value` from the response

### "Compare this week vs last week"
1. Call query twice — once for each week's date range
2. Present side-by-side with actual numbers from both responses

### "Give me a weekly report"
1. Call summary for the week: `web_fetch("http://127.0.0.1:18789/api/v1/health/summary?from=MONDAY&to=SUNDAY")`
2. Call anomalies: `web_fetch("http://127.0.0.1:18789/api/v1/health/anomalies")`
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
