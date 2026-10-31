#!/bin/bash
# test-merge-gate.sh — tests the local merge gate's scripts against a throwaway repository. No GitHub, no network.
#
# Covers scripts/test-all-merge-check.sh, scripts/test-all-pr.sh, scripts/test-all-train.sh (the merge train, with
# scripts/words-merge-3way.mjs and its --shadow, with scripts/test-all-shadow.sh), the green record in scripts/test-all-lib.sh
# (green_run_start / record_green_run), scripts/check-deps-installed.mjs, and the real test-all.sh's --all and what it
# keeps when it is stopped part-way (CI's timeout, or Ctrl-C). The repository is a bare "origin" and a
# clone of it in a temp dir; `gh` is a stub on PATH that answers `pr view` from files, logs `api` calls (answering
# check-runs from files) and does `pr merge` as a squash onto the bare origin's main; the clone's
# scripts/test-all.sh is a stub that sources the REAL test-all-lib.sh, so the record it writes is the real one.
#
# Run: bash scripts/test-merge-gate.sh

set -o pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

FAILS=0
ok()   { echo "✓ $1"; }
bad()  { echo "✗ $1"; FAILS=$((FAILS + 1)); }
# expect <want rc> <description> <pattern the output must contain, or ""> -- <command...>
expect() {
  local want="$1" desc="$2" pattern="$3"; shift 4
  local out rc
  out=$("$@" 2>&1); rc=$?
  if [ "$rc" != "$want" ]; then bad "$desc (exit $rc, wanted $want)"; echo "$out" | tail -15 | sed 's/^/      /'; return; fi
  # A here-string, not printf | grep -q: under pipefail, grep -q exits at the first match and printf's write fails with
  # SIGPIPE, so a large output that DOES contain the pattern reads as missing (CI, #2483, 26 Oct).
  if [ -n "$pattern" ] && ! grep -qF -- "$pattern" <<<"$out"; then
    bad "$desc (output lacks: $pattern)"; echo "$out" | tail -15 | sed 's/^/      /'; return
  fi
  ok "$desc"
}

# expect() itself: a pattern near the top of a large output is found (piped into grep -q under pipefail it was not)
expect 0 "expect: finds a pattern near the top of a 200,000-line output" "17" -- seq 1 200000

# ── suite-count-line.mjs: the NO-COUNT guard of run-server-suites.mjs ─────────────────────────────────────────────
# counted <want 0=counted, 1=not> <description> <log, with \n for newlines>
counted() {
  expect "$1" "$2" "" -- node --input-type=module -e '
    import { hasCountLine } from "'"$REPO_ROOT"'/scripts/suite-count-line.mjs";
    process.exit(hasCountLine(process.argv[1].replace(/\\n/g, "\n")) ? 0 : 1);' "$3"
}
counted 0 "count line: \"3/3 passed\" is a closing count" '✓ one\n3/3 passed'
counted 0 "count line: \"ALL TESTS PASSED\" and \"All 5 checks passed\" are closing counts" 'ALL TESTS PASSED\nAll 5 checks passed'
counted 1 "count line: checks with no closing count are not counted (NO-COUNT)" '✓ one\n✓ two'
counted 1 "count line: a line ending \"1/2\" and a later line with \"passed\" are not one count (#1334 confirmation 3)" '— step 1/2\n✓ the first check passed'

# ── check-deps-installed.mjs ─────────────────────────────────────────────────────────────────────────────────────
D="$T/deps"
mkdir -p "$D/apps/a" "$D/packages/p" "$D/node_modules/left-pad" "$D/node_modules/@scope/kit" "$D/apps/a/node_modules/only-here"
printf 'packages:\n  - "apps/*"\n  - "packages/*"\n' > "$D/pnpm-workspace.yaml"
echo '{"devDependencies":{"left-pad":"1"}}' > "$D/package.json"
echo '{"dependencies":{"@scope/kit":"1","only-here":"2","@me/p":"workspace:*"},"optionalDependencies":{"fsevents":"2"},"devDependencies":{"fsevents":"2"}}' > "$D/apps/a/package.json"
echo '{"dependencies":{"left-pad":"1"}}' > "$D/packages/p/package.json"
for p in left-pad @scope/kit; do echo '{}' > "$D/node_modules/$p/package.json"; done
echo '{}' > "$D/apps/a/node_modules/only-here/package.json"
expect 0 "deps: every declared package installed (root, scoped, one nested in its workspace; workspace: and optional skipped)" "" -- node "$REPO_ROOT/scripts/check-deps-installed.mjs" "$D"
mkdir -p "$D/apps/own-install" && echo '{"devDependencies":{"never-installed-here":"1"}}' > "$D/apps/own-install/package.json"
printf 'packages:\n  - "apps/*"\n  - "packages/*"\n  - "!apps/own-install"\n' > "$D/pnpm-workspace.yaml"
expect 0 "deps: a folder the workspace leaves out with \"!\" (its own install, like apps/reddit-watcher) is not checked" "" -- node "$REPO_ROOT/scripts/check-deps-installed.mjs" "$D"
echo '{"dependencies":{"left-pad":"1","new-dep":"3"}}' > "$D/packages/p/package.json"
expect 1 "deps: a package added to a workspace package.json and not installed is a stale install" "STALE INSTALL" -- node "$REPO_ROOT/scripts/check-deps-installed.mjs" "$D"
expect 1 "deps: ...naming the package and where it is declared" "packages/p/package.json: new-dep" -- node "$REPO_ROOT/scripts/check-deps-installed.mjs" "$D"
rm -rf "$D/node_modules" "$D/apps/a/node_modules"
expect 1 "deps: no node_modules at all says nothing is installed" "nothing is installed here" -- node "$REPO_ROOT/scripts/check-deps-installed.mjs" "$D"

# ── The real test-all.sh: --all runs every server suite ──────────────────────────────────────────────────────────
# Its first `node` call is the stale-install check, before any check starts. A stub node there prints what the run
# would hand the server-suite runner, then stops the run.
mkdir -p "$T/nodestub"
cat > "$T/nodestub/node" <<'STUB'
#!/bin/bash
echo "stub node: SERVER_SUITES_ONLY=[${SERVER_SUITES_ONLY-unset}] SERVER_SUITES_SHARD=[${SERVER_SUITES_SHARD-unset}] TEST_ALL_ONLY=[${TEST_ALL_ONLY-unset}] TEST_ALL_TEST_SLICE=[${TEST_ALL_TEST_SLICE-unset}]"; exit 1
STUB
chmod +x "$T/nodestub/node"
expect 1 "test-all --all drops SERVER_SUITES_ONLY, so a narrowed run cannot record a full green" "SERVER_SUITES_ONLY=[unset]" -- env SERVER_SUITES_ONLY=test-x PATH="$T/nodestub:$PATH" bash "$REPO_ROOT/scripts/test-all.sh" --all
expect 1 "test-all --all ...and says it is ignoring it" "ignoring SERVER_SUITES_ONLY=test-x" -- env SERVER_SUITES_ONLY=test-x PATH="$T/nodestub:$PATH" bash "$REPO_ROOT/scripts/test-all.sh" --all
expect 1 "test-all without --all keeps SERVER_SUITES_ONLY, for reproducing one suite" "SERVER_SUITES_ONLY=[test-x]" -- env SERVER_SUITES_ONLY=test-x PATH="$T/nodestub:$PATH" bash "$REPO_ROOT/scripts/test-all.sh" --fast

# ── The real test-all.sh narrowed for a CI shard: TEST_ALL_ONLY, SERVER_SUITES_SHARD, TEST_ALL_TEST_SLICE ──────────────
expect 1 "test-all --all without TEST_ALL_ONLY drops SERVER_SUITES_SHARD: the merge gate's run is every suite" "SERVER_SUITES_SHARD=[unset]" -- env SERVER_SUITES_SHARD=1/6 PATH="$T/nodestub:$PATH" bash "$REPO_ROOT/scripts/test-all.sh" --all
expect 1 "test-all --all ...and says it is ignoring it" "ignoring SERVER_SUITES_SHARD=1/6" -- env SERVER_SUITES_SHARD=1/6 PATH="$T/nodestub:$PATH" bash "$REPO_ROOT/scripts/test-all.sh" --all
expect 1 "test-all --all without TEST_ALL_ONLY drops TEST_ALL_TEST_SLICE too" "ignoring TEST_ALL_TEST_SLICE=--only" -- env TEST_ALL_TEST_SLICE="--only --filter=x" PATH="$T/nodestub:$PATH" bash "$REPO_ROOT/scripts/test-all.sh" --all
expect 1 "test-all --all with TEST_ALL_ONLY keeps SERVER_SUITES_SHARD for the shard's runner" "SERVER_SUITES_SHARD=[1/6]" -- env TEST_ALL_ONLY=server_suites SERVER_SUITES_SHARD=1/6 PATH="$T/nodestub:$PATH" bash "$REPO_ROOT/scripts/test-all.sh" --all
expect 1 "test-all with TEST_ALL_ONLY says the run records no green" "This run records no green." -- env TEST_ALL_ONLY=server_suites PATH="$T/nodestub:$PATH" bash "$REPO_ROOT/scripts/test-all.sh" --all
expect 1 "test-all keeps TEST_ALL_ONLY and TEST_ALL_TEST_SLICE from its checks (merge_gate runs test-all.sh again inside)" "TEST_ALL_ONLY=[unset] TEST_ALL_TEST_SLICE=[unset]" -- env TEST_ALL_ONLY=test TEST_ALL_TEST_SLICE=--only PATH="$T/nodestub:$PATH" bash "$REPO_ROOT/scripts/test-all.sh" --all
expect 2 "test-all refuses a TEST_ALL_ONLY name that is no check, before running anything" "TEST_ALL_ONLY names website_langs, which is no check here" -- env TEST_ALL_ONLY="website_lang website_langs" PATH="$T/nodestub:$PATH" bash "$REPO_ROOT/scripts/test-all.sh" --all

# ── The real test-all.sh stopped part-way: CI's `timeout -s INT 115m`, or Ctrl-C ──────────────────────────────────
# A copy of it beside the real test-all-lib.sh, with a stand-in install check and a stub pnpm on PATH: `turbo run build`
# and `turbo run test` run until signalled, then print their held output a second later, as turbo does under GitHub
# Actions. The deploy_preserve check is a stub that says it ran; every other check finds no script and fails at once.
# The whole process group is signalled, as `timeout` does, once deploy_preserve has run: by then native_phone_width,
# launched before it, is waiting for build.
S="$T/stopped"
mkdir -p "$S/scripts" "$S/bin" "$S/started"
cp "$REPO_ROOT/scripts/test-all.sh" "$REPO_ROOT/scripts/test-all-lib.sh" "$S/scripts/"
echo 'process.exit(0)' > "$S/scripts/check-deps-installed.mjs"
echo 'echo "stub deploy_preserve: ran"; touch "$STUB_STARTED/deploy_preserve"' > "$S/scripts/test-deploy-preserve.sh"
cat > "$S/bin/pnpm" <<'STUB'
#!/usr/bin/env node
const args = process.argv.slice(2).join(' ')
const task = (args.match(/^turbo run (build|test)\b/) || [])[1]
if (!task) process.exit(0)
console.log(`stub ${task}: started`)
process.on('SIGINT', () => setTimeout(() => { console.log(`stub ${task}: held output`); process.exit(130) }, 1000))
setInterval(() => {}, 1000)
STUB
chmod +x "$S/bin/pnpm"
# stopped_run <TEST_ALL_LOG_DIR, or "">: signals the run once deploy_preserve has run, then gives it 60 s to end (a run
# that outlives that is killed and fails below, rather than hanging this suite). Sets STOP_RC.
stopped_run() {
  rm -f "$S/started/"*
  env TEST_ALL_LOG_DIR="$1" STUB_STARTED="$S/started" PATH="$S/bin:$PATH" \
    perl -e '$SIG{INT} = $SIG{TERM} = "DEFAULT"; setpgrp(0, 0); exec @ARGV' bash "$S/scripts/test-all.sh" --fast > "$S/out" 2>&1 &
  local pg=$! i
  for i in $(seq 600); do [ -f "$S/started/deploy_preserve" ] && break; sleep 0.1; done
  kill -INT -- -"$pg"
  for i in $(seq 60); do kill -0 "$pg" 2>/dev/null || break; sleep 1; done
  kill -0 "$pg" 2>/dev/null && { kill -KILL -- -"$pg"; echo "(test: still running 60 s after the signal; killed)" >> "$S/out"; }
  wait "$pg"; STOP_RC=$?
}
# has <description> <file> <fixed string it must contain>
has() { if grep -qF -- "$3" "$2" 2>/dev/null; then ok "$1"; else bad "$1 (no line containing: $3)"; tail -25 "$S/out" | sed 's/^/      /'; fi; }
exits_130() { if [ "$STOP_RC" = 130 ]; then ok "$1"; else bad "$1 (exit $STOP_RC)"; tail -25 "$S/out" | sed 's/^/      /'; fi; }

stopped_run "$S/logs"
exits_130 "stopped run (CI): exits 130 on SIGINT"
has "stopped run (CI): names the checks that had not finished" "$S/out" "Checks unfinished: build test native_phone_width"
has "stopped run (CI): prints the end of a hung check's log, with the output turbo held until it ended" "$S/out" "stub test: held output"
has "stopped run (CI): copies the hung check's log, held output included, for the upload" "$S/logs/test.log" "stub test: held output"
has "stopped run (CI): ...and the log of a check that had finished" "$S/logs/deploy_preserve.log" "stub deploy_preserve: ran"
has "stopped run (CI): a check waiting for build is not started" "$S/logs/native_phone_width.log" "Not started: the run was stopped."
stopped_run ""
exits_130 "stopped run (local): exits 130 on SIGINT"
has "stopped run (local): keeps its logs where they are and says where" "$S/out" "Full logs of every check kept in "
KEPT=$(sed -n 's/^Full logs of every check kept in //p' "$S/out")
has "stopped run (local): ...held output included" "$KEPT/test.log" "stub test: held output"
case "$KEPT" in */tmp.*) rm -rf "$KEPT" ;; esac

# A CI shard's run of the same copy: only the checks TEST_ALL_ONLY names run and are reported, and a check that waits for
# build (native_phone_width) or for website_contrast (website_status) starts at once when that check is not in the run,
# instead of waiting for ever (alarm: 120 s). Both then fail fast here: their scripts are not in this copy.
rm -f "$S/started/"*
env TEST_ALL_ONLY="deploy_preserve native_phone_width website_status" STUB_STARTED="$S/started" PATH="$S/bin:$PATH" \
  perl -e 'alarm 120; exec @ARGV' bash "$S/scripts/test-all.sh" --all > "$S/out" 2>&1; ONLY_RC=$?
if [ "$ONLY_RC" = 1 ]; then ok "shard run: ends (exit 1: two checks failed), no check waiting for one not in the run"; else bad "shard run: exit $ONLY_RC, wanted 1 (142 is the 120 s alarm: a check waited for ever)"; tail -25 "$S/out" | sed 's/^/      /'; fi
has "shard run: the three checks named ran" "$S/out" "Total: 1 passed, 2 failed, 0 skipped"
if grep -qE "settings_phone|server_suites|secrets_guard" "$S/out"; then bad "shard run: reports a check it was not given"; else ok "shard run: reports no other check"; fi

# A check that passes having compared nothing prints "⚪ SKIP: <why>". On GitHub migration_steps read as a pass in 0 s on every
# pull request: the report says skipped, with the reason, and the run's page gets a warning. Under turbo the line has a prefix.
echo 'echo "@beanpool/guide:test: ⚪ SKIP: no origin/main to compare with"' > "$S/scripts/test-deploy-preserve.sh"
echo 'echo "fine"; echo "stub deploy_preserve: ran"' > "$S/scripts/test-deploy-health.sh"
env TEST_ALL_ONLY="deploy_preserve deploy_health" GITHUB_ACTIONS=true PATH="$S/bin:$PATH" bash "$S/scripts/test-all.sh" --all > "$S/out" 2>&1; SKIP_RC=$?
[ "$SKIP_RC" = 0 ] && ok "skip: a check with nothing to compare fails nothing" || bad "skip: exit $SKIP_RC, wanted 0"
has "skip: reported as skipped, with its reason" "$S/out" "⚪ SKIPPED  no origin/main to compare with"
has "skip: ...counted as skipped, and the other check as passed" "$S/out" "Total: 1 passed, 0 failed, 1 skipped"
has "skip: ...a warning on the run's page" "$S/out" "::warning title=test-all skipped deploy_preserve::no origin/main to compare with"
if grep -E "deploy_preserve +✅" "$S/out" >/dev/null; then bad "skip: it still reads as a pass"; else ok "skip: not a plain PASS"; fi
# -u: this suite runs on GitHub too, where the run below would inherit GITHUB_ACTIONS and be on GitHub after all.
env -u GITHUB_ACTIONS TEST_ALL_ONLY="deploy_preserve" PATH="$S/bin:$PATH" bash "$S/scripts/test-all.sh" --all > "$S/out" 2>&1
if grep -qF "::warning" "$S/out"; then bad "skip: an annotation outside GitHub Actions"; else ok "skip: no annotation off GitHub"; fi

# The check itself, in a checkout with no origin/main (a real git, this script's own copy): it says SKIP, and test-all reports that.
MG="$T/migcheck"; mkdir -p "$MG/scripts"; cp "$REPO_ROOT/scripts/check-migrations-unchanged.sh" "$MG/scripts/"
( cd "$MG" && git init -q && git -c user.name=t -c user.email=t@t.invalid commit -q --allow-empty -m one )
expect 0 "migration check: no origin/main is a SKIP line, not a pass" "⚪ SKIP: no origin/main here" -- bash "$MG/scripts/check-migrations-unchanged.sh"

# ── The real test-all.sh: --continue runs every package, and the report marks only what failed ────
expect 0 "test-all --continue: every package runs to its own result" "" -- bash "$REPO_ROOT/scripts/test-all-continue.sh"

# ── A throwaway repository with a bare origin ────────────────────────────────────────────────────────────────────
export TMPDIR="$T/tmp"; mkdir -p "$TMPDIR"
export GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1
git config --global user.name "Gate Test"; git config --global user.email "gate@test.invalid"
git config --global init.defaultBranch main; git config --global commit.gpgsign false; git config --global advice.detachedHead false
git init -q --bare "$T/origin.git"
git clone -q "$T/origin.git" "$T/work" 2>/dev/null
W="$T/work"
cd "$W" || exit 1
mkdir scripts
cp "$REPO_ROOT/scripts/test-all-lib.sh" scripts/
cat > scripts/test-all.sh <<'STUB'
#!/bin/bash
# Stub test-all: the real green record, no real checks. A committed FAIL file fails it.
cd "$(dirname "$0")/.." || exit 1
. scripts/test-all-lib.sh
[ "$1" = "--all" ] && green_run_start
if [ -f FAIL ]; then echo "stub test-all: FAIL"; exit 1; fi
[ -n "$STUB_COMMIT_DURING_RUN" ] && git commit -q --allow-empty -m "a commit during the run"
echo "stub test-all: every check passed"
[ "$1" = "--all" ] && record_green_run 7
exit 0
STUB
echo "line one" > notes.txt
git add scripts notes.txt && git commit -q -m c1 && git push -q origin main 2>/dev/null
C1=$(git rev-parse HEAD)

MERGE_CHECK="$REPO_ROOT/scripts/test-all-merge-check.sh"
PR_SCRIPT="$REPO_ROOT/scripts/test-all-pr.sh"
GREEN="$(git rev-parse --path-format=absolute --git-common-dir)/test-all-green"

# gh stub: `pr view <n> ...` prints $GH_STUB_DIR/pr-<n> ("<n> <head> <base> <url>"; the url only when asked for). The
# train's query (it asks for labels) adds $GH_STUB_DIR/prx-<n> ("<branch> <from a fork> <state> <labels>"), and its head is
# that branch on $GH_STUB_ORIGIN, as GitHub's is after a push. `api ...` appends its arguments to $GH_STUB_DIR/api, and a
# check-runs call prints $GH_STUB_DIR/ci-<sha> (the conclusions). `pr merge <n> --match-head-commit <sha>` squashes the
# branch onto $GH_STUB_ORIGIN's main, refused when the branch is not at <sha> or does not merge; $GH_STUB_DIR/merges
# lists the PRs merged, in order. A file $GH_STUB_DIR/sneak makes the next merge land a commit of its own on main first
# (another merge landing in the same moment), and is removed. `workflow run` appends its arguments to $GH_STUB_DIR/attempts,
# fails while $GH_STUB_DIR/dispatch-fails exists, hangs while dispatch-hangs does, and otherwise appends the arguments to
# dispatches and "<branch> <run id>" to runs. `run list` answers from runs; `run view <id>` prints run-<id> (the
# conclusion), or "pending" when there is none. $GH_STUB_DIR/view-appends, when it exists, is a line a run view adds to
# shadow.log: a train ending while the reader reads. $GH_STUB_DIR/view-rewrites, when it exists, replaces shadow.log the same
# way: another reader finishing first.
export GH_STUB_DIR="$T/gh"; mkdir -p "$GH_STUB_DIR" "$T/bin"
cat > "$T/bin/gh" <<'STUB'
#!/bin/bash
if [ "$1 $2" = "pr view" ]; then
  n="${3##*/}"; f="$GH_STUB_DIR/pr-$n"
  [ -f "$f" ] || { echo "no pull requests found for $3" >&2; exit 1; }
  case "$*" in
    *labels*)
      read -r num head base url < "$f"; read -r branch cross state labels < "$GH_STUB_DIR/prx-$n"
      h=$(git --git-dir="$GH_STUB_ORIGIN" rev-parse -q --verify "refs/heads/$branch") && head=$h
      [ -f "$GH_STUB_DIR/merged-$n" ] && state=MERGED
      echo "$num $head $base $url $branch $cross $state $labels" ;;
    *url*) cat "$f" ;;
    *) cut -d' ' -f1-3 "$f" ;;
  esac
  exit 0
fi
if [ "$1 $2" = "pr merge" ]; then
  n="$3"; want=""; prev=""
  for a in "$@"; do [ "$prev" = "--match-head-commit" ] && want="$a"; prev="$a"; done
  read -r branch _ < "$GH_STUB_DIR/prx-$n"
  O="$GH_STUB_ORIGIN"; head=$(git --git-dir="$O" rev-parse "refs/heads/$branch")
  [ "$head" = "$want" ] || { echo "GraphQL: Head branch was modified. Review and try the merge again." >&2; exit 1; }
  main=$(git --git-dir="$O" rev-parse refs/heads/main)
  if [ -f "$GH_STUB_DIR/sneak" ]; then
    rm -f "$GH_STUB_DIR/sneak"; blob=$(echo sneak | git --git-dir="$O" hash-object -w --stdin)
    t=$( (git --git-dir="$O" ls-tree "$main"; printf '100644 blob %s\tsneak.txt\n' "$blob") | git --git-dir="$O" mktree)
    s=$(git --git-dir="$O" commit-tree "$t" -p "$main" -m "another merge"); git --git-dir="$O" update-ref refs/heads/main "$s" "$main" && main=$s
  fi
  tree=$(git --git-dir="$O" merge-tree --write-tree "$main" "$head" 2>/dev/null) || { echo "GraphQL: Pull Request is not mergeable" >&2; exit 1; }
  c=$(git --git-dir="$O" commit-tree "$tree" -p "$main" -m "PR #$n (squash)")
  git --git-dir="$O" update-ref refs/heads/main "$c" "$main" || exit 1
  touch "$GH_STUB_DIR/merged-$n"; echo "$n" >> "$GH_STUB_DIR/merges"; exit 0
fi
if [ "$1" = "api" ]; then
  shift; echo "$*" >> "$GH_STUB_DIR/api"
  case "$1" in */check-runs*) sha=$(echo "$1" | sed -E 's|.*/commits/([0-9a-f]+)/check-runs.*|\1|'); cat "$GH_STUB_DIR/ci-$sha" 2>/dev/null ;; esac
  exit 0
fi
if [ "$1 $2" = "workflow run" ]; then
  echo "$*" >> "$GH_STUB_DIR/attempts"
  [ -f "$GH_STUB_DIR/dispatch-hangs" ] && exec sleep 30
  [ -f "$GH_STUB_DIR/dispatch-fails" ] && { echo "HTTP 403: Resource not accessible by integration" >&2; exit 1; }
  echo "$*" >> "$GH_STUB_DIR/dispatches"
  ref=""; prev=""; for a in "$@"; do [ "$prev" = "--ref" ] && ref="$a"; prev="$a"; done
  echo "$ref $((9000 + $(wc -l < "$GH_STUB_DIR/dispatches")))" >> "$GH_STUB_DIR/runs"
  exit 0
fi
if [ "$1 $2" = "run list" ]; then
  ref=""; prev=""; for a in "$@"; do [ "$prev" = "--branch" ] && ref="$a"; prev="$a"; done
  [ -f "$GH_STUB_DIR/runs" ] && sed -n "s|^$ref ||p" "$GH_STUB_DIR/runs" | tail -1
  exit 0
fi
if [ "$1 $2" = "run view" ]; then
  echo "$3" >> "$GH_STUB_DIR/views"
  if [ -f "$GH_STUB_DIR/view-appends" ]; then cat "$GH_STUB_DIR/view-appends" >> "$GH_STUB_SHADOW_LOG"; rm -f "$GH_STUB_DIR/view-appends"; fi
  if [ -f "$GH_STUB_DIR/view-rewrites" ]; then cat "$GH_STUB_DIR/view-rewrites" > "$GH_STUB_SHADOW_LOG"; rm -f "$GH_STUB_DIR/view-rewrites"; fi
  if [ -f "$GH_STUB_DIR/run-$3" ]; then cat "$GH_STUB_DIR/run-$3"; else echo pending; fi
  exit 0
fi
echo "gh stub: unexpected: $*" >&2; exit 1
STUB
chmod +x "$T/bin/gh"
export PATH="$T/bin:$PATH"
pr() { echo "$1 $2 main https://github.com/owner/repo/pull/$1" > "$GH_STUB_DIR/pr-$1"; git push -q -f origin "$2:refs/pull/$1/head" 2>/dev/null; }

# ── The green record ─────────────────────────────────────────────────────────────────────────────────────────────
expect 1 "merge check: nothing recorded yet is not covered" "no green \`test-all.sh --all\` run is recorded" -- bash "$MERGE_CHECK" --head "$C1"

git checkout -q -b feature
echo "feature" > feature.txt && git add feature.txt && git commit -q -m f1 && git push -q origin feature 2>/dev/null
F1=$(git rev-parse HEAD)
echo "stray" > stray.txt
expect 0 "record: an untracked file means the tree is not the commit: nothing recorded" "Not recorded for the merge gate: the tree was not a commit" -- bash scripts/test-all.sh --all
rm stray.txt
echo "edit" >> notes.txt
expect 0 "record: a modified tracked file: nothing recorded" "Not recorded for the merge gate: the tree was not a commit" -- bash scripts/test-all.sh --all
git checkout -q -- notes.txt
expect 0 "record: without --all nothing is recorded" "every check passed" -- bash scripts/test-all.sh
[ ! -s "$GREEN" ] && ok "record: ...and the log is still empty" || bad "record: the log has lines after runs that must not record"
expect 0 "record: a commit made during the run is not recorded" "HEAD moved during the run" -- env STUB_COMMIT_DURING_RUN=1 bash scripts/test-all.sh --all
git reset -q --hard "$F1"
expect 0 "record: an --all run on a clean committed tree is recorded" "Recorded $(git rev-parse --short "$F1") as green" -- bash scripts/test-all.sh --all
LINE=$(tail -n 1 "$GREEN")
read -r ts commit tree wall <<< "$LINE"
if [ "$commit" = "$F1" ] && [ "$tree" = "$(git rev-parse "$F1^{tree}")" ] && [ "$wall" = "7" ] && [ "$ts" -gt 1700000000 ]; then
  ok "record: the line is <epoch> <commit> <tree> <wall-seconds>"
else
  bad "record: unexpected line: $LINE"
fi
[ "$(dirname "$GREEN")" = "$(cd "$W" && git rev-parse --path-format=absolute --git-common-dir)" ] && ok "record: kept in the git common dir" || bad "record: not in the common dir"

# ── test-all-merge-check.sh ──────────────────────────────────────────────────────────────────────────────────────
expect 0 "merge check: a green run of the PR head, with main not moved since, covers it" "is covered by green run $(git rev-parse --short "$F1")" -- bash "$MERGE_CHECK" --head "$F1"
git checkout -q main
echo "line two" >> notes.txt && git commit -q -am c2 && git push -q origin main 2>/dev/null
C2=$(git rev-parse HEAD)
expect 1 "merge check: main gained a commit since the green run: not covered" "is missing 1 commit(s) that have landed on origin/main" -- bash "$MERGE_CHECK" --head "$F1"
pr 7 "$F1"
expect 1 "merge check (PR form, through gh): the same" "PR #7 into main is not covered" -- bash "$MERGE_CHECK" 7

# ── test-all-pr.sh ───────────────────────────────────────────────────────────────────────────────────────────────
: > "$GH_STUB_DIR/api"
expect 0 "test-all-pr: merges origin/main with the PR head in a scratch worktree and runs test-all --all" "posted \"local test-all --all\" on PR #7" -- bash "$PR_SCRIPT" 7
MERGED=$(tail -n 1 "$GREEN" | cut -d' ' -f2)
if git merge-base --is-ancestor "$F1" "$MERGED" && git merge-base --is-ancestor "$C2" "$MERGED"; then
  ok "test-all-pr: the green record is the PR head merged with current main"
else
  bad "test-all-pr: the recorded commit $MERGED is not main + the PR"
fi
API=$(cat "$GH_STUB_DIR/api")
case "$API" in
  *"repos/owner/repo/statuses/$F1"*"state=success"*"context=local test-all --all"*"description=green: origin/main $(echo "$C2" | cut -c1-9) + this head, tree "*", 7s"*)
    ok "test-all-pr: the status is on the PR head, context \"local test-all --all\", naming main's commit, the tree and the wall time" ;;
  *) bad "test-all-pr: unexpected status call: $API" ;;
esac
[ "$(git worktree list | wc -l | tr -d ' ')" = "1" ] && ok "test-all-pr: the scratch worktree is removed" || { bad "test-all-pr: a scratch worktree was left"; git worktree list; }
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] && git diff --quiet && ok "test-all-pr: the calling checkout is untouched" || bad "test-all-pr: the calling checkout changed"
expect 0 "merge check: now covered, by the merged run" "PR #7 into main is covered by green run $(git rev-parse --short "$MERGED")" -- bash "$MERGE_CHECK" 7

# Landing the PR with a merge commit adds no non-merge commit the green run lacks, so it stays covered; a squash would not.
git merge -q --no-ff -m "Merge PR #7" "$F1" && git push -q origin main 2>/dev/null
expect 0 "merge check: a merge commit on main that brings nothing new keeps it covered" "is covered" -- bash "$MERGE_CHECK" 7
echo "line three" >> notes.txt && git commit -q -am c3 && git push -q origin main 2>/dev/null
expect 1 "merge check: another commit on main uncovers it" "is missing 1 commit(s)" -- bash "$MERGE_CHECK" 7

# A red run posts nothing and records nothing.
git checkout -q -b red "$C1"
echo x > FAIL && git add FAIL && git commit -q -m "fails" && git push -q origin red 2>/dev/null
pr 8 "$(git rev-parse HEAD)"
: > "$GH_STUB_DIR/api"; BEFORE=$(wc -l < "$GREEN")
expect 1 "test-all-pr: a failing test-all fails, and posts nothing" "test-all --all failed on PR #8" -- bash "$PR_SCRIPT" 8
[ ! -s "$GH_STUB_DIR/api" ] && [ "$(wc -l < "$GREEN")" = "$BEFORE" ] && ok "test-all-pr: ...no status call, no record" || bad "test-all-pr: a red run posted or recorded"
RED=$(git rev-parse HEAD)
git checkout -q main
expect 0 "record: a green run of main as it stands" "Recorded $(git rev-parse --short HEAD) as green" -- bash scripts/test-all.sh --all
expect 1 "merge check: a green run with all of main but not the PR head does not cover it" "does not contain the PR head $(git rev-parse --short "$RED")" -- bash "$MERGE_CHECK" 8

# A PR that conflicts with main is refused before anything runs.
git checkout -q -b clash "$C1"
echo "a different line two" >> notes.txt && git commit -q -am "clashes with c2" && git push -q origin clash 2>/dev/null
pr 9 "$(git rev-parse HEAD)"
expect 1 "test-all-pr: a PR that does not merge cleanly with main is refused" "does not merge cleanly with origin/main" -- bash "$PR_SCRIPT" 9
[ "$(git worktree list | wc -l | tr -d ' ')" = "1" ] && ok "test-all-pr: ...and its scratch worktree is removed too" || bad "test-all-pr: a scratch worktree was left after a conflict"

# A green run of a branch stacked on the PR contains the PR head and all of main, but it is not what landing the PR
# alone produces: B's extra commit could mask something A breaks. Only a run of exactly A merged with main covers A.
git checkout -q -b stack-a main
echo "a" > stack-a.txt && git add stack-a.txt && git commit -q -m "stack A" && git push -q origin stack-a 2>/dev/null
SA=$(git rev-parse HEAD)
git checkout -q -b stack-b
echo "b" > stack-b.txt && git add stack-b.txt && git commit -q -m "stack B, on A" && git push -q origin stack-b 2>/dev/null
SB=$(git rev-parse HEAD)
git checkout -q main
echo "line four" >> notes.txt && git commit -q -am c4 && git push -q origin main 2>/dev/null
git checkout -q -b stack-g "$SB" && git merge -q --no-edit main
expect 0 "record: a green run of the stacked branch B merged with main" "Recorded $(git rev-parse --short HEAD) as green" -- bash scripts/test-all.sh --all
expect 1 "merge check: a green run of a branch stacked on the PR does not cover the PR under it" "tested a different tree than this PR merged with main" -- bash "$MERGE_CHECK" --head "$SA"
git checkout -q -b stack-a-landed main && git merge -q --no-edit "$SA"
expect 0 "record: a green run of A merged with main" "Recorded $(git rev-parse --short HEAD) as green" -- bash scripts/test-all.sh --all
expect 0 "merge check: ...which covers A" "is covered by green run $(git rev-parse --short HEAD)" -- bash "$MERGE_CHECK" --head "$SA"
git checkout -q main

expect 1 "merge check: an unknown head is not covered" "is not in this repository" -- bash "$MERGE_CHECK" --head 0123456789abcdef0123456789abcdef01234567

# A --single-branch clone's fetch refspec does not cover main: `git fetch origin main` succeeds and writes no
# origin/main, and a missing ref must not read as "main has nothing the green run lacks". feature (F1) is behind main.
git clone -q --single-branch --branch feature "$T/origin.git" "$T/single" 2>/dev/null
cd "$T/single" || exit 1
echo "$(date +%s) $F1 $(git rev-parse "$F1^{tree}") 1" >> "$(git rev-parse --path-format=absolute --git-common-dir)/test-all-green"
git rev-parse --verify -q origin/main >/dev/null && bad "single-branch: the clone already has origin/main, so this tests nothing" || ok "single-branch: the clone has no origin/main"
expect 1 "merge check in a --single-branch clone: main moved past the green run, so not covered" "is missing" -- bash "$MERGE_CHECK" --head "$F1"
cd "$W" || exit 1

# ── test-all-train.sh: the merge train ─────────────────────────────────────────────────────────────────────────────
# Its own bare origin and clone. The clone's test-all.sh is a stub that sources the real test-all-lib.sh: a committed
# FAIL-<suite> file fails it the way server_suites fails (an .rc and a "Server suites failed:" line in a kept log dir),
# an UNFINISHED-<check> file leaves that check's log with no .rc (killed part-way), a SUMMARY-RED file fails fail_summary
# beside it, and its run-server-suites.mjs fails SERVER_SUITES_ONLY's suites that have a FAIL-<suite> file. Like the real
# runner, a name with no apps/server/src/<name>.ts is no suite, and when no name is one it exits 2 ("matched no run").
# gh is the stub above; a PR's branch on origin is its head.
# TEST_ALL_RECHECK names a stub recheck: real red (exit 1) or load (exit 0).
git init -q --bare "$T/torigin.git"
git clone -q "$T/torigin.git" "$T/train" 2>/dev/null
cd "$T/train" || exit 1
mkdir -p scripts apps/pwa/words
cp "$REPO_ROOT/scripts/test-all-lib.sh" scripts/
cat > scripts/test-all.sh <<'STUB'
#!/bin/bash
cd "$(dirname "$0")/.." || exit 1
. scripts/test-all-lib.sh
[ "$1" = "--all" ] && green_run_start
fail=$(ls FAIL-* 2>/dev/null | sed 's/^FAIL-//' | tr '\n' ' ')
if [ -n "$fail" ]; then
  L=$(mktemp -d); echo 0 > "$L/build.rc"; echo 1 > "$L/server_suites.rc"
  for u in $(ls UNFINISHED-* 2>/dev/null | sed 's/^UNFINISHED-//'); do echo "started" > "$L/$u.log"; done
  [ -f SUMMARY-RED ] && { echo 1 > "$L/fail_summary.rc"; echo "summary self-test: FAIL" > "$L/fail_summary.log"; }
  echo "❌ Server suites failed: $fail" > "$L/server_suites.log"
  echo "stub test-all: FAIL"; echo "Full logs of every check kept in $L"; exit 1
fi
echo "stub test-all: every check passed"
[ "$1" = "--all" ] && record_green_run 7
exit 0
STUB
cat > scripts/run-server-suites.mjs <<'STUB'
import { existsSync } from 'node:fs';
const only = (process.env.SERVER_SUITES_ONLY || '').split(/\s+/).filter(Boolean);
const names = only.filter((n) => existsSync(`apps/server/src/${n}.ts`));
if (only.length && !names.length) { console.log(`❌ SERVER_SUITES_ONLY matched no run: ${only.join(' ')}`); process.exit(2); }
const failed = names.filter((n) => existsSync(`FAIL-${n}`));
if (failed.length) { console.log(`Server suites failed: ${failed.join(' ')}`); process.exit(1); }
console.log(`Server suites: ${names.length}/${names.length} passed`);
STUB
# catalog <file> <draftedBy> <updated> <key=value…>: a word catalog, written as the repo writes them (2 spaces, newline)
catalog() {
  node -e 'const [f, d, u, ...kv] = process.argv.slice(1); const o = { _meta: { language: "fr", draftedBy: d, updated: u } };
    for (const p of kv) { const i = p.indexOf("="); o[p.slice(0, i)] = p.slice(i + 1); }
    require("fs").writeFileSync(f, JSON.stringify(o, null, 2) + "\n");' "$@"
}
catalog apps/pwa/words/fr.json "base" "2026-10-01" "Hello=Bonjour" "Bye=Au revoir"
echo "line one" > notes.txt
mkdir -p apps/server/src && for s in test-x test-u test-load; do echo "// $s" > "apps/server/src/$s.ts"; done
git add scripts apps notes.txt && git commit -q -m t0 && git push -q origin main 2>/dev/null
TJ="$(git rev-parse --path-format=absolute --git-common-dir)/test-all-queue/journal.log"
export GH_STUB_ORIGIN="$T/torigin.git"
TRAIN="$REPO_ROOT/scripts/test-all-train.sh"
REAL_RED="$T/recheck-real.sh"; echo 'echo "recheck stub: real red"; exit 1' > "$REAL_RED"
LOAD="$T/recheck-load.sh"; echo 'echo "recheck stub: every failure passed alone"; exit 0' > "$LOAD"
export TEST_ALL_RECHECK="$REAL_RED"

# branch <PR> <branch> [<labels>] -- <command…>: a branch from origin/main whose one commit is what <command> changes,
# pushed and opened as PR <PR>
branch() {
  local n=$1 b=$2 labels=$3; shift 4
  git fetch -q origin && git checkout -q -B "$b" origin/main && "$@" && git add -A . && git commit -q -m "$b" || return 1
  git push -q -f origin "$b:refs/heads/$b" "$b:refs/pull/$n/head" 2>/dev/null
  echo "$n $(git rev-parse HEAD) main https://github.com/owner/repo/pull/$n" > "$GH_STUB_DIR/pr-$n"
  echo "$b false OPEN $labels" > "$GH_STUB_DIR/prx-$n"
}
add() { echo "$2" > "$1"; }
origin_main() { git --git-dir="$T/torigin.git" rev-parse refs/heads/main; }
on_main() { git --git-dir="$T/torigin.git" show "refs/heads/main:$1" 2>/dev/null; }
merges() { tr '\n' ' ' < "$GH_STUB_DIR/merges" 2>/dev/null | sed 's/ $//'; }

expect 2 "train: more than four PRs is refused" "a train carries at most 4 PRs" -- bash "$TRAIN" 1 2 3 4 5

branch 21 t-a "" -- add a.txt a
branch 22 t-b "" -- add b.txt b
branch 23 t-c "" -- add c.txt c
M0=$(origin_main)
expect 0 "train --no-merge: three PRs tested together, nothing merged" "WOULD MERGE" -- bash "$TRAIN" 21 22 23 --no-merge
[ "$(origin_main)" = "$M0" ] && ok "train --no-merge: ...and main has not moved" || bad "train --no-merge: main moved"
expect 0 "train: three PRs green in one run, merged in order" "train: #21 #22 #23 merged" -- bash "$TRAIN" 21 22 23
[ "$(merges)" = "21 22 23" ] && ok "train: ...squashed one at a time, in the order given" || bad "train: merged \"$(merges)\", not 21 22 23"
[ "$(on_main a.txt)$(on_main b.txt)$(on_main c.txt)" = "abc" ] && ok "train: ...and main has all three" || bad "train: main lacks a PR's file"
GOT=$(bash "$TRAIN" 21 2>&1); grep -qF "DROPPED: it is MERGED" <<<"$GOT" && ok "train: a merged PR is dropped" || { bad "train: a merged PR was not dropped"; echo "$GOT" | tail -5; }
[ "$(git worktree list | wc -l | tr -d ' ')" = "1" ] && ok "train: its scratch worktree is removed" || { bad "train: a scratch worktree was left"; git worktree list; }

: > "$GH_STUB_DIR/merges"
branch 24 t-clash1 "" -- add notes.txt "line one, as #24 has it"
branch 25 t-clash2 "" -- add notes.txt "line one, as #25 has it"
expect 1 "train: a PR that conflicts with one before it is dropped, never resolved" "#25: DROPPED: it does not merge with main and the PRs before it (conflicts outside the word catalogs: notes.txt)" -- bash "$TRAIN" 24 25
[ "$(merges)" = "24" ] && [ "$(on_main notes.txt)" = "line one, as #24 has it" ] && ok "train: ...the other is merged" || bad "train: merged \"$(merges)\", notes.txt: $(on_main notes.txt)"

: > "$GH_STUB_DIR/merges"
branch 26 t-d "" -- add d.txt d
branch 27 t-red "" -- add FAIL-test-x red
branch 28 t-e "" -- add e.txt e
OUT=$(bash "$TRAIN" 26 27 28 2>&1); RC=$?
[ $RC = 1 ] && ok "train: a red member: the train exits 1" || { bad "train: a red member: exit $RC"; echo "$OUT" | tail -15 | sed 's/^/      /'; }
grep -qE '#27: RED: it fails test-x with main alone \(.*/alone-pr27\.log\)' <<<"$OUT" && ok "train: ...the failing suite, run alone on main + each PR, names #27, with its log" || { bad "train: #27 not named"; echo "$OUT" | tail -15 | sed 's/^/      /'; }
LOG27=$(sed -nE 's/.*#27: RED: .*\((.*alone-pr27\.log)\).*/\1/p' <<<"$OUT" | head -1)
grep -qF "Server suites failed: test-x" "$LOG27" 2>/dev/null && ok "train: ...and that log is the suite failing" || bad "train: the named log ($LOG27) does not show the failure"
grep -qF "train: #26 #28 merged" <<<"$OUT" && [ "$(merges)" = "26 28" ] && ok "train: ...while the innocents #26 and #28 are merged" || bad "train: merged \"$(merges)\""
[ -z "$(on_main FAIL-test-x)" ] && [ "$(on_main d.txt)$(on_main e.txt)" = "de" ] && ok "train: ...and main has theirs and not the culprit's" || bad "train: main's files are wrong after a red member"
# Merging the innocents of a red run is a waiver: one line each in the queue's journal, as the recheck (v2) writes them.
# The green trains before this wrote none.
JL=$(grep -cE '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2} pr=(26|28) GREEN-BY-BISECT waived: suite test-x \(red in the train.s full run of #26 #27 #28; fails them alone: #27; passes them alone, and #26 #28 together; logs ' "$TJ" 2>/dev/null)
[ "$JL" = 2 ] && [ "$(wc -l < "$TJ" | tr -d ' ')" = 2 ] && ok "train: ...each innocent merged after the bisect is journalled as a waiver, and nothing else is" || { bad "train: the journal after a bisect merge ($TJ):"; cat "$TJ" 2>/dev/null | sed 's/^/      /'; }

# A failing suite that one PR adds is not on main + the other PR: that PR is not run on it (the real runner exits 2 on a
# name that is no suite), is not named RED for it, and merges.
: > "$GH_STUB_DIR/merges"
branch 50 t-newsuite "" -- sh -c 'echo "// test-new" > apps/server/src/test-new.ts; echo red > FAIL-test-new'
branch 51 t-n1 "" -- add n1.txt n1
OUT=$(bash "$TRAIN" 50 51 2>&1)
grep -qF "not on this tree, so not run (not a failure): suite test-new" <<<"$OUT" && ok "train: a failing suite one PR adds: the other PR's tree has none, and the train says it is not run there" || { bad "train: no line for the suite missing from #51's tree"; echo "$OUT" | tail -15 | sed 's/^/      /'; }
grep -qE '#50: RED: it fails test-new with main alone' <<<"$OUT" && grep -qF "train: #51 merged" <<<"$OUT" && [ "$(merges)" = "51" ] && ok "train: ...#50 is named RED and #51 merges" || { bad "train: merged \"$(merges)\" with a suite only #50 has"; echo "$OUT" | tail -15 | sed 's/^/      /'; }
grep -qE ' pr=51 GREEN-BY-BISECT waived: suite test-new ' "$TJ" && ok "train: ...journalled as a waiver" || bad "train: no waiver line for #51"

# A red fail_summary (a self-test of its own, not the run's report) beside a red suite: the bisect cannot run it alone,
# so nothing merges, not even the PRs that pass the suite.
branch 52 t-sumred "" -- add SUMMARY-RED x
branch 53 t-red2 "" -- add FAIL-test-x red
branch 54 t-p2 "" -- add p2.txt p2
OUT=$(bash "$TRAIN" 52 53 54 --no-merge 2>&1); RC=$?
[ $RC = 1 ] && grep -qF "red in fail_summary, which the train cannot run alone" <<<"$OUT" && ! grep -qF "WOULD MERGE" <<<"$OUT" \
  && ok "train: a red fail_summary beside a red suite: nothing merges" || { bad "train: a red fail_summary let a PR through (exit $RC)"; echo "$OUT" | tail -15 | sed 's/^/      /'; }

# Both PRs add a key after "Hello" and append a note to _meta.draftedBy: the lines clash, the keys do not. #30 then
# conflicts with main once #29 has landed, so the train merges main into #30's branch per key and pushes that first.
: > "$GH_STUB_DIR/merges"
branch 29 t-cat "" -- catalog apps/pwa/words/fr.json "base; #29 note" "2026-10-30" "Hello=Bonjour" "Cat=Chat" "Bye=Au revoir"
branch 30 t-dog "" -- catalog apps/pwa/words/fr.json "base; #30 note" "2026-10-31" "Hello=Bonjour" "Dog=Chien" "Bye=Au revoir"
H30=$(git rev-parse t-dog)
git merge-tree --write-tree t-cat t-dog >/dev/null 2>&1 && bad "train: the two catalogs do not conflict, so this tests nothing" || ok "train: two PRs whose catalog lines conflict"
expect 0 "train: a conflict only in word catalogs is merged per key, and both PRs merge" "train: #29 #30 merged" -- bash "$TRAIN" 29 30
GOTCAT=$(on_main apps/pwa/words/fr.json | node -e 'const o = JSON.parse(require("fs").readFileSync(0, "utf8")); console.log(Object.keys(o).join(","), "|", o._meta.draftedBy, "|", o._meta.updated, "|", o.Cat, o.Dog, o.Hello, o.Bye)')
[ "$GOTCAT" = "_meta,Hello,Dog,Cat,Bye | base; #29 note; #30 note | 2026-10-31 | Chat Chien Bonjour Au revoir" ] \
  && ok "train: ...nothing lost: every key, both draftedBy notes, the later date" || bad "train: main's catalog after the train: $GOTCAT"
NEW30=$(git --git-dir="$T/torigin.git" rev-parse refs/heads/t-dog)
[ "$(git --git-dir="$T/torigin.git" rev-parse "$NEW30^1")" = "$H30" ] && ok "train: ...#30's branch got main merged in on top of its head (a fast-forward push)" || bad "train: #30's branch is $NEW30, not a merge on $H30"
node "$REPO_ROOT/scripts/words-merge-3way.mjs" --base t-dog --main t-dog --pr t-dog --verify apps/pwa/words/fr.json >/dev/null 2>&1 && ok "words-merge-3way: --verify passes an unchanged catalog" || bad "words-merge-3way: --verify failed an unchanged catalog"
ln -s "$REPO_ROOT/scripts" "$T/linked-scripts"
GOTLINK=$(node "$T/linked-scripts/words-merge-3way.mjs" --nonsense 2>&1; echo "rc=$?")
case "$GOTLINK" in *"unexpected argument"*"rc=2") ok "words-merge-3way: reached through a symlink it still runs (a Mac's temp dir is one), and does not exit 0 having done nothing" ;; *) bad "words-merge-3way: through a symlink it did not run: $GOTLINK" ;; esac
: > "$GH_STUB_DIR/merges"
branch 37 t-bonjour1 "" -- catalog apps/pwa/words/fr.json "base; #29 note; #30 note" "2026-10-31" "Hello=Salut" "Dog=Chien" "Cat=Chat" "Bye=Au revoir"
branch 38 t-bonjour2 "" -- catalog apps/pwa/words/fr.json "base; #29 note; #30 note" "2026-10-31" "Hello=Coucou" "Dog=Chien" "Cat=Chat" "Bye=Au revoir"
expect 1 "train: two PRs that change the same key differently: the second is dropped, not merged" "#38: DROPPED: it does not merge with main and the PRs before it (word catalogs that cannot be merged per key: apps/pwa/words/fr.json: both sides changed \"Hello\"" -- bash "$TRAIN" 37 38
# One PR removes "Cat", the next changes it: the change must not vanish under the removal.
branch 44 t-nocat "" -- catalog apps/pwa/words/fr.json "base; #29 note; #30 note" "2026-10-31" "Hello=Salut" "Dog=Chien" "Bye=Au revoir"
branch 45 t-minou "" -- catalog apps/pwa/words/fr.json "base; #29 note; #30 note" "2026-10-31" "Hello=Salut" "Dog=Chien" "Cat=Minou" "Bye=Au revoir"
git merge-tree --write-tree t-nocat t-minou >/dev/null 2>&1 && bad "train: removing and changing \"Cat\" do not conflict, so this tests nothing" || ok "train: a PR that removes a key and one that changes it conflict"
expect 1 "train: a key removed by one PR and changed by the next: the second is dropped, its change not lost" "#45: DROPPED: it does not merge with main and the PRs before it (word catalogs that cannot be merged per key: apps/pwa/words/fr.json: main removed \"Cat\", which the PR changed" -- bash "$TRAIN" 44 45 --no-merge
GOTK=$(M="$REPO_ROOT/scripts/words-merge-3way.mjs" node --input-type=module -e 'const { mergeCatalog } = await import(process.env.M);
  const b = { Hello: "Bonjour", Bye: "Au revoir" }, m = { Hello: "Bonjour" };
  console.log(JSON.stringify(mergeCatalog("fr.json", b, m, b)), JSON.stringify(mergeCatalog("fr.json", b, b, m)));' 2>&1)
[ "$GOTK" = '{"Hello":"Bonjour"} {"Hello":"Bonjour"}' ] && ok "words-merge-3way: a key one side removed and the other left alone stays removed" || bad "words-merge-3way: removed-and-unchanged gave $GOTK"
# Two PRs add the same key with different words, three lines apart: git merges that with no conflict, and the file holds
# the key twice (JSON.parse would keep the PR's word alone). The second PR is dropped.
: > "$GH_STUB_DIR/merges"
branch 55 t-de "" -- catalog apps/pwa/words/de.json "base" "2026-10-01" "Hello=Hallo" "One=Eins" "Two=Zwei" "Three=Drei" "Bye=Tschuess"
expect 0 "train: a new catalog merges (for the next check)" "train: #55 merged" -- bash "$TRAIN" 55
branch 56 t-katze "" -- catalog apps/pwa/words/de.json "base" "2026-10-01" "Hello=Hallo" "Cat=Katze" "One=Eins" "Two=Zwei" "Three=Drei" "Bye=Tschuess"
branch 57 t-mieze "" -- catalog apps/pwa/words/de.json "base" "2026-10-01" "Hello=Hallo" "One=Eins" "Two=Zwei" "Three=Drei" "Bye=Tschuess" "Cat=Mieze"
git merge-tree --write-tree t-katze t-mieze >/dev/null 2>&1 && ok "train: two PRs adding \"Cat\" apart merge with no conflict in git" || bad "train: the two \"Cat\" catalogs conflict, so this tests nothing"
expect 1 "train: ...the same key twice in a catalog git merged: the second PR is dropped" "#57: DROPPED: it does not merge with main and the PRs before it (word catalogs that cannot be merged per key: apps/pwa/words/de.json: \"Cat\" written twice after the merge" -- bash "$TRAIN" 56 57 --no-merge
GOTV=$(M="$REPO_ROOT/scripts/words-merge-3way.mjs" node --input-type=module -e 'const { verifyCatalog } = await import(process.env.M);
  const b = { Hello: "Hallo" }, o = { _meta: { updated: "x" }, ...b };
  console.log(verifyCatalog("de.json", o, o, o, JSON.stringify(o, null, 2) + "\n").length, verifyCatalog("de.json", o, o, o, JSON.stringify(o, null, 4) + "\n").join(""));' 2>&1)
[ "$GOTV" = "0 de.json: not written as the catalogs are (2-space JSON, one newline at the end) after the merge" ] && ok "words-merge-3way: --verify passes a catalog as the repo writes it, and refuses one written any other way" || bad "words-merge-3way: verify gave $GOTV"

: > "$GH_STUB_DIR/merges"
branch 31 t-tier "tier-A,security" -- add f.txt f
branch 32 t-plain "" -- add g.txt g
branch 33 t-ledger "" -- sh -c 'mkdir -p packages/beanpool-core/src && echo x > packages/beanpool-core/src/ledger.ts'
branch 39 t-escrow "" -- sh -c 'mkdir -p apps/server/src/db && echo "db.prepare(\`UPDATE accounts SET balance = balance + ?\`)" > apps/server/src/db/db.ts'
OUT=$(bash "$TRAIN" 31 32 33 39 2>&1)
grep -qF "#31: RIDES ALONE: it is labelled tier-A" <<<"$OUT" && ok "train: a tier-A PR is refused a train" || { bad "train: the tier-A PR rode"; echo "$OUT" | tail -12 | sed 's/^/      /'; }
grep -qF "#33: RIDES ALONE: it touches ledger or money paths (packages/beanpool-core/src/ledger.ts)" <<<"$OUT" && ok "train: ...so is one touching core's ledger" || bad "train: the ledger PR rode"
grep -qF "#39: RIDES ALONE: it changes a line that moves Beans" <<<"$OUT" && ok "train: ...and one changing a line that writes a balance" || bad "train: the balance-writing PR rode"
[ "$(merges)" = "32" ] && ok "train: ...while the plain PR merges" || bad "train: merged \"$(merges)\", not 32"
expect 0 "train: a tier-A PR alone is a train of one" "train: #31 merged" -- bash "$TRAIN" 31
branch 48 t-lower "" -- sh -c 'mkdir -p apps/server/src/routes && echo "db.prepare(\"update accounts set last_updated_at = ?, balance = ? where public_key = ?\")" > apps/server/src/routes/members.ts'
branch 49 t-plain2 "" -- add j.txt j
expect 1 "train: a balance write in lower case, another column first, rides alone too" "#48: RIDES ALONE: it changes a line that moves Beans" -- bash "$TRAIN" 48 49 --no-merge
# Given with a merged PR and one GitHub holds, the tier-A PR is the only one still riding: a train of one.
branch 46 t-tier2 "tier-A" -- add k.txt k
branch 47 t-cired2 "" -- add l.txt l
echo "failure" > "$GH_STUB_DIR/ci-$(git rev-parse t-cired2)"
OUT=$(bash "$TRAIN" 46 47 21 --no-merge 2>&1)
grep -qF "#46: WOULD MERGE" <<<"$OUT" && ! grep -qF "RIDES ALONE" <<<"$OUT" && ok "train: a tier-A PR whose companions were dropped or held rides, alone" || { bad "train: the tier-A PR was left out with no PR riding beside it"; echo "$OUT" | tail -8 | sed 's/^/      /'; }

: > "$GH_STUB_DIR/merges"
branch 34 t-cired "" -- add h.txt h
branch 35 t-cipending "" -- add i.txt i
echo "failure" > "$GH_STUB_DIR/ci-$(git rev-parse t-cired)"
echo "pending" > "$GH_STUB_DIR/ci-$(git rev-parse t-cipending)"
expect 1 "train: a red GitHub Test-All on a PR's head holds it" "#34: HELD: GitHub's \"Run BeanPool Test-All Pipeline\" is red" -- bash "$TRAIN" 34 35
[ "$(merges)" = "35" ] && ok "train: ...a pending one does not" || bad "train: merged \"$(merges)\", not 35"
grep -qE 'repos/owner/repo/commits/[0-9a-f]{40}/check-runs\?check_name=Run%20BeanPool%20Test-All%20Pipeline' "$GH_STUB_DIR/api" && ok "train: ...read from the head's check-runs, by the required check's name" || bad "train: no check-runs call by name: $(tail -1 "$GH_STUB_DIR/api")"

# Another merge lands on main between two of the train's: main is no longer the tree the train tested, so it stops there.
: > "$GH_STUB_DIR/merges"
branch 40 t-s1 "" -- add s1.txt s1
branch 41 t-s2 "" -- add s2.txt s2
touch "$GH_STUB_DIR/sneak"
expect 3 "train: main moves under it after one merge: it stops (exit 3) and says so" "is not the tested tree" -- bash "$TRAIN" 40 41
[ "$(merges)" = "40" ] && [ -z "$(on_main s2.txt)" ] && ok "train: ...and merges nothing after that" || bad "train: merged \"$(merges)\" after main moved"

# A check that never finished (a log, no .rc) cannot be run alone: nothing merges, though a suite named the culprit.
: > "$GH_STUB_DIR/merges"
branch 42 t-u1 "" -- add u1.txt u1
branch 43 t-u2 "" -- sh -c 'echo red > FAIL-test-u; echo x > UNFINISHED-pwa_wide_pages'
expect 1 "train: a check left unfinished: nothing merges" "red in pwa_wide_pages, which the train cannot run alone" -- bash "$TRAIN" 42 43
[ -z "$(merges)" ] && ok "train: ...not even the innocent" || bad "train: merged \"$(merges)\" with a check unfinished"

# The parts a red run failed, read from test-all's logs as the recheck reads them: an unfinished check is a stage; a vitest
# package runs whole when it has an unhandled error, lists fewer failed files than it counts, or is not vitest at all.
P="$T/parts"; mkdir -p "$P"
echo 0 > "$P/build.rc"; echo 1 > "$P/test.rc"; echo started > "$P/pwa_wide_pages.log"; echo x > "$P/recheck-vitest.log"
printf '%s\n' 'a:test:  ❯ src/a.test.ts (3 tests | 1 failed) 20ms' 'a:test:  Test Files  1 failed | 9 passed (10)' \
  'b:test:  ❯ src/b.test.ts (2 tests | 1 failed) 20ms' 'b:test:  Test Files  2 failed | 1 passed (3)' \
  'c:test:  ❯ src/c.test.ts (2 tests | 1 failed) 20ms' 'c:test:  Test Files  1 failed (1)' 'c:test: ⎯⎯ Unhandled Errors ⎯⎯' \
  '  Failed:    a#test, b#test, c#test, guide#test' > "$P/test.log"
sed -n '/^failing_parts() {/,/^}/p' "$TRAIN" > "$T/failing_parts.sh"
GOTP=$(bash -c '. "$1" && failing_parts "$2"' _ "$T/failing_parts.sh" "$P" | tr '\n' ';')
[ "$GOTP" = "stage pwa_wide_pages;vitest a src/a.test.ts;package b;package c;package guide;" ] \
  && ok "train: a red run's parts: an unfinished check, one vitest file, and three packages run whole" || bad "train: parts read as: $GOTP"
P2="$T/parts2"; mkdir -p "$P2"
echo 1 > "$P2/fail_summary.rc"; echo 1 > "$P2/server_suites.rc"; echo "❌ Server suites failed: test-x" > "$P2/server_suites.log"
GOTP=$(bash -c '. "$1" && failing_parts "$2"' _ "$T/failing_parts.sh" "$P2" | tr '\n' ';')
[ "$GOTP" = "stage fail_summary;suite test-x;" ] && ok "train: a red fail_summary is a stage of its own, beside the red suite" || bad "train: parts with fail_summary red read as: $GOTP"

# run_parts on a tree without some parts: a test file or a package another PR adds is not run and not a failure; a file
# that is here runs. The pnpm stub fails as vitest does on a file that is not there, and as turbo does on no such package.
R="$T/rp"; mkdir -p "$R/apps/pwa/src" "$R/bin"
echo '{"name":"@beanpool/pwa"}' > "$R/apps/pwa/package.json"; echo "// old" > "$R/apps/pwa/src/old.test.ts"
printf '%s\n' 'vitest @beanpool/pwa src/old.test.ts' 'vitest @beanpool/pwa src/new.test.ts' 'package @beanpool/new' 'vitest @beanpool/new src/n.test.ts' > "$R/parts.txt"
printf '%s\n' '#!/bin/bash' 'echo "stub pnpm: $*"; for last; do :; done' \
  'case "$*" in "exec vitest run"*) [ -f "$last" ] || { echo "No test files found, exiting with code 1"; exit 1; } ;; "turbo run test"*) echo "No package found with name ${last#--filter=}"; exit 1 ;; esac' > "$R/bin/pnpm"
chmod +x "$R/bin/pnpm"
sed -n -e '/^install_deps() {/p' -e '/^prepare() {/,/^}/p' -e '/^pkg_dir() {/p' -e '/^run_parts() {/,/^}/p' "$TRAIN" > "$T/run_parts.sh"
GOTR=$(cd "$R" && env PATH="$R/bin:$PATH" LOGS="$R" bash -c '. "$1" && run_parts parts.txt "$2"' _ "$T/run_parts.sh" "$R/alone.log" 2>&1); RCR=$?
NOTRUN=$(grep -c "not on this tree, so not run (not a failure): " <<<"$GOTR")
[ $RCR = 0 ] && [ "$NOTRUN" = 3 ] && grep -qF "stub pnpm: exec vitest run --maxWorkers=1 src/old.test.ts" "$R/alone.log" \
  && [ "$(cat "$R/parts-here.txt" 2>/dev/null)" = "vitest @beanpool/pwa src/old.test.ts" ] \
  && ok "train: run_parts runs the test file that is here, and not (and does not fail) the file and package that are not" \
  || { bad "train: run_parts on a tree without some parts: exit $RCR, $NOTRUN said not run"; echo "$GOTR"; sed 's/^/      /' "$R/alone.log"; }

# ── test-all-train.sh --shadow ───────────────────────────────────────────────────────────────────────────────────────
# The tested tree on a train/* branch of the origin, and ci.yml started on it. No train above asked for one. Whatever happens
# to the shadow, the train's exit and merges are what they would be without it. A hook on the origin refuses a train/* push
# while $GH_STUB_DIR/push-fails exists.
TCOMMON="$(git rev-parse --path-format=absolute --git-common-dir)"
SL="$TCOMMON/test-all-queue/shadow.log"
export GH_STUB_SHADOW_LOG="$SL"
train_refs() { git --git-dir="$T/torigin.git" for-each-ref --format='%(refname:short)' 'refs/heads/train/'; }
attempts() { [ -f "$GH_STUB_DIR/attempts" ] && wc -l < "$GH_STUB_DIR/attempts" | tr -d ' ' || echo 0; }
lines() { [ -f "$SL" ] && wc -l < "$SL" | tr -d ' ' || echo 0; }
cat > "$T/torigin.git/hooks/pre-receive" <<'HOOK'
#!/bin/bash
[ -f "$GH_STUB_DIR/push-fails" ] || exit 0
while read -r _ _ ref; do case "$ref" in refs/heads/train/*) echo "refused"; exit 1 ;; esac; done
HOOK
chmod +x "$T/torigin.git/hooks/pre-receive"

[ "$(attempts)" = 0 ] && [ -z "$(train_refs)" ] && [ ! -e "$SL" ] && ok "shadow: every train above ran without --shadow: nothing pushed, nothing started, no line" \
  || { bad "shadow: a train not asked for one made one"; train_refs; cat "$SL" 2>/dev/null; }

: > "$GH_STUB_DIR/merges"
branch 60 t-sh1 "" -- add sh1.txt sh1
branch 61 t-sh2 "" -- add sh2.txt sh2
OUT=$(bash "$TRAIN" 60 61 --shadow 2>&1); RC=$?
BR=$(train_refs); SHA=$(git --git-dir="$T/torigin.git" rev-parse "refs/heads/$BR" 2>/dev/null); LINE=$(tail -1 "$SL" 2>/dev/null)
[ $RC = 0 ] && [ "$(merges)" = "60 61" ] && ok "shadow: a green train with --shadow merges as any other" || { bad "shadow: exit $RC, merged \"$(merges)\""; echo "$OUT" | tail -12 | sed 's/^/      /'; }
case "$BR" in train/*) ok "shadow: the tree is pushed to a train/* branch" ;; *) bad "shadow: branches on origin: $BR" ;; esac
[ "$(tail -1 "$TCOMMON/test-all-green" | cut -d' ' -f2)" = "$SHA" ] && [ -z "$(git --git-dir="$T/torigin.git" diff --name-only "$SHA" refs/heads/main)" ] \
  && ok "shadow: ...and that is the commit the local run tested, main + both PRs" || bad "shadow: $SHA is not the tested tree"
[ "$(tail -1 "$GH_STUB_DIR/dispatches" 2>/dev/null)" = "workflow run ci.yml --repo owner/repo --ref $BR" ] && ok "shadow: ci.yml is started on that branch" || bad "shadow: dispatched: $(tail -1 "$GH_STUB_DIR/dispatches" 2>/dev/null)"
grep -qE "^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2} prs=60,61 sha=$SHA run=9001 local=green branch=$BR\$" <<<"$LINE" \
  && ok "shadow: one line: time, PRs, tested sha, run id, local verdict" || bad "shadow: the line is: $LINE"

branch 62 t-shred "" -- add FAIL-test-x red
expect 1 "shadow: a red run" "RED: it fails test-x" -- bash "$TRAIN" 62 --shadow --no-merge
grep -qE " prs=62 .* local=red " <<<"$(tail -1 "$SL")" && ok "shadow: ...local=red" || bad "shadow: red run's line: $(tail -1 "$SL")"
expect 0 "shadow: a red run the load recheck passes" "load recheck: every failure passed alone" -- env TEST_ALL_RECHECK="$LOAD" bash "$TRAIN" 62 --shadow --no-merge
grep -qE " prs=62 .* local=green-by-recheck " <<<"$(tail -1 "$SL")" && ok "shadow: ...local=green-by-recheck" || bad "shadow: recheck's line: $(tail -1 "$SL")"
branch 63 t-shinno "" -- add shinno.txt i
expect 1 "shadow: a red train whose innocent would merge" "#63: WOULD MERGE" -- bash "$TRAIN" 63 62 --shadow --no-merge
RL=$(tail -1 "$SL"); RS=$(sed -n 's/.* sha=\([0-9a-f]*\) .*/\1/p' <<<"$RL")
grep -qE " prs=63,62 .* local=red " <<<"$RL" && git cat-file -e "$RS:FAIL-test-x" 2>/dev/null \
  && ok "shadow: ...the line is the whole train's tree and verdict, not the innocents' after the bisect" || bad "shadow: bisect's line: $RL"

branch 64 t-fork "" -- add fork.txt fork
echo "t-fork true OPEN " > "$GH_STUB_DIR/prx-64"
branch 65 t-shp "" -- add shp.txt shp
A0=$(attempts); L0=$(lines); R0=$(train_refs | wc -l)
OUT=$(bash "$TRAIN" 64 65 --shadow --no-merge 2>&1); RC=$?
grep -qF "Shadow: left out: #64 comes from a fork" <<<"$OUT" && ok "shadow: a train with a PR from a fork has none, and says so in a line" || { bad "shadow: no line for the fork"; echo "$OUT" | tail -8 | sed 's/^/      /'; }
[ "$(attempts)" = "$A0" ] && [ "$(train_refs | wc -l)" = "$R0" ] && [ "$(lines)" = "$L0" ] && ok "shadow: ...nothing pushed, nothing started, no line" || bad "shadow: a fork's code was pushed or started"
[ $RC = 0 ] && grep -qF "#64: WOULD MERGE" <<<"$OUT" && grep -qF "#65: WOULD MERGE" <<<"$OUT" && ok "shadow: ...and the train is as it would be" || bad "shadow: a fork changed the train (exit $RC)"

: > "$GH_STUB_DIR/merges"
branch 66 t-pf1 "" -- add pf1.txt x
branch 67 t-pf2 "" -- add pf2.txt x
touch "$GH_STUB_DIR/push-fails"; A0=$(attempts)
OUT=$(bash "$TRAIN" 66 67 --shadow 2>&1); RC=$?
rm -f "$GH_STUB_DIR/push-fails"
[ $RC = 0 ] && grep -qF "train: #66 #67 merged" <<<"$OUT" && [ "$(merges)" = "66 67" ] && ok "shadow: a push that fails: the train exits and merges as it would" || { bad "shadow: a failed push changed the train (exit $RC, merged \"$(merges)\")"; echo "$OUT" | tail -12 | sed 's/^/      /'; }
grep -qF "Shadow: could not push" <<<"$OUT" && [ "$(attempts)" = "$A0" ] && grep -qE " prs=66,67 .* run=none local=green " <<<"$(tail -1 "$SL")" \
  && ok "shadow: ...it says so, starts nothing, and the line reads run=none" || { bad "shadow: after a failed push: $(tail -1 "$SL")"; echo "$OUT" | tail -8 | sed 's/^/      /'; }

: > "$GH_STUB_DIR/merges"
branch 68 t-df1 "" -- add df1.txt x
branch 69 t-df2 "" -- add df2.txt x
touch "$GH_STUB_DIR/dispatch-fails"; A0=$(attempts)
OUT=$(SHADOW_RETRY_SECS=0 bash "$TRAIN" 68 69 --shadow 2>&1); RC=$?
rm -f "$GH_STUB_DIR/dispatch-fails"
[ $RC = 0 ] && grep -qF "train: #68 #69 merged" <<<"$OUT" && [ "$(merges)" = "68 69" ] && ok "shadow: a start that fails: the train exits and merges as it would" || { bad "shadow: a failed dispatch changed the train (exit $RC, merged \"$(merges)\")"; echo "$OUT" | tail -12 | sed 's/^/      /'; }
grep -qF "Shadow: could not start ci.yml" <<<"$OUT" && [ "$(attempts)" = $((A0 + 2)) ] && grep -qE " prs=68,69 .* run=none local=green " <<<"$(tail -1 "$SL")" \
  && ok "shadow: ...it says so after a second try, and the line reads run=none" || { bad "shadow: after a failed dispatch ($(attempts) attempts): $(tail -1 "$SL")"; echo "$OUT" | tail -8 | sed 's/^/      /'; }

# A start that hangs is stopped at its limit: a shadow never holds the train (the stub would sleep 30 s, twice).
: > "$GH_STUB_DIR/merges"
branch 90 t-hang "" -- add hang.txt x
touch "$GH_STUB_DIR/dispatch-hangs"
START=$SECONDS
OUT=$(SHADOW_LIMIT_SECS=1 SHADOW_RETRY_SECS=0 bash "$TRAIN" 90 --shadow 2>&1); RC=$?
rm -f "$GH_STUB_DIR/dispatch-hangs"
[ $RC = 0 ] && [ "$(merges)" = "90" ] && [ $((SECONDS - START)) -lt 25 ] && ok "shadow: a start that hangs is stopped, and the train goes on" || { bad "shadow: a hang held the train ($((SECONDS - START)) s, exit $RC, merged \"$(merges)\")"; echo "$OUT" | tail -8 | sed 's/^/      /'; }

# scripts/test-all-shadow.sh against a log and branches of each kind. It fills in results, lists disagreements, and deletes
# only train/* branches whose run is finished or never started.
SHADOWS="$REPO_ROOT/scripts/test-all-shadow.sh"
for b in $(train_refs); do git --git-dir="$T/torigin.git" update-ref -d "refs/heads/$b"; done
OTHERS=$(git --git-dir="$T/torigin.git" for-each-ref --format='%(objectname) %(refname)' | grep -v ' refs/heads/train/')
: > "$SL"
expect 0 "shadow report: an empty log" "No shadows yet" -- bash "$SHADOWS"
M=$(origin_main)
for b in a b c d e f g orphan-done orphan-running orphan-norun; do git --git-dir="$T/torigin.git" update-ref "refs/heads/train/$b" "$M"; done
cat > "$SL" <<EOF
2026-11-01 01:00:00 prs=70,71 sha=$M run=9101 local=green branch=train/a
2026-11-01 01:10:00 prs=72 sha=$M run=9102 local=red branch=train/b
2026-11-01 01:20:00 prs=73 sha=$M run=9103 local=green branch=train/c
2026-11-01 01:30:00 prs=74 sha=$M run=9104 local=green branch=train/d
2026-11-01 01:40:00 prs=75 sha=$M run=none local=green branch=train/e
2026-11-01 01:50:00 prs=76 sha=$M run=unknown local=green-by-recheck branch=train/f
2026-11-01 02:00:00 prs=77 sha=$M run=9107 local=none branch=train/g
EOF
printf '%s\n' "train/f 9106" "train/orphan-done 9108" "train/orphan-running 9109" >> "$GH_STUB_DIR/runs"
echo failure > "$GH_STUB_DIR/run-9101"; echo success > "$GH_STUB_DIR/run-9102"; echo success > "$GH_STUB_DIR/run-9103"
echo success > "$GH_STUB_DIR/run-9106"; echo cancelled > "$GH_STUB_DIR/run-9107"; echo success > "$GH_STUB_DIR/run-9108"
echo "2026-11-01 02:10:00 prs=78 sha=$M run=9110 local=green branch=train/late" > "$GH_STUB_DIR/view-appends"
OUT=$(bash "$SHADOWS" 2>&1); RC=$?
[ $RC = 0 ] && ok "shadow report: runs (a disagreement is a finding, not a failure)" || { bad "shadow report: exit $RC"; echo "$OUT" | tail -12 | sed 's/^/      /'; }
DIS=$(sed -n '/^Disagreements:/,/^$/p' <<<"$OUT")
grep -qF "#70 #71 ${M:0:9} run 9101: Mac green, GitHub failure" <<<"$DIS" && grep -qF "#72 ${M:0:9} run 9102: Mac red, GitHub success" <<<"$DIS" \
  && [ "$(wc -l <<<"$DIS" | tr -d ' ')" = 3 ] && ok "shadow report: lists both disagreements, and nothing else as one" || bad "shadow report: disagreements: $DIS"
grep -q "local=green branch=train/a github=failure$" "$SL" && grep -q "local=red branch=train/b github=success$" "$SL" && grep -q "branch=train/e github=none$" "$SL" \
  && grep -q "branch=train/g github=cancelled$" "$SL" && grep -q "branch=train/d$" "$SL" && ok "shadow report: fills in each finished run's result, and leaves a pending one" || { bad "shadow report: the log:"; sed 's/^/      /' "$SL"; }
grep -q " run=9106 local=green-by-recheck branch=train/f github=success$" "$SL" && ok "shadow report: finds a run the train could not name, by its branch" || bad "shadow report: run=unknown not filled in"
grep -q "branch=train/late$" "$SL" && [ "$(wc -l < "$SL" | tr -d ' ')" = 8 ] && ok "shadow report: a line a train adds while it reads is kept" || bad "shadow report: a train's line was lost"
[ "$(train_refs | sort | tr '\n' ' ')" = "train/d train/orphan-norun train/orphan-running " ] && ok "shadow report: deletes finished and never-started branches; keeps a running one, and one with no line and no finished run" || bad "shadow report: left: $(train_refs | tr '\n' ' ')"
[ "$(git --git-dir="$T/torigin.git" for-each-ref --format='%(objectname) %(refname)' | grep -v ' refs/heads/train/')" = "$OTHERS" ] && ok "shadow report: every other ref is as it was" || bad "shadow report: a ref that is no train branch changed"
: > "$GH_STUB_DIR/views"; cp "$SL" "$T/shadow.before"
bash "$SHADOWS" > /dev/null 2>&1
cmp -s "$SL" "$T/shadow.before" && ! grep -qE '^(9101|9102|9103)$' "$GH_STUB_DIR/views" && ok "shadow report: a second read changes nothing, and does not ask GitHub again about a finished run" || bad "shadow report: second read: views $(tr '\n' ' ' < "$GH_STUB_DIR/views")"

# shadow.log's lock. The reader's swap and a train's line each hold it, so a line cannot go with the old file; a second
# reader's rewrite cannot leave half a line; and a lock left behind holds up neither. The mv stub notes each swap of the log.
cat > "$T/bin/mv" <<STUB
#!/bin/bash
case "\$2" in */shadow.log) if [ -d "\$2.lock" ]; then echo locked; else echo unlocked; fi >> "$GH_STUB_DIR/swaps" ;; esac
exec "$(command -v mv)" "\$@"
STUB
chmod +x "$T/bin/mv"
M=$(origin_main)
shadow_line() { echo "2026-11-01 03:00:00 prs=$1 sha=$M run=$1 local=green branch=train/lk$1"; }
echo success > "$GH_STUB_DIR/run-9201"; echo success > "$GH_STUB_DIR/run-9202"
shadow_line 9201 > "$SL"
bash "$SHADOWS" > /dev/null 2>&1
[ "$(cat "$GH_STUB_DIR/swaps" 2>/dev/null)" = locked ] && grep -q "branch=train/lk9201 github=success$" "$SL" && [ ! -e "$SL.lock" ] \
  && ok "shadow lock: the reader swaps the log holding the lock, and gives it back" || bad "shadow lock: swaps \"$(cat "$GH_STUB_DIR/swaps" 2>/dev/null)\", lock left: $(ls -d "$SL.lock" 2>/dev/null)"

shadow_line 9202 > "$SL"; cp "$SL" "$T/shadow.before"; mkdir "$SL.lock"
OUT=$(SHADOW_LOCK_SECS=0 bash "$SHADOWS" 2>&1); RC=$?
[ $RC = 0 ] && cmp -s "$SL" "$T/shadow.before" && grep -qF "results not written: $SL.lock is held" <<<"$OUT" && [ -d "$SL.lock" ] \
  && ok "shadow lock: a lock it cannot take: the log is left as it was, it says so, and the lock is not its to remove" || { bad "shadow lock: a held lock: exit $RC"; echo "$OUT" | tail -8 | sed 's/^/      /'; }
( sleep 1; rmdir "$SL.lock" ) & FREE=$!
bash "$SHADOWS" > /dev/null 2>&1
wait $FREE
grep -q "branch=train/lk9202 github=success$" "$SL" && ok "shadow lock: ...and it waits for a lock that is given back" || { bad "shadow lock: the log after waiting:"; sed 's/^/      /' "$SL"; }

{ shadow_line 9201; shadow_line 9202; } > "$SL"
{ echo "$(shadow_line 9201) github=failure"; echo "$(shadow_line 9202) github=failure"; } > "$T/shadow.other"
cp "$T/shadow.other" "$GH_STUB_DIR/view-rewrites"
OUT=$(bash "$SHADOWS" 2>&1)
cmp -s "$SL" "$T/shadow.other" && grep -qF "another reader rewrote shadow.log" <<<"$OUT" \
  && ok "shadow lock: another reader's rewrite during this read stands whole, and it says so" || { bad "shadow lock: after another reader's rewrite:"; sed 's/^/      /' "$SL"; }

branch 91 t-lock "" -- add lock.txt x
: > "$SL"; mkdir "$SL.lock"
SHADOW_LOCK_SECS=60 bash "$TRAIN" 91 --shadow --no-merge > "$T/lock.out" 2>&1 & TP=$!
for _ in $(seq 300); do grep -q '^train: ' "$T/lock.out" && break; sleep 0.2; done
sleep 1
HELD=$(lines)
rmdir "$SL.lock"
wait $TP; RC=$?
[ "$HELD" = 0 ] && [ $RC = 0 ] && grep -q " prs=91 " "$SL" && [ ! -e "$SL.lock" ] \
  && ok "shadow lock: a train's line waits for the lock, and goes in once it is free" || { bad "shadow lock: $HELD line(s) while held, exit $RC"; tail -8 "$T/lock.out" | sed 's/^/      /'; }

branch 92 t-stale "" -- add stale.txt x
: > "$SL"; mkdir "$SL.lock"
OUT=$(SHADOW_LOCK_SECS=0 bash "$TRAIN" 92 --shadow --no-merge 2>&1); RC=$?
LG=$(sed -n 's/^train: .*(logs: \(.*\))$/\1/p' <<<"$OUT" | tail -1)
[ $RC = 0 ] && grep -q " prs=92 " "$SL" && grep -qF "was held past the wait" "$LG/shadow.out" && [ -d "$SL.lock" ] && grep -q '^train: ' <<<"$(tail -1 <<<"$OUT")" \
  && ok "shadow lock: a lock left behind holds no train: the line goes in, the note in shadow.out, and the summary stays last" || { bad "shadow lock: a stale lock: exit $RC"; echo "$OUT" | tail -8 | sed 's/^/      /'; }
rmdir "$SL.lock"; rm -f "$T/bin/mv"

# Last: #36 leaves its FAIL file on main, so every train after it would be red.
: > "$GH_STUB_DIR/merges"
branch 36 t-load "" -- add FAIL-test-load slow
expect 0 "train: a red run the load recheck calls load is green, and merges" "load recheck: every failure passed alone" -- env TEST_ALL_RECHECK="$LOAD" bash "$TRAIN" 36
[ "$(merges)" = "36" ] && ok "train: ...#36 merged" || bad "train: merged \"$(merges)\", not 36"
cd "$W" || exit 1

echo ""
if [ $FAILS -eq 0 ]; then
  echo "✓ merge gate scripts: all checks passed"
  exit 0
fi
echo "❌ merge gate scripts: $FAILS check(s) failed"
exit 1
