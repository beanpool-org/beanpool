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

## 12. Do not re-file register

Review agents repeatedly re-derive identical findings, file non-existent defects, and trip over
intentional architectural decisions. This register records specific items already investigated,
judged, and closed, items already fixed and merged on `main`, and deliberate design choices.

Before opening any PR, search this register and your persona's `.jules/<persona>.md`. If your
proposed finding matches an entry below, **do not file it**. (If an entry explicitly notes that a
prior PR was closed as a bad or empty attempt but the underlying defect is STILL WANTED, you may
file it properly once with a real diff and reproduction).

### Standing instruction: Valid categories for register entries

An entry in this register may ONLY ever record one of three things:

1. **CLAIM INVESTIGATED AND FOUND FALSE:** The reported defect was investigated against current `main`
   and proven not to exist (e.g. the code already handles the case or the test passes).
2. **FIX ALREADY LANDED:** A real issue that was already patched and merged into `main` (cite the commit
   OID and PR).
3. **DELIBERATE ARCHITECTURAL DECISION:** The observed behaviour is intentional product design, not a
   bug (cite the architectural rationale).

**Never suppress a real problem because a previous attempt at it was badly executed.** "This PR was bad"
is not "this problem is not real". If an agent opened an empty PR (violating Rule 11), introduced regressions,
or botch-merged, the PR is rejected — but the underlying defect remains open. You must NEVER add an entry
that silences future agents on an unpatched bug or live vulnerability.

Whoever appends to this register MUST state which of the three categories applies:
- `Category: CLAIM FALSE`
- `Category: FIX LANDED`
- `Category: DELIBERATE DECISION`

### Register entry format

To append new entries, use this exact format:

```markdown
### YYYY-MM-DD — <Persona>: <claim summary> (<PR#(s)>) — <STATUS: LANDED | CLOSED | INTENTIONAL>
- **Category:** <CLAIM FALSE | FIX LANDED | DELIBERATE DECISION>
- **Claim:** <What the agent reported as broken or missing>
- **Why not to re-file:** <Concrete proof why it is not a defect, commit hash where it landed, or architectural rationale>
```

---

### Deliberate architectural decisions — do NOT file as defects

These are permanent product and architecture boundaries. Agents keep filing them as bugs. They are
intentional; do not open PRs or issues attempting to alter them:

- **PWA node model is single-origin only:** The PWA has no multi-node switching and must only call
  relative `/api/` URLs on its host origin. It is a lightweight client served by a single community
  node. Do not file PRs adding node selectors, node-switching state, or rewriting relative `/api/`
  calls to absolute URLs. Multi-node fleet management belongs exclusively to `apps/manager`.
- **Device pairing is one-directional:** There is no PWA-to-native QR pairing. The PWA displays the
  pairing QR code (`/api/pair/init`, `/api/pair/poll`), and the native app scans it with its camera.
  There is no workflow where the PWA scans a native screen's QR code.
- **PWA authentication and security model:** The PWA has no PIN, biometric, or WebAuthn gate.
  Web identity keys persist directly in IndexedDB via `importIdentity()`. Do not file PRs attempting
  to add WebAuthn, biometric authentication, or PIN gates to the PWA.
- **PWA service worker and web push are disabled:** The PWA has no service worker and no web push.
  `selfDestroying: true` in `apps/pwa/vite.config.ts` is intentional until offline caching is
  properly redesigned. Do not attempt to re-enable service workers, register push managers, or file
  PRs claiming missing service worker registration.
- **Pulse creator OAuth linking is phone-only:** External platform OAuth intake and account linking
  for Pulse creators is deliberately implemented only in `apps/native`. The PWA does not have OAuth
  intake or channel linking flows. Do not file PRs attempting to add OAuth linking to the PWA.
- **Fresh listings count deliberately includes treasury posts:** In `apps/pwa/src/pages/MarketplacePage.tsx`
  and `apps/native/app/(tabs)/index.tsx`, the "fresh listing posted today" count deliberately includes
  treasury-authored posts. Community enterprises post genuine community offers from treasury accounts.
  Do not file PRs filtering out treasury accounts from the fresh listings count.
- **Protected files are strictly off-limits:** As established in Rule 7, `apps/native/components/GlobalHeader.tsx`,
  `apps/native/components/Map.tsx`, `apps/native/components/Map.web.tsx`,
  `apps/native/components/UnifiedMapPin.tsx`, and all logo assets (`apps/native/assets/images/logo.png`,
  `apps/pwa/public/logo.png`, `apps/pwa/public/assets/logo-*.png`, `branding/logo-*.png`) are fragile,
  previously reverted, and off-limits. Do not touch them in any PR or sweep. If an edit is needed,
  record it in your journal for human review.

---

### Seeded triage register (2026-09-08 to 2026-09-09 batch)

### 2026-09-08 — Sentinel: bound OAuth batch ingest item limit (#683) — CLOSED (EMPTY PR / DEFECT UNPATCHED)
- **Category:** REJECTED BAD PR (DEFECT STILL WANTED — NOT A SUPPRESSION)
- **Claim:** Enforce a maximum batch size of 200 items on `POST /api/member/pulse/oauth-ingest` in `apps/server/src/routes/pulse-submit.ts`.
- **Status & Guidance:** PR #683 was closed because commit `d573ec3` was genuinely empty (`0 files changed, 0 insertions, 0 deletions`, identical tree SHA `892b4de` to parent on `main`), violating Rule 11 (no-op PRs). **Do not mistake a bad PR for a non-problem.** The underlying vulnerability is REAL and UNPATCHED: `apps/server/src/routes/pulse-submit.ts` accepts unbounded `rawItems.length` from request bodies and executes item lookups/inserts inside a synchronous SQLite `db.transaction(...)` write lock, presenting a live denial-of-service risk. The bound is **STILL WANTED**. A Sentinel agent may file this fix again, once, WITH a real diff (bounding batch items to 200 and returning 400 if exceeded), reproduction steps, and test coverage in `src/test-pulse-oauth.ts`. Do NOT re-file an empty commit.

### 2026-09-09 — Vault: attach 2FA session token to admin requests (#682) — LANDED AFTER FIX
- **Category:** FIX LANDED
- **Claim:** Attach `X-Admin-2FA-Session` token to admin requests in `apps/manager` so operations succeed on 2FA-enabled nodes.
- **Why not to re-file:** Landed in commit `99e474b`. PR #682 updated 14 API client helpers in `apps/manager/src/lib/node-client.ts`, but missed three user action handlers in `apps/manager/src/App.tsx` (`onUpdateTier`, `onToggleVoucher`, `onToggleOperator`). Fixed during triage by passing `getTfaSessionToken(activeNode.id)` to all three handlers. Fully resolved on `main`.

### 2026-09-09 — Palette: ARIA meter semantics in CreditBar (#681) — LANDED AFTER FIX
- **Category:** FIX LANDED
- **Claim:** Add `role="meter"` semantics and hide decorative emojis in `apps/pwa/src/components/CreditBar.tsx`.
- **Why not to re-file:** Landed in commit `575c4cb`. PR #681 provided `role="meter"`, `aria-label`, `aria-valuenow`, and `aria-valuemin`, but omitted `aria-valuemax`. Assistive technologies default omitted `aria-valuemax` to 100; because balances regularly exceed 100, this created an invalid ARIA state (`valuenow > valuemax`). Fixed during triage by specifying `aria-valuemax={feeFreeMax}` (default 200), clamping `valuenow = Math.min(valuemax, Math.max(valuemin, balance))`, and adding unit tests in `CreditBar.test.tsx`. Fully resolved on `main`.

### 2026-09-09 — Pixel: accessibility labels in AvatarPickerSheet (#680) — LANDED
- **Category:** FIX LANDED
- **Claim:** Add missing `accessibilityLabel` to camera and gallery source buttons in `apps/native/components/AvatarPickerSheet.tsx`.
- **Why not to re-file:** Landed in commit `16b2219`. Added explicit labels to `Pressable` buttons, cleanly masking decorative emojis for screen readers. Resolved on `main`.

### 2026-09-09 — Expo: navigation param typing and Talk tab view state (#679) — LANDED
- **Category:** FIX LANDED
- **Claim:** Make `view` search param optional in `apps/native/app/(tabs)/people.tsx` and sync `talkView` state from `talkParams.view` in `apps/native/app/(tabs)/chats.tsx`.
- **Why not to re-file:** Landed in commit `7128f82`. Corrects parameter typing and ensures tab state synchronizes when navigating to `/chats` while already mounted. Resolved on `main`.

### 2026-09-09 — Scout: test coverage for post pause and resume routes (#678) — LANDED
- **Category:** FIX LANDED
- **Claim:** Missing test coverage for `POST /api/marketplace/posts/pause` and `POST /api/marketplace/posts/resume`.
- **Why not to re-file:** Landed in commit `6314f4a`. Added integration test suite `apps/server/src/test-post-pause-resume.ts` and registered it in `scripts/test-all.sh`. Resolved on `main`.

### 2026-09-09 — Forge: cleanup dangling interval timer in LE cert request (#677) — LANDED
- **Category:** FIX LANDED
- **Claim:** Clear dangling 500ms `setInterval` in `requestLetsEncryptCert` in `apps/server/src/services/tls.ts`.
- **Why not to re-file:** Landed in commit `092c9cd`. Wrapped `Promise.race` in `try...finally` to clear both `timer` and `checkInterval`. Resolved on `main`.

### 2026-09-09 — Atlas: TelemetryModule component unit tests (#676) — LANDED
- **Category:** FIX LANDED
- **Claim:** Missing unit tests for `apps/manager/src/components/modules/TelemetryModule.tsx`.
- **Why not to re-file:** Landed in commit `0a8706b`. Added `TelemetryModule.test.tsx` with 6 unit tests covering metric calculations, callbacks, and tab switching. (Manager tests were unblocked by commit `464c600` / PR #419 wiring `"test": "vitest run"` into `apps/manager/package.json`). Resolved on `main`.

### 2026-09-09 — Flow: replace any with unknown in MembersModule catch blocks (#675) — LANDED
- **Category:** FIX LANDED
- **Claim:** Replace untyped `catch (e: any)` with `catch (e: unknown)` in `apps/manager/src/components/modules/MembersModule.tsx`.
- **Why not to re-file:** Landed in commit `ac888a3`. Six catch blocks safely converted using `e instanceof Error ? e.message : String(e)` without type assertions. Resolved on `main`.

