/**
 * Blocking someone stops their direct messages and their pushes on the node, not just on the blocker's screen (MEDIUM-5
 * of scratch/reviews/FABLE-sec-global-abuse.md; engine/withheld-lines.ts, engine/member-blocks.ts).
 *
 * Over REAL HTTPS through the real signature middleware, with signed member sockets and Expo stubbed:
 *
 *   1. before any block, a DM line reaches its recipient: their list, their unread count, a push (the stub works)
 *   2. a blocked member opens a DM with the blocker: answered as any new conversation is, announced to their own sockets
 *      only; the blocker's list, sockets and pushes show nothing; asked again, the same conversation
 *   3. they send lines into it, a photo among them, and retry one: each answered as a stored line is; nothing in
 *      `messages`; the blocker's list, unread count, sockets and pushes show nothing, and their read of the conversation
 *      id is the answer an id nobody has gets; the sender reads their lines back, and their photo, and nobody else does
 *   4. in a conversation the two already had: a new line, an edit of a line the blocker can see and a reaction on the
 *      blocker's line reach the blocker not at all; the sender edits and deletes their own withheld line as any line
 *   5. after the unblock nothing old arrives: the blocker's list, lines and badge are as they were; a line sent after it
 *      arrives alone, with a push, in the conversation the sender opened while blocked (the same id)
 *   6. a group @mention by a blocked member pushes the blocker nothing (an ordinary line neither); another member's does
 *   7. a deal request from a blocked member waits with no push; anyone else's pushes
 *   8. a listing addressed to the blocker is refused as one to someone who isn't here
 *   9. a member of another community, relayed by a peer, is withheld as a member here is
 *  10. a standby's copy carries no withheld line or conversation; a prune takes the member's own
 *  11. pushes that aren't a blocked member's words still come: a vote to replace a convenor, the admin page's message
 *
 * Run: ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-blocks-on-messaging.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.ENFORCE_READ_AUTH;
const PW = 'BlocksOnMessagingPass123!';
process.env.ADMIN_PASSWORD = PW;

import crypto from 'node:crypto';
import WebSocket from 'ws';
import { initTls } from './services/tls.js';
import {
    initStateEngine, seedGenesisMember, adminPruneUser, exportSyncState, createGroup, joinGroup, createPost, requestPost,
    createConversation, sendMessage, transfer, getAdminPubkey,
} from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { initAdminPassword } from './config/local-config.js';
import { db } from './db/db.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { registerVisitor } from './engine/members.js';
import { lockedDm } from './dm-test-payload.js';
import { getFirstNodeAdminPubkey } from './engine/node-roles.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
/** A step that throws on a tree without withheld lines (no such table) must fail its assertion, not abort the run. */
function attempt<T>(fn: () => T): T | undefined {
    try { return fn(); } catch (e: any) { console.error(`  (threw: ${e?.message})`); return undefined; }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let BASE = '';

// ── Expo, stubbed: every push the node hands it, by token ───────────────────────────────────────
const realFetch = globalThis.fetch;
const pushes: { to: string; title: string; body: string; data: any }[] = [];
(globalThis as any).fetch = async (url: any, init: any) => {
    if (String(url).includes('exp.host')) {
        pushes.push(...JSON.parse(init.body));
        return { ok: true, status: 200, json: async () => ({}) } as any;
    }
    return realFetch(url, init);
};
const tokenOf = (id: Id) => `ExponentPushToken[${id.name}]`;
const pushesTo = (id: Id) => pushes.filter(p => p.to === tokenOf(id));

// ── members and signed requests ─────────────────────────────────────────────────────────────────
interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}
let owner: Id;
function member(name: string): Id {
    const id = newId(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, is_visitor, avatar_url)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'TEST', 'active', 0, ?)`)
        .run(id.pk, name, owner.pk, `https://example.org/${name}.jpg`);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
    db.prepare(`INSERT OR REPLACE INTO push_tokens (public_key, token, platform) VALUES (?, ?, 'android')`).run(id.pk, tokenOf(id));
    return id;
}

interface Res { status: number; body: any }
async function call(method: 'GET' | 'POST', id: Id | null, path: string, body?: unknown): Promise<Res> {
    resetGatewayRateLimit();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = method === 'GET' ? {} : { 'Content-Type': 'application/json' };
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await realFetch(`${BASE}${path}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* empty or not JSON */ }
    return { status: res.status, body: parsed };
}
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 160)}`;
const keysOf = (o: any) => Object.keys(o ?? {}).sort().join(',');

// ── signed member sockets ───────────────────────────────────────────────────────────────────────
type Sock = { ws: WebSocket; events: any[] };
function socket(id: Id): Promise<Sock> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`WS\n/ws\n${ts}\n${nonce}\n`), id.priv).toString('base64');
    const url = `${BASE.replace('https', 'wss')}/ws?pubkey=${id.pk}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`;
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { rejectUnauthorized: false });
        const s: Sock = { ws, events: [] };
        ws.on('message', (d) => { try { s.events.push(JSON.parse(d.toString())); } catch { /* */ } });
        ws.on('open', () => resolve(s));
        ws.on('error', reject);
    });
}
/** Any event on this socket that names one of these ids. */
const heard = (s: Sock, ...ids: string[]) => s.events.filter(e => ids.some(id => id && JSON.stringify(e).includes(id)));

// ── what a member reads ─────────────────────────────────────────────────────────────────────────
const listOf = async (id: Id) => (await call('GET', id, `/api/messages/conversations/${id.pk}`)).body;
const linesOf = async (id: Id, conv: string) => (await call('GET', id, `/api/messages/${conv}`)).body?.messages?.map((m: any) => m.id) ?? null;
const inMessages = (ids: string[]) => ids.filter(Boolean).filter(i => db.prepare('SELECT 1 FROM messages WHERE id = ?').get(i)).length;
const dm = (conversationId: string, author: Id, extra: Record<string, unknown> = {}) =>
    ({ conversationId, authorPubkey: author.pk, ...lockedDm(), ...extra });

async function main(): Promise<void> {
    console.log('\n=== Blocking stops messages and notifications on the node ===\n');
    initAdminPassword();
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive');
    const ann = member('Ann');   // blocks
    const bo = member('Bo');     // blocked, no conversation with Ann
    const dee = member('Dee');   // blocked, a conversation with Ann from before
    const cy = member('Cy');     // never blocked
    const annSock = await socket(ann);
    const boSock = await socket(bo);
    const deeSock = await socket(dee);
    await sleep(100);

    // ── 1. before any block ─────────────────────────────────────────────────────────────────────
    console.log('── 1. before any block ──');
    const dd = await call('POST', dee, '/api/messages/conversation', { type: 'dm', participants: [dee.pk, ann.pk], createdBy: dee.pk });
    const deeConv: string = dd.body?.conversation?.id;
    const d1 = await call('POST', dee, '/api/messages/send', dm(deeConv, dee));
    const a1 = await call('POST', ann, '/api/messages/send', dm(deeConv, ann));
    await sleep(150);
    const annList0 = await listOf(ann);
    assert(d1.status === 200 && !!annList0?.conversations?.some((c: any) => c.id === deeConv) && annList0.totalUnread === 1,
        `Dee's line reaches Ann: in her list, one unread (${show(d1)}; unread ${annList0?.totalUnread})`);
    assert(pushesTo(ann).length === 1, `and a push (the stub hears the dispatcher: ${pushesTo(ann).length})`);
    await call('POST', ann, '/api/messages/mark-read', { conversationId: deeConv });
    // The answers a stored line and a new conversation get, to hold the withheld ones to.
    const cc = await call('POST', cy, '/api/messages/conversation', { type: 'dm', participants: [cy.pk, dee.pk], createdBy: cy.pk });
    const cs = await call('POST', cy, '/api/messages/send', dm(cc.body?.conversation?.id, cy));

    const blk = await call('POST', ann, '/api/blocks', { targetPubkey: bo.pk });
    const blk2 = await call('POST', ann, '/api/blocks', { targetPubkey: dee.pk });
    assert(blk.status === 200 && blk2.status === 200, `Ann blocks Bo and Dee (${show(blk)})`);
    const pushesBefore = pushesTo(ann).length;
    annSock.events.length = 0;
    const annUnreadBefore = (await listOf(ann))?.totalUnread;

    // ── 2. a blocked member opens a DM ──────────────────────────────────────────────────────────
    console.log('── 2. a blocked member opens a DM ──');
    const bc = await call('POST', bo, '/api/messages/conversation', { type: 'dm', participants: [bo.pk, ann.pk], createdBy: bo.pk });
    const boConv: string = bc.body?.conversation?.id;
    assert(bc.status === 200 && bc.body?.success === true && !!boConv && keysOf(bc.body) === keysOf(cc.body)
        && keysOf(bc.body.conversation) === keysOf(cc.body.conversation) && bc.body.conversation.participants?.includes(ann.pk),
        `answered as any new conversation is (${show(bc)})`);
    const again = await call('POST', bo, '/api/messages/conversation', { type: 'dm', participants: [ann.pk, bo.pk], createdBy: bo.pk });
    assert(again.status === 200 && again.body?.conversation?.id === boConv, 'asked again, the same conversation');
    await sleep(150);
    assert(!(await listOf(ann))?.conversations?.some((c: any) => c.id === boConv), "it isn't in Ann's list");
    assert(heard(annSock, boConv).length === 0, `Ann's socket hears nothing of it (${heard(annSock, boConv).length})`);
    assert(boSock.events.some(e => e.type === 'conversation_created' && e.conversation?.id === boConv), 'Bo hears of it, as of any new conversation');
    const boList = await listOf(bo);
    const boEntry = boList?.conversations?.find((c: any) => c.id === boConv);
    assert(!!boEntry && boEntry.peerCallsign === 'Ann' && boEntry.participants?.includes(ann.pk), `it is in Bo's own list, with Ann (${JSON.stringify(boEntry)?.slice(0, 120)})`);

    // ── 3. lines into it ────────────────────────────────────────────────────────────────────────
    console.log('── 3. lines into it ──');
    const photo = lockedDm(64);
    const retryId = crypto.randomUUID();
    const b1 = await call('POST', bo, '/api/messages/send', dm(boConv, bo));
    await sleep(5);
    const b2 = await call('POST', bo, '/api/messages/send', dm(boConv, bo, { id: retryId }));
    const b2again = await call('POST', bo, '/api/messages/send', dm(boConv, bo, { id: retryId }));
    await sleep(5);
    const b3 = await call('POST', bo, '/api/messages/send', dm(boConv, bo, { type: 'image', attachment: { data: photo.ciphertext, nonce: photo.nonce, mime: 'image/jpeg' } }));
    const boIds: string[] = [b1, b2, b3].map(r => r.body?.message?.id);
    assert([b1, b2, b3].every(r => r.status === 200 && r.body?.success === true && keysOf(r.body) === keysOf(cs.body)
        && keysOf(r.body.message) === keysOf(cs.body.message) && r.body.message.conversationId === boConv),
        `each answered as a stored line is (${show(b1)})`);
    assert(b2again.status === 200 && b2again.body?.message?.id === retryId && b2again.body.message.timestamp === b2.body?.message?.timestamp,
        'a retry with the same id is answered with the same line');
    assert(inMessages(boIds) === 0, `none of them is in \`messages\` (${inMessages(boIds)})`);
    const kept = attempt(() => (db.prepare('SELECT COUNT(*) AS n FROM withheld_lines WHERE conversation_id = ?').get(boConv) as { n: number }).n);
    assert(kept === 3, `three lines kept for Bo alone, the retry once (${kept})`);
    await sleep(150);
    const annList3 = await listOf(ann);
    assert(!annList3?.conversations?.some((c: any) => c.id === boConv) && annList3?.totalUnread === annUnreadBefore,
        `Ann's list and unread count are as they were (${annList3?.totalUnread})`);
    assert(pushesTo(ann).length === pushesBefore, `no push to Ann (${pushesTo(ann).length - pushesBefore})`);
    assert(heard(annSock, boConv, ...boIds).length === 0, 'her socket hears nothing');
    const unknown = await call('GET', ann, `/api/messages/${crypto.randomUUID()}`);
    const annRead = await call('GET', ann, `/api/messages/${boConv}`);
    assert(annRead.status === unknown.status && JSON.stringify(annRead.body) === JSON.stringify(unknown.body),
        `Ann's read of the conversation is the answer an id nobody has gets (${show(annRead)})`);
    const boRead = await call('GET', bo, `/api/messages/${boConv}`);
    assert(boRead.status === 200 && JSON.stringify(boRead.body?.messages?.map((m: any) => m.id)) === JSON.stringify(boIds)
        && boRead.body?.conversation?.participants?.includes(ann.pk),
        `Bo reads his three lines back, in order (${show(boRead)})`);
    const boPhoto = await call('GET', bo, `/api/messages/${boIds[2]}/attachment`);
    const annPhoto = await call('GET', ann, `/api/messages/${boIds[2]}/attachment`);
    const anonPhoto = await call('GET', null, `/api/messages/${boIds[2]}/attachment`);
    assert(boPhoto.status === 200 && boPhoto.body?.data === photo.ciphertext && boPhoto.body?.nonce === photo.nonce,
        `Bo's photo comes back to him (${show(boPhoto)})`);
    assert(annPhoto.status === 404 && anonPhoto.status === 404, `to nobody else (${annPhoto.status}, ${anonPhoto.status})`);
    const boMark = await call('POST', bo, '/api/messages/mark-read', { conversationId: boConv });
    assert(boMark.status === 200, `Bo marks it read as any chat (${show(boMark)})`);
    // Mute and his own read marker answer and show as a real conversation's do (#1403 review, NON-BLOCKING): Cy's chat
    // with Dee is the control.
    const ccConv: string = cc.body?.conversation?.id;
    await call('POST', cy, '/api/messages/mark-read', { conversationId: ccConv });
    const ctrlMute = await call('POST', cy, '/api/messages/mute', { conversationId: ccConv, duration: '8h' });
    const boMute = await call('POST', bo, '/api/messages/mute', { conversationId: boConv, duration: '8h' });
    assert(boMute.status === ctrlMute.status && boMute.status === 200 && keysOf(boMute.body) === keysOf(ctrlMute.body)
        && keysOf(boMute.body?.mute) === keysOf(ctrlMute.body?.mute) && boMute.body?.mute?.conversationId === boConv,
        `Bo mutes it as any chat (${show(boMute)}; control ${show(ctrlMute)})`);
    const boEntry3 = (await listOf(bo))?.conversations?.find((c: any) => c.id === boConv);
    const cyEntry3 = (await listOf(cy))?.conversations?.find((c: any) => c.id === ccConv);
    assert(!!boEntry3?.mute && !!cyEntry3?.mute && keysOf(boEntry3.mute) === keysOf(cyEntry3.mute) && !!boEntry3.myLastReadAt && !!cyEntry3?.myLastReadAt,
        `his list shows the mute and his read marker, as Cy's does (${JSON.stringify(boEntry3?.mute)}, ${boEntry3?.myLastReadAt})`);
    const boCursor = (await call('GET', bo, `/api/messages/${boConv}`)).body?.conversation?.readCursors?.find((r: any) => r.publicKey === bo.pk);
    const cyCursor = (await call('GET', cy, `/api/messages/${ccConv}`)).body?.conversation?.readCursors?.find((r: any) => r.publicKey === cy.pk);
    assert(!!boCursor?.lastReadAt && !!cyCursor?.lastReadAt, `and so does his read of it (${JSON.stringify(boCursor)})`);
    const boUnmute = await call('POST', bo, '/api/messages/mute', { conversationId: boConv, duration: 'off' });
    const ctrlUnmute = await call('POST', cy, '/api/messages/mute', { conversationId: ccConv, duration: 'off' });
    assert(boUnmute.status === 200 && JSON.stringify(boUnmute.body) === JSON.stringify(ctrlUnmute.body)
        && !(await listOf(bo))?.conversations?.find((c: any) => c.id === boConv)?.mute, `and unmutes it (${show(boUnmute)})`);

    // ── 4. a conversation the two already had ───────────────────────────────────────────────────
    console.log('── 4. a conversation the two already had ──');
    const annLines4 = await linesOf(ann, deeConv);
    const d2 = await call('POST', dee, '/api/messages/send', dm(deeConv, dee));
    const d2id: string = d2.body?.message?.id;
    const firstLine: string = d1.body?.message?.id;
    const annLine: string = a1.body?.message?.id;
    const before4 = db.prepare('SELECT ciphertext, metadata, edited_at FROM messages WHERE id = ?').get(firstLine) as any;
    const ed = await call('POST', dee, '/api/messages/edit', { messageId: firstLine, ...lockedDm() });
    const re = await call('POST', dee, '/api/messages/react', { messageId: annLine, authorPubkey: dee.pk, emoji: '😠' });
    await sleep(150);
    assert(d2.status === 200 && d2.body?.success === true && inMessages([d2id]) === 0, `Dee's new line is answered as stored, and isn't (${show(d2)})`);
    assert(ed.status === 200 && ed.body?.success === true && re.status === 200 && re.body?.success === true,
        `her edit of a line Ann can see, and her reaction on Ann's, are answered as made (${show(ed)}, ${show(re)})`);
    const after4 = db.prepare('SELECT ciphertext, metadata, edited_at FROM messages WHERE id = ?').get(firstLine) as any;
    const annMeta = (db.prepare('SELECT metadata FROM messages WHERE id = ?').get(annLine) as any)?.metadata ?? '';
    assert(JSON.stringify(after4) === JSON.stringify(before4) && !String(annMeta).includes(dee.pk), 'neither changed what Ann has');
    assert(JSON.stringify(await linesOf(ann, deeConv)) === JSON.stringify(annLines4) && (await listOf(ann))?.totalUnread === annUnreadBefore
        && pushesTo(ann).length === pushesBefore && heard(annSock, d2id, firstLine, annLine).length === 0,
        "Ann's lines, unread count, pushes and socket are as they were");
    const deeLines = await linesOf(dee, deeConv);
    assert(JSON.stringify(deeLines) === JSON.stringify([firstLine, annLine, d2id]), `Dee reads her line among the others (${JSON.stringify(deeLines)})`);

    // Her reaction and her edit stay as made on her own screen (#1403 review, BLOCKING 1 and 2): a sender-only overlay,
    // merged into her reads and heard on her own sockets, the same in shape as a control's (Cy has blocked nobody).
    const ccId: string = cc.body?.conversation?.id;
    const ctrlLine = await call('POST', dee, '/api/messages/send', dm(ccId, dee));
    const ctrlEd = await call('POST', dee, '/api/messages/edit', { messageId: ctrlLine.body?.message?.id, ...lockedDm() });
    const ctrlRe = await call('POST', dee, '/api/messages/react', { messageId: cs.body?.message?.id, authorPubkey: dee.pk, emoji: '😠' });
    await sleep(150);
    const deeRead4 = (await call('GET', dee, `/api/messages/${deeConv}`)).body?.messages ?? [];
    const deeFirst = deeRead4.find((m: any) => m.id === firstLine);
    const deeOnAnn = deeRead4.find((m: any) => m.id === annLine);
    const reactionsOf = (m: any) => { try { return JSON.parse(m?.metadata ?? '{}')?.reactions ?? []; } catch { return []; } };
    assert(!!deeFirst && deeFirst.ciphertext === ed.body?.message?.ciphertext && deeFirst.nonce === ed.body?.message?.nonce
        && deeFirst.editedAt === ed.body?.message?.editedAt && !!deeFirst.editedAt,
        `Dee's next read shows her edit, as made (${JSON.stringify(deeFirst)?.slice(0, 140)})`);
    assert(reactionsOf(deeOnAnn).some((r: any) => r.author === dee.pk && r.emoji === '😠') && deeOnAnn?.metadata === re.body?.metadata,
        `and her reaction on Ann's line, as the answer had it (${deeOnAnn?.metadata})`);
    const ownEvent = (s: Sock, type: string, id: string) => s.events.filter(e => e.type === type && (e.messageId === id || e.message?.id === id));
    const reEv = ownEvent(deeSock, 'message_reaction', annLine), edEv = ownEvent(deeSock, 'message_edited', firstLine);
    const ctrlReEv = ownEvent(deeSock, 'message_reaction', cs.body?.message?.id), ctrlEdEv = ownEvent(deeSock, 'message_edited', ctrlLine.body?.message?.id);
    assert(reEv.length === 1 && edEv.length === 1 && reEv[0].metadata === re.body?.metadata && edEv[0].message?.ciphertext === ed.body?.message?.ciphertext,
        `her own sockets hear each once (${reEv.length} reaction, ${edEv.length} edit)`);
    assert(ctrlReEv.length === 1 && ctrlEdEv.length === 1 && keysOf(reEv[0]) === keysOf(ctrlReEv[0]) && keysOf(edEv[0]) === keysOf(ctrlEdEv[0])
        && keysOf(edEv[0]?.message) === keysOf(ctrlEdEv[0]?.message) && reEv[0].participants?.length === 2 && edEv[0].participants?.length === 2,
        `in the shape a control's events have (${keysOf(reEv[0])} / ${keysOf(ctrlReEv[0])})`);
    assert(keysOf(re.body) === keysOf(ctrlRe.body) && keysOf(ed.body) === keysOf(ctrlEd.body) && keysOf(ed.body?.message) === keysOf(ctrlEd.body?.message),
        `and the answers have a control's shape (${keysOf(ed.body?.message)} / ${keysOf(ctrlEd.body?.message)})`);
    // Another emoji replaces hers on her screen; the same again takes it away; Ann's row never changes.
    const re2 = await call('POST', dee, '/api/messages/react', { messageId: annLine, authorPubkey: dee.pk, emoji: '👍' });
    const seen2 = (await call('GET', dee, `/api/messages/${deeConv}`)).body?.messages?.find((m: any) => m.id === annLine);
    const re3 = await call('POST', dee, '/api/messages/react', { messageId: annLine, authorPubkey: dee.pk, emoji: '👍' });
    const seen3 = (await call('GET', dee, `/api/messages/${deeConv}`)).body?.messages?.find((m: any) => m.id === annLine);
    assert(re2.status === 200 && reactionsOf(seen2).filter((r: any) => r.author === dee.pk).map((r: any) => r.emoji).join() === '👍'
        && re3.status === 200 && !reactionsOf(seen3).some((r: any) => r.author === dee.pk),
        `she changes it and takes it back, as anyone does (${seen2?.metadata}; ${seen3?.metadata})`);
    const re4 = await call('POST', dee, '/api/messages/react', { messageId: annLine, authorPubkey: dee.pk, emoji: '😠' });
    await sleep(100);
    const annMetaNow = (db.prepare('SELECT metadata FROM messages WHERE id = ?').get(annLine) as any)?.metadata ?? '';
    const annRead4 = (await call('GET', ann, `/api/messages/${deeConv}`)).body?.messages ?? [];
    assert(re4.status === 200 && !String(annMetaNow).includes(dee.pk)
        && !String(annRead4.find((m: any) => m.id === annLine)?.metadata ?? '').includes(dee.pk)
        && annRead4.find((m: any) => m.id === firstLine)?.ciphertext === before4.ciphertext
        && heard(annSock, firstLine, annLine).length === 0,
        "none of it reaches Ann's row, her read or her socket");
    const ownEd = await call('POST', dee, '/api/messages/edit', { messageId: d2id, ...lockedDm() });
    const ownDel = await call('POST', dee, '/api/messages/delete', { messageId: d2id });
    const deeView = (await call('GET', dee, `/api/messages/${deeConv}`)).body?.messages?.find((m: any) => m.id === d2id);
    assert(ownEd.status === 200 && !!ownEd.body?.message?.editedAt && ownDel.status === 200 && ownDel.body?.message?.type === 'removed'
        && deeView?.type === 'removed', `she edits and deletes her own withheld line as any line (${show(ownEd)}, ${show(ownDel)})`);
    const ctrlDel = await call('POST', dee, '/api/messages/delete', { messageId: ctrlLine.body?.message?.id });
    const ownDelAgain = await call('POST', dee, '/api/messages/delete', { messageId: d2id });
    const ctrlDelAgain = await call('POST', dee, '/api/messages/delete', { messageId: ctrlLine.body?.message?.id });
    assert(keysOf(ownDel.body?.message) === keysOf(ctrlDel.body?.message) && ownDel.body?.message?.systemType === null
        && keysOf(ownDelAgain.body?.message) === keysOf(ctrlDelAgain.body?.message) && ownDelAgain.body?.message?.systemType === null,
        `the delete answers, first and again, have a stored line's shape, systemType null (${keysOf(ownDel.body?.message)})`);
    const annDel = await call('POST', ann, '/api/messages/delete', { messageId: boIds[0] });
    const nobodyDel = await call('POST', ann, '/api/messages/delete', { messageId: crypto.randomUUID() });
    assert(annDel.status === nobodyDel.status && JSON.stringify(annDel.body) === JSON.stringify(nobodyDel.body),
        `to Ann a withheld line's id is one nobody has (${show(annDel)})`);

    // ── 5. the unblock ──────────────────────────────────────────────────────────────────────────
    console.log('── 5. after the unblock ──');
    await call('POST', ann, '/api/blocks/remove', { targetPubkey: bo.pk });
    await call('POST', ann, '/api/blocks/remove', { targetPubkey: dee.pk });
    const annList5 = await listOf(ann);
    assert(!annList5?.conversations?.some((c: any) => c.id === boConv) && annList5?.totalUnread === annUnreadBefore
        && JSON.stringify(await linesOf(ann, deeConv)) === JSON.stringify(annLines4),
        "nothing old arrives: Ann's list, lines and badge are as they were");
    const b4 = await call('POST', bo, '/api/messages/send', dm(boConv, bo));
    const d3 = await call('POST', dee, '/api/messages/send', dm(deeConv, dee));
    await sleep(150);
    const annList6 = await listOf(ann);
    assert(b4.status === 200 && annList6?.conversations?.some((c: any) => c.id === boConv),
        `Bo's next line opens the conversation for Ann, under the same id (${show(b4)})`);
    assert(JSON.stringify(await linesOf(ann, boConv)) === JSON.stringify([b4.body?.message?.id]), 'and it holds that line alone');
    assert(JSON.stringify(await linesOf(ann, deeConv)) === JSON.stringify([...annLines4, d3.body?.message?.id]), "Dee's next line follows her old ones, without the withheld one");
    const annRead5 = (await call('GET', ann, `/api/messages/${deeConv}`)).body?.messages ?? [];
    assert(annRead5.find((m: any) => m.id === firstLine)?.ciphertext === before4.ciphertext
        && !String(annRead5.find((m: any) => m.id === annLine)?.metadata ?? '').includes(dee.pk),
        "nor Dee's edit or reaction from while she was blocked");
    assert(pushesTo(ann).length === pushesBefore + 2, `each pushes Ann now (${pushesTo(ann).length - pushesBefore})`);
    assert(JSON.stringify(await linesOf(bo, boConv)) === JSON.stringify([...boIds, b4.body?.message?.id]), 'Bo reads all four');
    const boEntry5 = (await listOf(bo))?.conversations?.find((c: any) => c.id === boConv);
    assert(!!boEntry5?.myLastReadAt && boEntry5.myLastReadAt === boEntry3?.myLastReadAt,
        `his read marker from while it was withheld is the real conversation's (${boEntry5?.myLastReadAt})`);

    // ── 6. a group's chat ───────────────────────────────────────────────────────────────────────
    console.log("── 6. a group's chat ──");
    const g = createGroup({ name: 'Seed Savers', joinPolicy: 'open', createdBy: ann.pk });
    joinGroup(g.id, bo.pk);
    joinGroup(g.id, cy.pk);
    await call('POST', ann, '/api/blocks', { targetPubkey: bo.pk });
    pushes.length = 0;
    const gm = await call('POST', bo, `/api/groups/${g.id}/chat/message`, { text: '@Ann look at this' });
    const gl = await call('POST', bo, `/api/groups/${g.id}/chat/message`, { text: 'and this' });
    await sleep(50);
    assert(gm.status === 201 && gl.status === 201, `Bo's lines go into the room, as the room's are shared (${show(gm)})`);
    assert(pushesTo(ann).length === 0, `his @mention of Ann, and his line, push her nothing (${JSON.stringify(pushesTo(ann))})`);
    assert(pushesTo(cy).length === 2, `Cy hears both (${pushesTo(cy).length})`);
    const cm = await call('POST', cy, `/api/groups/${g.id}/chat/message`, { text: 'hi @Ann' });
    await sleep(50);
    assert(cm.status === 201 && pushesTo(ann).length === 1 && pushesTo(ann)[0]?.data?.k === 'chat.mention', "Cy's @mention of Ann pushes her");

    // ── 7. a deal request ───────────────────────────────────────────────────────────────────────
    console.log('── 7. a deal request ──');
    // A Need asks its author to have listed an Offer first, and the Beans to pay for it.
    attempt(() => createPost('offer', 'goods', 'Spare jars', 'A box of them', 1, 'fixed', ann.pk));
    attempt(() => transfer('genesis', ann.pk, 10, 'Seed grant', 'direct', true));
    const need = attempt(() => createPost('need', 'goods', 'A lift to town', 'Thursday morning', 1, 'fixed', ann.pk));
    pushes.length = 0;
    const boReq = attempt(() => requestPost(need!.id, bo.pk));
    await sleep(50);
    assert(!!boReq && pushesTo(ann).length === 0, `Bo's request waits in Ann's deals with no push (${boReq?.status}; ${pushesTo(ann).length})`);
    const cyReq = attempt(() => requestPost(need!.id, cy.pk));
    await sleep(50);
    assert(!!cyReq && pushesTo(ann).length === 1, `Cy's pushes her (${pushesTo(ann).length})`);

    // ── 8. a listing addressed to her ───────────────────────────────────────────────────────────
    console.log('── 8. a listing addressed to her ──');
    let refused = '';
    try { createPost('offer', 'goods', 'For you', 'words', 1, 'fixed', bo.pk, undefined, undefined, [], false, undefined, false, { audienceScope: 'direct', targetPubkey: ann.pk }); }
    catch (e: any) { refused = e?.message ?? String(e); }
    assert(refused === 'Target member not found or pruned', `Bo's listing addressed to Ann is refused as one to someone who isn't here (${refused || 'made'})`);
    const cyDirect = attempt(() => createPost('offer', 'goods', 'For you', 'words', 1, 'fixed', cy.pk, undefined, undefined, [], false, undefined, false, { audienceScope: 'direct', targetPubkey: ann.pk }));
    assert(!!cyDirect, "Cy's is made");

    // ── 9. a member of another community ────────────────────────────────────────────────────────
    console.log('── 9. a member of another community ──');
    const far = newId('Far');
    registerVisitor(far.pk, 'Far', 'https://far.example.org');
    await call('POST', ann, '/api/blocks', { targetPubkey: far.pk });
    // As federation-protocol.ts relays a DM: open, then send.
    const farConv = attempt(() => createConversation('dm', [far.pk, ann.pk], far.pk));
    let farLine: any = null;
    try { farLine = sendMessage(farConv!.id, far.pk, lockedDm().ciphertext, lockedDm().nonce); } catch (e: any) { console.error(`  (threw: ${e?.message})`); }
    assert(!!farLine?.id && inMessages([farLine.id]) === 0 && !(await listOf(ann))?.conversations?.some((c: any) => c.id === farConv?.id),
        `a relayed line from someone Ann blocked is answered as stored, and reaches her not at all (${farLine?.id})`);

    // ── 10. a standby's copy, and a prune ───────────────────────────────────────────────────────
    console.log("── 10. a standby's copy, and a prune ──");
    const copy = JSON.stringify(await exportSyncState('test-node'));
    const withheldIds = [...boIds, d2id, farLine?.id, farConv?.id].filter(Boolean) as string[];
    assert(withheldIds.length === 6 && withheldIds.every(i => !copy.includes(i)), 'a copy for a standby carries no withheld line or conversation');
    adminPruneUser(bo.pk, owner.pk);
    const boLeft = attempt(() => (db.prepare('SELECT COUNT(*) AS n FROM withheld_lines WHERE author_pubkey = ?').get(bo.pk) as { n: number }).n);
    assert(boLeft === 0, `a prune takes Bo's withheld lines (${boLeft})`);

    // ── 11. pushes that aren't a blocked member's words ─────────────────────────────────────────
    // #1403 review, BLOCKING 3: a block silences the pushes that carry the blocked member's own lines (a group's line,
    // an @mention), and no other: the node's notices and the group's rules push as they did. The real dispatcher, Expo
    // stubbed.
    console.log("── 11. pushes that aren't a blocked member's words ──");
    const DAY = 86_400_000;
    const silence = (pub: string) => {
        const then = new Date(Date.now() - 31 * DAY).toISOString();
        db.prepare('UPDATE members SET last_active_at = ?, joined_at = ? WHERE public_key = ?').run(then, then, pub);
        const before = new Date(Date.now() - 61 * DAY).toISOString();
        db.prepare('UPDATE group_members SET joined_at = ?, role_since = ? WHERE group_id IN (SELECT id FROM groups WHERE lead_pubkey = ?)').run(before, before, pub);
    };
    const lee = member('Lee'), pat = member('Pat'), mo = member('Mo'), quin = member('Quin');
    const leeGroup = createGroup({ name: 'Bike Kitchen', joinPolicy: 'open', createdBy: lee.pk });
    joinGroup(leeGroup.id, pat.pk);
    const moGroup = createGroup({ name: 'Tool Library', joinPolicy: 'open', createdBy: mo.pk });
    joinGroup(moGroup.id, quin.pk);
    const leeBlocks = await call('POST', lee, '/api/blocks', { targetPubkey: pat.pk });
    silence(lee.pk);
    silence(mo.pk);
    pushes.length = 0;
    const pp = await call('POST', pat, `/api/groups/${leeGroup.id}/succession/propose`, { candidatePubkey: pat.pk });
    const qp = await call('POST', quin, `/api/groups/${moGroup.id}/succession/propose`, { candidatePubkey: quin.pk });
    await sleep(50);
    assert(leeBlocks.status === 200 && pp.status === 200 && qp.status === 200, `two silent leads face a vote (${show(pp)}; ${show(qp)})`);
    assert(pushesTo(lee).length === 1 && pushesTo(lee)[0]?.data?.k === 'group.lead',
        `a vote to replace a convenor pushes them though they blocked its proposer (${pushesTo(lee).length}; ${pushesTo(lee)[0]?.data?.k})`);
    assert(pushesTo(mo).length === 1 && pushesTo(mo)[0]?.data?.k === 'group.lead', `as one by someone they never blocked does (${pushesTo(mo).length})`);

    // The admin page's message: the node's words, sent under the operator's member key, which Ann has blocked.
    const operator = getFirstNodeAdminPubkey() || getAdminPubkey();
    const annBlocksOp = await call('POST', ann, '/api/blocks', { targetPubkey: operator });
    pushes.length = 0;
    resetGatewayRateLimit();
    const adminRes = await realFetch(`${BASE}/api/local/admin/inbox/send`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Password': PW },
        body: JSON.stringify({ targetPubkey: ann.pk, message: 'The node will be down for an hour on Sunday.' }),
    });
    await sleep(50);
    assert(annBlocksOp.status === 200 && adminRes.status === 200 && pushesTo(ann).length === 1 && pushesTo(ann)[0]?.data?.k === 'chat.message',
        `the admin page's message pushes Ann though she blocked the operator's key (${adminRes.status}; ${pushesTo(ann).length})`);

    for (const s of [annSock, boSock, deeSock]) s.ws.close();
    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Blocks on messaging checks PASSED.');
}

main().then(() => process.exit(0)).catch((e) => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
