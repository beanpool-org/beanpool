import { describe, it } from 'vitest';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { exactPlaceReaders, isEventHost, readsAsAuthor } from '../posts.js';

/**
 * Who has a listing's place exactly (posts.ts exactPlaceReaders) runs for each new or changed listing on a node where
 * anyone can join (openMembership, the global node), from two places in apps/server state-engine.ts (the listing's
 * broadcast copy and placeOfListingEvent). Its keeper query joins a handful of treasury_operators
 * rows to members. Written as a plain JOIN, with no sqlite_stat1 (no node runs ANALYZE), SQLite planned it from members
 * (idx_members_member_keys, is_visitor = 0) and probed treasury_operators once per account: 0.35 s a call at 100,000
 * accounts, one listing create 888 ms (scratch/capacity-1104/REPORT.md, finding 5). It is `CROSS JOIN` now, small table
 * first, which SQLite keeps in the order written.
 *
 * The plan only goes wrong on the node's real indexes, so the database here is built from the node's own DDL
 * (apps/server/src/db/schema.sql), not a copy of it, and never ANALYZEd.
 */

const SCHEMA = readFileSync(fileURLToPath(new URL('../../../../apps/server/src/db/schema.sql', import.meta.url)), 'utf8');
function ddl(re: RegExp): string {
    const m = re.exec(SCHEMA);
    if (!m) throw new Error(`schema.sql no longer has ${re}`);
    return m[0];
}

/** The members, keeper, group and RSVP tables as the node has them, plus accounts enough that a walk of members shows. */
function nodeDb(filler = 3000): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = OFF');
    db.exec([
        ddl(/CREATE TABLE IF NOT EXISTS members \([\s\S]*?\n\);/),
        ddl(/CREATE INDEX IF NOT EXISTS idx_members_member_keys[^;]*;/),
        ddl(/CREATE TABLE IF NOT EXISTS treasury_operators \([\s\S]*?\n\);/),
        ddl(/CREATE INDEX IF NOT EXISTS idx_treasury_operators_member[^;]*;/),
        ddl(/CREATE TABLE IF NOT EXISTS group_members \([\s\S]*?\n\);/),
        ddl(/CREATE INDEX IF NOT EXISTS idx_group_members_pubkey[^;]*;/),
        ddl(/CREATE INDEX IF NOT EXISTS idx_group_members_status_role[^;]*;/),
        ddl(/CREATE TABLE IF NOT EXISTS event_rsvps \([\s\S]*?\n\);/),
        ddl(/CREATE INDEX IF NOT EXISTS idx_event_rsvps_member[^;]*;/),
    ].join('\n'));
    assert.strictEqual(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_stat1'").get(), undefined, 'a node has no planner statistics');

    const member = db.prepare('INSERT INTO members (public_key, callsign, status, is_visitor, is_treasury) VALUES (?, ?, ?, ?, ?)');
    db.transaction(() => {
        // The enterprise (a treasury account) and the enterprise nobody keeps.
        member.run('ent', 'Mill', 'active', 0, 1);
        member.run('lone', 'Lone', 'active', 0, 1);
        // Its keepers: two active, one suspended, and a visitor whose keeper row is left from before visitors were refused one.
        member.run('k1', 'Kay', 'active', 0, 0);
        member.run('k2', 'Kit', 'active', 0, 0);
        member.run('kSusp', 'Kerry', 'suspended', 0, 0);
        member.run('kVis', 'Kim', 'active', 1, 0);
        // The club's convenors: one active, one suspended, one a visitor.
        member.run('c1', 'Cam', 'active', 0, 0);
        member.run('cSusp', 'Cass', 'suspended', 0, 0);
        member.run('cVis', 'Cleo', 'active', 1, 0);
        // The event's RSVPs: going (let in, and not), going as a visitor, only interested.
        member.run('g1', 'Gil', 'active', 0, 0);
        member.run('g2', 'Gwen', 'active', 0, 0);
        member.run('gVis', 'Gus', 'active', 1, 0);
        member.run('gInt', 'Gem', 'active', 0, 0);
        for (let i = 0; i < filler; i++) member.run(`f${i}`, `Filler ${i}`, 'active', i % 40 === 0 ? 1 : 0, 0);
    })();

    const keeper = db.prepare('INSERT INTO treasury_operators (treasury_pubkey, member_pubkey) VALUES (?, ?)');
    for (const k of ['k1', 'k2', 'kSusp', 'kVis']) keeper.run('ent', k);
    const convenor = db.prepare("INSERT INTO group_members (group_id, member_pubkey, role, status) VALUES ('club', ?, ?, 'active')");
    for (const [k, role] of [['c1', 'convenor'], ['cSusp', 'convenor'], ['cVis', 'convenor'], ['g1', 'member']]) convenor.run(k, role);
    const rsvp = db.prepare("INSERT INTO event_rsvps (post_id, member_pubkey, status, signature, let_in_at) VALUES ('ev', ?, ?, 's', ?)");
    rsvp.run('g1', 'going', null);
    rsvp.run('g2', 'going', '2026-11-01T00:00:00.000Z');
    rsvp.run('gVis', 'going', '2026-11-01T00:00:00.000Z');
    rsvp.run('gInt', 'interested', '2026-11-01T00:00:00.000Z');
    return db;
}

const OFFER = { id: 'p1', author_pubkey: 'ent', type: 'offer' };
const EVENT = { id: 'ev', author_pubkey: 'ent', type: 'event', audience_scope: 'group', target_group_id: 'club', event_host_lets_in: 0 };

describe('Who has a listing\'s place exactly: the same readers as before (exactPlaceReaders)', () => {
    /** The keeper query as it was written before CROSS JOIN: the oracle the rewrite must agree with. */
    function keepersAsBefore(db: Database.Database, enterprise: string): string[] {
        return (db.prepare(`
            SELECT o.member_pubkey FROM treasury_operators o
            JOIN members m ON m.public_key = o.member_pubkey
            WHERE o.treasury_pubkey = ? AND m.status = 'active' AND m.is_visitor = 0`).all(enterprise) as Array<{ member_pubkey: string }>)
            .map(r => r.member_pubkey);
    }

    it('an enterprise\'s listing: the enterprise and its active keepers, not a suspended keeper or a visitor\'s old row', () => {
        const db = nodeDb();
        assert.deepStrictEqual([...exactPlaceReaders(db, OFFER)].sort(), ['ent', 'k1', 'k2']);
        assert.deepStrictEqual([...exactPlaceReaders(db, OFFER)].sort(), ['ent', ...keepersAsBefore(db, 'ent')].sort());
    });

    it('a listing of an enterprise nobody keeps, and of a member: just its author', () => {
        const db = nodeDb();
        assert.deepStrictEqual([...exactPlaceReaders(db, { ...OFFER, author_pubkey: 'lone' })], ['lone']);
        assert.deepStrictEqual([...exactPlaceReaders(db, { ...OFFER, author_pubkey: 'f1' })], ['f1']);
    });

    it('a keeper who is suspended is a reader again the moment they are active', () => {
        const db = nodeDb();
        assert.ok(!exactPlaceReaders(db, OFFER).has('kSusp'));
        db.prepare("UPDATE members SET status = 'active' WHERE public_key = 'kSusp'").run();
        assert.ok(exactPlaceReaders(db, OFFER).has('kSusp'));
        db.prepare("UPDATE members SET is_visitor = 1 WHERE public_key = 'kSusp'").run();
        assert.ok(!exactPlaceReaders(db, OFFER).has('kSusp'), 'a visitor holds none');
    });

    it('an event of the club: its keepers, its active convenor, and those Going (not a visitor, not only interested)', () => {
        const db = nodeDb();
        assert.deepStrictEqual([...exactPlaceReaders(db, EVENT)].sort(), ['c1', 'ent', 'g1', 'g2', 'k1', 'k2']);
    });

    it('an event whose host lets people in: only those Going and let in', () => {
        const db = nodeDb();
        assert.deepStrictEqual([...exactPlaceReaders(db, { ...EVENT, event_host_lets_in: 1 })].sort(), ['c1', 'ent', 'g2', 'k1', 'k2']);
    });

    it('an event for everyone has no convenors among its readers', () => {
        const db = nodeDb();
        assert.deepStrictEqual([...exactPlaceReaders(db, { ...EVENT, audience_scope: 'public', target_group_id: null })].sort(), ['ent', 'g1', 'g2', 'k1', 'k2']);
    });
});

describe('Who has a listing\'s place exactly: the plan starts from the small table, never a walk of members (finding 5)', () => {
    type Seen = { sql: string; args: unknown[] };
    /** Every statement the call runs that joins members, with the arguments it ran with. A fresh handle: prepared() caches per handle. */
    function joinsOf(db: Database.Database, run: () => unknown): Seen[] {
        const seen: Seen[] = [];
        const realPrepare = db.prepare.bind(db);
        db.prepare = ((sql: string) => {
            const stmt = realPrepare(sql);
            if (/JOIN members m\b/.test(sql)) {
                const all = stmt.all.bind(stmt);
                const get = stmt.get.bind(stmt);
                stmt.all = ((...args: unknown[]) => { seen.push({ sql, args }); return all(...args); }) as typeof stmt.all;
                stmt.get = ((...args: unknown[]) => { seen.push({ sql, args }); return get(...args); }) as typeof stmt.get;
            }
            return stmt;
        }) as typeof db.prepare;
        run();
        db.prepare = realPrepare as typeof db.prepare;
        return seen;
    }

    const planOf = (db: Database.Database, q: Seen): string[] =>
        (db.prepare('EXPLAIN QUERY PLAN ' + q.sql).all(...q.args as unknown[]) as Array<{ detail: string }>).map(r => r.detail);

    /** The plan reaches members by its key, from a row it already holds: its first step is the small table, and no step scans members. */
    function assertReachesMembersByKey(db: Database.Database, q: Seen): void {
        const plan = planOf(db, q);
        const label = `${plan.join(' | ')}\n${q.sql.replace(/\s+/g, ' ').trim()}`;
        assert.ok(!/^(SCAN|SEARCH) m\b/.test(plan[0]), `the plan starts from members: ${label}`);
        assert.ok(!plan.some(d => /^SCAN m\b/.test(d)), `the plan scans members: ${label}`);
        const step = plan.find(d => /^SEARCH m\b/.test(d));
        assert.ok(step && step.includes('public_key=?'), `members is not looked up by key: ${label}`);
    }

    /** An event's readers run exactly three queries that join members, in this order; checked so none of the tests below passes on nothing. */
    function eventQueries(): { db: Database.Database; seen: Seen[] } {
        const db = nodeDb();
        const seen = joinsOf(db, () => exactPlaceReaders(db, EVENT));
        assert.deepStrictEqual(seen.map(q => /FROM (\w+) /.exec(q.sql)![1]), ['treasury_operators', 'group_members', 'event_rsvps']);
        return { db, seen };
    }

    it('the event\'s keeper query starts from treasury_operators', () => {
        const { db, seen } = eventQueries();
        assertReachesMembersByKey(db, seen[0]);
    });

    it('the event\'s convenor query starts from group_members', () => {
        const { db, seen } = eventQueries();
        assertReachesMembersByKey(db, seen[1]);
    });

    it('the event\'s Going query starts from event_rsvps', () => {
        const { db, seen } = eventQueries();
        assertReachesMembersByKey(db, seen[2]);
    });

    it('a plain listing runs the keeper query and it starts from treasury_operators', () => {
        const db = nodeDb();
        const seen = joinsOf(db, () => exactPlaceReaders(db, OFFER));
        assert.strictEqual(seen.length, 1);
        assert.match(seen[0].sql, /FROM treasury_operators o/);
        assertReachesMembersByKey(db, seen[0]);
    });

    it('the plan is not left to luck: the same query written as a plain JOIN does start from members here', () => {
        const db = nodeDb();
        const plain = planOf(db, {
            sql: `SELECT o.member_pubkey FROM treasury_operators o JOIN members m ON m.public_key = o.member_pubkey
                  WHERE o.treasury_pubkey = ? AND m.status = 'active' AND m.is_visitor = 0`,
            args: ['ent'],
        });
        assert.match(plain[0], /^SEARCH m USING INDEX idx_members_member_keys \(is_visitor=\?\)$/, `the fixture no longer reproduces the walk: ${plain.join(' | ')}`);
    });

    it('the two queries that hold the member\'s own key (isEventHost, enterprisesKeptBy) plan from that key and stay as they are', () => {
        const db = nodeDb();
        const seen = joinsOf(db, () => {
            // A convenor of the club's event reaches both of isEventHost's queries; a keeper's read runs enterprisesKeptBy.
            isEventHost(db, { author_pubkey: 'ent', audience_scope: 'group', target_group_id: 'club' }, 'c1');
            readsAsAuthor(db, 'k1', 'ent');
        });
        assert.deepStrictEqual(seen.map(q => /FROM (\w+) /.exec(q.sql)![1]), ['treasury_operators', 'group_members', 'treasury_operators']);
        for (const q of seen) {
            const plan = planOf(db, q);
            const step = plan.find(d => /^SEARCH m\b/.test(d));
            assert.ok(!plan.some(d => /^SCAN m\b/.test(d)) && step && step.includes('public_key=?'), `scans members: ${plan.join(' | ')}`);
        }
    });
});
