import { describe, it } from 'vitest';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { generateSearchKeywords, getPosts, publicBroadcastPost, type MarketplacePost } from '../posts.js';

describe('Posts Search Keyword Expansion', () => {
    const synonymMap: Record<string, string[]> = {
        'lemon': ['citrus', 'fruit'],
        'cup of tea': ['chai', 'hot beverage'],
        '3d printer': ['additive manufacturing', 'rapid prototyping'],
    };

    it('expands single-word synonyms correctly', () => {
        const keywords = generateSearchKeywords('Fresh Lemon', 'Fresh organic lemons for sale', 'produce', synonymMap);
        assert.ok(keywords.includes('produce'));
        assert.ok(keywords.includes('citrus'));
        assert.ok(keywords.includes('fruit'));
    });

    it('expands multi-word n-gram synonyms containing short words correctly', () => {
        const keywords = generateSearchKeywords('Nice cup of tea', 'Enjoy a warm cup of tea', 'food', synonymMap);
        assert.ok(keywords.includes('food'));
        assert.ok(keywords.includes('chai'));
        assert.ok(keywords.includes('hot beverage'));
    });

    it('expands n-gram synonyms with numbers and abbreviations', () => {
        const keywords = generateSearchKeywords('Creality 3D printer', 'Fast 3d printer for hobbyists', 'tools', synonymMap);
        assert.ok(keywords.includes('tools'));
        assert.ok(keywords.includes('additive manufacturing'));
        assert.ok(keywords.includes('rapid prototyping'));
    });

    it('handles empty synonym map or missing synonyms gracefully', () => {
        const keywords = generateSearchKeywords('Guitar', 'Vintage electric guitar', 'music');
        assert.strictEqual(keywords, 'music');
    });
});

// Archetypes gate nothing (docs/the-commons.md, "Working-style archetypes"). #823 added a
// targetArchetype filter over posts.target_archetypes; it was removed before anything used it.
// The column stays in live databases, so the test table keeps it too.
describe('Posts ignore archetypes', () => {
    it('lists every post whatever targetArchetype is asked for, and never returns the column', () => {
        const db = new Database(':memory:');
        db.exec(`
            CREATE TABLE members (
                public_key TEXT PRIMARY KEY,
                callsign TEXT NOT NULL,
                avatar_url TEXT,
                status TEXT DEFAULT 'active',
                earned_credit REAL DEFAULT 0,
                paused INTEGER DEFAULT 0,
                joined_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE groups (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                slug TEXT UNIQUE,
                description TEXT,
                avatar_url TEXT,
                category TEXT DEFAULT 'general',
                created_by TEXT,
                join_policy TEXT DEFAULT 'open',
                created_at DATETIME,
                updated_at DATETIME
            );
            CREATE TABLE group_members (
                group_id TEXT,
                member_pubkey TEXT,
                role TEXT DEFAULT 'member',
                status TEXT DEFAULT 'active',
                joined_at DATETIME,
                invited_by TEXT,
                updated_at DATETIME,
                PRIMARY KEY (group_id, member_pubkey)
            );
            CREATE TABLE transactions (
                id TEXT PRIMARY KEY,
                from_pubkey TEXT,
                to_pubkey TEXT,
                amount REAL
            );
            CREATE TABLE marketplace_transactions (
                id TEXT PRIMARY KEY,
                post_id TEXT,
                buyer_pubkey TEXT,
                seller_pubkey TEXT,
                status TEXT,
                created_at DATETIME,
                completed_at DATETIME
            );
            CREATE TABLE member_preferences (
                public_key TEXT,
                pref_key TEXT,
                pref_value TEXT
            );
            CREATE TABLE post_photos (
                post_id TEXT,
                photo_data TEXT,
                order_num INTEGER,
                updated_at DATETIME
            );
            CREATE TABLE posts (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                category TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT NOT NULL,
                credits REAL NOT NULL,
                price_type TEXT DEFAULT 'fixed',
                author_pubkey TEXT NOT NULL REFERENCES members(public_key),
                created_at DATETIME NOT NULL,
                active INTEGER DEFAULT 1,
                status TEXT DEFAULT 'active',
                repeatable INTEGER DEFAULT 0,
                accepted_by TEXT,
                accepted_at DATETIME,
                lat REAL,
                lng REAL,
                updated_at DATETIME,
                search_keywords TEXT,
                cash_also_needed INTEGER DEFAULT 0,
                reach TEXT DEFAULT 'local',
                reach_peers TEXT,
                created_by TEXT,
                poll_options TEXT,
                poll_closes_at DATETIME,
                audience_scope TEXT DEFAULT 'public',
                target_group_id TEXT,
                target_pubkey TEXT,
                assigned_to TEXT,
                target_archetypes TEXT,
                event_start_at DATETIME,
                event_end_at DATETIME,
                event_place_name TEXT,
                event_private_note TEXT,
                event_state TEXT,
                event_conversation_id TEXT
            );
            INSERT INTO members (public_key, callsign) VALUES ('author1', 'Alice');
            INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, target_archetypes)
            VALUES ('p1', 'offer', 'tools', 'Hammer', 'A hammer', 5, 'author1', datetime('now'), '["guardian"]'),
                   ('p2', 'offer', 'tools', 'Saw', 'A saw', 5, 'author1', datetime('now'), NULL);
        `);

        // A caller still sending the old filter (a stale client, or a hand-built URL) gets the full list.
        const filter = { targetArchetype: 'sage' } as Parameters<typeof getPosts>[1];
        const posts = getPosts(db, filter);
        assert.deepStrictEqual(posts.map(p => p.id).sort(), ['p1', 'p2']);
        assert.strictEqual(getPosts(db, { targetArchetype: 'guardian' } as Parameters<typeof getPosts>[1]).length, 2);
        for (const post of posts) {
            assert.ok(!('targetArchetypes' in post), 'post must not carry targetArchetypes');
        }
    });
});

// The copy of a post the live feed sends every member socket. Posts are read for their author (or a poll's voter)
// before they are broadcast, and the apps keep what the feed sends them, so nothing only that one reader may see
// can ride along.
describe('publicBroadcastPost', () => {
    const base = {
        id: 'p1', type: 'offer', category: 'food', title: 'Lemons', description: 'A bag', credits: 5,
        authorPublicKey: 'a'.repeat(64), authorCallsign: 'Ann', createdAt: '2026-09-24T01:00:00.000Z',
        updatedAt: '2026-09-24T01:00:00.000Z', active: true, status: 'active', audienceScope: 'public',
    } as MarketplacePost;

    it('drops reachPeers from every type: getPosts gives it to the author alone', () => {
        for (const type of ['offer', 'need', 'poll', 'event'] as const) {
            const out = publicBroadcastPost({ ...base, type, reach: 'peers', reachPeers: ['12D3KooWPeer'] });
            assert.ok(!('reachPeers' in out), `${type}: reachPeers must not be broadcast`);
            assert.strictEqual(out.reach, 'peers', `${type}: reach is a property of the listing and stays`);
        }
    });

    it("still drops an event's host-only and reader-only fields", () => {
        const out = publicBroadcastPost({
            ...base, type: 'event', eventPrivateNote: 'Gate 1234', myRsvp: 'going',
            eventRsvps: [{ memberPubkey: 'b'.repeat(64), status: 'going', updatedAt: base.updatedAt! }],
        });
        assert.ok(!('eventPrivateNote' in out) && !('myRsvp' in out) && !('eventRsvps' in out));
    });

    it("leaves everything else as it was, and does not touch the caller's copy", () => {
        const post = { ...base, reachPeers: ['12D3KooWPeer'] };
        const out = publicBroadcastPost(post);
        const { reachPeers: _dropped, ...rest } = post;
        assert.deepStrictEqual(out, rest);
        assert.deepStrictEqual(post.reachPeers, ['12D3KooWPeer']);
    });
});
