# ⚠️ Operating policy — READ BEFORE OPENING ANY PR

This repo has accumulated many duplicate Bolt PRs (15+ filing the same "member
lookups/counts → O(1)" fix). Before opening a PR:

1. **Check for duplicates first.** Run `gh pr list --state all --search "<keywords>"`
   and read the diffs of any open / recently-merged / recently-closed PRs touching
   the same file or topic. If an equivalent change is already open, merged, or
   closed-as-rejected, **do not open another** — append a note here and stop.
2. **One issue → one PR.** Never re-file a fix that already landed. Treat merged and
   closed PRs as final; only revisit a topic if you can cite the specific commit that
   regressed it.
3. **Verify against current `main`**, not a stale checkout. Several past PRs conflicted
   because they were written against old code (e.g. before a column/refactor landed).
4. **Record outcomes below** so the next run sees what's already done.

## ✅ Resolved — do NOT re-file (2026-06-14, landed in #111)
- Member lookups → O(1): `getMembers().find(m => m.publicKey === x)` replaced with
  `getMember(x)` in federation-protocol, https-server, federation-api.
- Member counts → O(1): `getMembers().length` replaced with SQL `COUNT` in
  `/node/info` and `getCommunityHealth`.
- Marketplace tx-by-id: added `getMarketplaceTransaction(id)`; the 7
  `getMarketplaceTransactions(...).find(t => t.id === id)!` sites (which silently
  broke past the getter's `LIMIT 50`) now use it.
- Social-recovery `/api/recovery/lookup/:callsign` N+1: the per-row
  `getGuardiansOf()` filter is now a single SQL subquery.
- `/api/node/info` counts are O(1) (#111 memberCount, #118 postCount). For postCount use
  `getActivePostCount()`, NOT `getCommunityInfo().postCount`: `pausePost()` leaves
  `active=1` with `status='paused'`, so a plain `COUNT(active=1)` over-counts by including
  paused posts. (Closed PR #116 made exactly this mistake — do not re-file it.)
- NOTE: the federation-api `verify_member`/`relay_message` lookups some PRs "fixed"
  are inside a commented-out `[SECURITY PATCH]` block (dead code) — do not edit.

### Coordination note (2026-06-25, from the primary agent)
- **Connector-lookup optimization — canonical open PR is #141.** Duplicates **#133,
  #135, #140 were closed** (all the same `connector-manager.ts` change). **Do not
  re-file** — review/merge #141. NB it likely needs a rebase: `https-server.ts`
  changed substantially on `main` (WS-auth / read-auth middleware).

---

## 2026-05-11 - [O(N^2) Array Filtering on Relational Data]
**Learning:** In `state-engine.ts`, fetching associated relational data (like photos for posts) was done by running `.filter()` on an entire array of relational objects inside a `.map()` block across all rows. For large datasets, this N+1 in-memory problem creates an O(N^2) complexity that blocks the single-threaded Node.js event loop.
**Action:** When mapping relational rows to nested objects, pre-group the relational arrays using a `Map` structure with the foreign key (e.g., `post_id`) as the key to convert the operation into an O(N) lookup.
## 2026-05-18 - [O(N^2) Nested Filtering in Invite Tree Generation]
**Learning:** In `apps/server/src/state-engine.ts`, the `getInviteTree` function previously filtered the entire `allMembers` array for every node recursively (`O(N^2)` complexity). This is a known performance anti-pattern in the codebase that can block the Node.js event loop with large datasets.
**Action:** When performing nested array associations (like building trees from flat lists), pre-compute a lookup `Map` grouping items by their parent key (e.g. `invitedBy`) to convert nested filtering into `O(N)` key lookups.

## 2026-05-21 - [N+1 Query on Profile Endpoint]
**Learning:** The administrative data endpoint `/api/local/admin/data` previously fetched all member profiles using `.map(m => getProfile(m.publicKey))` after retrieving all members. This triggered N+1 separate SQLite queries. For large member registries, this results in significant database roundtrips and blocks the Node.js event loop.
**Action:** Implemented `getAllProfiles()` in `state-engine.ts`, which fetches all member profiles via a single batch query (`SELECT * FROM members`) and applies contact visibility settings in-memory. Replaced the N+1 loop with this batch helper in the admin data controller.

## 2026-05-21 - [Array Allocations and O(N) Database Lookups in Social Recovery]
**Learning:** In `createRecoveryRequest()`, validating guardian guess callsigns was previously done by mapping the guardian public keys to member profiles, filtering out empty profiles, and then executing `.some()` against the resulting array. This led to unnecessary allocations (`.map()` and `.filter()`) and executed database lookups for all guardians even if a match was found in the first element.
**Action:** Refactored the lookups using `guardians.some(...)` with hoisted, pre-normalized callsign comparison. This enables short-circuiting database reads and completely avoids intermediate array allocations.

## 2026-06-19 - O(N²) dedup in admin inbox handler
**Learning:** In the `/api/local/admin/inbox` handler (`https-server.ts`), legacy 'system' conversations were de-duplicated against the admin's conversations with `legacyConvs.filter(c => !convs.find(x => x.id === c.id))` — an O(N²) nested scan that blocks the event loop on large inboxes.
**Action:** Pre-compute `const convIds = new Set(convs.map(c => c.id))` once, then filter with `!convIds.has(c.id)` for O(1) lookups → O(N) overall. Landed by martin consolidating duplicate PRs #123 and #126 (identical fixes). When filtering one array against another by id/key, always build a Set first.


## 2026-07-01 - Closed perf PRs #174/#176 — reimplemented on main (connector lookups)
**Learning:** `getConnectorsByLevel` and `getPeerOrigins` still called `getConnectors()` (which allocates a merged `ConnectorStatus` for every connector) before filtering. Reimplemented on current `main` in commit `5cb77c2`: iterate the raw `connectors` array and only materialize matches (`getPeerOrigins` yields `publicUrl` directly, no status merge) — matching the pattern already applied to `getConnectorByPublicUrl`/`isPeerTrusted`. PRs #174 and #176 (duplicates) were CLOSED, not merged — their branches had ~260-file drift and were unmergeable.
**Action:** Branch from CURRENT `main` before raising PRs. The repo is about to be flattened for open-sourcing, so open PR branches are throwaway — coordinate with the human first.

## 2026-07-02 - O(N^2) Nested Scan During Ledger Audit Export
**Learning:** In `apps/server/src/state-engine.ts`, the `exportLedgerAudit` function used `members.find(...)` inside a loop over `pendingTxs` array to lookup the member details associated with a transaction. This `.find` creates an `O(N * M)` nested scan since it repeatedly scans over the entire list of community members.
**Action:** When filtering or enriching rows sequentially, use `Map` lookups instead. A Map can be created via `const membersByPubKey = new Map(members.map(m => [m.publicKey, m]));` and then the lookup happens with an `O(1)` Map retrieval via `membersByPubKey.get(tx.buyer_pubkey)`. This transforms an O(N^2) procedure into a significantly faster O(N) operation.
