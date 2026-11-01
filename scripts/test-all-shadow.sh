#!/bin/bash
# test-all-shadow.sh — reads the shadows of `test-all-train.sh --shadow`, the week's comparison of GitHub with the Mac
# (Marty, 1 Nov 2026: "compare for a week"; the Mac decides every merge meanwhile).
#
#   bash scripts/test-all-shadow.sh
#
# For each line of <git common dir>/test-all-queue/shadow.log ("<date> <time> prs=… sha=… run=… local=… branch=…") it reads
# the run from GitHub, writes a finished run's result into that line (github=<conclusion>), prints the line, and lists where
# the Mac and GitHub disagree. Then it deletes each train/* branch whose run has finished, or never started. A branch with
# no line (a train killed outright, or one still running) goes when its run has finished; it is left if it has no run.
#
# It writes shadow.log and deletes train/* branches. It reads everything else, and it never merges, re-runs or cancels.
# The rewrite holds the log's lock (test-all-lib.sh), as a train's line does, and is dropped when it cannot go in cleanly:
# nothing is lost, the next read asks GitHub again. So a train's line is never lost, and two readers at once are safe.
# Exit: 0 (a disagreement is a finding, not a failure); 2 not in a repository.

set -o pipefail
# shellcheck source=test-all-lib.sh
. "$(cd "$(dirname "$0")" && pwd)/test-all-lib.sh"
git rev-parse --git-dir >/dev/null 2>&1 || { echo "❌ not inside a git repository." >&2; exit 2; }
LOG="$(git rev-parse --path-format=absolute --git-common-dir)/test-all-queue/shadow.log"
TMP="$LOG.tmp.$$"; READ="$LOG.read.$$"; LOCKED=0
trap 'rm -f "$TMP" "$READ"; [ $LOCKED -eq 0 ] || shadow_unlock "$LOG"' EXIT

field() { sed -n "s/.* $1=\([^ ]*\).*/\1/p" <<<"$2"; }
# run_of <branch>: the ci.yml run on it, or nothing.
run_of() { gh run list --workflow ci.yml --branch "$1" --limit 1 --json databaseId --jq '.[0].databaseId // empty' 2>/dev/null; }
# result_of <run>: its conclusion once finished, "pending" until then, or nothing when GitHub could not be read.
result_of() { gh run view "$1" --json status,conclusion --jq 'if .status == "completed" then .conclusion else "pending" end' 2>/dev/null; }
# delete <branch> <why>. Only the train/* branches ls-remote lists below reach it, whatever a line of the log says.
delete() {
  if git push --quiet --no-verify origin --delete "$1" 2>/dev/null; then echo "   deleted $1 ($2)"; else echo "   could not delete $1 ($2)"; fi
}

DISAGREE=""; FINISHED=" "; IN_LOG=" "
if [ -s "$LOG" ]; then
  # A copy, whole even if another reader swaps the file now. Its size: a train appending while this reads keeps its line
  # (the tail copied below).
  cp "$LOG" "$READ"
  SIZE=$(wc -c < "$READ" | tr -d ' ')
  : > "$TMP"
  echo "Shadows ($LOG):"
  while IFS= read -r line <&3; do
    branch=$(field branch "$line"); run=$(field run "$line"); mac=$(field local "$line"); github=$(field github "$line")
    IN_LOG="$IN_LOG$branch "
    if [ "$run" = unknown ]; then
      found=$(run_of "$branch")
      if [ -n "$found" ]; then line=${line/ run=unknown/ run=$found}; run=$found; fi
    fi
    if [ -z "$github" ]; then
      if [ "$run" = none ]; then github=none
      elif [ "$run" = unknown ]; then github=""
      else github=$(result_of "$run"); fi
      [ -z "$github" ] || [ "$github" = pending ] || line="$line github=$github"
    fi
    printf '%s\n' "$line" >> "$TMP"
    case "$github" in ''|pending) ;; *) FINISHED="$FINISHED$branch " ;; esac
    case "$mac:$github" in
      green*:success|red:failure|red:timed_out|red:startup_failure) said=agree ;;
      green*:failure|green*:timed_out|green*:startup_failure) said="DISAGREE: the Mac is green, GitHub is not" ;;
      red:success) said="DISAGREE: the Mac is red, GitHub is green" ;;
      *:|*:pending) said="waiting for GitHub" ;;
      *) said="not compared" ;;
    esac
    echo "  $(cut -d' ' -f1-2 <<<"$line") #$(field prs "$line" | sed 's/,/ #/g') $(field sha "$line" | cut -c1-9): Mac ${mac:-?}, GitHub ${github:-unread}, run $run: $said"
    case "$said" in DISAGREE*) DISAGREE="$DISAGREE
  #$(field prs "$line" | sed 's/,/ #/g') $(field sha "$line" | cut -c1-9) run $run: Mac $mac, GitHub $github" ;; esac
  done 3< "$READ"
  if ! cmp -s "$READ" "$TMP"; then
    if shadow_lock "$LOG"; then
      LOCKED=1
      # After another reader's swap the bytes past $SIZE are not a train's lines but the middle of one of that reader's.
      if head -c "$SIZE" "$LOG" | cmp -s - "$READ"; then
        tail -c +$((SIZE + 1)) "$LOG" >> "$TMP"
        mv "$TMP" "$LOG"
      else
        echo "  (results not written: another reader rewrote shadow.log meanwhile; its copy stands)"
      fi
      shadow_unlock "$LOG"; LOCKED=0
    else
      echo "  (results not written: $LOG.lock is held; a process killed outright leaves it, so if none is running, remove it)"
    fi
  fi
else
  echo "No shadows yet ($LOG)."
fi

echo ""
if [ -n "$DISAGREE" ]; then echo "Disagreements:$DISAGREE"; else echo "Disagreements: none."; fi

echo ""
echo "Train branches:"
BRANCHES=$(git ls-remote --heads origin 'refs/heads/train/*' 2>/dev/null | sed 's|.*refs/heads/||')
[ -n "$BRANCHES" ] || echo "   none on origin"
for b in $BRANCHES; do
  case "$IN_LOG" in
    *" $b "*)
      case "$FINISHED" in *" $b "*) delete "$b" "finished" ;; *) echo "   kept $b (its run has not finished)" ;; esac ;;
    *)
      run=$(run_of "$b")
      if [ -z "$run" ]; then echo "   kept $b: no line in shadow.log and no run on GitHub"; continue; fi
      case "$(result_of "$run")" in
        ''|pending) echo "   kept $b (no line in shadow.log yet; run $run has not finished)" ;;
        *) delete "$b" "no line in shadow.log, run $run finished" ;;
      esac ;;
  esac
done
