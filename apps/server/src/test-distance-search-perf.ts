/**
 * Distance search (global node G4) at a global node's size, against the read it replaced. 743b5d57 ranked a nearest-first
 * read in one query that selected every column of every post the listing shows (the author's trade count included),
 * measured each and sorted them all: 128 ms at 100k posts / 200k transactions for the global Market's default read,
 * growing with the posts on the node (the first deciding review of #1140). The circles (posts.ts NEAREST_FIRST_CIRCLES_KM)
 * read the posts near the reader instead. But a circle reads every post in it, whatever the filter, so for a filter that
 * few posts near the reader match, circles cost more than the one pass (the second and third deciding reviews: the Events
 * tab, a rare category, and a category common on the node and rare near the reader). posts.ts circlesMayRead now lets
 * only the reads where that can't happen search circles, and every other read takes one pass.
 *
 * This seeds the node's real schema (initStateEngine) with posts spread over the world's towns: 1% events still to come,
 * 0.3% polls, 70% of the rest offers and 30% needs; 0.1% in a rare category; 20% in a 'wide' category that is rare in
 * the biggest town (about 20 of its 5,500 posts at 100k); 0.5% for a group the reader is in. For each read below, at
 * 20k and 100k posts, each with 0 and 200k transactions, it times 743b5d57's read and this one in the same run, on the
 * same database, through the same conditions and the same code after the ranking (engine getPostsRankedBy), and holds:
 *   1. no read is slower than 743b5d57's beyond a timer's noise
 *   2. each read's page is 743b5d57's page, post for post, with the same distances
 *   3. the reads circlesMayRead allows search circles, and every other read takes exactly one pass
 *   4. the default page's circle searched idx_posts_lat_lng
 *   5. the first pages are the pages a brute-force haversine over every post gives, on both paths
 *
 * Every bound compares two times measured in the same run, medians of interleaved reads, and is generous, so a slow or
 * busy machine can't fail it. The timings are printed as the table for the PR.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-distance-search-perf.ts
 */
delete process.env.NODE_PROFILE;

import { initStateEngine, seedGenesisMember, createGroup } from './state-engine.js';
import { boundingBox, getPostsRankedBy, getPosts as getPostsEngine, type PostFilter, type RowsNear } from '@beanpool/engine';
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
/** 0.1% of posts; a category no post is in; and 20% of posts, but about 0.35% of the biggest town's. */
const RARE = 'rare', EMPTY = 'none', WIDE = 'wide';
const MEMBERS = 20_000;
const OWNER = '00'.repeat(32);
/** A member with a few posts, as seedMembers names them. */
const AUTHOR = (1235).toString(16).padStart(64, '0');
const members: string[] = [];
let clubId = '';

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
    // The reader is in a group; 0.5% of posts are for it.
    clubId = createGroup({ name: 'Perf club', createdBy: members[0] }).id;
}

let postCount = 0, pollCount = 0;
function seedPostsTo(posts: number): void {
    const insPost = db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, updated_at, lat, lng,
                                                   event_start_at, event_end_at, poll_options, audience_scope, target_group_id)
                                VALUES (?, ?, ?, ?, '', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    db.transaction(() => {
        for (; postCount < posts; postCount++) {
            let lat: number | null = null, lng: number | null = null, atHub = false;
            if (rand() > 0.05) {
                const t = Math.floor(rand() ** 2 * towns.length);
                const town = towns[t];
                atHub = t === 0;
                lat = Math.max(-90, Math.min(90, town.lat + gauss() * 15 / KM_PER_DEG));
                lng = ((town.lng + gauss() * 15 / KM_PER_DEG / Math.cos(rad(town.lat)) + 540) % 360) - 180;
            }
            const at = new Date(Date.UTC(2026, 0, 1) + postCount * 60_000).toISOString();
            // 1% events still to come; 0.3% polls, each by its own author (one active poll a member).
            const kind = rand();
            const type = kind < 0.01 ? 'event' : kind < 0.013 ? 'poll' : rand() < 0.7 ? 'offer' : 'need';
            const author = type === 'poll' ? members[pollCount++] : members[Math.floor(rand() * MEMBERS)];
            const c = rand();
            const category = c < 0.001 ? RARE : c < (atHub ? 0.0045 : 0.211) ? WIDE : CATEGORIES[Math.floor(rand() * CATEGORIES.length)];
            const forClub = rand() < 0.005;
            insPost.run(`perf-${postCount}`, type, category, `Post ${postCount}`, author, at, at, lat, lng,
                type === 'event' ? '2099-06-01T10:00:00.000Z' : null, type === 'event' ? '2099-06-01T12:00:00.000Z' : null,
                type === 'poll' ? '[{"id":"a","text":"Yes"},{"id":"b","text":"No"}]' : null,
                forClub ? 'group' : 'public', forClub ? clubId : null);
        }
    })();
}
function seedTransactions(n: number): void {
    const insTx = db.prepare('INSERT INTO transactions (id, from_pubkey, to_pubkey, amount) VALUES (?, ?, ?, 1)');
    db.transaction(() => {
        for (let i = 0; i < n; i++) insTx.run(`perf-tx-${i}`, members[Math.floor(rand() * MEMBERS)], members[Math.floor(rand() * MEMBERS)]);
    })();
}

/**
 * 743b5d57's read with a point, as it was: one query that selects every column of every post the listing shows, the
 * author's trade count included, measures each and sorts them all before LIMIT. Copied from 743b5d57's getPosts; the
 * conditions (`where`) are the listing's own, unchanged since.
 */
const rowsNear743b5d57: RowsNear = (conn, near, where, whereParams, filter) => {
    let sql = `
        SELECT p.*, m.callsign as author_callsign, m.avatar_url as author_avatar, a.callsign as accepted_callsign,
               g.name as target_group_name,
               haversine_km(?, ?, p.lat, p.lng) AS distance_km,
               COALESCE(m.earned_credit, 0) as author_earned_credit,
               (
                 COALESCE((SELECT COUNT(*) FROM transactions t
                      WHERE (t.from_pubkey = m.public_key OR t.to_pubkey = m.public_key)
                        AND t.from_pubkey != t.to_pubkey
                        AND t.from_pubkey NOT LIKE 'escrow_%' AND t.to_pubkey NOT LIKE 'escrow_%'
                        AND t.from_pubkey != 'SYSTEM' AND t.to_pubkey != 'SYSTEM'), 0) +
                 COALESCE((SELECT COUNT(*) FROM marketplace_transactions mt
                      WHERE (mt.buyer_pubkey = m.public_key OR mt.seller_pubkey = m.public_key)
                        AND mt.status = 'completed'), 0)
               ) as author_trade_count
        FROM posts p
        LEFT JOIN members m ON p.author_pubkey = m.public_key
        LEFT JOIN members a ON p.accepted_by = a.public_key
        LEFT JOIN groups g ON p.target_group_id = g.id
        WHERE 1=1${where}`;
    const params: unknown[] = [near.lat, near.lng, ...whereParams];
    if (near.radiusKm !== undefined) {
        const box = boundingBox(near.lat, near.lng, near.radiusKm);
        sql += ` AND p.lat BETWEEN ? AND ? AND (${box.lngRanges.map(() => 'p.lng BETWEEN ? AND ?').join(' OR ')})`;
        params.push(box.latMin, box.latMax, ...box.lngRanges.flat());
        sql += " AND haversine_km(?, ?, p.lat, p.lng) <= ?";
        params.push(near.lat, near.lng, near.radiusKm);
    }
    sql += filter.sortByDistance
        ? " ORDER BY distance_km ASC NULLS LAST, p.updated_at DESC, p.created_at DESC, p.id ASC"
        : " ORDER BY p.updated_at DESC, p.created_at DESC";
    if (filter.limit) {
        sql += " LIMIT ? OFFSET ?";
        params.push(filter.limit, filter.offset || 0);
    }
    return conn.prepare(sql).all(...params) as any[];
};

// As the route reads for a signed member: the Market's page, 50 posts, events left out unless asked for.
const VIEWER = () => members[0];
const asRead = (extra: PostFilter): PostFilter => ({ limit: 50, offset: 0, excludeEvents: true, viewerPubkey: VIEWER(), ...extra });
const before = (f: PostFilter) => getPostsRankedBy(db, asRead(f), rowsNear743b5d57);
const now = (f: PostFilter) => getPostsEngine(db, asRead(f));

// A town few posts gather around (towns late in the list are chosen least).
const SPARSE = towns[250];
// On the biggest town's latitude, with no town (so no post) within 800 km: the circles out to 300 km find nothing.
const NOTHING_NEAR = (() => {
    for (let lng = HUB.lng - 20; lng > HUB.lng - 200; lng -= 0.5) {
        const p = { lat: HUB.lat, lng: ((lng + 540) % 360) - 180 };
        const nearest = Math.min(...towns.map(t => haversine(p.lat, p.lng, t.lat, t.lng)));
        if (nearest > 800 && nearest < 1500) return p;
    }
    throw new Error('no point with nothing within 800 km');
})();
// No town is south of 50°S, so no post is within 3,000 km of here: the circles find nothing, and one pass ranks every post.
const FAR = { lat: -80, lng: 0 };

interface Shape { name: string; filter: PostFilter; circles: boolean }
const nearest = (at: { lat: number; lng: number }) => ({ near: at, sortByDistance: true });
const SHAPES: Shape[] = [
    { name: 'no filter, the biggest town', filter: nearest(HUB), circles: true },
    { name: 'no filter, a small town', filter: nearest(SPARSE), circles: true },
    { name: 'no filter, nothing within 700 km', filter: nearest(NOTHING_NEAR), circles: true },
    { name: 'no filter, 3,000 km from every post', filter: nearest(FAR), circles: true },
    { name: 'the apps\' feed (types=offer,need,poll,event)', filter: { ...nearest(HUB), types: ['offer', 'need', 'poll', 'event'], excludeEvents: false }, circles: true },
    { name: 'type=offer', filter: { ...nearest(HUB), type: 'offer' }, circles: true },
    { name: 'type=need', filter: { ...nearest(HUB), type: 'need' }, circles: true },
    { name: 'type=event', filter: { ...nearest(HUB), type: 'event', excludeEvents: false }, circles: false },
    { name: 'type=poll', filter: { ...nearest(HUB), type: 'poll' }, circles: false },
    { name: 'a category with no posts', filter: { ...nearest(HUB), category: EMPTY }, circles: false },
    { name: 'a category holding 0.1% of posts', filter: { ...nearest(HUB), category: RARE }, circles: false },
    { name: 'a category holding 20%, 0.35% of the biggest town\'s', filter: { ...nearest(HUB), category: WIDE }, circles: false },
    { name: 'one author', filter: { ...nearest(HUB), authorPubkey: AUTHOR }, circles: false },
    { name: 'a group scope', filter: { ...nearest(HUB), audienceScope: 'group' }, circles: false },
    { name: 'radius 500 km', filter: { near: { ...HUB, radiusKm: 500 }, sortByDistance: true }, circles: false },
    { name: 'today\'s order, a point', filter: { near: HUB }, circles: false },
    { name: 'today\'s order, no point', filter: {}, circles: false },
];

/** The reads a page makes: circles (a box on idx_posts_lat_lng joined to the listing) and one pass. */
function trace(f: PostFilter): { circles: number; passes: number } {
    const prepare = db.prepare.bind(db);
    const out = { circles: 0, passes: 0 };
    (db as any).prepare = (sql: string) => {
        const st = prepare(sql);
        const kind = /CROSS JOIN posts p/.test(sql) ? 'circles' : /haversine_km/.test(sql) && !/WHERE p\.id IN/.test(sql) ? 'passes' : undefined;
        if (kind) {
            const all = st.all.bind(st);
            (st as any).all = (...params: unknown[]) => { out[kind]++; return all(...params); };
        }
        return st;
    };
    try { now(f); } finally { delete (db as any).prepare; }
    return out;
}

/** Medians of the two reads, interleaved (each goes first half the time), after a few to warm up. */
function race(f: PostFilter, reps: number): { before: number; now: number } {
    for (let i = 0; i < 2; i++) { before(f); now(f); }
    const a: number[] = [], b: number[] = [];
    const time = (read: () => unknown, into: number[]) => { const t = performance.now(); read(); into.push(performance.now() - t); };
    for (let i = 0; i < reps; i++) {
        if (i % 2) { time(() => before(f), a); time(() => now(f), b); } else { time(() => now(f), b); time(() => before(f), a); }
    }
    const median = (xs: number[]) => xs.sort((x, y) => x - y)[Math.floor(xs.length / 2)];
    return { before: median(a), now: median(b) };
}

/** Within a timer's noise of 743b5d57, generously: half as slow again, or 3 ms, whichever is more. */
const noSlower = (t: number, base: number) => t <= Math.max(1.5 * base, base + 3);

interface Row { size: string; shape: Shape; before: number; now: number; reads: string; same: boolean }
function measure(size: string): Row[] {
    return SHAPES.map(shape => {
        const f = shape.filter;
        const slow = /no filter|feed|type=offer|type=need/.test(shape.name) && !/today/.test(shape.name);
        const t = race(f, slow ? 9 : 15);
        const { circles, passes } = trace(f);
        const reads = `${circles ? `${circles} circle${circles > 1 ? 's' : ''}` : ''}${circles && passes ? ' + ' : ''}${passes ? `${passes} pass` : ''}` || 'no point';
        const a = before(f), b = now(f);
        const same = JSON.stringify(a.map(p => [p.id, p.distanceKm])) === JSON.stringify(b.map(p => [p.id, p.distanceKm]));
        return { size, shape, ...t, reads, same };
    });
}

async function main(): Promise<void> {
    console.log('\n=== Distance search (G4) at scale, against 743b5d57 ===\n');
    initStateEngine();
    seedMembers();

    const rows: Row[] = [];
    let t = performance.now();
    seedPostsTo(20_000);
    console.log(`seeded 20,000 posts in ${Math.round(performance.now() - t)} ms`);
    rows.push(...measure('20k / 0'));
    seedTransactions(200_000);
    rows.push(...measure('20k / 200k'));
    db.prepare("DELETE FROM transactions WHERE id LIKE 'perf-tx-%'").run();
    t = performance.now();
    seedPostsTo(100_000);
    console.log(`seeded to 100,000 posts in ${Math.round(performance.now() - t)} ms`);
    rows.push(...measure('100k / 0'));
    seedTransactions(200_000);
    rows.push(...measure('100k / 200k'));

    const sizes = [...new Set(rows.map(r => r.size))];
    console.log(`\nMedians in ms, 743b5d57 → this read, per posts / transactions. Nothing within 700 km is (${NOTHING_NEAR.lat}, ${NOTHING_NEAR.lng.toFixed(2)}).\n`);
    console.log(`| read | ${sizes.join(' | ')} | reads |`);
    console.log(`|---|${sizes.map(() => '---').join('|')}|---|`);
    for (const shape of SHAPES) {
        const cells = sizes.map(size => { const r = rows.find(x => x.size === size && x.shape === shape)!; return `${r.before.toFixed(1)} → ${r.now.toFixed(1)}`; });
        console.log(`| ${shape.name} | ${cells.join(' | ')} | ${rows.find(x => x.shape === shape && x.size === '100k / 200k')!.reads} |`);
    }
    console.log('');

    // ── 1. no read slower than 743b5d57's ────────────────────────────────────────────────────────
    for (const r of rows) {
        assert(noSlower(r.now, r.before), `${r.size}, ${r.shape.name}: ${r.now.toFixed(1)} ms, no slower than 743b5d57's ${r.before.toFixed(1)} ms`);
    }
    // ── 2. the same pages ────────────────────────────────────────────────────────────────────────
    const differ = rows.filter(r => !r.same).map(r => `${r.size}, ${r.shape.name}`);
    assert(differ.length === 0, `every read's page is 743b5d57's page, post for post, with the same distances (${differ.join('; ') || 'all the same'})`);
    // ── 3. the path each read takes ──────────────────────────────────────────────────────────────
    const wrongPath = rows.filter(r => r.shape.filter.near && (r.shape.circles ? !/circle/.test(r.reads) : r.reads !== '1 pass'));
    assert(wrongPath.length === 0,
        `no filter, the apps' feed and type offer or need search circles; every other read takes exactly one pass (${wrongPath.map(r => `${r.size}, ${r.shape.name}: ${r.reads}`).join('; ') || 'all as said'})`);

    // ── 4. the index ─────────────────────────────────────────────────────────────────────────────
    const prepare = db.prepare.bind(db);
    const reads: Array<{ sql: string; params: unknown[] }> = [];
    (db as any).prepare = (sql: string) => {
        const st = prepare(sql);
        if (/CROSS JOIN posts p/.test(sql)) {
            const all = st.all.bind(st);
            (st as any).all = (...params: unknown[]) => { reads.push({ sql, params }); return all(...params); };
        }
        return st;
    };
    try { now(nearest(HUB)); } finally { delete (db as any).prepare; }
    const found = reads[reads.length - 1];
    const plan = found ? (db.prepare(`EXPLAIN QUERY PLAN ${found.sql}`).all(...found.params) as Array<{ detail: string }>).map(r => r.detail) : [];
    assert(plan.some(d => /idx_posts_lat_lng/.test(d)),
        `the circle that found the default page searched idx_posts_lat_lng (${reads.length} circle(s); ${plan.join(' | ') || 'none captured'})`);

    // ── 5. the page itself ───────────────────────────────────────────────────────────────────────
    // Every seeded post is live and by an active member, every event is still to come, and the reader is in the club, so
    // the listing shows every post its filter matches (the default page leaves events out); the reference is measured
    // here from the rows alone.
    const all = db.prepare(`SELECT id, type, category, lat, lng, updated_at, created_at FROM posts WHERE id LIKE 'perf-%'`).all() as Array<{ id: string; type: string; category: string; lat: number | null; lng: number | null; updated_at: string; created_at: string }>;
    const by = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const referenceFor = (keep: (p: typeof all[number]) => boolean) => all.filter(keep)
        .map(p => ({ id: p.id, u: p.updated_at, c: p.created_at, d: p.lat === null || p.lng === null ? null : haversine(HUB.lat, HUB.lng, p.lat, p.lng) }))
        .sort((a, b) => (a.d === null ? 1 : 0) - (b.d === null ? 1 : 0) || (a.d ?? 0) - (b.d ?? 0) || by(b.u, a.u) || by(b.c, a.c) || by(a.id, b.id));
    const brute: Array<[string, PostFilter, (p: typeof all[number]) => boolean]> = [
        ['no filter (circles)', {}, p => p.type !== 'event'],
        ['type=need (circles)', { type: 'need' }, p => p.type === 'need'],
        ['type=event (one pass)', { type: 'event', excludeEvents: false }, p => p.type === 'event'],
        ['the wide category (one pass)', { category: WIDE }, p => p.category === WIDE && p.type !== 'event'],
        ['the rare category (one pass)', { category: RARE }, p => p.category === RARE && p.type !== 'event'],
    ];
    const results: string[] = [];
    let allSame = true;
    for (const [name, f, keep] of brute) {
        const ref = referenceFor(keep);
        const wrong: number[] = [];
        for (const offset of [0, 50, 1000, ref.length - 20]) {
            if (offset < 0) continue;
            const got = now({ ...f, ...nearest(HUB), offset }).map(p => p.id);
            if (JSON.stringify(got) !== JSON.stringify(ref.slice(offset, offset + 50).map(r => r.id))) wrong.push(offset);
        }
        if (wrong.length) allSame = false;
        results.push(`${name}: ${ref.length} posts${wrong.length ? `, wrong at ${wrong.join(', ')}` : ''}`);
    }
    assert(allSame, `on both paths, the pages at offsets 0, 50, 1,000 and near the end are the brute-force pages (${results.join('; ')})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ No nearest-first read is slower than 743b5d57\'s, and the default page reads the posts near the reader, not every post on the node.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
