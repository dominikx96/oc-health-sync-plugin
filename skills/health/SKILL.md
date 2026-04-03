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

You have access to the user's Apple HealthKit data via four tools.
Data is synced from their iPhone/Apple Watch and stored locally.

## Tool Selection Guide

**Start with `health_summary`** for broad questions:
- "How was my health this week?"
- "Summarize yesterday"
- "Give me a weekly report"

**Use `health_query`** for specific metrics:
- "What was my average resting heart rate last week?"
- "How many steps did I take on Monday?"
- "Show me my weight trend for January"

**Use `health_anomalies`** for trend detection:
- "Anything unusual in my health data?"
- "Am I overtraining?"
- "How's my recovery looking?"

**Use `health_raw` only as a last resort** when other tools don't have the detail needed.
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
