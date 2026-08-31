# Package 05 — Manual Ingestion (pulse-manual-ingest)

PR: #550
Status: complete

## Built

### 1. Manual Ingestion Client Screen (`apps/native/app/pulse-intake.tsx`)
- Intake screen for manual Pulse post ingestion.
- Pre-fills from route params (`url` from clipboard nudge / share intents, `channelId` from channel selections / post-count nudges).
- URL input configured with `autoCapitalize="none" autoCorrect={false} spellCheck={false} keyboardType="url"`.
- Live input whitespace stripping on typing (`text.replace(/\s+/g, '')`).
- Paste button supporting direct insertion from `Clipboard.getStringAsync()`.
- Channel picker chips auto-detecting matching platform/channel and allowing selection from member's connected channels.
- Category picker chips defaulting to channel category and selectable across the taxonomy.
- Debounced live resolution against `POST /api/member/pulse/preview` rendering a facade preview card.
- Deduplication indicator when post is already imported on the feed.
- Review list with deliberate per-item opt-out confirmation toggle ("Publish to Pulse").
- Signed mutation submission via `POST /api/member/pulse/submit`.
- Inline error reporting positioned directly below the failed controls (URL input, submit button).
- Responsive layout adhering to native rules (320dp width and 1.3× font scale resilience, `KeyboardAvoidingView` from `react-native-keyboard-controller`, `SafeAreaView` from `react-native-safe-area-context`, flexGrow/flexBasis).

### 2. Pulse Nudge Components (`apps/native/components/PulseNudges.tsx`)
- **Clipboard Nudge**:
  - Non-intrusively inspects `Clipboard.getStringAsync()` on mount / app resume without interrupting boot.
  - Matches URLs against member's connected channels (Instagram, TikTok, YouTube, Facebook, Website/RSS).
  - Uses `AsyncStorage` (`pulse_seen_clip_${url}`) to offer adding **once per URL**, never repeatedly.
  - Non-intrusive banner offering "Add to Pulse" (navigating to `/pulse-intake?url=...`) and "Dismiss".
- **Post-Count Nudge**:
  - Compares channel's current post count against `post_count_seen`.
  - Displays "You've posted N new things on <Platform>" notice.
  - "Share" button directs to `/pulse-intake?channelId=...`.
  - "Dismiss" button fires signed `POST /api/member/pulse/channels/:id/dismiss-nudge`, advancing the watermark so it goes quiet.

### 3. Facade Preview Card Component (`apps/native/components/PulsePreviewCard.tsx`)
- Facade card for previewing post before submit.
- Thumbnail rendering with image error fallbacks.
- Multi-line reflowing title with 1.3× font scale headroom.
- Platform badge, category tag, and author callsign via `@beanpool/core`.
- Duplicate notice banner and review opt-in/opt-out toggle switch.

### 4. Server Endpoints & Ingestion Pipeline (`apps/server/src/routes/pulse-submit.ts` & `https-server.ts`)
- `POST /api/member/pulse/preview`:
  - Signed request validation via `ctx.state.actor`.
  - Platform detection and external ID extraction (`identifyPlatformAndExternalId`).
  - SSRF-hardened live resolution (`resolveMetadata`) for YouTube (oEmbed & fallback thumbnails), TikTok (oEmbed), Instagram (OpenGraph HTML extraction), and Web/RSS.
  - Matches against member's owned channels (`matchOwnedChannel`). Refuses other member channels (403 `NOT_YOURS`).
  - In-flight deduplication check against active `pulse_items`.
- `POST /api/member/pulse/submit`:
  - Signed mutation scoped to `ctx.state.actor`.
  - Validates channel ownership (403 `NOT_YOURS`).
  - Deduplicates on `(channel_id, external_id)` and `(channel_id, url)`.
  - Inserts new row with `source = 'manual'`, `muted = 0`, and restores tombstoned rows if re-submitted.
- `POST /api/member/pulse/channels/:id/dismiss-nudge`:
  - Signed mutation advancing `creator_channels.post_count_seen`.
- `POST /api/member/pulse/items/:id/delete`:
  - Owner-scoped item tombstoning via `scrubPulseItems`.
- `POST /api/member/pulse/nudges`:
  - Lists channels where latest probed count exceeds `post_count_seen`.
- Mounted router in `apps/server/src/https-server.ts`.

### 5. Navigation Entry Points & Wiring
- `apps/native/app/channels.tsx`: Integrated `<PulseNudges />`, added "+ Share post" on manual channels, and bottom "Share a post to Pulse" link.
- `apps/native/app/(tabs)/settings.tsx`: Added "Share to Pulse" menu button.
- `apps/native/app/_layout.tsx`: Registered `pulse-intake` modal screen.

---

## Verified

### 1. Native TypeScript Typecheck (`apps/native`)
```
$ pnpm --filter beanpool-pillar exec tsc --noEmit
(exited with 0 errors)
```

### 2. Server TypeScript Typecheck (`apps/server`)
```
$ pnpm --filter @beanpool/server exec tsc --noEmit
(exited with 0 errors)
```

### 3. Server Suite Registration Check (`scripts/check-suite-registration.sh`)
```
$ bash scripts/check-suite-registration.sh
✓ all 81 server suites in apps/server/src are registered in scripts/test-all.sh
```

### 4. Manual Ingestion Test Suite (`apps/server/src/test-pulse-submit.ts`)
```
$ ENABLE_PEER_CONNECTORS=true pnpm --filter @beanpool/server exec tsx src/test-pulse-submit.ts
=== Manual Ingestion (Pulse Submit) Test Suite ===

🏛️ Restored Commons Pool balance: 0.00
✅ [LedgerAudit] OK — sum(balances)=0.0000, drift=0.0000
📒 SQLite DB initialized: 5 members, 0 posts
--- 0. URL Identification & ID Extraction ---
✓ Instagram post platform detected
✓ Instagram post external ID extracted
✓ Instagram reel platform detected
✓ Instagram reel external ID extracted
✓ TikTok video platform detected
✓ TikTok video external ID extracted
✓ TikTok account handle extracted
✓ YouTube watch platform detected
✓ YouTube video ID extracted
✓ Generic website platform detected

--- 1. Authentication & Ownership Gating ---
✓ Unsigned preview request rejected with 401
✓ Unsigned submit request rejected with 401
✓ Member with no channels cannot preview (403)
✓ Member with no channels cannot submit (403)
✓ Member cannot submit to another member channelId (403 NOT_YOURS)
✓ Member cannot preview another member channelId (403 NOT_YOURS)

--- 2. Unmatched URL Refusal ---
✓ URL with no matching owned platform channel is refused (403)
✓ TikTok URL refused when member has no TikTok channel (403)
✓ TikTok URL belonging to a stranger is refused (403)

--- 3. Preview Endpoint ---
✓ Preview endpoint returns 200 for valid owned channel URL
✓ Preview response has success: true
✓ Platform detected as youtube
✓ Video ID extracted as externalId
✓ Mapped to Kayla YouTube channel
✓ alreadyImported is false before submit
✓ Thumbnail URL extracted

--- 4. Submission & Deduplication ---
✓ First submit returns 200
✓ First submit returns success: true
✓ First submit returns deduplicated: false
✓ Generated valid pulse item id
✓ Title matches submission
✓ Source is set to manual
✓ Owner matches actor pubkey
✓ publishedAt is populated
✓ Preview detects item is alreadyImported
✓ Preview returns existingItemId
✓ Second submit returns 200
✓ Second submit returns deduplicated: true
✓ Deduplicated submission returns the exact same item id
✓ Deduplicated submit updates title
✓ Database contains exactly 1 row for the deduplicated post

--- 5. Watermark Dismissal (dismiss-nudge) ---
✓ dismiss-nudge returns 200
✓ dismiss-nudge returns success: true
✓ dismiss-nudge returned postCountSeen: 15
✓ creator_channels.post_count_seen updated in DB to 15
✓ Non-owner cannot dismiss nudge on channel (403 NOT_YOURS)
✓ dismiss-nudge on non-existent channel returns 404

--- 6. SSRF Protection ---
✓ Preview blocked SSRF target: http://127.0.0.1:8080/admin
✓ Submit blocked SSRF target: http://127.0.0.1:8080/admin
✓ Preview blocked SSRF target: http://localhost:3000/
✓ Submit blocked SSRF target: http://localhost:3000/
✓ Preview blocked SSRF target: http://169.254.169.254/latest/meta-data/
✓ Submit blocked SSRF target: http://169.254.169.254/latest/meta-data/
✓ Preview blocked SSRF target: http://10.0.0.1/internal
✓ Submit blocked SSRF target: http://10.0.0.1/internal
✓ Preview blocked SSRF target: http://192.168.1.1/router
✓ Submit blocked SSRF target: http://192.168.1.1/router
✓ Preview blocked SSRF target: http://[::1]/
✓ Submit blocked SSRF target: http://[::1]/
✓ Preview blocked SSRF target: http://metadata.google.internal/computeMetadata/v1/
✓ Submit blocked SSRF target: http://metadata.google.internal/computeMetadata/v1/

--- 7. Item Deletion via scrubPulseItems ---
✓ Non-owner cannot delete item (403 NOT_YOURS)
✓ Owner item delete returns 200
✓ Delete returns success: true
✓ Tombstoned item has deleted_at set
✓ Tombstoned item has url NULLed
✓ Tombstoned item has title NULLed
✓ Tombstoned item has thumbnail_url NULLed
✓ Deleting already deleted item returns 404

--- 8. Resubmission of Tombstoned Row ---
✓ Resubmitting deleted item returns 200
✓ Resubmit returns success: true
✓ Resubmit returns deduplicated: false (restored)
✓ Resubmitted item reuses the original row id
✓ Restored item title is updated
✓ Restored item url is restored from NULL
✓ Restored DB row has deleted_at set back to NULL
✓ Restored DB row has content populated

--- 9. Nudges Endpoint ---
✓ Nudges endpoint returns 200
✓ Nudges response contains nudges array

Results: 79/79 tests passed.
```

### 5. Pulse Resolver & Creator Channels Verification
```
$ ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm --filter @beanpool/server exec tsx src/test-pulse-resolver.ts
Results: 109/109 tests passed.

$ ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm --filter @beanpool/server exec tsx src/test-creator-channels.ts
127/127 passed
```

---

## Not done
- Native on-device visual testing across physical devices: A native change cannot be tested end-to-end without a standalone rebuild. Verification on device will confirm keyboard avoidance feel and haptics.
- Automated OAuth ingestion (Phase 5): Out of scope for Package 05 (manual ingestion only).

---

## Assumptions a reviewer must confirm
- Watermark dismissal on manual ingestion sets `post_count_seen` to latest probed or provided count, silencing notifications until fresh posts appear.
- Deduplicated items re-submitted by the member update the title/category and return the existing ID rather than creating duplicate feed cards.

---

## Found but out of scope
- `apps/manager/src/lib/ai-client.test.ts` fails in local node environment without jsdom localstorage bridging (addressed by Package 04).

---

## Review round (2026-08-31)

### What was found
A technical code review on PR #550 yielded 17 inline comments across server route handlers and native client components:
1. **Server Platform Mismatch on Explicit Channel ID**: `matchOwnedChannel` did not verify platform compatibility when `requestedChannelId` was explicitly provided.
2. **Website/RSS Domain Gating**: Fallback for `website`/`rss` channels allowed unowned hostnames if no hostname match occurred.
3. **Left Join Resilience**: `rowToPulseFeedCard` used `INNER JOIN` instead of `LEFT JOIN`, risking item lookup failures if channel/member records were transiently altered.
4. **Index-Optimized Deduplication Query**: Deduplication query in `preview` used an `OR` construct instead of branching on `external_id` / `url` against partial index `idx_pulse_items_dedupe`.
5. **Custom Overrides Validation**: `customTitle` and `customThumbnailUrl` in submit route lacked XML sanitization, length bounds, and URL scheme validation.
6. **SQLite Statement Compilation**: Prepared statements in `better-sqlite3` were compiled inside transaction closures and request loops rather than at router scope.
7. **Sequential Probing in Nudges**: `POST /api/member/pulse/nudges` probed member channels sequentially with `await` in a `for` loop.
8. **Watermark Regression & Safe Integer**: `dismiss-nudge` did not enforce `Number.isSafeInteger` and could regress watermarks if a lower count was passed.
9. **Watermark Update Statement**: Prepared statement for watermark initialization in `/nudges` was inside the channel iteration loop.
10. **Native URI Decoding Safety**: `decodeURIComponent(params.url)` could crash on malformed percent encoding without `try/catch`.
11. **Native URL Ref Tracking & Debounce Cleanup**: Chip selection re-triggered preview fetching due to dependency on `urlInput`, and debounce timers were not cleaned up on unmount.
12. **Native Thumbnail Error Reset**: `PulsePreviewCard` did not reset `imageError` state when `preview.thumbnailUrl` changed.
13. **YouTube Shorts Clipboard Support**: Clipboard platform matcher in `PulseNudges` lacked `youtube.com/shorts/`.
14. **Native HitSlop & Accessibility**: `Paste` button lacked `hitSlop` and accessible attributes.
15. **Native Chip Semantics**: Channel and category chips lacked `accessibilityRole="radio"` and `accessibilityState={{ selected: isSelected }}`.
16. **Nudge Dismiss Accessibility**: Close buttons (`✕`) in `PulseNudges` lacked `accessibilityRole="button"` and `hitSlop`.
17. **Review Toggle Touch Target**: Review toggle row was not wrapped in an accessible `Pressable`, making only the switch itself tappable.

### What was changed
- **`apps/server/src/routes/pulse-submit.ts`**:
  - Added platform compatibility verification when `requestedChannelId` is provided, throwing `PulseError('NO_CHANNEL_MATCH')` if incompatible.
  - Enforced hostname verification for `website`/`rss` channels in `matchOwnedChannel`, throwing `PulseError('NOT_YOURS')` on domain mismatch.
  - Converted `rowToPulseFeedCard` joins to `LEFT JOIN` on `creator_channels` and `members`.
  - Prepared statements at router scope (`stmtFindActiveByExternalId`, `stmtFindExistingByExternalId`, `stmtRestoreItem`, `stmtUpdateActiveItem`, `stmtInsertItem`, `stmtUpdateChannelWatermark`, etc.).
  - Added `cleanXmlText` sanitization and 500-char truncation on `customTitle`; validated `customThumbnailUrl` (`https?://`, max 2048 chars).
  - Refactored `/nudges` to probe channels concurrently via `Promise.all`.
  - Validated `Number.isSafeInteger(seenCount) && seenCount >= 0` and guarded against watermark regression with `Math.max(channel.post_count_seen ?? 0, seenCount)`.
- **`apps/native/app/pulse-intake.tsx`**:
  - Implemented `safeDecodeURIComponent` with `try/catch`.
  - Added `lastResolvedUrlRef` to decouple chip changes from URL preview re-resolution.
  - Added unmount cleanup for `debounceTimerRef`.
  - Added `hitSlop` and accessible labels to `Paste` button; updated chips to `accessibilityRole="radio"` with `accessibilityState={{ selected: isSelected }}`.
- **`apps/native/components/PulsePreviewCard.tsx`**:
  - Added `useEffect` hook resetting `imageError` whenever `preview.thumbnailUrl` changes.
  - Wrapped review toggle row in accessible `Pressable` with `accessibilityRole="switch"` and `accessibilityState={{ checked: isOptedIn }}`.
- **`apps/native/components/PulseNudges.tsx`**:
  - Added `youtube.com/shorts/` platform matching.
  - Added `accessibilityRole="button"` and `hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}` to dismiss buttons.
- **`apps/server/src/test-pulse-submit.ts`**:
  - Added regression test suite for explicit `channelId` platform mismatch, foreign website domain rejection, custom thumbnail URL scheme validation, and watermark non-regression (87/87 tests passed).

### What was learned
- SQLite prepared statements with `better-sqlite3` must be prepared at router initialization time outside transaction closures and loops; explicit channel ID selection must strictly validate platform compatibility before trusting the selection.
- Native interactive chips functioning as mutually exclusive selectors should always carry `accessibilityRole="radio"` and `accessibilityState={{ selected: isSelected }}` for complete accessibility compliance.

---

## Crash fix

PR: #563

### Root Cause
Opening the manual ingestion screen (route `/pulse-intake`) crashed immediately on mount with the error boundary displaying:
`"Something went wrong — Error: Cannot read property 'default' of undefined"`

The error boundary swallowed the stack trace on standalone production builds, presenting only the exception message. The underlying cause was:
1. `apps/native/app/pulse-intake.tsx` referenced `colors.background.default` in `makeStyles`, but `ThemeContext` / `colors.ts` defines `colors.surface.app` and `colors.surface.card` (no `background` namespace exists in the semantic color system). Evaluating `colors.background.default` at style creation time resulted in reading `.default` off `undefined`.
2. Several other style declarations in `pulse-intake.tsx`, `PulsePreviewCard.tsx`, and `PulseNudges.tsx` referenced undefined tokens (`colors.text.primary` instead of `colors.text.heading` and `colors.status.error` instead of `colors.feedback.danger.solid` / `colors.feedback.danger.fg`) because `makeStyles` used untyped `{ colors: any }` arguments.

### Changes
1. **`apps/native/app/pulse-intake.tsx`**:
   - Replaced `colors.background.default` with `colors.surface.app`.
   - Replaced `colors.text.primary` with `colors.text.heading`.
   - Replaced `colors.status.error` with `colors.feedback.danger.solid` (borders) and `colors.feedback.danger.fg` (text).
   - Typed `makeStyles` strictly with `{ colors: typeof lightColors; theme: string }` and exported it.
2. **`apps/native/components/PulsePreviewCard.tsx`**:
   - Replaced `colors.text.primary` with `colors.text.heading`.
   - Typed `makeStyles` strictly with `{ colors: typeof lightColors; theme: string }` and exported it.
3. **`apps/native/components/PulseNudges.tsx`**:
   - Replaced `colors.text.primary` with `colors.text.heading`.
   - Typed `makeStyles` strictly with `{ colors: typeof lightColors; theme: string }` and exported it.
4. **`apps/native/utils/__tests__/pulse-intake.test.ts`**:
   - Added unit test suite verifying `safeDecodeURIComponent` and evaluating `makeStyles` across all palettes (`classic`, `earth`, `slate`, and `dark`), ensuring no undefined tokens or style creation exceptions occur.

### Verification
- `pnpm --filter beanpool-pillar exec tsc --noEmit` exited with 0 errors.
- `apps/native` vitest suite passed (13 test files, 141 tests).
- `bash scripts/test-all.sh --all` passed (all 8 checks: build, lint, test, typecheck, suite_registration, deploy_preserve, secrets_guard, federation).


