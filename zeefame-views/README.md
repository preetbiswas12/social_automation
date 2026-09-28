# zeefame views

The second workflow. Same code as the original **views automation**, aimed at a
different Zefame page: **free Instagram likes**, not views.

- **Session 1** opens the page, pastes the reel link, clicks **Get Now**, waits
  1 min 10 s, looks for the success text, then the session ends
- **31 minute gap**
- **Session 2** does the same
- Repeats until `Ctrl+C`

## The clock is much slower here

This is the thing to understand before running it. The two services are not
alike. From the site's own config endpoint
(`api.zefame.com/api_free.php?action=config`):

| Service | id | Per order | Cooldown |
| --- | --- | --- | --- |
| Instagram **Views** | 237 | 300 views | 5 min |
| Instagram **Likes** | 234 | **10 likes** | **30 min** |

So this workflow yields roughly **20 likes an hour** where the views workflow
yields roughly **3,000 views an hour** - about 150x less.

`cooldownMs` is set to 31 minutes rather than 30, and the 70 s in-session wait
sits inside that gap, so consecutive orders land 32 min 10 s apart. Running
this on the original 6 minute clock would give you one success followed by four
`Please wait 24m 0s before using this service again.` errors every half hour.

```bash
npm start          # loop forever
npm run once       # a single session
npm run manual     # you paste and click, the script only watches
npm run check      # verify selectors, never submits
```

## Selectors: checked against the live page

Unlike the original workflow, this page was verified by reading the real
markup, so the copy works unchanged. All nine resolve:

| Selector | Present |
| --- | --- |
| `#instagram-link.input-optin-link` | yes |
| `button#submit-btn.btn-optin` | yes |
| `#loading-page` | yes |
| `#timer-page` | yes |
| `#success-page` | yes |
| `#error-page` | yes |
| `#error-message` | yes |
| `#timer-quantity-text` | yes |
| `#timeTimer` | yes |

Other things confirmed identical to the views page:

- the countdown is 60 s, so `--wait 70000` is still right
- the success text is the same, `Success` followed by
  "You will get the service on your link in a few minutes."
- nothing is hardcoded for the views service - the quantity is read live from
  `#timer-quantity-text`, so it reports 10 here without a code change

Still worth running `npm run check` once before trusting it, since that is the
one thing a static read cannot prove.

## Two things that can stop it

**Maintenance.** The page carries an `IS_MAINTENANCE` flag. It is `false` right
now. If the site flips it on, the page disables both the input and the submit
button, so sessions fail at the fill step rather than quietly doing nothing.

**The 30 minute limit is enforced per device id, which the site mints fresh
per browser.** Our own 31 minute cooldown is what actually governs the pacing,
which is why the gap is set generously instead of exactly 30 minutes.

## Deploy to Render

`Dockerfile`, `.dockerignore` and `render.yaml` are here, same as the original.
Point a second Background Worker at this directory.

| Var | What it does |
| --- | --- |
| `REEL_URL` | the link to paste, changeable without a redeploy |
| `START_URL` | the page, changeable without a redeploy |
| `HEADLESS` | `1` forces headless, `0` forces a window |

Use a paid instance. Render's free tier suspends idle workers and caps at 750
hours a month, which a continuous loop will exhaust.

**Running both workers at once is fine in principle** - they hit different
services (234 and 237) so the per-service cooldowns are separate. But both
default to the same reel, and each service separately refuses the same reel
inside its own window, so give this one a different reel via `REEL_URL`.
