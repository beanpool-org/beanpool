/**
 * Browser to phone by QR (front doors S9): a member signed in on the web brings the account to the phone app.
 *
 *   browser  POST /api/pair/init { to: 'phone' }        a to-phone session, the binding cookie
 *   phone    POST /api/pair/offer { phonePubHex }        one phone per session; four digits + the phone's own secret
 *   browser  GET  /api/pair/poll                         'confirming'; never the phone's key before the digits
 *   browser  POST /api/pair/confirm { code }             the digits the PHONE shows; three wrong burn the session
 *   browser  GET  /api/pair/poll                         'released' + the phone's key
 *   browser  POST /api/pair/send                         the account sealed to that key, once, with the cookie
 *   phone    POST /api/pair/collect { phoneSecret }      the sealed account, to the phone that offered only
 *   phone    POST /api/pair/saved { phoneSecret, saved } whether it SAVED it; the browser's poll: 'saved' / 'not-saved'
 *
 * Every check here that guards the account has a forced-failure proof in the PR (the check taken out, this suite red).
 * Part 1 goes through the real server and middleware; it spends the 'pairing' bucket (15 a minute per address), so it
 * stays under 15 such calls (14 now). Part 2 drives the relay itself for what needs many sessions or the clock: the burn, the
 * 120 s, the grace, the held-payload cap, and the existing direction left as it was.
 *
 * Run: SERVER_SUITES_ONLY=test-pairing-to-phone TEST_ALL_JOBS=2 node scripts/run-server-suites.mjs
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import {
    createPairingSession,
    createPairInKey,
    encryptPairingPayload,
    openPairingPayloadOnPhone,
    sealPairingPayloadToPhone,
} from '@beanpool/core';
import {
    initPairingSession,
    offerToPhoneSession,
    confirmPairingTransfer,
    sendToPhonePayload,
    collectToPhonePayload,
    reportToPhoneSaved,
    cancelPairingSession,
    pollPairingSession,
    transferPairingPayload,
    clearAllPairingSessions,
    PAIRING_RELAY_LIMITS,
    _pairingRelayCountsForTests,
    _setPairingClockForTests,
} from './pairing-relay.js';

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

const ACCOUNT = { version: 1, publicKey: '11'.repeat(32), mnemonic: ['climb', 'ridge', 'forest', 'creek', 'solar', 'harvest', 'garden', 'timber', 'breeze', 'summit', 'valley', 'meadow'] };
const json = { 'Content-Type': 'application/json' };
const cookieOf = (res: Response) => (res.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).find(c => c.startsWith('bp_pair_')) || '';
const post = (path: string, body: unknown, cookie = '') => fetch(`${BASE}${path}`, { method: 'POST', headers: { ...json, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const poll = (id: string, cookie: string) => fetch(`${BASE}/api/pair/poll?session=${id}`, { headers: cookie ? { cookie } : {} });
const otherDigits = (code: string) => String((Number(code) + 1) % 10_000).padStart(4, '0');
/**
 * A browser's binding cookie, as a real browser keeps it: only as long as its Set-Cookie says (max-age, or expires counted
 * from when the answer came). The relay's clock can be moved here and a cookie's cannot, so `at(ms)` is the cookie this
 * browser would still send `ms` after the init: '' once it has expired.
 */
function jarOf(res: Response) {
    const receivedAt = Date.now();
    const line = (res.headers.getSetCookie?.() || []).find(c => c.startsWith('bp_pair_')) || '';
    const attrs = line.split(';').slice(1).map(a => a.trim());
    const maxAge = attrs.find(a => /^max-age=/i.test(a));
    const expires = attrs.find(a => /^expires=/i.test(a));
    const lifetimeMs = maxAge ? Number(maxAge.slice('max-age='.length)) * 1_000
        : expires ? Date.parse(expires.slice('expires='.length)) - receivedAt
            : Infinity;
    return { lifetimeMs, at: (ms: number) => (ms < lifetimeMs ? line.split(';')[0] : '') };
}

async function throughTheServer(): Promise<void> {
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    // 1. The browser opens the other way. Only the exact word does; anything else is refused, never a quiet session.
    const browser = createPairingSession();
    const init = await post('/api/pair/init', { sessionId: browser.sessionId, desktopPubHex: browser.publicKeyHex, to: 'phone' });
    const cookie = cookieOf(init);
    assert(init.status === 200 && !!cookie, 'init { to: phone } opens a session and sets the binding cookie');
    const typo = createPairingSession();
    const badInit = await post('/api/pair/init', { sessionId: typo.sessionId, desktopPubHex: typo.publicKeyHex, to: 'computer' });
    assert(badInit.status === 400, 'init with any other direction is refused (400)');

    // 2. Before any phone: the browser waits; nobody without the cookie learns anything.
    assert(((await (await poll(browser.sessionId, cookie)).json()) as any).status === 'waiting', 'the browser polls: waiting');
    assert((await poll(browser.sessionId, '')).status === 403, 'a poll without the cookie: 403 wrong-browser');
    const unknown = await post('/api/pair/offer', { sessionId: 'ab'.repeat(16), phonePubHex: createPairInKey().publicKeyHex });
    assert(unknown.status === 410, 'an offer to no session: 410');

    // No phone's account is ever taken into this session (the other direction's step), even while it waits for a phone.
    const pushed = encryptPairingPayload(ACCOUNT, browser.publicKeyHex, browser.sessionId);
    const transfer = await post('/api/pair/transfer', { sessionId: browser.sessionId, ...pushed, confirm: 'four-digits' });
    assert(transfer.status === 400 && ((await transfer.json()) as any).confirmCode === undefined, "a phone's account sent into a waiting to-phone session: 400, no digits, nothing held");
    assert(((await (await poll(browser.sessionId, cookie)).json()) as any).status === 'waiting', 'and the session still waits for its phone');

    // 3. The phone offers its key: four digits and a secret come back to it.
    const phone = createPairInKey();
    const offer = await post('/api/pair/offer', { sessionId: browser.sessionId, phonePubHex: phone.publicKeyHex });
    const offered = (await offer.json()) as any;
    assert(offer.status === 200 && /^\d{4}$/.test(offered.confirmCode) && /^[0-9a-f]{64}$/.test(offered.phoneSecret),
        'the phone offers its key: 200, four digits and a 64-hex secret for it alone');
    assert(typeof offered.endsInMs === 'number' && offered.endsInMs > 0 && offered.endsInMs <= PAIRING_RELAY_LIMITS.ttlMs,
        "and how long the session has left by the relay's clock (the phone's digits end then)");
    assert(offer.headers.get('cache-control') === 'no-store', 'the offer answer is no-store');

    // 4. One phone per session: a second offer (someone else who saw the QR) changes nothing.
    const thief = createPairInKey();
    const second = await post('/api/pair/offer', { sessionId: browser.sessionId, phonePubHex: thief.publicKeyHex });
    assert(second.status === 409 && ((await second.json()) as any).confirmCode === undefined, 'a second phone offering is refused (409), no digits');

    // 6. Before the digits: the browser sees a phone scanned, not its key; it cannot send; the phone waits.
    const before = (await (await poll(browser.sessionId, cookie)).json()) as any;
    assert(before.status === 'confirming' && before.phonePubHex === undefined && before.payload === undefined,
        "the browser polls: confirming, and no phone key before the digits");
    const early = sealPairingPayloadToPhone(ACCOUNT, browser.privateKeyHex, phone.publicKeyHex, browser.sessionId);
    const sendEarly = await post('/api/pair/send', { sessionId: browser.sessionId, ...early }, cookie);
    assert(sendEarly.status === 409, 'the browser sending before the digits: 409, nothing held');
    const wrongPhone = await post('/api/pair/collect', { sessionId: browser.sessionId, phoneSecret: 'cd'.repeat(32) });
    assert(wrongPhone.status === 403 && ((await wrongPhone.json()) as any).status === 'wrong-phone', 'a collect without the phone secret: 403');
    const waiting = (await (await post('/api/pair/collect', { sessionId: browser.sessionId, phoneSecret: offered.phoneSecret })).json()) as any;
    assert(waiting.status === 'confirming' && waiting.ciphertextHex === undefined, 'the phone collects: confirming, nothing yet');

    // 7. The digits, typed in the browser, with its cookie. Without it: nothing changes.
    const noCookie = await post('/api/pair/confirm', { sessionId: browser.sessionId, code: offered.confirmCode });
    assert(noCookie.status === 403, 'the right digits without the cookie: 403, nothing released');
    const wrong = await post('/api/pair/confirm', { sessionId: browser.sessionId, code: otherDigits(offered.confirmCode) }, cookie);
    assert(wrong.status === 400 && ((await wrong.json()) as any).triesLeft === 2, 'wrong digits: 400, two tries left');
    const right = await post('/api/pair/confirm', { sessionId: browser.sessionId, code: offered.confirmCode }, cookie);
    assert(right.status === 200, 'the digits the phone shows: released');
    // A second Confirm (a double click, or a retry of a lost answer) is answered the same, and ends nothing.
    const twice = await post('/api/pair/confirm', { sessionId: browser.sessionId, code: offered.confirmCode }, cookie);
    assert(twice.status === 200 && ((await twice.json()) as any).result === 'released', 'a second confirm of a released session: 200 released, not an end');
    const released = (await (await poll(browser.sessionId, cookie)).json()) as any;
    assert(released.status === 'released' && released.phonePubHex === phone.publicKeyHex, "the browser polls: released, with the offering phone's key");

    // 8. The browser seals to that key and sends, once, with its cookie only.
    const sealed = sealPairingPayloadToPhone(ACCOUNT, browser.privateKeyHex, released.phonePubHex, browser.sessionId);
    const sendNoCookie = await post('/api/pair/send', { sessionId: browser.sessionId, ...sealed });
    assert(sendNoCookie.status === 403, 'a send without the cookie: 403');
    const send = await post('/api/pair/send', { sessionId: browser.sessionId, ...sealed }, cookie);
    assert(send.status === 200, 'the browser sends the sealed account: 200');
    const sendAgain = await post('/api/pair/send', { sessionId: browser.sessionId, ...sealed }, cookie);
    assert(sendAgain.status === 409, 'a second send: 409, the first stands');

    // 9. Only the offering phone collects it, and opens it with the QR's key.
    const got = (await (await post('/api/pair/collect', { sessionId: browser.sessionId, phoneSecret: offered.phoneSecret })).json()) as any;
    const opened = got.status === 'sent' ? openPairingPayloadOnPhone(got.ciphertextHex, got.nonceHex, browser.publicKeyHex, phone.privateKeyHex, browser.sessionId) : null;
    assert(JSON.stringify(opened) === JSON.stringify(ACCOUNT), 'the phone collects and opens the account with the QR key, exactly');
    assert(got.mobilePubHex === undefined && got.payload === undefined, 'the collect names no sender key: the phone uses the QR one');
    const stranger = await post('/api/pair/collect', { sessionId: browser.sessionId, phoneSecret: thief.privateKeyHex });
    assert(stranger.status === 403, 'anyone else collecting after: 403');
    const done = (await (await poll(browser.sessionId, cookie)).json()) as any;
    assert(done.status === 'collected' && done.payload === undefined, 'the browser polls: collected, never a payload');

    // 9b. Collected is not saved. Only the phone that collected, with its secret, says it saved the account.
    const forged = await post('/api/pair/saved', { sessionId: browser.sessionId, phoneSecret: thief.privateKeyHex, saved: true });
    assert(forged.status === 403, "a 'saved' without the phone's secret: 403");
    assert(((await (await poll(browser.sessionId, cookie)).json()) as any).status === 'collected', 'and the browser still hears collected, not saved');
    const saved = await post('/api/pair/saved', { sessionId: browser.sessionId, phoneSecret: offered.phoneSecret, saved: true });
    assert(saved.status === 200 && saved.headers.get('cache-control') === 'no-store', "the phone says it saved the account: 200, no-store");
    assert(((await (await poll(browser.sessionId, cookie)).json()) as any).status === 'saved', 'the browser polls: saved');
    assert((await poll(browser.sessionId, '')).status === 403, 'a poll without the cookie still learns nothing');
    const unsay = await post('/api/pair/saved', { sessionId: browser.sessionId, phoneSecret: offered.phoneSecret, saved: false });
    assert(unsay.status === 409 && ((await (await poll(browser.sessionId, cookie)).json()) as any).status === 'saved', "a different word after it: 409, 'saved' stands");
    const nowhere = await post('/api/pair/saved', { sessionId: 'ef'.repeat(16), phoneSecret: offered.phoneSecret, saved: true });
    assert(nowhere.status === 410, "a 'saved' for no collected session: 410");

    // 10. The other direction stays as it was: an offer into a phone-to-browser session is refused.
    const fromPhone = createPairingSession();
    const fromInit = await post('/api/pair/init', { sessionId: fromPhone.sessionId, desktopPubHex: fromPhone.publicKeyHex });
    const fromCookie = cookieOf(fromInit);
    const fromJar = jarOf(fromInit);
    const cross = await post('/api/pair/offer', { sessionId: fromPhone.sessionId, phonePubHex: phone.publicKeyHex });
    assert(cross.status === 400 && ((await cross.json()) as any).confirmCode === undefined, 'an offer into a phone-to-browser session: 400, no digits');
    assert(((await (await poll(fromPhone.sessionId, fromCookie)).json()) as any).status === 'waiting', 'and that session still waits for its phone');

    // 11. The phone's word reaches its browser for the whole save window, not only for the session's 120 s
    // (doors-s9-fix2, the Opus review of 44aec445: the to-phone cookie lived 150 s from init, so a 'saved' said after
    // that was never heard, and the panel ended at "hasn't said it saved"). The browser here sends its cookie only while
    // its Set-Cookie allows. The phone's offer goes straight to the relay, to keep part 1 under the 'pairing' bucket.
    {
        const L = PAIRING_RELAY_LIMITS;
        const slow = createPairingSession();
        const jar = jarOf(await post('/api/pair/init', { sessionId: slow.sessionId, desktopPubHex: slow.publicKeyHex, to: 'phone' }));
        assert(jar.lifetimeMs >= L.ttlMs + L.saveWindowMs && jar.lifetimeMs <= L.ttlMs + L.saveWindowMs + 31_000,
            `the to-phone cookie lasts the session and the save window after it: 120 s + 5 min + 30 s (${Math.round(jar.lifetimeMs / 1_000)} s)`);
        assert(fromJar.lifetimeMs > L.ttlMs + 28_000 && fromJar.lifetimeMs <= L.ttlMs + 31_000,
            `the phone-to-browser cookie is as before: 120 s + 30 s (${Math.round(fromJar.lifetimeMs / 1_000)} s)`);
        const slowPhone = createPairInKey();
        const o = offerToPhoneSession(slow.sessionId, slowPhone.publicKeyHex);
        if (!o.ok) throw new Error('offer');
        await post('/api/pair/confirm', { sessionId: slow.sessionId, code: o.confirmCode }, jar.at(0));
        const rel = (await (await poll(slow.sessionId, jar.at(0))).json()) as any;
        const sealedSlow = sealPairingPayloadToPhone(ACCOUNT, slow.privateKeyHex, rel.phonePubHex, slow.sessionId);
        assert((await post('/api/pair/send', { sessionId: slow.sessionId, ...sealedSlow }, jar.at(0))).status === 200, 'a slow member: released and sent');
        // The phone collects at 90 s (the session lasts 120 s); the member reads the phone, taps, and the save ends at 151 s.
        _setPairingClockForTests(90_000);
        const got = (await (await post('/api/pair/collect', { sessionId: slow.sessionId, phoneSecret: o.phoneSecret })).json()) as any;
        assert(got.status === 'sent', 'the phone collects at 90 s');
        const late = L.ttlMs + 31_000;
        _setPairingClockForTests(late);
        assert(((await (await poll(slow.sessionId, jar.at(late))).json()) as any).status === 'collected', 'at 151 s the browser, with the cookie it still holds, hears collected');
        const said = await post('/api/pair/saved', { sessionId: slow.sessionId, phoneSecret: o.phoneSecret, saved: true });
        assert(said.status === 200, 'the phone says it saved the account at 151 s: 200');
        assert(((await (await poll(slow.sessionId, jar.at(late))).json()) as any).status === 'saved', 'and its browser polls at 151 s: saved');
        const last = 90_000 + L.saveWindowMs - 1_000;
        _setPairingClockForTests(last);
        assert(((await (await poll(slow.sessionId, jar.at(last))).json()) as any).status === 'saved', "and still saved at the save window's last second (6 min 29 s after the init)");
        assert(((await (await poll(slow.sessionId, '')).json()) as any).status !== 'saved', 'a poll without the cookie learns nothing of it');
        _setPairingClockForTests(0);
    }
}

function inTheRelay(): void {
    clearAllPairingSessions();
    const open = () => {
        const b = createPairingSession();
        const r = initPairingSession(b.sessionId, b.publicKeyHex, 'to-phone');
        return { b, secret: r.secret! };
    };

    // The burn: three wrong digits end it; nothing can be sent; the phone is told.
    {
        const { b, secret } = open();
        const p = createPairInKey();
        const o = offerToPhoneSession(b.sessionId, p.publicKeyHex);
        const code = o.ok ? o.confirmCode : '0000';
        confirmPairingTransfer(b.sessionId, secret, otherDigits(code));
        confirmPairingTransfer(b.sessionId, secret, '12');
        const third = confirmPairingTransfer(b.sessionId, secret, otherDigits(otherDigits(code)));
        assert(third.result === 'burned', 'three wrong tries (one of them two digits) burn the session');
        assert(confirmPairingTransfer(b.sessionId, secret, code).result === 'burned', 'and the right digits after it release nothing');
        const sealed = sealPairingPayloadToPhone(ACCOUNT, b.privateKeyHex, p.publicKeyHex, b.sessionId);
        assert(!sendToPhonePayload(b.sessionId, secret, sealed.nonceHex, sealed.ciphertextHex).ok, 'a burned session takes no send');
        assert(collectToPhonePayload(b.sessionId, o.ok ? o.phoneSecret : '').status === 'burned', 'the phone is told: burned');
        assert(pollPairingSession(b.sessionId, secret).phonePubHex === undefined, "the browser never learns the phone's key");
    }

    // An offer's key is 64 hex, or nothing changes: the session still waits for a phone.
    {
        const { b, secret } = open();
        for (const bad of ['zz'.repeat(32), 'ab'.repeat(31), 'ab'.repeat(33), 42, null]) {
            const r = offerToPhoneSession(b.sessionId, bad);
            assert(!r.ok && r.error === 'bad-key', `an offer with the key ${JSON.stringify(bad)?.slice(0, 12)}… is refused`);
        }
        assert(pollPairingSession(b.sessionId, secret).status === 'waiting', 'and the session still waits for a phone');
    }

    // The 120 s: an offer, a confirm, a send or a collect past it finds nothing.
    {
        const { b } = open();
        const p = createPairInKey();
        _setPairingClockForTests(PAIRING_RELAY_LIMITS.ttlMs);
        assert(!offerToPhoneSession(b.sessionId, p.publicKeyHex).ok, 'an offer at 120 s: expired');
        _setPairingClockForTests(0);
    }
    {
        const { b, secret } = open();
        const p = createPairInKey();
        const o = offerToPhoneSession(b.sessionId, p.publicKeyHex);
        _setPairingClockForTests(PAIRING_RELAY_LIMITS.ttlMs);
        assert(confirmPairingTransfer(b.sessionId, secret, o.ok ? o.confirmCode : '').result === 'expired', 'the digits at 120 s: expired');
        _setPairingClockForTests(0);
    }

    // The grace: a collected account is kept 15 s for a retry, never past the 120 s, then gone.
    {
        const { b, secret } = open();
        const p = createPairInKey();
        const o = offerToPhoneSession(b.sessionId, p.publicKeyHex);
        if (!o.ok) throw new Error('offer');
        confirmPairingTransfer(b.sessionId, secret, o.confirmCode);
        const sealed = sealPairingPayloadToPhone(ACCOUNT, b.privateKeyHex, p.publicKeyHex, b.sessionId);
        assert(sendToPhonePayload(b.sessionId, secret, sealed.nonceHex, sealed.ciphertextHex).ok, 'released, the browser sends');
        assert(_pairingRelayCountsForTests().held === 1, 'the sealed account is held: one slot');
        assert(collectToPhonePayload(b.sessionId, o.phoneSecret).status === 'sent', 'the phone collects');
        assert(_pairingRelayCountsForTests().held === 0, 'its slot is free at once');
        _setPairingClockForTests(PAIRING_RELAY_LIMITS.graceMs - 1_000);
        assert(collectToPhonePayload(b.sessionId, o.phoneSecret).status === 'sent', 'a retry inside the grace gets it again');
        _setPairingClockForTests(PAIRING_RELAY_LIMITS.graceMs * 2 + 1_000);
        assert(collectToPhonePayload(b.sessionId, o.phoneSecret).status === 'expired', 'after the grace: gone');
        _setPairingClockForTests(0);
    }

    // The held cap: past MAX_HELD_PAYLOADS a send is refused 'busy', and the session stays released for a retry.
    {
        clearAllPairingSessions();
        const p = createPairInKey();
        let lastSecret = '', lastId = '', lastB = createPairingSession();
        for (let i = 0; i <= PAIRING_RELAY_LIMITS.heldPayloads; i++) {
            const { b, secret } = open();
            const o = offerToPhoneSession(b.sessionId, p.publicKeyHex);
            if (!o.ok) throw new Error('offer');
            confirmPairingTransfer(b.sessionId, secret, o.confirmCode);
            lastSecret = secret; lastId = b.sessionId; lastB = b;
            if (i < PAIRING_RELAY_LIMITS.heldPayloads) sendToPhonePayload(b.sessionId, secret, '00'.repeat(24), 'ab'.repeat(16));
        }
        const sealed = sealPairingPayloadToPhone(ACCOUNT, lastB.privateKeyHex, p.publicKeyHex, lastId);
        const busy = sendToPhonePayload(lastId, lastSecret, sealed.nonceHex, sealed.ciphertextHex);
        assert(!busy.ok && busy.error === 'busy', `the ${PAIRING_RELAY_LIMITS.heldPayloads + 1}th held account is refused busy`);
        assert(pollPairingSession(lastId, lastSecret).status === 'released', 'and that session stays released for a retry');
        clearAllPairingSessions();
    }

    // The seal's size: past 4,096 hex it is refused (the room free, so only the size refuses it), and the session stays
    // released for one that fits.
    {
        const { b, secret } = open();
        const p = createPairInKey();
        const o = offerToPhoneSession(b.sessionId, p.publicKeyHex);
        if (!o.ok) throw new Error('offer');
        confirmPairingTransfer(b.sessionId, secret, o.confirmCode);
        const big = sendToPhonePayload(b.sessionId, secret, '00'.repeat(24), 'f'.repeat(PAIRING_RELAY_LIMITS.ciphertextHex + 2));
        assert(!big.ok && big.error === 'bad-payload' && _pairingRelayCountsForTests().held === 0, 'a seal past 4,096 hex is refused, nothing held');
        assert(sendToPhonePayload(b.sessionId, secret, '00'.repeat(24), 'f'.repeat(PAIRING_RELAY_LIMITS.ciphertextHex)).ok, 'and one of 4,096 hex is taken');
        clearAllPairingSessions();
    }

    // Collected is not saved: the phone's word, kept past the session's end for SAVE_WINDOW_MS, for its browser only.
    const collectedOne = () => {
        const { b, secret } = open();
        const p = createPairInKey();
        const o = offerToPhoneSession(b.sessionId, p.publicKeyHex);
        if (!o.ok) throw new Error('offer');
        confirmPairingTransfer(b.sessionId, secret, o.confirmCode);
        const sealed = sealPairingPayloadToPhone(ACCOUNT, b.privateKeyHex, p.publicKeyHex, b.sessionId);
        sendToPhonePayload(b.sessionId, secret, sealed.nonceHex, sealed.ciphertextHex);
        return { b, secret, phoneSecret: o.phoneSecret };
    };
    {
        const { b, secret, phoneSecret } = collectedOne();
        assert(pollPairingSession(b.sessionId, secret).status === 'sent', 'sent, not yet collected: the browser hears sent');
        assert(!reportToPhoneSaved(b.sessionId, phoneSecret, true).ok, "a 'saved' before the phone collected changes nothing");
        assert(collectToPhonePayload(b.sessionId, phoneSecret).status === 'sent', 'the phone collects');
        assert(pollPairingSession(b.sessionId, secret).status === 'collected', 'collected: the browser hears collected, not saved');
        _setPairingClockForTests(PAIRING_RELAY_LIMITS.ttlMs + 1_000);
        assert(collectToPhonePayload(b.sessionId, phoneSecret).status === 'expired', 'past the 120 s the session and its seal are gone');
        assert(pollPairingSession(b.sessionId, secret).status === 'collected', 'and its browser still hears collected (the member may read the phone slowly)');
        assert(pollPairingSession(b.sessionId, 'ab'.repeat(32)).status === 'expired', 'any other browser hears nothing of it');
        const r = reportToPhoneSaved(b.sessionId, 'cd'.repeat(32), true);
        assert(!r.ok && r.error === 'wrong-phone', "a 'saved' with another secret: wrong-phone");
        assert(!reportToPhoneSaved(b.sessionId, phoneSecret, 'yes').ok, "a report that isn't true or false changes nothing");
        assert(reportToPhoneSaved(b.sessionId, phoneSecret, false).ok, 'the phone says it did not save it');
        assert(pollPairingSession(b.sessionId, secret).status === 'not-saved', 'its browser hears not-saved');
        const late = reportToPhoneSaved(b.sessionId, phoneSecret, true);
        assert(!late.ok && late.error === 'already' && pollPairingSession(b.sessionId, secret).status === 'not-saved', 'the first word stands');
        assert(reportToPhoneSaved(b.sessionId, phoneSecret, false).ok, 'the same word again (a lost answer) is fine');
        _setPairingClockForTests(PAIRING_RELAY_LIMITS.saveWindowMs + 1_000);
        assert(pollPairingSession(b.sessionId, secret).status === 'expired', 'past the save window: nothing is kept');
        _setPairingClockForTests(0);
    }
    {
        // Anyone may cancel a session; after the collect that leaves the phone's word to reach its browser.
        const { b, secret, phoneSecret } = collectedOne();
        collectToPhonePayload(b.sessionId, phoneSecret);
        cancelPairingSession(b.sessionId);
        assert(pollPairingSession(b.sessionId, secret).status === 'collected', 'a cancel after the collect: its browser still waits for the phone');
        assert(reportToPhoneSaved(b.sessionId, phoneSecret, true).ok && pollPairingSession(b.sessionId, secret).status === 'saved', 'and hears saved when the phone says so');
        // Someone who saw the QR opens a session with the same id: the browser still hears its own phone.
        const again = initPairingSession(b.sessionId, createPairingSession().publicKeyHex, 'to-phone');
        assert(pollPairingSession(b.sessionId, secret).status === 'saved', 'a new session on the same id changes nothing for the first browser');
        assert(pollPairingSession(b.sessionId, again.secret).status === 'waiting', 'and the newcomer sees only its own session');
        _setPairingClockForTests(PAIRING_RELAY_LIMITS.saveWindowMs + 1_000);
        assert(!reportToPhoneSaved(b.sessionId, phoneSecret, true).ok, "a 'saved' past the window: expired");
        _setPairingClockForTests(0);
        clearAllPairingSessions();
        assert(_pairingRelayCountsForTests().outcomes === 0, 'clearing the relay clears the phones\' words too');
    }

    // A second Confirm on a released session: the same answer, no try spent, nothing ended or burned.
    {
        const { b, secret } = open();
        const p = createPairInKey();
        const o = offerToPhoneSession(b.sessionId, p.publicKeyHex);
        if (!o.ok) throw new Error('offer');
        assert(confirmPairingTransfer(b.sessionId, secret, o.confirmCode).result === 'released', 'the digits: released');
        for (let i = 0; i < 4; i++) confirmPairingTransfer(b.sessionId, secret, otherDigits(o.confirmCode));
        const again = confirmPairingTransfer(b.sessionId, secret, o.confirmCode);
        assert(again.result === 'released' && pollPairingSession(b.sessionId, secret).status === 'released', 'four more confirms, any digits: still released, never burned');
        assert(confirmPairingTransfer(b.sessionId, 'ab'.repeat(32), o.confirmCode).result === 'wrong-browser', 'another browser still gets wrong-browser');
        const sealed = sealPairingPayloadToPhone(ACCOUNT, b.privateKeyHex, p.publicKeyHex, b.sessionId);
        assert(sendToPhonePayload(b.sessionId, secret, sealed.nonceHex, sealed.ciphertextHex).ok, 'and the browser still sends');
        assert(confirmPairingTransfer(b.sessionId, secret, o.confirmCode).result === 'released', 'a confirm after the send: released, nothing changed');
        clearAllPairingSessions();
    }

    // The existing direction, unchanged: its session takes no offer, and its transfer and digits work as before.
    {
        const b = createPairingSession();
        const r = initPairingSession(b.sessionId, b.publicKeyHex);
        const p = createPairInKey();
        const cross = offerToPhoneSession(b.sessionId, p.publicKeyHex);
        assert(!cross.ok && cross.error === 'not-to-phone', 'a phone-to-browser session refuses an offer');
        const enc = encryptPairingPayload(ACCOUNT, b.publicKeyHex, b.sessionId);
        const t = transferPairingPayload(b.sessionId, enc.mobilePubHex, enc.nonceHex, enc.ciphertextHex);
        assert(t.ok && !!t.confirmCode, 'and still takes its phone\'s account, with four digits');
        assert(sendToPhonePayload(b.sessionId, r.secret, enc.nonceHex, enc.ciphertextHex).ok === false, 'a browser send into it is refused');
        confirmPairingTransfer(b.sessionId, r.secret, t.confirmCode);
        assert(confirmPairingTransfer(b.sessionId, r.secret, t.confirmCode).result === 'not-confirming', 'a second confirm there answers as before (not-confirming)');
        assert(pollPairingSession(b.sessionId, r.secret).payload?.ciphertextHex === enc.ciphertextHex, 'its browser collects it as before');
        assert(collectToPhonePayload(b.sessionId, 'ab'.repeat(32)).status === 'expired', 'and a phone collect there finds nothing');
        clearAllPairingSessions();
    }
}

async function main() {
    console.log('🧪 Pairing browser → phone (S9)\n');
    await throughTheServer();
    inTheRelay();
    console.log(`\nPairing to phone: ${passed}/${run} assertions passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
}

main().then(() => process.exit(0)).catch((err) => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});
