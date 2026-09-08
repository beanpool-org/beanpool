# Parity Correctness & Truthfulness Audit Fixes

This document lists all changes made in worktree `/Users/marty/projects/bp-parity-a` (branch `fix/parity-correctness`) addressing the verified findings from `docs/native-pwa-parity.md`.

---

## Changes by File

### 1. `apps/native/utils/keeper-enrolment.ts`
- **File:Line:** Lines 44, 215-224, 368-372
- **What Changed:**
  - Imported `toEd25519Seed` from `@beanpool/core`.
  - Replaced strict `hexToBytes(identity.privateKey).length !== 32` rejection guards in both `enrolSsoKeeper` and `enrolFriendKeepers` with `toEd25519Seed(hexToBytes(identity.privateKey))`.
  - Updated the outdated comment asserting the private key is always a 32-byte seed.
- **Why:** PWA-created identities store a 48-byte PKCS8 key envelope. Verbatim transfer over QR pairing caused keeper enrolment to fail on native phones with `"private key is 48 bytes, expected 32"`. `toEd25519Seed` canonicalizes both 32-byte raw seeds and 48-byte PKCS8 keys while rejecting genuinely invalid keys.

### 2. `apps/native/utils/__tests__/keeper-enrolment.test.ts`
- **File:Line:** Lines 32, 318-386
- **What Changed:**
  - Imported `toEd25519Pkcs8` from `@beanpool/core`.
  - Added unit test: `'enrols with a 48-byte PKCS8 key (PWA-origin) and produces the same result as the equivalent 32-byte seed'`.
  - Added unit test: `'rejects an invalid private key with a clear error'`.
- **Why:** Proves that 48-byte PKCS8-origin keys successfully enrol and produce identical share distributions to the equivalent 32-byte seeds.

### 3. `apps/native/utils/db.ts`
- **File:Line:** Lines 1849-1854
- **What Changed:**
  - In `voteForProjectApi`: changed endpoint from `/api/crowdfund/projects/vote` to `/api/commons/vote`.
  - Changed payload field names from `{ projectId, pubkey, votes }` to `{ voterPubkey: identity.publicKey, projectId, voteCount: votes }`.
- **Why:** `/api/crowdfund/projects/vote` does not exist on the server (404). The canonical handler is `POST /api/commons/vote` (`apps/server/src/routes/commons.ts:79`), taking `{ voterPubkey, projectId, voteCount }`. The endpoint passed to `_signedRequest` is used for both cryptographic signing and HTTP fetch, ensuring signature validation succeeds.

### 4. `packages/beanpool-core/src/protocol.ts`
- **File:Line:** Lines 40, 74-79
- **What Changed:**
  - Added `PER_COUNTERPARTY_VOLUME_CAP: 500` to `PROTOCOL_CONSTANTS`.
  - Exported canonical constant `PER_COUNTERPARTY_VOLUME_CAP = 500`.
- **Why:** Neither client (`apps/native`, `apps/pwa`) can import from `@beanpool/engine` because engine requires `better-sqlite3` (native C++ SQLite binding) and is not a client dependency. Re-exporting from `@beanpool/core` (which both clients already depend on) provides a single source of truth across the monorepo without duplicating literals or circular package dependencies.

### 5. `packages/beanpool-engine/src/trust.ts`
- **File:Line:** Lines 9, 20-21
- **What Changed:**
  - Imported `PER_COUNTERPARTY_VOLUME_CAP` from `@beanpool/core` and re-exported it (`export { PER_COUNTERPARTY_VOLUME_CAP }`).
- **Why:** Preserves the export contract for existing engine consumers (e.g. `apps/server`, engine unit tests) while anchoring the canonical definition in `@beanpool/core`.

### 6. `apps/native/app/(tabs)/ledger.tsx`
- **File:Line:** Lines 24, 33, 62, 380-388, 407, 496, 574, 769-773
- **What Changed:**
  - **Counterparty Cap:** Imported `PER_COUNTERPARTY_VOLUME_CAP` from `@beanpool/core` and set `const PER_COUNTERPARTY_CAP = PER_COUNTERPARTY_VOLUME_CAP` (line 33).
  - **Send Gate & Copy:**
    - Gated `canSend` on `balanceState.balance > 0 && earned > 0` (line 407).
    - Updated `openSend` to alert when blocked due to no completed trade (`earned <= 0`) vs zero balance (lines 380-388).
    - Updated Newcomer perk list: `'Send credits after first trade (needs positive balance)'` (line 62).
    - Updated quick-action pill text when disabled: `earned <= 0 ? 'Send (needs 1st trade)' : 'Send (needs +ve balance)'` (line 496).
    - Updated detail note: `"Direct sends require a positive balance and one completed trade."` (line 574).
    - Updated send button text when disabled: `earned <= 0 ? 'Send Credits (needs 1 completed trade)' : 'Send Credits (needs positive balance)'` (lines 769-773).
- **Why:**
  - Corrected 10x understatement in partner estimation for next tier.
  - Aligned send gate and copy with server enforcement (`apps/server/src/state-engine.ts:1213`), which rejects sends when `earnedCredit <= 0` with `'Send failed — you can only send beans you currently hold, and only after your first completed trade.'`.

### 7. `apps/pwa/src/pages/LedgerPage.tsx`
- **File:Line:** Lines 17, 26-28, 45, 162, 313, 398, 490-494, 502-506
- **What Changed:**
  - **Newcomer Floor (Task 5):** Fixed Newcomer floor from `-20` to `0`, removed false "small welcome voucher gets you moving" blurb, and aligned with canonical `CREDIT_BASE_FLOOR: 0` (lines 26-27).
  - **Counterparty Cap (Task 3):** Imported `PER_COUNTERPARTY_VOLUME_CAP` from `@beanpool/core` and set `const PER_COUNTERPARTY_CAP = PER_COUNTERPARTY_VOLUME_CAP` (line 45).
  - **Send Gate & Copy (Task 4):**
    - Updated Newcomer perk: `'Send credits after first trade (needs positive balance)'` (line 28).
    - Gated `canSend` on `balance > 0 && earned > 0` (line 162).
    - Updated capability pill: `earned <= 0 ? 'Send (needs 1st trade)' : 'Send (needs +ve balance)'` (line 313).
    - Updated levels note: `"Direct sends require a positive balance and one completed trade."` (line 398).
    - Updated disabled warning box and send button text to explain first completed trade requirement (lines 490-494, 502-506).
- **Why:**
  - No -20 welcome voucher exists in the server; base floor is 0.
  - Corrected 10x counterparty cap divergence.
  - Aligned client send gate and copy with server rules.

### 8. `apps/native/components/info-content/GuardianInfoModal.tsx`
- **File:Line:** Line 157
- **What Changed:**
  - Replaced `"If a majority (e.g., 2 out of 3, or 3 out of 5) of your Guardians approve your recovery request, your account is restored!"` with `"When at least 3 Guardians (e.g., 3 out of 3, or 3 out of 5) approve your recovery request, your account is restored!"`.
- **Why:** `RECOVERY_THRESHOLD = 3` in `packages/beanpool-core/src/recovery-split.ts:64`. Combining fewer than 3 shares throws an error; "2 out of 3" was false and misleading.

### 9. `apps/native/components/info-content/BalanceInfoModal.tsx`
- **File:Line:** Lines 194-199
- **What Changed:**
  - Replaced the warning of account suspension after 3 months at maximum floor with an accurate statement: `"When you reach your credit floor, further spending is paused until you earn credits back by trading on the Marketplace."`
- **Why:** No inactivity suspension, timer, or floor penalty exists in `apps/server` or packages. Suspension is strictly an administrative/moderation action.

### 10. `apps/pwa/src/lib/api.ts`
- **File:Line:** Lines 1107-1115
- **What Changed:**
  - In `getNodeStats()`: changed `GET /api/stats` to `GET /api/community/health`, mapping `health.tree?.totalMembers` to `members`, `health.activity?.totalPosts` to `posts`, and `health.activity?.totalTransactions` to `transactions`.
- **Why:** `GET /api/stats` does not exist (404) and was swallowed by `catch { return null }`. `GET /api/community/health` is an existing public endpoint carrying real community member, post, and transaction counts.

### 11. `apps/pwa/src/pages/SettingsPage.tsx`
- **File:Line:** Lines 245-246
- **What Changed:**
  - In `loadDiagnostics`: updated `members` and `posts` to prioritize returned `stats` (`stats ? stats.members : memberCount`), falling back to local storage counts only if `stats` is unavailable.
- **Why:** Ensures the Diagnostics section renders the real node metrics returned by `getNodeStats()`.

---

## Architectural Decisions & Routes Taken

1. **Canonical Constant Import (Task 3):**
   - **Route Taken:** Exported `PER_COUNTERPARTY_VOLUME_CAP = 500` from `@beanpool/core`, re-exported it from `@beanpool/engine` to preserve engine's public API, and imported it into `apps/native` and `apps/pwa`.
   - **Rationale:** Neither client depends on `@beanpool/engine` (nor should they, because `@beanpool/engine` depends on native SQLite C++ bindings via `better-sqlite3`). Both clients already depend on `@beanpool/core`. Exporting from core eliminates duplication while keeping all packages decoupled.

2. **Send Gating (Task 4):**
   - **Route Taken:** Both `/api/ledger/balance/:publicKey` and `getBalance()` in both clients already expose `earnedCredit` (`balanceState.earnedCredit` in native, `balanceInfo.earnedCredit` in PWA). We gated `canSend` on `balance > 0 && earned > 0` in both clients, updated all disabled button labels and warning notices to state that 1 completed trade is required, and verified that any server-side rejection message (`'Send failed — you can only send beans you currently hold, and only after your first completed trade.'`) surfaces to the user via existing error handlers.

3. **Stats Route (Task 8):**
   - **Route Taken:** Pointed `getNodeStats()` at the existing `GET /api/community/health` endpoint without adding any server route. Extracted `tree.totalMembers`, `activity.totalPosts`, and `activity.totalTransactions`.

---

## Verification Results

1. **PWA Typecheck & Build:**
   ```bash
   cd apps/pwa && npx tsc --noEmit && pnpm run build
   ```
   - **Exit code:** `0`
   - **Result:** TypeScript check passed (`tsc`), Vite build succeeded (`built in 1.77s`), producing production assets in `../server/public`.

2. **Native Vitest Run:**
   ```bash
   cd apps/native && npx vitest run
   ```
   - **Exit code:** `0`
   - **Result:** 15 test files passed, 173 tests passed (including all new PKCS8 key enrolment tests).
