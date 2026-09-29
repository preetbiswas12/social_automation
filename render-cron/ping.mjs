#!/usr/bin/env node
// One-shot GitHub Actions dispatcher, made to run inside a Render Cron Job.
// Each cron tick invokes this script, it POSTs one workflow_dispatch and
// exits (~1-2 s), so a run costs almost nothing (cron jobs bill per second,
// with a $1/mo minimum per job).
//
// Required env (set in the Render dashboard):
//   GH_TOKEN          fine-grained PAT with "Actions: read and write" on the
//                     repo - github.com/settings/personal-access-tokens/new
//   ZEFAME_WORKFLOW   "views" or "likes" (no .yml suffix). Default: views
//   GH_REPO           "owner/repo". Default: preetbiswas12/social_automation
//
// 204 = GitHub accepted the dispatch. Anything else is printed and exits 1
// (the cron run then shows as failed in the Runs page).

const TOKEN = process.env.GH_TOKEN || "";
const WORKFLOW = process.env.ZEFAME_WORKFLOW || "views";
const REPO = process.env.GH_REPO || "preetbiswas12/social_automation";

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
  if (res.status !== 204) {
    const text = await res.text().catch(() => "");
    if (text) console.log(text.slice(0, 300));
    return false;
  }
  return true;
}

async function main() {
  if (!TOKEN) {
    console.error("GH_TOKEN is not set - add it in the Render dashboard");
    process.exit(1);
  }
  const ok = await dispatch();
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`dispatch failed: ${err.message}`);
  process.exit(1);
});