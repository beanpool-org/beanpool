/**
 * Marketplace posts ignore archetypes, against the REAL server.
 *
 * #823 added a `targetArchetypes` field on create and a `targetArchetype` filter on the list, over a
 * `posts.target_archetypes` column. Nothing used them, and a filter like that is how "posts for
 * Guardians only" would get built. Archetypes gate nothing, same as tiers (docs/the-commons.md,
 * "Working-style archetypes"), so both were removed. The column stays: dropping it needs a table
 * rebuild on every node for no gain, so the server just stops reading and writing it.
 *
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-posts-ignore-archetypes.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';

const PORT = 8611;
const BASE = `https://localhost:${PORT}`;
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

/** A member complete enough to post: profile fields + a listed Offer for the need covenant. */
function makeAuthor(callsign: string) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(
        `INSERT OR IGNORE INTO members (public_key, callsign, joined_at, avatar_url)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'data:image/png;base64,iVBORw0KGgo=')`
    ).run(pubKeyHex, callsign);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pubKeyHex);
    return { pubKeyHex, privateKey };
}

async function signedFetch(method: 'GET' | 'POST', path: string, id: { pubKeyHex: string; privateKey: crypto.KeyObject }, body?: any) {
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const signPath = path.split('?')[0];
    const canonical = `${method}\n${signPath}\n${ts}\n${nonce}\n${bodyString}`;
    const headers: Record<string, string> = {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'POST' ? bodyString : undefined });
    let json: any; try { json = await res.json(); } catch { /* */ }
    return { status: res.status, body: json, error: json?.error as string | undefined };
}

const post = (title: string, extra: Record<string, unknown> = {}) => ({
    type: 'offer', category: 'general', title, description: 'test listing',
    credits: 20, priceType: 'fixed', ...extra,
});

async function main() {
    console.log('Running marketplace-ignores-archetypes tests...\n');
    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    const author = makeAuthor('archetypetester');

    // ── 1. Create ignores targetArchetypes ──────────────────────────────────────
    const tagged = await signedFetch('POST', '/api/marketplace/posts', author,
        { ...post('Tagged for guardians'), targetArchetypes: '["guardian"]', authorPublicKey: author.pubKeyHex });
    assert(tagged.status === 200, `a post sent with targetArchetypes is still created (got ${tagged.status} ${tagged.error ?? ''})`);
    const taggedId = tagged.body?.post?.id as string;
    assert(!('targetArchetypes' in (tagged.body?.post || {})), 'the created post does not echo targetArchetypes');
    const stored = db.prepare('SELECT target_archetypes FROM posts WHERE id = ?').get(taggedId) as { target_archetypes: string | null } | undefined;
    assert(!!stored && stored.target_archetypes === null, 'the column is not written');

    const plain = await signedFetch('POST', '/api/marketplace/posts', author,
        { ...post('Untagged'), authorPublicKey: author.pubKeyHex });
    assert(plain.status === 200, `an untagged post is created (got ${plain.status} ${plain.error ?? ''})`);
    const plainId = plain.body?.post?.id as string;

    // A row written before the removal still has a value in the column. It must not leak out.
    db.prepare(`UPDATE posts SET target_archetypes = '["sage"]' WHERE id = ?`).run(plainId);

    // ── 2. The list ignores targetArchetype ─────────────────────────────────────
    const all = await signedFetch('GET', '/api/marketplace/posts', author);
    const allIds = (all.body as any[]).map(p => p.id);
    assert(allIds.includes(taggedId) && allIds.includes(plainId), 'unfiltered list shows both posts');

    for (const key of ['sage', 'guardian', 'catalyst']) {
        const filtered = await signedFetch('GET', `/api/marketplace/posts?targetArchetype=${key}`, author);
        const ids = (filtered.body as any[]).map(p => p.id);
        assert(
            filtered.status === 200 && ids.includes(taggedId) && ids.includes(plainId),
            `?targetArchetype=${key} returns every post, not a filtered subset`,
        );
    }

    assert(
        (all.body as any[]).every(p => !('targetArchetypes' in p) && !('target_archetypes' in p)),
        'no listed post carries targetArchetypes, even one with a stale column value',
    );

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Marketplace ignores archetypes PASSED.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
