# beanpool-registrar

Cloudflare Worker that leases `<name>.beanpool.org` to community nodes and keeps them honest.
Full design: [`docs/node-dns-registrar.md`](../../docs/node-dns-registrar.md).

- **Node-facing (signed):** `GET /api/registrar/available` (public) · `POST /api/registrar/claim` (a new
  name, or a heal of the claimant's own) · `POST /api/registrar/heal` · `GET /api/registrar/status` ·
  `POST /api/registrar/update` · `POST /api/registrar/release` (`/offline` is its old name and still works)
- **Admin (shared secret):** `GET /api/local/admin/registrar/pending` (every held name, any state) ·
  `GET /api/local/admin/registrar/events[?name=]` · `POST /api/local/admin/registrar/:name/`
  `approve | pause | resume | block | release` (`revoke` is block's old name). Every action is logged in
  `name_events`.
- **Switchboard:** `GET /i/:code` (trampoline) — resolves `live` and `paused` names only
- **Cron:** attestation sweep every 5 min, in two phases. Phase 1 challenges every live name
  (`/api/attest`) and writes nothing; each reply is `ok`, `impostor` (a valid signature by a
  *different* node key) or `unverifiable` (down, 5xx, not an attest, or a signature we can't verify —
  never evidence). Phase 2 runs only if the sweep is believable: a configured `CANARY_NAME` attested
  `ok`, impostors ≤ max(2, 10% of live) and not every live name, unverifiable ≤ half of live. Otherwise
  it acts on no row and logs `[ATTEST_SWEEP] suspended:…`. `ATTEST_FAIL_LIMIT` consecutive impostor
  verdicts **pause** the name (tunnel and DNS deleted, the name kept for its key); an `ok` or
  `unverifiable` verdict in an applied sweep ends the run (a suspended sweep changes nothing). Every
  sweep writes one `sweep_log` row, including a count of content-swaps (a 2xx that is no attest at all),
  which are counted only, never acted on yet. Then, applied or suspended alike, **upkeep** (not a verdict: it
  never takes routing away from a live name or routes one that isn't live): a live name whose attest reached no
  node at all (unreachable, Cloudflare's 530, or its 52x for a proxied address) is checked at Cloudflare, and if its
  record or tunnel is gone or points elsewhere it is re-made as its row says (event `repaired`; a new tunnel's
  token reaches the node through `/status`). Nodes never heal a name `/status` calls live, so this is what keeps any ordering of
  requests from leaving a live name dark. A node merely asleep costs one or two reads; one that answered
  anything costs none. Deletions Cloudflare refused earlier (`teardown`) are retried.

A tunnel or record the registrar lets go of that Cloudflare refuses to delete is recorded in `teardown`, never
dropped: another key's take-over of a name, a pause, block or release's record, the record a heal, take-back or
resume takes back down when its re-attest fails, the old tunnel of a move to a direct address, a failed request's
tunnel. The sweep retries each one, but not while it is a live name's routing
(a record at its hostname is the live row's to keep: its repair runs first, and the record stays owed until the
hostname routes as the row says) or the tunnel an admin pause keeps. A live `bp-<name>` tunnel
no row records would make Cloudflare refuse every later tunnel for the name (1013), so a claim that meets one
deletes it when it provably belongs to nobody: it is owed, or it was made before the claiming tenure or over 10
minutes ago. Otherwise the claim answers **503** "cleaning up … try again shortly".

## Ownership: a name belongs to its node's key

The registrar can stop routing a name, but never hands it to another key. A name frees only when its
owner releases it (after a 30-day hold for that same key, `RELEASE_COOLOFF_S`), when the admin releases
it, or — a later PR — after a long, warned abandonment. States (`name_allocations.status`, see
`migrations/0002_states.sql`):

| State | Routed | Another key may claim it | How it gets there · how it leaves |
|---|---|---|---|
| `pending` | no | no | a gated claim · admin approve (→ live), or a release: its key's frees it at once (nobody approved it; `pause_reason` `withdrawn`) |
| `live` | yes | no | claim / approve / heal / resume |
| `paused` | no | no | sweep impostor (`pause_reason` `impostor`), admin pause (`admin`), the 09-24 incident (`incident-2026-09-24`), a take-back not yet re-attested (`unverified`, or `impostor` if another key answered) · the owner's heal, except an admin pause, which only admin resume (or release) lifts: its owner can neither heal nor release it |
| `released` | no | after the 30-day hold (owner's release) or at once (admin's, or a withdrawn claim) | release · the same key re-claims any time; others once free |
| `blocked` | no | never | admin block (the kill switch) · admin resume or release; the owner can't heal or release it |
| `abandoned` | no | yes | a later PR |

A heal (`claim` of your own name, or `heal`) never deprovisions first: `ensure` keeps the tunnel if
Cloudflare still has it, re-PUTs the ingress, and finds the DNS record by name — keeps it, PATCHes it if it
points elsewhere, POSTs only when none exists. A paused name resumes on its owner's heal only when nobody
else can be answering: on a tunnel made in that heal (its token goes only to the signed request), or after
an edge re-attest (`/api/attest` through the hostname) signed by the owner's key. The owner taking back its
own release is routed by the same rule: the take-back first deletes a tunnel its release could not, so it
normally comes back on a fresh one; a tunnel Cloudflare still won't delete, or a direct address, routes only
after the re-attest, and otherwise the name stays paused for its key, which its next heal re-attests. `status`
reports the owner's row in any state with `reason` and `since` (and `held_until` for a release).

## Schema and migrations

`migrations/0001_init.sql` is the schema the live database already has (it was `schema.sql`).
**Never run 0001 against the live database** — its policy seed would re-add rows the live table has since
dropped (e.g. `test`). `migrations/0002_states.sql` adds the ownership columns, `sweep_log` and
`name_events`, and restores the names revoked by the 2026-09-24 incident (paused, owned by their original
keys; any name claimed since 2026-08-31 gets an `incident-review` event for a human — nobody is evicted).

Applying 0002 to the live database (Marty or the deploy workflow — not an agent):

1. Read-only preflight — what the migration will change:
   ```sql
   SELECT name, substr(node_pubkey,1,16) AS key, status, attest_fails,
          datetime(requested_at,'unixepoch') AS requested, datetime(decided_at,'unixepoch') AS decided,
          CASE
            WHEN status='revoked' AND attest_fails>=2 AND COALESCE(decided_at,requested_at)<1790233200 THEN 'paused/incident (restored)'
            WHEN status='revoked' AND attest_fails>=2 THEN 'paused/impostor'
            WHEN status='revoked' THEN 'released, held 30 days'
            ELSE 'unchanged + incident-review event'
          END AS becomes
   FROM name_allocations
   WHERE status='revoked' OR (status IN ('pending','live') AND requested_at>=1788134400)
   ORDER BY name;
   ```
   (`npx wrangler d1 execute beanpool-registrar --remote --command "<the query>"`)
2. `npx wrangler d1 execute beanpool-registrar --remote --file migrations/0002_states.sql` — **before**
   deploying the Worker that reads the new columns. The old Worker keeps working on the new schema (a
   `paused` row is just "not revoked" to it). A second run stops at its first ALTER and changes nothing.
   Then `--file migrations/0003_decision_seq.sql` (one column, `decision_seq`: the count of decisions a
   request in flight must not overwrite). Same rule: before the Worker; a rerun stops at the ALTER.
   Then `--file migrations/0004_teardown.sql` (one table, `teardown`: deletions Cloudflare refused, which the
   sweep retries). Before the Worker; a rerun changes nothing.
3. Deploy the Worker. Until the migrations table is bootstrapped with 0001 marked applied (design PR 4),
   don't use `wrangler d1 migrations apply --remote` — it would run 0001.

## Signed request scheme (node → registrar)

Headers `x-bp-pubkey` (64 hex), `x-bp-timestamp` (unix s), `x-bp-signature` (128 hex);
signed message `` `beanpool-registrar-request/v1\n${METHOD}\n${pathname}\n${timestamp}\n${bodyText}` `` with the node's Ed25519 key.

The leading domain tag is load-bearing, not cosmetic: the node signs both this and a PUBLIC attestation with the same identity key, so without distinct tags `/api/attest` is a forgery oracle for this scheme. Change it here and in `registrar-client.ts` together, never one alone.

## Attestation response (node serves at `/api/attest?nonce=`)

```json
{ "pubkey": "<hex>", "nonce": "<echoed>", "timestamp": <unix s>,
  "signature": "<Ed25519 over `beanpool-node-attest/v1\n${nonce}\n${timestamp}`, hex>" }
```

## Deploy

```bash
cd apps/registrar
npm i

# 1. D1 database (a NEW one — for the live database see "Schema and migrations" above)
npx wrangler d1 create beanpool-registrar        # paste database_id into wrangler.toml
npx wrangler d1 migrations apply beanpool-registrar --remote

# 2. Secrets (values not committed)
npx wrangler secret put CF_API_TOKEN             # scoped: Account·Tunnel·Edit + Zone·DNS·Edit
npx wrangler secret put CF_ACCOUNT_ID            # 151a28c4fd1e6ee09768f4226be76b4d
npx wrangler secret put CF_ZONE_ID               # 060a99ae34e53b26dcf3be6578722b31
npx wrangler secret put ADMIN_SECRET

# 3. Deploy + attach routes (uncomment [[routes]] in wrangler.toml first)
npx wrangler deploy
```

> The Worker attaches to `beanpool.org/api/registrar/*` and `beanpool.org/i/*` via Worker Routes and
> coexists with the existing Cloudflare Pages static site (Worker routes win for matching paths).

## Tests

`npm test` runs the Worker against an in-memory SQLite loaded with the migrations and a stateful fake of the
Cloudflare API (`test/harness.js`); no network. It includes a seeded slice of the race fuzz (`test/fuzz.test.js`,
about 12 s): a request or decision landing at each Cloudflare call of another, at its re-attest, or while the sweep
settles what is owed, with Cloudflare refusing writes for a while. After Cloudflare recovers and the sweep runs, no key
but the owner is routed, a paused, blocked, released or pending name routes nothing, a live name routes exactly what
its row records, and nothing owed is lost. `npm run fuzz` runs the whole matrix (about 35,000 cases, 3½ minutes);
`FUZZ_CASE='…'` replays one case and prints its trace.

## Status

Phase 1a (this dir): registrar core — **not yet deployed or run**; validate with `wrangler dev` + a
local D1. The CF provisioning calls it uses were proven live 2026-07-27 (`scratchpad/cf-phase0.sh`).
Next: the node `/api/attest` endpoint + phone-home client (Phase 1b), then the manager tab + sidecar (1c).
