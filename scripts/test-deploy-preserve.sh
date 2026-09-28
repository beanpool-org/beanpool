#!/bin/bash
# Does a deploy keep a node's data/ and .env, whatever happened to the deploy before it?
#
# WHY THIS EXISTS. deploy.sh wipes the project directory on every run and parks data/ and .env outside it first.
#   2026-08-25, test: mv SRC DEST moves SRC *into* DEST when DEST is an existing directory, and both moves were
#     `mv ... 2>/dev/null || true`, so a backup left by an interrupted deploy buried the live ledger at data/data/ and the node
#     booted on the stale backup's community.key. Found holding 220 MB.
#   2026-09-28, test: two deploys ran at once. The first stopped the node and parked data/ at ~/beanpool-data-backup-<DIR>;
#     the second took that parked copy for a stale leftover, moved it to .stale "because the live data/ is authoritative",
#     found no data/ left to keep, and the node started a new, empty community (a new community.key, a new genesis). The next
#     deploy down that path would have rm -rf'd the .stale copy, the only one left. Log: scratch/overnight/deploy-logs/
#     deploy-7f50044.log (every line in it is there twice).
#
# This RUNS deploy.sh, as shipped, against a stand-in server in a temp dir; nothing is contacted. ssh and scp are stubs that
# run the remote script here, with the server's home (/home/bpfake) mapped into the sandbox. docker is a stub whose "node" is a
# real process in its own process group that writes into its data folder while it runs, and, like a bind mount, goes on
# writing into that folder if it is moved (the folder is its working directory). sudo runs the command, logs each mv, and can
# cut the deploy off right after a move or start a second deploy at that moment, which is what happened on 28 Sep.
#
#   bash scripts/test-deploy-preserve.sh
#   DEPLOY_SH=/path/to/an/older/deploy.sh bash scripts/test-deploy-preserve.sh   # uses the scripts/deploy-lib.sh beside it
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY_SH="${DEPLOY_SH:-$ROOT/deploy.sh}"
DEPLOY_LIB="$(cd "$(dirname "$DEPLOY_SH")" && pwd)/scripts/deploy-lib.sh"
SB="$(cd "$(mktemp -d)" && pwd -P)"
run=0; passed=0
assert() { run=$((run+1)); if [ "$2" = "$3" ]; then passed=$((passed+1)); echo "✓ $1"; else echo "✗ $1 (expected '$3', got '$2')"; fi; }
# shellcheck source=deploy-lib.sh
. "$DEPLOY_LIB"   # sha256_hex, for the key fingerprints the FATAL message should show

echo "--- deploy.sh as written: $DEPLOY_SH ---"
# The remote step is an UNQUOTED heredoc, so the LOCAL shell expands it before it is sent. A backtick or an unescaped
# dollar-paren there runs on the operator's machine, even inside a comment: on 2026-08-25 a backticked comment produced
# "syntax error near unexpected token ||" on every node deployed. The one intended local expansion is the declare -f line
# that ships the helpers.
MAIN="$SB/main-heredoc.sh"
awk '/<< EOF/ && !done {inside=1; next} inside && /^EOF$/ {inside=0; done=1} inside' "$DEPLOY_SH" > "$MAIN"
assert "found the remote step deploy.sh sends over ssh" "$([ -s "$MAIN" ] && grep -q 'BEGIN preserve/restore' "$MAIN" && echo yes || echo no)" "yes"
BT='`'
hits=$(grep -n "$BT" "$MAIN" | head -3)
assert "the remote step has no backtick (the local shell would run it, comments included)" "${hits:-none}" "none"
hits=$(grep -nE '(^|[^\\])\$\(' "$MAIN" | grep -v '^[0-9]*:[[:space:]]*\$(declare -f ' | head -3)
assert "the remote step has no unescaped \$( but the declare -f that ships the helpers" "${hits:-none}" "none"
# No code path deletes a copy of a node's data: not a parked copy, not a .stale one, not data/ or .env themselves.
hits=$(cat "$DEPLOY_SH" "$DEPLOY_LIB" | grep -vE '^[[:space:]]*#' \
  | grep -E '(^|[^[:alnum:]_-])rm[[:space:]]+(-[[:alpha:]]*[rR]|--recursive)' | grep -E 'backup|stale|set-aside|/data|\.env' | head -3)
assert "no rm -r in deploy.sh or deploy-lib.sh names a copy of the data or the .env" "${hits:-none}" "none"

# --- the stand-in server ---
APP="$SB/app"; BIN="$SB/bin"
export SRV="$SB/srv" EVENTS="$SB/events.log" DOCKER_STATE="$SB/docker" NODE_SH="$SB/node.sh" APP SB
HOME_L="$SRV/home/bpfake"                     # the server's /home/bpfake, as the stubs map it
DIR="BeanPool-Fake"; PROJ="$HOME_L/$DIR"; DATA="$PROJ/data"
PARKED="$HOME_L/beanpool-data-backup-$DIR"; PARKED_ENV="$HOME_L/beanpool-env-backup-$DIR"
export LOCK_FILE="$HOME_L/beanpool-deploy-$DIR.lock"
mkdir -p "$APP/scripts" "$BIN"
cp "$DEPLOY_SH" "$APP/deploy.sh"
cp "$DEPLOY_LIB" "$APP/scripts/deploy-lib.sh"
cp "$ROOT/docker-compose.yml" "$APP/docker-compose.yml"
echo "new code" > "$APP/NEW-CODE"
# test is a build node (no registry lookup, compose up --build); BeanPool-Fake matches none of the per-node port edits.
echo "1:test:server.invalid:test.server.invalid:bpfake:$DIR" > "$APP/deploy-targets.conf"
: > "$APP/.deploy-package.tar.gz"   # GNU tar: "file changed as we read it" when gzip creates it mid-read

cat > "$BIN/ssh" << 'STUB'
#!/bin/bash
# ssh [options] user@host [command]: runs the command, or the script on stdin, HERE, with the server's home in the sandbox.
last="${!#}"
export REMOTE_SHELL_PID=$$
if [ "$last" = "/bin/bash" ]; then
  script=$(mktemp "$SRV/.remote.XXXXXX")
  sed "s#/home/bpfake#$SRV/home/bpfake#g" > "$script"
  exec bash -s < "$script"
fi
exec bash -c "$(printf '%s' "$last" | sed "s#/home/bpfake#$SRV/home/bpfake#g")"
STUB
cat > "$BIN/scp" << 'STUB'
#!/bin/bash
# scp [options] <file> user@host:<path>: copies into the stand-in server.
src="${@: -2:1}"; dst="${!#}"
cp "$src" "$(printf '%s' "${dst#*:}" | sed "s#/home/bpfake#$SRV/home/bpfake#")"
STUB
cat > "$BIN/lockprobe" << 'STUB'
#!/bin/bash
# lockprobe <file>: "held" while some process holds a flock on <file>. It opens its own description of the file.
[ -e "$1" ] || { echo "no-lock-file"; exit 0; }
perl -MFcntl=:flock -e 'open(my $f, "<", $ARGV[0]) or exit 2; exit(flock($f, LOCK_EX | LOCK_NB) ? 0 : 1)' "$1"
case $? in 0) echo free ;; 1) echo held ;; *) echo unreadable ;; esac
STUB
cat > "$BIN/sudo" << 'STUB'
#!/bin/bash
# sudo: runs the command as this user. Each mv is logged with the state of the deploy lock. KILL_AFTER_MOVE_OF=<path> cuts the
# deploy off (SIGKILL to the remote shell) right after <path> is moved; SECOND_DEPLOY_AFTER_MOVE_OF=<path> runs a whole second
# deploy at that moment and waits for it. Both are what happened to test on 2026-09-28.
[ "${1:-}" = "-E" ] && shift
case "${1:-}" in
  journalctl) exit 0 ;;                                            # the host cleanup: not this machine's journal
  tee) case "$*" in */proc/*) cat > /dev/null; exit 0 ;; esac ;;   # nor its page cache
esac
[ "${1:-}" = "mv" ] || exec "$@"
"$@"; rc=$?
echo "mv ${2#"$SRV"} -> ${3#"$SRV"} rc=$rc lock=$(lockprobe "$LOCK_FILE")" >> "$EVENTS"
if [ -n "${SECOND_DEPLOY_AFTER_MOVE_OF:-}" ] && [ "$2" = "$SECOND_DEPLOY_AFTER_MOVE_OF" ]; then
  echo "second deploy starts" >> "$EVENTS"
  env -u SECOND_DEPLOY_AFTER_MOVE_OF -u KILL_AFTER_MOVE_OF bash "$APP/deploy.sh" 1 > "$SB/second-deploy.log" 2>&1 9>&-
  echo "second deploy rc=$?" >> "$EVENTS"
fi
if [ -n "${KILL_AFTER_MOVE_OF:-}" ] && [ "$2" = "$KILL_AFTER_MOVE_OF" ]; then
  echo "deploy cut off" >> "$EVENTS"
  kill -KILL "$REMOTE_SHELL_PID"
fi
exit $rc
STUB
cat > "$BIN/rm" << 'STUB'
#!/bin/bash
# rm: logs everything removed on the stand-in server, and keeps deploy.sh's local removal of a legacy /tmp file off this machine.
case "$*" in */tmp/beanpool-deploy.tar.gz*) exit 0 ;; esac
case "$*" in *"$SRV"*) echo "rm $*" | sed "s#$SRV##g" >> "$EVENTS" ;; esac
exec /bin/rm "$@"
STUB
cat > "$BIN/df" << 'STUB'
#!/bin/bash
# df: the disk preflight reads free space on docker's filesystem; the stand-in has plenty, whatever this machine has.
case "$*" in
  *-Pk*) printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\nstand-in 104857600 1048576 103809024 2%% /\n' ;;
  *) exec /bin/df "$@" ;;
esac
STUB
cat > "$BIN/curl" << 'STUB'
#!/bin/bash
# curl: the server's public-IP lookup, and the health check (200 while a stand-in node of the project runs, else 000).
case "$*" in
  *ifconfig.me*) echo "192.0.2.10" ;;
  *http_code*) if [ -n "$(docker ps -q --filter label=com.docker.compose.project=beanpool-fake)" ]; then echo 200; else echo 000; fi ;;
esac
exit 0
STUB
cat > "$NODE_SH" << 'STUB'
#!/bin/bash
# The stand-in node. It works in its data folder the way the real one works through its bind mount: if the folder is moved
# while it runs, it goes on writing into it wherever it now is. A folder with no community.key gets a new community, as a real
# node's first start does.
cd "$1" || exit 1
for fd in 3 4 5 6 7 8 9; do eval "exec $fd>&-"; done
if [ ! -e community.key ]; then
  printf 'new-community-%s-%s\n' "$$" "$RANDOM" > community.key
  printf '{\n  "communityId": "new%s",\n  "createdAt": "%s"\n}\n' "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > genesis.json
fi
echo "boot $$" >> state.db
touch "$2/ready"
while :; do echo "write $$" >> state.db-wal; sleep 0.05; done
STUB
cat > "$BIN/docker" << 'STUB'
#!/bin/bash
# docker: just what deploy.sh uses. A container is a folder under $DOCKER_STATE (name, project, service, mount, pid); a running
# one has a node.sh process in its own process group. A container with an "unstoppable" file refuses stop and rm.
S=$DOCKER_STATE
ev() { echo "$*" >> "$EVENTS"; }
field() { cat "$S/$1/$2" 2>/dev/null; }
alive() { local p; p=$(field "$1" pid); [ -n "$p" ] && kill -0 "$p" 2>/dev/null; }
ids() { local d; for d in "$S"/*/; do [ -d "$d" ] && basename "$d"; done; }
find_id() { local i; for i in $(ids); do if [ "$i" = "$1" ] || [ "$(field "$i" name)" = "$1" ]; then echo "$i"; return 0; fi; done; return 1; }
stop_c() {
  local p
  [ -e "$S/$1/unstoppable" ] && { echo "Error response from daemon: cannot stop container: $1" >&2; return 1; }
  if alive "$1"; then
    p=$(field "$1" pid)
    kill -TERM -- "-$p" 2>/dev/null
    while kill -0 "$p" 2>/dev/null; do sleep 0.02; done
    ev "stop $(field "$1" name)"
  fi
  return 0
}
rm_c() { stop_c "$1" && /bin/rm -r "${S:?}/$1"; }
create_c() {  # <name> <project> <service> <mount>
  local n i
  n=$(( $(cat "$S/.count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$S/.count"
  i=$(printf 'c%04d' "$n"); mkdir -p "$S/$i"
  echo "$1" > "$S/$i/name"; echo "$2" > "$S/$i/project"; echo "$3" > "$S/$i/service"; echo "$4" > "$S/$i/mount"
  echo "$i"
}
start_c() {
  local m; m=$(field "$1" mount)
  mkdir -p "$m"   # like compose, a missing bind-mount source is created, empty
  perl -e 'use POSIX (); POSIX::setsid(); exec @ARGV or die' bash "$NODE_SH" "$m" "$S/$1" 9>&- < /dev/null > /dev/null 2>&1 &
  echo $! > "$S/$1/pid"
  for _ in $(seq 1 250); do [ -e "$S/$1/ready" ] && break; sleep 0.02; done
  ev "start $(field "$1" name) on ${m#"$SRV"} lock=$(lockprobe "$LOCK_FILE")"
}
cmd=${1:-}; shift
case "$cmd" in
  info) echo "$SRV" ;;
  pull) ev "pull $*" ;;
  manifest|network|builder|system) ;;
  image) [ "${1:-}" = prune ] && ev "prune images $*" ;;
  logs) echo "(stand-in node log)" ;;
  run)  # docker run -d --name <name> -v <src>:<dst> <image>: a container started by hand, in no compose project
    name=""; mnt=""
    while [ $# -gt 0 ]; do case "$1" in --name) name=$2; shift ;; -v) mnt=${2%%:*}; shift ;; esac; shift; done
    start_c "$(create_c "$name" "" "" "$mnt")" ;;
  stop) rc=0; for n in "$@"; do i=$(find_id "$n") && stop_c "$i" || rc=1; done; exit $rc ;;
  rm)
    [ "${1:-}" = "-f" ] && shift
    rc=0; for n in "$@"; do
      if ! i=$(find_id "$n"); then echo "Error: No such container: $n" >&2; rc=1; else rm_c "$i" || rc=1; fi
    done; exit $rc ;;
  ps)
    all=0; fl=()
    while [ $# -gt 0 ]; do case "$1" in -a|-aq|-qa) all=1 ;; --filter) fl+=("$2"); shift ;; --format) shift ;; esac; shift; done
    for i in $(ids); do
      [ $all = 1 ] || alive "$i" || continue
      ok=1
      for f in "${fl[@]+"${fl[@]}"}"; do
        case "$f" in
          label=com.docker.compose.project=*) [ "$(field "$i" project)" = "${f#label=com.docker.compose.project=}" ] || ok=0 ;;
          label=com.docker.compose.service=*) [ "$(field "$i" service)" = "${f#label=com.docker.compose.service=}" ] || ok=0 ;;
        esac
      done
      [ $ok = 1 ] && echo "$i"
    done ;;
  inspect)
    fmt=""; if [ "${1:-}" = -f ] || [ "${1:-}" = --format ]; then fmt=$2; shift 2; fi
    i=$(find_id "${1:-}") || { echo "Error: No such object: ${1:-}" >&2; exit 1; }
    case "$fmt" in
      *State.Status*) if alive "$i"; then echo "running 0"; else echo "exited 0"; fi ;;
      *.Mounts*) field "$i" mount ;;
      '{{.Name}}') echo "/$(field "$i" name)" ;;
      *Config.Image*) echo "ghcr.io/beanpool-org/beanpool-node:stand-in" ;;
      *revision*) echo "stand-in" ;;
      *) echo "sha256:stand-in" ;;
    esac ;;
  compose)
    proj=""; sub=""
    while [ $# -gt 0 ]; do case "$1" in --profile) shift ;; -p) proj=$2; shift ;; *) [ -z "$sub" ] && sub=$1 ;; esac; shift; done
    case "$sub" in
      down) rc=0; for i in $(ids); do [ "$(field "$i" project)" = "$proj" ] && { rm_c "$i" || rc=1; }; done; exit $rc ;;
      ps) for i in $(ids); do [ "$(field "$i" project)" = "$proj" ] && alive "$i" && echo "$i"; done ;;
      up)
        [ -f docker-compose.yml ] || { echo "no configuration file provided: not found" >&2; exit 1; }
        name="$proj-beanpool-node-1"
        if i=$(find_id "$name"); then
          [ "$(field "$i" project)" = "$proj" ] || { echo "Conflict. The container name \"/$name\" is already in use" >&2; exit 1; }
          rm_c "$i" || exit 1
        fi
        start_c "$(create_c "$name" "$proj" beanpool-node "$PWD/data")" ;;
    esac ;;
esac
exit 0
STUB
if ! command -v flock > /dev/null 2>&1; then
  # macOS has no util-linux. flock(2) on the inherited descriptor locks the one the calling shell holds, as util-linux flock
  # does, so the lock outlives this process and is let go when the shell's descriptor closes.
  cat > "$BIN/flock" << 'STUB'
#!/bin/bash
[ "${1:-}" = "-n" ] && [ -n "${2:-}" ] || { echo "flock stand-in: only 'flock -n <fd>'" >&2; exit 64; }
exec perl -MFcntl=:flock -e 'open(my $fh, ">&=", $ARGV[0]) or exit 1; exit(flock($fh, LOCK_EX | LOCK_NB) ? 0 : 1)' "$2"
STUB
fi
chmod +x "$BIN"/* "$NODE_SH"

# Every stand-in node is a process the docker stub started, recorded by pid; each is stopped by its process group.
stop_all_nodes() {
  local f p
  for f in "$DOCKER_STATE"/*/pid; do
    [ -f "$f" ] || continue
    p=$(cat "$f"); kill -TERM -- "-$p" 2>/dev/null
    while kill -0 "$p" 2>/dev/null; do sleep 0.02; done
  done
}
trap 'stop_all_nodes; /bin/rm -rf "$SB"' EXIT

dk() { (cd "${2:-$SB}" && PATH="$BIN:$PATH" docker $1); }
fresh_server() { stop_all_nodes; /bin/rm -rf "$SRV" "$DOCKER_STATE"; mkdir -p "$HOME_L" "$DOCKER_STATE"; : > "$EVENTS"; }
# A server that runs: the previous code, data/ holding a community, a .env, and the node running on it.
live_server() {
  fresh_server
  mkdir -p "$DATA"
  echo "ORIGINAL-KEY" > "$DATA/community.key"
  printf '{\n  "communityId": "original0000001",\n  "createdAt": "2025-03-01T09:00:00.000Z"\n}\n' > "$DATA/genesis.json"
  echo "original ledger" > "$DATA/state.db"
  echo "members' photos" > "$DATA/marker"
  printf 'NODE_PROFILE=\nSENTINEL_ENV=kept\n' > "$PROJ/.env"
  cp "$APP/docker-compose.yml" "$PROJ/"; echo "old code" > "$PROJ/OLD-CODE"
  dk "compose -p beanpool-fake up -d" "$PROJ" > /dev/null
  : > "$EVENTS"
}
n=0
deploy() {  # deploy [VAR=value ...]: one run of deploy.sh for node 1; sets RC and OUT (its output)
  n=$((n+1)); OUT="$SB/deploy-$n.log"
  env PATH="$BIN:$PATH" HEALTH_INTERVAL=0 HEALTH_STREAK=1 HEALTH_TIMEOUT=3 "$@" bash "$APP/deploy.sh" 1 > "$OUT" 2>&1
  RC=$?
}
node_pid() { local i; i=$(dk "ps -q --filter label=com.docker.compose.project=beanpool-fake" | head -n1); [ -n "$i" ] && cat "$DOCKER_STATE/$i/pid"; }
writes() { wc -l < "$1/state.db-wal" 2>/dev/null | tr -d ' ' || echo 0; }
# Is a node writing into <dir> right now?
written_to() { local a; a=$(writes "$1"); sleep 0.3; [ "$(writes "$1")" -gt "${a:-0}" ] && echo yes || echo no; }
ev_line() { grep -n -m1 -E "$1" "$EVENTS" | cut -d: -f1; }
before() { local a b; a=$(ev_line "$1"); b=$(ev_line "$2"); [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ] && echo yes || echo "no ($1 at ${a:-never}, $2 at ${b:-never})"; }
deleted() { local h; h=$(grep -E '^rm ' "$EVENTS" | grep -E 'backup|stale|set-aside|/data|\.env' | head -3); echo "${h:-nothing}"; }
# What a deploy changed on the server. A refused deploy removing its own upload (beanpool-deploy-*.tar.gz) changes nothing
# of the node's.
server_changes() { grep -E '^(mv|rm|stop|start|pull|prune) ' | grep -v 'beanpool-deploy-.*\.tar\.gz' | head -3; }
changes() { local h; h=$(server_changes < "$EVENTS"); echo "${h:-none}"; }
fp() { sha256_hex < "$1" | cut -c1-16; }
section() { echo ""; echo "--- $1 ---"; failed_before=$((run - passed)); }
show() {
  [ $((run - passed)) = "$failed_before" ] && return
  echo "   deploy.sh output (last 12 lines):"; tail -12 "$OUT" | sed 's/^/   | /'
  echo "   events:"; sed 's/^/   | /' "$EVENTS"
}
R_DATA="/home/bpfake/$DIR/data"; R_PARKED="/home/bpfake/beanpool-data-backup-$DIR"

section "an ordinary deploy"
live_server
old_pid=$(node_pid)
deploy
assert "it succeeds" "$RC" "0"
assert "the community survives (community.key, genesis, ledger, photos)" \
  "$(cat "$DATA/community.key")|$(grep -c original0000001 "$DATA/genesis.json")|$(head -n1 "$DATA/state.db")|$(cat "$DATA/marker")" \
  "ORIGINAL-KEY|1|original ledger|members' photos"
assert ".env survives" "$(grep -c '^SENTINEL_ENV=kept$' "$PROJ/.env" 2>/dev/null)" "1"
assert "the new code is in place, the old gone" "$(cat "$PROJ/NEW-CODE" 2>/dev/null)|$([ -e "$PROJ/OLD-CODE" ] && echo old || echo gone)" "new code|gone"
assert "the old node is stopped before data/ moves" "$(before '^stop beanpool-fake-beanpool-node-1$' "^mv $R_DATA ")" "yes"
assert "the new node starts only after data/ is back" "$(before "^mv $R_PARKED -> $R_DATA rc=0" '^start ')" "yes"
assert "the node runs on data/" "$([ "$(node_pid)" != "$old_pid" ] && written_to "$DATA")" "yes"
assert "one deploy at a time: the lock is held at every move and at the start" \
  "$(grep -E '^(mv|start) ' "$EVENTS" | grep -vc 'lock=held$')|$(grep -cE '^(mv|start) ' "$EVENTS")" "0|5"
assert "and let go when the deploy ends" "$(PATH="$BIN:$PATH" lockprobe "$LOCK_FILE")" "free"
assert "nothing is left parked, nothing set aside" "$(ls "$HOME_L" | grep -cE 'backup|stale|set-aside')" "0"
assert "the uploaded package is removed" "$(ls "$HOME_L" | grep -c 'tar.gz')" "0"
assert "no copy of the data or the .env is deleted" "$(deleted)" "nothing"
show

section "28 Sep, replayed: the deploy is cut off right after it parks data/, then run again"
live_server
deploy KILL_AFTER_MOVE_OF="$DATA"
assert "attempt 1 is cut off with data/ parked" \
  "$(grep -c '^deploy cut off' "$EVENTS")|$([ -e "$DATA" ] && echo data || echo no-data)|$(cat "$PARKED/community.key" 2>/dev/null)" \
  "1|no-data|ORIGINAL-KEY"
deploy
assert "attempt 2 succeeds" "$RC" "0"
assert "it says it is putting the parked copy back" "$(grep -c "$R_PARKED is this node's data" "$OUT")" "1"
assert "the ORIGINAL community is live in data/ (key, genesis, ledger, photos)" \
  "$(cat "$DATA/community.key" 2>/dev/null)|$(grep -c original0000001 "$DATA/genesis.json" 2>/dev/null)|$(head -n1 "$DATA/state.db" 2>/dev/null)|$(cat "$DATA/marker" 2>/dev/null)" \
  "ORIGINAL-KEY|1|original ledger|members' photos"
assert ".env survives" "$(grep -c '^SENTINEL_ENV=kept$' "$PROJ/.env" 2>/dev/null)" "1"
assert "the node runs on it" "$(written_to "$DATA")" "yes"
assert "nothing is left parked or set aside as stale" "$(ls "$HOME_L" | grep -cE 'backup|stale|set-aside')" "0"
assert "nothing was deleted, in either attempt" "$(deleted)" "nothing"
show

section "cut off right after it parks .env (data/ parked too, the project dir not yet wiped), then run again"
live_server
deploy KILL_AFTER_MOVE_OF="$PROJ/.env"
assert "attempt 1 is cut off with data/ and .env parked" "$([ -d "$PARKED" ] && [ -f "$PARKED_ENV" ] && echo both)" "both"
deploy
assert "attempt 2 succeeds" "$RC" "0"
assert "both come back" "$(cat "$DATA/community.key" 2>/dev/null)|$(grep -c '^SENTINEL_ENV=kept$' "$PROJ/.env" 2>/dev/null)" "ORIGINAL-KEY|1"
assert "nothing was deleted" "$(deleted)" "nothing"
show

section "28 Sep, the state it left: data/ parked with the node still running and writing into the parked copy"
live_server
old_pid=$(node_pid)
mv "$DATA" "$PARKED"   # as the first deploy left it: a bind mount follows its folder, so the node now writes into the copy
assert "the running node writes into the parked copy" "$(written_to "$PARKED")" "yes"
parked_writes=$(writes "$PARKED")
deploy
assert "the deploy succeeds" "$RC" "0"
assert "the node writing into the parked copy is stopped before anything moves" "$(before '^stop beanpool-fake-beanpool-node-1$' '^mv ')" "yes"
assert "the old node is gone" "$(kill -0 "$old_pid" 2>/dev/null && echo alive || echo gone)" "gone"
assert "the ORIGINAL community is live, with what the node wrote while parked" \
  "$(cat "$DATA/community.key" 2>/dev/null)|$([ "$(writes "$DATA")" -ge "$parked_writes" ] && echo kept || echo lost)" "ORIGINAL-KEY|kept"
assert "the new node starts only after the parked copy is back, and runs on it" \
  "$(before "^mv $R_PARKED -> $R_DATA rc=0" '^start ')|$(written_to "$DATA")" "yes|yes"
assert "nothing is left parked or set aside as stale" "$(ls "$HOME_L" | grep -cE 'backup|stale|set-aside')" "0"
assert "nothing was deleted" "$(deleted)" "nothing"
show

section "the same, with the project dir gone too (cut off after the wipe): the stop must not need it"
live_server
old_pid=$(node_pid)
mv "$DATA" "$PARKED"; mv "$PROJ/.env" "$PARKED_ENV"; /bin/rm -rf "$PROJ"
assert "the running node writes into the parked copy" "$(written_to "$PARKED")" "yes"
deploy
assert "the deploy succeeds" "$RC" "0"
assert "the node is stopped before anything moves" "$(before '^stop beanpool-fake-beanpool-node-1$' '^mv ')" "yes"
assert "the old node is gone" "$(kill -0 "$old_pid" 2>/dev/null && echo alive || echo gone)" "gone"
assert "the ORIGINAL community and .env are live, and the node runs on them" \
  "$(cat "$DATA/community.key" 2>/dev/null)|$(grep -c '^SENTINEL_ENV=kept$' "$PROJ/.env" 2>/dev/null)|$(written_to "$DATA")" "ORIGINAL-KEY|1|yes"
assert "nothing is left parked or set aside as stale" "$(ls "$HOME_L" | grep -cE 'backup|stale|set-aside')" "0"
assert "nothing was deleted" "$(deleted)" "nothing"
show

section "28 Sep, as it happened: a second deploy starts while the first has data/ parked"
live_server
deploy SECOND_DEPLOY_AFTER_MOVE_OF="$DATA"
assert "the first deploy succeeds" "$RC" "0"
assert "the first holds the lock while data/ is parked" "$(grep -E "^mv $R_DATA " "$EVENTS" | grep -c 'lock=held$')" "1"
assert "the second refuses" "$(grep -E '^second deploy rc=' "$EVENTS")|$(grep -c 'another deploy' "$SB/second-deploy.log" 2>/dev/null)" "second deploy rc=1|1"
between=$(sed -n '/^second deploy starts$/,/^second deploy rc=/p' "$EVENTS" | server_changes)
assert "the second changes nothing: no move, no removal, no stop or start, no prune" "${between:-none}" "none"
assert "the ORIGINAL community is live, and the node runs on it" "$(cat "$DATA/community.key" 2>/dev/null)|$(written_to "$DATA")" "ORIGINAL-KEY|yes"
assert "nothing is left parked or set aside as stale" "$(ls "$HOME_L" | grep -cE 'backup|stale|set-aside')" "0"
assert "neither deploy leaves its package behind" "$(ls "$HOME_L" | grep -c 'tar.gz')" "0"
assert "nothing was deleted" "$(deleted)" "nothing"
show

section "both data/ and a parked copy: refuse, change nothing, say what to check"
live_server
mkdir -p "$PARKED"
echo "OTHER-KEY" > "$PARKED/community.key"
printf '{\n  "communityId": "other0000000002",\n  "createdAt": "2026-09-28T10:53:00.000Z"\n}\n' > "$PARKED/genesis.json"
echo "a different ledger, from a node that started over on an empty data folder" > "$PARKED/state.db"
old_pid=$(node_pid)
digest() { (cd "$SRV" && find . -type f ! -name state.db-wal ! -name '.remote.*' ! -name '*.tar.gz' ! -name '*.lock' | LC_ALL=C sort | while read -r f; do printf '%s %s\n' "$f" "$(sha256_hex < "$f")"; done); }
before_digest=$(digest)
deploy
assert "the deploy fails" "$RC" "1"
assert "it says FATAL and names both copies" \
  "$(grep -c 'FATAL' "$OUT" | tr -d ' ' | sed 's/^[1-9][0-9]*$/yes/')|$(grep -c "$R_DATA" "$OUT" | sed 's/^[1-9][0-9]*$/yes/')|$(grep -c "$R_PARKED" "$OUT" | sed 's/^[1-9][0-9]*$/yes/')" "yes|yes|yes"
db_lines=$(grep -E 'state\.db[[:space:]]*:' "$OUT")
assert "with each state.db's size" \
  "$(echo "$db_lines" | grep -c " $(wc -c < "$DATA/state.db" | tr -d ' ') bytes")|$(echo "$db_lines" | grep -c " $(wc -c < "$PARKED/state.db" | tr -d ' ') bytes")" "1|1"
assert "and when each state.db changed" "$(echo "$db_lines" | grep -cE 'modified [0-9]{4}-[0-9]{2}-[0-9]{2}')" "2"
assert "each community and when it was founded" \
  "$(grep -c 'original0000001, founded 2025-03-01' "$OUT")|$(grep -c 'other0000000002, founded 2026-09-28' "$OUT")" "1|1"
assert "each community.key's fingerprint" "$(grep -c "$(fp "$DATA/community.key")" "$OUT")|$(grep -c "$(fp "$PARKED/community.key")" "$OUT")" "1|1"
assert "never a key itself" "$(grep -cE 'ORIGINAL-KEY|OTHER-KEY' "$OUT")" "0"
assert "nothing on the server changed" "$(digest)" "$before_digest"
assert "the node was left running on data/" "$(node_pid)|$(written_to "$DATA")" "$old_pid|yes"
assert "no move, removal, stop, start or pull" "$(changes)" "none"
show

section "both .env and a parked .env: refuse, change nothing"
live_server
printf 'NODE_PROFILE=\nSENTINEL_ENV=parked\n' > "$PARKED_ENV"
old_pid=$(node_pid)
deploy
assert "the deploy fails, saying FATAL and naming both" \
  "$RC|$(grep -c 'FATAL' "$OUT" | sed 's/^[1-9][0-9]*$/yes/')|$(grep -c "/home/bpfake/beanpool-env-backup-$DIR" "$OUT" | sed 's/^[1-9][0-9]*$/yes/')" "1|yes|yes"
assert "both are kept as they were" "$(grep -c 'SENTINEL_ENV=kept' "$PROJ/.env")|$(grep -c 'SENTINEL_ENV=parked' "$PARKED_ENV")" "1|1"
assert "the node was left running" "$(node_pid)" "$old_pid"
assert "no move, removal, stop, start or pull" "$(changes)" "none"
show

section "no data/, no parked copy, but a copy an older deploy set aside (.stale): refuse, change nothing"
fresh_server
mkdir -p "$PROJ" "$PARKED.stale"
echo "old code" > "$PROJ/OLD-CODE"
echo "ORIGINAL-KEY" > "$PARKED.stale/community.key"
deploy
assert "the deploy fails, saying FATAL and naming the set-aside copy" \
  "$RC|$(grep -c 'FATAL' "$OUT" | sed 's/^[1-9][0-9]*$/yes/')|$(grep -c "$R_PARKED.stale" "$OUT" | sed 's/^[1-9][0-9]*$/yes/')" "1|yes|yes"
assert "no new, empty community is made" "$([ -e "$DATA" ] && echo made || echo none)|$(dk "ps -q" | wc -l | tr -d ' ')" "none|0"
assert "the set-aside copy and the project are as they were" "$(cat "$PARKED.stale/community.key")|$(cat "$PROJ/OLD-CODE")" "ORIGINAL-KEY|old code"
assert "no move, removal, stop, start or pull" "$(changes)" "none"
show

section "a container nobody named still has data/ mounted: it is stopped before anything moves"
live_server
dk "run -d --name started-by-hand -v $DATA:/data ghcr.io/beanpool-org/beanpool-node" > /dev/null
: > "$EVENTS"
deploy
assert "the deploy succeeds" "$RC" "0"
assert "the hand-started container is stopped before data/ moves" "$(before '^stop started-by-hand$' "^mv $R_DATA ")" "yes"
assert "the community survives and the node runs on it" "$(cat "$DATA/community.key" 2>/dev/null)|$(written_to "$DATA")" "ORIGINAL-KEY|yes"
show

section "a container with data/ mounted will not stop: refuse before anything moves"
live_server
hand=$(dk "run -d --name will-not-stop -v $DATA:/data ghcr.io/beanpool-org/beanpool-node" > /dev/null; ls "$DOCKER_STATE" | grep '^c' | tail -n1)
touch "$DOCKER_STATE/$hand/unstoppable"
: > "$EVENTS"
deploy
assert "the deploy fails, saying FATAL and naming it" \
  "$RC|$(grep -c 'FATAL' "$OUT" | sed 's/^[1-9][0-9]*$/yes/')|$(grep -c 'will-not-stop' "$OUT" | sed 's/^[1-9][0-9]*$/yes/')" "1|yes|yes"
assert "data/ never moved, the project was not wiped" \
  "$(cat "$DATA/community.key" 2>/dev/null)|$(grep -c '^mv ' "$EVENTS")|$(cat "$PROJ/OLD-CODE" 2>/dev/null)" "ORIGINAL-KEY|0|old code"
show

section "a new server (no project, no data): the first deploy makes its community"
fresh_server
deploy
assert "it succeeds" "$RC" "0"
assert "the node made a new community in data/ and runs on it" "$(grep -c '^new-community-' "$DATA/community.key" 2>/dev/null)|$(written_to "$DATA")" "1|yes"
assert "no FATAL" "$(grep -c 'FATAL' "$OUT")" "0"
show

echo ""
echo "$passed/$run passed"
[ "$passed" = "$run" ] || exit 1
