#!/usr/bin/env node
// Uniform 35-minute dispatcher for a Render Cron Job.
//
// Use this ONLY if you need perfectly uniform 35-minute spacing (relevant for
// likes, where a 25-minute gap would trip the site's 30-minute per-link
// limit). Standard cron cannot express 35 minutes, so this works around it:
//
//   - Schedule the cron job hourly:  0 * * * *
//   - Start command:                 node ping-uniform.mjs
//
// Each run fires three dispatches 35 minutes apart, then takes 70 minutes
// total. Render's "single-run guarantee" delays the next hourly tick until
// this run finishes, so the ticks chain together and the dispatches land at
// perfectly uniform 35-minute intervals forever:
//
//   00:00 -> 00:35 -> 01:10 -> 01:45 -> 02:20 -> ...
//
// Trade-off: a run lives ~70 of every ~70 minutes, so this is billed like an
// always-on instance (roughly $20-30/mo on the smallest plan, not the $1/mo
// minimum). If a uniform beat that fast isn't necessary, use `ping.mjs` with
// a `*/35` or `0 * * * *` schedule instead.

const TOKEN = process.env.GH_TOKEN || "";
const WORKFLOW = process.env.ZEFAME_WORKFLOW || "views";
const REPO = process.env.GH_REPO || "preetbiswas12/social_automation";

const SLEEP_MS = 35 * 60 * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function dispatch() {
  const url = `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}.yml/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "render-cron-pinger",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  console.log(
    `${new Date().toISOString()} dispatch ${WORKFLOW}: HTTP ${res.status}${
      res.status === 204 ? " (accepted)" : ` ${res.statusText}`
    }`
  );
  return res.status === 204;
}

async function main() {
  if (!TOKEN) {
    console.error("GH_TOKEN is not set - add it in the Render dashboard");
    process.exit(1);
  }
  // dispatch -> sleep 35m -> dispatch -> sleep 35m -> dispatch (exits ~1h10m)
  if (!(await dispatch())) process.exit(1);
  await sleep(SLEEP_MS);
  if (!(await dispatch())) process.exit(1);
  await sleep(SLEEP_MS);
  if (!(await dispatch())) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error(`dispatch failed: ${err.message}`);
  process.exit(1);
});