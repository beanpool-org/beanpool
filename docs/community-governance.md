# Community Governance — Architecture Note

> **Status: DESIGN — not built.** Captures the design conversation of 2026-07-26.
> No code has changed. This is the "what we agreed" reference before an implementation plan.

## Why

Beanpool is evolving from a peer-to-peer trading app into something closer to a **community
operating system**: a community can collectively stand up, fund, staff, and evolve its own shared
enterprises, all visible in one ledger. The primitives it needs — mutual credit, trust from real
trades, quadratic governance, guardian quorum — are ones already built for other reasons, which is
the tell that the foundation was always pointed here.

**First real driver:** Bindarrabi, a remote off-grid intentional community (founder: Doone). They
need fair internal trade, collective management of shared assets, and a way to fund themselves.

**Guiding constraint: complete but simple.** Few components. Complexity is shown only to the people
who need it (a normal member's app must not change).

## The concrete case that grounds it — community eggs

Community-managed chickens produce eggs. First-come-first-served is unfair: it rewards speed and
proximity, not contribution. The fix reframes the problem — a commons with no allocation rule
defaults to the *least* fair rule, so any rule beats it:

- The **Commons becomes an economic actor** that owns the flock.
- It **pays the tenders as real trades** (a posted "need," settled through escrow) so the people
  doing the work earn Beans *and* trust — not a gift, which builds nothing.
- It **sells the weekly dozen at a cost-recovery price** (`(feed + tender wage) ÷ dozens/week`),
  which throttles the grab-race by price, funds the feed, and closes the loop.
- Framed as *"chipping in to keep the flock fed,"* never *"eggs for sale"* — pricing a formerly-free
  thing can corrode the gift ethic in an intentional community, so keep it nominal.

Eggs is the **smallest instance** of the general pattern below, not a special case.

## What we already have (do not rebuild)

- **Governance engine** — `packages/beanpool-core/src/governance.ts`: proposals, quadratic voting
  (`cost = N²`), double-vote protection, vote thresholds, auto-execute-to-escrow on pass; `SYSTEM`
  (draws from Commons) vs `STEWARD` (draws from proposer) origins.
- **Projects** — native tab + `apps/native/app/propose-project.tsx`, PWA `ProjectsPage`; voting
  rounds (`getActiveVotingRound`), governance-credits, funding goals/deadlines. Today: an individual
  proposes → community votes → funds release from the pool. **Individually owned.**
- **Commons fund** — the ledger demurrage pool (`packages/beanpool-core/src/ledger.ts`); synthetic
  wallets (escrow / project / commons) are already **exempt from decay**.
- **Standing score** — `Passport.standing`, gates proposing (`> 50`).

## The model: three primitives

Sitting on the existing substrate (ledger, offers/needs, quadratic voting, standing).

1. **Treasury** — a community-owned account that can earn / hold / spend. The Commons itself, plus
   named sub-treasuries. **An enterprise is a project that persists and trades; a bounded project is
   a treasury that winds down — same object, different lifecycle.** A treasury's balance is its books.
2. **Decision** — generalise the existing proposal so its *effect* is typed: `fund` |
   `appoint`/`remove` | `set` (a parameter) | `poll` (non-binding). This one change absorbs voting on
   projects + any other vote + role grants + deficit authorisation + fund-generation levers. QV and
   voting rounds are unchanged. **Simplifier: only `fund` auto-executes; the rest are recorded and
   made visible, and an admin carries them out — "decisions authorise; humans execute."**
3. **Role** — granted, revocable authority: **administrator** (community-scoped) and **operator**
   (the same, scoped to one treasury). Granted by appointment (bootstrap) or by an `appoint`
   Decision. Ancestors already present: `standing > 50`, `STEWARD` origin.

**Treasury · Decision · Role**, on the existing substrate. The wishlist maps on cleanly:

| Wanted | Primitive |
|---|---|
| community fund | Treasury (the root one) |
| projects / enterprises | Treasury (scoped) |
| offers & needs | already exist — a treasury posts them |
| voting on projects / anything | Decision |
| community administrators | Role |
| governance generates funds | Decision (`set` a levy) + enterprise surplus → Treasury |

## What's genuinely new or changed

- **Community-owned Treasury as an actor** — new (today the commons is a passive balance).
- **Generalise the proposal effect** beyond `fund` — extend `governance.ts`.
- **Explicit, recorded, revocable Role** + a **client-readable "am I a steward/operator?" signal** —
  new; there is no clean client role flag today.
- **A legitimate pass rule** — the one *existing* thing to rethink, not just extend. Today a proposal
  passes on `currentVotes >= votesNeeded` where the *proposer* picks the target. Real governance needs
  a threshold tied to the electorate: majority of votes cast + a minimum turnout.
- **Fee-exemption flag** on a Treasury (half-exists via synthetic-wallet decay exemption) + a
  **grantable credit line** so a treasury can go negative by collective Decision (reuses the
  `grantedCredit` lever), repaid by future treasury income.
- **Transparency surface** — delivered *by the member view of the Commons tab* (see below): treasury
  balances, open decisions, active enterprises. Mostly UI; the thing that makes it *feel* like
  self-government rather than hidden admin config.
- **Fund generation as a lever** — a community-`set` levy rate + enterprise surplus flowing to the
  treasury. Bindarrabi specifically wants to explore this.

## Explicitly NOT building yet

- Auto-executing non-`fund` decisions (a rules engine).
- Per-activity accounting — use **one treasury per enterprise; its balance is its P&L**. Only build
  consolidated reporting when a second/third enterprise exists.
- Delegated / liquid voting.
- Per-household egg caps (price alone is enough to start).
- A separate reversal workflow — get it **free** by making the primitive symmetric: appoint/remove,
  fund/defund, open/close.

## The Commons tab (all users, role-scaled)

The existing **"Projects" bottom-tab slot becomes "Commons"** — the community's civic front door, for
**everyone**, with depth that scales by role. This *transforms* an existing slot rather than adding
one, so the native bar stays at 6 (Market · Map · Chat · People · **Commons** · Ledger) — no width
cost at the 320dp + 1.3× font floor (`fontSize: 10` labels). See
`apps/native/app/(tabs)/_layout.tsx`.

**Every member sees** — the participatory + transparency view (this is where the "transparency
surface" lives; keep it inviting, not a dashboard):

- **Vote** — open decisions/proposals needing them, with their quadratic-voting credit budget (the
  existing `govCreditsBanner`). The one active, time-sensitive thing — lead with it.
- **Projects** — browse active/funded projects; propose one (existing flow).
- **The Commons at a glance** — treasury balance, active enterprises (e.g. 🥚 Community Eggs), what
  was funded lately. Visibility = belonging.

**A steward additionally sees**, in the *same* tab (this is Option B — role-gated depth, not a
separate destination):

- **Operate treasuries** — post offer/need *as* a treasury, release beans, income-vs-cost.
- **Execute decisions** — finalise proposals, action passed polls/appointments.
- **Moderation + community admin** — reports, health-flagged posts, invites, member audit (all moved
  out of Settings).

So it's **one tab, one name, progressive disclosure** — a member's civic surface that quietly deepens
into a steward's console. (Alternatives considered for the steward layer: **A** = a separate
role-gated 7th tab, icon-only — costs bar width; **C** = "Steward mode" from the header — cleanest bar
but buries governance so the tending habit never forms.)

**Naming:** Commons — never "Admin" / "Government." The tab is the *face of the Role primitive*, not a
fourth primitive. **PWA:** the side-nav has room, so the width constraint is native-only.

## Eggs-first build order

1. **Role primitive + client signal** — unblocks the tab and operator actions.
2. **Treasury** — make the Commons an actor + one sub-treasury for eggs; fee-exempt flag; grantable
   credit line.
3. **Steward surface (Option B)** — minimal: operate treasuries + post offers/needs as a treasury.
4. **Eggs live** — recurring egg offer at cost-recovery price; tending posted as a paid need.
5. **Generalise Decision effects** + the legitimate pass rule.
6. **Transparency / Community view** + community-set levy.

Ship eggs as **"project-zero"** (admin-run, no vote) before building the general framework. Extract
the framework from 2–3 real enterprises, not from this document — build it now and you build the
version this conversation *imagined*, which is always slightly wrong.

## Open questions

- Exact pass-rule thresholds — turnout floor? simple majority vs supermajority for money vs polls?
- How an operator authorises a treasury spend — single operator vs N-of-M quorum (the 3-of-N
  guardian machinery is the natural pattern to reuse).
- Is the Commons fee-exempt permanently, or does a community-set levy replace demurrage for it?
