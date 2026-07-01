# BeanPool PWA (Web Client)

> The primary Progressive Web Application for the BeanPool protocol. It serves as the community gateway interface for identity management, local marketplace discovery, and peer-to-peer messaging.

---

## 📱 Features

- **Map:** Leaflet/OSM map with marketplace pins, dynamic root locations, pin clustering, and post form with photo upload. Map is strictly defaulted to Light Mode with CartoDB Positron and a customized slate-blue dusk theme overlay filter.
- **Marketplace:** 13-category Deals Hub with "My Market" segment controls, radius filters, MyDeals modal, category picker, trust badges, unread inbound request counters, Given review editing, **synonym-expanded search** (417-entry map), and **blocked user filtering**.
- **Messaging (Chat):** Unified inbox conversations list representing Transactional CRM (smart mapping to parent marketplace posts) with real E2E-encrypted messaging (Noise/X25519/AES-GCM), sent/read receipts, tap-to-enlarge chat images with lazy image cache, 15-minute edit window, and encrypted photo attachments.
- **People:** Community browser with **search filter**, avatar circles, relative date formatting, 💬 message button on friends, Invites (hierarchical code management), and Guardians.
- **Ledger:** Mutual credit balances, transaction fee warnings, solvency transparency, 0% fee Green Zone (0–200 Beans), and CSV export.
- **Profile:** Editable profiles with camera/gallery avatar uploads, callsigns, bios, and 3-tier visibility settings.
- **Identity:** Deterministic Ed25519 identity generation and 12-word seed phrase recovery locally stored in IndexedDB.
- **Security:** Private key viewer (reveal/hide + copy), identity wipe with double-confirm, and backup reminder.
- **Community Status:** Health popover on header tap showing node online/offline status, member count, and membership badge.
- **Guest Mode:** UI indicators when visiting a node you're not a member of (header badge + sync status).

---

## 📁 Source Architecture (Key Files)

| File | Purpose |
|------|---------|
| `src/App.tsx` | Shell — identity gate, 5-tab bottom nav (Map, Market, Chat, People, Ledger), header |
| `src/pages/MapPage.tsx` | Leaflet/OSM map with marketplace pins, post form with photo upload |
| `src/pages/MarketplacePage.tsx` | Marketplace list + search + radius filter + post detail + edit own posts + bean ratings + abuse reporting |
| `src/pages/MessagesPage.tsx` | Conversations list + chat view (DMs + groups) |
| `src/pages/PeoplePage.tsx` | People tab — Friends, Community browser, Invites, Guardians sub-views |
| `src/pages/LedgerPage.tsx` | Balance, transactions, send credits |
| `src/pages/ProfilePage.tsx` | Editable profile — avatar (camera/gallery), callsign, bio, contact |
| `src/components/MarketplaceCard.tsx` | Post tile with primary photo + bean rating |
| `src/components/RadiusPickerPage.tsx` | Facebook-style map radius picker (Leaflet circle + slider) |
| `src/components/CategoryPickerModal.tsx` | Modal for selecting marketplace categories |
| `src/components/MyDealsModal.tsx` | Modal for viewing active marketplace deals (offers/needs in escrow) |
| `src/components/PublicProfileModal.tsx` | Reusable modal for viewing a member's public profile and social recovery status |
| `src/components/PostAuthorTrust.tsx` | Trust badge display for post authors (ratings, join date) |
| `src/lib/api.ts` | Typed client for all 67+ REST endpoints (incl. friends, guardians, members, push tokens, escrow, social recovery, administrative restore, and governance) |
| `src/lib/identity.ts` | Ed25519 identity — mnemonic-derived keys, IndexedDB persistence |
| `src/lib/mnemonic.ts` | BIP-39 mnemonic generation + WebCrypto PKCS8 key derivation |
| `src/lib/e2e-crypto.ts` | E2E encryption handler using Noise/X25519/AES-GCM keys |
| `src/lib/marketplace.ts` | 13-category config, MarketplacePost type |
| `src/lib/geo.ts` | Haversine distance, radius settings persistence |
| `src/lib/search.ts` | Synonym-expanded marketplace search (expandSearchTerms, matchesExpandedSearch) |
| `src/lib/synonyms.json` | 417-entry synonym map (food, trades, tools, goods, plants, etc.) |

---

## 🛠️ Development

```bash
cd apps/pwa
pnpm install
pnpm dev
```
