# Parity Audit: Social, Pulse, and the App Shell

## Parity table
| Feature | Native (file:line) | PWA (file:line) | Verdict |
| :--- | :--- | :--- | :--- |
| Direct Message E2E Encryption (X25519/XChaCha20) | apps/native/utils/e2e-crypto.ts:20-77 | apps/pwa/src/lib/e2e-crypto.ts:16-78 | parity |
| Legacy Message Encoding/Decoding (plaintext-v1) | apps/native/utils/db.ts:2740-2745 | apps/pwa/src/lib/e2e-crypto.ts:83-96 | parity |
| Conversations List Organization & Filtering | apps/native/app/(tabs)/chats.tsx:26-32 | apps/pwa/src/pages/MessagesPage.tsx:1031-1076 | divergent |
| Chat Thread Pagination & History Loading | apps/native/app/chat/[id].tsx:29-32 | apps/pwa/src/pages/MessagesPage.tsx:258-263 | divergent |
| Message Sending & Offline Queuing | apps/native/utils/db.ts:2822-2915 | apps/pwa/src/pages/MessagesPage.tsx:314-335 | divergent |
| Group Conversation Creation | apps/native/app/new-message.tsx:236 | apps/pwa/src/pages/MessagesPage.tsx:287-304 | PWA-only |
| Message Editing (15-minute window) | apps/native/app/chat/[id].tsx:26-28 | none | native-only |
| Message Emoji Reactions | apps/native/app/chat/[id].tsx:103-106 | none | native-only |
| Local Message Deletion | apps/native/app/chat/[id].tsx:12 | none | native-only |
| Encrypted Image Attachments & Captions | apps/native/utils/db.ts:3001-3036 | apps/pwa/src/pages/MessagesPage.tsx:337-358 | divergent |
| Unread Conversation Badge Polling | apps/native/app/(tabs)/_layout.tsx:151-189 | apps/pwa/src/App.tsx:189-217 | divergent |
| New Message Composition Flow | apps/native/app/new-message.tsx:61-120 | apps/pwa/src/pages/MessagesPage.tsx:467-538 | divergent |
| Member Directory Search & Sorting | apps/native/app/(tabs)/people.tsx:20-22 | apps/pwa/src/pages/PeoplePage.tsx:81-120 | divergent |
| Public Member Profiles & Synergy Display | apps/native/app/public-profile.tsx:42-100 | apps/pwa/src/pages/PublicProfilePage.tsx:21-83 | divergent |
| Own Profile Editing & Persistence | apps/native/app/(tabs)/settings.tsx:960-992 | apps/pwa/src/pages/ProfilePage.tsx:50-80 | divergent |
| Contact Visibility Scopes & Defaults | apps/native/app/(tabs)/settings.tsx:539 | apps/pwa/src/pages/ProfilePage.tsx:24 | divergent |
| Avatar Rendering & Letter Fallback Color | apps/native/components/MemberAvatar.tsx:27-34 | apps/pwa/src/pages/PeoplePage.tsx:47-76 | divergent |
| Member Archetype Personality Quiz & Synergy | apps/native/app/public-profile.tsx:11-13 | none | native-only |
| Cross-Node Canonical Profile Sync | apps/native/utils/canonical-profile.ts:1-57 | none | native-only |
| Trust Levels & Recognition Milestones | apps/native/app/(tabs)/ledger.tsx:410-470 | apps/pwa/src/pages/LedgerPage.tsx:275-395 | parity |
| Send Credit Gating (Positive Balance Rule) | apps/native/app/(tabs)/ledger.tsx:379-385 | apps/pwa/src/pages/LedgerPage.tsx:161 | parity |
| Elder Vouching Workflow | apps/native/app/public-profile.tsx:7 | apps/pwa/src/pages/PublicProfilePage.tsx:93-115 | parity |
| Trust Risk Scoring & Badging | apps/native/app/public-profile.tsx:46-50 | apps/pwa/src/components/PostAuthorTrust.tsx:80-140 | divergent |
| User Blocking & Blocklist Enforcement | apps/native/utils/blocklist.ts:1-120 | apps/pwa/src/pages/MarketplacePage.tsx:1910 | native-only |
| Abuse Reporting Submission | apps/native/utils/db.ts:3945-3965 | apps/pwa/src/pages/MarketplacePage.tsx:1349-1390 | parity |
| Online Invite Code Generation | apps/native/app/(tabs)/people.tsx:330-365 | apps/pwa/src/pages/InvitePage.tsx:96-109 | parity |
| Cryptographic Offline Ticket Generation Wire Format | apps/native/app/(tabs)/people.tsx:370-405 | apps/pwa/src/pages/InvitePage.tsx:111-155 | divergent |
| Invite Sharing & System Share Sheet | apps/native/app/(tabs)/people.tsx:87-92 | apps/pwa/src/pages/InvitePage.tsx:185-202 | parity |
| Online & Offline Invite Code Redemption | apps/native/utils/db.ts:3237-3280 | apps/pwa/src/pages/WelcomePage.tsx:479-490 | parity |
| Community Invite Tree Interactive Visualizer | none | apps/pwa/src/pages/InvitePage.tsx:340-420 | PWA-only |
| Pulse Community Feed Tab & View | apps/native/app/(tabs)/pulse.tsx:40-350 | none | native-only |
| Pulse Feed Facade Cards | apps/native/components/PulseFeedCard.tsx:1-200 | none | native-only |
| Creator Channels Management (CRUD) | apps/native/app/channels.tsx:22-450 | none | native-only |
| Public Channel Link Chips on Member Profiles | apps/native/components/ChannelChips.tsx:1-85 | apps/pwa/src/components/ChannelChips.tsx:20-89 | parity |
| Manual Pulse Ingestion Screen & Previews | apps/native/app/pulse-intake.tsx:24-350 | none | native-only |
| Pulse Channel OAuth Integrations (TikTok/Instagram) | apps/native/utils/pulse-oauth.ts:1-850 | none | native-only |
| Pulse Intake Nudges & Preview Cards | apps/native/components/PulseNudges.tsx:1-250 | none | native-only |
| Native Push Notifications Registration | apps/native/services/push-notifications.ts:36-115 | none | native-only |
| Notification Preferences Panel | none | apps/pwa/src/pages/SettingsPage.tsx:1052-1100 | PWA-only |
| WebSocket Transport Protocol (`/ws`) | apps/native/services/ws-client.ts:83-117 | apps/pwa/src/lib/sync.ts:45-96 | parity |
| WebSocket 30s Heartbeat Ping | apps/native/services/ws-client.ts:125-136 | none | native-only |
| WebSocket Reconnection Strategy | apps/native/services/ws-client.ts:211-225 | apps/pwa/src/lib/sync.ts:124-126 | divergent |
| State Synchronization Engine | apps/native/services/pillar-sync.ts:190-320 | apps/pwa/src/lib/sync.ts:69-84 | divergent |
| System Announcements Presentation | apps/native/app/_layout.tsx:701-708 | apps/pwa/src/App.tsx:631-671 | divergent |
| Tab Bar Configuration & Routing Structure | apps/native/app/(tabs)/_layout.tsx:210-306 | apps/pwa/src/App.tsx:75, 239-246 | divergent |
| Global Header & Node Switcher | apps/native/components/GlobalHeader.tsx:47-200 | apps/pwa/src/App.tsx:352-420 | divergent |
| Theme Switching & Palette Customization | apps/native/app/ThemeContext.tsx:24-60 | apps/pwa/src/lib/useTheme.ts:14-38 | divergent |
| Deep Linking & Native Intents | apps/native/app/+native-intent.ts:9-54 | apps/pwa/src/pages/WelcomePage.tsx:475-485 | divergent |
| PWA Installation Floating Banner | none | apps/pwa/src/components/InstallPrompt.tsx:32-110 | PWA-only |
| Minimum Viewport Adaptation (320dp floor) | apps/native/app/(tabs)/_layout.tsx:27-31 | apps/pwa/src/App.tsx:532-570 | parity |
| App Version Display & Store Floor Enforcement | apps/native/utils/app-version.ts:78-105 | apps/pwa/src/App.tsx:110-127 | divergent |

### Divergences
- **Conversations List Organization & Filtering**: Native sorts by recent, unread count, or credit transaction balances with a friends/all filter (apps/native/app/(tabs)/chats.tsx:26-29), while PWA divides conversations across All, Transactions, and Direct tabs sorted by active escrow state (apps/pwa/src/pages/MessagesPage.tsx:1031-1076).
- **Chat Thread Pagination & History Loading**: Native limits chat thread history to pages of 50 via SQLite cursor reads (apps/native/app/chat/[id].tsx:32), whereas PWA fetches the entire message list over HTTP on load (apps/pwa/src/pages/MessagesPage.tsx:258-263).
- **Message Sending & Offline Queuing**: Native writes messages immediately to local SQLite with optimistic pending status and background flush (apps/native/utils/db.ts:2852-2886), whereas PWA fires an inline HTTP POST that throws an alert and loses the draft if the device is offline (apps/pwa/src/pages/MessagesPage.tsx:314-335).
- **Encrypted Image Attachments & Captions**: Native accepts an optional text caption encrypted into the message ciphertext and caches decrypted images to the local filesystem (apps/native/utils/db.ts:3001-3050), while PWA hardcodes an empty caption and retains decrypted images only in React component memory (apps/pwa/src/pages/MessagesPage.tsx:345, 97-125).
- **Unread Conversation Badge Polling**: Native computes unread badges from local SQLite every 5s with a 30s background network backstop (apps/native/app/(tabs)/_layout.tsx:179-180), while PWA polls /api/messages/conversations/:publicKey over HTTP every 10s (apps/pwa/src/App.tsx:215).
- **New Message Composition Flow**: Native pushes a dedicated full screen route with animated skeleton shimmers and recent contacts (apps/native/app/new-message.tsx:21-42), whereas PWA mounts an inline conditional subview within the same page (apps/pwa/src/pages/MessagesPage.tsx:468-538).
- **Member Directory Search & Sorting**: Native offers 5 distinct directory sorting criteria (newest, name, friends, trusted, active) (apps/native/app/(tabs)/people.tsx:21), whereas PWA provides only an unsorted text filter (apps/pwa/src/pages/PeoplePage.tsx:83).
- **Public Member Profiles & Synergy Display**: Native computes dynamic archetype synergy percentages and renders server risk banners (apps/native/app/public-profile.tsx:12, 46-50), whereas PWA renders standard tabs without archetype calculations or risk banners (apps/pwa/src/pages/PublicProfilePage.tsx:34-40).
- **Own Profile Editing & Persistence**: Native allows offline profile edits queued in AsyncStorage for subsequent synchronization (apps/native/app/(tabs)/settings.tsx:961-965), while PWA explicitly aborts save operations if !navigator.onLine (apps/pwa/src/pages/ProfilePage.tsx:51-54).
- **Contact Visibility Scopes & Defaults**: Native initializes contact visibility to community (apps/native/app/(tabs)/settings.tsx:539), while PWA initializes contact visibility to hidden (apps/pwa/src/pages/ProfilePage.tsx:24).
- **Avatar Rendering & Letter Fallback Color**: Native hashes public keys across 8 palette colors with optional tap-to-enlarge modal inspection (apps/native/components/MemberAvatar.tsx:27-34, 46-48), while PWA applies fixed neutral background tones with amber highlighting for guardians (apps/pwa/src/pages/PeoplePage.tsx:66-71).
- **Trust Risk Scoring & Badging**: Native retrieves verified risk assessment payloads from GET /api/community/trust-profile/:pubkey (apps/native/app/public-profile.tsx:7, 46-50), whereas PWA derives trust indicators strictly from local marketplace transaction math in PostAuthorTrust (apps/pwa/src/components/PostAuthorTrust.tsx:43-78).
- **Cryptographic Offline Ticket Generation Wire Format**: Native encodes payload JSON to base64 before wrapping it into ticket JSON { p: payloadBase64, s: signatureBase64 } (apps/native/app/(tabs)/people.tsx:389-393), whereas PWA embeds the raw payload string directly into { p: payloadStr, s: signature } with URL-safe base64 transformation (apps/pwa/src/pages/InvitePage.tsx:124-133).
- **WebSocket Reconnection Strategy**: Native applies exponential backoff (1s doubling to 30s) with randomized jitter and disconnects when backgrounded (apps/native/services/ws-client.ts:43-51, 211-224), whereas PWA attempts reconnection on a fixed 5s interval without jitter or visibility guards (apps/pwa/src/lib/sync.ts:21, 124-126).
- **State Synchronization Engine**: Native executes Merkle-assisted delta replication storing posts, members, transactions, and balances into SQLite (apps/native/services/pillar-sync.ts:190-300), whereas PWA only commits Merkle root strings and account count integers to localStorage (apps/pwa/src/lib/sync.ts:69-76).
- **System Announcements Presentation**: Native surfaces alerts via native system dialog boxes Alert.alert (apps/native/app/_layout.tsx:706), while PWA presents a custom fixed-position glassmorphism overlay modal styled by severity (apps/pwa/src/App.tsx:631-671).
- **Tab Bar Configuration & Routing Structure**: Native mounts 6 top-positioned tabs (Market, Map, Talk, Pulse, Commons, Ledger) with hidden routes for Settings and People (apps/native/app/(tabs)/_layout.tsx:210-305), while PWA mounts 6 bottom tabs (Market, Map, Commons, Chat, People, Ledger) on mobile and a sidebar on desktop, omitting Pulse entirely (apps/pwa/src/App.tsx:239-251).
- **Global Header & Node Switcher**: Native mounts a persistent top header reporting dynamic layout height and community switching (apps/native/components/GlobalHeader.tsx:47-120), while PWA renders a mobile-only header with inline community status cards and hides the header on desktop (apps/pwa/src/App.tsx:351-415).
- **Theme Switching & Palette Customization**: Native toggles between light and dark themes alongside 3 light palette modes (classic, earth, slate) (apps/native/app/ThemeContext.tsx:5-12), whereas PWA provides only a binary light/dark mode switch (apps/pwa/src/lib/useTheme.ts:10-37).
- **Deep Linking & Native Intents**: Native intercepts custom OS schemes (beanpool://), foregrounding wakeups, and OAuth callbacks via native listeners (apps/native/app/+native-intent.ts:9-54), whereas PWA relies exclusively on browser query parameter parsing (apps/pwa/src/pages/WelcomePage.tsx:475-485).
- **App Version Display & Store Floor Enforcement**: Native parses node health headers to block builds below minAppVersion with an undismissible update barrier (apps/native/utils/app-version.ts:78-105), whereas PWA merely reads __APP_VERSION__ for display with zero minimum-version enforcement (apps/pwa/src/App.tsx:110-127).

## HIGH severity
1. **PWA Notification Preferences Illusion (Zero Push Delivery)**
   - **What breaks**: Members who enable notification toggles in the PWA never receive push notifications when the application tab is closed or backgrounded.
   - **For whom**: All web/PWA users relying on notification preferences configured in Settings.
   - **File:line evidence**:
     - `apps/pwa/src/pages/SettingsPage.tsx:1052-1093` presents UI toggles for chat, marketplace, and escrow notifications, calling `updateNotificationPreferences` (`apps/pwa/src/lib/api.ts:1099`).
     - `apps/pwa/vite.config.ts:34` explicitly sets `selfDestroying: true` on the Vite PWA plugin, disabling service worker registration.
     - `apps/pwa/src` contains zero calls to `Notification.requestPermission`, `PushManager`, or token registration with `/api/push-tokens` (unlike Native in `apps/native/services/push-notifications.ts:36-78`).

2. **Complete Pulse Feature Omission in PWA**
   - **What breaks**: PWA users have no access to the community pulse feed, cannot view feed cards, cannot manage syndicated creator channels, cannot ingest manual URLs, and cannot link OAuth accounts.
   - **For whom**: All PWA users attempting to view local content syndicated by community neighbors.
   - **File:line evidence**:
     - `apps/pwa/src/App.tsx:75, 239-246` defines `type Tab = "map" | "marketplace" | "messages" | "people" | "ledger" | "projects"` with no Pulse tab.
     - Native has dedicated implementations in `apps/native/app/(tabs)/pulse.tsx:40`, `apps/native/app/channels.tsx:22`, `apps/native/app/pulse-intake.tsx:24`, and `apps/native/utils/pulse-oauth.ts:1-850`.
     - The only Pulse artifact in PWA is read-only channel chips on member profiles (`apps/pwa/src/components/ChannelChips.tsx:20`).

3. **PWA User Harassment Vulnerability (Non-functional Blocklist)**
   - **What breaks**: A PWA user subjected to harassment or spam cannot block any user.
   - **For whom**: All PWA users interacting in messages or the directory.
   - **File:line evidence**:
     - `apps/pwa/src/pages/MarketplacePage.tsx:1910` checks `localStorage.getItem("bp_blocked_users")`.
     - Nowhere in `apps/pwa` is `bp_blocked_users` ever written, and no UI exists on `PublicProfilePage.tsx` or `MessagesPage.tsx` to add a user to the blocklist.
     - In contrast, Native implements full block actions in `apps/native/utils/blocklist.ts:34-75` and `apps/native/app/public-profile.tsx:1270-1310`.

4. **Missing Minimum-Version Gate in PWA**
   - **What breaks**: When a node operator increases `MIN_APP_VERSION` to mandate protocol updates or security fixes, PWA clients continue running incompatible API formats without warning.
   - **For whom**: PWA users connected to nodes requiring updated schema contracts.
   - **File:line evidence**:
     - Server defines and transmits `minAppVersion` in `apps/server/src/app-store-versions.ts:45, 120`.
     - Native inspects this field and renders a non-dismissible blocking banner (`apps/native/utils/app-version.ts:89-100`, `apps/native/components/GlobalHeader.tsx:440`).
     - PWA reads `/api/community/health` in `apps/pwa/src/App.tsx:124-126` but completely ignores `minAppVersion`.

## Built but unreachable
1. **PWA 4-Tier Privacy Badge Component**
   - **Component**: `apps/pwa/src/components/PrivacyBadge.tsx:11-64`
   - **Evidence**: Grepping for `PrivacyBadge` across `apps/pwa/src` shows only its declaration and a stale comment in `apps/pwa/src/App.tsx:7` (`* - Persistent header with SyncStatus + PrivacyBadge`). It is never imported or rendered by any component or page in the PWA.
2. **PWA 4-Tier Location Privacy Cycling Logic**
   - **Functions**: `cycleTier`, `generateZoneOffset`, and `TIER_CONFIG` in `apps/pwa/src/lib/privacy.ts:18, 30, 52`
   - **Evidence**: Only imported by `apps/pwa/src/components/PrivacyBadge.tsx:9`. Because `PrivacyBadge` is unmounted, these functions cannot be executed. `apps/pwa/src/pages/SettingsPage.tsx:92-99` instead implements an independent binary toggle (`"0"` vs `"3"`).
3. **PWA Marketplace Blocklist Filter**
   - **Code**: `apps/pwa/src/pages/MarketplacePage.tsx:1908-1918`
   - **Evidence**: Reads `localStorage.getItem("bp_blocked_users")`. Grepping for `bp_blocked_users` reveals no writes anywhere in `apps/pwa`. No UI flow can populate this filter.
4. **Native Group Conversation Creation Logic**
   - **Code**: `apps/native/utils/db.ts:3111-3130` (`createConversationApi(type: "dm" | "group", ...)`)
   - **Evidence**: Every caller across `apps/native` (`people.tsx:721`, `new-message.tsx:236`, `post/[id].tsx:735, 763, 1020, 1301, 1398, 1432`) hardcodes `"dm"`. Grepping for `"group"` arguments passed to `createConversationApi` returns zero callers.

## Endpoints
Node API endpoints used by one client and not the other in this domain:

### Native Only
- `POST /api/messages/edit` — `apps/native/utils/db.ts:2973`
- `POST /api/messages/react` — `apps/native/utils/db.ts:3921`
- `GET /api/community/trust-profile/:pubkey` — `apps/native/utils/db.ts:4049`
- `GET /api/pulse/feed` — `apps/native/utils/pulse.ts:98`
- `POST /api/member/pulse/items/:id/mute` — `apps/native/utils/pulse.ts:147`
- `POST /api/channels/mine` — `apps/native/app/channels.tsx:135`
- `POST /api/member/channels` — `apps/native/app/channels.tsx:158`
- `POST /api/member/channels/:id` — `apps/native/app/channels.tsx:234`
- `POST /api/member/channels/:id/delete` — `apps/native/app/channels.tsx:372`
- `POST /api/member/channels/oauth/start` — `apps/native/utils/pulse-oauth.ts:333`
- `POST /api/member/channels/:id/verify-oauth` — `apps/native/utils/pulse-oauth.ts:402`
- `POST /api/member/channels/:id/disconnect-oauth` — `apps/native/utils/pulse-oauth.ts:817`
- `POST /api/member/pulse/preview` — `apps/native/app/pulse-intake.tsx:205`
- `POST /api/member/pulse/submit` — `apps/native/app/pulse-intake.tsx:265`
- `POST /api/member/pulse/channels/:id/dismiss-nudge` — `apps/native/components/PulseNudges.tsx:228`
- `POST /api/push-tokens` — `apps/native/services/push-notifications.ts:78`
- `DELETE /api/push-tokens` — `apps/native/services/push-notifications.ts:182`

### PWA Only
- `GET /api/community/tree` — `apps/pwa/src/lib/api.ts:251`
- `GET /api/member/notifications/preferences` — `apps/pwa/src/lib/api.ts:1096`
- `POST /api/member/notifications/preferences` — `apps/pwa/src/lib/api.ts:1100`

## Coverage gaps
All relevant files across both clients were inspected directly in code. Unread areas outside this domain include:
- `apps/native/utils/friend-recovery.ts` and `apps/native/app/recover.tsx` (Social key recovery protocols).
- `apps/native/utils/ledger-engine.ts` and `apps/pwa/src/lib/ledger.ts` (Core financial calculation internals, beyond trust levels and positive balance sending gates).
- `apps/server/src/routes/apple-probe.ts` and `apps/server/src/routes/federation-commission.ts` (App Store validator probes and server federation internals).
