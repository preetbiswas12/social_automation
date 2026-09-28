/**
 * Discord bot - posts every successful session to your channel and keeps a
 * running count you can ask for.
 *
 * Setup, once:
 *   1. https://discord.com/developers/applications -> New Application -> Bot
 *   2. Reset Token -> that is DISCORD_BOT_TOKEN
 *   3. Invite URL: https://discord.com/api/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot
 *      (needs "Read Message History" and "Send Messages" under Privileged Intents)
 *   4. Put the token and channel id in discord.config.json  (gitignored)
 *
 * Then:
 *   node discord-bot.js
 *
 * Commands in the channel:
 *   !count    how many sessions have succeeded, per service
 *   !status   the last result from each service
 *   !help     this list
 *
 * How it learns about a session: it reads logs/runs.jsonl, which the automation
 * already appends to after every run. It watches that file rather than being
 * called, so the bot and the automation can be started in any order and neither
 * has to know the other exists. Restarting the bot does not lose or double count
 * anything - it remembers how far through the file it has read.
 *
 * The token is only ever read from discord.config.json or the environment. It is
 * never written to a log or echoed back to the channel.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(ROOT, 'logs', 'discord-state.json');
const RUNS = path.join(ROOT, 'logs', 'runs.jsonl');
const CONFIG_FILE = path.join(ROOT, 'discord.config.json');

const API = 'https://discord.com/api/v10';
const POLL_MS = 15_000; // how often to look for new messages
const stamp = () => new Date().toLocaleString('en-GB');

function log(message) {
  console.log(`[${stamp()}] [discord] ${message}`);
}

/* ------------------------------------------------------------------ config */

/** The token comes from the config file or the environment, never from a
 *  command line, because a command line shows up in ps for every user on the
 *  machine. The environment is the better of the two when the box is shared. */
function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    // No file is fine - the environment alone can configure this.
  }

  const token = String(process.env.DISCORD_BOT_TOKEN ?? file.token ?? '').trim();
  const channelId = String(process.env.DISCORD_CHANNEL_ID ?? file.channelId ?? '').trim();
  const dataDir = String(file.dataDir ?? '').trim() || ROOT;

  if (!token || !channelId) {
    console.error(`
Discord is not configured. Create discord.config.json next to this file:

  {
    "token": "your bot token",
    "channelId": "the channel id"
  }

or set DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID in the environment.
The token is in Discord's developer portal under Bot -> Reset Token.
`);
    process.exit(1);
  }
  return { token, channelId, dataDir: path.resolve(ROOT, dataDir) };
}

const { token, channelId, dataDir } = loadConfig();
const RUNS_FILE = path.join(dataDir, 'runs.jsonl');
const STATE_FILE = path.join(dataDir, 'logs', 'discord-state.json');

/* ------------------------------------------------------------------- state */

/** Counts and how far through runs.jsonl we have read. Saved after every change
 *  so a restart neither re-posts old sessions nor skips new ones. */
const state = { counts: {}, totals: { ok: 0, failed: 0 }, lastRunAt: '', lastMessageId: '' };

try {
  Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
  log(`resuming: ${state.totals.ok} successes already counted`);
} catch {
  // First run. Everything starts at zero.
}

let saving = false;
function save() {
  if (saving) return; // a save is already queued behind this one
  saving = true;
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (error) {
    log(`could not save state: ${error.message}`);
  } finally {
    saving = false;
  }
}

/* --------------------------------------------------------------- discord api */

/** One request, with the errors Discord actually returns turned into something
 *  readable. A bad token fails here once rather than silently forever. */
async function api(method, endpoint, body) {
  const response = await fetch(`${API}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (response.status === 401) {
    log('the bot token was rejected. Check DISCORD_BOT_TOKEN.');
    process.exit(1);
  }
  if (!response.ok) {
    // 429 is Discord saying "you are going too fast", with a retry hint.
    if (response.status === 429) {
      const wait = Number(response.headers.get('retry-after') ?? 5);
      log(`rate limited, waiting ${wait}s`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      return api(method, endpoint, body);
    }
    throw new Error(`${method} ${endpoint} -> ${response.status} ${await response.text()}`);
  }
  return response.json().catch(() => null);
}

const post = (content) => api('POST', `/channels/${channelId}/messages`, { content });

/* --------------------------------------------------------- watch for results */

/** Read whatever has been appended to runs.jsonl since last time and post a
 *  message for each success. Reading by byte offset means a restart resumes
 *  exactly where it left off. */
function watchRuns() {
  let offset = 0;
  try {
    offset = fs.statSync(RUNS_FILE).size;
    log(`watching ${path.relative(ROOT, RUNS_FILE)} from byte ${offset}`);
  } catch {
    log(`no ${path.relative(ROOT, RUNS_FILE)} yet - it appears once a session finishes`);
  }

  return setInterval(() => {
    let size;
    try {
      size = fs.statSync(RUNS_FILE).size;
    } catch {
      return; // not created yet
    }
    // A truncated file means something rotated it; start over rather than
    // reading from a nonsense offset.
    if (size < offset) offset = 0;
    if (size === offset) return;

    let chunk;
    try {
      const fd = fs.openSync(RUNS_FILE, 'r');
      const buffer = Buffer.alloc(size - offset);
      fs.readSync(fd, buffer, 0, buffer.length, offset);
      fs.closeSync(fd);
      chunk = buffer.toString('utf8');
    } catch (error) {
      log(`could not read runs: ${error.message}`);
      return;
    }
    offset = size;

    // Only whole lines - the last one may still be being written.
    const lines = chunk.split('\n').filter(Boolean);
    for (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // a partial line; the next pass will catch up
      }
      report(entry);
    }
  }, 10_000);
}

/** Post one line per finished session and keep the counter. Failures are
 *  counted but not posted every time, because a broken loop would otherwise
 *  flood the channel - they still move the counter. */
function report(entry) {
  const name = entry.target || 'views';
  const ok = entry.result === 'success' && entry.matched !== false;

  state.counts[name] ??= { ok: 0, failed: 0 };
  state.counts[name][ok ? 'ok' : 'failed'] += 1;
  state.totals[ok ? 'ok' : 'failed'] += 1;
  state.lastRunAt = entry.at ?? new Date().toISOString();
  save();

  if (ok) {
    const total = state.totals.ok;
    const text = entry.message ? ` - ${entry.message.slice(0, 120)}` : '';
    post(`:white_check_mark: **${name}** session done${text}\nCounter: **${total}**`)
      .then(() => log(`posted a success for ${name} (counter ${total})`))
      .catch((error) => log(`could not post: ${error.message}`));
    log(`${name}: success, counter now ${total}`);
  } else {
    log(`${name}: ${entry.result}${entry.message ? ` - ${entry.message.slice(0, 80)}` : ''} (not posted)`);
  }
}

/* ----------------------------------------------------------------- commands */

const countLine = () => {
  const rows = Object.entries(state.counts).map(
    ([name, c]) => `**${name}**: ${c.ok} ok, ${c.failed} failed`,
  );
  return [
    ':bar_chart: **Session counter**',
    ...(rows.length ? rows : ['nothing recorded yet']),
    `**Total successful: ${state.totals.ok}**`,
  ].join('\n');
};

const statusLine = () => {
  const rows = Object.entries(state.counts).map(([name, c]) => `**${name}**: ${c.ok} ok, ${c.failed} failed`);
  return [
    ':satellite: **Status**',
    ...(rows.length ? rows : ['nothing recorded yet']),
    state.lastRunAt ? `Last session finished: ${state.lastRunAt}` : 'No session has finished yet',
  ].join('\n');
};

/** Read new messages and answer the ones we understand. Polling rather than a
 *  websocket keeps this to no dependencies, which matters on a shared box where
 *  installing packages is a nuisance. */
async function pollCommands() {
  const query = state.lastMessageId ? `?limit=20&after=${state.lastMessageId}` : '?limit=20';
  let messages;
  try {
    messages = await api('GET', `/channels/${channelId}/messages${query}`);
  } catch (error) {
    log(`could not read messages: ${error.message}`);
    return;
  }
  if (!Array.isArray(messages) || messages.length === 0) return;

  // Discord returns newest first, so walk backwards to keep the order sane.
  for (const message of [...messages].reverse()) {
    state.lastMessageId = message.id;
    if (message.author?.bot) continue; // never answer ourselves
    const text = String(message.content ?? '').trim().toLowerCase();
    if (!text.startsWith('!')) continue;

    const reply = {
      '!count': countLine,
      '!counter': countLine,
      '!status': statusLine,
      '!help': () =>
        [
          ':robot: **Commands**',
          '`!count` - session counter',
          '`!status` - last result',
          '`!help` - this list',
        ].join('\n'),
    }[text.split(/\s+/)[0]];

    if (!reply) continue;
    save(); // remember the message even if the reply fails
    try {
      await post(`${message.author?.username ?? 'you'}:\n${reply()}`);
      log(`answered ${text} in the channel`);
    } catch (error) {
      log(`could not reply: ${error.message}`);
    }
  }
}

/* --------------------------------------------------------------------- main */

const config = await loadConfig().catch(() => null); // already handled above
log('starting');
log(`posting to channel ${channelId}`);

await post(
  `:green_circle: **Zefame bot online**\nWatching \`${path.relative(ROOT, RUNS_FILE)}\`. ` +
    'Post every successful session, and count them. Try `!count`.',
);

watchRuns();

const first = await pollCommands();
setInterval(pollCommands, POLL_MS);
log(`polling for commands every ${POLL_MS / 1000}s`);

// Hold the process open, and exit tidily so a supervisor can restart it.
const shutdown = () => {
  log('stopping');
  save();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
