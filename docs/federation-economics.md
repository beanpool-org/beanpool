# Federation Economics — Inter-Node Clearing Model

> **Status:** Specification. Agreed in the 2026-07-30/31 design session; written up per #103.
> Implemented by #104 (settlement + bridge accounts), #105 (cross-node needs board),
> #107 (federation-aware circulation charge). Not yet built.
>
> **Companion docs:** [protocol-rules.md](protocol-rules.md) §14 (Federation) — the protocol-level
> constants that must be identical on every node. [commons-pool-transparency.md](commons-pool-transparency.md)
> — zero-sum equilibrium, pruning write-offs. #96 covers federation *transport*; this document covers
> federation *economics*. Where they meet, see [Two kinds of trust](#two-kinds-of-trust).

Federation has a transport design — how nodes discover each other, authenticate, and replicate. It has
had no economic design. "How do beans cross a node boundary" turns out to be a distinct and much harder
problem than "how do nodes talk", and answering it wrongly silently destroys local circulation. This
document is the answer.

---

## 1. The constraint: beans cannot travel

A bean is not a token. It is **the mirror of a live negative**.

- Accounts start at 0. There is no money supply; the network always sums to zero (§1, §4).
- `CREDIT_BASE_FLOOR` is 0 — there is no baked-in overdraft. Every bean of a member's floor is
  explicitly granted, earned, or vouched, capped at `CREDIT_FLOOR_CAP` (2000).
- Direct member→member sends are floor-0: you can only send beans you already hold. Only a
  marketplace/escrow draw against `usableFloor()` creates a *new* negative — and `usableFloor` is
  itself offer-band gated, so credit is only available to a member who is actively offering.
- Positive balances decay (§8, progressive circulation brackets → Commons Pool).

Every positive bean therefore has a specific matching negative on a specific member, who extinguishes
it by earning.

**So exporting a positive bean strands its negative.** If a Brisbane member's +50 leaves for Byron, the
Brisbane member sitting at −50 can no longer earn it back from Brisbane's circulation, because the
counterpart to their debt has left the local economy. The debt has to be worked off against beans that
are no longer there. Repeat that across many visitors and the drained community's circulation is
permanently reduced — not by fraud, but by correct-looking transfers.

This is why the previously-shipped path was wrong in principle as well as in implementation. It
verified the visitor's home balance and then performed a purely **local** transfer — reading a ledger
it never wrote to (#102, closed by PR #112 as a refusal pending this model).

> **Rule 1 — Beans never cross a node boundary. Standing does.**

---

## 2. The settlement model: charge home, mint local, carry a tab

A cross-node purchase is settled in three moves:

1. The buyer is charged **on their home ledger**, in real time.
2. The destination node **mints locally** to pay its own seller.
3. The two nodes carry a **bilateral tab** in dedicated per-peer bridge accounts.

### 2.1 The four entries

Buyer `B` is a member of **BRISBANE** (their home node). Seller `S` is a member of **BYRON**. `B` buys a
5-bean service from `S`.

```
BYRON                                    BRISBANE
  S                        +5              B                        −5
  bridge_brisbane          −5              bridge_byron             +5
  ─────────────────────────────            ─────────────────────────────
  node total                0              node total                0
```

Four entries, two per node, each node's books still summing to zero. The pair of bridge entries **is**
the tab. Nothing else crosses the border.

### 2.2 Sign convention

This is the part implementations get wrong, so it is stated as a rule:

> **Rule 2 — On each node, `bridge_<peer>` is that node's position *toward* that peer.
> Positive = value taken from a local member and owed outward. Negative = value minted locally
> against a claim on the peer, i.e. credit extended to that peer.**

Consequences that follow directly:

- `bridge_byron@BRISBANE = +5` — Brisbane debited its own member and owes Byron 5.
- `bridge_brisbane@BYRON = −5` — Byron paid its own seller against a claim on Brisbane.
- The two are always **equal and opposite**. Any drift is a reconciliation failure, and is the single
  most useful federation health check to expose.
- A node's **credit exposure to a peer** is how negative its bridge to that peer is. Byron capping
  Brisbane means capping `−bridge_brisbane@BYRON`.
- Flow in the other direction nets the tab toward zero. If Byron later buys 3 beans of work from
  Brisbane, the same four entries apply with the roles swapped, leaving the tab at 2.

### 2.3 Bridge accounts are not the Commons

A bridge position is held in a **dedicated per-peer synthetic account**, alongside the existing
`escrow_*` / `project_*` / `COMMONS_POOL` synthetics — never folded into `COMMONS_POOL`.

A liability owed to a neighbour must stay distinguishable from local project funds. Mixing them means a
community cannot answer "how much of the Commons is actually ours to spend?", which is precisely the
question the Commons transparency work exists to answer.

Bridge accounts are:

- **Reserved by prefix** the way `escrow_` and `project_` are, and added to the synthetic-recipient
  rejection list on public routes, so no member can address one directly.
- **Exempt from the ordinary circulation charge** (§8). A tab is not an idle hoard, and decaying it
  would silently forgive a debt — see [§5](#5-rebalancing-a-tab) for why forgiveness must be deliberate.
  #107 later adds a *distinct* charge keyed to imbalance; that is not the same mechanism and must not be
  conflated with it.

### 2.4 The settlement exchange

Read-only verification is not sufficient — the home node must perform an actual **debit** and say so in
a way the destination can rely on. This needs a new authenticated libp2p action alongside
`verify_member` / `relay_message`.

Ordering is chosen so that the only reachable failure state is the *safe* one:

| Step | Actor | Action |
|---|---|---|
| 1 | BYRON → BRISBANE | `RESERVE(key, buyer, amount)`. Brisbane checks the buyer's `usableFloor`, their total foreign exposure cap, and its own willingness to extend. Returns a signed reservation token, or a refusal reason. |
| 2 | BYRON → BRISBANE | `COMMIT(key)`. Brisbane atomically debits the buyer and credits `bridge_byron`, then returns a **signed settlement receipt**. |
| 3 | BYRON | Only *on holding that receipt*, atomically credits the seller and debits `bridge_brisbane`. |

> **Rule 3 — A node never credits a local member before it holds a signed settlement receipt from the
> buyer's home node.**

Rule 3 is the whole point. Crediting first is exactly the #102 defect: unbacked local beans.

**Failure handling.**

- `key` is an **idempotency key per purchase**. `COMMIT` is idempotent and returns the same receipt on
  replay, so a retry can never double-charge.
- Step 2 ambiguous (timeout, connection dropped — Brisbane may or may not have committed): Byron
  retries `COMMIT` with the same key. Safe by idempotency.
- Step 3 fails after a successful step 2 (Byron crashes holding a receipt): the home ledger is debited
  and the seller unpaid. This is the one unresolved state, it is **recoverable by replaying from the
  durable receipt**, and it never mints unbacked beans. Receipts must therefore be persisted before
  step 3 is attempted.
- A reservation that is never committed **expires** and is released after a defined timeout. Reservations
  hold no beans; they only reduce the buyer's available headroom while live.

**Home node offline.** Solar and off-grid nodes sleep. **Fail closed** — refuse the purchase, and say so
plainly and without alarm ("Byron can't reach your community's node right now, so this purchase can't
be completed yet"). Extending a local allowance that reconciles later is exactly the unbacked-mint
temptation this model exists to remove, and fail-closed matches the offline-safe stance already taken in
the DNS registrar attestation work.

---

## 3. Exposure limits

Two independent caps, answering two different questions.

### 3.1 A member's total foreign exposure — capped by their home node

> **Rule 4 — A member's foreign exposure is capped in aggregate across *all* peers, as one shared pool
> — never per-peer.**

A per-peer cap is trivially multiplied by visiting more nodes: five peers at 200 each is 1000 of
exposure against a member whose home floor may be 400. The cap must be a single pool drawn down by
reservations and commits to any peer.

The pool is bounded by the member's existing home credit standing — it grants no new headroom. Because
`usableFloor` is offer-band gated, a member can only run up foreign exposure while actively offering at
home, which is the same covenant that governs local credit.

### 3.2 A node's credit to each peer — capped by each node independently

> **Rule 5 — Each node independently caps how much credit it extends to each peer node, and enforces it
> on its own books.**

This is the `−bridge_<peer>` limit from Rule 2. Its natural home is the **connector record**, alongside
the existing `TrustLevel` (`mirror` | `peer` | `blocked`) — the same place the operator already decides
how much to trust a neighbour.

Neither cap may be negotiated over the wire. Each node enforces its own, on its own books, from its own
configuration. A compromised peer must not be able to raise the limit that constrains it.

Both refusals surface at the point of sale and must be **clear and non-alarming**. Hitting a cap is a
throttle working as designed, not an error the member did something wrong to cause.

### Two kinds of trust

#96 and this document both use the phrase "trust matrix", for two different things. Keeping them
separate avoids building one and believing you have both:

- **Transport trust** (#96) — may this peer talk to us at all, and in what mode: `mirror` | `peer` |
  `blocked`. Governs replication and query routing.
- **Credit trust** (this document, §3.2) — how much value will we mint locally against this peer's
  word. Governs the bridge cap.

They share a record and are not the same decision. A peer can be fully trusted for discovery and
extended almost no credit.

---

## 4. Redeemability: what makes the tab worth anything

A claim is only worth what it can be redeemed for. A tab against a community that has nothing you want
is worthless however faithfully both nodes account for it.

This has a concrete design consequence: **federation works to the extent two communities genuinely want
each other's output.** Peer selection should therefore favour **complementary** communities, not similar
ones — a bioregional cluster (coast/hinterland, town/farm, trades/services) clears naturally, while two
neighbouring communities with identical skill mixes have little to settle with.

This is guidance for how operators choose peers, not a rule the protocol can enforce.

### The failure mode, stated plainly

Under chronic one-way flow, the tab walks to the cap and then **throttles**: further cross-node
purchases from the drained community's members are refused until flow reverses or the tab is
deliberately settled.

That is a **controlled stop, not a collapse.** Both ledgers stay balanced, local trade in both
communities is entirely unaffected, and nothing is lost — the boundary simply stops passing value until
someone acts. Designing for a clean throttle instead of an unbounded tab is the point of the caps.

---

## 5. Rebalancing a tab

Two mechanisms, in strict order of preference.

### 5.1 The surplus community buys work from the drained one — trade, not charity

The community holding the claim commissions work from its partner, redeeming the tab through real
exchange. Individual cross-boundary demand is organic and happens only where it happens; the
**treasury/commons channel is the one a community can act on deliberately** — which is why #105 (the
cross-node needs board) is the mechanism that makes this model actually rebalance rather than merely
account.

This is strongly preferred because it settles the tab *and* produces something both sides wanted.

### 5.2 Only where surplus is genuinely saturated: let it decay or forgive

Where a community's surplus is real, unspendable, and it has exhausted what it wants to buy, the claim
may be allowed to decay or be forgiven. This must be **deliberate and visible** — never a silent
by-product of applying the ordinary circulation charge to a bridge account (§2.3).

### The fairness rule

> **Rule 6 — Pressure may only fall on a party that has the power to act.**

- Charging an **idle surplus** is fair: the holder can spend it, buy work, or forgive it. They have
  agency.
- Penalising a community **because nobody took up its offers** is not fair: it did the thing being asked
  of it and cannot control demand. It has no agency.

This rule is what separates a rebalancing mechanism from austerity, and it is the test any future
adjustment lever (#107 included) must pass before it ships.

---

## 6. Prior art: Keynes' International Clearing Union

The model arrived at here is, almost line for line, Keynes' 1943 proposal for an International Clearing
Union — revived for a contemporary audience by Monbiot in *The Age of Consent*. The correspondence is
close enough to be worth recording, because the prior art carries arguments this design would otherwise
have to rediscover.

| ICU | BeanPool federation |
|---|---|
| the **bancor** — unit of account, never held by traders | the **bilateral tab** in bridge accounts |
| overdraft limits per member state | **per-peer credit caps** (§3.2) |
| charge on persistent **surpluses** as well as deficits | **circulation charge** / demurrage (§8), extended by #107 |
| trade clears through the union, currencies don't travel | standing crosses the boundary, beans don't (Rule 1) |

Two things it supplies directly:

**Symmetry of adjustment.** Keynes' central argument was that pressure to correct an imbalance must fall
on *both* sides. Capping only the deficit side is the austerity answer: it is unfair, and it is
unstable, because the surplus side has no reason to ever act. Rule 6 is the same principle expressed as
a fairness test rather than a symmetry claim, and §5 is the mechanism.

**Why the ICU failed, and why that objection doesn't transfer.** It failed because sovereign creditors —
the United States, in 1944 — refused to accept a charge on their surpluses. That refusal was available
because the charge depended on the continuing consent of the party it fell on.

Here, the equivalent rule is applied automatically by a shared protocol both nodes already run, on
constants that are identical network-wide (§14). Consent is given once when a node federates, not
renegotiated each time the charge bites. This does not make the design immune to politics — a node can
always defederate — but it removes the specific mechanism that killed the original.

---

## 7. Rejected alternatives

Each of these is a reasonable first instinct. Recording *why* each was rejected is the point, so they
are not quietly reintroduced later.

### A settlement token or coin

**Rejected.** It reintroduces a travelling asset, which is Rule 1's failure mode wearing a different
name: to be useful the token must be acquirable with beans, which strands the matching negative exactly
as before. It also creates something with an exchange rate, and therefore something to speculate on and
arbitrage between nodes.

### Persistent per-node visitor accounts

**Rejected.** A member holding a real balance on every node they have ever visited fragments their
standing across N ledgers, multiplies the exposure cap N-fold (§3.1), makes decay meaningless
(spread thin enough, nothing crosses a bracket), and leaves stranded positives on nodes the member never
returns to. A visitor should have *standing* on a peer node and a balance only at home.

### Automatic forgiveness of a tab

**Rejected as an automatic mechanism**, retained as a deliberate one (§5.2). Automatic forgiveness is a
standing subsidy for one-way flow: it makes running a permanent deficit free, so the tab carries no
information and the caps stop meaning anything. Forgiveness must be a decision someone makes and can be
held to.

### Routed or multi-hop credit

**Rejected for now.** Clearing A→C through B means B underwrites a relationship it is not party to, and
turns a cap breach on one link into a cascade across the mesh. Bilateral tabs keep every failure local
to one pair. Revisit only if a real cluster demonstrates the need, and never before the bilateral case
is proven in production.

---

## 8. Scope boundary: what can actually cross

Cross-node trade is **beans-only**, and in practice **services and remote deliverables only**.

- **Cash cannot travel.** The "cash also needed" flag (#108) covers a real local outlay — fuel,
  consumables — settled directly between two people who are in the same place. It has no cross-boundary
  meaning.
- **Physical goods cannot be delivered across a boundary.** You cannot collect a couch you are not
  standing next to.

The useful consequence: **physicality is self-enforcing.** A remote member browsing a "help move a
shed" offer simply cannot fulfil it, and no rule needed to be written to stop them.

> **Rule 7 — Remote reach is a discovery filter, not an access control.**

Per-listing reach (#105) exists so members don't wade through offers they can't use, and so a poster can
say "this one travels" about remote tutoring or design work. It is not a permission system, and should
not be built as one — building it as access control implies a guarantee the protocol cannot make and
does not need to.

---

## 9. Open questions

Deliberately unresolved. Each needs a decision before or during #104; none blocks writing it down.

1. **Does the 1.5% transaction fee (§8) apply to a cross-node purchase, and whose Commons receives
   it?** Options: the seller's node (it did the minting), the buyer's node (it carries the write-off
   risk if the buyer is later pruned), split, or exempt. Leaning: the buyer's home node, since it holds
   the debt that pruning would write off — but this needs confirming against the solvency model in
   [commons-pool-transparency.md](commons-pool-transparency.md).
2. **What happens to a live tab when a member is pruned at home?** Their negative is written off against
   their home Commons today. The bridge position is a separate obligation between nodes and should
   presumably survive — confirm.
3. **What happens to a tab on defederation?** A `blocked` transition with a non-zero tab needs a defined
   end state: frozen pending settlement, or written off symmetrically.
4. **Reservation timeout value**, and whether it should scale with peer latency. The test pair is a
   1 CPU / 1 GB VM specifically because its added latency exposes races a local run hides — tune against
   that, not against localhost.
5. **How is the tab surfaced to members**, if at all? The bridge-equality check is the most useful
   federation health signal, and Commons transparency argues for showing it. But "our community is owed
   40 by Byron" is a governance-grade fact and may belong in the Commons tab rather than a status page.
