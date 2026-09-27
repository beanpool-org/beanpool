/**
 * Unit/integration tests for getAdminQueue utility (apps/server/src/engine/admin-queue.ts).
 *
 * Asserts proper calculation of queue items for node admin and moderator roles across reports,
 * disputes, suspensions, removals, and unclean shutdowns, and the suspensions label with formal Decisions on and off.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-admin-queue.ts
 */

import { initStateEngine } from './state-engine.js';
import { db } from './db/db.js';
import { getAdminQueue, DISPUTE_MIN_DAYS } from './engine/admin-queue.js';
import { setShutdownStatusForTesting } from './engine/shutdown-recovery.js';
import { NODE_PROFILE_KEY } from './config/node-profile.js';

let run = 0;
let passed = 0;

function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        process.exitCode = 1;
    }
}

function main() {
    console.log('Running getAdminQueue tests...\n');

    // Initialize state engine to set up SQLite schema
    initStateEngine();

    // Reset shutdown status
    setShutdownStatusForTesting({ uncleanShutdown: false });

    // Seed dummy members for FK constraints
    const reporterPk = 'r'.repeat(64);
    const targetPk = 't'.repeat(64);
    const buyerPk = 'b'.repeat(64);
    const sellerPk = 's'.repeat(64);

    for (const pk of [reporterPk, targetPk, buyerPk, sellerPk]) {
        db.prepare(`
            INSERT OR IGNORE INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
            VALUES (?, 'user', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')
        `).run(pk);
    }

    // 1. Initial empty state
    const emptyQueue = getAdminQueue();
    assert(emptyQueue.total === 0, 'empty queue returns total = 0');
    assert(emptyQueue.items.length === 0, 'empty queue returns items = []');

    const emptyModQueue = getAdminQueue({ forModerator: true });
    assert(emptyModQueue.total === 0, 'empty moderator queue returns total = 0');

    // 2. Add pending abuse reports
    db.prepare(`
        INSERT INTO abuse_reports (id, reporter_pubkey, target_pubkey, target_post_id, reason, status, created_at)
        VALUES ('rep_1', ?, ?, 'post_123', 'spam', 'pending', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `).run(reporterPk, targetPk);
    db.prepare(`
        INSERT INTO abuse_reports (id, reporter_pubkey, target_pubkey, reason, status, created_at)
        VALUES ('rep_2', ?, ?, 'harassment', NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `).run(reporterPk, targetPk);
    db.prepare(`
        INSERT INTO abuse_reports (id, reporter_pubkey, target_pubkey, target_post_id, reason, status, created_at)
        VALUES ('rep_3', ?, ?, 'post_456', 'resolved report', 'resolved', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `).run(reporterPk, targetPk);

    let q = getAdminQueue();
    assert(q.total === 2, 'reports queue total counts pending or null status reports');
    const repItem = q.items.find(i => i.kind === 'reports');
    assert(repItem !== undefined && repItem.count === 2, 'reports item count is 2');
    assert(repItem?.settingsPath === '/settings#section=moderation', 'reports section settingsPath is correct');

    let modQ = getAdminQueue({ forModerator: true });
    assert(modQ.total === 2 && modQ.items.length === 1, 'moderator queue includes pending reports');

    // 3. Stalled marketplace trade disputes
    // Recent transaction (should not be counted)
    db.prepare(`
        INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at)
        VALUES ('tx_recent', 'post_1', ?, ?, 100, 'pending', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `).run(buyerPk, sellerPk);
    // Stalled transaction (> DISPUTE_MIN_DAYS ago)
    const oldDate = new Date(Date.now() - (DISPUTE_MIN_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
        INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at)
        VALUES ('tx_stalled', 'post_2', ?, ?, 200, 'pending', ?)`
    ).run(buyerPk, sellerPk, oldDate);

    q = getAdminQueue();
    const disputeItem = q.items.find(i => i.kind === 'disputes');
    assert(disputeItem !== undefined && disputeItem.count === 1, 'disputes item counts stalled trades');
    assert(disputeItem?.settingsPath === '/settings#section=disputes', 'disputes settingsPath is correct');

    // 4. Emergency suspensions & pending removals in decisions table
    const closesAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
        INSERT INTO decisions (id, author_pubkey, title, description, touches, effect, franchise, status, closes_at, created_at)
        VALUES ('dec_susp', ?, 'Emergency Suspension', 'desc', 'member', 'keep_suspension', '1m1v', 'open', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `).run(reporterPk, closesAt);
    db.prepare(`
        INSERT INTO decisions (id, author_pubkey, title, description, touches, effect, franchise, status, closes_at, created_at)
        VALUES ('dec_rem', ?, 'Removal Grace Period', 'desc', 'member', 'remove_member', '1m1v', 'execution_pending_grace', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `).run(reporterPk, closesAt);

    q = getAdminQueue();
    const suspItem = q.items.find(i => i.kind === 'suspensions');
    assert(suspItem !== undefined && suspItem.count === 1, 'suspensions item counts open keep_suspension decisions');
    const remItem = q.items.find(i => i.kind === 'removals');
    assert(remItem !== undefined && remItem.count === 1, 'removals item counts execution_pending_grace decisions');
    assert(q.total === 5, 'admin queue total reflects reports + disputes + suspensions + removals (2+1+1+1=5)');
    assert(suspItem?.label === 'Emergency suspensions the community is voting on',
        `with Decisions on, the suspensions label says the community is voting (got ${JSON.stringify(suspItem?.label)})`);

    // 4b. Formal Decisions switched off (the global profile, or the operator's override): an emergency suspension opens
    // no vote and lifts by itself after 7 days. The label says so; what is counted, and where it lands, do not change.
    const setDecisions = (value: 'true' | 'false') =>
        db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
            .run(`${NODE_PROFILE_KEY}.decisions`, value);
    setDecisions('false');
    q = getAdminQueue();
    const offItem = q.items.find(i => i.kind === 'suspensions');
    assert(offItem?.label === 'Emergency suspensions in their 7 days',
        `with Decisions off, the suspensions label says no vote, only their 7 days (got ${JSON.stringify(offItem?.label)})`);
    assert(!/vot/i.test(offItem?.label ?? 'vote'), 'with Decisions off, the suspensions label mentions no vote');
    assert(offItem?.count === 1 && offItem.section === 'decisions' && offItem.settingsPath === '/settings#section=decisions',
        'with Decisions off, the suspensions count, section and settingsPath are unchanged');
    assert(q.total === 5, 'with Decisions off, the admin queue total is unchanged (5)');
    setDecisions('true');
    q = getAdminQueue();
    assert(q.items.find(i => i.kind === 'suspensions')?.label === 'Emergency suspensions the community is voting on',
        'with Decisions switched back on, the suspensions label says the community is voting again');
    db.prepare('DELETE FROM node_config WHERE key = ?').run(`${NODE_PROFILE_KEY}.decisions`);

    // 5. Unclean shutdown item
    setShutdownStatusForTesting({ uncleanShutdown: true, acknowledged: false });
    q = getAdminQueue();
    const shutdownItem = q.items.find(i => i.kind === 'unclean_shutdown');
    assert(shutdownItem !== undefined && shutdownItem.count === 1, 'unclean_shutdown item is present when unacknowledged');
    assert(shutdownItem?.settingsPath === '/settings#section=home', 'unclean_shutdown settingsPath is correct');
    assert(q.total === 6, 'admin queue total includes unclean shutdown item');

    // Acknowledged shutdown item
    setShutdownStatusForTesting({ uncleanShutdown: true, acknowledged: true });
    q = getAdminQueue();
    assert(!q.items.some(i => i.kind === 'unclean_shutdown'), 'unclean_shutdown item excluded when acknowledged');

    // 6. Verify moderator queue filtering with all queue types populated
    modQ = getAdminQueue({ forModerator: true });
    assert(modQ.total === 2, 'moderator queue total is strictly 2 (only reports counted)');
    assert(modQ.items.length === 1 && modQ.items[0].kind === 'reports', 'moderator queue contains only reports item');

    console.log(`\n${passed}/${run} getAdminQueue tests passed.`);
    process.exit(process.exitCode ?? 0);
}

main();
