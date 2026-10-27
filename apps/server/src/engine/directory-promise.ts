/**
 * The listing promise (DESIGN-global-mothership-fable.md §1.2, slice A2): four lines a community in the public directory
 * makes to the strangers the directory sends to it, carried in its directory push (services/directory-publisher.ts) as
 * `promise`, signed with the rest of the row.
 *
 *   | Line                               | How                                                                          |
 *   |------------------------------------|------------------------------------------------------------------------------|
 *   | Two owners                         | measured: two or more owners whose role acts (engine/node-roles.ts)          |
 *   | A recovery code and backups        | measured: backups are locked to a recovery code (services/sealed-backup.ts), |
 *   |                                    | and snapshots are on (services/snapshot-scheduler.ts) or an off-box          |
 *   |                                    | destination is set (services/offbox-backups.ts)                              |
 *   | Reports looked at within a week    | ticked by an owner: nothing outside can measure it without reading reports   |
 *   | Thirty days' notice before closing | ticked by an owner                                                           |
 *
 * ## Counts and booleans only
 *
 * The push carries `{ v: 1, owners: <how many>, backups: true, reports: true, notice: true }` and nothing else: never an
 * owner's name, key or callsign, never where the backups go. A global node's mirror takes exactly that shape and drops
 * anything else (engine/directory-cache.ts listingPromise), so what this file sends is what a mirror keeps.
 *
 * ## Made once, measured at every push
 *
 * An owner ticks the two lines in Settings → Directory (POST /api/local/admin/directory/promise, routes/settings.ts),
 * kept as node_config `directory_promise`. The other two are measured at every push, and the promise is left out of the
 * row when one fails: a community down to one owner, or whose backups stopped, is "New listing" again at its next push,
 * never "Keeps the listing promise" on an old claim. Why it is left out is in the owners' diagnostics
 * (`directoryPromise`, services/directory-publisher.ts), as `directoryHeldBack` says why the name is (#1935). Nothing
 * here gates anything: a community without the promise is listed, runs and takes members as before (design §0.2 item 2:
 * it orders the directory, never decides who may be in it).
 *
 * ## Also in the push
 *
 *   - `acceptingKnocks`: whether a stranger can ask to join from the directory: the knocks switch on
 *     (config/node-profile.ts), the door not "only admins" (config/door.ts), and an address published (getDirectoryInfo
 *     `publicUrl`): with none the phone has nothing to knock on (apps/native/utils/knock.ts noAddress).
 *   - `closingOn`: the day the community says it closes (Settings → Directory → Leave the directory), or null.
 *
 * The ticks and the day are the community's own settings (config/community-settings.ts): a standby keeps them, and a
 * take-over installs them, so the community a take-over keeps running still makes its promise.
 */
import { db } from '../db/db.js';
import { actingOwnerCount } from './node-roles.js';
import { backupLockState } from '../services/sealed-backup.js';
import { getAutoSnapshotConfig } from '../services/snapshot-scheduler.js';
import { readOffboxSettings } from '../services/offbox-backups.js';
import { getProfileSwitches } from '../config/node-profile.js';
import { getDoor } from '../config/door.js';
import { resolvePublicNodeUrl, PUBLIC_URL_RULES } from '../state-engine.js';
import { closingDay, listingPromise, MAX_CLOSING_DAYS, MAX_PROMISE_OWNERS, type ListingPromise } from './directory-cache.js';
import { knockAnswersForDirectory } from './knocks.js';

export type { ListingPromise };

/** The node_config row: the two ticked lines and the closing day, as JSON. No row: nothing ticked, no day. */
export const DIRECTORY_PROMISE_KEY = 'directory_promise';

/** What an owner set in Settings → Directory. */
export interface PromiseTicks {
    /** "Reports are looked at within a week." */
    reports: boolean;
    /** "Thirty days' notice before closing." */
    notice: boolean;
    /** The day the community says it closes (YYYY-MM-DD), or null. */
    closingOn: string | null;
}

const NO_TICKS: PromiseTicks = { reports: false, notice: false, closingOn: null };

/**
 * A stored row read back: each field only when it is what the route writes, else its default. The closing day passes
 * the route's own check (closingDay: a real date, up to {@link MAX_CLOSING_DAYS} days ahead), so a standby installing
 * its main server's row holds no day the route would refuse, and a push never carries one. A day long past reads back
 * as none, as the push leaves it out anyway. Never throws.
 */
function ticksOf(value: unknown, now: number = Date.now()): PromiseTicks {
    if (typeof value !== 'string' || value.length > 200) return { ...NO_TICKS };
    let v: any;
    try { v = JSON.parse(value); } catch { return { ...NO_TICKS }; }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { ...NO_TICKS };
    return {
        reports: v.reports === true,
        notice: v.notice === true,
        closingOn: closingDay(v.closingOn, now),
    };
}

export function readPromiseTicks(now: number = Date.now()): PromiseTicks {
    const row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(DIRECTORY_PROMISE_KEY) as { value: string | null } | undefined;
    return ticksOf(row?.value, now);
}

/**
 * The row as a standby keeps it from its main server's record (config/community-settings.ts): rewritten from what it
 * says, so it holds the three fields and nothing else. Null when it isn't a row this file wrote.
 */
export function cleanPromiseRow(v: unknown): string | null {
    if (typeof v !== 'string' || v.length > 200) return null;
    try {
        const parsed = JSON.parse(v);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    } catch {
        return null;
    }
    return JSON.stringify(ticksOf(v));
}

/** Today in UTC, as YYYY-MM-DD. */
function today(now: number): string {
    return new Date(now).toISOString().slice(0, 10);
}

/**
 * The closing day the owners set (Settings → Directory → Leave the directory), when it has come: today or before (UTC),
 * read from the stored row itself. readPromiseTicks reads a day more than two days past as none (a push leaves it out),
 * so it can't say a community has closed; this can, for as long as the day is stored. Null: no day, or one still to come.
 * The publisher withdraws the community on that day and pushes no more (services/directory-publisher.ts).
 */
export function closingDayReached(now: number = Date.now()): string | null {
    const row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(DIRECTORY_PROMISE_KEY) as { value: string | null } | undefined;
    if (typeof row?.value !== 'string' || row.value.length > 200) return null;
    let v: any;
    try { v = JSON.parse(row.value); } catch { return null; }
    const day = v && typeof v === 'object' && typeof v.closingOn === 'string' ? v.closingOn : null;
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    const t = Date.parse(`${day}T00:00:00Z`);
    if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== day) return null;
    return day <= today(now) ? day : null;
}

export type SetTicks = { ok: true; ticks: PromiseTicks } | { ok: false; error: string };

/**
 * An owner's change (the route checks who). Each of `reports`, `notice` (true or false) and `closingOn` (a day from
 * today to {@link MAX_CLOSING_DAYS} days ahead, YYYY-MM-DD, or null to clear it) is changed only when sent. Anything
 * else is refused with a sentence and nothing written. Nothing ticked and no day leaves no row.
 */
export function setPromiseTicks(update: { reports?: unknown; notice?: unknown; closingOn?: unknown }, now: number = Date.now()): SetTicks {
    for (const name of ['reports', 'notice'] as const) {
        if (update[name] !== undefined && typeof update[name] !== 'boolean') return { ok: false, error: `${name} must be true or false.` };
    }
    let closingOn: string | null | undefined;
    if (update.closingOn === null || update.closingOn === '') {
        closingOn = null;
    } else if (update.closingOn !== undefined) {
        const day = typeof update.closingOn === 'string' ? closingDay(update.closingOn, now) : null;
        if (!day || day < today(now)) {
            return { ok: false, error: `closingOn must be a day from today to ${MAX_CLOSING_DAYS} days ahead, written YYYY-MM-DD, or null to clear it.` };
        }
        closingOn = day;
    }
    const current = readPromiseTicks(now);
    const next: PromiseTicks = {
        reports: typeof update.reports === 'boolean' ? update.reports : current.reports,
        notice: typeof update.notice === 'boolean' ? update.notice : current.notice,
        closingOn: closingOn !== undefined ? closingOn : current.closingOn,
    };
    publicFields = null;
    if (!next.reports && !next.notice && next.closingOn === null) {
        db.prepare('DELETE FROM node_config WHERE key = ?').run(DIRECTORY_PROMISE_KEY);
    } else {
        db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
            .run(DIRECTORY_PROMISE_KEY, JSON.stringify(next));
    }
    return { ok: true, ticks: next };
}

/** Why the promise is not in the push, each its own line; none when it is. */
export type PromiseGap = 'not_made' | 'one_owner' | 'no_recovery_code' | 'backups_off';

/** What the owners read for each (the diagnostics' `directoryPromise.why`); their screens say it in their own words. */
export const PROMISE_GAP_MESSAGES: Record<PromiseGap, string> = {
    not_made: 'The listing promise is not made yet: an owner ticks "Reports are looked at within a week" and "Thirty days\' notice before closing" in Settings → Directory.',
    one_owner: 'The listing promise needs two owners, and this community has fewer. Make a second person an owner and it is listed with the promise at the next push.',
    no_recovery_code: 'The listing promise needs backups locked to a recovery code, and this community has none. Make a recovery code (Who can unlock this community).',
    backups_off: 'The listing promise needs backups running: scheduled snapshots are off and no off-box destination is set. Turn snapshots on, or add a destination, in Backups.',
};

/** The promise as this node measures it now. */
export interface PromiseStatus {
    /** All four lines hold: the push carries the promise. */
    kept: boolean;
    /** Why not, in the order the owners would fix them; empty when kept. */
    gaps: PromiseGap[];
    /** Owners whose role acts. */
    owners: number;
    /** Backups are locked to a recovery code. */
    backupsLocked: boolean;
    /** Scheduled snapshots are on, or an off-box destination is set. */
    backupsRunning: boolean;
    reports: boolean;
    notice: boolean;
    closingOn: string | null;
}

export function measurePromise(): PromiseStatus {
    const ticks = readPromiseTicks();
    const owners = actingOwnerCount();
    let backupsLocked: boolean;
    try { backupsLocked = backupLockState().locked; } catch { backupsLocked = false; }
    let backupsRunning = getAutoSnapshotConfig().enabled;
    if (!backupsRunning) {
        try { backupsRunning = readOffboxSettings().destinations.length > 0; } catch { backupsRunning = false; }
    }
    const gaps: PromiseGap[] = [];
    if (!ticks.reports || !ticks.notice) gaps.push('not_made');
    if (owners < 2) gaps.push('one_owner');
    if (!backupsLocked) gaps.push('no_recovery_code');
    if (!backupsRunning) gaps.push('backups_off');
    return { kept: gaps.length === 0, gaps, owners, backupsLocked, backupsRunning, ...ticks };
}

/**
 * Whether a stranger can ask to join from the directory: knocks on, the door not "only admins", and the address the push
 * publishes (getDirectoryInfo `publicUrl`, by the same rules) to ask at.
 */
export function acceptingKnocks(): boolean {
    return getProfileSwitches().knocks && getDoor() !== 'admins' && resolvePublicNodeUrl(PUBLIC_URL_RULES.community) !== null;
}

/** The fields the directory push carries, besides what getDirectoryInfo publishes. */
export interface ListingFields {
    promise: ListingPromise | null;
    acceptingKnocks: boolean;
    /** Only while it is still to come (a mirror drops a day long past anyway). */
    closingOn: string | null;
    /** How promptly it answers requests to join (front doors S1; engine/knocks.ts knockAnswersForDirectory: 'none' held 60 days), or null. */
    answers: 'week' | 'slow' | 'none' | null;
}

/** What this community's next push says, and the measurement it came from. */
export function listingFields(now: number = Date.now()): { fields: ListingFields; status: PromiseStatus } {
    const status = measurePromise();
    const promise = status.kept
        ? listingPromise({ v: 1, owners: Math.min(status.owners, MAX_PROMISE_OWNERS), backups: true, reports: true, notice: true })
        : null;
    const closingOn = status.closingOn && status.closingOn >= today(now) ? status.closingOn : null;
    const answers = knockAnswersForDirectory(now);
    return { fields: { promise, acceptingKnocks: acceptingKnocks(), closingOn, answers }, status };
}

const PUBLIC_FIELDS_TTL_MS = 60_000;
let publicFields: { at: number; fields: ListingFields } | null = null;

/**
 * listingFields' fields for the public preview (GET /api/directory/info, unsigned): measured at most once a minute, so
 * an anonymous read never makes the node read its key files on every hit. A tick saved clears it. The push and the
 * owners' screens measure afresh.
 */
export function publicListingFields(now: number = Date.now()): ListingFields {
    if (!publicFields || now - publicFields.at >= PUBLIC_FIELDS_TTL_MS || now < publicFields.at) {
        publicFields = { at: now, fields: listingFields(now).fields };
    }
    return publicFields.fields;
}
