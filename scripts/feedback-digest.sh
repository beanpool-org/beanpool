#!/bin/zsh
# feedback-digest.sh — the weekly "Suggest a change to BeanPool" digest.
#
#   1. reads the admin token from the macOS keychain (item `beanpool-feedback-admin`) — never from a
#      file or an argument, never echoed; curl gets it through a 0600 header file in a private temp dir
#   2. fetches every item with status=new from the feedback Worker (apps/feedback)
#   3. runs a headless Claude (claude-sonnet-5, NO tools, no MCP) with scripts/feedback-digest-prompt.md:
#      drop spam, translate, cluster, count communities
#   4. writes .claude/queue-board/feedback-digest.md (one screen) for the queue board
#   5. marks each fetched item spam or triaged via the admin API
#
# Filing GitHub Discussions is NOT automatic: the digest lists candidates and Marty decides.
# Runs in the foreground. Nothing is marked unless the digest was written first, so a failed run
# leaves every item `new` for the next one.
#
# Usage:  scripts/feedback-digest.sh [--dry-run]     (--dry-run: write the digest, mark nothing)
# Env:    FEEDBACK_BASE  (default https://beanpool.org/api/feedback; e.g. http://127.0.0.1:8787/api/feedback for wrangler dev)
#         CLAUDE_BIN     (default: claude on PATH)
# Weekly schedule: scripts/launchd/com.marty.beanpool-feedback-digest.plist.example

emulate -L zsh
setopt err_exit pipe_fail no_unset

DRY_RUN=0
for arg in "$@"; do
  case $arg in
    --dry-run) DRY_RUN=1 ;;
    *) print -u2 "usage: ${0:t} [--dry-run]"; exit 2 ;;
  esac
done

# launchd starts us with a bare PATH; claude usually lives in one of these.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

SCRIPT_DIR=${0:A:h}
REPO_ROOT=${SCRIPT_DIR:h}
BASE=${FEEDBACK_BASE:-https://beanpool.org/api/feedback}
PROMPT_FILE=$SCRIPT_DIR/feedback-digest-prompt.md
OUT_DIR=$REPO_ROOT/.claude/queue-board
OUT=$OUT_DIR/feedback-digest.md
MODEL=claude-sonnet-5
CLAUDE_BIN=${CLAUDE_BIN:-claude}
LIMIT=500

die() { print -u2 -- "feedback-digest: $*"; exit 1; }

for tool in curl jq perl security $CLAUDE_BIN; do
  command -v $tool >/dev/null 2>&1 || die "missing $tool"
done
[[ -r $PROMPT_FILE ]] || die "missing $PROMPT_FILE"

umask 077
WORK=$(mktemp -d "${TMPDIR:-/tmp}/beanpool-feedback-digest.XXXXXX")
trap 'rm -rf -- "$WORK"' EXIT INT TERM

# --- token: keychain → header file (never argv, never stdout) ---
TOKEN=$(security find-generic-password -s beanpool-feedback-admin -w 2>/dev/null) \
  || die "no keychain item 'beanpool-feedback-admin' — see apps/feedback/README.md (Deploy, step 2)"
[[ -n $TOKEN ]] || die "keychain item 'beanpool-feedback-admin' is empty"
print -r -- "Authorization: Bearer $TOKEN" > $WORK/auth.h
unset TOKEN

# api METHOD ROUTE [BODY_FILE] → response body in $WORK/resp, HTTP status on stdout.
# (`route`, not `path`: in zsh $path is tied to $PATH.)
api() {
  local method=$1 route=$2 data=${3:-}
  local -a args=(-sS --max-time 60 -o $WORK/resp -w '%{http_code}' -X $method -H @$WORK/auth.h)
  [[ -n $data ]] && args+=(-H 'content-type: application/json' --data-binary @$data)
  curl $args "$BASE$route" || print 000
}

# --- 1. fetch ---
code=$(api GET "/admin/items?status=new&limit=$LIMIT")
[[ $code == 200 ]] || die "fetching new items failed (HTTP $code)"
mv $WORK/resp $WORK/items.json
jq -e '.items | type == "array"' $WORK/items.json >/dev/null || die "unexpected response shape from $BASE"
N=$(jq '.items | length' $WORK/items.json)
TOTAL=$(jq '.total // (.items | length)' $WORK/items.json)
WEEK=$(date +%Y-%m-%d)

mkdir -p $OUT_DIR
write_out() { # atomically replace the digest with stdin
  local tmp=$OUT_DIR/.feedback-digest.md.tmp
  cat > $tmp
  chmod 644 $tmp
  mv -f $tmp $OUT
}

if (( N == 0 )); then
  print -r -- "# BeanPool feedback — week of $WEEK

No new suggestions this week." | write_out
  print "feedback-digest: no new items; wrote $OUT"
  exit 0
fi

# --- 2. sort with a headless Claude: no tools, no MCP, run from the empty temp dir ---
jq -c '.items | map({id, text, kind, source, app_version, platform, lang, community, received_at})' \
  $WORK/items.json > $WORK/items-slim.json
{
  cat $PROMPT_FILE
  print
  print '<items>'
  cat $WORK/items-slim.json
  print '</items>'
} > $WORK/prompt.txt

print "feedback-digest: sorting $N item(s) with $MODEL…"
( cd $WORK && $CLAUDE_BIN -p --model $MODEL --tools '' --strict-mcp-config --no-session-persistence \
    --output-format json < $WORK/prompt.txt > $WORK/claude.json ) \
  || die "claude run failed; nothing marked, items stay new"
jq -e '.is_error != true and (.result | type == "string")' $WORK/claude.json >/dev/null \
  || die "claude returned an error; nothing marked, items stay new"

# The reply should be bare JSON; tolerate code fences or stray prose around one object.
jq -r '.result' $WORK/claude.json | perl -0777 -ne 'print $1 if /(\{.*\})/s' > $WORK/reply.json
jq -e '(.digest_markdown | type == "string" and length > 0) and (.decisions | type == "array")' \
  $WORK/reply.json >/dev/null 2>&1 || die "could not parse the digest reply; nothing marked, items stay new"

# Keep only decisions for ids we actually fetched, with an allowed status, one per id.
jq --slurpfile items $WORK/items.json '
  ($items[0].items | map(.id)) as $ids
  | .decisions
  | map(select((.id | type) == "number" and (.status == "spam" or .status == "triaged")))
  | map(select(.id as $i | $ids | index($i)))
  | unique_by(.id)
  | map({id, status, note: ((.note // "") | tostring | .[0:200])})' \
  $WORK/reply.json > $WORK/decisions.json

SPAM=$(jq '[.[] | select(.status == "spam")] | length' $WORK/decisions.json)
DECIDED=$(jq 'length' $WORK/decisions.json)
UNDECIDED=$(( N - DECIDED ))
MORE=$(( TOTAL - N ))

# --- 3. write the digest (before marking anything) ---
{
  print -r -- "# BeanPool feedback — week of $WEEK"
  print
  print -r -- "_$N new suggestion(s) read · $SPAM dropped as spam$( (( MORE > 0 )) && print -n " · $MORE more still waiting (next run)" )$( (( UNDECIDED > 0 )) && print -n " · $UNDECIDED not sorted by the model, left new" )$( (( DRY_RUN )) && print -n " · DRY RUN: nothing marked" )_"
  print
  jq -r '.digest_markdown' $WORK/reply.json
  print
  print -r -- "_Item ids refer to the feedback Worker (apps/feedback). Filing on GitHub is manual._"
} | write_out
print "feedback-digest: wrote $OUT"

if (( DRY_RUN )); then
  print "feedback-digest: dry run — $DECIDED item(s) would be marked ($SPAM spam)"
  exit 0
fi

# --- 4. mark each fetched item ---
FAILED=0
MARKED=0
while IFS= read -r d; do
  id=$(jq -r '.id' <<< $d)
  jq '{status, note}' <<< $d > $WORK/body.json
  code=$(api POST "/admin/items/$id" $WORK/body.json)
  if [[ $code == 200 ]]; then (( ++MARKED )); else (( ++FAILED )); print -u2 "feedback-digest: marking $id failed (HTTP $code)"; fi
done < <(jq -c '.[]' $WORK/decisions.json)

print "feedback-digest: marked $MARKED item(s) ($SPAM spam); $UNDECIDED left new; $FAILED failed"
(( FAILED == 0 ))
