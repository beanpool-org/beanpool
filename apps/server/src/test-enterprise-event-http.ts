/**
 * An enterprise hosting an event, over REAL HTTP — through the signature middleware, not the router alone.
 *
 * This suite exists because the bug it covers was invisible to a router-level test. The web and phone event
 * forms hosted for an enterprise by naming it as `authorPublicKey` on POST /api/marketplace/posts, and the
 * route was written to accept that. It never could: the signature middleware refuses ANY body field ending in
 * `pubkey`/`publickey` that is not the signer, so the request died with 403 "Signature validation failed"
 * before the handler ran — while the handler's own tests passed, because they drive the router directly. It is
 * the same trap as the cross-node `seller` field (#143). So every check here goes over the wire.
 *
 * Verifies:
 *  1. A keeper signs and posts an event to POST /api/treasury/:treasury/event and it is accepted; the stored
 *     row has the ENTERPRISE as author_pubkey and the KEEPER as created_by, as its Offer and Need do.
 *  2. A signed member who is not a keeper of that enterprise: 403.
 *  3. An unsigned request: 401, from the middleware, before the route runs.
 *  4. A body that also carries a mismatched `...Pubkey` field: 403 from the middleware — the new route buys
 *     no exemption from the spoof check, which is the whole point of putting the enterprise in the path.
 *  5. The old way really is refused over HTTP: naming the enterprise as `authorPublicKey` on
 *     /api/marketplace/posts is 403 "Signature validation failed" — the bug Damo hit, and the reason old app
 *     builds keep failing until they are updated.
 *  6. Validation parity with the marketplace route, over the wire: an unparseable start, a start in the past,
 *     an end before the start, a missing title, a missing pin, and more than 5 photos are all refused.
 *  7. A member's own event still goes through /api/marketplace/posts and has no created_by.
 *  8. A keeper can EDIT what the enterprise hosts, signing with their own key: the other half of "Post as".
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-enterprise-event-http.ts
 */

// Self-signed cert in LAN mode → relax TLS verification for the test client only.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, createTreasury, adminAssignTreasuryOperator } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';

const PORT = 8697;
const BASE = `https://localhost:${PORT}`;
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const HOUR = 60 * 60 * 1000;
const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();

// Every assertion runs and failures are reported together, so one broken finding does not hide the others.
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ FAIL: ${msg}`); }
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };

function makeIdentity(callsign: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, avatar_url, status, joined_at, updated_at)
                VALUES (?, ?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
      .run(pubKeyHex, callsign, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pubKeyHex);
    return { pubKeyHex, privateKey };
}

/** The replay-proof scheme the real middleware requires: method + path + timestamp + nonce + body. */
async function signedFetch(method: 'POST', path: string, body: unknown, id: Id | null) {
    const bodyString = JSON.stringify(body ?? {});
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const canonical = `${method}\n${path}\n${ts}\n${nonce}\n${bodyString}`;
        headers['X-Public-Key'] = id.pubKeyHex;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body: bodyString });
    let json: any;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, body: json, error: json?.error as string | undefined };
}

async function main(): Promise<void> {
    console.log('\nAn enterprise hosting an event, over real HTTP\n');
    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    const keeper = makeIdentity('KeeperKim');
    const stranger = makeIdentity('StrangerSam');

    const { publicKey: enterprise } = createTreasury('Bindarrabi Hall', AVATAR, 0, { leadKeeperPubkey: keeper.pubKeyHex });
    adminAssignTreasuryOperator(enterprise, keeper.pubKeyHex, 'admin', 0);

    const eventPath = `/api/treasury/${enterprise}/event`;
    const event = (extra: Record<string, unknown> = {}) => ({
        title: 'Hall working bee',
        description: 'Bring gloves',
        lat: -28.55,
        lng: 153.5,
        eventStartAt: inHours(30),
        eventPlaceName: 'The old bowls club',
        eventPrivateNote: 'Gate code 1234',
        ...extra,
    });

    // ── 1. A keeper hosts for the enterprise ─────────────────────────────────────────────────
    console.log('── 1. A keeper hosts for the enterprise ──');
    const created = await signedFetch('POST', eventPath, event({ photos: [PHOTO] }), keeper);
    assert(created.status === 200 && created.body?.success === true,
        `a keeper's signed event is accepted through the real middleware (got ${created.status} ${created.error ?? ''})`);
    const newId = created.body?.post?.id;
    const row = newId && db.prepare('SELECT author_pubkey, created_by, type, event_place_name, event_private_note FROM posts WHERE id = ?').get(newId) as any;
    assert(!!row && row.author_pubkey === enterprise, 'the stored event is authored by the ENTERPRISE');
    assert(!!row && row.created_by === keeper.pubKeyHex, '...and records the KEEPER as created_by');
    assert(!!row && row.type === 'event', '...and is stored as an event');
    assert(!!row && row.event_place_name === 'The old bowls club' && row.event_private_note === 'Gate code 1234',
        '...carrying the place and the going-note it was sent with');
    const photoCount = newId ? (db.prepare('SELECT COUNT(*) c FROM post_photos WHERE post_id = ?').get(newId) as any).c : 0;
    assert(photoCount === 1, '...and its photo');

    // ── 2. A member who is not a keeper ──────────────────────────────────────────────────────
    console.log('\n── 2. Not a keeper ──');
    const refused = await signedFetch('POST', eventPath, event(), stranger);
    assert(refused.status === 403, `a signed member who is not a keeper is refused (got ${refused.status})`);
    assert(refused.error === 'You are not a keeper of this enterprise', '...with the keeper refusal');

    // ── 3. Unsigned ──────────────────────────────────────────────────────────────────────────
    console.log('\n── 3. Unsigned ──');
    const unsigned = await signedFetch('POST', eventPath, event(), null);
    assert(unsigned.status === 401, `an unsigned request is refused by the middleware (got ${unsigned.status})`);

    // ── 4. The spoof check still bites on the new route ──────────────────────────────────────
    console.log('\n── 4. The spoof check is untouched ──');
    const spoofed = await signedFetch('POST', eventPath, event({ authorPublicKey: enterprise }), keeper);
    assert(spoofed.status === 403 && spoofed.error === 'Signature validation failed',
        `a mismatched ...PublicKey in the body is still refused by the middleware (got ${spoofed.status} ${spoofed.error ?? ''})`);
    const spoofed2 = await signedFetch('POST', eventPath, event({ somethingPubkey: stranger.pubKeyHex }), keeper);
    assert(spoofed2.status === 403 && spoofed2.error === 'Signature validation failed',
        '...and so is any other body field ending in Pubkey that is not the signer');
    const notSpoofed = db.prepare("SELECT COUNT(*) c FROM posts WHERE author_pubkey = ? AND type = 'event'").get(enterprise) as any;
    assert(notSpoofed.c === 1, 'neither refusal created an event');

    // ── 5. The old way, which is the bug ─────────────────────────────────────────────────────
    console.log('\n── 5. Naming the enterprise in the body (the bug) ──');
    const oldWay = await signedFetch('POST', '/api/marketplace/posts', {
        type: 'event', category: 'community', title: 'Hall working bee', credits: 0, priceType: 'fixed',
        authorPublicKey: enterprise, lat: -28.55, lng: 153.5, eventStartAt: inHours(30),
    }, keeper);
    assert(oldWay.status === 403 && oldWay.error === 'Signature validation failed',
        `hosting through the marketplace route with the enterprise in the body is refused by the middleware (got ${oldWay.status} ${oldWay.error ?? ''})`);

    // ── 6. Validation parity, over the wire ──────────────────────────────────────────────────
    console.log('\n── 6. Validation parity ──');
    const bad = async (extra: Record<string, unknown>, match: RegExp, msg: string) => {
        const res = await signedFetch('POST', eventPath, event(extra), keeper);
        assert(res.status === 400 && match.test(res.error ?? ''), `${msg} (got ${res.status} "${res.error ?? ''}")`);
    };
    await bad({ eventStartAt: 'next tuesday' }, /Start time must be a valid date/, 'an unparseable start is refused');
    await bad({ eventStartAt: inHours(-1) }, /must start in the future/, 'a start in the past is refused');
    await bad({ eventStartAt: inHours(5), eventEndAt: inHours(4) }, /must end after it starts/, 'an end before the start is refused');
    await bad({ lat: undefined, lng: undefined }, /needs a place on the map/, 'an event with no pin is refused');
    await bad({ eventPlaceName: 'x'.repeat(81) }, /80 characters/, 'a place name over 80 characters is refused');
    await bad({ eventPrivateNote: 'x'.repeat(1001) }, /1000 characters/, 'a going-note over 1000 characters is refused');
    await bad({ photos: Array(6).fill(PHOTO) }, /at most 5 photos/, 'more than five photos is refused');
    const noTitle = await signedFetch('POST', eventPath, event({ title: '' }), keeper);
    assert(noTitle.status === 400 && /title is required/.test(noTitle.error ?? ''),
        `an event with no title is refused (got ${noTitle.status} "${noTitle.error ?? ''}")`);
    const stillOne = db.prepare("SELECT COUNT(*) c FROM posts WHERE author_pubkey = ? AND type = 'event'").get(enterprise) as any;
    assert(stillOne.c === 1, 'no refused event was stored');

    // ── 7. A member's own event is unchanged ─────────────────────────────────────────────────
    console.log("\n── 7. A member's own event ──");
    const own = await signedFetch('POST', '/api/marketplace/posts', {
        type: 'event', category: 'community', title: 'Creek swim', credits: 0, priceType: 'fixed',
        authorPublicKey: stranger.pubKeyHex, lat: -28.55, lng: 153.5, eventStartAt: inHours(30),
    }, stranger);
    assert(own.status === 200 && own.body?.success === true,
        `a member hosting their own event through the marketplace route still works (got ${own.status} ${own.error ?? ''})`);
    const ownRow = own.body?.post?.id && db.prepare('SELECT author_pubkey, created_by FROM posts WHERE id = ?').get(own.body.post.id) as any;
    assert(!!ownRow && ownRow.author_pubkey === stranger.pubKeyHex && ownRow.created_by === null,
        "...authored by the member, with no created_by");

    // ── 8. Editing what the enterprise hosts ─────────────────────────────────────────────────
    // The forms sign an edit with the member's OWN key and let the node check the host set, so an edit does
    // not need the enterprise anywhere. Checked here because it is the other half of "Post as": an event you
    // can create and not change would be worse than one you cannot create.
    console.log('\n── 8. Editing the enterprise event ──');
    const edited = await signedFetch('POST', '/api/marketplace/posts/update', {
        id: newId, authorPublicKey: keeper.pubKeyHex, title: 'Hall working bee (bring a rake)',
    }, keeper);
    assert(edited.status === 200 && edited.body?.success === true,
        `a keeper edits the enterprise's event with their own key (got ${edited.status} ${edited.error ?? ''})`);
    const afterEdit = newId && db.prepare('SELECT title, author_pubkey FROM posts WHERE id = ?').get(newId) as any;
    assert(!!afterEdit && afterEdit.title === 'Hall working bee (bring a rake)' && afterEdit.author_pubkey === enterprise,
        '...and the event is still the enterprise\u2019s');
    const strangerEdit = await signedFetch('POST', '/api/marketplace/posts/update', {
        id: newId, authorPublicKey: stranger.pubKeyHex, title: 'Hijacked',
    }, stranger);
    assert(strangerEdit.status === 404 || strangerEdit.status === 403,
        `a member who is not a host cannot edit it (got ${strangerEdit.status})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Enterprise event over HTTP PASSED.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
