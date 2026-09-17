# Lanes — pipeline scripts for delegated builds and reviews

A **lane** is a zsh script that drives agents through build → continue → PR → review → (deciding review) →
land, gating every step on what actually happened in git and on GitHub. This directory is the single, versioned
copy of that tooling. Lane scripts used to live in a session scratchpad under `/private/tmp`, which is cleared on
reboot, and each session forked its own `libN.sh`.

**The specification is `~/.claude/playbook/delegation-and-pipelines.md`** ("Pipeline scripts (lanes)" and "Headless
Claude builds"). Model routing (which model builds, reviews and decides) is in
`~/.claude/playbook/operating-model.md`, and AGY mechanics are in `~/.claude/playbook/agy.md`. This README does
not repeat them; the code comments name the incident behind each rule.

| File | What it is |
|---|---|
| `lib.sh` | The library. Source it from a run script. Stages for both backends, watchdog, gates, land, deploy, process-tree and worktree helpers. |
| `decide.sh` | Deciding reviews: one at a time, behind a machine-wide lock, probing the model first. `lib.sh` sources it. |
| `start.sh` | Runs `run-<lane>.sh` in the foreground under `caffeinate -i`, logging to `scratch/lanes/log-<lane>.txt`. |
| `watch.sh` | Exits, which wakes the director, when a lane is stuck on quota, has no capacity, had a deciding review downgraded, holds a PR, or when all lanes have stopped. |
| `stop.sh` | Stops lanes now, killing each lane's whole process tree. |
| `stop-at-boundary.sh` | Lets each lane finish its current stage, then stops it as a FIX, SYNC or deciding stage starts. |
| `sweep-orphans.sh` | Lists (or `--kill`s) test runners reparented to launchd that are more than an hour old. |
| `remove-worktree.sh` | Removes finished worktrees: stops fsmonitor, unlocks, removes, and checks each step. |
| `headless-brief-rules.md` | Appended to every headless Claude brief. |
| `agy-brief-rules.md` | Appended to every AGY brief. |
| `test/selftest.sh` | Proves all of the above against fake `agy`/`claude`/`gh`/`ssh`. No real model, PR or node is touched. |

## Running a lane

Everything a lane produces goes under the checkout's git-ignored `scratch/lanes/`. Briefs go in
`scratch/lanes/briefs/`, run scripts in `scratch/lanes/run-<lane>.sh`, and logs, stage output and model markers
sit beside them. Worktrees go in `.claude/worktrees/lane-<lane>`, which is also where `claude --worktree` puts them.

```zsh
# scratch/lanes/run-s7.sh
#!/bin/zsh
source "$(git -C "${0:A:h}" rev-parse --show-toplevel)/scripts/lanes/lib.sh"
LANE_BUILD_BACKEND=claude            # high-risk build: headless Opus 5. Omit for AGY Flash.
log "lane S7 — keeper succession"
item S7 feat/s7-keepers S7-keepers.md   # build → CONTINUE → open PR → 2 early passes → deciding pass
[ "$CLEAN" = 1 ] && land "$PR"          # CI green, then HELD unless LANE_MERGE=1
log "LANE S7 DONE (clean=$CLEAN merged=$MERGED)"
```

The director launches both of these with the Bash tool's `run_in_background: true`, in the foreground form shown:

```zsh
scripts/lanes/start.sh scratch/lanes/run-s7.sh
scripts/lanes/watch.sh
```

To stop a lane, run `scripts/lanes/stop.sh s7` (now) or `scripts/lanes/stop-at-boundary.sh s7` (after the current
stage). Afterwards, run `scripts/lanes/sweep-orphans.sh` and, once a worktree is clean and pushed,
`scripts/lanes/remove-worktree.sh .claude/worktrees/lane-s7`.

The building blocks are `stage NAME TIMEOUT BRIEF [ROLE]`, `cont`, `item`, `review`, `decide_review`,
`decide_pass PR BRANCH`, `sync_main`, `land PR [hold]`, `merge_if_clean`, `deploy_main NODE SYMBOL [LABEL]`,
`count`, `prnum` and `gh_try`. The comment above each function describes its contract.

## Backends and models

There are three roles. `build` covers builds, CONTINUE, FIX and SYNC stages. `review` covers the early CCR passes.
`decide` covers the pass that gates a merge: `CCR-*-3`, `CCR-*-sync` and `decide_pass`. Each role picks a backend
through `LANE_BUILD_BACKEND`, `LANE_REVIEW_BACKEND` and `LANE_DECIDE_BACKEND`:

- **`agy`** runs `agy -p=… --model … --print-timeout … --output-format stream-json` inside the lane worktree.
- **`claude`** runs the newest IDE-bundled `claude -p … --model … --permission-mode auto --output-format stream-json
  --verbose`. The first stage uses `--worktree lane-<lane>` from the repo root; later stages run inside that
  worktree. The run exits when the model stops. The library waits on the process and never on a promised report.
  It kills anything the run left in the background and logs a warning when the final message promises a later
  report.
- **`director`** applies only to `decide`. It holds the PR and logs `ready for the in-session deciding review`,
  which wakes `watch.sh`.

The model for a role is resolved each attempt, in this order: the `LANE_BUILD_MODEL` / `LANE_REVIEW_MODEL` /
`LANE_DECIDE_MODEL` env var for this run, then the marker file `scratch/lanes/model-<role>-<backend>` in this
checkout, then the default. Defaults are `gemini-3.8-flash-high` for AGY, `claude-opus-5` for Claude builds and
`claude-fable-5-1` for Claude deciding passes. To switch a running lane, use one `echo` into its marker. Markers
are per checkout: never use `~/.agy-model`, because a shared marker moved other sessions' lanes.

A deciding pass never quietly runs on a weaker model. It probes first and waits for the model. If
`LANE_DECIDE_FALLBACK_MODEL` is set and used, the pass is marked DOWNGRADED, logs `VERIFY THIS PR BY HAND`, and no
gate counts it as clean.

## Gates

- `count` returns `-1` when GitHub does not answer, after four tries through `gh_try`. Every gate refuses `-1`.
- A killed, idle-killed, errored or downgraded stage never satisfies a review gate.
- The idle watchdog kills a stage only when its output has not grown for 45 min **and** no worktree file has
  changed for 30 min. For AGY, the idle banner must also be present. An idle-kill never retries the brief.
- 503 "No capacity" is not quota. The library logs `NO CAPACITY`, re-reads the marker and does not sit in a quota
  wait.
- `land` checks that a merge landed on `origin/<base>` by reading git history, not the MERGED label. It merges only
  when `LANE_MERGE=1`; otherwise it holds.

## Deploying

`deploy_main NODE SYMBOL [LABEL]` has **no default node**, because plain `deploy.sh` deploys to every node. It
refuses a live community (`LANE_LIVE_NODES`) unless `LANE_ALLOW_LIVE_DEPLOY` names that exact node. It also
refuses when the deploy worktree has no `.env`, since deploy.sh would push empty secrets, and when that worktree
has edits to tracked files. It waits for the image build of `origin/main`, runs
`DEPLOY_TAG=<sha> DEPLOY_PULL=1 bash deploy.sh NODE` under a machine-wide lock, and then sets `DEPLOY_OK=1` only
if both of these hold in the **running** container:

- the `org.opencontainers.image.revision` label equals the commit
- `SYMBOL` is found by grep

## Configuration

Every setting is an env var with a default derived from the checkout (see the top of `lib.sh`): `LANE_REPO`,
`LANE_NAME`, `LANE_BASE`, `LANE_STATE`, `LANE_WT`, `LANE_DEPLOY_WT`, `LANE_LOCK_DIR` (machine-wide, under
`$TMPDIR`), `LANE_GH_REPO`, `LANE_AGY_BIN`, `LANE_CLAUDE_BIN`, `LANE_BUILD_TIMEOUT` (60m), `LANE_REVIEW_TIMEOUT`
(40m), `LANE_HEADER_FILE`, and the timing knobs (`LANE_IDLE_OUTPUT_SECS`, `LANE_IDLE_WT_SECS`, `LANE_WAIT_SECS`, …).

## zsh gotchas (each one has broken a lane script)

- **Unquoted variables are not word-split.** `for p in $PIDS` runs once, with the whole list as one string. Use an
  array, `PIDS=( $(pgrep …) )`, or `${(f)PIDS}`. Command substitution `$(…)` *is* split.
- **`$var[…]` is a subscript.** `"run-$l[.]sh"` fails with "bad floating point constant". Write `"run-${l}[.]sh"`.
- **A colon after a variable is a modifier.** `git show $TAG:apps/x.ts` expands `$TAG:a` ("make absolute"). With
  `2>/dev/null` it fails silently; that once reported every release "not vulnerable". Write `"${TAG}:apps/x.ts"`.
- **Don't put `&` or `nohup … &` inside a call that is already backgrounded** (`run_in_background`). The task
  "completes" instantly and the work runs on unwatched. `start.sh` is meant to run in the foreground.
- **An `EXIT` trap set inside a function fires when that function returns**, not when the script exits. The old
  `opus_begin` released its lock the moment it took it. Locks here are released explicitly or by traps set at the
  top level of `lib.sh`.
- **`status` is a read-only special parameter** (as are `path`, `argv` and `pipestatus`). `local status` fails,
  and a verdict computed into it comes back empty. The self-test caught this in the port.
- **`print "--- x"` treats the argument as options.** Use `print -r -- "…"` for anything that could start with `-`.
- **`pgrep -f "run-x[.]sh"`**: the bracket keeps the pattern from matching its own command line.
- **Functions load at source time.** A running lane keeps the library version it started with. Fix this copy and
  restart the lane; don't fork `libN+1.sh`.

These scripts are macOS-only (`stat -f`, `find -mtime -Ns`, `caffeinate`), because lanes run on the Mac.

## Testing changes

```zsh
for f in scripts/lanes/*.sh scripts/lanes/test/selftest.sh; do zsh -n "$f"; done
zsh scripts/lanes/test/selftest.sh      # ~2 min; fakes only; prints each scenario's lane log and ✓/✗ checks
```
