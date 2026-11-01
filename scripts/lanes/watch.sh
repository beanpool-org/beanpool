#!/bin/zsh
# watch.sh — exits (waking the director, who runs it with run_in_background) when a lane needs attention:
#   STUCK ON QUOTA        a lane has sat in a quota wait with no log progress for 25 min
#   NO CAPACITY           a model returned 503 — waiting will not help, switch the model marker
#   DECIDING REVIEW DOWNGRADED   a deciding pass retried on a fallback model; the PR needs a human read
#   READY FOR DECIDING REVIEW / HELD   a PR is waiting for the in-session deciding review or the maintainer
#   NOT REVIEWED          GitHub was not green on a PR's head and the lane has stopped trying; its deciding pass never ran
#   LANE DONE             a run script's last line, "LANE <name> DONE (clean=… pr=…) — HELD for the director"
#   ALL LANES STOPPED     every lane it saw running has exited
# Silence is the failure mode: without this, a lane stuck at 02:00 is found at 09:00.
#
# Lanes are discovered at every poll (log-*.txt plus a running run-<lane>.sh) — v2 hard-coded lane names and went
# on reporting "all lanes died" about lanes that had been deliberately retired. One-shot events are remembered in
# scratch/lanes/.watch-seen so restarting the watcher does not fire on the same line again.
source "${0:A:h}/lib.sh"
SEEN="$LANE_STATE/.watch-seen"
SAW_ANY=0
once(){ # KEY → 0 the first time KEY is seen
  mkdir -p "$LANE_STATE"; touch "$SEEN"
  grep -qxF -- "$1" "$SEEN" && return 1
  print -r -- "$1" >> "$SEEN"; return 0; }
while :; do
  RUNNING=()
  for f in $LANE_STATE/log-*.txt(N); do
    lane=${${f:t:r}#log-}
    # Before the running check: a lane's run script logs DONE and exits right after a hold, so by the next poll it has gone.
    if [ "$(lane_mtime "$f")" -gt "$(( $(date +%s) - 7200 ))" ]; then
      ev=$(tail -30 "$f" | grep -E "NO CAPACITY|VERIFY THIS PR BY HAND|ready for the in-session deciding review|HELD for the maintainer|LEFT FOR THE DIRECTOR" | tail -1)
      # Its own event, not one more word in the list above: a hold and the run script's last line land in the same second,
      # and with both in that list, tail -1 would always pick the last line and no hold would ever show its headline.
      fin=$(tail -30 "$f" | grep -F "HELD for the director" | tail -1)
      woke=0
      if [ -n "$ev" ] && once "$lane $ev"; then
        woke=1
        case "$ev" in
          *"NO CAPACITY"*)                 print "NO CAPACITY on lane $lane at $(date +%H:%M) — switch the model marker";;
          *"VERIFY THIS PR BY HAND"*)      print "DECIDING REVIEW DOWNGRADED on lane $lane at $(date +%H:%M) — the strong model did not answer";;
          *"ready for the in-session"*)    print "READY FOR DECIDING REVIEW on lane $lane at $(date +%H:%M)";;
          *"HELD for the maintainer"*)     print "PR HELD FOR THE MAINTAINER on lane $lane at $(date +%H:%M)";;
          *"LEFT FOR THE DIRECTOR"*)       print "NOT REVIEWED on lane $lane at $(date +%H:%M) — GitHub not green, PR left for the director";;
        esac
      fi
      if [ -n "$fin" ] && once "$lane $fin"; then
        woke=1
        # A # that matches nothing leaves the whole line, and its first word is the timestamp: look before cutting.
        c=?; p=
        [[ "$fin" == *"clean="* ]] && c=${${fin#*clean=}%%[ )]*}
        [[ "$fin" == *" pr="* ]] && p=${${fin#* pr=}%%[ )]*}
        print "LANE DONE on lane $lane at $(date +%H:%M) — clean=$c, ${${p:+PR #$p}:-no PR}, held for the director"
      fi
      if [ "$woke" = 1 ]; then tail -4 "$f"; exit 0; fi
    fi
    (( ${#$(lane_pids "$lane")} )) || continue
    RUNNING+=("$lane")
    LAST=$(tail -1 "$f")
    case "$LAST" in
      *"waiting for "*"(quota"*|*" still unavailable"*|*" never came back"*)
        AGE=$(( $(date +%s) - $(lane_mtime "$f") ))
        if [ "$AGE" -ge 1500 ]; then
          print "STUCK ON QUOTA: lane $lane — no progress for $((AGE/60)) min at $(date +%H:%M)"
          for m in $LANE_STATE/model-*(N); do print "  ${m:t}: $(cat "$m")"; done
          tail -4 "$f"; exit 0
        fi ;;
    esac
  done
  (( ${#RUNNING} )) && SAW_ANY=1
  if [ "$SAW_ANY" = 1 ] && (( ${#RUNNING} == 0 )); then
    print "ALL LANES STOPPED at $(date +%H:%M)"
    for f in $LANE_STATE/log-*.txt(N); do
      [ "$(lane_mtime "$f")" -gt "$(( $(date +%s) - 7200 ))" ] || continue
      print -r -- "--- ${f:t}"; tail -2 "$f"
    done
    exit 0
  fi
  sleep "${LANE_WATCH_SECS:-180}"
done
