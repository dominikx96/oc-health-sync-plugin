# Deploying oc-health-sync to a VPS

This guide walks through deploying oc-health-sync on a Linux VPS. Releases come from a CI pipeline as **(a)** a private Docker image on GHCR and **(b)** this very tarball, attached to a GitHub release. The VPS pulls both, runs `install.sh` once, and then runs `upgrade.sh` for every subsequent version transition.

The stack is Tailscale-isolated (no public inbound ports) and layers our compose overlay on top of the upstream [supabase/supabase](https://github.com/supabase/supabase) self-host docker setup.

## Prerequisites

- A Linux VPS with a public IP (Ubuntu 22.04+ recommended).
- **Docker** — `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER` (log out and back in after).
- **Tailscale** — `curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up`.
- **`postgresql-client`** — `init-users.sh` runs `psql` from the host: `sudo apt-get install -y postgresql-client`.
- **`rsync`** — used to overlay each new tarball onto `~/oc-health-sync/`: `sudo apt-get install -y rsync`.
- **`gh` CLI** — needed to download the private release tarball:
  ```
  type -p curl >/dev/null || sudo apt-get install -y curl
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
  sudo apt-get update && sudo apt-get install -y gh
  gh auth login            # one-time browser flow
  ```
- A **GitHub PAT** with `read:packages` scope, to write into `deploy/.env` as `GHCR_PAT`. Generate at https://github.com/settings/tokens.

## First-time install

### Step 1 — Download and extract the release tarball

```bash
TARGET=v0.1.0   # whichever release you want
gh release download "$TARGET" \
  -R dominikx96/oc-health-sync-plugin \
  -p '*.tar.gz'
tar xzf "oc-health-sync-${TARGET}.tar.gz"
mkdir -p ~/oc-health-sync
rsync -a --exclude='.env*' --exclude='.last-version*' \
  "oc-health-sync-${TARGET}/" ~/oc-health-sync/
cd ~/oc-health-sync
```

The `rsync` line is the same on first install and every upgrade: it never overwrites operator-managed state (`.env`, `.last-version*`).

### Step 2 — Configure secrets

```bash
cp .env.example .env
```

Open `.env` and replace every `changeme-*` placeholder. See the comments inline; in particular:

| Variable | Notes |
|---|---|
| `POSTGRES_PASSWORD` | Strong random password for the `postgres` superuser. |
| `JWT_SECRET` | At least 32 characters. |
| `ANON_KEY` / `SERVICE_ROLE_KEY` | JWTs signed with `JWT_SECRET` — see the [Supabase JWT generator](https://supabase.com/docs/guides/self-hosting/docker#generate-api-keys). |
| `INGEST_API_KEY` | Bearer token the iOS app sends. |
| `MCP_API_KEY` | Bearer token the MCP client sends. |
| `INGEST_USER_PASSWORD` / `READ_USER_PASSWORD` | Must match the password in the corresponding DB URL. |
| `GHCR_PAT` | Read-only GitHub PAT with `read:packages`. |

### Step 3 — Confirm `.env` then run `install.sh`

```bash
./install.sh "$TARGET"
```

This script:

1. Clones upstream supabase compose into `~/supabase-base/` (idempotent).
2. Merges `.env` into `~/supabase-base/docker/.env`.
3. `docker login` to GHCR with `GHCR_PAT`.
4. Pulls the MCP image at `$TARGET`.
5. Brings up `db`, `kong`, `functions`.
6. Waits for Postgres.
7. Runs migrations as the `postgres` superuser.
8. Runs `init-users.sh` to create `ingest_user` and `read_user`.
9. Copies the edge function source from the image into the upstream `functions/ingest/` volume.
10. Brings up `mcp`.
11. Runs `smoke.sh`.
12. Records `$TARGET` in `.last-version`.

A passing run prints `✓ Installed $TARGET.` and instructions for the next step.

### Step 4 — Expose to your tailnet

```bash
sudo tailscale serve --bg --tcp 8000 8000
sudo tailscale serve --bg --tcp 3737 3737     # or whatever MCP_PORT you set
tailscale serve status
```

> **Security:** Do **not** use `tailscale funnel`. Funnel exposes services to the public internet; `serve` restricts access to your tailnet only.

### Step 5 — Configure the iOS app and MCP client

**iOS app:**
- Server URL: `http://<tailscale-ip>:8000/functions/v1/ingest`
- API key: `INGEST_API_KEY` from `.env`

**MCP client (e.g. `~/Library/Application Support/Claude/claude_desktop_config.json`):**

```json
{
  "mcpServers": {
    "oc-health-sync": {
      "url": "http://<tailscale-ip>:3737/mcp",
      "headers": { "Authorization": "Bearer <your-MCP_API_KEY>" }
    }
  }
}
```

Find your VPS's tailnet IP with `tailscale ip -4`.

## Upgrading to a new version

```bash
TARGET=v0.1.1
gh release download "$TARGET" \
  -R dominikx96/oc-health-sync-plugin \
  -p '*.tar.gz'
tar xzf "oc-health-sync-${TARGET}.tar.gz"
rsync -a --exclude='.env*' --exclude='.last-version*' \
  "oc-health-sync-${TARGET}/" ~/oc-health-sync/
cd ~/oc-health-sync
./upgrade.sh "$TARGET"
```

`upgrade.sh`:

1. Snapshots the DB to `~/backups/pre-upgrade-<timestamp>.sql.gz`.
2. Stashes the current `.last-version` in `.last-version.bak`.
3. `docker login` to GHCR.
4. Pulls the MCP image at `$TARGET`.
5. Runs migrations as a one-shot — fails fast if any migration breaks; the running app is untouched.
6. Copies new edge function source into the host volume.
7. Restarts `mcp` and `functions`.
8. Runs `smoke.sh`.
9. Writes `$TARGET` into `.last-version`.

If anything fails after step 5, the previous version is still recorded in `.last-version.bak`.

## Rollback

```bash
cd ~/oc-health-sync
./upgrade.sh --rollback
```

Re-pulls the version recorded in `.last-version.bak`, runs migrations (forward-only, so this is a no-op for the rollback case as long as migration discipline is followed — see `CONTRIBUTING.md`), and restarts.

If the schema is incompatible with the old image (i.e. migration discipline was violated), restore from the snapshot:

```bash
gunzip -c ~/backups/pre-upgrade-<timestamp>.sql.gz \
  | docker exec -i supabase-db psql -U postgres postgres
```

## Backup

The Postgres data lives in the upstream Supabase compose's named volumes. Schedule a daily snapshot:

```bash
# crontab -e
0 2 * * * docker run --rm -v supabase_db-data:/data -v $HOME/backups:/backup alpine tar czf /backup/db-backup-$(date +\%F).tar.gz /data
```

Store backups off-VPS (e.g., `rclone copy ~/backups/ remote:oc-health-sync-backups/`).

## File layout on the VPS

```
~/oc-health-sync/
  upgrade.sh, install.sh, ...       ← overwritten on every upgrade (rsync from tarball)
  .env                              ← state — operator-edited secrets
  .last-version, .last-version.bak  ← state — managed by install/upgrade scripts

~/supabase-base/                    ← upstream supabase clone
~/backups/                          ← pg_dump snapshots
```
