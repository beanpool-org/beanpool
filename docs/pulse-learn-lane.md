# The Pulse — Learn lane and curated content

> **Status: SPEC / not yet built.** Written 2026-09-07 after diagnosing why the Pulse feed is empty
> on every node. Covers a `learn` category, a genesis-seeded BeanPool channel, a third Pulse lane,
> and cadence injection ("the drip"). Does **not** cover the 30-day intake bug, which is a separate
> defect documented in §1.3 and needs its own fix.

---

## 0. Why this exists

Two problems, one mechanism.

**Education has nowhere to live.** There is no in-app explanation of how BeanPool works. Instructional
videos exist on YouTube and nothing in the app points at them.

**Every new community's Pulse is empty and stays empty.** This is not a hypothesis — it is measured,
and the cause is not what it looks like.

### 0.1 What was measured (2026-09-07)

Starting from "the mullum feed is empty despite my profile listing a YouTube account":

```
GET https://mullum.beanpool.org/api/pulse/feed
  → HTTP 200  {"items":[],"nextCursor":null}          # a healthy, genuine empty
```

The channel is configured correctly. From the public channels endpoint:

```
platform=youtube  supportsAutolist=TRUE  isPrimaryVideo=TRUE  isVerified=false
url=https://www.youtube.com/channel/UC-b27mPemXxYje4VkKF7hgw
```

`/channel/UC…` is one of the channel-shaped forms `canAutolist()` accepts, so it is eligible for
polling, and `listPublicChannels` only returns rows with `syndicate_to_node = 1`, so syndication is
on. The upstream feed works:

```
GET https://www.youtube.com/feeds/videos.xml?channel_id=UC-b27mPemXxYje4VkKF7hgw
  → HTTP 200, 5 entries
```

Running the real resolver against that real channel on a local database:

```
resolveChannel -> {"count":0}
pulse_items written: 0
channel after: {"fail_count":0,"last_error":null}
```

It fetches, parses five items, writes none, reports **success**, and records **no error**.

### 0.2 The cause

[`pulse-resolver.ts`](../apps/server/src/engine/pulse-resolver.ts) drops anything older than 30 days
at intake:

```js
const thirtyDaysAgoMs = Date.now() - (30 * 24 * 60 * 60 * 1000);
for (const item of parsed.items) {
    const pubMs = Date.parse(item.publishedAt);
    if (!isNaN(pubMs) && pubMs < thirtyDaysAgoMs) continue;   // ← every item dies here
```

The five videos are **33–36 days old**. They missed the window by three days.

| Video | Published | Age at diagnosis |
|---|---|---|
| The BeanPool Economy | 2026-08-01 | 36 days |
| The BeanPool Blueprint | 2026-08-01 | 36 days |
| Federation Connector | 2026-08-04 | 33 days |
| BeanPool UX Redesign | 2026-08-04 | 33 days |
| BeanPool – The Neighborhood Economy | 2026-08-04 | 33 days |

### 0.3 How widespread

Across the whole fleet, **not one item has ever entered via the autolist path**:

```
test.beanpool.org:  4 items — all platform=instagram, all source=oauth
mullum:             0 items
```

Everything that exists arrived through the Instagram OAuth push. The RSS/scheduler route — the one
most creators would use — has produced nothing, anywhere, ever.

This is the **built-but-unreachable** pattern the code itself warns about, in
[`https-server.ts`](../apps/server/src/https-server.ts):

> *"an unstarted scheduler means channels resolve never and the feed stays permanently empty, which
> is exactly the built-but-unreachable trap."*

The scheduler is wired and on by default. The intake filter defeats it anyway.

### 0.4 Why curated content is the right fix for the cold start

Even with the intake bug fixed, **a brand-new community's Pulse is empty on day one** and stays empty
until a member posts something recent. That is the worst possible first impression for a feature whose
entire job is making a place feel inhabited. Seeded evergreen content fixes education and cold start
with one mechanism.

---

## 1. Constraints discovered

These are load-bearing. Anything built here has to satisfy them.

### 1.1 Curated items need a real member and a real channel

The feed query joins both and filters on member status:

```sql
FROM pulse_items i
JOIN creator_channels c ON c.id = i.channel_id
JOIN members m ON m.public_key = i.owner_pubkey
WHERE c.deleted_at IS NULL AND c.syndicate_to_node = 1
  AND i.deleted_at IS NULL AND i.muted = 0
  AND m.status = 'active'
```

So curated items cannot be free-floating rows. They need an **active member** to own them and a
**channel** to hang off. This forces the attribution decision rather than leaving it open: the feed
renders a callsign and avatar per card, so those videos will visibly belong to *someone*.

**Decision: a `BeanPool` system member + channel, seeded at genesis on every node.** Not the admin's
personal account — official content should not look like one person's posts. There is precedent for
synthetic members: treasuries are members so they can trade.

### 1.2 Pagination is keyset, not offset

```js
ORDER BY ${FEED_SORT_KEY} DESC, i.id DESC
// cursor = `${published_at}|${id}`
```

The cursor is a **position in the chronological stream**, not an index. It carries no count, so
"every 15th slot" is not something the query knows on its own. §2.4 handles this without changing the
cursor format.

### 1.3 The 30-day pruner has no exemptions

```sql
UPDATE pulse_items SET deleted_at = ?, url = NULL, title = NULL, thumbnail_url = NULL
 WHERE deleted_at IS NULL AND published_at < ?
```

No `source` check, no pinned flag. **The obvious workaround today — add a channel and manually submit
the videos — works for exactly 30 days and then tombstones itself.** Manual items get
`published_at = submission time`, so they would look correct and vanish a month later, which is worse
than never having them.

### 1.4 The Pulse lanes are a client-side split

[`pulse.tsx`](../apps/native/app/%28tabs%29/pulse.tsx) already carries the caveat:

```js
// should pass the lane to the API so pagination stays correct per lane
const [lane, setLane] = useState<'neighbours' | 'local'>('neighbours');
```

Both lanes carve up **one fetched page**, so per-lane pagination is already subtly wrong. A third lane
built the same way inherits the bug and competes for the same page budget.

### 1.5 The lane bar hides when empty

```jsx
{localLaneAvailable && (
```

Lanes only appear once they have content. A Learn lane seeded on every node **always** has content, so
the lane bar becomes permanent furniture instead of something that appears as a community gets busy.
That is a deliberate change to the quiet-community experience — arguably a good one, since it tells a
brand-new member there is something to read, but it should be chosen, not stumbled into.

### 1.6 The feed has no viewer context

`getPulseFeed()` takes no actor. The feed is **identical for every member**. Anything per-viewer —
"hide ones I've watched", per-user rotation — is out of scope without a larger change.

---

## 2. Design

### 2.1 A `learn` category

Add to the taxonomy in both places it is declared —
[`packages/beanpool-core/src/channels.ts`](../packages/beanpool-core/src/channels.ts) and
[`creator-channels.ts`](../apps/server/src/engine/creator-channels.ts):

```ts
export type ChannelCategory =
    'community' | 'food' | 'craft' | 'business' | 'repair' | 'art' | 'learn' | 'other';
```

with `{ id: 'learn', icon: '📚', label: 'How it works' }` in the core label map.

This alone gives a filterable home: `GET /api/pulse/feed?category=learn` already works.

### 2.2 A genesis-seeded BeanPool channel

At genesis, alongside the Commons pool account, seed:

- a member `BeanPool` with `status = 'active'` and a distinct avatar
- one `creator_channels` row owned by it, `platform = 'youtube'`, `category = 'learn'`,
  `syndicate_to_node = 1`, `supports_autolist = 0` (its items are curated, not polled)
- the instructional videos as `pulse_items` with `source = 'curated'` and `curated = 1`

Seeding at genesis rather than fetching means **it works on a node with no internet**, and every new
community is non-empty from its first boot.

### 2.3 Curated items never expire

Add `curated INTEGER NOT NULL DEFAULT 0` to `pulse_items`, and one clause to the pruner:

```sql
WHERE deleted_at IS NULL AND published_at < ? AND curated = 0
```

### 2.4 The drip — cadence injection

Curated items appear in the **Neighbours** lane at most once every `N` posts (default **15**).

- Empty community → every slot is curated → the feed *is* the BeanPool videos
- One real post → they space out
- Fifteen real posts → one video between them

It self-balances: a quiet community sees them often, a busy one rarely, and nobody tunes anything.

**Making it work with keyset pagination.** The cursor carries no count, so derive the global index
with a `COUNT(*)` over the same filters for everything newer than the cursor:

```sql
SELECT COUNT(*) FROM pulse_items i JOIN ... WHERE <same conditions> AND ${FEED_SORT_KEY} >= ?
```

Injection positions are then pure arithmetic on that index — identical on every request, so pagination
cannot double up or skip. One cheap extra query per page, and **no cursor format change**.

**Which item lands in slot k:** rotate deterministically, `curated[(k / N) % curatedCount]`, so the
catalogue is walked in order with no repeats.

**Cap the cycle.** Stop injecting after one full pass through the catalogue. At 1-in-15 a 200-post
scroll would otherwise hit ~13 injections and start repeating; house content that repeats reads as
spam.

### 2.5 The Learn lane

A third lane beside Neighbours and Local:

```js
{ id: 'learn', label: 'Learn', icon: '📚', count: learnItems.length }
```

**Fetched server-side** via `?category=learn`, not carved out of the client-side list — see §1.4. That
makes Learn correct from the start and sets the pattern for fixing the other two lanes later.

### 2.6 An entry point from onboarding

Filtering only helps someone who already knows to look. One entry — from the onboarding flow, or the
Settings "How BeanPool works" row — deep-linking to Pulse on the Learn lane. This is the piece that
turns a findable thing into a found thing.

---

## 3. Rejected alternatives

**A top-level tab.** The tab bar is already at its compact threshold: `width / tabs < 58` means six
tabs at 320dp is `53.3` — already compact, 9pt with `adjustsFontSizeToFit`. A seventh gives `45.7`.
Beyond the width, a tab is permanent real estate spent on something each person needs once.

**Pinning curated items to the top.** Always-first means the same videos greet everyone forever and go
stale fast. The drip gives durable presence without permanent prominence.

**A category chip alone.** Cheapest option, but buried among eight chips it is discoverable only by
someone already looking. The lane earns its place.

**Widening the intake window to admit old items.** Does not work on its own — the pruner deletes at 30
days, so anything older is ingested and immediately tombstoned. Intake and retention have to move
together, which is why it is a separate piece of work (§5).

---

## 4. Build order

Three small PRs, each reviewable alone.

1. **`learn` category + genesis-seeded BeanPool channel + `curated` column + pruner exemption.**
   Delivers the filterable home and makes every new node non-empty on day one. Server + core only.
2. **The Learn lane** in `pulse.tsx`, server-filtered. Client only.
3. **The drip** — cadence injection in `getPulseFeed`, plus the onboarding entry point.

## 5. Explicitly out of scope

- **The 30-day intake bug (§0.2).** Real, separate, and needs its own decision: seed the latest *N*
  items regardless of age on a channel's first resolve, and/or surface `last_error` when items parsed
  but were all filtered by age — currently that case reports success and says nothing.
- **Author spreading across the feed.** Within a page it is a cheap greedy reorder (take the cursor
  from the chronologically-last item, not the display-last). *Across* pages it is incompatible with
  keyset pagination and would mean a materialised feed ordering — a re-architecture, not a change.
- **Per-viewer state.** See §1.6.
- **Fixing the existing lanes' client-side split (§1.4).** Learn should be built correctly; migrating
  Neighbours and Local is follow-up work.
