/**
 * Schema upgrade safety, part 2: indexes a booted node's copy lacks, made again by its next boot, and the reads that
 * search them. Each case is a booted node with one index dropped, booted again by the REAL initSchema().
 *
 *  11. friends(friend_pubkey), and the contact lookups search indexes.
 *  16. marketplace_transactions(post_id, status): a listing's open deals are searched, not walked (#1769).
 *
 * (Sections 7, 9, 10 and 12-15 upgraded shapes from before 1.2.36: posts_au and the search index, the members trigger,
 * the area columns, the G5/G6 tables and visitors' rows. The 1.4.0 gate refuses those files (db/schema-gate.ts), and
 * they went with their steps.)
 *
 * The three suites test-schema-upgrade-fresh-shape.ts, test-schema-upgrade-triggers-visitors.ts and
 * test-schema-upgrade-markers-watermarks.ts were one until it took 4m00s-4m56s on CI against the runner's 300 s per
 * suite (killed at 300 s on PR #1479's Test-All run 36997955477). The section numbers are the old suite's; the
 * helpers are in schema-upgrade-test-harness.ts.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-schema-upgrade-triggers-visitors.ts
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { OWNERS_WHO_ADDED_AS_FRIEND_SQL, TRADE_PARTNERS_SQL } from '@beanpool/engine';
import { assert, bootInto, indexes, tmp, runSchemaSuite } from './schema-upgrade-test-harness.js';

runSchemaSuite('indexes a booted node lacks, and the reads that search them', '⭐️ Schema upgrade checks (triggers and visitors) PASSED.', async () => {
    // ── 11. friends(friend_pubkey), and the contact lookups search indexes ─────────────────────────
    // contactVisibleTo's two lookups run on every member-list and profile read, keyed on the VIEWER: who has added
    // them as a friend (ownersWhoAddedAsFriend) and who they have a trade with (tradePartnersOf). friends' primary key
    // leads with owner_pubkey, so the first scanned the whole table on every node from before idx_friends_friend_pubkey
    // (1–2 ms at 50k rows, #1145's review). The fixture is a booted node with that index dropped, holding a friend
    // row; it must boot onto exactly a fresh install's friends indexes, and both lookups, the engine's own SQL, must
    // search an index rather than scan.
    console.log('\n--- 11. idx_friends_friend_pubkey, and the contact lookups search indexes ---');
    {
        const dir = tmp('friends-index');
        assert(bootInto(dir).ok, 'a fresh node boots (the fixture starts from the current schema)');
        const d = new Database(path.join(dir, 'state.db'));
        const freshFriendIndexes = indexes(d, 'friends');
        assert(freshFriendIndexes.includes('idx_friends_friend_pubkey'), `a fresh install has idx_friends_friend_pubkey (friends indexes: ${freshFriendIndexes.join(', ')})`);
        d.pragma('foreign_keys = OFF');
        d.exec('DROP INDEX idx_friends_friend_pubkey');
        d.prepare(`INSERT INTO friends (owner_pubkey, friend_pubkey) VALUES (?, ?)`).run('ee'.repeat(32), 'ff'.repeat(32));
        assert(!indexes(d, 'friends').includes('idx_friends_friend_pubkey'), 'the fixture genuinely lacks the index');
        d.close();

        const result = bootInto(dir);
        assert(result.ok, 'the node from before the index boots');
        if (!result.ok) console.error(result.output.split('\n').slice(-20).join('\n'));
        const after = new Database(path.join(dir, 'state.db'));
        assert(JSON.stringify(indexes(after, 'friends')) === JSON.stringify(freshFriendIndexes),
            `ending up with exactly the friends indexes a fresh install has (${indexes(after, 'friends').join(', ')})`);
        const plan = (sql: string, ...params: string[]): string[] =>
            (after.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as any[]).map(r => String(r.detail));
        const viewer = 'ff'.repeat(32);
        const friendsPlan = plan(OWNERS_WHO_ADDED_AS_FRIEND_SQL, viewer);
        assert(friendsPlan.some(p => /\bUSING (COVERING )?INDEX idx_friends_friend_pubkey\b/.test(p)) && !friendsPlan.some(p => /^SCAN friends\b/.test(p)),
            `"who has added me" searches idx_friends_friend_pubkey (plan: ${friendsPlan.join(' | ')})`);
        const tradePlan = plan(TRADE_PARTNERS_SQL, viewer, viewer);
        assert(tradePlan.some(p => /\bUSING (COVERING )?INDEX idx_marketplace_transactions_buyer_/.test(p))
            && tradePlan.some(p => /\bUSING (COVERING )?INDEX idx_marketplace_transactions_seller_/.test(p))
            && !tradePlan.some(p => /^SCAN marketplace_transactions\b/.test(p)),
            `"who have I traded with" searches the buyer and seller indexes (plan: ${tradePlan.join(' | ')})`);
        after.close();
        assert(bootInto(dir).ok, 'booting it again is a no-op');
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // ── 16. marketplace_transactions(post_id, status), and a listing's open deals are searched (#1769) ─────────────────
    // On a node that reads by area, a listing's pushes also reach both sides of its open deals (#1765), read on every
    // listing event; a removal and a hide ask the same of its held deals. No index led with post_id, so each read
    // searched idx_marketplace_transactions_status_completed for status alone: every open deal on the node, for one
    // listing. The fixture is a booted node with the index dropped, holding open deals on two listings; it must boot onto
    // exactly a fresh install's indexes, and each read must search by the listing.
    console.log('\n--- 16. idx_marketplace_transactions_post_status, and a listing\'s open deals are searched (#1769) ---');
    {
        const OPEN_DEAL_SIDES_SQL = "SELECT buyer_pubkey, seller_pubkey FROM marketplace_transactions WHERE post_id = ? AND status IN ('requested', 'pending')";
        const HOLDS_DEAL_SQL = "SELECT 1 FROM marketplace_transactions WHERE post_id = ? AND status = 'pending' LIMIT 1";
        const dir = tmp('deals-post-index');
        assert(bootInto(dir).ok, 'a fresh node boots (the fixture starts from the current schema)');
        const d = new Database(path.join(dir, 'state.db'));
        const freshDealIndexes = indexes(d, 'marketplace_transactions');
        assert(freshDealIndexes.includes('idx_marketplace_transactions_post_status'),
            `a fresh install has idx_marketplace_transactions_post_status (indexes: ${freshDealIndexes.join(', ')})`);
        d.pragma('foreign_keys = OFF');
        d.exec('DROP INDEX IF EXISTS idx_marketplace_transactions_post_status');
        // A deal of 1 Bean: whole hundredths (amount_c).
        const deal = d.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, amount_c, status) VALUES (?, ?, ?, ?, 100, ?)`);
        for (const [i, post, status] of [[1, 'post-a', 'requested'], [2, 'post-a', 'pending'], [3, 'post-b', 'pending'], [4, 'post-b', 'completed']] as const) {
            deal.run(`deal-${i}`, post, `${i}`.repeat(64), 'ab'.repeat(32), status);
        }
        assert(!indexes(d, 'marketplace_transactions').includes('idx_marketplace_transactions_post_status'), 'the fixture genuinely lacks the index');
        d.close();

        const result = bootInto(dir);
        assert(result.ok, 'the node from before the index boots');
        if (!result.ok) console.error(result.output.split('\n').slice(-20).join('\n'));
        const after = new Database(path.join(dir, 'state.db'));
        assert(JSON.stringify(indexes(after, 'marketplace_transactions')) === JSON.stringify(freshDealIndexes),
            `ending up with exactly the marketplace_transactions indexes a fresh install has (${indexes(after, 'marketplace_transactions').join(', ')})`);
        const plan = (sql: string): string[] =>
            (after.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('post-a') as any[]).map(r => String(r.detail));
        for (const [what, sql] of [["a listing's open deals (both sides)", OPEN_DEAL_SIDES_SQL], ['whether a listing holds a deal', HOLDS_DEAL_SQL]] as const) {
            const p = plan(sql);
            assert(p.some(x => /\bUSING (COVERING )?INDEX idx_marketplace_transactions_post_status \(post_id=\? AND status=\?\)/.test(x))
                && !p.some(x => /^SCAN marketplace_transactions\b/.test(x)),
                `${what} searches by the listing and its status (plan: ${p.join(' | ')})`);
        }
        const sides = after.prepare(OPEN_DEAL_SIDES_SQL).all('post-a') as { buyer_pubkey: string }[];
        assert(sides.map(r => r.buyer_pubkey).sort().join() === ['1'.repeat(64), '2'.repeat(64)].join(), `and reads the same rows (${sides.length} open deal(s) on post-a)`);
        after.close();
        assert(bootInto(dir).ok, 'booting it again is a no-op');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
