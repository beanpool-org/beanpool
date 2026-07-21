# Node Architecture Assessment & Refactoring Roadmap

> **Status**: Updated 2026-07-22. Route splitting complete (PR #55). State engine decomposition complete (Phases 1–9, PRs #56–#63). All test suites 100% passing.
> **Author**: Architectural review during Manager Convergence Plan work.

---

## Current State

### `state-engine.ts` — 6,359 lines, 31 sections
This single file IS the node. It contains everything:

| Section | Lines | What it does |
|---------|-------|-------------|
| Types | 96–333 | All type definitions |
| State + Init | 334–628 | Module globals, boot, schema migration |
| WebSocket | 629–663 | Client sync connections |
| DB Helpers | 664–720 | Row mappers, utility queries |
| Members | 721–818 | CRUD for member records |
| Invite Codes | 819–1097 | Full invite tree logic |
| Profiles | 1098–1189 | Member profile views |
| Trust Stats | 1190–1234 | **Delegated to `@beanpool/engine`** ✅ |
| Trust Profile (Viewer) | 1235–1475 | Viewer-aware trust display |
| Ledger | 1476–1616 | Balance mutations, transfers, decay |
| Marketplace | 1617–2035 | Post CRUD, search, photos |
| Marketplace Transactions | 2036–2526 | Full escrow lifecycle |
| Community Info | 2527–2545 | Node metadata |
| Messaging | 2546–3053 | DMs, groups, E2E, attachments |
| Unread Tracking | 3054–3076 | Message read state |
| State Sync | 3077–4448 | **1,372 lines** — import/export, Merkle, delta |
| Ratings | 4449–4535 | Bean reputation system |
| Friends & Guardians | 4536–4574 | Social graph |
| Social Recovery | 4575–4804 | Guardian-based account recovery |
| Abuse Reports | 4805–4932 | Report lifecycle |
| Community Health | 4933–5267 | Health checks, monitoring |
| Admin Controls | 5268–5396 | Admin action handlers |
| Activity | 5397–5404 | Activity tracking |
| Node Config | 5405–5489 | Runtime configuration |
| Audit Export | 5490–5528 | Data export for auditing |
| Community Commons | 5529–6015 | Decay, commons pool, ledger audit |
| Replication Access | 6016–6090 | Backup access logging |
| Push Notifications | 6091–6123 | FCM/APNs push |
| Member Preferences | 6124–6158 | User settings |
| Holiday Mode | 6159–6204 | Decay pause |
| Push Dispatcher | 6205–6359 | Notification routing |

### `https-server.ts` — ✅ SPLIT (PR #55)
Previously 3,957 lines with 147 routes. Now split into:

```
apps/server/src/
├── https-server.ts              (876 lines — thin server shell)
└── routes/
    ├── types.ts                 (40 lines — RouteDeps interface)
    ├── admin.ts                 (397 lines)
    ├── backup.ts                (717 lines)
    ├── commons.ts               (251 lines)
    ├── community.ts             (1,080 lines)
    ├── marketplace.ts           (314 lines)
    ├── messaging.ts             (234 lines)
    └── settings.ts              (387 lines)
```

Route modules receive shared state via a `RouteDeps` dependency injection interface. The server shell handles only boot, middleware, and mounting.

---

## What's Right

1. **Section headers are disciplined** — 31 named sections in state-engine.ts, easy to navigate
2. **Single source of truth** — no duplicated logic across files
3. **Test coverage is targeted** — 17 test files testing specific subsystems
4. **Supporting modules are clean** — `backup-puller.ts`, `tls.ts`, `snapshot-scheduler.ts`, `local-config.ts` are all well-scoped single-responsibility files
5. **The `@beanpool/engine` extraction** proves the code is movable — the trust functions came out cleanly
6. **Route splitting is complete** — 7 focused route files with dependency injection ✅

## What Still Needs Work

### 1. The God File Problem
`state-engine.ts` at **6,359 lines** is a monolith. It has 31 conceptual sections that are really 31 modules jammed into one file. The sections are well-marked, but they share module-level globals (`db`, `ledger`, `wss`, `localConfig`) which creates hidden coupling — you can't move a section without untangling which globals it touches.

> **Impact:** Every change to any part of the system touches this file. Merge conflicts are guaranteed in collaborative development.

### 2. State Sync is 1,372 Lines Inside state-engine.ts
The sync engine (import/export, Merkle trees, delta computation) is the most complex subsystem and it's embedded in the middle of the god file. It's tightly coupled to the `db` singleton and the `LedgerManager` instance.

> **Impact:** This is the hardest thing to extract for the manager convergence — and it's the most valuable to extract.

### 3. Module-Level Singletons
`db`, `ledger` (LedgerManager), `wss` (WebSocket server), `localConfig` — these are module-level globals that every section reaches into. The `@beanpool/engine` extraction solved this for trust by parameterizing on `db`, but 9+ other call sites still reference `ledger` directly.

> **Impact:** Can't run two instances, can't test in isolation, can't reuse logic without the full runtime context.

---

## Ideal Target Architecture

```
apps/server/src/
├── index.ts                    # Boot sequence only
├── server.ts                   # HTTP server setup + middleware (was https-server.ts)
├── routes/                     # ✅ DONE (PR #55)
│   ├── types.ts                # RouteDeps interface
│   ├── community.ts            # /api/community/* (public)
│   ├── marketplace.ts          # /api/marketplace/*
│   ├── messaging.ts            # /api/messages/*
│   ├── admin.ts                # /api/local/admin/* (authed)
│   ├── backup.ts               # /api/local/admin/sync-* & backup-*
│   ├── commons.ts              # /api/commons/*
│   ├── settings.ts             # /, /settings, /api/version, deep links
│   └── federation.ts           # /api/federation/* (currently in federation-api.ts)
├── engine/                     # Thin wrappers calling @beanpool/engine
│   ├── members.ts
│   ├── invites.ts
│   ├── marketplace.ts
│   ├── messaging.ts
│   ├── ratings.ts
│   └── sync.ts
├── services/
│   ├── websocket.ts            # WS connection management
│   ├── tls.ts                  # Cert management (already separate ✅)
│   ├── backup-puller.ts        # Already separate ✅
│   ├── snapshot-scheduler.ts   # Already separate ✅
│   ├── push-notifications.ts
│   └── directory-publisher.ts  # Already separate ✅
├── config/
│   ├── local-config.ts         # Already separate ✅
│   └── gateway.ts              # Interface/access controls (new)
└── db/
    ├── db.ts                   # Connection + schema (already exists ✅)
    └── schema.sql              # Already exists ✅

packages/beanpool-engine/src/
├── trust.ts                    # Already extracted ✅
├── audit.ts                    # Next extraction
├── ledger.ts                   # Future: balance mutations, transfers
├── marketplace.ts              # Future: escrow lifecycle
├── sync.ts                     # Future: import/export/Merkle
└── members.ts                  # Future: member CRUD
```

---

## Extraction Order (Remaining Work)

| Priority | What | Lines | Why this order | Status |
|----------|------|-------|----------------|--------|
| ✅ Done | Route splitting (`https-server.ts`) | ~3,950 | Zero risk, pure reorganization | **PR #55** |
| ✅ Done | Trust/fraud (`trust.ts`) | ~420 | Pure reads, proven pattern | In `@beanpool/engine` |
| 🔜 Next | Audit/conservation guard | ~500 | Fixes known bugs, read-mostly | Not started |
| 3 | Members + Invites | ~380 | Self-contained, few globals | Not started |
| 4 | Ratings + Friends | ~180 | Trivial, just DB reads | Not started |
| 5 | Marketplace (posts) | ~420 | Moderate coupling | Not started |
| 6 | Marketplace (escrow) | ~490 | Complex state machine | Not started |
| 7 | Messaging | ~510 | E2E crypto coupling | Not started |
| 8 | State Sync | ~1,370 | Hardest — deep `ledger` + P2P coupling | Not started |

---

## Key Design Principles

1. **"The API is the product"** — The node is a sovereign appliance. All business logic lives on the node, not in native/PWA clients.
2. **Dependency injection over globals** — Route modules receive `RouteDeps`, engine modules receive `db`. No module-level singletons in new code.
3. **The extraction pattern** — Every section follows: Map dependencies → Move code → Wire via interface → Verify build → Test → Deploy.
4. **Manager convergence IS the refactoring** — You can't share code with the manager until it's extracted from `state-engine.ts`. The two goals are the same work.

---

## Key Files Reference

| File | Lines | Role |
|------|-------|------|
| `apps/server/src/state-engine.ts` | 6,359 | The god file — ALL business logic |
| `apps/server/src/https-server.ts` | 876 | Thin server shell (post-split) |
| `apps/server/src/routes/*.ts` | ~3,420 | 7 route modules + types |
| `apps/server/src/local-config.ts` | ~350 | Node configuration |
| `apps/server/src/connector-manager.ts` | ~300 | P2P connector management |
| `apps/server/src/backup-puller.ts` | ~250 | Backup replication client |
| `apps/server/src/db/db.ts` | ~450 | SQLite connection + schema |
| `packages/beanpool-engine/src/trust.ts` | ~420 | Extracted trust/fraud engine |

---

## Verdict

The node works, and the code is correct — 17 test suites prove that. The section discipline shows thoughtful organization. But `state-engine.ts` is a **monolith that grew organically** — one file carrying ~45% of all server code. The `@beanpool/engine` extraction pattern (proven with trust, proven with routes) is the right approach. Apply it methodically across the remaining 30 sections.
