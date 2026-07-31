# Federation Economics — Inter-Node Clearing Model

> **Status:** Specification, model agreed. Designed in the 2026-07-30/31 session, written up per #103,
> and the four remaining design questions settled 2026-07-31 — see [Decisions taken](#decisions-taken).
> Settlement revised 2026-08-01 to be **node-mediated** rather than member-signed (§2.5).
> Implemented by #104 (settlement + bridge accounts), #105 (cross-node needs board),
> #107 (federation-aware circulation charge). **Not yet built** — #104 is clear to start.
>
> **Companion docs:** [protocol-rules.md](protocol-rules.md) §14 (Federation) — the protocol-level
> constants that must be identical on every node. [commons-pool-transparency.md](commons-pool-transparency.md)
> — zero-sum equilibrium, pruning write-offs. #96 covers federation *transport*; this document covers
> federation *economics*. Where they meet, see [Two kinds of trust](#two-kinds-of-trust).

## Decisions taken

Four questions that were open when this document was first written, and are now settled. Each links to
the section that implements it — read the section for the mechanism, this table for the *why*.

| Question | Decision | Why this one |
|---|---|---|
| Where does the tab live? | A dedicated **`bridge_<peer>`** account per peer, not `COMMONS_POOL` — [§2.4](#24-bridge-accounts-are-not-the-commons) | Keeps "how much of the Commons is actually ours to spend?" answerable, and keeps two peers' tabs from blending into one number. One source of truth, in the ledger. |
| Where does a visitor's spending power abroad come from? | **Carved out of their existing home `usableFloor`** — [§3.1](#31-a-members-total-foreign-exposure--capped-by-their-home-node) | Creates no new credit at the boundary, which is the thing Rule 1 exists to prevent. Also inherits the offer covenant free: you can only run up foreign exposure while actively offering at home. |
| How is a node's credit cap on a peer set? | **No default. The operator sets an explicit number before credit-enabled federation works** — [§3.2](#32-a-nodes-credit-to-each-peer--capped-by-each-node-independently) | A default that suits a 200-member town quietly overexposes a 15-member one, and small communities are both the most vulnerable to being drained and the least able to absorb a bad tab. Fails safe, and forces the decision while the operator is actually thinking about that peer. |
| Who receives the 1.5% transaction fee on a cross-node purchase? | The **buyer's home node's Commons** — worked into the entries in [§2.1](#21-the-entries) | It holds the resulting debt, so it carries the write-off if that member is later pruned. Put the fee where the solvency risk sits. **Consequence:** the buyer pays the fee *on top*, rather than the seller absorbing it as they would locally — that's the only arrangement where both nodes balance and the reserve lands on the node with the exposure. See §2.1. |

The first supersedes the ledger diagram in the "Beans on holiday" design notes, which showed the tab in
`Commons`. Sign convention is identical either way; only the account differs.

---

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

### 2.1 The entries

Buyer `B` is a member of **BRISBANE** (their home node). Seller `S` is a member of **BYRON**. `B` buys a
5-bean service from `S`. The 1.5% transaction fee (§8) is 0.075.

```
BYRON                                    BRISBANE
  S                     +5.000              B                     −5.075
  bridge_brisbane       −5.000              COMMONS_POOL          +0.075
                                            bridge_byron          +5.000
  ─────────────────────────────            ─────────────────────────────
  node total             0.000              node total             0.000
```

Each node's books still sum to zero. Two properties to preserve when implementing:

- **The bridge entries are equal and opposite, and carry the agreed price — never price plus fee.** The
  tab is what the two communities owe each other for the *trade*; a local fee is nobody else's business.
- **The seller receives exactly the agreed amount.** They quoted 5 and they get 5.

#### Why the buyer pays the fee here, when locally the recipient absorbs it

Locally, §8 has the recipient absorb the fee: Bob receives `amount − 1.5%`. Cross-node that convention
cannot hold together with [Decision 4](#decisions-taken), and the arithmetic is the reason rather than a
preference:

- If the **seller absorbs** it, the fee is deducted on Byron, so it can only land in *Byron's* Commons —
  otherwise Byron's books don't balance. But Byron holds no debt from this trade, so it would accumulate
  a reserve against an exposure it does not have, while Brisbane — which *does* carry the write-off if
  `B` is later pruned — gets nothing.
- If the **buyer pays it on top**, the fee never crosses the border, both nodes balance, and the reserve
  builds on the node facing the risk.

So the cross-node fee is visible to the buyer rather than absorbed by the seller. That is a deliberate
divergence from the local convention, and arguably the more honest presentation for a cross-border trade
— but it *is* a divergence, and it follows from Decision 4 rather than standing on its own. If the fee
should instead follow the local convention, Decision 4 is the thing to revisit, not this table.

### 2.2 What the bridge entry actually is: an energy balance

Nothing is transferred between the two nodes. Each makes purely local entries, and the two bridge rows
mirror each other as a **shared record of who owes whom work**. So the number is not beans sitting in an
account — it records that **Byron has delivered N beans' worth of real work to Brisbane's members and has
not yet received equivalent work back.** Energy delivered, not yet reciprocated.

That is a genuinely different *kind* of ledger row from a member balance, even though it lives in the same
`accounts` table:

|  | A member balance | A bridge row |
|---|---|---|
| What it mirrors | a specific member's live negative | nothing at member level — no member is at −N because of it |
| Can it be spent? | yes | **no** — no member is ever paid out of it |
| Can it be transferred? | yes | **no** — it is a claim on *one* community's future work, not a bearer instrument |
| Does it decay? | yes, above the green zone | **no** — decaying a debt is silent forgiveness. Enforced by `ledger.setDecayExempt()`, applied at boot alongside `COMMONS_POOL`, `escrow_*`, `project_*` and every `is_treasury=1` account |

Three rules elsewhere in this document follow from that single fact rather than standing on their own:
bridge accounts are prefix-reserved and rejected on public routes (§2.4), credit is never routed through
an intermediary (Rule 6), and bridge accounts are demurrage-exempt (§2.4). If the row were beans, each of
those would be an arbitrary restriction. Because it is an obligation marker, each is necessary.

**Terminology.** The unit is **beans**, always — there is exactly one currency and no second kind of bean
(§7). What needs a name is the *position*, and that is an **energy balance** with a named community:

> Our energy balance with Byron: **−480**

`bridge_<peer>` stays the internal account name; "energy balance" is what it's called in prose and to
members.

#### Worked both ways: the balance moving out and back

§2.1 shows one crossing. What it doesn't show is the thing that matters most — the balance **returning to
zero**, which is the whole point of the design. Fees omitted here to keep the movement legible.

**Step 1.** A Brisbane member buys a 5-bean guitar lesson from a Byron member.

```
BYRON                                    BRISBANE
  seller                 +5               buyer                  −5
  bridge_brisbane        −5               bridge_byron           +5

  energy balance with Brisbane: −5        energy balance with Byron: +5
  "we've delivered 5 of work,             "we owe 5 of work
   not yet paid back in kind"              to Byron"
```

**Step 2.** Later, a Byron member has their fence fixed by a Brisbane member, also 5 beans. Same four
entries, roles swapped — there is no special "settlement" transaction, it is just an ordinary trade that
happens to run the other way.

```
BYRON                                    BRISBANE
  buyer                  −5               seller                 +5
  bridge_brisbane        +5               bridge_byron           −5

  energy balance with Brisbane: 0         energy balance with Byron: 0
  "square"                                "square"
```

Note what did and didn't happen across those two steps:

- **Two individuals were charged, on their own home ledgers.** Neither ever held or spent a foreign
  balance.
- **Two sellers were paid in their own community's beans, immediately.**
- **Both nodes summed to zero at every point** — after step 1 as much as after step 2.
- **Nothing crossed the border in either direction.** The only thing that moved was the *number the two
  nodes agree on*, out to −5 and back to 0.
- **Nobody settled anything.** No transfer between nodes, no reconciliation run, no payment. Two ordinary
  trades in opposite directions cleared the balance as a side effect. This is why "correcting the
  imbalance" is not a transaction type (§5.1) — there is nothing to build.

The tab only needs deliberate attention when flow *stops* running both ways. That is what §5 is for.

#### Present it as a scale centred on zero, not as a debt

The canonical presentation is a slider or gauge with **zero in the middle and each node's cap at one
end** — not a debt figure. That is not decoration; it encodes three things this document argues for
separately:

- **Both ends are unhealthy.** Being owed too much is as much a problem as owing too much. That is
  Keynes' symmetry of adjustment (§6), and it is the correction to the first instinct — which was to cap
  only the deficit side.
- **The two caps are literally the two ends.** Byron's cap at one extreme, Brisbane's at the other. The
  one-way valve (§3.2) then stops being an odd rule and becomes obvious: you may always move *toward* the
  middle.
- **Zero is the target, not a maximum.** A community's health is not how much it has stored, it is how
  well the energy keeps moving — so the healthy state is a balance that breathes around zero, not one
  that accumulates in either direction.

### 2.3 Sign convention

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

### 2.4 Bridge accounts are not the Commons

**Decided.** A bridge position is held in a **dedicated per-peer synthetic account**, alongside the
existing `escrow_*` / `project_*` / `COMMONS_POOL` synthetics — never folded into `COMMONS_POOL`.

Two reasons, and the second is the one that settled it:

1. A liability owed to a neighbour must stay distinguishable from local project funds. Mixing them means
   a community cannot answer "how much of the Commons is actually ours to spend?", which is precisely
   the question the Commons transparency work exists to answer.
2. `COMMONS_POOL` is **one** balance, so two peers' tabs would net into a single number — and the tab is
   only meaningful *per peer*. A node owed 40 by Byron and owing 40 to Brisbane is not in balance; it has
   two separate positions with two separate caps, and one of them may be about to throttle.

The alternative considered was keeping the notes' `Commons` entry and tracking per-peer positions in a
side table. Rejected: that is two sources of truth to reconcile, which is the exact bug class #102 came
from — a balance that was read while no write kept it in step.

Bridge accounts are:

- **Reserved by prefix** the way `escrow_` and `project_` are, and added to the synthetic-recipient
  rejection list on public routes, so no member can address one directly.
- **Exempt from the circulation charge.** A tab is not an idle hoard, and decaying it would silently
  forgive a debt — see [§5](#5-rebalancing-a-tab) for why forgiveness must be deliberate. Reuse the
  existing mechanism: `ledger.setDecayExempt()`, which already covers `COMMONS_POOL`, `escrow_*`,
  `project_*` and every `is_treasury=1` account at boot. No new exemption concept is needed.

> **Note on the circulation charge, because the design notes say otherwise.** The surplus charge is
> **live, not dormant.** `PROTOCOL_CONSTANTS.CIRCULATION_RATE` is `0.000`, but it is a vestigial
> constant with no consumers; the real rates are hardcoded in `_calculateProgressiveDecay`
> (`beanpool-core/src/ledger.ts`) and applied on every account read — 1.0% per month above 200 rising to
> 2.5% above 2000, with only the 0–200 green zone at zero. So #107 is not "dialling up" an existing
> charge: it is adding a genuinely new, *imbalance-keyed* charge alongside one that already runs.

### 2.5 The settlement exchange

Read-only verification is not sufficient — the home node must perform an actual **debit** and say so in
a way the destination can rely on. This needs a new authenticated libp2p action alongside
`verify_member` / `relay_message`.

#### Who may write which ledger: each node writes only its own

The buyer's node **initiates and mediates**. A member never signs a cross-node payload; they make an
**ordinary local purchase on their own node**, through the same signed `/api/*` path they use for every
other purchase. Their node then settles with the peer.

That direction of travel is the whole security argument, and it is stronger than the one it replaces:

> **Rule 3a — A node writes only its own ledger. A peer's request can never cause us to debit one of our
> members; the most it can ever do is cause us to extend credit, bounded by the cap we set for that peer.**

Work the blast radius through. In this model:

- **Brisbane debits its own member**, on that member's own signed instruction, on its own books.
- **Byron pays its own seller** from its own `bridge_brisbane` account, under its own cap.
- Neither node ever asks the other to touch a member account.

So a **compromised peer's maximum reach is exactly its cap**. A malicious Brisbane can, at worst,
persuade Byron to extend credit up to the number Byron chose — which is precisely what the cap is for
(§3.2). It cannot make Byron debit a Byron member, because Byron never accepts an instruction to do that
from anyone. A malicious Byron can refuse to trade, or fail to pay its own seller after being paid — a
fraud and dispute matter between two people, not a ledger-integrity failure.

Being able to state the blast radius as *"one number, chosen by the operator"* is a much better position
than *"whatever we can verify cryptographically"*.

**What this replaces, and why.** An earlier draft had the destination node relay a *member-signed*
authorisation for the home node to verify, on the reasoning that peer-connection trust authorises the
connection and not the assertion — the same concern `relay_message` already documents:

> *"the connection is trusted (a `peer` connector), but that authorizes the CONNECTION, not the asserted
> sender authorship — a compromised/malicious federation peer can set senderPublicKey to anyone."*

That reasoning was right for a model where Byron asks Brisbane to debit somebody. It also required a new
signed-payload format, binding of the home node to stop the same authorisation being replayed at a second
node where the member also holds an account, and signing work in both clients. **Reversing who initiates
removes the question rather than answering it**: nobody is asked to debit anyone, so there is no assertion
to authenticate and no portable authorisation to replay.

The member's own signature still does real work — it is what authorises the local purchase — but it goes
only to their own node, over the existing `requireSignature` path, and never travels.

**One pre-existing wrinkle worth recording, since it is adjacent but not ours.** The existing signature
scheme covers `method + path + timestamp + nonce + body` and does not bind the host. So in principle any
signed request could be replayed against a different node where the same identity is also a member. That
is a property of the whole API, not something settlement introduces, and it is not #104's to fix — but it
is the honest reason "the member signs locally" is *simpler* rather than *provably safer in every respect*.

#### The exchange

Brisbane initiates. Ordering is chosen so the only reachable failure state is the safe one, and so the
node that **mints locally** never does so on a promise:

| Step | Actor | Action |
|---|---|---|
| 1 | BRISBANE (local) | The buyer purchases through Brisbane's ordinary signed route. Brisbane checks their `usableFloor` and total foreign exposure, then **holds the amount in local escrow**. Nothing has crossed the border. |
| 2 | BRISBANE → BYRON | `PURCHASE(key, buyerPublicKey, buyerHomeNode, amount, postId)`. Byron checks its **own** cap on Brisbane (`settlementCapacity`), reserves against it, and replies accepted or refused. It does **not** pay its seller yet. |
| 3 | BRISBANE | On acceptance, atomically converts escrow into the real entries: buyer debited, `bridge_byron` credited, fee to its own Commons. Returns a **signed settlement receipt**. |
| 4 | BYRON | Only *on holding that receipt*, atomically credits the seller and debits `bridge_brisbane`. |
| — | either side | Refusal or timeout before step 3 → Brisbane **refunds the escrow** to the buyer and Byron releases its reservation. Nothing happened. |

**Why Brisbane escrows before asking.** Step 1 holds the buyer's beans without yet knowing whether Byron
will accept — deliberately. Step 2 is the **sole gate on Byron's cap**, and Byron is the only authority on
it (Rule 5), so asking earlier would be advisory at best and stale by the time it mattered. Escrow is
cheap and fully reversible, whereas discovering the buyer cannot afford it *after* a round trip is not. So
the order is: establish the buyer can pay, then ask whether the peer will accept.

`buyerPublicKey` and `buyerHomeNode` are both carried explicitly. The public key identifies the person for
the seller (they still need to know who they are serving, and Byron holds a visitor record for them); the
home node names who to send the receipt to and who the resulting balance is with. Neither is inferable
from the connection alone once a node has more than one peer.

> **Rule 3c — A node never credits a local member before it holds a signed settlement receipt from the
> buyer's node.**

Rule 3c is unchanged by the reversal and remains the point: crediting first is exactly the #102 defect,
unbacked local beans. Note it binds whichever node is **minting locally** — here Byron, at step 4.

The two rules now answer two questions, and neither substitutes for the other: **3a** — who may write this
ledger? (only its owner, and a peer's reach is capped). **3c** — in what order? (never mint before the
receipt).

*(An earlier draft carried a Rule 3b requiring a `homeNode` field inside a member-signed authorisation, to
stop that authorisation being replayed at a second node where the member also held an account. Node
mediation retires it: there is no portable member-signed payload to replay. Recorded so the number is not
silently reused.)*

**Failure handling.** The reversal moves each safeguard to a different side, so they are restated in
terms of who now does what.

- `key` is an **idempotency key per purchase**, minted by Brisbane. Every step is idempotent on it: a
  retried `PURCHASE` returns the same accept/refuse, and a retried receipt delivery is a no-op. A retry
  can never double-charge or double-pay.
- **Step 2 ambiguous** (timeout, connection dropped — Byron may or may not have reserved): Brisbane
  retries `PURCHASE` with the same key. Safe by idempotency. Brisbane's escrow is still held, so the
  buyer's beans are neither spent nor released while this resolves.
- **Step 4 never happens after a successful step 3** (Byron crashes holding the receipt): Brisbane's
  buyer is debited and `bridge_byron` credited, but Byron's seller is unpaid and `bridge_brisbane`
  untouched. **The two bridges now disagree, which is the reconciliation failure Rule 2 warns about.**
  It is the one unresolved state, it is recoverable, and — crucially — it never mints unbacked beans.
  The direction is deliberate: Brisbane owes outward for something not yet delivered, rather than Byron
  having paid out against nothing.
- **Byron must persist the receipt before acting on it**, and Brisbane must persist "committed, awaiting
  confirmation" before returning it. Both halves are needed:
  - Byron persisting first is what makes step 4 replayable — a crash mid-payment resumes from the receipt
    rather than losing the fact that it owes its seller.
  - Brisbane persisting first is what lets it *detect* the disagreement at all. Without it, a receipt
    that never got acted on is invisible, and the bridge mismatch surfaces only as unexplained drift.

  On boot, each side resolves its unfinalised rows: Byron by completing step 4, Brisbane by asking
  `GET_RECEIPT_STATUS(key)`. This is what makes "recoverable by replay" true rather than aspirational.

  `GET_RECEIPT_STATUS(key)` answers with a state, and each state has a single correct response — a
  two-state answer is not enough, because "never arrived" and "arrived, not yet acted on" require
  opposite actions:

  | Response | Means | Brisbane must |
  |---|---|---|
  | `NOT_FOUND` | Byron never received the receipt, or its reservation lapsed | **reverse** — compensate its entries and refund the buyer |
  | `HELD` | receipt persisted, seller not yet paid | **wait** and re-ask. Byron will complete step 4; reversing now would strand a payment about to happen |
  | `SETTLED` | seller paid, `bridge_brisbane` debited | **finalise** — mark confirmed; the two bridges agree |
  | `UNKNOWN` | Byron cannot say — an unrecognised key, or one belonging to a different peer | **wait** and re-ask, and escalate to a human if it never resolves |

  Byron must answer `NOT_FOUND` only when it can be *sure*. **`UNKNOWN` is a fourth state rather than a
  default of `NOT_FOUND`, and the distinction is load-bearing:** `NOT_FOUND` instructs the asker to
  *reverse*, so answering it for anything unrecognised would let a fabricated or truncated key talk a node
  into undoing a trade that actually settled. Making the safe answer structural beats requiring the
  implementer to remember it. Anything malformed on the wire is likewise read as `UNKNOWN`, never as
  permission to reverse.

  For the same reason `GET_RECEIPT_STATUS` is **scoped to the asking peer**: a peer asking about a key
  that belongs to someone else gets `UNKNOWN`, not the real state. Otherwise the answer doubles as a probe
  of another community's trading activity.
- **Byron's cap reservation expires** if no receipt arrives within a defined timeout, releasing the
  headroom it was holding. A reservation moves no beans on either side.
- **A receipt arriving after Byron's reservation expired must be re-validated, not honoured on trust.** A
  slow network or a sleeping VM can land it late, and paying blindly could push Byron past the cap its
  operator chose. So Byron re-evaluates `settlementCapacity` **atomically** at step 4: if the headroom is
  still there it pays; if it is not, it returns `CAPACITY_LAPSED` and does **not** pay its seller.
  Brisbane then reverses its own entries against the same key and refunds the buyer.

  This makes a reservation *a hint that reduces headroom*, not a promise — the right shape, because a
  node's own cap is the only authority on what it may extend, and it should never be bound by a decision
  it made in the past.

- **A reversal is a compensating transaction, never a deletion.** Brisbane has already written real
  entries by step 3, so undoing them means *posting the opposite entries against the same `key`* — leaving
  both the original and the reversal in the ledger and in the audit trail. Silently removing rows would
  make a settled trade indistinguishable from one that never happened, defeat `runLedgerAudit`, and hand a
  spoofed or replayed `CAPACITY_LAPSED` the power to quietly rewrite history. A compensating entry is
  self-documenting and idempotent on the key.
- **Byron's reservation must outlive Brisbane's step-3 timeout**, by a clear margin. Then a late receipt
  is an exceptional event caused by a genuine fault, not routine operation. `CAPACITY_LAPSED` and its
  reversal path must still be implemented and tested — but they should be the rare path, and if they are
  firing regularly the timers are misconfigured rather than the protocol being exercised as designed.

**Note what the buyer side no longer needs.** An earlier draft had the buyer's node hold a *reservation*
against the member's `usableFloor`, which then had to be subtracted from local headroom so the same credit
could not be spent twice while a foreign purchase was pending (§3.1). Node mediation replaces that with an
ordinary **local escrow** — the existing marketplace machinery, which already moves the beans out of the
member's balance. The double-spend window closes by itself, with nothing new to build or reason about.

**Home node offline.** Solar and off-grid nodes sleep. **Fail closed** — refuse the purchase, and say so
plainly and without alarm ("Byron can't reach your community's node right now, so this purchase can't
be completed yet"). Extending a local allowance that reconciles later is exactly the unbacked-mint
temptation this model exists to remove, and fail-closed matches the offline-safe stance already taken in
the DNS registrar attestation work.

### 2.6 What "signed receipt" means, and two guards it does not cover

Three details settled while building the exchange. Each is a place where the obvious implementation is
wrong in a way that only shows up as beans in the wrong place.

**The receipt is signed with the node's persistent libp2p identity, and the signature binds the issuing
peer id.** Signing at all is worth justifying, since the stream is already an authenticated Noise channel
from a trusted peer: the receipt has to *outlive the connection*. The seller's node persists it and may act
on it after a reboot with nothing live to re-authenticate against, so at that moment the signature is the
only evidence the buyer's node really committed. Transport authentication proves who is talking now; the
signature proves who committed then, and stays checkable in an audit.

Binding the issuer is the part with teeth. **The bridge account that gets debited is chosen by who issued
the receipt**, so a receipt not pinned to its issuer would let peer B settle against peer A's credit line —
spending a limit set for someone else. Verification therefore checks the receipt's `issuerPeerId` against
the peer of the connection it arrived on (or, in recovery, the peer recorded on the row), and an Ed25519
peer id embeds its own public key, so this needs no key distribution beyond the trust list that already
exists. Amount, buyer, seller and post are all inside the signature too, and are re-checked against the
reservation: a validly-signed receipt naming a larger amount than was reserved must be refused, because the
cap check authorised the reserved figure and nothing else.

**The buyer named in a `PURCHASE` must not be one of the seller node's own members.** Same shape as the
existing `relay_message` impersonation guard — the connection is trusted, but that authorises the
*connection*, not the asserted identity. The consequence here is worse than a bogus trade: accepting it
reaches `registerVisitor`, which stamps a `home_node_url` onto a member row that has none, quietly
converting a local member into a visitor — and #102's guard then refuses that member's own local spending.
Any peer knowing a public key could freeze its owner's account. So a peer claiming one of our members is
refused outright.

**Crediting the Commons is not a transfer to `COMMONS_POOL`.** The Commons pot is the `COMMONS_BALANCE`
global; the `COMMONS_POOL` *account* is only its persisted shadow, rewritten from the global after every
transfer. A transfer into that account is therefore written and then overwritten, and the value disappears
at the next restart — the node stops summing to zero, silently. The cross-node fee goes through a dedicated
`moveToCommons` / `payFromCommons` pair instead. (The pre-existing `adminPruneUser` path has this bug and is
tracked separately; it is not settlement's to fix.)

---

## 3. Exposure limits

Two independent caps, answering two different questions.

### 3.1 A member's total foreign exposure — capped by their home node

> **Rule 4 — A member's foreign exposure is capped in aggregate across *all* peers, as one shared pool
> — never per-peer.**

A per-peer cap is trivially multiplied by visiting more nodes: five peers at 200 each is 1000 of
exposure against a member whose home floor may be 400. The cap must be a single pool drawn down by
reservations and commits to any peer.

**Decided: the pool is carved out of the member's existing home `usableFloor`. It is not an additional
allowance.** Spending abroad reduces what they can spend at home, and vice versa — there is one pot.

```
usableFloor at home        −400

spends 120 in Byron
  → foreign exposure        120
  → headroom left at home   280      (not 400)

visits three more nodes
  → the SAME 280 is all that's left, across all of them
```

**A pending cross-node purchase is held in ordinary local escrow, so this needs no new arithmetic.** An
earlier draft had the home node hold a *reservation* against the member's `usableFloor`, which then had to
be subtracted from local headroom — otherwise the same credit could be spent locally while a foreign
purchase was still pending, over-committing across the two.

Node mediation (§2.5) removes that problem instead of solving it. The buyer's beans move into escrow the
moment they purchase, using the existing marketplace machinery, so they have already left the spendable
balance. `usableFloor` needs no adjustment, there is no reservation ledger to keep, and the double-spend
window closes by itself.

What still has to be tracked is **committed** foreign exposure — the member's share of the bridge debits —
because that is what Rule 4's aggregate cap is measured against.

Why this and not a separate foreign allowance: an allowance *on top* of the home floor is new credit
created at the boundary, mirrored by no local negative anywhere. That is Rule 1's failure mode arriving
through the front door instead of the side. The simpler UX of "travelling doesn't change your home
headroom" is not worth minting beans for.

Two properties fall out of it for free, which is a good sign the choice is the right shape:

- Because `usableFloor` is offer-band gated, **a member can only run up foreign exposure while actively
  offering at home** — the same covenant that governs local credit, with nothing extra to build.
- Standing is genuinely what travels. A five-year member has more spending power abroad than a newcomer
  without any separate foreign-reputation concept existing.

A flat per-member cap was also considered and rejected: it hands a brand-new member the same foreign
spending power as a veteran, which contradicts the premise that it is *standing* crossing the boundary.

### 3.2 A node's credit to each peer — capped by each node independently

> **Rule 5 — Each node independently caps how much credit it extends to each peer node, and enforces it
> on its own books.**

This is the `−bridge_<peer>` limit from Rule 2. Its natural home is the **connector record**, alongside
the existing `TrustLevel` (`mirror` | `peer` | `blocked`) — the same place the operator already decides
how much to trust a neighbour.

**Decided: there is no default cap.** An operator must set an explicit number per peer, and until they
do, cross-node settlement with that peer stays refused.

The reasoning is about who gets hurt by a wrong default. A number that suits a 200-member town quietly
overexposes a 15-member one, and small communities are simultaneously **the most vulnerable to being
drained and the least able to absorb a bad tab** — so the failure mode of a too-generous default lands
hardest exactly where it does the most damage. Requiring the number also puts the decision in front of
the operator at the one moment they are actually thinking about that specific neighbour.

Two useful consequences:

- **The safe state is already the current state.** With no cap configured, settlement is refused — which
  is precisely what the #102 kill switch does today. #104 doesn't have to introduce a fail-closed path;
  it inherits one, and the flag simply stops being global.
- **Nothing needs a formula yet.** Scaling the cap by active member count or total earned credit is the
  obvious eventual move, but any formula now is a guess. Let real operators set real numbers on a real
  cluster first, then derive the default from what they actually chose.

Neither cap may be negotiated over the wire. Each node enforces its own, on its own books, from its own
configuration. A compromised peer must not be able to raise the limit that constrains it.

#### The cap is one-way. This is the part to get right.

There is no single switch governing "trade with Byron". There are **two independent one-way valves**, one
held by each node, each governing only the credit *it* extends.

> **A node at its cap for a peer must keep accepting flow in the *other* direction. Refusing both is
> refusing the cure along with the disease.**

**Which direction a listing belongs to depends on who PAYS, not on who posted it.** Offer-vs-need is only
a question of who spoke first (§5.1), so both framings appear on each side of the ledger. With Brisbane
drained and Byron holding the claim:

| Listing | Payer | Direction | Status at the cap |
|---|---|---|---|
| **Byron's Needs**, filled by Brisbane members | Byron | Byron → Brisbane | ✅ **rebalances** |
| **Brisbane's Offers**, bought by Byron members | Byron | Byron → Brisbane | ✅ **rebalances** |
| Byron's Offers, bought by Brisbane members | Brisbane | Brisbane → Byron | ⛔ throttled |
| Brisbane's Needs, filled by Byron members | Brisbane | Brisbane → Byron | ⛔ throttled |

So the rebalancing surface is precisely **the drained community's Offers plus the surplus community's
Needs** — the two places where the surplus side is the one paying. Byron's cap throttles the bottom pair;
the top pair is governed by *Brisbane's* cap, which has enormous room precisely because Brisbane is owed
nothing.

**Beans and energy move in opposite directions, and conflating them is how this gets read backwards.**
In the permitted direction:

```
beans   Byron  ──────────▶  Brisbane      (Byron pays; the claim shrinks)
energy  Byron  ◀──────────  Brisbane      (Brisbane does the work; Byron is finally paid in real value)
```

Which is the whole point of the throttle. Byron has been accumulating a *claim* — an entitlement to
future work it has not yet received. At the cap, the only crossing still open is the one that **redeems
that claim instead of growing it**: Byron spends its position down and receives real work for it. Nothing
is confiscated and nobody is being generous; Byron simply gets what it was already owed, and Brisbane's
members earn their way back off the floor doing it (§5.2).

The mechanism is therefore asymmetric by construction: each cap binds only the sign representing credit
*given*, and the rebalancing flow reduces the very quantity that was capped. The failure mode to avoid is
an implementation that checks `abs(tab) > cap` and blocks the peer wholesale. That would freeze a drained
community permanently, because the only thing that can clear the tab is exactly what it blocked.

#### Discovery stays open both ways, and skew may reorder it

A community at its credit cap must still *see* its partner's listings — seeing them is the precondition
for the trade that fixes things. **Never hide a listing because a tab is full; that is the moment it
matters most** (Rule 6, Rule 9).

A skewed tab is, however, exactly the licence Rule 7 allows: it **may decide what gets surfaced first,
never whether a need is genuine.** So when a tab is near its cap, promoting the rebalancing pair — the
creditor's Needs to the debtor community, the debtor's Offers to the creditor community — is legitimate
prioritisation. Inventing needs to soak up a surplus is not. That distinction is the whole content of
Rule 7, and this is its first concrete application: it is the ranking rule #105 should implement.

Both refusals surface at the point of sale and must be **clear and non-alarming**. Hitting a cap is a
throttle working as designed, not an error the member did something wrong to cause.

### 3.3 Credit is never routed; knowledge is

Credit and information have opposite risk profiles, and the topology must reflect that.

> **Rule 6 — A node extends credit only to peers it has directly chosen and set a limit for. Credit is
> never routed through an intermediary. Discovery propagates freely.**

If Byron owes Brisbane and Brisbane owes Gold Coast, Byron must not end up carrying Gold Coast's risk
through a community it never vetted. That is precisely how contagion works in correspondent banking: one
cap breach on one link cascades across the mesh. Bilateral tabs keep every failure local to one pair
(and see [§7](#7-rejected-alternatives) on multi-hop netting).

Information carries no such risk, so listings and needs can propagate across the whole network. The
resulting rule of thumb is worth stating in the UI, not just the spec:

**You can see everywhere, but you can only trade with your direct partners.** Spotting something from an
unconnected community is not an error state — the answer is to go and connect.

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

**Size asymmetry helps rather than hurts.** The instinct is that a big community will drain a small one.
In practice the two dominant flows run in opposite directions and partly cancel: physical visiting flows
*toward* the scenic or rural community, while demand for skills, depth and specialist services flows
*toward* the larger one. Byron sells place and experience; Brisbane sells depth and talent. A
coast/hinterland or town/farm pairing is therefore a better credit partner than two towns of equal size
and identical skill mix.

### The failure mode, stated plainly

Under chronic one-way flow, the tab walks to the cap and then **throttles**: further cross-node
purchases from the drained community's members are refused until flow reverses or the tab is
deliberately settled.

That is a **controlled stop, not a collapse.** Both ledgers stay balanced, local trade in both
communities is entirely unaffected, and nothing is lost — the boundary simply stops passing value in the
direction that was draining it. Designing for a clean throttle instead of an unbounded tab is the point
of the caps.

Note "in that direction": the throttle is **one-way**, and the opposite direction is the cure. See
[§3.2](#the-cap-is-one-way-this-is-the-part-to-get-right) — a cap that blocked the peer relationship
wholesale would freeze the drained community permanently.

Note also *who* suffers versus who can act, because it is the whole design problem in one sentence: under
one-way flow the surplus community is perfectly comfortable — visitor demand puts otherwise-idle people to
work, members hold more beans, the commons swells, and nothing looks wrong from where it sits. The drained
community is the one whose members drift toward their floor until trade grinds. **The community that
suffers is not the one with the power to fix it.** Everything in §5 exists to answer that asymmetry.

### The case this model cannot solve

A genuinely self-sufficient community that wants nothing from anyone. There, the tab simply stops at the
cap and stays there. The honest answers are cash or deliberate generosity, and it is worth saying plainly:
**mutual credit can fund reciprocal exchange; it cannot manufacture value to fund one-way consumption.**
No mechanism in this document should be extended to pretend otherwise.

---

## 5. Rebalancing a tab

Two mechanisms, in strict order of preference. First, though, it matters *which* channel a rebalancing
flow can travel down.

### 5.1 The four channels

Value crosses a border in four economically distinct ways, depending on who pays and who earns:

| Channel | What it is | Can a community *decide* to do it? |
|---|---|---|
| **Person → Person** | A Byron member buys directly from a Brisbane member | No — organic, happens only where real demand exists |
| **Person → Commons** | A Byron member buys something Brisbane's commons offers | No — organic |
| **Commons → Person** | Byron's commons hires a Brisbane member | **Yes — the main deliberate lever** |
| **Commons → Commons** | The two treasuries trade directly, institution to institution | Yes |

The distinction that matters: the first two breathe on their own and cannot be willed into happening, so
a community with a surplus cannot fix an imbalance through them. **The commons rows are the only ones it
can act on deliberately** — which is exactly why #105 is the mechanism that makes this model rebalance
rather than merely account.

Two things follow, and both prevent building something more complicated than needed:

- **Offer vs request is only a question of who spoke first.** The beans move identically. Reach controls
  and the needs board are the same primitive seen from two ends, not two systems.
- **"Correcting the imbalance" is not a special transaction type.** It is simply whatever happens to flow
  the right way. There is nothing to implement called a settlement or a correction — the tab nets down as
  a side effect of ordinary trade.

### 5.2 The surplus community buys work from the drained one — trade, not charity

The community holding the claim commissions work from its partner, redeeming the tab through real
exchange. Individual cross-boundary demand is organic and happens only where it happens; the
**treasury/commons channel is the one a community can act on deliberately** — which is why #105 (the
cross-node needs board) is the mechanism that makes this model actually rebalance rather than merely
account.

The worked example from the design session: **Byron hires Brisbane musicians to play at a Byron
festival.** Beans flow Byron → Brisbane, talent flows Brisbane → Byron, the tab nets down, Brisbane
members earn their way off the floor — and Byron gets a festival instead of getting nothing. The people
filling those needs are being *hired*, not bailed out, which matters for a project built on mutual aid.

This is strongly preferred because it settles the tab *and* produces something both sides wanted.

**The reciprocity covenant already applies, and #105 inherits it.** `createPost` refuses a `need` from any
author with no listed offer (`engine/posts.ts:72`, `CONTRIBUTION_REQUIRED_ERROR`). A treasury is an
ordinary `members` row posting through the same path, so a community treasury must already be offering
something before it can post a Need — including a cross-node one. That is the right behaviour and needs no
exemption; it does mean a surplus community cannot commission its way out of a tab while offering nothing
itself.

> **Rule 7 — An imbalance may decide what gets *prioritised*. It may never decide whether a need is
> genuine.**

Rule 7 is the guard rail on the whole mechanism. Paying people to dig holes and fill them in would settle
a tab beautifully and destroy the thing that makes a bean mean anything. A needs board fed by imbalance
must surface real needs sooner — never manufacture them.

### 5.3 Only where surplus is genuinely saturated: let it decay or forgive

Where a community's surplus is real, unspendable, and it has exhausted what it wants to buy, the claim
may be allowed to decay or be forgiven. This must be **deliberate and visible** — never a silent
by-product of applying the circulation charge to a bridge account (§2.4).

This is what resolves the forgiveness question, and the resolution turns on a distinction the demurrage
brackets already draw. Gifting beans that could still buy something real is a genuine sacrifice, and
automating it is a subsidy for one-way flow (§7). But once a community is saturated — everyone flush,
nothing left it wants — those excess beans have **stopped being claims on anything**. Shedding *those*
costs nothing and helps everyone. Normal, active holdings sit in the green zone untouched; only
pathological idle piles feel the charge. The brackets are the mechanism that tells the two apart.

### The fairness rule

> **Rule 8 — Pressure may only fall on a party that has the power to act.**

- Charging an **idle surplus** is fair: the holder can spend it, buy work, or forgive it. They have
  agency.
- Penalising a community **because nobody took up its offers** is not fair: it did the thing being asked
  of it and cannot control demand. It has no agency.

This rule is what separates a rebalancing mechanism from austerity, and it is the test any future
adjustment lever (#107 included) must pass before it ships.

It also fixes the *direction* of #107's clearance fund. Proceeds from the charge on an idle surplus become
a **carrot that makes the clearing work more attractive to take on — never a stick applied to the drained
community.** A community whose offers nobody took up did exactly what was asked of it and controls none
of the demand; charging it for that outcome fails Rule 8. Funding a premium on the work that would
rebalance the tab passes.

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
unstable, because the surplus side has no reason to ever act. Rule 8 is the same principle expressed as
a fairness test rather than a symmetry claim, and §5 is the mechanism.

It also corrected the design session's own first instinct, which was to cap the *deficit* community —
i.e. to cap Brisbane. That is the austerity answer. The surplus side is equally responsible for the
imbalance and is the side that can actually afford to move.

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

### A distinct kind of bean — "traveller beans", "clearance beans", "inter beans"

**Rejected.** Naming the cross-boundary position as its own *kind of bean* is the settlement token above
wearing friendlier clothes. Anything with its own noun becomes a thing to hold, price, compare and
arbitrage, and a bean called a "traveller bean" quietly asserts the one thing Rule 1 denies — that beans
travel.

There is exactly **one** unit: beans. What needed a name was never the unit but the *position*, and that
is the **energy balance** (§2.2). Keeping one currency and naming the position costs nothing and removes
an entire class of misunderstanding.

### Routing the surplus charge to a supra-community pool

**Rejected, and worth recording because it will come up again** once a cluster has more than two nodes.
Charging idle surpluses into a shared, higher-level fund is not a bad idea in itself — it is *literally*
Keynes' design, where the charge accrued to the union's own reserve rather than to the deficit country.

It is also exactly where the ICU died. The reason its failure mode doesn't transfer to beanpool (§6) is
that there is **no outside body**: the charge is applied automatically by a protocol both nodes already
run, consented to once when they federate. Create a supra-community pool with a claim on a community's
surplus and you have rebuilt the precise thing the United States refused in 1944 — an external entity to
defect from. Somebody eventually will.

So the charge stays **local**: to the pair, or funding the clearing work itself (#107). Revisit only if a
real multi-community cluster makes the case, and never by quietly widening the scope of #107.

**The honest cost of staying local, past two nodes.** Bilateral caps can deadlock a loop that would
otherwise clear itself: A is at its cap with B, B at its cap with C, C at its cap with A — and yet the
three positions sum to nothing. Each pair is stuck even though the ring is balanced. That is precisely
why multi-community **netting** is the attractive deferred item in §7, and it is a real limitation rather
than an oversight.

Until netting exists, the answer is bilateral and unglamorous: a community at its cap with a partner
clears it *with that partner*, by buying the work described in §5. To be explicit about two things this
does **not** license:

- **#107 is not netting.** It is the imbalance-keyed circulation charge and clearance fund. Netting is a
  separate, unbuilt mechanism, and conflating them would smuggle multi-hop clearing in under a scope that
  never covered it.
- **Nothing here may become mandatory before it exists.** A spec must not require a protocol that has not
  been built; the bilateral case has to be proven in production first (§7, routed credit).

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
turns a cap breach on one link into a cascade across the mesh — see Rule 6. Bilateral tabs keep every
failure local to one pair. Revisit only if a real cluster demonstrates the need, and never before the
bilateral case is proven in production.

Multi-community **netting** — where a closed *loop* of debts cancels itself out — is the genuinely
attractive version of this, and is firmly a later problem. It is also strictly safer than routed credit,
because netting a loop moves no credit outside pairs that already chose each other.

---

## 8. Scope boundary: what can actually cross

Cross-node trade is **beans-only**, and in practice **services and remote deliverables only**.

- **Cash cannot travel.** The "cash also needed" flag (#108) covers a real local outlay — fuel,
  consumables — settled directly between two people who are in the same place. It has no cross-boundary
  meaning.
- **Physical goods cannot be delivered across a boundary.** You cannot collect a couch you are not
  standing next to.

### What beans are for, and the cash test

Beans do not work for things that cost money, and were never meant to. A café cannot accept beans for a
coffee, because its beans, milk, rent and wages are all in dollars — beans don't pay its suppliers. That
is the boundary, not a flaw. Beans work for the economy that runs on **spare time, skills and surplus**:
a free Saturday fixing a fence, guitar lessons, a lift into town, a logo, too many eggs. Nobody bought
those inputs.

Two rules follow, and they belong here because they are the reason cross-node trade is beans-only:

> **Beans cannot be bought.** You earn them, or you are given a starting credit line. If dollars could
> buy in, a price would form and the system collapses back into the thing it routes around. Buying
> something with cash and then *offering* it for beans is fine — that is earning by another route.

> **Cash covers fuel and consumables. Your time and your tools are beans.** (#108)

The test is whether you bought it with money **and** used it up doing the job. Petrol: yes. Timber, paint,
ingredients: yes. Your drill: no — you still own it afterwards, so it's beans. Your labour: always beans.
The app never touches the money, so it must not pretend to: a single flag on the listing, details in chat.

The useful consequence: **physicality is self-enforcing.** A remote member browsing a "help move a
shed" offer simply cannot fulfil it, and no rule needed to be written to stop them.

> **Rule 9 — Remote reach is a discovery filter, not an access control.**

Per-listing reach (#105) exists so members don't wade through offers they can't use, and so a poster can
say "this one travels" about remote tutoring or design work. It is not a permission system, and should
not be built as one — building it as access control implies a guarantee the protocol cannot make and
does not need to.

---

## 9. Open questions

Deliberately unresolved. Each needs a decision before or during #104; none blocks writing it down. The
four that *were* here and are now settled have moved to [Decisions taken](#decisions-taken).

**Resolved: the 1.5% transaction fee on a cross-node purchase goes to the buyer's home node's Commons**
— worked into the ledger entries in [§2.1](#21-the-entries), including why the buyer pays it on top
rather than the seller absorbing it as they would locally.
The fee exists to keep the network solvent when pruning an inactive member means writing off their debt
(§8, and [commons-pool-transparency.md](commons-pool-transparency.md)). In a cross-node purchase the debt
lands on the **buyer's home** ledger — so that is the node facing the write-off, and that is the Commons
that should be building the reserve against it. The seller's node minted locally but carries no debt from
the trade, so a fee there would accumulate against an exposure it doesn't have.

1. **What happens to a live tab when a member is pruned at home?** Their negative is written off against
   their home Commons today. The bridge position is a separate obligation between nodes and should
   presumably survive — confirm.
2. **What happens to a tab on defederation?** A `blocked` transition with a non-zero tab needs a defined
   end state: frozen pending settlement, or written off symmetrically.
3. **Reservation timeout value**, and whether it should scale with peer latency. The test pair is a
   1 CPU / 1 GB VM specifically because its added latency exposes races a local run hides — tune against
   that, not against localhost.
4. **Where is the energy balance surfaced**, and to whom? The *form* is settled — a scale centred on zero
   with each cap at an end, denominated in beans (§2.2). What's open is placement: the bridge-equality
   check is the most useful federation health signal for an operator, while "our energy balance with Byron
   is −480" is a governance-grade fact that probably belongs in the Commons tab rather than a status page.
5. **Are stewards of a community enterprise appointed by an admin or nominated by the community?** Carried
   here from #106, because the answer determines whether an `appoint` Decision becomes the grantor. #106
   builds admin-appointed and keeps the schema open; this is the decision it defers.

### Deliberately not in scope

Recorded so they are not mistaken for oversights: multi-community netting (§7), routed credit (§7, Rule 6),
any tradeable settlement token or distinct kind of bean (§7), routing the surplus charge to a
supra-community pool (§7), and per-activity accounting across enterprises — one treasury per
enterprise, its balance is its books, and consolidated reporting waits until a second and third enterprise
actually exist.
