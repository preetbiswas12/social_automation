#!/usr/bin/env bash
# Fires a GitHub Actions workflow_dispatch on a fixed cadence, so the exact
# interval is this script's job and not GitHub's (whose schedule trigger is
# limited to 5-minute cron steps and skips overlapping runs).
#
# The heavy work runs in the cloud; this only needs curl and a token:
#
#   ./pinger.sh views          # loop: dispatch views every 7 min
#   ./pinger.sh likes          # loop: dispatch likes every 31 min
#   ./pinger.sh views once     # dispatch a single run and exit (cron test)
#
# The token comes from the GH_TOKEN environment variable, or from a private
# file so it never has to appear on a crontab line:
#   printf '%s' 'github_pat_XXX' > ~/.gh-token && chmod 600 ~/.gh-token
#
# To survive reboots without sudo, put this in your user crontab (crontab -e):
#   @reboot cd /home/USER/ml-workspace/zefame/social_automation && \
#     setsid nohup bash pinger.sh views > logs/pinger-views.out 2>&1 &
#   @reboot cd /home/USER/ml-workspace/zefame/social_automation && \
#     setsid nohup bash pinger.sh likes > logs/pinger-likes.out 2>&1 &
#
# After adding the lines, start them without waiting for a reboot:
#   setsid nohup bash pinger.sh views > logs/pinger-views.out 2>&1 &
#   setsid nohup bash pinger.sh likes > logs/pinger-likes.out 2>&1 &
# then watch the log until you see "dispatch views: HTTP 204".
#
# Intervals: views 420s (7 min - safely over the site's 5-min per-link limit,
# and longer than a job normally takes, so beats never pile up). Likes 1860s
# (31 min - the site limit is 30).

set -uo pipefail
cd "$(dirname "$0")" || exit 1
mkdir -p logs

SERVICE="${1:-views}"
ONCE="${2:-}"
case "$SERVICE" in
  views) INTERVAL=420 ;;
  likes) INTERVAL=1860 ;;
  *)     echo "usage: $0 {views|likes} [once]" >&2; exit 2 ;;
esac

if [ -z "${GH_TOKEN:-}" ] && [ -s "$HOME/.gh-token" ]; then
  GH_TOKEN="$(cat "$HOME/.gh-token")"
fi
if [ -z "${GH_TOKEN:-}" ]; then
  echo "No token: set GH_TOKEN or create ~/.gh-token (github.com/settings/tokens, scopes repo + workflow)." >&2
  exit 1
fi

REPO="${REPO:-preetbiswas12/social_automation}"
URL="https://api.github.com/repos/$REPO/actions/workflows/$SERVICE.yml/dispatches"

# 204 means the run was accepted. Anything else (401 = bad token, 404 =
# wrong workflow name) is logged and retried shortly rather than spun on.
dispatch() {
  code="$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $GH_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    "$URL" -d '{"ref":"main"}')"
  echo "$(date -Is) dispatch $SERVICE: HTTP $code"
  [ "$code" = "204" ]
}

if [ "$ONCE" = "once" ]; then
  dispatch
  exit $?
fi

# Refuse to start a second copy so two pingers do not double-dispatch.
PIDFILE="logs/pinger-$SERVICE.pid"
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "$SERVICE pinger already running (pid $(cat "$PIDFILE"))" >&2
  exit 1
fi
echo $$ > "$PIDFILE"
trap 'rm -f "$PIDFILE"' EXIT INT TERM

echo "$(date -Is) pinger $SERVICE started (every ${INTERVAL}s, workflow $SERVICE.yml)"

while true; do
  if dispatch; then
    sleep "$INTERVAL"
  else
    echo "  not accepted, retrying in 60s"
    sleep 60
  fi
done