# The Commons — Enterprises, Decisions and Polls

> **Status: DESIGN, agreed in discussion. Not built.**
> Master document for three interwoven things: **community enterprises**, **binding decisions**,
> and **everyday polls**. It supersedes the Treasury/Decision/Role sketch in
> [`community-governance.md`](./community-governance.md) and fixes the final shape of the derived
> credit model that Antigravity specified in `enterprise-credit-model.pdf`.
>
> **Sources.** Written 2026-09-14 by Claude from (a) a verified read of `main` at that date, (b) the
> three architectural manuals in `projects/beanpool-docs`, (c) a three-round design argument with
> Antigravity. Where Antigravity and Claude disagreed and settled, the doc says so. Where they did
> not settle, it is in §7 as a decision for Marty.
>
> **Every claim in §0 was checked against the code, not against the manuals.** The manuals were
> written against an older checkout (`bp-manual`) and some of their line numbers have drifted, but
> every finding below still reproduces on `main`.

---

## 0. What is actually true today

Read this section first. Most of the confusion about voting comes from the fact that there are two
project systems, and the one the app shows you is not the one with the voting in it.

### 0.1 Enterprises — half-built, and the half that is missing is the important half

An enterprise is a row in `members` with `is_treasury = 1`. It is a real account: it holds a
balance, posts offers and needs, gets rated, and is exempt from demurrage.

**Works today:**

| Thing | Where |
|---|---|
| Create an enterprise | `POST /api/local/admin/treasury` — **admin only** (also fleet manager, bootstrap script, and auto-created for Daily Pulse / BeanPool / federation links) |
| Post an offer or a need as the enterprise | `POST /api/treasury/:t/offer` and `/need` — native only |
| Buy *from* an enterprise | normal marketplace flow, works everywhere |
| Sweep surplus to the Commons pool | `POST /api/treasury/:t/sweep` — native only |
| Appoint a keeper | `POST /api/local/admin/treasury/:t/operators` — **curl only, no UI anywhere** |

**Does not work today:**

- **An enterprise cannot pay anyone.** `POST /api/treasury/:t/approve` and `/complete` exist on the
  server and have client helpers in *both* clients, and **neither client calls them**. So the whole
  point of the model from [`community-governance.md`](./community-governance.md) — the Commons posts
  "tend the chickens" as a paid Need and a member earns beans and trust doing it — is unreachable.
  Tapping Approve on the normal post screen sends the operator's *personal* key and the server
  rejects it 400.
- **`scripts/grant-operator.mjs` still calls the wrong route.** It hits `/operator` (which only flips
  `members.can_operate`) and prints a success message promising controls that will not appear. The
  working route is `/operators` (plural). This is the single most misleading thing in the repo.
- **The PWA has no operator UI at all.** `apps/pwa/src/lib/api.ts` defines a helper for every
  treasury action; not one component imports any of them. Treasury cards render as dead `<div>`s.
- **Money only flows one way.** `sweep` moves beans enterprise → Commons. There is no path at all
  from Commons → enterprise. `payFromCommons` exists but is wired only to voting-round winners and
  pruned-member debt write-offs.
- **No audit trail.** The server checks *that* you are an authorised keeper and then throws your
  public key away. Posts record `author_pubkey = treasury`; sweeps record `auth_signer = NULL`. With
  two keepers, nothing anywhere records which one spent the money.
- **A dead private key.** `createTreasury` generates an Ed25519 keypair and writes the private key in
  **plaintext** to `node_config` as `treasury_privkey_<pub>`. **No code path ever reads it.** The
  enterprise never signs anything; keepers sign with their own keys and the server authorises them.

**The floor is the part that matters most.** `packages/beanpool-engine/src/trust.ts` currently says:

```ts
const activated = elderVouched || grantedCredit > 0 || earnedCredit > 0 || isTreasury;
const effectiveGranted = isTreasury ? Math.max(200, grantedCredit) : grantedCredit;
```

So **every enterprise is born activated with a −200 overdraft that nobody earned**, whatever the
admin typed in the credit-line box. Ten enterprise rows = 2,000 beans of unbacked credit, at a cost
of zero. That is why creation is locked to admins: creating an enterprise currently *hands out
money-like capacity*, so it cannot be self-serve as the code stands. Fix the floor and self-serve
becomes safe — that is the hinge this whole document turns on.

(The offer covenant does bite: `usableFloor = max(floor, −offerCapForCount(liveOffers))`, and
`offerCapForCount(0) = 0`, so an enterprise with no live offers cannot actually draw its −200. That
is a real brake, but it is a brake on *use*, not on *issuance* — the capacity still exists and
unlocks the moment one offer is posted.)

### 0.2 Voting — it does not work, and here is exactly how it fails

There is a complete quadratic-voting engine on the server. It is unreachable from every client.

- **The engine.** Proposals and rounds are stored as **JSON blobs in `node_config`** under
  `commons_projects` and `voting_rounds`. There is no SQL table. Voting power = `qualifiedTradeValue`
  (completed escrow trades, counterparty-capped — gifts grant nothing, and liquid beans cannot buy
  votes, which is correct and worth keeping). Cost = votes².
- **`packages/beanpool-core/src/governance.ts` is dead code.** It is exported from the package index
  and **nothing imports it**. The real implementation lives in `state-engine.ts`. Anyone reading the
  repo to understand governance reads the wrong file first.
- **Only an admin can open or close a round**, via `admin.ts` — and there is no fleet-manager UI for
  it either, so in practice it is a curl command. Only one round can be open at a time.
- **The PWA never calls it.** `getCommonsProjects`, `voteForProject`, `getGovernanceCredits` all
  exist in `api.ts`; zero components import them. `ProjectsPage` talks only to `/api/crowdfund/*`.
- **Native calls a route that does not exist.** `voteForProjectApi` posts to
  `/api/crowdfund/projects/vote` → **404**. It is masked because `getProjects()` hardcodes
  `type: 'community'` while the vote UI only renders when `type === 'commons'`, so the button is
  permanently invisible. A 404 hidden behind a dead conditional.

And even if it were wired, the mechanism itself is not a decision procedure:

- **You can only back one thing.** `voteForProject` deletes all your existing votes in the round
  before recording the new one. So you cannot spread votes across proposals — which is the entire
  point of quadratic voting. It is a one-pick funding contest wearing QV's clothes.
- **There is no way to vote against anything.** Support only.
- **There is no pass rule.** Highest weight wins, full stop. No quorum, no majority, no minimum
  support. One person voting once decides a round.
- **The winner's money lands in their personal wallet.** `closeVotingRound` debits `COMMONS_POOL`
  and credits `winner.proposerPubkey`'s personal balance, with no escrow, no milestones and no
  obligation to do the thing they proposed.

### 0.3 Two project systems, and the wrong one is switched on

| | Commons proposals | Crowdfunding projects |
|---|---|---|
| Storage | JSON in `node_config` | SQL `projects` table |
| Funded by | `COMMONS_POOL` | direct member pledges |
| Mechanism | quadratic voting | escrow, releases at goal |
| Works? | **No — unreachable** | **Yes, both clients** |
| Governance? | yes (broken) | **none at all** |

So the system with democracy in it cannot be reached, and the system members can reach has no
democracy in it. That is the whole of the "voting doesn't work" problem in one table.

---

## 1. The answer in one page

Three objects. That is the whole model.

**1. An Enterprise** — a community thing that trades: the egg flock, the tool library, the firewood
depot. It is an account with a face, run by **keepers**, and its credit line comes from the earned
trading standing of those keepers. No keepers, no credit. It is not owned by anyone.

**2. A Decision** — a binding vote with a typed effect. Only four effects exist: grant money from the
Commons, remove a lead keeper, change a protocol parameter, write off a bad debt. It has a quorum, a
majority, a fixed window, and it executes itself. This is the heavy machinery, and it is rare.

**3. A Poll** — a question anyone can ask, posted into the market feed like an offer or a need. No
bond, no quorum, no cooling period, no money. It closes and shows a tally. This is the everyday
thing, and it is the part that makes a community feel like it is governing itself.

The mistake in the current build is that it has exactly one mechanism, sized for **2**, wired for
**1**, and it is missing **3** — which is the one people would actually use every week.

> **The key move:** voting stops being a feature of the projects page and becomes a general member
> capability. Funding a project is then just *one kind* of Decision, not the reason Decisions exist.

---

## 2. Enterprises

### 2.1 A project *is* an enterprise — one object, two lifecycles

This was already the agreed position in [`community-governance.md`](./community-governance.md) —
*"an enterprise is a project that persists and trades; a bounded project is a treasury that winds
down — same object, different lifecycle"* — but the code never made it literal, which is exactly why
there are two project systems today. Make it literal.

**There is one object. It is an Enterprise.** It has a name, a face, a **purpose**, keepers, an
account, and a lifecycle. "Project" is not a second thing; it is an enterprise with an end.

| | Ongoing enterprise | Bounded enterprise ("a project") |
|---|---|---|
| Example | Community Eggs, tool library, firewood depot | Build the shade house; buy the woodchipper; run the spring fair |
| Purpose statement | required — *"we keep 30 chickens fed and lay-ready"* | required — *"we will build a shade house by November"* |
| Has a goal amount | no | yes |
| Has an end date | no | yes |
| At the end | keeps going | **winds up**: surplus returns to the Commons, keepers released, account archived |
| Trades | yes | usually yes — it can sell and it can hire |
| Receives pledges | yes | yes |

**Both get a purpose statement.** Marty's instinct here is right and it is not decoration: the
purpose is what a Commons grant is *for*, what a keeper is signing up to, and what the community
judges the thing against when it later asks "did that work?". An enterprise without a stated purpose
is an account with a name on it. Make the field required at creation, show it on the card, show it on
the detail screen, and quote it in any Decision that spends money on the enterprise.

**Collaborators are just keepers.** Marty asked whether a project can have collaborators — yes, and
there is no second concept for it. A one-person project is an enterprise with one keeper. It grows
by adding keepers. Nothing in the model changes.

**What this buys us, concretely:**

- The `projects` SQL table and the `commons_projects` JSON blob both disappear. A "project" becomes a
  row in `members` with `is_treasury = 1`, a purpose, a goal and a deadline.
- Crowdfunding pledges stop paying a *person*. Today `db.ts` sweeps a funded project's escrow
  straight to `creator_pubkey`'s personal balance. Under one object, pledges land in the
  **enterprise's own account** — visible, keeper-run, spendable only on offers and needs that the
  whole community can see. This is a strict integrity improvement and it falls out of the
  unification for free rather than needing its own escrow-and-milestones machinery.
- "Fund a project from the Commons" and "capitalise an enterprise from the Commons" become the same
  Decision, which closes the one-way liquidity trap in §0.1 with one route instead of two.
- One list in the Commons tab instead of two, one detail screen instead of two.

> **Claude's note on where Antigravity and this differ.** Antigravity's answer to the two-systems
> problem was to keep the `projects` table and add a `funding_mechanism` column. Marty's framing is
> better: the difference between the two systems was never the funding mechanism (both can be
> pledged into, both can be granted to, both can trade) — it was the **lifecycle**. Sorting on
> lifecycle gives one object; sorting on funding gives one table with three modes and all the same
> confusion.

### 2.2 What a community actually needs to run one

The pragmatic checklist, in the order a real community hits it. Marked ✅ exists, ⚠️ exists but
unreachable, ❌ missing.

**Standing it up**
- ❌ Create it themselves, without asking a node admin (§2.3)
- ❌ State its purpose
- ✅ Give it a name (unique per node, already enforced) and an avatar
- ❌ Say whether it is ongoing or bounded, and if bounded, goal + end date
- ❌ Put it somewhere — a map location, so the shed and the flock are findable
  - **Pins are public, exactly like marketplace post pins**: anyone who can open the node's map sees
    them, not only members. Findability is the point — a neighbour who has not joined yet should be able
    to find the flock. What protects a home is the **Approximate** option (rounds to roughly 100 m), kept
    one tap away beside the warning in the picker, which says so in plain words: "Anyone who opens this
    node's map will see this spot." A wound-up enterprise's location is cleared at finalisation and never
    served again. (Marty, 2026-09-17; §10)

**Money**
- ✅ Hold a balance, exempt from demurrage
- ❌ Get a credit line that is *earned* rather than handed out (§2.4)
- ✅ Sell things and be paid
- ⚠️ **Pay someone for work** — the single biggest gap; server routes exist, no client calls them
- ❌ Receive member pledges into its own account (today they pay the creator personally)
- ❌ Receive a grant from the Commons (no route exists at all)
- ✅ Sweep surplus back to the Commons
- ❌ See its own income vs spend — "the balance is its P&L" only works if you can *read* the P&L

**People**
- ⚠️ Appoint a keeper (curl only, and the helper script is broken)
- ❌ A member asking to *join* as a keeper, rather than being appointed from outside
- ✅ Revoke a keeper
- ❌ A lead, and a way for the lead role to move when that person goes quiet (§2.3)
- ❌ Any record of *which* keeper did a thing (§0.1)

**Doing the work**
- ✅ Post an offer (recurring offers already supported via `repeatable`)
- ✅ Post a need — gated behind the offer covenant, which is correct
- ⚠️ Approve a bid on that need
- ⚠️ Confirm completion and release payment
- ❌ Pause the enterprise for a season — members have holiday mode
  (`member_preferences.holiday_mode`), enterprises have nothing. A flock in winter, a project between
  stages, and a bounded enterprise waiting on materials all need it, and without it the offer
  covenant quietly closes their floor the moment they stop listing.

  **The credit floor while paused** (decided by Marty, 2026-09-16, implemented exactly as written):
  - On pause, snapshot the enterprise's current derived floor (`paused_floor_snapshot`, `paused_at`).
  - While paused, its usable floor is `max(snapshot, derived)` — the covenant cannot pull it below what it had the day it paused, and genuinely earned growth still counts. It is NOT recomputed downward.
  - The snapshot expires after **90 days paused**: past that the floor is the normally derived value again. Warn visibly before the expiry, not after it.
  - On resume, clear the snapshot and recompute normally.
  - Keeper exits during a pause still release their backing per §2.6 — a pause freezes the covenant, never a keeper's right to leave.

**Being accountable**
- ✅ Ratings accrue to the enterprise, not to whoever was operating it that day
- ❌ A visible ledger of what it took in and paid out
- ❌ A wind-up path: finish, return surplus, release keepers, archive the name

**Talking about it**
- ❌ Somewhere to discuss it. Every real enterprise generates conversation ("who's got the ute
  Saturday?"). Today that lands in general Chat and is lost. An enterprise-scoped thread is a small
  feature with a large effect on whether the thing feels alive.

### 2.3 Who runs it — keepers, and the owner question

**Decided (Marty, 2026-09-14): no owner — a lead keeper.** Marty initially asked for an owner plus
keepers; the reasoning below changed the call. A second argument arrived later and reinforced it:
the node now has an **owner** too (§9.2), so an enterprise owner would make "owner" mean two
different things at two levels — and "Steward" has already taught us what that costs. The final
vocabulary is **node → owner / admin · enterprise → lead keeper / keeper · group → convenor ·
trust tier → Steward.** Four levels, no word reused.

Why ownership is the wrong shape for this specific object:

1. **The asset is not theirs.** A community enterprise is underwritten by the pooled standing of its
   keepers and, on failure, by the Commons. An owner would hold unilateral control over a thing other
   people carry the risk for.
2. **It creates a capture surface.** "Founder owns the flock" is fine until the founder falls out
   with the community and takes the name, the listings and the balance with them.
3. **It has no succession.** An owner who leaves, loses their phone, or simply goes quiet paralyses
   the enterprise until an admin edits the database by hand. Every intentional community eventually
   has this person.

What replaces it — and note it is *less* than ownership but *more* than the flat table we have now:

| | Keeper | Lead keeper |
|---|---|---|
| Post offers and needs | ✅ | ✅ |
| Approve bids, confirm work, pay | ✅ | ✅ |
| Sweep surplus to the Commons | ✅ | ✅ |
| Edit name, avatar, purpose, location | ❌ | ✅ |
| Invite and remove other keepers | ❌ | ✅ |
| Start a wind-up | ❌ | ✅ |
| Sweep to a *personal* account | ❌ | ❌ — nobody can, ever |

- **The creator is the first lead keeper.** Nothing else is special about them.
- **Succession, without an admin:** if the lead records no node activity for 30 days, a simple
  majority of the remaining keepers can move the lead role to an active keeper. If there are no other
  keepers, the enterprise falls to the inactivity rules in §2.6.
- **Removal of a rogue lead** is not an internal matter — it is a community Decision (§3), because by
  then internal consensus has already failed. That is the one place a vote reaches inside an
  enterprise, and it exists precisely so that ownership does not have to.

**The schema is already ready for this.** `treasury_operators.role` exists, defaults to `'keeper'`,
and is *never read* by any authorisation path. Adding `'lead'` is a value change, not a migration.

**Naming.** `Steward` is taken — it is a trust *tier* in `protocol.ts` (`Newcomer | Resident |
Steward | Elder`), which is exactly why `db.ts` renamed the role to `keeper` in the first place. That
rename then collided with recovery keepers — but social/guardian recovery was scrapped in September
2026, so **"keeper" is free again and should be kept.** It is also Marty's own word for it. A profile
card then reads `Dave · Resident · Community Eggs keeper` with no collision. (Antigravity proposed
renaming the entity itself to "Co-op"; "Enterprise" is retained here because it already appears
throughout the docs and because not every enterprise is a co-op — the Daily Pulse account is one too.)

### 2.4 The floor — the part that has to be right

**Today:** every enterprise is born with an unearned −200 overdraft. **Proposed:** an enterprise has
no intrinsic credit line at all. Its floor is the earned trading standing its keepers put behind it.

```
enterprise_allowance = min( CREDIT_FLOOR_CAP,  Σ backing_pledged_by_keeper_i )
enterprise_floor     = − enterprise_allowance
usable_floor         = max( enterprise_floor, −offerCapForCount(liveOffers) )   ← unchanged, still applies
```

Four rules make that safe, and they were argued out rather than assumed:

**Rule 1 — only *earned* credit backs an enterprise.** Vouch gifts (25/50/100) and admin tier grants
count for **zero**. Only `earnedCredit` — completed, escrow-settled, counterparty-capped trade —
counts. Without this, a voucher can mint fresh identities, hand them welcome credit, make them
keepers, and multiply unbacked credit into existence with no trade behind it.

**Rule 2 — no multiplier. Straight sum.** Antigravity's original spec proposed a super-additive
curve (M(2)=1.25 … M(4+)=1.50) to reward co-stewardship. **Marty's instinct — plain sum of the
members — is the one adopted, and Antigravity reversed its own spec to agree.** A multiplier
manufactures up to ~667 beans of purchasing power nobody earned, and the only way to make that safe
is machinery that claws it back from volunteers (see Rule 4). What is lost is a *bonus for teaming
up*; the real reason to form an enterprise is a shared trading identity, pooled inventory and joint
listing presence, not synthetic credit.

**Rule 3 — count a keeper's standing once, and let them declare how much.** This is the one part
neither the original spec nor the first round of discussion had right.

A plain sum still leaks: Carol, with 100 of earned credit, keeps her personal −100 floor *and* backs
the Tool Shed for 100 *and* the Bakery for 100. Three hundred beans of network drawdown capacity from
one hundred beans of demonstrated production — the same multiplication we just rejected, reached by
founding enterprises instead of by a curve.

Two fixes were considered. **Exclusive staking** (backing is deducted from your own floor) was
rejected: a keeper's personal floor is their household working capital — the buffer that buys bread
on Tuesday before the eggs sell on Friday — and asking volunteers to give that up to curate a public
asset kills volunteering before it starts. It also traps a keeper inside an indebted enterprise.

The rule adopted instead: **a keeper's earned credit is never touched on their personal side, but it
is counted once across all enterprises they keep.**

```
available_to_back(keeper) = earnedCredit(keeper) − Σ backing already pledged elsewhere
```

- Backing is an **explicit pledge**, made when joining, with one control: *"Back this enterprise with
  your standing: 0 … <available>."*
- **Never auto-split.** If Carol's 100 were silently split when she joined a second enterprise, the
  Tool Shed's floor would drop from −100 to −50 the moment she said yes to the bakery — and if the
  shed were sitting at −80 it would go underwater and spend-freeze mid-trade, with no warning to
  anyone. The pledge is deliberate, visible, and changes nothing anywhere else.
- **Pledge lock:** a keeper cannot pull backing below what the enterprise's current deficit needs.
  If the shed is at −80, that 80 stays until inventory sells or another keeper pledges cover.
- Total capacity traceable to one member is therefore capped at `2 × earnedCredit` — their own floor
  plus their pledged backing — no matter how many enterprises they join.

**Rule 4 — the enterprise fails, not the keeper's household.** If an enterprise defaults, its own
credit freezes (floor → 0; it can still *receive*, so it can trade its way back). Its keepers are
barred from founding or keeping another enterprise for 12 months. **Their personal floors are not
touched.**

This is a deliberate reversal of Rule 4 of the original spec, which apportioned the deficit across
keepers' personal floors and could freeze their personal credit. Antigravity named it as the single
thing most likely to kill the model in practice, and it is right: in an off-grid community, if
volunteering to keep the flock means your family's grocery credit can be frozen when a fox gets in,
nobody volunteers. Cooperatives, credit unions and non-profits all give volunteer boards limited
liability for exactly this reason.

**So be honest about what the keepers' standing is doing.** It is **not** collateral and nothing is
"underwritten" by it — Antigravity conceded this wording. It is a **sizing heuristic**: proof that
the people running this thing demonstrably produce value for the community, used to decide how deep
the thing may go. The loss-bearer of last resort is the Commons pool, which is funded by a levy on
every trade — i.e. it is already the community's mutual-assurance fund, and absorbing the occasional
failed initiative is what it is *for*.

**And the ledger never breaks.** A floor is an overdraft limit, not a balance. Changing it writes
zero transactions and mints zero beans; `SUM(balances) + COMMONS_POOL = 0` holds throughout, whatever
number we pick. The risk being managed here is *capacity*, not issuance.

**Rule 5 — credit buys inputs; profit pays people.** *(Marty, 2026-09-14 — the missing half of this
model.)*

> **An enterprise may borrow from the community to buy things. It may not borrow from the community
> to pay itself.**

At approve time the server already knows the payee, the amount and the balance, and
`treasury_operators` says whether the payee is a keeper. So:

| Payee | May spend |
|---|---|
| **not a keeper** of this enterprise — a supplier, a neighbour's labour, feed, timber | down to `usableFloor`, i.e. into credit |
| **a keeper** of this enterprise | only while `balance − amount >= 0`. **Never into credit.** |

This closes the loop with Rule 3. Keepers pledge their earned standing to give the enterprise a
credit line — and then **cannot convert that standing into their own wages.** You may lend the
community's trust to the flock; you may not route it into your own pocket.

It also makes Rule 4 (no personal recourse) considerably safer. The failure that rule is most
exposed to is a **bust-out** — run an enterprise into the ground while paying yourself out of its
credit line, then walk. That attack *requires* paying a keeper from credit. Block it and the attack
has no payload left.

**A sole keeper in deficit therefore cannot be paid at all.** That is correct, not a bug — the
operator eats last, as in any real small concern — but the UI must say so plainly rather than let
someone discover it at the moment they expected money.

**Rule 6 — keeper pay is capped by *earned surplus*, so grants cannot become wages.** A positive
balance is not the same thing as profit. If the Commons grants 300 beans to the tool shed, the
balance rises and Rule 5 alone would let the keepers pay themselves out of community money.

Track one integer on the enterprise: `earned_surplus` = lifetime income **from sales** minus
lifetime payments **to keepers**. Keeper pay is capped by it. Grants, pledges and gifts raise the
balance and never the surplus — they can buy feed, hire a neighbour, fund the thing they were voted
for, and they can never come out as wages.

**Seasonality is handled by deferring, not by relaxing.** A flock buys feed in winter and sells eggs
in spring; the keeper does the work in the cold half. A keeper payment that Rule 5 or 6 refuses
becomes a **deferred wage claim** — recorded now, paid automatically the moment the enterprise can
legitimately pay it. Same pattern as a queued Commons grant (§3.7): the community's decision is not
thrown away over a timing accident.

**Rule 7 — surplus above a working-capital ceiling returns to the Commons automatically.**
Enterprises are exempt from demurrage (§0.1), so a member's idle beans shrink and an enterprise's
never do. With sweeping left voluntary, an enterprise can accumulate indefinitely while everyone
else's holdings decay. That is capitalism wearing the app's clothes — not by intent, but the effect
is identical.

Each enterprise declares the working capital its purpose actually requires. Below the ceiling it
holds freely and stays decay-exempt, because saving toward a real pump or a new coop is legitimate.
**Above the ceiling, earned surplus sweeps to the Commons automatically** — no keeper decision involved.
The sweep takes only earned surplus, never grant money: `sweepable = max(0, min(balance − working_capital_ceiling, earned_surplus))`.
Grants, pledges and gifts raise balance, never earned surplus, and are never swept.

The ceiling is set at creation and changed only by a **Decision**, never by the enterprise's own
keepers. Otherwise the first response to hitting it is to raise it.

*(Note: enterprises already contribute on every sale — marketplace settlements run through escrow
and pay the 1.5% community fee like anyone else. The leak was never contribution. It was
accumulation.)*

Together, Rules 5–7 mean an enterprise can **hold** what it needs, **pay outsiders** on credit, pay
**its own people only out of genuine trading profit**, and cannot **accumulate** past its stated
purpose.

> **Member-facing copy is not updated yet.** These rules will need to reach `apps/website/rules.html`
> and the in-app explanations before they are live, and the app already carries copy that overstates
> what the system does. Do not let the rule book and the rule diverge again.

### 2.5 Creating one — self-serve becomes safe

Creation is admin-only today for one reason: **creating an enterprise currently hands out a −200
credit line.** Remove that (§2.4) and creation mints nothing — a keeperless enterprise has a floor of
exactly 0 and cannot spend a bean it has not been given. Self-serve becomes safe.

What is left to defend is namespace and clutter, not money:

| Guardrail | Why |
|---|---|
| Creator must have `earnedCredit > 0` and not be `credit_frozen` | at least one real completed trade; a brand-new account cannot spawn enterprises |
| Name unique per node, case-insensitive | already enforced in `createTreasury` — stops `bakery` being squatted |
| Purpose statement required, min length | an enterprise with no stated purpose is just a named account |
| Avatar required | already enforced for non-system creation |
| Max 2 enterprises kept per member | limits both clutter and concentration |
| Auto-archive: 0 transactions, 0 offers, 0 keepers, 0 balance for 90 days → `archived`, name released | reclaims squatted and abandoned names without an admin |

**A creation fee was considered and is not recommended.** Antigravity proposed 10 beans to the
Commons as skin in the game. But a member at their floor cannot pay it, the thing being created mints
nothing, and charging for the act of organising your community is the wrong signal in a gift-adjacent
economy. The standing gate (`earnedCredit > 0`) already costs more effort than 10 beans and is not
regressive. *(Recorded as an open question in §7 — Marty may disagree.)*

**Does creating an enterprise need a community vote?** No. If Carol and Dave have earned their
standing through honest trade and choose to put it behind Community Firewood, they do not need the
town's permission to spend inside a limit they earned. Requiring a referendum to start a woodpile is
exactly the bureaucracy that makes governance features go unused. **A vote is required only when the
enterprise reaches for something that is not its own:** a grant from the Commons pool, or a credit
line beyond what its keepers' standing supports. That is the line, and it is the whole of §4.

### 2.6 Failing, pausing and winding up

- **Pausing.** An enterprise can go on holiday like a member can. Needed for seasons, for stages and
  for waiting on materials — and without it the offer covenant silently closes an idle enterprise's
  floor. While paused: listings hidden, floor held at its current usable level, no default clock.
- **Default** is an *objective* engine trigger, never a judgement call: negative balance for 60 days
  with no inbound trade, **or** negative balance with zero live offers for 14 days (offer covenant
  abandoned). On default: enterprise spend-frozen, keepers barred from new enterprises for 12 months,
  a notice shown to the community. No personal ledgers touched.
- **The debt does not vanish and is not silently absorbed.** A defaulted enterprise sits on the ledger
  as recognised bad debt. Clearing it is a pool Decision (§3.6) — because a pool that
  quietly absorbs losses is a pool being spent without a vote.
- **Keeper exit.** Solvent: leave immediately, backing released, floor recalculates. In deficit:
  backing is locked to the extent the deficit needs it (Rule 3), so there is no race to the exit and
  no unilateral dumping — but nothing is charged to anyone personally.
- **Wind-up.** Lead keeper starts it (or it is automatic for a bounded enterprise at its end date):
  settle open trades, return surplus to the Commons, release keepers and their backing, archive the
  account and free the name. An insolvent enterprise cannot self-wind-up — it needs the write-off
  Decision first.

---

## 3. Decisions and Polls

### 3.1 What voting is, in plain words

*(This is the section Marty asked for: what voting is at a functional level, assuming you have never
read the governance code.)*

Every trade on the node pays a small fee (1.5%), and beans that sit idle decay a little. Both flows
go into one shared account called the **Commons pool**. Nobody owns it. It is the community's money.

**Voting is how the community decides what happens to that money, and who holds community roles.**

A member opens the Commons tab and sees a short list of things to decide, each with a plain title and
a clock:

> *"Grant 200 beans to the Shade House so it can buy timber"* · 4 days left
> *"Remove Dave as lead keeper of Community Eggs"* · 2 days left
> *"Should the market move to Sunday?"* · closes Friday

They tap one, read the case for it, and vote. When the clock runs out the node counts the votes
itself — no admin presses a button — and if it passed, **the thing happens automatically**: the beans
move, the role changes, the setting changes. If it was just a question, the result is recorded and
visible, and that is the point of it.

That is all voting is. The current build has the counting engine and none of the rest: no list, no
clock, no automatic close, no automatic effect, and no way for a member to open one.

### 3.2 Two weights of thing — and this is the change that matters

The single most important correction to the current design: **voting must stop being a feature of
the projects page and become a general member capability.** Marty is right that it wants to come out
and be a tool members use for anything — and Antigravity, which initially argued for wrapping every
vote in bonds, cooling periods and quorums, conceded the point outright once it was put this way.

But "vote on anything" cannot mean "everything carries the same machinery". Split by **stakes**, not
by topic:

| | **Poll** — the everyday thing | **Decision** — the rare, binding thing |
|---|---|---|
| Example | *"Market on Sunday?"* · *"Bulk-order feed from Casino?"* | *"Grant 200 beans to the Shade House"* |
| Who can open one | any active member | any member with `earnedCredit > 0` |
| Cost to open | **nothing** | a refundable bond *(see §7)* |
| Cooling period | none | 48 hours to discuss and amend |
| Quorum | none | yes (§3.4) |
| Effect when it passes | a visible tally, and that is all | the node executes it |
| Where it lives | **a card in the market feed** | the Commons tab |
| Lifecycle | 3 / 7 / 14 days, or closed by the author | fixed 7-day window, auto-closes |

**A Poll is a post.** Not a new screen, not a new tab, not a governance module: a third post type
alongside Offer and Need, in the feed people already open every day. You tap "New post", pick "Poll",
type a question and 2–4 options, and it appears in the feed as a card with progress bars and a
tap-to-vote button. That placement *is* the feature — a governance tab that people have to remember
to visit will not build a habit, and the feed already has their attention.

**Noise is handled socially, not financially.** A poll nobody cares about gets ignored and scrolls
away. Rate limits (1 open poll per member, 5 open per node) are enough. No bond — charging a member
beans because their neighbours were apathetic punishes the wrong person, which is the same unfairness
we rejected for enterprise default.

Everything a Decision can do is enumerated in §3.6, and everything else anyone wants to vote about
is a Poll. A Poll never moves anything: if it passes and needs doing, a person does it.

### 3.3 Who gets a voice

Two franchises, because one cannot serve both purposes.

**Polls and role Decisions: one member, one vote.** Weighting *"should the market move to Sunday"* by
trade volume creates a commercial oligarchy where the busiest traders set village rules for everyone
else. Every active member gets exactly one equal voice.

**Commons money: quadratic voting on earned trade standing.** Voice credits = `earnedCredit`; casting
N votes costs N². Liquid beans cannot buy votes, gifts build nothing, vouch credit counts for
nothing. This already exists and is already correct — it is the one part of the governance engine
worth keeping as-is. Giving one-member-one-vote power over a shared treasury invites exactly the
sockpuppet attack the trade-derived franchise was built to stop.

How to say it to a member without it feeling rigged:

> *"For community questions and for who holds a role, every member has one equal voice. For spending
> the shared pool, the voice is weighted by trade — because the pool is built from trade fees, and
> quadratic counting means the biggest traders still cannot outvote everyone else."*

**"One member" has to mean something.** Membership comes from an invite, so a prolific inviter could
otherwise farm a voting bloc — a quieter capture than the oligarchy we just avoided. The gate:

- account active, not frozen, and at least 14 days old; **and**
- vouched by an elder, **or** at least one completed escrow trade with someone who is **not** their
  inviter and not in their invite downline.

At village scale this closes it: minting ten voters means conducting ten real, fee-paying trades with
established members, which costs more than capturing the vote is worth. **It does not hold at 500+
members** — at that size the independence gate has to tighten to two independent vouches, and honestly
that is federation's problem, not this document's. Say it plainly rather than pretend otherwise.

> **Exception for the first slice:** ship Polls with **no trade gate at all** — active and not frozen
> is enough. Bindarrabi has ~20 real humans who know each other, and gating *"should we hire the
> woodchipper this weekend"* behind completed escrow trades excludes exactly the newcomers the
> community is trying to draw in. The franchise gate arrives with Decisions, when real money is on
> the table.

### 3.4 The pass rule

Today: highest weight wins, no quorum, no majority, admin closes the round by hand. That is not a
pass rule, it is a leaderboard.

**Quorum is counted against *active* members, never total registrations.** Counting against everyone
who ever installed the app means dormant accounts permanently brick the denominator and every
proposal fails forever.

```
quorum = max( K_min, ceil(0.30 × activeMembers_30d) )
```

`activeMembers_30d` = distinct accounts with a trade, transfer or settlement in the last 30 days.
`K_min` is an absolute human floor so a six-member node is not governed by one person: **3**.

| Node | active (30d) | quorum |
|---|---|---|
| brand new (6 members) | ~6 | 3 |
| Bindarrabi (~30 members) | ~20 | 6 |
| mullum (~400 registered) | ~50 | 15 |

**Majority:**

- **Polls** — simple majority of votes cast; no quorum at all (a poll's only job is to show a tally)
- **Pool decisions** (grants, hardship, write-offs) — 60% of voting weight in support, judged **per
  proposal**, pass or fail on its own merits. Not a contest where the top vote-getter takes the money.
- **Member and rule decisions** — 60% supermajority
- **Restorations** (reinstate, unfreeze, return a badge) — simple majority, deliberately lower than
  the act they reverse
- **Removing a member** — 66% on a 25% quorum, the highest bar in the system (§3.8)

**Ties fail. Quorum failures expire as `UNRESOLVED` and cost nobody anything.** No beans are ever
burned for community apathy.

**Nothing needs an admin.** A Decision closes itself on the first state-engine tick after its
deadline. The current design — where a human must both open and close every round — is why zero
rounds have ever run.

### 3.5 Where the money goes when a Decision passes

Today the winner's requested amount is credited to the **proposer's personal balance**, with no
escrow, no milestones and no obligation to do the thing. That has to go.

**A Commons grant is paid to an enterprise. Never to a person.** This falls out of §2.1 for free: if
a project *is* an enterprise, then "fund a project" means "credit an enterprise account" — an account
with a stated purpose, named keepers, a public balance, and spending that happens through visible
offers and needs the whole community can watch. The accountability comes from the object being
transparent, not from bolting a milestone-approval workflow onto a personal payout.

If a member wants Commons money for something, the path is: create the enterprise (free, self-serve,
mints nothing), state its purpose, then propose the grant. That ordering is a feature.

### 3.6 What a Decision can do — typed by what it touches

The first draft of this document listed four Decision types, and three of them were about
enterprises. That was the wrong direction to enumerate from: it made voting look like an enterprise
feature with a poll bolted on, when **voting sits beside enterprises, not inside them.** An
enterprise is not a category of decision — it is one possible *subject* of one.

So Decisions are typed by **what the effect touches**, and that also settles which franchise applies:

| Touches | Effects | Franchise | Threshold |
|---|---|---|---|
| **a member** | suspend · remove · **reinstate** · freeze or unfreeze credit · appoint or remove a voucher · remove a lead keeper | one member, one vote | 60% (removals), simple majority (restorations) |
| **the pool** | grant to an enterprise · **hardship grant or debt forgiveness for a person** · write off a defaulted deficit · set a levy *(not built)* | quadratic on earned trade | 60% |
| **a rule** *(not built)* | fee rate · demurrage rate · vouch gift sizes · offer-band depths · invite expiry · open vs invite-only · peer with another node · which Pulse channels we carry | one member, one vote | 60% |
| **nothing** | every Poll — a Poll is a post in the feed, not a Decision | one member, one vote | simple majority, no quorum |

**What is live (2026-09-19).** The member and pool rows are built, except the levy. Nothing that
changes a rule is built yet, so the server refuses to open a `set_rule`, `set_levy` or `poll`
Decision ("This kind of decision is not available yet") rather than let one pass and change nothing.
Tier badges and elder standing were once in the member row as `grant_tier` / `revoke_tier` /
`grant_elder` / `revoke_elder`; they are **removed** — the server refuses them and neither app offers
them — because a tier is earned by trading and a vote on it is exactly the vote the "never a vote"
list below forbids. The effect names stay in the type so old stored rows still load; a stored one no
longer changes anyone's earned credit.

Two consequences worth naming:

- **"Fund the shade house" and "give Sarah a hardship grant" are the same kind of decision** pointed
  at different subjects. An off-grid community will likely use the second more than the first, and
  the current design has no path for it at all.
- **Restoring is easier than removing.** Removals need 60%; reinstating someone, unfreezing credit,
  needs a simple majority. Asymmetry is deliberate: an error that
  excludes someone should be cheaper to correct than it was to make.

Every one of these is a power a node admin holds unilaterally today — `adminSetUserStatus`,
`adminSetCreditFrozen`, `adminSetTier`, `adminSetVoucher`, `adminSetElder`, `adminPruneUser`,
`adminPruneBranch`, `actionReport`. **This section is mostly a list of admin powers being handed to
the community**, which is a fair description of what "community governance" has to mean if it means
anything.

**What must never be a vote.** Equally important, and a standing rule:

- **An individual trade.** That is what escrow and ratings are for.
- **Anyone's trust score or credit floor.** It is earned, not granted — a vote to raise someone's
  standing is a vote to mint credit, and it would make the whole trust model negotiable.
- **Declaring an enterprise in default.** An objective engine condition (§2.6), never a popularity
  contest about whether we like the keepers.
- **Anything urgent.** Safety needs a fast unilateral path with ratification afterwards (§3.8), not
  a quorum.
- **Anything that would recur weekly.** If it comes up repeatedly it is not a decision, it is a
  rule — set it once in the "touches a rule" row and stop voting on it.

### 3.7 How a Decision actually takes effect

*(Marty's question: is this bolted into the real code path — an account removal, say — or is it a
directive the admin then enacts?)*

**Bolted in. It executes itself. With one carve-out for destruction.**

A directive-only model was considered and rejected as the general rule, because an admin who simply
does nothing becomes a **silent veto** — and the cases that most need a vote (removing a rogue lead
keeper, removing someone the admin is friends with) are exactly the cases where inaction is most
likely. A vote that is advertised as binding but is advisory in practice is worse than no vote at
all. It teaches a community that governance is theatre, and you only get to teach them that once.

**The mechanism is simpler than it sounds, because the execution surface already exists.** Every
`admin*` function in `state-engine.ts` is a plain function — the admin password is checked at the
*route* layer, not inside the function. So a Decision executor calls the same functions the admin
route calls, with no refactor of either.

1. A `decisions` row holds `effect`, `subject`, `params`, `opens_at`, `closes_at`, `status`.
2. A tick evaluates decisions past their close time. `state-engine.ts` already runs periodic ticks
   (5-minute persistence, daily conservation audit); this joins them. **No admin presses anything**,
   which is the single biggest difference from today, where a human must open *and* close every
   round and consequently zero rounds have ever run.
3. Quorum and majority are evaluated (§3.4). Pass → `executeDecision()` dispatches on `effect`.
4. **A pre-flight assertion runs immediately before applying anything**: does the subject still
   exist, are the invariants intact, is the pool solvent for this? A failed assertion halts at
   `execution_blocked` and alerts — it never applies a partial change.
5. The status flip and the effect commit **in one `BEGIN IMMEDIATE` transaction**, so a crash can
   never leave "passed but not applied" or apply something twice.
6. Every mutation carries a provenance stamp — `auth_signer = 'system:decision:<id>'` plus a
   `reason`. This doubles as the fix for the audit-trail hole in §0.1, where sweeps currently record
   `auth_signer = NULL`, and it ties every ledger debit and role change back to the signed tally
   that authorised it. **A decision-driven change to someone's account must never be anonymous.**

**Sort effects by reversibility, not by type:**

| | Examples | On close |
|---|---|---|
| **Reversible state flips** | suspend, freeze, appoint, revoke, set a parameter, pause | **execute immediately.** Undo is another Decision, and it is cheap |
| **Money movements** | grant, hardship, write-off | **execute immediately.** The ledger is already the audit trail and the destination is an account, not a deletion |
| **Destructive** | prune a member, prune an invite branch, archive an enterprise and release its name | **never on close.** Set a pending state with a **7-day grace window** |

**The grace window is not delay theatre — it does four specific jobs.** The member is suspended
immediately, so the community is protected from the first minute. During the window they can settle
their balance, export what they need, and be reinstated by a new Decision if the vote was a mistake
or new facts appear. And the destructive step **fires automatically at the end of the window** — it
does not wait for an admin to be awake, which is what keeps the silent-veto problem closed.

**What the admin keeps is a brake, not a veto.** They can *accelerate* a pending removal (clear,
ongoing abuse) or *halt* one — but a halt requires posting a **signed, public reason** that raises an
alert in the main feed. An admin overriding the community is then a visible act they have to defend,
which is categorically different from an admin quietly not clicking a button.

**When a passed Decision cannot execute**, the rule depends on *why*, and **it is never a partial
execution.** A half-paid grant strands public money in an unviable half-project; a grant is
all-or-nothing.

- **Not enough in the pool** — a 300-bean grant passes but the pool holds 240 by close. The community
  already decided, so do not throw that away: the decision sits at `passed_queued_for_funds` and
  pays out automatically once fee income brings the pool to 300. The card shows
  *"Approved · funding 240 / 300"*. **Cap this carefully:** one queued grant at a time, visible to
  everyone, and it expires after 90 days rather than pre-committing the community's income
  indefinitely. A long queue of claims against future fees is a future community governing under a
  past one's decisions.
- **The subject is gone** — the member was already pruned, the enterprise wound up mid-vote. Mark it
  `execution_void` with a permanent tombstone and a reason. It never re-opens.

### 3.8 Removing a member — the hard case

Marty's example, and the one that stresses the design hardest. Three problems, none of them obvious.

**1. Speed and legitimacy pull in opposite directions.** A seven-day vote on someone actively
defrauding people is useless. So it is two phases:

- **Quarantine, immediately.** Any moderator can sever access on the spot: listings hidden, trading
  and messaging blocked, credit clamped to zero. The community is protected from the first minute.
- **Ratification, mandatorily.** A quarantine **automatically opens a removal Decision within 24
  hours**, and — this is the part that matters — **if no removal is ratified within 7 days, the
  quarantine expires on its own and the member is reinstated automatically.** Without that expiry, a
  rogue moderator can silence someone indefinitely by calling it "temporary" and never following
  through. The suspension stays on the public record either way, so an unjustified one has a visible
  cost to whoever made it.

**2. Removing a member is also a spending decision, and nobody would guess that.** `adminPruneUser`
settles the departing member's balance: a negative balance is **written off against the Commons**,
with `allowDeficit` set, so it can push the pool negative. (That is deliberate, not a bug —
[`commons-pool-transparency.md`](./commons-pool-transparency.md) states that to delete an account and
keep the zero-sum invariant, the community must pay off the debt.)

So the ballot has to say so out loud:

> **Remove Dave from this node.**
> Dave's balance is **−180 beans**. Removing him charges that 180 to the Commons pool, which
> currently holds 240.

Nobody would infer that, and it will change how people vote.

**But it stays one-member-one-vote, not the pool's quadratic franchise** — and this was the sharpest
question in the whole design. The tempting inference is "money moves, so use the money franchise".
The answer is no, for two reasons. First, switching it would hand the community's biggest traders
the power to banish their neighbours, which is the one power a trade-weighted franchise must never
have. Second, the write-off is not a discretionary investment — **the debt is already lost whether
or not the person is expelled.** Removing them recognises a loss; it does not create one. Expulsion
is a question of civic safety and community boundaries, so every active member gets one vote.

**3. Be honest about what removal is.** The member holds their own keys. Removal means **this node
refuses to serve them** — it does not erase them, and they may still exist on other nodes. The copy
should say that plainly rather than imply a power the system does not have.

**Thresholds — removal is the highest bar in the system.** Expulsion needs a **two-thirds (66%)
supermajority** on a 25% quorum, not the 60% that other Decisions use: banishing a neighbour should
require broad alignment, not a 51% factional win. **Reinstatement needs only a simple majority** on
the standard 20% quorum. Without a reinstatement path every removal is permanent by inertia, and the
first unjust one poisons the mechanism for good.

**And the node admin cannot be voted out — say so plainly.** They hold the SSH keys, the container,
the SQLite file and the DNS. A vote that flips an `is_admin` bit is undone with one shell command,
and shipping an in-app "depose the admin" button would be security theatre. Governance here is real
over everything except the machine itself.

**The honest remedy is a fork, not a mutiny.** A `no_confidence` Decision does not try to strip the
admin of anything. What it does is produce a **signed community archive** — ledger, balances,
reputation graph, membership, post history — that the community can carry to a new node under a host
they trust. That is a real remedy rather than a theoretical one, because the machinery already
exists: the node DNS registrar lets a community claim its own `<name>.beanpool.org`, the delta
backup work already produces verified snapshots, and federation means the new node is not starting
from nothing. **The right to leave with your history is the check on the person holding the server.**

---

## 4. Where this is managed in the app

**Yes — the Commons tab, with one exception that matters.** The native bottom bar already has
`Commons` (it is `app/(tabs)/projects.tsx`, renamed but not re-shaped). It becomes the civic front
door, with depth that scales by role and *nothing extra shown to a member who holds no role*.

**Commons tab — what every member sees**

1. **Decide** — open Decisions and Polls needing them, each with a clock. The one time-sensitive
   thing, so it leads. Empty most weeks, and that is fine.
2. **Enterprises** — one list, ongoing and bounded together, each card showing avatar, name, purpose,
   live-offer count and balance. Bounded ones additionally show progress toward goal and time left.
   A "Start something" button at the bottom.
3. **The Commons at a glance** — pool balance, what was funded lately, what wound up. Visibility is
   what makes it feel like a shared thing rather than admin config.

**Enterprise detail screen — the console.** One screen per enterprise, and it is where the actual
running happens. Everyone sees the purpose, balance, keepers, live listings, and the record of what
it took in and paid out. **Keepers additionally see, on the same screen:** post offer, post need,
**approve bids, confirm work and pay** (the missing half), sweep surplus, pause, and — for the lead —
edit details and manage keepers. Progressive disclosure, not a separate destination.

**The exception: Polls live in the market feed, not here.** A Poll is a post (§3.2). It is created
from the existing "New post" flow and appears as a card in the feed alongside offers and needs. The
Commons tab *also* lists open polls, but the feed is where they are met and voted on. This is
deliberate: the feed is the screen people open daily, and a governance tab people must remember to
visit will not build the habit.

**What moves out of Settings.** Moderation, reports, invites and member audit belong with the other
role-gated depth in the Commons tab, not buried in Settings. (Lower priority than the above, but it
is the same principle: one civic surface.)

**PWA.** Same information architecture; the side-nav has room, so the width constraints are
native-only. Note the PWA currently has *no* operator UI at all despite having every API helper —
whatever ships to native must ship here too, or desktop keepers stay locked out.

---

## 5. Where enterprises and voting meet

This is the join. It is deliberately small — most of running an enterprise involves no voting
whatsoever, and that is what keeps governance from being resented.

> **This table is the enterprise-shaped slice of §3.6, not the whole of voting.** Most Decisions a
> community makes — removing a member, appointing a voucher, changing the fee, a hardship grant —
> have nothing to do with any enterprise. Voting sits *beside* enterprises.

| Event | Who decides | Why |
|---|---|---|
| Create an enterprise | **the creator alone** | it mints nothing; a floor of 0 until keepers back it |
| Back it with your standing | **the keeper alone** | it is their own earned credit, capped at what they have |
| Appoint / remove a keeper | **lead keeper** | a co-op cannot need a referendum to onboard a helper |
| Post offers, hire, pay, sweep | **any keeper** | day-to-day operations |
| Pause / resume | **any keeper** | operational |
| **Grant Commons beans to it** | **Decision** — pool franchise, 60% | the pool belongs to everyone |
| **Credit line beyond keepers' standing** | **Decision** — pool franchise, 60% | asking for capacity nobody earned |
| **Remove a rogue lead keeper** | **Decision** — 1p1v, 60% | internal consensus has already failed; this is the check that replaces ownership |
| Declare default | **nobody — the engine** | an objective condition, not a political judgement |
| **Write off a defaulted deficit** | **Decision** — pool franchise, 60% | it spends the pool, so it is typed like every other pool decision (§3.6) |
| Wind up (solvent) | **lead keeper** | nothing is at stake but their own effort |
| Wind up (insolvent) | **Decision**, then lead | the write-off has to be authorised first |

Read the table top to bottom and the principle is visible: **a vote is required exactly when an
enterprise reaches for something that is not its own** — the community's money, capacity nobody
earned, or authority over a person who will not yield it. Everything else is just work.

---

## 6. Build order

Smallest first. Each slice is independently useful — nothing here is a big-bang cutover.

**Slice 0 — stop the bleeding (days, no schema change, safe for mullum today)**
- Fix `scripts/grant-operator.mjs` to hit `/operators` and actually insert the binding, or delete it.
  Right now it prints a success message for a grant that does nothing.
- Delete `packages/beanpool-core/src/governance.ts` — dead code that misdirects anyone reading the
  repo to understand governance.
- Remove native's `voteForProjectApi` call to the non-existent `/api/crowdfund/projects/vote`.

**Slice 1 — an enterprise can pay someone (the biggest single unlock)**
- Wire `/approve` and `/complete` into the enterprise detail screen, native **and** PWA. The helpers
  already exist in both clients; nothing calls them. Until this ships, no community enterprise can
  hire anyone, which is the entire premise.
- Record the acting keeper (`auth_signer`, and a `created_by` on enterprise posts) so there is an
  audit trail when an enterprise has more than one keeper.
- Give the PWA a treasury detail screen at all.

**Slice 2 — Polls (the first thing a community will actually feel)**
- `posts.type = 'poll'`, with `poll_options` JSON and `poll_closes_at`; new `poll_votes` table keyed
  `(post_id, voter_pubkey)`, re-voting overwrites.
- Created from the existing New-post flow; rendered as a feed card with tap-to-vote.
- Votes are **signed and open**, not secret — see §8.
- Franchise: active and not frozen. No trade gate yet.
- **Must be invisible to everything that keys off "is a post"** — see the checklist in §8.

**Slice 3 — one object (unify projects and enterprises)**
- Enterprises gain `purpose`, `goal_amount`, `deadline_at`, `lifecycle`, `status`, `paused`.
- Migrate the `projects` table into enterprise rows; pledges land in the enterprise account, not the
  creator's personal balance.
- Retire the `commons_projects` / `voting_rounds` JSON blobs from `node_config`.
- One list, one detail screen, in the Commons tab.

**Slice 4 — the derived floor ⚠️ the one slice that can break a live community**
- Replace `Math.max(200, grantedCredit)` and the `|| isTreasury` activation with the derived model.
- Add explicit backing pledges (`treasury_operators.backing`), with the pledge lock.
- Cache the derived floor; invalidate on trade completion, keeper change, backing change and
  freeze/status change. `getBalance` and `usableFloor` are on the hot path — they must stay O(1).
- **Do not ship this to mullum without the grandfather migration.** Community Eggs is live, holds a
  small positive balance, and dips into deficit to buy feed *before* eggs sell. A cutover that drops
  its floor to 0 the moment its keepers are not yet formally bound with enough earned credit will
  block a real feed purchase and strand a real flock. Set `legacy_credit_floor = 200` on existing
  enterprises, take `max(legacy, derived)`, and auto-clear the legacy value once derived ≥ 200.
  Same for Daily Pulse and BeanPool.
- Drop the plaintext `treasury_privkey_*` rows. Nothing reads them; they are pure liability.

**Slice 5 — Decisions**
- `decisions` + `decision_votes` tables, typed by what the effect touches (§3.6), two franchises,
  quorum and majority per §3.4.
- **The executor** (§3.7): tick-driven close, pre-flight assertion, single `BEGIN IMMEDIATE`
  transaction, `auth_signer = 'system:decision:<id>'` on every mutation, the reversible /
  money / destructive split, the funding queue. It calls the same `admin*` state-engine functions
  the admin routes already call — the execution surface exists, it just has one caller today.
- Start with **reversible member effects** (suspend, freeze, appoint a voucher, grant a tier, remove
  a lead keeper) — they exercise the whole pipeline with nothing destructive at the end of it.
- Then **pool effects**: the Commons → enterprise grant that has never existed, and the hardship
  grant, which an off-grid community will probably use more.
- **Removal last** (§3.8): quarantine with auto-expiry, mandatory ratification, the debt disclosure
  on the ballot, the 7-day grace, reinstatement at a lower bar. Do not ship removal before
  reinstatement works — a removal you cannot undo is not a feature, it is a liability.
- Commons tab "Decide" section, native and PWA.

**Slice 6 — the rest of §2.2**
- Enterprise pause, wind-up, join-as-keeper requests, lead succession, income/spend view,
  per-enterprise discussion thread, map location.

---

## 7. Decisions for Marty

Each has a recommendation. These are the ones where reasonable people differ, so they are yours.

1. ~~**Owner, or lead keeper?**~~ **DECIDED 2026-09-14: lead keeper.** Revocable, succeeds
   automatically when the person goes quiet, removable by community Decision — and it keeps "owner"
   meaning only one thing, now that the node has an owner too (§9.2).
2. **Creation fee?** Antigravity wants 10 beans to the Commons as skin in the game. The doc
   recommends **no fee** — a member at their floor cannot pay it, and charging to organise your
   community reads badly. The standing gate already does the work.
3. **Do Decisions need a bond?** The doc keeps a refundable bond on Decisions and **no bond** on
   Polls. The bond is the last piece of punitive machinery left; **consider dropping it too** and
   relying on the `earnedCredit > 0` gate plus a one-open-Decision-per-author limit.
4. **Max enterprises per member — 2 or 3?** Antigravity's spec said 3, its later answer said 2. The
   doc says 2. Low stakes, easy to change, but it caps how much of one person's standing can be in
   play at once.
5. **Quorum floor `K_min = 3`.** Fine at 6 members, possibly too low at 30. Worth a look once a real
   community has run three Decisions — do not tune it in advance.
6. **Does an enterprise ever get to vote?** Recommendation: **never.** An enterprise is a balance
   sheet, not a person; letting keepers vote its standing creates a corporate bloc inside a village.
   Currently it cannot vote, by accident. Make that deliberate and write it down.
7. **What happens to live `commons_projects` data on retirement?** Unknown — check each node before
   Slice 3 deletes the blobs. Probably empty everywhere, since nothing has ever been able to reach
   the feature, but "probably" is not good enough for a live node.
8. **Who can trigger an emergency quarantine?** §3.8 says "any moderator", but the node has no
   moderator role today — only the admin. Either the admin is the only one until a `moderate` Decision
   exists, or moderator becomes the first appointable role. **Recommendation: admin-only at first**,
   because the auto-expiry makes the power much less dangerous than it sounds.
9. **Should a queued grant hold a claim on future fee income at all?** §3.7 caps it at one grant,
   90 days, publicly visible. The alternative is to fail it outright and make the proposer re-propose
   against real numbers. **Recommendation: keep the queue** — the community already decided and
   making them decide again over a timing accident is the kind of friction that stops people voting.
10. **Is the levy worth having?** "Set a levy" appears in the pool row of §3.6 and would be the
   community's one lever to grow the Commons deliberately. It is also the easiest way to make people
   resent the app. **Recommendation: design it, ship it last**, after a community has actually run
   out of pool money and asked for it.

---

## 8. Named, not solved

Honest list of what this design does not fix.

**Polls are posts, and "is a post" is load-bearing.** Every query that currently means "a tradeable
listing" must be made to exclude polls explicitly, or a poll will quietly corrupt something
expensive. The concrete list:

1. **`liveOfferCount` / the offer covenant** — polls must never count toward `OFFER_BANDS`. Match
   `type = 'offer'` strictly; never `type != 'need'`. Get this wrong and posting polls widens your
   credit floor.
2. **The need-requires-an-offer gate** — a poll neither requires a live offer nor satisfies one.
3. **Trade routes** — request / approve / complete on a poll must 400, not half-work.
4. **Category filters and search** — searching "timber" must not return a ballot.
5. **Map pins** — polls have no pickup location and must not clutter the map.
6. **Completion and star ratings** — closing a poll must never trigger a rating prompt.
7. **Daily Pulse counts** — polls feed their own line, not "new offers".
8. `posts.status` has a `CHECK` constraint; a poll's lifecycle must fit inside the existing values or
   the constraint has to change.

**Votes are open, not secret — and we should say so.** A secret ballot on a node whose operator has
shell access to SQLite is a promise we cannot keep. Promise **signed, transparent village polling**
instead: every vote signed by the member's key, an aggregate tally shown prominently, and a
collapsible list of who voted for what. In a 20-person community, open accountability is more honest
than the illusion of privacy. The real cost is real, though — a visible vote against a neighbour is
socially expensive, and some things a community needs to decide are exactly the things people will
not put their name to. **This design cannot do a genuinely secret ballot, and should not pretend to.**

**The Commons pool may not be able to absorb what it insures.** At village trade volumes a 1.5% levy
might leave the pool holding +60 when a failed enterprise sits at −200. Nothing *breaks* — those 200
beans were already credited to the people who sold the tools, and `SUM(balances) + COMMONS_POOL = 0`
still holds; the network is simply carrying a recognised negative obligation. But the write-off
cannot be paid in one go. It amortises against incoming fee revenue, and until it clears, the debt
sits visible on the ledger. That is tolerable and honest, but **a community that suffers two
defaults in a row will feel it**, and the only real defence is that the standing gate makes defaults
rare.

**One-member-one-vote does not survive scale.** It holds at village size because minting voters means
conducting real trades with real people who know each other. At 500+ members with anonymous
onboarding it degrades, and the independence gate has to tighten. Named here so that nobody is
surprised by it later.

**A keeper still cannot lose anything.** Rule 4 deliberately protects the household ledger, so the
strongest penalty for running a community asset into the ground is a 12-month ban from keeping
another. Whether that is sufficient deterrent is genuinely unknown and will only be answered by a
real default in a real community.

---

## 9. Roles — the four kinds of belonging

Four different things in this system look like "a set of people with roles", and they are arriving
from four different directions: trust tiers (already shipped), enterprise keepers (§2.3), node
owner and admins (below), and the groups primitive in draft PR #416. Left alone they will collide.
This section places them on their axes.

| | What it is | How you get it | What it gives you | Taken away by |
|---|---|---|---|---|
| **Trust tier** — Newcomer / Resident / Steward / Elder | **earned standing**, computed | by trading | credit depth, and nothing else | nobody — it is a calculation, not a grant |
| **Group member** (#416) | **audience scope** — who sees what | joining (open / request / invite) | see and post inside a scope | the group's convenor |
| **Enterprise keeper / lead keeper** | **economic authority over one account** | appointed by the lead keeper; lead removable by Decision | spend that enterprise's money | the lead keeper, or a Decision |
| **Node owner / admin** | **infrastructure authority** | the owner appoints | node settings, moderation, overrides | the owner |

**The rule that keeps them apart: none of these may ever grant another.** Joining a group must never
confer admin. Being an admin must never confer a trust tier or credit. Being a keeper must never
confer vote weight. Every one of those would be a privilege-escalation path dressed up as a
convenience, and each is an easy accident to make when three of the four are structurally identical
join tables.

**Build three tables, not one generic one.** `treasury_operators` exists, `group_members` is proposed
in #416, and `node_roles` is proposed below — and they do look alike. Resist merging them. They have
different grant authorities, different revocation rules and different lifecycles, and a polymorphic
`role_grants` table makes every authorisation query carry a discriminator it can get wrong. Three
boring tables beat one clever one when the failure mode is "someone accidentally became an admin".

### 9.1 The word "steward" is now overloaded three ways

- `TierName = 'Newcomer' | 'Resident' | 'Steward' | 'Elder'` in `protocol.ts` — an **earned** tier.
- `treasury_operators.role` was `'steward'` and was **already renamed to `'keeper'`** in `db.ts`
  specifically to dodge that collision.
- Draft PR #416 introduces `GroupRole = 'steward' | 'member' | 'observer'` — walking straight back
  into it.

**#416 is unreviewed and disposable** (Marty, 2026-09-14), so groups is a clean slate rather than
something to design around. Take the name as a free choice: **`convenor`.** It is the word
Australian community, co-op and permaculture culture already uses for the person who runs a working
group, it is unused anywhere in the codebase, and it reads plainly to a non-technical member.

*(Antigravity proposed `Host`. Rejected — "host" already means the machine in this codebase: node
host, self-hosted nodes, `home_node_url`, the DNS registrar's whole vocabulary. It would be the
fourth collision, not an escape from the third.)*

So: **tier = Steward · enterprise = keeper / lead keeper · group = convenor · node = admin / owner.**
Four concepts, four words, no overlap.

### 9.2 Node owner and admins

**Today there is no owner, and "admin" is two disconnected mechanisms.**

- **A shared password.** `checkAdminAuth` verifies a scrypt hash (plus optional TOTP, CSRF and an IP
  allowlist) and gates every `/api/local/admin/*` route. It is **anonymous** — it can prove *an*
  admin acted, never *which*. This is the root of the audit-trail hole that §3.7 has to work around.
- **A pubkey, inferred.** `getAdminPubkey()` is
  `SELECT public_key FROM members WHERE invited_by = 'genesis' LIMIT 1` — no `ORDER BY`, no index on
  `invited_by`. It gates the in-protocol override in about eight places (`canOperate`,
  `canOperateTreasury`, `keeperOf`, offer bands).

They do not agree with each other: `createVotingRound` accepts **any** genesis member, while
`canOperateTreasury` accepts only whichever row `LIMIT 1` returns.

> **⚠️ Likely live bug — verify before designing around it.** `initStateEngine` inserts
> `('SYSTEM', 'System', 'genesis', 'genesis')` before any real genesis member exists. With no index
> on `invited_by`, the query is a rowid-order scan, so `SYSTEM` is almost certainly row one — meaning
> `getAdminPubkey()` returns the literal string `'SYSTEM'`, which no human holds, and every
> `publicKey === getAdminPubkey()` override has been silently inert. One check settles it, on the
> **test** node, never mullum:
> `SELECT public_key, callsign FROM members WHERE invited_by='genesis' LIMIT 1;`

**The model:**

```
node_roles( member_pubkey, role CHECK(role IN ('owner','admin')), granted_at, granted_by )
```

Symmetric with `treasury_operators`, and it replaces the inference entirely — `getAdminPubkey()`
becomes a lookup, and the SYSTEM bug dies with it.

| | Owner | Admin |
|---|---|---|
| Node settings, moderation, invites | ✅ | ✅ |
| In-protocol override (operate any enterprise, etc.) | ✅ | ✅ |
| Appoint and remove admins | ✅ | ❌ |
| Appoint another owner | ✅ | ❌ |
| Delete the node | ✅ | ❌ |

**More than one owner — yes.** A single owner is a single point of failure for an entire community,
and co-hosted nodes are a real thing. The rules are deliberately minimal:

- any owner may appoint an admin; only an owner may appoint an owner
- **three or more owners:** removing one requires **two others**, through the destructive-action
  grace window from §3.7 — seven days, publicly visible, the target notified
- **exactly two owners:** an owner **cannot** be removed unilaterally. It takes mutual resignation,
  or a community Decision at 66%
- never fewer than one owner; self-resignation always allowed unless you are the last

**The two-owner rule is not pedantry.** Without it, two co-owners who fall out get a race: A clicks
"remove B", and B's only recourse is to click "remove A" faster. Putting the community between two
feuding co-owners is the only resolution that is not a coin toss.

**Be honest about what this table is.** It is a **coordination and attribution record, not a security
boundary.** Anyone with SSH edits it directly with one SQL statement. What it can guarantee is
narrower and still worth having: *as long as the node is running normally, one co-owner cannot
silently disenfranchise another without the community seeing it.* This is the same honesty as §3.8 —
authority over the machine belongs to whoever holds the machine, and the community's real remedy is
the signed fork archive, not a clever table.

**Appointment is not a Decision.** The owner appoints admins unilaterally — it is their machine and
their liability — but every appointment and removal is a **public, visible event** in the Commons
tab. The community's check is the `no_confidence` Decision and the fork, not a veto.

### 9.3 Owner and admin tags

Both roles carry a visible tag next to the member's name in People and the Marketplace. This is the
point of the whole exercise: it turns anonymous password-authority into an attributable person, which
is what §3.7's provenance stamp and §3.8's signed public halt both require. You cannot sign as a
password.

**Two caveats, and the second is a change to what was asked for.**

*First — in the marketplace, a tag next to a name reads as a trust signal, and this is not one.* It
says *runs this node*, not *safe to trade with*. Wherever it appears it must sit **alongside** the
tier badge rather than instead of it, be worded as a role rather than a rank, and be visually
quieter than the tier badge — which is the earned thing. Otherwise you have invented a reputation
shortcut that routes around the entire trust model.

*Second — it should probably **not** appear on marketplace listings at all.* Antigravity raised this
and it is a real objection: publicly flagging the exact human who pays for the server makes that
person the target for every automated ban, every outage and every unpopular moderation call. In a
small, off-grid, counter-cultural community that is not an abstract risk.

**Decided (Marty, 2026-09-14): the People list, and not the marketplace.**

| Surface | Tag? | Why |
|---|---|---|
| People directory | **yes** | "who runs this node" is a fair question that should have a findable answer |
| Member profile | **yes** | you are looking at a *person*; role is the context you want |
| Marketplace listing cards | **no** | you are looking at a *listing*; the only relevant signal is trade reputation |
| Map pins, post authorship, chat | **no** | same reason — keep the badge out of trading surfaces |

One thing that is **not** a badge decision and stays regardless: **decision and moderation records
name the admin who acted.** That is provenance, not a tag — it is the whole point of §9.2, and it
does not appear next to anyone's listings.

This keeps the role visible, findable and attributable — one tap from any listing — while removing
both the false trust signal and the harassment target.

**Not the `SYSTEM` account.** The owner does **not** take over `SYSTEM`. `SYSTEM` is the impersonal
voice of the node — it authors announcements, and "node maintenance tonight" from **Marty** reads
differently from the same words from **System**. Same for the Daily Pulse and BeanPool accounts:
those are enterprises and stay enterprises. What becomes the named owner is the *admin identity*,
which today is inferred and should be explicit.

### 9.4 Should an enterprise be a group?

They overlap more than is comfortable: both have members with roles and a join policy, and "a member
asks to become a keeper" — listed as missing in §2.2 — looks a lot like a group's `request_to_join`.

**No. Keep them completely separate, and do not even link them.** *(This reverses an earlier
suggestion of mine to share the join-request machinery and link an enterprise to a working group.
Antigravity's counter-argument is better than my proposal.)*

- **The lifecycles diverge and the link rots.** If a keeper leaves the working group, are they
  stripped of financial authority? If the group is archived, what happens to the bank account? Every
  answer is either wrong or a rule nobody will remember.
- **The join thresholds are not comparable.** Joining a discussion group is a low-stakes social
  click. Becoming a keeper means pledging your earned standing against collective debt (§2.4 Rule 3).
  Sharing the flow implies a false equivalence between joining a club and becoming a director — and
  the UI would be teaching exactly the wrong thing at exactly the wrong moment.

**The clean boundary:** an enterprise is an *account* (`members.is_treasury = 1`); a group is an
*audience scope*. If the keepers of Community Eggs want a private thread, they create a group called
"Community Eggs Team" like anyone else would. Two objects, no foreign key, nothing to desynchronise.
The "somewhere to discuss it" gap in §2.2 is then filled by groups generally, not by a special case.

### 9.5 Working-style archetypes: a preference, never a label

The archetype quiz says how a member likes to work ("You prefer…, works best when…"). It is not a
role, a rank or an identity, and like a trust tier it gates nothing: no beans, no credit, no pricing,
no listing audience. Two standing refusals, from the decision note on PR #591 (2026-09-17):

- **No public archetype labels anywhere.** No chips or tags on profiles, member lists, listings or the
  map. A member sees their own type. What they see about another member (the Collaboration Chemistry
  card, the outreach message it prefills) carries tips and strengths, never a type name. A "Champion"
  tag next to a name becomes a permanent reputation label in a community nobody can leave.
- **No per-type breakdown of a group or enterprise.** "2 Sparks, 1 Guardian" on a four-person
  enterprise lets anyone who knows two members work out the others. If a composition view is ever
  wanted, the only safe shape is three coarse energies with nothing shown below four members, and it
  needs its own decision first.

Enforcement today is a display rule in both clients, not the server: the member directory still
serves each member's saved result (primary, secondary, mode, date) because the card needs it. The
`posts.target_archetypes` filter from #823 was removed before anything used it; the column is left
in place, unread and unwritten.

---

## 10. Decisions log

Settled with Marty on 2026-09-14. Recorded here so they are not re-litigated.

| | Decision |
|---|---|
| Enterprise leadership | **Lead keeper**, not owner (§2.3) |
| Enterprise credit floor | derived from keepers' earned standing, **plain sum, no multiplier** (§2.4 Rule 2) |
| Backing | an **explicit once-only pledge**, never auto-split, never deducted from the personal floor (Rule 3) |
| On default | **no personal recourse** — freeze the enterprise, not the household (Rule 4) |
| Paying keepers | **only out of profit**, never out of credit (Rule 5) |
| Grants as wages | **no** — capped by earned surplus (Rule 6) |
| Hoarding | surplus above a **working-capital ceiling** sweeps automatically (Rule 7) |
| Rule 7 ceiling sweep | **takes only earned surplus, never grant money** — `sweepable = max(0, min(balance − working_capital_ceiling, earned_surplus))`; grants/pledges/gifts raise balance, not earned surplus, and are never swept |
| Creating an enterprise | **no fee**. The standing gate is enough, and a member at their floor could not pay one |
| Enterprises kept per member | **3** |
| Can an enterprise vote? | **Never.** It is a balance sheet, not a person. Make it deliberate and write it down |
| Opening a Decision | **no bond.** The stick was rejected; the carrot is that participation is **visible on your profile** — in a village, being known as someone who turns up is the real currency |
| Emergency suspension | admin for now, and a new **`moderator`** node role — can action reports and pause someone while their future is decided, nothing else |
| Admins | **must be members** of the node they administer, or they cannot be attributable |
| Quorum | **30% of members active in the last 30 days**, floor of 3. Dormant accounts never count |
| A levy | **do not build it.** Wait until a community has actually run out of pool money and asked |
| Underfunded passed grants | **queue, do not fail** — one at a time, visible, expires at 90 days |
| Admin spending an enterprise's money | **no** — split the permission; admins may administer, not spend (§2.3, `admin-surface.md` §6) |
| Approving your own payment | **no** — two-person rule; a different keeper approves |
| Credit floor while paused | snapshot on pause (`paused_floor_snapshot`, `paused_at`); usable floor is `max(snapshot, derived)` — cannot pull below pause-day floor, earned growth counts, not recomputed downward; expires at **90 days paused** (warn visibly before); clear on resume; keeper exits during pause still release backing per §2.6 (Marty, 2026-09-16, §2.2) |
| Member re-keying across federation | **local atomic transfer; known limitation: peer nodes retain old key** — peer villages do not receive automated key rotation events; trades with other villages will need manual re-linking until cross-node key gossip is built (§10, PR #825) |
| Enterprise map pins | **public, exactly like marketplace post pins** — anyone who opens the node's map sees them; the map routes stay on the public read list. Findability is the point; the picker says so plainly and keeps **Approximate** (~100 m) beside the warning to protect a home. A wound-up enterprise's location is cleared and never served (Marty, 2026-09-17, §2.2) |
| Working-style archetypes | **a preference, never a label** — no public archetype labels anywhere, no per-type breakdown of a group or enterprise, and archetypes gate nothing (2026-09-17, §9.5) |

---

## Appendix — provenance

- **§0** verified against `main` on 2026-09-14: `trust.ts`, `state-engine.ts` (governance ~3120–3345,
  treasury ~1740–1830, `createTreasury` ~2900–2940), `routes/commons.ts`, `routes/treasury.ts`,
  `routes/admin.ts`, `db/schema.sql`, both clients.
- **Enterprise credit model** — Antigravity, `enterprise-credit-model.pdf` (2026-09-09). Adopted with
  two reversals it agreed to: **no multiplier** (its Decision 1 Option C, which is Marty's instinct),
  and **no personal recourse** (cutting its own Rule 4). Extended with the once-only backing pledge
  in §2.4 Rule 3, which is new to this document.
- **Architectural manuals** — `enterprises-and-stewards.pdf`, `keepers-enterprises-commons.pdf`, and
  their repo twins. Findings still reproduce; the recovery-keeper halves are historical.
- **Design argument** — Claude ↔ Antigravity, five rounds, 2026-09-14. Antigravity conceded the
  lightweight-poll split and the hollow-underwriting wording; Claude conceded that exclusive staking
  taxes volunteers and that limited liability is correct. Round 4 settled the execution mechanics:
  Antigravity supplied the auto-expiring quarantine, the funding queue in place of a hard fail, the
  signed public admin halt, and the fork-not-mutiny answer on admin deposition; Claude's
  sort-by-reversibility split and the provenance stamp survived intact. §3.6 (typing Decisions by
  what they touch) came from Marty's observation that the original four types were all
  enterprise-shaped. Round 5 covered node roles: Antigravity supplied the two-owner deadlock rule,
  the break-glass-can-only-enrol-a-key restriction, and the objection to putting an owner tag on
  marketplace listings; it also talked Claude out of linking enterprises to groups. §9 and
  [admin-surface.md](./admin-surface.md) are the result. Full transcript: [the-commons-discussion.md](./the-commons-discussion.md).
- **Supersedes** the primitive sketch in `community-governance.md` §"The model: three primitives".
  Treasury → **Enterprise**, Decision → **Decision + Poll**, Role → **keeper / lead keeper**.
