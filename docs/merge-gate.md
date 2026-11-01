# The merge gate

GitHub's merge queue is the only gate to `main` (Marty, 1 Nov 2026: "drop the Mac and go GH"). A cleared PR goes on the board, the queue tests it on top of the PRs ahead of it, and it lands only if the required check **Run BeanPool Test-All Pipeline** passes on that tree. The Mac holds no merge.

| Piece | Where |
|---|---|
| The check | `.github/workflows/ci.yml`: on `pull_request` and `merge_group`, 14 shards and the aggregate job |
| The ruleset | `.github/rulesets/protect-main.json` |
| The way in | `scripts/merge-queue/board.sh` |
| The way back after a flake | `scripts/merge-queue/requeue.sh` |
| The proof it says red | `scripts/merge-queue/self-test.sh` |
| The daily Mac run | `scripts/merge-queue/tripwire.sh` |
| The journal | `<git common dir>/test-all-queue/journal.log`, read every heartbeat, as before |

`scripts/check-ci-shards.test.mjs` fails on any edit that undoes the trigger or the ruleset.

## The numbers

| Setting | Value | Why |
|---|---|---|
| `max_entries_to_merge`, `min_entries_to_merge` | 1, 1 | One PR to a group. Tier-A and money PRs ride alone, and a red takes out only its own PR. |
| `max_entries_to_build` | 6 | Six at once is 6 PRs a run, past the 5 Marty set. Four would be 4. |
| `grouping_strategy` | `ALLGREEN` | Every PR's own commit must pass. |
| `merge_method` | `SQUASH` | As every merge here. |
| `check_response_timeout_minutes` | 120 | A slow run (55 min) behind a job queue. A timeout is a red, never a pass. |

**Why 6 fits in 60 jobs.** Measured on six runs on 1 Nov: a run is 15 jobs and 121-138 job-minutes over 16-29 minutes of wall clock, so it holds 5-8 slots on average, not 15. Six runs hold about 40 of the 60, on top of the 14 that PR runs held on average that day (9.3 runs an hour), so a full queue on a busy day uses most of what there is. `web-pages` alone sets the wall clock (16-29 min; the next is 15). Six starting at the same moment, as after a red, want 84 slots for the first ten minutes, and some shards wait for a slot.

**Sharing a group buys nothing.** Under `ALLGREEN` each PR's own commit must pass, so every PR still costs a build. Under `HEADGREEN` only the last commit must pass, so a PR that failed can land on a later PR's green, which is a pass nobody decided. So the throughput comes from building more at once.

**What a red costs.** The PR is taken out. Every PR behind it, up to 5, is rebuilt without it: each loses at most one run, about 23 minutes, and none is taken out. Their old runs carry on to the end, because `ci.yml`'s token is read-only and cannot cancel them: up to 5 × 130 job-minutes, and for those minutes job slots are short. If reds turn out to be common, lower `max_entries_to_build`: one number, and the trade is plain.

## Putting it on (the director, after this merges)

1. The PR that adds this merges under the old ruleset: the last `--admin` merge.
2. Apply: `gh api -X PUT repos/beanpool-org/beanpool/rulesets/19976145 --input .github/rulesets/protect-main.json`
3. Check: `gh api repos/beanpool-org/beanpool/rulesets/19976145 --jq '.current_user_can_bypass, [.rules[].type]'` must say `never` and list `merge_queue`.
4. Point the old board at the new one, by `mv`, never in place: `scratch/overnight/handover-20/board.sh` becomes `exec bash /Users/marty/projects/beanpool/scripts/merge-queue/board.sh "$@"`, once the primary tree has this.
5. The walk below.
6. Install the tripwire: `scripts/launchd/com.marty.beanpool-test-all-tripwire.plist.example`.

No review is required by the ruleset, deliberately. Every PR here is authored by `martyinspace`, the only code owner, who cannot approve their own PR: the old rule was only ever met by `--admin`. With no bypass it would stop every merge. The deciding review stays what it was: the director boards only what cleared it.

## The way in

```bash
bash scripts/merge-queue/board.sh 2700@<reviewed head> 2701@<reviewed head>
```

Run it in the background: it stays until each PR has landed or been taken out. The `@head` is optional and worth giving. A plain number takes the head as it is now.

It checks what the Mac queue checked: tier-A labels and the money list (`MONEY_PATHS` and `MONEY_LINE` in `scripts/test-all-train.sh`, read from main) set the order; the head is the one cleared and is queued by its sha, so a push since is refused; GitHub is green on it; each landing is verified by `--stat`, and that the commit is on main and carries the PR's files. It calls GitHub's `enqueuePullRequest`, not `gh pr merge`: that goes through auto-merge, which is off here, and an armed auto-merge outlives a later push. There is no quiet hour: the 03:15-03:40 pause was the Mac's `/tmp`, and GitHub has no such thing.

A conflict with main leaves the PR out with a line. `scripts/words-merge-3way.mjs` still merges word catalogs by key, by hand, on the branch: the queue cannot.

A queue entry's guide and words checks compare with its first parent, what it lands on, not with main under every entry. A guide publish behind a page edit is stale, so the queue takes it out: run `pnpm guide:publish --merge` again.

## A red in the queue

The queue takes the PR out. Nothing puts it back by itself, and the board refuses that head until `requeue.sh` has.

1. **Read the failure.** `gh run view <run>`, and the `test-all-logs-<shard>` artifact. The board names the run.
2. **An assertion failure stays red.** So does a failed build, lint, typecheck or a check that compared nothing. Fix it on the branch. A new head goes through the board as a new PR.
3. **A flake is the director's call, and only the director's**, with the failing test named and the log line that shows it was no assertion: a timeout, a runner lost, a network fetch. Nothing is passed on what its output looks like.
4. **One rerun of failed jobs, at most, per head:**

   ```bash
   bash scripts/merge-queue/requeue.sh 2700 --run <run id> --why "test-x timed out at 300 s: <log line>"
   ```

   It reruns that run's failed jobs. If they pass it boards the PR again, and **only a whole new queue run can land it**: the rerun is evidence and waives nothing. If they fail it stays out. If GitHub will not rerun a dead group's jobs, the new queue run is the one rerun.

   A PR taken out with nothing red (the queue's 120 minutes ran out, or someone removed it) has no failed jobs: `requeue.sh 2700 --no-run --why "<what happened>"`. It spends the same one rerun, and is refused if the PR has a red run.
5. **The second red of a head is real.** `requeue.sh` refuses it. Fix it, or take it to Marty.

`RERUN`, `REQUEUED`, `RED` and `OUT` lines go in the journal, and the rerun's reasons on the PR too. A test that goes red in the queue twice in a week gets a lane to fix it, not a third look.

`GREEN-BY-RERUN` is gone: the Mac's recheck counted a failure as green when the failing piece passed alone (10 times since 31 Oct). The queue has no such rule.

## Break-glass

Nothing in the ruleset: `bypass_actors` is empty, so `gh pr merge --admin` is refused and no script uses it. Marty decides, or a director on his word in chat, and only when the queue itself cannot work: GitHub Actions down, or the queue stuck. A red main is not that case: the fix goes through the queue, because a queue entry is main plus the fix.

```bash
gh api -X PUT repos/beanpool-org/beanpool/rulesets/19976145 --input .github/rulesets/protect-main.before-merge-queue.json
gh pr merge <PR> --squash --admin --match-head-commit <head>
gh api -X PUT repos/beanpool-org/beanpool/rulesets/19976145 --input .github/rulesets/protect-main.json
```

Journal it, with the reason. GitHub keeps the ruleset's history. The same file is the way back if the queue has to come off.

## The walk: proving it says red

Once, after the ruleset is applied, and again after any change to it. Not before: it refuses to start with no queue, with a bypass, or with PRs in the queue. About 2 hours and 9 full runs, in the foreground of a background shell.

```bash
bash scripts/merge-queue/self-test.sh        # prints the walk
bash scripts/merge-queue/self-test.sh --run
```

1. A PR adds `selftest-red.marker`, which `selftest.test.mjs` refuses. It goes red; the board leaves it out; `gh pr merge` does not merge it; `gh pr merge --admin` is refused.
2. Two PRs add `selftest-a.marker` and `selftest-b.marker`: green alone, red together. Boarded a then b: a lands, b is taken out and stays open, its queue run is red, and a rerun of its failed jobs stays red and does not put it back. This is the first real measure of two things the documents do not say: that a queue build holds the entries ahead when one PR is merged at a time, and that a dead group's jobs can be rerun.
3. A PR takes `selftest-a.marker` off main again, through the queue.

It closes what it opened and ends `PROVED` or `NOT PROVED`. The test step that goes red is a real assertion in the `workflows` check.

## The Mac

`scripts/test-all.sh` still runs on a Mac, for a lane or by hand, and decides nothing. `scripts/merge-queue/tripwire.sh` runs it on main once a day at 05:00: macOS, Node 26, unsharded, which GitHub is not. A red is a journal line and a fix PR. It never holds a merge. `scripts/test-all-train.sh --no-merge` still tests PRs together; without `--no-merge` its `--admin` is refused.
