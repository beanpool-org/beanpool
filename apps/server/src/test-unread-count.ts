/**
 * GET /api/me/unread: how much waits for a member in one community, in counts alone (chat stage 1, slice S1.2:
 * scratch/fable-design/DESIGN-cross-community-chat-fable.md §1.2 R3, §1.4; Marty, 1 Nov 2026: "never miss a DM"). Over REAL
 * HTTPS through the real signature middleware, signed as both apps sign (format 2, bound to the host):
 *
 *   1. the answer: `unread`, `requests` and `asOf` and nothing else; private, never stored; a line counts until it is read
 *   2. message requests (requests on): a request is in `requests` and never in `unread`; an opened chat with no line, an
 *      ignored request, a blocked sender's and one 30 days old are in neither; accepting one moves its line to `unread`; the
 *      opener never counts their own; and every number is the member's own list's, `totalUnread` and `requests.count`
 *   3. the app icon: a push's badge is `unread`, so the number on the icon and the number here are one
 *   4. a hidden event chat: not counted while it is hidden from them, counted again once it is not
 *   5. who is answered: the signer and nobody else. Unsigned 401; another member's signature on a key 403; a key with no
 *      row, a visitor's row, a closed account and a replaced key 403; a suspended member reads their own; a key named in the
 *      query changes nothing; a replayed request and one signed for another community are refused. The checks hold with
 *      read auth on and opted out (the `readauth-off` run), as the memory read-auth-conversation-hole asks: with it opted
 *      out the route's own checks are all there is
 *   6. the nonce share (member-signature.ts): 60 reads at once, with the throttle and the nonce store as they ship, are
 *      all answered for an established member and for a newcomer, one nonce each. A phone asks at most 12 an hour
 *   7. requests off (the `local` run): `requests` is 0, the list has none, and a request ignored while they were on stays
 *      out of `unread`, as it stays out of the list
 *
 * Run: SERVER_SUITES_ONLY=test-unread-count TEST_ALL_JOBS=2 node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.EXPO_ACCESS_TOKEN;
const LOCAL_RUN = process.env.UNREAD_LOCAL_NODE === '1';
if (LOCAL_RUN) delete process.env.NODE_PROFILE; else process.env.NODE_PROFILE = 'global';

import crypto from 'node:crypto';
import { lockedDm } from './dm-test-payload.js';
import { localFetch } from './keepalive-test-fetch.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
const DAY = 86_400_000;
const ROUTE = '/api/me/unread';
const HOST = 'localhost';
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';
const iso = (ms: number) => new Date(ms).toISOString();
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); await new Promise(r => setTimeout(r, 50)); };

// ── Expo, stubbed: every push the node hands it ─────────────────────────────────────────────────────────────────────
const pushes: { to: string; badge?: number }[] = [];
const realFetch = globalThis.fetch;
(globalThis as any).fetch = async (url: any, init: any) => {
    if (String(url).includes('exp.host')) {
        pushes.push(...JSON.parse(init.body));
        return { ok: true, status: 200, json: async () => ({ data: [] }) } as any;
    }
    return realFetch(url, init);
};

// ── members and signed requests ─────────────────────────────────────────────────────────────────────────────────────
interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}

/** The headers both apps sign with (format 2). `as`: name this key instead of the signer's; `host`: bind to this one. */
function signed(id: Id, method: string, path: string, raw = '', opts: { as?: string; host?: string } = {}): Record<string, string> {
    const ts = String(Date.now());
    const nonce = crypto.randomBytes(16).toString('hex');
    const host = opts.host ?? HOST;
    const text = `beanpool-request/2\n${host}\n${method}\n${path}\n${ts}\n${nonce}\n${raw}`;
    const bytes = Buffer.concat([Buffer.from([0xff]), Buffer.from(text, 'utf8')]);
    return {
        'X-Public-Key': opts.as ?? id.pk, 'X-Signature': crypto.sign(null, bytes, id.priv).toString('base64'),
        'X-Timestamp': ts, 'X-Nonce': nonce, 'X-Signed-For': host,
    };
}

let BASE = '';
/** Puts the minute's throttles back between calls: only section 6 measures them, and it calls `raw` itself. */
let beforeCall: () => void = () => {};
interface Res { status: number; body: any; text: string; headers: Headers }
async function raw(method: string, route: string, headers: Record<string, string>, bodyText?: string): Promise<Res> {
    const res = await localFetch(`${BASE}${route}`, { method, headers, body: bodyText });
    const text = await res.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch { /* empty or not JSON */ }
    return { status: res.status, body, text, headers: res.headers };
}
function call(method: 'GET' | 'POST', id: Id | null, route: string, body?: unknown): Promise<Res> {
    beforeCall();
    const bodyText = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = {
        ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
        ...(id ? signed(id, method, route.split('?')[0], bodyText) : {}),
    };
    return raw(method, route, headers, method === 'GET' ? undefined : bodyText);
}
const show = (r: Res | undefined) => `${r?.status} ${r?.text?.slice(0, 160)}`;

async function main(): Promise<void> {
    const mode = `${LOCAL_RUN ? 'local' : 'global'} profile, read auth ${process.env.ENFORCE_READ_AUTH === 'false' ? 'opted out' : 'on'}`;
    console.log(`\n=== GET /api/me/unread (${mode}) ===\n`);
    if (!process.env.BEANPOOL_DATA_DIR) throw new Error('BEANPOOL_DATA_DIR must be set to a fresh directory');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { setMemberPhoto } = await import('@beanpool/engine');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { resetChatRateLimit } = await import('./chat-rate-limit.js');
    const { requestNonces } = await import('./engine/member-signature.js');
    const { ensureEventThread } = await import('./engine/event-thread.js');
    const { putPushTokenRow } = await import('./services/push-token-seal.js');
    const { wrapCreatePost } = await import('./post-test-helper.js');
    const createPost = wrapCreatePost(se.createPost);
    beforeCall = () => { resetGatewayRateLimit(); resetChatRateLimit(); };

    await initTls();
    se.initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    const owner = newId('Olive');
    se.seedGenesisMember(owner.pk, 'Olive');
    const tokenOf = (id: Id) => `ExponentPushToken[unread-${id.name}]`;

    const member = (name: string, opts: { newcomer?: boolean } = {}): Id => {
        const id = newId(name);
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, is_visitor)
                    VALUES (?, ?, ?, ?, 'TEST', 'active', 0)`)
            .run(id.pk, name, iso(Date.now() - 30 * DAY), owner.pk);
        setMemberPhoto(db, id.pk, `https://example.org/${name}.jpg`);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
        // A member who came in by the 12-words door just now (engine/probation.ts): a newer account's nonce share.
        if (opts.newcomer) {
            db.prepare('UPDATE members SET joined_at = ? WHERE public_key = ?').run(iso(Date.now()), id.pk);
            db.prepare("INSERT INTO open_joins (member_pubkey, provider, join_hash) VALUES (?, 'words', ?)").run(id.pk, crypto.randomBytes(16).toString('hex'));
        }
        return id;
    };

    const unreadOf = (id: Id) => call('GET', id, ROUTE);
    const listOf = async (id: Id) => (await call('GET', id, `/api/messages/conversations/${id.pk}`)).body;
    const open = (a: Id, b: Id) => call('POST', a, '/api/messages/conversation', { type: 'dm', participants: [a.pk, b.pk], createdBy: a.pk });
    const send = (conv: string, author: Id) => call('POST', author, '/api/messages/send', { conversationId: conv, authorPubkey: author.pk, ...lockedDm() });
    const markRead = (id: Id, conversationId: string) => call('POST', id, '/api/messages/mark-read', { pubkey: id.pk, conversationId });
    const decide = (id: Id, conversationId: string, decision: string) => call('POST', id, '/api/messages/request', { conversationId, decision });
    const addFriend = (id: Id, friend: Id) => call('POST', id, '/api/friends/add', { friendPubkey: friend.pk });

    /** The answer, held to the member's own list number for number: what makes a badge one they can open and clear. */
    const counted = async (id: Id, label: string, want: { unread: number; requests: number }): Promise<void> => {
        const answer = await unreadOf(id);
        const list = await listOf(id);
        const listed = { unread: list?.totalUnread, requests: list?.requests?.count ?? 0 };
        assert(answer.status === 200 && answer.body?.unread === want.unread && answer.body?.requests === want.requests
            && listed.unread === want.unread && listed.requests === want.requests,
            `${label}: unread ${want.unread}, requests ${want.requests}, as their list says (${show(answer)}; list ${JSON.stringify(listed)})`);
    };

    const ann = member('Ann');   // the member who asks
    const cy = member('Cy');     // someone she writes with
    await addFriend(ann, cy);
    putPushTokenRow(ann.pk, tokenOf(ann), 'android');

    // ── 1. The answer ─────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('── 1. the answer: counts alone ──');
    await counted(ann, 'nothing waiting', { unread: 0, requests: 0 });
    const cyConv: string = (await open(cy, ann)).body?.conversation?.id;
    await send(cyConv, cy);
    await send(cyConv, cy);
    await counted(ann, 'two lines from Cy', { unread: 2, requests: 0 });
    await counted(cy, 'his own lines are not unread to him', { unread: 0, requests: 0 });

    const before = Date.now();
    const answer = await unreadOf(ann);
    const after = Date.now();
    const asOf = Date.parse(answer.body?.asOf);
    assert(JSON.stringify(Object.keys(answer.body ?? {}).sort()) === JSON.stringify(['asOf', 'requests', 'unread']),
        `three fields and no others (${show(answer)})`);
    assert(new Date(asOf).toISOString() === answer.body?.asOf && asOf >= before - 1 && asOf <= after + 1,
        `asOf is the moment of the count, in ISO 8601 (${answer.body?.asOf})`);
    assert(answer.headers.get('cache-control') === 'private, no-store', `private and never stored (${answer.headers.get('cache-control')})`);
    assert(answer.headers.get('etag') === null, `no tag to keep it by (${answer.headers.get('etag')})`);
    assert(!answer.text.includes(ann.pk) && !answer.text.includes(cy.pk) && !answer.text.includes(cyConv) && !/Ann|Cy/.test(answer.text) && answer.text.length < 100,
        `no key, no name, no chat id, ${answer.text.length} bytes (their whole list is ${JSON.stringify(await listOf(ann)).length})`);
    const conditional = await raw('GET', ROUTE, { ...signed(ann, 'GET', ROUTE), 'If-None-Match': '*', 'If-Modified-Since': new Date().toUTCString() });
    assert(conditional.status === 200 && conditional.body?.unread === 2, `a conditional read is answered in full, never a 304 (${show(conditional)})`);
    await markRead(ann, cyConv);
    await counted(ann, 'Ann read them', { unread: 0, requests: 0 });
    await send(cyConv, cy);
    await counted(ann, 'one more line after she read', { unread: 1, requests: 0 });
    await markRead(ann, cyConv);

    if (!LOCAL_RUN) {
        // ── 2. Message requests ───────────────────────────────────────────────────────────────────────────────────────
        console.log('\n── 2. a request is in `requests`, never in `unread` ──');
        const bo = member('Bo');     // a stranger to her
        const boConv: string = (await open(bo, ann)).body?.conversation?.id;
        await counted(ann, 'an open with no line yet asks her nothing', { unread: 0, requests: 0 });
        await send(boConv, bo);
        await counted(ann, "Bo's first line waits as a request", { unread: 0, requests: 1 });
        await counted(bo, 'an opener never counts their own request', { unread: 0, requests: 0 });
        const annList = await listOf(ann);
        assert(!annList?.conversations?.some((c: any) => c.id === boConv) && annList?.requests?.conversations?.some((c: any) => c.id === boConv),
            'it is the one in her list\'s requests, not among her chats');

        const dee = member('Dee');
        const deeConv: string = (await open(dee, ann)).body?.conversation?.id;
        await send(deeConv, dee);
        await counted(ann, 'a second request', { unread: 0, requests: 2 });
        await decide(ann, deeConv, 'ignore');
        await counted(ann, 'one she ignored is in neither', { unread: 0, requests: 1 });

        const eve = member('Eve');
        const eveConv: string = (await open(eve, ann)).body?.conversation?.id;
        await send(eveConv, eve);
        await counted(ann, 'a third', { unread: 0, requests: 2 });
        await call('POST', ann, '/api/blocks', { targetPubkey: eve.pk });
        await counted(ann, 'one from someone she blocked is in neither', { unread: 0, requests: 1 });

        const fay = member('Fay');
        const fayConv: string = (await open(fay, ann)).body?.conversation?.id;
        await send(fayConv, fay);
        await counted(ann, 'a fourth', { unread: 0, requests: 2 });
        db.prepare('UPDATE dm_requests SET requested_at = ? WHERE conversation_id = ?').run(iso(Date.now() - 31 * DAY), fayConv);
        await counted(ann, 'one 30 days old is in neither', { unread: 0, requests: 1 });

        await decide(ann, boConv, 'accept');
        await counted(ann, 'accepted: Bo\'s line moves from `requests` to `unread`', { unread: 1, requests: 0 });
        await markRead(ann, boConv);
        await counted(ann, 'and clears as any line does', { unread: 0, requests: 0 });
    }

    // ── 3. The app icon ───────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 3. the push\'s badge is the same number ──');
    pushes.length = 0;
    await send(cyConv, cy);
    await flush();
    const badge = pushes.filter(p => p.to === tokenOf(ann)).at(-1)?.badge;
    const iconAnswer = await unreadOf(ann);
    assert(badge === 1 && iconAnswer.body?.unread === badge, `a line's push sets the icon to \`unread\` (badge ${badge}, ${show(iconAnswer)})`);
    await markRead(ann, cyConv);

    // ── 4. A hidden event chat ────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. an event chat hidden from the member is not counted ──');
    const eventPost = createPost('event', 'general', 'Seed swap', 'Swap seeds', 0, 'fixed', cy.pk, -28.6, 153.6, [TINY_PNG], false, undefined, false, {
        eventStartAt: iso(Date.now() + 3 * DAY), eventEndAt: iso(Date.now() + 3 * DAY + 3_600_000),
    } as any)!;
    ensureEventThread(eventPost.id);
    db.prepare('INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(eventPost.id, ann.pk);
    se.sendMessage(eventPost.id, cy.pk, 'See you there', '');
    await counted(ann, 'a line in the chat of an event she is going to', { unread: 1, requests: 0 });
    db.prepare('UPDATE posts SET hidden_by_reports_at = ? WHERE id = ?').run(iso(Date.now()), eventPost.id);
    await counted(ann, 'hidden by reports: the chat and its line are gone from her list and her count', { unread: 0, requests: 0 });
    await counted(cy, 'its host still has it, and his own line is not unread to him', { unread: 0, requests: 0 });
    db.prepare('UPDATE posts SET hidden_by_reports_at = NULL WHERE id = ?').run(eventPost.id);
    await counted(ann, 'shown again: counted again', { unread: 1, requests: 0 });
    await markRead(ann, eventPost.id);

    // ── 5. Who is answered ────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 5. the signer and nobody else ──');
    await send(cyConv, cy);
    const annHas = (await unreadOf(ann)).body?.unread;
    assert(annHas === 1, `Ann has one line waiting, which nobody below may learn (${annHas})`);
    const leaked = (r: Res) => r.text.includes('"unread"');

    const unsigned = await raw('GET', ROUTE, {});
    assert(unsigned.status === 401 && !leaked(unsigned), `unsigned: 401 (${show(unsigned)})`);
    const unsignedHead = await raw('HEAD', ROUTE, {});
    assert(unsignedHead.status === 401, `a HEAD is held as the GET is: 401 (${unsignedHead.status})`);

    const dan = member('Dan');
    const forged = await raw('GET', ROUTE, signed(dan, 'GET', ROUTE, '', { as: ann.pk }));
    assert(forged.status === 403 && !leaked(forged), `another member's signature on Ann's key: 403 (${show(forged)})`);
    const hisOwn = await call('GET', dan, `${ROUTE}?publicKey=${ann.pk}&pubkey=${ann.pk}&member=${ann.pk}`);
    assert(hisOwn.status === 200 && hisOwn.body?.unread === 0, `the route takes no key: naming Ann in the query answers Dan for Dan (${show(hisOwn)})`);

    const stranger = newId('Stranger');
    const noRow = await unreadOf(stranger);
    assert(noRow.status === 403 && noRow.body?.code === 'not_a_member' && !leaked(noRow), `a key with no row: 403 not_a_member (${show(noRow)})`);

    const vee = newId('Vee');
    const veeConv: string = (await open(ann, vee)).body?.conversation?.id;
    await send(veeConv, ann);
    const veeRow = db.prepare('SELECT is_visitor FROM members WHERE public_key = ?').get(vee.pk) as { is_visitor?: number } | undefined;
    const visitor = await unreadOf(vee);
    assert(veeRow?.is_visitor === 1 && visitor.status === 403 && visitor.body?.code === 'not_a_member' && !leaked(visitor),
        `a visitor's row: 403 not_a_member, a line waiting for it or not (row ${JSON.stringify(veeRow)}, ${show(visitor)})`);

    const gus = member('Gus');
    await addFriend(gus, cy);
    const gusConv: string = (await open(cy, gus)).body?.conversation?.id;
    await send(gusConv, cy);
    await counted(gus, 'Gus has a line', { unread: 1, requests: 0 });
    db.prepare("UPDATE members SET status = 'disabled' WHERE public_key = ?").run(gus.pk);
    const paused = await unreadOf(gus);
    assert(paused.status === 200 && paused.body?.unread === 1, `a paused member reads their own count, as they do their own chats (${show(paused)})`);
    db.prepare("UPDATE members SET status = 'active' WHERE public_key = ?").run(gus.pk);

    const hal = member('Hal');
    se.adminPruneUser(hal.pk, 'owner:password');
    const closed = await unreadOf(hal);
    assert(closed.status === 403 && closed.body?.code === 'account_closed' && !leaked(closed), `a closed account: 403 account_closed (${show(closed)})`);

    const ivy = member('Ivy');
    const ivyNew = newId('IvyNew');
    db.prepare("INSERT INTO invalidated_keys (public_key, reason, rekeyed_to) VALUES (?, 'rekey', ?)").run(ivy.pk, ivyNew.pk);
    const replaced = await unreadOf(ivy);
    assert(replaced.status === 403 && replaced.body?.code === 'key_invalidated' && !leaked(replaced), `a replaced key: 403 key_invalidated (${show(replaced)})`);

    const once = signed(ann, 'GET', ROUTE);
    const first = await raw('GET', ROUTE, once);
    const again = await raw('GET', ROUTE, once);
    assert(first.status === 200 && again.status === 403 && !leaked(again), `the same signed request twice: answered once (${first.status}, then ${show(again)})`);
    const elsewhere = await raw('GET', ROUTE, signed(ann, 'GET', ROUTE, '', { host: 'castlemaine.test' }));
    assert(elsewhere.status === 421 && elsewhere.body?.code === 'wrong_community' && !leaked(elsewhere),
        `a request signed for another community is refused here (${show(elsewhere)})`);
    await markRead(ann, cyConv);

    // ── 6. The nonce share ────────────────────────────────────────────────────────────────────────────────────────────
    // Five minutes' calls at once, which is harder on the throttle than five minutes of them: the throttle and the store are
    // as they ship (the throttle is put back once, for a fresh minute, and `raw` doesn't touch it again).
    console.log('\n── 6. the nonce share ──');
    const shares = requestNonces.limits;
    const newcomer = member('Nia', { newcomer: true });
    assert(!(await import('./engine/probation.js')).isEstablishedMember(newcomer.pk), 'Nia holds a newer account\'s share');
    for (const [who, label, share] of [[dan, 'an established member', shares.keyMax], [newcomer, 'a newcomer', shares.newKeyMax]] as const) {
        resetGatewayRateLimit();
        const liveBefore = requestNonces.counts().rows.live;
        let answered = 0;
        for (let i = 0; i < 60; i++) if ((await raw('GET', ROUTE, signed(who, 'GET', ROUTE))).status === 200) answered++;
        const spent = requestNonces.counts().rows.live - liveBefore;
        assert(answered === 60 && spent === 60, `${label}: 60 of 60 answered, one nonce each (${answered} answered, ${spent} spent, share ${share})`);
        const still = await raw('GET', `/api/messages/conversations/${who.pk}`, signed(who, 'GET', `/api/messages/conversations/${who.pk}`));
        assert(still.status === 200, `${label}: their own reads still go through after them (${still.status})`);
    }

    if (LOCAL_RUN) {
        // ── 7. Requests off ───────────────────────────────────────────────────────────────────────────────────────────
        console.log('\n── 7. requests off: `requests` is 0 ──');
        const list = await listOf(ann);
        assert(list && !('requests' in list), 'a local community has requests off: its list has none');
        const kay = member('Kay');
        const kayConv: string = (await open(kay, ann)).body?.conversation?.id;
        await send(kayConv, kay);
        await counted(ann, 'a stranger\'s line is an ordinary line here', { unread: 1, requests: 0 });
        db.prepare(`INSERT INTO dm_requests (conversation_id, from_pubkey, to_pubkey, state, requested_at, decided_at)
                    VALUES (?, ?, ?, 'ignored', ?, ?)`).run(kayConv, kay.pk, ann.pk, iso(Date.now() - DAY), iso(Date.now()));
        await counted(ann, 'one she ignored while they were on stays out of her list and her count', { unread: 0, requests: 0 });
    }
}

main().then(() => {
    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) { console.error(`${run - passed} check(s) failed`); process.exit(1); }
    console.log('⭐️ Unread count checks PASSED.');
    process.exit(0);
}).catch((e) => {
    console.error(e);
    process.exit(1);
});
