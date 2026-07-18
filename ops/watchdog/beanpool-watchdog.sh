#!/usr/bin/env bash
# =============================================================================
# BeanPool node watchdog
# =============================================================================
# Detects a HUNG node — the container is still "running" but its single JS
# thread has spun to 100% CPU and the event loop is dead, so it stops serving
# HTTP entirely (exactly the 2026-07-18 test-node freeze: 6 hours pinned, only
# recovered by a manual `docker restart`). A Docker `restart: unless-stopped`
# policy does NOT catch this because the process never exits.
#
# On detection the watchdog, BEFORE restarting:
#   1. snapshots `docker logs` + `docker stats`/`top` to an incident file, then
#   2. sends SIGUSR2 to the node (PID 1) so `--report-on-signal` writes a
#      Node.js diagnostic report — the blocked JS stack — to /data (persisted),
#      giving us the root cause the next time it happens, and only then
#   3. `docker restart`s the container.
#
# Guards against fighting a deploy / boot / crash-loop: skips containers that
# aren't running or started <BOOT_GRACE ago, honours a post-restart cooldown,
# and stops auto-restarting a container that has flapped MAX_RESTARTS_HR times
# in the last hour (logs loudly for a human instead).
#
# Install: see ops/watchdog/README.md. Host infra — NOT wiped by deploy.sh.
# =============================================================================
set -uo pipefail

# --- config (override via environment in the systemd unit) -------------------
CONTAINERS_DEFAULT="beanpool-beanpool-test-beanpool-node-1 beanpool-beanpool-mullum-beanpool-node-1 beanpool-beanpool-bris-beanpool-node-1"
read -r -a CONTAINERS <<< "${BEANPOOL_WATCH_CONTAINERS:-$CONTAINERS_DEFAULT}"
INTERVAL="${BEANPOOL_WATCH_INTERVAL:-20}"        # seconds between sweeps
FAIL_THRESHOLD="${BEANPOOL_WATCH_FAILS:-3}"      # consecutive fails before acting (~60s)
HTTP_TIMEOUT="${BEANPOOL_WATCH_TIMEOUT:-8}"      # per-check curl timeout (s)
BOOT_GRACE="${BEANPOOL_WATCH_BOOT_GRACE:-90}"    # ignore a container for N s after (re)start
REPORT_WAIT="${BEANPOOL_WATCH_REPORT_WAIT:-10}"  # let the diag report flush before restart
COOLDOWN="${BEANPOOL_WATCH_COOLDOWN:-900}"       # min seconds between auto-restarts of a container
MAX_RESTARTS_HR="${BEANPOOL_WATCH_MAX_RESTARTS_HR:-4}"  # crash-loop backstop
LOGDIR="${BEANPOOL_WATCH_LOGDIR:-/var/log/beanpool-watchdog}"
LOG="$LOGDIR/watchdog.log"

mkdir -p "$LOGDIR"
declare -A FAILS LAST_RESTART RESTART_TIMES RECOVERIES LAST_RECOVERY

log(){ printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$LOG"; }

# Host path of the container's /data mount, so we can drop a status file the
# node itself serves via /api/community/health (the fleet manager already polls
# that endpoint — this is how watchdog activity becomes visible + alertable
# without the node being able to reach the manager).
data_dir(){ docker inspect "$1" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' 2>/dev/null; }

# Write a heartbeat + recovery tally into the node's data dir. The node reads
# this and reports it; a stale heartbeat there tells the fleet a watchdog died.
write_status(){
  local c="$1" st="$2" dd f
  dd="$(data_dir "$c")"; [ -n "$dd" ] && [ -d "$dd" ] || return 0
  f="$dd/watchdog-status.json"
  printf '{"watchdog":"beanpool-watchdog","host":"%s","lastSeenAt":"%s","status":"%s","intervalSeconds":%s,"recoveries":%s,"lastRecoveryAt":%s}\n' \
    "$(hostname)" "$(date -u +%FT%TZ)" "$st" "$INTERVAL" "${RECOVERIES[$c]:-0}" \
    "$([ -n "${LAST_RECOVERY[$c]:-}" ] && printf '"%s"' "${LAST_RECOVERY[$c]}" || printf 'null')" \
    > "$f.tmp" 2>/dev/null && mv "$f.tmp" "$f" 2>/dev/null || true
}

# Seed the in-memory tally from any existing status file so the count survives a
# watchdog restart (the file is the source of truth).
seed_recoveries(){
  local c="$1" dd f n
  dd="$(data_dir "$c")"; [ -n "$dd" ] || return 0
  f="$dd/watchdog-status.json"; [ -f "$f" ] || return 0
  n="$(grep -o '"recoveries":[0-9]*' "$f" | grep -o '[0-9]*' | head -1)"
  [ -n "$n" ] && RECOVERIES[$c]="$n"
}

# Host port mapped to the container's 8443/tcp (HTTPS). Auto-discovered so the
# same watchdog works for test/mullum/bris without hard-coding ports.
health_port(){ docker inspect "$1" --format '{{if index .NetworkSettings.Ports "8443/tcp"}}{{(index (index .NetworkSettings.Ports "8443/tcp") 0).HostPort}}{{end}}' 2>/dev/null; }

is_running(){ [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = "true" ]; }

# Seconds since the container (re)started; huge number if unknown.
started_ago(){
  local s; s="$(docker inspect -f '{{.State.StartedAt}}' "$1" 2>/dev/null)" || { echo 999999; return; }
  local t; t="$(date -d "$s" +%s 2>/dev/null)" || { echo 999999; return; }
  echo $(( $(date +%s) - t ))
}

# Only send SIGUSR2 to nodes that actually have --report-on-signal enabled;
# without it SIGUSR2's default disposition would TERMINATE the process. Lets us
# roll the NODE_OPTIONS flag out node-by-node while the watchdog guards them all.
has_report_flag(){ docker inspect "$1" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep -q 'report-on-signal'; }

health_ok(){
  local port; port="$(health_port "$1")"
  [ -n "$port" ] || return 1
  curl -sk -o /dev/null --max-time "$HTTP_TIMEOUT" "https://127.0.0.1:${port}/api/community/info"
}

restarts_last_hour(){
  local c="$1" now cutoff cnt=0 t
  now=$(date +%s); cutoff=$(( now - 3600 ))
  for t in ${RESTART_TIMES[$c]:-}; do [ "$t" -ge "$cutoff" ] && cnt=$(( cnt + 1 )); done
  echo "$cnt"
}

recover(){
  local c="$1" now stamp inc
  now=$(date +%s); stamp=$(date -u +%Y%m%dT%H%M%SZ)
  inc="$LOGDIR/incident-${c}-${stamp}.log"

  if [ "$(restarts_last_hour "$c")" -ge "$MAX_RESTARTS_HR" ]; then
    log "CRASHLOOP $c reached $MAX_RESTARTS_HR restarts in the last hour — NOT restarting; manual attention required"
    FAILS[$c]=0
    return
  fi

  log "HUNG $c unreachable ${FAIL_THRESHOLD}x — capturing forensics, then restarting"

  # 1) logs + resource snapshot FIRST (survives even if step 2 kills the process)
  {
    echo "== hung incident $(date -u +%FT%TZ): $c =="
    echo "-- docker stats --"; docker stats --no-stream "$c" 2>&1
    echo "-- docker top --";   docker top "$c" 2>&1
    echo "-- docker logs (tail 400) --"; docker logs --tail 400 --timestamps "$c" 2>&1
  } > "$inc" 2>&1
  log "  wrote $inc"

  # 2) Node diagnostic report (blocked JS stack) -> /data/report.*.json in-container
  if has_report_flag "$c"; then
    if docker exec "$c" kill -USR2 1 2>>"$LOG"; then
      log "  sent SIGUSR2 -> diagnostic report to /data (waiting ${REPORT_WAIT}s to flush)"
      sleep "$REPORT_WAIT"
    else
      log "  SIGUSR2 send failed for $c"
    fi
  else
    log "  $c lacks --report-on-signal; skipping diag report (log snapshot only)"
  fi

  # 3) restart
  if docker restart "$c" >>"$LOG" 2>&1; then
    log "  RESTARTED $c"
  else
    log "  RESTART FAILED for $c"
  fi
  LAST_RESTART[$c]=$now
  RESTART_TIMES[$c]="${RESTART_TIMES[$c]:-} $now"
  RECOVERIES[$c]=$(( ${RECOVERIES[$c]:-0} + 1 ))
  LAST_RECOVERY[$c]="$(date -u +%FT%TZ)"
  FAILS[$c]=0
  write_status "$c" hung
}

for c in "${CONTAINERS[@]}"; do seed_recoveries "$c"; done
log "watchdog up — guarding [${CONTAINERS[*]}] interval=${INTERVAL}s threshold=${FAIL_THRESHOLD} boot_grace=${BOOT_GRACE}s cooldown=${COOLDOWN}s"

while true; do
  for c in "${CONTAINERS[@]}"; do
    docker inspect "$c" >/dev/null 2>&1 || continue      # not present on this host
    if ! is_running "$c"; then FAILS[$c]=0; continue; fi  # legitimately down (deploy)

    now=$(date +%s)
    # post-restart cooldown: let it settle, only reset the counter if healthy
    if [ "${LAST_RESTART[$c]:-0}" -ne 0 ] && [ $(( now - ${LAST_RESTART[$c]} )) -lt "$COOLDOWN" ]; then
      health_ok "$c" && FAILS[$c]=0
      continue
    fi
    # boot grace: don't judge a container that just (re)started
    if [ "$(started_ago "$c")" -lt "$BOOT_GRACE" ]; then FAILS[$c]=0; continue; fi

    if health_ok "$c"; then
      [ "${FAILS[$c]:-0}" -ne 0 ] && log "OK $c recovered after ${FAILS[$c]} failed check(s)"
      FAILS[$c]=0
      write_status "$c" ok
    else
      FAILS[$c]=$(( ${FAILS[$c]:-0} + 1 ))
      log "FAIL $c health ${FAILS[$c]}/${FAIL_THRESHOLD}"
      [ "${FAILS[$c]}" -ge "$FAIL_THRESHOLD" ] && recover "$c"
    fi
  done
  sleep "$INTERVAL"
done
