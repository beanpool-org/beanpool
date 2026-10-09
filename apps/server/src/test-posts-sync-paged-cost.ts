/**
 * Test Suite: what a phone's posts sync read paged by key costs the node, and that its pages are the read's.
 *
 * A sync read paged by key (engine posts.ts PAGE_ORDER) sorts every listing below its key: PAGE_ORDER is an expression,
 * so no index sets it. Sorted with the full row, each of those listings first computed its author's two trade counts
 * (POST_ROW_SELECT), so every page cost about what all the listings below it cost, and a whole pull O(N²): at 10,000
 * listings, 20,000 ledger rows and 3,000 deals, page 1 took 2.4 s against main's 99 ms for the read an older phone makes,
 * and the whole pull 65 s over 51 pages, each blocking the node's event loop (review of PR #1719, B2). The page's ids are
 * now ranked first and only they are read in full (postRowsForSyncPage).
 *
 * Seeds the node's real schema (initStateEngine) with 10,000 listings by 300 members, 20,000 ledger rows and 3,000
 * completed deals, among them 50 listings tied on both times, NULL times, cancelled ones, events, and group and direct
 * listings in and out of the reader's view, and holds:
 *   1. the pages are the read's: for two readers, with and without the event types, whole and as a delta, every page is
 *      the engine's unpaged read of the same filter sorted in PAGE_ORDER and cut into 200s, row for row (each row's every
 *      field), and each page's key is its last row's;
 *   2. no statement of a page sorts full rows: none that selects the trade counts uses a temporary B-tree for its order;
 *   3. page 1 costs at most twice the read an older phone makes (its first 200, newest first, on the index), and the
 *      whole pull at most twice that read for each of its pages. Medians of interleaved reads, measured in the same run.
 * The times are printed for the PR.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-posts-sync-paged-cost.ts
 */
delete process.env.NODE_PROFILE;

import { initStateEngine, seedGenesisMember, createGroup } from './state-engine.js';
import { getPosts as getPostsEngine, type MarketplacePost, type PostFilter, type SyncPage } from '@beanpool/engine';
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
const rand = prng(20261009);

const LISTINGS = 10_000, MEMBERS = 300, LEDGER = 20_000, DEALS = 3_000;
/** The server's MAX_PAGE_LIMIT: what a phone's sync read gets a page. */
const PAGE = 200;
const TYPES = ['offer', 'need', 'poll', 'event'];
const OWNER = '00'.repeat(32);
const members: string[] = [];
const iso = (ms: number) => new Date(ms).toISOString();
const BASE = Date.parse('2026-01-01T00:00:00.000Z');

function seed(): { carol: string; bob: string; deltaFrom: string } {
    seedGenesisMember(OWNER, 'Owner');
    const insMember = db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                                  VALUES (?, ?, '2026-01-01T00:00:00.000Z', ?, 'TEST', 'active')`);
    db.transaction(() => {
        for (let i = 0; i < MEMBERS; i++) {
            const pk = (i + 1).toString(16).padStart(64, '0');
            members.push(pk);
            insMember.run(pk, `m${i}`, OWNER);
        }
    })();
    const [carol, bob] = members;
    // Carol keeps a group; bob is in none.
    const club = createGroup({ name: 'Cost club', createdBy: carol }).id;
    const other = createGroup({ name: 'Not carol', createdBy: members[2] }).id;

    const insPost = db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, status, active,
                                    created_at, updated_at, audience_scope, target_group_id, target_pubkey, event_start_at, event_end_at, event_state)
                                VALUES (?, ?, 'food', ?, '', 5, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const deltaFromMs = BASE + (LISTINGS - 450) * 60_000;
    let polls = 0;
    db.transaction(() => {
        for (let i = 0; i < LISTINGS; i++) {
            const id = `cost-${String(i).padStart(5, '0')}`;
            const k = rand();
            const type = k < 0.02 ? 'event' : k < 0.025 ? 'poll' : rand() < 0.7 ? 'offer' : 'need';
            // One active poll a member (the node's unique index): each poll by its own author.
            const author = type === 'poll' ? members[10 + polls++] : members[Math.floor(rand() * MEMBERS)];
            const s = rand();
            // 3% for carol's group, 2% for a group she's not in, 2% direct to her, 1% direct between others.
            const [scope, group, target] = s < 0.03 ? ['group', club, null] : s < 0.05 ? ['group', other, null]
                : s < 0.07 ? ['direct', null, carol] : s < 0.08 ? ['direct', null, members[3]] : ['public', null, null];
            const cancelled = rand() < 0.02;
            let created: string | null = iso(BASE + i * 30_000);
            let updated: string | null = iso(BASE + i * 60_000);
            // 50 tied on both times, across a page's edge; 5 with no updated_at, 5 with no created_at.
            if (i >= 4_990 && i < 5_040) { created = iso(BASE); updated = iso(BASE + 4_990 * 60_000); }
            if (i >= 100 && i < 105) updated = null;
            if (i >= 200 && i < 205) created = null;
            insPost.run(id, type, `Listing ${i}`, author, cancelled ? 'cancelled' : 'active', cancelled ? 0 : 1, created, updated,
                scope, group, target,
                type === 'event' ? '2099-06-01T10:00:00.000Z' : null, type === 'event' ? '2099-06-01T12:00:00.000Z' : null,
                type === 'event' && cancelled ? 'cancelled' : null);
        }
    })();
    const insTx = db.prepare('INSERT INTO transactions (id, from_pubkey, to_pubkey, amount) VALUES (?, ?, ?, 1)');
    db.transaction(() => {
        for (let i = 0; i < LEDGER; i++) insTx.run(`cost-tx-${i}`, members[Math.floor(rand() * MEMBERS)], members[Math.floor(rand() * MEMBERS)]);
    })();
    const insDeal = db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, completed_at)
                                VALUES (?, ?, ?, ?, 5, 'completed', '2026-06-01T00:00:00.000Z')`);
    db.transaction(() => {
        for (let i = 0; i < DEALS; i++) {
            insDeal.run(`cost-deal-${i}`, `cost-${String(Math.floor(rand() * LISTINGS)).padStart(5, '0')}`,
                members[Math.floor(rand() * MEMBERS)], members[Math.floor(rand() * MEMBERS)]);
        }
    })();
    return { carol, bob, deltaFrom: iso(deltaFromMs) };
}

/** A row's place in PAGE_ORDER, from the table: its times ('' for none) and its id. */
const placeOf = new Map<string, [string, string, string]>();
const keyOf = (id: string) => Buffer.from(JSON.stringify(placeOf.get(id))).toString('base64url');
function pageOrder(a: string, b: string): number {
    const [ua, ca] = placeOf.get(a)!, [ub, cb] = placeOf.get(b)!;
    if (ua !== ub) return ua < ub ? 1 : -1;
    if (ca !== cb) return ca < cb ? 1 : -1;
    return a < b ? 1 : a > b ? -1 : 0;
}

/** The phone's sync read (routes/marketplace.ts): `sync`, a page of 200, its reader, and the event types or none. */
function syncFilter(reader: string, types: boolean, since: string | undefined): PostFilter {
    return { sync: true, limit: PAGE, viewerPubkey: reader, ...(types ? { types: TYPES } : { excludeEvents: true }), ...(since ? { updatedAfter: since } : {}) };
}

/** Every page of a paged read, with each page's key, and the ms each page took. */
function pagedRead(filter: PostFilter, on = db as any) {
    const pages: Array<{ rows: MarketplacePost[]; next: string | null; ms: number }> = [];
    let after: string | null = null;
    do {
        const page: SyncPage = { after, next: null };
        const t0 = performance.now();
        const rows = getPostsEngine(on, { ...filter, syncPage: page });
        pages.push({ rows, next: page.next, ms: performance.now() - t0 });
        after = page.next;
    } while (after && pages.length < 200);
    return pages;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function main() {
    console.log('What a phone\'s posts sync read paged by key costs the node...\n');
    initStateEngine();
    const t0 = performance.now();
    const { carol, bob, deltaFrom } = seed();
    for (const r of db.prepare(`SELECT id, COALESCE(updated_at, '') AS u, COALESCE(created_at, '') AS c FROM posts`).all() as any[]) {
        placeOf.set(r.id, [r.u, r.c, r.id]);
    }
    console.log(`Seeded ${LISTINGS} listings, ${MEMBERS} members, ${LEDGER} ledger rows, ${DEALS} deals in ${Math.round(performance.now() - t0)} ms\n`);

    // ── 1. The pages are the read's ──
    const cases: Array<[string, PostFilter]> = [
        ['carol, whole, with events', syncFilter(carol, true, undefined)],
        ['carol, whole, without events', syncFilter(carol, false, undefined)],
        ['bob, whole, with events', syncFilter(bob, true, undefined)],
        ['carol, delta of the newest 450 and more, with events', syncFilter(carol, true, deltaFrom)],
    ];
    for (const [name, filter] of cases) {
        const all = getPostsEngine(db as any, { ...filter, limit: undefined });
        const ordered = all.map(p => p.id).sort(pageOrder);
        const full = new Map(all.map(p => [p.id, JSON.stringify(p)]));
        const pages = pagedRead(filter);
        let rowsDiffer = 0, keysDiffer = 0;
        pages.forEach((page, i) => {
            const want = ordered.slice(i * PAGE, (i + 1) * PAGE);
            if (page.rows.map(p => p.id).join() !== want.join()) rowsDiffer++;
            if (page.rows.some(p => JSON.stringify(p) !== full.get(p.id))) rowsDiffer++;
            const wantNext = want.length === PAGE ? keyOf(want[want.length - 1]) : null;
            if (page.next !== wantNext) keysDiffer++;
        });
        const got = pages.reduce((n, p) => n + p.rows.length, 0);
        assert(got === ordered.length && pages.length === Math.max(1, Math.ceil(ordered.length / PAGE)) && rowsDiffer === 0 && keysDiffer === 0,
            `${name}: ${pages.length} pages of the read's ${ordered.length} rows, each page the read's in PAGE_ORDER, row for row (${rowsDiffer} differ, ${keysDiffer} keys differ)`);
    }

    // ── 2. No statement of a page sorts full rows ──
    const seen: Array<{ sql: string; args: unknown[] }> = [];
    const spy = {
        prepare(sql: string) {
            const stmt = db.prepare(sql);
            return new Proxy(stmt, {
                get(target, prop) {
                    const v = (target as any)[prop];
                    if (prop === 'all' || prop === 'get') return (...args: unknown[]) => { seen.push({ sql, args }); return v.apply(target, args); };
                    return typeof v === 'function' ? v.bind(target) : v;
                },
            });
        },
    };
    const page1 = { after: null as string | null, next: null as string | null };
    getPostsEngine(spy as any, { ...syncFilter(carol, true, undefined), syncPage: page1 });
    getPostsEngine(spy as any, { ...syncFilter(carol, true, undefined), syncPage: { after: page1.next, next: null } });
    const fullSorts = seen.filter(s => s.sql.includes('author_trade_count'))
        .filter(s => (db.prepare(`EXPLAIN QUERY PLAN ${s.sql}`).all(...s.args) as any[]).some(r => /TEMP B-TREE FOR ORDER BY/.test(r.detail)));
    assert(seen.some(s => s.sql.includes('author_trade_count')) && fullSorts.length === 0,
        `pages 1 and 2: no statement that selects the trade counts sorts with a temporary B-tree (${fullSorts.length} do)`);

    // ── 3. What a page costs, against the read an older phone makes ──
    const legacy: number[] = [], paged: number[] = [];
    for (let round = 0; round < 7; round++) {
        let t = performance.now();
        getPostsEngine(db as any, syncFilter(carol, true, undefined));
        legacy.push(performance.now() - t);
        t = performance.now();
        getPostsEngine(db as any, { ...syncFilter(carol, true, undefined), syncPage: { after: null, next: null } });
        paged.push(performance.now() - t);
    }
    const legacyMs = median(legacy), page1Ms = median(paged);
    const pull = pagedRead(syncFilter(carol, true, undefined));
    const pullMs = pull.reduce((n, p) => n + p.ms, 0);
    const worstMs = Math.max(...pull.map(p => p.ms));
    console.log(`\n  the older phone's read (first 200, newest first): median ${legacyMs.toFixed(1)} ms`);
    console.log(`  page 1 paged by key:                              median ${page1Ms.toFixed(1)} ms`);
    console.log(`  the whole pull paged by key: ${pull.length} pages, ${Math.round(pullMs)} ms in all, median page ${median(pull.map(p => p.ms)).toFixed(1)} ms, worst ${worstMs.toFixed(1)} ms\n`);
    assert(page1Ms <= 2 * legacyMs, `page 1 costs at most twice the older phone's read (${page1Ms.toFixed(1)} ms against ${legacyMs.toFixed(1)} ms)`);
    assert(pullMs <= 2 * legacyMs * pull.length,
        `the whole pull costs at most twice that read a page (${Math.round(pullMs)} ms over ${pull.length} pages, bound ${Math.round(2 * legacyMs * pull.length)} ms)`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ A sync read paged by key costs a page, not the listings below it.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
