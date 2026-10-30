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

**Design constraint (hard): the engine never fabricates a person, product, or store.** It only assembles *real* content (knowledge the node curates, genuinely time-sensitive data, real member activity already on the node, real supplier/resource data). Seeding is authoring + instantiation, never invention.

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
 Stage 1  INSTANTIATE ── for each module, fill 5 content-packs from REAL sources
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

Each `SeedModule` is authored once (by an LLM/agent at authoring time, then frozen). At runtime it fills **five content-pack types**, each from a REAL source only:

| # | Content-pack | Real source | Example (module: `market-garden`) |
|---|---|---|---|
| **ACTIVATION** | 3–5 step solo checklist, matched to `region_param` | Authored & region-parameterised (once per region) | "1. Test soil pH 2. Sow peas 2w before last frost 3. Mulch beds" |
| **RIPE** | Time-sensitive, genuinely current | Region seasonal/weather table, refreshed by cron | "First frost in 14 days — cover the figs / blackberries peaking this week" |
| **KNOWLEDGE** | A vetted starter guide for the topic | Authored per module, region-parameterised | "Growing in [City]: a 2-min local start guide" |
| **ECHO** | Real existing node content matching the tags | Real member posts, real events, real gaps from `activity_feed`/`posts`/`events` | "Neighbour Sarah is offering seedlings" / a real repair-café event |
| **MARKET** | Real anchor/resource listings, only when real data exists | Actual curated suppliers, resources, or real listings | Real local tool-lending resource — **never invented** |

**Why each bucket is "real not fake":**
- `ACTIVATION` / `KNOWLEDGE` → authored content is *content*, not a fabricated person; it is legitimate the moment it is written and region-corrected.
- `RIPE` → clock/weather truth; it cannot be faked because it is true today in this region.
- `ECHO` → genuine occupancy: it makes the node's **real** early members feel seen and gives the new user honest social proof. This is also the anti-ghost-town mechanism.
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
5. **MARKET** — real trade/opportunity, only when real data exists.

Fully deterministic → unit-testable, reproducible, safe to roll out, and trivially A/B-able.

---

## Stage 3 — Assembly & caching (the "handles any scale" part)

- All content is **precomputed + cached** per module/region; RIPE/ECHO/MARKET caches refresh on `ttl_s` via **cron** — never per-user.
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
- `POST /api/garden/refresh` — admin/keeper: re-run real-data hooks now.
- `POST /api/garden/reload-templates` — admin: hot-reload the authored module library (authoring path).

**Cron jobs** (node's existing scheduler): refresh `ripe`/`echo`/`market` caches on their `ttl_s`.

**Client integration** — the assembled feed is what the new member's home screen renders immediately after the 3-tag prompt. It reuses existing components (activity cards, event cards, marketplace tiles), so no new rendering system.

---

## Phasing

| Phase | Scope | Est |
|---|---|---|
| **G0** | `seed_modules` + normalisation table + `seed_feeds` cache; resolve 3 tags → modules, empty feed assembly | 1–2 days |
| **G1** | Author a first ~10 core modules (with an LLM at authoring time, then frozen) + region-parameterised ACTIVATION/KNOWLEDGE templates | 2–3 days |
| **G2** | RIPE hooks (seasonal table + weather feed) + cron refresh | 1–2 days |
| **G3** | ECHO hooks over real `activity_feed`/`posts`/`events` | 1–2 days |
| **G4** | MARKET hooks (real listings/resources only), scoring/ordering, A/B test | 2–3 days |
| **G5** | MCP write-path invocation (`gardener.seed`), guardrails + tests | 1–2 days |

**Everything is deterministic from G0** — the system is real, honest, and testable before any data hooks land.

---

## Why this avoids the "incentive/ghost" traps

| Trap | How the Gardener avoids it |
|---|---|
| **Minds-style token farming** | Nothing here pays users; content is REAL value, not a reward for joining |
| **Fake occupancy / fake stores** | MARKET only populated from real data; `skip` when none exists |
| **LLM-only runtime (can't scale)** | Agent writes templates once; node instantiates deterministically forever |
| **Empty first screen** | ACTIVATION + RIPE always populate something real, even with 1 member |
| **Nagging / guilt** | No "post an offer" pressure — the feed *gives*, it never *asks* in the first screen |

---

## Open questions

1. **Authoring pipeline** — do we author modules by hand, or via a Jules-style agent (e.g. a new `Gardener` agent with a `.jules/gardener.md` journal like the other 12)? Recommendation: author via agent, freeze in `seed_modules`.
2. **Region source** — which region resolution do nodes use (zip/postcode, `node_config`, manual)? Determines how `region_param` is set.
3. **ECHO privacy** — ECHO surfaces real member content; must respect node privacy/flags (mirror the way `activity_feed` and feed visibility already work).
4. **RIPE data cost** — a weather source introduces an external dependency; acceptable on the node ring, or purely from a static seasonal table first?
