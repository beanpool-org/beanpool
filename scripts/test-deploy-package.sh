#!/bin/bash
# Does deploy.sh ship only the files git tracks, and keep the node's data out of the Docker build?
#
# WHY THIS EXISTS. deploy.sh packed the whole folder it runs from, minus a list of excludes. Anything not on the list went to
#   every server: .claude/ (settings, the board's answers), scratchpad/ (agent logs), any stray log or key. The package on
#   disk on 2026-09-16 held .claude/settings.json and settings.local.json, 107 .agents/ entries and shadow-backup/
#   (scratch/reviews/FABLE-sec-infra.md M2). Since 2026-10-01 it packs `git ls-files`: tracked files only, as they are on
#   disk, with the old excludes as a second filter. And there was no .dockerignore, so on a build node the node's own data/
#   and .env went into the build context (M1).
#
# This RUNS deploy.sh, as shipped, in temp folders with a deploy-targets.conf that names no node: it packages, has nothing to
# deploy to, and ends. ssh, scp, curl and docker are stubs that log any call and fail, and the last check is that none was
# called: nothing is contacted.
#
#   bash scripts/test-deploy-package.sh
#   DEPLOY_SH=/path/to/an/older/deploy.sh bash scripts/test-deploy-package.sh   # uses the scripts/deploy-lib.sh beside it
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY_SH="${DEPLOY_SH:-$ROOT/deploy.sh}"
DEPLOY_LIB="$(cd "$(dirname "$DEPLOY_SH")" && pwd)/scripts/deploy-lib.sh"
SB="$(cd "$(mktemp -d)" && pwd -P)"; trap 'rm -rf "$SB"' EXIT
run=0; passed=0
assert() { run=$((run+1)); if [ "$2" = "$3" ]; then passed=$((passed+1)); echo "✓ $1"; else echo "✗ $1 (expected '$3', got '$2')"; fi; }
yn() { if "$@"; then echo yes; else echo no; fi; }

BIN="$SB/bin"; CALLS="$SB/calls.log"
mkdir -p "$BIN"; : > "$CALLS"
for c in ssh scp curl docker; do
  printf '#!/bin/bash\necho "%s $*" >> "%s"\nexit 1\n' "$c" "$CALLS" > "$BIN/$c"
done
# deploy.sh ends by removing a legacy /tmp file; keep this run inside its sandbox.
printf '#!/bin/bash\ncase "$*" in */tmp/beanpool-deploy.tar.gz*) exit 0 ;; esac\nexec /bin/rm "$@"\n' > "$BIN/rm"
chmod +x "$BIN"/*

# stage <dir>: deploy.sh and its lib in <dir>, with a deploy-targets.conf that names no node.
stage() {
  mkdir -p "$1/scripts"
  cp "$DEPLOY_SH" "$1/deploy.sh"
  cp "$DEPLOY_LIB" "$1/scripts/deploy-lib.sh"
  cp "$ROOT/docker-compose.yml" "$1/docker-compose.yml"
  echo "# no node: a run only packages" > "$1/deploy-targets.conf"
}
# git_add <dir> <path>...: a new checkout at <dir> tracking <path>s. -f: the global gitignore of whoever runs this ignores nothing here.
git_add() { local d=$1; shift; git -C "$d" -c init.defaultBranch=main init -q && git -C "$d" add -f -- "$@"; }
# deploy <dir>: one run of <dir>/deploy.sh, no arguments; sets RC and OUT (its output).
deploy() {
  OUT="$SB/out-$(basename "$1").log"
  (cd "$SB" && env -u DEPLOY_PULL -u DEPLOY_TAG PATH="$BIN:$PATH" bash "$1/deploy.sh" > "$OUT" 2>&1); RC=$?
}

echo "--- deploy.sh as written: $DEPLOY_SH ---"
echo ""
echo "--- a git checkout with untracked files beside the tracked ones ---"
APP="$SB/app"; stage "$APP"
mkdir -p "$APP/src" "$APP/apps/native" "$APP/apps/server/dist" "$APP/data"
echo "as committed" > "$APP/src/edited.ts"
echo "deleted after git add" > "$APP/src/deleted.ts"
echo "spaces" > "$APP/src/a name with spaces.ts"
echo "a file when added" > "$APP/src/now-a-folder"
ln -s /dev/null "$APP/src/masked.service"
# Tracked, but on the old exclude list: they must still stay out.
echo "phone app" > "$APP/apps/native/App.tsx"
echo "build output" > "$APP/apps/server/dist/index.js"
echo "ledger" > "$APP/data/state.db"
echo "EXAMPLE=1" > "$APP/.env.example"
echo "apk" > "$APP/app-release.apk"
git_add "$APP" deploy.sh scripts/deploy-lib.sh docker-compose.yml deploy-targets.conf src apps data .env.example app-release.apk
# After git add: an edit not committed, a tracked file deleted, a tracked file that is now a folder with something in it.
echo "edited, not committed" > "$APP/src/edited.ts"
rm "$APP/src/deleted.ts"
rm "$APP/src/now-a-folder"; mkdir "$APP/src/now-a-folder"; echo "untracked" > "$APP/src/now-a-folder/inside.txt"
# Untracked, and on no exclude list: what the old package shipped.
mkdir -p "$APP/.claude/queue-board" "$APP/scratchpad/agy"
echo "an answer with a pasted token" > "$APP/.claude/queue-board/answers.md"
echo "{}" > "$APP/.claude/settings.local.json"
echo "agent log" > "$APP/scratchpad/agy/run.jsonl"
echo "log" > "$APP/deploy-debug.log"
echo "not a real key" > "$APP/id_ed25519"
echo "not added yet" > "$APP/src/new-file.ts"
printf '%s=%s\n' SOME_TOKEN 'sentinel-untracked-env-9c41' > "$APP/.env"

deploy "$APP"
assert "deploy.sh ran to the end (no node to deploy to)" "$RC" "0"
PKG="$APP/.deploy-package.tar.gz"
mkdir -p "$SB/pkg"; tar -xzf "$PKG" -C "$SB/pkg" 2>/dev/null
ENTRIES="$SB/entries.txt"; tar -tzf "$PKG" 2>/dev/null | sed 's#^\./##' > "$ENTRIES"
shipped() { local p out=""; for p in "$@"; do grep -qxF -- "$p" "$ENTRIES" && out="$out $p"; done; echo "${out:- none}" | sed 's/^ //'; }

assert "no untracked file ships (.claude/, scratchpad/, a log, a key, a new file not yet added)" \
  "$(shipped .claude/queue-board/answers.md .claude/settings.local.json scratchpad/agy/run.jsonl deploy-debug.log id_ed25519 src/new-file.ts)" "none"
assert "nothing inside a tracked path that is now a folder ships" "$(shipped src/now-a-folder/inside.txt)" "none"
assert "the Mac's .env ships nowhere in the package" "$(grep -rl 'sentinel-untracked-env-9c41' "$SB/pkg" 2>/dev/null | wc -l | tr -d ' ')" "0"
assert "an uncommitted edit to a tracked file ships, as it is on disk" "$(cat "$SB/pkg/src/edited.ts" 2>/dev/null)" "edited, not committed"
assert "the tracked files ship" \
  "$(shipped deploy.sh scripts/deploy-lib.sh docker-compose.yml deploy-targets.conf 'src/a name with spaces.ts' src/masked.service)" \
  "deploy.sh scripts/deploy-lib.sh docker-compose.yml deploy-targets.conf src/a name with spaces.ts src/masked.service"
assert "a tracked symlink ships as the symlink" "$(readlink "$SB/pkg/src/masked.service" 2>/dev/null)" "/dev/null"
assert "a tracked file deleted on disk does not ship, and does not stop the package" "$(shipped src/deleted.ts)" "none"
assert "the old excludes still apply to tracked files (apps/native, dist, data, .env.*, *.apk)" \
  "$(shipped apps/native/App.tsx apps/server/dist/index.js data/state.db .env.example app-release.apk)" "none"
n=$(grep -cv '/$' "$ENTRIES")
assert "the log gives the package's file count" "$(grep -c "Package ready: .*, $n files" "$OUT")" "1"
assert "the log lists the top-level entries, files per folder" \
  "$(grep -A3 'Package ready' "$OUT" | grep -c 'scripts/ (1)  src/ (')" "1"
if [ "$passed" != "$run" ]; then
  echo "   package entries:"; sed 's/^/   | /' "$ENTRIES"
  echo "   deploy.sh output (last 15 lines):"; tail -15 "$OUT" | sed 's/^/   | /'
fi

echo ""
echo "--- a folder that is not a git checkout ---"
NOGIT="$SB/nogit"; stage "$NOGIT"
mkdir -p "$NOGIT/.claude"; echo "x" > "$NOGIT/.claude/x"
deploy "$NOGIT"
assert "deploy.sh refuses it" "$([ "$RC" -ne 0 ] && echo refused || echo "ran, rc=$RC")" "refused"
assert "and says why" "$(grep -c 'is not the top of a git checkout' "$OUT")" "1"
assert "before packaging anything" "$(yn test -e "$NOGIT/.deploy-package.tar.gz")" "no"

echo ""
echo "--- a folder inside a git checkout, not its top ---"
OUTER="$SB/outer"; mkdir -p "$OUTER"; echo "outer" > "$OUTER/README"
git_add "$OUTER" README
stage "$OUTER/inner"
deploy "$OUTER/inner"
assert "deploy.sh refuses it" "$([ "$RC" -ne 0 ] && echo refused || echo "ran, rc=$RC")" "refused"
assert "before packaging anything" "$(yn test -e "$OUTER/inner/.deploy-package.tar.gz")" "no"

echo ""
echo "--- nothing was contacted ---"
assert "no ssh, scp, curl or docker call in any run" "$(wc -l < "$CALLS" | tr -d ' ')" "0"
[ -s "$CALLS" ] && sed 's/^/   | /' "$CALLS"

echo ""
echo "--- the Docker build context: .dockerignore ---"
# On a build node deploy.sh puts data/ and .env back into the project folder before `docker compose up --build`.
DI="$ROOT/.dockerignore"
for p in data '**/.env*' .claude 'scratch*' .git '**/node_modules' apps/native; do
  assert ".dockerignore keeps $p out of the build context" "$(yn grep -qxF -- "$p" "$DI")" "yes"
done

echo ""
echo "$passed/$run passed"
[ "$passed" = "$run" ]
