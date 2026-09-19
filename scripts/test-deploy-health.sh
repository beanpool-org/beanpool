#!/bin/bash
# Does deploy.sh refuse to call a dead node deployed, and refuse to fill a host's disk?
#
# WHY THIS EXISTS. 2026-09-19 the qld host hit 100% disk (tagged images from every DEPLOY_TAG pull that the
# old cleanup never removed), the new test container crash-looped on SQLITE_IOERR_SHMSIZE, and deploy.sh
# printed "✅ test deployed!" anyway. This runs the helpers deploy.sh uses (scripts/deploy-lib.sh) locally,
# against a URL nothing answers and against stubbed container / disk state. It never touches a node.
#
#   bash scripts/test-deploy-health.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=deploy-lib.sh
. "$ROOT/scripts/deploy-lib.sh"
run=0; passed=0
assert() { run=$((run+1)); if [ "$2" = "$3" ]; then passed=$((passed+1)); echo "✓ $1"; else echo "✗ $1 (expected '$3', got '$2')"; fi; }
yn() { if "$@" >&2; then echo yes; else echo no; fi; }

grep -q 'source "$SCRIPT_DIR/scripts/deploy-lib.sh"' "$ROOT/deploy.sh" && r=yes || r=no
assert "deploy.sh uses these helpers (not a copy)" "$r" "yes"

# --- what counts as the node answering ---
assert "401 answers (read auth is on by default)" "$(yn http_code_answers 401)" "yes"
assert "200 answers" "$(yn http_code_answers 200)" "yes"
assert "502 is the proxy answering for a dead node" "$(yn http_code_answers 502)" "no"
assert "530 is the tunnel with no origin" "$(yn http_code_answers 530)" "no"
assert "000 is nothing answering" "$(yn http_code_answers 000)" "no"

BOGUS="http://127.0.0.1:9/api/version"
assert "a URL nothing listens on reads as 000" "$(HEALTH_CURL_TIMEOUT=3 http_status "$BOGUS")" "000"

# --- wait_node_healthy, with stubbed container state ---
HEALTH_INTERVAL=1
state_running() { echo "running 0"; }
state_crashloop() { echo "restarting 3"; }

echo ""
echo "--- a running container whose URL never answers (the output deploy.sh shows before ❌) ---"
start=$SECONDS
wait_node_healthy bogus "$BOGUS" 3 state_running; rc=$?
assert "an unanswering node is not healthy" "$rc" "1"
assert "it gave up at the timeout, not before" "$([ $((SECONDS - start)) -ge 3 ] && echo yes || echo no)" "yes"
assert "the report carries the last http code" "$HEALTH_CODE" "000"

echo ""
echo "--- a crash-looping container ---"
start=$SECONDS
wait_node_healthy crashloop "$BOGUS" 60 state_crashloop; rc=$?
assert "a crash loop is not healthy" "$rc" "1"
assert "a crash loop fails at once instead of waiting out the timeout" "$([ $((SECONDS - start)) -lt 10 ] && echo yes || echo no)" "yes"
assert "the report carries the restart count" "$HEALTH_RESTARTS" "3"
assert "the report carries the container status" "$HEALTH_STATUS" "restarting"

echo ""
echo "--- a node that answers 401 while running with no restarts ---"
http_status() { echo 401; }
wait_node_healthy good "https://node.example/api/version" 10 state_running; rc=$?
assert "a running, answering node is healthy" "$rc" "0"

echo ""
echo "--- a node that answers once, then its container restarts ---"
state_flaky() { [ -f "$FLAG" ] && echo "restarting 1" || { touch "$FLAG"; echo "running 0"; }; }
FLAG="$(mktemp -u)"; trap 'rm -f "$FLAG"' EXIT
wait_node_healthy flaky "https://node.example/api/version" 10 state_flaky; rc=$?
assert "one good answer on the way into a crash loop is not healthy" "$rc" "1"

# --- disk_preflight, with stubbed free space and docker ---
echo ""
echo "--- disk preflight ---"
FREE_FILE="$(mktemp)"; PRUNED="$(mktemp -u)"; trap 'rm -f "$FLAG" "$FREE_FILE" "$PRUNED"' EXIT
docker_free_kb() { cat "$FREE_FILE"; }
sudo() { if [ "$*" = "docker image prune -a -f" ]; then touch "$PRUNED"; echo "$AFTER_PRUNE_KB" > "$FREE_FILE"; echo "Total reclaimed space: 27.48GB"; fi; }

echo $((5 * 1024 * 1024)) > "$FREE_FILE"; rm -f "$PRUNED"
assert "enough space passes" "$(yn disk_preflight 3584 t)" "yes"
assert "enough space does not prune" "$([ -e "$PRUNED" ] && echo pruned || echo untouched)" "untouched"

echo $((1 * 1024 * 1024)) > "$FREE_FILE"; rm -f "$PRUNED"; AFTER_PRUNE_KB=$((20 * 1024 * 1024))
assert "short space prunes, then passes" "$(yn disk_preflight 3584 t)" "yes"
assert "the prune ran" "$([ -e "$PRUNED" ] && echo pruned || echo untouched)" "pruned"

echo $((1 * 1024 * 1024)) > "$FREE_FILE"; rm -f "$PRUNED"; AFTER_PRUNE_KB=$((2 * 1024 * 1024))
assert "still short after the prune fails (deploy.sh aborts that node)" "$(yn disk_preflight 3584 t)" "no"

echo $((1 * 1024 * 1024)) > "$FREE_FILE"; rm -f "$PRUNED"
assert "no-prune fails when short" "$(yn disk_preflight 2048 t no-prune)" "no"
assert "no-prune never prunes (it would delete the image just pulled)" "$([ -e "$PRUNED" ] && echo pruned || echo untouched)" "untouched"

echo ""
echo "$passed/$run passed"
[ "$passed" = "$run" ] || exit 1
