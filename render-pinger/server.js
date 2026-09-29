// server.js — Render web service that dispatches one GitHub Actions workflow
// on a true, uniform 35-minute interval.
//
// Unlike cron (which can only alternate 35/25-minute gaps), this is a loop:
// it waits 35 minutes after each dispatch, so the gap is exactly 35 minutes
// every time. That means a uniform 35-min beat is safe for BOTH views
// (site limit: 5 min per link) and likes (site limit: 30 min per link).
//
// Environment variables (set in the Render dashboard):
//   GH_TOKEN          (required) fine-grained PAT with "Actions: read and
//                     write" on the repo -
//                     github.com/settings/personal-access-tokens/new
//   ZEFAME_WORKFLOW   "views" or "likes" (no .yml suffix). Default: views
//   GH_REPO           "owner/repo". Default: preetbiswas12/social_automation
//   INTERVAL_MINUTES  Minutes between dispatches. Default: 35
//   IMMEDIATE_FIRST   "false" skips the dispatch that fires on boot.
//                     Default: on (so you see it working right away).
//   KEEP_ALIVE_URL    FREE PLAN ONLY: Render spins a free web service down
//                     after 15 minutes without INBOUND traffic, which would
//                     kill the loop. Set this to your service's own URL, e.g.
//                     https://zefame-views-pinger.onrender.com, and the
//                     service pings itself every 10 minutes. Each self-ping
//                     is inbound traffic, so the 15-minute idle timer never
//                     fires and the loop runs 24/7.
//   PORT              Provided by Render. Default: 3000

import http from "node:http";

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.GH_TOKEN || "";
const WORKFLOW = process.env.ZEFAME_WORKFLOW || "views";
const REPO = process.env.GH_REPO || "preetbiswas12/social_automation";
const IMMEDIATE_FIRST = process.env.IMMEDIATE_FIRST !== "false";
const INTERVAL_MS =
  (parseInt(process.env.INTERVAL_MINUTES || "35", 10) || 35) * 60 * 1000;
const KEEP_ALIVE_URL = (process.env.KEEP_ALIVE_URL || "").replace(/\/+$/, "");

const DISPATCH_URL = `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}.yml/dispatches`;

let lastDispatch = null; // { at, ok, status, error? }

async function dispatch() {
  const at = new Date().toISOString();
  if (!TOKEN) {
    console.log(`${at} dispatch ${WORKFLOW}: skipped - GH_TOKEN not set`);
    lastDispatch = { at, ok: false, status: "no-token" };
    return;
  }
  try {
    const res = await fetch(DISPATCH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "render-pinger-server",
      },
      body: JSON.stringify({ ref: "main" }),
    });
    const ok = res.status === 204;
    console.log(
      `${at} dispatch ${WORKFLOW}: HTTP ${res.status}${ok ? " (accepted)" : ` ${res.statusText}`}`
    );
    lastDispatch = { at, ok, status: res.status };
  } catch (err) {
    console.log(`${at} dispatch ${WORKFLOW}: network error - ${err.message}`);
    lastDispatch = { at, ok: false, status: "network-error", error: err.message };
  }
}

async function keepAlive() {
  try {
    const res = await fetch(`${KEEP_ALIVE_URL}/healthz`);
    console.log(`${new Date().toISOString()} keep-alive: HTTP ${res.status}`);
  } catch (err) {
    console.log(`${new Date().toISOString()} keep-alive failed: ${err.message}`);
  }
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } else if (req.method === "GET" && pathname === "/last") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(lastDispatch || { at: null, status: "none yet" }));
  } else if (req.method === "POST" && pathname === "/dispatch") {
    await dispatch();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(lastDispatch));
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("GET /healthz | GET /last | POST /dispatch");
  }
});

server.listen(PORT, () => {
  console.log(
    `render-pinger up on :${PORT} -> ${REPO}/${WORKFLOW}.yml every ${INTERVAL_MS / 60000} min`
  );
  if (IMMEDIATE_FIRST) dispatch();
  setInterval(dispatch, INTERVAL_MS);
  if (KEEP_ALIVE_URL) {
    setInterval(keepAlive, 10 * 60 * 1000);
    console.log(`keep-alive on -> ${KEEP_ALIVE_URL}/healthz every 10 min`);
  }
});