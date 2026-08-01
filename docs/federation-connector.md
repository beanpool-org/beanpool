# The Federation Connector — one concept, end to end

**Status:** map, not a spec. Written 2026-08-02 to put the whole connector back in one place after it had
been split across #102–#108 and lost its through-line.

**What this is for:** you should be able to read this in ten minutes and see the entire thing — what it is,
what it entails, what exists, what doesn't, and what is still undecided. Every mechanism links to the
document that owns the detail. Nothing here supersedes those; where they disagree, they win.

> Sources: the design conversation of 2026-07-30 (the one "Beans on holiday" was written up *from* — that
> artifact was a simplified pass for showing to friends, and two things did not survive it; see
> [What the write-up lost](#what-the-write-up-lost)). Detail lives in
> [federation-economics.md](federation-economics.md), [protocol-rules.md](protocol-rules.md) §14,
> [node-dns-registrar.md](node-dns-registrar.md).

---

## 1. The one-sentence version

**A member of one community can spend their beans in another, without any beans crossing the boundary —
because the two communities keep a tally of work owed, and settle it by doing work for each other.**

The original framing was "beans on holiday": someone from Brisbane is in Byron for a week and wants to buy
something. They have beans. Their beans live on Brisbane's ledger. What happens?

## 2. Why it can't be a transfer

A bean is not a token — it is **the mirror of a live negative**. Accounts start at zero, there is no money
supply, and the network always sums to zero. Every positive bean has a specific member somewhere sitting at
a matching negative, who extinguishes it by earning.

So sending a positive bean to another community **strands its negative**. The Brisbane member at −50 can no
longer earn it back from Brisbane's circulation, because the counterpart to their debt has left. Repeat it
across many visitors and the drained community's circulation shrinks permanently — not through fraud, but
through transfers that look perfectly correct.

> **Rule 1 — Beans never cross a node boundary. Standing does.**

## 3. The loop — and it is a loop, not a pipeline

This is the part the issue split obscured. The connector is **two halves of one mechanism**:

### Half A — accounting: charge home, mint local, carry a tab

A Brisbane member buys a 5-bean service from a Byron seller. Four entries, two ledgers, both still summing
to zero:

```
BYRON                                    BRISBANE
  seller               +5.000              buyer                −5.075
  bridge_brisbane      −5.000              COMMONS_POOL         +0.075   (the 1.5% fee, stays home)
                                           bridge_byron         +5.000
  ─────────────────────────                ─────────────────────────
  node total            0.000              node total            0.000
```

Byron has delivered real work and not yet had any back. That is what the bridge row records — in the
original phrasing, **"byron has a credit of energy."** It is not beans in an account: nobody can spend it,
nobody can transfer it, and it does not decay (decaying a debt is silent forgiveness).

### Half B — redemption: the community holding the credit calls the favour in

Byron's tally is worth nothing unless Byron can *use* it. It does that by **posting needs into Brisbane** —
commissioning work from Brisbane members, paid in Brisbane beans it now effectively holds. From the design
conversation, near-verbatim: *the management team in Byron advertises in Brisbane, posting needs for things
Brisbane can offer — Brisbane people get paid in beans to come down and do a performance in Byron.*

The tab nets down as a **side effect of ordinary trade**. There is no "settlement transaction" to build.

**Value crosses in four channels**, and only two of them can be *decided* on
([§5.1](federation-economics.md#51-the-four-channels)):

| Channel | Deliberate? |
|---|---|
| Person → Person | No — organic |
| Person → Commons | No — organic |
| **Commons → Person** (a community hires a member of its partner) | **Yes — the main lever** |
| **Commons → Commons** (the two treasuries trade directly) | Yes |

**Half A without Half B is a number that only grows.** That is the single most important sentence in this
document, and it is why the two must not be sequenced as "build the settlement, then maybe the needs board
later."

## 4. What it entails — the stack

Six layers. A connector is only useful when all six are in place, and today they are not.

| # | Layer | What it is | State |
|---|---|---|---|
| 0 | **An address** | A node has to be reachable and nameable before anyone can connect to it. `<name>.beanpool.org` via our Cloudflare Worker registrar; tunnel mode (default, NAT-safe) or direct. | Code-complete, merged (#87/#88). **Not deployed.** |
| 1 | **The connector record** | An operator manually adds a peer by multiaddr in `/settings`. No auto-discovery, no bootstrap list, no central coordination. Stored in `data/connectors.json`. | Built |
| 2 | **Transport** | libp2p — TCP + WebSockets, Noise encryption, yamux muxing. Two protocols: `/beanpool/handshake/1.0.0` (mutual trust + RTT) and `/beanpool/federation/1.0.0` (RPC). | Built |
| 3 | **Trust level** | `mirror` = backup replica, full state replication. `peer` = trading partner, no sync. `blocked` = deny. **A mirror must never settle** — a replica mirrors a ledger, it does not author one. | Built |
| 4 | **Economics — Half A** | Bridge accounts, per-peer credit caps, per-member foreign exposure caps, the purchase/receipt exchange, compensating reversals, boot recovery. | Built, unverified across two live nodes |
| 5 | **Redemption — Half B** | The cross-node needs board and per-listing reach. The thing that makes a tab settle rather than accumulate. | **Not built** |

## 5. Three gates, all fail-closed, all currently shut

Worth knowing together, because it means **the entire federation surface is dormant in production right
now** — nothing below is live on any node:

| Gate | Default | What it controls |
|---|---|---|
| `ENABLE_PEER_CONNECTORS` (env) | **off** | Whether peer connectors function at all |
| `FEDERATION_SETTLEMENT` (env) | **off** | Whether *new* cross-node trades are accepted. Receipt delivery and status queries stay open either way, so switching it off never strands value already committed |
| per-peer `creditCap` | **unset** | No default, ever. Unset means settlement with that peer is refused. A default that suits a 200-member town quietly overexposes a 15-member one |

Caps are **never negotiated over the wire**. Each node enforces its own, from its own config, on its own
books — so a compromised peer's maximum reach is exactly the number its counterparty chose.

## 6. The boundary: what can actually cross

Cross-node trade is beans-only, and in practice **services and remote deliverables only**.

- **Cash cannot travel.** The "cash also needed" flag covers a real local outlay — fuel, consumables —
  settled directly between two people standing in the same place.
- **Physical goods cannot travel.** You cannot collect a couch you are not next to.
- **Beans cannot be bought.** You earn them, or you're given a starting credit line. Buying something with
  money and then *offering* it for beans is fine — that's earning by another route.

The useful consequence: **physicality is self-enforcing.** A remote member browsing "help move a shed"
simply cannot fulfil it. No rule was needed.

> **Rule 9 — Remote reach is a discovery filter, not an access control.** It exists so members don't wade
> through offers they can't use. Building it as a permission system would imply a guarantee the protocol
> cannot make and does not need to.

## 7. What the write-up lost

Comparing the 2026-07-30 conversation against what was built, two things were demoted:

**1. The needs board is the mechanism, not a follow-on feature.** In the conversation it arrives as the
answer to "how does Byron ever get its energy back?" — it is the settlement half. In the issue split it
became #105, filed after #104 and described as "cross-node needs board + per-listing reach controls",
which reads like a discovery nicety. `federation-economics.md` §5.1 actually says it plainly — *"#105 is
the mechanism that makes this model rebalance rather than merely account"* — but the issue ordering said
otherwise, and the issue ordering is what got worked.

**2. The overlap with Commons / Treasury / enterprises was flagged and never resolved.** Mid-conversation:
*"you do realise we already have a commons and treasury feature... people are nominated to manage
'enterprises' inside the commons tab... it does seem that there is overlap here."* Two of the four
rebalancing channels are Commons-side, and the actors that would run them — treasuries, keepers,
per-enterprise stewardship — **already exist and are deployed**. Half B has far more foundation under it
than #105 implies. Nobody has checked how the two fit together.

## 8. Open decisions

Carried from [§9](federation-economics.md#9-open-questions), still unresolved:

1. **A live tab when a member is pruned at home.** Their negative is written off against their home
   Commons; the bridge position is a separate obligation between nodes and should presumably survive.
2. **A tab on defederation.** A `blocked` transition with a non-zero tab needs a defined end state: frozen
   pending settlement, or written off symmetrically.
3. **Reservation timeout**, and whether it should scale with peer latency. Tune against the real 1 CPU /
   1 GB pair, not localhost.
4. **Where the energy balance is surfaced, and to whom.** The form is settled — a scale centred on zero
   with each cap at an end, in beans. Placement is open: an operator health signal, or a governance-grade
   fact belonging in the Commons tab.
5. **Are enterprise stewards appointed by an admin or nominated by the community?** Determines whether an
   `appoint` Decision becomes the grantor. Currently admin-appointed with the schema left open.

**Settled, and recorded so they aren't relitigated:** the tab lives in `bridge_<peer>` rather than the
Commons; foreign spending power is carved out of the member's existing home floor; a node's cap on a peer
has no default; the 1.5% fee goes to the buyer's home Commons. Reasoning for each is in the
[Decisions taken](federation-economics.md#decisions-taken) table.

**Explicitly out of scope**, so they aren't mistaken for gaps: multi-community netting, routed or
multi-hop credit, any tradeable settlement token or second kind of bean, and routing a surplus charge to a
supra-community pool.

## 9. Prior art

This is Keynes' International Clearing Union (1943), component for component — bilateral tabs in a unit of
account nobody can hoard or export, with pressure applied to *both* the deficit and the surplus side.
Revived by Monbiot in *The Age of Consent*. The one deliberate departure: the ICU charged surplus nations
interest to force them to spend; here the surplus community is instead given somewhere to spend —
the needs board — because a small community's surplus is a symptom of stagnation, not of hoarding.
