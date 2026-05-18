# Cron runbook — daily ntfy.pl catering sync

Hand this file to the scheduled agent that runs the daily diet sync. It is
self-contained: it does not require the `diet-coach` skill to be loaded.

## What this job does

Once a day it mirrors the user's **ntfy.pl catering plan** into the
`oc-health-sync` MCP server, so the rest of the day's nutrition tracking has an
accurate baseline. It only refreshes the *plan*; it never records what was
eaten and never modifies the user's consumption log.

## When

Once daily, early — around **06:00 local time**, before the first meal.
Re-running later the same day is safe (the sync is idempotent).

## Capabilities the agent needs

1. **Browser automation** with a **persisted session** (e.g. Playwright MCP
   with a fixed `userDataDir`, or an equivalent persistent browser context).
2. An **MCP client** connected to the `oc-health-sync` server (the same server
   the `diet-coach` skill uses), with the `diet_sync_subscriptions` and
   `diet_sync_catering_day` tools available.

## One-time human setup (not the agent's job)

A human logs into `https://ntfy.pl` **once** in the browser profile the cron
will reuse, completing any 2FA, and confirms the diet-management page loads
without a fresh login. The cron agent must **never** type credentials, solve
2FA, or create an account — if it lands on a login screen, it stops and asks
the human to re-login into that profile.

## Method

Do **not** hand-construct the ntfy.pl API URL. Open the diet-management page
and let the ntfy.pl web app issue its own authenticated requests, then read the
**response bodies** out of the browser's network log. This needs no `user_id`
and no query parameters, and keeps working if ntfy.pl changes its URLs.

API host (for recognising the requests): `orion-api.ntfy.pl/api/v2.0`.

## Steps

1. Open the browser using the **persisted ntfy.pl profile**. Start recording
   network requests.
2. Navigate to `https://ntfy.pl/zarzadzanie-dietami/`.
   - If it redirects to a login / sign-in page → **session expired**: stop,
     notify the human to re-login into the persisted profile, do not continue.
3. In the recorded network traffic, find the request to
   `…/api/v2.0/users/<id>/delivery-diets` and read its **response body**
   (raw JSON). This is the subscriptions payload.
4. Call MCP tool **`diet_sync_subscriptions`** with:
   ```json
   { "payload": <the raw delivery-diets JSON from step 3> }
   ```
5. From that JSON, for each **active** subscription note its `delivery_diet_id`
   and its `delivery_days`. Decide whether **today** is a delivery day for any
   active subscription.
   - If today is **not** a delivery day for any of them → nothing to sync.
     Emit a one-line note and finish.
6. For each active `delivery_diet_id` whose plan covers **today**: make the
   page load that diet for today's date — navigate to
   `https://ntfy.pl/zarzadzanie-dietami/?delivery_diet_id=<id>&date=<YYYY-MM-DD>`
   using today's date (or use the on-page date picker) — and capture the
   **response body** of the resulting
   `…/api/v2.0/users/<id>/deliveries?…&date=<today>&delivery_diet_id=<id>…`
   request.
7. Call MCP tool **`diet_sync_catering_day`** with:
   ```json
   { "payload": <the raw deliveries JSON from step 6> }
   ```
   Repeat steps 6–7 for each active `delivery_diet_id`.
8. Emit one line, e.g.:
   `Synced <date>: <n> meals across <k> subscription(s).`

## Optional follow-on — previous-day recap

If the `diet-coach` skill is available, after the sync run its **Prev-day
recap** playbook for *yesterday* (consumed kcal vs plan target and net kcal,
one line on deviations). Skip if the skill is not loaded.

## Rules

- **PII:** the raw ntfy.pl JSON contains personal data (delivery addresses,
  account ids). Never write it to disk, logs, or version control. Pass it
  straight from the network capture into the MCP tool argument, then discard.
- **Idempotent:** `diet_sync_subscriptions` and `diet_sync_catering_day` never
  duplicate rows and never touch the user's consumption log. Re-running any day
  is safe.
- **Fail loud, never fabricate:** on session expiry, a changed page, or a
  missing request, stop and report what happened. Never invent or partially
  reconstruct a payload.
