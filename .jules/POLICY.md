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
  suites; do not work around it. The list is a bash array with one name per line: add yours
  on its own line beside a related suite, not at the end (see the #740 entry below).
- **vitest packages**: the package must have a `"test"` script for `turbo run test` to see
  it. `apps/native`, `apps/pwa` and `apps/manager` all have one. **`apps/manager` was
  unblocked by PR #419 (`464c600`, 2026-08-25)** and now holds dozens of test files that do
  run, and that fail the build when they break. **Manager tests are welcome.** An earlier
  version of this bullet said the opposite; it is withdrawn — see the `TelemetryModule` entry
  in the register below.
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


### 2026-09-13 — Sentinel: path traversal in fleet manager backup routes (#747) — LANDED, BUT THE CLAIM WAS FALSE
- **Category:** PHANTOM VULNERABILITY (fix merged anyway, as a regression guard)
- **Claim:** `nodeId` on `/api/manager/backups/download-db` and `/download-identity` allows path traversal via `../../`.
- **Why not to re-file:** The traversal was **already impossible**. Every `nodeId` passes through `nodeSlug()` (`apps/server/src/services/harvester.ts`), which either returns a known node name or falls back to `id.replace(/[^a-zA-Z0-9_-]/g, '_')` — slashes, dots and backslashes are stripped before the path is ever built, so `../../secret` became `______secret`. The PR was merged because the traversal **test** it adds is worth having as a guard on `nodeSlug`'s sanitisation, not because it closed a hole. Do not re-file traversal findings against any route whose input goes through `nodeSlug` without first showing that `nodeSlug` itself lets the character through.
- **Related trap:** the guard it added rejects any `nodeId` containing `/`. That is safe only because callers pass an already-slugified value (`TopologyModule.tsx` sends `{ nodeId: slug }`). A future caller passing a node URL would be rejected. Check call sites before tightening input validation on this family of routes.

### 2026-09-13 — Scout: members-holiday test coverage (#740) — LANDED AFTER REBASE
- **Category:** MERGE CONFLICT, RECURRING
- **Claim:** Missing coverage for holiday-mode member behaviour.
- **Why not to re-file:** The suite landed. Recording the conflict because it is now the third time: `scripts/test-all.sh` used to keep its entire suite list on one line inside a single-quoted `bash -c` block, so any two PRs that registered a new suite in the same batch conflicted with each other. #740 collided with #751. **Since #843 the lists are bash arrays with one suite name per line** (`SUITES=(` … `)`, plus `SETTLEMENT_ON_SUITES=(` for the settlement-on variants). When filing a new suite, add it on its own line **beside a related suite, not at the end of the array** — two PRs that both append after the same last line still conflict, while insertions at different points merge cleanly. The arrays are still inside the single-quoted `bash -c` block, so never introduce an apostrophe anywhere in it, comments included — it breaks the whole script with an error that points at EOF. `scripts/check-suite-registration.sh` reads these arrays, so keep exactly one name per line.

### 2026-09-14 — Sentinel: reaction metadata TypeError DoS (#760) — LANDED, CLAIM WAS REAL
- **Category:** REAL VULNERABILITY
- **Claim:** `toggleMessageReaction` assumed `metadata` was an object; a primitive or array makes assigning `.reactions` throw.
- **Why this one was real, unlike #747:** `metadata` is taken straight off the client request body (`apps/server/src/routes/messaging.ts:102`) and passed through to `sendMessage`, so a caller genuinely controls its shape. In an ES module (strict mode) assigning a property to a primitive throws `TypeError`. The guard is at the point of consumption, which is the right place — a peer could also deliver an odd shape through sync.
- **The distinction worth keeping:** before accepting or rejecting an input-validation finding, trace whether the value is actually **client-authored**. #747's traversal was inert because `nodeSlug()` sanitised first; this one was real because nothing sanitised first. Same shape of claim, opposite verdict.

### 2026-09-14 — Bolt: O(1) lookup rewrites (#745, #766) — BOTH LANDED, ONLY ONE WORTH IT
- **Category:** MARGINAL / JUDGEMENT
- **Claim:** replace `array.find()` with a pre-computed `Map`.
- **Why not to re-file blindly:** #766 was worth it — the lookup sat inside a **recursive tree render**, so it was O(M·(M+P)). #745 replaced a **single** lookup per render, where building the Map costs as much as the scan it saves. Both are harmless and both landed, but a `.find()` → `Map` rewrite is only a win when the lookup is in a loop or recursion. Do not file these against one-shot lookups.

### 2026-09-15 — Atlas: manager node-client unit tests (#777) — LANDED
- **Category:** FIX LANDED
- **Claim:** Missing unit tests for node client helpers (`loginToNode`, `fetchNodeTreasuries`, `createNodeTreasury`, `fetchNodeSnapshots`, `createNodeSnapshot`, `deleteNodeSnapshot`, `updateNodeReplicationCadence`, `forceNodeResync`) in `apps/manager/src/lib/node-client.ts`.
- **Why not to re-file:** Landed in commit `e3a9f47`. Added unit tests in `apps/manager/src/lib/node-client.test.ts` covering authentication, treasury management, snapshot operations, and replication cadence helpers.

### 2026-09-15 — Shield: pairing relay uses shared shouldBlockCleartextNodeUrl (#778) — LANDED
- **Category:** FIX LANDED
- **Claim:** Enforce secure transport for pairing relay URLs in `apps/native/app/pair-device.tsx`.
- **Why not to re-file:** Landed in commit `60d1424`. Replaced custom hostname parsing with `shouldBlockCleartextNodeUrl(targetNode)` in `apps/native/app/pair-device.tsx` to block insecure cleartext HTTP/WS pairing relays on non-private hosts.

### 2026-09-15 — Forge: validate report reason type in submitReport (#779) — LANDED
- **Category:** FIX LANDED
- **Claim:** Validate report reason type in `submitReport` to prevent runtime `TypeError` when calling `.slice()`.
- **Why not to re-file:** Landed in commit `daa3989`. Validates `typeof reason === 'string' && reason.trim()` in `apps/server/src/routes/community.ts` and safely coerces reason via `String(reason ?? '')` before slicing in `apps/server/src/state-engine.ts`.

### 2026-09-15 — Palette: OnboardingGuide decorative emojis hidden, WCAG 2.5.3 name preserved (#780) — LANDED
- **Category:** FIX LANDED
- **Claim:** Hide decorative emojis in `apps/pwa/src/components/OnboardingGuide.tsx` from screen readers while preserving accessible names under WCAG 2.5.3.
- **Why not to re-file:** Landed in commit `7d09b2e`. Wrapped decorative emojis in `<span aria-hidden="true">` across cards in `OnboardingGuide.tsx` while preserving accessible button names under WCAG 2.5.3, verified by unit tests in `OnboardingGuide.test.tsx`.

### 2026-09-15 — Bolt: avatarUrl in getFriends response (#782) — LANDED
- **Category:** FIX LANDED
- **Claim:** Include `avatarUrl` in `getFriends` response to avoid $O(M)$ member directory fetch.
- **Why not to re-file:** Landed in commit `b393517`. Added `m.avatar_url` to the `getFriends` SQL query in `packages/beanpool-engine/src/social.ts` and updated `FriendEntry` interfaces, enabling $O(1)$ friend avatar rendering in PWA `PeoplePage.tsx`.

### 2026-09-15 — Pixel: create-poll button accessibilityLabel/hint/state (#783) — LANDED
- **Category:** FIX LANDED
- **Claim:** Add missing `accessibilityLabel`, `accessibilityHint`, and `accessibilityState` to the create-poll submit button in `apps/native/components/NewPollModal.tsx`.
- **Why not to re-file:** Landed in commit `8eed2fa`. Added dynamic `accessibilityLabel` ("Create poll" / "Creating poll"), `accessibilityHint`, and `accessibilityState={{ disabled: submitting, busy: submitting }}` to the submit button in `NewPollModal.tsx`.

### 2026-09-15 — Vault: 2FA session token forwarded on snapshot ops — closes the #682 gap (#784) — LANDED
- **Category:** FIX LANDED
- **Claim:** Snapshot operations in `apps/manager/src/components/modules/TopologyModule.tsx` failed with 401 on 2FA-enabled nodes because `getTfaSessionToken` was not forwarded.
- **Why not to re-file:** Landed in commit `ed294ee`. Passed `getTfaSessionToken(targetSnapshotNode.id)` to `fetchNodeSnapshots`, `createNodeSnapshot`, and `deleteNodeSnapshot` in `apps/manager/src/components/modules/TopologyModule.tsx`, closing the remaining #682 consumer gap.

### 2026-09-15 — Flow: manager strict interfaces replacing any (#785) — LANDED
- **Category:** FIX LANDED
- **Claim:** Replace untyped `any` annotations with strict interfaces in `apps/manager/src/App.tsx` and `apps/manager/src/lib/node-client.ts`.
- **Why not to re-file:** Landed in commit `149780e`. Defined strict TypeScript interfaces (`NodeHealthFlag`, `NodeReport`, `MemberItem`, `NodeDataPayload`) in `node-client.ts` and removed `any` annotations across state and filter callbacks in `App.tsx`.

### 2026-09-15 — Scout: test coverage commons-reject-project (#781) — LANDED
- **Category:** FIX LANDED
- **Claim:** Missing test coverage for `POST /api/local/admin/commons/reject` and `adminRejectProject`.
- **Why not to re-file:** Landed in merge commit `60e55543`. The tests target `/api/local/admin/commons/reject` and `adminRejectProject`, which SURVIVE the project==enterprise unification (#792) — old routes now serve from the unified model — so this coverage stays valid; the only conflict was the suite-list line in `scripts/test-all.sh`.

### 2026-09-16 — Atlas: manager TopologyModule unit tests (#798) — LANDED
- **Category:** FIX LANDED
- **Claim:** Missing unit test coverage for `TopologyModule` in `apps/manager/src/components/modules/TopologyModule.tsx`.
- **Why not to re-file:** Landed in merge commit `e7b52dc7`. Added unit tests in `apps/manager/src/components/modules/TopologyModule.test.tsx` covering tab switching across module views (On-Node Snapshots, Replication & Standby, Domain Name Claims, Disaster Recovery Runbook), domain name claim approval flow, and on-node snapshot fetching and creation. The module survives #808 behind `IS_FLEET_MODE`.

### 2026-09-16 — Forge: admin post delete returns 404 for missing post (#799) — LANDED
- **Category:** FIX LANDED
- **Claim:** Missing HTTP 404 status code in `POST /api/local/admin/posts/:id/delete` when the post to delete is not found.
- **Why not to re-file:** Landed in merge commit `22692a4d`. In `apps/server/src/routes/admin.ts`, returns HTTP status 404 `{ success: false, error: 'Post not found' }` if `adminDeletePost(ctx.params.id)` returns `false`, with regression coverage in `apps/server/src/test-moderation-admin.ts`.

### 2026-09-16 — Sentinel: authenticated caller message send IDOR (#800) — LANDED, BUT CLAIM WAS FALSE
- **Category:** CLAIM FALSE
- **Claim:** An authenticated caller can send a message as another member (IDOR on send).
- **Why not to re-file:** Landed in merge commit `d2a6b3ed`. `requireSignature` in `apps/server/src/https-server.ts` already rejects any request whose identity field (`authorPubkey` ends in `'pubkey'`) differs from the signing key with 403 `'Identity mismatch'`; verified against main before the PR. The PR landed only a redundant route-level guard plus a regression assertion in the already-registered `test-messaging-idor.ts`, so this is defence in depth, not a vulnerability fix.

### 2026-09-16 — Expo: native treasury-detail exports ErrorBoundary and refines params (#801) — LANDED
- **Category:** FIX LANDED
- **Claim:** Missing `ErrorBoundary` export in `apps/native/app/treasury-detail.tsx` and fragile parameter handling for array/scalar routes.
- **Why not to re-file:** Landed in merge commit `b5792ac1`. Exports `ErrorBoundary` from `expo-router` in `apps/native/app/treasury-detail.tsx` to enable screen-level error handling, and refines parameter typing/extraction to safely handle both scalar string and array parameter edge cases.

### 2026-09-16 — Palette: PulseFeedCard focus rings and touch targets, WCAG 2.5.3 name preserved (#802) — LANDED
- **Category:** FIX LANDED
- **Claim:** Interactive controls in `apps/pwa/src/components/PulseFeedCard.tsx` lacked minimum 44px touch target sizing and focus-visible rings.
- **Why not to re-file:** Landed in merge commit `b4cd8c5e`. Added minimum 44px touch target height and focus-visible rings to interactive controls in `PulseFeedCard.tsx` while preserving accessible names under WCAG 2.5.3, verified by unit tests in `PulseFeedCard.test.tsx`.

### 2026-09-16 — Bolt: O(1) invite-code lookups in native offline invite sync (#803) — LANDED
- **Category:** FIX LANDED
- **Claim:** Nested $O(N \times M)$ array scans (`find()` and `some()`) during offline invite sync in `apps/native/app/(tabs)/people.tsx`.
- **Why not to re-file:** Landed in merge commit `7d2395ee`. Replaced nested array searches in `loadOfflineInvites()` with pre-computed `serverInvitesMap` (`Map`) and `updatedCodes` (`Set`), reducing invite code lookups from $O(N \times M)$ to $O(N + M)$ during offline invite synchronization on native devices.

### 2026-09-16 — Flow: manager OnboardingModule empty state when no fleet profiles exist (#804) — LANDED
- **Category:** FIX LANDED
- **Claim:** Missing empty state UI in `apps/manager/src/components/modules/OnboardingModule.tsx` when the node profiles list is empty or no active profile is selected.
- **Why not to re-file:** Landed in merge commit `7e4ee012`. Added accessible empty state UI in `OnboardingModule.tsx` guiding the operator to configure a node profile in Fleet Settings when no profiles exist.

### 2026-09-16 — Pixel: accessibilityRole/label on native clear-deadline button in propose-project (#805) — LANDED
- **Category:** FIX LANDED
- **Claim:** Missing `accessibilityRole` and `accessibilityLabel` on the clear deadline `Pressable` in `apps/native/app/propose-project.tsx`.
- **Why not to re-file:** Landed in merge commit `9dbe8dbc`. Added `accessibilityRole="button"` and `accessibilityLabel="Clear deadline"` to the clear deadline `Pressable` in `apps/native/app/propose-project.tsx`, which survives the #792 project-enterprise unification.

### 2026-09-16 — Scout: test coverage commons projects update and delete (#807) — LANDED
- **Category:** FIX LANDED
- **Claim:** Missing test coverage for `POST /api/commons/projects/update` and `POST /api/commons/projects/delete` routes in `apps/server/src/routes/commons.ts`.
- **Why not to re-file:** Landed in merge commit `365a909c`. Added integration test suite `apps/server/src/test-commons-projects-update-delete.ts` covering owner updates/deletions, non-owner rejections (400), field validation, and duplicate deletion guards, registered in `scripts/test-all.sh`. Commons project update/delete routes survive the #792 unification; only a suite-list conflict occurred.


### 2026-09-17 — Sentinel: sanitize nodeSlug in fleet harvester (#836) — LANDED, SECURITY CLAIM STILL WRONG
- **Category:** PHANTOM VULNERABILITY, RECURRING — this is the second filing of the same wrong claim
- **Claim:** `nodeSlug` allows path traversal via an unsanitised `id`.
- **Why not to re-file:** Already registered on 2026-09-14 against #747 and still wrong. `nodeSlug()`
  returned a sanitised value on **every** branch: the allowlist arm is an exact match against known
  node names (`'../../test'` never equals `'test'`), and the fallback already ran
  `id.replace(/[^a-zA-Z0-9_-]/g, '_')`. There was no traversal to close, then or now.
- **Why it was merged anyway:** the diff carries real robustness that has nothing to do with the
  stated claim — `target?.id || ''` stops `undefined.replace()` throwing when an object target has
  no id, and `cleanId || 'unknown'` stops an all-special-character id collapsing to an empty slug.
  Judge the diff, not the headline.
- **Standing rule:** a traversal finding against anything flowing through `nodeSlug` needs proof that
  `nodeSlug` itself passes the character through. Twice now it has not.

### 2026-09-17 — Vault: cleanup legacy admin secret header (#834) — LANDED, GENUINELY USEFUL
- **Category:** REAL (small)
- **Claim:** the manager sends a redundant legacy `x-admin-secret` header alongside `X-Admin-Password`.
- **Verified:** the server reads `x-admin-secret` **nowhere**, and `buildAdminHeaders` already sends
  `X-Admin-Password` plus `X-Admin-2FA-Session`. Removing it stops the admin password being
  transmitted twice in two different headers — less credential surface for no behaviour change.
### 2026-09-18 — Shield: manifest usesCleartextTraffic=false (#872) — CLOSED, DELIBERATE DECISION
- **Category:** RE-RAISED DELIBERATE DECISION
- **Claim:** the Android manifest allows cleartext traffic, so it should set `usesCleartextTraffic=false`.
- **Why not to re-file:** BeanPool nodes are self-hosted, and a community's node is often reached on a LAN
  or by bare IP over http. `normalizeNodeUrl` (apps/native/utils/node-url.ts) deliberately returns `http://`
  for IPv4 and localhost; the settings placeholder is `e.g. http://192.168.1.55`. The protection already
  exists one layer up: `shouldBlockCleartextNodeUrl` (#778, registered 2026-09-15) blocks plaintext to
  public hosts while LAN sync keeps working. Flipping the manifest flag would break every LAN and direct-IP
  node connection in release builds.
- **Standing rule:** any cleartext finding against the native app must first say what happens to a member
  whose node is `http://192.168.x.x`.

### 2026-09-18 — Vault: 2FA session token in member wizards (#875) — LANDED, CLAIM WRONG, DIFF USEFUL
- **Category:** PHANTOM CLAIM, REAL CLEANUP
- **Claim:** the member wizards don't forward the 2FA session token.
- **Verified:** false — all five helpers already call `buildAdminHeaders(adminPassword, tfaToken)`, which
  sends `X-Admin-2FA-Session`. What the diff really does is drop the legacy `x-admin-secret` header, the
  same cleanup registered for #834 on 2026-09-17. Merged on that basis, not the headline.
- **Still open:** three more sites send the legacy header (apps/manager/src/lib/node-client.ts ~1417, ~1453, ~1488).

### 2026-09-19 — Vault: don't persist the AI API key (#908) — CLOSED, WOULD BREAK THE FEATURE
- **Category:** REGRESSION DRESSED AS HARDENING
- **Claim:** the manager stores the AI provider key in localStorage.
- **Verified:** true, and intended. The settings screen reloads its config from storage, so dropping the key makes it
  vanish on every reload: Save still reports success, the key field comes back empty, and OpenRouter calls return a 401
  error that never says the key was discarded. It is the operator's own bring-your-own key in their own browser.
- **Standing rule:** a "don't store X" change must say how X survives a reload and what the user sees.

### 2026-09-19 — Sentinel: rating author bound to signer (#909) — LANDED, CLAIM WAS FALSE
- **Category:** PHANTOM CLAIM, HARMLESS DEFENCE IN DEPTH (third after #800, #836)
- **Verified:** `requireSignature` already refuses unsigned writes and any `*pubkey` body field that isn't the signer.
  The route-level check duplicates it. Show the request passing the middleware before calling anything spoofable.

### 2026-09-22 — Forge: 429 on braked recovery-code takeover/open (#1017) — CLOSED, CLAIM WAS FALSE
- **Category:** CLAIM FALSE
- **Claim:** the braked path on `/api/local/admin/takeover/open` doesn't answer 429.
- **Why not to re-file:** `refuseBraked` sets `ctx.status = 429` and `Retry-After` itself
  (apps/server/src/password-brake.ts:372-373), and Koa keeps an explicitly set status when `ctx.body` is assigned
  later. test-takeover-by-code.ts already asserts 429 on this route and passes with or without the extra line.

### 2026-09-22 — Vault: admin headers on fetchNodeTreasuries (#1014) — CLOSED, INERT AND LEAKS THE PASSWORD
- **Category:** CLAIM FALSE
- **Claim:** the manager's treasury list fetch needs admin auth headers.
- **Why not to re-file:** `/api/treasuries` is a public read (PUBLIC_READ_EXACT in apps/server/src/https-server.ts), and
  its handler never calls `checkAdminAuth`, so the headers are never read and the list is identical. Sending them only
  puts the admin password and 2FA session on a public request. Before adding admin headers to a fetch, show the
  route reads them.
- **Re-filed as #1041** (2026-09-22, 19:10 UTC), before #1042 wrote this entry into `.jules/vault.md`; closed again
  2026-09-23.

### 2026-09-22 — Shield: SecureStore for native onboarding state (#1019) — CLOSED, WOULD STRAND NEW MEMBERS
- **Category:** DELIBERATE DECISION
- **Claim:** the mid-wizard onboarding record should be in SecureStore, not AsyncStorage.
- **Why not to re-file:** nothing in it is secret (the invite code is spent at Step 1; callsign, node URL and avatar are
  public profile data; the keypair is already in SecureStore). The avatar is a base64 data URI of about 85-90 KB, which
  some iOS keychains reject, and the write swallows errors, so the step silently fails to save. That strands a new
  member on the node-mismatch screen, the exact harm the record exists to prevent
  (apps/native/utils/onboarding-state.ts header).

### 2026-09-22 — Bolt: Map lookup for enterprise names in NewEventModal (#1018) — CLOSED, NO BENEFIT
- **Category:** CLAIM FALSE
- **Claim:** `keeperOf.map(... treasuries.find ...)` is a costly O(N×M) scan.
- **Why not to re-file:** `keeperOf` is the enterprises one member keeps (usually 0-3), and it runs once per modal
  open. Bolt: only file a lookup rewrite for a list that can grow with the community AND runs per render or per
  keystroke.

### 2026-09-22 — Sentinel: admin auth on POST /api/commons/decisions/tick (#1021) — LANDED, CLAIM OVERSTATED
- **Category:** FIX LANDED
- **Claim:** the tick route is unauthenticated.
- **Verified:** it already needed a valid signature (any keypair, not a member). It calls `tickDecisions()` with no
  arguments, the same call the primary's 60-second timer makes, so the exposure was low. Landed as hardening. The
  route has no client; removing it outright is a possible follow-up, not a defect to re-file.

### 2026-09-23 — Bolt: Map lookup for group names in the MapPage composer (#1034) — CLOSED, NO BENEFIT
- **Category:** CLAIM FALSE
- **Claim:** three `userGroups.find()` calls in the New Post panel are repeated O(G) scans worth a memoised `Map`.
- **Why not to re-file:** they are one-shot lookups in one panel's render, over the member's own groups (a handful),
  not inside a loop or recursion. That is the third filing of this shape (#745, #1018, #1034). Bolt: before a lookup
  rewrite, name the loop or recursion the lookup runs in and how large the list can grow.

### 2026-09-23 — Pixel: accessibilityLabel on the group invite landing buttons (#1036) — CLOSED, NO-OP
- **Category:** CLAIM FALSE
- **Claim:** the Try again / Close / Not now buttons in `apps/native/app/group/[id].tsx` lack accessibility labels.
- **Why not to re-file:** each Pressable's only child is a `Text` with those exact words, and React Native names an
  accessible element from its child text on iOS and Android, so screen readers already read them. The one button whose
  content can be a spinner (the primary action) already has an explicit label and a busy state. Pixel: add
  `accessibilityLabel` only where the visible content is not text (icon, image, spinner, emoji only), or where the
  spoken name must differ from the text.

### 2026-09-24 — Pixel: accessibilityLabel on the pending-deal card in MyDealsSheet (#1087) — CLOSED, CLAIM FALSE
- **Category:** CLAIM FALSE
- **Claim:** the Pressable that wraps a pending deal in `apps/native/components/MyDealsSheet.tsx` lacks an
  `accessibilityLabel`, so screen readers can't tell what it opens.
- **Why not to re-file:** with no label, React Native names the Pressable from all of its child text, so VoiceOver and
  TalkBack already read the whole card: status, date, the Beans amount with its sign, the post title and "From/To
  <member>". The proposed label ("View deal details for <title>") REPLACES all of that and drops the amount, the status
  and the other member. Never put an `accessibilityLabel` on a Pressable that wraps a whole card of text. If it needs
  anything, it's an `accessibilityHint` saying what a tap does.
