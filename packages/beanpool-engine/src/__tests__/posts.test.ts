import { describe, it } from 'vitest';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { generateSearchKeywords, getPosts, publicBroadcastPost, type MarketplacePost } from '../posts.js';
import { boundingBox, haversineKm, registerGeoFunctions, MAX_RADIUS_KM } from '../geo.js';

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

/** The tables getPosts reads, as the node's schema.sql has them (the columns it touches). */
const POSTS_FIXTURE_DDL = `
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
        event_conversation_id TEXT,
        hidden_by_reports_at TEXT,
        removed_by_moderator_at TEXT
    );
`;

// Archetypes gate nothing (docs/the-commons.md, "Working-style archetypes"). #823 added a
// targetArchetype filter over posts.target_archetypes; it was removed before anything used it.
// The column stays in live databases, so the test table keeps it too.
describe('Posts ignore archetypes', () => {
    it('lists every post whatever targetArchetype is asked for, and never returns the column', () => {
        const db = new Database(':memory:');
        registerGeoFunctions(db);
        db.exec(`
            ${POSTS_FIXTURE_DDL}
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

// Distance search (global node G4, design §3.2). The node's HTTP suite (apps/server test-distance-search) covers the
// route, the profiles and the brute-force comparison; these pin the engine's own contract.
describe('Distance search (G4)', () => {
    const hub = { lat: -28.55, lng: 153.5 };
    const north = (km: number) => hub.lat + km / (6371 * Math.PI / 180);
    function fixture(): Database.Database {
        const db = new Database(':memory:');
        registerGeoFunctions(db);
        db.exec(POSTS_FIXTURE_DDL);
        db.exec(`INSERT INTO members (public_key, callsign) VALUES ('author1', 'Alice');`);
        const ins = db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, updated_at, lat, lng)
                                VALUES (?, 'offer', 'tools', ?, '', 0, 'author1', ?, ?, ?, ?)`);
        // Most recent first is the reverse of nearest first, so the two orders can be told apart.
        const rows: Array<[string, number | null]> = [['near', 1], ['mid', 10], ['far', 100], ['nowhere', null]];
        rows.forEach(([id, km], i) => {
            const at = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
            ins.run(id, id, at, at, km === null ? null : north(km), km === null ? null : hub.lng);
        });
        return db;
    }

    it('haversine_km matches the formula, and is NULL for a missing place', () => {
        const db = fixture();
        const d = (db.prepare('SELECT haversine_km(-28.55, 153.5, -37.07, 144.22) AS d').get() as { d: number }).d;
        assert.ok(Math.abs(d - 1280) / 1280 < 0.01, `Mullumbimby to Castlemaine ≈ 1,280 km (got ${d})`);
        assert.strictEqual(d, haversineKm(-28.55, 153.5, -37.07, 144.22));
        assert.strictEqual((db.prepare('SELECT haversine_km(1, 2, NULL, 4) AS d').get() as { d: number | null }).d, null);
    });

    it('without a point, the query and the answer are what they always were', () => {
        const db = fixture();
        const posts = getPosts(db);
        assert.deepStrictEqual(posts.map(p => p.id), ['nowhere', 'far', 'mid', 'near']);
        assert.ok(posts.every(p => !('distanceKm' in p)));
    });

    it('a radius keeps what is inside it, and a post with no place is never in it', () => {
        const db = fixture();
        const posts = getPosts(db, { near: { ...hub, radiusKm: 50 }, sortByDistance: true });
        assert.deepStrictEqual(posts.map(p => p.id), ['near', 'mid']);
        assert.deepStrictEqual(posts.map(p => p.distanceKm), [1, 10]);
    });

    it('nearest first puts a post with no place last; without sortByDistance the order is unchanged', () => {
        const db = fixture();
        const nearest = getPosts(db, { near: hub, sortByDistance: true });
        assert.deepStrictEqual(nearest.map(p => p.id), ['near', 'mid', 'far', 'nowhere']);
        assert.deepStrictEqual(nearest.map(p => p.distanceKm), [1, 10, 100, null]);
        assert.deepStrictEqual(getPosts(db, { near: hub }).map(p => p.id), ['nowhere', 'far', 'mid', 'near']);
    });

    it('boundingBox splits across the antimeridian and covers every longitude around a pole', () => {
        const fiji = boundingBox(-17.7, 178, 800);
        assert.strictEqual(fiji.lngRanges.length, 2);
        assert.ok(fiji.lngRanges.some(([lo, hi]) => hi === 180 && lo < 178) && fiji.lngRanges.some(([lo, hi]) => lo === -180 && hi > -180 && hi < -170));
        const west = boundingBox(-16, -179.5, 500);
        assert.ok(west.lngRanges.length === 2 && west.lngRanges.some(([lo]) => lo > 170));
        assert.deepStrictEqual(boundingBox(88, 45, 600).lngRanges, [[-180, 180]]);
        assert.deepStrictEqual(boundingBox(-89.5, 0, 100).lngRanges, [[-180, 180]]);
        assert.deepStrictEqual(boundingBox(0, 0, MAX_RADIUS_KM).lngRanges, [[-180, 180]]);
        const small = boundingBox(-28.55, 153.5, 10);
        assert.strictEqual(small.lngRanges.length, 1);
        assert.ok(small.latMin < -28.55 - 0.089 && small.latMax > -28.55 + 0.089);
    });

    it('every point within the radius falls inside its box (random points near the antimeridian and the poles)', () => {
        let seed = 7;
        const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
        for (const [lat, lng, r] of [[-17.7, 178, 800], [-16, -179.5, 500], [88, 45, 600], [85, -120, 300], [-86, 170, 1200], [60, 179.9, 50]]) {
            const box = boundingBox(lat, lng, r);
            for (let i = 0; i < 2000; i++) {
                const pLat = Math.max(-90, Math.min(90, lat + (rand() - 0.5) * 40));
                const pLng = ((lng + (rand() - 0.5) * 360 + 540) % 360) - 180;
                if (haversineKm(lat, lng, pLat, pLng) > r) continue;
                const inLng = box.lngRanges.some(([lo, hi]) => pLng >= lo && pLng <= hi);
                assert.ok(pLat >= box.latMin && pLat <= box.latMax && inLng, `(${pLat}, ${pLng}) is ${haversineKm(lat, lng, pLat, pLng)} km from (${lat}, ${lng}) but outside its box`);
            }
        }
    });
});
