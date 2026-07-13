# Deploy

ChronoWhoop is a static bundle served as Cloudflare Workers assets at
https://chronowhoop.com (assets-only Worker, no server code — `wrangler.jsonc`).

## Normal path: CI deploy-on-main

Push (or merge) to `main`. The `deploy` job in `.github/workflows/ci.yml`
runs `bun run deploy` after the gating jobs (`check` +
`browser-opfs-chromium`) pass; WebKit is informational and never blocks it.

Required repo secrets (GitHub → Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | token with Workers Scripts:Edit + Workers Routes edit for the chronowhoop.com zone |
| `CLOUDFLARE_ACCOUNT_ID` | the account owning the chronowhoop.com zone |

## Manual deploy

```
bun run deploy
```

(= `bun run build && wrangler deploy`.) Wrangler needs the same credentials
locally: `wrangler login`, or `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`
in the environment. The custom domain is declared in `wrangler.jsonc`
(`routes`), so a plain deploy attaches it — no dashboard steps.

## Verifying a deploy

- Load https://chronowhoop.com; the build id (short git hash, injected as
  `__BUILD_ID__` at build time) must match the deployed commit.
- An already-open client shows the **"Update available"** banner (see below)
  rather than switching silently.

## Rollback

```
bunx wrangler deployments list   # find the previous deployment
bunx wrangler rollback           # interactive; or: wrangler rollback <version-id>
```

Rollback re-activates a previous Worker version including its assets. Clients
then treat the old bundle as "new": the service worker sees changed content
and offers the update prompt — no cache flush needed. Note that data files
(OPFS) live on the devices, not in the deploy: rolling back an app whose
schemaVersion moved does NOT roll back user data — files written by the newer
app are refused in place as `unsupported-version` until the app is rolled
forward again (see `docs/specs/storage.md`).

## Service-worker update flow (what a deploy does to running clients)

- The build precaches the full bundle (vite-plugin-pwa/Workbox,
  `registerType: 'prompt'`); the precache-completeness test
  (`bun run test:precache`, run by CI after the build) guards the manifest.
- On the next load/reload after a deploy, the new SW installs in the
  background and the app shows the **Update available — Update now** banner
  (`UpdateBanner.svelte`); the user taps to activate and reload. Nothing
  updates mid-session under the user's feet.
- Fully offline clients keep running the precached previous build until they
  next see the network — that is the PWA contract, not a fault.
