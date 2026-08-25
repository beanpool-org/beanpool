# Jules — Shared Operating Policy

**Every persona reads this before opening any PR,** alongside its own `.jules/<persona>.md`.

These rules exist because of specific, repeated failures — each one is annotated with what
went wrong. They are not style preferences.

---

## 1. Prove the problem exists on current `main` before you fix it

On 2026-08-24, five PRs across two personas fixed problems that did not exist. Watchman
filed "fix test-federation-api failure" three times (#368, #381, #404) — the suite passes
9/9 on `main`. Forge filed "fix request body extraction" twice (#403, #409) — the middleware
already sets both fields the fallback was guarding.

Before opening a PR:

1. Check out current `origin/main` — not your branch, not a cached tree.
2. Reproduce the failure and **paste the actual output into the PR body.**
3. For a server suite: `cd apps/server && BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-<name>.ts`
4. **Run it the way CI runs it.** `scripts/test-all.sh` is the authority on which env vars
   each suite gets. A suite that only fails under flags test-all.sh does not set for it
   (`ENFORCE_READ_AUTH`, `ENFORCE_WS_AUTH`, …) is **not** a regression — it is you running
   it wrong.
5. For a "this code is broken" claim: read the call path end to end first. Confirm the bad
   value can actually reach the line you are changing.

**If you cannot reproduce it, do not open the PR.** Record the non-finding in your journal
and move on.

## 2. Never widen a security allowlist to make something pass

Do **not** add entries to, or relax, any of these:

- `PUBLIC_READ_EXACT` / `PUBLIC_READ_PATTERNS` in `apps/server/src/https-server.ts`
- the `isBypassed` path list in `requireSignature`
- `checkAdminAuth` / `checkAdmin` — including widening which headers may carry the secret
- any `ENFORCE_*` flag default

These are deny-by-default on purpose. Making a route public is a product decision with a
blast radius, and "a test wanted it" is never the reason. If you believe a route should be
public, open an **issue** describing exactly what data it exposes and to whom. Do not ship
it as a fix.

## 3. Search for existing work before opening a PR

33 of the 63 PRs open on 2026-08-25 were duplicates of each other, in 11 clusters. Four
separate PRs re-raised a change that had already been closed with a reason.

```bash
gh pr list --state open   --limit 100 --search "<file or topic>"
gh pr list --state closed --limit 50  --search "<file or topic>"
```

- Read the **closing comment** on every match. A closed PR is a decision, not a backlog item.
- Check your own `## ✅ Resolved — do NOT re-file` section first — that section exists
  precisely so you don't repeat yourself, and it only works if you read it and append to it.
- If an open PR already covers the file, either leave it alone or comment on it. Do not open
  a second one.

## 4. One concern per PR

A security fix does not also restyle buttons. A typing change does not also add an empty
state. Reviewers reject bundled PRs wholesale, so the good half dies with the bad half.

## 5. Never touch build or dependency plumbing

- **Do not regenerate `pnpm-lock.yaml`.** Six PRs in the 2026-08-20 batch silently
  downgraded React 19.2.0 → 19.1.0 across the monorepo, including the Expo/React Native
  graph, by regenerating the lockfile as a side effect of adding a test.
- **Do not add or remove dependencies.** `.npmrc` sets `node-linker=hoisted`, so an
  undeclared dependency resolves fine in CI and breaks later. If your change needs a dep,
  say so in the PR body and stop.
- **Do not edit the production sections of any `vite.config.ts`** — `plugins`,
  `resolve.alias`, `build`. Four PRs aliased `react` into a test library's nested
  `node_modules` at the *top level*, which would ship a different React in the production
  bundle. A `test:` block is the only part you may add.

## 6. A test only counts if it runs

Adding a test file that CI never executes is worse than adding nothing — it reads as
coverage that does not exist.

- **`apps/server`**: every `src/test-*.ts` must be registered in the suite list in
  `scripts/test-all.sh` **in the same PR**. There is a guard that fails for unregistered
  suites; do not work around it.
- **vitest packages**: the package must have a `"test"` script for `turbo run test` to see
  it. `apps/native` and `apps/pwa` have one. **`apps/manager` does not** — it already holds
  three test files that have never run. Do not add manager tests until that script exists.
- Verify before pushing: `pnpm turbo run test --filter=<pkg>` and confirm your file appears
  in the output.

## 7. Protected files — do not edit

Fragile, previously reverted, and off-limits in any refactor or sweep:

- `apps/native/components/GlobalHeader.tsx`
- `apps/native/assets/logo.png`
- `map.tsx`, `UnifiedMapPin`

If one of these genuinely needs a change, describe it in your journal and let a human do it.

## 8. Do not change an exported signature without updating every consumer

`grep -rn "<exportName>" apps packages` across the whole repo first. Renaming an export or
changing its return shape and leaving callers on the old contract ships something nobody can
use — and if the new capability has no consumer at all, it is not a fix, it is dead code.

## 9. Journal entries go in their own final commit

Each persona appends to a single `.jules/<persona>.md`. Two open PRs from the same persona
therefore **always** conflict on that file. Keep the journal edit as the **last** commit on
the branch so the conflict is one file, one hunk, and trivially resolved by keeping both
entries in date order.

## 10. No scratch files in PRs

`git status` before you push. A helper script you wrote to make an edit is not part of the
change (a stray `fix_imports.py` shipped in #308 and had to be removed separately).

## 11. If the change is a no-op, do not ship it

Churn costs a CI run, a review, and a merge conflict for someone else. Before pushing, ask
what observably differs after this change. Replacing `.find()` on a two-element array with a
ternary, or adding a fallback to a value that is always set, answers "nothing".
