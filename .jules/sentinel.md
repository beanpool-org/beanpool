# ⚠️ Operating policy — READ BEFORE OPENING ANY PR

This repo has accumulated many duplicate Sentinel PRs (5 on the PWA identity-import
storage issue, repeats on the SQL parameter-limit issue, and historically ~6 each on
stack-trace leak and CWE-598). Before opening a PR:

1. **Check for duplicates first.** Run `gh pr list --state all --search "<keywords>"`
   and read the diffs of any open / recently-merged / recently-closed PRs on the same
   vulnerability. If an equivalent fix is already open, merged, or closed-as-rejected,
   **do not open another** — append a note here and stop.
2. **One vulnerability → one PR.** Never re-file a fix that already landed. Treat merged
   and closed PRs as final; only revisit if you can cite the commit that regressed it.
3. **Calibrate severity.** Don't label something CRITICAL when it isn't (e.g. an array
   that throws a catchable error is not "memory corruption / server crash").
4. **Record outcomes below** so the next run sees what's already done.

## ✅ Resolved — do NOT re-file (2026-06-14, landed in #109)
- PWA identity import (PWA-4): import now persists via `importIdentity()` (IndexedDB),
  not `localStorage`; the legacy `localStorage` key is purged; `wipeIdentity()` deletes
  the key from IndexedDB on "Wipe Forever". Supersedes the duplicate set #96/#99/#103/#105/#108.
- SQLite parameter-limit hardening: unbounded `IN (...)` arrays in `state-engine.ts` are
  now batched via `selectInChunks()` (≤900 params/query). Supersedes #74/#85. This is a
  hardening item, not CRITICAL — the arrays derive from stored rows, not request bodies.

### Coordination note (2026-06-25, from the primary agent)
- **SRV-23 (unbounded stream reads) — canonical open PR is #142.** It covers
  `sync-protocol.ts`, `federation-protocol.ts`, and `handshake.ts`. Earlier
  duplicates **#132 and #134 were closed** as superseded. **Do not file another** —
  review/merge #142.
- **Broader server security remediation is in progress and largely landed/flag-gated**
  by the primary agent: read-auth (SRV-2/4, `ENFORCE_READ_AUTH`), WS-auth (SRV-4,
  `ENFORCE_WS_AUTH`), X-1b (legacy sigs removed), SRV-9a/10 (restore traversal + admin
  pw), SRV-20/21 (mirror-only import + balance LWW; full signed-ledger in progress).
  **Read `SECURITY-AUDIT.md` (status log) before filing any server-security PR** to
  avoid duplicating work already merged or in flight.

---

## 2024-05-24 - [CRITICAL] Fix Stored XSS in Admin Dashboard
**Vulnerability:** The admin dashboard constructed HTML directly using `innerHTML` and interpolated user-controlled data such as post titles, user callsigns, and message plaintexts without sanitization, leading to a Stored Cross-Site Scripting (XSS) vulnerability.
**Learning:** Even internal admin dashboards are vulnerable if they display user-generated content without proper escaping. `innerHTML` is inherently dangerous when mixed with user data.
**Prevention:** Always escape user-controlled data before interpolating it into HTML strings, or use DOM APIs that inherently escape content (e.g., `textContent`).

## 2025-05-10 - [Sentinel] Remove Hardcoded Secrets
**Vulnerability:** A hardcoded dev secret was exposed as a fallback value for the `DIRECTORY_API_KEY` in `apps/server/src/directory-publisher.ts`.
**Learning:** Hardcoded fallbacks pose significant risk if accidental production leaks occur or if external services can be invoked with a default dev key.
**Prevention:** Always ensure configuration requires environment variables for API keys and fails securely if they are not provided, avoiding string fallbacks.

## 2026-05-11 - [Sentinel] Fix Command Injection in Backup/Restore
**Vulnerability:** Command injection risks existed in `apps/server/src/https-server.ts` where `execSync` was used to execute shell commands with user-influenced file paths (e.g., `tar -xzf "${tarPath}" -C "${tmpDir}"`).
**Learning:** `execSync` executes a command within a shell, making it susceptible to injection if arguments aren't strictly sanitized. Even in admin-authenticated endpoints, this represents a significant risk.
**Prevention:** Use `execFileSync` (or `spawn`) and pass arguments as an array rather than a single string. This bypasses shell interpolation. Additionally, handle standard streams programmatically (e.g., `{ stdio: ['ignore', 'pipe', 'ignore'] }`) instead of using shell redirects like `2>/dev/null`.

## 2026-05-11 - [Sentinel] Final XSS Hardening of Admin Dashboard
**Vulnerability:** Remaining `innerHTML` injection points were discovered in the administrative dashboard (`settings.js`), including Nominatim location search results, Trusted Connectors management, health alert descriptions, and moderation reports.
**Learning:** Initial security patches often miss secondary or "edge" data display points. A comprehensive audit specifically targeting dangerous sinks like `innerHTML` is necessary for full remediation.
**Prevention:** Standardized the use of a global `esc()` helper for all user-controlled data. Hardened `onclick` action handlers by escaping IDs to prevent JS string break-outs. Fixed message rendering logic to handle escaping internally while preserving system-generated HTML formatting.

## 2026-05-20 - [CRITICAL] Fix Authorization Bypass in requireSignature Middleware
**Vulnerability:** Multiple sensitive POST endpoints — `/api/ratings`, `/api/reports`, `/api/friends/*` (including guardian assignment, an identity-takeover primitive), `/api/recovery/*`, `/api/push-tokens`, `/api/members/preferences`, `/api/commons/vote`, and the entire `/api/marketplace/transactions/*` family — were missing from the explicit `isProtected` allowlist in the `requireSignature` middleware. Attackers who knew a user's public key (publicly visible via `/api/members`) could bypass Ed25519 signature verification and impersonate any user. Several client callsites in the native app also POSTed to these routes without signing, meaning the server fix alone would silently break legitimate flows.
**Learning:** This is the fifth sentinel ticket on the same class (see closed PRs #30, #32, #34, #56, #57). The proximate cause is a hand-maintained "protect-list" pattern that defaults new routes to unauthenticated. The deeper root cause is that authentication is opt-in on both sides of the wire: the server route must be added to `isProtected` *and* the client callsite must be wired through a signing helper. Either omission silently fails open. There is also a second drift-prone list inside the middleware itself: a hand-maintained set of body-field spoof checks (`publicKey`, `raterPubkey`, `ownerPubkey`, ...) that must be updated whenever a new identity field name enters a request body. Two append-only critical-path lists is one too many.
**Prevention:** Broadened the protect-list to cover every currently-vulnerable route, added an exported `signedRequest` helper on the client to centralize signing, and shipped a standalone `scripts/verify-auth-boundary.mjs` that POSTs unsigned/forged/spoofed requests to every protected route and exits non-zero if any boundary check fails. Follow-up work tracked separately: flip the middleware to deny-by-default with a small public allowlist, move handlers off body-field identity onto a verified `ctx.state.actor`, and add proof-of-possession to `/api/invite/redeem*`.

## 2026-05-21 - [Sentinel] Fix Sensitive Data Exposure in Restore Endpoint
**Vulnerability:** The admin database restore endpoint (`/api/local/admin/restore`) previously accepted the administrative password as a URL query parameter (`?password=...`), exposing the credential to server access logs, browser history, proxy logs, and network referrer headers.
**Learning:** Passing credentials or high-privilege administrative keys via URL query strings is insecure because HTTP paths are frequently logged or transmitted to third parties (e.g., via Referer headers or browser extensions).
**Prevention:** Relocated administrative authorization to a custom HTTP request header (`X-Admin-Password`). Updated the server to parse the password from this header and updated `settings.js` to transmit the key in the HTTP headers of the `POST` restore request rather than in the URL.

## 2026-05-21 - [Sentinel] Deny-by-Default Boundaries & Cryptographic P2P Sync Hardening
**Vulnerability:** 
1. The `requireSignature` auth filter previously used an "opt-in" allowlist, meaning new mutating API routes were unauthenticated by default.
2. Naive body spoof checks blocked legitimate cross-identity fields like rating targets (`targetPubkey`) and recovery keys (`oldPubkey`).
3. P2P sync data was imported directly into SQLite without peer cryptographic verification, exposing nodes to replica-poisoning/spoofing.
**Learning:** 
1. High-security boundaries must fail-secure (deny-by-default) rather than relying on developer opt-in.
2. Spoof protection must distinguish between the request initiator and other entities.
3. Decentralized sync must cryptographically assert peer identity using stable node keypairs rather than blindly trusting transport channels.
**Prevention:**
1. Flipped middleware to deny-by-default, allowlisting only public and admin password routes.
2. Implemented precision-scoped body spoof checking by matching initiator keys while excluding non-sender fields (`target*`, `old*`, `to*`, `invited*`).
3. Refactored mutating routes to consume verified `ctx.state.actor`.
4. Cryptographically secured P2P sync using Ed25519 payload signing (`exportSyncState`) and public key protobuf verification (`importRemoteState`).
5. Added administrative sliding-window rate limiting (60 req/min per IP) and standard global modern security headers.

## 2026-06-19 - [Sentinel] Improper Control of Navigation (PWA-5) — RESOLVED, do NOT re-file
**Vulnerability:** `MessagesPage.tsx` navigated to a post by assigning `window.location.href = "/?post=" + metaObj.postId`, a direct navigation sink flagged as Improper Control of Navigation (open-redirect/XSS class) that also forces a full page reload and loses SPA state.
**Fix landed:** Both escrow buttons now call `onNavigate?.('marketplace', metaObj.postId)`; `MessagesPage` receives `onNavigate` from `App.tsx` (`navigateToTab`), matching the existing prop convention used by `MapPage`/`MarketplacePage`/`PeoplePage`. The `window.location.href` sink is removed entirely (no fallback). Landed by martin consolidating duplicate PRs #120 and #121 — two PRs for the same issue. Prefer the existing `onNavigate(tab, ctxId)` signature over a bespoke `onNavigatePost` prop. NOTE: PR #121 also rewrote this entire journal, deleting the operating-policy header and every prior entry — never replace this file; append only.

## 2026-06-19 - [Sentinel] Android cleartext (NAT-4) — REJECTED, do NOT re-file as a blanket removal
**Proposed (PRs #125, #127):** Remove `"usesCleartextTraffic": true` from `apps/native/app.json` to force HTTPS/WSS.
**Why rejected:** This BREAKS production. BeanPool is a local-first / P2P app: users connect to community nodes by typing a bare LAN IP, and `utils/node-url.ts::normalizeNodeUrl` deliberately downgrades bare IPs to `http://` (the settings field literally suggests `e.g. http://192.168.1.55`). The sync REST calls (`services/pillar-sync.ts`) and the WebSocket client (`services/ws-client.ts`, `http→ws`) then talk cleartext to `http://192.168.x.x:8080` / `ws://192.168.x.x:8080/ws`. With `minSdkVersion: 26`, removing the flag means Android API 28+ blocks ALL non-localhost cleartext → LAN sync and WS reconnect fail for anyone on a private/community node.
**Correct fix (if pursued):** Do NOT remove the flag outright. Ship a scoped Android `networkSecurityConfig` that permits cleartext only for private/link-local ranges (10/8, 172.16/12, 192.168/16, *.local) while denying it for public domains — or require https/wss for non-LAN hosts in `normalizeNodeUrl`. Until that lands, `usesCleartextTraffic: true` stays.


## 2026-06-24 - [CRITICAL] Fix Unbounded Stream Reads (DoS Risk)
**Vulnerability:** In `apps/server/src/sync-protocol.ts`, `federation-protocol.ts`, and `handshake.ts`, the `readFromStream` function read incoming streams directly into a memory buffer without enforcing a maximum payload size. This allows a malicious peer to exhaust server memory, causing a Denial of Service (DoS) by sending an unending stream.
**Learning:** Libp2p stream chunking and raw text buffers can grow indefinitely if unconstrained. You cannot rely on a valid JSON structure (`try { JSON.parse(text) }`) to bound the size, as an attacker can simply send malformed or incomplete data continuously.
**Prevention:** Always enforce a strict upper bound (e.g., 10MB) when buffering streams in memory before processing them. Track `totalLength` as chunks arrive and short-circuit the connection with an error if the threshold is exceeded.

## 2026-06-26 - [Primary agent] Phase 1: mirror → one-directional live backup (in-flight PR)
**Branch:** `feat/phase1-one-directional-backup` (off `main`; NOT committed to main). One open PR.
**What:** Replaces the bidirectional `mirror` replication with a one-directional live backup so the
PRIMARY imports NOTHING inbound (closes the SRV-20/21 ledger-forgery vector on the live authority).
- `NODE_ROLE` (default `primary`) — hard guard at the top of `importRemoteState`: only a `backup`
  may import. New `getNodeRole`/`setNodeRole`/`promotionSanityCheck` in `state-engine.ts`.
- New read-only `GET /api/local/admin/sync-snapshot` (admin-password header) on `https-server.ts`.
- New `backup-puller.ts` (HTTPS snapshot pull on the backup); wired in `index.ts`.
- Tests: new `test-backup-topology.ts` (10/10); updated `test-sync-signature.ts` (10/10) +
  `test-delta-sync.ts` (9/9) for the role model.
**Do NOT:** re-file a "P2P sync trust" or "mirror import" fix against this — the import path is now
role-gated by design and all SRV-20/21 hardening is intentionally KEPT as a dormant safety net (do
not "clean it up" as dead code). Coordinate here before touching `importRemoteState` / sync trust.
**Note:** left an unrelated `apps/native/app.json` version bump (1.1.53/169) untouched in the working
tree — that's someone else's change, kept out of this PR.

## 2026-06-28 - [Primary agent] Backend security cutover executed on the TEST PAIR
**What:** Ran the `docs/SECURITY-CUTOVER-CHECKLIST.md` cutover on `test`(5, primary) + `test-mirror`(6,
backup). No server *code* changed — this was ops + config. The only code/doc change is a small PR
(below). Do NOT revert or "tidy" these.
- **Deployed current `main`** to both (Phase 1 + all A2 fixes).
- **Topology:** `test` = `NODE_ROLE=primary`, `connectors.json=[]` (imports from nobody). `test-mirror`
  = `NODE_ROLE=backup`, one passive (`enabled:false`) `mirror` connector at the primary's PeerID
  (`/p2p/12D3KooWM5k4...EB6r6`), `BACKUP_PRIMARY_URL=https://test.beanpool.org`. Backup pulls + converges.
- **Ledger migration (IRREVERSIBLE)** run on both (`dist/srv20-ledger-reset.js`): txns cleared, balances 0,
  members+offers preserved. `data/` tarballs saved on the host (`beanpool-premigration-*`).
- **Flags ON** on both: `ENFORCE_READ_AUTH` / `ENFORCE_WS_AUTH` / `ENFORCE_LEDGER_AUTH`. Verified: gated
  reads + unsigned `/ws` → 401; public allowlist open; backup keeps pulling (admin path); failover
  promotion `✅ PROMOTION OK`.
- **Admin password** reset on both to the shared operator value (held only in each node's chmod-600
  `.env` as `ADMIN_PASSWORD` / `BACKUP_ADMIN_PASSWORD` — not recorded here). The old March lock ignored
  every redeploy (`initAdminPassword` skips when `isLocked`), so the auth fields were nulled + restarted.
**Env mechanism (small PR off `main`, user admin-merges):** `docker-compose.yml` now declares
`NODE_ROLE`/`BACKUP_*`/`PROMOTED_FROM_BACKUP`/`ENFORCE_*` as `${VAR:-}` passthroughs; `deploy.sh` now
preserves a node-local `.env` across the `rm -rf` (like `data/`). Per-node role/flags/secrets live in
that `.env` (chmod 600). Empty defaults = primary/flags-off (safe dormant). Checklist updated (compiled-JS
migration cmd + admin-lock gotcha).
**Do NOT touch:** `review`(4), `mullum1`(1), `mullum2`(2) — production cutover is NOT done yet (pending
on-device app validation on the test pair).

## 2026-06-28 - [Primary agent] Removed the dead mirror P2P sync stack (branch cleanup/remove-mirror-p2p-sync)
Backups are an HTTPS snapshot pull now (Phase 1); the libp2p mirror sync protocol was dormant dead code (no enabled connectors ever triggered it) and is removed to shrink attack surface before open-sourcing.
**DELETED:** `sync-protocol.ts` (v1+v2 hash/payload/delta/event handlers, syncWithPeer, readFromStream), `push-on-write.ts`, `exportDeltaState`/`hasDeltaContent`, the connector-manager sync/fullResync timers, and the now-dead `broadcastHook`/`setBroadcastHook` plumbing. Tests `test-delta-sync.ts`/`test-stream-read.ts` deleted.
**KEPT — do NOT "restore" or file findings against their absence:** `importRemoteState` + ALL SRV-20/21 guards (they run on the HTTPS backup pull, still the security boundary), `exportSyncState`, federation (`federation-protocol.ts` + `handshake.ts` + `peer` connectors), the `wsClients` live `/ws` fanout in `broadcast()`, the libp2p signing identity.
**Do NOT re-file a "P2P sync trust" / "unauth mirror import" finding against the deleted code** — the only inbound import path is now the HTTPS pull, gated by the kept guards. tsc clean; test-backup-topology 10/10, test-backup-hardening 13/13, test-sync-signature 10/10.

## 2026-07-01 - [Primary agent] Closed stale Sentinel PRs (#154, #167, #173, #175, #177) — reimplemented on main
These were reviewed and **CLOSED, not merged**: their branches had ~260-file drift off an old base and were unmergeable. The real fix from each was reimplemented cleanly on current `main`. Please do NOT re-raise these — they are resolved:
- **readBody body-size DoS (#154):** already fixed on `main` — `MAX_JSON_BODY_BYTES = 2 MB` cap in `readBody` (A2-10/SRV-11), stricter than the proposed 10 MB and without the `req.destroy` EPIPE race. No change needed.
- **Restore upload/stream disk DoS (#167, #175, #177):** fixed on `main` in commit `9ea04ed` — `/api/local/admin/restore` rejects an over-limit `Content-Length` up front AND enforces a 500 MB cap on the bytes actually streamed, aborting + cleaning up the partial tarball (returns 413). #177 was a same-issue re-raise.
- **Hardcoded Google Maps API key (#173):** fixed on `main` in commit `660d429` — removed from `apps/native/app.json`, injected from `GOOGLE_MAPS_API_KEY` via a new `apps/native/app.config.js` (key is being rotated as part of open-source prep).
**Process note:** branch from CURRENT `main` before opening PRs — recent branches were unmergeable due to large drift. The repo is about to be FLATTENED to a fresh history for open-sourcing, so open PR branches are throwaway — coordinate with the human before raising new ones.
