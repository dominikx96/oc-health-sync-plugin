# Releasing `@oc-health-sync/openclaw-plugin`

## One-time setup

1. **Log in to npm** as a user with publish rights:
   ```bash
   npm login
   npm whoami
   ```
2. **Create the npm org** that owns the `@oc-health-sync` scope (free tier is fine for public packages):
   https://www.npmjs.com/org/create → name `oc-health-sync`.
3. Confirm you own the scope:
   ```bash
   npm access list packages @oc-health-sync
   ```

The `publishConfig.access` in `package.json` is already set to `public`, so scoped publishes do not need `--access public` on every release.

## Pre-publish checklist

Run from the repo root:

```bash
# Clean build
npm run clean && npm run build

# Inspect what will actually ship — should list dist/**, openclaw.plugin.json,
# skills/**, README.md, package.json, and NOTHING from src/, docs/, scripts/, agent/
npm pack --dry-run

# Smoke-test the tarball in a scratch dir
npm pack
cd /tmp && mkdir pkg-smoke && cd pkg-smoke && npm init -y
npm install /path/to/oc-health-sync-openclaw-plugin-<version>.tgz
node -e "console.log(require('@oc-health-sync/openclaw-plugin'))"
```

`prepublishOnly` runs `clean && build` automatically on `npm publish`, so a stale `dist/` cannot ship — but running it yourself first surfaces TypeScript errors before you bump the version.

## Publishing

### Pre-1.0 (publish to `next` tag)

While the plugin is pre-1.0, publish to the `next` dist-tag so `npm install @oc-health-sync/openclaw-plugin` does **not** pick it up by default:

```bash
npm version prerelease --preid=next   # 0.1.0 → 0.1.1-next.0
npm publish --tag next
git push --follow-tags
```

Users who want to try it opt in explicitly:

```bash
openclaw plugins install @oc-health-sync/openclaw-plugin@next
# or
npm install @oc-health-sync/openclaw-plugin@next
```

### Stable releases (1.0 and beyond)

```bash
npm version patch      # bug fix:      0.1.0 → 0.1.1
npm version minor      # new feature:  0.1.0 → 0.2.0
npm version major      # breaking:     0.1.0 → 1.0.0

npm publish
git push --follow-tags
```

`npm version` creates the commit + tag; `npm publish` runs `prepublishOnly` (clean build) automatically.

### Promoting `next` → `latest`

Once a `next` release is proven stable:

```bash
npm dist-tag add @oc-health-sync/openclaw-plugin@0.2.0 latest
```

## Rollback

**Never** use `npm unpublish` after 72 hours — it breaks anyone depending on that version. Instead, deprecate the broken release and publish a fixed patch:

```bash
npm deprecate @oc-health-sync/openclaw-plugin@0.1.3 "Broken ingest route — use 0.1.4+"
```

## Verifying a published release

```bash
npm view @oc-health-sync/openclaw-plugin
npm view @oc-health-sync/openclaw-plugin versions
npm view @oc-health-sync/openclaw-plugin dist-tags
```

On a fresh machine with OpenClaw installed:

```bash
openclaw plugins install @oc-health-sync/openclaw-plugin
openclaw gateway restart
openclaw gateway logs 2>&1 | grep "health-sync"
```
