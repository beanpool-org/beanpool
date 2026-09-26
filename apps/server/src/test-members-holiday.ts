/**
 * Integration test for Members Holiday Mode route (#143):
 *   POST /api/members/holiday
 *
 * Verifies authentication, enabling/disabling holiday mode when no open trades exist,
 * and rejection when open trades are in progress. Also that POST /api/members/preferences
 * takes only the push settings, so holiday mode can't go round that check through it.
 *
 * Run with:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx apps/server/src/test-members-holiday.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, createPost, requestPost, reconcileLedgerFromDb, isOnHoliday } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';

const PORT = 8552;
const BASE = `https://localhost:${PORT}`;
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

function makeMember(callsign: string) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(
        `INSERT OR IGNORE INTO members (public_key, callsign, joined_at, avatar_url, status)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'data:image/png;base64,iVBORw0KGgo=', 'active')`
    ).run(pubKeyHex, callsign);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 100, 0)`).run(pubKeyHex);
    return { pubKeyHex, privateKey };
}

async function signedFetch(
    method: 'GET' | 'POST',
    path: string,
    id?: { pubKeyHex: string; privateKey: crypto.KeyObject },
    body?: any
) {
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = {};

    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const signPath = path.split('?')[0];
        const canonical = `${method}\n${signPath}\n${ts}\n${nonce}\n${bodyString}`;
        headers['X-Public-Key'] = id.pubKeyHex;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }

    if (method === 'POST') headers['Content-Type'] = 'application/json';

    const res = await fetch(`${BASE}${path}`, {
        method,
        headers,
        body: method === 'POST' ? bodyString : undefined,
    });
    let json: any;
    try {
        json = await res.json();
    } catch {
        /* ignore */
    }
    return { status: res.status, body: json, error: json?.error as string | undefined };
}

async function main() {
    console.log('Running Members Holiday Mode integration tests...\n');
    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    const alice = makeMember('alice_hol');
    const bob = makeMember('bob_hol');
    reconcileLedgerFromDb();

    // ── 1. Unsigned Request Rejection ──────────────────────────────────────────
    const unsignedRes = await signedFetch('POST', '/api/members/holiday', undefined, { enabled: true });
    assert(unsignedRes.status === 401, 'unsigned POST /api/members/holiday is rejected with 401');

    // ── 2. Enable Holiday Mode (No Open Trades) ───────────────────────────────
    const enableRes = await signedFetch('POST', '/api/members/holiday', alice, { enabled: true });
    assert(enableRes.status === 200, 'signed POST /api/members/holiday { enabled: true } returns 200');
    assert(enableRes.body?.success === true, 'response indicates success === true');
    assert(enableRes.body?.enabled === true, 'response indicates enabled === true');
    assert(enableRes.body?.openTrades === 0, 'response indicates openTrades === 0');

    // ── 3. Disable Holiday Mode ────────────────────────────────────────────────
    const disableRes = await signedFetch('POST', '/api/members/holiday', alice, { enabled: false });
    assert(disableRes.status === 200, 'signed POST /api/members/holiday { enabled: false } returns 200');
    assert(disableRes.body?.enabled === false, 'response indicates enabled === false');

    // ── 4. Block Holiday Mode when Open Trades Exist ───────────────────────────
    // Create an offer as Bob (satisfying Gate 1 requirement for Bob)
    const bobPost = createPost(
        'offer',
        'general',
        'Lawn Mowing',
        'Mow your lawn',
        15,
        'fixed',
        bob.pubKeyHex
    );
    assert(!!bobPost, 'bob offer created successfully');

    // Create an offer as Alice and request it as Bob to create an in-flight trade
    const alicePost = createPost(
        'offer',
        'general',
        'Garden Help',
        'Help in the garden',
        10,
        'fixed',
        alice.pubKeyHex
    );
    assert(!!alicePost, 'alice offer created successfully');

    if (alicePost) {
        requestPost(alicePost.id, bob.pubKeyHex);
    }

    const blockedRes = await signedFetch('POST', '/api/members/holiday', alice, { enabled: true });
    assert(blockedRes.status === 400, 'POST /api/members/holiday with open trade returns 400');
    assert(blockedRes.body?.openTrades === 1, 'response includes openTrades === 1');
    assert(typeof blockedRes.error === 'string' && blockedRes.error.includes('active trade'), 'error message describes open trade requirement');

    // ── 5. Preferences take the push settings and nothing else ─────────────────
    // POST /api/members/preferences used to store every key it was given: holiday mode through it skipped the
    // open-trades check above, and any made-up key made a row. A body with anything but the push settings, or a
    // push setting that isn't true or false, is refused whole and writes nothing.
    const rowsOf = (pk: string) => JSON.stringify(db.prepare(
        `SELECT pref_key, pref_value FROM member_preferences WHERE public_key = ? ORDER BY pref_key`).all(pk));
    const setPrefs = (id: { pubKeyHex: string; privateKey: crypto.KeyObject }, preferences: unknown) =>
        signedFetch('POST', '/api/members/preferences', id, { publicKey: id.pubKeyHex, preferences });
    const readPrefs = async (id: { pubKeyHex: string; privateKey: crypto.KeyObject }) =>
        (await signedFetch('GET', `/api/members/preferences?publicKey=${id.pubKeyHex}`, id)).body ?? {};

    const fiftyMadeUp = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`made_up_${i}`, true]));
    const refused: [string, unknown][] = [
        ['holiday mode on', { holiday_mode: true }],
        ['holiday mode on, as text', { holiday_mode: 'true' }],
        ['holiday mode off', { holiday_mode: false }],
        ['holiday mode beside a valid push setting', { notify_chat: false, holiday_mode: true }],
        ['a made-up key', { made_up: true }],
        ['a made-up key beside a valid push setting', { notify_escrow: false, made_up: true }],
        ['fifty made-up keys', fiftyMadeUp],
        ["the reminders' stored key, past their check", { event_reminder_offsets: '[1]' }],
        ['a push setting as text', { notify_chat: 'false' }],
        ['a push setting as null', { notify_chat: null }],
        ['a push setting as a number', { notify_marketplace: 0 }],
        ['a valid reminder choice beside a made-up key', { eventReminderOffsets: [60], made_up: true }],
        ['a list', ['notify_chat']],
        ['text', 'notify_chat'],
    ];
    for (const [what, preferences] of refused) {
        const before = rowsOf(alice.pubKeyHex);
        const res = await setPrefs(alice, preferences);
        const after = rowsOf(alice.pubKeyHex);
        assert(res.status === 400 && typeof res.error === 'string' && res.error.length > 0 && res.body?.success === undefined,
            `preferences with ${what} are refused with 400 and a sentence (got ${res.status} ${res.error ?? JSON.stringify(res.body)})`);
        assert(after === before, `...and nothing is written (${before === after ? 'unchanged' : `${JSON.parse(before).length} rows → ${JSON.parse(after).length}, changed`})`);
        assert(!isOnHoliday(alice.pubKeyHex), `...and alice, with a trade in progress, is not on holiday`);
    }
    const holidayRefusal = await setPrefs(alice, { holiday_mode: true });
    assert(/holiday/i.test(holidayRefusal.error ?? ''), `the holiday refusal says where holiday mode is switched (${holidayRefusal.error})`);
    assert((await readPrefs(alice)).notify_chat === 'true', 'alice\'s chat pushes are still on: the refused bodies saved no part of themselves');

    const pushSettings = { notify_chat: false, notify_marketplace: true, notify_escrow: false, notify_recovery: false };
    const savedToggles = await setPrefs(alice, pushSettings);
    const afterToggles = await readPrefs(alice);
    assert(savedToggles.status === 200 && savedToggles.body?.success === true
        && afterToggles.notify_chat === 'false' && afterToggles.notify_marketplace === 'true'
        && afterToggles.notify_escrow === 'false' && afterToggles.notify_recovery === 'false',
        `the four notification toggles still save (${savedToggles.status}; ${JSON.stringify(afterToggles)})`);
    const savedOffsets = await setPrefs(alice, { eventReminderOffsets: [60, 1440] });
    assert(savedOffsets.status === 200 && JSON.stringify((await readPrefs(alice)).eventReminderOffsets) === '[1440,60]',
        `reminder offsets still save (${savedOffsets.status} ${savedOffsets.error ?? ''})`);
    const savedBoth = await setPrefs(alice, { notify_chat: true, eventReminderOffsets: [] });
    const afterBoth = await readPrefs(alice);
    assert(savedBoth.status === 200 && afterBoth.notify_chat === 'true' && JSON.stringify(afterBoth.eventReminderOffsets) === '[]',
        `a toggle and the offsets save together (${savedBoth.status} ${savedBoth.error ?? ''})`);
    assert(!isOnHoliday(alice.pubKeyHex), 'none of that put alice on holiday');

    // Rows stored under other keys before this rule stay where they are, and no read serves them.
    db.prepare(`INSERT OR REPLACE INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, 'made_up_before', 'x')`).run(alice.pubKeyHex);
    const served = Object.keys(await readPrefs(alice)).sort();
    assert(served.join() === 'eventReminderOffsets,holiday_mode,notify_chat,notify_escrow,notify_marketplace,notify_recovery',
        `a key stored before the rule is not served back (${served.join()})`);
    assert(rowsOf(alice.pubKeyHex).includes('made_up_before'), '...and its row is left in place');

    // ── 6. Holiday mode is the holiday route's alone ───────────────────────────
    const stillBlocked = await signedFetch('POST', '/api/members/holiday', alice, { enabled: true });
    assert(stillBlocked.status === 400 && stillBlocked.body?.openTrades === 1 && !isOnHoliday(alice.pubKeyHex),
        `the holiday route still refuses alice while her trade is open (${stillBlocked.status} ${stillBlocked.error ?? ''})`);

    const carol = makeMember('carol_hol');
    const carolOn = await signedFetch('POST', '/api/members/holiday', carol, { enabled: true });
    assert(carolOn.status === 200 && isOnHoliday(carol.pubKeyHex) && (await readPrefs(carol)).holiday_mode === 'true',
        `with no trades, the holiday route puts carol on holiday and her preferences show it (${carolOn.status} ${carolOn.error ?? ''})`);
    const carolOffByPrefs = await setPrefs(carol, { holiday_mode: false });
    assert(carolOffByPrefs.status === 400 && isOnHoliday(carol.pubKeyHex),
        `preferences can't switch it off either (${carolOffByPrefs.status} ${carolOffByPrefs.error ?? ''})`);
    const carolToggle = await setPrefs(carol, { notify_escrow: false });
    assert(carolToggle.status === 200 && isOnHoliday(carol.pubKeyHex),
        `a push setting saves while she is away and leaves her away (${carolToggle.status} ${carolToggle.error ?? ''})`);
    const carolOff = await signedFetch('POST', '/api/members/holiday', carol, { enabled: false });
    assert(carolOff.status === 200 && !isOnHoliday(carol.pubKeyHex),
        `the holiday route switches it off (${carolOff.status} ${carolOff.error ?? ''})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Members Holiday Mode integration tests PASSED.');
}

main().then(() => process.exit(0)).catch(e => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
