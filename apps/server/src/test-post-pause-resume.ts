/**
 * Integration test for Marketplace Post Pause & Resume routes (#108):
 *   POST /api/marketplace/posts/pause
 *   POST /api/marketplace/posts/resume
 *
 * Verifies parameter validation, author authorization, state mutation,
 * and visibility filtering in general feeds vs author feed.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx apps/server/src/test-post-pause-resume.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, getPosts } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';

const PORT = 8551;
const BASE = `https://localhost:${PORT}`;
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

function makeMember(callsign: string) {
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

async function main() {
    console.log('Running Post Pause & Resume tests...\n');
    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    const author = makeMember('postauthor');
    const stranger = makeMember('stranger');

    // Create a post as author
    const createRes = await signedFetch('POST', '/api/marketplace/posts', author, {
        type: 'offer', category: 'general', title: 'Garden Tools', description: 'Rake and shovel',
        credits: 10, priceType: 'fixed', authorPublicKey: author.pubKeyHex,
    });
    assert(createRes.status === 200, 'author created a post successfully');
    const postId = createRes.body?.post?.id;
    assert(!!postId, 'post ID was returned');

    // ── 1. Parameter Validation ─────────────────────────────────────────────────
    const missingPostId = await signedFetch('POST', '/api/marketplace/posts/pause', author, {
        authorPublicKey: author.pubKeyHex,
    });
    assert(missingPostId.status === 400, 'POST /api/marketplace/posts/pause rejects missing postId with 400');

    const missingAuthor = await signedFetch('POST', '/api/marketplace/posts/pause', author, {
        postId,
    });
    assert(missingAuthor.status === 400, 'POST /api/marketplace/posts/pause rejects missing authorPublicKey with 400');

    const missingResumePostId = await signedFetch('POST', '/api/marketplace/posts/resume', author, {
        authorPublicKey: author.pubKeyHex,
    });
    assert(missingResumePostId.status === 400, 'POST /api/marketplace/posts/resume rejects missing postId with 400');

    // ── 2. Authorization / Non-Author Rejection ──────────────────────────────
    const strangerPause = await signedFetch('POST', '/api/marketplace/posts/pause', stranger, {
        postId,
        authorPublicKey: stranger.pubKeyHex,
    });
    assert(strangerPause.status === 400 || strangerPause.body?.success === false, 'non-author pausing post fails');

    // ── 3. Author Pausing Post ──────────────────────────────────────────────────
    const pauseRes = await signedFetch('POST', '/api/marketplace/posts/pause', author, {
        postId,
        authorPublicKey: author.pubKeyHex,
    });
    assert(pauseRes.status === 200 && pauseRes.body?.success === true, 'author successfully paused post');

    // ── 4. Feed Visibility when Paused ─────────────────────────────────────────
    const publicFeed = await fetch(`${BASE}/api/marketplace/posts`);
    const publicItems = (await publicFeed.json()) as any[];
    assert(!publicItems.some(p => p.id === postId), 'paused post is hidden from public feed');

    const authorSelfView = getPosts({ authorPubkey: author.pubKeyHex, viewerPubkey: author.pubKeyHex });
    assert(authorSelfView.some(p => p.id === postId), 'author viewing their own posts sees paused post');

    const strangerView = getPosts({ authorPubkey: author.pubKeyHex, viewerPubkey: stranger.pubKeyHex });
    assert(!strangerView.some(p => p.id === postId), 'stranger viewing author posts does not see paused post');

    // ── 5. Resuming Post ───────────────────────────────────────────────────────
    const strangerResume = await signedFetch('POST', '/api/marketplace/posts/resume', stranger, {
        postId,
        authorPublicKey: stranger.pubKeyHex,
    });
    assert(strangerResume.status === 400 || strangerResume.body?.success === false, 'non-author resuming post fails');

    const resumeRes = await signedFetch('POST', '/api/marketplace/posts/resume', author, {
        postId,
        authorPublicKey: author.pubKeyHex,
    });
    assert(resumeRes.status === 200 && resumeRes.body?.success === true, 'author successfully resumed post');

    const restoredFeed = await fetch(`${BASE}/api/marketplace/posts`);
    const restoredItems = (await restoredFeed.json()) as any[];
    assert(restoredItems.some(p => p.id === postId), 'resumed post is visible again in public feed');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Post Pause & Resume tests PASSED.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
