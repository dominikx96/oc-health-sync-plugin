# Deploying oc-health-sync to a VPS

This guide walks through deploying oc-health-sync on a Linux VPS. The stack is Tailscale-isolated (no public inbound ports) and layers our compose overlay on top of the upstream [supabase/supabase](https://github.com/supabase/supabase) self-host docker setup.

## Prerequisites

- A Linux VPS with a public IP (Ubuntu 22.04+ recommended)
- Docker (installed in step 1)
- Tailscale (installed in step 1)

---

## Step 1: Install prerequisites

```bash
# Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # log out and back in after this

# Tailscale
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

---

## Step 2: Get the code

```bash
git clone https://github.com/dominikx96/oc-health-sync.git ~/oc-health-sync
```

---

## Step 3: Configure secrets

```bash
cp ~/oc-health-sync/deploy/.env.example ~/oc-health-sync/deploy/.env
```

Open `deploy/.env` and replace every `changeme-*` placeholder with strong, unique values:

| Variable | Notes |
|---|---|
| `POSTGRES_PASSWORD` | Strong random password for the `postgres` superuser |
| `JWT_SECRET` | At least 32 characters; used by Supabase Auth internals |
| `ANON_KEY` / `SERVICE_ROLE_KEY` | JWTs signed with `JWT_SECRET` — see [JWT generator](https://supabase.com/docs/guides/self-hosting/docker#generate-api-keys) |
| `INGEST_API_KEY` | Bearer token the iOS app sends on every request |
| `MCP_API_KEY` | Bearer token the MCP client sends |
| `INGEST_USER_PASSWORD` | Must match the password embedded in `INGEST_DATABASE_URL` |
| `READ_USER_PASSWORD` | Must match the password embedded in `MCP_DATABASE_URL` |

---

## Step 4: Get the official Supabase self-host compose

We layer our overlay on top of the upstream stack rather than re-creating it.

```bash
# Clone the upstream repo anywhere on the VPS
git clone --depth 1 https://github.com/supabase/supabase ~/supabase-base

# Copy the operator-tunable env file as a starting point
cp ~/supabase-base/docker/.env.example ~/supabase-base/docker/.env

# Append our overlay-specific vars into it
cat ~/oc-health-sync/deploy/.env >> ~/supabase-base/docker/.env
```

> See [supabase.com/docs/guides/self-hosting/docker](https://supabase.com/docs/guides/self-hosting/docker) for current instructions on upstream env vars (JWT keys, SMTP, etc.).

In `~/supabase-base/docker/.env`, make sure the DB port is set to **54422** (we use this to coexist with other Supabase projects on the same host):

```bash
POSTGRES_PORT=54422
```

The Supabase Studio UI will be available on port **54423**. Kong (the API gateway / ingest endpoint) runs on **8000** in production.

---

## Step 5: Bring the stack up

```bash
cd ~/supabase-base/docker

docker compose \
  -f docker-compose.yml \
  -f ~/oc-health-sync/deploy/docker-compose.mcp.yml \
  up -d

# Wait until Postgres is ready
docker compose logs -f db
# Look for: "database system is ready to accept connections"
# Ctrl-C once you see it
```

---

## Step 6: Apply migrations

Run all five migrations in order against the local Postgres (port 54422):

```bash
cd ~/oc-health-sync

PGPASSWORD=$POSTGRES_PASSWORD psql \
  -h 127.0.0.1 -p 54422 -U postgres -d postgres \
  -f supabase/migrations/20260507000000_init_tables.sql

PGPASSWORD=$POSTGRES_PASSWORD psql \
  -h 127.0.0.1 -p 54422 -U postgres -d postgres \
  -f supabase/migrations/20260507000100_roles.sql

PGPASSWORD=$POSTGRES_PASSWORD psql \
  -h 127.0.0.1 -p 54422 -U postgres -d postgres \
  -f supabase/migrations/20260507000200_metrics_views.sql

PGPASSWORD=$POSTGRES_PASSWORD psql \
  -h 127.0.0.1 -p 54422 -U postgres -d postgres \
  -f supabase/migrations/20260507000300_data_completeness.sql

PGPASSWORD=$POSTGRES_PASSWORD psql \
  -h 127.0.0.1 -p 54422 -U postgres -d postgres \
  -f supabase/migrations/20260507000400_detect_anomalies.sql
```

**Alternative:** if the Supabase CLI is installed on the VPS, one command applies them all in order:

```bash
supabase db push \
  --db-url "postgresql://postgres:$POSTGRES_PASSWORD@127.0.0.1:54422/postgres"
```

---

## Step 7: Create login users

```bash
cd ~/oc-health-sync
set -a; source deploy/.env; set +a
./deploy/init-users.sh
```

This creates `ingest_user` and `read_user` in Postgres and grants them the appropriate roles (`health_ingest_role` and `health_read_role`). The script is idempotent — safe to re-run if you need to rotate passwords.

---

## Step 8: Restart the MCP container

The MCP server connects as `read_user`, which did not exist until the previous step. Restart it so it can establish its connection pool:

```bash
docker compose \
  -f ~/supabase-base/docker/docker-compose.yml \
  -f ~/oc-health-sync/deploy/docker-compose.mcp.yml \
  restart mcp
```

---

## Step 9: Expose to your tailnet

Use `tailscale serve` to make the services reachable on your tailnet. This keeps everything private — only devices logged in to your Tailscale account can reach these ports.

```bash
# Kong gateway (ingest + Supabase APIs) on port 8000
sudo tailscale serve --bg --tcp 8000 8000

# MCP server on whatever MCP_PORT is set to (default 3737)
source ~/oc-health-sync/deploy/.env
sudo tailscale serve --bg --tcp $MCP_PORT $MCP_PORT
```

Verify both are registered:

```bash
tailscale serve status
```

> **Security:** Do **not** use `tailscale funnel`. Funnel exposes services to the public internet; `serve` restricts access to your tailnet only.

---

## Step 10: Configure the iOS app

In the oc-health-sync iOS app settings:

- **Server URL:** `http://<tailscale-ip>:8000/functions/v1/ingest`
- **API key:** the value of `INGEST_API_KEY` from your `deploy/.env`

Tap **Test Connection** to verify end-to-end.

To find your VPS's Tailscale IP:

```bash
tailscale ip -4
```

---

## Step 11: Configure your MCP client

Point whichever MCP client you use (Claude Desktop, VS Code MCP extension, etc.) at:

- **URL:** `http://<tailscale-ip>:$MCP_PORT/mcp`
- **Auth header:** `Authorization: Bearer $MCP_API_KEY`

Example Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "oc-health-sync": {
      "url": "http://<tailscale-ip>:3737/mcp",
      "headers": {
        "Authorization": "Bearer <your-MCP_API_KEY>"
      }
    }
  }
}
```

---

## Smoke test

Once everything is up, run the smoke test (created in task 4.4):

```bash
cd ~/oc-health-sync
set -a; source deploy/.env; set +a

INGEST_URL=http://127.0.0.1:8000/functions/v1/ingest \
MCP_URL=http://127.0.0.1:$MCP_PORT/mcp \
./deploy/smoke.sh
```

A passing run prints success messages for both the ingest POST and the MCP health check.

---

## Backup

The Postgres data lives in the upstream Supabase compose's named volumes. Snapshot with:

```bash
# Check actual volume names on your host first
docker volume ls | grep supabase

# Example snapshot (volume names may vary — check docker volume ls output)
docker run --rm \
  -v supabase_db-data:/data \
  -v "$HOME/backups":/backup \
  alpine \
  tar czf /backup/db-backup-$(date +%F).tar.gz /data
```

Schedule this in cron (e.g., daily at 02:00):

```bash
0 2 * * * docker run --rm -v supabase_db-data:/data -v $HOME/backups:/backup alpine tar czf /backup/db-backup-$(date +\%F).tar.gz /data
```

Store backups off-VPS (e.g., `rclone copy ~/backups/ remote:oc-health-sync-backups/`).
