#!/bin/bash
# test-merge-gate.sh — tests the local merge gate's scripts against a throwaway repository. No GitHub, no network.
#
# Covers scripts/test-all-merge-check.sh, scripts/test-all-pr.sh, scripts/test-all-train.sh (the merge train, with
# scripts/words-merge-3way.mjs), the green record in scripts/test-all-lib.sh
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
echo "stub node: SERVER_SUITES_ONLY=[${SERVER_SUITES_ONLY-unset}]"; exit 1
STUB
chmod +x "$T/nodestub/node"
expect 1 "test-all --all drops SERVER_SUITES_ONLY, so a narrowed run cannot record a full green" "SERVER_SUITES_ONLY=[unset]" -- env SERVER_SUITES_ONLY=test-x PATH="$T/nodestub:$PATH" bash "$REPO_ROOT/scripts/test-all.sh" --all
expect 1 "test-all --all ...and says it is ignoring it" "ignoring SERVER_SUITES_ONLY=test-x" -- env SERVER_SUITES_ONLY=test-x PATH="$T/nodestub:$PATH" bash "$REPO_ROOT/scripts/test-all.sh" --all
expect 1 "test-all without --all keeps SERVER_SUITES_ONLY, for reproducing one suite" "SERVER_SUITES_ONLY=[test-x]" -- env SERVER_SUITES_ONLY=test-x PATH="$T/nodestub:$PATH" bash "$REPO_ROOT/scripts/test-all.sh" --fast

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
# (another merge landing in the same moment), and is removed.
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
# an UNFINISHED-<check> file leaves that check's log with no .rc (killed part-way), and its run-server-suites.mjs fails
# SERVER_SUITES_ONLY's suites that have a FAIL-<suite> file. gh is the stub above; a PR's branch on origin is its head.
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
  echo "❌ Server suites failed: $fail" > "$L/server_suites.log"
  echo "stub test-all: FAIL"; echo "Full logs of every check kept in $L"; exit 1
fi
echo "stub test-all: every check passed"
[ "$1" = "--all" ] && record_green_run 7
exit 0
STUB
cat > scripts/run-server-suites.mjs <<'STUB'
import { existsSync } from 'node:fs';
const names = (process.env.SERVER_SUITES_ONLY || '').split(/\s+/).filter(Boolean);
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
git add scripts apps notes.txt && git commit -q -m t0 && git push -q origin main 2>/dev/null
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
