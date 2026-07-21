# BeanPool Architecture Vision

> **Status**: Documented 2026-07-22, following architectural design sessions.
> This captures the bigger-picture vision for BeanPool's system architecture — how the node, clients, and management layer relate, and where the boundaries are.

---

## Core Principle: "The API Is the Product"

BeanPool's node is a **sovereign appliance** — a headless API server that owns all business logic, enforces all rules, and stores all state. Everything else (PWA, mobile app, manager dashboard) is a **thin client** that sends user intents and displays results.

```
┌─────────────────────────────────────────────────────────┐
│                    CLIENTS (thin)                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐ │
│  │ PWA      │  │ Native   │  │ Desktop  │  │Manager │ │
│  │ (browser)│  │ (iOS/    │  │ (Electron│  │(fleet  │ │
│  │          │  │  Android)│  │  /Tauri) │  │ admin) │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───┬────┘ │
│       │              │              │             │      │
│       └──────────────┴──────────────┴─────────────┘      │
│                         │                                │
│              HTTPS API + WebSocket                       │
│                         │                                │
├─────────────────────────┼────────────────────────────────┤
│                    NODE (sovereign)                       │
│  ┌─────────────────────┴──────────────────────────────┐ │
│  │ Gateway Config (self-protection)                    │ │
│  │  • CORS allowed origins                            │ │
│  │  • Admin IP allowlist                              │ │
│  │  • Feature toggles (PWA, marketplace, messaging)   │ │
│  │  • Rate limiting                                   │ │
│  ├────────────────────────────────────────────────────┤ │
│  │ API Layer (routes)                                 │ │
│  │  • Community, Marketplace, Messaging, Admin, etc.  │ │
│  ├────────────────────────────────────────────────────┤ │
│  │ Engine (business rules — the actual product)       │ │
│  │  • Credit floors, trust model, conservation guard  │ │
│  │  • Transaction validation, escrow settlement       │ │
│  │  • Wash/Sybil detection, invite tree rules         │ │
│  │  • Progressive circulation (decay)                 │ │
│  ├────────────────────────────────────────────────────┤ │
│  │ Storage (SQLite)                                   │ │
│  │  • Single file = single truth                      │ │
│  │  • Backup = copy the file                          │ │
│  │  • Replication = delta sync over HTTPS             │ │
│  └────────────────────────────────────────────────────┘ │
│                                                          │
│  P2P Mesh (libp2p) ←──→ Other Nodes                    │
└─────────────────────────────────────────────────────────┘
```

---

## The Three Layers

### 1. Node (Sovereign Appliance)

The node is the **authority**. It enforces all rules and owns all state:

| Responsibility | Why it must be on the node |
|---|---|
| Credit floor calculations (trust model) | Integrity — can't be client-side |
| Conservation guard (balances sum to zero) | Ledger correctness |
| Transaction validation (overdraw checks) | Cannot trust clients |
| Escrow settlement logic | Multi-party state machine |
| Wash-trading / Sybil detection | Security — adversary-facing |
| Invite tree rules | Sybil gate |
| Progressive circulation (decay) | Economic model enforcement |
| State sync (Merkle, delta, P2P) | Network protocol |
| Backup / replication | Data integrity |

**The node never sees private keys.** All client identity is cryptographic — Ed25519 signatures verified server-side, never stored.

### 2. Clients (Thin, Interchangeable)

All clients — PWA, native mobile, desktop — are thin wrappers around the same API. They handle **only** what must happen on the device:

| On the client | Why it stays there |
|---|---|
| 12-word seed phrase / private key | Node must **never** see your private key |
| E2E encryption (Noise/X25519/AES-GCM) | Node can't read message content — by design |
| Transaction signing (Ed25519) | Proof of identity, must happen client-side |
| SQLite cache (conversations, deals) | Offline resilience / phone-change recovery |
| UI validation (required fields) | UX convenience — node re-validates anyway |
| Map rendering, photo resizing | Pure client concerns |

Every piece of client-side logic is either **crypto that must not leave the device** or **UX polish that the node doesn't trust anyway**. There is nothing on the PWA/native that should be moved to the node.

### 3. Manager (Fleet Dashboard)

The manager is a separate admin interface for operating one or more nodes remotely. It connects to each node via the same API (with admin credentials). It can:

- Monitor health, view diagnostics, check logs
- Manage members, posts, moderation
- Configure node settings
- Trigger backups, manage replication

The manager does **not** own any business logic — it's just a nicer admin UI that calls the same endpoints the Settings page does.

---

## Detached PWA Architecture

Currently the PWA is bundled inside the node (`apps/server/public/`). This is fine for the default case, but the architecture supports full decoupling:

### Default: PWA served by the node
```
Browser → https://mullum.beanpool.org/app → (node serves PWA + API)
```
Same origin, no CORS needed. Simple.

### Detached: PWA hosted independently
```
Browser → https://app.beanpool.org → (CDN serves PWA)
         ↓ API calls to ↓
         https://mullum.beanpool.org/api/*
```
Requires the node to configure CORS allowed origins.

### Desktop app
```
Electron/Tauri → (local PWA) → API calls to node
```
No browser = no CORS. Direct HTTPS connection.

### Mobile app (existing)
```
Capacitor shell → (bundled PWA) → API calls to node
```
Already works this way in `apps/native`.

### What makes this possible

The PWA already talks to the node via API (`fetch()` + WebSocket). The only coupling is **relative URLs** (`/api/...`). To fully decouple:

1. Make the API base URL configurable (point at any node)
2. Node adds CORS allowed origins to gateway config
3. Deploy PWA anywhere — CDN, Electron, Tauri, static hosting

This is a config change, not an architecture change. The PWA is already a standalone client.

---

## Gateway Configuration (Node Self-Protection)

The node must control its own access, independent of any manager. This is **bootstrap-level security** — the node protects itself:

| Interface | Controls |
|---|---|
| **PWA hosting** | On/off toggle (`SERVE_PWA=true/false`) — headless mode |
| **CORS origins** | Which web-hosted frontends can call the API |
| **Admin IP allowlist** | Which machines can access admin endpoints |
| **Feature toggles** | Enable/disable marketplace, messaging, federation, invites |
| **Rate limiting** | Per-IP throttles on auth and public endpoints |
| **Replication auth** | Scoped token for backup pull (not the admin password) |

These controls live in the node's `local-config.json` and are settable via the admin API or environment variables. They form the node's own "firewall" — self-protection that doesn't depend on any external system.

---

## Database Architecture Decision

### Why SQLite is right for BeanPool

| SQLite property | How it fits BeanPool |
|---|---|
| Single file | Each node = self-contained. No database server process. |
| Backup = copy the file | The replication model is trivially simple |
| Embedded | No separate Postgres container, no connection strings |
| Offline-capable | Works without any network |
| Deterministic | Same input → same output, critical for Merkle sync |

### Could you swap to Postgres?

The API layer abstracts the database — an HTTP endpoint returning JSON looks the same whether SQLite or Postgres is behind it. However, the engine layer has hundreds of raw SQLite-specific SQL strings. Swapping the DB would mean rewriting the engine's query layer.

**But here's the key insight**: if you ever wanted a completely different node implementation (e.g., a Postgres-backed "enterprise node" for a 10,000-member community), you wouldn't swap the DB inside the current node. You'd build a **new node implementation** that speaks the same API contract. The PWA, mobile app, and manager would all work with it unchanged — because the API is the protocol.

This is the same principle as email: Gmail, Fastmail, and self-hosted Postfix are completely different implementations, but any email client works with all of them because they all speak SMTP/IMAP. BeanPool's API is its IMAP.

---

## Implementation Roadmap

### ✅ Phase 1: Route Splitting (DONE — PR #55)
Split `https-server.ts` (3,957 lines) into 7 route modules + thin server shell.

### 🔜 Phase 2: Engine Extraction
Extract business logic from `state-engine.ts` (6,359 lines) into `@beanpool/engine` modules. See [node-architecture-assessment.md](./node-architecture-assessment.md) for the detailed extraction order.

### Phase 3: Gateway Configuration
Add the gateway config layer — CORS origins, IP allowlists, feature toggles.

### Phase 4: PWA Decoupling
Make the API base URL configurable in the PWA. Deploy independently if desired.

### Phase 5: Manager Convergence
With the engine extracted, the manager can share `@beanpool/engine` for display logic while calling the node API for mutations.

---

## Key Files

| File | Role |
|------|------|
| `apps/server/src/state-engine.ts` | The god file — ALL business logic (6,359 lines) |
| `apps/server/src/https-server.ts` | Thin server shell (876 lines, post-split) |
| `apps/server/src/routes/*.ts` | 7 route modules with dependency injection |
| `apps/native/` | React Native / Capacitor mobile app |
| `apps/pwa/` | Progressive Web App (thin client) |
| `apps/manager/` | Fleet management dashboard |
| `packages/beanpool-engine/` | Shared engine (`@beanpool/engine`) |
| `packages/beanpool-core/` | Protocol constants (`@beanpool/core`) |

---

## Summary

1. **The node is sovereign.** All rules, all state, all authority.
2. **Clients are thin.** They send intents and display results.
3. **The API is the protocol.** Any client that speaks it works. Any node implementation behind it works.
4. **SQLite is right.** Self-contained, embeddable, file-based replication.
5. **The PWA is already decoupled.** It just needs a configurable API URL.
6. **The manager is just another client.** Admin credentials, same API.
7. **The gateway config is self-protection.** The node controls its own access.
