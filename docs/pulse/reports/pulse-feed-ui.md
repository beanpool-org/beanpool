# Package 03 — The Feed UI (pulse-feed-ui)

PR: #(pending submission)
Status: complete

## Built

### 1. Pulse Feed Client & Fixture Layer (`apps/native/utils/pulse.ts`)
- Implemented Contract B consumer interfaces: `PulseFeedItem`, `PulseFeedResponse`, `FetchPulseFeedOptions`.
- `fetchPulseFeed(options)`:
  - Fetches `GET /api/pulse/feed` with `cursor`, `category`, and `limit` query parameters from the active community anchor node.
  - Automatically falls back to built-in local fixture (`PULSE_FIXTURE_ITEMS`) when running offline or against nodes where live syndication has not yet populated items.
- `mutePulseItem(itemId, muted, identity)`:
  - Performs signed `POST /api/member/pulse/items/:id/mute` via `signedPost` authenticated by `identity`.
- `formatRelativeTime(dateString)`:
  - Human-friendly relative timestamp formatter ("Just now", "25m ago", "3h ago", "2d ago", "Aug 24").
- `PULSE_FIXTURE_ITEMS`:
  - Built-in multi-platform fixture items (YouTube, RSS, Instagram, Website) across categories (`craft`, `food`, `repair`, `art`, `community`).

### 2. Facade Presentation Card Component (`apps/native/components/PulseFeedCard.tsx`)
- **Facade Architecture**: Renders static 16:9 thumbnail posters with play badge overlays for video platforms (`youtube`, `tiktok`, `instagram`). No embedded iframes or video stream proxies (preserving member privacy and complying with platform terms & CSP restrictions).
- **Attribution First**: Displays author avatar (`MemberAvatar`), callsign, verified badge (`✓`), platform badge (`platformMeta`), and category badge (`categoryMeta`). Tapping the author navigates to `/public-profile`.
- **Safe External Navigation**: Tapping card opens the canonical post URL in device browser/app via `Linking.openURL`, strictly validated via `isWebUrl` before opening.
- **Owner Muting**: When viewed by the item's owner (`ownerPubkey === currentPubkey`), renders a "Mute" button with confirmation alert triggering optimistic removal.
- **Accessibility & Responsive**: Accessible roles and labels, min 44dp touch targets, reflowing cleanly at 320dp and 1.3× font scale.

### 3. Community Feed Screen & Navigation (`apps/native/app/pulse.tsx`)
- **Category Filter Tabs**: Horizontal scrollable category selector ("All" + `CATEGORIES` from `@beanpool/core`), resetting pagination on category change.
- **Cursor Pagination & Infinite Scroll**: `FlatList` with `onEndReached` pagination using Contract B's cursor.
- **Pull to Refresh**: `RefreshControl` with light haptic feedback.
- **Honest Empty States**:
  - Global empty state explains channel syndication and provides direct button to `+ Connect your channels` (`/channels`).
  - Filtered empty state prompts member to check other categories.
- **Actionable Error State**: Inline error alert with "Retry" action.
- **Navigation Integration**:
  - Registered `pulse` and `channels` in `apps/native/app/_layout.tsx`.
  - Added "The Pulse" menu entry (`🗞️`) in `apps/native/app/(tabs)/settings.tsx`.
  - Added "View Feed ↗" shortcut in `apps/native/app/channels.tsx` header.

### 4. Unit Tests (`apps/native/utils/__tests__/pulse.test.ts`)
- 18 unit tests covering relative date formatting, fixture sorting, category filtering, cursor pagination, live fetch parameter encoding, offline fallback handling, and signed owner muting.

---

## Verified

### 1. Vitest Unit Test Suites (`pnpm --filter beanpool-pillar test`)
```
> beanpool-pillar@1.2.5 test /Users/marty/.gemini/antigravity/worktrees/beanpool/implement_pulse_feed_ui/apps/native
> vitest run

 RUN  v3.2.7 /Users/marty/.gemini/antigravity/worktrees/beanpool/implement_pulse_feed_ui/apps/native

 ✓ utils/__tests__/pulse.test.ts (18 tests) 16ms
 ✓ utils/__tests__/channels.test.ts (8 tests) 3ms
 ✓ utils/__tests__/node-url.test.ts (13 tests) 3ms
 ✓ utils/__tests__/local-auth.test.ts (6 tests) 4ms
 ✓ utils/__tests__/pin.test.ts (17 tests) 5ms
 ✓ utils/__tests__/protection-state.test.ts (15 tests) 9ms
 ✓ utils/__tests__/apply-delta.test.ts (4 tests) 11ms
 ✓ utils/__tests__/pillar-sync.test.ts (5 tests) 11ms
 ✓ utils/__tests__/friend-recovery.test.ts (2 tests) 38ms
 ✓ utils/__tests__/sso-recovery.test.ts (4 tests) 131ms
 ✓ utils/__tests__/keeper-enrolment.test.ts (16 tests) 157ms
 ✓ utils/__tests__/sso-signin.test.ts (23 tests) 367ms

 Test Files  12 passed (12)
      Tests  122 passed (122)
   Start at  21:52:18
   Duration  741ms (transform 599ms, setup 0ms, collect 1.84s, tests 737ms, environment 1ms, prepare 510ms)
```

### 2. TypeScript Clean Typechecks (`tsc --noEmit`)
```bash
$ pnpm --filter @beanpool/core build && pnpm --filter @beanpool/engine build
> @beanpool/core@1.2.5 build
> tsc

> @beanpool/engine@1.2.0 build
> tsc

$ pnpm --filter beanpool-pillar exec tsc --noEmit
(Clean compilation, 0 errors)

$ pnpm --filter @beanpool/server exec tsc --noEmit
(Clean compilation, 0 errors)
```

### 3. Server Feed Contract B Suite (`test-pulse-resolver.ts`)
```
=== Pulse Resolver & Cache Test Suite ===
...
--- 7. Feed Queries & Visibility ---
✓ Feed returns 3 active, non-muted items across members
✓ Feed ordered by published_at DESC
✓ Category filter returns only craft items
✓ Found 2 craft items
✓ Page 1 limit 2 returns 2 items
✓ Page 1 returns nextCursor
✓ Page 2 returns remaining 1 item
✓ Page 2 item is item_1
✓ All 5 same-timestamp items paginated (saw 5/5)
✓ Pagination terminated rather than looping
✓ NULL-dated item is reachable through pagination
✓ Cursor round-trips the id
✓ NULL published_at encodes as an empty sort key
✓ Timestamp-only cursor decodes with a null id
✓ Suspended member items hidden from feed
✓ De-syndicated channel items hidden from feed

--- 8. Item Muting ---
✓ Marty muted item_m1
✓ Muted item hidden from feed
✓ Kayla cannot mute Marty item
✓ Non-existent item gets NOT_FOUND
✓ Deleted/tombstoned item gets NOT_FOUND
✓ Unmuted item reappears on feed
✓ Channel deletion cascaded tombstone to all channel pulse_items

Results: 109/109 tests passed.
```

---

## Not done
- **Native on-device visual rendering verification**: Requires a standalone mobile binary build (`needs a build to verify on device`).
- **Untested against a live production feed**: The feed client has been tested against Contract B endpoints and fixture data; live external RSS/YouTube ingestion testing is pending Package 02 deployment to live nodes.

---

## Assumptions a reviewer must confirm
- **Facade Cards**: Tapping a feed card opens the post externally on its native platform (YouTube, web browser, etc.) via `Linking.openURL` guarded by `isWebUrl()` rather than mounting webviews or embedding media players.
- **Fixture Fallback**: When connecting to a node that has no syndicated items yet or returns 404, the feed seamlessly provides the built-in fixture so the UI remains previewable and testable.
- **Owner-Scoped Muting**: Per Contract B, only the owner can mute their own items (`ownerPubkey === identity.publicKey`).

---

## Found but out of scope
- `apps/manager/src/lib/ai-client.test.ts` fails locally due to vitest JSDOM environment config (owned by Package 04 per `CONTRACTS.md`).
