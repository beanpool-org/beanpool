#!/bin/bash
# sync-pr.sh <PR> [--dry-run] [--keep] — merge origin/<base> into a PR's branch, word catalogs per key, and push.
#
# WHY (Marty, 15 Nov: fewer sync rounds). Every PR that adds words appends keys to the same 24-language catalogs, so each
# landing leaves the waiting PRs conflicting there, and each took a sync lane or a director's hand merge. A conflict that
# is only in the catalogs is now one command and no lane. Anything else still stops here and goes to a person or a lane.
#
# WHAT IT DOES, from any checkout of this repository:
#   1. gh reads the PR's branch and base (a PR from a fork, or one not open, is refused: we cannot push there).
#   2. A fresh worktree (.claude/worktrees/sync-pr-<PR>, removed at the end) on origin/<branch>.
#   3. git merge origin/<base>, word catalogs through the per-key driver (scripts/words-merge-3way.mjs, "AS GIT'S MERGE
#      DRIVER"), with main's .gitattributes (attr.tree), so a branch made before the attributes existed is merged the
#      same way. The driver and this script's own copy of the merger are passed on the command line: no config needed.
#   4. STOPS, pushing nothing, on ANY conflict outside the catalogs, on a catalog the driver refuses (both sides changed
#      one key differently, a key one side removed and the other changed, a key written twice), on a catalog changed on
#      both sides that fails the merger's --verify, or on a red words check (node scripts/words/words.mjs check).
#   5. Pushes the merge to the branch, fast-forward only (never forced; a branch that moved meanwhile is refused), and
#      prints the new head.
#
# GitHub's own merges (the merge queue, "Update branch") never run a custom driver: this is for our syncs only.
#
# --dry-run  everything but the push; prints the head it would push.
# --keep     on a stop, leave the worktree mid-merge (conflicts in place) for a hand merge, and print its path.
#
# Exit: 0 synced (or already up to date), 1 stopped (nothing pushed), 2 could not start.
# Env (tests): SYNC_PR_WORDS_CHECK replaces the words check command (run in the worktree); SYNC_PR_WT_ROOT the folder
# the worktree goes in.
# macOS /bin/bash is 3.2: no associative arrays, no mapfile.

set -u
PR="" DRY=0 KEEP=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --keep) KEEP=1 ;;
    [0-9]*) PR=${a#\#} ;;
    \#[0-9]*) PR=${a#\#} ;;
    *) echo "sync-pr: unexpected argument $a" >&2; echo "usage: scripts/sync-pr.sh <PR> [--dry-run] [--keep]" >&2; exit 2 ;;
  esac
done
case "$PR" in ''|*[!0-9]*) echo "usage: scripts/sync-pr.sh <PR> [--dry-run] [--keep]" >&2; exit 2 ;; esac

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd -P)
MERGER="$SCRIPT_DIR/words-merge-3way.mjs"
CATALOG_RE='^(apps|packages)/[^/]+/words/[^/]+\.json$'
[ -f "$MERGER" ] || { echo "sync-pr: $MERGER is missing" >&2; exit 2; }

# The repository is the one we are run in (not the script's: the tests run this copy against a fixture).
TOP=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "sync-pr: run it inside a checkout of the repository" >&2; exit 2; }
COMMON=$(git -C "$TOP" rev-parse --path-format=absolute --git-common-dir) || exit 2
MAIN_TOP=$(dirname "$COMMON")
WT="${SYNC_PR_WT_ROOT:-$MAIN_TOP/.claude/worktrees}/sync-pr-$PR"

info=$(gh pr view "$PR" --json headRefName,baseRefName,isCrossRepository,state \
  -q '[.headRefName, .baseRefName, (.isCrossRepository|tostring), .state] | @tsv' 2>/dev/null) \
  || { echo "sync-pr: gh could not read PR #$PR" >&2; exit 2; }
BRANCH=$(printf '%s' "$info" | cut -f1)
BASE=$(printf '%s' "$info" | cut -f2)
CROSS=$(printf '%s' "$info" | cut -f3)
STATE=$(printf '%s' "$info" | cut -f4)
[ -n "$BRANCH" ] && [ -n "$BASE" ] || { echo "sync-pr: gh gave no branch for PR #$PR ($info)" >&2; exit 2; }
[ "$STATE" = OPEN ] || { echo "sync-pr: PR #$PR is $STATE, not open: nothing to sync" >&2; exit 2; }
[ "$CROSS" = false ] || { echo "sync-pr: PR #$PR comes from a fork: we cannot push to its branch" >&2; exit 2; }

git -C "$TOP" fetch -q origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" "+refs/heads/$BASE:refs/remotes/origin/$BASE" \
  || { echo "sync-pr: could not fetch $BRANCH and $BASE from origin" >&2; exit 2; }
HEAD_SHA=$(git -C "$TOP" rev-parse "origin/$BRANCH") || exit 2
BASE_SHA=$(git -C "$TOP" rev-parse "origin/$BASE") || exit 2
short(){ printf '%s' "$1" | cut -c1-8; }

if git -C "$TOP" merge-base --is-ancestor "$BASE_SHA" "$HEAD_SHA"; then
  echo "sync-pr: #$PR ($BRANCH) already has origin/$BASE $(short "$BASE_SHA"): nothing to do"
  echo "head $HEAD_SHA"
  exit 0
fi

if [ -e "$WT" ]; then
  echo "sync-pr: $WT is left from an earlier run: look at it, then git worktree remove it, and run again" >&2; exit 2
fi
mkdir -p "$(dirname "$WT")" || exit 2
git -C "$TOP" worktree add -q --detach "$WT" "$HEAD_SHA" || { echo "sync-pr: could not create the worktree $WT" >&2; exit 2; }

cleanup(){ git -C "$TOP" worktree remove --force "$WT" >/dev/null 2>&1 || true; }
stop(){ # MESSAGE — nothing is pushed
  echo "sync-pr: STOP, nothing pushed: #$PR ($BRANCH): $1" >&2
  if [ "$KEEP" = 1 ]; then
    echo "sync-pr: the worktree is kept as it stands: $WT (git worktree remove --force it when done)" >&2
  else
    git -C "$WT" merge --abort >/dev/null 2>&1
    cleanup
  fi
  exit 1
}

MB=$(git -C "$WT" merge-base "$HEAD_SHA" "$BASE_SHA")
MSG="Merge origin/$BASE into $BRANCH (word catalogs per key, by scripts/sync-pr.sh)"
# BEANPOOL_WORDS_MAIN=theirs: main is the side coming in. attr.tree: main's .gitattributes send the catalogs to the driver
# even on a branch that predates them.
OUT=$(cd "$WT" && BEANPOOL_WORDS_MAIN=theirs git -c core.fsmonitor=false -c attr.tree="$BASE_SHA" \
  -c merge.beanpool-words.name='BeanPool word catalogs, per key' \
  -c merge.beanpool-words.driver="node '$MERGER' --driver %O %A %B %P" \
  merge --no-ff --no-edit -m "$MSG" "$BASE_SHA" 2>&1)
RC=$?
UNMERGED=$(git -C "$WT" diff --name-only --diff-filter=U)
if [ -n "$UNMERGED" ] || [ "$RC" != 0 ]; then
  OTHER=$(printf '%s\n' "$UNMERGED" | sed '/^$/d' | grep -v -E "$CATALOG_RE")
  CATS=$(printf '%s\n' "$UNMERGED" | sed '/^$/d' | grep -E "$CATALOG_RE")
  WHY=""
  [ -n "$OTHER" ] && WHY="conflicts outside the word catalogs: $(echo $OTHER | cut -c1-300)"
  if [ -n "$CATS" ]; then
    REASONS=$(printf '%s\n' "$OUT" | grep '^words-merge-3way: ' | sed 's/^words-merge-3way: //' | head -5 | tr '\n' ';' | cut -c1-500)
    WHY="${WHY:+$WHY; }word catalogs that cannot be merged per key: ${REASONS:-$(echo $CATS | cut -c1-300)}"
  fi
  [ -n "$WHY" ] || WHY="git merge failed: $(printf '%s' "$OUT" | tail -3 | tr '\n' ' ' | cut -c1-300)"
  stop "$WHY"
fi

# Every catalog both sides changed went through the driver, which verified it. Checked again from the commits, so a
# merge where the attributes did not apply (a key added twice that git merged as text) cannot slip through.
BOTH=$(comm -12 <(git -C "$WT" diff --name-only "$MB" "$HEAD_SHA" | grep -E "$CATALOG_RE" | sort) \
                <(git -C "$WT" diff --name-only "$MB" "$BASE_SHA" | grep -E "$CATALOG_RE" | sort))
NBOTH=0
if [ -n "$BOTH" ]; then
  NBOTH=$(printf '%s\n' "$BOTH" | wc -l | tr -d ' ')
  # shellcheck disable=SC2086
  if ! VOUT=$(cd "$WT" && node "$MERGER" --base "$MB" --main "$BASE_SHA" --pr "$HEAD_SHA" --verify $BOTH 2>&1); then
    stop "word catalogs fail the per-key check after the merge: $(printf '%s' "$VOUT" | grep -v '^words-merge-3way: [0-9]* problem' | head -3 | sed 's/^ *//' | tr '\n' ';' | cut -c1-400)"
  fi
fi

CHECK=${SYNC_PR_WORDS_CHECK:-node scripts/words/words.mjs check}
if ! COUT=$(cd "$WT" && sh -c "$CHECK" 2>&1); then
  stop "the words check is red on the merge ($CHECK): $(printf '%s' "$COUT" | tail -5 | tr '\n' ' ' | cut -c1-400)"
fi

NEW=$(git -C "$WT" rev-parse HEAD)
if [ "$DRY" = 1 ]; then
  echo "sync-pr: --dry-run: #$PR ($BRANCH) merges cleanly with origin/$BASE $(short "$BASE_SHA") ($NBOTH word catalog(s) both sides changed, merged per key); not pushed"
  [ "$KEEP" = 1 ] && echo "sync-pr: worktree kept: $WT" || cleanup
  echo "head $NEW"
  exit 0
fi
# Fast-forward only: if the branch moved on origin since the fetch, the push is refused and nothing changes.
if ! POUT=$(git -C "$WT" push -q origin "HEAD:refs/heads/$BRANCH" 2>&1); then
  stop "the push was refused (did $BRANCH move on origin meanwhile? run it again): $(printf '%s' "$POUT" | tail -2 | tr '\n' ' ' | cut -c1-300)"
fi
cleanup
echo "sync-pr: #$PR ($BRANCH) synced: origin/$BASE $(short "$BASE_SHA") merged in, $NBOTH word catalog(s) both sides changed merged per key, words check ok, pushed"
echo "head $NEW"
