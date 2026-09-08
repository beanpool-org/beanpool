# Summary of PWA Safety & Parity Fixes

This document details all changes implemented in the working tree (`/Users/marty/projects/bp-parity-b`) to bring the PWA to parity with native safety, version gating, privacy controls, and honest notification settings as audited in `docs/native-pwa-parity.md`.

---

## 1. Task 1: Blocklist & Abuse Reporting Parity

### Overview
In native (`apps/native/utils/blocklist.ts`), users can block/unblock members and submit abuse reports. When blocking a user, an abuse report is sent to the server (`POST /api/reports`). If offline or the network fails, the report is saved to an offline queue (`bp_pending_abuse_reports` / `beanpool_pending_abuse_reports`) with a 7-day TTL and retried upon app reconnection. Blocked users are filtered out of feeds, searches, conversations, and friend lists.

Previously, `bp_blocked_users` was read in only one place in the PWA (`MarketplacePage.tsx:1910`) and never written anywhere.

### Files Created:
1. **`apps/pwa/src/lib/blocklist.ts`** (Lines 1–236)
   - **What**: Implements full blocklist utility:
     - `getBlockedUsers()`: Reads blocked public keys from `bp_blocked_users` (and syncs with `beanpool_blocked_users`).
     - `isUserBlocked(pubkey)`: Checks if a public key is blocked.
     - `blockUser(targetPubkey, reason?, details?, targetPostId?, reporterPubkey?)`: Adds user to blocklist, emits update events, and submits abuse report (`reportAbuse()`) to `POST /api/reports`. If the network request fails, queues report to `bp_pending_abuse_reports` (capped at 50, 7-day TTL).
     - `unblockUser(targetPubkey)`: Removes user from blocklist and emits update event.
     - `clearBlocklist()`: Clears all blocked users.
     - `retryPendingReports()`: Retries queued offline abuse reports with backoff and clears succeeded/expired entries.
     - `onBlocklistUpdated(callback)`: Event emitter and listener (supporting window `storage` events across tabs) for reactive UI updates.
   - **Why**: Provides consistent semantics, storage keys, and offline resilience matching native `blocklist.ts`.

2. **`apps/pwa/src/lib/blocklist.test.ts`** (Lines 1–85)
   - **What**: 7 unit tests testing blocking, unblocking, idempotency, duplicate prevention, and offline report queue/retry mechanisms. All passing.
   - **Why**: Prevents regressions and validates offline report queueing.

3. **`apps/pwa/src/components/ReportModal.tsx`** (Lines 1–147)
   - **What**: Accessible modal dialog allowing users to report a member or post:
     - Predefined reason selection (`'Spam or scam'`, `'Offensive content'`, `'Misleading post'`, `'Other'`).
     - Optional details textarea with 500-character limit.
     - Directly calls `reportAbuse(reporterPubkey, targetPubkey, reason, targetPostId)` from `api.ts`.
     - Supports keyboard navigation, dark mode, and responsive layout down to 320dp.
   - **Why**: Provides the UI interface for member abuse reporting matching native safety flows.

### Files Modified:
4. **`apps/pwa/src/pages/PublicProfilePage.tsx`**
   - **Lines 15, 23**: Imported `blockUser`, `unblockUser`, `isUserBlocked`, and `ReportModal`.
   - **Lines 50–52**: Added component state `isBlocked`, `isBlocking`, and `showReportModal`.
   - **Lines 72–104**: Added `handleBlock` and `handleUnblock` handlers with user confirmations and optimistic UI updates.
   - **Lines 173–200**: Added top-right header action buttons for "Report" (flag icon) and "Block/Unblock" next to "Edit" (or replacing the placeholder spacer).
   - **Lines 243–257**: Replaced "Send Message" button with a blocked banner notice ("🚫 You have blocked this member. Messaging is disabled.") when `isBlocked` is true.
   - **Lines 562–591**: Added prominent bottom action block for non-self profiles ("Report Member" and "Block Member" / "Unblock Member") with contextual explanation.
   - **Lines 671–678**: Mounted `ReportModal` tied to state.

5. **`apps/pwa/src/pages/MessagesPage.tsx`**
   - **Lines 20, 24**: Imported `getBlockedUsers`, `isUserBlocked`, `blockUser`, `unblockUser`, `onBlocklistUpdated`, and `ReportModal`.
   - **Lines 73, 90–98**: Added `blocklistVersion` reactive state and `onBlocklistUpdated` listener.
   - **Lines 100–108**: Filtered DM conversations list by `getBlockedUsers()` so blocked user threads are hidden from the active inbox.
   - **Lines 319–324**: Filtered candidate members list in New Conversation modal to exclude blocked members.
   - **Lines 530–540**: Added header "Report" (🚩) and "Block" (🚫) action buttons in active DM conversation view.
   - **Lines 806–830**: Replaced active message input bar with a non-interactive warning banner ("🚫 You have blocked this user. Messaging is disabled.") and an inline "Unblock" button if the user opens a blocked thread.
   - **Lines 898–906, 990–998**: Mounted `ReportModal` for thread reporting.

6. **`apps/pwa/src/pages/PeoplePage.tsx`**
   - **Line 16**: Imported `getBlockedUsers` and `onBlocklistUpdated`.
   - **Lines 86, 91–98**: Added `blocklistVersion` state and `onBlocklistUpdated` listener; memoized `blockedSet`.
   - **Lines 146–153**: Filtered `visibleFriends`, `friendPubkeys`, and `guardians` to exclude blocked members.
   - **Lines 163–170**: Filtered `filteredMembers` in the Community tab to exclude blocked members.
   - **Lines 200, 209**: Rendered `visibleFriends` in Friends tab.
   - **Lines 355, 372**: Rendered `visibleFriends` in Guardians tab with dark-mode support.

7. **`apps/pwa/src/pages/MarketplacePage.tsx`**
   - **Line 39**: Imported `getBlockedUsers` and `onBlocklistUpdated`.
   - **Lines 271–277**: Added `blocklistVersion` state and `onBlocklistUpdated` listener to trigger reactive re-filtering when blocklist updates occur.
   - **Lines 1916–1921**: Refactored raw `localStorage.getItem` parse to use `getBlockedUsers()` helper and filter matching posts.

8. **`apps/pwa/src/pages/SettingsPage.tsx`**
   - **Lines 18, 24, 71**: Imported `getBlockedUsers`, `unblockUser`, `clearBlocklist`; added `'blocked-users'` to `SettingsMode`.
   - **Lines 187–208**: Added `blockedUsersList` state and `loadBlockedList()` fetching member callsigns and public keys.
   - **Lines 642–650**: Added "🚫 Manage Blocked Members" button under the `LEGAL & PRIVACY` menu section.
   - **Lines 1144–1211**: Added `mode === 'blocked-users'` view displaying all blocked members with shortened pubkeys, individual "Unblock" buttons, and an "Unblock All" button with confirmation.

---

## 2. Task 2: Minimum Version Gate

### Overview
In native (`apps/native/components/GlobalHeader.tsx:267, 584-635` and `apps/native/utils/app-version.ts`), the app checks the node's `minAppVersion` served by `GET /api/community/health`. If the client bundle version is older than `minAppVersion`, it blocks interaction or warns the user that an update is required.

Previously, `minAppVersion` was not read or checked in the PWA at all.

### Files Created:
1. **`apps/pwa/src/lib/app-version.ts`** (Lines 1–38)
   - **What**: Ported `normaliseVersion` and `isVersionOlder` from native `apps/native/utils/app-version.ts`. Compares standard semantic versions `x.y.z` as well as versions with `v` prefixes or pre-release suffixes.
   - **Why**: Guarantees identical version comparison behavior between native and PWA.

2. **`apps/pwa/src/lib/app-version.test.ts`** (Lines 1–57)
   - **What**: 7 unit tests verifying semver comparisons (patch, minor, major, equality, prefix stripping, and malformed fallback). All passing.
   - **Why**: Ensures version comparisons are robust and regression-free.

### Files Modified:
3. **`apps/pwa/src/App.tsx`**
   - **Lines 21–22**: Imported `normaliseVersion`, `isVersionOlder`, and `retryPendingReports`.
   - **Line 84**: Added `minAppVersion?: string;` to `NodeHealthState` interface.
   - **Line 115**: Computed `isVersionOutdated` comparing baked bundle version `__APP_VERSION__` (from `vite.config.ts`) against `communityHealth?.minAppVersion`.
   - **Line 160**: Called `retryPendingReports()` on mount to process any queued offline abuse reports.
   - **Lines 357–381**: Rendered a prominent, non-dismissible warning banner at the top of the viewport when `isVersionOutdated` is true:
     - Includes warning emoji `⚠️`, required version vs current version.
     - Features an actionable "Refresh" button (`window.location.reload()`) to load the updated web bundle.
     - Accessible: `role="alert" aria-live="assertive"`.
     - Styled cleanly with dark mode and 320dp responsive breakpoints.

---

## 3. Task 3: Dead Privacy Control Analysis & Cleanup

### Native Architectural Analysis:
In native (`apps/native/app/(tabs)/settings.tsx:467-485, 1622-1637`), location privacy is strictly a binary device toggle:
- Native uses `expo-location` with `Location.getForegroundPermissionsAsync()` and requests system permission.
- Native displays:
  - Label: `Location`
  - Subtitle: `Enabled — used for nearby posts & map` vs `Disabled — tap to enable`
- Native contains **no 4-tier privacy model**, no `PrivacyBadge`, and no granular tier settings.

In the PWA:
- `apps/pwa/src/lib/privacy.ts` defined an unused 4-tier model (`'0' | '1' | '2' | '3'` with labels like `'Ghost'`, `'Neighbourhood'`, `'Precise'`).
- `apps/pwa/src/components/PrivacyBadge.tsx` rendered this 4-tier badge, but was **never mounted anywhere in the application**.
- `apps/pwa/src/App.tsx:7` contained a stale header comment referencing `PrivacyBadge`.
- `SettingsPage.tsx:92-100, 554-570` implements an unrelated binary toggle (`privacyTier === '3' ? 'Live Location Sharing' : 'Ghost Mode (Location Hidden)'`).

### Changes Made:
1. **Deleted `apps/pwa/src/components/PrivacyBadge.tsx`** (63 lines removed).
2. **Deleted `apps/pwa/src/lib/privacy.ts`** (80 lines removed).
3. **Modified `apps/pwa/src/App.tsx:7`**: Removed stale comment referring to `PrivacyBadge`.
4. **Justification**: Removing `PrivacyBadge.tsx` and `privacy.ts` eliminates dead code while leaving the binary location toggle in `SettingsPage.tsx` aligned with native's binary model.

---

## 4. Task 4: Honest Notification Settings Copy

### Overview
The PWA does not support Web Push notifications or a background push service worker (`selfDestroying: true` is enabled in `vite.config.ts` to prevent stale caching). Push notification device tokens are registered exclusively on native phones via `apps/native/utils/push-notifications.ts`.

However, the PWA settings page displays notification preferences stored in the member profile on the server (`GET /api/members/preferences` and `POST /api/members/preferences`). Previously, `SettingsPage.tsx` had misleading copy:
> *"Control which activity triggers browser notifications and alerts."*

This caused users to believe toggling these settings would enable web browser push notifications.

### Files Modified:
1. **`apps/pwa/src/pages/SettingsPage.tsx`**
   - **Line 573**: Updated main settings menu item subtext from `"Control alerts by category"` to `"Phone app push notification settings"`.
   - **Lines 1085–1091**: Replaced misleading copy with an explicit callout banner:
     > **📱 Phone App Only**
     > *These preferences govern push notifications delivered to the mobile app for this account. Web browsers do not receive push notifications.*
   - **Lines 1100, 1112, 1124**: Updated toggle descriptions to clarify their phone app behavior:
     - **Chat Messages**: *"Push alerts on your phone when someone messages you"*
     - **Marketplace Activity**: *"Push alerts on your phone for new offers & needs in your area"*
     - **Escrow & Deals**: *"Push alerts on your phone for trade updates & credit transfers"*

---

## 5. Test Setup

### Files Modified:
1. **`apps/pwa/src/setupTests.ts`**
   - **Lines 3–28**: Added an in-memory `localStorage` mock conforming to the `Storage` interface. This ensures vitest executes deterministically in Node v26 environments where the global `localStorage` property may otherwise be unconfigured or read-only during CLI test runs.

---

## 6. Verification Results

- **PWA Vitest**:
  ```
  Test Files  4 passed (4)
       Tests  19 passed (19)
  ```
  - `src/lib/smoke.test.ts` (2 tests)
  - `src/lib/app-version.test.ts` (7 tests)
  - `src/lib/channels.test.ts` (3 tests)
  - `src/lib/blocklist.test.ts` (7 tests)

- **Native Vitest**:
  ```
  Test Files  15 passed (15)
       Tests  171 passed (171)
  ```

- **PWA TypeScript & Production Build**:
  ```bash
  cd apps/pwa && npx tsc --noEmit && pnpm run build
  ```
  Exited with code 0 (clean compilation and build).

- **Responsive & Theme Verification**:
  - All new elements include Tailwind responsive classes down to 320dp width (`min-w-0`, `truncate`, `flex-wrap`, `text-xs sm:text-sm`).
  - All new UI components include corresponding `dark:` variants (`dark:bg-nature-900`, `dark:border-nature-800`, `dark:text-white`, `dark:text-nature-400`).
