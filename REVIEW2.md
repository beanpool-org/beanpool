# Comprehensive PR Re-Review: #684 (`fix/parity-correctness`)

**Verdict:** **MERGE BLOCKED** — Native project voting remains broken at runtime (making requests to non-existent endpoint `POST /api/crowdfund/projects/vote` -> 404), the fix commit merely reverted `apps/native/utils/db.ts` back to that broken route rather than addressing the defect, and the PR title and description continue to advertise a working native vote route.

---

## Executive Summary

This re-review inspects branch `fix/parity-correctness` at commit `534c01426898864e2e3464462a107d23663bdd04` following the initial architect review on commit `b63f390069bf04215f1e194b3a5fa0946491b0bd`.

The fixing commit (`534c014`) successfully resolved several critical findings from the first review:
1. **[CONFIRMED FIXED] Guardian Recovery Threshold Copy:** Reverted from the incorrect "3 Guardians" to "2 Guardians (e.g. 2 out of 3)" in [`apps/native/components/info-content/GuardianInfoModal.tsx:157`](file:///Users/marty/projects/bp-parity-a/apps/native/components/info-content/GuardianInfoModal.tsx#L157) and documented in [`docs/native-pwa-parity.md:142`](file:///Users/marty/projects/bp-parity-a/docs/native-pwa-parity.md#L142), correctly respecting `TWO_LAYER_THRESHOLD = 2` from `@beanpool/core`.
2. **[CONFIRMED FIXED] "Balance is 0" Copy on Debt/Negative Balance Direct Sends:** Updated across Native ([`apps/native/app/(tabs)/ledger.tsx:388-392`](file:///Users/marty/projects/bp-parity-a/apps/native/app/%28tabs%29/ledger.tsx#L388-L392)) and PWA ([`apps/pwa/src/pages/LedgerPage.tsx:493`](file:///Users/marty/projects/bp-parity-a/apps/pwa/src/pages/LedgerPage.tsx#L493)) to accurately indicate that direct sends require a positive balance.
3. **[CONFIRMED FIXED] Dead / Unread React State in Diagnostics:** Completely removed unused `nodeStats` state from [`apps/pwa/src/pages/SettingsPage.tsx:210-215`](file:///Users/marty/projects/bp-parity-a/apps/pwa/src/pages/SettingsPage.tsx#L210-L215) and updated the diagnostic card label to "Community Members" at [`apps/pwa/src/pages/SettingsPage.tsx:991`](file:///Users/marty/projects/bp-parity-a/apps/pwa/src/pages/SettingsPage.tsx#L991).
4. **[CONFIRMED FIXED] Stale Fallback Floor Values:** Aligned fallback floors to `0` in [`apps/pwa/src/pages/LedgerPage.tsx:150`](file:///Users/marty/projects/bp-parity-a/apps/pwa/src/pages/LedgerPage.tsx#L150) (`balanceInfo?.floor ?? 0`) and [`apps/native/app/(tabs)/ledger.tsx:81`](file:///Users/marty/projects/bp-parity-a/apps/native/app/%28tabs%29/ledger.tsx#L81) (`floor: 0`).
5. **[CONFIRMED FIXED] CSS & Responsive Styling at 320dp:** Removed inline `style={{ background: 'none' }}` and added `dark:border-nature-800` at [`apps/pwa/src/pages/LedgerPage.tsx:309-310`](file:///Users/marty/projects/bp-parity-a/apps/pwa/src/pages/LedgerPage.tsx#L309-L310); added `break-words` and `text-sm sm:text-[15px]` at [`apps/pwa/src/pages/LedgerPage.tsx:500-506`](file:///Users/marty/projects/bp-parity-a/apps/pwa/src/pages/LedgerPage.tsx#L500-L506) preventing button text overflow at 320dp with 1.3x font scaling.

### Why Merge Is Blocked:
The core defect identified in Review 1 regarding Native Project Voting was **FIXED BADLY**. 
- In commit `b63f390`, the PR changed `voteForProjectApi` to call `/api/commons/vote`. Review 1 proved that `/api/commons/vote` rejects Crowdfund project IDs with HTTP 400 (`Project not found`).
- In fix commit `534c014`, rather than resolving the broken feature (e.g. by hiding/disabling the non-functional voting UI on Crowdfund cards until Commons projects are synced), the author simply reverted `apps/native/utils/db.ts` to `POST /api/crowdfund/projects/vote`.
- **`POST /api/crowdfund/projects/vote` does not exist on the server** (verified in `apps/server/src`). Any user tapping "Vote with Credits" -> "Cast" on [`apps/native/app/(tabs)/projects.tsx:426`](file:///Users/marty/projects/bp-parity-a/apps/native/app/%28tabs%29/projects.tsx#L426) receives an immediate runtime error (`Voting Failed: Not Found`).
- Moreover, the PR title (`fix(parity): keeper key format, native vote route and false in-app copy`) and PR description (Section 3) continue to claim that this PR fixes the native vote route, promising working functionality that does not exist.

---

## HALF ONE — Verification of Earlier Review Findings

Every finding from the initial review was re-tested against the current codebase:

| # | Review 1 Finding | Status | Proof / Evidence | Notes |
| :--- | :--- | :--- | :--- | :--- |
| **1** | **Native Voting Runtime Failure (`/api/commons/vote` -> 400)** | **FIXED BADLY** | [`apps/native/utils/db.ts:1849-1853`](file:///Users/marty/projects/bp-parity-a/apps/native/utils/db.ts#L1849-L1853) | Reverted to `/api/crowdfund/projects/vote`, which returns 404 (route does not exist in `apps/server/src`). Voting remains broken in the UI (`projects.tsx:426`). |
| **2** | **Erroneous Guardian Recovery Threshold ("3 Guardians")** | **FIXED** | [`apps/native/components/info-content/GuardianInfoModal.tsx:157`](file:///Users/marty/projects/bp-parity-a/apps/native/components/info-content/GuardianInfoModal.tsx#L157) | Restored to "2 Guardians (e.g., 2 out of 3)" combining with the community node, matching `TWO_LAYER_THRESHOLD = 2` (`packages/beanpool-core/src/two-layer-split.ts:63`). |
| **3** | **Inaccurate "Balance is 0" Copy on Negative Balance** | **FIXED** | [`apps/native/app/(tabs)/ledger.tsx:388-392`](file:///Users/marty/projects/bp-parity-a/apps/native/app/%28tabs%29/ledger.tsx#L388-L392), [`apps/pwa/src/pages/LedgerPage.tsx:493`](file:///Users/marty/projects/bp-parity-a/apps/pwa/src/pages/LedgerPage.tsx#L493) | Copy updated to `'Positive balance required'` / `'direct sends require a positive balance'`. |
| **4** | **`keeper-enrolment.ts` (`toEd25519Seed` PKCS8)** | **FIXED** | [`apps/native/utils/keeper-enrolment.ts:215-224, 368-372`](file:///Users/marty/projects/bp-parity-a/apps/native/utils/keeper-enrolment.ts#L215-L224) | Successfully strips ASN.1 header for 48-byte PKCS8 keys. |
| **5** | **`keeper-enrolment.test.ts` Unit Tests** | **FIXED** | [`apps/native/utils/__tests__/keeper-enrolment.test.ts:318-386`](file:///Users/marty/projects/bp-parity-a/apps/native/utils/__tests__/keeper-enrolment.test.ts#L318-L386) | All 18 vitest tests pass cleanly. |
| **6** | **`PER_COUNTERPARTY_VOLUME_CAP = 500` in Core** | **FIXED** | [`packages/beanpool-core/src/protocol.ts:40, 77`](file:///Users/marty/projects/bp-parity-a/packages/beanpool-core/src/protocol.ts#L40) | Canonical constant added to `PROTOCOL_CONSTANTS` and exported. |
| **7** | **Re-export of Cap in `@beanpool/engine`** | **FIXED** | [`packages/beanpool-engine/src/trust.ts:9, 21`](file:///Users/marty/projects/bp-parity-a/packages/beanpool-engine/src/trust.ts#L9) | Re-exports canonical constant from core; engine tests pass. |
| **8** | **Native `ledger.tsx` Initial State & Gating** | **FIXED** | [`apps/native/app/(tabs)/ledger.tsx:81, 415`](file:///Users/marty/projects/bp-parity-a/apps/native/app/%28tabs%29/ledger.tsx#L81) | Initial state `floor: 0` fixed at line 81. `canSend = balanceState.balance > 0 && earned > 0` enforced at line 415. |
| **9** | **PWA `LedgerPage.tsx` Fallback & Gating** | **FIXED** | [`apps/pwa/src/pages/LedgerPage.tsx:27, 150, 162`](file:///Users/marty/projects/bp-parity-a/apps/pwa/src/pages/LedgerPage.tsx#L27) | Newcomer floor initialized to `0` (line 27), fallback `floor ?? 0` (line 150), and `canSend = balance > 0 && earned > 0` (line 162). |
| **10** | **`BalanceInfoModal.tsx` Suspension Warning** | **FIXED** | [`apps/native/components/info-content/BalanceInfoModal.tsx:194-199`](file:///Users/marty/projects/bp-parity-a/apps/native/components/info-content/BalanceInfoModal.tsx#L194-L199) | Fictitious 3-month suspension warning replaced with accurate credit floor pause explanation. |
| **11** | **PWA `getNodeStats` Route** | **FIXED** | [`apps/pwa/src/lib/api.ts:1105-1118`](file:///Users/marty/projects/bp-parity-a/apps/pwa/src/lib/api.ts#L1105-L1118) | Replaced 404 `/api/stats` with valid `GET /api/community/health`. |
| **12** | **PWA `SettingsPage.tsx` Unread State & Label** | **FIXED** | [`apps/pwa/src/pages/SettingsPage.tsx:210-215, 991`](file:///Users/marty/projects/bp-parity-a/apps/pwa/src/pages/SettingsPage.tsx#L210-L215) | Removed unread state variable `nodeStats`; updated label to "Community Members". |
| **13** | **Inline `background: none` Wiping Pill Style** | **FIXED** | [`apps/pwa/src/pages/LedgerPage.tsx:309-310`](file:///Users/marty/projects/bp-parity-a/apps/pwa/src/pages/LedgerPage.tsx#L309-L310) | Removed `background: 'none'` and added `dark:border-nature-800`. |
| **14** | **Button Label Length at 320dp with 1.3x Scale** | **FIXED** | [`apps/pwa/src/pages/LedgerPage.tsx:500-506`](file:///Users/marty/projects/bp-parity-a/apps/pwa/src/pages/LedgerPage.tsx#L500-L506) | Added `break-words` and responsive `text-sm sm:text-[15px]` to prevent clipping. |

---

## HALF TWO — Review of Newest Changes (Commit `534c014`) on Their Merits

Commit `534c014` (`fix(parity): address review — vote route, guardian threshold copy, stats label`) introduced changes across 7 files. Evaluating these additions against risk categories:

### 1. Fix Applied in One Call Site but Not Its Siblings
- **Pill vs Button Send Copy:**
  - In [`apps/pwa/src/pages/LedgerPage.tsx:313`](file:///Users/marty/projects/bp-parity-a/apps/pwa/src/pages/LedgerPage.tsx#L313), the pill displays:
    `earned <= 0 ? 'Send (needs 1st trade)' : 'Send (needs +ve balance)'`
  - In [`apps/pwa/src/pages/LedgerPage.tsx:506`](file:///Users/marty/projects/bp-parity-a/apps/pwa/src/pages/LedgerPage.tsx#L506), the send button displays:
    `earned <= 0 ? '🔒 Send Credits (needs 1 completed trade)' : '🔒 Send Credits (needs positive balance)'`
  - In [`apps/native/app/(tabs)/ledger.tsx:496, 771`](file:///Users/marty/projects/bp-parity-a/apps/native/app/%28tabs%29/ledger.tsx#L496), the native app matches this distinction.
  - **Verdict:** Consistent across all call sites.

### 2. State That Is Now Set but Never Read
- In [`apps/pwa/src/pages/SettingsPage.tsx:210-220`](file:///Users/marty/projects/bp-parity-a/apps/pwa/src/pages/SettingsPage.tsx#L210-L220), `nodeStats` and `setNodeStatsData` were completely excised. The result from `await getNodeStats()` is held in a local constant `stats` and directly mapped into `setDbStats(...)` (lines 243-245).
- **Verdict:** Clean. No dead or unread state remains in `SettingsPage.tsx`.

### 3. An Effect Whose Dependencies Changed
- No `useEffect` hooks were added, modified, or had their dependency arrays altered in `534c014` or across the branch diff.
- **Verdict:** Clean.

### 4. Error Paths That Swallow Failures
- In [`apps/pwa/src/lib/api.ts:1116-1118`](file:///Users/marty/projects/bp-parity-a/apps/pwa/src/lib/api.ts#L1116-L1118), `getNodeStats()` catches any request error and returns `null`. [`SettingsPage.tsx:243-244`](file:///Users/marty/projects/bp-parity-a/apps/pwa/src/pages/SettingsPage.tsx#L243-L244) uses optional chaining and falls back to local storage counts:
  `members: stats ? stats.members : memberCount`
  This is appropriate graceful degradation for an offline/diagnostic display.
- **Verdict:** Clean.

### 5. Copy That Still Promises What the Code Does Not Do
- **[CRITICAL / CONFIRMED] Native Project Voting Route & UI:**
  - **Code:** [`apps/native/utils/db.ts:1849`](file:///Users/marty/projects/bp-parity-a/apps/native/utils/db.ts#L1849) calls `POST /api/crowdfund/projects/vote`.
  - **Server Reality:** There is no route matching `/api/crowdfund/projects/vote` anywhere in `apps/server/src`.
  - **UI Promise:** [`apps/native/app/(tabs)/projects.tsx:400-448`](file:///Users/marty/projects/bp-parity-a/apps/native/app/%28tabs%29/projects.tsx#L400-L448) renders an active voting stepper on project cards with "Cast" button and text: `Earn credits by completing trades to unlock voting`.
  - **PR Claims:** The PR title promises `fix(parity): ... native vote route ...` and PR body Section 3 claims `voteForProjectApi` was updated to `/api/commons/vote`.
  - **Failure:** Tapping "Cast" triggers an immediate `404: Not Found` alert. Reverting `db.ts` in `534c014` did not fix the problem; it reinstated a dead endpoint.
- **[LOW / CONFIRMED] Stale Comments in Native `ledger.tsx`:**
  - Lines 29-31 and 38 of [`apps/native/app/(tabs)/ledger.tsx`](file:///Users/marty/projects/bp-parity-a/apps/native/app/%28tabs%29/ledger.tsx#L29-L31) still describe `floor = -(20 welcome voucher + earned + granted)` and assert `The 20 voucher is already folded into the tier thresholds`. The code at line 81 and line 60 has eliminated this voucher (`floor: 0`).
- **[LOW / CONFIRMED] Non-Existent Tailwind Class:**
  - In [`apps/pwa/src/pages/LedgerPage.tsx:501`](file:///Users/marty/projects/bp-parity-a/apps/pwa/src/pages/LedgerPage.tsx#L501), the disabled button uses class `text-nature-450`. `nature-450` is not defined in [`apps/pwa/tailwind.config.js:11-23`](file:///Users/marty/projects/bp-parity-a/apps/pwa/tailwind.config.js#L11-L23) (only 400 and 500 exist), resulting in no applied color utility.

---

## Comprehensive `/api/` Endpoint Audit for the Whole Branch

Every API endpoint touched across the entire branch was verified against the route declarations in `apps/server/src`:

| Client Call Site | Method | Endpoint Path | Matched Server Route & File | Server Status |
| :--- | :--- | :--- | :--- | :--- |
| [`apps/pwa/src/lib/api.ts:1110`](file:///Users/marty/projects/bp-parity-a/apps/pwa/src/lib/api.ts#L1110) | `GET` | `/api/community/health` | `router.get('/api/community/health')`<br>[`apps/server/src/routes/community.ts:678`](file:///Users/marty/projects/bp-parity-a/apps/server/src/routes/community.ts#L678) | **VALID** |
| [`apps/pwa/src/pages/LedgerPage.tsx:640`](file:///Users/marty/projects/bp-parity-a/apps/pwa/src/pages/LedgerPage.tsx#L640) | `GET` | `/api/ledger/export` | `router.get('/api/ledger/export')`<br>[`apps/server/src/routes/community.ts:1067`](file:///Users/marty/projects/bp-parity-a/apps/server/src/routes/community.ts#L1067) | **VALID** |
| [`apps/native/app/(tabs)/ledger.tsx:329`](file:///Users/marty/projects/bp-parity-a/apps/native/app/%28tabs%29/ledger.tsx#L329) | `GET` | `/api/ledger/export` | `router.get('/api/ledger/export')`<br>[`apps/server/src/routes/community.ts:1067`](file:///Users/marty/projects/bp-parity-a/apps/server/src/routes/community.ts#L1067) | **VALID** |
| [`apps/native/utils/keeper-enrolment.ts:157`](file:///Users/marty/projects/bp-parity-a/apps/native/utils/keeper-enrolment.ts#L157) | `POST` | `/api/recovery/shares/hub-fragment` | `router.post('/api/recovery/shares/hub-fragment')`<br>[`apps/server/src/routes/keepers.ts:325`](file:///Users/marty/projects/bp-parity-a/apps/server/src/routes/keepers.ts#L325) | **VALID** |
| [`apps/native/utils/keeper-enrolment.ts:281`](file:///Users/marty/projects/bp-parity-a/apps/native/utils/keeper-enrolment.ts#L281) | `POST` | `/api/recovery/shares/sso` | `router.post('/api/recovery/shares/sso')`<br>[`apps/server/src/routes/keepers.ts:348`](file:///Users/marty/projects/bp-parity-a/apps/server/src/routes/keepers.ts#L348) | **VALID** |
| [`apps/native/utils/keeper-enrolment.ts:316`](file:///Users/marty/projects/bp-parity-a/apps/native/utils/keeper-enrolment.ts#L316) | `DELETE` | `/api/recovery/shares/sso/:provider` | `router.delete('/api/recovery/shares/sso/:provider')`<br>[`apps/server/src/routes/keepers.ts:421`](file:///Users/marty/projects/bp-parity-a/apps/server/src/routes/keepers.ts#L421) | **VALID** |
| [`apps/native/utils/keeper-enrolment.ts:400`](file:///Users/marty/projects/bp-parity-a/apps/native/utils/keeper-enrolment.ts#L400) | `POST` | `/api/recovery/shares` | `router.post('/api/recovery/shares')`<br>[`apps/server/src/routes/keepers.ts:251`](file:///Users/marty/projects/bp-parity-a/apps/server/src/routes/keepers.ts#L251) | **VALID** |
| [`apps/native/utils/db.ts:1849`](file:///Users/marty/projects/bp-parity-a/apps/native/utils/db.ts#L1849) | `POST` | `/api/crowdfund/projects/vote` | *None* (only `/api/crowdfund/projects/:id/pledge` exists in [`apps/server/src/routes/commons.ts:203`](file:///Users/marty/projects/bp-parity-a/apps/server/src/routes/commons.ts#L203)) | **INVALID (404)** |

---

## User Interface, Theming & 320dp / 1.3x Font Scaling Evaluation

All user-facing modifications were reviewed for light/dark theme contrast and responsiveness on 320dp viewports at 1.3x font scaling:

1. **PWA Capability Pills ([`apps/pwa/src/pages/LedgerPage.tsx:306-319`](file:///Users/marty/projects/bp-parity-a/apps/pwa/src/pages/LedgerPage.tsx#L306-L319)):**
   - **Container:** `flex flex-wrap gap-2` allows pills to wrap smoothly across lines without overflow or text truncation on narrow 320px screens.
   - **Styling:** Removal of `style={{ background: 'none' }}` allows the Tailwind classes (`bg-emerald-50 dark:bg-emerald-950/20` and `bg-nature-100 dark:bg-nature-800`) to render solid pill backdrops in both light and dark modes.
   - **Borders:** Addition of `dark:border-nature-800` resolves the dark mode border contrast defect identified in Review 1.

2. **PWA Send Action & Notice ([`apps/pwa/src/pages/LedgerPage.tsx:488-508`](file:///Users/marty/projects/bp-parity-a/apps/pwa/src/pages/LedgerPage.tsx#L488-L508)):**
   - **Text Length:** The button string `'🔒 Send Credits (needs 1 completed trade)'` is 40 characters long.
   - **Fix Merits:** Commit `534c014` added `break-words` and `text-sm sm:text-[15px]`. At a 320dp viewport with 1.3x font scale (~18.2px font size), the text breaks cleanly into two lines within the button bounds without clipping or overflowing the viewport edges.
   - **Dark Mode:** Notice card uses `dark:bg-nature-850/50 border-nature-200 dark:border-nature-800 text-nature-500 dark:text-nature-400`, ensuring legible contrast.

3. **Guardian Info Modal ([`apps/native/components/info-content/GuardianInfoModal.tsx:157`](file:///Users/marty/projects/bp-parity-a/apps/native/components/info-content/GuardianInfoModal.tsx#L157)):**
   - Step 4 text now reads: *"When at least 2 Guardians (e.g., 2 out of 3) approve your recovery request, their approvals combine with your community node to restore your account!"*.
   - Uses `ListItem` with standard flex layout and wrapping text, rendering cleanly on small mobile viewports.

---

## Speculative Findings

- **[SPECULATIVE] Long-Term Resolution for Native Project Voting:**
  The server supports two separate systems:
  1. *Crowdfunding Campaigns* (`apps/server/src/db/db.ts:701-718`): accept pledges via `POST /api/crowdfund/projects/:id/pledge`. They do not support quadratic voting.
  2. *Commons Governance Proposals* (`apps/server/src/state-engine.ts:3312`): accept quadratic votes via `POST /api/commons/vote`.
  In `apps/native`, `projects.tsx` currently displays Crowdfunding campaigns, but embeds a quadratic voting UI. If Commons Grant voting is intended for native mobile, `projects.tsx` should be refactored to fetch from `GET /api/commons/projects` and render Commons proposals. If only Crowdfunding is supported on native, the voting UI should be hidden/removed so only "Pledge" actions are visible (matching PWA's `ProjectsPage.tsx`).

---

## Actionable Items to Unblock Merge

1. **Resolve Native Project Voting (`apps/native/utils/db.ts:1849` & `apps/native/app/(tabs)/projects.tsx:400-450`):**
   - Either hide / disable the voting UI on Crowdfunding project cards in `apps/native/app/(tabs)/projects.tsx` so users cannot trigger the 404 route, OR implement proper Commons project syncing if Commons voting is intended.
2. **Update PR Title and Description:**
   - Remove "native vote route" from the PR title or update the description to accurately reflect that project voting was not introduced in this PR.
   - Update PR description Section 8 to reflect the 2-Guardian threshold rather than the obsolete 3-Guardian claim.
3. **Clean Up Minor Stylistic Items:**
   - In `apps/native/app/(tabs)/ledger.tsx:29-31`, update the header comments to remove the obsolete -20 voucher references.
   - In `apps/pwa/src/pages/LedgerPage.tsx:501`, change `text-nature-450` to `text-nature-400` or `text-nature-500`.
