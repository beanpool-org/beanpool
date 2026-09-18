/**
 * The community activity feed is readable by members only.
 *
 * GET /api/activity/feed returns the last ~100 community events: every completed trade with BOTH
 * callsigns, the listing title and the Beans, and a row for each member who joins. It sat on the
 * public-read allowlist, so anyone who knew a node's address could read it with no sign-in. Marty's
 * call on the board (2026-09-18): "Require membership".
 *
 * Boots the real server with every ENFORCE_* variable REMOVED (the fresh-download default), then:
 *   1. an unsigned GET of the feed → 401
 *   2. a guest signed by a key that is NOT a member here → 403
 *   3. a member who took part in the trade → 200 with the trade in it
 *   4. a member who took NO part in it → 200 with the same trade (it is a community feed, not a
 *      per-participant one)
 *   5. every public read a guest needs still returns 200, unsigned and signed by the non-member
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-activity-feed-members-only.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
// Module consts read at import, so they are removed before the dynamic imports below.
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.ENFORCE_LEDGER_AUTH;

import crypto from 'node:crypto';

const PORT = 8598;
const BASE = `https://localhost:${PORT}`;
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

async function get(path: string, id?: Id): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = {};
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const canonical = `GET\n${path.split('?')[0]}\n${ts}\n${nonce}\n`;
        headers['X-Public-Key'] = id.pubKeyHex;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${path}`, { headers });
    let body: any;
    try { body = await res.json(); } catch { /* binary or empty body */ }
    return { status: res.status, body };
}

async function main() {
    console.log('Activity feed is members-only, with NO environment set...\n');
    const { initTls } = await import('./services/tls.js');
    const { initStateEngine, createTreasury } = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { recordActivity } = await import('./db/activity-feed-db.js');
    const { db } = await import('./db/db.js');

    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    const member = (callsign: string): Id => {
        const id = keypair();
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                    VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'seed', 'seed')`).run(id.pubKeyHex, callsign);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pubKeyHex);
        return id;
    };
    const alice = member('alice');
    const bob = member('bob');
    const carol = member('carol');
    const guest = keypair();

    // The row a completed trade writes (engine/escrow.ts): both parties, the listing and the Beans.
    recordActivity('trade_completed', alice.pubKeyHex, bob.pubKeyHex, { credits: 42, postTitle: 'Sourdough loaf' });
    const FEED = '/api/activity/feed';
    const hasTrade = (body: any) => Array.isArray(body?.feed) && body.feed.some((e: any) =>
        e.eventType === 'trade_completed' && e.actorCallsign === 'alice' && e.targetCallsign === 'bob');

    console.log('── a stranger is refused ──');
    const unsigned = await get(FEED);
    assert(unsigned.status === 401, `unsigned GET ${FEED} is refused with 401 (got ${unsigned.status})`);
    assert(!hasTrade(unsigned.body), 'the unsigned response carries no trade');
    const unsignedPaged = await get(`${FEED}?limit=100&offset=0`);
    assert(unsignedPaged.status === 401, `unsigned GET ${FEED}?limit=100 is refused with 401 (got ${unsignedPaged.status})`);

    console.log('\n── a signed non-member (a guest) is refused ──');
    const asGuest = await get(FEED, guest);
    assert(asGuest.status === 403, `non-member guest, signed, is refused with 403 (got ${asGuest.status})`);
    assert(!hasTrade(asGuest.body), 'the guest response carries no trade');

    console.log('\n── any member of the community reads it ──');
    const asAlice = await get(FEED, alice);
    assert(asAlice.status === 200, `alice (in the trade), signed, gets 200 (got ${asAlice.status})`);
    assert(hasTrade(asAlice.body), 'alice sees the alice→bob trade');
    const asCarol = await get(FEED, carol);
    assert(asCarol.status === 200, `carol (NOT in the trade), signed, gets 200 (got ${asCarol.status})`);
    assert(hasTrade(asCarol.body), 'carol sees the same alice→bob trade — it is a community feed');

    console.log('\n── a guest can still browse the public community ──');
    const enterprise = createTreasury('Guest Visible Bakery', 'data:image/png;base64,iVBORw0KGgo=', 0, { leadKeeperPubkey: alice.pubKeyHex }).publicKey;
    const guestReads: string[] = [
        '/api/community/info',
        '/api/node/info',
        '/api/marketplace/posts',
        '/api/enterprises',
        '/api/enterprises/map',
        `/api/enterprise/${enterprise}`,
        '/api/pulse/feed',
        '/api/invite/check?code=NOT-A-REAL-CODE',
    ];
    for (const path of guestReads) {
        const u = await get(path);
        assert(u.status === 200, `unsigned GET ${path.split('?')[0]} is 200 (got ${u.status})`);
        const g = await get(path, guest);
        assert(g.status === 200, `non-member guest, signed, GET ${path.split('?')[0]} is 200 (got ${g.status})`);
    }

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ The activity feed is members-only, and guest browsing still works.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
