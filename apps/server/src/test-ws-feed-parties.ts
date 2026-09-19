/**
 * A private live-feed event goes only to the people it is about.
 *
 * Before this suite, broadcast() sent every event without `recipients` to every member socket, and these
 * passed none: a DM's new_message (who is talking to whom, the ciphertext, and system lines in plaintext),
 * conversation_created, message_reaction, message_edited, and every trade event (both parties, the Beans,
 * the listing). Any member with the app open saw every other member's conversations and trades as they
 * happened. The HTTP routes never allowed that; the feed did.
 *
 * Three signed member sockets A, B, C and one unsigned stranger socket, on the real server, driving real
 * engine paths:
 *   1. a DM between A and B (create, send, react, edit) reaches A and B in full; C gets nothing of it
 *   2. a trade between A and B (request, approve, complete) reaches A and B in full; C gets nothing of the
 *      request and only a bare `{ type }` doorbell for the steps that change the public board
 *   3. a group chat and an event chat reach their members; C, not in either, gets no message payload.
 *      The enterprise thread is public (anyone may read it) and still reaches every member.
 *   4. an application to keep an enterprise reaches the applicant and the lead keeper, not C
 *   5. the stranger gets nothing private (#954's rules still hold)
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-ws-feed-parties.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_WS_AUTH;

import crypto from 'node:crypto';
import net from 'node:net';
import WebSocket from 'ws';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address() as net.AddressInfo;
            s.close(() => resolve(port));
        });
    });
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };
function keypair(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pubKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
}
function signedWsQuery(id: Id): string {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`WS\n/ws\n${ts}\n${nonce}\n`), id.privateKey).toString('base64');
    return `pubkey=${id.pubKeyHex}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`;
}

type Sock = { ws: WebSocket; events: any[]; raw: string[] };
function open(url: string): Promise<Sock> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { rejectUnauthorized: false });
        const s: Sock = { ws, events: [], raw: [] };
        ws.on('message', (d) => { s.raw.push(d.toString()); try { s.events.push(JSON.parse(d.toString())); } catch { /* */ } });
        ws.on('open', () => resolve(s));
        ws.on('unexpected-response', (_q, res) => reject(new Error(`upgrade refused: ${res.statusCode}`)));
        ws.on('error', reject);
    });
}
const types = (s: Sock) => s.events.map(e => e.type);
const clear = (...ss: Sock[]) => { for (const s of ss) { s.events.length = 0; s.raw.length = 0; } };
const bare = (s: Sock, type: string) => s.events.filter(e => e.type === type).every(e => Object.keys(e).length === 1);

async function main() {
    console.log('A private /ws event goes only to its parties...\n');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');

    await initTls();
    se.initStateEngine();
    const port = await freePort();
    await startHttpsServer(port);
    const base = `wss://localhost:${port}`;

    const member = (callsign: string): Id => {
        const id = keypair();
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, avatar_url)
                    VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'seed', 'seed', '/uploads/avatar.jpg')`).run(id.pubKeyHex, callsign);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pubKeyHex);
        return id;
    };
    const A = member('alice'), B = member('bob'), C = member('carol');
    se.transfer('genesis', A.pubKeyHex, 200, 'seed alice', 'direct', true);
    se.transfer('genesis', B.pubKeyHex, 200, 'seed bob', 'direct', true);

    const aWs = await open(`${base}/ws?${signedWsQuery(A)}`);
    const bWs = await open(`${base}/ws?${signedWsQuery(B)}`);
    const cWs = await open(`${base}/ws?${signedWsQuery(C)}`);
    const anon = await open(`${base}/ws`);
    const all = [aWs, bWs, cWs, anon];
    await sleep(150);
    clear(...all);

    // ── 1. A DM between A and B ──
    console.log('— a DM —');
    const conv = se.createConversation('dm', [A.pubKeyHex, B.pubKeyHex], A.pubKeyHex)!;
    const CT = 'dm-ct-' + crypto.randomBytes(4).toString('hex');
    const msg = se.sendMessage(conv.id, A.pubKeyHex, CT, 'nonce-1')!;
    se.toggleMessageReaction(msg.id, B.pubKeyHex, '👍');
    const CT2 = 'dm-ct-edited-' + crypto.randomBytes(4).toString('hex');
    se.editMessage(msg.id, A.pubKeyHex, CT2, 'nonce-2');
    await sleep(300);
    const DM_TYPES = ['conversation_created', 'new_message', 'message_reaction', 'message_edited'];
    for (const [name, s] of [['A', aWs], ['B', bWs]] as const) {
        for (const t of DM_TYPES) assert(types(s).includes(t), `${name} gets ${t}`);
        assert(s.events.some(e => e.type === 'new_message' && e.message?.ciphertext === CT && e.conversationId === conv.id
            && Array.isArray(e.participants) && e.participants.includes(A.pubKeyHex) && e.participants.includes(B.pubKeyHex)),
            `${name} gets new_message with the full payload (message, conversation, participants)`);
        assert(s.events.some(e => e.type === 'message_edited' && e.message?.ciphertext === CT2), `${name} gets the edit in full`);
    }
    for (const [name, s] of [['C (a member, not in the DM)', cWs], ['the stranger', anon]] as const) {
        for (const t of DM_TYPES) assert(!types(s).includes(t), `${name} gets no ${t} (got [${types(s).join(', ')}])`);
        for (const secret of [CT, CT2, conv.id]) assert(!s.raw.some(r => r.includes(secret)), `${name} never sees ${secret.slice(0, 16)}…`);
    }

    // ── 2. A trade between A and B ──
    console.log('\n— a trade —');
    clear(...all);
    const TITLE = 'Ironbark firewood ' + crypto.randomBytes(3).toString('hex');
    const post = se.createPost('offer', 'goods', TITLE, 'seasoned', 30, 'fixed', A.pubKeyHex)!;
    se.createPost('offer', 'services', 'Mowing', 'lawns', 10, 'fixed', B.pubKeyHex); // B has an offer listed, so may request
    await sleep(150);
    clear(...all);

    const tx = se.requestPost(post.id, B.pubKeyHex);
    await sleep(200);
    for (const [name, s] of [['A', aWs], ['B', bWs]] as const) {
        assert(s.events.some(e => e.type === 'transaction_requested' && e.transaction?.id === tx.id
            && e.transaction.buyerPublicKey === B.pubKeyHex && e.transaction.sellerPublicKey === A.pubKeyHex && e.transaction.credits === 30),
            `${name} gets transaction_requested with the full transaction`);
    }
    for (const [name, s] of [['C', cWs], ['the stranger', anon]] as const) {
        assert(!types(s).includes('transaction_requested'), `${name} gets no transaction_requested (nothing public changed)`);
    }

    clear(...all);
    se.approvePostRequest(tx.id, A.pubKeyHex);
    await sleep(250);
    for (const [name, s] of [['A', aWs], ['B', bWs]] as const) {
        assert(s.events.some(e => e.type === 'post_accepted' && e.postId === post.id && e.transaction?.id === tx.id), `${name} gets post_accepted in full`);
    }
    assert(types(cWs).includes('post_accepted') && bare(cWs, 'post_accepted'),
        `C gets post_accepted only as a bare doorbell (the listing went pending on the board) — got ${JSON.stringify(cWs.events.filter(e => e.type === 'post_accepted'))}`);
    assert(!types(cWs).includes('new_message'), "C does not get the escrow system line in A and B's DM");

    clear(...all);
    const done = se.completePostTransaction(tx.id, B.pubKeyHex);
    assert(!!done && done.status === 'completed', 'setup: the buyer completes the trade');
    await sleep(250);
    for (const [name, s] of [['A', aWs], ['B', bWs]] as const) {
        assert(s.events.some(e => e.type === 'transaction_completed' && e.transaction?.id === tx.id && e.transaction.credits === 30), `${name} gets transaction_completed in full`);
    }
    assert(types(cWs).includes('transaction_completed') && bare(cWs, 'transaction_completed'), 'C gets transaction_completed only as a bare doorbell');
    for (const [name, s] of [['C', cWs], ['the stranger', anon]] as const) {
        for (const secret of [tx.id, TITLE, B.pubKeyHex]) assert(!s.raw.some(r => r.includes(secret)), `${name} never sees ${secret.slice(0, 16)}… from the trade`);
    }
    for (const t of ['transaction_requested', 'post_accepted', 'transaction_completed', 'new_message']) {
        assert(!types(anon).includes(t), `the stranger gets no ${t} at all`);
    }

    // ── 3. Threads ──
    console.log('\n— threads —');
    clear(...all);
    const group = se.createGroup({ name: 'Quiet Room', joinPolicy: 'request_to_join', createdBy: A.pubKeyHex } as any);
    se.joinGroup(group.id, B.pubKeyHex);
    se.approveGroupMember(group.id, A.pubKeyHex, B.pubKeyHex);
    const GTEXT = 'group-line-' + crypto.randomBytes(4).toString('hex');
    se.postGroupThreadMessage(group.id, B.pubKeyHex, GTEXT);

    const ev = se.createPost('event', 'social', 'Street picnic', 'Bring a plate', 0, 'fixed', A.pubKeyHex, -28.55, 153.5,
        undefined, undefined, undefined, undefined, { eventStartAt: new Date(Date.now() + 86_400_000).toISOString(), eventPlaceName: 'The park' })!;
    se.rsvpEvent(ev.id, B.pubKeyHex, 'going');
    const ETEXT = 'event-line-' + crypto.randomBytes(4).toString('hex');
    se.postEventThreadMessage(ev.id, B.pubKeyHex, ETEXT);

    const ent = se.createTreasury('Bakery', '/uploads/avatar.jpg', 0, { leadKeeperPubkey: A.pubKeyHex }).publicKey;
    const XTEXT = 'enterprise-line-' + crypto.randomBytes(4).toString('hex');
    se.postEnterpriseThreadMessage(ent, B.pubKeyHex, XTEXT);
    await sleep(300);

    const hasLine = (s: Sock, text: string) => s.events.some(e => e.type === 'new_message' && JSON.stringify(e.message ?? {}).includes(text));
    for (const [name, s] of [['A', aWs], ['B', bWs]] as const) {
        assert(s.raw.some(r => r.includes(GTEXT)) || hasLine(s, Buffer.from(GTEXT).toString('base64')), `${name} (in the group) gets the group chat line`);
        assert(s.raw.some(r => r.includes(ETEXT)) || hasLine(s, Buffer.from(ETEXT).toString('base64')), `${name} (host / Going) gets the event chat line`);
    }
    for (const [name, s] of [['C', cWs], ['the stranger', anon]] as const) {
        for (const text of [GTEXT, ETEXT]) {
            assert(!s.raw.some(r => r.includes(text) || r.includes(Buffer.from(text).toString('base64'))), `${name} never sees ${text.slice(0, 12)}…`);
        }
        assert(!s.events.some(e => e.type === 'new_message' && (e.conversationId === group.id || e.conversationId === ev.id)),
            `${name} gets no new_message for the group or the event chat`);
    }
    assert(cWs.events.some(e => e.type === 'new_message' && e.conversationId === ent), 'C still gets the enterprise thread line (the thread is public to read)');
    assert(!anon.raw.some(r => r.includes(XTEXT) || r.includes(Buffer.from(XTEXT).toString('base64'))) && !types(anon).includes('new_message'),
        'the stranger gets no enterprise thread line');

    // ── 4. An application to keep an enterprise ──
    console.log('\n— a keeper application —');
    clear(...all);
    const req = se.requestToJoinEnterprise(ent, B.pubKeyHex, 0);
    await sleep(200);
    for (const [name, s] of [['A (lead keeper)', aWs], ['B (applicant)', bWs]] as const) {
        assert(s.events.some(e => e.type === 'enterprise_keeper_request_created' && e.requestId === req.id && e.memberPubkey === B.pubKeyHex),
            `${name} gets enterprise_keeper_request_created in full`);
    }
    for (const [name, s] of [['C', cWs], ['the stranger', anon]] as const) {
        assert(!types(s).includes('enterprise_keeper_request_created'), `${name} gets no keeper application`);
    }
    clear(...all);
    se.declineKeeperRequest(req.id, A.pubKeyHex);
    await sleep(200);
    assert(types(bWs).includes('enterprise_keeper_declined'), 'the applicant hears it was declined');
    assert(!types(cWs).includes('enterprise_keeper_declined'), 'C does not');

    // ── 5. Community events still reach every member ──
    clear(...all);
    const NEWS = 'meeting-' + crypto.randomBytes(4).toString('hex');
    se.adminBroadcastAnnouncement(NEWS, 'at the hall', 'info');
    await sleep(200);
    assert(cWs.events.some(e => e.type === 'system_announcement' && e.title === NEWS), 'C still gets a community-wide announcement in full');
    assert(!anon.raw.some(r => r.includes(NEWS)), 'the stranger still does not');
    assert(anon.events.every(e => Object.keys(e).length === 1), 'the stranger gets bare doorbells only');

    for (const s of all) s.ws.close();
    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ /ws private events reach only their parties.');
}
main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
