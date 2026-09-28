/**
 * Views automation - Zefame "Free Instagram Views".
 *
 * Runs in sessions on a fixed interval:
 *   session 1: open the page, paste the reel link, click "Get Now",
 *              wait 1 min 10 s, look for the success text, then the session ends
 *   6 minute gap
 *   session 2: same thing again
 *   ...repeats until Ctrl+C
 *
 * The Chrome window is opened once and reused for every session, so the site
 * sees one continuous user rather than a new browser every 6 minutes.
 *
 * Usage:
 *   node zefame.js                    # loop forever
 *   node zefame.js --sessions=3       # or --cycles=3
 *   node zefame.js --link=https://www.instagram.com/reel/XXXX/
 *   node zefame.js --manual           # you paste and click, it only watches
 *   node zefame.js --check            # verify selectors only, never submits
 *   node zefame.js --headless         # hide the Chrome window
 *   node zefame.js --target=views     # label this run, used by the dashboard
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ config */

const DEFAULTS = {
  // Can be overridden per run with --url= / --link=, or in the environment as
  // START_URL / REEL_URL (used by the Render deployment).
  startUrl: 'https://zefame.com/en/free-instagram-views',
  reelUrl: 'https://www.instagram.com/reel/Ddwn0ZwzX6w/',
  buttonText: 'Get Now',
  successText: 'Success',

  postClickWaitMs: 70_000, // 1 min 10 s - the site's own countdown is 60 s
  cooldownMs: 360_000, // 6 minutes between runs
  settleMs: 5_000, // render slack after the wait, before the grace period
  graceMs: 45_000, // extra patience if 70 s was not enough
  cycles: Infinity,

  headless: false,
  screenshots: true,
  check: false,
  manual: false,
};

const SELECTORS = {
  input: '#instagram-link.input-optin-link',
  button: 'button#submit-btn.btn-optin',
  loading: '#loading-page',
  timer: '#timer-page',
  success: '#success-page',
  error: '#error-page',
  errorMessage: '#error-message',
  quantity: '#timer-quantity-text',
  timerText: '#timeTimer',
};

/* ------------------------------------------------------------------- utils */

/** A headless Linux box has no DISPLAY and usually runs as root in a
 *  container, both of which change how the browser must be started. */
function detectEnvironment() {
  const noDisplay = process.platform === 'linux' && !process.env.DISPLAY;
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  return { noDisplay, asRoot, headlessDefault: noDisplay };
}

const ENV = detectEnvironment();

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const match = /^--([^=]+)(?:=([\s\S]*))?$/.exec(arg);
    if (match) out[match[1]] = match[2] === undefined ? true : match[2];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const bool = (value, fallback) =>
  value === undefined ? fallback : !(value === 'false' || value === '0' || value === 'no');
const num = (value, fallback) => {
  if (value === undefined || value === true) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** HEADLESS=1 / HEADLESS=0 in the environment overrides the guess, so a
 *  container's config and the script can never disagree. */
function headlessFromEnv(fallback) {
  const value = process.env.HEADLESS;
  if (value === undefined || value === '') return fallback;
  return !(value === '0' || value.toLowerCase() === 'false' || value.toLowerCase() === 'no');
}

const CONFIG = {
  startUrl: String(args.url ?? process.env.START_URL ?? DEFAULTS.startUrl),
  reelUrl: String(args.link ?? process.env.REEL_URL ?? DEFAULTS.reelUrl),
  buttonText: String(args['button-text'] ?? DEFAULTS.buttonText),
  successText: String(args['success-text'] ?? DEFAULTS.successText),
  postClickWaitMs: num(args.wait, DEFAULTS.postClickWaitMs),
  cooldownMs: num(args.cooldown, DEFAULTS.cooldownMs),
  graceMs: num(args.grace, DEFAULTS.graceMs),
  cycles: num(args.cycles ?? args.sessions, DEFAULTS.cycles),
  headless: bool(args.headless, headlessFromEnv(ENV.headlessDefault)),
  screenshots: bool(args.screenshots, DEFAULTS.screenshots),
  check: bool(args.check, DEFAULTS.check),
  manual: bool(args.manual, DEFAULTS.manual),
};

const SHOTS_DIR = path.join(ROOT, 'shots');
const LOGS_DIR = path.join(ROOT, 'logs');
const PROFILE_DIR = path.join(ROOT, '.chrome-profile');

/** Optional label for which workflow this process is running.
 *
 *  The dashboard runs one process per workflow and passes --target=<id>, so
 *  their status files and log lines can be told apart. Left unset - the plain
 *  command line case - behaviour is exactly as it was before: logs/status.json,
 *  unprefixed log lines, and no "target" field in the history.
 */
const TARGET = args.target ? String(args.target) : '';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = () => new Date().toLocaleString('en-GB');

function log(message) {
  console.log(`[${stamp()}]${TARGET ? ` [${TARGET}]` : ''} ${message}`);
}

/** Sleep that gives up as soon as a stop is requested, so Ctrl+C (or systemd
 *  stopping the unit) does not have to wait out a 6 minute idle. */
async function interruptibleSleep(ms) {
  const deadline = Date.now() + ms;
  while (!stopping && Date.now() < deadline) {
    await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
  }
}

/** Sleep, but print a countdown line so the console does not look frozen. */
async function sleepWithCountdown(ms, label) {
  if (ms <= 0) return;
  const totalSeconds = Math.round(ms / 1000);
  log(`${label} ${formatDuration(ms)} (${totalSeconds}s)`);
  const stepMs = Math.min(30_000, ms);
  let remaining = ms;
  while (remaining > 0 && !stopping) {
    const chunk = Math.min(stepMs, remaining);
    await interruptibleSleep(chunk);
    remaining -= chunk;
    if (remaining > 0) log(`  ...${formatDuration(remaining)} left`);
  }
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function ensureDirs() {
  for (const dir of [SHOTS_DIR, LOGS_DIR]) fs.mkdirSync(dir, { recursive: true });
}

function recordRun(entry) {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    ...(TARGET ? { target: TARGET } : {}),
    ...entry,
  });
  fs.appendFileSync(path.join(LOGS_DIR, 'runs.jsonl'), line + '\n');
}

/** A small status file so the run can be checked from outside the process
 *  (there is no console to watch on a server). One file per workflow when
 *  --target is used, so the dashboard can read each one independently. */
function writeStatus(patch) {
  const file = path.join(LOGS_DIR, TARGET ? `status-${TARGET}.json` : 'status.json');
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // First run, or the file is unreadable.
  }
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
}

async function screenshot(page, name) {
  if (!CONFIG.screenshots) return;
  const file = path.join(SHOTS_DIR, `${TARGET ? `${TARGET}-` : ''}${name}.png`);
  try {
    await page.screenshot({ path: file, fullPage: false });
    log(`  screenshot: ${path.relative(ROOT, file)}`);
  } catch (error) {
    log(`  screenshot failed: ${error.message}`);
  }
}

/* ----------------------------------------------------------------- browser */

let stopping = false;
process.on('SIGINT', () => {
  if (stopping) process.exit(1);
  stopping = true;
  log('Stop requested (Ctrl+C again to quit immediately). Current step will finish.');
});
process.on('SIGTERM', () => {
  stopping = true;
});

async function launch() {
  ensureDirs();

  const args = ['--disable-blink-features=AutomationControlled'];
  if (!CONFIG.headless) args.push('--start-maximized');
  if (ENV.asRoot) {
    // Chrome's sandbox cannot start as root; this is the documented workaround.
    args.push('--no-sandbox', '--disable-setuid-sandbox');
  }
  // Containers often have a tiny /dev/shm, which makes Chrome crash on render.
  args.push('--disable-dev-shm-usage');

  const options = { headless: CONFIG.headless, viewport: null, args };

  log(
    `Launching browser (headless=${CONFIG.headless}` +
      `${ENV.asRoot ? ', running as root so --no-sandbox is set' : ''})...`,
  );

  // Prefer a real Chrome if one is installed, else Playwright's Chromium.
  const channels = ['chrome', 'chromium'];
  let lastError;
  for (const channel of channels) {
    try {
      return await chromium.launchPersistentContext(PROFILE_DIR, { ...options, channel });
    } catch (error) {
      lastError = error;
      log(`  ${channel} unavailable: ${error.message.split('\n')[0]}`);
    }
  }

  log('  falling back to the default bundled browser...');
  try {
    return await chromium.launchPersistentContext(PROFILE_DIR, options);
  } catch (error) {
    log(`Could not start a browser. On Linux run: npx playwright install --with-deps chromium`);
    throw lastError ?? error;
  }
}

/**
 * Chrome discards this site's localStorage when the profile closes (verified:
 * the deviceUUID never lands in .chrome-profile), so the site mints a new
 * device id on every launch. That is only a diagnostic - our own 6 minute
 * cooldown is what actually paces the runs, so we never go faster than the
 * site intends. We just report the id so it is visible.
 */
async function reportDeviceId(page) {
  try {
    const id = await page.evaluate(() => localStorage.getItem('deviceUUID'));
    log(`Site device id: ${id || '(not set yet)'}`);
  } catch {
    log('Site device id: could not be read');
  }
}

/** Print the form markup and every control on the page, so the selectors can
 *  be checked against what the server actually served. */
async function reportDom(page) {
  const form = await page
    .locator('#instagram-form')
    .evaluate((el) => el.outerHTML)
    .catch(() => '(no #instagram-form found)');

  log('');
  log('Form markup as served:');
  for (const line of form.split('\n')) log(`  ${line.trim()}`);

  const controls = await page
    .$$eval('input, textarea, select, button, a[href]', (els) =>
      els
        .filter((el) => el.offsetParent !== null || el.tagName === 'BUTTON')
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          cls: el.className || '',
          type: el.type || '',
          text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40),
          href: el.getAttribute('href') || '',
        })),
    )
    .catch(() => []);

  log('');
  log(`Visible controls (${controls.length}):`);
  for (const c of controls) {
    log(`  <${c.tag}${c.id ? ` id="${c.id}"` : ''}${c.cls ? ` class="${c.cls}"` : ''}>` +
        `${c.type ? ` type="${c.type}"` : ''}${c.text ? ` text="${c.text}"` : ''}`);
  }
}

/** Report which of the site's five panels is on screen. */
async function reportPageState(page) {
  const names = {
    [SELECTORS.loading]: 'loading (verifying the link)',
    [SELECTORS.timer]: 'timer (countdown running)',
    [SELECTORS.success]: 'success',
    [SELECTORS.error]: 'error',
  };
  const shown = [];
  for (const [selector, label] of Object.entries(names)) {
    if (await isVisible(page, selector)) shown.push(label);
  }
  return shown.length ? shown.join(', ') : 'main form';
}

/** The site keeps a device UUID + rate-limit state in localStorage, and the
 *  chat widget can sit on top of the form. */
async function preparePage(context) {
  await context.addInitScript(() => {
    // Light touch: the chat widget only needs to be gone by the time we click.
    const hideChat = () => {
      if (document.getElementById('automation-hide-chat') || !document.head) return;
      const style = document.createElement('style');
      style.id = 'automation-hide-chat';
      style.textContent =
        '#crisp-chat-box, .crisp-client, #chat-launcher, [id^="crisp"] { display: none !important; }';
      document.head.appendChild(style);
    };
    hideChat();
    document.addEventListener('DOMContentLoaded', hideChat);
    window.addEventListener('load', hideChat);
  });

  const page = context.pages()[0] ?? (await context.newPage());
  return page;
}

/** Every text box on the page and what is in it, so a paste that landed in the
 *  wrong place can be spotted instead of just reporting "empty". */
async function describeTextBoxes(page) {
  return page
    .$$eval('input, textarea', (els) =>
      els
        .filter((el) => {
          const type = (el.getAttribute('type') || 'text').toLowerCase();
          return !['hidden', 'checkbox', 'radio', 'submit', 'button'].includes(type);
        })
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          id: el.id || '(no id)',
          cls: el.className || '(no class)',
          visible: !!(el.offsetWidth || el.offsetHeight),
          value: el.value || '',
          placeholder: el.placeholder || '',
        })),
    )
    .catch(() => []);
}

/** Read the link back out of the box and say whether it is what we expected. */
async function verifyPastedValue(page) {
  const locator = page.locator(SELECTORS.input);
  const matches = await locator.count();

  if (matches === 0) {
    const boxes = await describeTextBoxes(page);
    return {
      verdict: 'NO MATCH',
      detail: `selector ${SELECTORS.input} matched nothing. Text boxes on the page:\n` +
        (boxes.length
          ? boxes.map((b) => `               <${b.tag} id="${b.id}" class="${b.cls}"> value="${b.value}"`)
              .join('\n')
          : '               (none found)'),
    };
  }

  if (matches > 1) {
    return {
      verdict: 'AMBIGUOUS',
      detail: `${matches} elements match ${SELECTORS.input} - the first one was read, ` +
        'but the selector is not unique',
    };
  }

  const raw = await locator.first().inputValue();
  const trimmed = raw.trim();

  if (!trimmed) {
    // The paste may have gone into a different box - say where.
    const boxes = await describeTextBoxes(page);
    const withText = boxes.filter((b) => b.value.trim());
    return {
      verdict: 'EMPTY',
      detail:
        'the target box matched but is empty - nothing was pasted there.\n' +
        (withText.length
          ? '             your text is actually in:\n' +
            withText
              .map((b) => `               <${b.tag} id="${b.id}" class="${b.cls}"> "${b.value.trim()}"`)
              .join('\n')
          : '             no text box on the page has any text in it'),
    };
  }

  if (trimmed !== CONFIG.reelUrl) {
    return {
      verdict: 'DIFFERENT',
      detail:
        `box has "${trimmed}"\n             configured link is "${CONFIG.reelUrl}"\n` +
        '             (fine in manual mode - this is just what you pasted)',
    };
  }

  const looksLikeReel = /instagram\.com\/reel\//.test(trimmed);
  return {
    verdict: looksLikeReel ? 'MATCH' : 'MATCH but not a reel link',
    detail: `"${trimmed}" (${trimmed.length} chars)`,
  };
}

async function isVisible(page, selector) {
  const locator = page.locator(selector);
  return (await locator.count()) > 0 && (await locator.first().isVisible().catch(() => false));
}

async function textOf(page, selector) {
  const locator = page.locator(selector);
  if ((await locator.count()) === 0) return '';
  return (await locator.first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ session */

/** Load the page fresh and put the reel link in the box. */
async function openForm(page) {
  log(`Opening ${CONFIG.startUrl}`);
  await page.goto(CONFIG.startUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  await page.waitForSelector(SELECTORS.input, { state: 'visible', timeout: 30_000 });
  await page.waitForSelector(SELECTORS.button, { state: 'visible', timeout: 30_000 });

  // Dismiss the custom error popup if a previous invalid link left one open.
  await page
    .locator('#customErrorOverlay, .custom-error-overlay')
    .first()
    .evaluate((el) => el.remove())
    .catch(() => {});

  await page.fill(SELECTORS.input, '');
  await page.locator(SELECTORS.input).click();
  await page.locator(SELECTORS.input).fill(CONFIG.reelUrl);

  const typed = await page.inputValue(SELECTORS.input);
  if (typed.trim() !== CONFIG.reelUrl) {
    throw new Error(`Link did not land in the input (got "${typed}")`);
  }
  log(`Pasted link: ${typed}`);
  return typed;
}

async function clickGetNow(page) {
  const button = page.locator(SELECTORS.button).first();
  await button.waitFor({ state: 'visible', timeout: 15_000 });
  await button.scrollIntoViewIfNeeded();

  const label = (await button.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  log(`Clicking button: "${label || CONFIG.buttonText}"`);

  try {
    await button.click({ timeout: 10_000 });
  } catch (error) {
    // Something is overlapping the button (usually the chat bubble).
    log(`  normal click failed (${error.message.split('\n')[0]}) - forcing it.`);
    await button.click({ force: true, timeout: 10_000 });
  }
}

/**
 * Watch the page in the background during the 70 s wait so the console shows
 * what the site is doing instead of going quiet. Mutates and returns `state`;
 * the caller sets `state.stopped` when the session is over.
 */
function startWatcher(page) {
  const state = { views: '', error: '', timerSeen: false, cloudflare: false, stopped: false };

  (async () => {
    while (!state.stopped) {
      try {
        if (!state.timerSeen && (await isVisible(page, SELECTORS.timer))) {
          state.timerSeen = true;
          state.views = await textOf(page, SELECTORS.quantity);
          const clock = await textOf(page, SELECTORS.timerText);
          log(
            `  countdown running (${clock || 'timer'})${
              state.views ? ` - ${state.views} views` : ''
            }`,
          );
        }

        if (!state.error && (await isVisible(page, SELECTORS.error))) {
          state.error = await textOf(page, SELECTORS.errorMessage);
          log(`  site reported an error already: ${state.error || 'unknown'}`);
        }

        if (
          !state.cloudflare &&
          (await page.locator('iframe[src*="challenges.cloudflare.com"]').count()) > 0
        ) {
          state.cloudflare = true;
          log('  Cloudflare check present - if a box appears, click it in the Chrome window.');
        }
      } catch {
        // A navigation mid-session can throw here; the real check happens later.
      }
      await sleep(1000);
    }
  })();

  return state;
}

/**
 * Check the page after the full wait has already elapsed. `settleMs` only gives
 * the page a moment to finish rendering before we fall through to the grace
 * period - it is not another full wait.
 */
async function waitForOutcome(page, views) {
  const settleDeadline = Date.now() + DEFAULTS.settleMs;

  while (Date.now() < settleDeadline && !stopping) {
    if (await isVisible(page, SELECTORS.success)) return resolveSuccess(page, views);
    if (await isVisible(page, SELECTORS.error)) return resolveError(page, views);
    await sleep(1000);
  }

  log(`  no result after ${formatDuration(CONFIG.postClickWaitMs)}`);
  if (CONFIG.graceMs > 0) {
    log(`  giving it ${formatDuration(CONFIG.graceMs)} more...`);
    const graceDeadline = Date.now() + CONFIG.graceMs;
    while (Date.now() < graceDeadline && !stopping) {
      if (await isVisible(page, SELECTORS.success)) return resolveSuccess(page, views);
      if (await isVisible(page, SELECTORS.error)) return resolveError(page, views);
      await sleep(1000);
    }
  }
  return { result: 'timeout', message: 'No success or error page appeared', views };
}

async function resolveSuccess(page, views) {
  const body = await textOf(page, SELECTORS.success);
  const matched = body.toLowerCase().includes(CONFIG.successText.toLowerCase());
  const headline = body.split(CONFIG.successText)[0].trim().slice(-120) || body.slice(0, 120);

  return {
    result: 'success',
    matched,
    message: matched
      ? `success text "${CONFIG.successText}" found${headline ? ` (${headline})` : ''}`
      : `success page shown but "${CONFIG.successText}" was not in the text`,
    views,
  };
}

async function resolveError(page, views) {
  const message = (await textOf(page, SELECTORS.errorMessage)) || 'unknown error';
  const hint = /Please wait \d+m \d+s/i.test(message)
    ? ' - cooldown was too short, raise --cooldown'
    : '';

  return {
    result: 'error',
    matched: false,
    message: `error page: ${message}${hint}`,
    views,
  };
}

async function runCycle(page, session) {
  const label = String(session).padStart(3, '0');
  const startedAt = Date.now();
  log('');
  log(`########## SESSION ${session} ##########`);

  await openForm(page);

  if (CONFIG.check) {
    await screenshot(page, `check-session-${label}`);
    log('Check mode: form is filled, "Get Now" was NOT clicked.');
    return { result: 'check', matched: true, message: 'selectors verified, nothing submitted' };
  }

  await clickGetNow(page);

  // Watch the countdown while we sit out the full wait.
  const watcher = startWatcher(page);
  log(`Waiting ${formatDuration(CONFIG.postClickWaitMs)} before checking for the success text...`);
  await interruptibleSleep(CONFIG.postClickWaitMs);
  if (stopping) return { result: 'stopped', message: 'stop requested during the wait', views: '' };

  const outcome = await waitForOutcome(page, watcher.views);
  watcher.stopped = true;
  await screenshot(page, `session-${label}-${outcome.result}-${Date.now()}`);

  log(`  SESSION ${session} ENDED after ${formatDuration(Date.now() - startedAt)} - ${outcome.result}`);
  return outcome;
}

/* ------------------------------------------------------------------ manual */

/**
 * Hand-driven mode. The script opens the page and then only *observes*:
 * you paste the link and click the button yourself, and it reports what the
 * page actually contains at every step. Nothing is typed or clicked for you,
 * so this uses no quota unless you click Get Now.
 */
async function runManual(page) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question) => new Promise((resolve) => rl.question(question, resolve));

  try {
    log('MANUAL MODE - the script will not type or click anything.');
    log('');
    log(`Opening ${CONFIG.startUrl}`);
    await page.goto(CONFIG.startUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    const title = await page.title();
    const input = page.locator(SELECTORS.input);
    const button = page.locator(SELECTORS.button);

    log('');
    log('--- page loaded ---');
    log(`  title      : ${title}`);
    log(`  url        : ${page.url()}`);
    log(`  page shows : ${await reportPageState(page)}`);
    log(`  input      : ${(await input.count()) ? 'FOUND' : 'MISSING'} (${SELECTORS.input})`);
    log(`  button     : ${(await button.count()) ? 'FOUND' : 'MISSING'} (${SELECTORS.button})`);
    if (await button.count()) {
      log(`  button text: "${(await button.first().innerText()).replace(/\s+/g, ' ').trim()}"`);
    }
    await reportDeviceId(page);
    await reportDom(page);

    log('');
    const first = await ask(
      '>>> Paste your reel link into the box in the Chrome window, then press Enter here. ',
    );
    if (first.trim()) {
      log(`  (ignoring "${first.trim()}" - type in the browser, not here)`);
    }

    const check = await verifyPastedValue(page);
    log('');
    log('--- what is actually in the box ---');
    log(`  ${check.verdict}: ${check.detail}`);
    log(`  page shows : ${await reportPageState(page)}`);
    await screenshot(page, `manual-pasted-${Date.now()}`);

    log('');
    const second = await ask(
      '>>> Click "Get Now" in the Chrome window yourself, then press Enter here. ' +
        'Type "click" and press Enter to let the script click it instead. ',
    );

    if (second.trim().toLowerCase() === 'click') {
      await clickGetNow(page);
    } else {
      log('Waiting for you to click...');
    }

    // Readline redraws its prompt over any log line written after this point,
    // which garbles timestamps during the long watch. Close it first.
    rl.close();

    const outcome = await watchManually(page);
    await screenshot(page, `manual-result-${outcome.result}-${Date.now()}`);

    log('');
    log('--- result ---');
    log(`  outcome    : ${outcome.result}`);
    log(`  views      : ${outcome.views || '(not reported)'}`);
    log(`  detail     : ${outcome.message}`);
    log(`  page shows : ${await reportPageState(page)}`);
    return outcome;
  } finally {
    if (!rl.closed) rl.close();
  }
}

/** Watch the page after the click, logging each change of state. */
async function watchManually(page) {
  let views = '';
  let last = '';

  for (let i = 0; i < 400; i++) {
    const state = await reportPageState(page);

    if (state !== last) {
      log(`  [${formatDuration(i * 1000)}] page shows: ${state}`);
      last = state;
    }

    if (state === 'success') {
      const body = await textOf(page, SELECTORS.success);
      const matched = body.toLowerCase().includes(CONFIG.successText.toLowerCase());
      return {
        result: 'success',
        views,
        message: matched
          ? `success text "${CONFIG.successText}" found - ${body.slice(0, 160)}`
          : `success page shown, but "${CONFIG.successText}" was not in the text - ${body.slice(0, 160)}`,
      };
    }

    if (state === 'error') {
      return {
        result: 'error',
        views,
        message: (await textOf(page, SELECTORS.errorMessage)) || 'unknown error',
      };
    }

    if (state.startsWith('timer') && !views) {
      views = await textOf(page, SELECTORS.quantity);
      const clock = await textOf(page, SELECTORS.timerText);
      log(`  countdown: ${clock || 'running'}${views ? ` - ${views} views` : ''}`);
    }

    await sleep(1000);
  }

  return { result: 'timeout', views, message: 'nothing happened for over 6 minutes' };
}

/* --------------------------------------------------------------------- main */

async function runCheck(page) {
  log('Check mode: no order will be placed.');
  await openForm(page);
  for (const [name, selector] of Object.entries(SELECTORS)) {
    const found = (await page.locator(selector).count()) > 0;
    log(`  ${found ? 'OK  ' : 'MISS'} ${name} (${selector})`);
  }
  await screenshot(page, 'check');
  log('Check finished.');
}

async function main() {
  log('VIEWS AUTOMATION');
  log(`  start URL   : ${CONFIG.startUrl}`);
  log(`  reel link   : ${CONFIG.reelUrl}`);
  log(`  success text: "${CONFIG.successText}"`);
  log(`  per session : click + wait ${formatDuration(CONFIG.postClickWaitMs)}`);
  log(`  interval    : ${formatDuration(CONFIG.cooldownMs)} between sessions`);
  log(`  sessions    : ${CONFIG.cycles === Infinity ? 'unlimited (Ctrl+C to stop)' : CONFIG.cycles}`);
  if (CONFIG.manual) {
    log('MANUAL MODE: you paste and click, the script only watches and reports.');
  }
  if (!CONFIG.headless) {
    log('The Chrome window stays open on purpose - you can watch it and click any Cloudflare box yourself.');
  }
  log('');
  log('Flow: session 1 runs and ends, 6 minute gap, session 2 runs and ends, and so on.');
  log(`Platform   : ${process.platform} (headless default: ${ENV.headlessDefault})`);

  let context = null;
  let page = null;

  /** Nobody is watching a server, so a dead browser has to recover itself. */
  async function ensureBrowser() {
    if (context && page && !page.isClosed()) return page;
    if (context) {
      log('  browser is gone - starting a new one');
      await context.close().catch(() => {});
      context = null;
    }
    context = await launch();
    page = await preparePage(context);
    return page;
  }

  try {
    if (CONFIG.manual) {
      const manualPage = await ensureBrowser();
      const outcome = await runManual(manualPage);
      recordRun({ session: 0, manual: true, ...outcome });
      writeStatus({ state: 'manual-finished', ...outcome });
      return;
    }

    if (CONFIG.check) {
      const checkPage = await ensureBrowser();
      await runCheck(checkPage);
      writeStatus({ state: 'check-finished' });
      return;
    }

    let session = 0;
    let failures = 0;
    writeStatus({ state: 'running', headless: CONFIG.headless, platform: process.platform });

    while (!stopping && session < CONFIG.cycles) {
      session += 1;
      let outcome;

      // One retry, because a dead browser is recoverable and a real failure
      // is not - without this a single crash would end a long unattended run.
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const activePage = await ensureBrowser();
          outcome = await runCycle(activePage, session);
          break;
        } catch (error) {
          const recoverable =
            error.message.includes('Target closed') ||
            error.message.includes('has been closed') ||
            error.message.includes('browser has disconnected') ||
            error.message.includes('Protocol error') ||
            error.message.includes('Connection closed');

          if (recoverable && attempt === 1) {
            log(`  SESSION ${session}: ${error.message.split('\n')[0]}`);
            log(`  recovering and retrying once...`);
            if (context) await context.close().catch(() => {});
            context = null;
            page = null;
            continue;
          }

          outcome = { result: 'crash', matched: false, message: error.message.split('\n')[0] };
          log(`  SESSION ${session} FAILED: ${outcome.message}`);
          break;
        }
      }

      if (outcome.result === 'success' && outcome.matched) {
        log(`  RESULT: success - ${outcome.message}`);
      } else if (outcome.result === 'success') {
        failures += 1;
        log(`  RESULT: partial - ${outcome.message}`);
      } else {
        failures += 1;
        log(`  RESULT: ${outcome.result} - ${outcome.message}`);
      }

      recordRun({ session, ...outcome });
      writeStatus({
        state: 'running',
        lastSession: session,
        lastResult: outcome.result,
        lastMessage: outcome.message,
        lastViews: outcome.views || null,
        sessionsRun: session,
        failures,
        nextSessionAt: new Date(Date.now() + CONFIG.cooldownMs).toISOString(),
      });

      const finished = session >= CONFIG.cycles;
      if (finished || stopping) break;
      if (CONFIG.cooldownMs > 0) {
        await sleepWithCountdown(CONFIG.cooldownMs, 'Idle, next session in');
      }
    }

    log('');
    log(`ALL DONE. ${session - failures}/${session} sessions confirmed the success text.`);
    log(`History: ${path.relative(ROOT, path.join(LOGS_DIR, 'runs.jsonl'))}`);
    // Drop the promised next-session time, since there isn't one.
    writeStatus({ state: 'finished', sessionsRun: session, failures, nextSessionAt: null });
  } finally {
    if (context) await context.close().catch(() => {});
    // No process.exit() here. Windows keeps the persistent profile's handles
    // alive and the process would hang, but exiting from finally would kill it
    // before the error handler below could report a fatal error. The exit
    // happens in the .then/.catch below instead.
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error) => {
    log(`Fatal: ${error.stack || error.message}`);
    process.exit(1);
  },
);
