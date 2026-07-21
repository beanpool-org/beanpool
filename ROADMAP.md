# 🗺️ BeanPool Roadmap

> Planned features and future work. Updated: 2026-06-17

---

## ✅ Recently Completed

- ✅ **Decoupled Architecture Vision (Phases 1–5)** — Fully shipped the long-term sovereign appliance roadmap specified in `docs/architecture-vision.md`:
  - **Phase 1: Route Splitting**: Separated Koa HTTP server into modular domain routes (`routes/admin.ts`, `routes/backup.ts`, `routes/community.ts`, `routes/messaging.ts`, etc.).
  - **Phase 2: State Engine Decomposition**: Hollowed out `state-engine.ts` across 9 extraction phases into `@beanpool/engine` and `apps/server/src/engine/`.
  - **Phase 3: Gateway Configuration (Node Self-Protection)**: Implemented CORS allowed origins, IP allowlists, rate limiting, and subsystem feature toggles (`servePwa`, `marketplace`, `messaging`, `federation`, `invites`).
  - **Phase 4: Detached PWA Architecture**: Added configurable Node API URL (`getNodeApiUrl()`) & dynamic WebSocket derivation (`getNodeWsUrl()`) to PWA, allowing clients to be hosted anywhere (CDN/static/desktop) while pointing at any sovereign node.
  - **Phase 5: Fleet Manager Convergence (`apps/manager`)**: Built a modern, decoupled React + TypeScript control plane in `apps/manager` for multi-node diagnostics, telemetry, gateway management, and trust verification.
- ✅ **Release v1.1.40: Alternative Palettes, Light Mode Map, and Chat Upgrades** — Tokenized colors across the native app, defaulting to Light Mode and introducing Classic, Earth, and Slate palettes. Switched website maps to CartoDB Positron with a custom slate-blue dusk theme. Regenerated all logos with transparent backgrounds. Consolidated inbox tabs into a single unified list. Added tap-to-enlarge chat images, lazy caches, and extended the message edit window from 5 to 15 minutes. Added node status mismatch check and Ed25519 PKCS8 signing fixes. Bumped Android versionCode to 156 (v1.1.40) and iOS buildNumber to 141.
- ✅ **Release v1.1.29: Inbox Real-Time Sync & Alignment** — Resolved chat delays in PWA and Native apps by tying synchronizations directly to WebSocket activity and local SQLite write events. Aligned avatar and name columns on chat list rows. Suppressed intrusive Expo LogBox dev-client crash screens on transient network failures by using `console.warn` instead of `console.error`. Bumped Android versionCode to 143 (v1.1.29) and iOS buildNumber to 131.
- ✅ **Release v1.1.18: Post Context Metadata Caching** — Implemented local caching of marketplace post titles, status, photos, and credits inside local SQLite `conversations` and `marketplace_transactions` tables. This resolves empty/blank post details in inbox and deals history lists upon phone change restoration, since completed posts are not distributed in regular sync loops. Bumped Native client to v1.1.18 (Android versionCode 131).
- ✅ **Release v1.1.17: Given Review Editing & UX** — Added support to edit ratings and reviews directly from the profile's Given tab or active Deals cards. Reviews pre-populate stars and comments inside `ReviewModal` for immediate updates. Bumped Native client to v1.1.17 (Android versionCode 130, iOS build 125) with dynamic settings footer.
- ✅ **Release v1.1.16: Circulation Fee Rename, Green Zone & Solvency Dashboard** — Renamed "transaction tax" to "transaction fee" across native, PWA, and server ledgers. Added solvency transparency modals and 1.5% circulation fee warnings, alongside a 0% circulation fee "Green Zone" on balances between 0 and 200 Beans. Combined ledger tiers and marketplace trust counts. Resolved Android Out-of-Memory (OOM) crashes by enabling `largeHeap: true`.
- ✅ **Release v1.1.14: E2E Direct Message Encryption** — Shipped real end-to-end encryption for direct messages (Noise/X25519/AES-GCM), protecting chats from node administrator visibility (NAT-1). Added sent/read delivery receipt checkmarks in chats, lazy-loaded encrypted photo/camera attachments, and a visible E2E indicator on DMs. Bumped version to v1.1.14 (build 123/124).
- ✅ **Release v1.1.5: Native Tab Navigation & Safeguards** — Removed swipe-to-navigate gesture in native tabs to prevent layout conflicts, improved credit spectrum bar layout, and cleaned version positioning. Fixed server `setGuardian` to implicitly add friends, and excluded friend updates from generic signature spoof check gates. Bumped version to v1.1.5 (build 115).
- ✅ **Release v1.1.3: Low-Latency Escrow Settlements & Coalesced Trailing Syncs** — Shipped a massive client-side and background synchronization engine optimization, shrinking escrow settlement times to <1s, eliminating SQLite "database is locked" errors, and introducing real-time chat reactive updates.
  - **Zero-Lock Database Network fetches**: Moved all HTTP fetches completely out of critical database `acquireSyncLock()` mutex blocks in `syncMessages`, `syncSingleConversation`, and `createProject` in `utils/db.ts`. Sync locks are now held strictly during microsecond SQLite write transactions, preventing lock-blocking during network I/O.
  - **Coalesced Trailing Sync Cooldown**: Introduced a protective `2000ms` trailing sync cooldown throttle inside `requestSync()` in `pillar-sync.ts`. Successive rapid WebSocket event broadcasts (e.g., transaction updates, messages) are combined and executed in a single sync run, preventing infinite background sync storms.
  - **Hourly Directory Caching**: Optimized background synchronization payload volume by caching `/api/members` directory requests to 1-hour intervals, saving mobile CPU processing and network bandwidth during high-frequency sync cycles.
  - **Dynamic Chat State Reloading**: Integrated a `sync_data_updated` DeviceEventEmitter listener inside `chat/[id].tsx` to refresh conversation details and message logs in real-time, coupled with immediate `loadConversationData()` reloads on local Accept and Cancel escrow actions to completely eliminate frozen visual action cards.
  - **Fresh Listings Hiding & Dismissal**: Added scroll-aware auto-hiding and dynamic manual dismissal (tap-to-dismiss) to the Marketplace "Fresh Listings" social proof banner on the main Feed page in `index.tsx`.
  - **Native Version Release v1.1.3 (Build 112)**: Bushed native client release build v1.1.3 with incremental updates.
- ✅ **Release v1.0.88: Active/Passive Collision & Deadlock Warnings & Test Mirror Deployment** — Introduced high-visibility connection warnings, real-time push-on-write replication, safety reconciles, automatic tombstone pruning, and a 5th live node (Node 6 - Test Mirror) to the BeanPool federated network.
  - **Active/Passive Role Toggles & HUD Warnings**: Added Dialer (`enabled: true`) and Listener (`enabled: false`) roles that exchange enabled states on handshake. Automatically detects and overlays a red `⚠️ Collision` warning badge for dual active nodes and a yellow `⚠️ Deadlock` warning badge for dual passive nodes with clear inline instructions.
  - **Push-on-Write Real-Time Replication**: Upgraded state synchronization to perform real-time WebSocket delta event broadcasts (`/beanpool/sync/delta/2.0.0`) on database write, cryptographically signed using the node's Ed25519 private key and validated by the receiver.
  - **15-Min Reconcile & 24h Tombstone Pruning**: Shipped a robust 15-minute background full Merkle-tree state comparison safety net to repair dropped delta frames, paired with a 24-hour database garbage collector that prunes soft-deleted tombstones older than 30 days once downstream peers' cursors have synced past them.
  - **Test Mirror Node 6 Deployment**: Added `test-mirror.beanpool.org` (Node 6) as a real-time replica of Test (Node 5) on ports `8451/8083` and `4008/4009`, serving as a live mirror backup node.
- ✅ **Release v1.0.86: Self-Healing Stale Socket Drops** — Resolved the Yamux socket reference hang-up issue occurring after node restarts, preventing asymmetric handshake failures.
  - **Auto-Pruning & Active Hangup**: Implemented proactive catch-block connection purging in `connector-manager.ts` that detects failed P2P handshakes, clears connection status immediately, and forcefully terminates stale sockets (`p2pNode.hangUp`).
  - **Automated Reconnect Recovery**: Leveraged retry-loop dials on fresh sockets, restoring mutual trust handshake sync states bidirectionally in under 30 seconds of node boot.
- ✅ **Release v1.0.85: App Store Lookups & Secure WebSocket P2P Tunneling** — Completely decoupled the client and server release pipelines, and enabled stable bidirectional P2P mirroring for nodes behind Cloudflare Tunnels.
  - **Direct Store Queries**: Rewrote client version checking to hit unauthenticated public store APIs—Apple iTunes Search Lookup on iOS and regular expression matching on Google Play HTML scripts on Android—bypassing local node reliance.
  - **Decoupled Version Bumper**: Expanded `bump-version.mjs` with `--native` and `--server` split bumping flags, supporting dedicated Git tag namespaces (`native-v*`, `server-v*`) and custom commits to match review cycles.
  - **Subdomain WebSocket Routing**: Registered orange-clouded `p2p-mullum2.beanpool.org` CNAMEs routed through host-mapped ingress configs to local libp2p WebSocket ports.
  - **Secure WebSocket Multiaddress**: Migrated peer-connector setups to standard secure WebSocket (`wss`) format over port `443` to bypass Cloudflare inbound TCP restrictions.
- ✅ **Release v1.0.84: Mobile Diagnostics UI Fixes** — Fixed rendering bottlenecks and platform-specific path lookup issues.
  - **SQLite File Size Resolution**: Patched platform-aware DB path lookups (`getDatabaseFilePath`) in Android companion app to properly display SQLite file sizes.
  - **Remote Node URL Sanitization**: Resolved trailing slash anchor-query URL parsing bugs preventing direct comparison visual dashboards from displaying remote comparison data.
- ✅ **Release v1.0.83: Database Diagnostics Panel & Version Enforcement** — Shipped native SQLite structural diagnostics and community version gates.
  - **Integrity Checks & Counters**: Added active `PRAGMA integrity_check` scans and multi-table counters (Members, Posts, DMs, Txns) displaying database health indicators in settings.
  - **Minimum Version Enforcement**: Expanded Koa health endpoint with `minAppVersion` limits matched dynamically against local build versions on client boot to overlay updates prompt.
- ✅ **Release v1.0.82: Real-time Node Parity & Database Diagnostics** — Implemented client-side SQLite sync status indicators and resync mechanisms in Settings.
  - **Local/Remote Parity Indicator**: Displays dynamic status pills (`Healthy & Synced`, `Out of Sync`, `Offline / Local-First`) by comparing local SQLite table counts against remote node transactions, posts, and member totals.
  - **Resync Cache Clearing**: Hooked version throttling and dismissed update states into the "Clear DB Cache" settings action, allowing immediate refresh during testing.
- ✅ **Admin Log & Diagnostic Screen (Release v1.0.78)** — Built a secure, real-time administrative console and hardware resource monitoring dashboard for the BeanPool node settings panel.
  - **Security & Redaction**: Designed a multi-phase regex sanitization engine to strip BIP39 mnemonics, PEM private keys, plain passwords/secrets, and hex seeds before database write or WebSocket broadcast.
  - **Resource Telemetry**: Integrated a glassmorphic visual telemetry deck featuring circular CPU load gauge widgets (with pulsating HSL colors), linear RAM allocation bars, and real-time database/WAL file metrics.
  - **Interactive Terminal Feed**: Engineered a real-time event log viewer with category/level filters, instant text searches, pause/play scroll freeze controls, and console clears.
  - **Exporting Options**: Added support for exporting and downloading logs in both Plain Text (`.txt`) and Raw JSON (`.json`) formats.
  - **Alert Badges**: Implemented an automated background warning/error listener that updates a glowing badge counter next to the "Diagnostics & Logs" tab button in the header when the user is active on another settings tab.
- ✅ **Release v1.0.77: SQLite Database Restoration & "Never" Syncing** — Successfully restored the SQLite database state on `test.beanpool.org` using simulator datasets to recover 28 members, 21 posts, and 24 messages. Added a "Never (Disabled)" option to Directory settings, allowing admins to completely bypass periodic directory pushes.
- ✅ **Release v1.0.76: Settings Lockout Fix & Password Complexity** — Resolved Admin Settings CSP lockouts by explicitly permitting Leaflet, OpenStreetMap, and geocoding API domains (`https://unpkg.com`, `https://*.tile.openstreetmap.org`, `https://nominatim.openstreetmap.org`). Enforced high-entropy complexity rules (minimum 8 chars, mixed cases, digits, and special characters) validated dynamically on settings inputs, system boot, and API boundaries.
- ✅ **Production EAS Native Builds (v1.0.76-b97)** — Successfully compiled production Android app bundle (`beanpool-android-v1.0.76-b97.aab`) and iOS app bundle (`beanpool-ios-v1.0.76-b97.ipa`) using EAS, copying them to local and desktop build stores.
- ✅ **Global Mesh Node Deployment** — Automated and executed global mesh deployment of release `v1.0.77` using `deploy.sh` across all 4 nodes: `mullum1.beanpool.org` (Azure AU), `mullum2.beanpool.org` (Bare Metal), `review.beanpool.org` (Bare Metal), and `test.beanpool.org` (Bare Metal).
- ✅ **Sentinel Security Hardening & Deny-by-Default (Sentinel Sprint)** — Inverted the Koa server `requireSignature` auth filter to deny-by-default on all mutating endpoints (`POST`, `PUT`, `DELETE` under `/api/*`), eliminating opt-in vulnerabilities. Bound verified request keys to `ctx.state.actor` as the authenticated source of truth, and implemented precision spoof-checking with dynamic exclusions.
- ✅ **Auth Boundary Verifier Upgrades** — Shipped `scripts/verify-auth-boundary.mjs` verifying all 38 protected routes with 114 checkmarks (unsigned, wrong-key, spoofed-body vectors) against running servers to prevent regression.
- ✅ **Cryptographic P2P Sync Signature Engine** — Secured the peer-to-peer Merkle replication pipeline by signing outgoing state payloads with the node's libp2p Ed25519 private key, and verifying payload signatures before database writes. Added a standalone integration test `test-sync-signature.ts`.
- ✅ **Native Identity SecureStore & Clipboard Privacy** — Eliminated legacy plaintext `AsyncStorage` fallback lookup routines for user private keys in favor of hardware-backed Expo `SecureStore`, and resolved OS clipboard notification warnings by switching to a user-initiated paste action.
- ✅ **Client-side Signing Lockstep** — Signed the 4 key callsites affected by the expanded protect-list in the native app.
- ✅ **Monorepo Flat Linting** — Implemented monorepo-wide Flat config `eslint.config.mjs` to automate cleaner code standards.
- ✅ **Author Request Review Flow** — Enhanced deals management allowing sellers to review buyer requests with integrated messaging and standardized decline reasons.
- ✅ **Ledger UI Enhancements** — Corrected credit slider visual representation for negative balances and improved feedback for locked 'Send Credits' functionality.
- ✅ **Cross-platform Avatar Sync** — Implemented `bundled://` protocol for avatars, fixing missing pin icons and broken clustering on Android.
- ✅ **Native Quadratic Voting** — Restored native QV governance engine, CommonsInfoModal, voting stepper, and dual progress bars.
- ✅ **Sybil Hardening v3** — Implemented funnel detection, ghost velocity gate, and interactive audit filters.
- ✅ **Profile Completeness Enforcement** — Added server-side enforcement for profile completeness.
- ✅ **Onboarding UX Overhaul** — Refined into a friendly 3-step onboarding flow.
- ✅ **Haptic Feedback** — Phase 1 essentials implemented for native app interactions.
- ✅ **Admin Dashboard Reorganization** — Redistributed System tab settings to contextual tabs; fixed login ReferenceError.
- ✅ **Continuous Health Ping** — Added offline red dot indicator and continuous health ping to mobile app header, mapped using unique public keys to prevent UI collisions.
- ✅ **Sentinel Security Hardening** — Mitigated Stored XSS vulnerabilities across the Admin Dashboard and fixed Command Injection in server backup routines. Established `.jules/sentinel.md` as a continuous security audit journal.
- ✅ **Relational Filtering Optimization** — Fixed an O(N^2) performance bottleneck for array filtering on relational data elements.
- ✅ **PWA Accessibility** — Added missing ARIA attributes and labels to the WelcomePage inputs.
- ✅ **PWA Community Status Indicator** — Health popover on header tap showing node status, member count, and membership badge.
- ✅ **PWA Avatar Trust Badges** — Author avatars with initials fallback on marketplace cards and posts, navigating to public profile on click.
- ✅ **PWA People Page Parity** — Search filter, avatar circles, relative dates ("3d ago"), and 💬 message button on friend rows.
- ✅ **PWA Synonym-Expanded Search** — 417-entry synonym map enables marketplace discovery across related terms (e.g., "lemon" → fruit, citrus, produce).
- ✅ **PWA Blocked User Filtering** — Posts from blocked users hidden via `localStorage` blocklist.
- ✅ **PWA Security Settings** — Backup reminder card, private key viewer (reveal/hide + copy), wipe identity with double-confirm.
- ✅ **Native Invite Share Fix** — Share text now includes Node URL for manual invite code entry.
- ✅ **Decentralized Directory Auth** — Replaced hardcoded shared API keys with node-specific Libp2p Ed25519 cryptographic signatures and UTC timestamp verification to prevent spoofing and replay attacks.
- ✅ **Admin Node Restore** — Implemented system restoration via `.tar.gz` database upload for admins.
- ✅ **Offline Profile Healing** — Restored offline-first profile synchronization.
- ✅ **A11y & Stability** — Fixed P2P stream crash loops and applied accessibility improvements across components.
- ✅ **Sanitized Syncing** — Automatic filtering of synthetic "Visitor" and escrow accounts from local databases and UI elements.
- ✅ **Map Clustering Stabilization** — Patched `react-native-map-clustering` to prevent marker disappearance on iOS during zoom and scroll interactions.
- ✅ **Offline Queue** — Built native SQLite capability to draft and save marketplace posts whilst offline, syncing automatically when connection restores.
- ✅ **Database Backup & Reset Safeguards** — Streaming `tar.gz` database snapshot downloads via the System tab, plus type-to-confirm and backup prompts to protect against accidental node resets.
- ✅ **Admin Branch Stats** — Inline stats chips (posts, msgs, deals) and expandable branch aggregate cards in the Audit tree, optimized with a single-pass SQL query.
- ✅ **Map Centering & Location Fixes** — Map now centers dynamically on the node's configured `serviceRadius` (defaulting to Mullumbimby), and Leaflet async "ghost pin" leak bugs were resolved.
- ✅ **People Tab** — replaced Invite tab with Friends, Community browser, Invites, Guardians
- ✅ **12-Word Seed Phrase** — BIP-39 mnemonic generation + deterministic Ed25519 key derivation
- ✅ **Recovery Mode** — enter 12 words + callsign to restore identity on any device
- ✅ **Landing Page Welcome Hub** — 3 clear paths (join, transfer, recover) + admin contact info. Newsletter signup using insert bypassed RLS constraints.
- ✅ **Admin Community Config** — name, email, phone in Settings → Community tab
- ✅ **Social Recovery (3-of-N)** — Cryptographically secure identity recovery mechanism requiring quorum approval from trusted friends. Includes Guardian Knowledge Check to prevent spoofing and a 24-hour security cooldown.
- ✅ **Native App (Expo)** — 7-tab React Native companion app achieving PWA parity: Map, Projects, Market (14 categories), Chat, People, Ledger, Settings
- ✅ **Native SQLite + SecureStore** — local data persistence and self-managed identity storage on device
- ✅ **Community Projects Tab** — native-only crowdfunding feature with progress tracking, atomic editing, and destructive rollback for escrow.
- ✅ **Marketplace Deals Hub** — Sync'd 1-step (Offers) and 3-step (Needs) atomic escrow handshake logic across both Native and PWA.
- ✅ **Smart CRM Inbox** — Converted messaging interfaces natively and functionally into transactional Deal tracking hubs (All/Transactions/Direct) with inline Object Attribution identifying post title and status parameters.
- ✅ **Moderation Centre** — Admin dashboard with reported posts, health-flagged wash trading (self-dealing, circular, rapid reciprocation), batch post operations, and member audit with client-side pagination (25/page).
- ✅ **Software Update Notifications** — Docker Desktop-style header badge, server-side GitHub polling, configurable auto-check interval (Hourly/6h/Daily/Weekly), copy-to-clipboard update instructions.
- ✅ **CI/CD Release Pipeline** — GitHub Actions auto-builds Docker images on `v*` tags, auto-creates GitHub Releases, injects version from git tag (no manual package.json bumps).
- ✅ **Deploy Model: Pull vs Build** — `deploy.sh` switched from `docker compose build` to `docker compose pull`, eliminating 2-5 min server-side compilation.
- ✅ **Admin Settings Extraction** — Moved all settings JS from inline `<script>` to standalone `static/settings.js` for maintainability.
- ✅ **Push Notifications** — Expo push token registration, DM/marketplace deal alerts, per-member notification preferences.
- ✅ **Guest Mode** — multi-node onboarding with membership probe endpoint, guest UI indicators in native and PWA headers.
- ✅ **Map Phase 6** — pin clustering, modern markers with category icons, elder glow effects for founding members (PWA + Native).
- ✅ **Marketplace UX Modernization** — horizontal category chips, author trust badges, active deals tracking (PWA + Native).
- ✅ **FTS5 Full-Text Search** — marketplace search with synonym mapping across titles, descriptions, and categories.
- ✅ **Directory Publisher** — nodes push metadata to beanpool.org Supabase global directory.
- ✅ **Community Search** — search and infinite scroll on the People/Community member list (native).
- ✅ **Escrow Demurrage Exemption** — escrow wallets exempt from circulation decay with DB persistence fix.
- ✅ **Self-Healing DB Migrations** — auto-repair corrupted ratings table schema on startup.
- ✅ **iOS Crypto Polyfill** — SHA-512 and Ed25519 signing polyfilled for iOS via `expo-crypto`.
- ✅ **Commons Demurrage Persistence** — COMMONS_BALANCE now persists to `accounts` table, restored on startup, saved every 5 min + on every transfer.
- ✅ **Project System Unification** — Admin Commons UI now reads from the live `projects` SQL table instead of deprecated JSON config blob.
- ✅ **Profile Photo Server Sync** — Profile updates (including avatar) now push to server and propagate to all devices via sync.
- ✅ **Android Marker Pipeline** — Pre-rendered PNG map markers via `react-native-view-shot` delivered through Google Maps `BitmapDescriptor`, eliminating Android JSX snapshot clipping. Cluster counts pre-rendered 2–99 with "99+" overflow.
- ✅ **Profile Navigation Consistency** — Author names and avatars are tappable across all marketplace surfaces (cards, map preview, community list, projects), navigating to Trust Profile with correct data params.

---

## 🔴 Critical / High Priority

> These items represent data integrity risks, security gaps, or significant UX blockers for real users.

### Identity & Security

- [ ] 🔴 **View Recovery Phrase** — Show stored 12-word phrase in Settings for existing mnemonic-based identities. _Users currently have no way to see their seed words after initial creation. If they didn't write them down, identity loss is permanent on device failure._ **Note:** PWA now has a private key viewer as a partial mitigation.
- [x] 🔴 **Identity Backup Reminder** — Prompt users to export their identity if they haven't yet. _Implemented in PWA Settings as an amber warning card._
- [ ] 🔴 **Ban / Revoke Member (Enforcement)** — `adminSetUserStatus('disabled')` exists but doesn't actually block transactions or posting. Disabled members can still transact. _Need to enforce status checks in transfer/post/messaging pathways._
- [ ] 🔴 **`/api/invite/redeem*` Proof-of-Possession** — Implement a cryptographic challenge-response check on the supplied `publicKey` during invite redemption to ensure the client actually holds the corresponding private key.
- [ ] **Visitor Account Audit** — Investigate signup flow for ghost/unnamed accounts; consider enforcing mandatory profile info or redirecting to profile settings on first login.
- [ ] 🟡 **PWA sendRemoteTransfer unsigned POST** — Fix long-standing bug where the PWA client posts to `/api/ledger/transfer` without signature headers.

### Data Lifecycle & Storage

- [ ] 🔴 **Photo Size Limits** — No upload size enforcement exists. Large base64 images (including profile avatars) are stored as-is, creating unbounded storage growth and sync payload bloat.
- [ ] 🟡 **Stale Post Archival** — Auto-archive posts older than X days (configurable), remove photos to free disk space. _Without this, node storage grows indefinitely._
- [ ] 🟡 **Post Completion Cleanup** — When a need/offer is fulfilled, delete associated photos after a grace period (7 days).
- [ ] **Photo Compression Pipeline** — Server-side image optimisation for marketplace post photos.
- [ ] **Message Retention Policy** — Auto-prune old messages/conversations beyond a configurable age.
- [ ] **Storage Dashboard** — Show total data/photos disk usage in admin System tab with warnings.

---

## 🟡 Important

### Governance & Credits

- [ ] 🟡 **Mobile Voting UI** — Native app interface for community members to vote on funding rounds. _Admin voting UI exists in settings.html, but phone users cannot currently participate in governance — this is a major participation gap for a community currency._
- [ ] **Self-Healing Profile Synchronization** — Enable correct promotion of Visitor accounts to full member state when recovering locally before connecting to the node.

### Identity & Security

- [x] **Sign Out / Wipe Identity** — `wipeIdentity()` implemented in native app Settings with type-to-confirm safeguard and full state cleanup. PWA equivalent added with double-confirm → `localStorage` clear → page reload.

---

## Backlog

### Marketplace

- [x] **Database Migration (SQLite)** — Replaced JSON state engine with `better-sqlite3`. Includes relational constraints and paging limits.
- [ ] **Trade Safety — "Let a guardian know" buddy nudge** — One-tap action at the in-person meeting moment (escrow funded) to share a trade's details (item, peer, rough time) to a chosen friend/guardian DM. Deferred for now — the community is largely closed/low-risk and members can message someone manually; revisit if the network opens up. Pairs with the at-trade risk gate + trust-profile work (mutual connections, vouched-in, completion rate, proportional caution).

### Network & Federation

- [x] **Federation Protocol — Phase 1** — Trust levels (mirror/peer/blocked), CORS, `/api/node/info`
- [x] **Federation Protocol — Phase 2** — Remote marketplace browsing, Connected Communities UI, node badges
- [x] **Federation Protocol — Phase 3** — Cross-node trading (Accept Offer on remote node) with Libp2p identity verification
- [x] **Federation Protocol — Phase 4** — Cross-node E2E messaging and mesh fund validation over authenticated Noise streams
- [x] **Offline Queue** — Queue posts/transactions/messages when offline, replay on reconnect (save pending_upload to SQLite)
- [ ] **Federation (Native)** — remote marketplace browsing on native

### Governance & Credits

- [x] **Transaction History Export** — Implemented `/api/ledger/export` CSV generation on Web and Native environments.

### Native App

- [x] **7-Tab Native Interface** — Map, Projects, Market, Chat, People, Ledger, Settings with neon-vine branded tab bar
- [x] **Native Identity Flow** — self-managed identity creation and 12-word recovery via Expo SecureStore
- [x] **Native SQLite Persistence** — `expo-sqlite` for posts, projects, messages, ledger
- [x] **Marketplace (14 categories)** — grid/list view, search, category filter, user blocking
- [x] **Community Projects** — crowdfund proposals with progress bars and funding badges
- [x] **Pillar Toggle MVP** — Background Merkle sync service for Android/iOS (Expo)
- [x] **Live Inbox Parity** — SQLite E2E text decryption, Background Sync Mutex Locking, & Native Tab Unread Badges
- [x] **Bean Ratings (Native)** — port 🫘 rating system to native app
- [x] **Abuse Reporting (Native)** — port reporting UI to native app
- [x] **Push Notifications** — Message and trade alerts via Expo Push Notifications
- [x] **App Store & Play Store Submission** — Published/built for both stores (v1.0.76, build 97).

## 🚀 Proposed Advanced P2P Upgrades (Mesh Hardening)

These represent next-generation design specifications for decentralized, federated mutual credit:

- [ ] **Stellar Hybrid Anchor Auditing (State Commitment)** — Immutably lock local database Merkle root hashes (MST roots) to the public Stellar ledger every 10–60 minutes. Utilizes a single node-level account secured by a 2-of-3 multi-signature quorum (Server Node + 2 elected Guardians) to prevent unauthorized database tampering (like direct SSH SQL edits) whilst preserving $0$ user gas fees, no-KYC onboarding, and full offline trading capability.
- [ ] **Ethereum Swarm Decentralized Backup (MetaProvide Integration)** — Run nightly, fully encrypted SQLite database backups uploaded directly to decentralized storage (Ethereum Swarm via MetaProvide's HejBit/IPSH gateway), anchoring the encrypted backup hash URI to the public Stellar ledger. Enables complete, zero-data-loss server restoration in the event of a catastrophic hosting failure.
- [ ] **FolkPass Selective Disclosure Identity & Web-of-Trust Quorums** — Implement a privacy-preserving digital identity standard where members' real names, biometric passport details, and physical credentials are stored strictly local-first on mobile devices (Expo SecureStore). The public global directory (Stellar/Swarm) only registers cryptographically blinded, high-entropy salted hashes (e.g., `SHA256("Real Name" + Salt)`) co-signed by a 3-of-N quorum of local community Elders. Enables real-name peer-to-peer verification (via secure local NFC/QR tap) while preventing bulk directory crawling and profile scraping.
- [ ] **Multi-Sig Peer Arbitration & Crowd Juries** — Safe resolution mechanism for disputed escrow transactions. Neutral, high-trust Stewards/Elders can act as temporary peer jurists to release or refund escrows without admin centralization.
- [ ] **Double-Signed Cryptographic Offline Receipts** — Tamper-evident face-to-face offline transactions. Alice and Bob perform a 2-way scan handshake to generate an Ed25519-signed proof-of-transaction, guaranteeing that offline SQLite logs cannot be altered.
- [ ] **Topographical Web-of-Trust Throttling** — Advanced Sybil-resistance utilizing topographical path-diversity algorithms (e.g. EigenTrust/SybilLimit). Collusive puppet rings are identified by graph bottlenecks, capping their dynamic credit floor.
- [ ] **Zero-Knowledge Multi-Hop Credit Routing** — Ripple/Lightning-style routed transactions over federated node trust-lines. Enables cross-node transfers across nodes without direct mirror/peer synchronization.
- [ ] **Algorithmic Demurrage Tuning** — Dynamic circulation value decay (holding fees) calculated based on currency velocity to self-stabilize the P2P economy organically.

---

_Suggestions? Open an issue or discuss with your node admin._
