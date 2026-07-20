# Manager convergence — implementation plan

Status: **PLANNING (2026-07-20). Nothing in this doc is built yet.** Extends
[delta-backup-plan.md](./delta-backup-plan.md) — see below on how it also resolves
that plan's deferred decision point #4 ("(A) manager-side applier ... duplicates
applier logic" vs "(B) backup-mode node replica ... more infra"). This plan builds
a *third* option instead of picking between those two.

## Why

Three separate problems converged into one plan:

1. **Backup infrastructure.** [delta-backup-plan.md](./delta-backup-plan.md) built
   option (B) — a full `NODE_ROLE=backup` node instance as the replica. It works
   (proven, hash-matched, deployed fleet-wide), but it's heavier than it needs to
   be: a backup replica boots P2P, TLS, the full HTTP/admin server, and
   community-simulating background jobs it will never use, just to receive
   deltas. That gets expensive fast if extended past `test` to the rest of the
   fleet — 7 more full node clones just to hold a copy each.

2. **Business-logic duplication.** The fleet manager's Sentinel
   (`src/sentinel/rules.js`, `src/replicas.js`) independently reimplements a
   chunk of what the node's own `state-engine.ts` already computes — not by
   accident, but by design (the file's own docstring: *"a compromised node can
   lie about its flags, but not about its ledger backup"*). The intent is
   sound; the execution has already drifted:
   - `conservationDrift()` / `strandedEscrow()` (rules.js) — identical queries
     to `runLedgerAudit()` (state-engine.ts), byte-for-byte. Pure redundancy.
   - `computeTrustProfiles()` (replicas.js) — an independent, hardcoded
     reimplementation of the node's actual trust-floor formula
     (`getMemberTrustProfile()`, state-engine.ts). Real trust-model policy,
     encoded twice, with no shared source of truth.
   - `delinquency()` (rules.js) — **already inconsistent with the node**: the
     node's delinquent check is relative to each member's own floor
     (`balance <= floor * 0.8`); Sentinel's is a flat `-100` beans regardless
     of floor. This produces wrong answers *today*, independent of anything
     else in this plan.
   - `cohortVelocity()` (rules.js) — same underlying signal as the node's
     cohort-anomaly check, but week-bucketed on the node vs day-bucketed in
     the manager, with the `-600` beans / `14-day` thresholds hardcoded
     separately in both places.

3. **Admin surface fragmentation.** The node ships its own full admin/settings
   UI — prune a user, resolve an abuse report, moderate a post, broadcast an
   announcement — served directly from the node's own HTTP server. The
   manager increasingly needs to trigger the same actions for a coherent
   fleet experience (it already does some of this: `announcePanel` in
   `node.js` calls `/api/action/announce`). Today that means two separate,
   overlapping admin surfaces — one per node, one central — with no single
   answer to "where do I go to manage this community," and AI-assisted
   moderation/response has nowhere natural to live since it'd have to be
   wired into both.

The first two problems share a root cause: the logic that should be one
trusted "ledger/sync engine" is buried inside one 6,700-line node-only file
(`state-engine.ts`). Anything that wants to reuse it — a lean backup receiver,
or the manager's own fraud rules — either re-derives it from scratch (drift
risk, as above) or has to run a full node just to get access to it (infra
cost). The third is a product-surface decision layered on top: once the
manager is the trusted place for backup and monitoring, it should also be the
trusted place for day-to-day administration — see
[Admin surface](#admin-surface-what-moves-what-stays) below.

## Target architecture

```
beanpool/  (pnpm workspace)
├── packages/
│   ├── beanpool-core/        existing — wire protocol, shared types
│   └── beanpool-ledger/      NEW — extracted from state-engine.ts:
│         schema.sql + migrations
│         conservation guard + runLedgerAudit
│         trust-floor formula (replaces replicas.js's computeTrustProfiles)
│         the rules currently duplicated in rules.js (conservationDrift,
│           strandedEscrow, delinquency, cohortVelocity)
│         sync engine (importRemoteState / exportSyncState / LWW merge)
│
├── apps/
│   ├── server/                existing — the node, admin UI shrinks to a
│   │                                       minimum (see below); ledger/
│   │                                       protocol capability unchanged
│   ├── pwa/, native/           existing — unchanged
│   └── manager/                MOVED from beanpool-manager repo, converted to TS
│         fleet registry, credentials, AI synthesis (optional), alerting,
│           dashboard UI
│         NEW: primary admin surface — user/message/report management,
│           moderation, for one node or many; calls the node's existing
│           admin API underneath, does not reimplement the mutations
│         Sentinel's fleet-only rules (wash-trading graph, Sybil rings,
│           funnels, dormant-reactivation, watchlist, trend spikes) — no node
│           equivalent, stay exactly as they are
│         NEW: lean backup receiver — N polling loops + N SQLite files, no
│           P2P/TLS/HTTP-server, built on beanpool-ledger's sync engine
```

## Admin surface: what moves, what stays

The split is **read/analysis vs. write**, not "everything moves":

- **Moves to the manager (interface + orchestration only):** the UI and
  workflow for user management, message moderation, and abuse-report
  handling — one place to click "prune this user" or "resolve this report,"
  for one node or eight, with AI-assisted triage layered on top for whoever
  wants it.
- **Stays on the node (the actual mutation):** the code that executes those
  actions — `adminPruneUser`, abuse-report resolution, etc. — keeps running
  on the node, because the node is the only thing that can safely serialize
  a write against its own live, authoritative ledger. The manager's UI calls
  the node's existing admin API to trigger it, the same pattern already used
  today (e.g. `announcePanel` → `/api/action/announce`); the logic doesn't
  relocate, only the interface consolidates.
- **Why not move the mutation logic too:** doing so would mean the manager
  either computes a ledger-affecting mutation and pushes it into the node
  (a new inbound-write channel to the primary — precisely what this year's
  one-directional backup redesign, "primary imports from nobody," was built
  to close) or mutates its own replica and somehow reconciles that back —
  neither is acceptable. Ledger-affecting writes have exactly one legitimate
  writer: the node itself.
- **What "minimum" means on the node:** enough to bootstrap and survive with
  zero dependency on the manager — initial admin-password setup, basic
  settings, and emergency actions (e.g. freezing an account) — not the full
  rich admin experience. Exact scope is an open decision below, not decided
  here.

## What's already built (foundation — don't redo)

Everything in [delta-backup-plan.md](./delta-backup-plan.md): watermark
migration, delta export/endpoint, LWW importer, delta puller — merged, deployed
to all 8 nodes, shadow-run proven (independently-computed stateHash matched a
live primary, twice, across two rounds of fixes). beanpool PR #51 (role-gating:
marketplace hygiene + directory publisher now skip on a backup replica) and
beanpool-manager PR #2 (cadence UI moved to the fleet-wide Ops & Backups table)
are also merged. `beanpool-ledger` is an **extraction** of this already-working
code, not a rewrite of it.

## What does NOT change

- The node's standalone **ledger/protocol** capability — identity, ledger,
  P2P, local snapshot-to-file (`snapshot-scheduler.ts`, already exists,
  untouched), and the existing `NODE_ROLE=backup` full-node-replica mode. A
  single operator can still run one node and do everything — including real
  off-node redundancy — without ever installing the manager.
- No AI in the node, ever. Stays a manager-exclusive product surface by
  deliberate choice, not merely because a single node lacks fleet context.
- The manager's fleet-only detection (wash-trading graph, Sybil rings, invite
  funnels, dormant-reactivation, watchlist, trend analysis) — no node
  equivalent exists or is planned. These are additive capabilities, not
  duplicated ones, and are untouched by this plan.
- **Revises earlier framing:** the node's admin *UI* is not staying as-is —
  see [Admin surface](#admin-surface-what-moves-what-stays) above. What
  doesn't change is the node's ability to run *standalone*, not the shape of
  its admin interface.

## Staged migration (each step lands + is verified before the next)

1. **Extract `beanpool-ledger` from `state-engine.ts`.** The riskiest and
   most valuable part: refactor every extracted function to take a `db`
   handle as an argument instead of reading the module-level singleton — the
   one change that lets a single process later run the sync engine against N
   different databases. Already confirmed low-risk on both couplings that
   mattered most: `backup-puller.ts` only imports `state-engine.js`,
   `logger.js`, `local-config.js` (no P2P/TLS coupling), and
   `isPeerTrusted` (connector-manager.ts:510) is pure/in-memory — no live P2P
   connection required, despite living in a P2P-flavored file.
   **Test:** the node's own boot-time behavior must be byte-identical
   before/after (same log lines, same audit results) — this step changes
   *where* the code lives, not what it does.

2. **Fix the known divergences as part of the move, not after:** unify
   `delinquency()`'s threshold to the node's real (floor-relative)
   definition; replace `replicas.js`'s `computeTrustProfiles()` with a call
   into the extracted trust-floor formula; align `cohortVelocity()`'s
   bucketing. Correctness fixes riding on the extraction, not new scope.

3. **Node becomes a thin caller** — `state-engine.ts`'s `importRemoteState`,
   `runLedgerAudit`, etc. become wrappers delegating to `beanpool-ledger`
   against its own live `db`. No behavior change from the node's
   perspective.

4. **Convert `beanpool-manager` to TypeScript, incrementally**
   (`allowJs`/`checkJs`, file by file) — not a big-bang rewrite. It's a live
   production tool holding real state (credentials, audit log, alert
   history); incremental conversion keeps it deployable at every commit
   instead of down for the length of a rewrite.

5. **Move it into this workspace as `apps/manager`**, added to
   `pnpm-workspace.yaml` alongside `server`/`pwa`/`native`. This is what
   turns "share code with a separate repo" from a packaging/publishing
   problem into a normal in-workspace import — the same mechanism `pwa` and
   `server` already use for `beanpool-core`.

6. **Rewire Sentinel** to call `beanpool-ledger`'s shared functions for the
   rules that overlap the node (conservation drift, stranded escrow, trust
   floor, delinquency, cohort velocity), deleting the parallel
   implementations. The genuinely fleet-only rules (wash-trading graph,
   Sybil rings, funnels, dormant-reactivation, watchlist, trend spikes) are
   untouched — there's nothing on the node side to unify them with.

7. **Build the lean backup receiver** in `apps/manager`, using
   `beanpool-ledger`'s sync engine directly — no P2P, no TLS, no HTTP
   server, no admin panel, none of the community-simulating background jobs
   (the things PR #51 had to explicitly gate off a full node replica for).
   One polling loop + one SQLite file per configured node, all in one
   process. Shadow-run it the same way the original delta mechanism was
   proven: point it at `test`, hash-compare against the primary *and*
   against the existing full-node replica, before trusting it.

8. **Cutover decision (not automatic).** Once the lean receiver is proven,
   decide whether to retire the full-tar harvester per node in favor of it —
   keeping the tar pull as break-glass, same posture as the original
   delta-backup plan. The standalone `NODE_ROLE=backup` full-node path stays
   available regardless, for anyone not running a manager at all.

9. **Scope the node's minimum admin surface.** Inventory the node's current
   admin/settings UI and sort each action into "bootstrap/emergency — stays
   on the node" vs. "day-to-day — moves to the manager." Concrete starting
   point, not a final answer: admin-password setup, basic settings, and
   emergency freeze/report actions stay; routine user management, message
   moderation, and abuse-report triage move.

10. **Build the manager's admin-action surface.** For each action moved in
    step 9, the manager's UI calls the node's *existing* admin API endpoints
    (the same pattern already used by `announcePanel` → `/api/action/announce`)
    — no new mutation logic, no new inbound-write channel to the node. This
    is UI/orchestration work, not ledger-engine work, and can proceed in
    parallel with steps 4–8 rather than waiting on them.

11. **Shrink the node's own admin UI** to the step-9 minimum once the
    manager's equivalent is live and proven — remove the now-redundant
    routine-management screens from the node's HTTP server, keep the
    bootstrap/emergency subset.

## Risks

- **De-globalizing `db`/`ledger` state** (step 1) touches the most
  security-sensitive code in the repo (signature verify, conservation
  guard). Mitigate: extraction only, no logic changes in the same step; the
  full existing test suite (52/52 migration, 19/19 export, 7/7 importer,
  12/12 round-trip) re-run against the extracted package before it's wired
  back in.
- **Manager downtime during TS conversion.** Mitigate: incremental, not
  big-bang; the manager keeps running real backups/alerts throughout.
- **Losing the "independent verification" property** when Sentinel's rules
  move to shared code. Mitigate: the independence comes from *where* the
  computation runs (a separate process, against independently-synced
  replica data) and *when* (on the manager's own schedule), not from
  maintaining a second, drifting implementation. Sharing the code removes
  the drift risk (see: the delinquency threshold, today) without removing
  the independence.
- **Package boundary bikeshedding** — whether this becomes a new
  `beanpool-ledger` package or extends `beanpool-core` is a naming/scoping
  call, not an architectural one; doesn't block starting the extraction.
- **Over-centralizing admin power in the manager.** The manager already
  holds every node's admin credentials for backup purposes; making it the
  *primary* admin surface too means compromising the manager is now
  compromising day-to-day control of the whole fleet, not just its backups.
  Mitigate: the node keeps an independent, minimum admin capability (step 9)
  specifically so there is no single point of total failure — this is the
  main reason that minimum surface must not shrink to zero.

## Open decisions (flag, don't block on)

- New package (`beanpool-ledger`) vs. extending `beanpool-core` — naming/scope only.
- Exact cutover timing for the full-tar harvester once the lean receiver is proven.
- Whether the node should eventually retain its own rolling history (to
  support trend-based self-checks, like `negativeSumSpike`, without a
  manager at all) — genuinely optional, not required for anything above.
- **Exact contents of the node's minimum admin surface** (step 9) — needs a
  real inventory of the current admin UI's actions, sorted deliberately,
  not assumed from this doc's starting-point examples.
