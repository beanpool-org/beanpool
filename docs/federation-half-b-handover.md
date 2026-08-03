# #143 Federation connector — handover

**As at 2026-08-03.** Written at a context/quota boundary, so it states what is *verified*, what is *built but
unproven*, and the one job left. Nothing here is aspirational.

---

## ► START HERE — resuming cold

Everything is merged. `main` is at `a5b9ed7`, the tree is clean, no branches or PRs are open. **Nothing is
half-landed, so there is nothing to untangle first.** The remaining work is ~20 minutes and it is one thing:
prove the tab comes down.

```bash
# 1. Deploy. 5d9041c is published; give the publish a moment, then:
DEPLOY_PULL=1 bash deploy.sh 12 13

# 2. VERIFY IT ACTUALLY LANDED — a deploy this session pulled a stale :latest, recreated
#    nothing, and reported success. Expect a NEW image sha and a fresh StartedAt.
ssh root@ssh-vic.beanpool.org 'docker inspect --format "{{.Name}} {{.Image}} {{.State.StartedAt}}" \
  beanpool-gippsland-beanpool-node-1 beanpool-eastgippy-beanpool-node-1'

# 3. Tunnel, then run the redemption. The harness is IN THE REPO at scripts/federation/.
ssh -N -L 18448:localhost:8448 -L 18450:localhost:8450 root@ssh-vic.beanpool.org
cd scripts/federation
export ADMIN_PASSWORD="$(grep -E '^ADMIN_PASSWORD=' ../../.env | cut -d= -f2-)"
node redeem.mjs report
node redeem.mjs 1     # then 2, then 3, WAIT ≤5 min for a pull tick, then 4
```

`export`, not a per-command prefix: the harness throws immediately without `ADMIN_PASSWORD`, and a prefix on
only the first line means every later phase fails on a missing variable rather than on anything real.

**`scripts/federation/` is a durable home, deliberately.** The first version of this doc pointed at a session
scratchpad, and the next session could not see it — the files were fine, they were simply outside the
workspace. Anything a future session needs has to live in the repo.

`fed-state.json` sits beside them and is **gitignored**: it holds the test identities' private keys. If it is
missing, the harness re-seeds from scratch, which is fine — it just means new identities and a fresh 100-bean
local trade.

**Phase 1's self-deal is FIXED** (`makeFreshMember`, which mints unconditionally instead of calling
`seedElder`). The bug is still described below because the *shape* of it — a helper that quietly reuses stored
state — is worth recognising elsewhere.

**What "done" looks like:** gippsland's bridge moves **−20 → −19**, its Commons drops by 1.015, the eastgippy
seller is credited 1, and `SUM(balance)` is still `0.000000` on both nodes — with the ceiling at **0** the whole
time.

Until that has happened, **#143 stays open**. The tab has been proven to go up, and to net out by reciprocal
accident. It has never been driven down on purpose, and that is the claim the whole design rests on.

Spec: [`docs/federation-connector.md`](federation-connector.md) §3 (the two halves), §7 (resolutions), §8 (the
five-step slice). Economics: [`docs/federation-economics.md`](federation-economics.md).

---

## The slice: where each step stands

| # | Step | State |
|---|---|---|
| 1 | Cross-node purchase route | **Verified live** |
| 2 | Two live nodes, one purchase | **Verified live** — both directions, bridges net to 0 |
| 3 | The link enterprise | **Verified live** — 1 per node, `is_treasury=1`, ceiling 0 |
| 4 | Reach + the pull | **Verified live** — 5/5 matrix incl. revocation |
| 5 | **Half B — redemption** | **Merged, deployed-ready, NEVER EXECUTED** |

### Merged this session

| PR | What |
|---|---|
| #158 | `reachPeers` stripped from non-authors; chooser reworded from "Who can see this?" to "Where does this travel?"; dead `rowToPost` removed |
| #159 | **Live bug** — a pulled listing could be bought with the *local* escrow |
| #161 | **Half B** — commission route, allowance, keeper UI |

Filed: **#160** (settled cross-node escrow accounts leave `1.8e-16`, so `WHERE public_key LIKE 'escrow_%' AND
balance != 0` false-positives per trade — the obvious stuck-hold probe is unreliable).

---

## THE ONE JOB LEFT

**Run a real redemption on the gippsland↔eastgippy pair and watch the tab come down.** Everything for it is
merged and published; nothing has ever run.

This matters more than it sounds. "Built, tested, never executed" has been this feature's failure mode **six
times** — every one of the five step-1/2 blockers, plus the boot-order bug in #157 that two green suites and a
deploy all missed. The Half B suite is 42/42, and the suite deliberately **does not cover the happy path**:
past its checks the route hands off to `settleCrossNodePurchase`, which needs a live libp2p node.

So the arithmetic is proven and **the act is not**.

### Deploy first

```
DEPLOY_PULL=1 bash deploy.sh 12 13
```

`5d9041c` is published (confirmed success). **Give the publish a couple of minutes before deploying** — an
earlier deploy this session pulled while ghcr's `:latest` was still the previous build, got no new digest, and
compose therefore recreated nothing. The tell is `beanpool-node Pulled` with **no layer output**, and
`docker ps` still showing the old uptime. Verify with:

```
ssh root@ssh-vic.beanpool.org 'docker inspect --format "{{.Name}} {{.Image}} {{.State.StartedAt}}" \
  beanpool-gippsland-beanpool-node-1 beanpool-eastgippy-beanpool-node-1'
```

A **new** image sha and a fresh `StartedAt` mean it landed.

### Then the redemption

Driver written and ready: `<scratchpad>/redeem.mjs`, four phases, `node redeem.mjs 1|2|3|4|all`. Needs
`ADMIN_PASSWORD` in the environment (from the repo `.env`).

**Why the setup is four phases and not one.** Both Commons pots hold exactly **0.075** — one fee each — so a
commission of any size refuses `commons_short`. And a cross-node fee goes to the **buyer's** Commons, so the
trade that puts gippsland in credit fills *eastgippy's* pot, not gippsland's. The only honest way to fill
gippsland's is gippsland members paying fees locally.

1. **Local gippsland trade, 100 beans** → ~1.5 of fee into gippsland's Commons.
2. **eastgippy buys 20 beans of gippsland work** → gippsland's bridge goes to **−20** (negative = *they owe
   us*). This is the Byron→Brisbane direction: gippsland delivered, gippsland is owed.
3. **A 1-bean travelling offer on eastgippy** (`reach: 'everywhere'`), then **wait one pull cycle (≤5 min)**.
4. **gippsland's keeper commissions it.** Assign the keeper via
   `POST /api/local/admin/treasury/<treasury>/operators` with `{password, pubkey}`.

**What success looks like:** gippsland's bridge moves **−20 → −19**, its Commons drops by 1.015, the eastgippy
seller is credited 1, and `SUM(balance)` stays `0.000000` on **both** nodes. The tab came down deliberately —
which is the entire point of Half B.

**This also proves the claim I care most about:** the ceiling is **0** throughout, and redemption still works.
`allowance = ceiling − tab = 0 − (−20) = 20`.

### Two harness bugs already fixed, don't re-find them

- `signed()` in `fed.mjs` used to attach a body to a GET and sign over `'{}'`. A GET must sign over an **empty**
  body (`rawBody ?? ''`) and carry none — fetch throws otherwise. The 403 it produced looks exactly like a
  wrong key.
- **`seedElder()` short-circuits on the stored identity**, so `seedElder('gippsland', 'FedLocal')` handed back
  **FedBuyer** and phase 1 tried to buy FedBuyer's own offer — which `acceptPost` refuses outright ("Cannot
  accept your own post"), so phase 1 could never have worked as first written. **Fixed:** `makeFreshMember()`
  in `redeem.mjs` mints unconditionally and stores under its own key. Recorded because the shape is worth
  recognising — a helper that quietly reuses stored state, called somewhere that needs a distinct one.

---

## The Half B model, so nobody re-derives it

```
allowance = ceiling − energyBalanceExact(peerId)
```

Sign convention, which is counterintuitive and has already shipped inverted once in a comment: **positive = we
owe them**, negative = they owe us.

| tab | ceiling | allowance | |
|---|---|---|---|
| −480 | 0 | 480 | pure redemption — needs nobody's permission |
| 0 | 0 | 0 | square, no ceiling → nothing |
| 0 | 500 | 500 | the ceiling is discretion to open a *fresh* tab |
| +500 | 500 | **0** | ceiling reached — the cumulative bound |
| +750 | 500 | 0 | past the ceiling reads as nothing, never a negative |

**It had to be cumulative.** `settlementCapacity` bounds only the *negative* side of a bridge and says so
emphatically (a check on the absolute value would freeze a drained community permanently). Commissioning drives
the tab **positive**, so it passes that check untouched at any size — a per-commission ceiling of 500 would
permit 500 a thousand times over. Mutation-verified: making it per-commission kills exactly the four
assertions claiming otherwise.

**A ceiling of 0 still permits redemption**, deliberately. Making redemption wait on an operator typing a
number would leave every new link a ratchet, which is the failure Half B exists to fix.

Funding is **Commons → link enterprise → escrow**. The enterprise's own balance is spent **before** the pot, so
a reversal's refund (which lands on the enterprise, not the Commons) is consumed by the next commission instead
of needing a sweep. No `allowDeficit`: one keeper's discretion must not put the community's pot underwater.

Authorisation is `canOperateTreasury` (#106), unchanged — a link *is* an enterprise, so a second answer to "who
may act for this one" is how the two drift apart. **Open decision 4** (stewards appointed vs nominated) is
still open; whatever settles it changes `canOperateTreasury` and this inherits the answer.

---

## Operational notes that cost time to learn

- **Never `mullum`.** Real community. `test` is the only data node in use. gippsland + eastgippy are the
  federation pair (both on the **vic** VM, talking over `beanpool-shared` by container IP `172.18.0.3` /
  `172.18.0.4`, port 4001). Containers: `beanpool-<node>-beanpool-node-1`; DB at
  `/root/BeanPool-<Name>/data/state.db`.
- Tunnel: `ssh -N -L 18448:localhost:8448 -L 18450:localhost:8450 root@ssh-vic.beanpool.org`.
- **Never `git add -A` in this tree** — a second autonomous agent shares the worktree, and it swept 38 of its
  untracked files into a PR once.
- **`test-all.sh`'s federation block is inside `bash -c '...'`** — a single apostrophe in a comment closes the
  string and the file fails to parse ~100 lines later as "unexpected end of file". Cost a real debugging
  detour; there is now a warning comment in the function.
- Conservation must be measured **excluding** the `COMMONS_POOL` row and **adding** the live global — the pot is
  `COMMONS_BALANCE` and the row is only its persisted shadow (#124, #126). A naive `SUM(balance)` misses the
  exact mistake worth catching.
- Test fixtures that INSERT into `accounts` after `initStateEngine` must call `reconcileLedgerFromDb()`, or
  `transfer` debits from an in-memory zero and persists the result — a payer read **100 → −4** on a 4-bean
  trade. Also seed `last_demurrage_epoch` at the current epoch, not 0 (1970 → ~56 years of decay, #138).

---

## Backlog, ranked

1. **Run the redemption** (above). Everything else waits.
2. **#160** — escrow dust; zero the row on finalise, and make the "already funded" test a threshold not `> 0`.
3. **Remote card reads "(from 172.18.0.4)"** — `remoteOriginLabel` derives the name from `origin_node` (a URL)
   while the connector callsign is right there. Fine with real hostnames, garbage by IP.
4. **Hoist the remote-badge trimming** out of `MarketplaceCard` so the visible badge and the aria label share
   one definition (noted in the #155 review, deliberately deferred).
5. **Native app has no reach control** — `apps/native/app/(tabs)/map.tsx` is the protected/fragile map file, so
   native listings default to `local`. Its own small PR, if wanted.
6. Open, not blocking: **#154** (FK pragma left ON, contradicting `db.ts:73`); `mirror` trust level settable by
   API but absent from the Settings dropdown; `GET /api/local/connectors` unauthenticated and returns
   `creditCap`.
7. Parked by agreement: **#130** (2-line live security fix — admin password via URL query at
   `https-server.ts:829`), **#139** (product call), **#129** (`test` node's −9.82 drift), #114/#125/#131–#135.

**Division of labour:** the user takes #89–#101; Claude takes #102+.
