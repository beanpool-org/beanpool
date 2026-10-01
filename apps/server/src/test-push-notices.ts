/**
 * Pushes say nothing private, carry the community's signature, and Expo's answers are read
 * (scratch/global-node/DESIGN-push-relay-fable.md §4.1, §4.3, §4.4; @beanpool/core push-notice.ts; engine/push-notices.ts).
 *
 * Every push is caught where it leaves for Expo: nothing here contacts exp.host or any host but this machine.
 *   1. Every kind: a push of each kind in PUSH_NOTICE_KINDS, sent with details full of names, an amount, a listing title
 *      and ids, shows only "BeanPool" and its kind's sentence, and its data is the notice alone (bp, k, i, t, c, s): none
 *      of the details anywhere in what left. Every kind in the table is named by a sender in the server's source, and no
 *      sender names one that isn't in it.
 *   2. Real senders: a direct message, an answer to a listing, an operator's announcement and a moved event go out as
 *      chat.message, market.request, community.notice and event.update, and nothing that left names who, which listing,
 *      how many beans, what was announced, or a post, conversation or member id.
 *   3. The signature: a member's phone registers (POST /api/push-tokens) and is given pushKey, the node key's (its
 *      PeerId's); a push to them verifies with it for them (core verifyPushNotice), and fails for another member, with
 *      another key, and when any covered field (c, k, i, t) or the signature changes. Each recipient gets their own id.
 *   4. GET /api/notices/push/:id: the recipient reads the details (what the sender wrote, where a tap lands); another
 *      member gets 404, as for an id that never was or isn't one; a key that is no member here 403; unsigned 401. A
 *      notice older than 7 days is not answered and the hourly tidy deletes it; a pruned member's go with them.
 *   5. Expo's tickets: a DeviceNotRegistered ticket removes that phone's registration and only it (another phone of the
 *      same member, and another member's, stay), with its tombstone; a ticket for another error and an UNAUTHORIZED
 *      answer remove nothing, are said once each and counted for diagnostics; no line printed holds a push token.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-push-notices.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_ROLE;
delete process.env.NODE_PROFILE;
delete process.env.EXPO_ACCESS_TOKEN;
const ADMIN_PW = 'PushNoticesAdmin123!';
process.env.ADMIN_PASSWORD = ADMIN_PW; // the announcement route is the operator's

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    PUSH_NOTICE_KINDS, PUSH_NOTICE_LIFETIME_SECONDS, ed25519KeyOfPeerId, isPushNoticeKind, pushNoticeWords, verifyPushNotice,
    type PushNoticeKind,
} from '@beanpool/core';

// Everything this process prints, so section 5 can look for a push token in it.
const printed: string[] = [];
for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (...args: any[]) => boolean;
    (stream as any).write = (chunk: unknown, ...rest: any[]) => {
        printed.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
        return write(chunk, ...rest);
    };
}

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
/** A step that throws on a tree without push notices (no such table) must fail its assertion, not abort the run. */
function attempt<T>(fn: () => T): T | undefined {
    try { return fn(); } catch (e: any) { console.error(`  (threw: ${e?.message})`); return undefined; }
}
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); await new Promise(r => setTimeout(r, 50)); };
const DAY = 24 * 60 * 60 * 1000;
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}
const tokenOf = (name: string) => `ExponentPushToken[${name}-${crypto.randomBytes(12).toString('base64url')}]`;

let BASE = '';
interface Res { status: number; body: any }
async function call(method: 'GET' | 'POST', id: Id | null, route: string, body?: unknown): Promise<Res> {
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    resetGatewayRateLimit();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = {};
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${route.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    if (route.startsWith('/api/local/admin/')) headers['X-Admin-Password'] = ADMIN_PW;
    const res = await fetch(`${BASE}${route}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: parsed };
}

/** The keys a push's data may carry: the notice's own. (`kind` too, for the old apps' recovery tap only.) */
const NOTICE_KEYS = ['bp', 'c', 'i', 'k', 's', 't'];

async function main() {
    console.log('Push notices: fixed words, a signed notice, and Expo\'s answers...\n');
    if (!process.env.BEANPOOL_DATA_DIR) throw new Error('BEANPOOL_DATA_DIR must be set to a fresh directory');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { startP2P } = await import('./p2p.js');
    const { putPushTokenRow, pushTokenId } = await import('./services/push-token-seal.js');
    // Absent on a tree without them: the checks that need them fail, and the rest still run.
    const notices: any = await import('./engine/push-notices.js').catch(() => null);

    const { initAdminPassword } = await import('./config/local-config.js');
    initAdminPassword();
    await initTls();
    se.initStateEngine();
    // The node key (data/libp2p_key): what signs the notices.
    const p2p = await startP2P(0, 0);
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    // Pushes, caught where they leave for Expo. `expo` says how the stand-in answers.
    type Mode = 'ok' | 'tickets' | 'unauthorized';
    let expo: Mode = 'ok';
    let dead = new Set<string>();
    let otherError = new Set<string>();
    const sent: any[] = [];
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = async (input: any, init?: any) => {
        const url = String(input instanceof Request ? input.url : input);
        const host = new URL(url).hostname;
        if (host === 'exp.host' || host.endsWith('.expo.dev') || host === 'expo.dev') {
            const batch = JSON.parse(init?.body ?? '[]');
            sent.push(...batch);
            if (expo === 'unauthorized') {
                return new Response(JSON.stringify({ errors: [{ code: 'UNAUTHORIZED', message: 'The bearer token is invalid' }] }), { status: 401 });
            }
            const data = batch.map((m: any) => dead.has(m.to)
                ? { status: 'error', message: `"${m.to}" is not a registered push notification recipient`, details: { error: 'DeviceNotRegistered', expoPushToken: m.to } }
                : otherError.has(m.to)
                    ? { status: 'error', message: 'Too many messages to this device', details: { error: 'MessageRateExceeded' } }
                    : { status: 'ok', id: crypto.randomUUID() });
            return new Response(JSON.stringify({ data: expo === 'tickets' ? data : batch.map(() => ({ status: 'ok', id: crypto.randomUUID() })) }),
                { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (host === 'localhost' || host === '127.0.0.1') return realFetch(input, init);
        throw new Error(`the test refused to contact ${host}`);
    };
    const caught = async (fn: () => unknown) => { sent.length = 0; await fn(); await flush(); return [...sent]; };

    // Members, each with a phone.
    const owner = newId('OwnerOlive');
    se.seedGenesisMember(owner.pk, 'OwnerOlive');
    const member = (name: string): Id => {
        const id = newId(name);
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, avatar_url, status)
                    VALUES (?, ?, ?, ?, 'TEST', 'https://example.com/a.jpg', 'active')`).run(id.pk, name, new Date(Date.now() - 60 * DAY).toISOString(), owner.pk);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
        return id;
    };
    const ann = member('AnnSecretname'), bob = member('BobSecretname'), cat = member('CatSecretname');
    const stranger = newId('NobodyHere');
    const phone = { ann: tokenOf('ann'), annOld: tokenOf('annold'), bob: tokenOf('bob'), cat: tokenOf('cat') };
    const register = (who: Id, token: string) => putPushTokenRow(who.pk, token, 'android');
    register(bob, phone.bob);
    register(cat, phone.cat);
    const toWhom = new Map<string, Id>([[phone.ann, ann], [phone.annOld, ann], [phone.bob, bob], [phone.cat, cat]]);

    /** What left, as text: everything a lock screen, Expo, Apple and Google got. */
    const visible = (msgs: any[]) => JSON.stringify(msgs.map(m => ({ title: m.title, body: m.body, data: m.data, subtitle: m.subtitle })));
    /** The message shows only its kind's words, and its data is the notice and nothing else. */
    const onlyItsWords = (m: any): boolean => isPushNoticeKind(m?.data?.k) && m.title === 'BeanPool' && m.body === pushNoticeWords(m.data.k).body
        && JSON.stringify(Object.keys(m.data).filter(k => k !== 'kind').sort()) === JSON.stringify(NOTICE_KEYS)
        && (m.data.kind === undefined || (m.data.k === 'account.recovery-started' && m.data.kind === 'recovery_started'));

    try {
        // ── 3 first: the phone registers, and is given the key to pin ─────────────────────────────────────
        console.log('--- 3. The key the app pins, and the signature ---');
        const reg = await call('POST', ann, '/api/push-tokens', { publicKey: ann.pk, token: phone.ann, platform: 'android' });
        const pushKey: string = reg.body?.pushKey;
        const nodeKey = Buffer.from(ed25519KeyOfPeerId(p2p.peerId.toString()) ?? new Uint8Array()).toString('hex');
        assert(reg.status === 200 && reg.body?.success === true && typeof pushKey === 'string' && /^[0-9a-f]{64}$/.test(pushKey),
            `the registration answer carries pushKey (${reg.status} ${JSON.stringify(reg.body)})`);
        assert(pushKey === nodeKey, "and it is the node key, the key behind this community's PeerId");
        register(ann, phone.annOld);

        // ── 1. Every kind, with details full of what must not leave ─────────────────────────────────────────
        console.log('\n--- 1. Every kind shows only its fixed words ---');
        const POST_ID = crypto.randomUUID(), CONV_ID = crypto.randomUUID(), GROUP_ID = crypto.randomUUID();
        const secrets = ['AnnSecretname', 'Quince jam deluxe', '1234', 'Beans', 'Riverbend Growers', POST_ID, CONV_ID, GROUP_ID, ann.pk];
        const detailTitle = '🔒 Quince jam deluxe: 1234 Beans';
        const detailBody = 'AnnSecretname placed 1234 Beans in escrow for "Quince jam deluxe" in Riverbend Growers';
        const detailData = { screen: 'post', postId: POST_ID, conversationId: CONV_ID, groupId: GROUP_ID, from: ann.pk };
        const kinds = Object.keys(PUSH_NOTICE_KINDS) as PushNoticeKind[];
        const offKinds: string[] = [], leaked: string[] = [], unkept: string[] = [];
        for (const kind of kinds) {
            const msgs = await caught(() => se.dispatchPushNotification([bob.pk], 'SYSTEM', detailTitle, detailBody, detailData, 'marketplace', kind));
            if (msgs.length !== 1 || !onlyItsWords(msgs[0]) || msgs[0].data.k !== kind) offKinds.push(kind);
            const text = visible(msgs);
            const found = secrets.filter(s => text.includes(s));
            if (found.length) leaked.push(`${kind}: ${found.join(', ')}`);
            if (/\d/.test(`${msgs[0]?.title} ${msgs[0]?.body}`)) leaked.push(`${kind}: a number in the words`);
            const row = notices ? attempt(() => db.prepare('SELECT title, body, data FROM push_notices WHERE id = ?').get(msgs[0]?.data?.i)) as any : null;
            if (!row || row.title !== detailTitle || row.body !== detailBody || JSON.parse(row.data).postId !== POST_ID) unkept.push(kind);
        }
        assert(offKinds.length === 0, `each of the ${kinds.length} kinds goes out as "BeanPool" and its kind's sentence, with the notice as its only data${offKinds.length ? ` (not: ${offKinds.join(', ')})` : ''}`);
        assert(leaked.length === 0, `no name, amount, listing, group or id reaches Expo in any kind${leaked.length ? ` (${leaked.join('; ')})` : ''}`);
        assert(unkept.length === 0, `what the sender wrote is kept on this server as the notice's details, for every kind${unkept.length ? ` (not: ${unkept.join(', ')})` : ''}`);

        // The table and the senders agree: every kind is sent by someone, and nobody sends a kind that isn't in the table.
        const srcDir = path.dirname(fileURLToPath(import.meta.url));
        const named = new Set<string>();
        const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); continue; }
                if (!entry.name.endsWith('.ts') || entry.name.startsWith('test-') || entry.name.includes('-harness') || entry.name === 'push-notices.ts') continue;
                const text = fs.readFileSync(full, 'utf8');
                for (const m of text.matchAll(/dispatchPushNotification\(([\s\S]*?)\);/g)) {
                    for (const k of m[1].matchAll(/'((?:chat|group|market|trade|review|event|community|account|owner)\.[a-z-]+)'/g)) named.add(k[1]);
                }
                for (const k of text.matchAll(/^\s*'((?:chat|group|market|trade|review|event|community|account|owner)\.[a-z-]+)',?\s*$/gm)) named.add(k[1]);
                for (const k of text.matchAll(/\? '((?:review|trade)\.[a-z-]+)' : '((?:review|trade)\.[a-z-]+)'/g)) { named.add(k[1]); named.add(k[2]); }
            }
        };
        walk(srcDir);
        const unsent = kinds.filter(k => !named.has(k));
        const unknown = [...named].filter(k => !isPushNoticeKind(k));
        assert(unsent.length === 0 && unknown.length === 0,
            `every kind in the table is named by a sender in the server's source, and every kind a sender names is in it (unsent: ${unsent.join(', ') || 'none'}; unknown: ${unknown.join(', ') || 'none'})`);

        // ── 2. Real senders ────────────────────────────────────────────────────────────────────────────────
        console.log('\n--- 2. Real senders ---');
        const conv = se.createConversation('dm', [ann.pk, bob.pk], ann.pk)!;
        const { lockedDm } = await import('./dm-test-payload.js');
        const line = lockedDm();
        const dm = await caught(() => se.sendMessage(conv.id, ann.pk, line.ciphertext, line.nonce));
        const dmToBob = dm.filter(m => toWhom.get(m.to) === bob);
        assert(dmToBob.length === 1 && onlyItsWords(dmToBob[0]) && dmToBob[0].data.k === 'chat.message'
            && !visible(dm).includes('AnnSecretname') && !visible(dm).includes(conv.id),
            `a direct message: "You have a new message.", with no sender's name and no conversation id (${visible(dmToBob)})`);
        const dmDetails = notices?.readPushNotice(dmToBob[0]?.data?.i, bob.pk);
        assert(dmDetails?.body === 'AnnSecretname sent you a message' && dmDetails?.data?.conversationId === conv.id,
            `and its details say who wrote and which chat (${JSON.stringify(dmDetails)})`);

        se.transfer('genesis', bob.pk, 50, 'seed', 'direct', true);
        se.createPost('offer', 'other', 'Seedlings', 'Tomato seedlings', 1, 'fixed', bob.pk); // a member offers before they ask
        const listing = se.createPost('offer', 'other', 'Quince jam deluxe', 'Small batch', 7, 'fixed', ann.pk)!;
        const asked = await caught(() => se.requestPost(listing.id, bob.pk));
        const askedAnn = asked.filter(m => toWhom.get(m.to) === ann);
        assert(askedAnn.length === 2 && askedAnn.every(m => onlyItsWords(m) && m.data.k === 'market.request')
            && !/Quince|BobSecretname|\b7\b/.test(`${askedAnn[0]?.title} ${askedAnn[0]?.body}`) && !visible(asked).includes(listing.id),
            `an answer to a listing reaches both of Ann's phones as "Someone answered one of your listings.", with no title, name, amount or post id (${visible(askedAnn.slice(0, 1))})`);
        assert(askedAnn.length === 2 && typeof askedAnn[0].data.i === 'string' && askedAnn[0].data.i === askedAnn[1].data.i,
            "one notice per member: both of Ann's phones carry the same notice");

        const announced = await caught(() => se.adminBroadcastAnnouncement('Hall meeting moved', 'Riverbend Growers meet at 9pm, bring the cash box', 'info'));
        assert(announced.length >= 4 && announced.every(m => onlyItsWords(m) && m.data.k === 'community.notice')
            && !/Hall meeting|Riverbend|cash box|9pm/.test(visible(announced)),
            `an operator's announcement: "Your community has a notice for you." on every phone, and none of its words (${announced.length} phones)`);
        const announcedIds = new Set(announced.map(m => m.data.i));
        assert(announcedIds.size === 3, `each member gets their own notice id (${announcedIds.size} ids for ${announced.length} phones of 3 members)`);
        const annNotice = announced.find(m => toWhom.get(m.to) === ann)!;
        const bobNotice = announced.find(m => toWhom.get(m.to) === bob)!;

        const ev = se.createPost('event', 'community', 'Secret garden bee', 'Bring gloves', 0, 'fixed', cat.pk, -28.55, 153.5, [], false, undefined, false,
            { eventStartAt: inHours(30), eventPlaceName: 'Riverbend hall' } as any)!;
        se.rsvpEvent(ev.id, bob.pk, 'going');
        const moved = await caught(() => se.updatePost(ev.id, cat.pk, { eventStartAt: inHours(54) } as any, cat.pk));
        assert(moved.length === 1 && toWhom.get(moved[0].to) === bob && onlyItsWords(moved[0]) && moved[0].data.k === 'event.update'
            && !/Secret garden|Riverbend/.test(visible(moved)) && !visible(moved).includes(ev.id),
            `a moved event: "There is news about an event you're going to.", with no event name, place or post id (${visible(moved)})`);

        // ── 3. The signature ───────────────────────────────────────────────────────────────────────────────
        console.log('\n--- 3. The signature (continued) ---');
        const check = (data: any, recipient: Id, key = pushKey) => verifyPushNotice(data, { recipient: recipient.pk, pushKey: key });
        assert(check(annNotice.data, ann).ok === true && check(bobNotice.data, bob).ok === true,
            'each notice verifies with the pinned key, for the member it was sent to');
        assert(typeof annNotice.data.c === 'string' && typeof annNotice.data.s === 'string', 'it names the community (c) and carries the signature (s)');
        assert((check(annNotice.data, bob) as any).reason === 'bad-signature', "Ann's notice fails on Bob's phone: the recipient is signed though not sent");
        const otherKey = Buffer.from(crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
        assert((check(annNotice.data, ann, otherKey) as any).reason === 'other-community', 'and with any other key it is not this community\'s');
        const flip = (hex: unknown) => { const h = String(hex ?? ''); return h.slice(0, -1) + (h.endsWith('0') ? '1' : '0'); };
        const tampered: Array<[string, any]> = [
            ['c', { ...annNotice.data, c: flip(annNotice.data.c) }],
            ['k', { ...annNotice.data, k: 'trade.update' }],
            ['i', { ...annNotice.data, i: flip(annNotice.data.i) }],
            ['t', { ...annNotice.data, t: annNotice.data.t - 1 }],
            ['s', { ...annNotice.data, s: flip(annNotice.data.s) }],
        ];
        const held = tampered.filter(([, d]) => check(d, ann).ok);
        assert(check(annNotice.data, ann).ok === true && held.length === 0, `a change to any covered field fails the check: c, k, i, t and the signature itself${held.length ? ` (held: ${held.map(([f]) => f).join(', ')})` : ''}`);

        // ── 4. The details route ───────────────────────────────────────────────────────────────────────────
        console.log('\n--- 4. GET /api/notices/push/:id ---');
        const mine = await call('GET', ann, `/api/notices/push/${annNotice.data.i}`);
        assert(mine.status === 200 && mine.body?.id === annNotice.data.i && mine.body?.kind === 'community.notice'
            && mine.body?.title === 'Hall meeting moved' && mine.body?.body === 'Riverbend Growers meet at 9pm, bring the cash box'
            && mine.body?.sentAt === annNotice.data.t,
            `the recipient reads the details: the announcement's own words (${mine.status} ${JSON.stringify(mine.body)})`);
        // An announcement is never cut: 4,000 characters are read whole, and 4,001 is refused at the route with nothing sent.
        const long4000 = 'Long announcement. '.repeat(300).slice(0, 4000);
        const sentLong = await caught(async () => { await call('POST', null, '/api/local/admin/announcements', { title: 'Four thousand', body: long4000, severity: 'info' }); });
        const longToAnn = sentLong.find(m => toWhom.get(m.to) === ann);
        const longRead = longToAnn ? await call('GET', ann, `/api/notices/push/${longToAnn.data.i}`) : null;
        assert(long4000.length === 4000 && sentLong.length >= 4 && longRead?.status === 200 && longRead.body?.body === long4000 && longRead.body?.title === 'Four thousand',
            `a 4,000-character announcement sent through the route is read whole from its notice (${sentLong.length} phones, ${longRead?.status}, ${String(longRead?.body?.body ?? '').length} characters)`);
        let tooLong: Res | null = null;
        const sentTooLong = await caught(async () => { tooLong = await call('POST', null, '/api/local/admin/announcements', { title: 'Too long', body: long4000 + 'x', severity: 'info' }); });
        assert((tooLong as Res | null)?.status === 400 && /4,000/.test(String((tooLong as Res | null)?.body?.error)) && sentTooLong.length === 0,
            `4,001 characters is refused at the route with a 400 that names the limit, and nothing is sent (${(tooLong as Res | null)?.status} ${JSON.stringify((tooLong as Res | null)?.body)}, ${sentTooLong.length} pushes)`);
        let titleLong: Res | null = null;
        const sentTitleLong = await caught(async () => { titleLong = await call('POST', null, '/api/local/admin/announcements', { title: 't'.repeat(201), body: 'short', severity: 'info' }); });
        assert((titleLong as Res | null)?.status === 400 && sentTitleLong.length === 0, `a title over 200 characters is refused the same way (${(titleLong as Res | null)?.status}, ${sentTitleLong.length} pushes)`);
        const askedDetails = await call('GET', ann, `/api/notices/push/${askedAnn[0]?.data?.i}`);
        assert(askedDetails.status === 200 && askedDetails.body?.data?.postId === listing.id && /BobSecretname/.test(askedDetails.body?.body ?? ''),
            `and, for an answer to her listing, who answered and where a tap lands (${JSON.stringify(askedDetails.body)})`);
        const notHers = await call('GET', bob, `/api/notices/push/${annNotice.data.i}`);
        const never = await call('GET', bob, `/api/notices/push/${crypto.randomBytes(16).toString('hex')}`);
        assert(notHers.status === 404 && never.status === 404 && JSON.stringify(notHers.body) === JSON.stringify(never.body),
            `another member gets 404, the same answer as for an id that never was (${notHers.status}, ${never.status})`);
        assert((await call('GET', bob, `/api/notices/push/${bobNotice.data.i}`)).status === 200, 'and reads their own');
        const odd = await call('GET', ann, '/api/notices/push/..%2Fpost%2F1');
        const upper = await call('GET', ann, `/api/notices/push/${String(annNotice.data.i).toUpperCase()}`);
        assert(odd.status === 404 && upper.status === 404, `something that isn't a notice id is a 404 (${odd.status}, ${upper.status})`);
        const unsigned = await call('GET', null, `/api/notices/push/${annNotice.data.i}`);
        const outsider = await call('GET', stranger, `/api/notices/push/${annNotice.data.i}`);
        assert(unsigned.status === 401, `an unsigned caller is refused: 401 (${unsigned.status})`);
        assert(outsider.status === 403, `a signed key that is no member here: 403 (${outsider.status})`);
        assert(![unsigned, outsider, notHers].some(r => JSON.stringify(r.body).includes('Hall meeting')), 'and none of them is told what it said');

        const nowS = Math.floor(Date.now() / 1000);
        attempt(() => db.prepare('UPDATE push_notices SET sent_at = ? WHERE id = ?').run(nowS - PUSH_NOTICE_LIFETIME_SECONDS - 60, bobNotice.data.i));
        const stale = await call('GET', bob, `/api/notices/push/${bobNotice.data.i}`);
        assert(stale.status === 404, `a notice older than 7 days is not answered, whenever the tidy last ran (${stale.status})`);
        // An expired request tells its two people two different sentences: the requester's "requests", the author's "listings".
        const expiredTxn = attempt(() => db.prepare("SELECT id FROM marketplace_transactions WHERE post_id = ? AND status = 'requested'").get(listing.id)) as any;
        attempt(() => db.prepare("UPDATE marketplace_transactions SET created_at = datetime('now', '-30 days') WHERE id = ?").run(expiredTxn?.id));
        const expiredPushes = await caught(() => se.runMarketplaceHygiene());
        const expToAnn = expiredPushes.filter(m => toWhom.get(m.to) === ann), expToBob = expiredPushes.filter(m => toWhom.get(m.to) === bob);
        assert(expiredTxn && expToAnn.length >= 1 && expToAnn.every(m => m.data.k === 'market.listing' && m.body === 'There is news on one of your listings.')
            && expToBob.length >= 1 && expToBob.every(m => m.data.k === 'market.answer' && m.body === 'There is news on one of your requests.'),
            `an expired request: the listing's author hears "news on one of your listings", the requester "news on one of your requests" (${expToAnn.map(m => m.body).join('|')} / ${expToBob.map(m => m.body).join('|')})`);
        const left = attempt(() => db.prepare('SELECT COUNT(*) AS n FROM push_notices WHERE id = ?').get(bobNotice.data.i)) as any;
        const kept = attempt(() => db.prepare('SELECT COUNT(*) AS n FROM push_notices WHERE id = ?').get(annNotice.data.i)) as any;
        assert(left?.n === 0 && kept?.n === 1, `the hourly tidy deletes it, and keeps a newer one (${left?.n}, ${kept?.n})`);
        const catBefore = (attempt(() => db.prepare('SELECT COUNT(*) AS n FROM push_notices WHERE recipient = ?').get(cat.pk)) as any)?.n;
        se.adminPruneUser(cat.pk, owner.pk);
        const catAfter = (attempt(() => db.prepare('SELECT COUNT(*) AS n FROM push_notices WHERE recipient = ?').get(cat.pk)) as any)?.n;
        assert(catBefore > 0 && catAfter === 0, `a pruned member's notice details go with them (${catBefore} → ${catAfter})`);

        // A member who deletes their account no longer leaves their name in the notices kept for the people they wrote to.
        const wren = member('Wren Calloway'), juniper = member('Juniper Holt');
        const wrenOldKey = crypto.randomBytes(32).toString('hex');
        db.prepare(`INSERT INTO invalidated_keys (public_key, reason, rekeyed_to) VALUES (?, 'rekey', ?)`).run(wrenOldKey, wren.pk);
        const phoneJuniper = tokenOf('juniper');
        register(juniper, phoneJuniper);
        toWhom.set(phoneJuniper, juniper);
        const wrenConv = se.createConversation('dm', [wren.pk, juniper.pk], wren.pk)!;
        const wrenLine = lockedDm();
        const wrenDm = await caught(() => se.sendMessage(wrenConv.id, wren.pk, wrenLine.ciphertext, wrenLine.nonce));
        const juniperNoticeId = wrenDm.find(m => toWhom.get(m.to) === juniper)?.data?.i;
        const juniperBefore = notices?.readPushNotice(juniperNoticeId, juniper.pk);
        assert(juniperBefore?.body === 'Wren Calloway sent you a message', `Wren DMs Juniper: Juniper's kept notice names Wren (${juniperBefore?.body})`);
        // Every other kind whose details can name a member: a title, a body, and the name or a key inside the data.
        const wrenText = 'wren calloway';
        const otherKinds = [
            ['group.lead', '👥 Wren Calloway\'s group', 'Wren Calloway asked to lead', { by: 'Wren Calloway' }],
            ['market.request', '🙋 Request', 'Wren Calloway requested "Jam"', { from: wren.pk, nested: { name: 'Wren Calloway', n: 3 } }],
            ['trade.update', 'Trade', 'Wren Calloway accepted "Jam" - 7 Beans are now in escrow.', { peer: wrenOldKey.slice(0, 12) }],
            ['review.new', '⭐ Review from Wren Calloway', 'wren calloway left a review', {}],
        ] as const;
        const insertNotice = db.prepare("INSERT INTO push_notices (id, recipient, kind, title, body, data, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
        const kindIds = otherKinds.map(([kind, title, body, data], i) => {
            const id = crypto.randomBytes(16).toString('hex');
            insertNotice.run(id, juniper.pk, kind, title, body, JSON.stringify(data), Math.floor(Date.now() / 1000) - i);
            return id;
        });
        const bystander = crypto.randomBytes(16).toString('hex');
        insertNotice.run(bystander, juniper.pk, 'chat.group', '👥 Wrenfield Farm', 'Juniper Holt sent a message', JSON.stringify({ n: 12, ok: true }), Math.floor(Date.now() / 1000));
        const bystanderBefore = JSON.stringify(db.prepare('SELECT title, body, data FROM push_notices WHERE id = ?').get(bystander));
        const wrenOwn = crypto.randomBytes(16).toString('hex');
        insertNotice.run(wrenOwn, wren.pk, 'chat.message', 'Wren Calloway', 'to Wren Calloway', '{}', Math.floor(Date.now() / 1000));
        assert(se.purgeMemberSelf(wren.pk).ok, 'Wren deletes their account');
        const juniperAfter = notices?.readPushNotice(juniperNoticeId, juniper.pk);
        assert(juniperAfter && !/wren/i.test(JSON.stringify(juniperAfter)) && juniperAfter.body === 'A member sent you a message',
            `Juniper's stored notice no longer names Wren: "${juniperAfter?.body}"`);
        assert(juniperAfter?.data?.conversationId === wrenConv.id && juniperAfter?.kind === 'chat.message', 'and still says which chat and kind it is');
        const everyKind = kindIds.map(id => JSON.stringify(db.prepare('SELECT title, body, data FROM push_notices WHERE id = ?').get(id)));
        assert(everyKind.every(t => !t.toLowerCase().includes(wrenText) && !t.includes(wren.pk) && !t.includes(wrenOldKey.slice(0, 12))),
            `no other kind keeps their name or a key in its title, body or data (${everyKind.join(' | ')})`);
        assert(everyKind.every(t => { const r = JSON.parse(t); try { JSON.parse(r.data); return true; } catch { return false; } }), "and each kind's data is still JSON");
        assert(JSON.parse(everyKind[1]).data.includes('"n":3'), 'a number beside a name in the data is untouched');
        assert(JSON.stringify(db.prepare('SELECT title, body, data FROM push_notices WHERE id = ?').get(bystander)) === bystanderBefore,
            "a notice that does not name Wren (a longer word that starts like it, a number, a boolean) is exactly as it was");
        assert(!db.prepare('SELECT 1 FROM push_notices WHERE id = ?').get(wrenOwn), "Wren's own notices are gone");

        // ── 5. Expo's tickets ──────────────────────────────────────────────────────────────────────────────
        console.log("\n--- 5. Expo's tickets ---");
        // A row names its phone by the token's id (services/push-token-seal.ts): each id read back to the token it is.
        const byId = new Map([...toWhom.keys()].map(t => [pushTokenId(t), t]));
        const rowsNow = () => (db.prepare('SELECT public_key, token_id FROM push_tokens ORDER BY public_key, token_id').all() as { public_key: string; token_id: string }[])
            .map(r => byId.get(r.token_id) ?? r.token_id)
            .map(t => `${toWhom.get(t)?.name ?? '?'}:${t}`);
        const before = rowsNow();
        expo = 'tickets';
        dead = new Set([phone.annOld]);
        const deadSend = await caught(() => se.dispatchPushNotification([ann.pk, bob.pk], 'SYSTEM', 'T', 'B', {}, 'chat', 'chat.message'));
        const after = rowsNow();
        assert(deadSend.length === 3, `the push went to Ann's two phones and Bob's (${deadSend.length})`);
        assert(before.length - after.length === 1 && !after.some(r => r.endsWith(phone.annOld))
            && after.some(r => r.endsWith(phone.ann)) && after.some(r => r.endsWith(phone.bob)),
            `the phone Expo says is gone is removed, and only it: Ann's other phone and Bob's stay (${before.length} → ${after.length})`);
        const tomb = db.prepare("SELECT 1 FROM tombstones WHERE table_name = 'push_tokens' AND row_key = ?").get(`${ann.pk}|${pushTokenId(phone.annOld)}`);
        assert(!!tomb, 'with its tombstone, so a standby drops it too');

        dead = new Set();
        otherError = new Set([phone.bob]);
        const refusalsBefore = printed.filter(l => l.includes('[Push] Expo refused')).length;
        await caught(() => se.dispatchPushNotification([bob.pk], 'SYSTEM', 'T', 'B', {}, 'chat', 'chat.message'));
        await caught(() => se.dispatchPushNotification([bob.pk], 'SYSTEM', 'T', 'B', {}, 'chat', 'chat.message'));
        expo = 'unauthorized';
        await caught(() => se.dispatchPushNotification([bob.pk], 'SYSTEM', 'T', 'B', {}, 'chat', 'chat.message'));
        await caught(() => se.dispatchPushNotification([bob.pk], 'SYSTEM', 'T', 'B', {}, 'chat', 'chat.message'));
        expo = 'ok';
        assert(JSON.stringify(rowsNow()) === JSON.stringify(after), 'a ticket for another error, and an UNAUTHORIZED answer, remove nothing');
        const said = printed.filter(l => l.includes('[Push] Expo refused')).slice(refusalsBefore);
        assert(said.length === 2 && said.some(l => l.includes('MessageRateExceeded')) && said.some(l => l.includes('UNAUTHORIZED') && l.includes('EXPO_ACCESS_TOKEN')),
            `each is said once, UNAUTHORIZED in plain words naming EXPO_ACCESS_TOKEN (${said.length} line(s))`);
        const counted = typeof se.pushServiceRefusals === 'function' ? se.pushServiceRefusals() : {} as ReturnType<typeof se.pushServiceRefusals>;
        assert(counted.MessageRateExceeded?.count === 2 && counted.UNAUTHORIZED?.count === 2,
            `and counted for diagnostics (${JSON.stringify(Object.fromEntries(Object.entries(counted).map(([k, v]) => [k, v.count])))})`);
        const tokens = Object.values(phone);
        assert(!printed.some(l => tokens.some(t => l.includes(t))), `no line this process printed holds a push token (${printed.length} writes)`);

        console.log(`\n${passed}/${run} checks passed.`);
        if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
        console.log('⭐️ Push notice checks PASSED.');
    } finally {
        (globalThis as any).fetch = realFetch;
        await p2p.stop();
    }
}
main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
