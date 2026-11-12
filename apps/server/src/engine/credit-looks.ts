/**
 * The log of credit looks (scratch/fable-design/DESIGN-credit-list-amend-fable.md §5.2, slice C1): one line for each look a
 * giver (an owner, an admin or a voucher) took at one member's credit, on one surface, a UTC day: who looked, whose credit,
 * where (`list`: a page of the People list with Show credit on; `card`: the opened card or sheet), what the looker was then,
 * and the first look's exact time. The key is the first four columns, so "once a day" is the key itself and the write is one
 * `INSERT OR IGNORE` for the page.
 *
 * Written before the answer, in one statement: all of a page's lines or none, and a look that can't be recorded isn't
 * answered (the routes answer 500 with no body). A standby records nothing, so it answers no look (409, as the voucher
 * card does). The log holds no balance and no figure.
 *
 * Every owner and admin reads it (GET /api/credit/looks): grouped by looker and day, the names of one group, and who looked
 * at one member. Nobody else. Reading it is not itself logged: it shows no balance. Kept 12 months on each server, by the
 * manifest's age rule (engine/replication-manifest.ts CREDIT_LOOK_KEPT_DAYS) and {@link pruneOldLooks} on the hourly tidy.
 *
 * Nothing here is a Bean: no `accounts` row, no transfer.
 */
import type { CreditSight } from '@beanpool/core';
import { getMember } from '@beanpool/engine';
import { db } from '../db/db.js';
import { assertPlainTablesWritable } from '../config/node-role.js';
import { CREDIT_LOOK_KEPT_DAYS } from './replication-manifest.js';

export type LookSurface = 'list' | 'card';

const DAY_MS = 24 * 60 * 60 * 1000;
const callsignOf = (pk: string): string => getMember(db, pk)?.callsign ?? '';

/**
 * Records a look at each of `subjects` on `surface`, unless this looker already has that day's line for that person and
 * surface, in ONE statement (all or none). Throws when it can't (a standby: StandbyLedgerError; a failed insert: the
 * database's error): the caller answers nothing. Returns how many lines were new.
 */
export function recordLooks(viewer: string, sight: CreditSight, subjects: readonly string[], surface: LookSurface, at: Date = new Date()): number {
    assertPlainTablesWritable();
    const people = [...new Set(subjects)];
    if (people.length === 0) return 0;
    const iso = at.toISOString();
    const day = iso.slice(0, 10);
    const tuples = people.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
    const params = people.flatMap((s) => [viewer, s, surface, day, sight, iso]);
    return db.prepare(`INSERT OR IGNORE INTO credit_look_log (actor_pubkey, subject_pubkey, surface, day, sight, at) VALUES ${tuples}`).run(...params).changes;
}

export interface LookGroup { actorPubkey: string; callsign: string; day: string; sight: string; people: number }
export interface LookLine { actorPubkey: string; actorCallsign: string; subjectPubkey: string; subjectCallsign: string; surface: string; sight: string; day: string; at: string }

/**
 * What an owner or admin reads: with `actor` and `day`, the people one looker looked at that day; with `member`, who looked at
 * that member; else the groups, newest day first ("@jane · 12 Nov · looked at 30 people").
 */
export function readLooks(opts: { limit: number; offset: number; actor?: string | null; day?: string | null; member?: string | null }) {
    const { limit, offset } = opts;
    if (opts.member || (opts.actor && opts.day)) {
        const where = opts.member ? 'subject_pubkey = ?' : 'actor_pubkey = ? AND day = ?';
        const params = opts.member ? [opts.member] : [opts.actor, opts.day];
        const rows = db.prepare(`SELECT actor_pubkey, subject_pubkey, surface, sight, day, at FROM credit_look_log WHERE ${where}
            ORDER BY day DESC, at DESC, actor_pubkey, subject_pubkey, surface LIMIT ? OFFSET ?`).all(...params, limit, offset) as
            { actor_pubkey: string; subject_pubkey: string; surface: string; sight: string; day: string; at: string }[];
        const looks: LookLine[] = rows.map((r) => ({
            actorPubkey: r.actor_pubkey, actorCallsign: callsignOf(r.actor_pubkey),
            subjectPubkey: r.subject_pubkey, subjectCallsign: callsignOf(r.subject_pubkey),
            surface: r.surface, sight: r.sight, day: r.day, at: r.at,
        }));
        return { looks };
    }
    const rows = db.prepare(`SELECT actor_pubkey, day, MAX(sight) AS sight, COUNT(DISTINCT subject_pubkey) AS people, MIN(at) AS first
        FROM credit_look_log GROUP BY actor_pubkey, day ORDER BY day DESC, first DESC, actor_pubkey LIMIT ? OFFSET ?`).all(limit, offset) as
        { actor_pubkey: string; day: string; sight: string; people: number }[];
    const groups: LookGroup[] = rows.map((r) => ({ actorPubkey: r.actor_pubkey, callsign: callsignOf(r.actor_pubkey), day: r.day, sight: r.sight, people: r.people }));
    return { groups };
}

/** How many different people `actor` looked at in the last `days` days: the count on a voucher's card (§5.2, slice C3). */
export function peopleLookedAt(actor: string, days = 30, now = Date.now()): number {
    const since = new Date(now - days * DAY_MS).toISOString();
    return (db.prepare('SELECT COUNT(DISTINCT subject_pubkey) AS n FROM credit_look_log WHERE actor_pubkey = ? AND at > ?').get(actor, since) as { n: number }).n;
}

/**
 * The hourly tidy (state-engine.ts armMainServerTimers): lines older than the manifest's age rule go, with no tombstone. A
 * standby drops its own after each copy it imports (engine/plain-tables.ts), by the copy's time. Returns how many went.
 */
export function pruneOldLooks(now = Date.now()): number {
    const cutoff = new Date(now - CREDIT_LOOK_KEPT_DAYS * DAY_MS).toISOString();
    return db.prepare('DELETE FROM credit_look_log WHERE at < ?').run(cutoff).changes;
}
