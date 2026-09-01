# Package 05 — OAuth Upgrade Path (pulse-oauth)

Status: complete

## Built

### 1. Device-Side Token Storage & Fetch Service (`apps/native/utils/pulse-oauth.ts`)
- Device-side credential management using `expo-secure-store` (and `localStorage` for Web):
  - `getStoredOAuthToken(channelId)`: Reads credentials securely stored under `pulse_oauth_token_${channelId}`.
  - `saveStoredOAuthToken(token)`: Saves tokens exclusively to local hardware-backed keystore.
  - `deleteStoredOAuthToken(channelId)`: Clears local credentials upon disconnect.
  - **Inviolable constraint preserved:** The node NEVER receives, holds, or proxies platform access tokens or refresh tokens. There is no token column in `creator_channels`.
- **TikTok Login Kit v2 + Display API Integration:**
  - PKCE pair generation (`generatePkcePair`) using `expo-crypto` and `sha256` from `@noble/hashes/sha2.js`.
  - Authorization endpoint `https://www.tiktok.com/v2/auth/authorize/` with `scope=user.info.basic,video.list`.
  - Device-side token exchange via `POST https://open.tiktokapis.com/v2/oauth/token/` with PKCE `code_verifier`.
  - User identity lookup via `GET https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name,username`.
  - Content fetching via `POST https://open.tiktokapis.com/v2/video/list/?fields=id,title,video_description,duration,cover_image_url,share_url,create_time`.
  - Token refresh management (`refreshTokenIfNeeded`) automatically refreshing expiring access tokens using stored refresh tokens.
- **Instagram Creator Connector Abstraction:**
  - Symmetrically designed under the identical interface (`connectInstagramChannel`).
  - Gated behind node/client configuration `INSTAGRAM_APP_ID`.
  - **Critical Rule:** Never reuses SSO Meta App ID `818892721251369`.
  - Uses `Creator` (never 'Business') across all member-facing copy.
  - Dark until configured, ready for Meta App Review approval without architectural rewrites.

### 2. Android App Links & Custom Tab Interception Mitigation (`apps/native/`)
- Investigated Android OAuth redirect behaviour with native platform apps installed:
  - On Android, installed apps (such as TikTok or Facebook) and verified App Links for `beanpool.org` can intercept OAuth redirects, backgrounding or dismissing the Custom Tab and triggering a false `cancel` on `WebBrowser.openAuthSessionAsync`.
  - Mitigated via a multi-source callback race (`openAuthSessionWithFallback`) matching against session CSRF `state`:
    1. `WebBrowser.openAuthSessionAsync` promise resolution.
    2. `Linking.addEventListener('url')` native deep link listener.
    3. `DeviceEventEmitter.addListener('SSO_AUTH_CALLBACK')` broadcast from `+native-intent.ts`.
- Dedicated deep-link callback screens:
  - `apps/native/app/auth/tiktok.tsx`
  - `apps/native/app/auth/instagram.tsx`
  - Both catch WebBrowser and App Link callbacks, emit `SSO_AUTH_CALLBACK`, and safely navigate back.
- Updated `apps/native/app/+native-intent.ts` to intercept `auth/tiktok` and `auth/instagram` before route resolution.

### 3. Native Channels Screen Integration (`apps/native/app/channels.tsx`)
- Dynamic OAuth configuration discovery via `fetchPulseOAuthConfig` on screen load.
- Channel card status presentation:
  - **Connected & Verified Channels (`oauthVerifiedAt` populated):**
    - Displays `✓ Verified` badge in card top bar.
    - Displays `Updates itself (connected)` in channel metadata.
    - Provides `↻ Sync videos` button to trigger on-demand sync from platform Display API.
    - Provides `Disconnect` button with confirmation modal explaining fallback to manual sharing.
  - **Unconnected Channels:**
    - If platform OAuth is enabled on node: displays `Connect <Platform>` button with loading state.
    - If platform OAuth is not configured: gracefully hides the connect affordance without error, offering standard manual post sharing.
- Per-card error display (`cardErrors[channel.id]`): Errors appear directly next to the failed control rather than at the top of a scrolled screen.
- Layout resilience: Form elements and action buttons wrap with `flexWrap: 'wrap', gap: 8`, touch targets >= 44dp, resilient to 320dp width and 1.3× font scale.

### 4. Server Endpoints & Ingestion Pipeline (`apps/server/src/routes/` & `engine/`)
- `POST /api/member/channels/:id/verify-oauth`:
  - Enforces signed request with `ctx.state.actor`.
  - Verifies channel belongs to actor and is active (`deleted_at IS NULL`).
  - Verifies platform match and performs case-insensitive account handle match (`cleanUsername === cleanHandle` or URL substring match).
  - Rejects mismatched accounts with 400 `ACCOUNT_MISMATCH`.
  - Sets `oauth_verified_at = now()` and `supports_autolist = 1` in `creator_channels`.
- `POST /api/member/channels/:id/disconnect-oauth`:
  - Enforces signed request with `ctx.state.actor`.
  - Clears `oauth_verified_at = NULL` and resets `supports_autolist` to platform native capability.
  - Preserves all previously ingested `pulse_items` rows in place.
- `POST /api/member/pulse/oauth-ingest`:
  - Accepts batch payload `{ channelId, items: Array<{ url, title, thumbnailUrl, publishedAt, externalId, category }> }`.
  - Enforces signed request and verifies channel ownership.
  - Reuses Phase 4 deduplication: matches against `(channel_id, external_id)` and `(channel_id, url)`.
  - Updates existing active items, restores tombstoned rows (`deleted_at = NULL, source = 'oauth'`), and inserts new rows with `source = 'oauth'`.
  - Advances channel `post_count_seen` watermark.
- `GET /api/pulse/oauth/config`:
  - Public read endpoint (registered in `PUBLIC_READ_EXACT` in `https-server.ts`).
  - Returns `{ tiktok: { enabled, clientKey }, instagram: { enabled, appId } }` without exposing server secrets.
  - Also included in `GET /api/channels/options` response.

### 5. Verified Tick Presentation
- Verified that `isVerified` is derived from `Boolean(creator_channels.oauth_verified_at)`:
  - Public Profile chips (`apps/native/components/ChannelChips.tsx`): Displays `✓` verified badge when `channel.isVerified === true`.
  - Pulse Feed cards (`apps/native/components/PulseFeedCard.tsx`): Displays `✓` verified badge next to author callsign when `item.isVerified === true`.
  - Channels management screen (`apps/native/app/channels.tsx`): Displays `✓ Verified` badge on card.

### 6. Disconnect Semantics & Data Retention
- When a channel is disconnected:
  - `creator_channels.oauth_verified_at` is set to `NULL`.
  - `creator_channels.supports_autolist` is reset to `0` (for manual/Display API platforms).
  - Stored access and refresh tokens are deleted from device `SecureStore`.
  - Existing items in `pulse_items` are preserved without deletion.
  - Because `PulseFeedCard` joins live `creator_channels` to evaluate `isVerified`, feed items from the channel dynamically reflect current verification status while remaining active community content.

---

## Verification & Test Results

1. **New Automated Suite (`apps/server/src/test-pulse-oauth.ts`):**
   - Registered in `scripts/test-all.sh` and verified with `scripts/check-suite-registration.sh`.
   - Covers:
     - Non-owner cannot attach OAuth verification to another member's channel (403 `NOT_YOURS`).
     - Mismatched platform username is refused (400 `ACCOUNT_MISMATCH`).
     - Matching account sets `oauth_verified_at` and `supports_autolist = 1`.
     - Disconnect clears `oauth_verified_at` and resets `supports_autolist`.
     - Disconnect preserves previously ingested feed items.
     - OAuth config endpoint reports platform availability cleanly when unset.
     - Non-owner cannot ingest OAuth items for another member's channel (403 `NOT_YOURS`).
     - OAuth-ingested item dedupes against the same item ingested manually earlier.
     - Resubmission / tombstone restoration through OAuth ingestion.
     - Public channel serialization (`isVerified`) accurately reflects verification state.
   - Result: **38/38 tests passing**.

2. **Full Regression Suite (`scripts/test-all.sh`):**
   - `test-creator-channels`: **127/127 passing**.
   - `test-pulse-resolver`: **148/148 passing**.
   - `test-pulse-submit`: **87/87 passing**.
   - `test-pulse-oauth`: **38/38 passing**.
   - Monorepo checks & federation test suites: **All passing**.

---

## What is proven, and what is not

### What is proven
- **Server endpoint authorization & ownership gating:** `POST /api/member/channels/:id/verify-oauth`, `POST /api/member/channels/:id/disconnect-oauth`, and `POST /api/member/pulse/oauth-ingest` require signed requests from `ctx.state.actor` and strictly refuse unauthenticated requests (401) and foreign actor attempts on another member's channel (403 `NOT_YOURS`).
- **Account matching logic:** Channel platform and handle verification correctly compares normalized usernames against stored handles and profile URLs; mismatched accounts are refused with 400 `ACCOUNT_MISMATCH`.
- **Database mutations & retention semantics:** Verification stamps `oauth_verified_at` and enables autolist. Disconnect clears `oauth_verified_at = NULL` and resets `supports_autolist` to platform defaults while preserving all existing `pulse_items` rows in the database.
- **Batch OAuth ingestion pipeline & deduplication:** `oauth-ingest` updates existing active rows, deduplicates without creating redundant rows, and restores tombstoned rows (`deleted_at = NULL, source = 'oauth'`).
- **Clean fallback on unconfigured nodes:** When `TIKTOK_CLIENT_KEY` or `INSTAGRAM_APP_ID` are unset, config endpoints return `{ enabled: false }` and the native UI cleanly hides the connect affordance without throwing or erroring.

### What is NOT proven
- **No real platform endpoint was ever contacted:** There is currently **no registered TikTok developer app** and **no Instagram app**. No automated or manual test has opened a real network socket to `https://www.tiktok.com/v2/auth/authorize/`, `https://open.tiktokapis.com/v2/oauth/token/`, `https://open.tiktokapis.com/v2/user/info/`, or `https://open.tiktokapis.com/v2/video/list/`. The entire OAuth handshake is completely unexercised against real servers.
- **Live PKCE exchange & authorization flow:** Browser Custom Tab launches, redirect parameter extraction (`code`, `state`), PKCE verification on TikTok's auth servers, and token grant exchanges have only been tested against local test mocks and client code contracts.
- **Display API payload format compatibility:** The parsing of TikTok user profiles and video listings (`video/list/`) assumes TikTok's documented response schemas, but has not been verified against actual live responses from a real creator account.
- **Android App Link / Custom Tab interception on physical devices:** While the multi-source event race (`openAuthSessionWithFallback`) is implemented to mitigate Custom Tab dismissal by installed apps, its real-world behaviour on Android hardware with native TikTok and Facebook apps installed remains completely unverified.

### What will remain unverified until Marty registers a TikTok developer app:
1. Live TikTok Login Kit authorization redirect and PKCE code exchange against production TikTok endpoints.
2. Live TikTok user identity retrieval (`user.info.basic`) and username matching.
3. Live TikTok video list fetching (`video.list`) and thumbnail URL validity.
4. Token refresh cycle (`refresh_token`) against live TikTok auth endpoints upon token expiry.
5. End-to-end device authorization flow on physical Android and iOS hardware.

