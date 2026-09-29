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
 * The money routes are not limited here (no change in conservingTransaction, the ledger guards or the transfer
 * routes): the day budget bounds them from the gateway until their own limits land (design §7, W-money).
 */
export const WRITER_LIMITS = {
    /** Signed writes (POST, PUT, PATCH, DELETE) per key in any 24 hours, the admin surface and the read marks aside
     *  (gateway-rate-limit.ts DAY_BUDGET_READ_MARKS: the apps send those on a timer while a chat is open, ~300 an hour
     *  from a phone, and they make no row). Heavy real user: a very active member's few hundred messages, reactions,
     *  edits and deals, under 2,000. */
    signedWritesPerDay: 5_000,
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
    /** New posts (any kind) by one member in any 24 hours, their own and those they put up for an enterprise they
     *  keep. Photos stay at 5 a post. Heavy real user: a shop putting its whole stock up in one day. */
    postsPerDay: 100,
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
