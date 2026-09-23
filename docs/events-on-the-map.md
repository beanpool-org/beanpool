# Events — design note

Decisions made with Marty on 2026-09-17 and 2026-09-18 (32 of them, logged in
`scratch/events-design/decisions.md`), turned into a buildable design and checked against the code on `main`
at v1.2.19 (#857). The last nine answer the questions the first version of this note asked; they are folded
into the body below and listed in §6. This replaces the 2026-09-01 research draft, which proposed a separate
table, a blurred pin with host approval, and delta-sync federation; each of those was overtaken by
polls-as-a-post-type, the public enterprise pin with Approximate (#844), and the listings pull. The old text
is in this branch's history.

Status (2026-09-19): **slices 1–6 are built and merged**: server #866, PWA #870, native #869, chat #871,
notifications and copy #878, moderation and 30-day scrub #883; then edit/reopen and QA fixes #900 and address
search #901. **Slice 7 (native map layer) is built too**: #888 added event pins to the native map, drawn in
`map.tsx` itself rather than through `UnifiedMapPin`, and #900 refined them (calendar glyph, never clustered). The two
"later" slices are not scheduled. The text below is the design as decided; where a built PR differs, the PR wins.

**Reminders, "Your events", Share and Add to calendar (2026-09-23).** Damo asked for favourites, reminders,
Share and saved events under "★ For you"; Marty chose all four, with reminders each person can set. Interested
stays the favourite. The server half — `GET /api/events/mine`, `PUT /api/events/:postId/reminder`, the
Settings default, the schema and the delivery sweep — is §2.1, §2.2 and §2.4 below. Share and Add to calendar
are client-only and have no API.

---

## 1. What events are for, and what v1 is

An event is a community gathering with a time and a place: a working bee, a repair café, a skill-share, a
meeting. It is free. The point is people showing up. Today the only way to announce one is a chat message or
an offer with a date typed into the description.

**What.** One post of a new type `event` with title, description, photo, a start time, an end time
(optional; defaults to start + 2 hours), a map pin (required) plus a place name, and a **private note** shown
only to people who tapped Going (gate code, parking, what to bring). No capacity limit. No Beans: paying
helpers stays an enterprise Need with escrow, and an event may link to one. One-off only, with **Copy to a
new date**; no repeat rules.

**Who.** Any member creates one. Tiers gate nothing. An enterprise hosts through a keeper, a group through
a convenor, exactly as enterprise-authored and group-only posts work today. Every keeper of that enterprise,
and every active convenor of that group, is a host with full host rights; not only the member who posted it.
The card shows the host name.

**Where it shows.** In the Market feed as a card, like polls. On the map as a pin with **Today / This
weekend / Next 7 days** chips. Not in the Pulse and not on a host page in v1. The pin is exact by default with
**Approximate (~100 m)** one tap away and the same plain warning enterprise pins use. Audience is this
community (default) or group-only. Sharing to linked communities is not in v1: reach is forced to `local`
the way polls force it, until the federation listings pull carries event fields (§2.4).

**RSVP.** Going or Interested, one tap, no host approval. The card shows the two counts and my status; the
host sees the list.

**Chat.** Every event gets a chat. Members are the host plus everyone marked Going; switching to Interested
or Not going removes you. The private note is pinned at the top. The host can remove messages, like a keeper
in an enterprise thread. It is stored node-readable like the enterprise thread, not end-to-end like DMs, and
the screen says so in one line. Read-only when the event ends; gone with the event after 30 days.

**Lifecycle.** The host may edit everything, RSVPs or not. Cancel, or a change of time or place, pushes a
notification to everyone marked Going (not Interested) and the card shows CANCELLED or UPDATED; other edits
are silent. Notifications go out on the existing Marketplace push category. When the event ends it drops off
the map and feed; host and attendees can still open it for 30 days; then it is scrubbed: RSVPs, chat and the
private note are deleted and the post row stays, inactive, as every other post does.

**Limits.** The existing report → admin removal flow, plus a cap of 5 upcoming events per author, checked
at create like the poll limit; each enterprise and each group is its own author, separate from the member
posting for it. No far-future limit.

**Rollout.** Server, phone app and web ship together in one release; nodes deploy after the app is in the
store. Events are opt-in on the list route, so apps already in the store never receive one (§2.6). Step 1 is
events in the phone feed plus the web map. Step 2, its own PR, opens the protected native map files for the
pin and chips.

---

## 2. How it works, in the code

### 2.1 Data

**The post.** `posts.type` gains `'event'` next to `'offer' | 'need' | 'poll'`
(`apps/server/src/engine/posts.ts:101`, `packages/beanpool-engine/src/posts.ts:34`). New columns, added the
way the poll columns were (`apps/server/src/db/db.ts:357-358`: `ALTER TABLE ... ADD COLUMN` in a try, before
`schema.sql` runs):

| column | type | meaning |
|---|---|---|
| `event_start_at` | DATETIME | ISO UTC; rendered in the phone's local time |
| `event_end_at` | DATETIME | ISO UTC; drives auto-hide and read-only chat |
| `event_place_name` | TEXT | "The old bowls club" — the pin is `lat`/`lng`, which posts already have |
| `event_private_note` | TEXT | shown only to Going and the host; never in a public listing |
| `event_state` | TEXT | `'scheduled' \| 'updated' \| 'cancelled'`; what the card badge shows |
| `event_conversation_id` | TEXT | the chat, see below |

Everything else an event needs is already on `posts`: `title`, `description`, photos via `post_photos`,
`lat`/`lng` with the range check, `audience_scope` / `target_group_id` for group-only, `reach` /
`reach_peers`, `author_pubkey` + `created_by` for enterprise authoring, `search_keywords` and the
`posts_fts` triggers, `status` and `active` for the lifecycle, `updated_at` for sync. Polls prove this shape:
a non-trade, time-bound post with its own join table (`schema.sql:133-183`).

**RSVPs.** A small table on the `poll_votes` pattern (`schema.sql`, `poll_votes`: post id, voter, option,
signature, created_at, primary key on post + voter):

```sql
CREATE TABLE IF NOT EXISTS event_rsvps (
    post_id     TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    member_pubkey TEXT NOT NULL REFERENCES members(public_key) ON DELETE CASCADE,
    status      TEXT NOT NULL CHECK (status IN ('going', 'interested')),
    signature   TEXT NOT NULL,
    updated_at  DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (post_id, member_pubkey)
);
```

"Not going" is a delete, not a third value. `updated_at` rather than `created_at` because an RSVP changes,
unlike a vote, and the sync import is last-write-wins on that column.

**Reminders** (2026-09-23) add one nullable column to that table and one small table beside it:

```sql
ALTER TABLE event_rsvps ADD COLUMN reminder_offsets TEXT;   -- JSON minutes-before-start, NULL = my default

CREATE TABLE IF NOT EXISTS event_reminders_sent (
    post_id       TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    member_pubkey TEXT NOT NULL REFERENCES members(public_key) ON DELETE CASCADE,
    offset_min    INTEGER NOT NULL,
    sent_at       DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (post_id, member_pubkey, offset_min)
);
```

`reminder_offsets` lives ON THE RSVP because it is meaningless without one: it is created with the RSVP,
withdrawn with it, and travels with it. `NULL` means "my Settings default applies" and `'[]'` means none —
the distinction matters, and is why the column is nullable rather than defaulting to `'[]'`. The ALTER sits
with the other event columns in `db.ts`, above the `schema.sql` exec, because `schema.sql` indexes
`event_rsvps`.

The member's own default is one row in `member_preferences` under `event_reminder_offsets`, beside
`holiday_mode` and the `notify_*` toggles, holding the same JSON. Everyone starts at `[1440]` — the day
before — without a row being written for them, so an upgrade needs no backfill.

`event_reminders_sent` is a delivery log, not member data: see §2.2 for what it is for and §2.4 for why it
does not replicate.

**The chat.** One row in `conversations` with a new `type = 'event_thread'`, created with the post, id equal
to the post id, mirroring `ensureEnterpriseThread` (`apps/server/src/engine/enterprise-thread.ts:41-58`,
which uses the enterprise pubkey as the conversation id). Messages go in `messages` as the enterprise thread
stores them: base64 text with `nonce = 'plaintext-v1'` (`enterprise-thread.ts:175`), not the XChaCha20 DM
scheme that binds ciphertext to a fixed participant set (`apps/server/src/engine/messaging.ts:126-133`). That
is the only way membership can follow RSVPs and a host can remove a message the server can read. It also means
the node operator can read event chat, which is accepted for v1; the chat screen carries a one-line notice.
Membership is written to `conversation_participants` in step with `event_rsvps` (§2.2) so the chat appears in
the Talk list with unread counts, and the read and post handlers re-check the RSVP anyway.

**The private note** lives on the post row and is served by `rowToPost` only when the viewer is the host or
has a `going` RSVP; every other reader gets the field omitted, including guests and the listings pull. It is
also injected as the first, pinned item of the chat view by the client, not stored as a message, so an edit to
the note never leaves a stale copy.

### 2.2 Server rules

**Create** goes through `createPost` (`posts.ts:101`) with a `type === 'event'` branch beside the poll branch
(`posts.ts:190-232`):

- Validate: `event_start_at` in the future; `event_end_at` optional, set to start + 2 hours when omitted, and
  must be after the start when given; `lat`/`lng` present, place name ≤ 80 chars, private note ≤ 1000 chars.
  Photos validated by `validatePostPhotos` as for offers.
- Force what polls force: `credits = 0`, `price_type = 'fixed'`, `repeatable = 0`, `cash_also_needed = 0`,
  `category = 'community'`, and `reach = 'local'` (`posts.ts:229`; see §2.4). Unlike polls, keep `lat`/`lng`
  and photos.
- The **upcoming cap** runs inside the same transaction the poll rate limit uses (`posts.ts:243-251`):
  count `type = 'event' AND status = 'active'` for the same author; refuse at 5. A member's own events count
  against their pubkey, an enterprise's against the enterprise's pubkey (`author_pubkey`), a group's against
  the group (`audience_scope = 'group' AND target_group_id = ?`); the three pools are separate.
- Create the `event_thread` conversation and add the author (or, for an enterprise, the acting keeper from
  `created_by`) as the first participant.
- No offer-first rule: `CONTRIBUTION_REQUIRED_ERROR` applies to needs only (`posts.ts:239`).

**Host.** A member or a group convenor hosts through `POST /api/marketplace/posts`, which posts as the signer
and nobody else. An enterprise hosts through its OWN route, `POST /api/treasury/:treasury/event`, beside the
enterprise's Offer and Need: the enterprise is in the URL PATH, keepership is checked there, and the event is
recorded with the enterprise as `author_pubkey` and the acting keeper as `created_by` (2026-09-23). Naming the
enterprise in the body as `authorPublicKey` cannot work and never could — the signature middleware pins every
body field ending in `pubkey`/`publickey` to the signer, so it answered "Signature validation failed" before
the route ran, and the marketplace route now refuses it outright with a 403 that names the right route. Both
routes build the event through one shared function (`apps/server/src/routes/event-post.ts`), so validation and
storage cannot drift. Group hosting is `audienceScope: 'group'` +
`targetGroupId`, as the native group-post screen sends it (`apps/native/app/group-post.tsx:224-225`), with
the convenor-or-member check at `posts.ts:139-149`. "Host" for every host-only action below means: the author,
any keeper of an enterprise author, or an active convenor of the target group. That is the same set
`removePost` already trusts (`posts.ts:299-320`).

**Edit** goes through `updatePost` (`posts.ts:361`). Polls lock the question after votes; events do not lock.
If `event_start_at`, `event_end_at`, `lat`/`lng` or the place name change, set `event_state = 'updated'` and
notify Going. Title, description, photo and note changes are silent. Editing a cancelled or ended event is
refused.

**Cancel** is host-only: `event_state = 'cancelled'`, `active = 0`, `status = 'cancelled'`, notify Going,
chat read-only. Same broadcast `post_removed` the existing remove path sends (`posts.ts:339`).

**RSVP** is a new route `POST /api/marketplace/posts/:id/rsvp` beside `/vote`, calling an `rsvpEvent`
function modelled on `votePoll` (`posts.ts:530-624`): active member, event active and not ended, group-only
events require group membership (the same check as `posts.ts:555-561`), body `{ status: 'going' |
'interested' | null }`. Upsert or delete the `event_rsvps` row; touch `posts.updated_at` so delta sync
carries it (as `votePoll` does at `posts.ts:606-611`); then mirror membership: `going` inserts a
`conversation_participants` row, anything else deletes it. The host never leaves the chat.

**Auto-hide at end.** Not a sweep. The feed and map queries in `getPosts` (`packages/beanpool-engine/src/posts.ts:293-307`)
add `AND NOT (p.type = 'event' AND p.event_end_at <= now)` for the normal view, and the poll-style
exception lets the host and RSVPd members fetch an ended event by id for 30 days. Polls are swept lazily only
when someone creates a poll (`posts.ts:190`); events avoid the sweep entirely.

**30-day removal** is one job in the existing pulse scheduler tick (`apps/server/src/engine/pulse-resolver.ts:1962`),
next to `prunePulseItems`: for events with `event_end_at` older than 30 days, delete `event_rsvps`, delete the
chat's `messages` and `conversation_participants`, null `event_private_note`, and set `active = 0`,
`status = 'completed'`. The post row stays, as every other post does (posts are never hard-deleted and carry
no tombstones; `writeTombstone` is used for conversations, members, projects and friends only). The row is
what keeps a replica consistent.

**Notifications** use `dispatchPushNotification` (`apps/server/src/state-engine.ts:6245`). Recipients are
`going` RSVPs minus the actor. Payload `{ screen: 'post', postId }`, which the phone already routes to
`/post/:id` (`apps/native/services/push-notifications.ts:186-188`). Category `'marketplace'` in v1: every
app in the store has that Android channel and the `notify_marketplace` preference
(`push-notifications.ts:111`, `state-engine.ts:6257`), so no phone needs an update to hear about a
cancellation. A dedicated Events channel and preference is a later slice, after the release that adds it to
the client.

**Reminders** (2026-09-23; board: "all four, with reminders each person can set"). Interested stays the
favourite, and everyone who is Going or Interested is reminded before the event. Which reminders is each
member's own choice: a default in Settings → Notifications, and an optional per-event override.

- Offsets are minutes before the start, from exactly `{10080, 1440, 120, 60, 30}` — a week, a day, two
  hours, an hour, half an hour. A closed set, validated server-side, so there is nothing to sanitise
  downstream. The default for everyone is `[1440]`; `[]` is off.
- **Routes** (`routes/events.ts`), both signed, both taking the member from `ctx.state.actor` and never from
  the body — the same rule the RSVP route keeps:
  - `GET /api/events/mine` — "Your events": the signer's own RSVPs on upcoming, not-cancelled events,
    soonest first, as `{ postId, title, startAt, endAt, placeName, rsvp, photo, reminderOffsets }`.
    `reminderOffsets: null` means "my default applies"; `photo` is the same versioned URL the event card
    resolves.
  - `PUT /api/events/:postId/reminder` `{ offsets: number[] | null }` — allowed only on an event the signer
    has an RSVP on (403 otherwise, because whether the event exists is not a secret); an offset outside the
    five is a 400. `null` returns the event to the member's default.
  - The Settings default rides on the existing member preferences (`GET`/`POST /api/members/preferences`),
    which gain `eventReminderOffsets: number[]`. A rejected value refuses the WHOLE write rather than saving
    the other toggles and dropping it.
- **Delivery** is a sweep in the existing 60-second primary-only tick in `initStateEngine`, beside
  `tickDecisions` — `engine/event-reminders.ts`. Primary only, like every other background job with a side
  effect in the world: a backup holds the same RSVPs and the same push tokens, and would double every
  reminder. A reminder for (event, member, offset) is due when its moment, `event_start_at - offset`, is
  behind us AND was still ahead when that member RSVPed or chose it (`event_rsvps.updated_at`, which both
  bump) AND is no more than **15 minutes** behind. That window is what makes a reminder timely or unsent,
  never late: a start pulled forward drops several moments into the past at once, and "starts in a week"
  about an event on Thursday is worse than silence. It is also the whole tolerance for a node that was
  restarting when the minute came round.
- **Never twice:** the sweep CLAIMS a due reminder with `INSERT OR IGNORE` into `event_reminders_sent` and
  sends only if the insert won. Restart, overlapping tick, or a host moving the time back and forth — all
  land on a key that is already there. The mark is written even when the dispatcher then drops the member
  for having Marketplace notifications off, so turning them on an hour later does not release a stale
  reminder.
- Push goes out on the same `marketplace` category and `{ screen: 'post', postId }` payload as the change
  and cancel notifications, titled `📅 <title>` with a body of "Starts tomorrow at 10:00" or "Starts in 2
  hours". The clock is the node's: a node serves one locality.
- A cancelled event, an ended event and a withdrawn RSVP all drop out of the sweep's join, which is the
  whole of "never for a cancelled or ended event, or a removed RSVP". The 30-day scrub deletes an event's
  sent marks with its RSVPs.
- **Share and Add to calendar are client-only** and have no API. Share gives the title, date, place and the
  event's link; a non-member lands on the community's join page. Calendar is a conformant `.ics` on the web
  and the system calendar hand-off on the phone, with no new native module.

**Chat rules** reuse the enterprise-thread functions with an event flavour: post requires an RSVP of
`going` or host, 2000-char cap and the frozen-member block as at `enterprise-thread.ts:121-140`; read requires
the same (unlike the enterprise thread, whose read route is unauthenticated, `routes/treasury.ts:1400`); no
edits, as `messaging.ts:276` already refuses for threads; no push per message, as `messaging.ts:183` already
skips for threads. Read-only once `event_end_at` passes or the event is cancelled, refused with the same shape
as `enterprise-thread.ts:135`. Host removal marks the row `type = 'removed'` and replaces the text with
"removed by the host" (`enterprise-thread.ts:213-250`).

### 2.3 Privacy

- **Private note:** host and `going` only, enforced in `rowToPost`, never in the listings pull, never to
  guests. It is where the gate code and exact meeting spot belong.
- **Pin:** public like every post pin and every enterprise pin. Approximate is a client-side rounding to three
  decimals (`packages/beanpool-core/src/geo.ts:9`; PWA `EnterpriseLocationPicker.tsx:124-131`) applied before
  the coordinates are sent; the server stores what it gets. The event form reuses that picker and its warning
  text.
- **Audience:** `getPosts` already hides group-only posts from non-members and direct posts from third parties
  (`packages/beanpool-engine/src/posts.ts:323-353`). An event inherits that. A group-only event's chat is
  group-members-only by construction because only they can RSVP.
- **Guests** (a PWA viewer with no identity) see public events and the pin, never counts by name, never the
  note, and cannot RSVP; every write is a signed request (`apps/native/utils/crypto.ts:217-220`).
- **RSVP list:** host sees names; everyone else sees counts. Attendees in the chat see each other's callsigns,
  which they expect.

### 2.4 Sync and federation

**Delta sync** (backup and mirror replication) copies whole tables. `posts` and `poll_votes` are already
exported (`packages/beanpool-engine/src/sync.ts:337, 586`) and imported (`apps/server/src/engine/sync.ts:845`).
Registering `event_rsvps` means the same sites: export, import (last-write-wins on `updated_at`),
`MAX_IMPORT_ROWS_PER_CATEGORY` (`sync.ts:292`), `clearReplicatedTables`
(`apps/server/src/state-engine.ts:6107`), `getStateHash` (`packages/beanpool-engine/src/sync.ts:283`), and the
replica consistency audit. The chat rows ride on `conversations` / `messages`, which replicate already. A backup
replica therefore holds the private note and RSVPs, as it holds every DM ciphertext today; that is the backup
model, not a leak.

`reminder_offsets` **replicates with the RSVP it sits on**, because it is part of that row and because a
member restored from a backup should still have the reminders they set. `SyncEventRsvp` gains an OPTIONAL
`reminderOffsets`, and the import is two statements rather than one COALESCE: an absent field (a peer older
than reminders) leaves this replica's copy alone, while an explicit `null` (a member who cleared their
choice back to "my default") is written. A single COALESCE would make one of those two impossible, and
whichever one it dropped would be a silent loss. It is deliberately NOT added to `getStateHash`: the hash
keys RSVPs on `post_id|member_pubkey|status`, and putting a personal preference in it would read a
mixed-version pair as diverged over something that is not divergence.

`event_reminders_sent` does **not** replicate, and is in no tombstone, snapshot or audit count. It is this
node's own delivery log; only the primary sends (§2.2), so a replica has no use for it, and the worst case
at failover is bounded by the 15-minute window — a promoted standby can only re-send a reminder whose
moment fell inside the last quarter hour.

Peer communities see none of this: the listings pull carries no RSVPs, and so carries no reminders either.

**Peer communities** see listings through the periodic pull, not delta sync
(`apps/server/src/federation-listings.ts:72-91`): active, public, `reach != 'local'` posts, filtered by
`reachAdmitsPeer`. The pull carries id, type, category, title, description, credits, price and author, and
nothing else: no `lat`/`lng`, no photos, no dates. The receiving side refuses anything but `offer` and `need`
(`federation-listings.ts:153`) and caches a text-only copy (`:185`). A shared event would arrive at a peer as a
title with no pin, no time, no RSVP and no chat. So v1 forces `reach = 'local'` at create and hides the
linked-communities option on the event form; the pull is extended later to carry `eventStartAt`,
`eventEndAt`, `eventPlaceName` and `lat`/`lng` and to accept `type = 'event'`, and only then does the reach
control appear. RSVPs and the note never cross nodes either way.

### 2.5 Moderation

Reporting already takes a post: `POST /api/reports` with `targetPostId`
(`apps/server/src/routes/community.ts:1305`, `submitReport` at `state-engine.ts:4435`), from the phone's post
screen (`apps/native/app/post/[id].tsx:387`) and the PWA (`apps/pwa/src/lib/api.ts:1195`). An admin acting on
the report with `deletePost` calls `adminDeletePost` (`routes/admin.ts:1023-1027`, `posts.ts:674`), which
sets `active = 0, status = 'cancelled'` and broadcasts `post_removed`. Events need one addition there: mark
the chat read-only and notify Going that the event was removed. Chat messages are reported the way enterprise
thread messages are (target = the author, reason text names the message).

### 2.6 Old apps

There is no per-request version or capability header today. Signed requests carry key, signature, timestamp
and nonce only (`apps/native/utils/crypto.ts:217-220`). The node publishes `minAppVersion` in
`/api/community/health` (`state-engine.ts:4966`) and the phone shows a banner it cannot dismiss when it is
below the floor (`apps/native/components/GlobalHeader.tsx:268`); the PWA does the same (`apps/pwa/src/App.tsx:156`).
That is a blunt instrument for operators, not a way to hide one post type.

The phone pulls the whole feed with `GET /api/marketplace/posts?limit=1000&sync=true` and no type filter
(`apps/native/services/pillar-sync.ts:274`) into a local `posts` table (`apps/native/utils/db.ts:228`) and
renders anything that is not a poll as an offer/need tile (`apps/native/app/(tabs)/index.tsx:1344-1400`). The
PWA map pins every non-poll post (`apps/pwa/src/pages/MapPage.tsx:673`). An event sent to a v1.2.33 app would
show as a zero-Beans offer with no date, and its pin would be an offer pin.

**Guard: events are opt-in on the list route.** `GET /api/marketplace/posts` omits `type = 'event'` unless
the request says `types=offer,need,poll,event` (or `type=event`). New clients send it; every app in the store
today does not, so they never receive an event row. The by-id fetch, the RSVP route and the chat routes are
only reachable from screens that know events. Once every phone that matters is updated the parameter can
become the default; the health payload's `minAppVersion` is the operator's lever if a straggler needs a nudge.
No header change, no client detection, no server-side version table.

---

## 3. Screens at 320dp and 1.3× font

Every layout is checked at the floor in memory `product-audience-small-screens`
(`adb shell wm size 480x854 && wm density 240 && font_scale 1.30`). Row text gets `numberOfLines`; buttons
`flexShrink: 0`; nothing wraps in the chip strip.

**Chooser.** The phone's "Create New Post" sheet (`index.tsx:1760-1832`: Offer, Need, Community Poll, Cancel)
gains a fourth row: 📅 **Event** — "A gathering with a time and a place". Offer and Need push to the protected
map screen; Event opens a new `NewEventModal`, the way Poll opens `NewPollModal`, so the protected files are
untouched. The PWA's form toggle (`MapPage.tsx:1056`, `'offer' | 'need' | 'poll'`) gains `'event'`.

**Create form**, one column, in this order: title; date and time, two rows "Starts" and "Ends (optional,
2 hours after start if blank)", each a button that opens the native picker
(`@react-native-community/datetimepicker`, already used in `propose-project.tsx`; on Android 8 it is the
system dialog, date then time, which works with large fonts because it is the OS's own dialog; on the PWA
`<input type="datetime-local">`); place name; the pin picker with Approximate and the warning, reused from
enterprises; description; photo; "Note for people who are going" with the helper "Only people who tap Going
see this"; audience (the existing control, limited to this community or a group; linked communities are
later); host selector shown only when the member is a keeper or convenor ("Post as: me / Bindarrabi Hall /
Repair group"). Copy to a new date opens this form pre-filled with the dates cleared.

**Card** in the feed and the map preview, 320dp:

```
┌────────────────────────────────┐
│ SAT 27 SEP · 9:00–12:00        │  ← date+time first, largest text
│ Working bee at the hall        │
│ 📍 Bindarrabi Hall · 2.4 km    │
│ 👥 7 going · 3 interested      │
│ [ Going ✓ ]  [ Interested ]    │  ← my status shown on the filled button
└────────────────────────────────┘
```

CANCELLED or UPDATED is a badge on the first line. Host name is on the detail, not the card. Distance uses
the same "from my location" the map already computes.

**Event detail** (phone: `/post/:id` learns to branch on `type === 'event'`, as it does for needs; PWA: the
existing post modal at `MarketplacePage.tsx:724` gains an event branch beside the poll branch): photo, big
date and time with "Add to my Going", place name with a "Show on map" link, description, host line, RSVP
buttons, the private note in a shaded box when the viewer may see it, then "Open event chat (7)" and, for the
host, "Who's going" and "Cancel event" / "Copy to a new date".

**Chat entry.** The chat screen is the existing `/chat/:id` (event id), with the private note pinned as a
non-scrolling card at the top and a one-line footer "Visible to the host, everyone going, and this node's
operator". After the end: "This event has ended. The chat is read-only." The Talk list shows it with the
event title because the conversation row carries `name`.

**Web map** (`MapPage.tsx`, not protected): a purple pin with a calendar glyph via the `L.divIcon` path
enterprise pins use (`:825`); a chip strip **Today · This weekend · Next 7 days · All** above the map, filtering
on `event_start_at`; cancelled and ended events never pin.

**Native map** is step 2, its own PR: the pin variant in `UnifiedMapPin.tsx` (SVG → PNG through
`buildVariantList`), the layer toggle and chips in `map.tsx`. Both are protected files
(memory `protected-header-and-map`) and need Marty's explicit go before that PR is briefed.

---

## 4. Build slices

Each is a normal PR against `main` under the one-hit release plan, reviewable on its own and shippable
because the opt-in guard keeps old apps blind to events until they choose to see them.

| # | Slice | Size | Risk | Touches | Test |
|---|---|---|---|---|---|
| 1 | **Server: event post + RSVP + guard.** Type, columns, `event_rsvps`, create/edit/cancel/RSVP rules, end-time default, forced `reach = 'local'`, cap of 5 per author, auto-hide, opt-in `types=` parameter, sync registration. | M | low | `engine/posts.ts`, `packages/beanpool-engine/src/posts.ts`, `db/db.ts`, `schema.sql`, `routes/marketplace.ts`, both `sync.ts`, `state-engine.ts` (hash, clear), `audit.ts` | Unit tests beside the poll tests: create/validate, end defaults to start + 2 h, reach forced local, cap at 5 with enterprise and group pools separate, RSVP upsert/delete, list omits events without `types=`, by-id after end for host and Going only, sync round-trip of `event_rsvps`. |
| 2 | **PWA: create, card, detail, RSVP, note, map pin + chips.** | M | low | `MapPage.tsx`, `MarketplacePage.tsx`, new `EventCard.tsx`, `lib/api.ts` | Vitest for the card at 320px; manual: create with Approximate, RSVP flips counts, note hidden until Going, chips filter. |
| 3 | **Native (no protected files): chooser row, `NewEventModal`, feed tile, detail with RSVP and note.** | M | medium: the feed screen is large | `index.tsx`, new `components/NewEventModal.tsx`, `app/post/[id].tsx`, `utils/db.ts` (send `types=`, cache columns) | Emulator at the floor: form with the Android 8 picker, tile, detail, RSVP. Old build still shows no events against the same node. |
| 4 | **Event chat, server + both clients.** `event_thread` conversation (`plaintext-v1`), membership mirror with RSVP re-check, read/post/remove rules, read-only after end, pinned note, node-readable notice. | M | medium: touches messaging | new `engine/event-thread.ts`, `routes/marketplace.ts`, `messaging.ts` (thread exemptions), `/chat/:id` on both clients | Unit: Going adds, Interested removes, host removal, read-only after end, non-member read refused. Manual: chat appears in Talk with unread. |
| 5 | **Change and cancel notifications, Copy to a new date.** Host edits everything; time/place → UPDATED + push on the `marketplace` category. | S | low | `engine/posts.ts`, `state-engine.ts` (push), both create forms | Unit: time or place change notifies Going only, other edits silent; cancel sets state and read-only chat. Device: push arrives on the `marketplace` channel. |
| 6 | **Moderation hook and 30-day scrub.** `adminDeletePost` event branch, scheduler job, replica consistency. | S | low | `engine/posts.ts`, `pulse-resolver.ts` scheduler, `audit.ts` | Unit: scrub deletes RSVPs, messages, note; keeps the row; hash matches on a replica. |
| 7 | **Native map layer** (separate PR, after Marty opens the protected files). | M | high: protected, PNG pin pipeline | `map.tsx`, `UnifiedMapPin.tsx`, `Map.web.tsx` | Screenshot at the floor, pin variants regenerate, chips do not wrap. |
| later | **Federation: events in the listings pull.** Pull carries dates, place name and pin, accepts `type = 'event'`; reach control appears on the form. | S | low | `federation-listings.ts`, both event forms | Unit: peer receives an event with its fields; RSVP and note still never cross. |
| later | **Dedicated Events push channel** and `notify_events` preference, once the client that has it is in the store. | S | low | `push-notifications.ts`, `state-engine.ts`, settings screens | Device: old build still receives on `marketplace`; new build on `events`. |

Order: 1 → 2 and 3 in parallel → 4 → 5 → 6 → store release → node deploy → 7. The two "later" slices are not
scheduled; each starts only when Marty asks for it. Full suite last, in CI.

---

## 5. Not in v1

Paid entry or tickets. Capacity limits and waitlists. Repeat rules or a materialiser (Copy to a new date
only). Host approval of attendees. A Pulse "happening soon" strip. A host page listing its events. Calendar
export or OAuth. QR check-in. Cross-node RSVPs. Reminder pushes before the start. Member-to-member invites.
Sharing to linked communities (reach forced local; the listings pull grows event fields later). A dedicated
Events push channel (later). Hard deletion of ended events (scrubbed instead).

---

## 6. Decided 2026-09-18

The first version of this note asked ten questions the code forced. Marty answered all of them (decisions
24–32 in the log); each is now part of the body above.

1. **Old apps:** events are opt-in on the list route via the `types=` parameter; store apps never receive
   them (§2.6).
2. **Chat storage:** node-readable `plaintext-v1` like the enterprise thread, with a one-line on-screen
   notice (§2.1).
3. **Chat membership:** mirrored into `conversation_participants` as RSVPs change, re-checked on every read
   and post (§2.2; follows from decisions 20 and 25).
4. **Push:** the existing `marketplace` category in v1; a dedicated Events channel is a later slice (§2.2).
5. **Federation:** this community only in v1, `reach` forced `local` like polls; extend the listings pull
   later (§2.4).
6. **Upcoming cap:** 5 per author, enforced at create like the poll limit; each enterprise and group is its
   own author (§2.2).
7. **Editing after RSVPs:** the host may edit everything; time or place changes mark UPDATED and notify
   Going, other edits are silent (§2.2).
8. **30-day removal:** a scrub, not a hard delete; RSVPs, chat and note deleted, the inactive post row kept
   (§2.2).
9. **Host rights:** every keeper of the enterprise, every active convenor of the group; the same set
   `removePost` trusts (§2.2).
10. **End time:** optional, default start + 2 hours (§2.2, §3).

Marty read this note before slice 1; slices 1–6 have since shipped (see Status at the top).
