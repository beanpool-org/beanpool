# Profile chips — pulse-profile-chips

PR: #101
Status: complete

## Built
- Extracted creator channel platform taxonomy and metadata from `apps/native/app/channels.tsx` into shared `@beanpool/core` (`packages/beanpool-core/src/channels.ts`).
- Shared exports: `PLATFORMS`, `CATEGORIES`, `LISTING_LABEL`, `VIDEO_PLATFORMS`, `platformMeta`, `categoryMeta`, and `PublicCreatorChannel` type.
- Enforced safe fallbacks: `platformMeta` falls back to `{ icon: '🔗', label: 'Link', listing: 'card' }` (never `PLATFORMS[0]`); `categoryMeta` falls back to `{ icon: '✨', label: 'Other' }` (never `CATEGORIES[0]`).
- Native channel chip component (`apps/native/components/ChannelChips.tsx`):
  - Renders syndicated creator channels as link chips with platform icon, label, handle, and verified badge.
  - Distinct verification badge (`✓`) rendered only when `channel.isVerified` is true (`oauth_verified_at` set).
  - Tapping opens the external URL via `Linking.openURL` guarded against invalid schemes.
  - Renders `null` when channels list is empty or absent (no empty state, no add prompts).
  - Responsive flexWrap layout preventing horizontal scrolling/clipping at 320dp and 1.3× font scale.
- Native public profile integration (`apps/native/app/public-profile.tsx`):
  - Fetches syndicated channels via `fetchPublicChannels(pubkey)` (`apps/native/utils/channels.ts`) calling `GET /api/members/:publicKey/channels`.
  - Integrates `<ChannelChips />` in the profile banner.
- PWA channel chip component (`apps/pwa/src/components/ChannelChips.tsx`):
  - Renders wrapping external links (`<a>` tags with `target="_blank" rel="noopener noreferrer"`).
  - Displays platform icon, label, handle, and verified badge.
  - Returns `null` when channels list is empty.
- PWA public profile integration (`apps/pwa/src/pages/PublicProfilePage.tsx` and `apps/pwa/src/lib/api.ts`):
  - Added `getPublicChannels` API helper.
  - Integrated `<ChannelChips />` into `PublicProfilePage.tsx` banner.
- Unit tests added:
  - `packages/beanpool-core/src/__tests__/channels.test.ts` (platform and category resolution & fallback guards).
  - `apps/native/utils/__tests__/channels.test.ts` (native fetching and metadata resolution).
  - `apps/pwa/src/lib/channels.test.ts` (PWA API client integration).

## Verified
```bash
$ pnpm --filter @beanpool/core test && pnpm --filter beanpool-pillar test && pnpm --filter @beanpool/pwa test

> @beanpool/core@1.2.5 test /Users/marty/.gemini/antigravity/worktrees/beanpool/implement_pulse_profile_chips/packages/beanpool-core
> vitest run

 RUN  v3.2.7 /Users/marty/.gemini/antigravity/worktrees/beanpool/implement_pulse_profile_chips/packages/beanpool-core

 ✓ src/__tests__/pricing-catalog.test.ts (5 tests) 6ms
 ✓ src/__tests__/reach.test.ts (10 tests) 5ms
 ✓ src/__tests__/channels.test.ts (4 tests) 2ms
 ✓ src/__tests__/ed25519-key.test.ts (12 tests) 9ms
 ✓ src/__tests__/ledger.test.ts (10 tests) 21ms
 ✓ src/__tests__/merkle.test.ts (2 tests) 8ms
 ✓ src/__tests__/pairing-crypto.test.ts (4 tests) 15ms
 ✓ src/__tests__/two-layer-split.test.ts (48 tests) 13ms
 ✓ src/__tests__/recovery-split.test.ts (31 tests) 10ms
 ✓ src/__tests__/recovery-self-check.test.ts (20 tests) 49ms
 ✓ src/__tests__/crypto.test.ts (2 tests) 6ms
 ✓ src/__tests__/keeper-crypto.test.ts (45 tests) 583ms

 Test Files  12 passed (12)
      Tests  193 passed (193)
   Duration  862ms

> beanpool-pillar@1.2.5 test /Users/marty/.gemini/antigravity/worktrees/beanpool/implement_pulse_profile_chips/apps/native
> vitest run

 RUN  v3.2.7 /Users/marty/.gemini/antigravity/worktrees/beanpool/implement_pulse_profile_chips/apps/native

 ✓ utils/__tests__/channels.test.ts (8 tests) 4ms
 ✓ utils/__tests__/node-url.test.ts (13 tests) 3ms
 ✓ utils/__tests__/local-auth.test.ts (6 tests) 4ms
 ✓ utils/__tests__/pin.test.ts (17 tests) 5ms
 ✓ utils/__tests__/protection-state.test.ts (15 tests) 8ms
 ✓ utils/__tests__/apply-delta.test.ts (4 tests) 10ms
 ✓ utils/__tests__/pillar-sync.test.ts (5 tests) 12ms
 ✓ utils/__tests__/friend-recovery.test.ts (2 tests) 39ms
 ✓ utils/__tests__/sso-recovery.test.ts (4 tests) 128ms
 ✓ utils/__tests__/keeper-enrolment.test.ts (16 tests) 153ms
 ✓ utils/__tests__/sso-signin.test.ts (23 tests) 474ms

 Test Files  11 passed (11)
      Tests  104 passed (104)
   Duration  855ms

> @beanpool/pwa@1.2.5 test /Users/marty/.gemini/antigravity/worktrees/beanpool/implement_pulse_profile_chips/apps/pwa
> vitest run

 RUN  v3.2.7 /Users/marty/.gemini/antigravity/worktrees/beanpool/implement_pulse_profile_chips/apps/pwa

 ✓ src/lib/smoke.test.ts (2 tests) 1ms
 ✓ src/lib/channels.test.ts (3 tests) 2ms

 Test Files  2 passed (2)
      Tests  5 passed (5)
   Duration  531ms
```

```bash
$ pnpm --filter @beanpool/server exec tsc --noEmit && pnpm --filter beanpool-pillar typecheck && pnpm --filter @beanpool/pwa build
(Clean compilation, 0 errors)
```

```bash
$ BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx apps/server/src/test-creator-channels.ts
127/127 passed
```

## Not done
- Native on-device visual rendering verification requires a standalone mobile binary build; unit tests and mock verifications pass locally.

## Assumptions a reviewer must confirm
- Extracted vocabulary placed in `@beanpool/core/src/channels.ts` so both `@beanpool/pwa` and `beanpool-pillar` (and future packages) share a single canonical source of truth.
- Chip position on the public profile placed in the profile banner directly under the bio.

## Found but out of scope
- `apps/manager/src/lib/ai-client.test.ts` has a known pre-existing failure in the local Vitest runner (missing jsdom environment configuration); owned by Package 04 per `CONTRACTS.md`.

---

## Director's review round (appended after review, 2026-08-31)

Three findings, all real, all fixed on this branch.

1. The PWA chip interpolated `channel.url` straight into `href` with `|| '#'` as the fallback — a
   `javascript:` or `data:` scheme reaching that column would have executed on click, and `'#'`
   scrolls the router and opens a blank tab under `target="_blank"`. Only `http(s)` becomes an
   `<a>` now; anything else renders as an inert `<span>`.
2. & 3. Neither profile screen cleared `channels` before fetching, so tapping from one member to
   another showed the previous member's chips until the request landed. Both now clear on entry
   **and** drop a reply that arrives after navigation — the reset alone still lets a slow first
   request overwrite a fast second one.

The URL guard became `isWebUrl()` in `@beanpool/core` rather than a regex per client: native
already had its own copy, so the rule existed in two places before either was right. Same
principle as the platform vocabulary this package extracted.

**Assumptions above, now resolved:** both were accepted as-is — the shared module stays in
`@beanpool/core`, and the chips stay in the profile banner under the bio.

**Still not done:** no on-device verification. This changes what strangers see on a profile, and
it needs a standalone build to check — a dev client will not exercise it.
