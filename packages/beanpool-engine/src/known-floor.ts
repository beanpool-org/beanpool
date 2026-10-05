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
 *
 * The trust profile reads these for every author on a board page, so each statement is compiled once per handle
 * (statements.ts). A missing table throws at the compile, inside the same try, and nothing is kept.
 */
import type Database from 'better-sqlite3';
import { KNOWN_FLOOR_DEFAULT, CREDIT_CAP_DEFAULT, CREDIT_CAP_MAX, knownGrantFor, type KnownFloorException } from '@beanpool/core';
import { prepared } from './statements.js';

type Db = Database.Database;

export const CONFIRMATION_DIAL_KEY = 'confirmation';
export const KNOWN_FLOOR_KEY = 'known_floor';
export const CREDIT_CAP_KEY = 'credit_cap';

function configValue(db: Db, key: string): string | null {
    try {
        const row = prepared(db, 'SELECT value FROM node_config WHERE key = ?').get(key) as { value: string | null } | undefined;
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
        const row = prepared(db,
            'SELECT 1 FROM confirmations WHERE member_pubkey = ? AND revoked_at IS NULL AND (needs_second = 0 OR seconded_at IS NOT NULL) LIMIT 1',
        ).get(pubkey);
        return !!row;
    } catch {
        return false;
    }
}

export function knownFloorException(db: Db, pubkey: string): KnownFloorException | null {
    try {
        const row = prepared(db, 'SELECT amount, frozen FROM known_floor_exceptions WHERE member_pubkey = ?').get(pubkey) as
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
 * A keeper backs an enterprise from their known grant only by a recorded pledge (main's enterprise_pledges, Rule 3), never
 * by a share recomputed on each read: a pledge row whose id starts with this prefix is drawn from the known grant, any other
 * row from earned credit as on main. So a known pledge is locked exactly as a pledge is (release covenant, step-down, unbind).
 *
 * THE BOUND: a confirmed member with known grant G can pledge at most floor(G/2) of it, in all, and every Bean pledged comes
 * off their own known line 1:1. Own usable known line + every enterprise's known backing from them <= G, however many
 * enterprises they keep. Half of G is the most an enterprise can draw (design §4.2's half rate); 1:1 keeps the sum at G.
 */
export const KNOWN_PLEDGE_PREFIX = 'known:';

/**
 * The known part of a keeper's active pledges, across every enterprise (as recorded, before any shrink of G).
 * `extraPledged` (> 0): a known pledge not yet written, summed in the same SUM after the written rows, where its row would
 * land (the highest rowid in the keeper index). SQLite's SUM over REAL is compensated (3.43+), so SUM(rows) + x in JS is not
 * always the double SUM gives once the row is written: at the cent edge a keeper request's row would say yes and Approve no.
 */
export function memberKnownPledged(db: Db, pubkey: string, extraPledged = 0): number {
    try {
        const row = (extraPledged > 0
            ? prepared(db,
                "SELECT COALESCE(SUM(amount), 0) AS total FROM (SELECT amount FROM enterprise_pledges WHERE keeper = ? AND released_at IS NULL AND id LIKE 'known:%' UNION ALL SELECT CAST(? AS REAL))",
            ).get(pubkey, extraPledged)
            : prepared(db,
                "SELECT COALESCE(SUM(amount), 0) AS total FROM enterprise_pledges WHERE keeper = ? AND released_at IS NULL AND id LIKE 'known:%'",
            ).get(pubkey)) as { total: number } | undefined;
        return Number(row?.total || 0);
    } catch {
        return extraPledged;
    }
}

/**
 * How much of a keeper's known pledges counts today: never above half their grant now (0 with the dial off or unconfirmed).
 * `extraPledged` counts a known pledge not yet written, as if it were (a keeper request's check, without a write).
 */
function countedKnownPledged(db: Db, pubkey: string, grant = memberKnownGrant(db, pubkey), extraPledged = 0): { grant: number; pledged: number; counted: number } {
    // No grant (the dial off, or not confirmed): nothing of it counts and no room is left, so the pledges aren't read.
    if (grant === 0) return { grant, pledged: 0, counted: 0 };
    const pledged = memberKnownPledged(db, pubkey, extraPledged);
    return { grant, pledged, counted: Math.min(pledged, Math.floor(grant / 2)) };
}

/** What is left of half a keeper's known grant to pledge. */
export function knownPledgeRoom(db: Db, pubkey: string): number {
    const { grant, pledged } = countedKnownPledged(db, pubkey);
    return Math.max(0, Math.floor(grant / 2) - pledged);
}

/**
 * A member's own known line: their grant less what of it is pledged to enterprises (the bound above). `grant` stands in for
 * their grant now: trust.ts passes the grant they hold unfrozen, so a frozen member's tier is the one their line gives them.
 * `extraPledged`: a known pledge not yet written, counted as if it were (countedKnownPledged).
 */
export function memberUsableKnownGrant(db: Db, pubkey: string, grant?: number, extraPledged = 0): number {
    const { grant: g, counted } = countedKnownPledged(db, pubkey, grant, extraPledged);
    return Math.max(0, g - counted);
}

/**
 * What keepers' known pledges add to an enterprise's floor: each active, unfrozen keeper's known pledges to it, scaled down
 * when their grant has shrunk (dial off, floor lowered, confirmation revoked, an exception) so that across all their
 * enterprises they count at most half the grant they have now. The rows stay: a shrink spend-freezes, it claws nothing back.
 * 0 with the dial off. `exceptKeeper` leaves one keeper out (what the others would still back if they went).
 */
export function enterpriseKnownShareOf(db: Db, enterprisePubkey: string, exceptKeeper?: string): number {
    if (!confirmationDialOn(db)) return 0;
    let rows: { pk: string; amount: number }[];
    try {
        rows = prepared(db, `
            SELECT p.keeper AS pk, SUM(p.amount) AS amount
            FROM enterprise_pledges p
            JOIN members m ON m.public_key = p.keeper
            WHERE p.enterprise = ? AND p.released_at IS NULL AND p.id LIKE 'known:%'
              AND m.status = 'active' AND COALESCE(m.credit_frozen, 0) = 0
            GROUP BY p.keeper
        `).all(enterprisePubkey) as { pk: string; amount: number }[];
    } catch {
        return 0;
    }
    let share = 0;
    for (const r of rows) {
        if (r.pk === exceptKeeper) continue;
        const { pledged, counted } = countedKnownPledged(db, r.pk);
        if (pledged <= 0) continue;
        share += Math.floor(Number(r.amount) * counted / pledged);
    }
    return share;
}
