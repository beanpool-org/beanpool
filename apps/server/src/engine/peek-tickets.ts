/**
 * The peek ticket (front doors S6, scratch/fable-design/DESIGN-entry-points-fable.md §2.5 C and §3.4, Marty's "all of
 * Fable's picks", 27 Oct 2026): a member shares ONE listing, event or Pulse post outside the community, and whoever holds
 * the link reads that one post under the visitors' rules for seven days.
 *
 * ## What a ticket holder reads, and nothing else
 * `GET /api/marketplace/posts/:id?peek=<ticket>` (routes/peek.ts), let through the read gate by the ticket alone
 * (https-server.ts peekReadAllowed), answers exactly one post, read for nobody in particular as the global lobby reads a
 * listing for a visitor (`coarse`, `guest`, no voters) and passed through the engine's guestPost: what it is, its words,
 * photos (each URL with the key only a read of the listing hands out, engine/photo-keys.ts), price, dates, counts and its
 * rough area (0.1°), and nobody: no author key, name, face or standing, nobody who took it, voted or is going, no typed
 * place, no join link, no private note. Nothing else is read with it: no other post, no member, no balance. The page
 * around it (the share page, both apps' peek) adds only the community's public card (routes/community-card.ts).
 *
 * ## When a ticket opens its post
 * All of these, checked on every read, so each one ends it at once:
 *   - the ticket is one this node made (its SHA-256 is a row), for THIS post: a ticket never opens another post;
 *   - it hasn't run out (seven days, PEEK_TICKET_DAYS) and nobody stopped it: the member who shared it (Stop sharing),
 *     or the owners turning "Members may share listings outside the community" off, which stops every link at once;
 *   - the community still lets members share outside (the `shareOutside` switch) and is in no private preview;
 *   - the member who shared it still reads as a member here (readsAsMember): removed, suspended, re-keyed, closed or
 *     pruned, their links stop;
 *   - the post is one a visitor could be shown: on the board (active, not paused, its author not on holiday, not an
 *     enterprise paused or winding up, not a paused account's), for everyone here (no group or direct post: those are
 *     keyed to their people, #1348), not hidden by reports, this community's own (not a linked community's copy), and
 *     not an event that has ended or was cancelled.
 * Anything else is the plain visitor answer, the same in every case, so a refusal never says which: forged, run out,
 * stopped, another post's, switched off, a sharer gone, a post gone.
 *
 * ## The ticket
 * 16 random bytes, base64url (@beanpool/core isPeekTicket), made here when a member asks (`POST /api/peek`, signed by the
 * member's key through the real signature middleware: the member's key signs the post it is for). Never stored: the row
 * keeps its SHA-256, so a copy of this database opens nothing. The link carries no key, no name and no post id of its
 * own, so a forwarded link says nothing about who shared it. The design's sketch was a ticket the sharer's key signs and
 * the link carries; that would put the sharer's public key in every forwarded link, which the visitors' rules keep out
 * of everything a visitor reads (g9a), and a revocation list would still have to live here. So the node makes the
 * ticket, from the member's signed request, and keeps the list.
 */
import crypto from 'node:crypto';
import { PEEK_TICKET_DAYS, PEEK_TICKETS_LIVE_MAX, isPeekPostId, isPeekTicket, word, type PeekShare } from '@beanpool/core';
import { ENTERPRISE_ON_BOARD_SQL, ON_HOLIDAY_SQL, getPosts, guestPost, readsAsMember, type MarketplacePost } from '@beanpool/engine';
import { db } from '../db/db.js';
import { getProfileSwitches } from '../config/node-profile.js';
import { isPrivatePreview } from '../config/private-preview.js';
import { getNodeRole } from '../config/node-role.js';

const DAY_MS = 86_400_000;
/** A row is deleted this long after it ran out: long enough to list nothing it shouldn't, short enough to stay small. */
const KEEP_AFTER_EXPIRY_MS = 30 * DAY_MS;

export const PEEK_OFF_CODE = 'share_outside_off';
export const PEEK_NOT_SHAREABLE_CODE = 'not_shareable';
export const PEEK_TOO_MANY_CODE = 'too_many_shares';

export const PEEK_OFF = word('This community has turned sharing outside off.');
export const PEEK_NOT_SHAREABLE = word('Only a post everyone in this community can see can be shared outside.');
export const PEEK_TOO_MANY = word('You have 50 links shared outside. Stop one under Settings, Shared outside, to share another.');
export const PEEK_NOT_A_MEMBER = word('Only a member of this community can share its posts outside.');
export const PEEK_STANDBY = word('This server is a standby copy of the community. Share from its main address.');
export const PEEK_NO_SUCH_SHARE = word('No such link to stop.');

export class PeekError extends Error {
    constructor(readonly status: 400 | 403 | 404 | 429 | 503, readonly code: string, message: string) {
        super(message);
        this.name = 'PeekError';
    }
}

/** Whether members may share outside here now: the community's switch, and no private preview (it shows visitors nothing). */
export function outsideSharingOn(): boolean {
    return getProfileSwitches().shareOutside && !isPrivatePreview();
}

const hashOf = (ticket: string): string => crypto.createHash('sha256').update(ticket, 'utf8').digest('hex');

/**
 * The post as a visitor reads it, or null where a visitor could be shown none: read for nobody in particular (so the
 * public scope only, never one hidden by reports), at its area (`coarse`), with nothing of its people (`guest`), then
 * through guestPost. The read by id adds what a board read checks and a read by id doesn't: on the board now (active,
 * not paused, not taken off, its author's listings shown: posts.ts ON_HOLIDAY_SQL, ENTERPRISE_ON_BOARD_SQL), this
 * community's own, and not an event that has ended or was cancelled.
 */
function visitorsPost(postId: string): MarketplacePost | null {
    const [post] = getPosts(db, { id: postId, coarse: true, guest: true, includeVoters: false });
    if (!post || post.id !== postId) return null;
    if (post.active === false || post.audienceScope && post.audienceScope !== 'public') return null;
    const onBoard = post.status === 'active' || post.status === 'pending' || (post.type === 'poll' && post.status === 'completed');
    if (!onBoard) return null;
    if (post.originNode) return null;
    if (post.type === 'event' && post.eventEndAt && Date.parse(post.eventEndAt) <= Date.now()) return null;
    if (post.type === 'event' && post.eventState === 'cancelled') return null;
    const authorShown = db.prepare(`SELECT 1 FROM posts p LEFT JOIN members m ON m.public_key = p.author_pubkey
                                     WHERE p.id = ? AND p.author_pubkey NOT IN (${ON_HOLIDAY_SQL}) AND ${ENTERPRISE_ON_BOARD_SQL}`).get(postId);
    if (!authorShown) return null;
    return guestPost(post);
}

interface TicketRow { id: string; post_id: string; sharer_pubkey: string; expires_at: string; revoked_at: string | null }

/**
 * The post a ticket opens, as a visitor reads it, or null: every condition of the header, each checked now. `postId` is
 * the one the request names; a ticket for any other post opens nothing.
 */
export function peekPost(postId: unknown, ticket: unknown, now = Date.now()): MarketplacePost | null {
    if (!isPeekPostId(postId) || !isPeekTicket(ticket)) return null;
    if (!outsideSharingOn()) return null;
    const row = db.prepare('SELECT id, post_id, sharer_pubkey, expires_at, revoked_at FROM peek_tickets WHERE ticket_hash = ?')
        .get(hashOf(ticket)) as TicketRow | undefined;
    if (!row || row.post_id !== postId || row.revoked_at !== null || Date.parse(row.expires_at) <= now) return null;
    if (!readsAsMember(db, row.sharer_pubkey)) return null;
    return visitorsPost(postId);
}

/** Whether a ticket opens this post now (the read gate's question): peekPost's answer, without keeping the post. */
export function peekTicketOpens(postId: unknown, ticket: unknown, now = Date.now()): boolean {
    return peekPost(postId, ticket, now) !== null;
}

/**
 * A new link for `sharer` to share `postId` outside: the ticket (handed out once, here, and never again), the row's id
 * and when it runs out. Refused (PeekError) for a sharer who doesn't read as a member, a community with sharing outside
 * off, a post a visitor could not be shown, a standby, and a member with PEEK_TICKETS_LIVE_MAX links open already.
 */
export function makePeekTicket(sharer: string, postId: unknown, now = Date.now()): { ticket: string; id: string; postId: string; expiresAt: string } {
    if (getNodeRole() === 'backup') throw new PeekError(503, 'standby', PEEK_STANDBY);
    if (!readsAsMember(db, sharer)) throw new PeekError(403, 'not_a_member', PEEK_NOT_A_MEMBER);
    if (!outsideSharingOn()) throw new PeekError(403, PEEK_OFF_CODE, PEEK_OFF);
    if (!isPeekPostId(postId) || !visitorsPost(postId)) throw new PeekError(403, PEEK_NOT_SHAREABLE_CODE, PEEK_NOT_SHAREABLE);
    const at = new Date(now).toISOString();
    const ticket = crypto.randomBytes(16).toString('base64url');
    const id = crypto.randomBytes(9).toString('base64url');
    const expiresAt = new Date(now + PEEK_TICKET_DAYS * DAY_MS).toISOString();
    db.transaction(() => {
        // Rows that ran out a month ago go with each new one: the table holds about a month of shares, never more.
        db.prepare('DELETE FROM peek_tickets WHERE expires_at < ?').run(new Date(now - KEEP_AFTER_EXPIRY_MS).toISOString());
        const live = (db.prepare('SELECT COUNT(*) AS c FROM peek_tickets WHERE sharer_pubkey = ? AND expires_at > ? AND revoked_at IS NULL')
            .get(sharer, at) as { c: number }).c;
        if (live >= PEEK_TICKETS_LIVE_MAX) throw new PeekError(429, PEEK_TOO_MANY_CODE, PEEK_TOO_MANY);
        db.prepare('INSERT INTO peek_tickets (id, ticket_hash, post_id, sharer_pubkey, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(id, hashOf(ticket), postId, sharer, at, expiresAt);
    })();
    return { ticket, id, postId, expiresAt };
}

/** The member's own open links, newest first, each with its post's title as it is now (null where the post is gone). */
export function listPeekTickets(sharer: string, now = Date.now()): PeekShare[] {
    const rows = db.prepare(`SELECT t.id, t.post_id, t.created_at, t.expires_at, p.title
                               FROM peek_tickets t LEFT JOIN posts p ON p.id = t.post_id
                              WHERE t.sharer_pubkey = ? AND t.revoked_at IS NULL AND t.expires_at > ?
                              ORDER BY t.created_at DESC LIMIT ?`)
        .all(sharer, new Date(now).toISOString(), PEEK_TICKETS_LIVE_MAX) as Array<{ id: string; post_id: string; created_at: string; expires_at: string; title: string | null }>;
    return rows.map(r => ({ id: r.id, postId: r.post_id, title: r.title ?? null, createdAt: r.created_at, expiresAt: r.expires_at }));
}

/** Stop one of the member's own links now. Another member's, one already stopped or run out, or none: PeekError 404. */
export function stopPeekTicket(sharer: string, id: unknown, now = Date.now()): void {
    if (typeof id !== 'string' || id.length === 0 || id.length > 64) throw new PeekError(400, 'bad_id', PEEK_NO_SUCH_SHARE);
    const at = new Date(now).toISOString();
    const changed = db.prepare('UPDATE peek_tickets SET revoked_at = ? WHERE id = ? AND sharer_pubkey = ? AND revoked_at IS NULL AND expires_at > ?')
        .run(at, id, sharer, at).changes;
    if (changed !== 1) throw new PeekError(404, 'no_such_share', PEEK_NO_SUCH_SHARE);
}

/** Every open link stops now: the owners turned sharing outside off (config/community-shape-write.ts). */
export function stopAllPeekTickets(at: string): number {
    return db.prepare('UPDATE peek_tickets SET revoked_at = ? WHERE revoked_at IS NULL AND expires_at > ?').run(at, at).changes;
}
