import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { KNOWN_FLOOR_DEFAULT, CREDIT_CAP_DEFAULT } from '@beanpool/core';
import { confirmationDialOn, configureKnownFloorBeans, memberKnownGrant, creditCap, CONFIRMATION_DIAL_KEY, CREDIT_CAP_KEY } from '../known-floor.js';
import { getEnterpriseFloor, clearEnterpriseFloorCache } from '../trust.js';

// The known floor on by default (Marty, board, 21 Oct: "Yes, on by default"): no row is on, the owner's 'off' row is off,
// and a node without Beans (the global profile) reads off whatever the row says.

function community(): Database.Database {
    const db = new Database(':memory:');
    db.exec(`
        CREATE TABLE node_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE members (public_key TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'active', credit_frozen INTEGER DEFAULT 0,
            legacy_credit_floor REAL DEFAULT 0);
        CREATE TABLE confirmations (id TEXT PRIMARY KEY, member_pubkey TEXT NOT NULL, entry_id TEXT NOT NULL, confirmed_by TEXT NOT NULL,
            needs_second INTEGER NOT NULL DEFAULT 0, seconded_at DATETIME, revoked_at DATETIME);
        CREATE TABLE known_floor_exceptions (member_pubkey TEXT PRIMARY KEY, amount INTEGER, frozen INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE enterprise_pledges (id TEXT PRIMARY KEY, keeper TEXT NOT NULL, enterprise TEXT NOT NULL, amount REAL NOT NULL,
            pledged_at DATETIME, released_at DATETIME DEFAULT NULL);
    `);
    for (const pk of ['kim', 'una', 'kai', 'bea', 'co', 'known-co']) db.prepare('INSERT INTO members (public_key) VALUES (?)').run(pk);
    db.prepare("INSERT INTO confirmations (id, member_pubkey, entry_id, confirmed_by) VALUES ('c1', 'kim', 'e1', 'ada')").run();
    return db;
}

const setDial = (db: Database.Database, value: string) =>
    db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(CONFIRMATION_DIAL_KEY, value);

describe('the confirmation dial, on by default', () => {
    afterEach(() => configureKnownFloorBeans(null));

    it('reads on with no row, and a confirmed member holds the known floor while an unconfirmed one holds nothing', () => {
        const db = community();
        expect(db.prepare('SELECT COUNT(*) AS n FROM node_config').get()).toEqual({ n: 0 });
        expect(confirmationDialOn(db)).toBe(true);
        expect(memberKnownGrant(db, 'kim')).toBe(KNOWN_FLOOR_DEFAULT);
        expect(memberKnownGrant(db, 'una')).toBe(0);
    });

    it("reads off on the owner's 'off' row, and on on an 'on' row an owner saved before this default", () => {
        const db = community();
        setDial(db, 'off');
        expect(confirmationDialOn(db)).toBe(false);
        expect(memberKnownGrant(db, 'kim')).toBe(0);
        setDial(db, 'on');
        expect(confirmationDialOn(db)).toBe(true);
        expect(memberKnownGrant(db, 'kim')).toBe(KNOWN_FLOOR_DEFAULT);
    });

    it("uses the owner's saved cap only while the dial is on", () => {
        const db = community();
        db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?)').run(CREDIT_CAP_KEY, '3000');
        expect(creditCap(db)).toBe(3000);
        setDial(db, 'off');
        expect(creditCap(db)).toBe(CREDIT_CAP_DEFAULT);
    });

    it('reads off on a node without Beans, whatever the row says, and on again once Beans are', () => {
        const db = community();
        configureKnownFloorBeans(() => false);
        expect(confirmationDialOn(db)).toBe(false);
        expect(memberKnownGrant(db, 'kim')).toBe(0);
        setDial(db, 'on');
        expect(confirmationDialOn(db)).toBe(false);
        db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?)').run(CREDIT_CAP_KEY, '3000');
        expect(creditCap(db)).toBe(CREDIT_CAP_DEFAULT);
        configureKnownFloorBeans(() => true);
        expect(confirmationDialOn(db)).toBe(true);
        configureKnownFloorBeans(null);
        expect(confirmationDialOn(db)).toBe(true);
    });

    it('a database without the tables reads the default, and gives nobody a known grant', () => {
        const db = new Database(':memory:');
        expect(confirmationDialOn(db)).toBe(true);
        expect(memberKnownGrant(db, 'kim')).toBe(0);
        expect(creditCap(db)).toBe(CREDIT_CAP_DEFAULT);
    });
});

describe("an enterprise's floor with the dial on", () => {
    it('is kept while the enterprise has no known pledge: no confirmation can move it until one is written', () => {
        const db = community();
        db.prepare("INSERT INTO enterprise_pledges (id, keeper, enterprise, amount) VALUES ('p1', 'bea', 'co', 300)").run();
        const first = getEnterpriseFloor(db, 'co');
        expect(first.floor).toBe(-300);
        expect(getEnterpriseFloor(db, 'co')).toBe(first);
        // A known pledge is written by a pledge, and every pledge clears its enterprise's floor (state-engine.ts).
        db.prepare("INSERT INTO confirmations (id, member_pubkey, entry_id, confirmed_by) VALUES ('c2', 'kai', 'e2', 'ada')").run();
        db.prepare("INSERT INTO enterprise_pledges (id, keeper, enterprise, amount) VALUES ('known:1', 'kai', 'co', 400)").run();
        clearEnterpriseFloorCache(db, 'co');
        expect(getEnterpriseFloor(db, 'co').floor).toBe(-700);
    });

    it('is read fresh while it has one: a revoked confirmation stops its share at the next read', () => {
        const db = community();
        db.prepare("INSERT INTO confirmations (id, member_pubkey, entry_id, confirmed_by) VALUES ('c2', 'kai', 'e2', 'ada')").run();
        db.prepare("INSERT INTO enterprise_pledges (id, keeper, enterprise, amount) VALUES ('known:1', 'kai', 'known-co', 500)").run();
        expect(getEnterpriseFloor(db, 'known-co').floor).toBe(-500);
        db.prepare("UPDATE confirmations SET revoked_at = '2026-10-21T00:00:00Z' WHERE id = 'c2'").run();
        expect(getEnterpriseFloor(db, 'known-co').floor).toBe(0);
    });
});
