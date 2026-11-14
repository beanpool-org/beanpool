/**
 * The phone's waiting asker (scratch/fable-design/DESIGN-web-notifications-fable.md §3 W4, Marty's Decision 4): a phone in
 * waiting mode registers its push token under the key that asked to join, and the yes buzzes it. Over REAL HTTPS through
 * the real signature middleware, with Expo's push service answered in-process (nothing leaves the machine).
 *
 *   1. a key with no row here and no request to join: 403 no_open_request, nothing kept; unsigned: 401
 *   2. a key with an open request registers its phone: 200 { success, pushKey }; the same phone again is taken
 *   3. a member and a visitor's row register as ever
 *   4. cancel and decline take the phone's row; a declined key in its block is answered as open and nothing is kept;
 *      a cancelled key's new phone is refused
 *   5. a lapsed request's phone goes at the tidy-up, an open one's stays
 *   6. approve sends `join.answered` to the waiting phone through Expo: the fixed words and a notice signed for that key,
 *      nothing else; any other kind sent to that key reaches none of its phones; the row stays while the invite works,
 *      and goes once it has lapsed
 *
 * Run: via scripts/run-server-suites.mjs (SERVER_SUITES_ONLY=test-push-waiting-asker)
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { dispatchPushNotification, initStateEngine, seedGenesisMember } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { startP2P } from './p2p.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { tidyKnocks } from './engine/knocks.js';
import { pushKeyHex } from './engine/push-notices.js';
import { pushTokenId } from './services/push-token-seal.js';
import { verifyPushNotice, pushNoticeWords } from '@beanpool/core';
import { wordsIn } from './member-words.js';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ FAIL: ${msg}`); process.exitCode = 1; }
}
const show = (v: unknown) => JSON.stringify(v)?.slice(0, 300);
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

async function main(): Promise<void> {
    console.log('\n=== The phone\'s waiting asker (web push W4) ===\n');
    if (!process.env.BEANPOOL_DATA_DIR) throw new Error('BEANPOOL_DATA_DIR must be set');

    await initTls();
    initStateEngine();
    await startP2P(0, 0);
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    // Expo's push service, answered here: what the node hands it, message by message.
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

    const owner = newId('Owner');
    seedGenesisMember(owner.pk, owner.name);
    const phones = (pk: string) => db.prepare('SELECT token_id FROM push_tokens WHERE public_key = ?').pluck().all(pk) as string[];
    const tokenOf = (id: Id, n = 1) => `ExponentPushToken[${id.name.toLowerCase()}-${n}]`;
    const register = (id: Id | null, token: string, as: Id | null = id) =>
        call(id, 'POST', '/api/push-tokens', { publicKey: (as ?? id)?.pk ?? 'none', token, platform: 'android', registeredAt: Date.now(), lang: 'en' });
    const knockOf = async (id: Id) => {
        // Every knock here comes from one address: its limit a day is not what this suite checks.
        db.prepare('UPDATE join_requests SET ip_hash = NULL').run();
        const r = await call(id, 'POST', '/api/join/knock', { callsign: id.name, message: 'Hello, may I join?' });
        if (r.status !== 201) throw new Error(`knock ${r.status} ${show(r.body)}`);
        const list = await call(owner, 'GET', '/api/join/knocks?limit=50');
        return (list.body.knocks as any[]).find((k) => k.pubkey === id.pk).id as string;
    };

    // ── 1. No row, no request ───────────────────────────────────────────────────────────────────────────────────────
    const ana = newId('Ana');
    const unsigned = await register(null, tokenOf(ana), ana);
    assert(unsigned.status === 401 && phones(ana.pk).length === 0, `an unsigned registration: 401, nothing kept (${unsigned.status})`);
    const stranger = await register(ana, tokenOf(ana));
    assert(stranger.status === 403 && stranger.body?.code === 'no_open_request' && phones(ana.pk).length === 0,
        `a key with no row here and no request to join: 403 no_open_request, nothing kept (${stranger.status} ${show(stranger.body)})`);

    // ── 2. An open request: the waiting phone registers ─────────────────────────────────────────────────────────────
    const anaKnock = await knockOf(ana);
    const waiting = await register(ana, tokenOf(ana));
    assert(waiting.status === 200 && waiting.body?.success === true && waiting.body?.pushKey === pushKeyHex(),
        `a key with an open request registers its phone: 200 { success, pushKey } (${waiting.status} ${show(waiting.body)})`);
    assert(phones(ana.pk).length === 1 && phones(ana.pk)[0] === pushTokenId(tokenOf(ana)), '...one row, keyed by the token\'s id (the token itself sealed)');
    const again = await register(ana, tokenOf(ana));
    assert(again.status === 200 && phones(ana.pk).length === 1, `the same phone again is taken and adds no row (${again.status})`);

    // ── 3. Members and visitors as ever ─────────────────────────────────────────────────────────────────────────────
    const asOwner = await register(owner, tokenOf(owner));
    const vis = newId('Vis');
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, is_visitor) VALUES (?, 'Vis', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1)`).run(vis.pk);
    const asVisitor = await register(vis, tokenOf(vis));
    assert(asOwner.status === 200 && phones(owner.pk).length === 1 && asVisitor.status === 200 && phones(vis.pk).length === 1,
        `a member and a visitor's row register with no request (${asOwner.status}, ${asVisitor.status})`);

    // ── 4. Cancel and decline ───────────────────────────────────────────────────────────────────────────────────────
    const cat = newId('Cat');
    await knockOf(cat);
    await register(cat, tokenOf(cat));
    const hadCat = phones(cat.pk).length;
    const cancelled = await call(cat, 'POST', '/api/join/knock/cancel', {});
    assert(cancelled.status === 200 && hadCat === 1 && phones(cat.pk).length === 0, `cancel my request takes the phone's row (${hadCat} → ${phones(cat.pk).length})`);
    const afterCancel = await register(cat, tokenOf(cat, 2));
    assert(afterCancel.status === 403 && phones(cat.pk).length === 0, `...and a new phone after it is refused, 403 (${afterCancel.status})`);

    const dan = newId('Dan');
    const danKnock = await knockOf(dan);
    await register(dan, tokenOf(dan));
    const hadDan = phones(dan.pk).length;
    const declined = await call(owner, 'POST', `/api/join/knocks/${danKnock}/decline`, {});
    assert(declined.status === 200 && hadDan === 1 && phones(dan.pk).length === 0, `"Not now" takes the phone's row (${hadDan} → ${phones(dan.pk).length})`);
    const afterNo = await register(dan, tokenOf(dan));
    assert(afterNo.status === 200 && afterNo.body?.success === true && afterNo.body?.pushKey === pushKeyHex() && phones(dan.pk).length === 0,
        `a declined key in its block is answered as an open one (a no is never a message), and nothing is kept (${afterNo.status} ${show(afterNo.body)})`);

    // ── 5. A lapse ──────────────────────────────────────────────────────────────────────────────────────────────────
    const eve = newId('Eve');
    const eveKnock = await knockOf(eve);
    await register(eve, tokenOf(eve));
    const hadEve = phones(eve.pk).length;
    db.prepare('UPDATE join_requests SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 31 * DAY_MS).toISOString(), eveKnock);
    tidyKnocks();
    assert(hadEve === 1 && phones(eve.pk).length === 0 && phones(ana.pk).length === 1 && phones(owner.pk).length === 1 && phones(vis.pk).length === 1,
        `a lapsed request's phone goes at the tidy-up; an open one's, a member's and a visitor's stay (${hadEve} → ${phones(eve.pk).length})`);

    // ── 6. The yes buzzes the waiting phone ─────────────────────────────────────────────────────────────────────────
    expo.length = 0;
    const yes = await call(owner, 'POST', `/api/join/knocks/${anaKnock}/approve`, {});
    await settle();
    const toAna = expo.filter((m) => m.to === tokenOf(ana));
    assert(yes.status === 200 && toAna.length === 1 && expo.length === 1, `approve sends one push, to the waiting phone (${yes.status}, ${expo.length})`);
    const words = pushNoticeWords('join.answered', wordsIn('en'));
    const msg = toAna[0];
    assert(msg?.title === words.title && msg?.body === words.body, `the fixed words of join.answered (${show({ title: msg?.title, body: msg?.body })})`);
    const check = verifyPushNotice(msg?.data, { recipient: ana.pk, pushKey: pushKeyHex()! });
    assert(check.ok && check.kind === 'join.answered', `the notice is signed by the node for the asking key (${show(check)})`);
    assert(!verifyPushNotice(msg?.data, { recipient: owner.pk, pushKey: pushKeyHex()! }).ok, '...and fails for any other key');
    const text = JSON.stringify(msg);
    assert(!text.includes(ana.name) && !text.includes(yes.body?.invite?.code ?? '§') && !text.includes(ana.pk) && !text.includes('Owner'),
        'no name, key or invite code in it');
    // Anything else sent to a key with no row reaches none of its phones: only the answer it waits for does.
    expo.length = 0;
    dispatchPushNotification([ana.pk], owner.pk, 'Hello', 'Hello', { screen: 'chat' }, 'chat', 'chat.message');
    await settle();
    assert(expo.length === 0, `a message to the waiting key reaches no phone of its (${expo.length} sent)`);
    tidyKnocks();
    assert(phones(ana.pk).length === 1, 'the waiting phone\'s row stays while the yes\'s invite works');
    const yesAgain = await register(ana, tokenOf(ana));
    assert(yesAgain.status === 200 && phones(ana.pk).length === 1, `...and the same phone registering again (the app's next start) is taken (${yesAgain.status})`);
    db.prepare('UPDATE join_requests SET decided_at = ? WHERE id = ?').run(new Date(Date.now() - 31 * DAY_MS).toISOString(), anaKnock);
    tidyKnocks();
    assert(phones(ana.pk).length === 0, 'once the invite has lapsed unused, the row goes at the tidy-up');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
