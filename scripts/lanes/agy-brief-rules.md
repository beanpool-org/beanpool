=== RULES — READ FIRST ===
- Work ONLY in the worktree named by WT_INT below. Never use the maintainer's own checkout.
- Branch: the one named in the task above, and no other. If the task does not name a branch, STOP and say so
  rather than guessing or pushing to one you found checked out.
- Push to origin after EVERY logical step, not at the end — several earlier runs burned their whole budget
  waiting on tests and committed nothing.
- Every task starts from CURRENT origin/main: `git fetch origin && git checkout --detach origin/main`, then
  `git checkout -b <branch>` (or check out the existing branch for a CONTINUE/FIX/SYNC stage).
- If node_modules is missing, run `pnpm install --frozen-lockfile` at the repo root, then build @beanpool/core and
  @beanpool/engine — their dist is shared and goes stale across branches. `pnpm exec tsc --noEmit` in apps/server
  catches type errors; tsx strips types and will NOT.
- Order: read → edit → commit → push → run the 2-3 suites you touched → push → scripts/test-all.sh LAST. Never run
  the full suite as a "baseline" before editing: one stage did, the baseline consumed its whole budget, and it
  committed nothing.
- Stage named paths only; never `git add -A` or `git add .`.
- NEVER delete or weaken a test assertion to make a suite pass. If an assertion encodes behaviour that was
  deliberately changed, update it and say so in the commit message.
- scripts/test-all.sh suite lists sit inside a single-quoted bash -c block: never put an apostrophe anywhere in
  that block, comments included, or the whole script fails with an error pointing at EOF.
- Never merge, never deploy, never force-push, never touch another branch or PR. Never touch the live nodes.
- Protected — never edit: apps/native/app/(tabs)/map.tsx, UnifiedMapPin, GlobalHeader*, logo assets, deploy.sh.
- Ledger conservation is absolute: SUM(balances) + COMMONS_POOL = 0. Anything that mutates the ledger goes through
  conservingTransaction.
- Migrations must be additive and idempotent and leave existing rows working; say in the PR body exactly what
  happens to existing data. Before changing any shape, grep repo-wide for every consumer and list them in the PR.
- RETRIES: this may be a RE-RUN after an attempt was cut off. If the worktree already holds commits ahead of
  origin/main or UNCOMMITTED edits for this same task, they are that attempt's work: KEEP THEM, review them, commit
  what is coherent, and continue. Never `git reset --hard`, `git checkout -- .`, stash, or start over.
- Report at the end: what you changed, the real `git status`, the real `git log --oneline -8`, test results, the
  PR as `gh pr list --head <branch>` shows it, and anything unfinished stated plainly.
