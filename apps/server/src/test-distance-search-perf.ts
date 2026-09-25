/**
 * Distance search (global node G4) at a global node's size. The deciding review of #1140 found that nearest first
 * without a radius measured and sorted every visible post on every request: 128 ms at 100k posts / 200k transactions,
 * against 5.4 ms for today's order, and growing with the posts on the node. That is the global Market's default read
 * (a point, no sort), each phone sends its own point so the ETag never saves it, and better-sqlite3 holds every other
 * request while it runs.
 *
 * This seeds the node's real schema (initStateEngine) with posts spread over the world's towns, reads as a signed
 * member does, and holds the listing to:
 *   1. a default nearest-first page (a point, no radius) costs a small multiple of today's order: at 20k posts / 40k
 *      transactions, and at 100k / 200k
 *   2. it does not grow with the posts on the node: at 100k it costs about what it does at 20k
 *   3. a 500 km radius, nearest first, the same
 *   4. EXPLAIN QUERY PLAN: the read that found the default page searched idx_posts_lat_lng
 *   5. the first pages are the pages a brute-force haversine over every post gives (a spot check at this size; the
 *      engine's vitest compares every edge)
 *
 * Every bound compares two times measured in the same run, medians of repeated reads, and is generous, so a slow or busy
 * machine can't fail it. The timings are printed as the table for the PR.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-distance-search-perf.ts
 */
delete process.env.NODE_PROFILE;

import { initStateEngine, seedGenesisMember, getPosts } from './state-engine.js';
import { db } from './db/db.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

/** Seeded, so a failure reproduces. */
function prng(seed: number): () => number {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const rand = prng(20260925);
const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
const R_KM = 6371;
const KM_PER_DEG = R_KM * Math.PI / 180;
const rad = (d: number) => d * Math.PI / 180;
function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
    return R_KM * 2 * Math.atan2(Math.sqrt(Math.min(1, a)), Math.sqrt(Math.max(0, 1 - a)));
}

// ── the world: 300 towns, a few big and most small; posts gather around them, and 5% have no place ────────────────
const HUB = { lat: -33.87, lng: 151.21 };
const towns = [HUB, ...Array.from({ length: 299 }, () => ({ lat: -50 + rand() * 115, lng: -180 + rand() * 360 }))];
const CATEGORIES = ['other', 'other', 'food', 'community', 'craft', 'repair', 'art', 'business', 'learn'];
const MEMBERS = 20_000;
const OWNER = '00'.repeat(32);
const members: string[] = [];

function seedMembers(): void {
    seedGenesisMember(OWNER, 'Owner');
    const ins = db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                            VALUES (?, ?, '2026-01-01T00:00:00.000Z', ?, 'TEST', 'active')`);
    db.transaction(() => {
        for (let i = 0; i < MEMBERS; i++) {
            const pk = (i + 1).toString(16).padStart(64, '0');
            members.push(pk);
            ins.run(pk, `m${i}`, OWNER);
        }
    })();
}

let postCount = 0, txCount = 0;
/** Posts and transactions up to the totals given, in one write each. */
function seedTo(posts: number, transactions: number): void {
    const insPost = db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, updated_at, lat, lng)
                                VALUES (?, ?, ?, ?, '', 0, ?, ?, ?, ?, ?)`);
    const insTx = db.prepare('INSERT INTO transactions (id, from_pubkey, to_pubkey, amount) VALUES (?, ?, ?, 1)');
    db.transaction(() => {
        for (; postCount < posts; postCount++) {
            let lat: number | null = null, lng: number | null = null;
            if (rand() > 0.05) {
                const town = towns[Math.floor(rand() ** 2 * towns.length)];
                lat = Math.max(-90, Math.min(90, town.lat + gauss() * 15 / KM_PER_DEG));
                lng = ((town.lng + gauss() * 15 / KM_PER_DEG / Math.cos(rad(town.lat)) + 540) % 360) - 180;
            }
            const at = new Date(Date.UTC(2026, 0, 1) + postCount * 60_000).toISOString();
            insPost.run(`perf-${postCount}`, rand() < 0.7 ? 'offer' : 'need', CATEGORIES[Math.floor(rand() * CATEGORIES.length)],
                `Post ${postCount}`, members[Math.floor(rand() * MEMBERS)], at, at, lat, lng);
        }
        for (; txCount < transactions; txCount++) {
            insTx.run(`perf-tx-${txCount}`, members[Math.floor(rand() * MEMBERS)], members[Math.floor(rand() * MEMBERS)]);
        }
    })();
}

/** The median of repeated reads, after a few to warm up. */
function median(read: () => unknown[], reps = 15): number {
    for (let i = 0; i < 3; i++) read();
    const times: number[] = [];
    for (let i = 0; i < reps; i++) {
        const t = performance.now();
        read();
        times.push(performance.now() - t);
    }
    return times.sort((a, b) => a - b)[Math.floor(reps / 2)];
}

// As the route reads for a signed member: the Market's default page, 50 posts, events left out.
const VIEWER = () => members[0];
const page = (extra: Record<string, unknown> = {}) => getPosts({ limit: 50, offset: 0, excludeEvents: true, viewerPubkey: VIEWER(), ...extra });
const nearestFirst = { near: HUB, sortByDistance: true };
const radius500 = { near: { ...HUB, radiusKm: 500 }, sortByDistance: true };

interface Row { size: string; recent: number; nearest: number; radius: number; radiusRecent: number; far: number }
// No town is south of 50°S, so no post is within 3,000 km of here: the one reader whose page takes a pass over every post.
const FAR = { lat: -80, lng: 0 };
function measure(size: string): Row {
    return {
        size,
        recent: median(() => page()),
        nearest: median(() => page(nearestFirst)),
        radius: median(() => page(radius500)),
        radiusRecent: median(() => page({ near: { ...HUB, radiusKm: 500 } })),
        far: median(() => page({ near: FAR, sortByDistance: true }), 7),
    };
}
/** A small multiple, with room for a timer's noise on a fast machine. */
const smallMultipleOf = (t: number, base: number) => t <= Math.max(3 * base, base + 15);

async function main(): Promise<void> {
    console.log('\n=== Distance search (G4) at scale ===\n');
    initStateEngine();
    seedMembers();

    const rows: Row[] = [];
    let t = performance.now();
    seedTo(20_000, 40_000);
    console.log(`seeded 20,000 posts / 40,000 transactions in ${Math.round(performance.now() - t)} ms`);
    rows.push(measure('20k / 40k'));
    t = performance.now();
    seedTo(100_000, 200_000);
    console.log(`seeded to 100,000 posts / 200,000 transactions in ${Math.round(performance.now() - t)} ms`);
    rows.push(measure('100k / 200k'));

    // The last two columns are printed, not held to a bound: sort=recent with a radius is the planner's one pass, and a
    // reader 3,000 km from every post needs one pass over every post.
    console.log('\n| posts / transactions | today\'s order | nearest first (a point, no radius) | radius 500 km, nearest first | radius 500 km, today\'s order | nearest first, 3,000 km from every post |');
    console.log('|---|---|---|---|---|---|');
    for (const r of rows) console.log(`| ${r.size} | ${r.recent.toFixed(1)} ms | ${r.nearest.toFixed(1)} ms | ${r.radius.toFixed(1)} ms | ${r.radiusRecent.toFixed(1)} ms | ${r.far.toFixed(1)} ms |`);
    console.log('');

    // ── 1–3. the default page, and a radius ──────────────────────────────────────────────────────
    for (const r of rows) {
        assert(smallMultipleOf(r.nearest, r.recent),
            `${r.size}: a default nearest-first page costs a small multiple of today's order (${r.nearest.toFixed(1)} ms against ${r.recent.toFixed(1)} ms)`);
        assert(smallMultipleOf(r.radius, r.recent),
            `${r.size}: a 500 km radius, nearest first, likewise (${r.radius.toFixed(1)} ms against ${r.recent.toFixed(1)} ms)`);
    }
    const [small, large] = rows;
    assert(large.nearest <= 2 * small.nearest + 10,
        `five times the posts, and the nearest-first page costs about the same (${small.nearest.toFixed(1)} ms at 20k, ${large.nearest.toFixed(1)} ms at 100k)`);
    assert(large.radius <= 2 * small.radius + 10,
        `and the 500 km radius (${small.radius.toFixed(1)} ms at 20k, ${large.radius.toFixed(1)} ms at 100k)`);

    // ── 4. the index ─────────────────────────────────────────────────────────────────────────────
    const prepare = db.prepare.bind(db);
    const reads: Array<{ sql: string; params: unknown[] }> = [];
    (db as any).prepare = (sql: string) => {
        const st = prepare(sql);
        if (/haversine_km/.test(sql)) {
            const all = st.all.bind(st);
            (st as any).all = (...params: unknown[]) => { reads.push({ sql, params }); return all(...params); };
        }
        return st;
    };
    let first: ReturnType<typeof page>;
    try { first = page(nearestFirst); } finally { delete (db as any).prepare; }
    const found = reads[reads.length - 1];
    const plan = found ? (db.prepare(`EXPLAIN QUERY PLAN ${found.sql}`).all(...found.params) as Array<{ detail: string }>).map(r => r.detail) : [];
    assert(plan.some(d => /idx_posts_lat_lng/.test(d)),
        `the read that found the default page searched idx_posts_lat_lng (${reads.length} read(s); ${plan.join(' | ') || 'none captured'})`);

    // ── 5. the page itself ───────────────────────────────────────────────────────────────────────
    // Every seeded post is a live, public offer or need by an active member, so every post is visible; the reference is
    // measured here from the rows alone.
    const all = db.prepare(`SELECT id, lat, lng, updated_at, created_at FROM posts WHERE id LIKE 'perf-%'`).all() as Array<{ id: string; lat: number | null; lng: number | null; updated_at: string; created_at: string }>;
    const by = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const reference = all
        .map(p => ({ id: p.id, u: p.updated_at, c: p.created_at, d: p.lat === null || p.lng === null ? null : haversine(HUB.lat, HUB.lng, p.lat, p.lng) }))
        .sort((a, b) => (a.d === null ? 1 : 0) - (b.d === null ? 1 : 0) || (a.d ?? 0) - (b.d ?? 0) || by(b.u, a.u) || by(b.c, a.c) || by(a.id, b.id));
    const pages = [0, 50, 1000].map(offset => ({ offset, got: page({ ...nearestFirst, offset }).map(p => p.id), want: reference.slice(offset, offset + 50).map(r => r.id) }));
    assert(first.length === 50 && pages.every(p => JSON.stringify(p.got) === JSON.stringify(p.want)),
        `the pages at offsets 0, 50 and 1,000 are the brute-force pages (${pages.map(p => `${p.offset}: ${p.got.length} posts, ${p.got.filter((id, i) => id !== p.want[i]).length} different`).join('; ')})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ A nearest-first page reads the posts near the reader, not every post on the node.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
