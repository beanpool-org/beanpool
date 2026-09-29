/**
 * The per-route writer limits (W-main, design scratch/global-node/DESIGN-replica-flood-bounds-opus.md §6.2): how many
 * posts, groups, enterprises, invites, Pulse links and new people by DM one member makes in a day, how many enterprises
 * and unused invites they hold at once, and how long a DM line may be. The numbers are in config/writer-limits.ts
 * (WRITER_LIMITS), with the day budget and the chat minute that are enforced elsewhere.
 *
 * Why: every one of these is a row a standby copies, and before these the gateway's 120 requests a minute was the only
 * limit, so one member could push each table past a standby's copy cap in a day or two (design §3.2).
 *
 * Like probation (engine/probation.ts), every count is read from the rows the member wrote, over a rolling 24 hours:
 * there is no counter table, so a restart, a restore, a standby or a take-over carries the counts with them. Each limit
 * applies on every profile. On the global profile probation's stricter limits are checked first where they apply.
 *
 * Over a limit: WriterLimitError, answered by respondProfileRefusal (routes/profile-feature-gate.ts) with its status
 * (429, or 413 for a DM line too long), a stable `code`, plain words, and `resetsAt` with `Retry-After` when waiting
 * lets it up.
 *
 * An enterprise's posts count against the enterprise at its own, higher number (WRITER_LIMITS.enterprisePostsPerDay),
 * never against the keeper's own 100, and against the keeper's enterprise work across every enterprise they keep
 * (WRITER_LIMITS.enterpriseWorkPostsPerDay). The money routes have their own limits (engine/money-limits.ts).
 */
import { db } from '../db/db.js';
import { WRITER_LIMITS } from '../config/writer-limits.js';
import { getNodeRole } from '../config/node-role.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** An invite's life: redeemInvite and checkInvite refuse a code older than this (engine/invites.ts, the engine's). */
const INVITE_LIFE_DAYS = 30;

export type WriterLimitCode =
    | 'message_too_long'
    | 'new_people_per_day'
    | 'enterprises_per_day'
    | 'enterprises_live'
    | 'posts_per_day'
    | 'enterprise_posts_per_day'
    | 'enterprise_work_posts_per_day'
    | 'groups_per_day'
    | 'invites_per_day'
    | 'invites_unused'
    | 'pulse_per_day';

export class WriterLimitError extends Error {
    constructor(
        readonly code: WriterLimitCode,
        message: string,
        /** When waiting lets it up (ISO), or null when only the member's own act can (winding one up, a code used). */
        readonly resetsAt: string | null = null,
        readonly status: number = 429,
    ) {
        super(message);
        this.name = 'WriterLimitError';
    }
}

const iso = (ms: number) => new Date(ms).toISOString();

/** "in about 5 hours", from now to the moment a limit lets up. */
function inAbout(atMs: number, now: number): string {
    const mins = Math.max(1, Math.ceil((atMs - now) / 60_000));
    if (mins < 60) return mins === 1 ? 'in about a minute' : `in about ${mins} minutes`;
    const hours = Math.round(mins / 60);
    return hours === 1 ? 'in about an hour' : `in about ${hours} hours`;
}

/**
 * Throws `code` when `times` (ISO instants of what counts, within the day) already hold `limit`. It lets up when enough
 * of them leave the day that one more fits: the (used - limit + 1)th oldest, 24 hours on.
 */
function assertUnderDaily(times: readonly string[], limit: number, now: number, code: WriterLimitCode, words: (when: string) => string): void {
    if (times.length < limit) return;
    const sorted = times.map((t) => Date.parse(t)).filter(Number.isFinite).sort((a, b) => a - b);
    const freeing = sorted[Math.max(0, sorted.length - limit)] ?? now;
    const resetsAtMs = Math.max(now + 1_000, freeing + DAY_MS);
    throw new WriterLimitError(code, words(inAbout(resetsAtMs, now)), iso(resetsAtMs));
}

const column = (rows: unknown[]) => (rows as { t: string }[]).map((r) => r.t);
const since = (now: number) => iso(now - DAY_MS);

// ── Posts ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Posts of any kind put up in the day as `author`: a member's own, or an enterprise's, whichever keepers put them up.
 * What a keeper puts up for an enterprise is the enterprise's (its author), and never counts against the keeper.
 */
function postTimes(author: string, now: number): string[] {
    return column(db.prepare(`SELECT created_at AS t FROM posts WHERE author_pubkey = ? AND origin_node IS NULL AND created_at > ?`)
        .all(author, since(now)));
}

/** Before a new post by `member` for themselves. */
export function assertMayPostToday(member: string, now = Date.now()): void {
    const limit = WRITER_LIMITS.postsPerDay;
    assertUnderDaily(postTimes(member, now), limit, now, 'posts_per_day',
        (when) => `You can put up ${limit} new posts in any 24 hours. You can post again ${when}.`);
}

/**
 * Before a new post `keeper` puts up for `enterprise` (an offer, a need or an event): the enterprise's own day, and then
 * the keeper's enterprise work, what they put up in the day for every enterprise they keep (created_by, the posts routes
 * set it to the keeper whenever the author is an enterprise).
 */
export function assertEnterpriseMayPostToday(enterprise: string, keeper: string, now = Date.now()): void {
    const limit = WRITER_LIMITS.enterprisePostsPerDay;
    const name = (db.prepare('SELECT callsign FROM members WHERE public_key = ?').get(enterprise) as { callsign: string | null } | undefined)?.callsign?.trim() || 'This enterprise';
    assertUnderDaily(postTimes(enterprise, now), limit, now, 'enterprise_posts_per_day',
        (when) => `${name} can put up ${limit.toLocaleString('en')} new posts in any 24 hours. It can post again ${when}.`);
    const work = WRITER_LIMITS.enterpriseWorkPostsPerDay;
    const forEnterprises = column(db.prepare(`SELECT created_at AS t FROM posts WHERE created_by = ? AND author_pubkey != ? AND origin_node IS NULL AND created_at > ?`)
        .all(keeper, keeper, since(now)));
    assertUnderDaily(forEnterprises, work, now, 'enterprise_work_posts_per_day',
        (when) => `You can put up ${work.toLocaleString('en')} new posts in any 24 hours for the enterprises you keep, all of them together. You can post for them again ${when}. Your own posts are counted apart.`);
}

// ── Groups ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Before a new group by `member`. */
export function assertMayStartGroupToday(member: string, now = Date.now()): void {
    const limit = WRITER_LIMITS.groupsPerDay;
    const times = column(db.prepare('SELECT created_at AS t FROM groups WHERE created_by = ? AND created_at > ?').all(member, since(now)));
    assertUnderDaily(times, limit, now, 'groups_per_day',
        (when) => `You can start ${limit} groups in any 24 hours. You can start another ${when}.`);
}

// ── Enterprises ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The enterprises `member` started, as their chat's first row says (createTreasury opens every enterprise's thread in
 * its creator's name, and a conversation is never deleted, so a creator who has since stepped down still counts).
 */
const STARTED_BY = `SELECT c.created_at AS t, m.status AS status FROM conversations c
                      JOIN members m ON m.public_key = c.id AND m.is_treasury = 1
                     WHERE c.type = 'enterprise_thread' AND c.created_by = ?`;

/** Before a new enterprise by `member`: 3 a day, and 20 of theirs still running (not wound up). */
export function assertMayStartEnterprise(member: string, now = Date.now()): void {
    const started = db.prepare(STARTED_BY).all(member) as { t: string; status: string | null }[];
    const running = started.filter((r) => r.status !== 'completed' && r.status !== 'pruned').length;
    if (running >= WRITER_LIMITS.enterprisesLive) {
        throw new WriterLimitError('enterprises_live',
            `You have started ${WRITER_LIMITS.enterprisesLive} enterprises that are still running, the most one member can have. Wind one up before you start another.`);
    }
    const limit = WRITER_LIMITS.enterprisesPerDay;
    const today = started.map((r) => r.t).filter((t) => typeof t === 'string' && t > since(now));
    assertUnderDaily(today, limit, now, 'enterprises_per_day',
        (when) => `You can start ${limit} enterprises in any 24 hours. You can start another ${when}.`);
}

// ── Invites ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The invites `member` made in the day: codes by when they were made, and offline tickets by when they were used. A
 * ticket is made on the phone, with a time its maker signs, and has no row here until someone joins with it, so its
 * join is when this server first sees it. A ticket's row is keyed on its hash (16 hex); every code begins `INV-`.
 * Never the codes an owner or admin made in Settings (`issued_by`, routes/community.ts): those hang off the first member
 * in the invite tree, and a card run of 100 would otherwise stop that person inviting anyone from their own phone.
 */
function inviteTimes(member: string, now: number): string[] {
    return [
        ...column(db.prepare(`SELECT created_at AS t FROM invite_codes WHERE created_by = ? AND code LIKE 'INV-%' AND issued_by IS NULL AND created_at > ?`)
            .all(member, since(now))),
        ...column(db.prepare(`SELECT used_at AS t FROM invite_codes WHERE created_by = ? AND code NOT LIKE 'INV-%' AND used_at > ?`)
            .all(member, since(now))),
    ];
}

const invitesPerDayWords = (limit: number) => (when: string) =>
    `You can make ${limit} invites in any 24 hours. You can make more ${when}.`;

/** Before a new invite code by `member`: 20 a day, and 50 of theirs unused and still working (Settings' own aside). */
export function assertMayMakeInvite(member: string, now = Date.now()): void {
    const unused = (db.prepare(`SELECT COUNT(*) AS n FROM invite_codes
                                 WHERE created_by = ? AND code LIKE 'INV-%' AND issued_by IS NULL AND used_by IS NULL AND created_at > ?`)
        .get(member, iso(now - INVITE_LIFE_DAYS * DAY_MS)) as { n: number }).n;
    if (unused >= WRITER_LIMITS.invitesUnused) {
        throw new WriterLimitError('invites_unused',
            `You have ${WRITER_LIMITS.invitesUnused} invites nobody has used yet, the most one member can hold. You can make more as they are used, or as they lapse ${INVITE_LIFE_DAYS} days after you made them.`);
    }
    assertUnderDaily(inviteTimes(member, now), WRITER_LIMITS.invitesPerDay, now, 'invites_per_day', invitesPerDayWords(WRITER_LIMITS.invitesPerDay));
}

/**
 * Before someone joins with an offline ticket `inviter` signed: the ticket is an invite made now (inviteTimes), so it
 * counts against the same 20 a day, and past it the join is refused with nothing written and the ticket still unused.
 * The words go to the person joining.
 */
export function ticketJoinRefusal(inviter: string, now = Date.now()): string | null {
    const limit = WRITER_LIMITS.invitesPerDay;
    try {
        assertUnderDaily(inviteTimes(inviter, now), limit, now, 'invites_per_day',
            (when) => `The member whose invite this is has brought ${limit} people in today, the most in 24 hours. Try this invite again ${when}.`);
        return null;
    } catch (e) {
        if (e instanceof WriterLimitError) return e.message;
        throw e;
    }
}

/**
 * Delete every invite code nobody used, `unusedInviteDays` after it was made (never before its 30-day life is over), with
 * no tombstone: an age rule, which writes nothing a standby must copy. A standby's copy of them goes at its next whole
 * copy, which makes every plain table exactly the main server's (engine/plain-tables.ts). A code someone used is kept
 * (it records how they joined), and so is an offline ticket's row, which exists only once used.
 * On a main server only: a standby writes no invite of its own (assertPlainTablesWritable). Returns how many went.
 */
export function pruneUnusedInvites(now = Date.now()): number {
    if (getNodeRole() !== 'primary') return 0;
    const days = Math.max(INVITE_LIFE_DAYS, WRITER_LIMITS.unusedInviteDays);
    return db.prepare(`DELETE FROM invite_codes WHERE used_by IS NULL AND created_at < ?`).run(iso(now - days * DAY_MS)).changes;
}

let inviteTimer: ReturnType<typeof setInterval> | null = null;

/** The prune on a timer (hourly), checking the role at every tick, so a standby that takes over starts pruning. */
export function startPruningUnusedInvites(everyMs = HOUR_MS): void {
    if (inviteTimer) clearInterval(inviteTimer);
    inviteTimer = setInterval(() => {
        try {
            const gone = pruneUnusedInvites();
            if (gone > 0) console.log(`[Invites] Deleted ${gone} unused invite(s) past their ${INVITE_LIFE_DAYS} days.`);
        } catch (e) { console.warn('[Invites] Could not prune unused invites:', (e as Error)?.message || e); }
    }, everyMs);
    inviteTimer.unref?.();
}

// ── DMs ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A DM line's words as stored (its ciphertext, and any metadata sent with it) may take WRITER_LIMITS.dmLineChars. A
 * photo is an attachment, stored apart and not counted. 413 `message_too_long`.
 */
export function assertDmLineFits(ciphertext: unknown, metadata?: unknown): void {
    const chars = (typeof ciphertext === 'string' ? ciphertext.length : 0) + (typeof metadata === 'string' ? metadata.length : 0);
    if (chars > WRITER_LIMITS.dmLineChars) {
        throw new WriterLimitError('message_too_long',
            'This message is too long to send. Send it as a few shorter messages. A photo goes as an attachment and is not counted.', null, 413);
    }
}

/**
 * The people with no row here that `member` opened a DM with in the day: DM conversations they opened whose other
 * person's row is a visitor's, made in the day, no later than that conversation, and in no conversation before it. That
 * is a row their opening made (createConversation → registerVisitor).
 */
function newPeopleTimes(member: string, now: number): string[] {
    return column(db.prepare(`
        SELECT c.created_at AS t
          FROM conversation_participants mine
          JOIN conversations c ON c.id = mine.conversation_id AND c.type = 'dm' AND c.created_by = mine.public_key AND c.created_at > ?
          JOIN conversation_participants other ON other.conversation_id = c.id AND other.public_key != mine.public_key
          JOIN members m ON m.public_key = other.public_key AND m.is_visitor = 1 AND m.joined_at > ? AND m.joined_at <= c.created_at
         WHERE mine.public_key = ?
           AND NOT EXISTS (SELECT 1 FROM conversation_participants p2 JOIN conversations c2 ON c2.id = p2.conversation_id
                            WHERE p2.public_key = other.public_key AND c2.created_at < c.created_at)`)
        .all(since(now), since(now), member));
}

/**
 * Before `member` opens a DM with `participants`: when one of them has no row here (the opening makes one for them), at
 * most WRITER_LIMITS.newPeopleByDmPerDay such people in the day. Anyone with a row (a member, or a visitor already
 * met) is never counted.
 */
export function assertMayReachNewPeople(member: string, participants: readonly string[], now = Date.now()): void {
    const unknown = participants.filter((p) => p !== member && !db.prepare('SELECT 1 FROM members WHERE public_key = ?').get(p));
    if (unknown.length === 0) return;
    const limit = WRITER_LIMITS.newPeopleByDmPerDay;
    const times = newPeopleTimes(member, now);
    if (times.length + unknown.length <= limit) return;
    // Room for fewer than `unknown`: it lets up when enough of the day's leave to fit them all.
    assertUnderDaily(times, Math.max(1, limit - unknown.length + 1), now, 'new_people_per_day',
        (when) => `You can start conversations with ${limit} people from outside this community in any 24 hours. You can message someone new again ${when}. Messaging members here, and replying, is not limited.`);
}

// ── The Pulse ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Pulse items `member` added in the day from `source` ('manual': by hand; 'oauth': synced from a connected account;
 * 'autolist': harvested by the server from their own feeds). An item pruned since still counts: its row stays, deleted.
 */
export function pulseItemsToday(member: string, source: 'manual' | 'oauth' | 'autolist', now = Date.now()): string[] {
    return column(db.prepare('SELECT created_at AS t FROM pulse_items WHERE owner_pubkey = ? AND source = ? AND created_at > ?')
        .all(member, source, since(now)));
}

/** Before a new Pulse item by hand (a resubmitted link that is already there, or comes back, is not new). */
export function assertMaySubmitToPulse(member: string, now = Date.now()): void {
    const limit = WRITER_LIMITS.pulseSubmissionsPerDay;
    assertUnderDaily(pulseItemsToday(member, 'manual', now), limit, now, 'pulse_per_day',
        (when) => `You can add ${limit} links to the Pulse in any 24 hours. You can add more ${when}.`);
}

/** How many new items a sync from `member`'s connected accounts may still add today. */
export function pulseSyncAllowance(member: string, now = Date.now()): number {
    return Math.max(0, WRITER_LIMITS.pulseSyncedItemsPerDay - pulseItemsToday(member, 'oauth', now).length);
}

/**
 * How many new items the Pulse harvester (engine/pulse-resolver.ts resolveChannel) may still add today from `member`'s
 * own channels, all of them together. The server makes these rows itself on its schedule, so neither the gateway's day
 * budget nor a route's limit sees them; without this a feed its owner controls could serve 20 new items at every visit.
 */
export function pulseHarvestAllowance(member: string, now = Date.now()): number {
    return Math.max(0, WRITER_LIMITS.pulseHarvestedItemsPerDay - pulseItemsToday(member, 'autolist', now).length);
}
