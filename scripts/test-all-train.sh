#!/bin/bash
# test-all-train.sh — tests up to four cleared PRs in ONE full local run and merges them in order (Fable's test-throughput
# design S2; Marty, 31 Oct 2026: "let's go with all of Fable's recommendations").
#
#   bash scripts/test-all-train.sh <PR> [<PR>…] [--no-merge] [--keep]
#
# Makes a scratch worktree at origin/main and merges each PR head into it in the order given. A conflict only in word
# catalogs (apps/*/words/*.json, packages/*/words/*.json) is merged per key by scripts/words-merge-3way.mjs and verified;
# any other conflict drops that PR from the train with a line, never resolved. Then `test-all.sh --all` on the result.
#
#   green → each PR is merged in order: `gh pr merge --squash --admin --match-head-commit <the head that was tested>`, and
#           after each, main's tree must be exactly the tested tree up to that PR (`git diff --stat`), or the train stops.
#           A PR that main has caught up with in word catalogs gets main merged into its branch the same per-key way first,
#           checked to give the tested tree, and pushed.
#   red   → the load recheck (scratch/lanes/bin/test-all-recheck.sh, or $TEST_ALL_RECHECK; set it empty for none) runs on
#           the same tree. Load only: green. A real failure: the failing server suites, vitest files and test packages run
#           alone on main + each PR. The PR they fail with is named with its log; the innocents (two or more of them run the
#           same parts together once more) are merged. A failure the train cannot run alone (lint, typecheck, a browser
#           check) merges nothing, and says so.
#
# Who rides: at most 4. A PR labelled tier-A, or touching ledger or money paths ($MONEY_PATHS, or a changed line that calls
# conservingTransaction or writes accounts SET balance), rides alone: in a train of two or more it is left out with a line. A RED GitHub
# "Run BeanPool Test-All Pipeline" on a PR's head holds it, before the run and again before merging; pending never holds.
# If main or any PR head moves during the run, or a PR's CI goes red, nothing is merged: run the train again.
#
#   --no-merge   test, bisect and report, but merge and push nothing
#   --keep       leave the scratch worktree in place
#
# Exit: 0 every PR given merged (--no-merge: would merge); 1 the train ran and some PR did not merge (the last line says
# which and why); 2 usage; 3 stopped with main not as tested, or part-way through merging: read the lines above.
# Logs: <git common dir>/test-all-train/<stamp>/. Run it in the foreground or from the queue; it never runs two at once by
# itself, so take the queue's slot first.

set -o pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=test-all-lib.sh
. "$SCRIPT_DIR/test-all-lib.sh"
scrub_test_env
# A red run's logs must stay where test-all.sh left them, .rc files included, for the recheck and the bisect.
unset TEST_ALL_LOG_DIR

CAP=4
CHECK_NAME="Run BeanPool Test-All Pipeline"
MERGER="$SCRIPT_DIR/words-merge-3way.mjs"
CATALOG_RE='^(apps|packages)/[^/]+/words/[^/]+\.json$'
# Ledger and money: the ledger itself, the files that move Beans (check-balance-writes.mjs's baseline and the engine's
# escrow, pledge and debt paths), the treasury routes, and the two scripts that guard conservation. db.ts is too central to
# list whole: a changed line there (or anywhere) that calls conservingTransaction or writes a balance counts instead.
MONEY_PATHS='^(packages/beanpool-core/src/ledger|apps/server/src/(state-engine|decisions-engine|federation-settlement-exchange|srv20-ledger-reset)\.ts$|apps/server/src/engine/(escrow|money-requests|unfunded-pledges|stranded-pledges|names-debts|key-move|audit|sync)\.ts$|apps/server/src/routes/treasury|scripts/(check-balance-writes|audit-conservation)\.mjs$)'

usage() { echo "usage: $0 <PR> [<PR>…] (at most $CAP) [--no-merge] [--keep]" >&2; exit 2; }
PRS=(); MERGE=1; KEEP=0
for arg in "$@"; do
  case "$arg" in
    --no-merge) MERGE=0 ;;
    --keep) KEEP=1 ;;
    -*) usage ;;
    *) n="${arg%/}"; n="${n##*/}"
       case "$n" in ''|*[!0-9]*) usage ;; esac
       case " ${PRS[*]} " in *" $n "*) echo "❌ PR #$n is given twice." >&2; exit 2 ;; esac
       PRS+=("$n") ;;
  esac
done
[ ${#PRS[@]} -ge 1 ] || usage
[ ${#PRS[@]} -le $CAP ] || { echo "❌ a train carries at most $CAP PRs; ${#PRS[@]} given." >&2; exit 2; }
git rev-parse --git-dir >/dev/null 2>&1 || { echo "❌ not inside a git repository." >&2; exit 2; }

COMMON=$(git rev-parse --path-format=absolute --git-common-dir)
RECHECK="${TEST_ALL_RECHECK-$(dirname "$COMMON")/scratch/lanes/bin/test-all-recheck.sh}"
LOGS="$COMMON/test-all-train/$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$LOGS" || exit 1
short() { echo "$1" | cut -c1-9; }

# Per PR, by index: number, head, branch, from a fork, and its fate ("" while it rides).
NUM=(); HEAD=(); BRANCH=(); CROSS=(); FATE=(); STEP=()
fate() { FATE[$1]="$2"; echo "   #${NUM[$1]}: $2"; }
riding() { local i; for i in "${!NUM[@]}"; do [ -z "${FATE[$i]}" ] && echo "$i"; done; }
nums() { local i out=""; for i in "$@"; do out="$out #${NUM[$i]}"; done; echo "${out# }"; }

# summary <exit code>: the last line, which callers read.
summary() {
  local i merged="" others=""
  for i in "${!NUM[@]}"; do
    case "${FATE[$i]}" in
      MERGED*|"WOULD MERGE"*) merged="$merged #${NUM[$i]}" ;;
      *) others="$others; #${NUM[$i]} ${FATE[$i]:-not merged}" ;;
    esac
  done
  echo ""
  [ -n "$merged" ] && merged="${merged# } $([ $MERGE -eq 1 ] && echo merged || echo "would merge (--no-merge)")" || merged="nothing merged"
  echo "train: $merged$others (logs: $LOGS)"
  exit "$1"
}

pr_info() {
  gh pr view "$1" --json number,headRefOid,baseRefName,url,headRefName,isCrossRepository,state,labels \
    --jq '"\(.number) \(.headRefOid) \(.baseRefName) \(.url) \(.headRefName) \(.isCrossRepository) \(.state) \([.labels[].name] | join(","))"'
}

# ci_state <sha>: "red" when the head's latest "Run BeanPool Test-All Pipeline" failed; "not-red" when it passed, is
# pending or has not started (Marty, 14 Oct: pending never holds); "unknown" when GitHub could not be read, which holds.
ci_state() {
  local out
  out=$(gh api "repos/$REPO/commits/$1/check-runs?check_name=$(echo "$CHECK_NAME" | sed 's/ /%20/g')&filter=latest" \
    --jq '.check_runs[] | (.conclusion // "pending")' 2>/dev/null) || { echo unknown; return; }
  case " $(echo $out) " in *" failure "*|*" timed_out "*|*" startup_failure "*) echo red ;; *) echo not-red ;; esac
}

# rides_alone <head> <labels>: why the PR may not share a train, or nothing.
rides_alone() {
  local mb files
  case ",$(echo "$2" | tr 'A-Z' 'a-z')," in *",tier-a,"*|*",tier a,"*|*",tier:a,"*) echo "is labelled tier-A"; return ;; esac
  mb=$(git merge-base "$MAIN_SHA" "$1") || { echo "shares no history with main"; return; }
  files=$(git diff --name-only "$mb" "$1" | grep -E "$MONEY_PATHS" | head -3 | tr '\n' ' ')
  [ -n "$files" ] && { echo "touches ledger or money paths (${files% })"; return; }
  # -G takes an extended regex: a bare | (\| would be a literal bar, and match nothing).
  files=$(git diff --name-only -G 'conservingTransaction|accounts SET balance' "$mb" "$1" | head -3 | tr '\n' ' ')
  [ -n "$files" ] && echo "changes a line that moves Beans: conservingTransaction or accounts SET balance (${files% })"
}

# merge_in <commit> <pr|main> <message>: merges <commit> into HEAD of the current tree; <pr|main> says which side the incoming
# commit is (a PR into main, or main into a PR's branch). Word catalogs both sides changed are merged per key and verified;
# a conflict anywhere else aborts. Prints why, and returns 1, when it cannot merge.
merge_in() {
  local commit=$1 role=$2 msg=$3 conflicted other mb both out mainrev prrev
  if git merge-base --is-ancestor "$commit" HEAD; then return 0; fi
  git -c core.fsmonitor=false merge --quiet --no-commit --no-ff "$commit" >/dev/null 2>&1
  conflicted=$(git diff --name-only --diff-filter=U)
  if ! git rev-parse -q --verify MERGE_HEAD >/dev/null; then
    git merge --abort >/dev/null 2>&1; echo "git could not start the merge"; return 1
  fi
  other=$(echo "$conflicted" | sed '/^$/d' | grep -v -E "$CATALOG_RE")
  if [ -n "$other" ]; then
    git merge --abort >/dev/null 2>&1
    echo "conflicts outside the word catalogs: $(echo $other | cut -c1-200)"; return 1
  fi
  mb=$(git merge-base HEAD MERGE_HEAD)
  if [ "$role" = pr ]; then mainrev=HEAD; prrev=MERGE_HEAD; else mainrev=MERGE_HEAD; prrev=HEAD; fi
  both=$(comm -12 <(git diff --name-only "$mb" HEAD | grep -E "$CATALOG_RE" | sort) \
                  <(git diff --name-only "$mb" MERGE_HEAD | grep -E "$CATALOG_RE" | sort))
  if [ -n "$conflicted$both" ]; then
    # shellcheck disable=SC2086
    if ! out=$(node "$MERGER" --base "$mb" --main "$mainrev" --pr "$prrev" --resolve $conflicted --verify $both 2>&1); then
      git merge --abort >/dev/null 2>&1
      echo "word catalogs that cannot be merged per key: $(echo "$out" | grep -v '^words-merge-3way: [0-9]* problem' | head -3 | sed 's/^ *//; s/^words-merge-3way: //' | tr '\n' ';' | cut -c1-300)"
      return 1
    fi
    echo "      $out"
    # shellcheck disable=SC2086
    [ -z "$conflicted" ] || git -c core.fsmonitor=false add -- $conflicted
  fi
  if [ -n "$(git diff --name-only --diff-filter=U)" ]; then git merge --abort >/dev/null 2>&1; echo "files still unmerged"; return 1; fi
  git -c core.fsmonitor=false commit --quiet --no-edit -m "$msg${conflicted:+ (word catalogs merged per key)}" >/dev/null 2>&1 \
    || { git merge --abort >/dev/null 2>&1; echo "could not commit the merge"; return 1; }
}

# build <indices…>: a fresh chain from main's tested commit: main, then each PR merged in order. STEP[i] is the commit after
# PR i. A PR that will not merge leaves the train (its fate says why). Ends with the tree checked out at the chain's tip.
build() {
  local i why
  git -c core.fsmonitor=false checkout --quiet --detach --force "$MAIN_SHA" || return 1
  for i in "$@"; do
    if why=$(merge_in "${HEAD[$i]}" pr "test-all-train: PR #${NUM[$i]} ($(short "${HEAD[$i]}")) on origin/$BASE ($(short "$MAIN_SHA"))"); then
      [ -n "$why" ] && echo "$why"
      STEP[$i]=$(git rev-parse HEAD)
    else
      fate "$i" "DROPPED: it does not merge with main and the PRs before it ($why)"
    fi
  done
}

install_deps() { [ ! -f pnpm-lock.yaml ] || pnpm install --frozen-lockfile --reporter=silent; }
# prepare: install, and build the workspace's dist as test-all.sh's first stage does (the alone runs switch trees, and
# the server suites run against core's dist).
prepare() {
  install_deps || return 1
  [ ! -f turbo.json ] || pnpm turbo run build
}

# failing_parts <test-all log dir>: one line per part a red run failed, from test-all.sh's own logs:
# "suite <name>", "vitest <package> <file>", "package <package>" (its test task, when no vitest file is named), or
# "stage <check>" for a check that cannot be run alone. The same reading as the load recheck (v2): a check with no .rc was
# killed or never finished, and a vitest package whose failed files are not all listed, or that has an unhandled error, is
# run whole, never on the listed files alone.
failing_parts() {
  local L=$1 x r s names pkgs files p nfail nlisted
  for x in "$L"/*.log "$L"/*.dur; do
    [ -e "$x" ] || continue
    s=$(basename "$x"); s=${s%.*}
    case "$s" in recheck-*) continue ;; esac
    [ -s "$L/$s.rc" ] || echo "stage $s"
  done | sort -u
  for r in "$L"/*.rc; do
    [ -f "$r" ] && [ "$(cat "$r")" != 0 ] || continue
    s=$(basename "$r" .rc)
    case "$s" in
      fail_summary) ;;
      server_suites)
        names=$(grep -E 'Server suites failed:' "$L/server_suites.log" | tail -1 | sed -E 's/.*Server suites failed: //; s/\([^)]*\)//g' | tr ' ' '\n' | sed '/^$/d' | sort -u)
        if [ -n "$names" ]; then echo "$names" | sed 's/^/suite /'; else echo "stage server_suites"; fi ;;
      test)
        pkgs=$(grep -E '^ *Failed: ' "$L/test.log" | tail -1 | sed -E 's/^ *Failed: +//; s/#test//g; s/,/ /g')
        [ -n "$(echo $pkgs)" ] || { echo "stage test"; continue; }
        for p in $pkgs; do
          files=$(grep -E "^$p:test: +❯ \S+ \([0-9]+ tests? \| [0-9]+ failed\)" "$L/test.log" | sed -E 's/^[^ ]+:test: +❯ ([^ ]+) .*/\1/' | sort -u)
          nfail=$(grep -E "^$p:test: +Test Files +[0-9]+ failed" "$L/test.log" | tail -1 | sed -E 's/.*Test Files +([0-9]+) failed.*/\1/')
          nlisted=$(echo "$files" | sed '/^$/d' | wc -l | tr -d ' ')
          if [ -z "$files" ] || [ "${nfail:-0}" != "$nlisted" ] || grep -qE "^$p:test: .*Unhandled (Error|Rejection)" "$L/test.log"; then
            echo "package $p"
          else
            echo "$files" | sed "s|^|vitest $p |"
          fi
        done ;;
      *) echo "stage $s" ;;
    esac
  done
}

# run_parts <parts file> <log>: runs those parts alone on the current tree. 0 when every one passes.
run_parts() {
  local parts=$1 log=$2 rc=0 names kind a b dir
  prepare >> "$log" 2>&1 || { echo "(install or build failed: see $log)" >> "$log"; return 1; }
  names=$(sed -n 's/^suite //p' "$parts" | tr '\n' ' ')
  if [ -n "${names// /}" ]; then
    echo "── server suites alone: $names" >> "$log"
    TEST_ALL_JOBS=1 SERVER_SUITES_ONLY="${names% }" node scripts/run-server-suites.mjs >> "$log" 2>&1 || rc=1
  fi
  while read -r kind a b; do
    case "$kind" in
      vitest)
        dir=$(for p in apps/*/package.json packages/*/package.json; do [ "$(node -p "require('./$p').name" 2>/dev/null)" = "$a" ] && dirname "$p"; done | head -1)
        echo "── vitest alone: $a $b" >> "$log"
        if [ -z "$dir" ]; then echo "no package $a here" >> "$log"; rc=1; continue; fi
        ( cd "$dir" && TEST_ALL_TIMEOUT_MS=60000 pnpm exec vitest run --maxWorkers=1 "$b" ) >> "$log" 2>&1 || rc=1 ;;
      package)
        echo "── test task alone: $a" >> "$log"
        pnpm turbo run test --filter="$a" >> "$log" 2>&1 || rc=1 ;;
    esac
  done < "$parts"
  return $rc
}

# ── Who is in the train ──────────────────────────────────────────────────────────────────────────────────────────
echo "Train: ${PRS[*]/#/#} (logs: $LOGS)"
BASE=""; REPO=""
for n in "${PRS[@]}"; do
  i=${#NUM[@]}; NUM[$i]=$n; FATE[$i]=""
  if ! info=$(pr_info "$n" 2>&1); then fate "$i" "DROPPED: could not look it up ($(echo "$info" | head -1))"; continue; fi
  read -r _num head base url branch cross state labels <<< "$info"
  HEAD[$i]=$head; BRANCH[$i]=$branch; CROSS[$i]=$cross
  [ -n "$BASE" ] || { BASE=$base; REPO=$(echo "$url" | sed -E 's|^https?://[^/]+/([^/]+/[^/]+)/pull/.*$|\1|'); }
  if [ "$state" != OPEN ]; then fate "$i" "DROPPED: it is $state"; continue; fi
  if [ "$base" != "$BASE" ]; then fate "$i" "DROPPED: its base is $base, the train's is $BASE"; continue; fi
  eval "LABELS_$i=\$labels"
done
[ -n "$BASE" ] || summary 1
# Into the ref by name: a plain `git fetch origin <base>` writes no origin/<base> in a --single-branch clone.
if ! git fetch --quiet origin "+refs/heads/$BASE:refs/remotes/origin/$BASE"; then echo "❌ could not fetch origin/$BASE"; summary 1; fi
MAIN_SHA=$(git rev-parse "origin/$BASE")
echo "Main: origin/$BASE $(short "$MAIN_SHA")"
for i in $(riding); do
  git fetch --quiet origin "pull/${NUM[$i]}/head" 2>/dev/null
  git cat-file -e "${HEAD[$i]}^{commit}" 2>/dev/null || { fate "$i" "DROPPED: its head ${HEAD[$i]} is not here after fetching"; continue; }
  case "$(ci_state "${HEAD[$i]}")" in
    red) fate "$i" "HELD: GitHub's \"$CHECK_NAME\" is red on its head $(short "${HEAD[$i]}")"; continue ;;
    unknown) fate "$i" "HELD: GitHub's checks on its head $(short "${HEAD[$i]}") could not be read"; continue ;;
  esac
  if [ ${#PRS[@]} -gt 1 ]; then
    eval "labels=\$LABELS_$i"
    why=$(rides_alone "${HEAD[$i]}" "$labels")
    [ -n "$why" ] && fate "$i" "RIDES ALONE: it $why; run: bash scripts/test-all-train.sh ${NUM[$i]}"
  fi
done
TRAIN=($(riding))
[ ${#TRAIN[@]} -gt 0 ] || summary 1

# ── The tested tree ──────────────────────────────────────────────────────────────────────────────────────────────
ORIG_DIR=$(pwd)
WT=$(mktemp -d "${TMPDIR:-/tmp}/test-all-train.XXXXXX") || exit 1
cleanup() {
  cd "$ORIG_DIR" || return
  if [ $KEEP -eq 1 ]; then echo "Scratch worktree kept: $WT"
  else git worktree remove --force "$WT" >/dev/null 2>&1; rm -rf "$WT"; git worktree prune >/dev/null 2>&1; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
git worktree add --quiet --detach "$WT" "$MAIN_SHA" || { echo "❌ could not make a scratch worktree at $WT"; exit 1; }
cd "$WT" || exit 1

build "${TRAIN[@]}"
TRAIN=($(riding))
[ ${#TRAIN[@]} -gt 0 ] || summary 1
TESTED=$(git rev-parse HEAD)
echo "Testing $(short "$TESTED"): origin/$BASE $(short "$MAIN_SHA") + $(nums "${TRAIN[@]}"), in $WT"
install_deps || { echo "❌ pnpm install failed in the scratch worktree"; summary 1; }

bash scripts/test-all.sh --all 2>&1 | tee "$LOGS/test-all.log"
RC=${PIPESTATUS[0]}
LAND=("${TRAIN[@]}")

if [ "$RC" -ne 0 ]; then
  RUNLOGS=$(sed -n 's/.*Full logs of every check kept in \(.*\)$/\1/p' "$LOGS/test-all.log" | tail -1)
  echo ""
  echo "❌ test-all --all failed on $(nums "${TRAIN[@]}") merged with origin/$BASE (logs: ${RUNLOGS:-none kept})."
  [ -z "$RECHECK" ] || [ -f "$RECHECK" ] || echo "(no load recheck at $RECHECK: every failure counts as real)"
  if [ -n "$RECHECK" ] && [ -f "$RECHECK" ] && [ -n "$RUNLOGS" ] && bash "$RECHECK" "$RUNLOGS" "$WT" 2>&1 | tee "$LOGS/recheck.log" && [ "${PIPESTATUS[0]}" = 0 ]; then
    echo "✅ load recheck: every failure passed alone on the same tree, so the run counts as green ($LOGS/recheck.log)"
    RC=0
  fi
fi

if [ "$RC" -ne 0 ]; then
  [ -n "$RUNLOGS" ] && failing_parts "$RUNLOGS" > "$LOGS/parts.txt"
  if [ -z "$RUNLOGS" ] || [ ! -s "$LOGS/parts.txt" ]; then
    for i in "${TRAIN[@]}"; do fate "$i" "NOT MERGED: the run was red and its failing parts could not be read ($LOGS/test-all.log)"; done
    summary 1
  fi
  echo "Failing parts: $(tr '\n' ';' < "$LOGS/parts.txt" | sed 's/;$//; s/;/; /g')"
  if grep -q '^stage ' "$LOGS/parts.txt"; then
    for i in "${TRAIN[@]}"; do fate "$i" "NOT MERGED: red in $(sed -n 's/^stage //p' "$LOGS/parts.txt" | tr '\n' ' ' | sed 's/ $//'), which the train cannot run alone; test the PRs one at a time ($RUNLOGS)"; done
    summary 1
  fi
  if [ ${#TRAIN[@]} -eq 1 ]; then
    fate "${TRAIN[0]}" "RED: it fails $(cut -d' ' -f2- "$LOGS/parts.txt" | tr '\n' ';' | sed 's/;$//; s/;/; /g') with main ($RUNLOGS)"
    summary 1
  fi
  # Each PR alone with main, the failing parts only.
  INNOCENT=(); CULPRIT=()
  for i in "${TRAIN[@]}"; do
    alone="$LOGS/alone-pr${NUM[$i]}.log"
    echo "── #${NUM[$i]} alone with origin/$BASE: the failing parts ($alone)"
    git -c core.fsmonitor=false checkout --quiet --detach --force "$MAIN_SHA"
    if ! why=$(merge_in "${HEAD[$i]}" pr "test-all-train: PR #${NUM[$i]} alone on origin/$BASE ($(short "$MAIN_SHA"))"); then
      fate "$i" "NOT MERGED: it would not merge with main alone ($why)"; continue
    fi
    if run_parts "$LOGS/parts.txt" "$alone"; then echo "   #${NUM[$i]}: passes them"; INNOCENT+=("$i")
    else CULPRIT+=("$i"); fate "$i" "RED: it fails $(cut -d' ' -f2- "$LOGS/parts.txt" | tr '\n' ';' | sed 's/;$//; s/;/; /g') with main alone ($alone)"; fi
  done
  if [ ${#CULPRIT[@]} -eq 0 ]; then
    for i in "${INNOCENT[@]}"; do fate "$i" "NOT MERGED: every PR passes the failing parts alone, so the failure needs two of them together, or main; test them one at a time ($RUNLOGS)"; done
    summary 1
  fi
  if [ ${#INNOCENT[@]} -eq 0 ]; then echo "Every PR fails those parts with main alone: check main itself too."; summary 1; fi
  # The innocents land as main + the innocents: build exactly that, and with two or more, run the failing parts on it.
  build "${INNOCENT[@]}"
  LAND=($(riding))
  [ ${#LAND[@]} -gt 0 ] || summary 1
  TESTED=$(git rev-parse HEAD)
  if [ ${#LAND[@]} -gt 1 ]; then
    together="$LOGS/together.log"
    echo "── $(nums "${LAND[@]}") together with origin/$BASE: the failing parts ($together)"
    if ! run_parts "$LOGS/parts.txt" "$together"; then
      for i in "${LAND[@]}"; do fate "$i" "NOT MERGED: passes the failing parts alone, but not together with $(nums "${LAND[@]}") ($together)"; done
      summary 1
    fi
  fi
  echo "Merging the innocents: $(nums "${LAND[@]}") (tree $(short "$TESTED"): main + them; every other check passed on main + the whole train)"
fi

if [ $MERGE -eq 0 ]; then
  for i in "${LAND[@]}"; do fate "$i" "WOULD MERGE (--no-merge), at step $(short "${STEP[$i]}")"; done
  [ ${#LAND[@]} -eq ${#PRS[@]} ] && summary 0 || summary 1
fi

# ── Merging ──────────────────────────────────────────────────────────────────────────────────────────────────────
# Nothing merges if anything moved under the run: main, a head, or a head's CI gone red.
git fetch --quiet origin "+refs/heads/$BASE:refs/remotes/origin/$BASE" || { echo "❌ could not fetch origin/$BASE"; summary 3; }
if [ "$(git rev-parse "origin/$BASE")" != "$MAIN_SHA" ]; then
  echo "⏹  origin/$BASE moved during the run ($(short "$MAIN_SHA") → $(short "$(git rev-parse "origin/$BASE")")): nothing merged. Run the train again."
  for i in "${LAND[@]}"; do FATE[$i]="NOT MERGED: main moved during the run"; done
  summary 3
fi
for i in "${LAND[@]}"; do
  now=$(pr_info "${NUM[$i]}" 2>/dev/null | cut -d' ' -f2)
  if [ "$now" != "${HEAD[$i]}" ]; then
    fate "$i" "HELD: its head moved during the run ($(short "${HEAD[$i]}") → $(short "${now:-?}"))"
  else
    case "$(ci_state "${HEAD[$i]}")" in
      red) fate "$i" "HELD: GitHub's \"$CHECK_NAME\" went red on its head during the run" ;;
      unknown) fate "$i" "HELD: GitHub's checks on its head could not be read" ;;
    esac
  fi
done
if [ "$(riding | wc -l | tr -d ' ')" != "${#LAND[@]}" ]; then
  for i in $(riding); do FATE[$i]="NOT MERGED: tested with a PR that is now held; run the train again without it"; done
  summary 1
fi

for i in "${LAND[@]}"; do
  n=${NUM[$i]}
  git fetch --quiet origin "+refs/heads/$BASE:refs/remotes/origin/$BASE" || { fate "$i" "NOT MERGED: could not fetch origin/$BASE"; summary 3; }
  now_main=$(git rev-parse "origin/$BASE")
  land=${HEAD[$i]}
  if ! git merge-tree --write-tree "$now_main" "$land" >/dev/null 2>&1; then
    # It conflicts with main as the train has moved it: word catalogs only (build() saw to that). Merge main into its
    # branch per key, check that gives the tree tested at this step, and push that to the PR first.
    if [ "${CROSS[$i]}" = true ]; then fate "$i" "NOT MERGED: its word catalogs need main merged in, and it comes from a fork"; summary 3; fi
    git -c core.fsmonitor=false checkout --quiet --detach --force "$land"
    if ! why=$(merge_in "$now_main" main "Merge origin/$BASE into ${BRANCH[$i]} (word catalogs merged per key, by test-all-train)"); then
      fate "$i" "NOT MERGED: main would not merge into its branch ($why)"; summary 3
    fi
    if [ -n "$(git diff --name-only "${STEP[$i]}" HEAD)" ]; then
      fate "$i" "NOT MERGED: main merged into its branch is not the tree the train tested ($(git diff --stat "${STEP[$i]}" HEAD | tail -1))"; summary 3
    fi
    land=$(git rev-parse HEAD)
    git push --quiet origin "$land:refs/heads/${BRANCH[$i]}" || { fate "$i" "NOT MERGED: could not push main merged into ${BRANCH[$i]}"; summary 3; }
    echo "   #$n: pushed $(short "$land") to ${BRANCH[$i]} (origin/$BASE merged in, word catalogs per key)"
    for _ in $(seq 30); do [ "$(pr_info "$n" 2>/dev/null | cut -d' ' -f2)" = "$land" ] && break; sleep 2; done
  fi
  if ! out=$(gh pr merge "$n" --squash --admin --match-head-commit "$land" 2>&1); then
    fate "$i" "NOT MERGED: gh pr merge failed: $(echo "$out" | tail -1)"; summary 3
  fi
  git fetch --quiet origin "+refs/heads/$BASE:refs/remotes/origin/$BASE"
  if [ -n "$(git diff --name-only "${STEP[$i]}" "origin/$BASE")" ]; then
    FATE[$i]="MERGED, BUT origin/$BASE is not the tree the train tested up to it"
    echo "⏹  STOP: after #$n, origin/$BASE $(short "$(git rev-parse "origin/$BASE")") is not the tested tree $(short "${STEP[$i]}"):"
    git diff --stat "${STEP[$i]}" "origin/$BASE" | tail -15
    summary 3
  fi
  fate "$i" "MERGED as $(short "$(git rev-parse "origin/$BASE")")"
done

echo ""
echo "git diff --stat $(short "$TESTED") origin/$BASE (the tested tree against main now):"
STAT=$(git diff --stat "$TESTED" "origin/$BASE")
if [ -n "$STAT" ]; then echo "$STAT"; echo "⏹  STOP: main is not the tree the train tested."; summary 3; fi
echo "   (empty: main is exactly the tree the train tested)"
[ ${#LAND[@]} -eq ${#PRS[@]} ] && summary 0 || summary 1
