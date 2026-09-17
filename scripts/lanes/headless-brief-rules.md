RULES FOR THIS HEADLESS RUN
- You are running headless. When you stop replying, the process EXITS. Never run a command in the background and
  never say you will report later — there is no later. Run everything in the foreground and finish before you stop.
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
