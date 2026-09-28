# Views automation

Browser automation for Zefame's free pages, run on a fixed interval, with a
dashboard for watching and changing them.

It works in sessions:

- **Session 1** opens the page, pastes the reel link, clicks **Get Now**, waits
  1 min 10 s, looks for the success text, then the session ends
- **gap**
- **Session 2** does the same thing
- Repeats until you stop it

The Chrome window is opened **once** and reused for every session, so the site
sees one continuous user rather than a brand-new browser every time.

## The dashboard

`server.js` serves a dashboard and supervises one `zefame.js` process per
workflow. It does not reimplement any of the browser work, so the session logic
stays exactly as it is and a browser that dies in one workflow cannot take
another one down with it.

```bash
npm run serve
```

Then open `http://localhost:3000`. The browser prompts for a password; **any
username, the password as the password**. `?token=...` also works for curl.

From the dashboard you can:

- see each workflow's live state, last result, failures and a countdown to the
  next session
- start, stop, or run a single session now
- change the page URL, the reel link, the interval, the post-click wait and a
  max session count, and save them
- read the full log and the run history for each workflow

### Sessions are add and delete, not a fixed list

Each **session** is one reel on one page, on its own timer, in its own browser
process. You can add and remove them at runtime from the dashboard:

- **Add a session** — pick a page, give it a reel link, choose the interval, and
  it starts immediately (untick "start it now" to create it stopped)
- **Delete** — stops the session first if it is running, then removes it. You
  get asked separately whether to also delete its log and status file

A new session picks up a safe default interval from the page itself, so a views
session starts at 6 minutes and a likes session at 31 without you having to know
the numbers. The id is generated from the name (`reel 1` becomes `reel-1`), and
de-duplicated if that already exists.

**Give every session a different reel.** Zefame refuses the same reel twice
inside one service's window, so two sessions on the same reel means the second
one fails every cycle. The dashboard detects this and says so, and the Add form
refuses a duplicate outright.

Deleting a session leaves its history in `logs/runs.jsonl`. That file is
append-only on purpose — it is the record of what actually happened, and the
per-session status and log files are the disposable part.

**Each session is its own Chromium process**, so memory scales with how many are
running. Two is comfortable; on a small Render instance, four or more is likely
to get the service OOM-killed. The dashboard warns past two running at once.

### The two pages Zefame offers

The dashboard knows these two, and uses them to prefill new sessions and to warn
you about intervals that are too short:

| page | per order | site limit | safe interval |
| --- | --- | --- | --- |
| free-instagram-views | 300 views | 5 min | 6 min |
| free-instagram-likes | 10 likes | 30 min | 31 min |

The two services are not alike, and the likes one is much slower. Running it on
a 6 minute clock just collects `Please wait 24m 0s` errors, so the dashboard
warns if you set an interval below what the site itself allows.

Any other Zefame page can be added by pasting its URL, but then the dashboard
does not know its limit and cannot prefill or warn for it. The two above were
read from the site's own config endpoint.

### Settings changes need a restart

`config.json` is read when a process starts. Saving a new URL, reel, interval or
wait takes effect on the **next start** of that workflow, not mid-session. The
dashboard says so when you save one of those.

### Surviving a redeploy

`config.default.json` is the shipped template. `config.json` is created from it
on first boot and is never overwritten, so your edits survive a redeploy as long
as it is not gitignored-and-rebuilt. It *is* gitignored, so if you attach a
**Persistent Disk** mounted at `/app/data` and set `CONFIG_PATH=/app/data/config.json`
the config is written onto the disk and definitely survives.

`logs/` and `shots/` are always ephemeral unless they are on a disk too. The
dashboard's own history comes from the live status files, so it is still correct
after a redeploy - only the older run history is lost.

### Crash recovery

A dead browser is recoverable, so the supervisor restarts it after 30 s. After
10 crashes in an hour it stops trying and says so, so a crash loop cannot burn
the instance. A workflow you stopped by hand stays stopped.

On boot the supervisor reaps browsers left behind by a previous run, but only
after `/proc` confirms the remembered pid is still one of our `zefame.js`
processes, so a reused pid is never killed by mistake.

## The command line still works on its own

`server.js` is optional. The original single-workflow script is untouched:

```bash
npm start          # loop forever
npm run once       # a single session
npm run check      # verify selectors, never submits
npm run manual     # you paste and click, the script only watches
npm run config     # validate config.json and exit
```

## Run on Render

`render.yaml` and a `Dockerfile` are included. From the repo, run:

```bash
render blueprint launch
```

This creates a **Web Service**, not a Background Worker, because the dashboard
has to answer HTTP. The workflows are child processes of that same process, so
one service covers both. A worker cannot serve a page, which is the only reason
the type changed.

The image is `mcr.microsoft.com/playwright:v1.63.0-jammy`, which already contains
Chromium and its system libraries. **Keep the tag in step with the `playwright`
version in `package.json`** (currently 1.63.0) or the browser will not be found.

Environment variables:

| Var | Required | What it does |
| --- | --- | --- |
| `DASHBOARD_TOKEN` | no | overrides the password built into `server.js` |
| `NODE_ENV` | set by blueprint | `production` |
| `HEADLESS` | no | `1` forces headless. The per-session setting in the dashboard overrides it |
| `CONFIG_PATH` | no | where `config.json` lives. Point it at a disk to make dashboard edits survive a redeploy |
| `PORT` | set by Render | Render assigns this for web services; the app must bind it |

### The dashboard password

It is in `server.js`, so **deploying needs no setup at all** — no environment
variable, nothing to paste, no prompt. Log in with any username and that
password.

Because it is in the source, treat it as public: anyone who can read the repo
can log in and start browser sessions. To use something else, set
`DASHBOARD_TOKEN` in the environment and it overrides the built-in one, no code
change. The dashboard shows a warning banner while the built-in password is in
use.

`/healthz` is deliberately unauthenticated so Render can poll it. Everything
else needs the password.

Before trusting it, read the logs on the first deploy. What you are watching for
is `Turnstile verification failed` - see the Cloudflare section below.

**The free tier will not work.** A loop this continuous never idles, and Render's
free web services suspend when idle and cap at 750 hours a month. Use a paid
instance.

**Memory.** The blueprint starts on `starter` (512 MB). Each workflow is its own
Chromium, so two of them on one small box is tight — headless Chromium on a
single page wants a few hundred MB each. If you see the service being OOM-killed
or a workflow crash-looping with no useful error, that is the first thing to
check, and `standard` is the fix. Turning `headless` off makes this worse, not
better.

**Logs and screenshots do not survive a redeploy** unless they are on a disk
too. The dashboard's current state comes from the live status files, so it
stays correct - only the older run history is lost.

## Run on a plain Linux server

There is a `deploy/` folder for this.

```bash
# copy the project to the server first, then on the server:
sudo bash deploy/install.sh
```

The script installs Node dependencies, downloads the browser with its system
libraries, creates a `views` service user, and registers a systemd unit. It
deliberately **does not start the service** — verify first:

```bash
sudo -u views bash -c 'cd /opt/views-automation && node zefame.js --check'
```

If every selector says `OK`, start it:

```bash
sudo systemctl start views-automation
sudo systemctl status views-automation
tail -f /opt/views-automation/logs/service.log
```

That unit runs the single-workflow CLI. To get the dashboard and both workflows
on the same box instead, point the unit at `server.js` and give it a token:

```bash
Environment=DASHBOARD_TOKEN=your-long-random-string
ExecStart=/usr/bin/node /opt/views-automation/server.js
```

Then `systemctl` gives you the dashboard on port 3000. Put it behind a reverse
proxy with TLS if it is not on a private network — it is password protected but
it is plain HTTP.

### What changes on a server

| | Desktop | Server |
| --- | --- | --- |
| Headless | off, so you can watch and click | **on automatically** (no `DISPLAY`) |
| Root / container | n/a | adds `--no-sandbox` |
| Container `/dev/shm` | n/a | adds `--disable-dev-shm-usage` |
| Dead browser | you'd see it | **restarts itself and retries the session once** |
| Stopping | Ctrl+C | stops between sessions in under a second |

Headless turns on by itself when there is no `DISPLAY`. Force it either way with
`--headless` or `--no-headless`.

### Checking on it without watching

With the dashboard, open the page. Without it, the status file is updated after
every session:

```bash
cat /opt/views-automation/logs/status.json          # CLI, no --target
cat /opt/views-automation/logs/status-views.json   # when started with --target=views
```

```json
{
  "state": "running",
  "lastSession": 12,
  "lastResult": "success",
  "lastViews": "300",
  "sessionsRun": 12,
  "failures": 0,
  "nextSessionAt": "2026-09-28T14:41:02.000Z"
}
```

### The real risk on a server: Cloudflare

Zefame runs a Cloudflare Turnstile check before placing the order. On a desktop
you can click it if it appears. On a headless server **there is nobody to click
it**, so if the check ever escalates, that session fails with
`error page: Turnstile verification failed` and there is no way to fix it
without a human.

Both live runs so far passed it silently, so it may never come up — but this is
the thing to watch in the logs after the first few sessions. If you see it, the
options are: run headed under `xvfb-run` (a real browser on a virtual display),
or stop. I have not built any challenge-solving or fingerprint-spoofing into
this, and I would not add it.

A sustained automated loop on a free service is also a good way to get your
server's IP blocked, and it is against both Zefame's and Instagram's terms.
The 6 minute interval stays above Zefame's stated 5 minute cooldown, which is
the most I can do about that from here.

```bash
npm install
```

That's it on a desktop — the script drives the Chrome you already have. If it
can't find it, it falls back to Playwright's bundled Chromium
(`npx playwright install chromium`).

## Run it

```bash
npm start          # loop forever, one session every 6 minutes
npm run once       # a single session, then exit - good for the first try
npm run manual     # you paste and click, the script only watches
npm run check      # verify the page/selectors only - never submits anything
```

`npm run check` is the safe way to test after any site change. It fills the form,
saves a screenshot, and stops before clicking.

### Manual mode

`npm run manual` is for when you want to drive it yourself. The script opens the
page and then only observes - it never types or clicks anything:

1. It loads the page and prints the form markup, every visible control, which of
   the site's five panels is showing, and the site's device id.
2. It waits for you to **paste the link into the Chrome window**, then asks you to
   press Enter in the terminal.
3. It reads the box back and tells you what is really in there:
   `MATCH`, `DIFFERENT` (prints both values), `EMPTY`, or `NO MATCH` for the selector.
4. It waits for **you to click Get Now**, then reports the countdown, the view
   quantity, the final outcome and the exact success text.

Nothing is submitted unless you click the button yourself, so it costs no quota
if you stop before that.

## Options

Every default can be overridden on the command line:

| Flag | Default | What it does |
| --- | --- | --- |
| `--url=` | `https://zefame.com/en/free-instagram-views` | page to open |
| `--link=` | `https://www.instagram.com/reel/Ddwn0ZwzX6w/` | reel link to paste |
| `--cycles=` / `--sessions=` | unlimited | how many sessions to run |
| `--wait=` | `70000` | ms to wait after clicking before checking (70s) |
| `--cooldown=` | `360000` | ms between sessions (6 min) |
| `--grace=` | `45000` | extra ms to wait if 70s wasn't enough |
| `--success-text=` | `Success` | text to look for on the page |
| `--headless` | off | hide the Chrome window |
| `--no-screenshots` | on | skip saving screenshots |
| `--check` | off | verify only, never submit |
| `--manual` | off | you paste and click, the script only watches |

Examples:

```bash
node zefame.js --cycles=5
node zefame.js --link=https://www.instagram.com/reel/ABC123/
node zefame.js --cooldown=660000          # 11 min, if you hit the rate limit
```

## Output

- `shots/session-001-success-1756360000000.png` — one screenshot per session
- `logs/runs.jsonl` — one JSON line per session (`session`, `result`, `views`, `message`)

## Things worth knowing

**Use `--headless` at your own risk.** The site runs a Cloudflare Turnstile check
before it places the order. A visible Chrome window passes it far more often, so
the window is left open on purpose. If a Turnstile box ever appears, click it
yourself — the script waits for you and logs a nudge.

**Don't delete `.chrome-profile/`.** It keeps the Cloudflare clearance cookie, so
the invisible check stops appearing as often. Each session has its own
subdirectory in there, named after the session id, because two Chromium
processes cannot share one profile directory.

**About the site cooldown.** The site keeps a device id in `localStorage` and
tracks the 5-minute cooldown against it. Chrome discards that storage when the
profile closes, so the site mints a new device id on every launch - you can see
it change in the manual-mode output. That does not affect us: the 6-minute
cooldown is enforced by this script, not by the site, so runs never go faster
than the site intends. If you ever see `Please wait 3m 35s before using this
service again`, raise `--cooldown` rather than retrying sooner.

**Turnstile failures show up as a normal error page**, reported as
`error page: Turnstile verification failed`. That is the site rejecting the
check, not a broken selector.

**If the site redesigns**, run `npm run check`. It prints `OK`/`MISS` per
selector, so you can see which one moved and update `SELECTORS` in `zefame.js`.
