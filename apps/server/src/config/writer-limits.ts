/**
 * How much one member's key may write to a main server in a day (W-main, design
 * scratch/global-node/DESIGN-replica-flood-bounds-opus.md §6.2).
 *
 * Why: a standby copies the main server's tables, and a table past the copy's row cap (250,000) can't be copied whole.
 * Before these limits the gateway's 120 requests a minute was the only bound on most routes, so one ordinary member
 * could push a dozen tables past the cap in 7 to 35 hours (design §3.2). Each limit here is set so the heaviest real
 * person never meets it; the comment on each says what that person does.
 *
 * EVERY NUMBER IS HERE, so changing one is one edit. What reads each:
 *   - the day budget: the gateway (gateway-rate-limit.ts gatewayAdmitDayBudget), in memory beside the minute buckets;
 *   - the DM minute: chat-rate-limit.ts (CHAT_LINES_PER_MINUTE), shared with group and event chats;
 *   - everything else: engine/writer-bounds.ts, which counts from the rows the member wrote (like probation), so a
 *     restart, a restore or a take-over carries the counts with them. The Pulse harvester's allowance is read there
 *     too, by engine/pulse-resolver.ts resolveChannel: those rows are the server's own writes for a member.
 *
 * An enterprise or project (a treasury: in the commons model a project IS an enterprise, members.is_treasury = 1) has its
 * own, higher allowance wherever it acts, counted against it and never against the keeper who signs (Marty, 2026-09-29:
 * "maybe needs to be higher for enterprise/project"; the director set 10x). Each `enterprise…` number sits beside the
 * member's one it replaces for an enterprise's acts.
 *
 * One person's enterprise work has a ceiling too, across every enterprise they keep (the director, 2026-09-30, after the
 * review of 362efe26: any member can start 3 enterprises a day and keep 20, so per-enterprise numbers alone multiplied
 * one person's day by the enterprises they started). Each `enterpriseWork…` number is at the enterprise's own: an act
 * for an enterprise counts against the enterprise AND against the keeper who does it, and both must have room. So a
 * busy shop with several keepers still gets its whole allowance (each keeper's share counts to their own ceiling), and
 * one person, through any number of enterprises, does at most one enterprise's worth a day, on top of their own limits.
 *
 * Once an enterprise's own day of something is spent (its writes, posts, payments, new people or approvals), what a
 * keeper does further of it for that enterprise counts against the keeper's OWN number beside it instead (the director,
 * 2026-09-30), as everything did on main: so one keeper who spends a shop's day blocks only themselves, and every other
 * keeper keeps their own allowance for it. The `enterprise…` numbers are the shop's 10x on top.
 *
 * The money limits (W-money, design §7 row 5) are MONEY_LIMITS below, read by engine/money-limits.ts.
 */
export const WRITER_LIMITS = {
    /** Signed writes (POST, PUT, PATCH, DELETE) per key in any 24 hours, the admin surface and the read marks aside
     *  (gateway-rate-limit.ts DAY_BUDGET_READ_MARKS: the apps send those on a timer while a chat is open, ~300 an hour
     *  from a phone, and they make no row). Heavy real user: a very active member's few hundred messages, reactions,
     *  edits and deals, under 2,000. */
    signedWritesPerDay: 5_000,
    /** Signed writes per enterprise or project in any 24 hours, for the writes whose path names it
     *  (`/api/treasury/:id/…`, `/api/enterprise/:id/…`, `/api/enterprises/:id/…`) when the signer keeps that running
     *  enterprise. They are counted here and not in the keeper's own signedWritesPerDay, until this is spent: then a
     *  keeper's writes for it count in their own signedWritesPerDay. Heavy real user: a large
     *  project's or a busy shop's keepers together, listing, approving, paying and talking in its thread all day: a few
     *  thousand. */
    enterpriseSignedWritesPerDay: 50_000,
    /** Signed writes one person makes for the enterprises they keep, all of them together, in any 24 hours: every write
     *  counted against an enterprise above counts here too, against the keeper who signs it, and not in their own
     *  signedWritesPerDay. Heavy real user: the busiest keeper of a large project or shop, doing most of its work
     *  alone: a few thousand. */
    enterpriseWorkSignedWritesPerDay: 50_000,
    /** Lines per member per minute in a chat: a DM, a group chat or an event chat. Heavy real user: nobody types 30
     *  lines a minute. */
    chatLinesPerMinute: 30,
    /** The most a DM line's words may take, as stored (its ciphertext plus any metadata sent with it), in characters.
     *  A photo goes as an attachment and is not counted. Heavy real user: nobody types a 48 KB message (64 KB of
     *  base64 ciphertext). */
    dmLineChars: 64 * 1024,
    /** People with no row here (not a member, and nobody this community has met) a member opens DMs with, in any 24
     *  hours. Each is a new row for them. Probation's stricter 10 new people still applies where it is on. Heavy real
     *  user: messaging 20 strangers from other communities in a day is already unusual. */
    newPeopleByDmPerDay: 20,
    /** Enterprises a member starts in any 24 hours. Heavy real user: a person runs one to three. */
    enterprisesPerDay: 3,
    /** Enterprises a member started that are still running (not wound up). Heavy real user: a person runs one to three. */
    enterprisesLive: 20,
    /** New posts (any kind) by one member in any 24 hours, their own. What they put up for an enterprise they keep
     *  counts against the enterprise (enterprisePostsPerDay), and here once the enterprise's are up. Photos stay at 5 a
     *  post. Heavy real user: a member putting a garage's worth of things up in one day. */
    postsPerDay: 100,
    /** New posts (offers, needs and events) an enterprise or project puts up in any 24 hours, whichever keepers put them
     *  up. Heavy real user: a large shop or market putting its whole stock up in one day. */
    enterprisePostsPerDay: 1_000,
    /** New posts one person puts up for the enterprises they keep, all of them together, in any 24 hours (each also
     *  counts against its enterprise's enterprisePostsPerDay). Heavy real user: a keeper putting a large shop's whole
     *  stock up in one day. */
    enterpriseWorkPostsPerDay: 1_000,
    /** Groups a member starts in any 24 hours. Heavy real user: a convenor making several interest groups in a day. */
    groupsPerDay: 5,
    /** Invites a member makes in any 24 hours. Heavy real user: a member bringing a street in for a launch night. */
    invitesPerDay: 20,
    /** A member's invites that nobody has used yet and that still work. Heavy real user: a member bringing a street in
     *  for a launch night. */
    invitesUnused: 50,
    /** An invite nobody used is deleted this many days after it was made, with no tombstone (an age rule): it has
     *  stopped working by then. Never below an invite's 30-day life, which the prune holds it to. */
    unusedInviteDays: 30,
    /** Links a member adds to the Pulse by hand in any 24 hours. Heavy real user: a creator's busy day. */
    pulseSubmissionsPerDay: 50,
    /** New Pulse items a member's app syncs from their connected accounts in any 24 hours. Over it, the rest of a sync
     *  waits for a later one. Heavy real user: a creator's first sync of all 12 channels, about 25 items each. */
    pulseSyncedItemsPerDay: 300,
    /** New Pulse items the server harvests in any 24 hours from one member's own feeds (website, RSS, YouTube,
     *  SoundCloud), all their channels together. Over it, a visit adds nothing new for them (items already listed still
     *  refresh) until the day's first ones age out. Heavy real user: a creator's first harvest of all 12 channels, the
     *  newest 20 each (240), plus a day of new posts across them (a daily blog, a podcast and a busy video channel:
     *  tens, not 160). Before it, a feed its owner controls could add ~57,600 rows a day. */
    pulseHarvestedItemsPerDay: 400,
};

/**
 * What one account may do with Beans in any 24 hours (W-money: design scratch/global-node/DESIGN-replica-flood-bounds-opus.md
 * §7 row 5; Marty's numbers, board card w-money-numbers, 2026-09-29, and 10x those for an enterprise or project, the
 * director's). So that one account, or a stolen phone, can't spray Beans or flood the ledger. Enforced by
 * engine/money-limits.ts (the routes: routes/money-limits-gate.ts, and the two federation routes themselves).
 *
 * Counted against the account whose Beans or deal it is: a member's own key, or the enterprise (its treasury) when a
 * keeper acts for it, never against the keeper's own while the enterprise has room. What a keeper does for an enterprise
 * also counts against their enterprise work, across every enterprise they keep (the `enterpriseWork…` numbers), so
 * starting enterprises doesn't multiply one person's day. Once the enterprise's own number is spent, a keeper's further
 * acts of that kind for it count against the keeper's own number (paymentsPerDay, newRecipientsPerDay,
 * marketRequestsPerDay) instead. Receiving is never limited.
 */
export const MONEY_LIMITS = {
    /** Payments a member's own account sends in any 24 hours: a send, a one-step buy, asking to buy an offer, approving
     *  help on their own need, a pledge to a crowdfund, a purchase from another community. Heavy real user: a market
     *  day's buying and a few gifts, a few dozen. */
    paymentsPerDay: 100,
    /** Payments an enterprise or project sends in any 24 hours: paying for help on its needs, sweeping to the Commons,
     *  commissioning from another community. Heavy real user: a busy shop or project paying its suppliers and helpers,
     *  a few hundred. */
    enterprisePaymentsPerDay: 1_000,
    /** Payments one person makes for the enterprises they keep, all of them together, in any 24 hours (sweeps, paying
     *  helpers, commissions). Heavy real user: the keeper who pays a busy shop's suppliers and helpers alone. */
    enterpriseWorkPaymentsPerDay: 1_000,
    /** People a member pays in any 24 hours whom they have never paid before (paying someone they have paid before is
     *  not counted). Heavy real user: buying from a dozen new stalls on a market day. */
    newRecipientsPerDay: 30,
    /** People an enterprise or project pays in any 24 hours whom it has never paid before. Heavy real user: a project
     *  taking on a hundred new helpers for a working bee. */
    enterpriseNewRecipientsPerDay: 300,
    /** People one person pays for the enterprises they keep, all of them together, in any 24 hours, each new to the
     *  enterprise that pays them (one paid by two of their enterprises is two). Heavy real user: the keeper who signs
     *  up a hundred new helpers for a working bee. */
    enterpriseWorkNewRecipientsPerDay: 300,
    /** Marketplace requests a member makes in any 24 hours: asking to buy or to help, accepting an offer, approving a
     *  request on their own listing. Heavy real user: a busy market day on both sides of the stall, several dozen. */
    marketRequestsPerDay: 100,
    /** Marketplace requests an enterprise or project makes in any 24 hours: approving requests on its listings. Heavy
     *  real user: a busy shop's orders on its best day, a few hundred. */
    enterpriseMarketRequestsPerDay: 1_000,
    /** Marketplace requests one person approves for the enterprises they keep, all of them together, in any 24 hours.
     *  Heavy real user: the keeper who handles a busy shop's orders alone on its best day. */
    enterpriseWorkMarketRequestsPerDay: 1_000,
    /** Pledge changes a member makes in any 24 hours: backing an enterprise (a keeper's pledge), changing or releasing
     *  it, or pledging to a crowdfund. Pledges are a member's act, so an enterprise has no number of its own. Heavy real
     *  user: backing a handful of projects at a launch. */
    pledgesPerDay: 20,
};
