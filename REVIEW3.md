# Comprehensive Code Re-Review: PR #690 (Post-Fix Evaluation)

**Verdict:** **MERGE BLOCKED** — While the high-frequency read path (`GET /api/marketplace/posts`) is now 100% clean of writes and the bidirectional boundary logic works as intended, the new gate function `syncPulseMarketplaceGate()` lacks exception shielding; an unexpected throw or SQLite lock failure in the gate will bubble up and cause the enclosing HTTP mutation route to return a 400 error to the client after the member's post, pause, remove, or financial transaction has already committed to the database.

---

## Executive Summary

Commit `9640444` (`fix(pulse): move the marketplace gate off the read path`) directly addresses the primary blocker from `REVIEW2.md`:
1. It eliminates all database writes and key generation from `GET /api/marketplace/posts` and read-only helper functions.
2. It introduces bidirectional synchronization (`syncPulseMarketplaceGate()`), restoring the Daily Pulse placeholder when member listings fall back below 2 (< 2) without requiring a server restart.
3. It fixes the WCAG 2.1 AA color contrast violations on amber pill badges and resolves the disappearing "Local" tab state hazard in `apps/native/app/(tabs)/pulse.tsx`.
4. It expands test coverage with route-level dispatch verification (82/82 assertions passing).

However, the implementation of `syncPulseMarketplaceGate()` exposes all 7 mutating API routes to side-effect failures: if the gate throws, the member's already-committed action is reported as a failure to the user. Wrapping `syncPulseMarketplaceGate()` in a `try/catch` resolves this and makes the PR safe to merge.

---

## 1. Verification of Read Paths vs Mutating Handlers (No Transitive Writes)

| Endpoint / Function | Mutation Status | Verification (`file:line`) |
| :--- | :--- | :--- |
| `GET /api/marketplace/posts` | **100% Read-Only** | [`apps/server/src/routes/marketplace.ts:66-93`](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/routes/marketplace.ts#L66-L93) — The unconditional `deactivatePulseMarketplacePost()` call was completely removed. The endpoint only calls `clampLimit`, `clampOffset`, `getPeerOrigins`, and `getPosts`. |
| `@beanpool/engine: getPostsEngine()` | **100% Read-Only** | Delegated from [`apps/server/src/state-engine.ts:1823-1825`](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/state-engine.ts#L1823-L1825). Executes `SELECT` statements only; zero transitive writes. |
| `getPulseTreasuryPubkey()` | **100% Read-Only** | [`apps/server/src/daily-pulse.ts:61-67`](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/daily-pulse.ts#L61-L67) — Replaced key-generating `ensurePulseTreasury()` with a prepared `SELECT` on `members`. On a cold/empty database, 0 keys are minted and 0 member rows are inserted ([`apps/server/src/test-daily-pulse.ts:61-65`](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/test-daily-pulse.ts#L61-L65)). |
| `getActiveMemberListingCount()` | **100% Read-Only** | [`apps/server/src/daily-pulse.ts:117-125`](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/daily-pulse.ts#L117-L125) — Uses cached prepared statements (`_stmtActiveMemberCount`, `_stmtActiveCountAll`) to run a `COUNT(*)` query. Never writes. |
| `getActivePulsePost()` | **100% Read-Only** | [`apps/server/src/daily-pulse.ts:260-268`](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/daily-pulse.ts#L260-L268) — Queries active pulse post. If count >= 2, returns `null` immediately without mutating SQL. |
| `GET` Route Mutability Regression Test | **PASS** | [`apps/server/src/test-daily-pulse.ts:270-275`](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/test-daily-pulse.ts#L270-L275) — Proves `updated_at` before and after `GET /api/marketplace/posts` is identical. |

### Call Site Audit for `syncPulseMarketplaceGate()`
All 7 call sites in [`apps/server/src/routes/marketplace.ts`](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/routes/marketplace.ts) sit exclusively within mutating `POST` routes:
1. `POST /api/marketplace/posts` ([line 125](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/routes/marketplace.ts#L125)) — After creating a member post.
2. `POST /api/marketplace/posts/remove` ([line 144](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/routes/marketplace.ts#L144)) — After removing a post.
3. `POST /api/marketplace/posts/accept` ([line 187](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/routes/marketplace.ts#L187)) — After accepting an offer into escrow.
4. `POST /api/marketplace/transactions/complete` ([line 283](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/routes/marketplace.ts#L283)) — After transaction completion.
5. `POST /api/marketplace/transactions/cancel` ([line 305](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/routes/marketplace.ts#L305)) — After transaction cancellation.
6. `POST /api/marketplace/posts/pause` ([line 322](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/routes/marketplace.ts#L322)) — After pausing a post.
7. `POST /api/marketplace/posts/resume` ([line 341](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/routes/marketplace.ts#L341)) — After resuming a post.

There are **zero** calls to `syncPulseMarketplaceGate()` or other write routines in any `GET` endpoint.

---

## 2. Judgment of the New Shape on its Own Merits

### 2.1 Idempotency
- **Deactivation path**: In [`apps/server/src/daily-pulse.ts:132-140`](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/daily-pulse.ts#L132-L140), `deactivatePulseMarketplacePost()` first inspects `getStmtGetActivePulse().get(pulsePubkey)`. If `!active`, it returns immediately. Calling it repeatedly on an already-deactivated node executes zero `UPDATE` queries.
- **Activation path**: In [`apps/server/src/daily-pulse.ts:276-295`](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/daily-pulse.ts#L276-L295), `ensurePulseMarketplacePost()` queries `SELECT id, active, status FROM posts WHERE id = ?`. If `existing.active === 1 && existing.status === 'active'`, it returns immediately. Calling it repeatedly on an active bootstrap node executes zero `UPDATE` queries.
- **Verdict**: Fully idempotent.

### 2.2 Cost When Nothing Needs to Change
- On every mutation, `syncPulseMarketplaceGate()` evaluates `getActiveMemberListingCount()`, which runs a single `SELECT COUNT(*)` on the indexed columns `(author_pubkey, active, status)` via a cached prepared statement ([`apps/server/src/daily-pulse.ts:39-46`](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/daily-pulse.ts#L39-L46)).
- If state already matches (e.g. listings >= 2 and pulse post is already cancelled, or listings < 2 and pulse post is already active), it executes exactly two microsecond-level prepared `SELECT` queries and 0 disk/WAL writes.
- Because this occurs exclusively during explicit, low-frequency user mutations (which already perform multi-table writes, ledger updates, and push notifications), the overhead is negligible (< 0.1ms).

### 2.3 Safety if it Throws [CRITICAL DEFECT — BLOCKER]
- **Issue**: In [`apps/server/src/daily-pulse.ts:303-310`](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/daily-pulse.ts#L303-L310), `syncPulseMarketplaceGate()` does **not** contain a `try...catch` block. Furthermore, none of the seven call sites in `apps/server/src/routes/marketplace.ts` wrap `syncPulseMarketplaceGate()` in a `try...catch`.
- **Mechanism of Failure**:
  In all 7 handlers, the member's primary database mutation has already completed before `syncPulseMarketplaceGate()` is invoked:
  - Line 118: `createPost()` commits the new post row.
  - Line 142: `removePost()` commits the post deletion.
  - Line 185: `acceptPost()` commits escrow creation.
  - Line 277: `completePostTransaction()` releases ledger funds.
  - Line 320: `pausePost()` sets `status = 'paused'`.
  - Line 339: `resumePost()` sets `status = 'active'`.
  
  If `syncPulseMarketplaceGate()` throws an error (e.g., SQLite `SQLITE_BUSY` lock contention during concurrent activity, disk full, or an error thrown in `rotateDailyPulse` at line 247: `throw new Error('[DailyPulse] Failed to create Daily Pulse post')`), the unhandled error bubbles directly into the route's outer `catch (e: any)` block:
  ```typescript
  // apps/server/src/routes/marketplace.ts:128-131
  } catch (e: any) {
      ctx.status = 400;
      ctx.body = { error: e.message || 'Failed to create post' };
  }
  ```
- **Consequence**: The API responds with HTTP 400 and an error message, telling the user that their post, pause, remove, or transaction failed, **even though the operation already permanently committed to SQLite**. This can lead to duplicate listings, confused users, or phantom transactions.
- **Rule Violation**: Violates the principle that *a secondary failure in the gate must never fail the member's post/pause/delete request*.
- **Required Fix**: Wrap the body of `syncPulseMarketplaceGate()` in `apps/server/src/daily-pulse.ts:303-310` with exception shielding:
  ```typescript
  export function syncPulseMarketplaceGate(now: Date = new Date()): void {
      try {
          const memberListings = getActiveMemberListingCount();
          if (memberListings >= 2) {
              deactivatePulseMarketplacePost();
          } else {
              ensurePulseMarketplacePost(now);
          }
      } catch (err) {
          console.error('[DailyPulse] Failed to synchronize marketplace gate:', err);
      }
  }
  ```

### 2.4 Safety Under Concurrent Mutations
- SQLite WAL mode serializes writes, and deterministic IDs (`pulse_${localDateStr}`) prevent duplicate row insertions.
- `ensurePulseMarketplacePost` re-evaluates `if (getActiveMemberListingCount() >= 2) return;` at [`apps/server/src/daily-pulse.ts:277`](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/daily-pulse.ts#L277) to defend against races where a second listing was inserted between outer and inner checks.
- Once the `try/catch` fix in Section 2.3 is applied, transient `SQLITE_BUSY` errors during concurrent bursts will not cascade into user-facing 400 failures.

---

## 3. Boundary Rule and Bidirectional Crossing Verification

The threshold arithmetic and state transitions were verified against the formal requirement:

1. **0 real member listings**: `getActiveMemberListingCount() === 0` (< 2) $\rightarrow$ `ensurePulseMarketplacePost()` creates/reactivates today's pulse offer. Allowed.
2. **1 real member listing**: `getActiveMemberListingCount() === 1` (< 2) $\rightarrow$ Placeholder remains active alongside the member listing. Total displayed: 2. Allowed.
3. **Exactly 2 real member listings**: `getActiveMemberListingCount() === 2` ($\ge$ 2) $\rightarrow$ `deactivatePulseMarketplacePost()` marks active pulse post `active = 0, status = 'cancelled'`. Suppressed.
4. **Daily Pulse self-exclusion**: In [`apps/server/src/daily-pulse.ts:42`](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/daily-pulse.ts#L42), `author_pubkey != ?` excludes the pulse treasury public key. The pulse post never increments the member listing count against itself.
5. **Bidirectional crossing without restart**:
   - **Transition $1 \rightarrow 2$**: Handled synchronously by `syncPulseMarketplaceGate()` on `POST /posts` and `POST /resume`. The pulse post is deactivated immediately.
   - **Transition $2 \rightarrow 1$**: Handled synchronously by `syncPulseMarketplaceGate()` on `POST /remove` and `POST /pause`. In [`apps/server/src/daily-pulse.ts:285-291`](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/daily-pulse.ts#L285-L291), `ensurePulseMarketplacePost()` finds the existing cancelled post for today and reactivates it (`active = 1, status = 'active'`) immediately without waiting for 5:00 AM rotation or a server restart.
   - **Verification**: Verified in [`apps/server/src/test-daily-pulse.ts:192-199`](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/test-daily-pulse.ts#L192-L199) and route tests at lines 247–268.

---

## 4. Client Interactivity, Learn Lane, and Test Coverage Rigor

### 4.1 Non-Transactable Placeholder on Both Clients
- **Native (`apps/native`)**:
  - [`apps/native/app/(tabs)/index.tsx:1234, 1303, 1354`](file:///Users/marty/projects/bp-daily-pulse/apps/native/app/(tabs)/index.tsx#L1234): Sets `disabled={isPulse}`, `accessibilityRole={isPulse ? undefined : "button"}`, and `onPress={isPulse ? undefined : ...}` across grid, compact, and list views. Cards cannot be tapped into deal flow.
  - [`apps/native/app/post/[id].tsx:1205`](file:///Users/marty/projects/bp-daily-pulse/apps/native/app/post/[id].tsx#L1205): Replaces deal action buttons with `pulseInspirationBox` ("Post Your Own Offer →").
  - [`apps/native/app/post/[id].tsx:1427`](file:///Users/marty/projects/bp-daily-pulse/apps/native/app/post/[id].tsx#L1427): Direct messaging button guarded with `!isPulsePost`.
  - Price displays suppressed in [`(tabs)/index.tsx:1249`](file:///Users/marty/projects/bp-daily-pulse/apps/native/app/(tabs)/index.tsx#L1249) and [`post/[id].tsx:875`](file:///Users/marty/projects/bp-daily-pulse/apps/native/app/post/[id].tsx#L875). Offer chip replaced with `🗞️ PULSE` badge ([`index.tsx:1259`](file:///Users/marty/projects/bp-daily-pulse/apps/native/app/(tabs)/index.tsx#L1259)).
- **PWA (`apps/pwa`)**:
  - [`apps/pwa/src/pages/MarketplacePage.tsx:2076, 2139`](file:///Users/marty/projects/bp-daily-pulse/apps/pwa/src/pages/MarketplacePage.tsx#L2076): `onClick={isPulse ? undefined : ...}` prevents modal navigation.
  - [`apps/pwa/src/pages/MarketplacePage.tsx:914`](file:///Users/marty/projects/bp-daily-pulse/apps/pwa/src/pages/MarketplacePage.tsx#L914): Renders inspiration card instead of accept/request buttons.
  - [`apps/pwa/src/components/MarketplaceCard.tsx:345`](file:///Users/marty/projects/bp-daily-pulse/apps/pwa/src/components/MarketplaceCard.tsx#L345): Action pill is inert with `cursor-default`. Price hidden across all card layouts ([L179, 273, 315](file:///Users/marty/projects/bp-daily-pulse/apps/pwa/src/components/MarketplaceCard.tsx#L179)).
- **Escrow Engine**:
  - [`apps/server/src/engine/escrow.ts:82, 299`](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/engine/escrow.ts#L82): Throws `"Daily Pulse inspirational posts cannot be requested or transacted"` on any request or accept attempt. Tested in [`apps/server/src/test-daily-pulse.ts:141-153`](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/test-daily-pulse.ts#L141-L153).

### 4.2 Learn Lane Integration & UI Polish
- In [`apps/native/app/(tabs)/pulse.tsx:50-66`](file:///Users/marty/projects/bp-daily-pulse/apps/native/app/(tabs)/pulse.tsx#L50-L66), Learn lane queries `{ category: 'learn', limit: 20 }`.
- `hasLocalLane` state preserves the "Local" tab when navigating into Learn lane, fixing the UI layout collapse flagged in REVIEW2 ([`pulse.tsx:59-66`](file:///Users/marty/projects/bp-daily-pulse/apps/native/app/(tabs)/pulse.tsx#L59-L66)).
- Loading race condition guarded with `activeCategoryRef` and `activeLaneRef` ([`pulse.tsx:116-119`](file:///Users/marty/projects/bp-daily-pulse/apps/native/app/(tabs)/pulse.tsx#L116-L119)).
- `minHeight: 44` added to `laneTab` for WCAG 2.5.5 touch target compliance ([`pulse.tsx:536`](file:///Users/marty/projects/bp-daily-pulse/apps/native/app/(tabs)/pulse.tsx#L536)).
- `numberOfLines={1}` and `ellipsizeMode="tail"` added to segmented control text ([`pulse.tsx:328-331`](file:///Users/marty/projects/bp-daily-pulse/apps/native/app/(tabs)/pulse.tsx#L328-L331)).
- `disabled={!item.url}` added to [`apps/native/components/PulseFeedCard.tsx:158`](file:///Users/marty/projects/bp-daily-pulse/apps/native/components/PulseFeedCard.tsx#L158).
- Amber badge contrast ratios updated to dark amber on light backgrounds (`#92400e` on `#fef3c7`, ratio > 4.5:1), resolving WCAG AA violations in [`index.tsx:1260-1270`](file:///Users/marty/projects/bp-daily-pulse/apps/native/app/(tabs)/index.tsx#L1260-L1270), [`post/[id].tsx:845`](file:///Users/marty/projects/bp-daily-pulse/apps/native/app/post/[id].tsx#L845), and [`MarketplaceCard.tsx:345`](file:///Users/marty/projects/bp-daily-pulse/apps/pwa/src/components/MarketplaceCard.tsx#L345).

### 4.3 Test Suite Rigor
- **`apps/server/src/test-daily-pulse.ts` (82/82 passed)**:
  - Uses strict truthiness assertions (`assert(!!...)`), eliminating loose equality false-positives.
  - Tests boundary transitions: 0 $\rightarrow$ 1 $\rightarrow$ 2 $\rightarrow$ 3 $\rightarrow$ 1.
  - Directly exercises route dispatching (`dispatchRoute`) for `POST /posts`, `POST /pause`, `POST /resume`, `POST /remove`, and `GET /posts`.
  - Would fail immediately if gating threshold arithmetic, reactivation logic, or route hooks regressed.
- **`apps/server/src/test-pulse-curated.ts` (88/88 passed)**:
  - Curated items survive hygiene pruning; Learn lane returns 5 videos + 1 Daily Pulse reflection card.
- **Native Vitest Suite (171/171 passed)**, **Server Typecheck (0 errors)**, **PWA Typecheck & Build (0 errors, 1.33s)**.

---

## 5. Verification of Explicitly Forbidden Rules

| Forbidden Rule | Status | Evidence (`file:line`) |
| :--- | :--- | :--- |
| **Must NOT change `freshTodayCount` or the "fresh listing posted today" banner** | **CONFIRMED PASS** | Both [`apps/native/app/(tabs)/index.tsx:840`](file:///Users/marty/projects/bp-daily-pulse/apps/native/app/(tabs)/index.tsx#L840) and [`apps/pwa/src/pages/MarketplacePage.tsx:1960`](file:///Users/marty/projects/bp-daily-pulse/apps/pwa/src/pages/MarketplacePage.tsx#L1960) remain completely untouched. Diff across `freshToday` is empty. |
| **Must NOT rewrite or regenerate daily pulse copy or scripts** | **CONFIRMED PASS** | `scripts/compress-pulse.mjs`, `scripts/daily-pulse-source.json`, and `apps/server/src/daily-pulse-entries.ts` have 0 changes (`git diff origin/main...HEAD` is empty). |

---

## Conclusion & Action Required to Unblock

This PR is significantly improved and nearly ready for `main`. However, it remains **MERGE BLOCKED** due to the unhandled exception hazard in `syncPulseMarketplaceGate()`.

### Required Fix (1 single block):
In [`apps/server/src/daily-pulse.ts:303-310`](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/daily-pulse.ts#L303-L310), enclose the body of `syncPulseMarketplaceGate` in a `try/catch` block:

```typescript
export function syncPulseMarketplaceGate(now: Date = new Date()): void {
    try {
        const memberListings = getActiveMemberListingCount();
        if (memberListings >= 2) {
            deactivatePulseMarketplacePost();
        } else {
            ensurePulseMarketplacePost(now);
        }
    } catch (err) {
        console.error('[DailyPulse] Error synchronizing marketplace gate:', err);
    }
}
```

Once this error-shielding fix is applied, the PR will be **SAFE TO MERGE**.
