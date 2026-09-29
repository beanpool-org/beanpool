#!/bin/bash
# test-merge-gate.sh — tests the local merge gate's scripts against a throwaway repository. No GitHub, no network.
#
# Covers scripts/test-all-merge-check.sh, scripts/test-all-pr.sh, the green record in scripts/test-all-lib.sh
# (green_run_start / record_green_run) and scripts/check-deps-installed.mjs. The repository is a bare "origin" and a
# clone of it in a temp dir; `gh` is a stub on PATH that answers `pr view` from files and logs `api` calls; the clone's
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
  if [ -n "$pattern" ] && ! printf '%s\n' "$out" | grep -qF -- "$pattern"; then
    bad "$desc (output lacks: $pattern)"; echo "$out" | tail -15 | sed 's/^/      /'; return
  fi
  ok "$desc"
}

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
echo '{"dependencies":{"left-pad":"1","new-dep":"3"}}' > "$D/packages/p/package.json"
expect 1 "deps: a package added to a workspace package.json and not installed is a stale install" "STALE INSTALL" -- node "$REPO_ROOT/scripts/check-deps-installed.mjs" "$D"
expect 1 "deps: ...naming the package and where it is declared" "packages/p/package.json: new-dep" -- node "$REPO_ROOT/scripts/check-deps-installed.mjs" "$D"
rm -rf "$D/node_modules" "$D/apps/a/node_modules"
expect 1 "deps: no node_modules at all says nothing is installed" "nothing is installed here" -- node "$REPO_ROOT/scripts/check-deps-installed.mjs" "$D"

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

# gh stub: `pr view <n> ...` prints $GH_STUB_DIR/pr-<n> ("<n> <head> <base> <url>"; the url only when asked for);
# `api ...` appends its arguments to $GH_STUB_DIR/api.
export GH_STUB_DIR="$T/gh"; mkdir -p "$GH_STUB_DIR" "$T/bin"
cat > "$T/bin/gh" <<'STUB'
#!/bin/bash
if [ "$1 $2" = "pr view" ]; then
  f="$GH_STUB_DIR/pr-${3##*/}"
  [ -f "$f" ] || { echo "no pull requests found for $3" >&2; exit 1; }
  case "$*" in *url*) cat "$f" ;; *) cut -d' ' -f1-3 "$f" ;; esac
  exit 0
fi
if [ "$1" = "api" ]; then shift; echo "$*" >> "$GH_STUB_DIR/api"; exit 0; fi
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

echo ""
if [ $FAILS -eq 0 ]; then
  echo "✓ merge gate scripts: all checks passed"
  exit 0
fi
echo "❌ merge gate scripts: $FAILS check(s) failed"
exit 1
