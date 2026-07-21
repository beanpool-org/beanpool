# BeanPool

> A decentralized mutual credit protocol for independent communities.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Status: Beta](https://img.shields.io/badge/Status-Beta-emerald.svg)]()

---

## What is BeanPool?

BeanPool is an open protocol for building a **post-extraction economy**. It connects communities through a decentralized mutual credit system where value is created through cooperation, not extraction. Nodes gossip state over a libp2p mesh, automatically applying progressive circulation (value decay) to prevent hoarding and fund a community Commons pool.

**Live network:** [mullum1.beanpool.org](https://mullum1.beanpool.org) · [mullum2.beanpool.org](https://mullum2.beanpool.org:8447) · [review.beanpool.org](https://review.beanpool.org:8445) · [test.beanpool.org](https://test.beanpool.org) · [test-mirror.beanpool.org](https://test-mirror.beanpool.org:8451) — federated via peer connectors with cross-community marketplace browsing and cryptographically secure Libp2p mesh trading.

---

## Features

### 💚 Community Status Indicator
Tap the header logo/title in the PWA to reveal a health popover:
- **Online/Offline** status (green/red pulse) fetched from `/api/community/health`
- **Node hostname**, member count, post count
- **Membership status** — Guest or Member badge

### 🗺️ Community Map
Full-screen Leaflet/OSM map as the landing page:
- **Light mode** (default) using a beautiful slate-blue dusk theme with CartoDB Positron 🌙
- **GPS crosshair** with pulse-animated purple user marker
- **Marketplace pins** — category emoji icons, colour-coded offers (blue) / needs (orange)
- **Tap pin → popup → "View in Market →"** navigates directly to the post detail view
- **Pin-drop posting** — tap the map to choose a location when creating a new post

### 🤝 Marketplace
13-category peer-to-peer bazaar:
- Create posts (offer/need, category, title, description, Beans pricing, location pin, up to 3 photos)
- **Branching Escrow Handshake** — Atomic smart-contract style settlement:
  - **Needs (3-step):** Requesters bid on jobs → Author approves → Escrow locks → Author releases funds on completion.
  - **Offers (1-step):** Requesters accept → Escrow immediately locks → Requester releases funds on completion.
- Filter by type, category dropdown, and **"My Market"** segment controls for inbound requests and active deals.
- **Post photos** — up to 3 photos per post, auto-resized to 400px, primary photo on tiles
- **Post validation** — all fields required, red glow on empty fields, location must be set
- **Post detail view** — Deals Hub UI parsing Payer/Payee roles for Escrow Settlement
- **💬 Message** — opens a DM with the author directly from the post (cross-node messages route securely over the Libp2p mesh)
- **🫘 Rate** — rate the author 1-5 beans with optional comment
- **🚩 Report** — report abuse with reason dropdown

### 🫘 Bean Reputation System
Community trust through bean ratings:
- **5-bean rating** with optional comment (one rating per rater-per-target, updatable)
- **Review Editing**: Option to edit reviews directly from the profile's Given tab or My Deals card, with pre-populated stars and comments inside `ReviewModal`.
- **Bean display** on marketplace tiles (`🫘🫘🫘○○`) and post detail view
- **Always visible** — shows `○○○○○ No ratings yet` for unrated members
- **Rate button** in post detail — "🫘 Rate {name}" opens picker + comment form

### 🚩 Abuse Reporting
Flag bad actors for admin review:
- **Report button** in post detail view
- **Reason dropdown**: Spam/scam, Offensive content, Misleading info, Harassment, Other
- **Admin panel** in Settings → "🚩 Abuse Reports" — view all reports with reporter, target, reason, date

### 💬 E2E Messaging & Smart CRM Inbox
DMs and group chats with real E2E encryption and transaction context:
- **Smart CRM Inbox** — Message threads automatically link to their parent Marketplace post, displaying the active title and Object Status (Active/Escrow/Completed). 
- **Unified Inbox** — Drop redundant tab filters to provide a single, streamlined conversations list.
- **Direct messages** — tap any member or use "Message" from a post detail (cross-node DMs are authenticated via PeerID Noise streams)
- **Group chats** — create named groups with multiple members
- **E2E Encryption**: Real end-to-end encryption for direct messages (Noise/X25519/AES-GCM) protecting chat content from server visibility (NAT-1).
- **Sent/Read Receipts**: Sent and read receipt indicators on direct messages.
- **Encrypted Photo Attachments**: Support for encrypted camera/photo attachments in direct messages, lazy-loaded on the client.

### 💾 SQLite Post Context Caching
Preserve conversation and transaction contexts on restoration:
- **Local SQLite Caching**: Metadata (titles, status, cover photos, credits) is cached directly in client-side `conversations` and `marketplace_transactions` tables.
- **Phone Change Recovery**: Ensures active thread contexts and deals history show correct titles and photos when restoring an identity, even when completed posts are no longer sent in active sync payloads.

### 🎟️ Invite Tree
Invite-only membership with hierarchical accountability:
- **Node genesis** — the server admin is the root of the tree, generating seed invite codes from Settings
- **Admin's personal identity** — admin uses a seed code on their own phone, then invites organically
- **Single-use invite codes** — each code works once, creating a branch in the tree
- **QR + share** — copy invite code or share via QR
- **Online check** — notifies user if offline when generating codes
- **Invite tree** — full hierarchy of who invited whom

### 👥 People & Friends
Community connections and guardians:
- **Friends** — add/remove friends from the community browser, with avatar circles and 💬 message button
- **Community** — browse all node members with **search filter**, avatar circles, and relative date formatting ("3d ago")
- **Invites** — generate and share invite codes (moved from standalone tab)
- **Guardians** — select up to 5 trusted friends as recovery guardians

### 🔑 12-Word Seed Phrase
Deterministic identity from a BIP-39 mnemonic:
- **New signups** generate a 12-word recovery phrase (128-bit entropy)
- **Deterministic Ed25519** — same words always regenerate the same keypair
- **One-time display** — words shown after creation with "I've written these down" confirmation
- **Recovery mode** — enter 12 words + callsign to restore identity on any device
- **WebCrypto SHA-256 + PKCS8** — no external crypto dependencies

### 🛡️ Social Recovery (3-of-N)
Cryptographically secure identity recovery without central admins:
- **Guardian Selection** — Select 3 to 5 trusted friends as recovery guardians.
- **Guardian Knowledge Check** — Initiators must know a guardian's exact callsign to prevent spam.
- **Quorum Approval** — Requires 3 guardians to approve the recovery request.
- **Atomic Migration** — Old identity data (posts, friends, balances) seamlessly migrates to a newly generated 12-word seed.
- **24-Hour Cooldown** — Security buffer to allow users to cancel fraudulent recovery attempts.

### 🏠 Landing Page (Welcome Hub)
Port 80 serves a community welcome hub:
- **Three clear paths**: New member (invite code), Add another device (transfer link), Lost device (recovery)
- **App Store Badges**: Quick links to download the native iOS and Android apps
- **Newsletter Signup**: Supabase Auth integration to capture early interest and email subscriptions
- **Dynamic content** — pulls community name, admin email/phone from node config
- **FAQ accordion** — common questions with expandable answers
- **Contact section** — configurable admin contact info

### 👤 Member Profiles
- **Avatar** with separate Camera / Gallery upload buttons
- **Editable callsign** — change your display name anytime (blue highlighted field with ✏️ icon)
- **Bio and contact details** with 3-tier visibility (hidden / trade partners / community)
- **Online check** — alerts user to connect before saving profile changes
- Profile shown in post detail views and messaging

### 📊 Ledger
Mutual credit balance and transaction history:
- **Send credits** to other members with member picker
- **Balance gauge** with dynamic credit floor (see [Protocol Rules](docs/protocol-rules.md))
- **Commons Pool** display (funds from progressive circulation)
- **Transaction history** with sent/received indicators
- **Solvency Transparency**: Interactive modals showing community-wide ledger solvency statistics.
- **Tax/Fee Notices & Green Zone**: Detailed 1.5% circulation fee notices and a 0% circulation fee "Green Zone" on balances between 0 and 200 Beans.
- **Transaction Fee Renames**: Renaming of "transaction tax" references to "transaction fee" across ledger components.

### 💚 Community Health Dashboard
Admin insights in Settings page:
- **Stats grid** — members, tree depth, 7/30-day transactions, active/inactive counts, commons balance
- **Widest branch** — who has the largest invite tree
- **Flags** — automated health alerts (wash trading detection, rapid circulation, zero-balance)
- **Refreshable** with one click

### 🛡️ Moderation Centre
Comprehensive admin dashboard for node safety:
- **Reported Posts** — review abuse reports with author profiles, reason, and one-click navigation
- **Health-Flagged Posts** — automated wash-trading detection (self-dealing, circular trading, rapid reciprocation)
- **Batch Operations** — select multiple posts and bulk-remove with escrow-safe refunds
- **Member Audit** — search and browse all community members with post counts and join dates
- **Client-side pagination** — 25 posts per page for nodes with thousands of listings
- **Inbox member cap** — "Show all members" toggle capped at 50 to prevent DOM overflow

### 🔄 Software Update Notifications
Docker Desktop-style update detection built into each node:
- **Header badge** — pulsing blue "v1.0.38 available" link next to version number
- **Update panel** — version comparison, release notes, "How to Update" code block with copy button
- **Auto-check** — configurable interval (Hourly / Every 6 hours / Daily / Weekly)
- **Server-side polling** — background timer checks GitHub Releases API every 6 hours
- **Notification-only** — admin runs `docker compose pull && docker compose up -d` manually

### 🔗 Independent Connectors + Federation
Node-to-node trust relationships with 3 levels:
- **`peer`** — cross-community federation: browse remote marketplace, trade across nodes
- **`mirror`** — complete data replication (backup/disaster recovery)
- **`blocked`** — deny API access from this node

### 🌐 Cross-Community Federation
Nodes connected as **peers** enable:
- **Remote marketplace browsing** — PWA queries remote node's API directly
- **Connected Communities UI** — pill bar to switch between 🏠 Home and 🌐 peer marketplaces
- **Session cache** — 5-minute cache for instant toggling between communities
- **Node badges** — 🌐 badges on remote posts to show their origin

### 🔄 Mirror State Sync
Automatic state synchronisation between `mirror`-trusted nodes:
- **Push-on-Write Real-Time Replication** — State updates instantly trigger delta event broadcasts over secure WebSockets `/beanpool/sync/delta/2.0.0`
- **Cryptographic Signatures** — payloaddeltas are signed using the node's private libp2p Ed25519 key and validated by the receiver before DB writes
- **Merkle hash comparison** — only syncs full payloads when state differs
- **15-minute Safety Reconcile** — periodic safety net re-compares the full Merkle tree, catch-up-syncing past dropped delta frames
- **24-hour Tombstone GC** — automatic garbage collection prunes deletion tombstones older than 30 days relative to downstream peer cursors
- **Origin tracking** — posts carry their source node ID

### 🔒 Privacy (4-Tier Location Model)
| Tier | Emoji | GPS Usage | What's Shared |
|------|-------|-----------|---------------|
| Ghost *(default)* | 👻 | None | Nothing — manual pin drop |
| Post-Only | 📍 | Once per post | Location at posting time |
| Zone | 🔵 | On app open | Fuzzed ±2km, session-stable |
| Live | 🔴 | Real-time | Exact, foreground only |

### 📲 PWA Install
Install banner with device-specific instructions:
- **Android Chrome** → native `beforeinstallprompt` one-tap install
- **iPhone Safari** → Share → Add to Home Screen steps
- Bean icon on home screen, full-screen standalone mode

### 🛡️ Gateway Configuration & Self-Protection
Node-enforced security controls in `local-config.json`:
- **CORS Allowed Origins**: Restrict API calls to explicit frontend domain whitelists for detached PWA / desktop clients.
- **Admin IP Allowlist**: Restrict `/settings` and `/api/local/admin/*` access to specified client IPs/CIDRs.
- **Rate Limiting**: Sliding window per-IP request throttles for API endpoints.
- **Subsystem Feature Toggles**: Dynamic 503/530 interceptors for `servePwa`, `marketplace`, `messaging`, `federation`, and `invites`.

### 🌐 Detached PWA & Sovereign Node Connection
- **Configurable API Target**: PWA can be hosted on any static server or CDN (e.g., `https://app.beanpool.org`) while targeting any sovereign node API (`getNodeApiUrl()`).
- **Dynamic WebSockets**: Automatic `wss://` / `ws://` endpoint derivation (`getNodeWsUrl()`).
- **Connection Manager**: Interactive node tester & target selector in PWA Settings → Advanced.

### 🎮 Fleet Manager (`apps/manager`)
Multi-node control plane for community operators:
- **Stateless Architecture**: Operates strictly as a client over node REST/WS APIs (`/api/local/admin/*`, `/ws/logs`).
- **Shared Engine Integration**: Reuses `@beanpool/engine` on the frontend for Merkle state hash calculations, trust scores, and audit parsing.
- **Multi-Node Switching**: Connect and monitor multiple sovereign nodes from a single dashboard.
- **Hardware Telemetry & Live Logs**: Real-time CPU, RAM, SQLite DB/WAL sizes, libp2p peer counts, and log streaming.

---

## Monorepo Structure

```
beanpool/
├── apps/
│   ├── server/        # Sovereign Node Appliance — Koa REST API, gateway, PWA host, libp2p mesh (routes/, services/, config/, engine/)
│   ├── pwa/           # PWA — map, marketplace (13 categories), messaging, ledger (Vite + React + Leaflet)
│   ├── native/        # Native App — 7-tab mobile client (Expo + React Native), SQLite, background sync
│   └── manager/       # Fleet Manager — Decoupled multi-node control plane (Vite + React + @beanpool/engine)
├── packages/
│   ├── beanpool-engine/# Shared node engine: DB-backed business logic (members, trust, escrow, posts, messaging, sync, audit)
│   └── beanpool-core/  # Shared protocol constants: Ledger, Merkle, Passport, Governance
├── scripts/           # Utility and verification scripts (incl. verify-auth-boundary.mjs)
├── branding/          # Bean icon assets (16x16 → 512x512)
├── docs/              # Architecture vision, assessment, and setup guides
├── Dockerfile         # Multi-stage build (accepts APP_VERSION build arg from CI)
├── docker-compose.yml # Docker orchestration
└── deploy.sh          # Deploy to live nodes via SSH — pulls pre-built GHCR image
```

---

## Quick Start

### Run a BeanPool Node (Docker)

BeanPool is distributed as a **Universal Docker Container** via the GitHub Container Registry. It natively supports:
- **Intel/AMD** (Standard servers, Mini PCs)
- **ARM64** (Raspberry Pi, Apple Silicon, ARM NAS drives)
- **TrueNAS Scale / Kubernetes** (runs smoothly as a non-root user via `PUID`/`PGID` variables)

```bash
git clone https://github.com/beanpool-org/beanpool.git
cd beanpool
docker compose pull
docker compose -p beanpool up -d
```

#### Updating an Existing Node

```bash
cd ~/beanpool
docker compose pull
docker compose up -d
```

> Your data is preserved in `./data/` — only the application container is replaced.

- **PWA:** `https://localhost:8443/` — community map, marketplace, messaging, ledger
- **Landing Page:** `http://localhost:8080/` — community welcome hub (3 paths: join, transfer, recover)
- **P2P Mesh:** TCP `:4001` / WS `:4002`

> 📖 For detailed setup instructions (including Let's Encrypt, no-domain options, and High-Availability mirrors), see [apps/server/README.md](apps/server/README.md).

### Development

```bash
pnpm install
cd packages/beanpool-core && pnpm build   # Build shared core first
cd apps/pwa && pnpm build                 # Build PWA → apps/server/public/
cd apps/server && pnpm dev                # Start BeanPool Node with hot reload
```

Or build everything at once:

```bash
pnpm build   # Builds all packages via Turborepo
```

---

## REST API

All endpoints are served on port 8443 (HTTPS):

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/community/info` | GET | Community stats (members, posts, transactions) |
| `/api/community/register` | POST | Register new member (publicKey + callsign) |
| `/api/community/members` | GET | List all members |
| `/api/community/health` | GET | Community health dashboard data |
| `/api/invite/generate` | POST | Generate a single-use invite code |
| `/api/invite/redeem` | POST | Redeem an invite code to join |
| `/api/invite/tree` | GET | Full invite hierarchy |
| `/api/profile/update` | POST | Update member profile (avatar, bio, contact) |
| `/api/profile/:publicKey` | GET | Get a member's profile |
| `/api/ledger/balance/:publicKey` | GET | Get balance, floor, commons |
| `/api/ledger/transfer` | POST | Send credits (from, to, amount, memo) |
| `/api/ledger/transactions` | GET | Transaction history |
| `/api/marketplace/posts` | GET | List marketplace posts (filterable) |
| `/api/marketplace/posts` | POST | Create a new post (with optional photos) |
| `/api/marketplace/posts/update` | POST | Edit a marketplace post |
| `/api/marketplace/posts/remove` | POST | Remove a post (safely refunds atomic escrow) |
| `/api/marketplace/posts/request` | POST | Request to buy a need-type post (3-step escrow) |
| `/api/marketplace/posts/accept` | POST | Accept an offer-type post (1-step escrow) |
| `/api/marketplace/posts/pause` | POST | Pause active marketplace post |
| `/api/marketplace/posts/resume` | POST | Resume paused marketplace post |
| `/api/marketplace/transactions` | GET | List marketplace deal transactions for a member |
| `/api/marketplace/transactions/approve` | POST | Approve a pending transaction request |
| `/api/marketplace/transactions/reject` | POST | Reject a pending transaction request |
| `/api/marketplace/transactions/cancel-request` | POST | Cancel a submitted transaction request |
| `/api/marketplace/transactions/complete` | POST | Confirm delivery and release escrow |
| `/api/marketplace/transactions/cancel` | POST | Cancel an active transaction and refund escrow |
| `/api/crowdfund/projects` | GET/POST | List or create community crowdfund projects |
| `/api/crowdfund/projects/update` | POST | Edit a live crowdfund project |
| `/api/crowdfund/projects/delete` | POST | Destructive rollback + atomic escrow refund |
| `/api/ratings` | POST | Submit or update a bean rating |
| `/api/ratings/:publicKey` | GET | Get ratings and average for a member |
| `/api/reports` | POST | Submit an abuse report |
| `/api/admin/reports` | POST | List all abuse reports (admin auth required) |
| `/api/local/admin/backup` | POST | Stream a complete `state.db` snapshot and config as `.tar.gz` |
| `/api/local/admin/restore` | POST | Restore system state from an uploaded `.tar.gz` backup archive (uses `X-Admin-Password` header) |
| `/api/messages/conversation` | POST | Create a DM or group conversation |
| `/api/messages/send` | POST | Send a message |
| `/api/messages/conversations/:pubkey` | GET | List conversations for a member |
| `/api/messages/messages/:conversationId` | GET | Get messages in a conversation |
| `/api/messages/mark-read` | POST | Mark a conversation as read |
| `/api/friends/:publicKey` | GET | List a member's friends |
| `/api/friends/add` | POST | Add a friend |
| `/api/friends/remove` | POST | Remove a friend |
| `/api/friends/guardian` | POST | Set/unset a friend as recovery guardian |
| `/api/recovery/request` | POST | Submit a new social recovery migration request |
| `/api/recovery/approve` | POST | Approve a recovery request as a guardian |
| `/api/recovery/reject` | POST | Reject a recovery request as a guardian |
| `/api/recovery/cancel` | POST | Cancel a recovery request as the target member |
| `/api/members` | GET | List all community members |
| `/api/community/membership/:publicKey` | GET | Probe whether a public key is a member of this node |
| `/api/push-tokens` | POST | Register an Expo push notification token |
| `/api/members/preferences` | GET/POST | Get or set notification preferences per member |
| `/api/invite/mine/:publicKey` | GET | List invite codes generated by a specific member |
| `/api/invite/redeem-offline` | POST | Redeem a cryptographic offline invite ticket |
| `/api/ledger/export` | GET | Export full transaction ledger as CSV |
| `/api/local/community-info` | GET | Community name, admin email/phone (public) |
| `/api/version` | GET | Current version, build info, cached update status |
| `/api/admin/check-update` | POST | Check GitHub for newer releases (admin auth) |
| `/api/admin/thresholds` | POST | Update protocol thresholds (admin auth) |
| `/api/admin/thresholds/get` | POST | Read current thresholds (admin auth) |
| `/api/commons/balance` | GET | Get the current Commons pool balance |
| `/api/commons/projects` | GET/POST | List or create governance voting projects |
| `/api/commons/projects/update` | POST | Edit a voting project |
| `/api/commons/projects/delete` | POST | Delete a voting project |
| `/api/commons/my-credits/:pubkey` | GET | Get available Quadratic Voting credits |
| `/api/commons/vote` | POST | Cast votes for a project (Quadratic Voting) |
| `/api/commons/rounds` | GET | List voting rounds |
| `/ws` | WebSocket | Real-time state feed |

---

## Port Architecture

| Port | Protocol | Purpose |
|------|----------|---------|
| **4001** | TCP | libp2p P2P mesh |
| **4002** | WS | libp2p WebSocket transport |
| **8080** | HTTP | HTTP → HTTPS redirect (LAN: QR trust bootstrap) |
| **8443** | HTTPS | Landing page (`/`), PWA (`/app`), Settings, REST API, WebSocket |

---

## The Protocol

> 📖 Full specification: **[Protocol Rules](docs/protocol-rules.md)** — the complete rule book for the BeanPool Social Capital Ledger.

- **Mutual Credit** — participants can go negative, backed by community trust. No money supply — the network sum is always zero.
- **Dynamic Credit Floor** — borrowing limit grows with trade history: `floor = -80 - min(1920, trades×8 + partners×40 + age×2)`. New members start at −80 Beans, veterans cap at −2000 Beans.

- **Reference Rate** — 40 Beans = 1 hour of community time. Hour equivalents shown throughout the app for value intuition.
- **Identity Tiers** — Ghost 👻 → Resident 🏠 → Steward 🏛️ → Elder ⛰️. Ghosts can only trade via marketplace escrow; no direct transfers, no invitations.
- **Anti-Sybil (KYH)** — Know Your History, not KYC. Three layers: Ghosts can't gift (friction), Ghosts can't invite (chain-break), diverse partner requirement (no wash-trading).
- **Community Circulation (Progressive Brackets)** — positive balances decay progressively based on abundance (0.5% up to 2.5% per month), returning to the Commons Pool
- **Gossip Mesh** — nodes connect via libp2p over TCP/WebSockets
- **Federation Protocol** — peer nodes share protocol constants; cross-community trading via CORS + API
- **Mirror Sync** — Merkle hash comparison + delta exchange every 15 minutes (backup nodes only)
- **Self-Managed Identity** — Ed25519 keypairs from 12-word BIP-39 mnemonic (deterministic, recoverable)
- **Invite Tree** — hierarchical membership: node genesis → seed codes → admin identity → organic invites
- **Handshake Protocol** — mutual trust verification + latency measurement via yamux streams
- **Bean Reputation** — 5-tier community trust score with comments
- **Abuse Reporting** — flagging system with admin review panel

---

## Project Documentation

| Document | Description |
|----------|-------------|
| [README.md](README.md) | Project overview, features, API table |
| [Protocol Rules](docs/protocol-rules.md) | **The Social Capital Ledger rule book** — credit formula, tiers, anti-Sybil, progressive circulation, reference rate |
| [HANDOVER.md](HANDOVER.md) | Agent handover: current state, LE rate limits, architecture |
| [ROADMAP.md](ROADMAP.md) | Planned features and future work |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contribution guidelines, code of conduct, governance model |

### App & Package Documentation

| App / Package | Directory | What It Does |
|---------------|-----------|-------------|
| **Server Node** | `apps/server/` | Gateway — genesis, admin, REST APIs, WebSocket, connectors, libp2p. Includes full [network topology setup guide](apps/server/README.md). |
| **PWA** | `apps/pwa/` | Web UI — map, marketplace (13 categories), messaging, people/friends, ledger. See [PWA Docs](apps/pwa/README.md). |
| **Native App** | `apps/native/` | 7-tab Expo + React Native mobile client. Contains all native deferred deep-linking. See [Native Docs](apps/native/README.md). |
| **Core Protocol**| `packages/beanpool-core/` | Shared Library — Identity, Mutual Credit economics, CRDT Mesh synchronisation, Ed25519 cryptography. See [Core Docs](packages/beanpool-core/README.md). |

### Config Files

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Port mappings, env vars, volume mounts |
| `.env` | Cloudflare + admin secrets (**gitignored**) |
| `Dockerfile` | Multi-stage build: core → PWA → BeanPool Node (accepts `APP_VERSION` build arg) |
| `deploy.sh` | Deploy script — pulls pre-built GHCR image to Azure + Debian nodes |
| `turbo.json` | Turborepo build pipeline |
| `pnpm-workspace.yaml` | Monorepo workspace config |

---

## Status

BeanPool is in active development. The PWA is **fully functional** and a **React Native / Expo companion app** has near-complete parity with 7 tabs (Map, Projects, Market, Chat, People, Ledger, Settings), SQLite persistence, and background Merkle sync. Five nodes (Mullum 1, Mullum 2, Review, Test, Test Mirror) are deployed with federation protocol for cross-community trading.

**What's working:**
- ✅ **Alternative Palettes, Light Mode Map, and Chat Upgrades (v1.1.40)** — Shipped color tokenization across the native app (supporting Classic, Earth, and Slate palettes), defaulted maps to Light Mode with CartoDB Positron and a custom slate-blue dusk theme, generated transparent logos/icons, consolidated inbox tabs into a single list, added tap-to-enlarge chat images, lazy caches, 15-minute edit windows, node status mismatch checks, and Ed25519 PKCS8 signing fixes.
- ✅ **Active/Passive Collision & Deadlock HUD (v1.0.87 / v1.0.88)** — Resolves P2P Yamux concurrent dial-racing and silent listener deadlocks. Configures Active Dialer (`enabled: true`) and Passive Listener (`enabled: false`) roles that exchange enabled states on handshake, automatically rendering red `⚠️ Collision` and yellow `⚠️ Deadlock` warning badges with custom inline warning instructions.
- ✅ **Push-on-Write Real-Time Replication (v1.0.87 / v1.0.88)** — Real-time event delta broadcasts using `/beanpool/sync/delta/2.0.0` secure WebSockets. Instantly signs delta event payloads with the node's libp2p Ed25519 private key upon any SQLite write, verified cryptographically by target mirrors.
- ✅ **15-Min Reconcile & 24h Tombstone Pruning** — Shipped a robust 15-minute background full Merkle-tree state comparison safety net to repair dropped delta frames, paired with a 24-hour database garbage collector that prunes soft-deleted tombstones older than 30 days once downstream peers' cursors have synced past them.
- ✅ **P2P WebSocket Tunneling & Self-Healing (v1.0.85 / v1.0.86)** — Establish stable bidirectional P2P mirroring through Cloudflare Tunnels (port `443` secure WebSockets) using orange-clouded DNS subdomains (e.g. `p2p-mullum2.beanpool.org`). Automatic periodic Yamux handshake checks prune stale socket references forcefully using `p2pNode.hangUp` and trigger clean recovery dials within 30 seconds of a node restart.
- ✅ **SQLite Diagnostics & Health Gates (v1.0.83 / v1.0.84)** — Active `PRAGMA integrity_check` scans and multi-table counters (Members, Posts, DMs, Txns) displaying database health indicators in Settings. Includes Koa health check `minAppVersion` gates matched dynamically on client boot to overlay updates.
- ✅ Dynamic Node-Centered Mapping — Leaflet map bounds are dynamically tethered to the node's configured radius, and GPS pin-drop race conditions have been resolved
- ✅ Invite-only membership with single-use codes + hierarchical invite tree
- ✅ 12-word BIP-39 seed phrase — deterministic Ed25519 key derivation + recovery
- ✅ People tab — Friends, Community browser, Invites, Guardians (up to 5)
- ✅ Landing page welcome hub (HTTPS `/`) — 3 paths (join, transfer, recover) + admin contact info
- ✅ Admin community config — name, email, phone in Settings → Community tab
- ✅ Member profiles (avatar via camera/gallery, editable callsign, bio, contact visibility)
- ✅ 🫘 Bean reputation system — 5-bean ratings with comments on marketplace tiles + detail
- ✅ Abuse reporting with reason dropdown + admin panel
- ✅ Marketplace with 13 categories, photos (up to 3), post validation, "My Posts" view
- ✅ E2E messaging — DMs and group chats
- ✅ PWA with map, marketplace, messaging, people, ledger
- ✅ Post detail view with author profile, photos, bean rating, Message/Rate/Report actions
- ✅ Community health dashboard (admin settings)
- ✅ Moderation Centre — reported posts, health-flagged wash trading, batch operations, member audit
- ✅ Software update notifications — Docker Desktop-style header badge, auto-check with configurable interval
- ✅ REST APIs (67+ endpoints) including friends, ratings, reports, admin thresholds, version check, push tokens, escrow lifecycle, and quadratic voting.
- ✅ WebSocket real-time state feed
- ✅ Federation protocol — peer/mirror/blocked trust levels
- ✅ Cross-community marketplace browsing (Connected Communities UI)
- ✅ Mirror state sync (Merkle hash + delta exchange, 15-min intervals)
- ✅ Handshake protocol (~570ms latency between continents)
- ✅ Let's Encrypt auto-TLS via DNS-01 challenge (Cloudflare API)
- ✅ 5 live nodes — Mullum 1 (Azure AU), Mullum 2 (bare metal), Review (bare metal), Test (bare metal, offline SQLite recovery node), and Test Mirror (bare metal real-time backup node)
- ✅ Node admin setup guide with LE and no-domain instructions
- ✅ Database (SQLite) — `better-sqlite3` with WAL mode, self-healing schema migrations
- ✅ FTS5 full-text search — marketplace search with synonym mapping
- ✅ Cryptographically signed APIs — Ed25519 client-side signatures on all POST requests to prevent spoofing
- ✅ CI/CD pipeline — GitHub Actions auto-builds Docker image, auto-creates Releases from git tags
- ✅ **Directory Publisher (Decentralized)** — nodes push metadata to beanpool.org Supabase global directory using Libp2p Ed25519 cryptographic signatures to prevent spoofing and replay attacks.
- ✅ Push Notifications — Expo push tokens, DM/marketplace alerts, per-member notification preferences
- ✅ Native Background Sync — SQLite `dbSyncLock` Mutex Queue safely handling parallel `applyDelta` and foreground Map/Inbox requests without `database is locked` panics.
- ✅ Offline Outbox — Draft and queue marketplace posts while offline, syncs automatically when connection restores.
- ✅ Live Inbox Parity — Base64 E2E plaintext message decryption, real-time polling, and global unread notification tab badges.
- ✅ Native Identity Flow — self-managed identity creation and 12-word recovery via Expo SecureStore
- ✅ Community Projects Tab — native-only crowdfunding feature with progress bars and proposal creation
- ✅ Neon-Vine Tab Bar — branded tab navigation with artwork background and dark overlay
- ✅ Guest Mode — multi-node onboarding with membership probe, guest UI indicators in header and sync status
- ✅ Native App (Expo) — 7-tab React Native companion app: Map, Projects, Market (14 cats), Chat, People, Ledger, Settings
- ✅ Native SQLite + SecureStore — local persistence and self-managed identity on device
- ✅ Map Phase 6 — pin clustering, modern markers, elder glow effects (both PWA + Native)
- ✅ Map Clustering Stabilization — custom patching to prevent marker disappearance on iOS scroll/zoom.
- ✅ Marketplace UX Modernization — horizontal category chips, trust badges, MyDeals sheet/modal, post author trust display
- ✅ Community Projects — native-only crowdfunding tab with progress tracking
- ✅ Escrow Demurrage Exemption — escrow wallets exempt from circulation decay
- ✅ **Sanitized Syncing** — Synthetic "Visitor" and escrow accounts automatically filtered from local member directories and map views.
- ✅ **Admin Node Restore** — Supports offline restoration of system states via `.tar.gz` database upload.
- ✅ **Social Recovery (3-of-N)** — Cryptographically secure identity recovery mechanism requiring quorum approval from trusted friends.
- ✅ **Identity Spoofing Security** — Hardened identity endpoints against impersonation attacks.
- ✅ **A11y & Stability** — Fixed P2P yamux stream crash loops and applied accessibility enhancements across the frontend.
- ✅ **Security Hardening (Sentinel)** — Mitigated Stored XSS vulnerabilities across the Admin Dashboard and fixed Command Injection in server backup routines. Established automated security auditing via `.jules/sentinel.md`.
- ✅ **Performance & Accessibility** — Fixed an O(N^2) array filtering bottleneck for relational data and added ARIA labels to the PWA WelcomePage.
- ✅ **PWA Parity Phase 1-4** — Community status indicator, avatar trust badges with profile navigation, People page search/avatars/relative dates/message button, synonym-expanded marketplace search (417-entry map), localStorage-based blocked user filtering, Settings security section (backup reminder, private key viewer, wipe identity).
- ✅ **Native Invite Fix** — Updated invite share text to include Node URL for manual code entry.
- ✅ **Cross-platform Avatar Sync** — Implemented `bundled://` protocol for avatars, fixing missing pin icons and broken clustering on Android.
- ✅ **Native Quadratic Voting** — Restored native QV governance engine, CommonsInfoModal, voting stepper, and dual progress bars.
- ✅ **Sybil Hardening v3** — Implemented funnel detection, ghost velocity gate, and interactive audit filters.
- ✅ **Profile Completeness Enforcement** — Added server-side enforcement for profile completeness.
- ✅ **Onboarding UX Overhaul** — Refined into a friendly 3-step onboarding flow.
- ✅ **Haptic Feedback** — Phase 1 essentials implemented for native app interactions.
- ✅ **Admin Dashboard Reorganization** — Redistributed System tab settings to contextual tabs; fixed login ReferenceError.
- ✅ **Continuous Health Ping** — Added offline red dot indicator and continuous health ping to mobile app header, mapped using unique public keys to prevent UI collisions.
- ✅ **Author Request Review Flow** — Enhanced deals management allowing sellers to review buyer requests with integrated messaging and standardized decline reasons.
- ✅ **Ledger UI Enhancements** — Corrected credit slider visual representation for negative balances and improved feedback for locked 'Send Credits' functionality.
- ✅ **Sentinel Security Hardening & Deny-by-Default (Sentinel)** — Inverted the Koa server `requireSignature` auth filter to deny-by-default on all mutating endpoints (`POST`, `PUT`, `DELETE` under `/api/*`), eliminating opt-in security drift. Binds verified request keys to `ctx.state.actor` as the authenticated source of truth, and enforces dynamic body spoof protection.
- ✅ **Auth Boundary Verification** — Shipped `scripts/verify-auth-boundary.mjs` which dynamically asserts all 38 mutating endpoints across 114 test vectors (unsigned, wrong-key, spoofed-body) against the live server.
- ✅ **Cryptographic P2P Sync Signatures** — Secured peer-to-peer Merkle replication by signing outgoing state payloads with the node's libp2p Ed25519 private key, and verifying payload signatures before database writes. Includes a dedicated `test-sync-signature.ts` integration suite.
- ✅ **Native Identity SecureStore & Clipboard Privacy** — Eliminated plaintext fallback storage for identity private keys in favor of hardware-backed Expo `SecureStore`, and resolved OS spyware notifications by replacing background clipboard sniffing with user-initiated pasting.
- ✅ Monorepo ESLint Flat Config — Configured monorepo-wide flat linting rules via `eslint.config.mjs` to maintain code health standards.
- ✅ Release v1.0.76 Settings Lockout Fix — Resolved Admin Settings CSP lockouts by explicitly permitting Leaflet, OpenStreetMap, and geocoding API domains (`https://unpkg.com`, `https://*.tile.openstreetmap.org`, `https://nominatim.openstreetmap.org`).
- ✅ Release v1.0.76 Password Complexity Engine — Enforced high-entropy complexity rules (minimum 8 chars, requiring uppercase, lowercase, digit, and special character check) dynamically evaluated at system boot, settings inputs, and API boundaries.
- ✅ Release v1.0.77 SQLite Database Restoration — Restored SQLite database state on the `test.beanpool.org` node using simulator datasets to recover 28 members, 21 posts, and 24 messages.
- ✅ Release v1.0.77 "Never" Sync Schedule — Added a "Never (Disabled)" option to Directory settings, allowing admins to completely bypass periodic directory pushes.
- ✅ Production EAS Native Builds (v1.0.76-b97) — Successfully generated production iOS ipa bundle and Android aab bundle, distributing them to local and desktop build stores.
- ✅ Global Mesh Node Deployment — Automated and verified the global mesh deployment of version `v1.1.40` using `deploy.sh` across all 5 mesh nodes (`mullum1.beanpool.org`, `mullum2.beanpool.org`, `review.beanpool.org`, `test.beanpool.org`, and `test-mirror.beanpool.org`) with valid Let's Encrypt TLS certificates.

**Coming next:**
- Native App Polish & App Store Submission (federation parity)

---

## License

[MIT](LICENSE)

_Last updated: 2026-06-17_
