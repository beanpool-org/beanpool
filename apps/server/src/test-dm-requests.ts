/**
 * Message requests: a first message from a stranger waits until the person it is for accepts it
 * (scratch/fable-design/DESIGN-message-a-friend-fable.md §4 and §8, slice S1; Marty accepted all ten recommendations on
 * 23 Oct 2026). The engine is engine/dm-requests.ts; the routes are routes/messaging.ts.
 *
 * Over REAL HTTPS through the real signature middleware, with signed member sockets and Expo stubbed. The main run is
 * the global profile, where requests are on; a child run is the local profile, where they are off until the operator
 * turns them on in Settings.
 *
 * Global (requests on):
 *   1. a stranger's open is a request; their first line is stored, and the person it is for reads it under `requests`,
 *      not in their chats, their unread count or their badge; a second line and a reaction are refused in words (R2); an
 *      open with no line yet asks nothing (not listed, counted or ignorable), and the 30 days run from the line
 *   2. someone the person has added, and a node role, go straight through (R3, R6)
 *   3. Accept: the sender hears it and their next line arrives, pushed; only the person it was sent to decides (R8, R17);
 *      a decision's refusal comes in the member's language, its status and code as they were (member-words.ts, #2400)
 *   4. the person's own first line accepts it (an owner's answer from the node's inbox too), and so does adding the sender
 *      as a friend (R11)
 *   5. Ignore: every answer the sender gets is the one a waiting request gets; the person's lists drop it (R9)
 *   6. Block, after the request or before it: the same answers again, and nothing listed (R10); once a block is lifted, the
 *      line kept during it doesn't count, the opener's own reads say their next line is the request, and it is the one Ann
 *      sees; an acceptance in a
 *      conversation still kept for its opener rings only them; an acceptance never rings
 *      someone who has blocked the one whose act it was, and an opener who blocked Ann reads an acceptance she made after
 *      the block as a request still waiting, until they lift it
 *   7. read receipts: neither side's read marker reaches the other until it is accepted
 *   8. 30 days: a request nobody accepted expires, an ignored one too; the sender's next line is a new request (R12)
 *   9. a 12-words newcomer's requests count against the new people they may reach in a day (R13)
 *  10. pushes: one per request, "wants to message you", folded to one an hour per person (R14)
 *  11. a removed sender's request goes; a deleted sender's line is blanked and their request goes (R15); neither becomes a
 *      chat or counts as unread; one waiting for a removed member goes from the node
 *  12. Ignore all
 *  13. a re-key moves the requests to the new key
 *  14. a standby: every decision refused, and an open that would make a request; a whole copy and a delta carry the
 *      requests verbatim, never a blocked opener's; a promoted copy answers as the main server did (R16)
 * Local (the child run):
 *  15. off by default: a stranger's open and two lines arrive as today, and nothing says requests (R1)
 *  16. the operator turns them on in Settings; then a stranger's open is a request, and a chat opened before stays open
 *  17. a trade's chat and a pending or completed trade go straight through; a trade opening accepts a request (R5, R7)
 *  18. turned off again: a waiting request is an ordinary chat; one Ann ignored, or a removed member's (one that had lapsed
 *      too), stays out of her chats and her unread count until one of them writes in it again or she opens it herself
 *  19. on again: what Ann did while off (her line, a friend add, her own open) accepted what waited for her, so each chat
 *      stays in her chats
 *
 * In every part, only the opener's own view of a request says whether their next line is its line (`nextLineIsRequest`),
 * by the node's count (PR #2404 review 4356625513); the person it is for never reads it.
 *
 * Local only: it talks to the server it starts on localhost, and to nothing else.
 *
 * Run: ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-dm-requests.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
const LOCAL_RUN = !!process.env.DM_REQUESTS_LOCAL_NODE;
if (LOCAL_RUN) delete process.env.NODE_PROFILE; else process.env.NODE_PROFILE = 'global';
delete process.env.ENFORCE_WS_AUTH;
delete process.env.ENFORCE_READ_AUTH;
process.env.ADMIN_PASSWORD = 'DmRequestsPass123!';

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { initTls } from './services/tls.js';
import {
    initStateEngine, seedGenesisMember, adminPruneUser, purgeMemberSelf, getListedUnreadCounts, grantNodeRole,
    ensureTransactionConversation, dispatchPushNotification, exportSyncState, signSyncPayload, importRemoteState, setNodeRole,
} from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { initAdminPassword } from './config/local-config.js';
import { ownerTokenHeaders } from './admin-auth-test-harness.js';
import { db } from './db/db.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { putPushTokenRow } from './services/push-token-seal.js';
import { lockedDm } from './dm-test-payload.js';
import { setMemberPhoto } from '@beanpool/engine';
import { emptyCopiedTables } from './engine/copied-tables.js';
import { issueRekeyCode, completeRekey } from './engine/member-wizards.js';
import { startP2P } from './p2p.js';
import { pinMainServerForTests } from './standby-pin-test-helper.js';
import { useCatalogsForTests } from './member-words.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
/** A step that throws on a tree without message requests must fail its assertion, not end the run. */
function attempt<T>(fn: () => T): T | undefined {
    try { return fn(); } catch (e: any) { console.error(`  (threw: ${e?.message})`); return undefined; }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const DAY = 86_400_000;
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** The engine's own clock-driven steps (engine/dm-requests.ts): absent on a tree without message requests. */
const requestsEngine: any = await import('./engine/dm-requests.js').catch(() => null);

let BASE = '';

// ── Expo, stubbed: every push the node hands it, by token ───────────────────────────────────────
const realFetch = globalThis.fetch;
const pushes: { to: string; title: string; body: string; data: any; badge?: number }[] = [];
(globalThis as any).fetch = async (url: any, init: any) => {
    if (String(url).includes('exp.host')) {
        pushes.push(...JSON.parse(init.body));
        return { ok: true, status: 200, json: async () => ({}) } as any;
    }
    return realFetch(url, init);
};
const tokenOf = (id: Id) => `ExponentPushToken[${id.name}]`;
const pushesTo = (id: Id) => pushes.filter(p => p.to === tokenOf(id));
/** The words of the pushes kept for a member (engine/push-notices.ts), oldest first: what their app shows for each. */
const noticesTo = (id: Id): string[] =>
    (db.prepare('SELECT body FROM push_notices WHERE recipient = ? ORDER BY sent_at, rowid').all(id.pk) as { body: string }[]).map(r => r.body);

// ── members and signed requests ─────────────────────────────────────────────────────────────────
interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}
let owner: Id;
function member(name: string, opts: { words?: boolean } = {}): Id {
    const id = newId(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, is_visitor)
                VALUES (?, ?, ?, ?, 'TEST', 'active', 0)`)
        .run(id.pk, name, iso(Date.now() - 30 * DAY), owner.pk);
    setMemberPhoto(db, id.pk, `https://example.org/${name}.jpg`);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
    // A member who came in by the 12-words door (engine/probation.ts WORDS_PROBATION), joined just now.
    if (opts.words) {
        db.prepare('UPDATE members SET joined_at = ? WHERE public_key = ?').run(iso(Date.now()), id.pk);
        db.prepare("INSERT INTO open_joins (member_pubkey, provider, join_hash) VALUES (?, 'words', ?)").run(id.pk, crypto.randomBytes(16).toString('hex'));
    }
    putPushTokenRow(id.pk, tokenOf(id), 'android');
    return id;
}

interface Res { status: number; body: any }
async function call(method: 'GET' | 'POST', id: Id | null, route: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<Res> {
    resetGatewayRateLimit();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = { ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders };
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${route.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await realFetch(`${BASE}${route}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* empty or not JSON */ }
    return { status: res.status, body: parsed };
}
const show = (r: Res | undefined) => `${r?.status} ${JSON.stringify(r?.body)?.slice(0, 180)}`;

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
/** The events on this socket since `from` that name this conversation. */
const heardOf = (s: Sock, conv: string, from = 0) => s.events.slice(from).filter(e => JSON.stringify(e).includes(conv));

// ── what a member does and reads ────────────────────────────────────────────────────────────────
const listOf = async (id: Id) => (await call('GET', id, `/api/messages/conversations/${id.pk}`)).body;
const open = (a: Id, b: Id) => call('POST', a, '/api/messages/conversation', { type: 'dm', participants: [a.pk, b.pk], createdBy: a.pk });
const send = (conv: string, author: Id) => call('POST', author, '/api/messages/send', { conversationId: conv, authorPubkey: author.pk, ...lockedDm() });
const react = (messageId: string, author: Id) => call('POST', author, '/api/messages/react', { messageId, authorPubkey: author.pk, emoji: '👍' });
const decide = (id: Id, conversationId: string, decision: string) => call('POST', id, '/api/messages/request', { conversationId, decision });
/** A member's lines in a conversation: stored, and kept for them alone (engine/withheld-lines.ts). */
const linesBy = (conv: string, author: Id) =>
    (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND author_pubkey = ?').get(conv, author.pk) as { n: number }).n
    + (attempt(() => (db.prepare('SELECT COUNT(*) AS n FROM withheld_lines WHERE conversation_id = ? AND author_pubkey = ?').get(conv, author.pk) as { n: number }).n) ?? 0);
const inChats = (list: any, conv: string) => !!list?.conversations?.some((c: any) => c.id === conv);
const inRequests = (list: any, conv: string) => !!list?.requests?.conversations?.some((c: any) => c.id === conv);
const entryOf = (list: any, conv: string) => list?.conversations?.find((c: any) => c.id === conv) ?? list?.requests?.conversations?.find((c: any) => c.id === conv);
/**
 * What the opener's own list entry and read of the chat say of their next line (`nextLineIsRequest`), as the node counts
 * their lines: the page can't tell by counting, as it can't tell a line kept for them during a block from one that reached
 * the other person (PR #2404 review 4356625513).
 */
async function nextLineSays(opener: Id, conv: string): Promise<unknown[]> {
    const entry = entryOf(await listOf(opener), conv);
    const read = await call('GET', opener, `/api/messages/${conv}`);
    return [entry?.request?.nextLineIsRequest, read.body?.conversation?.request?.nextLineIsRequest];
}
const allSay = (says: unknown[], v: boolean) => says.length === 2 && says.every(s => s === v);
/** The request row as the node holds it. */
const rowOf = (conv: string): any => attempt(() => db.prepare('SELECT * FROM dm_requests WHERE conversation_id = ?').get(conv));
/** Set a request's age, as if it had been made `days` ago. */
const ageRequest = (conv: string, days: number) =>
    attempt(() => db.prepare('UPDATE dm_requests SET requested_at = ? WHERE conversation_id = ?').run(iso(Date.now() - days * DAY), conv));

/**
 * Everything a sender reads about their own request, with the names, keys, ids and times that differ between two senders
 * replaced, so a waiting request and an ignored or blocked one can be compared answer for answer: asking for the chat
 * again, a second line, a reaction, their list's entry and their read of the chat.
 */
async function senderSees(sender: Id, conv: string, firstLine: string, receiver: Id): Promise<string> {
    const again = await open(sender, receiver);
    const line = await send(conv, sender);
    const reaction = await react(firstLine, sender);
    const list = await listOf(sender);
    const read = await call('GET', sender, `/api/messages/${conv}`);
    const entry = entryOf(list, conv);
    const pick = {
        again: { status: again.status, request: again.body?.conversation?.request, keys: Object.keys(again.body?.conversation ?? {}).sort() },
        line: { status: line.status, body: line.body },
        reaction: { status: reaction.status, body: reaction.body },
        entry: entry && { request: entry.request, peerLastReadAt: entry.peerLastReadAt, unreadCount: entry.unreadCount, inChats: inChats(list, conv) },
        read: {
            status: read.status, request: read.body?.conversation?.request, lines: read.body?.messages?.length,
            cursors: [...(read.body?.conversation?.readCursors ?? [])]
                .map((c: any) => ({ who: c.publicKey === sender.pk ? 'SENDER' : 'RECEIVER', at: c.publicKey === sender.pk ? !!c.lastReadAt : c.lastReadAt }))
                .sort((a: any, b: any) => a.who.localeCompare(b.who)),
        },
    };
    return JSON.stringify(pick)
        .split(sender.pk).join('SENDER').split(conv).join('CONV').split(firstLine).join('LINE')
        .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z/g, 'TIME');
}

async function main(): Promise<void> {
    console.log(`\n=== Message requests (${LOCAL_RUN ? 'local' : 'global'} profile) ===\n`);
    initAdminPassword();
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive');
    requestsEngine?.resetRequestPushes?.();
    if (LOCAL_RUN) await localRun(); else await globalRun();
    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log(`⭐️ Message requests checks PASSED (${LOCAL_RUN ? 'local' : 'global'}).`);

    if (!LOCAL_RUN) {
        console.log('\nAgain on the local profile...\n');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beanpool-dm-requests-local-'));
        const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], {
            env: { ...process.env, DM_REQUESTS_LOCAL_NODE: '1', BEANPOOL_DATA_DIR: dir, NODE_PROFILE: '' },
            stdio: 'inherit',
        });
        fs.rmSync(dir, { recursive: true, force: true });
        if (child.status !== 0) throw new Error(`the local-profile run failed (exit ${child.status})`);
    }
}

async function globalRun(): Promise<void> {
    const ann = member('Ann');   // the person messaged
    const bo = member('Bo');     // a stranger to her
    const annSock = await socket(ann);
    const boSock = await socket(bo);
    await sleep(100);

    // ── 1. a stranger's first message waits ─────────────────────────────────────────────────────
    console.log('── 1. a stranger\'s first message waits as a request ──');
    const info = await call('GET', null, '/api/community/info');
    assert(info.body?.features?.dmRequests === true, `the global community says requests are on (features.dmRequests ${info.body?.features?.dmRequests})`);
    const bOpen = await open(bo, ann);
    const boConv: string = bOpen.body?.conversation?.id;
    assert(bOpen.status === 200 && bOpen.body?.conversation?.request?.state === 'pending' && bOpen.body?.conversation?.request?.from === bo.pk,
        `Bo's open is a request from him, waiting (${show(bOpen)})`);
    assert(bOpen.body?.conversation?.request?.nextLineIsRequest === true && allSay(await nextLineSays(bo, boConv), true),
        `before he writes, his open, his list and his read say his next line is the request (${JSON.stringify(bOpen.body?.conversation?.request)})`);
    assert(rowOf(boConv)?.state === 'pending' && rowOf(boConv)?.from_pubkey === bo.pk && rowOf(boConv)?.to_pubkey === ann.pk,
        'the node holds it: from Bo, to Ann, waiting');
    // The apps ask for the chat when someone taps Message, before they type: an open with no line asks Ann nothing yet
    // (PR #2392 review 4354580417).
    const annList0 = await listOf(ann);
    assert(!inChats(annList0, boConv) && !inRequests(annList0, boConv) && annList0?.requests?.count === 0 && annList0?.totalUnread === 0,
        `until he writes, it is in neither of her lists, nor counted (${annList0?.requests?.count} waiting)`);
    const pushedBefore = pushesTo(ann).length;
    const b1 = await send(boConv, bo);
    const boLine: string = b1.body?.message?.id;
    await sleep(200);
    assert(b1.status === 200 && linesBy(boConv, bo) === 1, `his first line is stored (${show(b1)})`);
    const annList1 = await listOf(ann);
    assert(!inChats(annList1, boConv) && inRequests(annList1, boConv) && annList1?.requests?.count === 1,
        `Ann has it under requests, not in her chats (${annList1?.requests?.count} waiting)`);
    assert(entryOf(annList1, boConv)?.request?.state === 'pending' && entryOf(annList1, boConv)?.request?.from === bo.pk,
        'its card says who it is from, waiting');
    assert(annList1?.totalUnread === 0 && !(boConv in (attempt(() => getListedUnreadCounts(ann.pk)) ?? { [boConv]: 1 })),
        `it is in neither her unread count nor the badge her pushes carry (unread ${annList1?.totalUnread})`);
    const annRead = await call('GET', ann, `/api/messages/${boConv}`);
    assert(annRead.status === 200 && annRead.body?.messages?.length === 1 && annRead.body?.conversation?.request?.state === 'pending',
        'she can read his line before she decides');
    const toAnn = pushesTo(ann).slice(pushedBefore);
    assert(toAnn.length === 1 && toAnn[0].badge === 0 && noticesTo(ann).at(-1) === 'Bo wants to message you',
        `one push to Ann, "${noticesTo(ann).at(-1)}", and her badge 0 (${toAnn.length} pushes, badge ${toAnn[0]?.badge})`);
    const b2 = await send(boConv, bo);
    assert(b2.status === 403 && b2.body?.code === 'dm_request_pending' && b2.body?.error === 'Your first message is waiting for Ann. You can write more once they accept it.'
        && linesBy(boConv, bo) === 1, `his second line is refused, in words, and nothing is stored (${show(b2)})`);
    const bReact = await react(boLine, bo);
    assert(bReact.status === 403 && bReact.body?.code === 'dm_request_pending', `and a reaction (${show(bReact)})`);
    const bEdit = await call('POST', bo, '/api/messages/edit', { messageId: boLine, ...lockedDm() });
    assert(bEdit.status === 200, `he can still edit his line (${show(bEdit)})`);
    const boList1 = await listOf(bo);
    assert(inChats(boList1, boConv) && entryOf(boList1, boConv)?.request?.state === 'pending' && !boList1?.requests?.count,
        'his own list has the chat, marked as his waiting request');
    const boSays1 = await nextLineSays(bo, boConv);
    assert(allSay(boSays1, false), `after his line, his list and his read say his next line is not (${JSON.stringify(boSays1)})`);
    const annViews = [entryOf(annList1, boConv)?.request, annRead.body?.conversation?.request, entryOf(await listOf(ann), boConv)?.request];
    assert(annViews.every(r => !!r && !('nextLineIsRequest' in r)), `Ann's views of it never say (${JSON.stringify(annViews)})`);
    // An open with no line can't be ignored, so it never swallows the line that comes after it; and the 30 days run from
    // that line, not from the open (PR #2392 review 4354580417).
    const rae = member('Rae');
    const sol = member('Sol');
    const raeConv: string = (await open(rae, sol)).body?.conversation?.id;
    ageRequest(raeConv, 29);
    const solAll = await call('POST', sol, '/api/messages/request/ignore-all', {});
    const solIgnore = await decide(sol, raeConv, 'ignore');
    const solNobody = await decide(sol, crypto.randomUUID(), 'ignore');
    assert(solAll.status === 200 && solAll.body?.ignored === 0 && solIgnore.status === 404 && JSON.stringify(solIgnore.body) === JSON.stringify(solNobody.body)
        && rowOf(raeConv)?.state === 'pending',
        `Sol can't ignore Rae's open before she writes: Ignore all finds nothing, and Ignore answers as for a chat nobody has (${show(solAll)}; ${show(solIgnore)})`);
    const solPushed = noticesTo(sol).length;
    const r1 = await send(raeConv, rae);
    await sleep(150);
    const solList = await listOf(sol);
    assert(r1.status === 200 && inRequests(solList, raeConv) && solList?.requests?.count === 1 && rowOf(raeConv)?.state === 'pending'
        && JSON.stringify(noticesTo(sol).slice(solPushed)) === JSON.stringify(['Rae wants to message you']),
        `her first line is the request Sol sees, and is pushed as one (${show(r1)}; ${JSON.stringify(noticesTo(sol).slice(solPushed))})`);
    assert(Date.parse(rowOf(raeConv)?.requested_at) > Date.now() - HOUR && entryOf(solList, raeConv)?.request?.at === rowOf(raeConv)?.requested_at,
        `opened 29 days ago, it is made by her line, so its 30 days run from then (${rowOf(raeConv)?.requested_at})`);

    // ── 2. who goes straight through ────────────────────────────────────────────────────────────
    console.log('── 2. a friend and a node role go straight through ──');
    const dee = member('Dee');
    const added = await call('POST', ann, '/api/friends/add', { friendPubkey: dee.pk });
    const dOpen = await open(dee, ann);
    const deeConv: string = dOpen.body?.conversation?.id;
    const d1 = await send(deeConv, dee);
    const d2 = await send(deeConv, dee);
    await sleep(150);
    const annList2 = await listOf(ann);
    assert(added.status === 200 && dOpen.status === 200 && dOpen.body?.conversation?.request === null && d1.status === 200 && d2.status === 200
        && inChats(annList2, deeConv) && !inRequests(annList2, deeConv) && entryOf(annList2, deeConv)?.unreadCount === 2,
        `Ann added Dee, so Dee's open is an ordinary chat and both lines arrive (${show(dOpen)})`);
    const mo = member('Mo');
    grantNodeRole(mo.pk, 'moderator', owner.pk);
    const mOpen = await open(mo, ann);
    const moConv: string = mOpen.body?.conversation?.id;
    const m1 = await send(moConv, mo);
    const m2 = await send(moConv, mo);
    assert(mOpen.body?.conversation?.request === null && m1.status === 200 && m2.status === 200 && inChats(await listOf(ann), moConv),
        'a moderator reaches her straight away');
    // The rule is read again at each of the opener's lines while the request waits: a role granted since lets them through.
    const oz = member('Oz');
    const ozConv: string = (await open(oz, ann)).body?.conversation?.id;
    await send(ozConv, oz);
    assert((await send(ozConv, oz)).status === 403, 'Oz\'s request waits');
    grantNodeRole(oz.pk, 'moderator', owner.pk);
    const oz3 = await send(ozConv, oz);
    assert(oz3.status === 200 && rowOf(ozConv)?.state === 'accepted', `made a moderator since, Oz's next line goes through and accepts it (${show(oz3)})`);

    // ── 3. Accept ───────────────────────────────────────────────────────────────────────────────
    console.log('── 3. Accept ──');
    const byBo = await decide(bo, boConv, 'accept');
    assert(byBo.status === 403 && rowOf(boConv)?.state === 'pending', `Bo can't accept his own request (${show(byBo)})`);
    const cy = member('Cy');
    const byCy = await decide(cy, boConv, 'accept');
    const nobody = await decide(cy, crypto.randomUUID(), 'accept');
    assert(byCy.status === 404 && nobody.status === 404 && JSON.stringify(byCy.body) === JSON.stringify(nobody.body) && rowOf(boConv)?.state === 'pending',
        `nor can anyone outside it, answered as a chat nobody has (${show(byCy)})`);
    const bad = await decide(ann, boConv, 'maybe');
    assert(bad.status === 400, `a decision that is neither is refused (${show(bad)})`);
    const boHeard = boSock.events.length;
    const acc = await decide(ann, boConv, 'accept');
    await sleep(150);
    assert(acc.status === 200 && acc.body?.request?.state === 'accepted' && rowOf(boConv)?.state === 'accepted',
        `Ann accepts (${show(acc)})`);
    assert(heardOf(boSock, boConv, boHeard).some(e => e.type === 'dm_request_updated' && e.request?.state === 'accepted'),
        'Bo hears it: his app can write again');
    const annList3 = await listOf(ann);
    assert(inChats(annList3, boConv) && !inRequests(annList3, boConv) && entryOf(annList3, boConv)?.request?.state === 'accepted',
        'the chat moves to her chats');
    const pushed3 = pushesTo(ann).length;
    const b3 = await send(boConv, bo);
    await sleep(200);
    assert(b3.status === 200 && linesBy(boConv, bo) === 2 && pushesTo(ann).length === pushed3 + 1 && noticesTo(ann).at(-1) === 'Bo sent you a message',
        `his next line arrives, with an ordinary push (${show(b3)}; "${noticesTo(ann).at(-1)}")`);
    assert((await react(boLine, bo)).status === 200, 'and he can react');
    assert(!(attempt(() => db.prepare('SELECT 1 FROM friends WHERE owner_pubkey = ? AND friend_pubkey = ?').get(ann.pk, bo.pk))),
        'accepting made nobody a friend');
    const again = await decide(ann, boConv, 'accept');
    const ignoreAccepted = await decide(ann, boConv, 'ignore');
    assert(again.status === 200 && ignoreAccepted.status === 409 && rowOf(boConv)?.state === 'accepted',
        `accepting again changes nothing; an accepted chat can't be ignored (${show(ignoreAccepted)})`);
    // The catalogs are drafted after merge, so the suite brings its own French (as test-member-words does).
    const NO_REQUEST = 'There is no message request for you in this chat.';
    const ACCEPTED_ALREADY = 'You have accepted this chat already, so it is no longer a request.';
    assert(nobody.body?.error === NO_REQUEST && nobody.body?.code === 'request_not_found'
        && ignoreAccepted.body?.error === ACCEPTED_ALREADY && ignoreAccepted.body?.code === 'request_accepted',
        `with no language named, a decision's refusal is the English (${show(nobody)}; ${show(ignoreAccepted)})`);
    const FR: Record<string, string> = {
        [NO_REQUEST]: "Il n'y a pas de demande de message pour vous dans ce chat.",
        [ACCEPTED_ALREADY]: "Vous avez déjà accepté ce chat : ce n'est plus une demande.",
    };
    useCatalogsForTests('fr', { server: FR });
    try {
        const fr = { 'X-Language': 'fr' };
        const nobodyFr = await call('POST', cy, '/api/messages/request', { conversationId: crypto.randomUUID(), decision: 'accept' }, fr);
        const ignoreAcceptedFr = await call('POST', ann, '/api/messages/request', { conversationId: boConv, decision: 'ignore' }, fr);
        assert(nobodyFr.status === 404 && nobodyFr.body?.code === 'request_not_found' && nobodyFr.body?.error === FR[NO_REQUEST]
            && ignoreAcceptedFr.status === 409 && ignoreAcceptedFr.body?.code === 'request_accepted' && ignoreAcceptedFr.body?.error === FR[ACCEPTED_ALREADY]
            && rowOf(boConv)?.state === 'accepted',
            `with X-Language: fr a decision's refusal comes in French, its status and code as they were (${show(nobodyFr)}; ${show(ignoreAcceptedFr)})`);
    } finally {
        useCatalogsForTests('fr', null);
    }

    // ── 4. the person's own line, or a friend add, accepts ─────────────────────────────────────
    console.log('── 4. her own line, or adding them, accepts ──');
    const eve = member('Eve');
    const eOpen = await open(eve, ann);
    const eveConv: string = eOpen.body?.conversation?.id;
    await send(eveConv, eve);
    assert(rowOf(eveConv)?.state === 'pending', 'Eve\'s request waits');
    const eveSock = await socket(eve);
    await sleep(50);
    const aReply = await send(eveConv, ann);
    await sleep(150);
    // Read before Eve writes again: her next line would be let through by the rule all the same (Ann has written), so only
    // this shows the reply itself accepted it.
    assert(aReply.status === 200 && rowOf(eveConv)?.state === 'accepted' && inChats(await listOf(ann), eveConv)
        && eveSock.events.some(e => e.type === 'dm_request_updated' && e.conversationId === eveConv && e.request?.state === 'accepted'),
        `Ann's reply accepts Eve's request: it is in Ann's chats, and Eve hears it (${show(aReply)})`);
    const e2 = await send(eveConv, eve);
    assert(e2.status === 200, `and Eve's next line arrives (${show(e2)})`);
    eveSock.ws.close();
    const cOpen = await open(cy, ann);
    const cyConv: string = cOpen.body?.conversation?.id;
    await send(cyConv, cy);
    assert((await send(cyConv, cy)).status === 403, 'Cy\'s request waits');
    const addCy = await call('POST', ann, '/api/friends/add', { friendPubkey: cy.pk });
    // Read before Cy writes again, as above: his next line would be let through by the rule all the same.
    const annCy = await listOf(ann);
    assert(addCy.status === 200 && rowOf(cyConv)?.state === 'accepted' && inChats(annCy, cyConv) && !inRequests(annCy, cyConv),
        `Ann adds Cy as a friend: his request is accepted, and the chat is in her chats (${show(addCy)})`);
    const c3 = await send(cyConv, cy);
    assert(c3.status === 200, `and his next line arrives (${show(c3)})`);
    // Asking for the chat herself (Message on his profile) is reaching out to him, as writing is (§4.3 "opened the
    // conversation"): it accepts too, and the chat she opened is in her chats.
    const nia = member('Nia');
    const niaConv: string = (await open(nia, ann)).body?.conversation?.id;
    await send(niaConv, nia);
    const annAsks = await open(ann, nia);
    assert(annAsks.status === 200 && annAsks.body?.conversation?.id === niaConv && annAsks.body?.conversation?.request?.state === 'accepted'
        && rowOf(niaConv)?.state === 'accepted' && inChats(await listOf(ann), niaConv) && (await send(niaConv, nia)).status === 200,
        `Ann asking for the chat with Nia herself accepts Nia's request (${show(annAsks)})`);
    // The owner's answer from the node's inbox (POST /api/local/admin/inbox/send, the node's own line, written as her) is her
    // line in the chat as much as one from her app: it accepts a request waiting for her (PR #2392 review 4355066390).
    const tam = member('Tam');
    const tamSock = await socket(tam);
    await sleep(50);
    const tamConv: string = (await open(tam, owner)).body?.conversation?.id;
    await send(tamConv, tam);
    assert(rowOf(tamConv)?.state === 'pending' && inRequests(await listOf(owner), tamConv), 'Tam\'s request waits for Olive, the owner');
    const tamHeard = tamSock.events.length;
    const inboxReply = await call('POST', null, '/api/local/admin/inbox/send', { targetPubkey: tam.pk, message: 'Welcome, Tam' },
        ownerTokenHeaders('admin', owner.pk));
    await sleep(150);
    // Read before Tam writes again, as above: his next line would be let through by the rule all the same.
    const oliveTam = await listOf(owner);
    assert(inboxReply.status === 200 && linesBy(tamConv, owner) === 1 && rowOf(tamConv)?.state === 'accepted' && rowOf(tamConv)?.accepted_by === owner.pk
        && inChats(oliveTam, tamConv) && !inRequests(oliveTam, tamConv),
        `Olive's answer from the node's inbox accepts it, and the chat is in her chats (${show(inboxReply)}; ${rowOf(tamConv)?.state})`);
    assert(entryOf(await listOf(tam), tamConv)?.request?.state === 'accepted'
        && heardOf(tamSock, tamConv, tamHeard).some(e => e.type === 'dm_request_updated' && e.request?.state === 'accepted'),
        'Tam reads it accepted, and hears it: his app can write again');
    tamSock.ws.close();

    // ── 5. Ignore ───────────────────────────────────────────────────────────────────────────────
    console.log('── 5. Ignore tells the sender nothing ──');
    const fy = member('Fy');   // will be ignored
    const gi = member('Gi');   // waits, nobody decides
    const fySock = await socket(fy);
    const fConv: string = (await open(fy, ann)).body?.conversation?.id;
    const giConv: string = (await open(gi, ann)).body?.conversation?.id;
    const fLine: string = (await send(fConv, fy)).body?.message?.id;
    const gLine: string = (await send(giConv, gi)).body?.message?.id;
    await sleep(100);
    const fyHeard = fySock.events.length;
    const ign = await decide(ann, fConv, 'ignore');
    await sleep(150);
    assert(ign.status === 200 && rowOf(fConv)?.state === 'ignored', `Ann ignores Fy's request (${show(ign)})`);
    assert(heardOf(fySock, fConv, fyHeard).length === 0, 'Fy hears nothing of it');
    const annList5 = await listOf(ann);
    assert(!inChats(annList5, fConv) && !inRequests(annList5, fConv) && inRequests(annList5, giConv),
        'it leaves her requests, and her chats; Gi\'s still waits');
    const fySees = await senderSees(fy, fConv, fLine, ann);
    const giSees = await senderSees(gi, giConv, gLine, ann);
    assert(fySees === giSees, `every answer Fy gets is the one Gi's waiting request gets\n    ignored: ${fySees}\n    waiting: ${giSees}`);
    assert(linesBy(fConv, fy) === 1 && linesBy(giConv, gi) === 1, 'neither second line was stored');

    // ── 6. Block ────────────────────────────────────────────────────────────────────────────────
    console.log('── 6. Block tells the sender nothing ──');
    const gus = member('Gus');   // blocked after his request
    const hu = member('Hu');     // blocked before he writes at all
    const ida = member('Ida');   // waits, for the comparison
    const gusConv: string = (await open(gus, ann)).body?.conversation?.id;
    const gusLine: string = (await send(gusConv, gus)).body?.message?.id;
    const blockGus = await call('POST', ann, '/api/blocks', { targetPubkey: gus.pk });
    const blockHu = await call('POST', ann, '/api/blocks', { targetPubkey: hu.pk });
    const huOpen = await open(hu, ann);
    const huConv: string = huOpen.body?.conversation?.id;
    const huLine: string = (await send(huConv, hu)).body?.message?.id;
    const idaConv: string = (await open(ida, ann)).body?.conversation?.id;
    const idaLine: string = (await send(idaConv, ida)).body?.message?.id;
    await sleep(150);
    assert(blockGus.status === 200 && blockHu.status === 200 && huOpen.status === 200 && huOpen.body?.conversation?.request?.state === 'pending',
        `Ann blocks both; Hu's open still reads as a waiting request (${show(huOpen)})`);
    const annList6 = await listOf(ann);
    assert(![gusConv, huConv].some(c => inChats(annList6, c) || inRequests(annList6, c)) && inRequests(annList6, idaConv),
        'neither is in her requests or her chats; Ida\'s is');
    const gusSees = await senderSees(gus, gusConv, gusLine, ann);
    const huSees = await senderSees(hu, huConv, huLine, ann);
    const idaSees = await senderSees(ida, idaConv, idaLine, ann);
    assert(gusSees === idaSees, `Gus, blocked after his request, reads what a waiting request reads\n    blocked: ${gusSees}\n    waiting: ${idaSees}`);
    assert(huSees === idaSees, `Hu, blocked before he wrote, reads the same\n    blocked: ${huSees}\n    waiting: ${idaSees}`);
    // A block lifted (PR #2392 review 4354388176): the line kept for the opener during it never reaches Ann, so it isn't the
    // request's one line. The opener's next line is, and a conversation kept for them becomes the real one with it.
    const uma = member('Uma');   // blocked before she opens: her conversation is kept for her alone
    const vic = member('Vic');   // opens, then is blocked before he writes
    const blockUma = await call('POST', ann, '/api/blocks', { targetPubkey: uma.pk });
    const umaConv: string = (await open(uma, ann)).body?.conversation?.id;
    const u1 = await send(umaConv, uma);
    const vicConv: string = (await open(vic, ann)).body?.conversation?.id;
    const blockVic = await call('POST', ann, '/api/blocks', { targetPubkey: vic.pk });
    const v1 = await send(vicConv, vic);
    const uBlocked = await send(umaConv, uma);
    const vBlocked = await send(vicConv, vic);
    assert(blockUma.status === 200 && blockVic.status === 200 && u1.status === 200 && v1.status === 200
        && uBlocked.status === 403 && uBlocked.body?.code === 'dm_request_pending' && vBlocked.status === 403 && vBlocked.body?.code === 'dm_request_pending'
        && rowOf(umaConv)?.state === 'pending' && rowOf(vicConv)?.state === 'pending',
        `while blocked, each first line is kept for its sender alone and the next is refused, as any request's (${show(uBlocked)}; ${show(vBlocked)})`);
    const blockedSays = [await nextLineSays(uma, umaConv), await nextLineSays(vic, vicConv), await nextLineSays(ida, idaConv)];
    assert(blockedSays.every(s => allSay(s, false)),
        `while the block holds, Uma's and Vic's own reads say their next line is not the request, as Ida's do (${JSON.stringify(blockedSays)})`);
    const unUma = await call('POST', ann, '/api/blocks/remove', { targetPubkey: uma.pk });
    const unVic = await call('POST', ann, '/api/blocks/remove', { targetPubkey: vic.pk });
    const liftedSays = [await nextLineSays(uma, umaConv), await nextLineSays(vic, vicConv)];
    const idaLifted = await nextLineSays(ida, idaConv);
    assert(liftedSays.every(s => allSay(s, true)) && allSay(idaLifted, false),
        `once it is lifted, their own reads say their next line is the request, the kept one not counted; Ida's still say not (${JSON.stringify(liftedSays)}; ${JSON.stringify(idaLifted)})`);
    const u2 = await send(umaConv, uma);
    const v2 = await send(vicConv, vic);
    await sleep(150);
    assert(unUma.status === 200 && unVic.status === 200 && u2.status === 200 && v2.status === 200,
        `Ann lifts both blocks: each one's next line goes through (${show(u2)}; ${show(v2)})`);
    const afterSays = [await nextLineSays(uma, umaConv), await nextLineSays(vic, vicConv)];
    assert(afterSays.every(s => allSay(s, false)), `after it, their own reads say the next is not (${JSON.stringify(afterSays)})`);
    const annList6b = await listOf(ann);
    const annReadUma = await call('GET', ann, `/api/messages/${umaConv}`);
    const annReadVic = await call('GET', ann, `/api/messages/${vicConv}`);
    assert(inRequests(annList6b, umaConv) && inRequests(annList6b, vicConv) && !inChats(annList6b, umaConv) && !inChats(annList6b, vicConv)
        && annReadUma.body?.messages?.length === 1 && annReadVic.body?.messages?.length === 1,
        `as the request Ann sees, with that line and not the kept one (Uma ${annReadUma.status}/${annReadUma.body?.messages?.length}, Vic ${annReadVic.body?.messages?.length})`);
    const u3 = await send(umaConv, uma);
    const v3 = await send(vicConv, vic);
    assert(u3.status === 403 && u3.body?.code === 'dm_request_pending' && v3.status === 403 && v3.body?.code === 'dm_request_pending',
        `and the line after it waits, as any request's (${show(u3)}; ${show(v3)})`);
    // Until the opener's next line makes it real, a conversation kept for them is theirs alone (PR #2392 review 4355143120).
    // Ann blocks Ash and Bea before they open, each writes a line kept for them, and she lifts both blocks. Her adding Ash
    // accepts his, and Bea, made a moderator, accepts hers by reacting to her kept line: Ann hears of neither, as she has no
    // such chat, and each opener hears it and reads it accepted. Ash's next line makes his the real one, a chat in her list.
    const [ash, bea] = [member('Ash'), member('Bea')];
    const blocksKept = [await call('POST', ann, '/api/blocks', { targetPubkey: ash.pk }), await call('POST', ann, '/api/blocks', { targetPubkey: bea.pk })];
    const ashConv: string = (await open(ash, ann)).body?.conversation?.id;
    const beaConv: string = (await open(bea, ann)).body?.conversation?.id;
    const a1 = await send(ashConv, ash);
    const beaLine: string = (await send(beaConv, bea)).body?.message?.id;
    for (const s of [ash, bea]) blocksKept.push(await call('POST', ann, '/api/blocks/remove', { targetPubkey: s.pk }));
    const ashSock = await socket(ash);
    const beaSock = await socket(bea);
    await sleep(50);
    const annHeardKept = annSock.events.length;
    const addAsh = await call('POST', ann, '/api/friends/add', { friendPubkey: ash.pk });
    grantNodeRole(bea.pk, 'moderator', owner.pk);
    const beaReacts = await react(beaLine, bea);
    await sleep(200);
    const keptOnly = (c: string) => !db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(c);
    assert(blocksKept.every(r => r.status === 200) && a1.status === 200 && addAsh.status === 200 && beaReacts.status === 200
        && keptOnly(ashConv) && keptOnly(beaConv) && rowOf(ashConv)?.state === 'accepted' && rowOf(beaConv)?.state === 'accepted',
        `in a conversation still kept for its opener, Ann's add accepts Ash's, and Bea's reaction hers (${show(addAsh)}; ${show(beaReacts)})`);
    assert(heardOf(annSock, ashConv, annHeardKept).length === 0 && heardOf(annSock, beaConv, annHeardKept).length === 0,
        `Ann hears nothing of either (${heardOf(annSock, ashConv, annHeardKept).map(e => e.type)}; ${heardOf(annSock, beaConv, annHeardKept).map(e => e.type)})`);
    const keptUpdate = (s: Sock, c: string) => heardOf(s, c).filter(e => e.type === 'dm_request_updated' && e.request?.state === 'accepted');
    const ashReads = entryOf(await listOf(ash), ashConv)?.request?.state;
    const beaReads = entryOf(await listOf(bea), beaConv)?.request?.state;
    assert(keptUpdate(ashSock, ashConv).length === 1 && keptUpdate(beaSock, beaConv).length === 1 && ashReads === 'accepted' && beaReads === 'accepted',
        `each opener hears it and reads it accepted (${keptUpdate(ashSock, ashConv).length}/${ashReads}, ${keptUpdate(beaSock, beaConv).length}/${beaReads})`);
    const annListKept = await listOf(ann);
    const a2 = await send(ashConv, ash);
    const annListReal = await listOf(ann);
    assert(![ashConv, beaConv].some(c => inChats(annListKept, c) || inRequests(annListKept, c)) && a2.status === 200 && !keptOnly(ashConv)
        && inChats(annListReal, ashConv) && entryOf(annListReal, ashConv)?.request?.state === 'accepted',
        `neither is in Ann's list until Ash's next line makes his real: then it is a chat of hers, accepted (${show(a2)})`);
    for (const s of [ashSock, beaSock]) s.ws.close();
    // An acceptance never reaches someone who has blocked the one whose act it was (PR #2392 review 4354581168). Wes and
    // Xan each write, then block Ann: her reply accepts Wes's, her Accept Xan's. Ann blocks Yul after his line, and he is
    // made a moderator: his next line accepts it.
    const [wes, xan, yul] = [member('Wes'), member('Xan'), member('Yul')];
    const wesConv: string = (await open(wes, ann)).body?.conversation?.id;
    const xanConv: string = (await open(xan, ann)).body?.conversation?.id;
    const yulConv: string = (await open(yul, ann)).body?.conversation?.id;
    for (const [c, s] of [[wesConv, wes], [xanConv, xan], [yulConv, yul]] as [string, Id][]) await send(c, s);
    const wesSock = await socket(wes);
    const xanSock = await socket(xan);
    await sleep(50);
    const blocks6 = [
        await call('POST', wes, '/api/blocks', { targetPubkey: ann.pk }),
        await call('POST', xan, '/api/blocks', { targetPubkey: ann.pk }),
        await call('POST', ann, '/api/blocks', { targetPubkey: yul.pk }),
    ];
    const annHeard6 = annSock.events.length;
    const wReply = await send(wesConv, ann);
    const xAccept = await decide(ann, xanConv, 'accept');
    grantNodeRole(yul.pk, 'moderator', owner.pk);
    const y2 = await send(yulConv, yul);
    await sleep(200);
    assert(blocks6.every(r => r.status === 200) && wReply.status === 200 && xAccept.status === 200 && y2.status === 200
        && [wesConv, xanConv, yulConv].every(c => rowOf(c)?.state === 'accepted'),
        `each is accepted (${show(wReply)}; ${show(xAccept)}; ${show(y2)})`);
    const updated = (s: Sock, c: string, from = 0) => heardOf(s, c, from).filter(e => e.type === 'dm_request_updated');
    assert(updated(wesSock, wesConv).length === 0 && updated(xanSock, xanConv).length === 0,
        `neither Wes nor Xan, who blocked Ann, hears that she accepted (${updated(wesSock, wesConv).length}, ${updated(xanSock, xanConv).length})`);
    assert(updated(annSock, wesConv, annHeard6).length === 1 && updated(annSock, xanConv, annHeard6).length === 1,
        'Ann hears her own acceptances (her other devices)');
    assert(updated(annSock, yulConv, annHeard6).length === 0, 'and Ann, who blocked Yul, hears nothing of his line accepting his');
    for (const s of [wesSock, xanSock]) s.ws.close();
    // Nor does it show in what they read (the director's option b on review 4354581168): while Zak blocks Ann, her reply
    // reads to him as a request still waiting, and so does her adding Ora; each one's next line is refused as a waiting
    // request's is. Pip, who blocked Ann too, waits, for the comparison. It shows once the block is lifted.
    const [zak, ora, pip] = [member('Zak'), member('Ora'), member('Pip')];
    const zakConv: string = (await open(zak, ann)).body?.conversation?.id;
    const oraConv: string = (await open(ora, ann)).body?.conversation?.id;
    const pipConv: string = (await open(pip, ann)).body?.conversation?.id;
    const zakLine: string = (await send(zakConv, zak)).body?.message?.id;
    const oraLine: string = (await send(oraConv, ora)).body?.message?.id;
    const pipLine: string = (await send(pipConv, pip)).body?.message?.id;
    const blocks6b: Res[] = [];
    for (const s of [zak, ora, pip]) blocks6b.push(await call('POST', s, '/api/blocks', { targetPubkey: ann.pk }));
    const zReply = await send(zakConv, ann);
    const addOra = await call('POST', ann, '/api/friends/add', { friendPubkey: ora.pk });
    assert(blocks6b.every(r => r.status === 200) && zReply.status === 200 && addOra.status === 200
        && rowOf(zakConv)?.state === 'accepted' && rowOf(oraConv)?.state === 'accepted' && rowOf(pipConv)?.state === 'pending',
        `after each blocks Ann, her reply accepts Zak's and her add Ora's (${show(zReply)}; ${show(addOra)})`);
    const pipSees = await senderSees(pip, pipConv, pipLine, ann);
    const zakSees = await senderSees(zak, zakConv, zakLine, ann);
    const oraSees = await senderSees(ora, oraConv, oraLine, ann);
    assert(zakSees === pipSees, `Zak reads Ann's reply as a request still waiting\n    blocker: ${zakSees}\n    waiting: ${pipSees}`);
    assert(oraSees === pipSees, `Ora reads Ann's add the same\n    blocker: ${oraSees}\n    waiting: ${pipSees}`);
    const annList6c = await listOf(ann);
    const annReadZak = await call('GET', ann, `/api/messages/${zakConv}`);
    assert(inChats(annList6c, zakConv) && inChats(annList6c, oraConv) && entryOf(annList6c, zakConv)?.request?.state === 'accepted'
        && entryOf(annList6c, oraConv)?.request?.state === 'accepted' && annReadZak.body?.conversation?.request?.state === 'accepted',
        `Ann reads both as she left them: accepted, in her chats (${annReadZak.body?.conversation?.request?.state})`);
    // After 30 days, Ora reads it as lapsed, as Pip does his: the next line goes through and is the request's line again, and
    // the one after it waits.
    ageRequest(oraConv, 31);
    ageRequest(pipConv, 31);
    const oraLapsed = entryOf(await listOf(ora), oraConv)?.request?.state;
    const [o2, o3] = [await send(oraConv, ora), await send(oraConv, ora)];
    const [p2, p3] = [await send(pipConv, pip), await send(pipConv, pip)];
    const oraAfter = entryOf(await listOf(ora), oraConv)?.request?.state;
    assert(oraLapsed === 'expired' && oraAfter === 'pending' && o2.status === 200 && o3.status === 403 && o3.body?.code === 'dm_request_pending'
        && p2.status === 200 && p3.status === 403,
        `after 30 days Ora reads it as lapsed and writes once more, as Pip does (${oraLapsed} → ${oraAfter}; ${o2.status}/${o3.status}; Pip ${p2.status}/${p3.status})`);
    // What lets Ora through on her own still does, and then it is hers to read: made a moderator, her line goes through.
    grantNodeRole(ora.pk, 'moderator', owner.pk);
    const o4 = await send(oraConv, ora);
    const oraOwn = entryOf(await listOf(ora), oraConv)?.request?.state;
    assert(o4.status === 200 && oraOwn === 'accepted', `made a moderator, Ora's line goes through and she reads it accepted (${o4.status}, ${oraOwn})`);
    // An acceptance made before the block was seen, and stays seen: Ann accepts Quin's, then Quin blocks her.
    const quin = member('Quin');
    const quinConv: string = (await open(quin, ann)).body?.conversation?.id;
    await send(quinConv, quin);
    const qAccept = await decide(ann, quinConv, 'accept');
    await sleep(5);
    const blockQuin = await call('POST', quin, '/api/blocks', { targetPubkey: ann.pk });
    const quinSees = entryOf(await listOf(quin), quinConv)?.request?.state;
    const q2 = await send(quinConv, quin);
    assert(qAccept.status === 200 && blockQuin.status === 200 && quinSees === 'accepted' && q2.status === 200,
        `Ann's acceptance before Quin blocks her still reads accepted to him, and he writes on (${quinSees}; ${show(q2)})`);
    const unZak = await call('POST', zak, '/api/blocks/remove', { targetPubkey: ann.pk });
    const zakReadAfter = await call('GET', zak, `/api/messages/${zakConv}`);
    const zakListAfter = await listOf(zak);
    const z2 = await send(zakConv, zak);
    assert(unZak.status === 200 && zakReadAfter.body?.conversation?.request?.state === 'accepted'
        && entryOf(zakListAfter, zakConv)?.request?.state === 'accepted' && z2.status === 200,
        `once Zak lifts the block, Ann's acceptance shows to him, and his next line goes through (${show(z2)})`);

    // ── 7. read receipts ────────────────────────────────────────────────────────────────────────
    console.log('── 7. no read receipt either way until accepted ──');
    await call('POST', ann, '/api/messages/mark-read', { conversationId: idaConv });
    await call('POST', ida, '/api/messages/mark-read', { conversationId: idaConv });
    const idaEntry = entryOf(await listOf(ida), idaConv);
    const idaRead = await call('GET', ida, `/api/messages/${idaConv}`);
    const annOfIda = entryOf(await listOf(ann), idaConv);
    const annReadIda = await call('GET', ann, `/api/messages/${idaConv}`);
    const cursorOf = (r: Res, who: Id) => r.body?.conversation?.readCursors?.find((c: any) => c.publicKey === who.pk)?.lastReadAt;
    assert(idaEntry?.peerLastReadAt === null && cursorOf(idaRead, ann) === null && !!cursorOf(idaRead, ida),
        `Ida can't see that Ann read it (${idaEntry?.peerLastReadAt}, ${cursorOf(idaRead, ann)})`);
    assert(annOfIda?.peerLastReadAt === null && cursorOf(annReadIda, ida) === null && !!cursorOf(annReadIda, ann),
        'nor Ann that Ida read hers');
    await decide(ann, idaConv, 'accept');
    const idaAfter = entryOf(await listOf(ida), idaConv);
    assert(!!idaAfter?.peerLastReadAt, 'once accepted, the read markers show as in any chat');

    // ── 8. 30 days ──────────────────────────────────────────────────────────────────────────────
    console.log('── 8. 30 days ──');
    const hal = member('Hal');
    const halConv: string = (await open(hal, ann)).body?.conversation?.id;
    await send(halConv, hal);
    ageRequest(halConv, 31);
    const expired = attempt(() => requestsEngine.expireOldRequests(Date.now()));
    const annList8 = await listOf(ann);
    assert(typeof expired === 'number' && expired >= 1 && rowOf(halConv)?.state === 'expired' && !inRequests(annList8, halConv) && !inChats(annList8, halConv),
        `a request 31 days old expires and leaves her requests (${expired} expired)`);
    assert(entryOf(await listOf(hal), halConv)?.request?.state === 'expired', 'Hal\'s app is told it expired');
    const halSays = await nextLineSays(hal, halConv);
    assert(allSay(halSays, true), `and that his next line is the request, his line in it or not (${JSON.stringify(halSays)})`);
    const h2 = await send(halConv, hal);
    await sleep(100);
    assert(h2.status === 200 && rowOf(halConv)?.state === 'pending' && Date.parse(rowOf(halConv)?.requested_at) > Date.now() - HOUR
        && inRequests(await listOf(ann), halConv), `his next line is a new request, under her requests again (${show(h2)})`);
    assert((await send(halConv, hal)).status === 403, 'and the line after it waits as any request\'s does');
    // An ignored request is the same to its sender at 30 days, or ignoring would show.
    ageRequest(fConv, 31);
    ageRequest(giConv, 31);
    attempt(() => requestsEngine.expireOldRequests(Date.now()));
    const fyLate = entryOf(await listOf(fy), fConv)?.request?.state;
    const giLate = entryOf(await listOf(gi), giConv)?.request?.state;
    const f2 = await send(fConv, fy);
    const g2 = await send(giConv, gi);
    await sleep(100);
    assert(fyLate === 'expired' && giLate === 'expired' && f2.status === 200 && g2.status === 200,
        `at 30 days Fy's ignored request reads as Gi's expired one, and each may try again (${fyLate}, ${giLate}; ${f2.status}, ${g2.status})`);
    assert(inRequests(await listOf(ann), fConv) && rowOf(fConv)?.state === 'pending', 'Fy\'s new line is a new request she sees');

    // ── 9. probation ────────────────────────────────────────────────────────────────────────────
    console.log('── 9. a newcomer\'s requests count as new people ──');
    const wn = member('Wn', { words: true });
    const targets = [member('Pa'), member('Pb'), member('Pc'), member('Pd')];
    const opens = [];
    for (const t of targets) opens.push(await open(wn, t));
    assert(opens.slice(0, 3).every(r => r.status === 200 && r.body?.conversation?.request?.state === 'pending') && opens[3].status === 429
        && opens[3].body?.code === 'probation_limit', `a 12-words newcomer opens 3 requests, the 4th is refused as today (${opens.map(r => r.status).join(', ')})`);

    // ── 10. pushes ──────────────────────────────────────────────────────────────────────────────
    console.log('── 10. one push per request, folded to one an hour ──');
    const pat = member('Pat');
    const [ivy, jay, kai] = [member('Ivy'), member('Jay'), member('Kai')];
    const patBefore = noticesTo(pat).length;
    for (const s of [ivy, jay, kai]) {
        const c: string = (await open(s, pat)).body?.conversation?.id;
        await send(c, s);
        await send(c, s);   // refused: no push for it
    }
    await sleep(250);
    assert(JSON.stringify(noticesTo(pat).slice(patBefore)) === JSON.stringify(['Ivy wants to message you']),
        `three requests in an hour: one push, for the first (${JSON.stringify(noticesTo(pat).slice(patBefore))})`);
    attempt(() => requestsEngine.tickRequestPushFolds(dispatchPushNotification, Date.now() + 30 * 60_000));
    await sleep(100);
    assert(noticesTo(pat).length === patBefore + 1, 'half an hour on, still one');
    attempt(() => requestsEngine.tickRequestPushFolds(dispatchPushNotification, Date.now() + HOUR + 60_000));
    await sleep(100);
    assert(JSON.stringify(noticesTo(pat).slice(patBefore)) === JSON.stringify(['Ivy wants to message you', 'Someone new wants to message you']),
        `an hour on, one more for the two that waited, naming nobody (${JSON.stringify(noticesTo(pat).slice(patBefore))})`);
    attempt(() => requestsEngine.tickRequestPushFolds(dispatchPushNotification, Date.now() + 3 * HOUR));
    await sleep(100);
    assert(noticesTo(pat).length === patBefore + 2, 'and nothing more after that, with nothing new');

    // ── 11. a removed or deleted sender ─────────────────────────────────────────────────────────
    console.log('── 11. a removed or deleted sender\'s request goes ──');
    const jo = member('Jo');
    const kim = member('Kim');
    const joConv: string = (await open(jo, ann)).body?.conversation?.id;
    await send(joConv, jo);
    const kimConv: string = (await open(kim, ann)).body?.conversation?.id;
    const kimLine: string = (await send(kimConv, kim)).body?.message?.id;
    // And one waiting FOR a member who is then removed: Ann's to Lin.
    const lin = member('Lin');
    const linConv: string = (await open(ann, lin)).body?.conversation?.id;
    await send(linConv, ann);
    const annList11a = await listOf(ann);
    assert(inRequests(annList11a, joConv) && inRequests(annList11a, kimConv) && !inChats(annList11a, joConv) && !inChats(annList11a, kimConv)
        && rowOf(linConv)?.state === 'pending', 'both wait under her requests, and hers waits for Lin');
    const unreadBefore11 = annList11a?.totalUnread;
    attempt(() => adminPruneUser(jo.pk, 'owner:password'));
    const purged = attempt(() => purgeMemberSelf(kim.pk));
    attempt(() => adminPruneUser(lin.pk, 'owner:password'));
    const annList11 = await listOf(ann);
    const kimRow = db.prepare('SELECT type FROM messages WHERE id = ?').get(kimLine) as { type?: string } | undefined;
    // The conversation stays (a removed member's line with it), so the request is ignored, never deleted: with no row it would
    // be an ordinary chat in her list and her unread count (PR #2392 review 4354387983).
    assert(rowOf(joConv)?.state === 'ignored' && !inRequests(annList11, joConv) && !inChats(annList11, joConv),
        `a removed member's request goes from her list, and is not a chat either (row ${rowOf(joConv)?.state})`);
    assert(purged?.ok === true && rowOf(kimConv)?.state === 'ignored' && !inRequests(annList11, kimConv) && !inChats(annList11, kimConv)
        && kimRow?.type === 'removed', `a deleted member's goes too, and their line is blanked (${purged?.message}; ${kimRow?.type})`);
    const counts11 = attempt(() => getListedUnreadCounts(ann.pk)) ?? { [joConv]: 1, [kimConv]: 1 };
    assert(annList11?.totalUnread === unreadBefore11 && !(joConv in counts11) && !(kimConv in counts11),
        `neither is in her unread count or her badge (unread ${unreadBefore11} → ${annList11?.totalUnread})`);
    assert(!rowOf(linConv), 'the request waiting for a removed member goes, from the node');

    // ── 12. Ignore all ──────────────────────────────────────────────────────────────────────────
    console.log('── 12. Ignore all ──');
    const waiting = (await listOf(ann))?.requests?.count ?? 0;
    const all = await call('POST', ann, '/api/messages/request/ignore-all', {});
    const annList12 = await listOf(ann);
    assert(all.status === 200 && waiting >= 2 && all.body?.ignored === waiting && annList12?.requests?.count === 0,
        `every waiting request is ignored at once, and none is left (${show(all)}; ${waiting} were waiting)`);
    assert(rowOf(fConv)?.state === 'ignored' && rowOf(boConv)?.state === 'accepted', 'an accepted chat is left as it is');

    // ── 13. a re-key ────────────────────────────────────────────────────────────────────────────
    console.log('── 13. a re-key moves them ──');
    const lu = member('Lu');
    const luConv: string = (await open(lu, ann)).body?.conversation?.id;
    await send(luConv, lu);
    const luNew = newId('LuNew');
    const moved = attempt(() => { const code = issueRekeyCode(lu.pk, owner.pk).code; return completeRekey(lu.pk, luNew.pk, code, owner.pk); });
    assert(!!moved && rowOf(luConv)?.from_pubkey === luNew.pk, `Lu's request is from her new key (${rowOf(luConv)?.from_pubkey?.slice(0, 8)})`);
    const annRekey = await call('POST', ann, '/api/messages/request', { conversationId: luConv, decision: 'accept' });
    assert(annRekey.status === 200 && rowOf(luConv)?.state === 'accepted', 'and Ann accepts it there');

    // ── 14. a standby ───────────────────────────────────────────────────────────────────────────
    console.log('── 14. a standby ──');
    const mia = member('Mia');
    const ned = member('Ned');
    const miaConv: string = (await open(mia, ann)).body?.conversation?.id;
    await send(miaConv, mia);
    setNodeRole('backup');
    const sAccept = await decide(ann, miaConv, 'accept');
    const sIgnore = await decide(ann, miaConv, 'ignore');
    const sAll = await call('POST', ann, '/api/messages/request/ignore-all', {});
    const sOpen = await open(ned, ann);
    setNodeRole('primary');
    assert([sAccept, sIgnore, sAll].every(r => r.status === 503 && r.body?.code === 'standby') && rowOf(miaConv)?.state === 'pending',
        `a standby refuses every decision, 503 (${[sAccept, sIgnore, sAll].map(r => r.status).join(', ')})`);
    assert(sOpen.status === 409 && sOpen.body?.code === 'standby' && !db.prepare(
        `SELECT 1 FROM conversation_participants a JOIN conversation_participants b ON a.conversation_id = b.conversation_id
          WHERE a.public_key = ? AND b.public_key = ?`).get(ned.pk, ann.pk),
        `and an open that would be a request, writing nothing (${show(sOpen)})`);

    const p2p = await startP2P(0, 0);
    const nodeId = p2p.peerId.toString();
    pinMainServerForTests(`/ip4/127.0.0.1/tcp/4291/p2p/${nodeId}`);
    const everyRequest = () => (attempt(() => db.prepare('SELECT * FROM dm_requests ORDER BY conversation_id').all()) ?? []) as any[];
    const realRequests = () => everyRequest().filter(r => db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(r.conversation_id));
    const mainRows = realRequests();
    const annAnswer = async () => { const l = await listOf(ann); return JSON.stringify({ requests: l?.requests, chats: l?.conversations?.map((c: any) => [c.id, c.request]) }); };
    const mainAnswer = await annAnswer();
    const whole: any = await exportSyncState(nodeId);
    const carried: any[] = [...(whole.plainTables?.dm_requests ?? [])].sort((a, b) => (a.conversation_id < b.conversation_id ? -1 : 1));
    assert(mainRows.length >= 10 && JSON.stringify(carried) === JSON.stringify(mainRows),
        `a whole copy carries every request verbatim (${carried.length} of ${mainRows.length})`);
    assert(!!rowOf(huConv) && !carried.some(r => r.conversation_id === huConv),
        'but never one kept for a blocked opener alone, whose chat no copy has');
    const since = new Date().toISOString();
    await sleep(5);
    await decide(ann, miaConv, 'accept');
    const delta: any = await exportSyncState(nodeId, since);
    const dRows: any[] = delta.plainTables?.dm_requests ?? [];
    assert(dRows.length === 1 && dRows[0].conversation_id === miaConv && dRows[0].state === 'accepted',
        `a delta carries the decision (${dRows.map(r => `${r.conversation_id === miaConv ? 'Mia' : '?'}:${r.state}`).join(', ')})`);
    // A new standby: the whole copy, then the delta.
    const wholeCopy = await signSyncPayload((({ signature: _s, publicKey: _k, ...rest }) => rest)(whole));
    const deltaCopy = await signSyncPayload((({ signature: _s, publicKey: _k, ...rest }) => rest)(delta));
    const afterRows = realRequests();
    const afterAnswer = await annAnswer();
    attempt(() => emptyCopiedTables(db));
    attempt(() => db.prepare('DELETE FROM dm_requests').run());
    setNodeRole('backup');
    let importError = '';
    try { await importRemoteState(wholeCopy, { full: true }); } catch (e: any) { importError = e?.message || String(e); }
    const standbyWhole = JSON.stringify(realRequests());
    try { await importRemoteState(deltaCopy); } catch (e: any) { importError ||= e?.message || String(e); }
    setNodeRole('primary');
    assert(importError === '' && standbyWhole === JSON.stringify(mainRows),
        `a standby's whole copy holds them exactly (${importError || `${JSON.parse(standbyWhole).length} rows`})`);
    assert(JSON.stringify(realRequests()) === JSON.stringify(afterRows), 'and its delta brings the decision');
    assert(await annAnswer() === afterAnswer && afterAnswer !== mainAnswer, 'taken over, it answers Ann\'s list as the main server did');

    for (const s of [annSock, boSock, fySock]) s.ws.close();
}

async function localRun(): Promise<void> {
    const ann = member('Ann');
    const bo = member('Bo');

    // ── 15. off by default ──────────────────────────────────────────────────────────────────────
    console.log('── 15. off on a local community ──');
    const info = await call('GET', null, '/api/community/info');
    const cfg = await call('GET', null, '/api/node/config');
    assert(info.body?.features && !('dmRequests' in info.body.features) && cfg.body?.dmRequests === false,
        `a local community has requests off: not in its features, off in its settings (${cfg.body?.dmRequests})`);
    const bOpen = await open(bo, ann);
    const boConv: string = bOpen.body?.conversation?.id;
    const b1 = await send(boConv, bo);
    const b2 = await send(boConv, bo);
    await sleep(150);
    const annList = await listOf(ann);
    assert(bOpen.status === 200 && !('request' in (bOpen.body?.conversation ?? {})) && b1.status === 200 && b2.status === 200,
        `a stranger's open and two lines go through as today (${show(bOpen)})`);
    assert(inChats(annList, boConv) && annList?.totalUnread === 2 && !('requests' in (annList ?? {})) && !('request' in (entryOf(annList, boConv) ?? {})),
        'her list is as it always was: the chat, two unread, nothing about requests');

    // ── 16. the operator turns them on ──────────────────────────────────────────────────────────
    console.log('── 16. the operator turns them on ──');
    const admin = ownerTokenHeaders('admin');
    const badSet = await call('POST', null, '/api/local/admin/node/config', { dmRequests: 'yes' }, admin);
    const set = await call('POST', null, '/api/local/admin/node/config', { dmRequests: true }, admin);
    const cfgOn = await call('GET', null, '/api/node/config');
    const infoOn = await call('GET', null, '/api/community/info');
    assert(badSet.status === 400 && set.status === 200 && set.body?.dmRequests === true && cfgOn.body?.dmRequests === true && infoOn.body?.features?.dmRequests === true,
        `Settings turns it on, and only with true or false (${badSet.status}; ${show(set)})`);
    const cy = member('Cy');
    const cOpen = await open(cy, ann);
    const cyConv: string = cOpen.body?.conversation?.id;
    await send(cyConv, cy);
    const c2 = await send(cyConv, cy);
    assert(cOpen.body?.conversation?.request?.state === 'pending' && c2.status === 403, 'now a stranger\'s open is a request');
    const b3 = await send(boConv, bo);
    assert(b3.status === 200 && (await open(bo, ann)).body?.conversation?.request === null, `a chat opened before stays an ordinary one (${show(b3)})`);

    // ── 17. trades ──────────────────────────────────────────────────────────────────────────────
    console.log('── 17. trades go straight through ──');
    const post = (author: Id) => {
        const id = crypto.randomUUID();
        db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, active, status)
                    VALUES (?, 'offer', 'general', 'Eggs', 'A dozen', 5, ?, ?, 1, 'active')`).run(id, author.pk, iso(Date.now()));
        return id;
    };
    const trade = (buyer: Id, seller: Id, status: string) => db.prepare(
        `INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status) VALUES (?, ?, ?, ?, 5, ?)`)
        .run(crypto.randomUUID(), post(seller), buyer.pk, seller.pk, status);
    const dee = member('Dee');
    const tradeConv = attempt(() => ensureTransactionConversation(post(ann), dee.pk, ann.pk));
    const d1 = await send(tradeConv!, dee);
    const d2 = await send(tradeConv!, dee);
    assert(!!tradeConv && !rowOf(tradeConv) && d1.status === 200 && d2.status === 200, 'a trade\'s chat is the node\'s: no request');
    const fy = member('Fy');
    trade(fy, ann, 'pending');
    const fOpen = await open(fy, ann);
    const gi = member('Gi');
    trade(ann, gi, 'completed');
    const gOpen = await open(gi, ann);
    const hal = member('Hal');
    trade(hal, ann, 'cancelled');
    const hOpen = await open(hal, ann);
    assert(fOpen.body?.conversation?.request === null && gOpen.body?.conversation?.request === null && hOpen.body?.conversation?.request?.state === 'pending',
        `a pending trade, or a completed one, goes straight through; a cancelled one doesn't (${[fOpen, gOpen, hOpen].map(r => r.body?.conversation?.request?.state ?? 'none').join(', ')})`);
    const gus = member('Gus');
    const gusConv: string = (await open(gus, ann)).body?.conversation?.id;
    await send(gusConv, gus);
    attempt(() => ensureTransactionConversation(post(gus), ann.pk, gus.pk));
    assert(rowOf(gusConv)?.state === 'accepted' && (await send(gusConv, gus)).status === 200, 'a trade between them opening accepts the request');

    // ── 18. turned off again ────────────────────────────────────────────────────────────────────
    console.log('── 18. turned off again ──');
    // While on: one Ann ignores (Ike's, Kit's), and one whose opener is removed, which the removal ignores (Jem's).
    const [ike, jem, kit] = [member('Ike'), member('Jem'), member('Kit')];
    const ikeConv: string = (await open(ike, ann)).body?.conversation?.id;
    const jemConv: string = (await open(jem, ann)).body?.conversation?.id;
    const kitConv: string = (await open(kit, ann)).body?.conversation?.id;
    for (const [c, s] of [[ikeConv, ike], [jemConv, jem], [kitConv, kit]] as [string, Id][]) await send(c, s);
    const ignoreIke = await decide(ann, ikeConv, 'ignore');
    const ignoreKit = await decide(ann, kitConv, 'ignore');
    attempt(() => adminPruneUser(jem.pk, 'owner:password'));
    // And one that lapsed before its opener was removed (PR #2392 review 4354806402): Op's.
    const op = member('Op');
    const opConv: string = (await open(op, ann)).body?.conversation?.id;
    await send(opConv, op);
    ageRequest(opConv, 31);
    attempt(() => requestsEngine.expireOldRequests(Date.now()));
    const opLapsed = rowOf(opConv)?.state;
    attempt(() => adminPruneUser(op.pk, 'owner:password'));
    const unreadOn = (await listOf(ann))?.totalUnread;
    const off = await call('POST', null, '/api/local/admin/node/config', { dmRequests: false }, admin);
    const c3 = await send(cyConv, cy);
    await sleep(100);
    const annOff = await listOf(ann);
    assert(off.status === 200 && off.body?.dmRequests === false && c3.status === 200 && inChats(annOff, cyConv) && !('requests' in (annOff ?? {})),
        `off again, Cy's waiting request is an ordinary chat (${show(c3)})`);
    // What Ann ignored, and what a removal ignored, stays out of her chats, her unread count and her badge (PR #2392 review
    // 4354581049): only Cy's chat, waiting until now, adds to her unread.
    const countsOff = attempt(() => getListedUnreadCounts(ann.pk)) ?? { [ikeConv]: 1 };
    assert(ignoreIke.status === 200 && ignoreKit.status === 200 && rowOf(jemConv)?.state === 'ignored'
        && ![ikeConv, jemConv, kitConv].some(c => inChats(annOff, c) || c in countsOff)
        && annOff?.totalUnread === unreadOn + entryOf(annOff, cyConv)?.unreadCount,
        `the requests ignored while on stay out of her chats and her unread count (unread ${unreadOn} → ${annOff?.totalUnread})`);
    // Either of them writing again, or Ann asking for the chat herself, brings it back as an ordinary chat, so nothing is
    // stored or pushed into a chat she can't find.
    const pushedOff = noticesTo(ann).length;
    const i2 = await send(ikeConv, ike);
    const annAsksKit = await open(ann, kit);
    await sleep(150);
    const annBack = await listOf(ann);
    assert(i2.status === 200 && inChats(annBack, ikeConv) && entryOf(annBack, ikeConv)?.unreadCount === 2
        && JSON.stringify(noticesTo(ann).slice(pushedOff)) === JSON.stringify(['Ike sent you a message']),
        `Ike writes again: his chat is an ordinary one in her chats, pushed as one (${show(i2)}; ${JSON.stringify(noticesTo(ann).slice(pushedOff))})`);
    assert(annAsksKit.status === 200 && annAsksKit.body?.conversation?.id === kitConv && inChats(annBack, kitConv) && rowOf(kitConv)?.state === 'accepted',
        `Ann asks for the chat with Kit herself: it accepts his request, and it is in her chats (${show(annAsksKit)})`);
    assert(!inChats(annBack, jemConv), 'the removed member\'s stays out');
    const countsBack = attempt(() => getListedUnreadCounts(ann.pk)) ?? { [opConv]: 1 };
    assert(opLapsed === 'expired' && rowOf(opConv)?.state === 'ignored' && !inChats(annOff, opConv) && !inChats(annBack, opConv) && !(opConv in countsBack),
        `so does one that had lapsed before its opener was removed: ignored, out of her chats and her badge (${opLapsed} → ${rowOf(opConv)?.state})`);

    // ── 19. on again ────────────────────────────────────────────────────────────────────────────
    console.log('── 19. on again ──');
    // What Ann did while they were off accepts what was waiting for her then (PR #2392 review 4354806252), so turning them
    // on again leaves each chat where she put it. Lu, Mo and Nia each write while on; while off, Ann answers Lu, who
    // writes again, she adds Mo, and she asks for the chat with Nia.
    const on2 = await call('POST', null, '/api/local/admin/node/config', { dmRequests: true }, admin);
    const [lu, mo, nia] = [member('Lu'), member('Mo'), member('Nia')];
    const luConv: string = (await open(lu, ann)).body?.conversation?.id;
    const moConv: string = (await open(mo, ann)).body?.conversation?.id;
    const niaConv: string = (await open(nia, ann)).body?.conversation?.id;
    for (const [c, s] of [[luConv, lu], [moConv, mo], [niaConv, nia]] as [string, Id][]) await send(c, s);
    const waitingOn = [luConv, moConv, niaConv].map(c => rowOf(c)?.state);
    const off2 = await call('POST', null, '/api/local/admin/node/config', { dmRequests: false }, admin);
    const acts19 = [
        await send(luConv, ann), await send(luConv, ann), await send(luConv, lu), await send(luConv, lu),
        await call('POST', ann, '/api/friends/add', { friendPubkey: mo.pk }),
        await open(ann, nia),
    ];
    await sleep(100);
    const annOff2 = await listOf(ann);
    assert(on2.status === 200 && off2.status === 200 && waitingOn.every(st => st === 'pending') && acts19.every(r => r.status === 200)
        && [luConv, moConv, niaConv].every(c => inChats(annOff2, c) && rowOf(c)?.state === 'accepted'),
        `while off, her answer, her add and her own open each accept the one waiting for her (${[luConv, moConv, niaConv].map(c => rowOf(c)?.state).join(', ')})`);
    const on3 = await call('POST', null, '/api/local/admin/node/config', { dmRequests: true }, admin);
    const annOn2 = await listOf(ann);
    const counts19 = attempt(() => getListedUnreadCounts(ann.pk)) ?? {};
    const luReads = await call('GET', lu, `/api/messages/${luConv}`);
    const unread19 = (list: any) => [luConv, moConv, niaConv].map(c => entryOf(list, c)?.unreadCount ?? 0);
    assert(on3.status === 200 && [luConv, moConv, niaConv].every(c => inChats(annOn2, c) && !inRequests(annOn2, c) && c in counts19)
        && JSON.stringify(unread19(annOn2)) === JSON.stringify(unread19(annOff2)) && unread19(annOn2).reduce((n, u) => n + u, 0) === 5,
        `on again, each stays in her chats with its unread lines, and in her badge (${JSON.stringify(unread19(annOff2))} → ${JSON.stringify(unread19(annOn2))}; requests ${annOn2?.requests?.count})`);
    assert(luReads.body?.conversation?.request?.state === 'accepted', `and Lu reads it as accepted (${JSON.stringify(luReads.body?.conversation?.request)})`);
}

main().then(() => process.exit(0)).catch((e) => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
