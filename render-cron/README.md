# render-cron — GitHub Actions dispatcher as a Render Cron Job

A tiny Render cron job that pings the GitHub Actions `workflow_dispatch` endpoint on a schedule, replacing cron-job.org and the local `pinger.sh` loop.

## Files

| File | Purpose |
|---|---|
| `ping.mjs` | One-shot dispatch, exits in ~2 s. Use for cheap scheduled pings. |
| `ping-uniform.mjs` | Uniform 35-minute spacing via chained runs. Expensive — see below. |
| `render.yaml` | Blueprint for the cron job (or create it manually from the dashboard). |

## The 35-minute truth (read this before deploying)

Render cron jobs use **standard 5-field cron**, so a 35-minute beat alternates:

- Schedule `*/35 * * * *` → fires at `:00` and `:35` → gaps of **35 min and 25 min**.

That's the same pattern you saw on cron-job.org. An hour simply cannot be split into uniform 35-minute slices.

- **For views** this is fine — the site limit is 5 min per link, so even the 25-min gap is comfortable. Use `*/35 * * * *`.
- **For likes** the 25-min gap is under the site's 30-minute per-link limit, so every other run gets refused. Either:
  - use `0 * * * *` (once an hour, uniform 60-min gaps, safe, cheap), or
  - use `ping-uniform.mjs` for true uniform 35-minute spacing (see below).

## Setup

1. **Create a token** (cron jobs store it on Render): [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new) → only select `preetbiswas12/social_automation` → **Actions: Read and write** → Generate.
2. **Create the cron job** — either:
   - *Manual*: Render Dashboard → **New + → Cron Job** → connect this repo →
     - Root directory: `render-cron`
     - Runtime: **Node**
     - Build command: `true`
     - Start command: `node ping.mjs`
     - Schedule: `*/35 * * * *`
     - Plan: `0.5c-512mb`
     - Environment: `GH_TOKEN` (the fine-grained token), `ZEFAME_WORKFLOW=views`, `GH_REPO=preetbiswas12/social_automation`
   - *Blueprint*: **New + → Blueprint** → pick this repo → point the config at `render-cron/render.yaml`.
3. **Test**: open the cron job's **Runs** page → **Trigger Run** → logs should show `dispatch views: HTTP 204 (accepted)`.
4. Check the GitHub side: the `views.yml` workflow appears in the repo's Actions tab within a minute.

## Cost

Cron jobs are a paid Render feature: **$1/mo minimum per job**, plus per-second runtime.

- `ping.mjs` runs ~2 s per tick → ~48 ticks/day → a few cents of runtime → **~$1-2/mo**.
- Likes + views = two jobs = **at least $2/mo**.
- `ping-uniform.mjs` runs ~70 of every ~70 minutes → billed like an always-on instance (~**$20-30/mo**). Only use it for true uniform-35 likes cadence.

## Notes

- Render guarantees **at most one run at a time**: a scheduled tick waits if a run is still going, so beats never collide (and GitHub's `concurrency` group queues anything that does overlap).
- Runs are force-stopped after 12 hours — irrelevant here since `ping.mjs` exits in seconds (and `ping-uniform.mjs` exits ~70 min in).
- All schedule times are UTC. `*/35 * * * *` fires at :00/:35 UTC regardless of your timezone.
- The GitHub Actions queue is the same as before: every dispatch pays Actions minutes, so the **public-repo question** still decides long-term cost.