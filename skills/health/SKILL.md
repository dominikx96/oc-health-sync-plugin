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

# Health Data Analysis

You have access to the user's Apple HealthKit data via four tools. Data is synced from their iPhone/Apple Watch and stored locally in SQLite. All queries filter out soft-deleted records automatically.

## Available Data Types

| Metric | HK Identifier | Kind | Unit | Default Agg |
|--------|---------------|------|------|-------------|
| steps | HKQuantityTypeIdentifierStepCount | quantity | count | sum |
| active_energy | HKQuantityTypeIdentifierActiveEnergyBurned | quantity | kcal | sum |
| distance | HKQuantityTypeIdentifierDistanceWalkingRunning | quantity | m | sum |
| heart_rate | HKQuantityTypeIdentifierHeartRate | quantity | bpm | avg |
| resting_hr | HKQuantityTypeIdentifierRestingHeartRate | quantity | bpm | latest |
| hrv | HKQuantityTypeIdentifierHeartRateVariabilitySDNN | quantity | ms | avg |
| spo2 | HKQuantityTypeIdentifierOxygenSaturation | quantity | % | avg |
| respiratory_rate | HKQuantityTypeIdentifierRespiratoryRate | quantity | breaths/min | avg |
| weight | HKQuantityTypeIdentifierBodyMass | quantity | kg | latest |
| body_fat | HKQuantityTypeIdentifierBodyFatPercentage | quantity | % | latest |
| sleep_duration | HKCategoryTypeIdentifierSleepAnalysis | category | minutes | avg |
| workouts | HKWorkoutTypeIdentifier | workout | — | — |

### Sleep Stages

Sleep analysis samples store a numeric `value` representing the stage:

| Value | Stage | Counted in sleep duration? |
|-------|-------|---------------------------|
| 0 | In Bed | No |
| 1 | Asleep (unspecified) | Yes |
| 2 | Awake | No |
| 3 | Core sleep | Yes |
| 4 | Deep sleep | Yes |
| 5 | REM sleep | Yes |

Sleep duration = sum of time in stages 1, 3, 4, 5. Stages 0 (In Bed) and 2 (Awake) are excluded.

A night's sleep is dated to the day it **started** — sleep beginning at 2026-04-03 23:00 belongs to 2026-04-03.

### Workout Fields

Workout samples have extra columns beyond standard samples:
- `workout_activity_name` — human-readable name (Running, Cycling, HIIT, Yoga, etc.)
- `workout_duration_seconds` — total duration
- `workout_total_energy_kcal` — calories burned
- `workout_total_distance_m` — distance in meters (null for non-distance workouts)

### DB Schema (health_samples table)

Every sample has: `uuid`, `device_id`, `sample_kind` (quantity/category/workout), `data_type` (HK identifier), `start_date`, `end_date`, `value`, `unit`, `source_name`, `source_bundle`, `device_name`, `device_model`, `metadata_json`, `created_at`, `updated_at`, `deleted_at`.

Indexed on `(data_type, start_date)` and `(sample_kind, start_date)` for fast queries.

---

## Tool Reference

### 1. health_summary

Generates markdown daily summaries with activity, workouts, vitals, sleep, and body metrics. Includes 7-day rolling averages for context and flags basic anomalies inline.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `from` | string | Yes | Start date (YYYY-MM-DD) |
| `to` | string | Yes | End date (YYYY-MM-DD) |
| `type` | string | No | 'daily', 'weekly', or 'monthly' (informational label only) |

**Returns:** Markdown text with sections for each day:
- **Activity** — steps, active energy (kcal), distance (km)
- **Workouts** — each workout with name, duration, energy, distance
- **Vitals** — resting HR (+ 7-day avg), HRV (+ 7-day avg), SpO2, respiratory rate
- **Body** — latest weight (searches backward if no reading that day)
- **Sleep** — total duration, sleep window (bed→wake), stage breakdown (Core/Deep/REM/Awake)
- **Notable** — inline anomaly flags (HRV decline, elevated resting HR)

**When to use:** Broad questions — "How was my day?", "Summarize this week", "Weekly health report". Always start here unless the user asks for a specific number.

**When NOT to use:** Specific metric queries ("what was my average HR?") — use `health_query` instead.

**Caching:** Summaries for past dates are cached. Cache invalidates when new data arrives for that date. Today's date is never cached.

---

### 2. health_query

Queries a specific metric with flexible aggregation. Returns structured JSON.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `metric` | string | Yes | Metric short name (see Available Data Types table) |
| `from` | string | Yes | Start date (YYYY-MM-DD) |
| `to` | string | Yes | End date (YYYY-MM-DD) |
| `aggregation` | string | No | 'avg', 'sum', 'min', 'max', 'latest', or 'daily_breakdown'. Defaults to metric's default aggregation. |

**Returns (single value):**
```json
{
  "metric": "heart_rate",
  "from": "2026-04-01",
  "to": "2026-04-03",
  "aggregation": "avg",
  "value": 72.3,
  "unit": "bpm",
  "data_points": 1542
}
```

**Returns (daily_breakdown):**
```json
{
  "metric": "steps",
  "from": "2026-04-01",
  "to": "2026-04-07",
  "aggregation": "daily_breakdown",
  "days": [
    { "date": "2026-04-01", "value": 8432 },
    { "date": "2026-04-02", "value": 12001 },
    { "date": "2026-04-03", "value": null }
  ],
  "unit": "count"
}
```

**Aggregation per metric:**
- **Sum** metrics (steps, active_energy, distance): daily values are summed, then aggregated across the range
- **Avg** metrics (heart_rate, hrv, spo2, respiratory_rate): samples averaged per day, then across range
- **Latest** metrics (resting_hr, weight, body_fat): most recent value in range
- **daily_breakdown**: returns per-day aggregated values (uses sum/avg/latest per the metric's `perDay` setting)

**When to use:** Specific number questions — "How many steps this week?", "Average HRV last 7 days?", "Weight trend this month" (use daily_breakdown).

**When NOT to use:** Broad overviews — use `health_summary`. Raw sample inspection — use `health_raw`.

---

### 3. health_anomalies

Scans recent data for notable patterns and trends. Returns markdown.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `days` | number | No | Lookback window in days (default: 14) |
| `sensitivity` | string | No | 'low', 'medium' (default), or 'high' |

**Sensitivity thresholds:**
| Level | Consecutive days | Deviation % | Sleep threshold |
|-------|-----------------|-------------|-----------------|
| high | 2 | 5% | 7.5h (450 min) |
| medium | 3 | 10% | 7h (420 min) |
| low | 4 | 15% | 6h (360 min) |

**Anomalies detected:**
1. **Resting HR trend** — consecutive days of rise or decline
2. **HRV trend** — consecutive days of rise or decline
3. **Resting HR deviation** — 7-day avg vs N-day avg divergence beyond threshold
4. **HRV deviation** — same comparison
5. **Sleep deficit** — counts nights below threshold in last 7 days (flags if >= 3)
6. **Missing data** — heart rate, steps, or sleep not recorded in 2+ days
7. **Workout spike** — this week's total duration > 1.5x the 4-week average

**Returns:** Markdown with emoji severity:
- `⚠️` — warning (action may be needed)
- `ℹ️` — info (awareness)
- `✅` — all clear (no anomalies found)

**When to use:** "Anything unusual?", "Am I overtraining?", "How's my recovery?", proactive health checks.

---

### 4. health_raw

Returns raw sample records as JSON. Use as an escape hatch when other tools lack detail.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `data_type` | string | Yes | HK identifier or metric short name (e.g., "heart_rate" or "HKQuantityTypeIdentifierHeartRate") |
| `from` | string | Yes | Start datetime (YYYY-MM-DDTHH:MM:SS) |
| `to` | string | Yes | End datetime (YYYY-MM-DDTHH:MM:SS) |
| `limit` | number | No | Max samples (default 100, max 500) |

**Returns:**
```json
{
  "data_type": "HKQuantityTypeIdentifierHeartRate",
  "from": "2026-04-03T10:00:00",
  "to": "2026-04-03T12:00:00",
  "count": 42,
  "limit": 100,
  "samples": [
    {
      "uuid": "...",
      "value": 72,
      "unit": "bpm",
      "start_date": "2026-04-03T10:02:15Z",
      "end_date": "2026-04-03T10:02:15Z",
      "source_name": "Apple Watch",
      "device_model": "Watch6,2",
      "workout_activity_name": null,
      "metadata_json": "{}"
    }
  ]
}
```

**Note:** Uses full ISO datetimes (not just dates) for `from`/`to` — more precise than other tools.

**When to use:** "Show me my heart rate samples during my run", "What were my exact sleep stages last night?", debugging data issues, or when you need individual sample timestamps.

**When NOT to use:** As a first choice. Always try `health_summary` or `health_query` first. Raw data requires you to do the analysis yourself.

---

## Analysis Scenarios

### "How was my sleep last night?"
1. Call `health_summary` with yesterday's date for the full picture (duration, stages, window)
2. If the user wants more detail, call `health_query` with `metric: "sleep_duration"` for the number
3. For individual stage records, use `health_raw` with `data_type: "HKCategoryTypeIdentifierSleepAnalysis"`

### "Am I overtraining?"
1. Start with `health_anomalies` (sensitivity: "high", days: 14) — checks workout spikes, HRV decline, resting HR elevation
2. Follow up with `health_query` for `hrv` daily_breakdown over 14 days to show the trend visually
3. Check `resting_hr` daily_breakdown — rising resting HR + falling HRV together suggest overtraining

### "What's my resting heart rate trend?"
1. Call `health_query` with `metric: "resting_hr"`, `aggregation: "daily_breakdown"`, over the desired range
2. Present the daily values and note the direction (rising, falling, stable)
3. Compare recent 7-day avg vs 30-day avg for context

### "Compare this week vs last week"
1. Call `health_query` twice for each metric of interest — once for this week's range, once for last week's
2. Present side-by-side: steps, active energy, sleep duration, avg heart rate, workout count
3. Highlight significant changes (>10% difference)

### "Why was my HRV low yesterday?"
1. Call `health_summary` for yesterday — look for high workout load, poor sleep, elevated resting HR
2. Call `health_query` for `hrv` daily_breakdown over the last 7 days to see if it's a single-day dip or a trend
3. If needed, `health_raw` for workout samples that day to check intensity

### "Show me my weight trend"
1. Call `health_query` with `metric: "weight"`, `aggregation: "daily_breakdown"` over the desired range
2. Also call with `aggregation: "min"` and `aggregation: "max"` for the range to give context
3. Note: weight uses "latest" per-day aggregation, so daily_breakdown shows the last reading each day

### "Give me a weekly report"
1. Call `health_summary` with `from` = Monday, `to` = Sunday (or today), `type: "weekly"`
2. Follow up with `health_anomalies` for the same period
3. Optionally query specific metrics the user cares about for precise numbers

### "How active was I today?"
1. Call `health_query` for `steps` (sum), `active_energy` (sum), `distance` (sum) — all for today
2. If workout data exists, call `health_summary` for today to see workout details
3. Compare to the user's recent average if they ask "is that good?"

---

## Date Handling

- All tools use ISO dates. Calculate actual dates for relative references:
  - "today" → current date (YYYY-MM-DD)
  - "yesterday" → current date minus 1 day
  - "this week" → Monday through today (or Sunday, depending on user's locale)
  - "last week" → previous Monday through Sunday
  - "last 7 days" → today minus 6 days through today
  - "this month" → 1st of current month through today
- Date ranges are **inclusive** on both ends
- `health_raw` uses full datetimes (YYYY-MM-DDTHH:MM:SS), other tools use dates only (YYYY-MM-DD)

## Response Style

When presenting health data:
- **Lead with the insight**, not a data dump. "Your sleep has been declining this week" not "Here are 7 daily values..."
- **Compare to trends** when available — the summary includes 7-day averages, use them
- **Flag anomalies proactively** even if the user didn't ask — "your HRV dropped 15% from your weekly average"
- **Use plain language** — "your deep sleep was shorter than usual" not "stage 4 duration decreased"
- **Never diagnose** — say "your HRV has been declining" not "you may be getting sick"
- **Acknowledge missing data** — if a metric has no samples, say so honestly rather than omitting it
- **Present numbers with units** — "8,432 steps", "72 bpm", "6h 45m sleep", not bare numbers
- **Round appropriately** — steps are whole numbers, HR to 1 decimal, sleep to nearest 5 minutes

## Gotchas

1. **Sleep is dated to start day** — a sleep session starting April 3rd at 11pm and ending April 4th at 7am belongs to April 3rd
2. **Weight searches backward** — if no weight reading exists for a specific date, the summary shows the most recent prior reading
3. **Missing data ≠ zero** — if `value` is null or `data_points` is 0, the user didn't record data that day, not that the value was 0
4. **Metric short names vs HK identifiers** — `health_query` uses short names (steps, hrv, spo2). `health_raw` accepts both short names and full HK identifiers
5. **Aggregation matters** — steps should be summed (total for period), heart rate should be averaged, weight should use latest. Using the wrong aggregation gives misleading results
6. **daily_breakdown may have gaps** — days with no data are omitted from the array, not filled with null
7. **Workout spike detection** — compares this week to a 4-week average, so it needs ~4 weeks of data to be meaningful
8. **health_raw limit** — capped at 500 samples. For large date ranges, narrow the time window or the data will be truncated
