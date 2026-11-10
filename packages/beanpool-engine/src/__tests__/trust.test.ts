import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { usableAllowance, creditAllowance, VOUCH_PRESETS, VOUCH_MAX, isVouchPreset, isBudgetLevel } from '@beanpool/core';
import { PER_COUNTERPARTY_VOLUME_CAP, runWashTradingAnalysis, qualifiedTradeValue, getMemberTrustProfile, roomHeldOf, vouchesFor } from '../trust.js';

describe('beanpool-engine trust', () => {
    it('has constant PER_COUNTERPARTY_VOLUME_CAP set to 500', () => {
        expect(PER_COUNTERPARTY_VOLUME_CAP).toBe(500);
    });

    it('calculates qualified trade value with per-counterparty volume cap in SQLite', () => {
        const db = new Database(':memory:');

        // Create schema
        db.exec(`
            CREATE TABLE members (
                public_key TEXT PRIMARY KEY,
                joined_at TEXT
            );

            CREATE TABLE marketplace_transactions (
                id TEXT PRIMARY KEY,
                buyer_pubkey TEXT,
                seller_pubkey TEXT,
                amount_c REAL,
                status TEXT,
                completed_at TEXT
            );
        `);

        db.prepare(`INSERT INTO members (public_key, joined_at) VALUES ('pub_buyer', '2026-01-01')`).run();
        db.prepare(`INSERT INTO members (public_key, joined_at) VALUES ('pub_seller', '2026-01-01')`).run();

        // Insert completed trade of 1000 credits (above 500 cap)
        db.prepare(`
            INSERT INTO marketplace_transactions (id, buyer_pubkey, seller_pubkey, amount_c, status, completed_at)
            VALUES ('tx1', 'pub_buyer', 'pub_seller', 1000, 'completed', '2026-01-02')
        `).run();

        const buyerVal = qualifiedTradeValue(db, 'pub_buyer');
        expect(buyerVal).toBe(500); // Capped at 500

        const sellerVal = qualifiedTradeValue(db, 'pub_seller');
        expect(sellerVal).toBe(500); // Both sides earn up to cap

        const analysis = runWashTradingAnalysis(db);
        expect(analysis.flaggedPairs.size).toBe(0);
    });
});

// ── Room: the credit line a voucher's vouch or a member's gift gives (DESIGN-invites-and-names-list-amend2-fable.md §6) ──
// The node's own tables (apps/server/src/db/schema.sql), not a copy of them.

const SCHEMA = readFileSync(fileURLToPath(new URL('../../../../apps/server/src/db/schema.sql', import.meta.url)), 'utf8');

function node(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = OFF');
    db.exec(SCHEMA);
    for (const pk of ['jane', 'sam', 'kim', 'ann']) db.prepare("INSERT INTO members (public_key, callsign, joined_at) VALUES (?, ?, '2026-11-01')").run(pk, pk);
    return db;
}
let gift = 0;
const room = (db: Database.Database, from: string, to: string, amount: number, kind: 'vouch' | 'gift' = 'vouch', root = from) =>
    db.prepare("INSERT INTO room_gifts (id, from_pubkey, to_pubkey, root_pubkey, kind, amount_c) VALUES (?, ?, ?, ?, ?, ?)").run(`g${++gift}`, from, to, root, kind, amount);

describe('room held: the credit line people gave a member', () => {
    it('is what they received, less what they gave on; a voucher’s own vouches come from their budget, never their line', () => {
        const db = node();
        room(db, 'jane', 'sam', 50);
        room(db, 'jane', 'sam', 50);
        room(db, 'kim', 'sam', 25);
        room(db, 'sam', 'ann', 30, 'gift', 'jane');
        expect(roomHeldOf(db, 'sam')).toBe(95);
        expect(roomHeldOf(db, 'ann')).toBe(30);
        expect(roomHeldOf(db, 'jane')).toBe(0);
        expect(vouchesFor(db, 'sam')).toEqual([{ voucher: 'jane', amount: 100 }, { voucher: 'kim', amount: 25 }]);
    });

    it('opens the line, deepens the floor within the cap, and never moves the badge', () => {
        const db = node();
        expect(getMemberTrustProfile(db, 'sam')).toMatchObject({ activated: false, floor: 0, roomHeld: 0 });
        room(db, 'jane', 'sam', 100);
        const p = getMemberTrustProfile(db, 'sam');
        expect(p).toMatchObject({ activated: true, floor: -100, roomHeld: 100, knownGrant: 0, tierCredit: 0 });
        expect(p.tier.name).toBe(getMemberTrustProfile(db, 'kim').tier.name);
        for (let i = 0; i < 30; i++) room(db, `v${i}`, 'sam', 100);
        expect(getMemberTrustProfile(db, 'sam').floor).toBe(-2000);
    });

    it('is none while the whole line is frozen', () => {
        const db = node();
        room(db, 'jane', 'sam', 100);
        db.prepare("UPDATE members SET credit_frozen = 1 WHERE public_key = 'sam'").run();
        expect(getMemberTrustProfile(db, 'sam')).toMatchObject({ floor: 0, roomHeld: 0 });
    });

    it('reads 0 on a database from before the table (the boot’s vouching reset reads profiles before schema.sql makes it)', () => {
        const db = new Database(':memory:');
        db.exec("CREATE TABLE members (public_key TEXT PRIMARY KEY, joined_at TEXT, earned_credit_c REAL DEFAULT 0, credit_frozen INTEGER DEFAULT 0, is_treasury INTEGER DEFAULT 0)");
        expect(roomHeldOf(db, 'sam')).toBe(0);
        expect(vouchesFor(db, 'sam')).toEqual([]);
    });

    it('one live offer unlocks room whole, as the known grant; none unlocks none; the rest keeps the bands', () => {
        expect(usableAllowance({ knownGrant: 0, roomHeld: 100, otherAllowance: 0, cap: 2000, liveOffers: 0 })).toBe(0);
        expect(usableAllowance({ knownGrant: 0, roomHeld: 300, otherAllowance: 0, cap: 2000, liveOffers: 1 })).toBe(300);
        expect(usableAllowance({ knownGrant: 1000, roomHeld: 300, otherAllowance: 900, cap: 2000, liveOffers: 1 })).toBe(1500);
        expect(usableAllowance({ knownGrant: 0, otherAllowance: 900, cap: 2000, liveOffers: 1 })).toBe(200);
        expect(creditAllowance({ earned: 100, granted: 0, knownGrant: 0, roomHeld: 2500, cap: 2000 })).toBe(2000);
    });

    it('a vouch is one of four presets, never more than 100; a budget level is 100 to 2,000 in 100s', () => {
        expect([...VOUCH_PRESETS]).toEqual([25, 50, 75, 100]);
        expect(VOUCH_MAX).toBe(100);
        expect([25, 50, 75, 100].every(isVouchPreset)).toBe(true);
        expect([0, 60, 101, 125, '25', 25.5].some(isVouchPreset)).toBe(false);
        expect([100, 500, 1000, 2000].every(isBudgetLevel)).toBe(true);
        expect([0, 50, 150, 2100, 1000.5, '1000'].some(isBudgetLevel)).toBe(false);
    });
});
