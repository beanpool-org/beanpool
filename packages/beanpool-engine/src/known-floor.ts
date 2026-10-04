/**
 * The known floor (community modes slice 4, design §4.2): the community's settings and one member's known grant,
 * read from the node's own tables. Every read tolerates a database without the tables (an engine test, a server from
 * before them): that reads as the dial off, which is today's behaviour.
 *
 *   node_config 'confirmation' = 'on'   the confirmation dial (absent = off)
 *   node_config 'known_floor'           the community's known floor (absent = KNOWN_FLOOR_DEFAULT)
 *   node_config 'credit_cap'            the community's cap (absent = CREDIT_CAP_DEFAULT)
 *   known_floor_exceptions              an admin's exception for one member (amount, or frozen)
 *   confirmations                       the names list's confirmations (#1411); live = not revoked and not awaiting a second
 */
import type Database from 'better-sqlite3';
import { KNOWN_FLOOR_DEFAULT, CREDIT_CAP_DEFAULT, CREDIT_CAP_MAX, knownGrantFor, enterpriseKnownShare, type KnownFloorException } from '@beanpool/core';

type Db = Database.Database;

export const CONFIRMATION_DIAL_KEY = 'confirmation';
export const KNOWN_FLOOR_KEY = 'known_floor';
export const CREDIT_CAP_KEY = 'credit_cap';

function configValue(db: Db, key: string): string | null {
    try {
        const row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(key) as { value: string | null } | undefined;
        return row?.value ?? null;
    } catch {
        return null;
    }
}

function wholeBeans(v: string | null): number | null {
    if (v === null || !/^\d{1,6}$/.test(v)) return null;
    return Number(v);
}

export function confirmationDialOn(db: Db): boolean {
    return configValue(db, CONFIRMATION_DIAL_KEY) === 'on';
}

/** The cap the owner has saved: the stored value within [CREDIT_CAP_DEFAULT, CREDIT_CAP_MAX], else the default. */
export function savedCreditCap(db: Db): number {
    const v = wholeBeans(configValue(db, CREDIT_CAP_KEY));
    if (v === null || v < CREDIT_CAP_DEFAULT || v > CREDIT_CAP_MAX) return CREDIT_CAP_DEFAULT;
    return v;
}

/**
 * The cap every floor uses: the saved cap only while the dial is on. With the dial off it is main's CREDIT_FLOOR_CAP
 * whatever is saved, so a community that never turns the dial on reads exactly main's floors.
 */
export function creditCap(db: Db): number {
    return confirmationDialOn(db) ? savedCreditCap(db) : CREDIT_CAP_DEFAULT;
}

/** The community's known floor, never above its saved cap. */
export function knownFloor(db: Db): number {
    const v = wholeBeans(configValue(db, KNOWN_FLOOR_KEY));
    return Math.min(savedCreditCap(db), v === null ? KNOWN_FLOOR_DEFAULT : v);
}

export function isConfirmed(db: Db, pubkey: string): boolean {
    try {
        const row = db.prepare(
            'SELECT 1 FROM confirmations WHERE member_pubkey = ? AND revoked_at IS NULL AND (needs_second = 0 OR seconded_at IS NOT NULL) LIMIT 1',
        ).get(pubkey);
        return !!row;
    } catch {
        return false;
    }
}

export function knownFloorException(db: Db, pubkey: string): KnownFloorException | null {
    try {
        const row = db.prepare('SELECT amount, frozen FROM known_floor_exceptions WHERE member_pubkey = ?').get(pubkey) as
            { amount: number | null; frozen: number } | undefined;
        return row ? { amount: row.amount, frozen: row.frozen === 1 } : null;
    } catch {
        return null;
    }
}

/** One member's known grant (0 unless the dial is on and they are confirmed). */
export function memberKnownGrant(db: Db, pubkey: string): number {
    if (!confirmationDialOn(db)) return 0;
    return knownGrantFor({
        dialOn: true,
        confirmed: isConfirmed(db, pubkey),
        knownFloor: knownFloor(db),
        cap: creditCap(db),
        exception: knownFloorException(db, pubkey),
    });
}

/**
 * What an enterprise's active, unfrozen keepers' known grants add to its floor (core enterpriseKnownShare): each keeper's
 * half split over every enterprise they keep, so it counts once in all. 0 with the dial off. `exceptKeeper` leaves one
 * keeper out (what the others would still back if they went).
 */
export function enterpriseKnownShareOf(db: Db, enterprisePubkey: string, exceptKeeper?: string): number {
    if (!confirmationDialOn(db)) return 0;
    const keepers = db.prepare(`
        SELECT o.member_pubkey AS pk,
               (SELECT COUNT(*) FROM treasury_operators o2 WHERE o2.member_pubkey = o.member_pubkey) AS kept
        FROM treasury_operators o
        JOIN members m ON m.public_key = o.member_pubkey
        WHERE o.treasury_pubkey = ? AND m.status = 'active' AND COALESCE(m.credit_frozen, 0) = 0
    `).all(enterprisePubkey) as { pk: string; kept: number }[];
    return enterpriseKnownShare(keepers.filter(k => k.pk !== exceptKeeper)
        .map(k => ({ knownGrant: memberKnownGrant(db, k.pk), enterprisesKept: Number(k.kept) })));
}
