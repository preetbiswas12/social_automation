// Cloudflare Worker version of render-cron/ping.mjs
//
// Deploy free on Cloudflare Workers ("Workers Free" plan, no credit card).
// A cron trigger fires this Worker on schedule; each invocation POSTs one
// workflow_dispatch and exits.
//
// Env config:
//   GH_TOKEN          (secret, via "wrangler secret put GH_TOKEN")
//   ZEFAME_WORKFLOW   "views" or "likes" (default views) - set in wrangler.toml [vars]
//   GH_REPO           default preetbiswas12/social_automation (wrangler.toml [vars])
//
// 204 = accepted. Non-204 is logged (visible under Workers Logs).

export default {
  async scheduled(controller, env) {
    const ok = await dispatch(env);
    if (!ok) throw new Error("dispatch failed (see log)");
  },

  // Manual test: curl https://<your-worker>.workers.dev/dispatch
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/dispatch") {
      const ok = await dispatch(env);
      return new Response(ok ? "dispatch OK (204)" : "dispatch FAILED", {
        status: ok ? 200 : 500,
      });
    }
    return new Response("zefame pinger worker. GET /dispatch to trigger a run.");
  },
};

async function dispatch(env) {
  const token = env.GH_TOKEN;
  const workflow = env.ZEFAME_WORKFLOW || "views";
  const repo = env.GH_REPO || "preetbiswas12/social_automation";
  if (!token) {
    console.log("GH_TOKEN not set - run: npx wrangler secret put GH_TOKEN");
    return false;
  }
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${workflow}.yml/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "cloudflare-worker-pinger",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  console.log(`dispatch ${workflow}: HTTP ${res.status}${res.status === 204 ? " (accepted)" : " " + res.statusText}`);
  return res.status === 204;
}