/**
 * Test Suite: a copy's lease on the global community (engine/copy-lease.ts; DESIGN-no-switch-messaging-fable.md §4), and who may
 * take a copy down. Damo, 16 Nov 2026: an offer deleted at home stayed on global, because only the device that made the copy
 * held the way to it. Each device now finds the copy by its id (@beanpool/core show-on-global.ts), and global keeps a lease as
 * the backstop. Boots the real server on the global profile, over HTTPS, signed, through the real middleware:
 *
 *   1. a create gives a copy its lease; a plain post has none
 *   2. within 14 days the sweep leaves it; past them it comes off the board for everyone but its author, and stays readable to
 *      the author's device by id, as up
 *   3. a confirm by its own author's key puts it back; anyone else's, or one naming a plain post, changes nothing
 *   4. a 1.4.6 phone's edit (its 30-day resend) is a confirm too
 *   5. the author's own pause is no lease's, and a confirm leaves it paused
 *   6. a copy with no lease (made before it) is left to the 90-day rule
 *   7. nobody but the owner's key can take a copy down
 *   8. the confirm route: signed, a list of 1 to 100 ids
 *
 * Run: via scripts/run-server-suites.mjs (SERVER_SUITES_ONLY=test-copy-lease)
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
process.env.NODE_PROFILE = 'global';

import crypto from 'node:crypto';
import { localFetch } from './keepalive-test-fetch.js';
import { TEST_PHOTOS } from './post-test-helper.js';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

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
function signedHeaders(method: string, p: string, body: string, id: Id): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    return {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': signRequest(id.privateKey, { method, path: p.split('?')[0], timestamp: ts, nonce, body }),
        [SIGNED_FOR_HEADER]: signedForHost(),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
}
type Answer = { status: number; body: any; text: string };
async function call(method: 'GET' | 'POST', p: string, id: Id | null, payload?: unknown): Promise<Answer> {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const res = await localFetch(`${BASE}${p}`, {
        method,
        headers: { ...(id ? signedHeaders(method, p, body, id) : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body } : {}),
    });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: parsed, text };
}

const DAY = 24 * 60 * 60 * 1000;
const EXACT = { lat: -28.68731, lng: 153.52219 };
const HOST = 'riverside.example';
const PRICE = { price_c: 2000, per: 'fixed' };
const CONFIRM = '/api/marketplace/posts/copies/confirm';

async function main() {
    console.log('A copy\'s lease on the global community...\n');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { updateGatewayConfig, DEFAULT_GATEWAY_CONFIG } = await import('./config/local-config.js');
    const { NODE_PROFILE_KEY } = await import('./config/node-profile.js');
    const { writeDirectoryRows, normaliseRegistryRow } = await import('./engine/directory-cache.js');
    const { COPY_LEASE_DAYS } = await import('./engine/copy-lease.js');
    const { setMemberPhoto } = await import('@beanpool/engine');

    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    const { stopPricingAggregatorWorker } = await import('./pricing-aggregator.js');
    stopPricingAggregatorWorker();
    updateGatewayConfig({ ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: false, maxRequestsPerMinute: 120 } });
    db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`${NODE_PROFILE_KEY}.probation`, 'false');

    const longAgo = new Date(Date.now() - 400 * DAY).toISOString();
    const member = (name: string): Id => {
        const id = keypair();
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, is_treasury, updated_at)
                    VALUES (?, ?, 'active', ?, 'genesis', 'TEST', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(id.pubKeyHex, name, longAgo);
        setMemberPhoto(db, id.pubKeyHex, 'data:image/png;base64,iVBORw0KGgo=');
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pubKeyHex);
        return id;
    };
    const robin = member('RobinSeller');
    const sam = member('SamReader');
    const stranger = keypair();
    writeDirectoryRows([normaliseRegistryRow({ node_id: `https://${HOST}`, shown_name: 'Riverside Commons', node_url: `https://${HOST}`, last_seen_at: new Date().toISOString(), accepting_knocks: true })!], new Date().toISOString());

    const postCopy = async (title: string): Promise<string> => {
        const made = await call('POST', '/api/marketplace/posts', robin, {
            id: crypto.randomUUID(), type: 'offer', category: 'food', title, description: 'Fresh this morning', authorPublicKey: robin.pubKeyHex,
            ...EXACT, photos: TEST_PHOTOS, tags: [], shownPrice: PRICE, shownFrom: { host: HOST, postId: crypto.randomUUID() },
        });
        if (made.status !== 200 || made.body?.post?.shownCopy !== true) throw new Error(`setup: ${made.status} ${made.text.slice(0, 200)}`);
        return made.body.post.id;
    };
    const lease = (id: string) => db.prepare('SELECT * FROM copy_leases WHERE post_id = ?').get(id) as { confirmed_at: string; hidden_at: string | null } | undefined;
    const status = (id: string) => (db.prepare('SELECT status FROM posts WHERE id = ?').get(id) as { status: string }).status;
    /** The lease's clock moved back, as `days` without a word from any device would leave it. */
    const ageLease = (id: string, days: number) => db.prepare('UPDATE copy_leases SET confirmed_at = ? WHERE post_id = ?').run(new Date(Date.now() - days * DAY).toISOString(), id);
    const onBoard = async (id: string, who: Id | null) => {
        const read = await call('GET', '/api/marketplace/posts?types=offer,need&limit=200', who);
        return Array.isArray(read.body) && read.body.some((p: any) => p?.id === id);
    };
    const byIdFor = async (id: string, who: Id) => (await call('GET', `/api/marketplace/posts?ids=${id}`, who)).body?.[0];

    // ── 1. A create gives a copy its lease ──
    console.log('── 1. A create gives a copy its lease ──');
    const copy = await postCopy('Sourdough loaves');
    assert(!!lease(copy) && lease(copy)!.hidden_at === null, 'a copy\'s create gives it a lease, on the board');
    const plain = await call('POST', '/api/marketplace/posts', robin, { id: crypto.randomUUID(), type: 'offer', category: 'food', title: 'Plain loaves', description: 'x', authorPublicKey: robin.pubKeyHex, lat: -28.7, lng: 153.5, photos: TEST_PHOTOS });
    const plainId: string = plain.body?.post?.id;
    assert(plain.status === 200 && !lease(plainId), 'a plain post on global has no lease');

    // ── 2. Within and past the 14 days ──
    console.log('\n── 2. Within and past the lease ──');
    ageLease(copy, COPY_LEASE_DAYS - 1);
    assert(se.sweepCopyLeases() === 0 && status(copy) === 'active', `${COPY_LEASE_DAYS - 1} days without a word: still on the board`);
    ageLease(copy, COPY_LEASE_DAYS + 1);
    ageLease(plainId, COPY_LEASE_DAYS + 1);
    assert(se.sweepCopyLeases() === 1, 'past the lease: the sweep takes one copy off, and no plain post');
    assert(status(copy) === 'paused' && !!lease(copy)!.hidden_at, 'it is paused, and marked as the lease\'s');
    assert(status(plainId) === 'active', 'the plain post is as it was');
    assert(!(await onBoard(copy, sam)) && !(await onBoard(copy, null)), 'off the board for a member and a visitor');
    const forRobin = await byIdFor(copy, robin);
    assert(forRobin?.status === 'paused' && forRobin?.shownCopy === true, 'its author\'s device still reads it by id, so it keeps its pair');
    assert(se.sweepCopyLeases() === 0, 'a second sweep finds nothing more to do');

    // ── 3. Confirms ──
    console.log('\n── 3. A confirm, by whose key ──');
    const bySam = await call('POST', CONFIRM, sam, { ids: [copy] });
    assert(bySam.status === 200 && bySam.body?.confirmed === 0 && status(copy) === 'paused', 'another member\'s confirm of it changes nothing, and says nothing of it');
    const byStranger = await call('POST', CONFIRM, stranger, { ids: [copy] });
    assert(status(copy) === 'paused', `a stranger\'s key changes nothing (${byStranger.status})`);
    const ofPlain = await call('POST', CONFIRM, robin, { ids: [plainId] });
    assert(ofPlain.body?.confirmed === 0 && !lease(plainId), 'a confirm naming a plain post passes it over: no lease for it');
    const byRobin = await call('POST', CONFIRM, robin, { ids: [copy, plainId, crypto.randomUUID()] });
    assert(byRobin.status === 200 && byRobin.body?.confirmed === 1, 'its author\'s confirm takes the one copy of theirs');
    assert(status(copy) === 'active' && lease(copy)!.hidden_at === null, 'and puts it back on the board');
    assert(await onBoard(copy, sam), 'a member reads it on the board again');

    // ── 4. A 1.4.6 phone: its edit is its word ──
    console.log('\n── 4. An edit is a confirm (a 1.4.6 phone sends no other) ──');
    ageLease(copy, COPY_LEASE_DAYS + 1);
    se.sweepCopyLeases();
    assert(status(copy) === 'paused', 'untended past the lease: off the board');
    const edit = await call('POST', '/api/marketplace/posts/update', robin, { id: copy, authorPublicKey: robin.pubKeyHex, title: 'Sourdough loaves', description: 'Fresh this morning', tags: [], freeTags: [] });
    assert(edit.status === 200, `the edit lands on a copy off the board (${edit.status} ${edit.text.slice(0, 120)})`);
    assert(status(copy) === 'active' && Date.now() - Date.parse(lease(copy)!.confirmed_at) < 60_000, 'and puts it back, its lease from now');

    // ── 5. Its author's own pause is no lease's ──
    console.log('\n── 5. A pause by its author stays theirs ──');
    const paused = await call('POST', '/api/marketplace/posts/pause', robin, { postId: copy, authorPublicKey: robin.pubKeyHex });
    assert(paused.status === 200 && status(copy) === 'paused', 'its author pauses it');
    await call('POST', CONFIRM, robin, { ids: [copy] });
    assert(status(copy) === 'paused', 'a confirm leaves a pause the lease didn\'t make');
    await call('POST', '/api/marketplace/posts/resume', robin, { postId: copy, authorPublicKey: robin.pubKeyHex });

    // ── 6. A copy from before the lease ──
    console.log('\n── 6. A copy with no lease ──');
    const before = await postCopy('From before the lease');
    db.prepare('DELETE FROM copy_leases WHERE post_id = ?').run(before);
    db.prepare('UPDATE posts SET updated_at = ? WHERE id = ?').run(new Date(Date.now() - 30 * DAY).toISOString(), before);
    se.sweepCopyLeases();
    assert(status(before) === 'active', 'no lease row: the sweep leaves it to the 90-day rule (no conversion code)');

    // ── 7. Nobody but the owner's key takes a copy down ──
    console.log('\n── 7. Taking a copy down ──');
    const bySamRemove = await call('POST', '/api/marketplace/posts/remove', sam, { id: copy, authorPublicKey: robin.pubKeyHex });
    assert(bySamRemove.status === 403 && status(copy) === 'active', `another member\'s key, naming its author, is refused (${bySamRemove.status})`);
    const bySamOwn = await call('POST', '/api/marketplace/posts/remove', sam, { id: copy, authorPublicKey: sam.pubKeyHex });
    assert(bySamOwn.status !== 200 && status(copy) === 'active', `another member\'s key, as its own, is refused (${bySamOwn.status})`);
    const byStrangerRemove = await call('POST', '/api/marketplace/posts/remove', stranger, { id: copy, authorPublicKey: robin.pubKeyHex });
    assert(byStrangerRemove.status !== 200 && status(copy) === 'active', `a stranger\'s key is refused (${byStrangerRemove.status})`);
    const unsigned = await call('POST', '/api/marketplace/posts/remove', null, { id: copy, authorPublicKey: robin.pubKeyHex });
    assert(unsigned.status === 401 && status(copy) === 'active', `no signature is refused (${unsigned.status})`);
    const byRobinRemove = await call('POST', '/api/marketplace/posts/remove', robin, { id: copy, authorPublicKey: robin.pubKeyHex });
    assert(byRobinRemove.status === 200 && status(copy) === 'cancelled', 'its author\'s key takes it down');
    await call('POST', CONFIRM, robin, { ids: [copy] });
    assert(status(copy) === 'cancelled', 'a confirm never brings back a copy taken down');

    // ── 8. The route ──
    console.log('\n── 8. The confirm route ──');
    assert((await call('POST', CONFIRM, null, { ids: [copy] })).status === 401, 'unsigned: 401');
    for (const [what, body] of [['no ids', {}], ['an empty list', { ids: [] }], ['a string', { ids: copy }], ['a number in it', { ids: [1] }], ['101 ids', { ids: Array.from({ length: 101 }, () => crypto.randomUUID()) }]] as const) {
        assert((await call('POST', CONFIRM, robin, body)).status === 400, `${what}: 400`);
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
