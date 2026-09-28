/**
 * Dashboard and supervisor for the Zefame workflows.
 *
 * This does not reimplement any of the browser work. It runs zefame.js as one
 * child process per workflow and supervises it: start, stop, restart on crash,
 * and collect what each child writes to disk. That way the session logic that
 * already works stays untouched, and a browser that dies in one workflow cannot
 * take the other one down with it.
 *
 * Usage:
 *   node server.js                 # dashboard + supervisor
 *   node server.js --check         # validate config.json and exit
 *
 * Environment:
 *   PORT              listen port, default 3000 (Render sets this)
 *   DASHBOARD_TOKEN   the password. Required in production.
 *   CONFIG_PATH       where config.json lives, default alongside this file.
 *                     Point it at a mounted disk so dashboard edits survive
 *                     a redeploy.
 *   HEADLESS          passed through to the children
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(ROOT, 'zefame.js');
const CONFIG_FILE = process.env.CONFIG_PATH
  ? path.resolve(process.env.CONFIG_PATH)
  : path.join(ROOT, 'config.json');
/** Shipped defaults, copied into place on first boot. Keeping these separate
 *  is what stops a redeploy from wiping settings changed from the dashboard. */
const DEFAULT_CONFIG_FILE = path.join(ROOT, 'config.default.json');
const LOGS_DIR = path.join(ROOT, 'logs');
const PID_FILE = path.join(LOGS_DIR, 'supervisor.json');
const HTML_FILE = path.join(ROOT, 'public', 'index.html');

/** Log files are rewritten past this size, otherwise a workflow left running
 *  for a week fills the disk and takes the web service down with it. */
const MAX_LOG_BYTES = 2 * 1024 * 1024;
/** A crash loop must not burn the instance. */
const MAX_RESTARTS = 10;
const RESTART_WINDOW_MS = 60 * 60 * 1000;
const RESTART_DELAY_MS = 30_000;
/** Ctrl+C stops the child's sleeps promptly, but not instantly - the current
 *  step finishes. If it has not gone in this long, take it out. */
const STOP_GRACE_MS = 20_000;

const stamp = () => new Date().toLocaleString('en-GB');
const log = (message) => console.log(`[${stamp()}] [server] ${message}`);

/* ------------------------------------------------------------------ config */

const TARGET_FIELDS = {
  name: (v) => (typeof v === 'string' ? v.slice(0, 80) : undefined),
  enabled: (v) => (typeof v === 'boolean' ? v : undefined),
  autoStart: (v) => (typeof v === 'boolean' ? v : undefined),
  startUrl: (v) => validUrl(v),
  reelUrl: (v) => validUrl(v),
  cooldownSeconds: (v) => clampInt(v, 0, 86_400),
  waitSeconds: (v) => clampInt(v, 0, 3_600),
  timesMax: (v) => clampInt(v, 0, 1_000_000),
  headless: (v) => (typeof v === 'boolean' ? v : undefined),
  note: (v) => (typeof v === 'string' ? v.slice(0, 400) : undefined),
};

function validUrl(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!/^https:\/\//i.test(trimmed)) {
    throw new Error(`must be an https URL, got: ${trimmed.slice(0, 80)}`);
  }
  return trimmed.slice(0, 2000);
}

function clampInt(value, min, max) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`not a number: ${value}`);
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

/** What we know about each Zefame page, read from the site's own config
 *  endpoint. Keyed by URL, not by target id, because ids are now created at
 *  runtime by whoever is using the dashboard. Used for the default interval of
 *  a new session and for a warning if someone sets less than the site allows. */
const SERVICE_PROFILES = {
  'https://zefame.com/en/free-instagram-views': {
    label: 'Instagram views',
    cooldownSeconds: 300,
    quantity: 300,
    unit: 'views',
  },
  'https://zefame.com/en/free-instagram-likes': {
    label: 'Instagram likes',
    cooldownSeconds: 1800,
    quantity: 10,
    unit: 'likes',
  },
};
const siteCooldownFor = (url) => SERVICE_PROFILES[url]?.cooldownSeconds ?? 0;

/** Every setting the child process reads once, at startup, and therefore
 *  cannot pick up without a restart. If this list and buildArgs() ever disagree,
 *  the dashboard will claim a change took effect when it did not - so keep them
 *  together. */
const RESTART_KEYS = [
  'startUrl',
  'reelUrl',
  'cooldownSeconds',
  'waitSeconds',
  'timesMax',
  'headless',
];

function loadConfig() {
  seedConfig();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${path.basename(CONFIG_FILE)}: ${error.message}`);
  }
  if (!Array.isArray(parsed.targets) || parsed.targets.length === 0) {
    throw new Error('config.json needs a non-empty "targets" array');
  }
  const seen = new Set();
  for (const target of parsed.targets) {
    if (!target.id) throw new Error('every target needs an "id"');
    if (!/^[a-z0-9_-]{1,32}$/i.test(target.id)) {
      throw new Error(`target id "${target.id}" must be letters, digits, - or _`);
    }
    if (seen.has(target.id)) throw new Error(`duplicate target id "${target.id}"`);
    seen.add(target.id);
    validUrl(target.startUrl);
    validUrl(target.reelUrl);
  }
  return parsed;
}

/** Write via a temp file and rename, so a crash mid-write cannot leave the
 *  dashboard with an unparseable config on the next boot. */
function saveConfig(config) {
  const temp = `${CONFIG_FILE}.tmp`;
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(temp, JSON.stringify(config, null, 2));
  fs.renameSync(temp, CONFIG_FILE);
}

/** First boot: copy the shipped defaults into place, and never overwrite an
 *  existing file. */
function seedConfig() {
  if (fs.existsSync(CONFIG_FILE)) return;
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.copyFileSync(DEFAULT_CONFIG_FILE, CONFIG_FILE);
    log(`seeded ${path.relative(ROOT, CONFIG_FILE) || CONFIG_FILE} from defaults`);
  } catch (error) {
    // No defaults file is fine - the real config may already be correct.
    log(`no defaults to seed from: ${error.message}`);
  }
}

/* -------------------------------------------------------------- supervisor */

/** id -> { child, pid, startedAt, stopRequested, restarts, once } */
const running = new Map();

/** Crash timestamps per id, kept outside `running` on purpose. A restart
 *  replaces the entry in `running`, so history kept there would be thrown away
 *  exactly when it is needed - the restart cap would never trip. */
const restartHistory = new Map();

const recentRestarts = (id) =>
  (restartHistory.get(id) ?? []).filter(
    (at) => Date.now() - new Date(at).getTime() < RESTART_WINDOW_MS,
  );

function logFileFor(id) {
  return path.join(LOGS_DIR, `${id}.log`);
}

function appendLog(id, chunk) {
  const file = logFileFor(id);
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) {
      fs.writeFileSync(file, '');
    }
    fs.appendFileSync(file, chunk);
  } catch (error) {
    log(`could not write ${id}.log: ${error.message}`);
  }
}

function buildArgs(target, { once = false } = {}) {
  const args = [
    SCRIPT,
    `--target=${target.id}`,
    `--url=${target.startUrl}`,
    `--link=${target.reelUrl}`,
    `--cooldown=${Math.round(target.cooldownSeconds) * 1000}`,
    `--wait=${Math.round(target.waitSeconds) * 1000}`,
    `--headless=${target.headless !== false}`,
  ];
  // timesMax 0 means "until stopped", which is the script's own default, so
  // only pass a limit when there is one.
  if (once) args.push('--sessions=1');
  else if (target.timesMax > 0) args.push(`--sessions=${target.timesMax}`);
  return args;
}

function startTarget(target, options = {}) {
  const existing = running.get(target.id);
  if (existing && !existing.child.killed) {
    return { ok: false, error: 'already running' };
  }

  const args = buildArgs(target, options);
  log(`${target.id}: starting ${args.slice(1).join(' ')}`);

  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, HEADLESS: target.headless === false ? '0' : '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const entry = {
    child,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    /** Set by stopTarget, so a deliberate stop is not mistaken for a crash. */
    stopRequested: false,
    restarts: recentRestarts(target.id),
    once: Boolean(options.once),
  };
  running.set(target.id, entry);
  writePidFile();

  const forward = (stream) => {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => appendLog(target.id, chunk));
  };
  forward(child.stdout);
  forward(child.stderr);

  child.on('exit', (code, signal) => {
    const stillCurrent = running.get(target.id) === entry;
    log(`${target.id}: exited (${signal ? `signal ${signal}` : `code ${code}`})`);
    if (stillCurrent) {
      running.delete(target.id);
      writePidFile();
    }

    if (options.once) return;

    // A stop the operator asked for must stay stopped. Without this check the
    // Stop button would be undone by the crash recovery 30 seconds later.
    if (entry.stopRequested) {
      log(`${target.id}: stopped on request, not restarting`);
      return;
    }

    // Exiting 0 is the script saying it finished its work, not crashing. This
    // matters most for timesMax: the child exits cleanly after its last
    // session, and treating that as a crash would start another whole batch
    // immediately, so "run it 10 times" would silently loop forever.
    if (code === 0) {
      log(`${target.id}: finished cleanly, not restarting`);
      return;
    }

    const history = [...recentRestarts(target.id), new Date().toISOString()];
    restartHistory.set(target.id, history);
    if (history.length > MAX_RESTARTS) {
      log(`${target.id}: crashed ${history.length} times in an hour, giving up`);
      return;
    }
    if (!target.enabled) return;

    log(`${target.id}: restarting in ${RESTART_DELAY_MS / 1000}s`);
    setTimeout(() => {
      // Started again by hand while we waited, so leave it alone.
      if (running.has(target.id)) return;
      const fresh = findTarget(target.id);
      if (fresh) startTarget(fresh);
    }, RESTART_DELAY_MS).unref();
  });

  child.on('error', (error) => log(`${target.id}: failed to spawn: ${error.message}`));
  return { ok: true, pid: child.pid };
}

function stopTarget(id) {
  const entry = running.get(id);
  if (!entry || entry.child.killed) return { ok: false, error: 'not running' };

  // SIGINT, not SIGKILL: the script's sleeps are interruptible, so this ends
  // the current step and exits instead of leaving a browser behind.
  entry.stopRequested = true;
  entry.child.kill('SIGINT');
  const entryRef = entry;
  setTimeout(() => {
    if (running.get(id) === entryRef && !entryRef.child.killed) {
      log(`${id}: did not stop in ${STOP_GRACE_MS / 1000}s, forcing`);
      entryRef.child.kill('SIGKILL');
    }
  }, STOP_GRACE_MS).unref();

  return { ok: true, pid: entry.pid };
}

function writePidFile() {
  const payload = {
    writtenAt: new Date().toISOString(),
    supervisorPid: process.pid,
    children: [...running.entries()].map(([id, entry]) => ({ target: id, pid: entry.pid })),
  };
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.writeFileSync(PID_FILE, JSON.stringify(payload, null, 2));
  } catch (error) {
    log(`could not write supervisor.json: ${error.message}`);
  }
}

/** If the server was restarted or redeployed, the previous run's browsers are
 *  still alive and still holding their profiles. Clean them up on boot.
 *
 *  Only kills a pid when /proc confirms it is one of our own zefame.js
 *  processes - a bare kill on a remembered pid risks hitting an unrelated
 *  process that happens to have reused the number. */
function reapOrphans() {
  let previous;
  try {
    previous = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
  } catch {
    return;
  }
  for (const child of previous.children ?? []) {
    if (!child?.pid) continue;
    let alive = true;
    try {
      process.kill(child.pid, 0);
    } catch {
      alive = false;
    }
    if (!alive) continue;

    if (process.platform === 'linux') {
      let cmdline = '';
      try {
        cmdline = fs.readFileSync(`/proc/${child.pid}/cmdline`, 'utf8');
      } catch {
        continue; // gone between the check and the read
      }
      if (!cmdline.includes('zefame.js')) {
        log(`pid ${child.pid} was reused by something else, leaving it alone`);
        continue;
      }
    } else {
      // No /proc on Windows or macOS, so do not guess.
      log(`pid ${child.pid} may still be running, not killing it on this platform`);
      continue;
    }
    log(`reaping orphaned ${child.target} browser (pid ${child.pid})`);
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  try {
    fs.writeFileSync(PID_FILE, JSON.stringify({ children: [] }, null, 2));
  } catch {
    // Not important.
  }
}

/* -------------------------------------------------------------- log reading */

function readStatus(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(LOGS_DIR, `status-${id}.json`), 'utf8'));
  } catch {
    return null;
  }
}

/** Last `limit` entries for one workflow. runs.jsonl is shared by every
 *  workflow, so the target field is what separates them. */
function readRuns(id, limit = 50) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(LOGS_DIR, 'runs.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.target === id) out.push(entry);
    } catch {
      // A partial line from a process that was killed mid-write.
    }
  }
  return out.slice(-limit).reverse();
}

function tailLog(id, lines = 200) {
  let raw;
  try {
    raw = fs.readFileSync(logFileFor(id), 'utf8');
  } catch {
    return [];
  }
  return raw.split('\n').filter(Boolean).slice(-lines);
}

/* ------------------------------------------------------------------- auth */

/** The built-in dashboard password, so deploying needs no setup at all.
 *
 *  It is in the source, so treat it as public: anyone who can read the repo
 *  can log in and start browser sessions. DASHBOARD_TOKEN in the environment
 *  overrides it, which is how you change it without a code edit. */
const DEFAULT_TOKEN = 'preetb121106';
const TOKEN = process.env.DASHBOARD_TOKEN || DEFAULT_TOKEN;
const USING_DEFAULT_TOKEN = TOKEN === DEFAULT_TOKEN;

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** HTTP Basic, so the browser prompts for the password itself and no token ends
 *  up in history or in a referer header. Any username, token as the password.
 *  ?token= also works for curl. */
function authorised(req, url) {
  const header = req.headers.authorization ?? '';
  if (header.startsWith('Basic ')) {
    let decoded = '';
    try {
      decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    } catch {
      return false;
    }
    return safeEqual(decoded.slice(decoded.indexOf(':') + 1), TOKEN);
  }
  const query = url.searchParams.get('token');
  return query ? safeEqual(query, TOKEN) : false;
}

/* ---------------------------------------------------------------- routing */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 65_536) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error(`invalid JSON: ${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

function findTarget(id) {
  return config.targets.find((target) => target.id === id) ?? null;
}

let config = null;

/** Problems that only make sense across the whole list, so they cannot live on
 *  a single card. The big one is two sessions fighting over the same reel: the
 *  site refuses the same reel twice inside one service's window, so the second
 *  session's session is wasted every cycle. */
function globalNotices(targets) {
  const notices = [];

  const byReel = new Map();
  for (const target of targets) {
    if (!target.reelUrl) continue;
    const key = `${target.startUrl}::${target.reelUrl}`;
    if (!byReel.has(key)) byReel.set(key, []);
    byReel.get(key).push(target);
  }
  for (const group of byReel.values()) {
    if (group.length < 2) continue;
    const names = group.map((t) => t.name || t.id).join(', ');
    const cooldown = siteCooldownFor(group[0].startUrl);
    notices.push({
      level: 'warn',
      text:
        `${group.length} sessions are using the same reel on the same page (${names}). ` +
        `Zefame refuses the same reel twice inside its ` +
        `${Math.round(cooldown / 60) || 5} minute window, so only the first one can succeed. ` +
        'Give each session its own reel.',
    });
  }

  const running = targets.filter((t) => running.has(t.id)).length;
  if (running > 2) {
    notices.push({
      level: 'warn',
      text:
        `${running} sessions are running, and each one is its own Chromium process. ` +
        'A small Render instance will run out of memory well before this many. ' +
        'Watch for the service being OOM-killed.',
    });
  }

  return notices;
}

/** Turn a name into something usable as an id and as a filename. */
function slugify(name) {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return slug || 'session';
}

function uniqueId(base, taken) {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 500; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

function describeTarget(target) {
  const entry = running.get(target.id);
  const status = readStatus(target.id);
  const siteCooldown = siteCooldownFor(target.startUrl);
  const profile = SERVICE_PROFILES[target.startUrl] ?? null;
  const warnings = [];
  if (siteCooldown && target.cooldownSeconds < siteCooldown) {
    warnings.push(
      `cooldown ${Math.round(target.cooldownSeconds / 60)} min is under the site's own ` +
        `${Math.round(siteCooldown / 60)} min limit, so most sessions will come back ` +
        '"Please wait..." instead of succeeding',
    );
  }
  if (status?.nextSessionAt && new Date(status.nextSessionAt) < new Date()) {
    warnings.push('the next session was promised in the past and has not started yet');
  }

  return {
    ...target,
    siteCooldownSeconds: siteCooldown || null,
    knownService: profile?.label ?? null,
    quantityPerSession: profile?.quantity ?? null,
    unit: profile?.unit ?? null,
    running: Boolean(entry && !entry.child.killed),
    pid: entry?.pid ?? null,
    startedAt: entry?.startedAt ?? null,
    restarts: entry?.restarts.length ?? 0,
    status,
    recent: readRuns(target.id, 8),
    warnings,
  };
}

async function handle(req, res, url) {
  const route = url.pathname;

  // Unauthenticated on purpose - Render polls this, and it reveals nothing.
  if (route === '/healthz') return sendText(res, 200, 'ok');

  if (!authorised(req, url)) {
    if (route.startsWith('/api/')) {
      return sendJson(res, 401, { error: 'unauthorised' });
    }
    res.writeHead(401, {
      'www-authenticate': 'Basic realm="views automation", charset="UTF-8"',
      'content-type': 'text/plain; charset=utf-8',
    });
    return res.end('Password required.\n');
  }

  if (route === '/') {
    let html;
    try {
      html = fs.readFileSync(HTML_FILE);
    } catch {
      return sendText(res, 500, 'public/index.html is missing');
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    return res.end(html);
  }

  if (route === '/api/state') {
    const described = config.targets.map(describeTarget);
    return sendJson(res, 200, {
      now: new Date().toISOString(),
      authRequired: true,
      usingDefaultPassword: USING_DEFAULT_TOKEN,
      services: Object.entries(SERVICE_PROFILES).map(([url, profile]) => ({ url, ...profile })),
      notices: globalNotices(config.targets),
      targets: described,
    });
  }

  const firstId = () => config.targets[0]?.id ?? null;

  if (route === '/api/runs') {
    const id = url.searchParams.get('target') ?? firstId();
    if (!id) return sendJson(res, 200, { target: null, runs: [] });
    const limit = clampInt(url.searchParams.get('limit') ?? 50, 1, 500);
    return sendJson(res, 200, { target: id, runs: readRuns(id, limit) });
  }

  if (route === '/api/logs') {
    const id = url.searchParams.get('target') ?? firstId();
    if (!id) return sendJson(res, 200, { target: null, lines: [] });
    const lines = clampInt(url.searchParams.get('lines') ?? 200, 1, 2000);
    return sendJson(res, 200, { target: id, lines: tailLog(id, lines) });
  }

  if (route === '/api/targets') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'use POST' });
    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }

    const rawName = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
    const name = rawName || 'new session';
    const id = uniqueId(
      slugify(body.id ?? rawName),
      new Set(config.targets.map((t) => t.id)),
    );

    const built = {
      id,
      name,
      enabled: true,
      autoStart: true,
      startUrl: '',
      reelUrl: '',
      cooldownSeconds: 360,
      waitSeconds: 70,
      timesMax: 0,
      headless: true,
      note: '',
    };

    // Run the create through the same validators as an edit, so a bad value is
    // rejected the same way whichever door it came through.
    try {
      for (const [key, coerce] of Object.entries(TARGET_FIELDS)) {
        if (body[key] === undefined || body[key] === '') continue;
        const result = coerce(body[key]);
        if (result !== undefined) built[key] = result;
      }
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }

    if (!built.startUrl || !built.reelUrl) {
      return sendJson(res, 400, { error: 'a new session needs both a page URL and a reel link' });
    }

    // If no interval was given, use the page's own limit plus a minute, which
    // is the safe default for both services Zefame offers.
    if (body.cooldownSeconds === undefined) {
      const site = siteCooldownFor(built.startUrl);
      if (site) built.cooldownSeconds = site + 60;
    }

    config.targets.push(built);
    saveConfig(config);
    log(`${id}: created (${built.startUrl})`);

    // "start a new session" should start it, but allow creating one stopped.
    let started = false;
    if (body.startNow !== false && built.enabled) {
      const result = startTarget(built);
      started = result.ok;
      if (!result.ok) log(`${id}: created but not started: ${result.error}`);
    }

    return sendJson(res, 201, {
      target: describeTarget(built),
      started,
      message: started ? `${name} created and started` : `${name} created, stopped`,
    });
  }

  const targetMatch = route.match(/^\/api\/targets\/([a-z0-9_-]{1,32})(?:\/(\w+))?$/i);
  if (targetMatch) {
    const [, id, action] = targetMatch;
    const target = findTarget(id);
    if (!target) return sendJson(res, 404, { error: `no session "${id}"` });

    if (!action && req.method === 'DELETE') {
      // Stop first, then forget it. The child is told not to restart, and even
      // if it asked to, findTarget no longer resolves once the row is gone.
      const wasRunning = running.has(id);
      if (wasRunning) {
        stopTarget(id);
        log(`${id}: deleted, stopping it`);
      }
      config.targets = config.targets.filter((t) => t.id !== id);
      saveConfig(config);

      const purge = url.searchParams.get('purge') === '1';
      if (purge) {
        for (const file of [`status-${id}.json`, `${id}.log`]) {
          try {
            fs.unlinkSync(path.join(LOGS_DIR, file));
          } catch {
            // Already gone, which is fine.
          }
        }
        log(`${id}: log and status files removed`);
      }

      return sendJson(res, 200, { deleted: id, wasRunning, purged: purge });
    }

    if (!action) {
      if (req.method !== 'PUT') return sendJson(res, 405, { error: 'use PUT' });
      let patch;
      try {
        patch = await readBody(req);
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
      const applied = {};
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'id' || !(key in TARGET_FIELDS)) continue;
        const coerce = TARGET_FIELDS[key];
        try {
          const result = coerce(value);
          if (result !== undefined) {
            target[key] = result;
            applied[key] = result;
          }
        } catch (error) {
          return sendJson(res, 400, { error: `${key}: ${error.message}` });
        }
      }
      if (Object.keys(applied).length === 0) {
        return sendJson(res, 400, { error: 'nothing recognised to change' });
      }
      saveConfig(config);
      const restartNeeded = RESTART_KEYS.some((key) => key in applied);
      log(`${id}: config updated ${JSON.stringify(applied)}`);

      // Disabling something that is still running should stop it, otherwise
      // "enabled" only means "may be started" and the switch does nothing the
      // operator expects.
      if (applied.enabled === false && running.has(id)) {
        stopTarget(id);
        log(`${id}: disabled from the dashboard, stopping it`);
      }

      return sendJson(res, 200, {
        target: describeTarget(target),
        restartNeeded,
        message: restartNeeded
          ? 'saved. restart the workflow for this to take effect.'
          : 'saved.',
      });
    }

    if (req.method !== 'POST') return sendJson(res, 405, { error: 'use POST' });

    if (action === 'start') {
      if (!target.enabled) {
        return sendJson(res, 400, { error: 'this workflow is disabled' });
      }
      const result = startTarget(target);
      return sendJson(res, result.ok ? 200 : 409, result);
    }
    if (action === 'once') {
      const result = startTarget(target, { once: true });
      return sendJson(res, result.ok ? 200 : 409, result);
    }
    if (action === 'stop') {
      const result = stopTarget(id);
      return sendJson(res, result.ok ? 200 : 409, result);
    }
    return sendJson(res, 404, { error: `unknown action "${action}"` });
  }

  return sendText(res, 404, 'not found');
}

/* ------------------------------------------------------------------- boot */

const args = process.argv.slice(2);
if (args.includes('--check')) {
  try {
    const parsed = loadConfig();
    for (const target of parsed.targets) {
      const site = siteCooldownFor(target.startUrl);
      const flag = site && target.cooldownSeconds < site ? '  <-- under the site limit' : '';
      log(
        `${target.id}: ${target.startUrl} every ${Math.round(target.cooldownSeconds / 60)} min, ` +
          `wait ${target.waitSeconds}s${flag}`,
      );
    }
    log('config.json is valid');
    process.exit(0);
  } catch (error) {
    log(`config error: ${error.message}`);
    process.exit(1);
  }
}

fs.mkdirSync(LOGS_DIR, { recursive: true });

try {
  config = loadConfig();
} catch (error) {
  log(`config error: ${error.message}`);
  process.exit(1);
}

if (USING_DEFAULT_TOKEN) {
  log(`using the built-in dashboard password from the source.`);
  log('set DASHBOARD_TOKEN in the environment to override it.');
}

reapOrphans();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  handle(req, res, url).catch((error) => {
    log(`request failed: ${error.stack ?? error.message}`);
    if (!res.headersSent) sendJson(res, 500, { error: error.message });
  });
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, '0.0.0.0', () => {
  log(`dashboard on http://0.0.0.0:${port}`);
});

for (const target of config.targets) {
  if (target.enabled && target.autoStart) {
    const result = startTarget(target);
    if (result.ok) log(`${target.id}: auto-started (pid ${result.pid})`);
  }
}

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  const ids = [...running.keys()];
  log(`${signal} received, stopping ${ids.length} workflow(s)`);
  for (const id of ids) stopTarget(id);

  // Exit as soon as the children are actually gone rather than always waiting
  // out the full grace period, so a redeploy is not held up. The timeout is a
  // backstop for a child that ignores SIGINT: if it fires, exit anyway and let
  // the platform clean the process group up, because holding the deploy open
  // for 20s every time is worse than one stray browser.
  const backstop = setTimeout(() => {
    log('children did not stop in time, exiting anyway');
    process.exit(0);
  }, STOP_GRACE_MS);

  const poll = setInterval(() => {
    if (running.size > 0) return;
    clearInterval(poll);
    clearTimeout(backstop);
    server.close(() => process.exit(0));
  }, 250);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
