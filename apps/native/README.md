# BeanPool Native App

> Full-featured React Native / Expo companion app — achieving visual and functional parity with the BeanPool PWA.

---

## Purpose

The BeanPool Native App is a **full native client** for Android and iOS, built with Expo Router and React Native. It mirrors the PWA's tab-based interface with native UI controls, SQLite-backed data persistence, and Expo SecureStore for identity management. A background sync service (Pillar Toggle) periodically mirrors the community ledger via Merkle delta exchange.

## Architecture

```
apps/native/
├── app/
│   ├── _layout.tsx              # Root layout — IdentityContext gate
│   ├── IdentityContext.tsx       # Global identity provider (SecureStore)
│   ├── welcome.tsx              # Onboarding: Create / Recover identity
│   ├── recover-identity.tsx     # Social Recovery (3-of-N) and mnemonic restore
│   ├── propose-project.tsx      # Propose community crowdfund project
│   ├── edit-project.tsx         # Edit existing community project
│   ├── project-detail.tsx       # Detailed view of a specific project
│   ├── public-profile.tsx       # Public profile view for members
│   ├── chat/[id].tsx            # Individual chat conversation
│   ├── post/[id].tsx            # Post detail view
│   ├── i/[hash].tsx             # Shortlink redirection router
│   └── (tabs)/
│       ├── _layout.tsx          # Tab navigator — neon-vine branded bar
│       ├── index.tsx            # 🗺️ Map — Google Maps with native markers + clustering
│       ├── projects.tsx         # 🌱 Projects — community crowdfunding
│       ├── market.tsx           # 🤝 Market — 14-category marketplace
│       ├── chats.tsx            # 💬 Chat — conversations list
│       ├── people.tsx           # 👥 People — community browser
│       ├── ledger.tsx           # 📊 Ledger — balance & transactions
│       └── settings.tsx         # ⚙️ Settings — profile, node, identity
├── components/
│   ├── GlobalHeader.tsx         # Shared header with branding + guest mode indicator
│   ├── Map.tsx                  # Native map stub (placeholder)
│   ├── Map.web.tsx              # Web-only Leaflet map
│   ├── UnifiedMapPin.tsx        # SVG pin renderer + off-screen image capture pipeline
│   ├── MapPinTail.tsx           # SVG tail renderer for custom map pin positioning
│   ├── MemberAvatar.tsx         # Avatar display with fallback initials
│   ├── AvatarPickerSheet.tsx    # Bottom sheet for selecting member profile avatars (camera/gallery)
│   ├── SyncStatus.tsx           # Background sync status indicator + guest mode badge
│   ├── CurrencyDisplay.tsx      # Formatted display for Bean credits
│   ├── RadiusPickerModal.tsx    # Modal for filtering by distance
│   ├── ReviewModal.tsx          # Modal for submitting and viewing ratings
│   ├── CategoryPickerSheet.tsx  # Bottom sheet for marketplace category selection
│   ├── MyDealsSheet.tsx         # Bottom sheet for viewing active deals (offers/needs in escrow)
│   ├── PostAuthorTrust.tsx      # Trust badge display for post authors (ratings, join date)
│   ├── TrustPickerSheet.tsx     # Bottom sheet for Elders to vouch for newcomers
│   ├── PhotoCarousel.tsx        # Carousel element for viewing post photos
│   ├── InfoModal.tsx            # Generic info popover gate component
│   └── info-content/            # 10 dedicated text templates for info modals (Balance, Circulation, Trust, etc.)
├── services/
│   ├── pillar-sync.ts           # Delta-only Merkle sync engine
│   ├── background-task.ts       # Expo BackgroundFetch registration
│   └── push-notifications.ts    # Expo push notification registration + handler
├── utils/
│   ├── db.ts                    # SQLite database (expo-sqlite) with FTS5 search
│   ├── identity.ts              # Ed25519 keypair + BIP-39 mnemonic
│   ├── crypto.ts                # Crypto utilities (SHA-256, SHA-512, Ed25519 signing) with iOS polyfill
│   ├── identity-transfer.ts     # Cross-device identity transfer
│   ├── synonyms.json            # 417-entry marketplace synonym map
│   ├── bundled-avatars.ts       # Pre-bundled avatar image registry
│   └── image-processing.ts      # Photo resize/crop utilities
├── assets/
│   └── images/
│       ├── neon-vines-banner.png  # Tab bar background artwork
│       └── avatars/               # 10 bundled avatar images (bean, crystal, fire, etc.)
```

## Tabs

| Tab | Emoji | Screen | Purpose |
|-----|-------|--------|---------|
| Map | 🗺️ | `index.tsx` | Community map with pre-rendered markers + clustering (Google Maps native) |
| Projects | 🌱 | `projects.tsx` | Community crowdfunding — propose and fund shared goals with Beans |
| Market | 🤝 | `market.tsx` | 14-category marketplace — grid/list view, search, category filter, block users |
| Chat | 💬 | `chats.tsx` | DM and group conversations |
| People | 👥 | `people.tsx` | Community member browser |
| Ledger | 📊 | `ledger.tsx` | Mutual credit balance, transaction history, send credits |
| Settings | ⚙️ | `settings.tsx` | Profile editing, node config, identity management (hidden from tab bar) |

## Key Features

- **Self-Managed Identity & E2E Encryption** — Ed25519 keypair from BIP-39 12-word mnemonic, stored securely in hardware-backed Expo SecureStore. Direct messages are fully E2E encrypted (Noise/X25519/AES-GCM) protecting user chats from server visibility (NAT-1), with sent/read receipts and encrypted camera/photo attachments.
- **SQLite Post Context Caching** — Metadata (titles, status, cover photos, credits) is cached in local SQLite `conversations` and `marketplace_transactions` tables. This guarantees transaction histories and active chats display correct titles and photos when restoring/migrating accounts on a new phone.
- **Review Editing** — Option to edit reviews directly from the Given tab of a profile, with pre-populated stars and comments inside the `ReviewModal`.
- **Android Memory Optimization** — Configured `largeHeap: true` to prevent Out-of-Memory (OOM) heap limit crashes during dense image handling or map rendering.
- **Official App & Play Store Update Checks** — Querying unauthenticated store APIs (iTunes Lookup for iOS, regex parsing of Play details HTML scripts for Android) on a 24-hour throttled check, showing an organic header upgrade banner decoupled from node updates.
- **Decoupled Release Versioning** — Support for individual native-only bumps (`node scripts/bump-version.mjs patch --native`) and Git tags (`native-v*`), decoupling review times from server nodes.
- **Real-time Node Parity Settings** — Displaying sync status indicators (`🟢 Synced`, `⚠️ Out of Sync`, `⚪ Offline / Local-First`) under SQLite cache details by querying table aggregates against live remote transactions, posts, and member sizes.
- **SQLite Integrity Diagnostics (v1.0.83 / v1.0.84)** — Active `PRAGMA integrity_check` scans, database file size display, and multi-table counters (Members, Posts, DMs, Txns) displaying database health indicators in Settings. Includes Koa health check `minAppVersion` gates matched dynamically on client boot to overlay updates.
- **Client-Side Request Signing** — Signs requests natively using Ed25519 for all signature-required API routes (including profile update, ledger transfer, marketplace posts/deals, friends add/remove, set guardian, push token registration, and notification preferences).
- **SQLite Persistence** — all posts, projects, messages, and ledger data stored locally via `expo-sqlite`
- **14-Category Marketplace** — Food, Services, Labour, Tools, Goods, Housing, Transport, Education, Arts, Health, Care, Animals, Energy, General (PWA has 13; native adds Care ❤️)
- **Marketplace UX Modernization** — horizontal category chips via `CategoryPickerSheet`, author trust badges (`PostAuthorTrust`), and active deals tracking (`MyDealsSheet`)
- **Author Request Review Flow** — Enhanced deals management allowing sellers to review buyer requests with integrated messaging and standardized decline reasons
- **Ledger UI Enhancements** — Corrected credit slider visual representation for negative balances and improved feedback for locked 'Send Credits' functionality
- **Map Clustering (Phase 6)** — pin clustering for dense areas, modern markers with category icons, elder glow effects for founding members
- **Map Clustering Stabilization** — Patched `react-native-map-clustering` to prevent marker disappearance on iOS scroll/zoom
- **Android Marker Pipeline** — All map pins and clusters are pre-rendered to PNG via `react-native-view-shot` and served through the Google Maps `BitmapDescriptor` pipeline (`image={{ uri }}` prop), bypassing Android's restrictive JSX bitmap snapshot window. Cluster counts are pre-rendered for 2–99 with a "99+" overflow pattern for high-density areas.
- **Profile Navigation** — Author names and avatars are tappable across all marketplace surfaces (cards, map preview, community list, projects), navigating to the Trust Profile page with correct data params
- **Offline Outbox** — Native SQLite capability allowing users to draft and queue marketplace posts whilst offline, with automatic syncing upon reconnection
- **Sanitized Syncing** — The native SQLite `applyDelta` daemon and map automatically filter out synthetic visitor/guest accounts and escrow wallets
- **Push Notifications** — DM and marketplace deal alerts via Expo Push, per-member notification preferences, token registration
- **Guest Mode** — multi-node onboarding flow with membership probe; guest indicators in header and sync status when visiting a node you're not a member of
- **Community Search** — search and infinite scroll on the Community member list
- **App Store & Play Store Submission** — Published/built for both stores (v1.1.40, Android versionCode 156, iOS build 141).
- **Community Projects** — crowdfund tab with progress bars, funding badges, and proposal creation
- **Branded Tab Bar** — neon-vine artwork background with semi-transparent overlay
- **Post Detail View** — full-screen view with photos, credits, author info
- **Global Notifications** — red tab bar badges dynamically map to internal SQLite `last_read_at` unread calculations across inactive threads
- **Live Thread Syncing** — optimized 3-second polling hooks inside Active Chat fragments safely establish WebSocket-like responsiveness without hammering the background Node, paired with a `sync_data_updated` DeviceEventEmitter listener to reload chat details and message logs in real-time.
- **SQLite Concurrency Mutex** — robust `dbSyncLock` javascript queue and zero-lock network fetches guarantee zero memory locks and prevent "database is locked" crashes when background `applyDelta` daemons inherently overlap with foreground UX reads
- **Local User Blocking** — client-side block list stored in SecureStore securely hides target callsigns and listings
- **Settings Visual Overhaul** — identity card with bio, contact details, and contrast improvements
- **iOS Crypto Polyfill** — SHA-512 and Ed25519 signing polyfilled for iOS via `expo-crypto`
- **Escrow Actions** — request/approve/reject/cancel/complete marketplace deals with atomic escrow settlement
- **Social Recovery (3-of-N)** — cryptographically secure identity recovery requiring a quorum of trusted guardians without central admins.
- **Quadratic Voting** — native governance engine with voting stepper, dual progress bars, and CommonsInfoModal for community projects.
- **Haptic Feedback** — contextual haptic responses for a tactile and responsive native experience.
- **Cross-platform Avatar Sync** — robust `bundled://` protocol for seamless avatar resolution and cross-platform syncing.

## Background Sync (Pillar Toggle)

```
Every 15 min (iOS) / configurable (Android):
  1. Wake up in background
  2. Connect to BeanPool node
  3. Request node's Merkle root hash
  4. Compare with local hash
     → Match? Done. (0 bytes, ~1 second)
     → Differ? Pull delta only
  5. Apply delta, prune to 1,000 tx
  6. If > 20 seconds: checkpoint & abort
```

| Rule | Value | Why |
|------|-------|-----|
| **Timeout** | 20 seconds | iOS kills tasks > 30s |
| **Pruning** | 1,000 transactions | Protect phone storage |
| **Checkpoint** | Auto | Resume aborted syncs |

## Deep Link & Onboarding Architecture

To gracefully bypass Apple and Google's URL parameter stripping during uninstalled app boundary crossings, BeanPool implements a 3-tier deep-link mitigation flow carefully balancing reliability and user privacy constraints.

1. **Deferred Deep Linking (Clipboard Inference)**
   - Apple strictly drops URL parameters if a user must install the app completely from scratch. 
   - We solve this by having the `WelcomePage.tsx` Web Trampoline inject `navigator.clipboard.writeText()` onto the "Download App Store" buttons.
   - Onboarding clipboard verification is now strictly user-initiated on the first boot via a styled "Paste" action. This resolved intrusive background clipboard scanning (`Clipboard.hasStringAsync()`) that flashed platform privacy/spyware warnings, completely eliminating background clipboard polling.

2. **Bypassing Expo Router Hydration Drops**
   - Relying on `useLocalSearchParams()` on Android leads to intent drops, as standard router hydration intrinsically races during cold-boot states, losing the `?invite=` query argument.
   - We forcefully bypass the router by having the Welcome screen natively pull `Linking.useURL()` on purely the first mount tick.

3. **Android Intent Parser Safe Payloads**
   - The Android Deep Link parser destructively munches standard Base64 characters (`+`, `/`, `=`) turning them into whitespace inside URL parameters.
   - Offline cryptographic tickets are entirely encoded in `Base64URL` natively by the PWA and safely reversed exactly before the backend triggers Ed25519 parsing. Invite formats are distinguished primarily by length (Tickets > 20 characters) and fallback legacy genesis codes (`INV-XXXX`).

## Quick Start

```bash
cd apps/native
pnpm install
npx expo start --web --port 8082   # Web preview
npx expo start                      # Native dev client
```

## Parity Status (vs PWA)

| Feature | PWA | Native | Notes |
|---------|-----|--------|-------|
| Map with pins | ✅ | ✅ | WebView+Leaflet on native |
| Marketplace (grid/list) | ✅ | ✅ | Native has 14 categories (adds Care) |
| Post creation | ✅ | ✅ | Photo upload, location pin |
| Post detail view | ✅ | ✅ | |
| Chat (DM + groups) | ✅ | ✅ | Real E2E encryption (Noise/X25519/AES-GCM) with sent/read receipts |
| Live Chat Response Polling | ✅ | ✅ | 3-sec foreground hook interval |
| Unread Notification Badges | ✅ | ✅ | Tab bar indicator with JS Date Timezone corrections |
| People browser | ✅ | ✅ | Connects to `/api/members` dictionary for Callsign resolutions |
| Ledger & send credits | ✅ | ✅ | |
| Identity (create/recover) | ✅ | ✅ | SecureStore on native |
| Community Projects & Quadratic Voting | — | ✅ | Native-only feature (funding + QV governance) |
| Settings / Profile | ✅ | ✅ | |
| Bean ratings | ✅ | ✅ | Implemented via SQLite and ReviewModal |
| Abuse reporting | ✅ | ✅ | Implemented via SQLite and identity tracking |
| Push notifications | — | ✅ | DM + marketplace alerts via Expo Push |
| Guest mode | ✅ | ✅ | Multi-node onboarding with membership probe |
| Map clustering | ✅ | ✅ | Phase 6 overhaul with elder glow and stabilization patches |
| Offline Outbox | — | ✅ | Native-only offline draft queuing |
| Sanitized Syncing | ✅ | ✅ | Filtering of synthetic visitor accounts |
| Social Recovery | — | ✅ | 3-of-N quorum-based Guardian identity restoration |
| Synonym search | ✅ | ✅ | FTS5 on native, client-side on PWA (417-entry map) |
| Blocked user filtering | ✅ | ✅ | localStorage (PWA) / SecureStore (native) |
| Wipe identity | ✅ | ✅ | Double-confirm on both platforms |
| Community search | ✅ | ✅ | Search filter on People/Community member list |
| Community status | ✅ | — | PWA-only header health popover |
| Author Request Review Flow | — | ✅ | Sellers can review buyer requests with integrated messages/decline reasons |
| Federation (remote markets) | ✅ | 🔜 | Planned |

---

_Last updated: 2026-06-17_
