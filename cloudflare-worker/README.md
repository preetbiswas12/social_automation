# cloudflare-worker — free scheduled GitHub Actions dispatcher

The same dispatcher as `render-cron/`, hosted for free on **Cloudflare Workers** (Workers Free plan: 100,000 requests/day, 5 cron triggers per account, no credit card). Your code here runs the dispatch — it isn't just an HTTP config like cron-job.org.

## Why Cloudflare for this

| | Free? | Runs your code? | 35-min? |
|---|---|---|---|
| **Cloudflare Worker** (this folder) | ✅ | ✅ | cron → 35/25 alternation, like everywhere else |
| GitHub Actions `schedule:` | ✅ (public repo) | ✅ (the workflows themselves) | same alternation |
| cron-job.org | ✅ | ❌ (config only) | same alternation |

A cron expression fundamentally can't do uniform 35-minute slices (60 isn't divisible by 35), so every cron host alternates 35/25. For views the 25-min gap is fine; for likes use `0 * * * *`.

## Setup (two ways)

### A. Dashboard drag-and-drop (no tools)

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create Worker**.
2. Paste `worker.js` into the editor (replace the hello-world template), **Save and deploy**.
3. **Settings → Variables**: add `GH_REPO` and `ZEFAME_WORKFLOW` (plain text). Add `GH_TOKEN` via **Settings → Variables → + Add → Encrypt** (the fine-grained token — only `preetbiswas12/social_automation`, *Actions: read and write*).
4. **Settings → Triggers → Cron Triggers**: add `*/35 * * * *`.
5. Test: open the Worker's URL → append `/dispatch` → you should see `dispatch OK (204)`. Then check the repo's Actions tab — a run appears within a minute.

### B. Wrangler CLI (from this folder)

```bash
npm i -g wrangler        # or: npx wrangler ...
cd cloudflare-worker
wrangler login
wrangler deploy
wrangler secret put GH_TOKEN        # paste the fine-grained token
wrangler deploy                     # re-deploy so the secret binds
```

The `[triggers]` cron in `wrangler.toml` is now live. To re-test anytime: `wrangler tail` to watch logs, or hit `/dispatch`.

## Likes, or a second cadence

- **Likes**: change `wrangler.toml` crons to `["0 * * * *"]` and `ZEFAME_WORKFLOW = "likes"`, deploy a second Worker (free limit is 5 cron triggers/account, so two Workers fit easily). Or keep one Worker and add both cron lines — but then views and likes share the same dispatch config; separate Workers are cleaner.
- **Exact uniform 35** (the one thing no cron can do): a Worker could instead reschedule itself with a Durable Object alarm at precise 35-minute timestamps. Real but more moving parts — say the word and I'll build it.

## Free-tier watch-outs

- **GitHub API rate limit** is 5,000 request/hour authed — 41 dispatches/day is noise.
- Cron trigger wall time is capped at 15 min per run — irrelevant here, this Worker exits in ~1 s.
- Only the GitHub Actions **minutes** still cost anything, and only if the repo is private — the public-repo question remains the last economic cliff.

`render-cron/` stays in the repo as the paid alternative if you ever want it, and `pinger.sh` remains the free self-hosted fallback.