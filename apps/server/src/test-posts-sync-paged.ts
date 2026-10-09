/**
 * Test Suite: the phone's posts sync read, paged by key.
 *
 * Every read of GET /api/marketplace/posts holds at most 200 listings (https-server.ts MAX_PAGE_LIMIT), newest changed
 * first. The phone (apps/native services/pillar-sync.ts) read one page and moved its cursor to "now", so a delta of more
 * than 200 changes, or a whole pull of a node with more than 200 listings, never asked for the rest. A sync read that
 * says `paged=1` is now answered in one total order (engine posts.ts PAGE_ORDER: updated_at, created_at, id, newest
 * first) with the key of its last row in X-Posts-Next while the page is full; `pageAfter=<key>` reads the page below it.
 *
 * Boots the real server and reads over HTTP, signed by a member's key, through the real middleware:
 *   - a read without the new parameters is answered as before: its first 200, newest first, and no key;
 *   - a whole read of 450 listings in three pages: each listing once, the last page short and with no key; its first
 *     page is the same 200 as the read without the parameters;
 *   - a delta of 450 changes since the cursor, the same, and none of the listings that didn't change;
 *   - listings that share a time to the millisecond across a page's edge: each once (the id ends the order);
 *   - between two pages a listing is edited, one is made, and one of the first page's leaves the reader's view: every
 *     other listing still comes, once, and the delta from a cursor taken before the first page holds the edited and the
 *     new one (the phone's guarantee);
 *   - a key the node never handed out is a 400, never a quietly empty page; the paged read keeps its 304.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-posts-sync-paged.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { localFetch } from './keepalive-test-fetch.js';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };

function keypair(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pubKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
}

function signedHeaders(method: string, path: string, body: string, id: Id): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${body}`;
    return {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
}

/** The phone's sync read (pillar-sync.ts, utils/events.ts EVENT_TYPES_QUERY), plus `extra`. */
const SYNC = '/api/marketplace/posts?limit=1000&sync=true&types=offer,need,poll,event';

async function read(extra: string, id: Id, headers: Record<string, string> = {}) {
    const path = `${SYNC}${extra}`;
    const res = await localFetch(`${BASE}${path}`, { headers: { ...signedHeaders('GET', path, '', id), ...headers } });
    const text = await res.text();
    return {
        status: res.status,
        next: res.headers.get('x-posts-next'),
        etag: res.headers.get('etag'),
        rows: res.status === 200 ? JSON.parse(text) as Array<{ id: string; title: string }> : [],
    };
}

/** Every page of a paged read: the rows in the order they came, and how many pages. `between` runs before each later page. */
async function readAll(since: string, id: Id, between?: (page: number) => void) {
    const cursor = since ? `&updatedAfter=${encodeURIComponent(since)}` : '';
    const rows: Array<{ id: string; title: string }> = [];
    let page = await read(`${cursor}&paged=1`, id);
    const sizes = [page.rows.length];
    rows.push(...page.rows);
    while (page.next) {
        between?.(sizes.length);
        page = await read(`${cursor}&pageAfter=${encodeURIComponent(page.next)}`, id);
        if (page.status !== 200) throw new Error(`a later page answered ${page.status}`);
        sizes.push(page.rows.length);
        rows.push(...page.rows);
    }
    return { rows, sizes, lastNext: page.next };
}

const once = (rows: Array<{ id: string }>) => new Set(rows.map(r => r.id)).size === rows.length;

async function main() {
    console.log('The phone\'s posts sync read, paged by key...\n');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');

    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    const { stopPricingAggregatorWorker } = await import('./pricing-aggregator.js');
    stopPricingAggregatorWorker();

    const seed = (callsign: string): Id => {
        const id = keypair();
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                    VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'seed', ?)`)
            .run(id.pubKeyHex, callsign, `INV-${callsign.toUpperCase()}`);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pubKeyHex);
        return id;
    };
    const carol = seed('ReaderCarol');
    const ann = seed('AuthorAnn');

    const insert = db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, status, active,
                               created_at, updated_at) VALUES (?, 'offer', 'food', ?, '', 5, ?, 'active', 1, ?, ?)`);
    const base = Date.parse('2026-08-01T00:00:00.000Z');
    const iso = (ms: number) => new Date(ms).toISOString();
    db.transaction(() => {
        for (let i = 0; i < 450; i++) insert.run(`whole-${String(i).padStart(4, '0')}`, `Whole ${i}`, ann.pubKeyHex, iso(base), iso(base + i * 1000));
    })();
    const wholeIds = new Set(Array.from({ length: 450 }, (_, i) => `whole-${String(i).padStart(4, '0')}`));

    // ── A read without the new parameters: as it always was ──
    const legacy = await read('', carol);
    assert(legacy.status === 200 && legacy.rows.length === 200 && legacy.next === null,
        `a read without paged=1 answers its first 200 and no key, as before (${legacy.rows.length} rows, key ${legacy.next})`);
    assert(legacy.rows[0]?.id === 'whole-0449' && legacy.rows[199]?.id === 'whole-0250', 'newest changed first, as before');

    // ── A whole read, paged ──
    const whole = await readAll('', carol);
    assert(whole.sizes.join(',') === '200,200,50' && whole.lastNext === null,
        `a whole read of 450 listings comes in three pages, the last short and with no key (${whole.sizes.join(', ')})`);
    assert(once(whole.rows) && whole.rows.length === 450 && whole.rows.every(r => wholeIds.has(r.id)), 'each of the 450 once');
    assert(whole.rows.slice(0, 200).map(r => r.id).join() === legacy.rows.map(r => r.id).join(),
        'its first page is the same 200 as the read without the parameters');

    // ── A delta of 450 changes, paged ──
    const cursor = iso(Date.now() - 1000);
    db.transaction(() => {
        for (let i = 0; i < 450; i++) insert.run(`chg-${String(i).padStart(4, '0')}`, `Changed ${i}`, ann.pubKeyHex, iso(Date.now()), iso(Date.now() + i));
    })();
    const delta = await readAll(cursor, carol);
    assert(delta.sizes.join(',') === '200,200,50' && once(delta.rows) && delta.rows.length === 450,
        `a delta of 450 changes comes in three pages, each change once (${delta.sizes.join(', ')})`);
    assert(delta.rows.every(r => r.id.startsWith('chg-')), 'and none of the listings that did not change');

    // ── Ties across a page's edge ──
    const tie = iso(Date.now() + 60_000);
    db.transaction(() => {
        for (let i = 0; i < 30; i++) insert.run(`tie-${String(i).padStart(2, '0')}`, `Tie ${i}`, ann.pubKeyHex, tie, tie);
        // 185 newer, so the 30 tied listings straddle the first page's edge.
        for (let i = 0; i < 185; i++) insert.run(`top-${String(i).padStart(3, '0')}`, `Top ${i}`, ann.pubKeyHex, iso(Date.now() + 120_000), iso(Date.now() + 120_000 + i));
    })();
    const tied = await readAll(tie, carol);
    assert(tied.sizes.join(',') === '200,15' && once(tied.rows) && tied.rows.filter(r => r.id.startsWith('tie-')).length === 30,
        `30 listings with one time to the millisecond across the first page's edge: each once (${tied.sizes.join(', ')})`);

    // ── Changes between pages ──
    const group = crypto.randomUUID();
    db.prepare(`INSERT INTO groups (id, name, slug, created_by) VALUES (?, 'Ann only', 'ann-only', ?)`).run(group, ann.pubKeyHex);
    const visibleBefore = (await readAll('', carol)).rows.map(r => r.id);
    const takenAt = iso(Date.now() - 5 * 60_000); // the phone's cursor: when the read began, less its five minutes
    const editId = visibleBefore[visibleBefore.length - 5]; // on the last page
    const leaveId = visibleBefore[3];                         // on the first page
    const mid = await readAll('', carol, (page) => {
        if (page !== 1) return;
        db.prepare(`UPDATE posts SET title = 'Edited between pages', updated_at = ? WHERE id = ?`).run(iso(Date.now() + 600_000), editId);
        insert.run('made-mid-read', 'Made between pages', ann.pubKeyHex, iso(Date.now() + 600_000), iso(Date.now() + 600_000));
        db.prepare(`UPDATE posts SET audience_scope = 'group', target_group_id = ? WHERE id = ?`).run(group, leaveId);
    });
    const got = new Set(mid.rows.map(r => r.id));
    const missing = visibleBefore.filter(id => id !== editId && id !== leaveId && !got.has(id));
    assert(once(mid.rows) && missing.length === 0,
        `between two pages one listing edited, one made, one of the first page's leaving the reader's view: every other listing comes, once (${missing.length} missing)`);
    const after = await readAll(takenAt, carol);
    const edited = after.rows.find(r => r.id === editId);
    assert(edited?.title === 'Edited between pages' && after.rows.some(r => r.id === 'made-mid-read'),
        'the delta from a cursor taken before the first page holds the edited listing and the new one');

    // ── A key the node never handed out; the 304 ──
    const bad = await read('&pageAfter=not-a-key', carol);
    assert(bad.status === 400, `a key the node never handed out is a 400 (${bad.status})`);
    const first = await read('&paged=1', carol);
    const again = await read('&paged=1', carol, { 'If-None-Match': first.etag || '' });
    assert(!!first.etag && again.status === 304, `the paged read keeps its 304 (${again.status})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ The phone\'s posts sync reads every page.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
