RULES FOR THIS HEADLESS RUN
- You are running headless. When you stop replying, the process EXITS. Never run a command in the background and
  never say you will report later — there is no later. Run everything in the foreground and finish before you stop.
- Start from origin, not the checkout: `claude --worktree` can branch from the maintainer's checkout HEAD, which is
  often behind origin. Before reading or changing anything, pick ONE form — every form starts with `git fetch origin`:
  - The branch exists locally OR on origin (a CONTINUE/FIX/SYNC stage, or a re-run):
    `git fetch origin && git checkout <branch>`, then `git merge origin/<branch>` if origin has moved (bringing
    your own branch up to date is not "merging" a PR). Never `checkout -B` or reset an existing branch, onto
    origin/<branch> or origin/<base>: that silently drops commits that were never pushed.
  - The branch exists neither locally nor on origin (`git rev-parse --verify --quiet refs/heads/<branch>` and
    `git ls-remote --exit-code --heads origin <branch>` both find nothing):
    `git fetch origin && git checkout -B <branch> origin/<base>` (base is the PR's base branch, normally main).
  - Verification-only work: `git fetch origin && git checkout --detach origin/<base>`.
- RETRIES: this may be a RE-RUN after an attempt was cut off. If the branch or worktree already holds commits that are
  not on origin, or UNCOMMITTED edits for this same task, they are that attempt's work: KEEP THEM, review them, commit
  what is coherent, and continue. If git refuses a checkout or merge with "commit or stash", commit those edits where
  they sit (cherry-pick that commit onto <branch> if they sat on another branch) and retry. Never `git reset --hard`,
  `git checkout -- .`, `checkout -B` an existing branch, stash, or start over.
- Do NOT run scripts/test-all.sh. CI runs the full suite on the PR. Run only the suites your change touches.
- The worktree is new: `pnpm install --frozen-lockfile` at the repo root, then build @beanpool/core and
  @beanpool/engine before running anything — their dist is shared and goes stale across branches.
- Stage named paths only; never `git add -A` or `git add .`. Push after each logical step.
- Never merge, never deploy, never touch another branch or PR, never force-push.
- Protected — never edit: apps/native/app/(tabs)/map.tsx, UnifiedMapPin, GlobalHeader*, logo assets, deploy.sh.
- Never delete or weaken a test assertion to make a suite pass. If an assertion encodes behaviour that is actually a
  bug, say so explicitly instead of changing it.
- FINAL REPORT: real `git status`, `git log --oneline origin/main..HEAD`, the PR as `gh pr list --head <branch>`
  shows it, test output before/after where relevant, and anything unfinished stated plainly.
