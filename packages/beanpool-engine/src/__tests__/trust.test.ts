import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { PER_COUNTERPARTY_VOLUME_CAP, runWashTradingAnalysis, qualifiedTradeValue } from '../trust.js';

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
                credits REAL,
                status TEXT,
                completed_at TEXT
            );
        `);

        db.prepare(`INSERT INTO members (public_key, joined_at) VALUES ('pub_buyer', '2026-01-01')`).run();
        db.prepare(`INSERT INTO members (public_key, joined_at) VALUES ('pub_seller', '2026-01-01')`).run();

        // Insert completed trade of 1000 credits (above 500 cap)
        db.prepare(`
            INSERT INTO marketplace_transactions (id, buyer_pubkey, seller_pubkey, credits, status, completed_at)
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
