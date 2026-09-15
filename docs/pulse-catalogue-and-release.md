# Pulse: back-catalogue import and staged release

**Status: DESIGN ONLY — none of this is built.** Everything below describes proposed
behaviour. The "Today" section is measured from the code as it stands on 2026-09-02;
the "Proposal" sections are not implemented. Do not read this document as a
description of how the app works.

Raised by Marty on 2026-09-02 while preparing the TikTok and Meta App Review
submissions.

---

## The problem

When a member connects a TikTok or Instagram account, the app pulls their recent
posts into the community feed automatically. Two things follow from that:

**A back-catalogue dump.** A member's existing posts land in their neighbours' feed
in one burst, with no say over which ones. Nobody chose to publish them *here*.

**An unfiltered content mix.** The Pulse is a raw feed of whatever members have
posted elsewhere. A community feed will end up with fluffy cat videos sitting beside
material some members would not have chosen to put in front of their neighbours.
That is not a hypothetical — it is the normal consequence of importing someone's
whole recent history without asking.

## Today (measured, not proposed)

| Behaviour | Where | Value |
|---|---|---|
| TikTok fetch cap | `apps/native/utils/pulse-oauth.ts` | `max_count: 20`, single request, **no cursor pagination** |
| Instagram fetch cap | `apps/native/utils/pulse-oauth.ts` | no `limit` param and no paging loop → Instagram's default page (~25) |
| Server-side cap on ingest | `apps/server/src/routes/pulse-submit.ts` | **none** — `rawItems.length` is not bounded |
| Retention | `apps/server/src/engine/pulse-resolver.ts` | `prunePulseItems(maxAgeDays = 30)` tombstones items older than 30 days |
| Website/RSS refresh | `apps/server/src/engine/pulse-resolver.ts` | `startPulseScheduler(intervalMs = 5 * 60 * 1000)` |
| OAuth ingest timing | `apps/native/utils/pulse-oauth.ts` | synchronous — awaited inside the connect flow, inserted in a `db.transaction()`, no queue or pending state |

So a member with 750 videos does **not** get 750 imported; they get the 20 most
recent. Two problems hide behind that reassurance:

**The cap is incidental, not designed.** It is a hardcoded `max_count` with no
pagination. The server accepts whatever array the device sends, so the limit exists
only in the client — a modified client can post any number. That is a flood vector
independent of any curation decision, and it wants a server-side bound regardless of
what we do about the rest of this document.

**Ingest and retention disagree.** Ingest takes the last 20 *regardless of age*;
prune deletes anything older than 30 days. A member connecting with 20 posts spanning
three years sees a burst of old content that then silently disappears on the next
prune. That will read as "the app deleted my video".

## Proposal

Three parts, in descending order of value. The first is worth doing on its own.

### 1. Forward-only by default

On connect, record a watermark and import **nothing** historical. From that moment,
only posts published *after* connecting flow into the feed.

This removes the dump outright, and it matches what people already expect "connect my
account" to mean. Channels already carry a `post_count_seen` watermark to build on.

### 2. A catalogue picker, not an automatic pull

After connect, fetch the member's recent posts and **show them without publishing
anything**, newest first, with the newest item pre-ticked. The member sees their real
videos listed — which proves the integration works immediately — and the default
action is a single tap to publish that one. "Show more" reveals the rest.

Why a picker rather than auto-importing just the latest: the newest video is not
necessarily the one they would have chosen. Auto-publishing it reintroduces exactly
the failure this design exists to prevent, and "it was only one" will not feel better
to the member it happens to.

This is mostly UI work. The data path already exists:

- `syncChannelVideos` already fetches the list and builds `itemsToIngest` as
  `{url, title, thumbnailUrl, publishedAt, externalId}` — already the right shape to
  render a picker row.
- `/api/member/pulse/oauth-ingest` already accepts an **array**, so publishing a
  subset needs no server change.

The work is splitting that function into `fetchCatalogue()` and `ingest(selected)`,
plus the picker screen.

### 3. A release queue

Selected back-catalogue items go into a queue with a release interval rather than
publishing all at once, so a member importing fifteen old posts drips them out over
days instead of flooding the feed.

This reuses machinery that already exists: the Pulse scheduler already wakes every 5
minutes, so a queue needs a release timestamp per item and a check on that tick — not
a new subsystem.

Best use for this is **seeding a new node** whose feed is empty, making a fresh
community look alive over its first weeks. It should be opt-in, not the default path.

### 4. Push the content standard down to the node

Do not try to set a global line on acceptable content. Every community runs its own
node and sets its own rules — that is the premise of the whole project, and it applies
here.

The pieces are largely present: `category` exists on both channels and items,
viewers already have per-item Hide (`/api/member/pulse/items/:id/mute`) and the
category filter chips. What is missing is a **per-node category policy** the operator
can set.

"Cat videos beside radical content" is only a problem if the community has not said
what the feed is *for*. The software's job is to let them express that, not to decide
it for them.

### 5. Reconcile ingest with retention

Either filter by the 30-day window at ingest so we never import what prune will
immediately tombstone, or make per-item retention explicit and visible. The current
mismatch is silently confusing.

## Prior art

Worth being accurate about what is and is not novel here.

**The queue and drip mechanic is well established.** [OneUp](https://www.oneupapp.io/)
posts an entire back catalogue between accounts with a configurable interval to drip
them out over time — essentially proposal 3. [SmarterQueue](https://smarterqueue.com/)
and [Cloud Campaign](https://www.cloudcampaign.com/tools/social-media-scheduling) add
categorised recurring drip campaigns, add-to-top/bottom-of-queue, and evergreen
recycling. There is a mature vocabulary to borrow rather than invent.

One inversion to keep in mind: those tools **push out** to platforms. We **pull in**
and republish locally. The queue mechanic transfers; their UX does not map one-for-one.

**Multi-provider aggregation exists too** — [Juicer.io](https://www.juicer.io/),
[Walls.io](https://walls.io/features/social-media-aggregator) (14+ platforms),
[EmbedSocial](https://embedsocial.com/blog/social-media-aggregator/) — but as *one
brand, many channels, onto their own website*. The Pulse is *many members, one shared
community feed*, which is a different shape.

**Local feeds are not novel either: TikTok shipped one.**
[TikTok Nearby / Local Feed](https://newsroom.tiktok.com/introducing-tiktok-nearby-discover-whats-happening-around-you?lang=en-150)
recommends posts by location to surface local creators and businesses.

What *is* distinctive is none of the plumbing — it is that the feed lives on a node
the community owns. TikTok's Nearby is TikTok deciding what counts as local to you;
the Pulse is an invite-gated group of people who know each other, with the feed on
their own server.

## Consequence for App Review

TikTok's Nearby feature makes this submission-relevant, not just trivia: a "local feed
of TikTok videos" can read to a reviewer as duplicating core platform functionality,
which is a rejection reason.

The defences are all true today and should be stated explicitly in the submission:

- content appears only from members who **connected their own account**;
- we **do not host or replay video** — already stated in the privacy policy;
- every item **links out** to TikTok or Instagram to watch, sending traffic *to* the
  platform.

A moderation story is also worth having ready before the Meta review rather than
after. Even the short version — members choose what they import, node operators set
category policy, viewers can hide and report — is better than being asked cold.

## Open questions

- Does forward-only leave a new node's feed too empty to be worth opening? (Proposal 3
  is the intended answer, but it is unproven.)
- What is the right server-side cap on `rawItems.length`?
- Should the picker page beyond the first 20/25, i.e. do we add cursor pagination we
  currently do not have?
- Who sets per-node category policy — the operator alone, or a Commons decision?
