# The Onboarding Gardener — Deterministic Seed Engine

> **Status**: Design — not yet implemented
> **Goal**: Give every new member a real, personal, instant "this app gets me" moment in < 30 seconds, using **real** content only, at **any scale**, with **no live LLM in the runtime path**.
> **Outcome**: The node alone turns a new member's 3 interest tags into a personalised, honest, alive onboarding feed. It runs cold — no agent babysitting each signup — so it works for 1 member or 1 million.

---

## Why this exists

The live global node (2026-10-30): 21 members, 4 posts, **0 beans in circulation, 0 trades this month**. The growth problem is real and it is an **economy + first-30-seconds** problem, not a pure content problem.

The psychology (validated against onboarding literature — Belsky's *lazy, vain, selfish*; Lastres' *"nothing gets asked until the product has already done something useful"*; the cold-start rule *first meaningful action in 30s with a real number that belongs to them*):

1. A new user is **lazy** — they won't fill a profile or post before they get value.
2. A new user is **vain** — they stay if they feel seen, expert, or powerful.
3. A new user is **selfish** — the first screen must give, not take.

The one piece of personal data we already collect cheaply is the **3 interest tags**. The Gardener's entire job is to turn those 3 strings into a real, personalised first feed — automatically, honestly, and offline.

**Design constraint (hard): the engine never fabricates a person, product, or store.** It only assembles *real* content (knowledge the node curates, genuinely time-sensitive data, real member activity already on the node, real supplier/resource data) and *real people* (real, opted-in, active members). Seeding is authoring + instantiation, never invention.

The engine has **two jobs**, both deterministic:
1. **Content** — fill the first screen with real, relevant value (alone, a member is never stuck).
2. **Belonging** — connect real members who naturally fit together (same interest, or complementary skills forming a *crew*). This is what turns "a useful app" into "a village the new member wants to stay in."

---

## Architecture in one line

A finite set of **authored seed modules** × **real-data hooks**, instantiated per user by **pure deterministic rules**. An LLM/agent writes the modules once; the node waters every new member forever, with zero per-user AI compute.

```
   Member answers 3 tags
        │
        ▼
 Stage 0  NORMALISE ── synonyms + fuzzy match ──► ~40–60 canonical categories (each = a SeedModule)
        │
        ▼
 Stage 1  INSTANTIATE ── for each module, fill content-packs from REAL sources
        │                (ACTIVATION·RIPE·KNOWLEDGE·ECHO·MARKET + CONNECT·CREW people-packs)
        │
        ▼
 Stage 2  SCORE & ORDER ── relevance × timeliness × actionability (deterministic)
        │
        ▼
 Stage 3  ASSEMBLE & CACHE ── personal feed = read from cache + assemble, < 50 ms
        │
        ▼
 Stage 4  MCP writer invokes ── "seed for tags X,Y,Z" (write-capable MCP, next update)
```

---

## Stage 0 — Interest normalisation (the "many user types" scaler)

Free-text tags can't scale. One deterministic pass collapses millions of possible strings into a finite ontology.

**Canonical category set** — a curated table of ~40–60 categories (e.g. `sourdough|baking`, `market-garden|permaculture|compost`, `fermenting-preserves`, `foraging-harvest`, `tool-repair|makerspace`, `woodwork`, `beekeeping`, `sewing-textiles`, `service-electrical|plumbing`, `craft-fast|slow`). Each row carries:

| field | example |
|---|---|
| `id` | `market-garden` |
| `aliases` | `gardening`, `garden`, `veg`, `vegetable`, `compost`, `grow` |
| `region_param` | the region column used to parameterise real-data hooks |
| `module_id` | the SeedModule it maps to |

**Resolution rules (in order, all deterministic):**
1. exact alias match
2. lowercase + stem/containment match (`gardener` → `gardening`)
3. tokenised fuzzy word-similarity against aliases (a fixed table, computed once at startup — no live model)
4. no match → `discovery` catch-all module (never errors, never shows empty)

A member's tags resolve to 1–3 modules. Tags that match nothing funnel into `discovery`, which surfaces generic starter content + the "start a pool" founder hook. **The engine handles "a baker, a welder, a forager and 'idk, I cook'" with the same code path.**

---

## Stage 1 — Real-content instantiation

Each `SeedModule` is authored once (by an LLM/agent at authoring time, then frozen). At runtime it fills **seven content-pack types**, each from a REAL source only:

| # | Content-pack | Real source | Example (module: `market-garden`) |
|---|---|---|---|
| **ACTIVATION** | 3–5 step solo checklist, matched to `region_param` | Authored & region-parameterised (once per region) | "1. Test soil pH 2. Sow peas 2w before last frost 3. Mulch beds" |
| **RIPE** | Time-sensitive, genuinely current | Region seasonal/weather table, refreshed by cron | "First frost in 14 days — cover the figs / blackberries peaking this week" |
| **KNOWLEDGE** | A vetted starter guide for the topic | Authored per module, region-parameterised | "Growing in [City]: a 2-min local start guide" |
| **ECHO** | Real existing node content matching the tags | Real member posts, real events, real gaps from `activity_feed`/`posts`/`events` | "Neighbour Sarah is offering seedlings" / a real repair-café event |
| **CONNECT** | **A real, kindred member** who shares ≥1 interest | Real opted-in active member via the skill index (below) | "Roger is also into Technology — say hi" |
| **CREW** | **A real multi-party crew** whose complementary skills could form a project | Real opted-in members across complementary modules (below) | "Electrician + plumber + builder near you could run a Repair Café" |
| **MARKET** | Real anchor/resource listings, only when real data exists | Actual curated suppliers, resources, or real listings | Real local tool-lending resource — **never invented** |

**Why each bucket is "real not fake":**
- `ACTIVATION` / `KNOWLEDGE` → authored content is *content*, not a fabricated person; it is legitimate the moment it is written and region-corrected.
- `RIPE` → clock/weather truth; it cannot be faked because it is true today in this region.
- `ECHO` → genuine occupancy: it makes the node's **real** early members feel seen and gives the new user honest social proof. This is also the anti-ghost-town mechanism.
- `CONNECT` / `CREW` → real people, never invented. A kindred match or crew is only surfaced if real, opted-in, **active** members exist in the index; empty (skip) when none. This is the belonging bridge that turns solo value into a reason to stay.
- `MARKET` → only populated from real data; empty (`skip`) when no real listing exists. **This is the explicit "no fake bakery" guarantee.**

### The `SeedModule` record

```ts
interface SeedModule {
  id: string;                    // canonical category, e.g. 'market-garden'
  title: string;                 // human label, e.g. "Gardening & Market Garden"
  packs: {
    activation: ChecklistPack;   // authored steps, per region
    ripe:        RipePack;       // per region + season, refreshed by cron
    knowledge:   GuidePack;      // authored guide, per region
    echo:        EchoQuery;      // SQL/rule over real node content
    market:      MarketQuery;    // real listings/resource query
  };
}
```

### The `Template` record (the authored unit an LLM writes once)

```ts
interface Template {
  module_id: string;
  region: string;                // 'global' | specific region
  kind: 'activation' | 'knowledge';   // RIPE/MARKET/ECHO come from data, not templates
  body: string;                  // the authored content (page copy, checklist step, guide)
  tags: string[];                // for cross-linking to related modules
}
```

### The `RealDataHook` record (the "real" guarantor)

```ts
interface RealDataHook {
  module_id: string;
  kind: 'ripe' | 'echo' | 'market';   // never authored prose; always a real-data query
  source: string;                // e.g. 'seasonal/table', 'weather/feed', 'activity_feed', 'posts', 'events', 'marketplace_transactions'
  query: string;                 // parameterised SQL / filter, region & tags aware
  ttl_s: number;                 // cache lifetime; how often it refreshes
}
```

---

## Stage 1b — CONNECT & CREW: the belonging engine

Content packs make the app *valuable alone*. The two people-packs make it a *village*. Both are authoritative, purely deterministic joins — no live agent — so they scale identically to the content packs.

### The skill index (the substrate)
Rebuilt by cron from real member signups (cheap relational scan over `member_preferences.interest_tags`, resolved through Stage 0 normalisation):

```sql
-- module -> list of REAL, opted-in, recently-active member pubkeys
CREATE TABLE IF NOT EXISTS skill_index (
  module_id   TEXT NOT NULL,
  member_id   TEXT NOT NULL,
  activity_at TEXT NOT NULL,          -- newest activity; used to prefer active members
  PRIMARY KEY (module_id, member_id)
);
```

Only members who (a) have resolved interest tags, (b) opt in to being discoverable, and (c) have been active within a recency window (e.g. 21 days) appear. **This is the anti-ghost / anti-fake filter — nobody is surfaced unless they are a real, current human.**

### CONNECT — the kindred 1:1 pack
For the new member, their resolved modules are joined against the skill index to find others sharing ≥1 of those same modules.

```sql
SELECT s.member_id, COUNT(*) shared
FROM skill_index s
WHERE s.module_id IN (:myModules)
  AND s.member_id != :me
GROUP BY s.member_id ORDER BY shared DESC, s.activity_at DESC
```

- **Ordering** by shared-interest count, then activity recency (most like me, then most alive).
- **Card copy (authored once):** *"Roger is also into Technology — say hi 👋"* plus the shared tag(s).
- **Action:** one tap opens the existing E2E-encrypted DM with a pre-filled friendly opener ("Saw we're both into Technology on Beanpool!"). Existing components — no new plumbing.
- **Skip** when no kindred match exists; never shows a ghost.

### CREW — the multi-party complementary pack
This is the "electrician + plumber + builder" idea. A curated **archetype table** maps a set of *complementary* modules to a *real community outcome*. The engine finds whether, around the new member, at least one real, active, opted-in member exists in *each* required complementary role.

```yaml
archetypes:
  - id: repair-cafe
    title: "Run a Repair Café together"
    roles:            # each role = a module the crew needs
      - service-electrical
      - service-plumbing
      - service-build|handywoman
    blurb: "You + an electrician, a plumber and a builder nearby = a full Repair Café crew."
    target: enterprise   # surface as a community-enterprise / working-bee suggestion
  - id: community-garden
    title: "Start a community garden"
    roles: [market-garden, tool-repair|makerspace, service-build]
    blurb: "You + a gardener, a tool-repairer and a builder could stand up a community garden."
    target: event
  - id: market-stall-collective
    title: "Open a shared market stall"
    roles: [craft-fast|slow, market-garden, fermenting-preserves]
    blurb: "Pool your produce + craft with two neighbours into one weekend market stall."
    target: enterprise
  # ... ~8–12 curated archetypes, authored once, frozen
```

**Rule (deterministic):**
1. Take the new member's resolved modules.
2. For each archetype, check: does the new member themselves fit **any** of the archetype's roles? (Match = they bring at least one required skill.)
3. For each remaining role in that archetype, is there ≥1 real, opted-in, active member in the skill index? If **all** required roles are covered by real people (the new member counting as one), the archetype is *live*.
4. Assemble a crew card naming the real members who fill each role + the authored `blurb` + a `target` CTA (e.g. **"Start the Repair Café enterprise"** or **"Propose a working bee"**).

- **Never invents a teammate** — every named role is filled by a real member in the index; if even one role is empty, the archetype is skipped (or shown slimmed-down only if enough roles are covered and the empty one can be "invited to join your crew").
- **Multi-party value** is the highest-leverage cold-start move: it gives 2–4 real early members a concrete, pre-curated reason to meet, not just "here are profiles."

### Scoring CONNECT/CREW
```ts
// CONNECT: prefer many shared interests + recency
connectScore = 1.5 × sharedInterestCount + 1.0 × recencyWeight

// CREW: prefer archetypes where the new member is essential (hard-to-fill role)
crewScore = 1.0 × rolesThisMemberFills + 1.5 × coveredRolesCount + 0.5 × (fewer total members needed = easier to stand up)
```

Same deterministic guarantee as Stage 2: tests can assert "tag set X yields exactly these kindred matches and crews."

---

## Stage 2 — Deterministic scoring & ordering

No LLM. A fixed weighted score, computed per assembled content item.

```
score = 1.5 × relevance   (3.0 exact module match, 1.5 synonym, 0.5 discovery fallback)
      + 1.0 × timeliness  (RIPE/ECHO now = 1.0, evergreen KNOWLEDGE = 0.4, static = 0.2)
      + 1.0 × actionability (ACTIVATION 1.0, KNOWLEDGE 0.6, ECHO 0.5, MARKET 0.4)
```

**Guaranteed block order** (this is the "first 30 seconds" contract):
1. **ACTIVATION** — the instant, solo, real win the research demands.
2. **RIPE** — the living pulse that proves the app is alive *today*.
3. **KNOWLEDGE** — the take-away that makes the app feel like an expert.
4. **ECHO** — honest occupancy + makes early members feel seen.
5. **CONNECT** — a real kindred member: "someone like me is here."
6. **CREW** — a real multi-party project the new member could help lead.
7. **MARKET** — real trade/opportunity, only when real data exists.

Fully deterministic → unit-testable, reproducible, safe to roll out, and trivially A/B-able.

---

## Stage 3 — Assembly & caching (the "handles any scale" part)

- All content is **precomputed + cached** per module/region; RIPE/ECHO/MARKET caches refresh on `ttl_s` via **cron** — never per-user.
- The **skill index is rebuilt by cron** (a single relational scan over resolved interest tags), so CONNECT/CREW are also cache reads at request time.
- A member's feed on load = read cache + assemble, **< 50 ms**, zero per-user compute.
- `N` users = `N` cache lookups. No per-user AI, no per-user DB scans.
- Deterministic output is also what makes it safe: tests can assert "tags X,Y,Z produce exactly this feed."

**Interest tags storage** — reuse the existing `member_preferences` KV table (key `interest_tags`, value = JSON array). No new member-facing schema.

---

## Stage 4 — MCP write-path integration

Today the MCP token is **read-only on member content**; a write-capable update is coming. The Gardener is built so the MCP writer only needs to invoke it:

> `gardener.seed(memberPubkey, tags[]) → assembled feed`

The MCP writer never thinks — it calls the engine. This keeps the agent as **authoring tool only** and the node as the always-on runtime. Behind that one call the node does Stages 0–3 deterministically.

---

## Stage 5 — Give to Grow: the contribution & vesting loop

The LEARN seed is a **one-way broadcast** unless the community can add to it. `Give to Grow` closes the loop: members contribute real local knowledge, the node verifies it, and contributors earn **Seeds** that vest and unlock **Pro shop/enterprise features**. The reward is *feature access*, never a sellable token — so the economy is never polluted and there is no farming incentive.

### Two-stream corpus
- **Stream A — AI seed.** The compressed `learn-entries.ts` corpus, authored once, deterministic rotation (see LEARN card design).
- **Stream B — live community.** Approved member contributions stored in normal learn channels, merged into the **same**
  LEARN card. Filters by a member's starred interests/category. A new user sees AI-curated quality *and* proof that
  neighbours contribute — in the one card.

### Contribution pipeline (human + MCP triage)
A drafted LEARN item lands in a moderation queue as `pending` (reuse `requestPost` semantics).
- **Human keeper** reviews → Approve / Reject / Request changes.
- **MCP-controlled moderator** (the write-capable update) triages at scale with *pure rules*: auto-approve high-confidence
  items (allowed category, not a duplicate, contributor in a trusted tier); only edge cases bubble to a human. No agent
  glued to every submit — scales.

### Vesting (the anti-Minds core)
Approval mints **Seeds**, but they unlock on a schedule (e.g. 1 Seed per 30 days the item stays live and gets used/vouched):
- Rewards are **feature access, never cash** → nothing sellable, no farming.
- **Vesting forces return visits** — you must come back to collect; go dark and vesting pauses.
- **Compounding** — multiple live contributions keep earning in the background, so "coming back" always has a reward waiting.

### Pro-tier unlocks (shop/enterprise payoff)
Vested Seeds cross thresholds to unlock Pro shop/enterprise features, mapped to the existing tier ladder:
- **Level 1:** custom shop banner + menu / extra listing slots
- **Level 2:** subscription / booking slots for your enterprise
- **Level 3:** marketplace promo placement / featured-maker position

Each unlock is *earned by giving back* — the exact "keep users returning and giving to Beanpool" outcome — and it feeds
Single-Player value too (the maker is building their own asset).

### Guardrails
- Only **approved + real** contributions count (consistent with the "no fake bakery" stance).
- Contributor unlock weight scales with trust floor (Elder Seeds weigh more than a fresh account) — reuses the vouch/tier system.
- Bad apples get demoted → vesting pauses; keeps the corpus honest.
- Unlocks are **access, not value** — the dual-currency/economy is never polluted by an invented incentive token.
- **Terminology:** the unit is **Seeds** (or "points"), never "credits" — "credits" carries financial baggage that invites
  Minds-style "convert to value" thinking. "Seeds" matches the bean/garden metaphor: vesting is a seed growing over time.

---

## New/changed node surface

**New DB tables** (SQLite, same pattern as existing schema):

```sql
-- The authored module/template library (region-parameterised, frozen at authoring time)
CREATE TABLE IF NOT EXISTS seed_modules (
  id          TEXT PRIMARY KEY,          -- canonical category
  title       TEXT NOT NULL,
  aliases     TEXT NOT NULL DEFAULT '[]',-- JSON array of synonyms
  region      TEXT NOT NULL DEFAULT 'global',
  templates   TEXT NOT NULL DEFAULT '[]',-- JSON array of {kind,body,tags}
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT
);

-- Real-data hook configuration (the "real not fake" guarantor)
CREATE TABLE IF NOT EXISTS seed_real_hooks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  module_id   TEXT NOT NULL REFERENCES seed_modules(id),
  kind        TEXT NOT NULL CHECK (kind IN ('ripe','echo','market')),
  source      TEXT NOT NULL,
  query       TEXT NOT NULL,
  ttl_s       INTEGER NOT NULL DEFAULT 3600
);

-- Belonging engine: who is a real, opted-in, active member per resolved module (rebuilt by cron)
CREATE TABLE IF NOT EXISTS skill_index (
  module_id   TEXT NOT NULL,
  member_id   TEXT NOT NULL,
  activity_at TEXT NOT NULL,
  PRIMARY KEY (module_id, member_id)
);

-- Belonging engine: curated complementary-role archetypes (authored once, frozen)
CREATE TABLE IF NOT EXISTS seed_archetypes (
  id          TEXT PRIMARY KEY,          -- e.g. 'repair-cafe'
  title       TEXT NOT NULL,
  roles       TEXT NOT NULL,             -- JSON array of module ids this crew needs (| = OR of aliases)
  blurb       TEXT NOT NULL,
  target      TEXT NOT NULL,             -- 'enterprise' | 'event' | 'group'
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Give-to-Grow: Seeds ledger (vested contribution points) — never a sellable token
CREATE TABLE IF NOT EXISTS seed_ledger (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id    TEXT NOT NULL,
  source       TEXT NOT NULL,            -- contribution item id / channel
  status       TEXT NOT NULL CHECK (status IN ('pending','vesting','vested')),
  total_seeds  INTEGER NOT NULL DEFAULT 1,
  vested_seeds INTEGER NOT NULL DEFAULT 0,
  vest_period_days INTEGER NOT NULL DEFAULT 30,
  approved_at  TEXT,
  last_tick_at TEXT,
  UNIQUE (member_id, source)
);

-- Pro-tier unlocks earned from vested Seeds (feature access, not value)
CREATE TABLE IF NOT EXISTS seed_tier_unlocks (
  member_id   TEXT NOT NULL,
  tier        INTEGER NOT NULL,          -- 1 | 2 | 3
  unlocked_at TEXT NOT NULL,
  PRIMARY KEY (member_id, tier)
);

-- Resolved per-member feed (cache); invalidated when tags change or caches refresh
CREATE TABLE IF NOT EXISTS seed_feeds (
  public_key  TEXT PRIMARY KEY REFERENCES members(public_key),
  tags        TEXT NOT NULL,
  feed        TEXT NOT NULL,             -- JSON of ordered content-pack refs
  built_at    TEXT NOT NULL
);
```

**New routes** (Koa, alongside existing `routes/`):
- `POST /api/garden/seed` — build/refresh a member's feed from tags (signed member request).
- `GET  /api/garden/feed` — read the member's assembled feed (the client's first post-registration load).
- `GET  /api/garden/connect` — the CONNECT/CREW blobs within the feed (kindred matches + live archetype crews).
- `POST /api/garden/refresh` — admin/keeper: re-run real-data hooks AND rebuild the skill index now.
- `POST /api/garden/reload-templates` — admin: hot-reload the authored module library + archetypes (authoring path).
- `POST /api/garden/contribute` — member submits a LEARN contribution → moderation queue (`pending`).
- `POST /api/garden/decide` — keeper / MCP moderator: approve / reject / request-changes (creates `seed_ledger` rows on approve).
- `POST /api/garden/tick-vests` — cron: advance Vesting for approved contributions (paused for inactive members), check tier thresholds.

**Cron jobs** (node's existing scheduler): refresh `ripe`/`echo`/`market` caches on their `ttl_s`, and rebuild the `skill_index` periodically so CONNECT/CREW stay current.

**Client integration** — the assembled feed is what the new member's home screen renders immediately after the 3-tag prompt. It reuses existing components (activity cards, event cards, marketplace tiles), so no new rendering system.

---

## Phasing

| Phase | Scope | Est |
|---|---|---|
| **G0** | `seed_modules` + normalisation table + `seed_feeds` cache; resolve 3 tags → modules, empty feed assembly | 1–2 days |
| **G1** | Author a first ~10 core modules (with an LLM at authoring time, then frozen) + region-parameterised ACTIVATION/KNOWLEDGE templates | 2–3 days |
| **G2** | RIPE hooks (seasonal table + weather feed) + cron refresh | 1–2 days |
| **G3** | ECHO hooks over real `activity_feed`/`posts`/`events` | 1–2 days |
| **G4** | **CONNECT/CREW**: `skill_index` rebuild + kindred join + archetype table; `/connect` route; crew CTAs (enterprise/event) | 2–3 days |
| **G5** | MARKET hooks (real listings/resources only), scoring/ordering, A/B test | 2–3 days |
| **G6** | MCP write-path invocation (`gardener.seed`), guardrails + tests | 1–2 days |
| **G7** | **Give to Grow**: `seed_ledger` + tiers, contribution route + MCP triage, vesting cron, LEARN card merge | 3–5 days |

**Everything is deterministic from G0** — the system is real, honest, and testable before any data hooks land.

---

## Why this avoids the "incentive/ghost" traps

| Trap | How the Gardener avoids it |
|---|---|
| **Minds-style token farming** | Nothing here pays users; content is REAL value, not a reward for joining. Give-to-Grow Seeds vest into **feature access only** (never a sellable token), so there's nothing to farm |
| **Fake occupancy / fake stores** | MARKET only populated from real data; `skip` when none exists |
| **Fake people / ghost matches** | CONNECT/CREW only surface real, opted-in, recently-active members from the skill index; never invented teammates |
| **Brigading / spam outreach** | Only opted-in members are discoverable; feeds suggest, never auto-send; DM is the safe existing E2E channel |
| **LLM-only runtime (can't scale)** | Agent writes templates once; node instantiates deterministically forever |
| **Empty first screen** | ACTIVATION + RIPE always populate something real, even with 1 member |
| **Nagging / guilt** | No "post an offer" pressure — the feed *gives*, it never *asks* in the first screen |

---

## Open questions

1. **Authoring pipeline** — do we author modules by hand, or via a Jules-style agent (e.g. a new `Gardener` agent with a `.jules/gardener.md` journal like the other 12)? Recommendation: author via agent, freeze in `seed_modules`.
2. **Region source** — which region resolution do nodes use (zip/postcode, `node_config`, manual)? Determines how `region_param` is set.
3. **ECHO privacy** — ECHO surfaces real member content; must respect node privacy/flags (mirror the way `activity_feed` and feed visibility already work).
4. **RIPE data cost** — a weather source introduces an external dependency; acceptable on the node ring, or purely from a static seasonal table first?
5. **Discoverability opt-in** — CONNECT/CREW need a per-member "let others find me" flag. Default ON or OFF? (Recommendation: OFF by default, prompted during onboarding — matches privacy-first posture.)
6. **Crew standing-up UX** — when a CREW card's CTA is tapped, does it (a) pre-seed a community enterprise / working-bee draft naming the real members, or (b) send invite DMs to each member first? Recommendation: (b) invite-first, then auto-create on acceptance, so nobody is added to anything without consent.
7. **Give-to-Grow curation** — who approves Stream-B contributions: always a human keeper, or MCP-rules auto-approve for high-confidence items (allowed category + not a duplicate + trusted tier) with humans on edge cases? Recommendation: MCP rules for scale, human on edge cases — but needs explicit trust-floor defaults.
8. **Seeds nomenclature** — confirm the unit is **Seeds** (or "points"), never "credits". Recommendation: Seeds, to avoid financial baggage and match the bean/garden metaphor.
