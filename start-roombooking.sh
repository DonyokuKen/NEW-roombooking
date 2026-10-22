#!/bin/bash
# start-roombooking.sh — idempotent starter for NEW-roombooking (port 3100, entry server.js).
# Singleton via PID file + /proc cmdline verification (PID-file guard rule).
set -u
DIR="/home/hatch/workspace/NEW-roombooking"
PIDFILE="$DIR/roombooking.pid"
LOG="$DIR/roombooking.log"
PORT=3100

if [ -f "$PIDFILE" ]; then
  PID=$(cat "$PIDFILE" 2>/dev/null || echo "")
  if [ -n "$PID" ] && [ -d "/proc/$PID" ] && grep -q "node server.js" "/proc/$PID/cmdline" 2>/dev/null; then
    if curl -s -o /dev/null -m 3 "http://127.0.0.1:$PORT/"; then
      exit 0
    fi
  fi
fi

# MariaDB (real legacy data) must be up first — persistent datadir under /home/hatch.
if [ -f /home/hatch/mysql-roombooking/start-mysql.sh ]; then
  bash /home/hatch/mysql-roombooking/start-mysql.sh >>"$LOG" 2>&1 || { echo "mysql start failed" >&2; exit 1; }
fi

cd "$DIR" || exit 1
[ -d node_modules ] || npm install --no-audit --no-fund >>"$LOG" 2>&1
setsid nohup node server.js >>"$LOG" 2>&1 < /dev/null &
echo $! > "$PIDFILE"
for i in $(seq 1 15); do
  curl -s -o /dev/null -m 2 "http://127.0.0.1:$PORT/" && exit 0
  sleep 1
done
echo "roombooking failed to come up on $PORT — see $LOG" >&2
exit 1
