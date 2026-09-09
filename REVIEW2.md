# Comprehensive Code Review: PR #690

**Verdict:** **MERGE BLOCKED** — The PR introduces unconditional SQLite `UPDATE` write queries inside the primary HTTP `GET /api/marketplace/posts` endpoint causing severe database lock contention (`SQLITE_BUSY`), suffers from one-way threshold gating that fails to restore the bootstrap post when member listings drop back below 2 (< 2), and exhibits multiple WCAG 2.1 AA contrast failures and client state regressions.

---

## Executive Summary

PR #690 aims to move the "Daily Pulse" curated content from a live marketplace offer into the Pulse tab's Learn lane as a drip item, while gating its marketplace appearance to nodes with fewer than 2 real listings (< 2).

The core intent is well-conceived and mostly implemented, but several critical architectural bugs, concurrency hazards, and accessibility violations must be resolved before this branch can safely merge to `main`.

---

## 1. Explicitly Forbidden Rules Verification

The maintainer laid down two strict negative constraints. Both were verified:

| Forbidden Action | Status | Verification (file:line) |
| :--- | :--- | :--- |
| **Must NOT change `freshTodayCount` or the "fresh listing posted today" banner** | **CONFIRMED PASS** | Neither `apps/native/app/(tabs)/index.tsx:840` nor `apps/pwa/src/pages/MarketplacePage.tsx:1960` were modified. Git diff across `freshToday` is completely clean (`git diff origin/main...HEAD \| grep fresh` returns 0 changes). |
| **Must NOT rewrite or regenerate daily pulse copy or scripts** | **CONFIRMED PASS** | `scripts/compress-pulse.mjs`, `scripts/daily-pulse-source.json`, and `apps/server/src/daily-pulse-entries.ts` were untouched (`git diff origin/main...HEAD -- scripts/ apps/server/src/daily-pulse-entries.ts` is empty). |

---

## 2. Priority 1: Threshold Logic & Boundary Transitions

### 2.1 Boundary Evaluation (0, 1, and 2 listings)
- **0 member listings**: `getActiveMemberListingCount() === 0` (< 2) $\rightarrow$ Allowed.
- **1 member listing**: `getActiveMemberListingCount() === 1` (< 2) $\rightarrow$ Allowed.
- **2 member listings**: `getActiveMemberListingCount() === 2` (not < 2) $\rightarrow$ Suppressed.
- **Exclusion of Daily Pulse's own post**:
  In [`apps/server/src/daily-pulse.ts:83-89`](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/daily-pulse.ts#L83-L89):
  ```sql
  SELECT COUNT(*) as c FROM posts WHERE author_pubkey != ? AND active = 1 AND status = 'active'
  ```
  The Daily Pulse treasury public key is explicitly excluded. The threshold arithmetic is exact and free of off-by-one errors.

### 2.2 Boundary Crossing Hazards
- **Transition 1 $\rightarrow$ 2 (Node becomes active)**:
  - When the 2nd listing is created via `POST /api/marketplace/posts` ([`apps/server/src/routes/marketplace.ts:130-132`](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/routes/marketplace.ts#L130-L132)), `deactivatePulseMarketplacePost()` is immediately executed.
  - Active pulse post is set to `active = 0, status = 'cancelled'`. Both native and PWA clients also perform defensive client-side filtering.
- **Transition 2 $\rightarrow$ 1 (Member removes or pauses a listing) [CONFIRMED DEFECT]**:
  - In [`apps/server/src/routes/marketplace.ts:141-155`](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/routes/marketplace.ts#L141-L155) (`POST /api/marketplace/posts/remove`) and lines 311–325 (`POST /api/marketplace/posts/pause`), there is **no check** for whether member listings have dropped below 2.
  - In [`apps/server/src/routes/marketplace.ts:92-94`](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/routes/marketplace.ts#L92-L94) (`GET /api/marketplace/posts`), the code only checks `if (getActiveMemberListingCount() >= 2) { deactivatePulseMarketplacePost(); }`. It **never reactivates or re-creates** the post when listings drop back to 1 or 0.
  - **Result**: Once suppressed, the Daily Pulse marketplace post remains soft-deleted in the database until 5:00 AM the next day (or until the server restarts). A node whose active listings drop from 2 to 1 will remain without a marketplace placeholder for up to 24 hours.
  - *Note on test masking*: In `test-daily-pulse.ts:184`, the test masked this defect by manually calling `rotateDailyPulse(dateDay2)` after deleting listings, rather than verifying route behavior.

### 2.3 Concurrency & 5:00 AM Rotation Races
- In `rotateDailyPulse()` ([`apps/server/src/daily-pulse.ts:117`](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/daily-pulse.ts#L117)), execution is wrapped in `db.transaction(...)()`.
- If listing #2 is posted concurrently with 5:00 AM rotation, either `rotateDailyPulse` checks `getActiveMemberListingCount()` after the member post and suppresses creation, or if created first, `POST /api/marketplace/posts` immediately calls `deactivatePulseMarketplacePost()`. No race allows an orphaned active pulse post to survive.

---

## 3. Priority 2: Non-Transactable Placeholder Verification

The maintainer required that Daily Pulse cannot be pledged, accepted, messaged about, counted in listing totals, or opened into a deal flow on either client:

| Flow / Action | Native Client | PWA Client | Server Engine |
| :--- | :--- | :--- | :--- |
| **Pledge / Accept / Request Deal** | **BLOCKED**: [`post/[id].tsx:1205`](file:///Users/marty/projects/bp-daily-pulse/apps/native/app/post/[id].tsx#L1205) renders `pulseInspirationBox` ("Post Your Own Offer →") instead of deal action buttons. | **BLOCKED**: [`MarketplacePage.tsx:914`](file:///Users/marty/projects/bp-daily-pulse/apps/pwa/src/pages/MarketplacePage.tsx#L914) renders inspiration card; accept/request buttons are in the else branch. | **BLOCKED**: [`apps/server/src/engine/escrow.ts:299`](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/engine/escrow.ts#L299) and L82 throw `"Daily Pulse inspirational posts cannot be requested or transacted"`. |
| **Direct Messaging** | **BLOCKED**: [`post/[id].tsx:1427`](file:///Users/marty/projects/bp-daily-pulse/apps/native/app/post/[id].tsx#L1427) guards message button with `!isPulsePost`. | **BLOCKED**: [`MarketplacePage.tsx:1242`](file:///Users/marty/projects/bp-daily-pulse/apps/pwa/src/pages/MarketplacePage.tsx#L1242) guards message button with `!isPulsePost`. | **BLOCKED**: No inbound chats or outbound messages exist ([`test-daily-pulse.ts:144`](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/test-daily-pulse.ts#L144)). |
| **Card Tap / Deal Flow Opening** | **BLOCKED**: [`(tabs)/index.tsx:1236, 1294, 1344`](file:///Users/marty/projects/bp-daily-pulse/apps/native/app/(tabs)/index.tsx#L1236) set `onPress={isPulse ? undefined : ...}` across grid, compact, and list. | **BLOCKED**: [`MarketplacePage.tsx:2076, 2139`](file:///Users/marty/projects/bp-daily-pulse/apps/pwa/src/pages/MarketplacePage.tsx#L2076) set `onClick={isPulse ? undefined : ...}`. | N/A |
| **Bean Price Display** | **SUPPRESSED**: Price badges hidden on all cards and modal ([`index.tsx:1249`](file:///Users/marty/projects/bp-daily-pulse/apps/native/app/(tabs)/index.tsx#L1249), [`MarketplaceCard.tsx:179, 273, 315`](file:///Users/marty/projects/bp-daily-pulse/apps/pwa/src/components/MarketplaceCard.tsx#L179), [`post/[id].tsx:875`](file:///Users/marty/projects/bp-daily-pulse/apps/native/app/post/[id].tsx#L875), [`MarketplacePage.tsx:608`](file:///Users/marty/projects/bp-daily-pulse/apps/pwa/src/pages/MarketplacePage.tsx#L608)). | Same. | N/A |
| **OFFER Chip Display** | **SUPPRESSED**: Replaced by `🗞️ PULSE` or `DAILY PULSE` ([`index.tsx:1259, 1313, 1362`](file:///Users/marty/projects/bp-daily-pulse/apps/native/app/(tabs)/index.tsx#L1259), [`MarketplaceCard.tsx:165, 345`](file:///Users/marty/projects/bp-daily-pulse/apps/pwa/src/components/MarketplaceCard.tsx#L165)). | Same. | N/A |

---

## 4. Priority 3: Learn Lane Integration & Downstream PWA Consumption

### 4.1 Data Model Alignment
- Conforms to [`docs/pulse-learn-lane.md`](file:///Users/marty/projects/bp-daily-pulse/docs/pulse-learn-lane.md):
  - Uses existing `pulse_items` table with `category = 'learn'`, `platform = 'website'`, `source = 'curated'`, and `curated = 1` ([`apps/server/src/daily-pulse.ts:148`](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/daily-pulse.ts#L148)).
  - Uses `chan_daily_pulse` in `creator_channels` with `syndicate_to_node = 1`.
  - Satisfies Contract B tombstoning: soft-deletes prior day's item with `deleted_at`, scrubbing `url`, `title`, and `thumbnail_url` ([`apps/server/src/daily-pulse.ts:123-127`](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/daily-pulse.ts#L123-L127)).

### 4.2 Native Pulse Tab
- Displays in `apps/native/app/(tabs)/pulse.tsx`:
  - Added `'learn'` to `lane` state (`'neighbours' | 'local' | 'learn'`).
  - Calls `fetchPulseFeed({ category: 'learn', limit: 20 })`.
  - In `apps/native/components/PulseFeedCard.tsx:215`, renders `🌱 Daily Reflection` and disables link handlers when `item.url` is null.

### 4.3 Downstream Consumption by Merged PWA Pulse Tab (`origin/main` commit `d1dc04a`) [CONFIRMED IMPACT]
How the merged PWA Pulse tab consumes this content:
1. **Misclassified into Neighbours Lane**:
   In `apps/pwa/src/lib/pulse.ts:47`, `isOfficialSource(item)` is defined as `item.source === 'official'`. Because Daily Pulse uses `source = 'curated'`, `isOfficialSource` evaluates to `false`. PWA currently only splits between `'neighbours'` and `'local'` (no Learn lane yet). Consequently, the Daily Pulse reflection is placed directly into `neighbourItems` and shown in the default Neighbours feed.
2. **Broken "Open on Website ↗" Link**:
   In `apps/pwa/src/components/PulseFeedCard.tsx:232-257`, cards with platform `'website'` render `Website ↗`, `role="link"`, and footer text `Open on Website ↗`. Because `item.url` is `NULL`, clicking the card triggers `if (!item.url) return;`. To the user, it renders as an interactive link that is completely inert on click.
   - *Verdict*: PWA does **not** silently miss it; it surfaces it in the wrong lane with a broken interactive link affordance.

---

## 5. Priority 4: Test Suite Rigor & Boundary Verification

1. **`apps/server/src/test-daily-pulse.ts` (60/60 passed)**:
   - Tests 0, 1, 2, and 3 listings.
   - Tests soft-deletion of yesterday's pulse item and marketplace offer.
   - Tests callsign collision safety (`is_treasury = 0` un-escalated).
   - *Hazard Identified*: In lines 165 and 106, assertions like `assert(pulseItemWith2 !== null, ...)` and `assert(day1PulseItemRow?.deleted_at !== null, ...)` evaluate to `true` if the variable is `undefined`, causing tests to pass unconditionally if properties are missing. Should use `assert(!!pulseItemWith2, ...)`.
2. **`apps/server/src/test-pulse-curated.ts` (88/88 passed)**:
   - Verifies 5 seeded instructional videos + 1 Daily Pulse reflection card = 6 items in `getPulseFeed({ category: 'learn' })`.
   - Confirms craft feed excludes Daily Pulse.
3. **Typecheck & Build**:
   - `apps/native`: `tsc --noEmit` $\rightarrow$ 0 errors; 171/171 Vitest tests passed.
   - `apps/server`: `tsc --noEmit` $\rightarrow$ 0 errors.
   - `apps/pwa`: `tsc --noEmit` $\rightarrow$ 0 errors; Vite production build completed in 1.43s.

---

## 6. Priority 5: UX, Accessibility, 320dp & 1.3x Font Scaling

### 6.1 Native `laneBar` at 320dp with 1.3x Font Scaling
- In [`apps/native/app/(tabs)/pulse.tsx:298-328`](file:///Users/marty/projects/bp-daily-pulse/apps/native/app/(tabs)/pulse.tsx#L298-L328), when 3 tabs are present, each tab gets ~92dp width.
- At 1.3x scaling, `fontSize: 13` becomes ~17px. `👥 Neighbours` (12 chars + count badge) lacks `numberOfLines={1}` and `ellipsizeMode="tail"`, causing the label to wrap onto 2 lines and visually distort the segmented control.
- `laneTab` uses `paddingVertical: 9` (~36dp height), failing the 44x44dp minimum touch target (WCAG 2.5.5). Needs `minHeight: 44`.

### 6.2 WCAG 2.1 AA Color Contrast Violations (< 4.5:1) [CONFIRMED DEFECTS]
1. **Native Grid Badge** ([`apps/native/app/(tabs)/index.tsx:1259`](file:///Users/marty/projects/bp-daily-pulse/apps/native/app/(tabs)/index.tsx#L1259)):
   `🗞️ PULSE` badge uses `backgroundColor: palette.amber500` with text `color: '#ffffff'`. Contrast ratio is **2.14:1** (fails WCAG AA 4.5:1 requirement).
2. **Native Modal Badge** ([`apps/native/app/post/[id].tsx:845`](file:///Users/marty/projects/bp-daily-pulse/apps/native/app/post/[id].tsx#L845)):
   `● DAILY PULSE` text uses `palette.amber500` on white surface in light theme. Contrast ratio is **2.14:1** (fails WCAG AA).
3. **PWA Action Button** ([`apps/pwa/src/components/MarketplaceCard.tsx:345`](file:///Users/marty/projects/bp-daily-pulse/apps/pwa/src/components/MarketplaceCard.tsx#L345)):
   Inert `DAILY PULSE` pill uses `bg-amber-500 text-white`. Contrast ratio is **2.14:1** (fails WCAG AA).

---

## 7. Critical Architecture & Concurrency Defects

### 7.1 SQLite Write Contention on HTTP GET Endpoint [CRITICAL]
- **File**: [`apps/server/src/routes/marketplace.ts:92-94`](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/routes/marketplace.ts#L92-L94)
- **Code**:
  ```typescript
  if (getActiveMemberListingCount() >= 2) {
      deactivatePulseMarketplacePost();
  }
  ```
- **Blast Radius**:
  `deactivatePulseMarketplacePost()` executes `UPDATE posts SET active = 0, status = 'cancelled', updated_at = ...`.
  On every single incoming `GET /api/marketplace/posts` request on any active node (>= 2 listings), SQLite is forced to execute an `UPDATE` write statement.
  - In SQLite WAL mode, readers do not block readers, but a writer acquires an exclusive database lock.
  - Executing writes inside the highest-frequency read endpoint serializes requests, degrades throughput, and triggers `SQLITE_BUSY: database is locked` errors during concurrent user browsing or federation sync polling.
  - Mutating `updated_at` on every GET request pollutes incremental sync cursors (`?updatedAfter=...`) for peer nodes.
- **Remedy**:
  Do not run `UPDATE` statements on read queries. Deactivate strictly on mutating actions (`POST /api/marketplace/posts`, scheduled rotation), or check if an active post actually exists before calling `deactivatePulseMarketplacePost()`:
  ```typescript
  if (getActiveMemberListingCount() >= 2) {
      const activePulse = getActivePulsePost();
      if (activePulse) deactivatePulseMarketplacePost();
  }
  ```

### 7.2 Ed25519 Key Generation & State Mutation During Read Queries [CRITICAL]
- **File**: [`apps/server/src/daily-pulse.ts:83-89`](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/daily-pulse.ts#L83-L89) & [`L95`](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/daily-pulse.ts#L95)
- **Code**:
  `getActiveMemberListingCount()` and `deactivatePulseMarketplacePost()` call `ensurePulseTreasury()`.
  If the treasury does not yet exist (e.g. server startup or `DAILY_PULSE=false`), querying `GET /api/marketplace/posts` triggers synchronous Ed25519 key generation, SQLite member inserts, and WebSocket broadcasts.
- **Remedy**:
  Query `members` for `callsign = 'Daily Pulse' AND is_treasury = 1` read-only. If absent, `pulsePubkey` is null and no treasury creation should occur.

### 7.3 Idempotency & SQLite Primary Key Collision
- **File**: [`apps/server/src/daily-pulse.ts:176`](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/daily-pulse.ts#L176)
- **Code**:
  ```typescript
  const existingToday = db.prepare("SELECT * FROM posts WHERE id = ? AND author_pubkey = ?").get(pulseId, pulsePubkey) as any;
  ```
- **Risk**: If the treasury was recreated or identity rotated, `author_pubkey` changes. Querying with `AND author_pubkey = ?` returns `undefined`, leading to `createPost()` with `pulseId`, throwing a fatal `SQLITE_CONSTRAINT: UNIQUE constraint failed: posts.id` and rolling back `rotateDailyPulse()`.
- **Remedy**: Query by `id = ?` alone.

---

## 8. Detailed Specialist Findings (CONFIRMED vs SPECULATIVE)

| Finding | Classification | Severity | File:Line | Description |
| :--- | :--- | :--- | :--- | :--- |
| **Write Lock on GET** | **CONFIRMED** | **Blocker** | [`apps/server/src/routes/marketplace.ts:93`](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/routes/marketplace.ts#L93) | Unconditional `UPDATE posts` executed on read queries causes SQLite write lock contention and sync cursor pollution. |
| **One-Way Gating Asymmetry** | **CONFIRMED** | **Blocker** | [`apps/server/src/routes/marketplace.ts:149`](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/routes/marketplace.ts#L149) | Removing or pausing listings to drop count below 2 does not restore Daily Pulse until 5:00 AM the next day. |
| **Read Query Account Mutation** | **CONFIRMED** | **Major** | [`apps/server/src/daily-pulse.ts:84`](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/daily-pulse.ts#L84) | `getActiveMemberListingCount()` calls `ensurePulseTreasury()`, executing crypto key generation on read paths. |
| **Unique Constraint Collision** | **CONFIRMED** | **Major** | [`apps/server/src/daily-pulse.ts:176`](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/daily-pulse.ts#L176) | Idempotency lookup scoped by `author_pubkey` causes `SQLITE_CONSTRAINT` crash if treasury identity rotates. |
| **Disappearing Local Lane Tab** | **CONFIRMED** | **Normal** | [`apps/native/app/(tabs)/pulse.tsx:301`](file:///Users/marty/projects/bp-daily-pulse/apps/native/app/(tabs)/pulse.tsx#L301) | `localLaneAvailable` drops to false when `items` is replaced by learn items, removing Local tab from UI. |
| **Race Condition in `loadFeed`** | **CONFIRMED** | **Normal** | [`apps/native/app/(tabs)/pulse.tsx:108`](file:///Users/marty/projects/bp-daily-pulse/apps/native/app/(tabs)/pulse.tsx#L108) | `finally` block terminates loading spinner for newer in-flight requests on rapid tab switching. |
| **WCAG AA Contrast Failures** | **CONFIRMED** | **Normal** | [`apps/native/app/(tabs)/index.tsx:1259`](file:///Users/marty/projects/bp-daily-pulse/apps/native/app/(tabs)/index.tsx#L1259), [`apps/pwa/src/components/MarketplaceCard.tsx:345`](file:///Users/marty/projects/bp-daily-pulse/apps/pwa/src/components/MarketplaceCard.tsx#L345) | White text on `amber-500` yields 2.14:1 contrast ratio, failing WCAG 2.1 Level AA. |
| **PWA Inert Link Affordance** | **CONFIRMED** | **Normal** | [`apps/pwa/src/components/PulseFeedCard.tsx:232`](file:///Users/marty/projects/bp-daily-pulse/apps/pwa/src/components/PulseFeedCard.tsx#L232) (origin/main) | Merged PWA Pulse tab renders Daily Pulse reflection with broken "Open on Website ↗" link. |
| **Missing `disabled` on Pressable** | **CONFIRMED** | **Minor** | [`apps/native/app/(tabs)/index.tsx:1236`](file:///Users/marty/projects/bp-daily-pulse/apps/native/app/(tabs)/index.tsx#L1236) | Non-tappable card retains gesture responder without `disabled={isPulse}`. |
| **Uncached Prepared Statements** | **CONFIRMED** | **Minor** | [`apps/server/src/daily-pulse.ts:85`](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/daily-pulse.ts#L85) | `db.prepare()` recompilation churn on high-frequency route. |
| **Loose Equality Test Hazard** | **CONFIRMED** | **Minor** | [`apps/server/src/test-daily-pulse.ts:165`](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/test-daily-pulse.ts#L165) | `assert(pulseItemWith2 !== null)` passes if property is `undefined`. |
| **Sync Node Gating Desync** | *SPECULATIVE* | *Low* | [`apps/server/src/routes/marketplace.ts:89`](file:///Users/marty/projects/bp-daily-pulse/apps/server/src/routes/marketplace.ts#L89) | Replicas receiving peer sync might evaluate threshold against partial local state. |

---

## Conclusion & Next Steps

This PR cannot be merged in its current state. To achieve `SAFE TO MERGE`:
1. Remove database write operations from `GET /api/marketplace/posts` and read-only helpers.
2. Implement bidirectional threshold gating so deleting or pausing a listing properly restores the placeholder when listings fall below 2.
3. Update `apps/native/app/(tabs)/pulse.tsx` to preserve `hasLocalLane` and add `numberOfLines={1}` / `minHeight: 44` to `laneTab`.
4. Fix the `amber-500` contrast failures across native and PWA marketplace cards.
5. In follow-up PWA parity, add Learn lane and null-URL reflection card support to `apps/pwa/src/pages/PulsePage.tsx`.
