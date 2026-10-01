# beanpool-registrar

Cloudflare Worker that leases `<name>.beanpool.org` to community nodes and keeps them honest.
Full design: [`docs/node-dns-registrar.md`](../../docs/node-dns-registrar.md).

- **Node-facing (signed):** `GET /api/registrar/available` (public) · `POST /api/registrar/claim` (a new
  name, or a heal of the claimant's own) · `POST /api/registrar/heal` · `POST /api/registrar/rotate` (a fresh
  tunnel, below) · `GET /api/registrar/status` ·
  `POST /api/registrar/update` · `POST /api/registrar/release` (`/offline` is its old name and still works) ·
  `POST /api/registrar/holder {name}` (who holds a name, below)
- **Health (public):** `GET /api/registrar/health` → `{ status: 'ok', commit, accepted_proto }`: the git commit
  this Worker was deployed from (`null` if its deploy didn't say) and the signing protocols it accepts
- **Admin (shared secret):** `GET /api/local/admin/registrar/pending` (every held name, any state) ·
  `GET /api/local/admin/registrar/events[?name=]` · `POST /api/local/admin/registrar/:name/`
  `approve | pause | resume | block | release` (`revoke` is block's old name; `release` takes
  `{"free_now": true}`, below). Every action is logged in `name_events`.
- **Switchboard:** `GET /i/:code` (trampoline) — resolves `live` and `paused` names only. `?n=<name>` (or
  `?n=<name>.beanpool.org`) names the node to join, and is answered only for a name this registrar holds **live**;
  anything else is the "not found" page, never a link to another host (before 2026-10-01 any host was linked)
- **Cron:** attestation sweep every 5 min, in two phases. Phase 1 challenges every live name
  (`/api/attest`) and writes nothing; each reply is `ok`, `impostor` (a valid signature by a
  *different* node key) or `unverifiable` (down, 5xx, not an attest, or a signature we can't verify —
  never evidence on its own). A **content swap** is an unverifiable reply that is a 2xx but no attest at all (a page,
  or JSON with no signature): something other than a BeanPool node answers at the name — a stranger's server at a
  direct name's old IP address, or a connector running on a copy of the tunnel's token. A BeanPool node never answers
  one. While a run (below) is open on a name, an `ok` is asked again, up to three answers in all: two connectors on
  one tunnel share its visitors, and the owner's answer must not hide the other one. Phase 2 runs only if the sweep
  is believable: a configured `CANARY_NAME` attested `ok`, impostors and content swaps together ≤ max(2, 10% of
  live) and not every live name, unverifiable ≤ half of live. Otherwise it acts on no row and logs
  `[ATTEST_SWEEP] suspended:…`. Two runs are counted, over applied sweeps in a row: `ATTEST_FAIL_LIMIT` (2)
  impostor verdicts, or `SWAP_FAIL_LIMIT` (12, about an hour; design D2 = b) sweeps of foreign answers (an
  impostor or a content swap; a swap counts only in a sweep that saw the verifier work: the canary `ok`, or with
  no canary some name `ok`), **pause** the name, `pause_reason` `impostor` or `content-swap` (tunnel and DNS
  deleted, the name kept for its key, its node's heal resumes it). An `ok` (three, while a run is open) or any
  other `unverifiable` verdict in an applied sweep ends the runs (a suspended sweep changes nothing). Every sweep
  writes one `sweep_log` row, including the count of content swaps. Then, applied or suspended alike, **upkeep** (not a verdict: it
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

## Limits on what a key may do (the 2026-10-01 review)

- **Names per key:** one node key holds at most `CLAIM_LIMIT_PER_KEY` names (`wrangler.toml`, default 3; a value
  that isn't a whole number ≥ 1 means 3). Counted: every name held under the key — live, pending, paused, blocked —
  and its own releases (the owner's, or the admin's default one) still inside their hold. Not counted: a release that
  freed the name at once, one past its hold, and the admin's release of a name it took from the key (held from that
  key too). A claim of a **new** name past the limit gets `403 { error, limit, held }` and writes nothing; a name the
  key already holds is healed and taken back whatever the count, so a key over the limit when it was set or lowered
  keeps everything it has. Three, because a node uses one name and a rename leaves the old one held for it 30 days:
  two renames in a month fit, and one key can hold at most three Cloudflare tunnels (the account has ~1,000). Keys
  are free to make, so this stops one script with one key, not many keys: a per-IP budget (a Cloudflare rate-limit
  rule on `POST /api/registrar/claim`) is the next step and is not built. Two claims by one key that race past the
  count are both counted again once written, and the one over the limit gives its name back before it reaches
  Cloudflare.
- **Fields:** `community_name` (or `communityName`) at most 120 characters, `contact` at most 254, both text in any
  script but with no control characters, line or paragraph separators or bidi overrides (checked after trimming);
  `origin` is `http(s)://host[:port]` and nothing more, at most 200 characters; `public_ip` is an IPv4 address (a
  direct name is an A record). A claim, heal or update carrying anything else gets a plain `400 { error }` before it
  writes anything. The node caps its community name at 60, and its self-heal sends neither field.
- **Errors:** a keyholder is never sent Cloudflare's error, which names the account and the zone: a failure at
  Cloudflare answers `502 { error: 'provisioning failed', ref }`, anything else unexpected `500 { error: 'internal',
  ref }`, and the Worker's log has the detail under that `ref`. The admin's approve and resume still show Cloudflare's
  answer (`detail`).

## Ownership: a name belongs to its node's key

The registrar can stop routing a name, but never hands it to another key. A name frees only when its
owner releases it (after a 30-day hold for that same key, `RELEASE_COOLOFF_S`), when the admin releases
it (the same hold by default, from its own key too if the admin had blocked or paused it; at once with "free now"),
or — a later PR — after a long, warned abandonment. States (`name_allocations.status`, see
`migrations/0002_states.sql`):

| State | Routed | Another key may claim it | How it gets there · how it leaves |
|---|---|---|---|
| `pending` | no | no | a gated claim · admin approve (→ live), or a release: its key's frees it at once (nobody approved it; `pause_reason` `withdrawn`) |
| `live` | yes | no | claim / approve / heal / resume |
| `paused` | no | no | sweep impostor (`pause_reason` `impostor`), sweep content swap (`content-swap`), admin pause (`admin`), the 09-24 incident (`incident-2026-09-24`), a take-back not yet re-attested (`unverified`, or `impostor` if another key answered) · the owner's heal (or rotate), except an admin pause, which only admin resume (or release) lifts: its owner can neither heal nor release it |
| `released` | no | after the 30-day hold (the owner's release, `owner`; the admin's, `admin-held`; the admin's of a name it had blocked or paused, `admin-held-all`, which its own key can't claim either) or at once (the admin's with "free now", `admin`; a withdrawn or rejected claim nobody approved) | release · the same key re-claims any time (not after `admin-held-all`: it waits out the hold like anyone, then claims as a new claimant); others once free |
| `blocked` | no | never | admin block (the kill switch) · admin resume or release (held 30 days from every key, this one included, unless "free now"); the owner can't heal or release it |
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

**Rotate** — `POST /api/registrar/rotate {name?, origin?}`, signed by the name's key (M3 of the 2026-10-01 review):
its own tunnel name, live or paused by anything but the admin, onto a fresh tunnel. The old tunnel is deleted at
Cloudflare first, so every connector running on a copy of its token (a copied data folder or backup, a standby given
away, a token shown on a screen) is cut off; then the owner's heal makes the new one, re-points the record at it (the
record is kept, never deleted: a resolver that saw the name missing would remember that for up to half an hour) and
answers with its `tunnelToken`. `origin` moves the tunnel's destination at the same time. Row first: the old tunnel
leaves the row (a decision) before Cloudflare deletes it, so a request that read the row earlier misses its write. If
Cloudflare won't delete it, it goes back on the row and the answer is **503**, nothing changed (its token still works).
If the new tunnel fails, the old one is gone all the same, and the node's next heal makes it. Refused: another key or no
name (404), blocked or paused by the admin (403), released (409: a take-back is on a fresh tunnel anyway), awaiting
approval (409), a direct name (400: it has no token; a heal with its new `public_ip` re-points it). The node's Settings
offer it as **New tunnel key**.

**The admin's release** (decision D-C, Marty 2026-09-28) holds the name 30 days for its key, as the owner's own
release does: another key's claim is refused, and the key's node takes it back with its next claim (a misclick
undone). The names page's "free now" box (`{"free_now": true}`) frees it at once, to any key, for a name being freed
for someone new; "Free now" on a held release does the same. Rejecting a gated claim nobody approved frees the name at
once either way: it was never that key's. An admin release written before D-C (`pause_reason` `admin`) stays free.

A name the admin **blocked** (the only rows the names page offers Release on), or paused itself, is different: its
default release (`admin-held-all`) holds it 30 days from **every** key, the one the admin stopped included. That key's
claim, heal and release answer 403 `name blocked`, as while it was blocked, and `status` gives it no `held_until` (there
is nothing for it to take back). Block's promise, "its node cannot heal or release it", holds through a release: its
node's public-address agent, which claims every 5 minutes, can't bring it back (r4117740868). After the hold the name is
free to anyone, that key included as a new claimant, so a gated name needs approval again. "Free now" frees it at once.
A community's own release, and the admin's release of any other row, keep D-C's meaning. A Worker rolled back past this
reads `admin-held-all` as an owner's release (held for that key, which could take it back): no worse than before D-C,
when the admin's release freed the name to any key at once, the blocked one first.

**Who holds a name** — `POST /api/registrar/holder {name}`, signed like `status` (a POST, so the name is inside the
signed bytes). It answers `{ name, held, … }`: `held` is `you` (the asking key holds it: any state that holds a name,
or its own release inside the hold), `other` (another key holds it on the same terms), `reserved` (nobody holds it and
policy keeps it from every claim; also what the key the admin stopped hears about its name inside an `admin-held-all`
hold) or `free`. `you` also carries `state`, `since` (when this key's tenure began) and, for its release inside the
hold, `held_until`. `other` is exactly `{ name, held: 'other', holder_key }`: whose it is, and nothing about another
community's row: not its state (so no admin block or pause shows), not when it claimed, not when its hold ends. Anyone
can generate a key and ask, and the node's watcher (L3) needs only `held` and `holder_key` (r4117741404). The key of a
name that routes is public already (its node's `/api/attest`); a gated claim still waiting for approval has its key
named here too. Read-only: it writes nothing, not even contact, and asks nothing of
Cloudflare or any node. A node uses it to tell whether a name it held has passed to another community
(`scratch/registrar/DESIGN-lost-name-audience-opus.md` §5); an older Worker answers 404, and the node then drops nothing.

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
   request in flight must not overwrite, and of writes recording Cloudflare work that changed routing). Same rule:
   before the Worker; a rerun stops at the ALTER.
   Then `--file migrations/0004_teardown.sql` (one table, `teardown`: deletions Cloudflare refused, which the
   sweep retries). Before the Worker; a rerun changes nothing.
   Then `--file migrations/0005_reserve_global.sql` (three `name_policy` rows, `blocked`: `global` and `earth`,
   the global node's names, and `ssh-global`, the global server's only way in). The live table already has
   `global` and `earth`, so there it adds only `ssh-global`: it adds a row only where the table has none for
   that name, never changing one it has. The Worker doesn't depend on it; a rerun changes nothing.
   Then `--file migrations/0006_request_nonces.sql` (one table, `request_nonces`: the one-use nonces of v2 signed
   requests, kept ~10 minutes). Before the Worker; a rerun changes nothing. A Worker without the table answers every
   v2 request 500 (v1 requests never touch it).
   Then `--file migrations/0007_content_swap.sql` (one column, `swap_fails`: the sweeps in a row in which something
   other than a name's own node answered at it, design D2). Before the Worker: every write that routes a name again
   resets it, so a Worker without the column fails those. A rerun stops at the ALTER.
3. Deploy the Worker.

Or let the deploy workflow apply them (below), once the live database is bootstrapped.

### `wrangler d1 migrations` and the one-time bootstrap

`wrangler d1 migrations apply` applies every file in `migrations/` that its table `d1_migrations` doesn't
record, in order, each in one transaction with its own record. The live database predates that table, so a
first `apply --remote` would run 0001 against it — and 0001 succeeds silently (`IF NOT EXISTS`, `INSERT OR
IGNORE`), re-seeding the policy rows the live table dropped. `wrangler d1 migrations list` doesn't help: it too
creates an empty `d1_migrations`. So, **once, before the deploy workflow's first run** (Marty, not an agent):

```bash
npx wrangler d1 execute beanpool-registrar --remote --file scripts/bootstrap-d1-migrations.sql
```

It creates `d1_migrations` exactly as wrangler would and records each migration whose objects the database
already has (0001's tables; 0002's seven columns, two tables and three indexes; 0003's column; 0004's table and
index; 0005's three policy rows, `global`, `earth` and `ssh-global`; 0006's table and index), then prints the table.
Safe to re-run.
Whatever it didn't record — say 0002–0005, if they were never applied by hand — the workflow applies next, before
the Worker that needs them is deployed. The live table has only two of 0005's rows (`ssh-global` was never added
by hand), so there 0005 is not recorded and the workflow applies it, adding just `ssh-global`. The workflow
refuses to apply anything until `d1_migrations` records `0001_init.sql`. (To look for 0005's rows it needs
`name_policy`, so on a database that has none — only an empty one — it first makes it exactly as 0001 does; on
any other it makes nothing but `d1_migrations`.)

`node scripts/check-migrations.mjs` (the workflow's dry-run job runs it on every registrar PR) proves this on
local throwaway databases only: `migrations apply` builds exactly the schema and policy seed that applying the
files by hand does (and that the tests' `node:sqlite` database does); the bootstrap, run on a database at any
stage of the hand path, records exactly what it has, after which `migrations apply` adds only the rest, never
re-runs 0001 (a policy row deleted beforehand stays deleted) and ends at the same schema; on the live database's
shape (`global` and `earth` by hand, no `ssh-global`) it leaves 0005 unrecorded, and `migrations apply` adds only
`ssh-global`; and the guard refuses a database never bootstrapped, including one whose empty `d1_migrations` a
`migrations list` made.

## Signed request scheme (node → registrar)

Headers `x-bp-pubkey` (64 hex), `x-bp-timestamp` (unix s), `x-bp-signature` (128 hex), and `x-bp-proto` (the
signing protocol) for any protocol but v1; signed message
`` `${PROTOCOLS[proto].request}\n${METHOD}\n${pathname}\n${timestamp}\n${bodyText}` `` with the node's Ed25519 key.
For v1 that is `` `beanpool-registrar-request/v1\n${METHOD}\n…` ``, exactly as before protocols had versions.

**v2 (2026-10-01): a one-use nonce.** A v2 request also carries `x-bp-nonce` (32 lower-case hex, fresh for each
request), signed between the timestamp and the body:
`` `beanpool-registrar-request/v2\n${METHOD}\n${pathname}\n${timestamp}\n${nonce}\n${bodyText}` ``. The Worker records
each (key, nonce) in `request_nonces` (migration 0006) before acting and answers a second request carrying it
`401 { error: 'request already used' }`, so a captured request — a `/status` with its tunnel token above all — can't be
replayed while its timestamp is inside the ±300 s window. The sweep drops nonces over 600 s old. v1 signs no nonce and
is still accepted, replayable inside its window as before, until every node sends v2: v2 is at **step 1** below (both
sides accept it; nodes still send v1). Step 2 (`SEND_PROTO = 'v2'` in the node's `registrar-client.ts`) waits for this
Worker to be live through the deploy workflow: the live Worker may predate `accepted_proto` in its 401, and a node
sending v2 to it could not fall back.

The leading domain tag is load-bearing, not cosmetic: the node signs both this and a PUBLIC attestation with the same identity key, so without distinct tags `/api/attest` is a forgery oracle for this scheme.

### Protocol versions (design §5.1)

`PROTOCOLS` in `src/sign.js` and in the node's `apps/server/src/services/registrar-client.ts` name each version's
two tags. On 2026-09-24 the node changed its tag alone (#542) and every signed request 401'd; a format change is
now a new version, never an edit of one:

1. One PR adds `v(n+1)` to **both** tables. Both sides accept it; nobody sends it yet.
2. Deploy the Worker (the deploy workflow checks the live Worker's `accepted_proto` covers every key of the
   node's table). A later node release moves `SEND_PROTO` to `v(n+1)`.
3. Two releases after that, the old entry goes from both tables — from the node's no later than from the
   Worker's, since the Worker must accept everything the node can send.

So each side accepts two versions while a change is in flight, and deploy order never matters. `v1` is
`DEFAULT_PROTO` on both sides: a request with no `x-bp-proto`, or an attestation with no `proto`, is v1. A
request under a protocol the Worker doesn't speak gets `401 { error: 'bad signature', accepted_proto }`; the node
retries once under the newest protocol both speak and logs a warning. An attestation under one is
`unverifiable` — never evidence against the node. `apps/server/src/test-registrar-contract.ts` (in
`scripts/test-all.sh`, so CI) signs with the node's code and verifies with this Worker's, and fails the moment one
side changes a tag alone.

## Attestation response (node serves at `/api/attest?nonce=`)

```json
{ "pubkey": "<hex>", "nonce": "<echoed>", "timestamp": <unix s>,
  "signature": "<Ed25519 over `${PROTOCOLS[proto].attest}\n${nonce}\n${timestamp}`, hex>",
  "proto": "<only for a protocol other than v1>" }
```

For v1 (no `proto`) the signed message is `` `beanpool-node-attest/v1\n${nonce}\n${timestamp}` ``, as before.

## Deploy

### The deploy workflow (`.github/workflows/registrar-deploy.yml`)

**Manual only, and only with Marty's approval** (director's calls, 2026-09-25 and 2026-09-26). Actions →
*Registrar deploy* → *Run workflow* → branch `main` → *Run workflow*. The deploy job then waits for approval: open
the run → *Review deployments* → tick `registrar-production` → *Approve and deploy*. Approve only a run you started
yourself, from `main`. Once approved, it refuses any branch but `main`, checks the token is set, then:

1. refuses unless the live `d1_migrations` records `0001_init.sql` (the bootstrap above);
2. lists and applies pending migrations: `wrangler d1 migrations apply beanpool-registrar --remote`;
3. `wrangler deploy --var GIT_SHA:<the commit>`;
4. fails unless `https://beanpool.org/api/registrar/health` answers that `commit` and an `accepted_proto` that
   includes every protocol in the node's `PROTOCOLS` (`scripts/deploy-checks.mjs`, polled for up to 3 minutes).

**Who can deploy is GitHub's rule, not the workflow file's.** The deploy token is a secret of the
`registrar-production` environment and nowhere else. GitHub hands an environment's secrets only to a job that names
that environment, only on a branch the environment allows (`main`), and only after a required reviewer (Marty)
approves that run. A repository secret would be different: GitHub gives it to a run from any branch, and that run
uses the branch's own copy of the workflow, so "manual only, main only" would hold only while nobody edited the
file. A pull request that edits the workflow, `gh workflow run --ref <branch>`, or another collaborator pressing
*Run workflow* would each get the token. With the environment, none of them gets it until Marty approves.

The workflow sets the token only on the steps that run wrangler against Cloudflare (and on the check that it is
set). The actions and `pnpm install` don't get it in their environment. Code they install still runs inside the
wrangler steps, though (an install script can change wrangler's files or the job's PATH), so what really limits
third-party code is that every action is pinned to a full commit SHA and the install uses the lockfile's integrity
hashes (`--frozen-lockfile`), without the dependency cache.

On every pull request that touches `apps/registrar/**` or the workflow, a **dry-run** job with no secret and no
environment:
- runs `scripts/check-deploy-workflow.mjs`, which fails if the deploy job stops naming the environment, if the
  token appears anywhere but a wrangler step's own `env`, if an action isn't pinned to a SHA, or if the workflow
  gains a trigger besides a manual run and pull requests;
- runs `wrangler deploy --dry-run`;
- lists the migrations against a fresh local database;
- runs `scripts/check-migrations.mjs`.

**One-time setup (Marty), in this order:**

1. **Cloudflare dashboard** → My Profile → API Tokens → Create Token → *Create Custom Token*, named e.g.
   `github-registrar-deploy`, with:
   - Account · **Workers Scripts** · Edit
   - Account · **D1** · Edit
   - Account · **Account Settings** · Read
   - Zone · **Workers Routes** · Edit, and Zone · **Zone** · Read — for zone `beanpool.org` only. The Worker's
     `[[routes]]` (`beanpool.org/api/registrar/*`, `/admin*`, `/i/*`) are attached by `wrangler deploy`, which looks
     the zone up by name; without these it fails at the routes step.

   Account Resources: the BeanPool account only. No IP filter (GitHub's runners have no fixed address). Keep the
   token on screen for step 2.
2. **GitHub → the repo → Settings → Environments → New environment**, name `registrar-production` → *Configure
   environment*. (If `registrar-production` is already listed, open it instead: a run that names an environment
   creates it, empty and unprotected.) On that one page, top to bottom:
   - **Required reviewers**: tick it and add `martyinspace`. Leave **Prevent self-review** unticked, or you can't
     approve a run you started.
   - **Allow administrators to bypass configured protection rules**: untick it, so nobody can skip the approval.
     You are the only admin today.
   - Click **Save protection rules**.
   - **Deployment branches and tags**: choose *Selected branches and tags* → *Add deployment branch or tag rule* →
     Ref type *Branch*, name pattern `main` → *Add rule*. Add no other rule, and never `refs/pull/*/merge`.
   - **Environment secrets** → *Add environment secret*: name `CLOUDFLARE_WORKERS_TOKEN`, value the token from
     step 1 → *Add secret*.
3. **GitHub → the repo → Settings → Secrets and variables → Actions.** Under *Repository secrets* (and
   *Organization secrets*), `CLOUDFLARE_WORKERS_TOKEN` must not be listed; delete it if it is. Never add it there:
   every branch could read it. (On 2026-09-26 neither list had any secret.)
4. Run the bootstrap above once, from `apps/registrar`.

Treat this token as holding the Worker's own secrets. Workers Scripts · Edit can upload a new version of
`beanpool-registrar`, and a new version keeps the Worker's secret bindings, so whoever holds the token can read
`CF_API_TOKEN` (tunnels + DNS for `beanpool.org`: every community's address) and `ADMIN_SECRET`. That is why it lives
only in the approval-gated environment. The Worker's `CF_API_TOKEN` itself stays a Worker secret and is never in
GitHub.

### By hand (a new database, or without the workflow)

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

# 3. Deploy + attach routes
npx wrangler deploy --var GIT_SHA:$(git rev-parse HEAD)
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
`FUZZ_CASE='…'` replays one case and prints its trace. `test/review-2026-10-01.test.js` covers the 2026-10-01 review's
fixes: the switchboard's `?n=`, the field caps, the per-key limit (and its races), v2's nonce and replay refusal (and
v1 nodes still working), and no Cloudflare ids or error bodies in an answer to a keyholder. `test/m3-2026-10-02.test.js`
covers its M3: a content swap paused after 12 applied sweeps in a row and not before, what ends a run and what a
suspended sweep leaves alone, the mass breaker counting swaps, two connectors on one tunnel (another key, or a page,
every other answer), a direct name's address passed to a stranger, and rotate (its refusals, Cloudflare refusing or
failing it, and the admin's pause landing during it).

The signing contract with the node is tested from the node's side: `apps/server/src/test-registrar-contract.ts`
(run by `scripts/test-all.sh`) imports this Worker's `src/` and the harness. `node scripts/check-migrations.mjs`
checks the migrations and the bootstrap on local databases (about 40 s; needs wrangler).
`test/deploy-workflow.test.js` (in `npm test`) runs `scripts/check-deploy-workflow.mjs` on the deploy workflow,
and on copies with one regression planted each (the token at job level, in `pnpm install`, in an action, in the
dry-run job; no environment; a push trigger; an action on a tag), each of which must fail.

## Status

Phase 1a (this dir): registrar core — **not yet deployed or run**; validate with `wrangler dev` + a
local D1. The CF provisioning calls it uses were proven live 2026-07-27 (`scratchpad/cf-phase0.sh`).
Next: the node `/api/attest` endpoint + phone-home client (Phase 1b), then the manager tab + sidecar (1c).
