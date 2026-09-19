# Pulse: what a member's connected account publishes

**Decision note.** Rewritten 2026-09-17 against main at 882fd048 (node v1.2.19, app v1.2.33).
Replaces the 2026-09-02 draft, which proposed five things; two were built since, two are dropped,
one stands. Nothing in the "Decision" section is built yet unless it says so.

**Status (2026-09-19):** §2, report and operator removal, is built (#857). §1, the connect picker, and §3,
per-node category policy, are decided but not built; this note is their record until a lane picks them up.

## The problem

When a member connects TikTok or Instagram in the native app, the app fetches their newest posts
(TikTok asks for 20, Instagram returns its default page of about 25) and publishes all of them to
the community feed straight away, under the member's name, without asking which ones. The
"↻ Sync videos" button on the Channels screen does the same again. The member sees "Imported N
recent videos to the community feed" only after it has happened.

That is a consent problem, not a volume problem. The Pulse puts a member's name and face in front
of people who know them. Old, off-topic or embarrassing posts go out with no chance to say no.
The web app is not affected: it has no OAuth connect.

Code: `apps/native/utils/pulse-oauth.ts` (fetch and ingest are one function, `syncChannelVideos`),
`apps/native/app/channels.tsx` (connect and Sync call it, then show the toast).

## What changed since the first draft

- **Retention is now "keep the newest 20 per channel"** (#658), not a 30-day age cutoff. Curated
  items are exempt. So the 20 posts that import are exactly the 20 the node keeps; the old
  "import then vanish" bug is gone. `apps/server/src/engine/pulse-resolver.ts`, `prunePulseItems`.
- **The server caps an ingest batch at 50 items** and the body at 512 KB (#710). The flood vector
  is closed. `apps/server/src/routes/pulse-submit.ts`, `MAX_OAUTH_INGEST_ITEMS`.
- **Operators can add curated channels** under the BeanPool system identity (#660), and a seeded
  curated channel fills a new node's feed. Cold start is no longer a reason to pull a member's
  back catalogue.
- **The node caches thumbnail images** at ingest and serves them itself (#698, #711, #813).
  Video is still never hosted.

## Decision

### 1. A picker on connect and on "Sync videos"

Fetch the posts, show them as a list, tick the newest by default, publish only what is ticked.
One tap still proves the connection works; unticking is the member's choice, made before anything
goes out.

- **No paging past the first 20/25.** Keep-20 would prune anything older on the next tick, so
  offering it would only offer posts the node will not keep.
- **Native only.** Split `syncChannelVideos` into fetch and ingest-selected. The row shape the
  fetch already produces (url, title, thumbnail, date, external id) is what the picker renders,
  and the ingest route already takes an array, so a subset needs no server change. The 50-item cap
  already covers it.
- **Ship after the Instagram review returns.** The Meta review filed 2026-09-04 walks the reviewer
  through connect, Sync videos, see them in The Pulse. Those steps rely on auto-import, and Meta
  allows no withdrawal once in review. Build it when a lane is free, hold the release, then update
  the reviewer steps in the runbook and the portal.

### 2. Node moderation: members report, operators remove

A member can report a Pulse item. A node operator (admin level of `node_roles`) can remove any
member's item. Removal tombstones it the same way the owner's own delete does; the member is not
penalised. **Built:** #857.

Today the only tools are: the owner can hide or delete their own item, the member can disconnect,
the operator can add curated channels. Viewers cannot hide items: the "Hide from feed" action on
a card is owner-only and the feed has no viewer context (`NOT_YOURS` in `pulse-resolver.ts`,
`apps/native/components/PulseFeedCard.tsx`). The first draft said viewers could. They cannot, and
no paragraph sent to a reviewer should say so.

### 3. Per-node category policy

Each node decides what its feed is for. The operator sets the allowed categories, matching how
curated channels are set in #660. A Commons Decision could change it later, once Decisions are
seen to auto-execute in practice. Not built; nothing on main has a node-level category policy.
Do it after the report and takedown work, since it touches the feed query, ingest validation and
settings on both the manager and the native app.

## Dropped, and why

- **Forward-only import (watermark on connect, import nothing historical).** #658 decided the
  opposite on purpose: a quiet creator's old posts are "simply your latest 20", and keep-20 is
  what stops a new node looking empty. It would also show the Instagram reviewer nothing. The
  consent problem it was solving is answered by the picker instead. The building block it named,
  `post_count_seen`, is a nudge counter, not a per-item watermark.
- **A per-member release queue that drips selected old posts over days.** The feed sorts by
  publish date, so old posts land deep in the feed; there is no burst to spread out. Its cold-start
  purpose belongs to the seeded curated channel and the Learn-lane cadence drip
  (`docs/pulse-learn-lane.md` §2.4). And queued items older than a channel's newest 20 would be
  pruned before release.

## What to tell app reviewers

Three defences against "this duplicates TikTok's Nearby feed" hold:

1. Content comes only from members who connected their own account, plus curated channels the
   operator adds.
2. Every item links out to the platform. Cards are facades; there are no embeds.
3. We do not host video. We cache a thumbnail image on the community's own node.

The privacy policy page (`apps/website/privacy.html`) still says image media is never re-hosted
and that retention is 30 days. Both are out of date and are being corrected on
`docs/privacy-policy-matches-code`. Do not point a reviewer at that page until it lands.
