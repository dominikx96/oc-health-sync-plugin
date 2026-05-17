# Deploying oc-health-sync to a VPS

One command, given a Linux VPS with **Docker** and **Tailscale** preinstalled. The MCP image lives at `ghcr.io/dominikx96/oc-health-sync-plugin/mcp-server` (public — no GitHub auth needed).

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/dominikx96/oc-health-sync-plugin/main/deploy/install.sh \
  | bash -s -- v0.1.0
```

That's it. The script:

1. Generates strong random secrets and writes `~/oc-health-sync/.env` (mode 600).
2. Clones the upstream Supabase compose into `~/supabase-base/`.
3. Pulls `mcp-server:v0.1.0` from public GHCR.
4. Brings up Postgres, applies migrations, creates the login users, drops the edge function code into the volume, starts everything.
5. Runs the smoke test.
6. Saves a copy of itself to `~/oc-health-sync/install.sh` for future upgrades.

When it finishes it prints your generated `MCP_API_KEY` and `INGEST_API_KEY` (also in `.env`). **Save these** — they're how your iOS app and MCP client authenticate.

## Expose to your tailnet

```bash
sudo tailscale serve --bg --tcp 8000 8000     # Kong / ingest
sudo tailscale serve --bg --tcp 3737 3737     # MCP
tailscale serve status
```

> **Security:** Use `serve` (tailnet-only), never `funnel` (public).

## Upgrade

```bash
~/oc-health-sync/install.sh v0.1.1
```

Snapshots the DB to `~/backups/`, pulls the new image, runs migrations, swaps the edge function source, restarts. If anything fails before the restart, the running app is untouched.

## Roll back

```bash
~/oc-health-sync/install.sh --rollback
```

Re-pulls the version stashed in `~/oc-health-sync/.last-version.bak` and restarts. If the schema is genuinely incompatible with the old image (i.e. migration discipline was violated — see `CONTRIBUTING.md`), restore from the snapshot:

```bash
gunzip -c ~/backups/pre-upgrade-<timestamp>.sql.gz \
  | docker exec -i supabase-db psql -U postgres postgres
```

## iOS app + MCP client config

Find your VPS's tailnet IP:

```bash
tailscale ip -4
```

**iOS app:**
- Server URL: `http://<tailscale-ip>:8000/functions/v1/ingest`
- API key: `INGEST_API_KEY` from `~/oc-health-sync/.env`

**MCP client** (e.g. Claude Desktop, `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "oc-health-sync": {
      "url": "http://<tailscale-ip>:3737/mcp",
      "headers": { "Authorization": "Bearer <MCP_API_KEY>" }
    }
  }
}
```

## Backups

Schedule a daily Postgres dump:

```bash
# crontab -e
0 2 * * * docker run --rm -v supabase_db-data:/data -v $HOME/backups:/backup alpine \
  tar czf /backup/db-backup-$(date +\%F).tar.gz /data
```

Store off-VPS (e.g. `rclone copy ~/backups/ remote:oc-health-sync-backups/`).

## File layout on the VPS

```
~/oc-health-sync/
  install.sh              ← saved by curl|bash; re-runnable
  smoke.sh                ← fetched alongside install.sh
  docker-compose.mcp.yml  ← rewritten on every install/upgrade
  .env                    ← state — generated secrets, mode 600
  .last-version           ← state — current version
  .last-version.bak       ← state — previous version

~/supabase-base/          ← upstream supabase clone
~/backups/                ← pg_dump snapshots
```

## Customising secrets

`install.sh` only generates secrets if `~/oc-health-sync/.env` doesn't exist yet. If you want to control specific values, export them before running:

```bash
INGEST_API_KEY=my-fixed-key MCP_API_KEY=another \
  curl -fsSL https://raw.githubusercontent.com/dominikx96/oc-health-sync-plugin/main/deploy/install.sh \
  | bash -s -- v0.1.0
```

Or edit `~/oc-health-sync/.env` after first install and re-run `install.sh` (the `.env` file is preserved across runs).

## Login users and writer URLs

`install.sh` creates three write-limited login users in addition to the read/ingest users:

| User | Role | Env var |
|---|---|---|
| `gym_writer_user` | `gym_writer_role` | `MCP_GYM_WRITER_URL` |
| `diet_writer_user` | `diet_writer_role` | `MCP_DIET_WRITER_URL` |

`MCP_GYM_WRITER_URL` and `MCP_DIET_WRITER_URL` are composed from the generated passwords and injected into the `mcp` container at runtime. The provisioning step (psql block inside `install.sh`) runs on every install and upgrade, so new users are created automatically on first contact.
