import { describe, it } from 'vitest';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import {
    generateSearchKeywords, getPosts, publicBroadcastPost, NEAREST_FIRST_CIRCLES_KM, NEAREST_FIRST_CIRCLES_MAX_DEPTH, type MarketplacePost, type PostFilter,
} from '../posts.js';
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

// Nearest first is searched in widening circles (posts.ts NEAREST_FIRST_CIRCLES_KM) and ranked on ids before the page's
// rows are read (the deciding review of #1140). Held here to a brute-force haversine over every visible post: the same
// page, in the same order, wherever the page falls — inside a circle, across a circle's edge, across the last post with
// a place, and past the end.
describe('Nearest first, searched in widening circles (G4)', () => {
    const KM_PER_DEG = 6371 * Math.PI / 180;
    const hub = { lat: -28.55, lng: 153.5 };
    interface Seed { lat: number | null; lng: number | null; hidden?: boolean; inactive?: boolean; group?: boolean }

    function prng(seed: number): () => number {
        let x = seed >>> 0;
        return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; };
    }
    /** A place `km` from a point on a random bearing (spherical, so it is right near a pole and across the antimeridian). */
    function around(rand: () => number, lat: number, lng: number, km: number): [number, number] {
        const d = km / 6371, b = rand() * 2 * Math.PI, φ = lat * Math.PI / 180, λ = lng * Math.PI / 180;
        const φ2 = Math.asin(Math.min(1, Math.max(-1, Math.sin(φ) * Math.cos(d) + Math.cos(φ) * Math.sin(d) * Math.cos(b))));
        const λ2 = λ + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(φ), Math.cos(d) - Math.sin(φ) * Math.sin(φ2));
        return [φ2 * 180 / Math.PI, ((λ2 * 180 / Math.PI + 540) % 360) - 180];
    }
    /** Anywhere on Earth, evenly. */
    function anywhere(rand: () => number): [number, number] {
        return [Math.asin(2 * rand() - 1) * 180 / Math.PI, rand() * 360 - 180];
    }

    function world(seeds: Seed[]): Database.Database {
        const db = new Database(':memory:');
        registerGeoFunctions(db);
        db.exec(POSTS_FIXTURE_DDL);
        db.exec('CREATE INDEX idx_posts_lat_lng ON posts(lat, lng)');
        // Authors with and without a trade, so the fields read after the ranking differ by author.
        db.exec(`INSERT INTO members (public_key, callsign, earned_credit) VALUES ('a0', 'Ann', 0), ('a1', 'Bo', 12), ('a2', 'Cy', 0);
                 INSERT INTO transactions (id, from_pubkey, to_pubkey, amount) VALUES ('t1', 'a1', 'a0', 5);
                 INSERT INTO groups (id, name, slug) VALUES ('g1', 'Club', 'club');`);
        const ins = db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, updated_at, lat, lng,
                                                   active, hidden_by_reports_at, audience_scope, target_group_id)
                                VALUES (?, 'offer', 'tools', ?, '', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        db.transaction(() => seeds.forEach((seed, i) => {
            // Few distinct times, so equal distances and equal times both happen and the rest of the order decides.
            const updated = new Date(Date.UTC(2026, 0, 1, 0, i % 17)).toISOString();
            const created = new Date(Date.UTC(2025, 0, 1, 0, i % 5)).toISOString();
            ins.run(`p${String(i).padStart(5, '0')}`, `Post ${i}`, `a${i % 3}`, created, updated, seed.lat, seed.lng,
                seed.inactive ? 0 : 1, seed.hidden ? updated : null, seed.group ? 'group' : 'public', seed.group ? 'g1' : null);
        }))();
        return db;
    }

    /** The reference: every post the listing shows without a point, measured and sorted here. */
    function bruteForce(db: Database.Database, lat: number, lng: number, radiusKm?: number) {
        const by = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
        return getPosts(db)
            .map(p => ({ id: p.id, u: p.updatedAt ?? '', c: p.createdAt, d: typeof p.lat === 'number' && typeof p.lng === 'number' ? haversineKm(lat, lng, p.lat, p.lng) : null }))
            .filter(p => radiusKm === undefined || (p.d !== null && p.d <= radiusKm))
            .sort((a, b) => (a.d === null ? 1 : 0) - (b.d === null ? 1 : 0) || (a.d ?? 0) - (b.d ?? 0) || by(b.u, a.u) || by(b.c, a.c) || by(a.id, b.id));
    }

    /** Every read that measures distance, with its parameters, until `delete db.prepare`. */
    function watch(db: Database.Database): Array<{ sql: string; params: unknown[] }> {
        const seen: Array<{ sql: string; params: unknown[] }> = [];
        const prepare = db.prepare.bind(db);
        (db as any).prepare = (sql: string) => {
            const st = prepare(sql);
            if (/haversine_km/.test(sql)) {
                const all = st.all.bind(st);
                (st as any).all = (...params: unknown[]) => { seen.push({ sql, params }); return all(...params); };
            }
            return st;
        };
        return seen;
    }

    /** Pages at the edge of every circle, of the posts with a place, and of the list: each compared with the reference. */
    function checkPages(db: Database.Database, lat: number, lng: number, what: string): number {
        const ref = bruteForce(db, lat, lng);
        const located = ref.filter(r => r.d !== null).length;
        const edges = new Set<number>([0, 1, located, ref.length]);
        for (const km of NEAREST_FIRST_CIRCLES_KM) edges.add(ref.filter(r => r.d !== null && r.d <= km).length);
        const pages: Array<[number, number]> = [[50, 0], [200, 0], [7, ref.length + 5]];
        for (const edge of edges) for (const back of [7, 6, 3, 0]) if (edge - back >= 0) pages.push([7, edge - back]);
        for (const [limit, offset] of pages) {
            const got = getPosts(db, { near: { lat, lng }, sortByDistance: true, limit, offset });
            const want = ref.slice(offset, offset + limit);
            assert.deepStrictEqual(got.map(p => p.id), want.map(r => r.id), `${what}: limit ${limit}, offset ${offset}`);
            assert.deepStrictEqual(got.map(p => p.distanceKm), want.map(r => r.d === null ? null : Math.round(r.d * 10) / 10), `${what}: distances, offset ${offset}`);
        }
        return pages.length;
    }

    it('a dense town, the world around it, and posts with no place: every page is the brute-force page', () => {
        const rand = prng(1);
        const seeds: Seed[] = [];
        for (let i = 0; i < 1500; i++) { const [la, ln] = around(rand, hub.lat, hub.lng, Math.abs(8 * Math.sqrt(-2 * Math.log(rand() || 1e-9)))); seeds.push({ lat: la, lng: ln }); }
        for (let i = 0; i < 40; i++) seeds.push({ lat: hub.lat, lng: hub.lng });                     // all at one spot: a tie
        for (const km of NEAREST_FIRST_CIRCLES_KM) seeds.push({ lat: hub.lat + km / KM_PER_DEG, lng: hub.lng }); // on each circle's edge
        for (let i = 0; i < 300; i++) { const [la, ln] = anywhere(rand); seeds.push({ lat: la, lng: ln }); }
        for (let i = 0; i < 60; i++) seeds.push({ lat: null, lng: null });
        // Not for this reader: inside the first circle, and still out of every page.
        seeds.push({ lat: hub.lat, lng: hub.lng, hidden: true }, { lat: hub.lat, lng: hub.lng, inactive: true }, { lat: hub.lat, lng: hub.lng, group: true });
        const db = world(seeds);
        const checked = checkPages(db, hub.lat, hub.lng, 'dense');
        assert.ok(checked > 30, `pages at every edge (${checked})`);
        const ids = getPosts(db, { near: hub, sortByDistance: true, limit: 200 }).map(p => p.id);
        assert.ok(!ids.includes(`p${String(seeds.length - 3).padStart(5, '0')}`) && !ids.includes(`p${String(seeds.length - 1).padStart(5, '0')}`),
            'a hidden or group post is in no page');
    });

    it('the first page of a dense town comes from a circle, not a pass over every post', () => {
        const rand = prng(2);
        const seeds: Seed[] = [];
        for (let i = 0; i < 400; i++) { const [la, ln] = around(rand, hub.lat, hub.lng, rand() * 2); seeds.push({ lat: la, lng: ln }); }
        for (let i = 0; i < 400; i++) { const [la, ln] = anywhere(rand); seeds.push({ lat: la, lng: ln }); }
        const db = world(seeds);
        const seen = watch(db);
        const page = getPosts(db, { near: hub, sortByDistance: true, limit: 50 });
        delete (db as any).prepare;
        assert.strictEqual(page.length, 50);
        assert.ok(seen.length > 0 && seen.every(r => /\blat BETWEEN \? AND \?/.test(r.sql)), `every ranking read was a box (${seen.length} reads)`);
        const last = seen[seen.length - 1];
        const plan = (db.prepare(`EXPLAIN QUERY PLAN ${last.sql}`).all(...last.params) as Array<{ detail: string }>).map(r => r.detail);
        assert.ok(plan.some(d => /idx_posts_lat_lng/.test(d)), `the circle that held the page was searched with idx_posts_lat_lng (${plan.join(' | ')})`);
    });

    it('sparse: a few posts anywhere on Earth, read from the middle of an ocean', () => {
        const rand = prng(3);
        const seeds: Seed[] = [];
        for (let i = 0; i < 200; i++) { const [la, ln] = anywhere(rand); seeds.push({ lat: la, lng: ln }); }
        for (let i = 0; i < 20; i++) seeds.push({ lat: null, lng: null });
        const db = world(seeds);
        checkPages(db, 10, -30, 'sparse, mid-Atlantic');
        checkPages(db, -48.9, -123.4, 'sparse, the oceanic pole of inaccessibility');
    });

    it('across the antimeridian: a reader either side of it, posts either side and on it', () => {
        const rand = prng(4);
        const seeds: Seed[] = [];
        for (let i = 0; i < 400; i++) { const [la, ln] = around(rand, -17, 180, rand() * 600); seeds.push({ lat: la, lng: ln }); }
        seeds.push({ lat: -17, lng: 180 }, { lat: -17, lng: -180 }, { lat: -17.001, lng: 179.9999 }, { lat: -16.999, lng: -179.9999 });
        for (let i = 0; i < 100; i++) { const [la, ln] = anywhere(rand); seeds.push({ lat: la, lng: ln }); }
        for (let i = 0; i < 10; i++) seeds.push({ lat: null, lng: null });
        const db = world(seeds);
        checkPages(db, -17.2, 179.99, 'antimeridian, east of it');
        checkPages(db, -16.8, -179.99, 'antimeridian, west of it');
        checkPages(db, -17, 180, 'on the antimeridian');
    });

    it('around the poles: readers near and on each pole', () => {
        const rand = prng(5);
        const seeds: Seed[] = [];
        for (let i = 0; i < 300; i++) { const [la, ln] = around(rand, 90, 0, rand() * 1200); seeds.push({ lat: la, lng: ln }); }
        for (let i = 0; i < 150; i++) { const [la, ln] = around(rand, -90, 0, rand() * 900); seeds.push({ lat: la, lng: ln }); }
        seeds.push({ lat: 90, lng: 0 }, { lat: 90, lng: 135 }, { lat: -90, lng: -45 });
        for (let i = 0; i < 100; i++) { const [la, ln] = anywhere(rand); seeds.push({ lat: la, lng: ln }); }
        for (let i = 0; i < 10; i++) seeds.push({ lat: null, lng: null });
        const db = world(seeds);
        checkPages(db, 89.9, 10, 'near the North Pole');
        checkPages(db, 90, -60, 'the North Pole');
        checkPages(db, -89.95, -100, 'near the South Pole');
        checkPages(db, 84, 179.95, 'near the North Pole and the antimeridian');
    });

    it('deeper than the circles go, one pass gives the same page', () => {
        const rand = prng(6);
        const seeds: Seed[] = [];
        for (let i = 0; i < NEAREST_FIRST_CIRCLES_MAX_DEPTH + 150; i++) { const [la, ln] = around(rand, hub.lat, hub.lng, rand() * 3); seeds.push({ lat: la, lng: ln }); }
        const db = world(seeds);
        const ref = bruteForce(db, hub.lat, hub.lng);
        for (const offset of [NEAREST_FIRST_CIRCLES_MAX_DEPTH - 50, NEAREST_FIRST_CIRCLES_MAX_DEPTH - 49, NEAREST_FIRST_CIRCLES_MAX_DEPTH + 60]) {
            const seen = watch(db);
            const got = getPosts(db, { near: hub, sortByDistance: true, limit: 50, offset });
            delete (db as any).prepare;
            assert.deepStrictEqual(got.map(p => p.id), ref.slice(offset, offset + 50).map(r => r.id), `offset ${offset}`);
            const onePass = seen.length === 1 && !/BETWEEN/.test(seen[0].sql);
            assert.strictEqual(onePass, offset + 50 > NEAREST_FIRST_CIRCLES_MAX_DEPTH,
                `offset ${offset}: circles only while the page ends within ${NEAREST_FIRST_CIRCLES_MAX_DEPTH}`);
        }
    });

    it('a radius caps the circles: the page is the brute-force page inside it, and nothing outside', () => {
        const rand = prng(7);
        const seeds: Seed[] = [];
        for (let i = 0; i < 800; i++) { const [la, ln] = around(rand, hub.lat, hub.lng, rand() * 60); seeds.push({ lat: la, lng: ln }); }
        for (let i = 0; i < 10; i++) seeds.push({ lat: null, lng: null });
        const db = world(seeds);
        for (const radiusKm of [0.5, 2, 20, 45]) {
            const ref = bruteForce(db, hub.lat, hub.lng, radiusKm);
            for (const [limit, offset] of [[50, 0], [7, 0], [7, Math.max(0, ref.length - 3)], [7, ref.length], [200, 0]]) {
                const got = getPosts(db, { near: { ...hub, radiusKm }, sortByDistance: true, limit, offset });
                assert.deepStrictEqual(got.map(p => p.id), ref.slice(offset, offset + limit).map(r => r.id), `radius ${radiusKm} km, limit ${limit}, offset ${offset}`);
            }
        }
    });

    it('the rows read after the ranking are the rows a read without a point returns, plus distanceKm', () => {
        const rand = prng(8);
        const seeds: Seed[] = [];
        for (let i = 0; i < 300; i++) { const [la, ln] = around(rand, hub.lat, hub.lng, rand() * 40); seeds.push({ lat: la, lng: ln }); }
        const db = world(seeds);
        const plain = new Map(getPosts(db).map(p => [p.id, p]));
        const filters: PostFilter[] = [
            { near: hub, sortByDistance: true, limit: 50 },
            { near: { ...hub, radiusKm: 10 }, sortByDistance: true, limit: 50, offset: 5 },
            { near: { ...hub, radiusKm: 10 }, limit: 50 },
        ];
        for (const filter of filters) {
            const got = getPosts(db, filter);
            assert.ok(got.length > 0);
            for (const post of got) {
                const { distanceKm, ...rest } = post;
                assert.strictEqual(typeof distanceKm, 'number');
                assert.deepStrictEqual(rest, plain.get(post.id));
            }
            assert.ok(got.some(p => p.authorFoundingNeeded) && got.some(p => !p.authorFoundingNeeded), 'authors with and without a trade');
        }
    });
});
