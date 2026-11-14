/**
 * Members' web push (scratch/fable-design/DESIGN-web-notifications-fable.md §2.2, §3 W2 row): a member's own browsers are
 * told every kind their phone is, under the same switches. Over REAL HTTPS through the real signature middleware, with a
 * fake push service (services/web-push.ts _setWebPushFetchForTests) that opens what it is sent with the browser's own keys,
 * and a fake Expo.
 *
 *   1. a member subscribes: 201 { success, pushKey, vapidKey, subId }, one `member` row per browser, sealed; the same
 *      browser again is the same row; DELETE removes it
 *   2. the dispatcher sends Expo AND web for one recipient: one message to the phone, one to the browser, the same notice
 *   3. the payload: the fixed title, the kind's sentence in the browser's language, the tab, the signed notice, nothing else
 *   4. the member's switch gates both: chat off, neither the phone nor the browser; marketplace still both
 *   5. by kind: a chat's topic is its kind (so a browser away wakes to one), TTL a day; a deal's 7 days, no topic; the
 *      account's a day, high
 *   6. an asker's row (kept after the key joined) gets only `join.answered`; "Turn on" with that browser makes it the member's
 *   7. caps: 10 live a key (the stalest goes), 20 new a day (429 `key_rate_limited`)
 *   8. a member no longer a member (removed) loses their browsers at the tidy-up; a key with no request and no membership: 403
 *   9. the route is no longer behind the requests-to-join switch
 *
 * Run: via scripts/run-server-suites.mjs (SERVER_SUITES_ONLY=test-web-push-members)
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, dispatchPushNotification, registerPushToken } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { startP2P } from './p2p.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { _setWebPushFetchForTests, ensureVapidKey } from './services/web-push.js';
import { MEMBER_BROWSER_RULES } from './engine/web-push-subscriptions.js';
import { tidyKnocks } from './engine/knocks.js';
import { featureOffFor } from './routes/profile-feature-gate.js';
import { getProfileSwitches } from './config/node-profile.js';
import { verifyPushNotice, PUSH_NOTICE_KINDS, PUSH_NOTICE_LIFETIME_SECONDS, pushNoticeWords } from '@beanpool/core';
import { wordsIn } from './member-words.js';
import { pushKeyHex } from './engine/push-notices.js';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ FAIL: ${msg}`); process.exitCode = 1; }
}
const show = (v: unknown) => JSON.stringify(v)?.slice(0, 300);
const b64u = (s: string) => Buffer.from(s, 'base64url');

interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}

interface Res { status: number; body: any }
async function call(id: Id | null, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<Res> {
    pruneAuthAttempts(Date.now() + 120_000);
    resetGatewayRateLimit();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = {};
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = signRequest(id.priv, { method, path: path.split('?')[0], timestamp: ts, nonce, body: raw });
        headers[SIGNED_FOR_HEADER] = signedForHost();
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, body: parsed };
}

interface Browser { ecdh: crypto.ECDH; p256dh: string; auth: string; endpoint: string }
function newBrowser(endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomBytes(12).toString('hex')}`): Browser {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    return { ecdh, p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url'), endpoint };
}
const subscription = (b: Browser, lang = 'en') => ({ subscription: { endpoint: b.endpoint, keys: { p256dh: b.p256dh, auth: b.auth } }, lang });

function decrypt(body: Buffer, b: Browser): any {
    const salt = body.subarray(0, 16);
    const idlen = body[20];
    const senderPublic = body.subarray(21, 21 + idlen);
    const record = body.subarray(21 + idlen);
    const auth = b64u(b.auth);
    const hk = (ikm: Buffer, s: Buffer, info: Buffer, n: number) => Buffer.from(crypto.hkdfSync('sha256', ikm, s, info, n));
    const ikm = hk(b.ecdh.computeSecret(senderPublic), auth, Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), b.ecdh.getPublicKey(), senderPublic]), 32);
    const d = crypto.createDecipheriv('aes-128-gcm', hk(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16),
        hk(ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12));
    d.setAuthTag(record.subarray(record.length - 16));
    const plain = Buffer.concat([d.update(record.subarray(0, record.length - 16)), d.final()]);
    return JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString('utf8'));
}

async function main(): Promise<void> {
    console.log("\n=== Members' web push (W2) ===\n");
    if (!process.env.BEANPOOL_DATA_DIR) throw new Error('BEANPOOL_DATA_DIR must be set');

    await initTls();
    initStateEngine();
    await startP2P(0, 0);
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    ensureVapidKey();

    const web: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
    _setWebPushFetchForTests(async (input: any, init?: any) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = String(v);
        web.push({ url: String(input), headers, body: Buffer.from(init?.body ?? []) });
        return new Response(null, { status: 201 });
    });
    const expo: any[] = [];
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = async (input: any, init?: any) => {
        const url = String(input instanceof Request ? input.url : input);
        if (/exp\.host|expo\.dev/.test(new URL(url).hostname)) {
            const batch = JSON.parse(String(init?.body ?? '[]'));
            expo.push(...batch);
            return new Response(JSON.stringify({ data: batch.map(() => ({ status: 'ok', id: crypto.randomUUID() })) }), { status: 200 });
        }
        return realFetch(input, init);
    };
    const settle = () => new Promise((r) => setTimeout(r, 200));
    const clear = () => { web.length = 0; expo.length = 0; };

    const owner = newId('Owner');
    seedGenesisMember(owner.pk, owner.name);
    const addMember = (id: Id) => db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by) VALUES (?, ?, 'active', ?, ?)`)
        .run(id.pk, id.name, new Date().toISOString(), owner.pk);
    const rows = (pk: string) => db.prepare('SELECT * FROM web_push_subscriptions WHERE public_key = ?').all(pk) as any[];

    // ── 1. A member subscribes ──────────────────────────────────────────────────────────────────────────────────────
    const mia = newId('Mia');
    addMember(mia);
    const laptop = newBrowser('https://updates.push.services.mozilla.com/wpush/v2/' + crypto.randomBytes(8).toString('hex'));
    const ok = await call(mia, 'POST', '/api/web-push', subscription(laptop, 'fr'));
    assert(ok.status === 201 && ok.body?.success === true && ok.body?.pushKey === pushKeyHex() && typeof ok.body?.vapidKey === 'string'
        && /^[0-9a-f]{64}$/.test(ok.body?.subId ?? ''), `a member subscribes: 201 { success, pushKey, vapidKey, subId } (${ok.status} ${show(ok.body)})`);
    let miaRows = rows(mia.pk);
    const dump = JSON.stringify(miaRows);
    assert(miaRows.length === 1 && miaRows[0].kind === 'member' && miaRows[0].lang === 'fr' && !dump.includes(laptop.endpoint) && !dump.includes(laptop.p256dh),
        `one member row, sealed, in the browser's language (${show(miaRows.map((r) => [r.kind, r.lang]))})`);
    const again = await call(mia, 'POST', '/api/web-push', subscription(laptop, 'en'));
    miaRows = rows(mia.pk);
    assert(again.status === 201 && again.body.subId === ok.body.subId && miaRows.length === 1 && miaRows[0].lang === 'en',
        `the same browser again (each open) is the same row, its language updated (${miaRows.length}, ${miaRows[0]?.lang})`);
    const phoneBrowser = newBrowser();
    const second = await call(mia, 'POST', '/api/web-push', subscription(phoneBrowser));
    assert(second.status === 201 && rows(mia.pk).length === 2, `a second browser is a second row, as a second phone is (${rows(mia.pk).length})`);
    const gone = await call(mia, 'DELETE', '/api/web-push', { subId: second.body.subId });
    assert(gone.status === 200 && rows(mia.pk).length === 1 && rows(mia.pk)[0].sub_id === ok.body.subId, `DELETE (Turn off, sign-out) removes that browser only (${rows(mia.pk).length})`);

    // ── 2-3. Expo AND web for one recipient ─────────────────────────────────────────────────────────────────────────
    const reg = registerPushToken(mia.pk, `ExponentPushToken[${crypto.randomBytes(8).toString('hex')}]`, 'android', null, null, 'en');
    assert(reg === 'registered', `Mia has a phone too (${reg})`);
    clear();
    const n = dispatchPushNotification([mia.pk], owner.pk, 'Owner', 'hello Mia', { screen: 'chat', conversationId: crypto.randomUUID() }, 'chat', 'chat.message');
    await settle();
    assert(n === 2 && expo.length === 1 && web.length === 1 && web[0].url === laptop.endpoint,
        `one chat line: one message to the phone (Expo) and one to the browser (${n}; expo ${expo.length}, web ${web.length})`);
    let payload: any = null;
    try { payload = decrypt(web[0].body, laptop); } catch { /* checked below */ }
    const words = pushNoticeWords('chat.message', wordsIn('en'));
    assert(payload?.title === 'BeanPool' && payload?.body === words.body && payload?.tab === PUSH_NOTICE_KINDS['chat.message'].tab
        && Object.keys(payload).sort().join() === 'body,data,tab,title', `the payload: fixed title, the kind's sentence, the tab, the notice (${show(payload)})`);
    const check = verifyPushNotice(payload?.data, { recipient: mia.pk, pushKey: pushKeyHex()! });
    assert(check.ok && check.kind === 'chat.message' && JSON.stringify(payload.data) === JSON.stringify(expo[0].data),
        `the browser's notice is the phone's: signed by the node for Mia (${show(check)})`);
    assert(!JSON.stringify(payload).includes('hello Mia') && !JSON.stringify(payload).includes('Owner'), "no sender's words or name in it");

    // ── 5. By kind ──────────────────────────────────────────────────────────────────────────────────────────────────
    assert(web[0].headers.topic === 'chat-message' && web[0].headers.ttl === '86400' && web[0].headers.urgency === 'normal',
        `a chat line: topic = its kind (one waiting message per kind), TTL a day, normal (${show(web[0].headers)})`);
    clear();
    dispatchPushNotification([mia.pk], owner.pk, 'Owner', 'line 2', {}, 'chat', 'chat.message');
    dispatchPushNotification([mia.pk], owner.pk, 'Owner', 'line 3', {}, 'chat', 'chat.message');
    await settle();
    assert(web.length === 2 && web.every((w) => w.headers.topic === 'chat-message'), `two more lines carry the same topic, so the push service keeps only the newest (${web.map((w) => w.headers.topic)})`);
    clear();
    dispatchPushNotification([mia.pk], owner.pk, 'Deal', 'trade', { screen: 'post', postId: crypto.randomUUID() }, 'escrow', 'trade.update');
    await settle();
    assert(web.length === 1 && web[0].headers.ttl === String(PUSH_NOTICE_LIFETIME_SECONDS) && web[0].headers.urgency === 'normal' && !('topic' in web[0].headers),
        `a deal's: the notice's lifetime (7 days), normal, no topic (${show(web[0]?.headers)})`);
    clear();
    dispatchPushNotification([mia.pk], 'SYSTEM_ACTOR', 'Restored', 'x', {}, 'recovery', 'account.restored');
    await settle();
    assert(web.length === 1 && web[0].headers.ttl === '86400' && web[0].headers.urgency === 'high', `the account's: a day, high (${show(web[0]?.headers)})`);

    // ── 4. The member's switch gates both ───────────────────────────────────────────────────────────────────────────
    db.prepare(`INSERT OR REPLACE INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, 'notify_chat', 'false')`).run(mia.pk);
    clear();
    const off = dispatchPushNotification([mia.pk], owner.pk, 'Owner', 'muted', {}, 'chat', 'chat.message');
    await settle();
    assert(off === 0 && expo.length === 0 && web.length === 0, `Direct Messages off: neither the phone nor the browser is told (${off}; ${expo.length}, ${web.length})`);
    clear();
    const mkt = dispatchPushNotification([mia.pk], owner.pk, 'Ask', 'asked', { screen: 'post', postId: crypto.randomUUID() }, 'marketplace', 'market.request');
    await settle();
    assert(mkt === 2 && expo.length === 1 && web.length === 1, `Marketplace Activity still on: both told (${mkt}; ${expo.length}, ${web.length})`);
    db.prepare(`DELETE FROM member_preferences WHERE public_key = ? AND pref_key = 'notify_chat'`).run(mia.pk);

    // ── 6. An asker's row, kept after the key joined ────────────────────────────────────────────────────────────────
    const ana = newId('Ana');
    db.prepare('UPDATE join_requests SET ip_hash = NULL').run();
    const knock = await call(ana, 'POST', '/api/join/knock', { callsign: ana.name, message: 'Hello, may I join?' });
    const anaTab = newBrowser();
    const asked = await call(ana, 'POST', '/api/web-push', subscription(anaTab));
    assert(knock.status === 201 && asked.status === 201 && rows(ana.pk)[0]?.kind === 'asker', `an applicant's browser is an asker row (${knock.status} ${asked.status})`);
    addMember(ana);
    clear();
    dispatchPushNotification([ana.pk], owner.pk, 'Owner', 'welcome', {}, 'chat', 'chat.message');
    await settle();
    assert(web.length === 0, `now a member, that browser asked only for the yes: a chat line does not reach it (${web.length})`);
    const turnOn = await call(ana, 'POST', '/api/web-push', subscription(anaTab));
    const anaRows = rows(ana.pk);
    assert(turnOn.status === 201 && anaRows.length === 1 && anaRows[0].kind === 'member' && anaRows[0].sub_id === asked.body.subId,
        `"Turn on" in that browser makes the same row the member's (${show(anaRows.map((r) => r.kind))})`);
    clear();
    dispatchPushNotification([ana.pk], owner.pk, 'Owner', 'welcome', {}, 'chat', 'chat.message');
    await settle();
    assert(web.length === 1 && web[0].url === anaTab.endpoint, `...and then a chat line reaches it (${web.length})`);

    // ── 7. Caps ─────────────────────────────────────────────────────────────────────────────────────────────────────
    const cal = newId('Cal');
    addMember(cal);
    const subIds: string[] = [];
    for (let i = 0; i < MEMBER_BROWSER_RULES.liveBrowsers + 1; i++) {
        const r = await call(cal, 'POST', '/api/web-push', subscription(newBrowser()));
        subIds.push(r.body?.subId);
        // Each a moment apart, so "stalest" is well defined.
        db.prepare(`UPDATE web_push_subscriptions SET updated_at = ? WHERE sub_id = ?`).run(new Date(Date.now() - (100 - i) * 1000).toISOString(), r.body?.subId);
    }
    const calIds = rows(cal.pk).map((r) => r.sub_id);
    assert(calIds.length === MEMBER_BROWSER_RULES.liveBrowsers && !calIds.includes(subIds[0]) && calIds.includes(subIds[subIds.length - 1]),
        `at most ${MEMBER_BROWSER_RULES.liveBrowsers} browsers a key: the stalest goes (${calIds.length})`);
    let last: Res = { status: 0, body: null };
    for (let i = subIds.length; i < MEMBER_BROWSER_RULES.newBrowsersPerDay + 1; i++) last = await call(cal, 'POST', '/api/web-push', subscription(newBrowser()));
    assert(last.status === 429 && last.body?.code === 'key_rate_limited', `the ${MEMBER_BROWSER_RULES.newBrowsersPerDay + 1}st new browser in a day: 429 key_rate_limited (${last.status} ${show(last.body)})`);
    const known = await call(cal, 'POST', '/api/web-push', subscription(newBrowser()));
    assert(known.status === 429, `...and a new one after it too (${known.status})`);

    // ── 8. Removed, and strangers ───────────────────────────────────────────────────────────────────────────────────
    db.prepare(`UPDATE members SET status = 'pruned' WHERE public_key = ?`).run(cal.pk);
    tidyKnocks();
    assert(rows(cal.pk).length === 0 && rows(mia.pk).length === 1, `a member no longer here loses their browsers at the tidy-up; others keep theirs (${rows(cal.pk).length}, ${rows(mia.pk).length})`);
    const stranger = newId('Stranger');
    const refused = await call(stranger, 'POST', '/api/web-push', subscription(newBrowser()));
    assert(refused.status === 403 && rows(stranger.pk).length === 0, `a key that is no member and asked nothing: 403, nothing kept (${refused.status})`);

    // ── 9. Off the requests-to-join gate ────────────────────────────────────────────────────────────────────────────
    const noKnocks = { ...getProfileSwitches(), knocks: false, invites: false };
    assert(featureOffFor('/api/web-push', noKnocks, 'POST') === null && featureOffFor('/api/web-push/key', noKnocks, 'GET') === null,
        "members' browsers are told whatever the requests-to-join switch says: the route is not behind it");

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
