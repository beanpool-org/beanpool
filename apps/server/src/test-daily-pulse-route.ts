/**
 * Test Suite: GET /api/pulse/daily — Daily Pulse reflection route.
 *
 * Verifies:
 * 1. Read rules match the Pulse feed route (/api/pulse/feed):
 *    - Unsigned GET → 401
 *    - Signed guest (non-member) → 403
 *    - Signed member → 200
 * 2. Today's entry: answers { date, headline, body } matching getTodaysPulseEntry().
 * 3. A past date: answers { date, headline, body } matching getPulseEntry() for that date.
 * 4. Bad date:
 *    - Malformed date string (not YYYY-MM-DD or invalid calendar date) → 400
 *    - Unknown date (future date) → 404
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-daily-pulse-route.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.ENFORCE_LEDGER_AUTH;

import crypto from 'node:crypto';

let PORT = 0;
let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
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
    try {
        body = await res.json();
    } catch {
        /* empty */
    }
    return { status: res.status, body };
}

async function main() {
    console.log('🧪 Testing GET /api/pulse/daily route...\n');
    const { initTls } = await import('./services/tls.js');
    const { initStateEngine } = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { getTodaysPulseEntry, getPulseEntry } = await import('./daily-pulse-entries.js');

    await initTls();
    initStateEngine();
    PORT = await startHttpsServer(0);
    BASE = `https://localhost:${PORT}`;

    const member = (callsign: string): Id => {
        const id = keypair();
        db.prepare(
            `INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
             VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'seed', 'seed')`
        ).run(id.pubKeyHex, callsign);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pubKeyHex);
        return id;
    };

    const alice = member('alice');
    const guest = keypair();

    console.log('── 1. Read rules match /api/pulse/feed ──');
    const unsignedFeed = await get('/api/pulse/feed');
    const unsignedDaily = await get('/api/pulse/daily');
    assert(unsignedDaily.status === unsignedFeed.status, `unsigned GET /api/pulse/daily status (${unsignedDaily.status}) matches feed (${unsignedFeed.status})`);
    assert(unsignedDaily.status === 401, `unsigned GET /api/pulse/daily is refused with 401`);

    const guestFeed = await get('/api/pulse/feed', guest);
    const guestDaily = await get('/api/pulse/daily', guest);
    assert(guestDaily.status === guestFeed.status, `guest GET /api/pulse/daily status (${guestDaily.status}) matches feed (${guestFeed.status})`);
    assert(guestDaily.status === 403, `guest GET /api/pulse/daily is refused with 403`);

    const aliceDaily = await get('/api/pulse/daily', alice);
    assert(aliceDaily.status === 200, `member GET /api/pulse/daily succeeds with 200 (got ${aliceDaily.status})`);

    console.log('\n── 2. Today\'s Daily Pulse entry ──');
    const now = new Date();
    const localEpochMs = now.getTime() - (now.getTimezoneOffset() * 60 * 1000);
    const expectedTodayStr = new Date(localEpochMs).toISOString().split('T')[0];
    const todaysEntry = getTodaysPulseEntry(now);

    assert(aliceDaily.body?.date === expectedTodayStr, `Today's date is "${expectedTodayStr}" (got "${aliceDaily.body?.date}")`);
    assert(aliceDaily.body?.headline === todaysEntry.headline, `Headline matches: "${aliceDaily.body?.headline}"`);
    assert(aliceDaily.body?.body === todaysEntry.body, `Body matches today's reflection (${aliceDaily.body?.body?.length} chars)`);

    console.log('\n── 3. A past date ──');
    const pastDateStr = '2026-08-16';
    const [py, pm, pd] = pastDateStr.split('-').map(Number);
    const pastDayIndex = Math.floor(Date.UTC(py, pm - 1, pd) / 86400000);
    const pastEntry = getPulseEntry(pastDayIndex);

    const pastRes = await get(`/api/pulse/daily?date=${pastDateStr}`, alice);
    assert(pastRes.status === 200, `GET with past date ?date=${pastDateStr} returns 200`);
    assert(pastRes.body?.date === pastDateStr, `Past date is "${pastDateStr}"`);
    assert(pastRes.body?.headline === pastEntry.headline, `Past headline matches: "${pastRes.body?.headline}"`);
    assert(pastRes.body?.body === pastEntry.body, `Past body matches entry (${pastRes.body?.body?.length} chars)`);

    console.log('\n── 4. Bad dates (malformed → 400, unknown → 404) ──');
    const malformed1 = await get('/api/pulse/daily?date=invalid-date', alice);
    assert(malformed1.status === 400, `Malformed date "invalid-date" returns 400 (got ${malformed1.status})`);

    const malformed2 = await get('/api/pulse/daily?date=2026-02-31', alice);
    assert(malformed2.status === 400, `Invalid calendar date "2026-02-31" returns 400 (got ${malformed2.status})`);

    const malformed3 = await get('/api/pulse/daily?date=2026-13-01', alice);
    assert(malformed3.status === 400, `Invalid month "2026-13-01" returns 400 (got ${malformed3.status})`);

    const futureDate = await get('/api/pulse/daily?date=2099-01-01', alice);
    assert(futureDate.status === 404, `Future date "2099-01-01" returns 404 unknown (got ${futureDate.status})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) {
        throw new Error(`${run - passed} check(s) failed`);
    }
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('❌ Test failed:', err);
        process.exit(1);
    });
