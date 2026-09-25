/**
 * Distance search (global node G4) at a global node's size. The deciding review of #1140 found that nearest first
 * without a radius measured and sorted every visible post on every request: 128 ms at 100k posts / 200k transactions,
 * against 5.4 ms for today's order, and growing with the posts on the node. That is the global Market's default read
 * (a point, no sort), each phone sends its own point so the ETag never saves it, and better-sqlite3 holds every other
 * request while it runs.
 *
 * The second deciding review found that fix round 1's circles made a filter few posts match slower instead: each circle
 * read every post near the reader whatever the filter, came up short, and then the one pass ran anyway (type=event
 * 7.2 → 72.8 ms, an empty category 0.1 → 77.6 ms at 100k). Those are the native Market's Events and Polls tabs.
 *
 * This seeds the node's real schema (initStateEngine) with posts spread over the world's towns (1% of them events still
 * to come, 0.3% polls, 0.1% in a rare category), and a rural town 600 km from the biggest where half the posts are about
 * farming, which 200 posts over 3,500 km away are about too, and no others. It reads as a signed member does, and holds
 * the listing to:
 *   1. a default nearest-first page (a point, no radius) costs a small multiple of today's order: at 20k posts / 40k
 *      transactions, and at 100k / 200k; from the biggest town and from a small one
 *   2. it does not grow with the posts on the node: at 100k it costs about what it does at 20k
 *   3. a 500 km radius, nearest first, the same
 *   4. nearest first filtered to events (the first page and the fifth), to polls, to a rare category and to a category
 *      with no posts costs about one pass over what the filter matches: what the same read costs 3,000 km from every
 *      post, where the circles find nothing and one pass ranks every match. From the biggest town, at both sizes. And
 *      farming from the rural town: its share there says the next circle, with the biggest town in it, holds the page,
 *      and it holds none of them.
 *   5. EXPLAIN QUERY PLAN: the read that found the default page searched idx_posts_lat_lng
 *   6. the first pages are the pages a brute-force haversine over every post gives, with no filter and with filters
 *      that match fewer and more than posts.ts NEAREST_FIRST_MATCHES_PROBE posts (a spot check at this size; the
 *      engine's vitest compares every edge and every path)
 *
 * Every bound compares two times measured in the same run, medians of repeated reads, and is generous, so a slow or busy
 * machine can't fail it. The timings are printed as the table for the PR.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-distance-search-perf.ts
 */
delete process.env.NODE_PROFILE;

import { initStateEngine, seedGenesisMember, getPosts } from './state-engine.js';
import { NEAREST_FIRST_MATCHES_PROBE } from '@beanpool/engine';
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
/** 0.1% of posts; and a category no post is in. */
const RARE = 'rare', EMPTY = 'none';
/** 600 km west of HUB: 40 posts about farming and 40 others within 20 km, and farming nowhere else within 3,500 km. */
const RURAL = { lat: HUB.lat, lng: HUB.lng - 600 / (KM_PER_DEG * Math.cos(rad(HUB.lat))) };
const FARM = 'farm';
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

let postCount = 0, txCount = 0, pollCount = 0;
/** Posts and transactions up to the totals given, in one write each. */
function seedTo(posts: number, transactions: number): void {
    const insPost = db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, updated_at, lat, lng,
                                                   event_start_at, event_end_at, poll_options)
                                VALUES (?, ?, ?, ?, '', 0, ?, ?, ?, ?, ?, ?, ?, ?)`);
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
            // 1% events still to come; 0.3% polls, each by its own author (one active poll a member).
            const kind = rand();
            const type = kind < 0.01 ? 'event' : kind < 0.013 ? 'poll' : rand() < 0.7 ? 'offer' : 'need';
            const author = type === 'poll' ? members[pollCount++] : members[Math.floor(rand() * MEMBERS)];
            const category = rand() < 0.001 ? RARE : CATEGORIES[Math.floor(rand() * CATEGORIES.length)];
            insPost.run(`perf-${postCount}`, type, category, `Post ${postCount}`, author, at, at, lat, lng,
                type === 'event' ? '2099-06-01T10:00:00.000Z' : null, type === 'event' ? '2099-06-01T12:00:00.000Z' : null,
                type === 'poll' ? '[{"id":"a","text":"Yes"},{"id":"b","text":"No"}]' : null);
        }
        for (; txCount < transactions; txCount++) {
            insTx.run(`perf-tx-${txCount}`, members[Math.floor(rand() * MEMBERS)], members[Math.floor(rand() * MEMBERS)]);
        }
    })();
}

/** A place `km` from a point on a random bearing. */
function around(r: () => number, lat: number, lng: number, km: number): [number, number] {
    const d = km / R_KM, b = r() * 2 * Math.PI, φ = rad(lat), λ = rad(lng);
    const φ2 = Math.asin(Math.sin(φ) * Math.cos(d) + Math.cos(φ) * Math.sin(d) * Math.cos(b));
    const λ2 = λ + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(φ), Math.cos(d) - Math.sin(φ) * Math.sin(φ2));
    return [φ2 * 180 / Math.PI, ((λ2 * 180 / Math.PI + 540) % 360) - 180];
}
/** The rural town's posts, and farming's other 200 at towns over 3,500 km from it (so over 3,000 km from FAR too). Its own
 *  generator, so the rest of the world is the one the earlier rounds measured. */
function seedRural(): void {
    const r = prng(600);
    const far = towns.filter(t => haversine(RURAL.lat, RURAL.lng, t.lat, t.lng) > 3500);
    const ins = db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, updated_at, lat, lng)
                            VALUES (?, 'offer', ?, ?, '', 0, ?, ?, ?, ?, ?)`);
    const at = '2026-01-01T00:00:00.000Z';
    let n = 0;
    const post = (category: string, [lat, lng]: [number, number]) => ins.run(`perf-rural-${n}`, category, `Rural ${n}`, members[n++], at, at, lat, lng);
    db.transaction(() => {
        for (let i = 0; i < 40; i++) post(FARM, around(r, RURAL.lat, RURAL.lng, r() * 20));
        for (let i = 0; i < 40; i++) post('other', around(r, RURAL.lat, RURAL.lng, r() * 20));
        for (let i = 0; i < 200; i++) { const t = far[Math.floor(r() * far.length)]; post(FARM, around(r, t.lat, t.lng, r() * 30)); }
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
// A town few posts gather around (towns late in the list are chosen least).
const SPARSE = towns[250];
// 150 km from the biggest town, with nothing much nearer: the circles that hold the page hold the town, so they count first.
const BETWEEN = { lat: HUB.lat, lng: HUB.lng - 150 / (KM_PER_DEG * Math.cos(rad(HUB.lat))) };
// No town is south of 50°S, so no post is within 3,000 km of here: the one reader whose page takes a pass over every post.
const FAR = { lat: -80, lng: 0 };
const radius500 = { near: { ...HUB, radiusKm: 500 }, sortByDistance: true };

interface Row { size: string; recent: number; nearest: number; sparse: number; radius: number; radiusRecent: number; far: number }
function measure(size: string): Row {
    return {
        size,
        recent: median(() => page()),
        nearest: median(() => page(nearestFirst)),
        sparse: median(() => page({ near: SPARSE, sortByDistance: true })),
        radius: median(() => page(radius500)),
        radiusRecent: median(() => page({ near: { ...HUB, radiusKm: 500 } })),
        far: median(() => page({ near: FAR, sortByDistance: true }), 7),
    };
}
/** A small multiple, with room for a timer's noise on a fast machine. */
const smallMultipleOf = (t: number, base: number) => t <= Math.max(3 * base, base + 15);

// The Market's tabs and category chips, nearest first from the biggest town; and each from 3,000 km from every post, where
// the circles find nothing and one pass ranks every match (the planner finds them, by the category or events index where
// it can). Today's order is no measure of that pass: it can walk idx_posts_updated_at and stop at the page.
const FILTERS: Array<[string, Record<string, unknown>, { lat: number; lng: number }]> = [
    ['type=event', { type: 'event', excludeEvents: false }, HUB],
    ['type=event, the fifth page', { type: 'event', excludeEvents: false, offset: 200 }, HUB],
    ['type=poll', { type: 'poll' }, HUB],
    ['a category holding 0.1% of posts', { category: RARE }, HUB],
    ['a category with no posts', { category: EMPTY }, HUB],
    ['farming, from the rural town', { category: FARM }, RURAL],
];
interface FilteredRow { size: string; filter: string; nearest: number; onePass: number; count: number | null }
/** What asking how many posts the listing matches (posts.ts rankMatches) costs on its own, if the read asked. */
function countCost(extra: Record<string, unknown>): number | null {
    const prepare = db.prepare.bind(db);
    let asked: { sql: string; params: unknown[] } | undefined;
    (db as any).prepare = (sql: string) => {
        const st = prepare(sql);
        if (/WITH matches AS MATERIALIZED/.test(sql)) {
            const all = st.all.bind(st);
            (st as any).all = (...params: unknown[]) => { asked ??= { sql, params }; return all(...params); };
        }
        return st;
    };
    try { page(extra); } finally { delete (db as any).prepare; }
    if (!asked) return null;
    const st = db.prepare(asked.sql);
    return median(() => st.all(...asked!.params));
}
function measureFiltered(size: string): FilteredRow[] {
    return FILTERS.map(([filter, f, at]) => ({
        size, filter,
        nearest: median(() => page({ ...f, near: at, sortByDistance: true })),
        onePass: median(() => page({ ...f, near: FAR, sortByDistance: true })),
        count: countCost({ ...f, near: at, sortByDistance: true }),
    }));
}
/** Broad reads: a whole read, and what counting how many posts the listing matches cost it, if it counted. */
const BROAD: Array<[string, Record<string, unknown>]> = [
    ['type=need (30% of posts), from the biggest town', { type: 'need', ...nearestFirst }],
    ['no filter, 150 km from the biggest town', { near: BETWEEN, sortByDistance: true }],
];
function measureBroad(size: string): Array<{ size: string; read: string; total: number; count: number | null }> {
    return BROAD.map(([read, f]) => ({ size, read, total: median(() => page(f)), count: countCost(f) }));
}
/** About one pass: twice it, with room for a timer's noise and the circles' first look on a fast machine. */
const aboutOnePass = (t: number, onePass: number) => t <= Math.max(2 * onePass, onePass + 10);

async function main(): Promise<void> {
    console.log('\n=== Distance search (G4) at scale ===\n');
    initStateEngine();
    seedMembers();

    const rows: Row[] = [];
    const filtered: FilteredRow[] = [];
    const broad: ReturnType<typeof measureBroad> = [];
    let t = performance.now();
    seedTo(20_000, 40_000);
    seedRural();
    console.log(`seeded 20,000 posts / 40,000 transactions in ${Math.round(performance.now() - t)} ms`);
    rows.push(measure('20k / 40k'));
    filtered.push(...measureFiltered('20k / 40k'));
    broad.push(...measureBroad('20k / 40k'));
    t = performance.now();
    seedTo(100_000, 200_000);
    console.log(`seeded to 100,000 posts / 200,000 transactions in ${Math.round(performance.now() - t)} ms`);
    rows.push(measure('100k / 200k'));
    filtered.push(...measureFiltered('100k / 200k'));
    broad.push(...measureBroad('100k / 200k'));

    // The last two columns are printed, not held to a bound: sort=recent with a radius is the planner's one pass, and a
    // reader 3,000 km from every post needs one pass over every post.
    console.log('\n| posts / transactions | today\'s order | nearest first (a point, no radius), biggest town | nearest first, a small town | radius 500 km, nearest first | radius 500 km, today\'s order | nearest first, 3,000 km from every post |');
    console.log('|---|---|---|---|---|---|---|');
    for (const r of rows) console.log(`| ${r.size} | ${r.recent.toFixed(1)} ms | ${r.nearest.toFixed(1)} ms | ${r.sparse.toFixed(1)} ms | ${r.radius.toFixed(1)} ms | ${r.radiusRecent.toFixed(1)} ms | ${r.far.toFixed(1)} ms |`);
    const ms = (v: number | null) => v === null ? 'not counted' : `${v.toFixed(1)} ms`;
    console.log('\n| posts / transactions | filter | nearest first, from the biggest town | nearest first, 3,000 km from every post (one pass) | of which, counting how many match |');
    console.log('|---|---|---|---|---|');
    for (const r of filtered) console.log(`| ${r.size} | ${r.filter} | ${r.nearest.toFixed(1)} ms | ${r.onePass.toFixed(1)} ms | ${ms(r.count)} |`);
    console.log('\n| posts / transactions | broad read, nearest first | the read | of which, counting how many match |');
    console.log('|---|---|---|---|');
    for (const r of broad) console.log(`| ${r.size} | ${r.read} | ${r.total.toFixed(1)} ms | ${ms(r.count)} |`);
    console.log('');

    // ── 1–3. the default page, and a radius ──────────────────────────────────────────────────────
    for (const r of rows) {
        assert(smallMultipleOf(r.nearest, r.recent),
            `${r.size}: a default nearest-first page costs a small multiple of today's order (${r.nearest.toFixed(1)} ms against ${r.recent.toFixed(1)} ms)`);
        assert(smallMultipleOf(r.sparse, r.recent),
            `${r.size}: and from a small town (${r.sparse.toFixed(1)} ms against ${r.recent.toFixed(1)} ms)`);
        assert(smallMultipleOf(r.radius, r.recent),
            `${r.size}: a 500 km radius, nearest first, likewise (${r.radius.toFixed(1)} ms against ${r.recent.toFixed(1)} ms)`);
    }
    const [small, large] = rows;
    assert(large.nearest <= 2 * small.nearest + 10,
        `five times the posts, and the nearest-first page costs about the same (${small.nearest.toFixed(1)} ms at 20k, ${large.nearest.toFixed(1)} ms at 100k)`);
    assert(large.radius <= 2 * small.radius + 10,
        `and the 500 km radius (${small.radius.toFixed(1)} ms at 20k, ${large.radius.toFixed(1)} ms at 100k)`);

    // ── 4. a filter few posts match ──────────────────────────────────────────────────────────────
    for (const r of filtered) {
        assert(aboutOnePass(r.nearest, r.onePass),
            `${r.size}, ${r.filter}: nearest first costs about one pass over what it matches (${r.nearest.toFixed(1)} ms against ${r.onePass.toFixed(1)} ms)`);
    }

    // ── 5. the index ─────────────────────────────────────────────────────────────────────────────
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

    // ── 6. the page itself ───────────────────────────────────────────────────────────────────────
    // Every seeded post is live and public, by an active member, and every event is still to come, so the listing shows
    // every post its filter matches (the default page leaves events out); the reference is measured here from the rows
    // alone.
    const all = db.prepare(`SELECT id, type, category, lat, lng, updated_at, created_at FROM posts WHERE id LIKE 'perf-%'`).all() as Array<{ id: string; type: string; category: string; lat: number | null; lng: number | null; updated_at: string; created_at: string }>;
    const by = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const referenceFor = (keep: (p: typeof all[number]) => boolean) => all.filter(keep)
        .map(p => ({ id: p.id, u: p.updated_at, c: p.created_at, d: p.lat === null || p.lng === null ? null : haversine(HUB.lat, HUB.lng, p.lat, p.lng) }))
        .sort((a, b) => (a.d === null ? 1 : 0) - (b.d === null ? 1 : 0) || (a.d ?? 0) - (b.d ?? 0) || by(b.u, a.u) || by(b.c, a.c) || by(a.id, b.id));
    const reference = referenceFor(p => p.type !== 'event');
    const pages = [0, 50, 1000].map(offset => ({ offset, got: page({ ...nearestFirst, offset }).map(p => p.id), want: reference.slice(offset, offset + 50).map(r => r.id) }));
    assert(first.length === 50 && pages.every(p => JSON.stringify(p.got) === JSON.stringify(p.want)),
        `the pages at offsets 0, 50 and 1,000 are the brute-force pages (${pages.map(p => `${p.offset}: ${p.got.length} posts, ${p.got.filter((id, i) => id !== p.want[i]).length} different`).join('; ')})`);
    // Filtered, on both sides of NEAREST_FIRST_MATCHES_PROBE (1,000): at 100k there are about 1,040 events and 11,000
    // posts about food, and about 300 polls and 80 posts in the rare category.
    const filteredReads: Array<[string, Record<string, unknown>, (p: typeof all[number]) => boolean]> = [
        ['type=event', { type: 'event', excludeEvents: false }, p => p.type === 'event'],
        ['category=food', { category: 'food' }, p => p.category === 'food' && p.type !== 'event'],
        ['type=poll', { type: 'poll' }, p => p.type === 'poll'],
        ['the rare category', { category: RARE }, p => p.category === RARE && p.type !== 'event'],
        ['the empty category', { category: EMPTY }, () => false],
    ];
    const results: string[] = [];
    let allSame = true;
    for (const [name, f, keep] of filteredReads) {
        const ref = referenceFor(keep);
        const wrong: number[] = [];
        for (const offset of [0, 50, NEAREST_FIRST_MATCHES_PROBE - 20, ref.length - 20]) {
            if (offset < 0) continue;
            const got = page({ ...f, ...nearestFirst, offset }).map(p => p.id);
            if (JSON.stringify(got) !== JSON.stringify(ref.slice(offset, offset + 50).map(r => r.id))) wrong.push(offset);
        }
        if (wrong.length) allSame = false;
        results.push(`${name}: ${ref.length} posts${wrong.length ? `, wrong at ${wrong.join(', ')}` : ''}`);
    }
    const sizes = filteredReads.map(([, , keep]) => referenceFor(keep).length);
    assert(allSame && sizes.some(n => n > NEAREST_FIRST_MATCHES_PROBE) && sizes.some(n => n > 0 && n < NEAREST_FIRST_MATCHES_PROBE),
        `filtered, fewer and more than ${NEAREST_FIRST_MATCHES_PROBE} matches: every page at offsets 0, 50, ${NEAREST_FIRST_MATCHES_PROBE - 20} and near the end is the brute-force page (${results.join('; ')})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ A nearest-first page reads the posts near the reader, not every post on the node, and a filter few posts match costs about one pass over them.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
