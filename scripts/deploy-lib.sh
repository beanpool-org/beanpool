#!/bin/bash
# Helpers for deploy.sh, kept in their own file so scripts/test-deploy-health.sh can exercise them without
# touching a node.
#
# WHY THESE EXIST. 2026-09-19 the qld host (40 GB, also running live mullum, bindarrabi and bris) hit 100%
# disk: every DEPLOY_TAG pull left a TAGGED 1.2 GB image behind, and deploy.sh's cleanup (image prune -f,
# system prune -f) only ever removes dangling images, so it printed "reclaimed 0B" every time. The new test
# container then crash-looped on SQLITE_IOERR_SHMSIZE and deploy.sh still printed "✅ test deployed!",
# because it only read the image label back. Hence: check disk before touching a node, call a node deployed
# only when it answers, and prune tagged images once it does.

# --- Remote side. deploy.sh ships these to the host with declare -f, so they run THERE, not here. ---

# Free KB on the filesystem that holds docker's images.
docker_free_kb() {
  local root
  root=$(sudo docker info -f '{{.DockerRootDir}}' 2>/dev/null)
  [ -n "$root" ] || root=/var/lib/docker
  df -Pk "$root" 2>/dev/null | awk 'NR==2 {print $4}'
}

# disk_preflight <need_mb> <label> [no-prune]
# Succeeds when the docker filesystem has at least need_mb free. When it is short, removes every image no
# container uses (images of running AND stopped containers are kept, other nodes' included) and checks again.
# Pass no-prune once the new image is pulled but not yet running: a prune then would delete it.
disk_preflight() {
  local need_mb=$1 label=$2 mode=${3:-} free_kb
  free_kb=$(docker_free_kb)
  free_kb=${free_kb:-0}
  echo "💽 Disk preflight ($label): $((free_kb / 1024)) MB free on the docker filesystem, need $need_mb MB"
  [ "$free_kb" -ge $((need_mb * 1024)) ] && return 0
  [ "$mode" = "no-prune" ] && return 1
  echo "   Short of space — removing images no container uses (docker image prune -a -f)..."
  sudo docker image prune -a -f 2>&1 | grep -i 'reclaimed' || true
  free_kb=$(docker_free_kb)
  free_kb=${free_kb:-0}
  echo "   After prune: $((free_kb / 1024)) MB free, need $need_mb MB"
  [ "$free_kb" -ge $((need_mb * 1024)) ]
}

# --- Local side. ---

# http_status <url> — the HTTP status code, or 000 when nothing answered.
http_status() {
  local code
  code=$(curl -s -o /dev/null -m "${HEALTH_CURL_TIMEOUT:-10}" -w '%{http_code}' "$1" 2>/dev/null)
  echo "${code:-000}"
}

# http_code_answers <code> — did the NODE answer? 000 is nothing at all; 5xx is the proxy or tunnel answering
# for a node that is not there (502 while the container crash-loops, 530 when the tunnel has no origin).
# Any 2xx-4xx is the node itself; 401 is normal because read auth is on by default.
http_code_answers() {
  case "$1" in
    000|5??|'') return 1 ;;
    *) return 0 ;;
  esac
}

# wait_node_healthy <name> <url> <timeout_s> <state_fn>
# state_fn prints "<container status> <restart count>" (e.g. "running 0"). Healthy means: running, never
# restarted, and the URL answers — on HEALTH_STREAK consecutive checks, so a container that answers once
# on the way into a crash loop is not called healthy. A restart count above 0 fails at once: it never goes
# back down. Leaves HEALTH_STATUS, HEALTH_RESTARTS and HEALTH_CODE set for the caller's report.
wait_node_healthy() {
  local name=$1 url=$2 timeout=$3 state_fn=$4
  local interval=${HEALTH_INTERVAL:-5} need=${HEALTH_STREAK:-3}
  local deadline=$((SECONDS + timeout)) streak=0 state
  echo "🩺 Waiting up to ${timeout}s for $name to answer at $url ..."
  while :; do
    state=$($state_fn 2>/dev/null) || true
    HEALTH_STATUS=$(echo "$state" | awk '{print $1}')
    HEALTH_RESTARTS=$(echo "$state" | awk '{print $2}')
    HEALTH_STATUS=${HEALTH_STATUS:-unknown}
    HEALTH_RESTARTS=${HEALTH_RESTARTS:-?}
    HEALTH_CODE=$(http_status "$url")
    echo "   container=$HEALTH_STATUS restarts=$HEALTH_RESTARTS http=$HEALTH_CODE"
    if [[ "$HEALTH_RESTARTS" =~ ^[0-9]+$ ]] && [ "$HEALTH_RESTARTS" -gt 0 ]; then
      echo "   $name has restarted $HEALTH_RESTARTS time(s) — crash loop, not waiting any longer."
      return 1
    fi
    if [ "$HEALTH_STATUS" = "running" ] && [ "$HEALTH_RESTARTS" = "0" ] && http_code_answers "$HEALTH_CODE"; then
      streak=$((streak + 1))
      [ "$streak" -ge "$need" ] && return 0
    else
      streak=0
    fi
    [ "$SECONDS" -ge "$deadline" ] && return 1
    sleep "$interval"
  done
}
