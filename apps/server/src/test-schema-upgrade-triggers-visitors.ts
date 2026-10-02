/**
 * Schema upgrade safety, part 2: triggers and indexes a live node's copy lacks, the tables through G6, and visitors' rows.
 * Each case is a booted node rolled back to an older shape, booted again by the REAL initSchema().
 *
 *  7. The unguarded posts_au, replaced on boot, and posts_fts rebuilt exactly once (#878).
 *  9. members_touch_updated_at gains moderation_muted_until (G3).
 *  10. A person's coarse area and the posts distance index (G4).
 *  11. friends(friend_pubkey), and the contact lookups search indexes.
 *  12. The communities directory cache and place watches (G5).
 *  13. Requests to join (G6).
 *  14. Visitors' rows (members.is_visitor).
 *  15. A standby leaves the marking to its main server.
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
import { fileURLToPath } from 'node:url';
import { OWNERS_WHO_ADDED_AS_FRIEND_SQL, TRADE_PARTNERS_SQL } from '@beanpool/engine';
import { assert, bootInto, columns, indexes, tmp, runSchemaSuite } from './schema-upgrade-test-harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

runSchemaSuite('triggers, indexes, the tables through G6, and visitors', '⭐️ Schema upgrade checks (triggers and visitors) PASSED.', async () => {
    // ── 7. The unguarded posts_au, replaced on boot, and posts_fts rebuilt exactly once (#878) ─────────
    // Live nodes hold the old trigger, which fired a second time inside posts_touch_updated_at's nested UPDATE
    // and could leave posts_fts out of step. `CREATE TRIGGER IF NOT EXISTS` cannot replace it, so db.ts drops
    // it before the exec; and a one-time rebuild repairs whatever the old trigger left behind. The fixture is
    // a fully-booted node rolled back to the old trigger with a deliberately corrupted index.
    console.log('\n--- 7. Legacy posts_au + a desynced posts_fts ---');
    {
        const OLD_POSTS_AU = `CREATE TRIGGER posts_au AFTER UPDATE ON posts BEGIN
    INSERT INTO posts_fts(posts_fts, rowid, title, description, search_keywords)
    VALUES ('delete', old.rowid, old.title, old.description, old.search_keywords);
    INSERT INTO posts_fts(rowid, title, description, search_keywords)
    VALUES (new.rowid, new.title, new.description, new.search_keywords);
END`;
        const GUARD = /WHEN\s+OLD\.title\s+IS\s+NOT\s+NEW\.title/i;
        const auSql = (d: Database.Database): string =>
            (d.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='posts_au'`).get() as any)?.sql ?? '';
        const ftsHealthy = (d: Database.Database): boolean => {
            try { d.exec(`INSERT INTO posts_fts(posts_fts, rank) VALUES('integrity-check', 1)`); return true; } catch { return false; }
        };

        const dir = tmp('legacy-posts-au');
        assert(bootInto(dir).ok, 'a fresh node boots (the fixture starts from the current schema)');
        const POSTS = 5000;
        const d = new Database(path.join(dir, 'state.db'));
        assert(GUARD.test(auSql(d)), 'a fresh install gets the guarded posts_au');
        assert((d.pragma('user_version', { simple: true }) as number) >= 4, 'and is marked as rebuilt, so it never rebuilds again');

        d.pragma('foreign_keys = OFF');
        d.exec(`DROP TRIGGER posts_au; ${OLD_POSTS_AU};`);
        d.pragma('user_version = 3');
        const pk = 'aa'.repeat(32);
        d.prepare(`INSERT INTO members (public_key, callsign, joined_at) VALUES (?, 'Legacy', '2025-01-01T00:00:00.000Z')`).run(pk);
        const ins = d.prepare(`INSERT INTO posts (id, type, category, title, description, author_pubkey, search_keywords)
                               VALUES (?, 'offer', 'food', ?, 'Grown without sprays in the back paddock', ?, 'food')`);
        d.transaction(() => { for (let i = 0; i < POSTS; i++) ins.run(`legacy-${i}`, `Heirloom tomatoes batch ${i}`, pk); })();
        // Corrupt the index the way the old trigger could: an entry for text the row does not hold.
        const rowid = (d.prepare(`SELECT rowid FROM posts WHERE id = 'legacy-7'`).get() as any).rowid;
        d.prepare(`INSERT INTO posts_fts(rowid, title, description, search_keywords) VALUES (?, 'ghostword', '', '')`).run(rowid);
        assert(!GUARD.test(auSql(d)), 'the fixture holds the OLD unguarded posts_au');
        assert(!ftsHealthy(d), 'and a posts_fts that no longer matches posts');
        d.close();

        const first = bootInto(dir);
        assert(first.ok, 'the legacy node boots');
        if (!first.ok) console.error(first.output.split('\n').slice(-20).join('\n'));
        assert(/Replacing posts_au/.test(first.output), 'the boot replaces posts_au');
        const took = first.output.match(/Rebuilt posts_fts \((\d+)ms\)/);
        assert(!!took, `and rebuilds posts_fts, once (${took?.[1] ?? '?'}ms for ${POSTS} posts)`);
        // Generous: measured at tens of ms. A rebuild that took seconds on boot would want rethinking.
        assert(!!took && Number(took[1]) < 5000, 'the rebuild is cheap enough to sit on the boot path');

        const after = new Database(path.join(dir, 'state.db'));
        assert(GUARD.test(auSql(after)), 'posts_au now carries the guard');
        assert(ftsHealthy(after), 'posts_fts agrees with posts again');
        assert((after.prepare(`SELECT COUNT(*) c FROM posts_fts WHERE posts_fts MATCH 'ghostword'`).get() as any).c === 0,
            'the ghost entry is gone');
        assert((after.prepare(`SELECT COUNT(*) c FROM posts_fts WHERE posts_fts MATCH 'heirloom'`).get() as any).c === POSTS,
            'and every real post is still found');
        // The collision itself, on the upgraded node: a title change that leaves updated_at alone (so the touch
        // trigger fires), longer than everything indexed, which the old trigger turned into SQLITE_CORRUPT_VTAB.
        const filler = Array.from({ length: POSTS * 4 + 10 }, (_, i) => `w${i}`).join(' ');
        let threw: string | null = null;
        try { after.prepare(`UPDATE posts SET title = ? WHERE id = 'legacy-7'`).run(`Heirloom tomatoes relabelled ${filler}`); }
        catch (e: any) { threw = e.code ?? e.message; }
        assert(threw === null, `a colliding title edit on the upgraded node is accepted${threw ? ` (threw ${threw})` : ''}`);
        assert(ftsHealthy(after), 'and the index still agrees afterwards');
        after.close();

        const second = bootInto(dir);
        assert(second.ok, 'the node boots again');
        assert(!/Rebuilt posts_fts|Replacing posts_au/.test(second.output),
            'and the second boot neither replaces the trigger nor rebuilds — the migration is one-time');
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // ── 9. members_touch_updated_at gains moderation_muted_until (G3) ───────────────────────────────
    // A write that sets only the mute has to move updated_at, or delta sync never carries it to a standby.
    // `CREATE TRIGGER IF NOT EXISTS` can't widen a live node's whitelist, so db.ts drops the trigger before the
    // exec on every boot. The fixture is a booted node rolled back to the whitelist without the column.
    console.log('\n--- 9. Legacy members_touch_updated_at without moderation_muted_until ---');
    {
        const touchSql = (d: Database.Database): string =>
            (d.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='members_touch_updated_at'`).get() as any)?.sql ?? '';
        const dir = tmp('legacy-members-touch');
        assert(bootInto(dir).ok, 'a fresh node boots (the fixture starts from the current schema)');
        const d = new Database(path.join(dir, 'state.db'));
        const current = touchSql(d);
        const old = current.replace(/,\s*moderation_muted_until\b/, '');
        assert(/\bmoderation_muted_until\b/.test(current) && !/\bmoderation_muted_until\b/.test(old),
            'a fresh install lists moderation_muted_until in members_touch_updated_at, and the fixture takes it out');
        d.exec(`DROP TRIGGER members_touch_updated_at; ${old};`);
        const pk = 'cc'.repeat(32);
        d.prepare(`INSERT INTO members (public_key, callsign, joined_at, updated_at) VALUES (?, 'Legacy', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`).run(pk);
        d.close();

        const result = bootInto(dir);
        assert(result.ok, 'the legacy node boots');
        if (!result.ok) console.error(result.output.split('\n').slice(-20).join('\n'));
        const after = new Database(path.join(dir, 'state.db'));
        assert(/\bmoderation_muted_until\b/.test(touchSql(after)), 'and its trigger lists moderation_muted_until again');
        after.prepare(`UPDATE members SET moderation_muted_until = '9999-12-31T23:59:59.999Z' WHERE public_key = ?`).run(pk);
        const touched = (after.prepare('SELECT updated_at FROM members WHERE public_key = ?').get(pk) as any)?.updated_at;
        assert(touched > '2025-01-01T00:00:00.000Z', `an UPDATE that sets only moderation_muted_until moves updated_at (${touched})`);
        after.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // ── 10. A person's coarse area and the posts distance index (G4) ───────────────────────────────
    // Every node from before G4: members without area_lat / area_lng / area_updated_at, a members_touch_updated_at that
    // doesn't list them, and posts without idx_posts_lat_lng. The fixture is a booted node rolled back to that shape,
    // holding a member. It must boot onto exactly a fresh install's members columns and posts indexes, with the area
    // NULL on the member it had, and a write of the area alone must move updated_at (so delta sync carries it).
    console.log('\n--- 10. Legacy members without the area, posts without idx_posts_lat_lng (G4) ---');
    {
        const AREA = ['area_lat', 'area_lng', 'area_updated_at'];
        const touchSql = (d: Database.Database): string =>
            (d.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='members_touch_updated_at'`).get() as any)?.sql ?? '';
        const dir = tmp('legacy-g4');
        assert(bootInto(dir).ok, 'a fresh node boots (the fixture starts from the current schema)');
        const d = new Database(path.join(dir, 'state.db'));
        const freshMembers = columns(d, 'members');
        const freshPostIndexes = indexes(d, 'posts');
        const current = touchSql(d);
        const old = current.replace(/,\s*area_lat,\s*area_lng,\s*area_updated_at\b/, '');
        assert(AREA.every(c => freshMembers.includes(c)) && freshPostIndexes.includes('idx_posts_lat_lng')
            && AREA.every(c => new RegExp(`\\b${c}\\b`).test(current)) && !/\barea_/.test(old),
            'a fresh install has the area columns, idx_posts_lat_lng and a trigger listing the area; the fixture takes all three out');
        d.pragma('foreign_keys = OFF');
        d.exec(`DROP TRIGGER members_touch_updated_at; DROP INDEX idx_posts_lat_lng;
                ALTER TABLE members DROP COLUMN area_lat; ALTER TABLE members DROP COLUMN area_lng; ALTER TABLE members DROP COLUMN area_updated_at;
                ${old};`);
        const pk = 'dd'.repeat(32);
        d.prepare(`INSERT INTO members (public_key, callsign, joined_at, updated_at) VALUES (?, 'Legacy', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`).run(pk);
        assert(!AREA.some(c => columns(d, 'members').includes(c)) && !indexes(d, 'posts').includes('idx_posts_lat_lng'),
            'the fixture genuinely lacks the area columns and the index');
        d.close();

        const result = bootInto(dir);
        assert(result.ok, 'the pre-G4 node boots');
        if (!result.ok) console.error(result.output.split('\n').slice(-20).join('\n'));
        const after = new Database(path.join(dir, 'state.db'));
        assert(JSON.stringify(columns(after, 'members')) === JSON.stringify(freshMembers), 'ending up with exactly the members columns a fresh install has');
        assert(JSON.stringify(indexes(after, 'posts')) === JSON.stringify(freshPostIndexes), 'and exactly its posts indexes, idx_posts_lat_lng included');
        assert(AREA.every(c => new RegExp(`\\b${c}\\b`).test(touchSql(after))), 'its members_touch_updated_at lists the area again');
        const row = after.prepare('SELECT area_lat, area_lng, area_updated_at FROM members WHERE public_key = ?').get(pk) as any;
        assert(row && row.area_lat === null && row.area_lng === null && row.area_updated_at === null, 'the member it already had has no area');
        after.prepare('UPDATE members SET area_lat = -28.6, area_lng = 153.5 WHERE public_key = ?').run(pk);
        const touched = (after.prepare('SELECT updated_at FROM members WHERE public_key = ?').get(pk) as any)?.updated_at;
        assert(touched > '2025-01-01T00:00:00.000Z', `an UPDATE that sets only the area moves updated_at (${touched})`);
        let refused = false;
        try { after.prepare('UPDATE members SET area_lat = 91 WHERE public_key = ?').run(pk); } catch { refused = true; }
        assert(refused, 'and the column refuses a latitude past the pole');
        after.close();
        assert(bootInto(dir).ok, 'booting it again is a no-op');
        fs.rmSync(dir, { recursive: true, force: true });
    }

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

    // ── 12. The communities directory cache and place watches (G5) ─────────────────────────────────────────────────
    // Every node from before G5 has neither table. The fixture is a booted node with both dropped, holding a member; it
    // must boot onto exactly a fresh install's two tables (columns and indexes), empty, with their checks in force.
    console.log('\n--- 12. Legacy node without directory_cache and place_watches (G5) ---');
    {
        const G5_TABLES = ['directory_cache', 'place_watches'];
        const dir = tmp('legacy-g5');
        assert(bootInto(dir).ok, 'a fresh node boots (the fixture starts from the current schema)');
        const d = new Database(path.join(dir, 'state.db'));
        const freshShape = G5_TABLES.map(t => ({ t, cols: columns(d, t), idx: indexes(d, t) }));
        assert(freshShape.every(s => s.cols.length > 0), `a fresh install has both tables (${JSON.stringify(freshShape.map(s => [s.t, s.cols.length]))})`);
        d.pragma('foreign_keys = OFF');
        d.exec('DROP TABLE directory_cache; DROP TABLE place_watches;');
        const pk = 'ab'.repeat(32);
        d.prepare(`INSERT INTO members (public_key, callsign, joined_at, updated_at) VALUES (?, 'Legacy', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`).run(pk);
        const gone = (d.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('directory_cache', 'place_watches')`).get() as any).n;
        assert(gone === 0, 'the fixture genuinely lacks both tables');
        d.close();

        const result = bootInto(dir);
        assert(result.ok, 'the pre-G5 node boots');
        if (!result.ok) console.error(result.output.split('\n').slice(-20).join('\n'));
        const after = new Database(path.join(dir, 'state.db'));
        for (const s of freshShape) {
            assert(JSON.stringify(columns(after, s.t)) === JSON.stringify(s.cols) && JSON.stringify(indexes(after, s.t)) === JSON.stringify(s.idx),
                `${s.t}: exactly the columns and indexes a fresh install has (${columns(after, s.t).join(', ')})`);
        }
        const empty = G5_TABLES.every(t => (after.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n === 0);
        assert(empty, 'both empty: a local node keeps them empty, the global node\'s mirror fills one');
        after.prepare(`INSERT INTO place_watches (id, pubkey, lat, lng, radius_km, created_at) VALUES ('w1', ?, -28.6, 153.6, 50, '2026-09-26T00:00:00.000Z')`).run(pk);
        let dup = false;
        try { after.prepare(`INSERT INTO place_watches (id, pubkey, lat, lng, radius_km, created_at) VALUES ('w2', ?, -28.6, 153.6, 80, '2026-09-26T00:00:00.000Z')`).run(pk); } catch { dup = true; }
        let wide = false;
        try { after.prepare(`INSERT INTO place_watches (id, pubkey, lat, lng, radius_km, created_at) VALUES ('w3', ?, -27.5, 153.0, 500, '2026-09-26T00:00:00.000Z')`).run(pk); } catch { wide = true; }
        let offEarth = false;
        try { after.prepare(`INSERT INTO directory_cache (community_key, lat, lng, first_seen_at, updated_at) VALUES ('k', 91, 0, 'x', 'x')`).run(); } catch { offEarth = true; }
        assert(dup && wide && offEarth, `the checks hold: one watch per member per cell, a radius of at most 200 km, no place off the Earth (${dup}, ${wide}, ${offEarth})`);
        after.close();
        assert(bootInto(dir).ok, 'booting it again is a no-op');
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // ── 13. Requests to join (G6) ────────────────────────────────────────────────────────────────────────────────────
    // Every node from before G6 has no join_requests table. The fixture is a booted node with it dropped; it must boot
    // onto exactly a fresh install's table (columns and indexes), empty, with its rules in force.
    console.log('\n--- 13. Legacy node without join_requests (G6) ---');
    {
        const dir = tmp('legacy-g6');
        assert(bootInto(dir).ok, 'a fresh node boots (the fixture starts from the current schema)');
        const d = new Database(path.join(dir, 'state.db'));
        const fresh = { cols: columns(d, 'join_requests'), idx: indexes(d, 'join_requests') };
        assert(fresh.cols.length > 0 && fresh.idx.includes('idx_join_requests_one_open'), `a fresh install has the table and its one-open-knock index (${fresh.idx.join(', ')})`);
        d.exec('DROP TABLE join_requests;');
        const gone = (d.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'join_requests'`).get() as any).n;
        assert(gone === 0, 'the fixture genuinely lacks it');
        d.close();

        const result = bootInto(dir);
        assert(result.ok, 'the pre-G6 node boots');
        if (!result.ok) console.error(result.output.split('\n').slice(-20).join('\n'));
        const after = new Database(path.join(dir, 'state.db'));
        assert(JSON.stringify(columns(after, 'join_requests')) === JSON.stringify(fresh.cols) && JSON.stringify(indexes(after, 'join_requests')) === JSON.stringify(fresh.idx),
            `join_requests: exactly the columns and indexes a fresh install has (${columns(after, 'join_requests').join(', ')})`);
        assert((after.prepare('SELECT COUNT(*) AS n FROM join_requests').get() as any).n === 0, 'and empty');
        const pk = 'cd'.repeat(32);
        const ins = (id: string, status: string, decidedAt: string | null, code: string | null) => {
            try {
                after.prepare(`INSERT INTO join_requests (id, pubkey, callsign, message, status, decided_at, invite_code) VALUES (?, ?, 'Knocker', 'hi', ?, ?, ?)`)
                    .run(id, pk, status, decidedAt, code);
                return true;
            } catch { return false; }
        };
        assert(ins('k1', 'pending', null, null), 'a pending knock is stored');
        const second = ins('k2', 'pending', null, null);
        const oddStatus = ins('k3', 'maybe', '2026-09-26T00:00:00.000Z', null);
        const approvedNoInvite = ins('k4', 'approved', '2026-09-26T00:00:00.000Z', null);
        const pendingDecided = ins('k5', 'pending', '2026-09-26T00:00:00.000Z', null);
        assert(!second && !oddStatus && !approvedNoInvite && !pendingDecided,
            `the rules hold: one open knock per key, a known status, an approval always names its invite, a pending knock has no decision (${second}, ${oddStatus}, ${approvedNoInvite}, ${pendingDecided})`);
        assert(ins('k6', 'declined', '2026-09-26T00:00:00.000Z', null), 'a declined knock beside the open one is fine');
        after.close();
        assert(bootInto(dir).ok, 'booting it again is a no-op');
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // ── 14. Visitors' rows (members.is_visitor) ─────────────────────────────────────────────────────────────────────
    // Every node from before it has no is_visitor column, and holds visitors' rows (a DM or a transfer to a key with no
    // account, a federation visitor) that read as members. The fixture is a booted node with the column and its
    // one-time marker taken away, seeded with a row of every kind a live node can hold. The upgrade adds the column,
    // marks exactly the rows with no record of joining and no sign of use as a member, stamps them for delta sync, and
    // never runs again.
    console.log('\n--- 14. Legacy node without members.is_visitor ---');
    {
        const dir = tmp('legacy-visitors');
        assert(bootInto(dir).ok, 'a fresh node boots (the fixture starts from the current schema)');
        const d = new Database(path.join(dir, 'state.db'));
        const freshMembers = columns(d, 'members');
        const freshMemberIndexes = indexes(d, 'members');
        assert(freshMembers.includes('is_visitor') && freshMemberIndexes.includes('idx_members_member_keys'),
            'a fresh install has members.is_visitor, and the index of the members\' own keys');
        // As the node runs (db.ts): rows may name an inviter this node has no row for ('genesis', 'open:google').
        d.pragma('foreign_keys = OFF');
        // And from before members' photos left their rows (member_photos): a photo inline in members.avatar_url, which the
        // boot moves out before it marks the visitors, so row 24's photo still reads as a sign of use as a member.
        d.exec(`DROP TRIGGER members_touch_updated_at; DROP INDEX idx_members_member_keys; ALTER TABLE members DROP COLUMN is_visitor;
                DROP TABLE member_photos; ALTER TABLE members DROP COLUMN avatar_ref; ALTER TABLE members DROP COLUMN avatar_bytes;
                ALTER TABLE members ADD COLUMN avatar_url TEXT;
                DELETE FROM node_config WHERE key = 'migration_mark_visitors_v1';`);
        assert(!columns(d, 'members').includes('is_visitor'), 'the fixture genuinely lacks the column');
        const OLD = '2025-01-01T00:00:00.000Z';
        const key = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
        const genesisKey = key(1);
        const seed = (n: number, cols: Record<string, unknown> = {}) => {
            const all: Record<string, unknown> = { public_key: key(n), callsign: `Row${n}`, joined_at: OLD, updated_at: OLD, ...cols };
            const names = Object.keys(all);
            d.prepare(`INSERT INTO members (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...names.map(k => all[k]));
            return key(n);
        };
        // Visitors: no record of joining, and never used as a member here.
        const visitors: Record<string, string> = {
            'a DM or a transfer to a key with no account (Visitor-…)': seed(10, { callsign: 'Visitor-0a0a0a0a' }),
            'a federation visitor, with its home community': seed(11, { callsign: 'RemoteRay', home_node_url: 'https://peer.example.test' }),
            'a visitor whose row was later closed': seed(12, { status: 'pruned' }),
            'a visitor written with empty strings for inviter and code': seed(13, { invited_by: '', invite_code: '' }),
        };
        // Members: each has a record of joining, or a sign of use as a member here.
        const members: Record<string, string> = {
            'the genesis member': seed(1, { invited_by: 'genesis', invite_code: 'genesis' }),
            'a member who joined with an invite': seed(20, { invited_by: genesisKey, invite_code: 'INV-ABCD-EFGH' }),
            'a member who joined with an offline ticket': seed(21, { invited_by: genesisKey, invite_code: '0123456789abcdef' }),
            'a member who joined through the open door': seed(22, { invited_by: 'open:google' }),
            'an enterprise (no key holds it)': seed(23, { is_treasury: 1 }),
            'a visitor who redeemed an invite before this version and set a photo': seed(24, { avatar_url: 'data:image/png;base64,iVBORw0KGgo=' }),
            'a row with a profile edit': seed(25, { profile_updated_at: OLD }),
            'a row with a bio': seed(26, { bio: 'I grow tomatoes' }),
            'a row with contact details': seed(27, { contact_value: 'row27@example.test' }),
            'a row that made an invite': seed(28),
            'a row that used an invite code': seed(29),
            'a row with a node role': seed(30),
            'a row with a member_joined line in the feed': seed(31),
        };
        d.prepare(`INSERT INTO invite_codes (code, created_by, created_at, used_by) VALUES ('INV-ROW28-MADE', ?, ?, NULL)`).run(key(28), OLD);
        d.prepare(`INSERT INTO invite_codes (code, created_by, created_at, used_by) VALUES ('INV-ROW29-USED', ?, ?, ?)`).run(genesisKey, OLD, key(29));
        d.prepare(`INSERT INTO node_roles (member_pubkey, role, granted_by) VALUES (?, 'moderator', 'genesis')`).run(key(30));
        d.prepare(`INSERT INTO activity_feed (event_type, actor_pubkey) VALUES ('member_joined', ?)`).run(key(31));
        d.prepare(`INSERT INTO open_joins (member_pubkey, provider, join_hash) VALUES (?, 'google', 'hash-row22')`).run(key(22));
        d.close();

        const result = bootInto(dir);
        assert(result.ok, 'the node from before is_visitor boots');
        if (!result.ok) console.error(result.output.split('\n').slice(-20).join('\n'));
        assert(/Visitors' rows marked: 4\b/.test(result.output) && /kept as members, with no record of joining but used as a member here: 5\b/.test(result.output),
            `the boot says how many it marked and how many ambiguous rows it kept as members (${(result.output.match(/Visitors' rows marked[^\n]*/) || [''])[0].slice(0, 160)})`);
        const after = new Database(path.join(dir, 'state.db'));
        assert(JSON.stringify(columns(after, 'members')) === JSON.stringify(freshMembers), 'members: exactly the columns a fresh install has');
        assert(JSON.stringify(indexes(after, 'members')) === JSON.stringify(freshMemberIndexes),
            `members: exactly the indexes a fresh install has (${indexes(after, 'members').join(', ')})`);
        const flag = (pk: string) => (after.prepare('SELECT is_visitor, updated_at FROM members WHERE public_key = ?').get(pk) as any);
        for (const [label, pk] of Object.entries(visitors)) {
            const r = flag(pk);
            assert(r.is_visitor === 1 && r.updated_at > OLD, `marked a visitor, and stamped for delta sync: ${label} (${r.is_visitor}, ${r.updated_at})`);
        }
        for (const [label, pk] of Object.entries(members)) {
            const r = flag(pk);
            assert(r.is_visitor === 0 && r.updated_at === OLD, `left a member, untouched: ${label} (${r.is_visitor})`);
        }
        const system = after.prepare("SELECT is_visitor FROM members WHERE public_key = 'SYSTEM'").get() as any;
        assert(!system || system.is_visitor === 0, 'the SYSTEM account is left alone');
        assert(!!after.prepare("SELECT 1 FROM node_config WHERE key = 'migration_mark_visitors_v1'").get(), 'the one-time marker is written');
        // The trigger is back and lists the column, so a promotion reaches a standby by delta sync.
        const fed = visitors['a federation visitor, with its home community'];
        after.prepare("UPDATE members SET updated_at = ? WHERE public_key = ?").run(OLD, fed);
        after.prepare("UPDATE members SET is_visitor = 0 WHERE public_key = ?").run(fed);
        assert(flag(fed).updated_at > OLD, `members_touch_updated_at stamps a change of is_visitor (${flag(fed).updated_at})`);
        // A row with no record of joining written after the upgrade is not marked by a later boot: the pass ran once.
        const late = key(40);
        after.prepare(`INSERT INTO members (public_key, callsign, joined_at, updated_at) VALUES (?, 'LateRow', ?, ?)`).run(late, OLD, OLD);
        after.close();
        assert(bootInto(dir).ok, 'booting it again is a no-op');
        const again = new Database(path.join(dir, 'state.db'), { readonly: true });
        assert((again.prepare('SELECT is_visitor FROM members WHERE public_key = ?').get(late) as any).is_visitor === 0,
            'the pass runs once: a later boot marks nobody');
        again.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // ── 15. A standby leaves the marking to its main server ─────────────────────────────────────────────────────────
    // A standby's copy lacks some of what the rule reads (profile_updated_at isn't imported; invite_codes and the activity
    // feed don't replicate; node_roles only arrive with a take-over), so a standby boot marks nobody and writes no marker.
    // Its main server's marks reach it by delta sync, with the main's word that they are made, and the import then writes
    // the marker (test-suspended-and-visitor-reads §6). Promoted without that word (its main server predates the column),
    // it runs the pass at its first boot as the main server, on what it holds; with it, the main server's marks stand.
    console.log('\n--- 15. A standby leaves the marking to its main server ---');
    {
        const OLD = '2025-01-01T00:00:00.000Z';
        const MARKER = "SELECT value FROM node_config WHERE key = 'migration_mark_visitors_v1'";
        const key = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
        const seed = (d: Database.Database, n: number, cols: Record<string, unknown> = {}) => {
            const all: Record<string, unknown> = { public_key: key(n), callsign: `Row${n}`, joined_at: OLD, updated_at: OLD, ...cols };
            const names = Object.keys(all);
            d.prepare(`INSERT INTO members (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...names.map(k => all[k]));
            return key(n);
        };
        // What a take-over's "role" step writes (services/takeover.ts): the role in local-config.json, over NODE_ROLE.
        const promote = (dir: string) => {
            const file = path.join(dir, 'local-config.json');
            const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : {};
            fs.writeFileSync(file, JSON.stringify({ ...config, nodeRole: 'primary' }, null, 2));
        };
        const STANDBY = { NODE_ROLE: 'backup' };

        // A standby from before the column, copying a main server from before it too.
        const dir = tmp('standby-visitors');
        assert(bootInto(dir).ok, 'a fresh node boots (the fixture starts from the current schema)');
        let d = new Database(path.join(dir, 'state.db'));
        d.pragma('foreign_keys = OFF');
        d.exec(`DROP TRIGGER members_touch_updated_at; DROP INDEX idx_members_member_keys; ALTER TABLE members DROP COLUMN is_visitor;
                DELETE FROM node_config WHERE key = 'migration_mark_visitors_v1';`);
        const visitor = seed(d, 10, { callsign: 'Visitor-0a0a0a0a' });
        const member = seed(d, 20, { invited_by: key(1), invite_code: 'INV-ABCD-EFGH' });
        d.close();
        const standbyBoot = bootInto(dir, STANDBY);
        assert(standbyBoot.ok, 'the standby from before is_visitor boots');
        if (!standbyBoot.ok) console.error(standbyBoot.output.split('\n').slice(-20).join('\n'));
        d = new Database(path.join(dir, 'state.db'), { readonly: true });
        const flag = (db: Database.Database, pk: string) => db.prepare('SELECT is_visitor, updated_at FROM members WHERE public_key = ?').get(pk) as { is_visitor: number; updated_at: string };
        assert(columns(d, 'members').includes('is_visitor'), 'the standby has the column');
        assert(flag(d, visitor).is_visitor === 0 && flag(d, visitor).updated_at === OLD, `a standby boot marks nobody, and stamps nothing (is_visitor ${flag(d, visitor).is_visitor})`);
        assert(!d.prepare(MARKER).get(), 'a standby boot writes no marker, so the pass is left for a promotion');
        assert(!/Visitors' rows marked/.test(standbyBoot.output), 'a standby boot logs no marks');
        d.close();
        assert(bootInto(dir, STANDBY).ok, 'the standby boots again');
        d = new Database(path.join(dir, 'state.db'), { readonly: true });
        assert(flag(d, visitor).is_visitor === 0 && !d.prepare(MARKER).get(), 'a second standby boot marks nobody and writes no marker either');
        d.close();
        // Promoted: NODE_ROLE=backup stays in its .env; the take-over's local-config.json says primary.
        promote(dir);
        const promotedBoot = bootInto(dir, STANDBY);
        assert(promotedBoot.ok, 'the promoted standby boots as the main server');
        d = new Database(path.join(dir, 'state.db'), { readonly: true });
        assert(flag(d, visitor).is_visitor === 1 && flag(d, visitor).updated_at > OLD, `a promoted standby whose main server never marked runs the pass: the visitor is marked (is_visitor ${flag(d, visitor).is_visitor})`);
        assert(flag(d, member).is_visitor === 0 && flag(d, member).updated_at === OLD, '…and the member left alone');
        assert(!!d.prepare(MARKER).get() && /Visitors' rows marked: 1\b/.test(promotedBoot.output),
            `…the marker is written and the boot says what it marked (${(promotedBoot.output.match(/Visitors' rows marked[^\n]*/) || [''])[0].slice(0, 120)})`);
        d.close();
        fs.rmSync(dir, { recursive: true, force: true });

        // A standby holding its main server's marks: the main server marked Vi (the mark copied), and kept Al as a member on
        // evidence the standby doesn't hold (a profile edit, an invite made, a code used or a feed line), so Al's copy
        // shows no record of joining and no sign of use. The import wrote the marker with the marks.
        const dir2 = tmp('standby-marks-copied');
        const freshStandby = bootInto(dir2, STANDBY);
        assert(freshStandby.ok, 'a fresh standby boots');
        d = new Database(path.join(dir2, 'state.db'));
        assert(!d.prepare(MARKER).get(), 'a fresh standby writes no marker');
        d.pragma('foreign_keys = OFF');
        const vi = seed(d, 11, { callsign: 'Visitor-0b0b0b0b', is_visitor: 1 });
        const al = seed(d, 12, { callsign: 'AlKeptByMain' });
        d.prepare("INSERT OR REPLACE INTO node_config (key, value) VALUES ('migration_mark_visitors_v1', 'copied')").run();
        d.close();
        promote(dir2);
        const promoted2 = bootInto(dir2, STANDBY);
        assert(promoted2.ok, 'the promoted standby boots as the main server');
        d = new Database(path.join(dir2, 'state.db'), { readonly: true });
        assert(flag(d, al).is_visitor === 0 && flag(d, al).updated_at === OLD,
            `a promoted standby holding its main server's marks doesn't mark again: the member it kept stays one (is_visitor ${flag(d, al).is_visitor})`);
        assert(flag(d, vi).is_visitor === 1, "…and the main server's visitor stays one");
        assert(!/Visitors' rows marked/.test(promoted2.output), '…and it logs no marks');
        d.close();
        fs.rmSync(dir2, { recursive: true, force: true });

        // A take-over interrupted before its "role" step finishes at the next boot (services/takeover.ts
        // resumeTakeoverAtBoot), after the database's boot ran as a standby's: the pass runs then, not at a later restart.
        const dir3 = tmp('standby-promoted-in-process');
        assert(bootInto(dir3, STANDBY).ok, 'a fresh standby boots');
        d = new Database(path.join(dir3, 'state.db'));
        d.pragma('foreign_keys = OFF');
        const late = seed(d, 13, { callsign: 'Visitor-0c0c0c0c' });
        d.close();
        const inProcess = bootInto(dir3, STANDBY, `
            import { initSchema } from ${JSON.stringify(path.join(__dirname, 'db', 'db.ts'))};
            import { updateLocalConfig } from ${JSON.stringify(path.join(__dirname, 'config', 'local-config.ts'))};
            initSchema();
            // The take-over's "role" step, finished at this boot after initSchema has read the role as a standby's.
            updateLocalConfig({ nodeRole: 'primary' });
            const { resumeTakeoverAtBoot } = await import(${JSON.stringify(path.join(__dirname, 'services', 'takeover.ts'))});
            resumeTakeoverAtBoot();
            console.log('BOOT_OK');
            process.exit(0);
        `);
        assert(inProcess.ok, 'the standby boots, and the take-over promotes it in-process');
        if (!inProcess.ok) console.error(inProcess.output.split('\n').slice(-20).join('\n'));
        d = new Database(path.join(dir3, 'state.db'), { readonly: true });
        assert(/a standby marks none itself/.test(inProcess.output) && flag(d, late).is_visitor === 1 && !!d.prepare(MARKER).get(),
            `a standby promoted in-process by a take-over finishing at boot runs the pass then (is_visitor ${flag(d, late).is_visitor})`);
        d.close();
        fs.rmSync(dir3, { recursive: true, force: true });
    }
});
