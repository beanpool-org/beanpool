# SRV-20 — Verifiable Ledger (Signed Transactions) — Design Doc

**Status:** Draft for decision (pre-launch)
**Date:** 2026-06-21
**Relates to:** SRV-20 / SRV-1 / SRV-21 in `SECURITY-AUDIT.md`; builds on the mirror-only import gate (PR `fix/srv-20-mirror-only-ledger-import`).

---

## 1. Problem

`importRemoteState` accepts a sync payload from a trusted `mirror` connector and writes its
members / accounts / transactions wholesale. The mirror-only gate (shipped) proves the payload
came from a node the operator designated for replication — but it does **not** prove the
*contents* are authentic. A **compromised or malicious mirror can forge any balance, member, or
transaction** for any pubkey.

The root cause: **the ledger is not cryptographically self-verifying.**
- `transactions` rows carry **no signature** (see `apps/server/src/db/schema.sql` — `id, from_pubkey,
  to_pubkey, amount, tax_fee, memo, timestamp`, nothing else).
- The X-1 request signature authenticates the *HTTP call* that creates a transfer, but it is
  **consumed at request time and never stored on the row**, so it cannot be re-verified when
  another node imports that transaction later.
- `accounts.balance` is transmitted and trusted as an authoritative value, rather than derived
  from a verifiable history.

## 2. Goal

A node accepts a transaction **only if it can cryptographically verify who authored it**, and
balances are **derived from the verified transaction log** rather than trusted as imported
values. After this, a compromised mirror can no longer forge member-to-member value movement.

## 3. Design

### 3.1 Signed transaction format
Add to the `transactions` table:
- `signature` (base64 Ed25519)
- `signer_pubkey` (hex)
- `nonce` (hex) — prevents two economically-identical transactions from sharing a signature

Define one **canonical serialization** signed by the author, binding every economically-relevant
field so a signature can't be transplanted to a different transaction:
```
from \n to \n amount \n tax_fee \n memo \n timestamp \n nonce
```
This is distinct from the X-1 *request* signature (which stays, for API auth). This signature is
**persisted on the row** and travels with the transaction across nodes.

### 3.2 Two transaction classes

| Class | Examples | Signed by | Verified against |
|---|---|---|---|
| **Member-authored** | transfers, pledges | the `from` member's Ed25519 key | `signer_pubkey == from_pubkey`, signature valid |
| **Node-authoritative** | demurrage, escrow moves, transaction fees, genesis grants, opening balances | the **node's identity key** | `signer_pubkey` maps to a trusted mirror/node key |

**Why two classes:** many transactions have *no member to sign them* — demurrage
(`account → COMMONS_POOL`), escrow/marketplace/crowdfund moves, and genesis grants originate from
synthetic accounts (`COMMONS_POOL`, `escrow_*`, `genesis`, `SYSTEM`) that **hold no private key**.
These must be signed by the node itself.

**Residual (must be accepted):** a compromised node can still forge its *own* node-authoritative
transactions (e.g. mint demurrage credit). This is **strictly smaller** than today's exposure
(member transfers become unforgeable) and is bounded by rule-based sanity checks (demurrage is
rate-limited per the protocol constants; escrow nets to zero). Closing it entirely would require
threshold/multi-node signing — explicitly **out of scope**.

### 3.3 Balance derivation
- Stop treating imported `accounts.balance` as authoritative.
- On import, apply only **verified** transactions, recompute affected balances from the log, and
  **reject or flag** an imported balance that disagrees with the derived value beyond a rounding
  tolerance.
- **Prerequisite refactor:** escrow/crowdfund paths in `apps/server/src/db/db.ts` currently mutate
  `accounts.balance` directly, *partly outside* the transaction log. They must emit
  node-authoritative transaction rows so balances are **fully** derivable. (Without this, derived
  balances won't match and legitimate sync breaks — the SRV-21 "don't break legit sync" lesson
  applies hard here.)

### 3.4 Import enforcement (`importRemoteState`)
- Keep the mirror-only gate (shipped).
- For each imported transaction: verify `signature` over the canonical form against `signer_pubkey`;
  authorize `signer_pubkey` (member's own key for member txns; trusted node key for system txns).
- **Hard cutover:** reject unsigned / unverifiable transactions outright. (A "verify-if-present"
  phase is possible but does not deliver the guarantee — see §5.)

### 3.5 Client changes
- PWA (`apps/pwa/src/lib/api.ts`) and native (`apps/native/utils/...`): when creating a
  transaction, compute the canonical form, sign with the member's key, and send
  `signature + signer_pubkey + nonce`. This is **separate** from the existing X-1 request signing.
- PWA ships automatically on node redeploy (served by the node). **Native requires a standalone
  rebuild**; existing native installs that don't sign transactions will be rejected.

## 4. Migration — what survives the cutover

**The signing requirement applies only to the *ledger* (transactions + derived balances).
Identity and content tables are untouched.**

| Data | Survives? | How |
|---|---|---|
| **Members** (identities, callsigns, tiers, vouches) | ✅ Yes | Not transactions — preserved as-is |
| **Offers** (`posts`) + photos | ✅ Yes | Not transactions — preserved as-is |
| **Messages, friends, ratings, projects** | ✅ Yes | Not transactions — preserved as-is |
| **Balances** (everyone's current credit) | ◐ Optional | Reset for test (operator's call); preservable via opening-balance snapshot if ever needed |
| **Granular transaction history** (line-by-line transfers) | ❌ Reset | Unsigned & unverifiable |

**Operator decision (2026-06-22):** for the **test** cutover, balances are NOT important — a clean
ledger slate is fine. The hard requirement is that **offers (`posts`) survive** (to keep testing
accept/complete flows); **members** ideally survive too (so testers don't re-enter details). So the
test migration is simply:
- **Keep:** `members`, `posts` (+ photos), `messages`, `friends`, `ratings`, `projects`.
- **Reset:** `transactions` + `accounts.balance` (start at 0 / default floor). No snapshot needed.

**Opening-balance snapshot** (OPTIONAL — only if balances must be preserved, e.g. a future
production cutover):
1. Snapshot every account's current `balance`.
2. On the new signed system, emit **one node-authoritative "opening balance" transaction per
   account** that sets it to the snapshot value (same class as genesis grants).
3. Everyone keeps the credit they have; the unverifiable history is discarded (or archived
   read-only for display — not part of the verified ledger).

So to "can we copy users and offers back?" — **yes, fully**, and balances too *if* we ever want them
(via the optional snapshot). Only the per-transaction history is not carried forward in verifiable
form (it's unverifiable by definition).

## 5. Rollout — app-first (decided 2026-06-22)

App-store review takes 3–4 days, so we **ship the native client first** and flip the backend only
once the new app is approved and adopted. This avoids "backend requires signatures, but no approved
app can produce them."

**Order:**
1. **Native build with additive transaction-signing** — signs each transaction and sends the
   signature in **request headers** (NOT the JSON body — the body is scanned by the existing
   `*pubkey` spoof-check). It must not change the existing request contract.
   → This build is **backwards compatible with the current (old) node**: the node destructures only
   the fields it knows (`{ to, amount, memo }` + verified actor) and ignores the extra headers, so
   the new app behaves exactly like today against today's node. **No node-side compat work needed.**
   → Submit to the app store; wait for approval + tester adoption.
2. **Backend signed-ledger change + migration** (Phases A–C, E) — build while the app is in review.
3. **Cutover:** redeploy `test` + `test-mirror` with enforcement on + the test migration (keep
   members/offers, reset ledger). The **PWA updates automatically** on redeploy (served by the
   node); native is already capable. One native build spans the whole transition — no second
   release at cutover.

The only unavoidable cost: a tester who never updates the app breaks at cutover — but app-first
minimises that window (cut over only after the new app is widely installed).

**Alternative considered — phased "verify-if-present":** add columns, clients populate, server
verifies only when present. Non-breaking but provides **no guarantee** (a forger just omits the
signature), so it's only useful as a warm-up, not the end state.

**Scope check:** any other mesh node that syncs with these (`mullum1`, `mullum2`, `review`) needs
the same update, or it can no longer replicate. Confirm whether they're isolated before cutover.

## 6. Effort & sequencing

| Phase | Work | Risk |
|---|---|---|
| A | Schema + canonical form + sign/verify helpers (`core` + server) | Low |
| B | `importRemoteState` per-transaction verification | Medium |
| C | **Balance derivation + escrow/crowdfund → signed txn rows** | **High** (correctness; can break legit sync) |
| D | Clients sign transactions (PWA + native) | Medium (native rebuild) |
| E | Migration script + cutover + redeploy + native rebuild | Medium (data reset) |

Risk is concentrated in **Phase C**. The work is meaningful — not a patch — which is why it's a
deliberate pre-launch decision rather than a drop-in.

## 7. Decisions

**Decided (2026-06-22):**
- ✅ **Rollout = app-first, hard cutover** (see §5). Ship the additive-signing native build first;
  flip the backend once it's approved/adopted.
- ✅ **Test migration = keep members + offers, reset ledger** (balances not preserved; see §4).
- ✅ **History** — dropped for the test cutover (no read-only archive required).

**Still open:**
1. **Node-authoritative signing** — sign system transactions (demurrage/escrow/genesis) with the
   node identity key, accepting the bounded "compromised node can forge *system* txns" residual?
   (Recommended yes — member transfers become unforgeable regardless.)
2. **Mesh scope** — are `mullum*`/`review` isolated from `test`/`test-mirror`, or do they sync with
   them (and therefore need the same update before cutover)? **This is the blocker to confirm.**
