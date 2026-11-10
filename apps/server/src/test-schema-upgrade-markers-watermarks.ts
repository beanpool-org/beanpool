/**
 * Schema upgrade safety, part 3: a table a booted node's copy lacks is made by its next boot, whole. How every table born
 * since 1.2.36 reaches a kept node's file (schema.sql's CREATE TABLE IF NOT EXISTS; db/schema-gate.ts opens no older one).
 * Each case is a booted node with one table dropped, booted again by the REAL initSchema().
 *
 *  16. Moderation notices kept for the web app.
 *  18. A member's block list kept by the community.
 *
 * (Sections 17 and 19-23 upgraded shapes from before 1.2.36: deleted_by_owner_at, the board standing's fill, the plain
 * tables' unstamped rows, the link treasuries' markers, the releases' owners and the devices' watermark. The 1.4.0 gate
 * refuses those files, and they went with their steps.)
 *
 * The three suites test-schema-upgrade-fresh-shape.ts, test-schema-upgrade-triggers-visitors.ts and
 * test-schema-upgrade-markers-watermarks.ts were one until it took 4m00s-4m56s on CI against the runner's 300 s per
 * suite (killed at 300 s on PR #1479's Test-All run 36997955477). The section numbers are the old suite's; the
 * helpers are in schema-upgrade-test-harness.ts.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-schema-upgrade-markers-watermarks.ts
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { assert, bootInto, columns, indexes, tmp, runSchemaSuite } from './schema-upgrade-test-harness.js';

runSchemaSuite('a table a booted node lacks, made by its next boot', '⭐️ Schema upgrade checks (markers and watermarks) PASSED.', async () => {
    // ── 16. Moderation notices kept for the web app (engine/kept-notices.ts) ───────────────────────────────────────
    // Every node from before this has no moderation_notices table. The fixture is a booted node with it dropped; it must
    // boot onto exactly a fresh install's table (columns and indexes), empty, with its size limits in force.
    console.log('\n--- 16. Legacy node without moderation_notices ---');
    {
        const dir = tmp('legacy-notices');
        assert(bootInto(dir).ok, 'a fresh node boots (the fixture starts from the current schema)');
        const d = new Database(path.join(dir, 'state.db'));
        const fresh = { cols: columns(d, 'moderation_notices'), idx: indexes(d, 'moderation_notices') };
        assert(fresh.cols.length > 0 && fresh.idx.includes('idx_moderation_notices_recipient') && fresh.idx.includes('idx_moderation_notices_updated_at'),
            `a fresh install has the table, read by member and copied by updated_at (${fresh.idx.join(', ')})`);
        d.exec('DROP TABLE IF EXISTS moderation_notices;');
        const gone = (d.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'moderation_notices'`).get() as any).n;
        assert(gone === 0, 'the fixture genuinely lacks it');
        d.close();

        const result = bootInto(dir);
        assert(result.ok, 'the older node boots');
        if (!result.ok) console.error(result.output.split('\n').slice(-20).join('\n'));
        const after = new Database(path.join(dir, 'state.db'));
        assert(JSON.stringify(columns(after, 'moderation_notices')) === JSON.stringify(fresh.cols) && JSON.stringify(indexes(after, 'moderation_notices')) === JSON.stringify(fresh.idx),
            `moderation_notices: exactly the columns and indexes a fresh install has (${columns(after, 'moderation_notices').join(', ')})`);
        assert((after.prepare('SELECT COUNT(*) AS n FROM moderation_notices').get() as any).n === 0, 'and empty');
        const ins = (id: string, title: string, body: string, data: string) => {
            try {
                after.prepare('INSERT INTO moderation_notices (id, recipient, title, body, data) VALUES (?, ?, ?, ?, ?)').run(id, 'ab'.repeat(32), title, body, data);
                return true;
            } catch { return false; }
        };
        assert(ins('n1', 'Your post was removed', 'Your post was removed by the community\'s moderators.', '{"kind":"post_removed"}'), 'a notice is stored');
        const longTitle = ins('n2', 'T'.repeat(81), 'Body', '{}');
        const longBody = ins('n3', 'Title', 'B'.repeat(401), '{}');
        const longData = ins('n4', 'Title', 'Body', `{"k":"${'d'.repeat(300)}"}`);
        const emptyBody = ins('n5', 'Title', '', '{}');
        assert(!longTitle && !longBody && !longData && !emptyBody,
            `its size limits hold: title 80, body 400, data 300, and never empty (${longTitle}, ${longBody}, ${longData}, ${emptyBody})`);
        after.close();
        assert(bootInto(dir).ok, 'booting it again is a no-op');
        fs.rmSync(dir, { recursive: true, force: true });
    }


    // ── 18. A member's block list kept by the community (engine/member-blocks.ts) ──────────────────────────────────────
    // Every node from before it has no member_blocks table. The fixture is a booted node with it dropped, holding a member;
    // it must boot onto exactly a fresh install's table (columns and indexes), empty, with its key and owner checks in force.
    console.log('\n--- 18. Legacy node without member_blocks ---');
    {
        const dir = tmp('legacy-member-blocks');
        assert(bootInto(dir).ok, 'a fresh node boots (the fixture starts from the current schema)');
        const d = new Database(path.join(dir, 'state.db'));
        const fresh = { cols: columns(d, 'member_blocks'), idx: indexes(d, 'member_blocks') };
        assert(fresh.cols.join() === 'blocked_pubkey,created_at,owner_pubkey,updated_at'
            && fresh.idx.includes('idx_member_blocks_updated_at') && fresh.idx.includes('idx_member_blocks_blocked'),
            `a fresh install has the table, copied by updated_at and found by the key blocked (${fresh.cols.join(', ')}; ${fresh.idx.join(', ')})`);
        d.exec('DROP TABLE IF EXISTS member_blocks;');
        const owner = 'ab'.repeat(32);
        d.prepare(`INSERT INTO members (public_key, callsign, joined_at) VALUES (?, 'Legacy', '2025-01-01T00:00:00.000Z')`).run(owner);
        const gone = (d.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'member_blocks'`).get() as any).n;
        assert(gone === 0, 'the fixture genuinely lacks it');
        d.close();

        const result = bootInto(dir);
        assert(result.ok, 'the older node boots');
        if (!result.ok) console.error(result.output.split('\n').slice(-20).join('\n'));
        const after = new Database(path.join(dir, 'state.db'));
        assert(JSON.stringify(columns(after, 'member_blocks')) === JSON.stringify(fresh.cols) && JSON.stringify(indexes(after, 'member_blocks')) === JSON.stringify(fresh.idx),
            `member_blocks: exactly the columns and indexes a fresh install has (${columns(after, 'member_blocks').join(', ')})`);
        assert((after.prepare('SELECT COUNT(*) AS n FROM member_blocks').get() as any).n === 0, 'and empty');
        const ins = (o: string, b: string) => {
            try {
                after.prepare('INSERT INTO member_blocks (owner_pubkey, blocked_pubkey) VALUES (?, ?)').run(o, b);
                return true;
            } catch { return false; }
        };
        assert(ins(owner, 'cd'.repeat(32)), 'a block is stored');
        const twice = ins(owner, 'cd'.repeat(32));
        const self = ins(owner, owner);
        const upper = ins(owner, 'CD'.repeat(32));
        const short = ins(owner, 'cd'.repeat(31));
        const badOwner = ins('AB'.repeat(32), 'ef'.repeat(32));
        assert(!twice && !self && !upper && !short && !badOwner,
            `one row a pair, never the owner's own key, and only keys in the one spelling (${twice}, ${self}, ${upper}, ${short}, ${badOwner})`);
        after.close();
        assert(bootInto(dir).ok, 'booting it again is a no-op');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
