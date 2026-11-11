/**
 * "Tell me when they answer" (scratch/fable-design/DESIGN-web-notifications-fable.md §2.2-§2.4, slice W1): web push with the
 * node's own key, for a browser that asked to join. Over REAL HTTPS through the real signature middleware, with a fake push
 * service in place of Google's, Mozilla's, Apple's and Microsoft's (services/web-push.ts _setWebPushFetchForTests), which
 * decrypts what it is sent with the browser's own keys, as a browser would.
 *
 *   1. RFC 8291 §5's example, byte for byte; a message to a browser's keys opens with the browser's private key
 *   2. the VAPID header: ES256 by data/vapid.key, aud = the endpoint's origin, exp within 24 hours, k = the public key
 *   3. data/vapid.key: made once by the node, PEM, 0600, the same key after; in the take-over bundle's files
 *   4. only browser push services: http, another host, a port, credentials are refused
 *   5. the routes: the key is public; a subscription needs a signature (401), a key with an open request (403 for none,
 *      for a member, for an approved one), a push service's endpoint and browser keys (400)
 *   6. one asker row per key, sealed (no endpoint or key in the clear in the database); DELETE removes it
 *   7. cancel and decline delete it; a declined key in its block is answered as if open and nothing is kept; a lapse
 *      deletes it at the tidy-up
 *   8. approve sends `join.answered`: TTL = the invite's remaining seconds (capped at the push services' 28 days), normal
 *      urgency, topic `join`; the payload is the fixed title and sentence and the signed notice for the asker, nothing else
 *   9. the join keeps the row; a push service's 404 or 410 deletes it; its 403 is logged once
 *
 * Run: via scripts/run-server-suites.mjs (SERVER_SUITES_ONLY=test-web-push)
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import fs from 'node:fs';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { startP2P } from './p2p.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import {
    encryptPushPayload, vapidAuthorization, ensureVapidKey, readVapidKey, vapidKeyPath, isPushServiceEndpoint, pushTtl,
    _setWebPushFetchForTests, _webPushQueueForTests, sendWebPush, VAPID_KEY_FILE, WEB_PUSH_RULES,
} from './services/web-push.js';
import { BUNDLED_FILES } from './services/takeover-envelope.js';
import { tidyKnocks, joinAnsweredTtl } from './engine/knocks.js';
import { verifyPushNotice, PUSH_NOTICE_KINDS } from '@beanpool/core';
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
const DAY_MS = 86_400_000;

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

/** A browser: its push keys, its endpoint at a push service, and what it can open. */
interface Browser { ecdh: crypto.ECDH; p256dh: string; auth: string; endpoint: string }
function newBrowser(endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomBytes(12).toString('hex')}`): Browser {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    return { ecdh, p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url'), endpoint };
}
const subscription = (b: Browser) => ({ subscription: { endpoint: b.endpoint, keys: { p256dh: b.p256dh, auth: b.auth } }, lang: 'en' });

/** What a browser does with a push body (RFC 8291 §3, the receiving side). */
function decrypt(body: Buffer, ua: { ecdh: crypto.ECDH; auth: Buffer }): Buffer {
    const salt = body.subarray(0, 16);
    const idlen = body[20];
    const senderPublic = body.subarray(21, 21 + idlen);
    const record = body.subarray(21 + idlen);
    const secret = ua.ecdh.computeSecret(senderPublic);
    const hk = (ikm: Buffer, s: Buffer, info: string | Buffer, n: number) => Buffer.from(crypto.hkdfSync('sha256', ikm, s, info, n));
    const ikm = hk(secret, ua.auth, Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), ua.ecdh.getPublicKey(), senderPublic]), 32);
    const cek = hk(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16);
    const nonce = hk(ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12);
    const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
    d.setAuthTag(record.subarray(record.length - 16));
    const plain = Buffer.concat([d.update(record.subarray(0, record.length - 16)), d.final()]);
    let end = plain.length - 1;
    while (end >= 0 && plain[end] === 0) end--;
    if (plain[end] !== 2) throw new Error('not the last record');
    return plain.subarray(0, end);
}

/** Verify an ES256 JWT against a raw P-256 public key; returns the claims or null. */
function jwtClaims(token: string, publicKeyText: string): any {
    const [h, c, s] = token.split('.');
    const raw = b64u(publicKeyText);
    const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
    const ok = crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, b64u(s));
    return ok ? JSON.parse(b64u(c).toString('utf8')) : null;
}

async function main(): Promise<void> {
    console.log('\n=== Tell me when they answer (web push W1) ===\n');
    if (!process.env.BEANPOOL_DATA_DIR) throw new Error('BEANPOOL_DATA_DIR must be set');

    // ── 1. RFC 8291 §5 ──────────────────────────────────────────────────────────────────────────────────────────────
    const expected = 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' + 'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT'
        + 'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN';
    const vector = encryptPushPayload(b64u('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24'), {
        p256dh: b64u('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'),
        auth: b64u('BTBZMqHH6r4Tts7J_aSIgg'),
    }, { senderPrivate: b64u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'), salt: b64u('DGv6ra1nlYgDCS1FRnbzlw') });
    assert(vector.toString('base64url') === expected, `RFC 8291 §5: the example message, byte for byte (${vector.toString('base64url').slice(0, 40)}…)`);
    const uaPrivate = crypto.createECDH('prime256v1');
    uaPrivate.setPrivateKey(b64u('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94'));
    assert(decrypt(vector, { ecdh: uaPrivate, auth: b64u('BTBZMqHH6r4Tts7J_aSIgg') }).toString() === 'When I grow up, I want to be a watermelon',
        "...and the browser's side opens it to the example's plaintext");
    const someone = newBrowser();
    const fresh = encryptPushPayload(Buffer.from('hello'), { p256dh: b64u(someone.p256dh), auth: b64u(someone.auth) });
    const again = encryptPushPayload(Buffer.from('hello'), { p256dh: b64u(someone.p256dh), auth: b64u(someone.auth) });
    assert(decrypt(fresh, { ecdh: someone.ecdh, auth: b64u(someone.auth) }).toString() === 'hello' && !fresh.subarray(0, 16).equals(again.subarray(0, 16))
        && !fresh.subarray(21, 86).equals(again.subarray(21, 86)), 'a real message: a new salt and key pair each time, and the browser opens it');

    // ── 3. The node's key ───────────────────────────────────────────────────────────────────────────────────────────
    assert(readVapidKey() === null && !fs.existsSync(vapidKeyPath()), 'a new node has no data/vapid.key until it needs one');
    const made = ensureVapidKey();
    const mode = fs.statSync(vapidKeyPath()).mode & 0o777;
    assert(mode === 0o600 && /^-----BEGIN PRIVATE KEY-----/.test(fs.readFileSync(vapidKeyPath(), 'utf8')), `made: PKCS#8 PEM, 0600 (${mode.toString(8)})`);
    assert(made.publicKey.length === 65 && made.publicKey[0] === 4 && ensureVapidKey().publicKeyText === made.publicKeyText, '...a P-256 key, the same one after');
    assert((BUNDLED_FILES as readonly string[]).includes(VAPID_KEY_FILE), "it travels in the take-over bundle's files (a take-over, a sealed backup)");

    // ── 2. VAPID ────────────────────────────────────────────────────────────────────────────────────────────────────
    const now = Math.floor(Date.now() / 1000);
    const authz = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', 'https://test.example', made, now);
    const m = /^vapid t=([^,]+), k=([A-Za-z0-9_-]+)$/.exec(authz);
    const claims = m ? jwtClaims(m[1], m[2]) : null;
    assert(!!m && m[2] === made.publicKeyText && claims?.aud === 'https://fcm.googleapis.com' && claims?.sub === 'https://test.example'
        && claims.exp > now && claims.exp - now <= 24 * 3600, `the VAPID header verifies by the node's key, aud the endpoint's origin, exp within a day (${show(claims)})`);

    // ── 4. Push services only ───────────────────────────────────────────────────────────────────────────────────────
    const good = ['https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/x',
        'https://wns2-par02p.notify.windows.com/w/?token=x'];
    const bad = ['http://fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://u:p@fcm.googleapis.com/x', 'https://localhost/x',
        'https://10.0.0.1/x', 'https://evil.example/fcm.googleapis.com', 'https://fcm.googleapis.com.evil.example/x', 'https://notify.windows.com.evil/x', 42];
    assert(good.every(isPushServiceEndpoint) && !bad.some(isPushServiceEndpoint), 'only the browsers\' push services, over https on 443');
    assert(pushTtl(30 * 86400) === WEB_PUSH_RULES.maxTtlSeconds && pushTtl(-5) === 0 && pushTtl(3600.7) === 3600, 'TTL in whole seconds, 0 to 28 days');
    assert(joinAnsweredTtl(Date.now() + 2 * DAY_MS, Date.now()) === 2 * 86400 && joinAnsweredTtl(Date.now() + 30 * DAY_MS, Date.now()) === WEB_PUSH_RULES.maxTtlSeconds
        && joinAnsweredTtl(Date.now() - 1000, Date.now()) === 0, "join.answered's TTL: the invite's remaining seconds, capped by the push services");

    // ── The server ──────────────────────────────────────────────────────────────────────────────────────────────────
    await initTls();
    initStateEngine();
    await startP2P(0, 0);
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const sent: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
    const answers = new Map<string, number>();
    _setWebPushFetchForTests(async (input: any, init?: any) => {
        const url = String(input);
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = String(v);
        sent.push({ url, headers, body: Buffer.from(init?.body ?? []) });
        return new Response(null, { status: answers.get(url) ?? 201 });
    });
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = async (input: any, init?: any) => {
        const url = String(input instanceof Request ? input.url : input);
        if (/exp\.host|expo\.dev/.test(new URL(url).hostname)) return new Response(JSON.stringify({ data: [] }), { status: 200 });
        return realFetch(input, init);
    };
    const settle = () => new Promise((r) => setTimeout(r, 150));

    const owner = newId('Owner');
    seedGenesisMember(owner.pk, owner.name);
    const rows = (pk: string) => db.prepare('SELECT * FROM web_push_subscriptions WHERE public_key = ?').all(pk) as any[];
    const knockOf = async (id: Id) => {
        // Every knock here comes from one address: its 3-a-day limit is not what this suite checks.
        db.prepare('UPDATE join_requests SET ip_hash = NULL').run();
        const r = await call(id, 'POST', '/api/join/knock', { callsign: id.name, message: 'Hello, may I join?' });
        if (r.status !== 201) throw new Error(`knock ${r.status} ${show(r.body)}`);
        const list = await call(owner, 'GET', '/api/join/knocks?limit=50');
        return (list.body.knocks as any[]).find((k) => k.pubkey === id.pk).id as string;
    };

    // ── 5. The routes ───────────────────────────────────────────────────────────────────────────────────────────────
    const keyRes = await call(null, 'GET', '/api/web-push/key');
    assert(keyRes.status === 200 && keyRes.body?.vapidKey === made.publicKeyText, `GET /api/web-push/key: the node's public key, to anyone (${keyRes.status})`);
    const ana = newId('Ana');
    const anaPhone = newBrowser();
    const unsigned = await call(null, 'POST', '/api/web-push', subscription(anaPhone));
    assert(unsigned.status === 401, `an unsigned subscription: 401 (${unsigned.status})`);
    const noKnock = await call(ana, 'POST', '/api/web-push', subscription(anaPhone));
    assert(noKnock.status === 403 && rows(ana.pk).length === 0, `a key with no open request: 403, nothing kept (${noKnock.status} ${show(noKnock.body)})`);
    const asMember = await call(owner, 'POST', '/api/web-push', subscription(newBrowser()));
    assert(asMember.status === 403 && rows(owner.pk).length === 0, `a member: 403 in W1, nothing kept (${asMember.status})`);

    const anaKnock = await knockOf(ana);
    for (const [what, body] of [
        ['an endpoint that is no push service', subscription(newBrowser('https://evil.example/push'))],
        ['an http endpoint', subscription(newBrowser('http://fcm.googleapis.com/fcm/send/x'))],
        ['a p256dh that is no P-256 point', { subscription: { endpoint: anaPhone.endpoint, keys: { p256dh: 'AAAA', auth: anaPhone.auth } } }],
        ['an auth of the wrong size', { subscription: { endpoint: anaPhone.endpoint, keys: { p256dh: anaPhone.p256dh, auth: 'AAAA' } } }],
        ['no subscription', {}],
    ] as const) {
        const r = await call(ana, 'POST', '/api/web-push', body);
        assert(r.status === 400 && rows(ana.pk).length === 0, `${what}: 400, nothing kept (${r.status} ${show(r.body)})`);
    }

    // ── 6. One asker row per key, sealed ────────────────────────────────────────────────────────────────────────────
    const ok = await call(ana, 'POST', '/api/web-push', subscription(anaPhone));
    assert(ok.status === 201 && ok.body?.success === true && ok.body?.vapidKey === made.publicKeyText && ok.body?.pushKey === pushKeyHex()
        && /^[0-9a-f]{64}$/.test(ok.body?.subId ?? ''), `a key with an open request subscribes: 201 { success, pushKey, vapidKey, subId } (${ok.status} ${show(ok.body)})`);
    let anaRows = rows(ana.pk);
    const dump = JSON.stringify(anaRows);
    assert(anaRows.length === 1 && anaRows[0].kind === 'asker' && anaRows[0].sub_id === ok.body.subId && !dump.includes(anaPhone.endpoint)
        && !dump.includes(anaPhone.p256dh) && !dump.includes(anaPhone.auth), `one asker row, sealed: no endpoint or browser key in the clear (${show(anaRows.map((r) => r.kind))})`);
    const anaLaptop = newBrowser('https://updates.push.services.mozilla.com/wpush/v2/' + crypto.randomBytes(8).toString('hex'));
    const second = await call(ana, 'POST', '/api/web-push', subscription(anaLaptop));
    anaRows = rows(ana.pk);
    assert(second.status === 201 && anaRows.length === 1 && anaRows[0].sub_id === second.body.subId && second.body.subId !== ok.body.subId,
        `another browser for the same key replaces it: still one row (${anaRows.length})`);
    const del = await call(ana, 'DELETE', '/api/web-push', { subId: second.body.subId });
    assert(del.status === 200 && rows(ana.pk).length === 0, `DELETE removes the signer's own row (${del.status} ${show(del.body)})`);
    const ben = newId('Ben');
    await call(ana, 'POST', '/api/web-push', subscription(anaLaptop));
    const notHers = await call(ben, 'DELETE', '/api/web-push', { subId: rows(ana.pk)[0]?.sub_id });
    assert(rows(ana.pk).length === 1 && notHers.status !== 500, `...and never another key's (${notHers.status})`);

    // ── 7. Cancel, decline, lapse ───────────────────────────────────────────────────────────────────────────────────
    const cat = newId('Cat');
    await knockOf(cat);
    await call(cat, 'POST', '/api/web-push', subscription(newBrowser()));
    const cancelled = await call(cat, 'POST', '/api/join/knock/cancel', {});
    assert(cancelled.status === 200 && rows(cat.pk).length === 0, `cancel my request deletes the row (${cancelled.status} ${rows(cat.pk).length})`);

    const dan = newId('Dan');
    const danKnock = await knockOf(dan);
    await call(dan, 'POST', '/api/web-push', subscription(newBrowser()));
    const declined = await call(owner, 'POST', `/api/join/knocks/${danKnock}/decline`, {});
    assert(declined.status === 200 && rows(dan.pk).length === 0, `"Not now" deletes the row (${declined.status} ${rows(dan.pk).length})`);
    const afterNo = await call(dan, 'POST', '/api/web-push', subscription(newBrowser()));
    assert(afterNo.status === 201 && afterNo.body?.success === true && typeof afterNo.body?.subId === 'string' && rows(dan.pk).length === 0,
        `a declined key in its block is answered as if its request were open (a no is never a message), and nothing is kept (${afterNo.status})`);

    const eve = newId('Eve');
    const eveKnock = await knockOf(eve);
    await call(eve, 'POST', '/api/web-push', subscription(newBrowser()));
    db.prepare('UPDATE join_requests SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 31 * DAY_MS).toISOString(), eveKnock);
    tidyKnocks();
    assert(rows(eve.pk).length === 0 && rows(ana.pk).length === 1, `a lapsed request's row goes at the tidy-up; an open one's stays (${rows(eve.pk).length}, ${rows(ana.pk).length})`);

    // ── 8. Approve sends join.answered ──────────────────────────────────────────────────────────────────────────────
    sent.length = 0;
    const yes = await call(owner, 'POST', `/api/join/knocks/${anaKnock}/approve`, {});
    await settle();
    assert(yes.status === 200 && sent.length === 1 && sent[0].url === anaLaptop.endpoint, `approve sends one push, to the asker's browser (${yes.status} ${sent.length})`);
    const push = sent[0];
    const remaining = Math.floor((Date.parse(yes.body?.invite?.expiresAt) - Date.now()) / 1000);
    const ttl = Number(push?.headers.ttl);
    assert(ttl === Math.min(remaining, WEB_PUSH_RULES.maxTtlSeconds) || Math.abs(ttl - Math.min(remaining, WEB_PUSH_RULES.maxTtlSeconds)) <= 5,
        `TTL = the invite's remaining seconds, capped at 28 days (${push?.headers.ttl}, remaining ${remaining})`);
    assert(push?.headers.urgency === 'normal' && push?.headers.topic === 'join' && push?.headers['content-encoding'] === 'aes128gcm',
        `urgency normal, topic join, aes128gcm (${show(push?.headers)})`);
    const pm = /^vapid t=([^,]+), k=([A-Za-z0-9_-]+)$/.exec(push?.headers.authorization ?? '');
    assert(!!pm && pm[2] === made.publicKeyText && jwtClaims(pm[1], pm[2])?.aud === 'https://updates.push.services.mozilla.com',
        "signed with the node's own key for the endpoint's origin");
    let payload: any = null;
    try { payload = JSON.parse(decrypt(push.body, { ecdh: anaLaptop.ecdh, auth: b64u(anaLaptop.auth) }).toString('utf8')); } catch { /* checked below */ }
    assert(payload?.title === 'BeanPool' && payload?.body === PUSH_NOTICE_KINDS['join.answered'].body && payload?.tab === 'home'
        && Object.keys(payload).sort().join() === 'body,data,tab,title', `the payload: the fixed title and sentence, the tab, the notice, nothing else (${show(payload)})`);
    const check = verifyPushNotice(payload?.data, { recipient: ana.pk, pushKey: pushKeyHex()! });
    assert(check.ok && check.kind === 'join.answered', `the notice is signed by the node for the asker's key (${show(check)})`);
    assert(!verifyPushNotice(payload?.data, { recipient: ben.pk, pushKey: pushKeyHex()! }).ok, '...and fails for any other key');
    const text = JSON.stringify(payload);
    assert(!text.includes(ana.name) && !text.includes(yes.body?.invite?.code) && !text.includes(ana.pk) && !text.includes('Owner'),
        'no name, key or invite code in it');
    assert(push.body.length < 4096, `under the push services' 4 KB (${push.body.length} bytes)`);

    // ── 9. The join keeps it; 404/410 delete; 403 logged once ───────────────────────────────────────────────────────
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code) VALUES (?, ?, 'active', ?, ?, ?)`)
        .run(ana.pk, ana.name, new Date().toISOString(), owner.pk, yes.body?.invite?.code);
    tidyKnocks();
    assert(rows(ana.pk).length === 1, `the key joins: its row stays (same key, now a member) (${rows(ana.pk).length})`);

    for (const status of [404, 410]) {
        const fay = newId(`Fay${status}`);
        const fayKnock = await knockOf(fay);
        const fayBrowser = newBrowser();
        answers.set(fayBrowser.endpoint, status);
        await call(fay, 'POST', '/api/web-push', subscription(fayBrowser));
        sent.length = 0;
        await call(owner, 'POST', `/api/join/knocks/${fayKnock}/approve`, {});
        await settle();
        assert(sent.length === 1 && rows(fay.pk).length === 0, `the push service says ${status}: the row is deleted (${sent.length}, ${rows(fay.pk).length})`);
    }
    const warned: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(' ')); };
    try {
        for (const name of ['Gus', 'Hal']) {
            const id = newId(name);
            const k = await knockOf(id);
            const b = newBrowser();
            answers.set(b.endpoint, 403);
            await call(id, 'POST', '/api/web-push', subscription(b));
            await call(owner, 'POST', `/api/join/knocks/${k}/approve`, {});
            await settle();
        }
    } finally {
        console.warn = realWarn;
    }
    assert(warned.filter((w) => /refused this server's key \(403\)/.test(w)).length === 1, `a push service's 403 is logged once (${warned.length})`);

    // ── 10. At most 8 at once, a queue behind ───────────────────────────────────────────────────────────────────────
    let open = 0, most = 0;
    const releases: (() => void)[] = [];
    _setWebPushFetchForTests(async () => {
        open++; most = Math.max(most, open);
        await new Promise<void>((r) => releases.push(r));
        open--;
        return new Response(null, { status: 201 });
    });
    const target = { endpoint: 'https://fcm.googleapis.com/fcm/send/q', contact: 'https://test.example', p256dh: b64u(someone.p256dh), auth: b64u(someone.auth) };
    const many = Array.from({ length: 20 }, () => sendWebPush(target, { payload: { title: 'BeanPool' }, ttlSeconds: 60, urgency: 'normal' }, made));
    await new Promise((r) => setTimeout(r, 50));
    const firstWave = { ...(_webPushQueueForTests()), most };
    // Each finished send hands its place on, while new sends keep arriving.
    for (let i = 0; i < 25 && releases.length; i++) {
        releases.shift()!();
        void sendWebPush(target, { payload: { title: 'BeanPool' }, ttlSeconds: 60, urgency: 'normal' }, made).catch(() => {});
        await new Promise((r) => setTimeout(r, 5));
    }
    while (releases.length || _webPushQueueForTests().inFlight) { releases.splice(0).forEach((r) => r()); await new Promise((r) => setTimeout(r, 5)); }
    const outcomes = await Promise.all(many);
    assert(firstWave.inFlight === WEB_PUSH_RULES.inFlight && firstWave.waiting === 12 && most === WEB_PUSH_RULES.inFlight && outcomes.every((o) => o === 'sent'),
        `at most ${WEB_PUSH_RULES.inFlight} requests at once, the rest in line, all sent in the end (${show(firstWave)}, most ${most})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
