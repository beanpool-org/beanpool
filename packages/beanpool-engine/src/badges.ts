/**
 * Tier badges (Marty, 12 Nov 2026: "tiers badge only"). An owner or admin may give a member a badge, and a genesis invite
 * gives one (apps/server engine/badges.ts writes them): recognition only. A badge gives no credit, so nothing here reads or
 * writes a floor: the tier a member shows is the higher of their badge and what they did (core withBadge, trust.ts).
 *
 *   member_badges    one row per member who holds a badge (Resident, Steward or Elder); no row, no badge
 */
import type Database from 'better-sqlite3';
import { tierIndexForName, type BadgeTier } from '@beanpool/core';
import { prepared } from './statements.js';

type Db = Database.Database;

/** The badge an owner or admin (or a genesis invite) gave this member, or null. */
export function memberBadge(db: Db, pubkey: string): BadgeTier | null {
    let row: { tier: string } | undefined;
    try {
        row = prepared(db, 'SELECT tier FROM member_badges WHERE member_pubkey = ?').get(pubkey) as { tier: string } | undefined;
    } catch {
        // A database without the table (an engine test's own schema) holds no badges.
        return null;
    }
    return row && tierIndexForName(row.tier) > 0 ? row.tier as BadgeTier : null;
}
