/**
 * Moderation notices kept for the member they are for (#1175's deciding pass). Every notice moderation-notices.ts
 * sends goes live to the member's open sockets and out as a push; the web app has no push, so a web member whose post
 * was hidden or removed, or whose posting was paused, while the tab was closed was never told. Each notice is also
 * kept here, one row per recipient, and the web app shows the ones its member has not seen the next time it opens
 * (routes/notices.ts).
 *
 * - For one member only: they read their own (the signer, never a parameter) and mark their own seen. Kept only for a
 *   member who can read it here: not an enterprise's key, not a closed account.
 * - Exactly what the live notice carried: its title, body and data (the kind, the post). `tell()` never names who
 *   acted or who reported, so nothing here does either.
 * - Bounded: a member's newest KEPT_NOTICES.perMember, and nothing older than KEPT_NOTICES.maxAgeDays. A new notice
 *   trims its member's at once; the hourly hygiene job (state-engine.ts runMarketplaceHygiene, main server only) takes
 *   the old ones. The read never returns one past either bound, whenever the tidy last ran. The schema's CHECKs cap a
 *   row: title 80 characters, body 400, data 300.
 * - Gone with the member on a prune or a self-deletion, moved to the new key on a re-key.
 *
 * ## A standby holds them too (mergeReplicatedNotices)
 *
 * A notice is member-facing state nothing re-creates: after a take-over, a web member must still hear what the old main
 * server kept for them, and not hear again what they had seen. So the rows travel to a standby
 * (SyncPayload.moderationNotices), watermarked on `updated_at`, which a new notice, a seen mark and a re-key stamp; every
 * deletion (the bounds, a prune, a self-deletion) writes a `moderation_notices` tombstone keyed by the notice's id, which
 * is never used again. A standby therefore holds the main server's rows within the same bounds, and a server that takes
 * over starts tidying at its first hourly run.
 */
import crypto from 'node:crypto';
import { db, writeTombstone } from '../db/db.js';
import type { SyncModerationNotice } from '@beanpool/engine';

export const KEPT_NOTICES = { perMember: 50, maxAgeDays: 60 } as const;
/** The longest title, body and data (its JSON) a kept notice may hold, in characters: the schema's CHECKs. */
export const NOTICE_LIMITS = { title: 80, body: 400, data: 300 } as const;
/** At most this many ids in one "seen" mark: more than a member can hold. */
export const MARK_SEEN_MAX_IDS = 100;

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
const cutoff = (now: number) => iso(now - KEPT_NOTICES.maxAgeDays * DAY_MS);

export interface KeptNotice {
    id: string;
    title: string;
    body: string;
    /** What the live notice showed it with: always 'info' for moderation. */
    severity: 'info';
    /** The notice's own data (kind, postId, outcome, reason, count), as the live notice carried it. */
    data: Record<string, unknown>;
    createdAt: string;
    seenAt: string | null;
}

interface NoticeRow { id: string; recipient: string; title: string; body: string; data: string; created_at: string; seen_at: string | null; updated_at: string }

function parseData(raw: string): Record<string, unknown> {
    try {
        const v = JSON.parse(raw);
        return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
        return {};
    }
}

const toNotice = (r: NoticeRow): KeptNotice => ({
    id: r.id, title: r.title, body: r.body, severity: 'info', data: parseData(r.data), createdAt: r.created_at, seenAt: r.seen_at,
});

/** A member who can read their notices here: a member row, not an enterprise's key, not a closed account. */
function canHold(pubkey: string): boolean {
    return !!db.prepare("SELECT 1 FROM members WHERE public_key = ? AND COALESCE(is_treasury, 0) = 0 AND status != 'pruned'").get(pubkey);
}

/** Deletes these notices, each with its tombstone, so a standby deletes them too. */
function deleteNotices(ids: string[]): void {
    const del = db.prepare('DELETE FROM moderation_notices WHERE id = ?');
    for (const id of ids) {
        del.run(id);
        writeTombstone('moderation_notices', id);
    }
}

/** A member's notices past their newest KEPT_NOTICES.perMember. */
function overTheCap(recipient: string): string[] {
    return (db.prepare(`SELECT id FROM moderation_notices WHERE recipient = ?
                        ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?`)
        .all(recipient, KEPT_NOTICES.perMember) as { id: string }[]).map(r => r.id);
}

/**
 * The stamp for a change to a row: later than the row's own, even in the millisecond it was written, because a standby
 * keeps its copy on a tie and would keep the notice unseen.
 */
function laterStamp(updatedAt: string, now: number): string {
    const stamped = Date.parse(updatedAt);
    return iso(Number.isFinite(stamped) && stamped >= now ? stamped + 1 : now);
}

/**
 * Keeps one notice for one member, and trims their notices to the newest KEPT_NOTICES.perMember. Returns its id, or
 * null when it is not kept: the recipient is not a member who can read it here, or a field is past the schema's limit
 * (the notices moderation-notices.ts writes are far inside them). Never throws: a notice that can't be kept still goes
 * out live and as a push.
 */
export function keepNotice(recipient: string, title: string, body: string, data: Record<string, unknown>, now: number = Date.now()): string | null {
    try {
        let json = JSON.stringify(data ?? {});
        if (json === undefined) json = '{}';
        if (!title || !body || title.length > NOTICE_LIMITS.title || body.length > NOTICE_LIMITS.body || json.length > NOTICE_LIMITS.data) {
            console.warn('[Notices] A notice past the kept limits was not kept (it still went out live and as a push).');
            return null;
        }
        if (!canHold(recipient)) return null;
        const id = crypto.randomUUID();
        const at = iso(now);
        db.transaction(() => {
            db.prepare('INSERT INTO moderation_notices (id, recipient, title, body, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
                .run(id, recipient, title, body, json, at, at);
            deleteNotices(overTheCap(recipient));
        })();
        return id;
    } catch (e: any) {
        console.warn('[Notices] Could not keep a notice:', e?.message || e);
        return null;
    }
}

/**
 * A member's own notices, oldest first, within both bounds (the newest KEPT_NOTICES.perMember, none older than
 * KEPT_NOTICES.maxAgeDays, whenever the tidy last ran). `unseenOnly`: those they have not marked seen.
 */
export function listKeptNotices(recipient: string, opts: { unseenOnly?: boolean } = {}, now: number = Date.now()): KeptNotice[] {
    const rows = db.prepare(`SELECT * FROM moderation_notices WHERE recipient = ? AND created_at >= ?
                             ${opts.unseenOnly ? 'AND seen_at IS NULL' : ''}
                             ORDER BY created_at DESC, rowid DESC LIMIT ?`)
        .all(recipient, cutoff(now), KEPT_NOTICES.perMember) as NoticeRow[];
    return rows.reverse().map(toNotice);
}

/**
 * Marks the member's own notices seen. An id that is not theirs, or already seen, changes nothing. Returns how many
 * this marked. Stamped, so a standby gets the mark.
 */
export function markKeptNoticesSeen(recipient: string, ids: readonly string[], now: number = Date.now()): number {
    const unique = [...new Set(ids)].slice(0, MARK_SEEN_MAX_IDS);
    const find = db.prepare('SELECT updated_at FROM moderation_notices WHERE id = ? AND recipient = ? AND seen_at IS NULL');
    const mark = db.prepare('UPDATE moderation_notices SET seen_at = ?, updated_at = ? WHERE id = ? AND recipient = ? AND seen_at IS NULL');
    return db.transaction(() => {
        let marked = 0;
        for (const id of unique) {
            const row = find.get(id, recipient) as { updated_at: string } | undefined;
            if (!row) continue;
            marked += mark.run(iso(now), laterStamp(row.updated_at, now), id, recipient).changes;
        }
        return marked;
    })();
}

/** A prune or a self-deletion: the member's notices go with them. */
export function dropKeptNoticesOf(pubkey: string): void {
    db.transaction(() => {
        const ids = (db.prepare('SELECT id FROM moderation_notices WHERE recipient = ?').all(pubkey) as { id: string }[]).map(r => r.id);
        deleteNotices(ids);
    })();
}

/** A re-key (`completeRekey`, engine/member-wizards.ts, inside its transaction): the member's notices move to the new key, stamped. */
export function moveKeptNotices(oldKey: string, newKey: string, now: number = Date.now()): void {
    db.transaction(() => {
        const rows = db.prepare('SELECT id, updated_at FROM moderation_notices WHERE recipient = ?').all(oldKey) as { id: string; updated_at: string }[];
        const move = db.prepare('UPDATE moderation_notices SET recipient = ?, updated_at = ? WHERE id = ?');
        for (const r of rows) move.run(newKey, laterStamp(r.updated_at, now), r.id);
        deleteNotices(overTheCap(newKey));
    })();
}

/**
 * The bounds, for every member at once: deletes each notice older than KEPT_NOTICES.maxAgeDays and each past its
 * member's newest KEPT_NOTICES.perMember, with their tombstones, in one transaction. Returns how many went. On the main
 * server only (the hourly hygiene job): a standby takes the deletions from its copy.
 */
export function tidyKeptNotices(now: number = Date.now()): number {
    return db.transaction(() => {
        const old = (db.prepare('SELECT id FROM moderation_notices WHERE created_at < ?').all(cutoff(now)) as { id: string }[]).map(r => r.id);
        deleteNotices(old);
        const over = (db.prepare(`SELECT id FROM (
                                      SELECT id, ROW_NUMBER() OVER (PARTITION BY recipient ORDER BY created_at DESC, rowid DESC) AS n
                                        FROM moderation_notices)
                                  WHERE n > ?`).all(KEPT_NOTICES.perMember) as { id: string }[]).map(r => r.id);
        deleteNotices(over);
        return old.length + over.length;
    })();
}

// ── on a standby ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface NoticeMerge { written: number; kept: number; skipped: number; invalid: number }

const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/**
 * The main server's notices as a copy carries them (SyncPayload.moderationNotices), merged into this standby's database
 * inside the import's transaction (engine/sync.ts), after the members. Per notice, the newer `updated_at` wins, and
 * everything the main server's row says is taken as it is: recipient (a re-key moved it), and when it was seen.
 *
 * - A notice for someone this database has no member row for is skipped: nobody here could read it.
 * - A notice this database has a tombstone for was deleted, and ids are never used again: it stays deleted.
 * - A row that is malformed or past the schema's limits, or that this database refuses for any reason, is left out and
 *   counted. It never fails the copy it came in.
 */
export function mergeReplicatedNotices(rows: unknown): NoticeMerge {
    const merge: NoticeMerge = { written: 0, kept: 0, skipped: 0, invalid: 0 };
    if (!Array.isArray(rows) || rows.length === 0) return merge;
    const memberExists = db.prepare('SELECT 1 FROM members WHERE public_key = ?');
    const current = db.prepare('SELECT updated_at FROM moderation_notices WHERE id = ?');
    const deleted = db.prepare("SELECT 1 FROM tombstones WHERE table_name = 'moderation_notices' AND row_key = ?");
    const upsert = db.prepare(`INSERT INTO moderation_notices (id, recipient, title, body, data, created_at, seen_at, updated_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                               ON CONFLICT(id) DO UPDATE SET
                                   recipient = excluded.recipient, title = excluded.title, body = excluded.body, data = excluded.data,
                                   created_at = excluded.created_at, seen_at = excluded.seen_at, updated_at = excluded.updated_at`);
    db.transaction(() => {
        for (const raw of rows) {
            const n = raw as Partial<SyncModerationNotice> | null;
            if (!n || !isText(n.id, 64) || !isText(n.recipient, 128) || !isText(n.title, NOTICE_LIMITS.title) || !isText(n.body, NOTICE_LIMITS.body)
                || typeof n.data !== 'string' || n.data.length > NOTICE_LIMITS.data || !isText(n.createdAt, 40) || !isText(n.updatedAt, 40)
                || !(n.seenAt === null || n.seenAt === undefined || isText(n.seenAt, 40))) {
                merge.invalid++;
                continue;
            }
            if (!memberExists.get(n.recipient) || deleted.get(n.id)) { merge.skipped++; continue; }
            const here = current.get(n.id) as { updated_at: string } | undefined;
            if (here && here.updated_at >= n.updatedAt) { merge.kept++; continue; }
            try {
                upsert.run(n.id, n.recipient, n.title, n.body, n.data, n.createdAt, n.seenAt ?? null, n.updatedAt);
                merge.written++;
            } catch (e: any) {
                console.warn(`[Notices] A copied notice could not be stored here, left out: ${e?.message || e}`);
                merge.invalid++;
            }
        }
    })();
    return merge;
}
