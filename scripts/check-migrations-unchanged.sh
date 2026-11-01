#!/bin/bash
# check-migrations-unchanged.sh — fails when a change edits, renames or deletes a migration step that has shipped.
#
# WHY. A numbered migration runs once per database and is then remembered as done (Cloudflare D1 records it in
# d1_migrations). Editing it afterwards changes nothing on the database it already ran on, and everything on a new one:
# the live registrar and a fresh one quietly stop having the same schema. A change to a shipped step is a NEW step.
#
# WHAT HAS SHIPPED. A migration file that is on origin/main, since the registrar is deployed from main at any time.
# Precisely: every file in the directories below as it stands at the merge base of this checkout with origin/main.
# This checkout's changes since then (committed or not) may ADD files; any other change to one of them fails.
# On main itself the merge base is HEAD, so main is compared with main before this commit (a push to main: what landed).
#
# WHAT IT DOES NOT COVER. The node's own schema steps are not files: they are the user_version and column-exists steps
# inside apps/server/src/db/db.ts, which no file-level check can tell apart from the rest of that file.
# apps/server/src/db/migrations/ holds one .sql file that no code applies; it is guarded anyway.
#
# With nothing to compare against it passes, on a line starting "⚪ SKIP:", which test-all.sh reports as skipped and not as
# a pass (and a run with one records no green). CI fetches origin/main for this (ci.yml, "Fetch origin/main"), so on a pull
# request or a train branch it really compares.

cd "$(dirname "$0")/.." || exit 1
DIRS=(apps/registrar/migrations apps/server/src/db/migrations)

if ! git rev-parse --verify -q origin/main >/dev/null; then
  echo "⚪ SKIP: no origin/main here, so no shipped migrations to compare against"
  exit 0
fi
BASE=$(git merge-base origin/main HEAD 2>/dev/null) || { echo "⚪ SKIP: no merge base with origin/main, so no shipped migrations to compare against"; exit 0; }
NO_PARENT=""
if [ "$BASE" = "$(git rev-parse HEAD)" ]; then
  if PARENT=$(git rev-parse --verify -q HEAD^1); then BASE=$PARENT; else NO_PARENT=1; fi
fi

# Against the working tree, so an uncommitted edit counts too. A (added) is the only status allowed.
CHANGED=$(git diff --name-status -M "$BASE" -- "${DIRS[@]}" | awk '$1 !~ /^A/')
if [ -n "$CHANGED" ]; then
  echo "❌ Shipped migration step(s) changed (compared with origin/main at $(git rev-parse --short "$BASE")):"
  echo "$CHANGED" | sed 's/^/     /'
  echo "   A migration that has run is never run again, so this edit would reach only new databases. Put the change"
  echo "   in a new, higher-numbered migration file instead, and leave the shipped one exactly as it was."
  exit 1
fi
if [ -n "$NO_PARENT" ]; then
  echo "⚪ SKIP: this is origin/main with no commit before it here, so nothing to compare it with"
  exit 0
fi
echo "✓ no shipped migration step changed ($(git ls-tree -r --name-only "$BASE" -- "${DIRS[@]}" | wc -l | tr -d ' ') shipped, compared with $(git rev-parse --short "$BASE"))"
