import { afterEach, describe, it } from 'vitest';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import {
    generateSearchKeywords, getPosts, guestPost, publicBroadcastPost, NEAREST_FIRST_CIRCLES_KM, NEAREST_FIRST_CIRCLES_MAX_DEPTH,
    HIDDEN_AUTHOR, type MarketplacePost, type PostFilter,
} from '../posts.js';
import { areaBox, boundingBox, haversineKm, registerGeoFunctions, roundToArea, MAX_RADIUS_KM } from '../geo.js';

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

// A visitor on the global node (G9a): the listing and its area, and nobody. The node's HTTP suite (apps/server
// test-guest-view) walks every public read and 200 query points; these pin the engine's own contract.
describe('The listings, not the people (G9a)', () => {
    it('roundToArea: 0.1° to the nearest step, halves up, never -0', () => {
        assert.strictEqual(roundToArea(-28.53417), -28.5);
        assert.strictEqual(roundToArea(153.45), 153.5);
        assert.strictEqual(roundToArea(-0.04), 0);
        assert.ok(!Object.is(roundToArea(-0.04), -0));
        assert.strictEqual(roundToArea(179.97), 180);
        assert.strictEqual(roundToArea(-179.97), -180);
        for (const x of [-89.96, 0.3, 12.34, -45.55]) assert.strictEqual(roundToArea(roundToArea(x)), roundToArea(x));
    });

    it('area_km is haversine_km from the area of the place, and NULL for a missing place', () => {
        const db = new Database(':memory:');
        registerGeoFunctions(db);
        const d = (db.prepare('SELECT area_km(-28.55, 153.51, -28.53417, 153.49871) AS d').get() as { d: number }).d;
        assert.strictEqual(d, haversineKm(-28.55, 153.51, -28.5, 153.5));
        assert.strictEqual((db.prepare('SELECT area_km(1, 2, NULL, 4) AS d').get() as { d: number | null }).d, null);
    });

    it('areaBox holds every place whose area is inside the box, and a box holding no area holds nothing', () => {
        let seed = 11;
        const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
        const inBox = (b: ReturnType<typeof boundingBox>, lat: number, lng: number) =>
            lat >= b.latMin && lat <= b.latMax && b.lngRanges.some(([lo, hi]) => lng >= lo && lng <= hi);
        for (const [lat, lng, r] of [[-28.55, 153.5, 1], [-28.55, 153.5, 5], [-33.87, 151.21, 10], [-17.7, 179.97, 30], [-16, -179.98, 8],
            [89.97, 45, 4], [-89.99, 170, 20], [0, 180, 12], [0.02, -0.03, 6], [60, 179.9, 50]]) {
            const box = boundingBox(lat, lng, r);
            const area = areaBox(box);
            for (let i = 0; i < 4000; i++) {
                const pLat = Math.max(-90, Math.min(90, lat + (rand() - 0.5) * 2));
                const pLng = ((lng + (rand() - 0.5) * 4 + 540) % 360) - 180;
                if (!inBox(box, roundToArea(pLat), roundToArea(pLng))) continue;
                assert.ok(inBox(area, pLat, pLng), `(${pLat}, ${pLng}) has its area (${roundToArea(pLat)}, ${roundToArea(pLng)}) in the box of ${r} km from (${lat}, ${lng}), but is outside areaBox`);
            }
            // The areas on the antimeridian go by two names: a place rounding to -180 is inside a box that holds 180.
            if (box.lngRanges.some(([, hi]) => hi >= 180)) assert.ok(inBox(area, lat, -179.99) || !inBox(box, roundToArea(lat), 180));
        }
        // 1 km around a point 3 km from the nearest area's centre: no area, so nothing to read.
        const none = areaBox(boundingBox(-33.87, 151.21, 1));
        assert.ok(none.latMin > none.latMax, `an empty box (got ${JSON.stringify(none)})`);
    });

    const member = {
        id: 'p1', type: 'offer', category: 'food', title: 'Lemons', description: 'A bag', credits: 0, priceType: 'fixed',
        authorPublicKey: 'a'.repeat(64), authorCallsign: 'Ann', createdAt: '2026-09-24T01:00:00.000Z', updatedAt: '2026-09-24T01:00:00.000Z',
        active: true, status: 'pending', repeatable: false, cashAlsoNeeded: false, acceptedBy: 'b'.repeat(64), acceptedByCallsign: 'Bo',
        acceptedAt: '2026-09-24T02:00:00.000Z', pendingTransactionId: 'tx1', lat: -28.53417, lng: 153.49871, photos: ['/api/marketplace/posts/p1/photos/0?v=1'],
        originNode: 'node1', reach: 'local', reachPeers: ['12D3KooWPeer'], authorEnergyCycled: 250, authorFoundingNeeded: true,
        authorAvatarUrl: `/api/avatar/${'a'.repeat(64)}?size=thumb&v=abc`, createdBy: 'c'.repeat(64), audienceScope: 'public',
        distanceKm: 3.7,
    } as MarketplacePost;

    it('guestPost keeps the listing and its area, and names nobody', () => {
        const out = guestPost(member);
        assert.deepStrictEqual(out, {
            id: 'p1', type: 'offer', category: 'food', title: 'Lemons', description: 'A bag', credits: 0, priceType: 'fixed',
            createdAt: member.createdAt, updatedAt: member.updatedAt, active: true, status: 'pending', repeatable: false, cashAlsoNeeded: false,
            photos: member.photos, originNode: 'node1', reach: 'local', audienceScope: 'public',
            authorPublicKey: HIDDEN_AUTHOR, authorCallsign: '', acceptedByCallsign: '', authorAvatarUrl: null, authorEnergyCycled: 0,
            authorFoundingNeeded: false, lat: -28.5, lng: 153.5, distanceKm: 4,
        });
        assert.strictEqual(member.authorPublicKey, 'a'.repeat(64), "the caller's copy is untouched");
    });

    it('guestPost drops the voters, the RSVPs, the typed place and the scope; keeps the counts', () => {
        const poll = guestPost({ ...member, type: 'poll', pollOptions: [{ id: 'o', text: 'Yes', votes: 1, percentage: 100 }], totalVotes: 1,
            userVotedOptionId: 'o', pollVotes: [{ voterPubkey: 'b'.repeat(64), voterCallsign: 'Bo', optionId: 'o', createdAt: member.createdAt }] });
        assert.ok(!('pollVotes' in poll) && !('userVotedOptionId' in poll) && poll.totalVotes === 1 && poll.pollOptions?.[0].votes === 1);
        const event = guestPost({ ...member, type: 'event', eventPlaceName: '42 Crescent St', eventPrivateNote: 'Gate 1234', myRsvp: 'going',
            eventRsvps: [{ memberPubkey: 'b'.repeat(64), status: 'going', updatedAt: member.createdAt }], goingCount: 1, eventState: 'scheduled',
            targetPubkey: 'd'.repeat(64), assignedTo: 'd'.repeat(64), targetGroupId: 'g1', targetGroupName: 'Club', hiddenByReportsAt: member.createdAt });
        for (const f of ['eventPlaceName', 'eventPrivateNote', 'myRsvp', 'eventRsvps', 'targetPubkey', 'assignedTo', 'targetGroupId', 'targetGroupName', 'hiddenByReportsAt']) {
            assert.ok(!(f in event), `${f} is dropped`);
        }
        assert.ok(event.goingCount === 1 && event.eventState === 'scheduled');
    });

    it('guestPost drops a field it does not know, and a removal stays a removal', () => {
        const out = guestPost({ ...member, somethingNew: 'e'.repeat(64) } as MarketplacePost);
        assert.ok(!('somethingNew' in out));
        const removal = guestPost({ id: 'p2', type: 'offer', category: 'food', title: '', description: '', credits: 0, authorPublicKey: 'a'.repeat(64),
            authorCallsign: 'Ann', createdAt: member.createdAt, active: false, status: 'cancelled', photos: [] } as MarketplacePost);
        assert.deepStrictEqual(Object.keys(removal).sort(), ['active', 'authorCallsign', 'authorPublicKey', 'category', 'createdAt', 'credits', 'description', 'id', 'photos', 'status', 'title', 'type']);
        assert.strictEqual(removal.authorPublicKey, HIDDEN_AUTHOR);
    });
});

// Nearest first is searched in widening circles (posts.ts NEAREST_FIRST_CIRCLES_KM) and ranked on ids before the page's
// rows are read (the deciding review of #1140). Held here to a brute-force haversine over every visible post: the same
// page, in the same order, wherever the page falls — inside a circle, across a circle's edge, across the last post with
// a place, and past the end.
describe('Nearest first, searched in widening circles (G4)', { timeout: 60_000 }, () => {
    // CI (2026-09-26): these tests are long synchronous SQLite work, and vitest runs them back to back without letting the
    // worker's event loop turn, so its reply to the main process timed out ("Timeout calling onTaskUpdate") although every
    // test passed. One turn of the event loop after each test lets the reply through; no assertion or data changes.
    afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
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

    it('a radius is one pass over its box: the page is the brute-force page inside it, and nothing outside', () => {
        const rand = prng(7);
        const seeds: Seed[] = [];
        for (let i = 0; i < 800; i++) { const [la, ln] = around(rand, hub.lat, hub.lng, rand() * 60); seeds.push({ lat: la, lng: ln }); }
        for (let i = 0; i < 10; i++) seeds.push({ lat: null, lng: null });
        const db = world(seeds);
        for (const radiusKm of [0.5, 2, 20, 45]) {
            const ref = bruteForce(db, hub.lat, hub.lng, radiusKm);
            for (const [limit, offset] of [[50, 0], [7, 0], [7, Math.max(0, ref.length - 3)], [7, ref.length], [200, 0]]) {
                const seen = watch(db);
                const got = getPosts(db, { near: { ...hub, radiusKm }, sortByDistance: true, limit, offset });
                delete (db as any).prepare;
                assert.deepStrictEqual(got.map(p => p.id), ref.slice(offset, offset + limit).map(r => r.id), `radius ${radiusKm} km, limit ${limit}, offset ${offset}`);
                assert.ok(seen.length === 1 && !/CROSS JOIN/.test(seen[0].sql), `radius ${radiusKm} km, offset ${offset}: one pass (${seen.length} reads)`);
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

// A circle reads every post in it, whatever the filter, so for a filter that few posts near the reader match, circles
// cost more than the one pass (the second and third deciding reviews of #1140). So circles are only for a read with no
// filter, or offers or needs (posts.ts CIRCLE_FIELDS), and every other read takes one pass. Held here to: the path each
// read takes, decided by the kind of filter and nothing else; and the brute-force page on both paths.
describe('Nearest first: circles only for the reads they suit (G4)', { timeout: 60_000 }, () => {
    // CI (2026-09-26): these tests are long synchronous SQLite work, and vitest runs them back to back without letting the
    // worker's event loop turn, so its reply to the main process timed out ("Timeout calling onTaskUpdate") although every
    // test passed. One turn of the event loop after each test lets the reply through; no assertion or data changes.
    afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
    const hub = { lat: -28.55, lng: 153.5 };   // 1,200 offers and 300 needs within a kilometre, none in the categories read here
    const town = { lat: -37.07, lng: 144.22 }; // 1,400 'common' posts within 2 km, and nothing else
    const quiet = { lat: 10, lng: -30 };        // 30 posts within a kilometre and 400 more within three
    // A village where half the posts are 'farm', which is rare everywhere else, 2 km from a city of 1,500 posts.
    const village = { lat: 45.2, lng: 5.7 };
    const city = { lat: 45.2 + 2 / (6371 * Math.PI / 180), lng: 5.7 };
    // A hamlet where half the posts are 'crop', in a town with a few more, in a wider town with none.
    const hamlet = { lat: 60.1, lng: 25.0 };
    const FUTURE = '2099-01-01T00:00:00.000Z', PAST = '2000-01-01T00:00:00.000Z';
    const SHOWN = 1100;                         // 'rare' posts, and events still to come, the listing shows anyone
    const NOT_SHOWN = 110;                      // of each kind it leaves out
    const DEEP = 1000;                          // pages around here, as well as the first and the last

    function prng(seed: number): () => number {
        let x = seed >>> 0;
        return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; };
    }
    function around(rand: () => number, lat: number, lng: number, km: number): [number, number] {
        const d = km / 6371, b = rand() * 2 * Math.PI, φ = lat * Math.PI / 180, λ = lng * Math.PI / 180;
        const φ2 = Math.asin(Math.min(1, Math.max(-1, Math.sin(φ) * Math.cos(d) + Math.cos(φ) * Math.sin(d) * Math.cos(b))));
        const λ2 = λ + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(φ), Math.cos(d) - Math.sin(φ) * Math.sin(φ2));
        return [φ2 * 180 / Math.PI, ((λ2 * 180 / Math.PI + 540) % 360) - 180];
    }
    /** Somewhere between 5 and 2,000 km from the hub, so no rare post is in the hub's first circles. */
    const awayFromHub = (rand: () => number) => around(rand, hub.lat, hub.lng, 5 + rand() * 1995);

    interface Row { type?: string; category: string; at: [number, number]; author?: string; active?: number; status?: string;
        hidden?: boolean; scope?: 'public' | 'group' | 'direct'; group?: string; target?: string; eventEnd?: string; cash?: number }

    function listing(): Database.Database {
        const db = new Database(':memory:');
        registerGeoFunctions(db);
        db.exec(POSTS_FIXTURE_DDL);
        db.exec('CREATE INDEX idx_posts_lat_lng ON posts(lat, lng)');
        // An event read by a signed member asks whether they host it (posts.ts isEventHost).
        db.exec('CREATE TABLE treasury_operators (member_pubkey TEXT, treasury_pubkey TEXT)');
        // v0 reads and belongs to nothing; v1 is in the club; h0 wrote the posts hidden by reports; g0 convenes the club.
        db.exec(`INSERT INTO members (public_key, callsign, paused, status) VALUES
                     ('a0', 'Ann', 0, 'active'), ('v0', 'Viv', 0, 'active'), ('v1', 'Val', 0, 'active'), ('h0', 'Hal', 0, 'active'),
                     ('g0', 'Gus', 0, 'active'), ('hol', 'Holly', 0, 'active'), ('pau', 'Paula', 1, 'active'), ('wnd', 'Wendy', 0, 'winding_up');
                 INSERT INTO member_preferences (public_key, pref_key, pref_value) VALUES ('hol', 'holiday_mode', 'true');
                 INSERT INTO groups (id, name, slug) VALUES ('club', 'Club', 'club');
                 INSERT INTO group_members (group_id, member_pubkey, status) VALUES ('club', 'g0', 'active'), ('club', 'v1', 'active');`);
        const rand = prng(11);
        const rows: Row[] = [];
        for (let i = 0; i < 1200; i++) rows.push({ category: 'other', at: around(rand, hub.lat, hub.lng, rand() * 0.8), cash: i % 10 === 0 ? 1 : 0 });
        for (let i = 0; i < 300; i++) rows.push({ type: 'need', category: 'other', at: around(rand, hub.lat, hub.lng, rand() * 0.8) });
        // 'rare': SHOWN the listing shows anyone, and NOT_SHOWN of each kind it leaves out for v0.
        for (let i = 0; i < SHOWN; i++) rows.push({ category: 'rare', at: awayFromHub(rand) });
        for (let i = 0; i < NOT_SHOWN; i++) {
            rows.push({ category: 'rare', at: awayFromHub(rand), author: 'h0', hidden: true });
            rows.push({ category: 'rare', at: awayFromHub(rand), active: 0 });
            rows.push({ category: 'rare', at: awayFromHub(rand), status: 'cancelled' });
            rows.push({ category: 'rare', at: awayFromHub(rand), author: 'g0', scope: 'group', group: 'club' });
            rows.push({ category: 'rare', at: awayFromHub(rand), author: 'a0', scope: 'direct', target: 'wnd' });
            rows.push({ category: 'rare', at: awayFromHub(rand), author: 'hol' });
            rows.push({ category: 'rare', at: awayFromHub(rand), author: 'pau' });
            rows.push({ category: 'rare', at: awayFromHub(rand), author: 'wnd' });
        }
        // Events: SHOWN still to come, and NOT_SHOWN that have ended.
        for (let i = 0; i < SHOWN; i++) rows.push({ type: 'event', category: 'meet', at: awayFromHub(rand), eventEnd: FUTURE });
        for (let i = 0; i < NOT_SHOWN; i++) rows.push({ type: 'event', category: 'meet', at: awayFromHub(rand), eventEnd: PAST });
        for (let i = 0; i < 1400; i++) rows.push({ category: 'common', at: around(rand, town.lat, town.lng, rand() * 2) });
        for (let i = 0; i < 400; i++) rows.push({ category: 'faraway', at: around(rand, town.lat, town.lng, 3500 + rand() * 5000) });
        for (let i = 0; i < 30; i++) rows.push({ category: 'other', at: around(rand, quiet.lat, quiet.lng, rand() * 0.7) });
        for (let i = 0; i < 400; i++) rows.push({ category: 'other', at: around(rand, quiet.lat, quiet.lng, 1.5 + rand() * 1.3) });
        for (let i = 0; i < 40; i++) rows.push({ category: 'farm', at: around(rand, village.lat, village.lng, rand() * 0.5) });
        for (let i = 0; i < 40; i++) rows.push({ category: 'other', at: around(rand, village.lat, village.lng, rand() * 0.5) });
        for (let i = 0; i < 1500; i++) rows.push({ category: 'other', at: around(rand, city.lat, city.lng, rand() * 0.8) });
        for (let i = 0; i < 200; i++) rows.push({ category: 'farm', at: around(rand, village.lat, village.lng, 3500 + rand() * 5000) });
        for (let i = 0; i < 5; i++) rows.push({ category: 'crop', at: around(rand, hamlet.lat, hamlet.lng, rand() * 0.5) });
        for (let i = 0; i < 5; i++) rows.push({ category: 'other', at: around(rand, hamlet.lat, hamlet.lng, rand() * 0.5) });
        for (let i = 0; i < 40; i++) rows.push({ category: 'crop', at: around(rand, hamlet.lat, hamlet.lng, 1.5 + rand() * 1.3) });
        for (let i = 0; i < 400; i++) rows.push({ category: 'other', at: around(rand, hamlet.lat, hamlet.lng, 1.5 + rand() * 1.3) });
        for (let i = 0; i < 500; i++) rows.push({ category: 'other', at: around(rand, hamlet.lat, hamlet.lng, 4.5 + rand() * 4.5) });
        for (let i = 0; i < 200; i++) rows.push({ category: 'crop', at: around(rand, hamlet.lat, hamlet.lng, 3500 + rand() * 5000) });
        const ins = db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, updated_at, lat, lng,
                                                   active, status, hidden_by_reports_at, audience_scope, target_group_id, target_pubkey, event_end_at,
                                                   cash_also_needed)
                                VALUES (?, ?, ?, ?, '', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        db.transaction(() => rows.forEach((r, i) => {
            const updated = new Date(Date.UTC(2026, 0, 1, 0, i % 13)).toISOString();
            const created = new Date(Date.UTC(2025, 0, 1, 0, i % 7)).toISOString();
            ins.run(`q${String(i).padStart(5, '0')}`, r.type ?? 'offer', r.category, `Post ${i % 3 ? 'plain' : 'bike'} ${i}`, r.author ?? 'a0', created, updated,
                r.at[0], r.at[1], r.active ?? 1, r.status ?? 'active', r.hidden ? updated : null, r.scope ?? 'public', r.group ?? null,
                r.target ?? null, r.eventEnd ?? null, r.cash ?? 0);
        }))();
        // A search reads posts_fts (the node's schema keeps it in step with triggers; here it is built once).
        db.exec(`CREATE VIRTUAL TABLE posts_fts USING fts5(title, description, content='posts', content_rowid='rowid');
                 INSERT INTO posts_fts(posts_fts) VALUES ('rebuild');`);
        return db;
    }

    /** The reference: the posts the same read shows without a point, measured and sorted here; within a radius, if given. */
    function bruteForce(db: Database.Database, filter: PostFilter, lat: number, lng: number, radiusKm?: number) {
        const by = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
        return getPosts(db, filter)
            .map(p => ({ id: p.id, u: p.updatedAt ?? '', c: p.createdAt, d: typeof p.lat === 'number' && typeof p.lng === 'number' ? haversineKm(lat, lng, p.lat, p.lng) : null }))
            .filter(p => radiusKm === undefined || (p.d !== null && p.d <= radiusKm))
            .sort((a, b) => (a.d === null ? 1 : 0) - (b.d === null ? 1 : 0) || (a.d ?? 0) - (b.d ?? 0) || by(b.u, a.u) || by(b.c, a.c) || by(a.id, b.id));
    }

    /** The reads a page with a point makes, in order: a circle (a box joined to the listing), or one pass. */
    function trace(db: Database.Database, filter: PostFilter): { page: MarketplacePost[]; steps: string } {
        const steps: string[] = [];
        const prepare = db.prepare.bind(db);
        (db as any).prepare = (sql: string) => {
            const st = prepare(sql);
            const kind = /CROSS JOIN posts p/.test(sql) ? 'circle' : /haversine_km/.test(sql) ? 'pass' : undefined;
            if (!kind) return st;
            const all = st.all.bind(st);
            (st as any).all = (...params: unknown[]) => { steps.push(kind); return all(...params); };
            return st;
        };
        try { return { page: getPosts(db, filter), steps: steps.join(' → ') }; } finally { delete (db as any).prepare; }
    }

    /** Pages all through the read (limits 7 and 50, around DEEP, past the end), each compared with the reference. */
    function checkPages(db: Database.Database, filter: PostFilter, at: { lat: number; lng: number }, what: string): number {
        const ref = bruteForce(db, filter, at.lat, at.lng);
        const pages: Array<[number, number]> = [[50, 0], [7, 0], [7, 7], [7, 200], [7, ref.length - 3], [7, ref.length], [50, ref.length + 5]];
        for (const o of [DEEP - 60, DEEP - 7, DEEP - 1, DEEP]) pages.push([7, o], [50, o]);
        for (const [limit, offset] of pages) {
            if (offset < 0) continue;
            const got = getPosts(db, { ...filter, near: at, sortByDistance: true, limit, offset });
            const want = ref.slice(offset, offset + limit);
            assert.deepStrictEqual(got.map(p => p.id), want.map(r => r.id), `${what}: limit ${limit}, offset ${offset}`);
            assert.deepStrictEqual(got.map(p => p.distanceKm), want.map(r => r.d === null ? null : Math.round(r.d * 10) / 10), `${what}: distances, offset ${offset}`);
        }
        return ref.length;
    }

    const db = listing();
    const rare = { category: 'rare', excludeEvents: true };

    describe('no filter, the listing\'s own rules, and offers or needs: circles only, and the first that holds the page gives it', () => {
        const reads: Array<[string, PostFilter]> = [
            ['no filter', {}],
            ['a signed member, events left out', { viewerPubkey: 'v0', excludeEvents: true }],
            ['a moderator', { viewerPubkey: 'v0', includeHidden: true }],
            ['type=offer', { type: 'offer' }],
            ['type=need', { type: 'need' }],
            ["the apps' feed, types=offer,need,poll,event", { types: ['offer', 'need', 'poll', 'event'] }],
            ['types=need,poll', { types: ['need', 'poll'] }],
            ['type=offer and types=offer,event', { type: 'offer', types: ['offer', 'event'] }],
            ["type and category 'all', read as no filter", { type: 'all', category: 'all' }],
            ['fields set to nothing', { category: '', query: '', beansOnly: false, sync: false, authorPubkey: undefined }],
        ];
        for (const [what, filter] of reads) it(what, () => {
            const { page, steps } = trace(db, { ...filter, near: hub, sortByDistance: true, limit: 50 });
            assert.ok(/^circle( → circle)*$/.test(steps), `${what}: ${steps || 'nothing read'}`);
            assert.deepStrictEqual(page.map(p => p.id), bruteForce(db, filter, hub.lat, hub.lng).slice(0, 50).map(r => r.id), `${what}: the brute-force page`);
        });
    });

    describe('every other read: one pass, and no circle, whatever it matches near the reader', () => {
        const reads: Array<[string, PostFilter]> = [
            ['type=event', { type: 'event' }],
            ['type=poll', { type: 'poll' }],
            ['a rare category', rare],
            ['a category with no posts', { category: 'none' }],
            // Even a category that fills the reader's first circle: the kind of filter decides, not how many it matches.
            ['a category common near the reader', { category: 'other' }],
            ['one author', { authorPubkey: 'a0' }],
            ['a group scope', { audienceScope: 'group', viewerPubkey: 'v1' }],
            ['a direct scope', { audienceScope: 'direct', viewerPubkey: 'wnd' }],
            ['public posts only', { audienceScope: 'public' }],
            ['one group', { targetGroupId: 'club', viewerPubkey: 'v1' }],
            ['one assignee', { assignedTo: 'v0' }],
            ['beans only', { beansOnly: true }],
            ['a search', { query: 'bike' }],
            ['a status', { status: 'active' }],
            ['inactive posts too', { includeInactive: true }],
            ['every scope', { includeAllScopes: true }],
            ['events and polls', { types: ['poll', 'event'] }],
            ['type=offer and types=need,poll, which keep nothing', { type: 'offer', types: ['need', 'poll'] }],
            ['a type the listing doesn\'t know', { type: 'gift' }],
            ['a field PostFilter doesn\'t name', { addedLater: 'x' } as PostFilter],
        ];
        for (const [what, filter] of reads) it(what, () => {
            const { page, steps } = trace(db, { ...filter, near: hub, sortByDistance: true, limit: 50 });
            assert.strictEqual(steps, 'pass', `${what}: ${steps || 'nothing read'}`);
            assert.deepStrictEqual(page.map(p => p.id), bruteForce(db, filter, hub.lat, hub.lng).slice(0, 50).map(r => r.id), `${what}: the brute-force page`);
        });
        // A radius, today's order with a point, and a page deeper than the circles go: one pass, with no filter too.
        const plain: Array<[string, PostFilter, number | undefined]> = [
            ['a radius', { near: { ...hub, radiusKm: 50 }, sortByDistance: true, limit: 50 }, 50],
            ['type=offer within a radius', { type: 'offer', near: { ...hub, radiusKm: 50 }, sortByDistance: true, limit: 50, offset: 1180 }, 50],
            ["today's order with a point", { near: hub, limit: 50 }, undefined],
            ['a page past NEAREST_FIRST_CIRCLES_MAX_DEPTH', { near: hub, sortByDistance: true, limit: 50, offset: NEAREST_FIRST_CIRCLES_MAX_DEPTH }, undefined],
        ];
        for (const [what, filter, radiusKm] of plain) it(what, () => {
            const { page, steps } = trace(db, filter);
            assert.strictEqual(steps, 'pass', `${what}: ${steps || 'nothing read'}`);
            const { near, sortByDistance, limit, offset, ...rest } = filter;
            const want = sortByDistance ? bruteForce(db, rest, hub.lat, hub.lng, radiusKm).map(r => r.id) : getPosts(db, rest).map(p => p.id);
            assert.ok(page.length > 0 || want.length <= (offset ?? 0), `${what}: a page (${page.length} posts)`);
            assert.deepStrictEqual(page.map(p => p.id), want.slice(offset ?? 0, (offset ?? 0) + limit!), `${what}: the brute-force page`);
            void near;
        });
    });

    it('each reader is shown what the listing shows them: the rules hold on the one pass', () => {
        // v0 is shown SHOWN of 'rare'. Each of these is shown NOT_SHOWN more: the posts hidden by reports to their author and
        // to a moderator, the club's posts to a member of it. The rest (inactive, cancelled, a direct post, holiday mode, a
        // paused or winding-up author) nobody here is shown.
        for (const [who, filter, shown] of [
            ['a signed member', { ...rare, viewerPubkey: 'v0' }, SHOWN],
            ['a reader who is not signed in', rare, SHOWN],
            ['the author of the posts hidden by reports', { ...rare, viewerPubkey: 'h0' }, SHOWN + NOT_SHOWN],
            ['a moderator', { ...rare, viewerPubkey: 'v0', includeHidden: true }, SHOWN + NOT_SHOWN],
            ['a member of the club', { ...rare, viewerPubkey: 'v1' }, SHOWN + NOT_SHOWN],
        ] as Array<[string, PostFilter, number]>) {
            const ref = bruteForce(db, filter, hub.lat, hub.lng);
            assert.strictEqual(ref.length, shown, `${who} is shown ${shown}`);
            checkPages(db, filter, hub, who);
        }
    });

    describe('on both paths, from every place, every page is the brute-force page', () => {
        const reads: Array<[string, PostFilter, { lat: number; lng: number }]> = [
            ['no filter, from the hub', { viewerPubkey: 'v0' }, hub],
            ['no filter, from the quiet place', { excludeEvents: true, viewerPubkey: 'v0' }, quiet],
            ['no filter, from the village', { excludeEvents: true, viewerPubkey: 'v0' }, village],
            ['type=need, from the hub', { type: 'need', viewerPubkey: 'v0' }, hub],
            ['type=need, from the town, with none near it', { type: 'need', viewerPubkey: 'v0' }, town],
            ["the apps' feed, from the hamlet", { types: ['offer', 'need', 'poll', 'event'], viewerPubkey: 'v0' }, hamlet],
            ['rare, v1, from the quiet place', { ...rare, viewerPubkey: 'v1' }, quiet],
            ['events still to come, from the hub', { type: 'event', viewerPubkey: 'v0' }, hub],
            ['events still to come, from the town', { type: 'event', viewerPubkey: 'v0' }, town],
            ['common (1,400), from the town', { category: 'common', excludeEvents: true, viewerPubkey: 'v0' }, town],
            ['common (1,400), from the hub', { category: 'common', excludeEvents: true, viewerPubkey: 'v0' }, hub],
            ['faraway (400), from the town', { category: 'faraway', excludeEvents: true, viewerPubkey: 'v0' }, town],
            ['farm (240), from the village', { category: 'farm', excludeEvents: true, viewerPubkey: 'v0' }, village],
            ['crop (245), from the hamlet', { category: 'crop', excludeEvents: true, viewerPubkey: 'v0' }, hamlet],
            ['other, from the village', { category: 'other', excludeEvents: true, viewerPubkey: 'v0' }, village],
        ];
        for (const [what, filter, at] of reads) it(what, () => {
            const n = checkPages(db, filter, at, what);
            assert.ok(n > 0, `${what}: ${n} posts`);
        });
        for (const [what, filter] of [['rare, h0', { ...rare, viewerPubkey: 'h0' }], ['no filter', { viewerPubkey: 'v0' }]] as Array<[string, PostFilter]>) it(`${what}, within a radius`, () => {
            for (const radiusKm of [0.5, 100, 800, 2500]) {
                const ref = bruteForce(db, filter, hub.lat, hub.lng, radiusKm);
                for (const [limit, offset] of [[50, 0], [7, 3], [7, Math.max(0, ref.length - 2)]]) {
                    const got = getPosts(db, { ...filter, near: { ...hub, radiusKm }, sortByDistance: true, limit, offset });
                    assert.deepStrictEqual(got.map(p => p.id), ref.slice(offset, offset + limit).map(r => r.id), `${what} within ${radiusKm} km, offset ${offset}`);
                }
            }
        });
    });
});
