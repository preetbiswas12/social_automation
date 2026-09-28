#!/usr/bin/env bash
# Keep one Zefame service running without a terminal, tmux or root.
#
# Why this exists: tmux dies with the session, nohup does not restart a crash,
# and a systemd system unit needs sudo. This is a plain loop that owns the
# process, survives logout, and restarts it if it dies.
#
#   ./run.sh views      # 300 views every 6 min
#   ./run.sh likes      # 10 likes every 31 min
#
# Start in the background, detached, so it outlives the SSH connection:
#   setsid nohup ./run.sh views > logs/run-views.log 2>&1 &
#
# Stop it:
#   touch logs/views.stop     # graceful: ends after the current session
#   rm -f logs/views.stop     # resume
#   pkill -f "node views.js"  # immediate

set -uo pipefail

cd "$(dirname "$0")" || exit 1

SERVICE="${1:-views}"
case "$SERVICE" in
  views|likes) ;;
  *) echo "usage: $0 {views|likes}" >&2; exit 2 ;;
esac

mkdir -p logs

# Chromium must come from inside the project - no sudo, no shared cache.
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.browsers"

# nvm's node is a shell function, so a non-interactive shell has to load it.
if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node not found. Install it with nvm, or open a shell where it is on PATH." >&2
  exit 1
fi

# Refuse to start a second copy: two browsers on one profile lock each other out.
#
# This checks for a live PID rather than using flock, because flock is not
# installed everywhere and `if ! flock` treats "command not found" as "already
# locked" - which stops the service from ever starting, silently.
PIDFILE="logs/$SERVICE.pid"
mkdir -p logs
if [ -f "$PIDFILE" ]; then
  old="$(cat "$PIDFILE" 2>/dev/null)"
  if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then
    echo "$SERVICE is already running (pid $old)" >&2
    exit 1
  fi
  # The pid is stale - a previous run that was killed. Take it over.
  echo "$(date -Is) $SERVICE: replacing stale pid file (was $old)"
fi
echo $$ > "$PIDFILE"
cleanup() { rm -f "$PIDFILE"; }
trap cleanup EXIT INT TERM

# Never run faster than the site's own limit, however often we are restarted.
# The real interval lives in views.js / likes.js; this is only a floor.
# Overridable so the supervision logic can be tested without waiting minutes.
case "$SERVICE" in
  likes) DEFAULT_MIN_UPTIME=1830 ;;   # 31 min is 1860s
  *)     DEFAULT_MIN_UPTIME=330 ;;    # views: 6 min is 360s
esac
MIN_UPTIME="${RUN_MIN_UPTIME:-$DEFAULT_MIN_UPTIME}"

# How long a run must last before we treat an exit as normal rather than a
# crash. Also overridable, for the same reason.
QUICK_FAIL="${RUN_QUICK_FAIL:-30}"

echo "$(date -Is) run.sh starting $SERVICE (node $(node --version), pid $$)"

while true; do
  # A stop request is honoured between sessions, never mid-order.
  if [ -f "logs/$SERVICE.stop" ]; then
    echo "$(date -Is) $SERVICE: stop requested, not starting another session"
    break
  fi

  started=$(date +%s)
  echo "$(date -Is) $SERVICE: starting node $SERVICE.js"
  # RUN_CMD exists so the supervision logic can be tested against a stub. In
  # normal use it is unset and this is just: node "$SERVICE.js"
  if [ -n "${RUN_CMD:-}" ]; then
    bash -c "$RUN_CMD"
  else
    node "$SERVICE.js"
  fi
  code=$?
  ran=$(( $(date +%s) - started ))

  echo "$(date -Is) $SERVICE: exited with code $code after ${ran}s"

  # If it died immediately, wait before trying again, so a broken install does
  # not spin at full speed eating CPU and the site's rate limit.
  if [ "$ran" -lt "$QUICK_FAIL" ]; then
    echo "$(date -Is) $SERVICE: died quickly, waiting 60s before retrying"
    sleep "${RUN_QUICK_WAIT:-60}"
  elif [ "$ran" -lt "$MIN_UPTIME" ]; then
    wait=$(( MIN_UPTIME - ran ))
    echo "$(date -Is) $SERVICE: waiting ${wait}s so restarts cannot beat the site limit"
    sleep "$wait"
  fi
done

echo "$(date -Is) $SERVICE: stopped"
