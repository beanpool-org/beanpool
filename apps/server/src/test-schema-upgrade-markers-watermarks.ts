/**
 * Schema upgrade safety, part 3: the tables, columns and one-time markers added since, and the tables' watermarks.
 * Each case is a booted node rolled back to an older shape, booted again by the REAL initSchema().
 *
 *  16. Moderation notices kept for the web app.
 *  17. An account its owner deleted (members.deleted_by_owner_at).
 *  18. A member's block list kept by the community.
 *  19. When a member's board standing last changed (members.board_standing_changed_at).
 *  20. The plain tables' watermark.
 *  21. A link's treasury carries its peer's marker.
 *  22. A recovery release names its owner.
 *  23. Members' devices and conveniences gain their watermark; invite_links goes (design G4).
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
import { fileURLToPath } from 'node:url';
import { assert, bootInto, columns, indexes, tmp, legacyDdl, runSchemaSuite } from './schema-upgrade-test-harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

runSchemaSuite('the tables, columns and markers added since, and the watermarks', '⭐️ Schema upgrade checks (markers and watermarks) PASSED.', async () => {
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

    // ── 17. An account its owner deleted (members.deleted_by_owner_at) ─────────────────────────────────────────────────
    // Every node from before it: members without the column, and a members_touch_updated_at that doesn't list it. The
    // fixture is a booted node rolled back to that shape, holding a member. It must boot onto exactly a fresh install's
    // members columns, with the column NULL on the member it had (nobody deleted by their owner), and a write of the
    // column alone must move updated_at, so delta sync carries it to a standby.
    console.log('\n--- 17. Legacy members without deleted_by_owner_at ---');
    {
        const touchSql = (d: Database.Database): string =>
            (d.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='members_touch_updated_at'`).get() as any)?.sql ?? '';
        const dir = tmp('legacy-deleted-by-owner');
        assert(bootInto(dir).ok, 'a fresh node boots (the fixture starts from the current schema)');
        const d = new Database(path.join(dir, 'state.db'));
        const freshMembers = columns(d, 'members');
        const current = touchSql(d);
        const old = current.replace(/,\s*deleted_by_owner_at\b/, '');
        assert(freshMembers.includes('deleted_by_owner_at') && /\bdeleted_by_owner_at\b/.test(current) && !/\bdeleted_by_owner_at\b/.test(old),
            'a fresh install has members.deleted_by_owner_at and lists it in members_touch_updated_at; the fixture takes both out');
        d.pragma('foreign_keys = OFF');
        d.exec(`DROP TRIGGER members_touch_updated_at; ALTER TABLE members DROP COLUMN deleted_by_owner_at; ${old};`);
        const pk = 'ab'.repeat(32);
        d.prepare(`INSERT INTO members (public_key, callsign, joined_at, updated_at) VALUES (?, 'Legacy', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`).run(pk);
        assert(!columns(d, 'members').includes('deleted_by_owner_at'), 'the fixture genuinely lacks the column');
        d.close();

        const result = bootInto(dir);
        assert(result.ok, 'the node from before deleted_by_owner_at boots');
        if (!result.ok) console.error(result.output.split('\n').slice(-20).join('\n'));
        const after = new Database(path.join(dir, 'state.db'));
        assert(JSON.stringify(columns(after, 'members')) === JSON.stringify(freshMembers), 'ending up with exactly the members columns a fresh install has');
        assert(/\bdeleted_by_owner_at\b/.test(touchSql(after)), 'its members_touch_updated_at lists deleted_by_owner_at');
        const row = after.prepare('SELECT deleted_by_owner_at FROM members WHERE public_key = ?').get(pk) as any;
        assert(row && row.deleted_by_owner_at === null, 'the member it already had was not deleted by its owner');
        after.prepare(`UPDATE members SET deleted_by_owner_at = '2026-09-27T00:00:00.000Z' WHERE public_key = ?`).run(pk);
        const touched = (after.prepare('SELECT updated_at FROM members WHERE public_key = ?').get(pk) as any)?.updated_at;
        assert(touched > '2025-01-01T00:00:00.000Z', `an UPDATE that sets only deleted_by_owner_at moves updated_at (${touched})`);
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

    // ── 19. When a member's board standing last changed (members.board_standing_changed_at) ─────────────────────────────
    // The Market delta's author half reads it (engine posts.ts). Every node from before it has neither the column, its
    // index, its trigger nor the one-time marker, and holds members on the board and off it. The upgrade adds all three,
    // fills the rows it holds once (the upgrade's time for a member off the board, updated_at for the rest; db.ts
    // backfillBoardStanding) without moving an updated_at, and never fills again. The trigger then stamps a change of
    // `paused` or of a winding_up / completed status, and nothing else.
    console.log('\n--- 19. Legacy node without members.board_standing_changed_at ---');
    {
        const dir = tmp('legacy-board-standing');
        assert(bootInto(dir).ok, 'a fresh node boots (the fixture starts from the current schema)');
        const d = new Database(path.join(dir, 'state.db'));
        const fresh = { cols: columns(d, 'members'), idx: indexes(d, 'members') };
        const hasTrigger = (db: Database.Database) =>
            !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'members_touch_board_standing'").get();
        assert(fresh.cols.includes('board_standing_changed_at') && fresh.idx.includes('idx_members_board_standing_changed_at') && hasTrigger(d),
            'a fresh install has the column, its index and its trigger');
        d.pragma('foreign_keys = OFF');
        d.exec(`DROP TRIGGER members_touch_board_standing; DROP INDEX idx_members_board_standing_changed_at; DROP INDEX idx_members_standing_by_key;
                ALTER TABLE members DROP COLUMN board_standing_changed_at;
                DELETE FROM node_config WHERE key = 'migration_board_standing_v1';`);
        const OLD = '2025-01-01T00:00:00.000Z';
        const key = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
        const seed = (n: number, cols: Record<string, unknown> = {}) => {
            const all: Record<string, unknown> = { public_key: key(n), callsign: `Row${n}`, joined_at: OLD, updated_at: OLD, invited_by: 'genesis', invite_code: `INV-${n}`, ...cols };
            const names = Object.keys(all);
            d.prepare(`INSERT INTO members (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...names.map(k => all[k]));
            return key(n);
        };
        const onBoard = seed(1);
        const away = seed(2);
        d.prepare(`INSERT INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, 'holiday_mode', 'true')`).run(away);
        const paused = seed(3, { is_treasury: 1, paused: 1 });
        const winding = seed(4, { is_treasury: 1, status: 'winding_up' });
        const woundUp = seed(5, { is_treasury: 1, status: 'completed' });
        const suspended = seed(6, { status: 'suspended' });
        assert(!columns(d, 'members').includes('board_standing_changed_at') && !hasTrigger(d), 'the fixture genuinely lacks the column and the trigger');
        d.close();

        const bootedAt = new Date().toISOString();
        const result = bootInto(dir);
        assert(result.ok, 'the node from before the column boots');
        if (!result.ok) console.error(result.output.split('\n').slice(-20).join('\n'));
        const after = new Database(path.join(dir, 'state.db'));
        assert(JSON.stringify(columns(after, 'members')) === JSON.stringify(fresh.cols) && JSON.stringify(indexes(after, 'members')) === JSON.stringify(fresh.idx)
            && hasTrigger(after), 'members: exactly the columns and indexes a fresh install has, and the trigger');
        const r = (pk: string) => after.prepare('SELECT board_standing_changed_at AS s, updated_at AS u FROM members WHERE public_key = ?').get(pk) as { s: string | null; u: string };
        for (const [label, pk] of [['on holiday', away], ['a paused enterprise', paused], ['an enterprise winding up', winding], ['a wound-up enterprise', woundUp]] as const) {
            assert((r(pk).s ?? '') >= bootedAt && r(pk).u === OLD, `off the board, filled with the upgrade's time, updated_at left: ${label} (${r(pk).s})`);
        }
        for (const [label, pk] of [['a member on the board', onBoard], ['a suspended member, still on it', suspended]] as const) {
            // Left empty: filling updated_at would publish when each row last changed (#1250's review, 4115438316).
            assert(r(pk).s === null && r(pk).u === OLD, `on the board, left empty and updated_at left: ${label} (${r(pk).s})`);
        }
        assert(!!after.prepare("SELECT 1 FROM node_config WHERE key = 'migration_board_standing_v1'").get(), 'the one-time marker is written');
        // A row with no standing yet (a member who joined since) stays so at every boot: the fill ran once.
        after.pragma('foreign_keys = OFF');
        after.prepare(`INSERT INTO members (public_key, callsign, joined_at, updated_at, invited_by, invite_code) VALUES (?, 'Joined', ?, ?, 'genesis', 'INV-J')`).run(key(7), OLD, OLD);
        after.close();
        assert(bootInto(dir).ok, 'booting it again is a no-op');
        const again = new Database(path.join(dir, 'state.db'));
        const s = (pk: string) => (again.prepare('SELECT board_standing_changed_at AS s FROM members WHERE public_key = ?').get(pk) as { s: string | null }).s;
        assert(s(key(7)) === null, 'and fills nothing: a member who joined since has no standing yet');
        // The trigger: a change of standing, whichever writer, and nothing else.
        const stamped = (sql: string, pk: string): boolean => {
            again.prepare('UPDATE members SET board_standing_changed_at = ? WHERE public_key = ?').run(OLD, pk);
            again.prepare(sql).run(pk);
            return s(pk) !== OLD;
        };
        const moves: Array<[string, string, string, boolean]> = [
            ['a bio', 'UPDATE members SET bio = \'Hello\' WHERE public_key = ?', onBoard, false],
            ['a mute', 'UPDATE members SET moderation_muted_until = \'9999-12-31T23:59:59.999Z\' WHERE public_key = ?', onBoard, false],
            ['suspended', 'UPDATE members SET status = \'suspended\' WHERE public_key = ?', onBoard, false],
            ['suspended to pruned', 'UPDATE members SET status = \'pruned\' WHERE public_key = ?', onBoard, false],
            ['paused again (no change)', 'UPDATE members SET paused = 1 WHERE public_key = ?', paused, false],
            ['resumed', 'UPDATE members SET paused = 0 WHERE public_key = ?', paused, true],
            ['paused', 'UPDATE members SET paused = 1 WHERE public_key = ?', paused, true],
            ['a wind-up cancelled', 'UPDATE members SET status = \'active\' WHERE public_key = ?', winding, true],
            ['winding up', 'UPDATE members SET status = \'winding_up\' WHERE public_key = ?', winding, true],
            ['finalised (still off the board, the keepers\' view ends)', 'UPDATE members SET status = \'completed\', paused = 0 WHERE public_key = ?', winding, true],
        ];
        for (const [what, sql, pk, expected] of moves) {
            const moved = stamped(sql, pk);
            assert(moved === expected, `${expected ? 'stamps' : 'leaves'} the standing: ${what}`);
        }
        // Setting either column itself fires neither trigger.
        again.prepare('UPDATE members SET board_standing_changed_at = ?, updated_at = ? WHERE public_key = ?').run(OLD, OLD, paused);
        again.prepare('UPDATE members SET paused = 0 WHERE public_key = ?').run(paused);
        const moved = again.prepare('SELECT board_standing_changed_at AS s, updated_at AS u FROM members WHERE public_key = ?').get(paused) as { s: string; u: string };
        assert(moved.s > OLD && moved.u > OLD, `a change of standing moves updated_at too, so delta sync takes it to a standby (${moved.s}, ${moved.u})`);
        again.prepare('UPDATE members SET paused = 1, board_standing_changed_at = ? WHERE public_key = ?').run(OLD, paused);
        assert(s(paused) === OLD, 'a write that sets the standing itself keeps it (a standby taking its main server\'s)');
        again.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // ── 20. The plain tables' watermark (in-flight money and governance on a standby, design G3) ─────────────────────────
    // A node from before it has no updated_at on most of the plain tables (engine/replication-manifest.ts) and no triggers
    // stamping it. The upgrade adds the column before the schema, stamps each row it holds once, and makes both triggers
    // (db.ts stampPlainTables); the old deferred_wage_claims, which a rebuild after the schema replaces (its table-wide
    // UNIQUE), keeps the column through it and gets its triggers again.
    console.log('\n--- 20. The plain tables gain their watermark ---');
    {
        const dir = tmp('legacy-plain-tables');
        assert(bootInto(dir).ok, 'a fresh node boots (the fixture starts from the current schema)');
        const triggersOn = (d: Database.Database, t: string) =>
            (d.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY name`).all(t) as any[]).map((r) => r.name);
        const d = new Database(path.join(dir, 'state.db'));
        d.pragma('foreign_keys = OFF'); // as db.ts runs it
        const freshTriggers = [...triggersOn(d, 'invite_codes'), ...triggersOn(d, 'deferred_wage_claims')];
        assert(freshTriggers.length === 4 && columns(d, 'invite_codes').includes('updated_at'),
            `a fresh install stamps both tables' writes (${freshTriggers.join(', ')})`);
        d.exec(`DROP TABLE invite_codes; ${legacyDdl('invite_codes', ['updated_at'])}`);
        d.prepare(`INSERT INTO invite_codes (code, created_by, created_at) VALUES ('OLD-CODE', 'x', '2025-01-01T00:00:00.000Z')`).run();
        d.exec(`DROP TABLE deferred_wage_claims;
                CREATE TABLE deferred_wage_claims (id TEXT PRIMARY KEY, enterprise_pubkey TEXT NOT NULL, keeper_pubkey TEXT NOT NULL,
                    post_id TEXT, transaction_id TEXT UNIQUE, amount REAL NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
                    created_at DATETIME, paid_at DATETIME);`);
        d.prepare(`INSERT INTO deferred_wage_claims (id, enterprise_pubkey, keeper_pubkey, transaction_id, amount, created_at)
                   VALUES ('w1', 'e', 'k', 't1', 2, '2025-01-01T00:00:00.000Z')`).run();
        assert(!columns(d, 'invite_codes').includes('updated_at') && !columns(d, 'deferred_wage_claims').includes('updated_at')
            && triggersOn(d, 'invite_codes').length === 0, 'the fixture genuinely lacks the column and the triggers');
        d.close();

        const result = bootInto(dir);
        assert(result.ok, 'the older node boots');
        if (!result.ok) console.error(result.output.split('\n').slice(-20).join('\n'));
        const after = new Database(path.join(dir, 'state.db'));
        after.pragma('foreign_keys = OFF');
        const wages = (after.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'deferred_wage_claims'`).get() as any).sql as string;
        assert(!/transaction_id\s+TEXT UNIQUE/.test(wages) && columns(after, 'deferred_wage_claims').includes('updated_at'),
            'the old wage claims table is rebuilt, and keeps the column');
        assert(JSON.stringify([...triggersOn(after, 'invite_codes'), ...triggersOn(after, 'deferred_wage_claims')]) === JSON.stringify(freshTriggers),
            `both tables have both triggers, the rebuilt one too (${[...triggersOn(after, 'invite_codes'), ...triggersOn(after, 'deferred_wage_claims')].join(', ')})`);
        const stamp = (t: string, key: string, v: string) => (after.prepare(`SELECT updated_at AS u FROM ${t} WHERE ${key} = ?`).get(v) as any)?.u as string | null;
        const invited = stamp('invite_codes', 'code', 'OLD-CODE');
        assert(!!invited && !!stamp('deferred_wage_claims', 'id', 'w1'), `each row held is stamped once (${invited})`);
        after.prepare(`UPDATE invite_codes SET updated_at = '2025-01-02T00:00:00.000Z' WHERE code = 'OLD-CODE'`).run();
        after.prepare(`UPDATE invite_codes SET used_by = 'y' WHERE code = 'OLD-CODE'`).run();
        after.prepare(`INSERT INTO invite_codes (code, created_by, updated_at) VALUES ('NEW-CODE', 'x', NULL)`).run();
        assert((stamp('invite_codes', 'code', 'OLD-CODE') ?? '') > '2025-01-02T00:00:00.000Z' && !!stamp('invite_codes', 'code', 'NEW-CODE'),
            'a write moves the stamp, and a row inserted with none is stamped');
        after.close();
        assert(bootInto(dir).ok, 'booting it again is a no-op');
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // ── 21. A link's treasury carries its peer's marker (review 4122266160) ──────────────────────────────────────────────
    // federation_link_treasuries is the only evidence a lost link row's treasury is found by (federation-link.ts
    // findLinkTreasury). A link made before it gets the marker at boot, from its link row, on a main server; a standby
    // writes none (its rows are its main server's), and a member's enterprise named like a link gets none.
    console.log('\n--- 21. A link made before the marker gets it at boot, on a main server only ---');
    {
        const plant = (dir: string) => {
            assert(bootInto(dir).ok, 'a fresh node boots');
            const d = new Database(path.join(dir, 'state.db'));
            d.pragma('foreign_keys = OFF');
            d.exec('DROP TABLE federation_link_treasuries');
            for (const [key, name] of [['link-treasury', 'eastgippy Link'], ['her-enterprise', 'riverbend Link']]) {
                d.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, is_treasury)
                           VALUES (?, ?, '2025-01-01T00:00:00.000Z', 'x', 'x', 'active', 1)`).run(key, name);
            }
            d.prepare(`INSERT INTO federation_links (peer_id, treasury_pubkey) VALUES ('12D3KooWEastGippy', 'link-treasury')`).run();
            d.close();
        };
        const marks = (dir: string) => {
            const d = new Database(path.join(dir, 'state.db'));
            const rows = d.prepare('SELECT treasury_pubkey, peer_id, updated_at FROM federation_link_treasuries ORDER BY treasury_pubkey').all() as any[];
            d.close();
            return rows;
        };
        const mainDir = tmp('legacy-link-marker');
        plant(mainDir);
        assert(bootInto(mainDir).ok, 'a main server from before the marker boots');
        const marked = marks(mainDir);
        assert(marked.length === 1 && marked[0].treasury_pubkey === 'link-treasury' && marked[0].peer_id === '12D3KooWEastGippy' && !!marked[0].updated_at,
            `its link's treasury is marked with the link's peer, stamped, and the enterprise no link names is not (${JSON.stringify(marked)})`);
        assert(bootInto(mainDir).ok && JSON.stringify(marks(mainDir)) === JSON.stringify(marked), 'booting it again changes nothing');
        fs.rmSync(mainDir, { recursive: true, force: true });

        const standbyDir = tmp('legacy-link-marker-standby');
        plant(standbyDir);
        assert(bootInto(standbyDir, { NODE_ROLE: 'backup' }).ok, 'a standby from before the marker boots');
        assert(marks(standbyDir).length === 0, 'and marks nothing itself: its markers are its main server\'s, which its next copy brings');
        fs.rmSync(standbyDir, { recursive: true, force: true });
    }

    // ── 22. A recovery release names its owner (review 4122266731) ──────────────────────────────────────────────────────
    // recovery_releases.owner_pubkey is what a member's own delete finds their releases by on a server that took over,
    // which holds none of the main server's sessions. A release from before it gets its owner at boot from its session,
    // where the session is here, on a main server; a standby fills none (its rows are its main server's).
    console.log('\n--- 22. A release from before owner_pubkey names its owner at boot, where its session is here ---');
    {
        const plant = (dir: string) => {
            assert(bootInto(dir).ok, 'a fresh node boots');
            const d = new Database(path.join(dir, 'state.db'));
            d.pragma('foreign_keys = OFF');
            d.exec(`DROP TABLE recovery_releases; ${legacyDdl('recovery_releases', ['owner_pubkey'])}`);
            d.prepare(`INSERT INTO recovery_collections (id, owner_pubkey, generation, requester_ephemeral_pubkey, status, expires_at)
                       VALUES ('here', 'owner-here', 1, 'eph', 'complete', '2025-01-04T00:00:00.000Z')`).run();
            const release = d.prepare(`INSERT INTO recovery_releases (collection_id, share_id, holder_type, share_index, payload, payload_iv, payload_tag, released_at, updated_at)
                                       VALUES (?, ?, 'hub', 1, 'p', 'iv', 'tag', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`);
            release.run('here', 1);
            release.run('elsewhere', 2); // a session another server holds
            assert(!columns(d, 'recovery_releases').includes('owner_pubkey'), 'the fixture genuinely lacks the column');
            d.close();
        };
        const rows = (dir: string) => {
            const d = new Database(path.join(dir, 'state.db'));
            const out = d.prepare('SELECT collection_id, owner_pubkey, updated_at FROM recovery_releases ORDER BY collection_id').all() as any[];
            d.close();
            return out;
        };
        const mainDir = tmp('legacy-release-owner');
        plant(mainDir);
        assert(bootInto(mainDir).ok, 'a main server from before the column boots');
        const filled = rows(mainDir);
        const [elsewhere, here] = filled;
        assert(here?.owner_pubkey === 'owner-here' && here.updated_at > '2025-01-01T00:00:00.000Z' && elsewhere?.owner_pubkey === null
            && elsewhere.updated_at === '2025-01-01T00:00:00.000Z',
            `the release whose session is here names its owner, stamped so the next copy carries it; the other is left alone (${JSON.stringify(filled)})`);
        assert(bootInto(mainDir).ok && JSON.stringify(rows(mainDir)) === JSON.stringify(filled), 'booting it again changes nothing');
        fs.rmSync(mainDir, { recursive: true, force: true });

        const standbyDir = tmp('legacy-release-owner-standby');
        plant(standbyDir);
        assert(bootInto(standbyDir, { NODE_ROLE: 'backup' }).ok, 'a standby from before the column boots');
        assert(rows(standbyDir).every((r) => r.owner_pubkey === null), 'and fills no owner itself: its rows are its main server\'s, which its next copy brings');
        fs.rmSync(standbyDir, { recursive: true, force: true });
    }

    // ── 23. Members' devices and conveniences gain their watermark; invite_links goes (design G4) ───────────────────────
    // A node from before has no updated_at on push_tokens, push_token_leaves, chat_mutes, thread_read_cursors,
    // event_reminders_sent, activity_feed or pricing_reports (engine/replication-manifest.ts), and still has the
    // invite_links table nothing ever read or wrote. The upgrade adds the column, stamps each row it holds once on a main
    // server (a standby's rows are its main server's), makes both triggers, and drops invite_links. A standby seeds no
    // pricing guide of its own at boot.
    // Such a node also held each phone's push token in the clear (push_tokens.token, push_token_leaves.token): its two push
    // tables are planted as they were, and the boot here runs the lock that follows initSchema in initStateEngine
    // (services/push-token-seal.ts), which on a main server locks the row (stamped, as the rest) and on a standby drops it.
    console.log('\n--- 23. The devices tables gain their watermark, and invite_links goes ---');
    {
        const G4 = ['push_tokens', 'push_token_leaves', 'chat_mutes', 'thread_read_cursors', 'event_reminders_sent', 'activity_feed', 'pricing_reports'];
        const OLD_PUSH_DDL: Record<string, string> = {
            push_tokens: `CREATE TABLE push_tokens (public_key TEXT NOT NULL REFERENCES members(public_key), token TEXT NOT NULL,
                platform TEXT DEFAULT 'ios', created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), registered_at INTEGER,
                PRIMARY KEY (public_key, token))`,
            push_token_leaves: `CREATE TABLE push_token_leaves (public_key TEXT NOT NULL, token TEXT NOT NULL, left_at INTEGER NOT NULL,
                applied_at DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), PRIMARY KEY (public_key, token))`,
        };
        const bootSealing = `
            import { initSchema } from ${JSON.stringify(path.join(__dirname, 'db', 'db.ts'))};
            import { getNodeRole } from ${JSON.stringify(path.join(__dirname, 'config', 'node-role.ts'))};
            import { installPushTokenSealAtBoot } from ${JSON.stringify(path.join(__dirname, 'services', 'push-token-seal.ts'))};
            initSchema();
            installPushTokenSealAtBoot({ standby: getNodeRole() === 'backup' });
            console.log('BOOT_OK');
        `;
        const triggersOn = (d: Database.Database, t: string) =>
            (d.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY name`).all(t) as any[]).map((r) => r.name);
        const plant = (dir: string) => {
            assert(bootInto(dir).ok, 'a fresh node boots');
            const d = new Database(path.join(dir, 'state.db'));
            d.pragma('foreign_keys = OFF');
            assert(G4.every((t) => columns(d, t).includes('updated_at') && triggersOn(d, t).length === 2)
                && !d.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'invite_links'`).get(),
                'a fresh install has the column and both triggers on each, and no invite_links');
            for (const t of G4) d.exec(`DROP TABLE ${t}; ${OLD_PUSH_DDL[t] ?? legacyDdl(t, ['updated_at'])}`);
            d.exec(`CREATE TABLE invite_links (hash_id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at DATETIME)`);
            d.prepare(`INSERT INTO push_tokens (public_key, token, platform, created_at) VALUES ('k', 'ExponentPushToken[old]', 'ios', '2025-01-01T00:00:00.000Z')`).run();
            d.prepare(`INSERT INTO chat_mutes (conversation_id, member_pubkey, muted_until, created_at) VALUES ('c', 'k', NULL, '2025-01-01T00:00:00.000Z')`).run();
            d.prepare(`INSERT INTO activity_feed (event_type, actor_pubkey, created_at) VALUES ('post_created', 'k', '2025-01-01T00:00:00.000Z')`).run();
            d.exec('DELETE FROM pricing_guide_items');
            assert(G4.every((t) => !columns(d, t).includes('updated_at') && triggersOn(d, t).length === 0), 'the fixture genuinely lacks the column and the triggers');
            d.close();
        };
        const look = (dir: string) => {
            const d = new Database(path.join(dir, 'state.db'));
            const out = {
                shaped: G4.every((t) => columns(d, t).includes('updated_at') && triggersOn(d, t).length === 2),
                inviteLinks: !!d.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'invite_links'`).get(),
                // The planted phone, by its key: its row names the token by id now. 'id-new' is the row planted below.
                token: (d.prepare(`SELECT updated_at AS u FROM push_tokens WHERE public_key = 'k' AND token_id != 'id-new'`).get() as any)?.u ?? null,
                inClear: !!d.prepare(`SELECT 1 FROM sqlite_master WHERE name IN ('push_tokens_plain', 'push_token_leaves_plain')`).get()
                    || columns(d, 'push_tokens').includes('token'),
                mute: (d.prepare(`SELECT updated_at AS u FROM chat_mutes WHERE conversation_id = 'c'`).get() as any)?.u ?? null,
                line: (d.prepare(`SELECT updated_at AS u FROM activity_feed WHERE actor_pubkey = 'k'`).get() as any)?.u ?? null,
                guide: (d.prepare('SELECT COUNT(*) AS n FROM pricing_guide_items').get() as any).n as number,
            };
            d.close();
            return out;
        };
        const mainDir = tmp('legacy-devices');
        plant(mainDir);
        const booted = bootInto(mainDir, {}, bootSealing);
        assert(booted.ok, 'a main server from before the column boots');
        if (!booted.ok) console.error(booted.output.split('\n').slice(-20).join('\n'));
        const onMain = look(mainDir);
        assert(onMain.shaped && !onMain.inviteLinks && !!onMain.token && !!onMain.mute && !!onMain.line && onMain.guide > 0 && !onMain.inClear,
            `each table has the column and both triggers, every row it held is stamped (the phone's locked), invite_links is gone, and its guide is seeded (${JSON.stringify(onMain)})`);
        const w = new Database(path.join(mainDir, 'state.db'));
        w.pragma('foreign_keys = OFF'); // as db.ts runs it
        w.prepare(`UPDATE chat_mutes SET updated_at = '2025-01-02T00:00:00.000Z' WHERE conversation_id = 'c'`).run();
        w.prepare(`UPDATE chat_mutes SET muted_until = '2030-01-01T00:00:00.000Z' WHERE conversation_id = 'c'`).run();
        w.prepare(`INSERT INTO push_tokens (public_key, token_id, token_box, platform, updated_at) VALUES ('k', 'id-new', 'box', 'ios', NULL)`).run();
        const moved = (w.prepare(`SELECT updated_at AS u FROM chat_mutes WHERE conversation_id = 'c'`).get() as any).u as string;
        const stampedNew = (w.prepare(`SELECT updated_at AS u FROM push_tokens WHERE token_id = 'id-new'`).get() as any).u as string | null;
        w.close();
        assert(moved > '2025-01-02T00:00:00.000Z' && !!stampedNew, 'a write moves the stamp, and a row inserted with none is stamped');
        assert(bootInto(mainDir, {}, bootSealing).ok && look(mainDir).shaped, 'booting it again is a no-op');
        fs.rmSync(mainDir, { recursive: true, force: true });

        const standbyDir = tmp('legacy-devices-standby');
        plant(standbyDir);
        assert(bootInto(standbyDir, { NODE_ROLE: 'backup' }, bootSealing).ok, 'a standby from before the column boots');
        const onStandby = look(standbyDir);
        assert(onStandby.shaped && !onStandby.inviteLinks && onStandby.token === null && onStandby.mute === null && onStandby.line === null && onStandby.guide === 0
            && !onStandby.inClear,
            `and has the columns and triggers, stamps no row itself, keeps no phone in the clear (no key to lock it) and seeds no pricing guide: its rows are its main server's, which its next copy brings (${JSON.stringify(onStandby)})`);
        fs.rmSync(standbyDir, { recursive: true, force: true });
    }
});
