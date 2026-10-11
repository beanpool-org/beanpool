/**
 * The posts search through the REAL server (#1781): what the route answers for `q`, through the signature middleware.
 *
 * 1. Control characters in a raw `q` (a NUL above all) never reach FTS5 as they are: a NUL in a quoted FTS5 string ended it
 *    ("unterminated string"), getPosts threw and the route answered 500. The engine's search (posts.ts searchCondition),
 *    which the route, Home's saved-search card and the phone all reach, now reads them as spaces, so the answer is a 200
 *    with the listings the words without them find.
 *
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-search-http.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, createPost } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { setMemberPhoto } from '@beanpool/engine';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ FAIL: ${msg}`);
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };

function makeMember(callsign: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, updated_at)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pubKeyHex, callsign);
    setMemberPhoto(db, pubKeyHex, 'data:image/png;base64,iVBORw0KGgo=');
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pubKeyHex);
    return { pubKeyHex, privateKey };
}

async function signedGet(path: string, id: Id): Promise<{ status: number; body: any }> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `GET\n${path.split('?')[0]}\n${ts}\n${nonce}\n`;
    const res = await fetch(`${BASE}${path}`, {
        headers: {
            'X-Public-Key': id.pubKeyHex,
            'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
            'X-Timestamp': String(ts),
            'X-Nonce': nonce,
        },
    });
    let body: any; try { body = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, body };
}

/** The titles a search answers this reader, sorted, and the status. */
async function search(q: string | null, who: Id): Promise<{ status: number; titles: string[] }> {
    const res = await signedGet(`/api/marketplace/posts${q === null ? '' : `?q=${encodeURIComponent(q)}`}${q === null ? '?' : '&'}limit=200`, who);
    return { status: res.status, titles: Array.isArray(res.body) ? res.body.map((p: any) => p.title as string).sort() : [] };
}

async function main(): Promise<void> {
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const mei = makeMember('Mei');
    const reader = makeMember('Reader');
    const post = (title: string, author: Id) => {
        const p = createPost('offer', 'food', title, '', 5, 'fixed', author.pubKeyHex);
        if (!p) throw new Error(`createPost refused "${title}"`);
    };
    post('Fresh eggs', mei);
    post('Fresh bread', mei);
    post('新鲜鸡蛋出售', mei);
    post('Garden spade', mei);

    // ── 1. Control characters in a raw q ────────────────────────────────────────
    const asked: Array<[string, string]> = [
        ['fresh\u0000', 'fresh'],
        ['\u0000fresh', 'fresh'],
        ['fresh\u0000eggs', 'fresh eggs'],
        ['eggs\u0007\u001f\u007f\u0085', 'eggs'],
        ['鸡蛋\u0000', '鸡蛋'],
        ['"fresh\u0000"', 'fresh'],
    ];
    for (const [raw, plain] of asked) {
        const odd = await search(raw, reader);
        const clean = await search(plain, reader);
        assert(odd.status === 200, `q=${JSON.stringify(raw)} answers 200 (got ${odd.status})`);
        assert(clean.titles.length > 0 && JSON.stringify(odd.titles) === JSON.stringify(clean.titles),
            `q=${JSON.stringify(raw)} finds what q=${JSON.stringify(plain)} finds (${JSON.stringify(odd.titles)} vs ${JSON.stringify(clean.titles)})`);
    }
    const onlyNul = await search('\u0000', reader);
    const none = await search(null, reader);
    assert(onlyNul.status === 200 && JSON.stringify(onlyNul.titles) === JSON.stringify(none.titles),
        `q=NUL alone answers 200 with what no q answers (${onlyNul.status}, ${onlyNul.titles.length} vs ${none.titles.length})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Search through the real server PASSED.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
