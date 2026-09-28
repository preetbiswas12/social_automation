/**
 * Instagram LIKES - Zefame "Free Instagram Likes".
 *
 * One file per service, so each can be run, watched and stopped on its own:
 *   node likes.js                 # loop: 10 likes, then a 31 min gap
 *   node likes.js --sessions=1    # one order, then exit
 *   node likes.js --check         # verify the form, never submits
 *   node likes.js --headless      # no window
 *   node likes.js --link=https://www.instagram.com/p/OTHER/
 *
 * The automation itself lives in zefame.js - this file only decides which page
 * and which reel. An explicit --url or --link still overrides these.
 *
 * Why 31 minutes, and why it is so much slower than views: the site gives only
 * 10 likes per order and enforces a 30 minute limit on one link. Six minutes -
 * the views interval - is not enough and would be refused, so this is 30 + 1.
 * That works out to roughly 20 likes an hour against about 3000 views an hour
 * for the views run, so run the two side by side on separate reels.
 */

import { run } from './zefame.js';

const LIKES = {
  startUrl: 'https://zefame.com/en/free-instagram-likes',
  reelUrl: 'https://www.instagram.com/p/Ddx6_sEE9qw/',
  cooldownMs: 1_860_000, // 31 minutes - the site's limit is 30
  postClickWaitMs: 70_000, // the site's own countdown is 60 s
};

run({ ...LIKES, ...overridesFromArgs() })
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error(`Fatal: ${error.stack || error.message}`);
    process.exit(1);
  });

/** Let an explicit --url= / --link= / --cooldown= beat the defaults above. */
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
