#!/bin/bash
# Does a deploy actually preserve a node's data/ and .env?
#
# WHY THIS EXISTS. deploy.sh wipes the project directory on every run and moves data/ and .env
# aside first. `mv SRC DEST` moves SRC *into* DEST when DEST is an existing directory instead of
# replacing it, and both moves used to be `mv ... 2>/dev/null || true`. So a backup left behind by
# an interrupted deploy did not just waste disk — the NEXT deploy buried the live data one level
# down at data/data/ and populated data/ from the STALE backup. The node then booted on a
# different community.key with no state.db where it expected one. Found on `test` 2026-08-25,
# holding 220 MB, and it is the likeliest explanation for that node's identity changing on
# 2026-07-28.
#
# This does not re-implement the logic — it EXTRACTS the marked block out of deploy.sh and runs
# it, so the thing under test is the shipped code. A copy would pass while deploy.sh regressed.
#
#   bash scripts/test-deploy-preserve.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SB="$(mktemp -d)"; trap 'rm -rf "$SB"' EXIT
run=0; passed=0
assert() { run=$((run+1)); if [ "$2" = "$3" ]; then passed=$((passed+1)); echo "✓ $1"; else echo "✗ $1 (expected '$3', got '$2')"; fi; }

BLOCK="$SB/block.sh"
sed -n '/--- BEGIN preserve\/restore/,/--- END preserve\/restore/p' "$ROOT/deploy.sh" > "$BLOCK"
[ -s "$BLOCK" ] || { echo "✗ could not extract the preserve/restore block from deploy.sh"; exit 1; }
grep -q 'FATAL' "$BLOCK" || { echo "✗ extracted block is missing its fatal guards"; exit 1; }

# The block lives inside deploy.sh's UNQUOTED heredoc, so the LOCAL shell expands it before it is
# sent to the node. A backtick or an unescaped dollar-paren there runs on the operator's machine —
# and it does so even inside a comment. On 2026-08-25 a backticked comment produced
# "syntax error near unexpected token ||" on every node deployed, twice each. Harmless that time
# only because the substitution failed; a comment quoting a real command would have executed it.
BT='`'
if grep -q "$BT" "$BLOCK"; then
  echo "✗ preserve/restore block contains a backtick — the local shell will run it (comments included)"
  grep -n "$BT" "$BLOCK" | head -5
  exit 1
fi
if grep -qE '(^|[^\\])\$\(' "$BLOCK"; then
  echo "✗ preserve/restore block contains an unescaped \$( — the local shell will run it"
  grep -nE '(^|[^\\])\$\(' "$BLOCK" | head -5
  exit 1
fi
echo "✓ block is free of backticks and unescaped command substitution"

# Simulate a node, with the precondition that caused the bug: a leftover backup from a deploy
# that died between the two moves.
HOME_DIR="$SB/root"; DIR="BeanPool-Test"; PROJECT_DIR="$HOME_DIR/$DIR"
mkdir -p "$PROJECT_DIR/data" "$HOME_DIR/beanpool-data-backup-$DIR"
echo "LIVE-IDENTITY"  > "$PROJECT_DIR/data/community.key"
echo "LIVE-LEDGER"    > "$PROJECT_DIR/data/state.db"
echo "LIVE-ENV"       > "$PROJECT_DIR/.env"
echo "STALE-IDENTITY" > "$HOME_DIR/beanpool-data-backup-$DIR/community.key"
mkdir -p "$SB/src" && echo "new code" > "$SB/src/README.md"
tar -czf "$HOME_DIR/beanpool-deploy.tar.gz" -C "$SB/src" .

# deploy.sh runs this over ssh with sudo available; locally it is a no-op passthrough.
sudo() { "$@"; }
export HOME_DIR DIR PROJECT_DIR
# shellcheck disable=SC1090
. "$BLOCK"

assert "the live identity survives (not replaced by the stale backup)" \
       "$(cat "$PROJECT_DIR/data/community.key" 2>/dev/null || echo MISSING)" "LIVE-IDENTITY"
assert "the live ledger survives at data/state.db" \
       "$(cat "$PROJECT_DIR/data/state.db" 2>/dev/null || echo MISSING)" "LIVE-LEDGER"
assert ".env survives" \
       "$(cat "$PROJECT_DIR/.env" 2>/dev/null || echo MISSING)" "LIVE-ENV"
assert "the new build is deployed" \
       "$(cat "$PROJECT_DIR/README.md" 2>/dev/null || echo MISSING)" "new code"
assert "nothing is buried at data/data/" \
       "$([ -e "$PROJECT_DIR/data/data" ] && echo nested || echo clean)" "clean"
assert "no backup dir nested inside data/" \
       "$(find "$PROJECT_DIR/data" -maxdepth 1 -name 'beanpool-*backup*' 2>/dev/null | wc -l | tr -d ' ')" "0"
assert "the stale backup is parked outside the project dir, not deleted" \
       "$([ -e "$HOME_DIR/beanpool-data-backup-$DIR.stale/community.key" ] && echo parked || echo gone)" "parked"

# Second run, now with no leftover backup: the ordinary path must still round-trip.
rm -rf "$HOME_DIR/beanpool-data-backup-$DIR.stale"
. "$BLOCK"
assert "a clean deploy still round-trips the ledger" \
       "$(cat "$PROJECT_DIR/data/state.db" 2>/dev/null || echo MISSING)" "LIVE-LEDGER"
assert "a clean deploy leaves no stale dir behind" \
       "$([ -e "$HOME_DIR/beanpool-data-backup-$DIR.stale" ] && echo yes || echo no)" "no"

echo ""
echo "$passed/$run passed"
[ "$passed" = "$run" ] || exit 1
