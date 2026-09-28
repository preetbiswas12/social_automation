/**
 * Instagram VIEWS - Zefame "Free Instagram Views".
 *
 * One file per service, so each can be run, watched and stopped on its own:
 *   node views.js                 # loop: 300 views, then a 6 min gap
 *   node views.js --sessions=1    # one order, then exit
 *   node views.js --check         # verify the form, never submits
 *   node views.js --headless      # no window
 *   node views.js --link=https://www.instagram.com/reel/OTHER/
 *
 * The automation itself lives in zefame.js - this file only decides which page
 * and which reel. An explicit --url or --link still overrides these, so you can
 * point a single run at a different reel without editing anything.
 *
 * Why 6 minutes: the site allows 300 views per 5 minutes on one link. Six is
 * that plus a minute of headroom, so the loop never trips its own limit.
 */

import { run } from './zefame.js';

const VIEWS = {
  startUrl: 'https://zefame.com/en/free-instagram-views',
  reelUrl: 'https://www.instagram.com/reel/Ddwn0ZwzX6w/',
  cooldownMs: 360_000, // 6 minutes
  postClickWaitMs: 70_000, // the site's own countdown is 60 s
  // Each service needs its own Chromium profile. Two processes cannot share one
  // - the second dies with "Failed to create a ProcessSingleton for your profile
  // directory" - so running views and likes at the same time needs this set.
  // It also gives each its own logs/status-<id>.json.
  target: 'views',
};

run({ ...VIEWS, ...overridesFromArgs() })
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error(`Fatal: ${error.stack || error.message}`);
    process.exit(1);
  });

/** Let an explicit --url= / --link= / --cooldown= beat the defaults above, so
 *  these are starting points rather than a straitjacket. */
function overridesFromArgs() {
  const out = {};
  for (const arg of process.argv.slice(2)) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (!match) continue;
    if (match[1] === 'url') out.startUrl = match[2];
    if (match[1] === 'link') out.reelUrl = match[2];
    if (match[1] === 'cooldown') out.cooldownMs = Number(match[2]) * 1000;
    if (match[1] === 'wait') out.postClickWaitMs = Number(match[2]) * 1000;
  }
  return out;
}
