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

# FLEET SECRETS (sensitive-data report A8, 2026-09-28). deploy.sh used to hand every server four values from the Mac's .env:
# a Cloudflare token that can rewrite DNS for the whole beanpool.org zone and its zone id (a server uses them only for its own
# certificate, and no tunnel of ours checks that certificate), the one admin password all our servers shared (read only on a
# server's first start), and the fleet's tunnel token, written to data/tunnel-token (its tunnel no longer exists). A break-in
# at any one server could have repointed global.beanpool.org. deploy.sh sends none of them now, and these remove what earlier
# deploys and hand edits left. scripts/test-deploy-no-fleet-secrets.sh fails the build if deploy.sh sends one again.

# The names, in one place for the functions below and for the test.
fleet_secret_names() {
  echo "CF_API_TOKEN CF_ZONE_ID ADMIN_PASSWORD CF_TUNNEL_TOKEN"
}

# sha256 of stdin, as lowercase hex. sha256sum on the servers and in CI, shasum on a Mac.
sha256_hex() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi | awk '{print $1}'
}

# strip_fleet_secrets_env <env file>
# Deletes the lines of a server's preserved .env that set one of fleet_secret_names, in each form docker compose reads
# (NAME=, NAME:, export NAME=, a bare NAME, spaces around), and nothing else: every other line, comments included, stays as
# it was. docker compose reads that file too, so a line left there would still reach the container. Prints the names it
# removed, never a value. The file keeps its owner and mode: it is rewritten through a copy made with cp -p, then renamed.
strip_fleet_secrets_env() {
  local env_file=$1 re removed tmp
  sudo test -f "$env_file" || return 0
  re="^[[:space:]]*(export[[:space:]]+)?($(fleet_secret_names | tr ' ' '|'))[[:space:]]*([=:]|$)"
  removed=$(sudo grep -E "$re" "$env_file" | sed -E 's/^[[:space:]]*(export[[:space:]]+)?([A-Z_]+).*/\2/' | sort -u | tr '\n' ' ')
  [ -n "$removed" ] || return 0
  tmp="$env_file.fleet-strip"
  # grep -v exits 1 when it keeps no line at all, which is a result, not a failure; 2 is a failure.
  if ! sudo cp -p "$env_file" "$tmp" \
    || ! sudo sh -c 'grep -vE "$1" "$2" > "$3"; [ $? -le 1 ]' _ "$re" "$env_file" "$tmp" \
    || ! sudo mv -f "$tmp" "$env_file"; then
    sudo rm -f "$tmp"
    echo "⚠️  Could not remove ${removed% } from $env_file: the file is as it was. Delete those lines by hand."
    return 1
  fi
  echo "🧹 Removed ${removed% } from $env_file (values not shown): deploy.sh no longer gives servers the fleet's secrets."
}

# remove_fleet_tunnel_token <token file> <sha256 of the fleet tunnel token, or empty>
# Deletes data/tunnel-token only when it holds the fleet's copy that earlier deploys wrote there. A server's OWN token, written
# by public-address-agent.ts for a registrar-managed address, is a different token and is kept. The two are compared by
# sha256, so the fleet token itself never leaves the Mac. deploy.sh wrote the token with a newline and the agent writes it
# without one, so whitespace is left out of the hash on both sides.
remove_fleet_tunnel_token() {
  local file=$1 fleet_sha=$2 sha
  sudo test -f "$file" || return 0
  if [ -z "$fleet_sha" ]; then
    echo "ℹ️  Kept $file: this Mac's .env has no CF_TUNNEL_TOKEN to tell the fleet's copy from this server's own."
    return 0
  fi
  sha=$(sudo cat "$file" | tr -d '[:space:]' | sha256_hex)
  if [ "$sha" != "$fleet_sha" ]; then
    echo "ℹ️  Kept $file: it is this server's own tunnel token, not the fleet's."
    return 0
  fi
  if sudo rm -f "$file"; then
    echo "🧹 Removed $file: it held the fleet's tunnel token, which deploy.sh no longer sends."
  else
    echo "⚠️  Could not remove $file, which holds the fleet's tunnel token. Delete it by hand."
    return 1
  fi
}

# first_password_notice <data dir> <ssh target>
# Run just before the container starts. A server with no locked admin password (no local-config.json yet, or one that is not
# locked) makes one up on this start, because deploy.sh no longer sends ADMIN_PASSWORD. It never prints it: it keeps it in
# data/first-admin-password.txt (FIRST_PASSWORD_FILE in apps/server/src/config/local-config.ts). This says where, never what.
first_password_notice() {
  local data_dir=$1 target=$2 file
  if sudo test -f "$data_dir/local-config.json" \
    && sudo grep -qE '"isLocked"[[:space:]]*:[[:space:]]*true' "$data_dir/local-config.json"; then
    return 0
  fi
  file="$data_dir/first-admin-password.txt"
  echo "🔑 This server has no admin password yet, so it makes one up as it starts. It is not in this output or in its log."
  echo "   It will be in $file, which only root and the server can read:"
  echo "     ssh $target 'sudo cat $file'"
  echo "   Sign in at /settings with it, then change it there; the file is deleted when you do."
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
