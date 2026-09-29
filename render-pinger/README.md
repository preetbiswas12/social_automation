# render-pinger — Uniform 35-minute GitHub Actions dispatcher

A tiny Render **web service** that POSTs one `workflow_dispatch` every 35 minutes. The interval is a real loop (35 min after each dispatch), so the spacing is uniform 35 minutes — unlike cron, which alternates 35/25-minute gaps. This makes the same 35-min beat safe for **views** (5-min per-link limit) and **likes** (30-min per-link limit).

## Deploy

**New + → Web Service** in the Render dashboard:

- Repo: `preetbiswas12/social_automation`, **Root directory**: `render-pinger`
- Runtime: **Node**, Build command: `npm install`, Start command: `node server.js`
- Plan: **Free** (or paid if you prefer)
- **Environment variables**:

| Key | Value |
|---|---|
| `GH_TOKEN` | Fine-grained PAT — only `preetbiswas12/social_automation`, **Actions: read and write** ([create here](https://github.com/settings/personal-access-tokens/new)) |
| `ZEFAME_WORKFLOW` | `views` or `likes` |
| `GH_REPO` | `preetbiswas12/social_automation` |
| `INTERVAL_MINUTES` | `35` (default) |
| `KEEP_ALIVE_URL` | `https://<your-service>.onrender.com` — REQUIRED on the free plan (see below) |

## The free-plan catch (read this)

Render **free** web services spin down after 15 minutes without **inbound** traffic, and the loop's outbound GitHub calls don't count — if it sleeps, the interval stops until someone hits the URL. So set `KEEP_ALIVE_URL` to the service's own URL after it's created: the service then pings its own `/healthz` every 10 minutes, each a self-ping counting as inbound traffic, and the idle timer never fires.

Two more free-plan facts:
- **750 instance hours/month per workspace**, shared across all your free web services. This pinger runs 24/7 ≈ 720 h/mo — if the old `social-automation` dashboard service is still deployed, pause/delete it or you'll hit the cap and both get suspended.
- Render may restart the service at any time; the loop just starts again (and dispatches on boot since `IMMEDIATE_FIRST` defaults to on).

## Verify

After deploy:
1. Check the log — you should see `render-pinger up ... every 35 min` and a `dispatch views: HTTP 204 (accepted)` right away.
2. Open `https://<your-service>.onrender.com/last` — it shows the last dispatch result.
3. `POST /dispatch` triggers one manually; the repo's Actions tab should show a run within a minute.

## Routes

- `GET /healthz` — used by the keep-alive and Render.
- `GET /last` — last dispatch result JSON.
- `POST /dispatch` — fire one dispatch now.

## Alternatives

- `cloudflare-worker/` — same thing, free on Cloudflare Workers (no Render at all).
- `render-cron/` — paid Render cron job ($1/mo min) if you'd rather not keep a web service awake.