/**
 * A suspended member, while that lasts, and a visitor's row see what a non-member sees (Marty's board answers,
 * 2026-09-26: cards suspended-members-read and visitor-rows).
 *
 * What only members may read goes to a reader who reads as a member (readsAsMember): contact details shared with
 * Community, who voted for what in a poll, the activity feed, the People list's distances and the /ws member feed. A
 * suspended or disabled member keeps their account and what they may do, and their own messages and deals, but gets a
 * non-member's copy of those while the suspension lasts, and a member's again the moment it ends. A visitor's row (a key
 * a member messaged or sent Beans to, or a member of another community) receives its messages and Beans and reads only
 * those; joining for real makes the same row a member's, keeping both.
 *
 * Boots the real server; every read goes over HTTP through the real signature middleware, or over /ws.
 *
 *  1. Member-only reads, for each reader: a member suspended through a report, one disabled by an admin, a visitor made
 *     by a DM (POST /api/messages/conversation), one made by a transfer (transfer() from the genesis account, which is
 *     how every send reaches the row, with Beans), one made by a send the node refused (POST /api/ledger/transfer), a
 *     federation visitor, and the old key of a member being re-keyed each get no Community contact (the member list and
 *     the profile page), no voters (the board), no activity feed and no distances. A real member made every way there is
 *     (the genesis member, an invite, an offline ticket, the open door) gets all four, as do the suspended and the
 *     disabled member once their suspension is lifted.
 *  2. The gate: a visitor reads its own conversation list, its DM and its Beans (balance, transactions) and nothing
 *     else gated (the directory, a profile, its standing, someone else's Beans or chats, the whole ledger, groups). A
 *     suspended member still reads their own messages, standing and balance, and still sends a message.
 *  3. /ws: a suspended or disabled member's socket (opened before the suspension, or after it), a visitor's, a replaced
 *     key's and a stranger's get no voters and no member feed (member_joined), while a member's gets both; a suspended
 *     member's and a visitor's still get their own messages. A socket signed before its key joined is made a member
 *     socket when member_joined goes out for it, but never for a replaced key. A lifted suspension, and a visitor who
 *     joins, bring the member feed back to the socket already open.
 *  4. A visitor joins: the membership probe says it is no member until then; an invite, an offline ticket and the open
 *     door each make its row a member's (not "already a member"), use the code, keep its DMs and Beans, and it reads as
 *     a member. It may knock. registerVisitor never makes a member's row a visitor's.
 *  5. Invites refuse a key a re-key replaced: an invite code and an offline ticket, and neither is used.
 *
 * Runs twice: here with every ENFORCE_* variable REMOVED (the fresh-download default: read auth on, the member-only
 * /ws feed), then in a child process with ENFORCE_READ_AUTH=false, where the gate doesn't run and each route's own
 * test (contactViewer, the viewer tier, peoplePoint) must hold 1 on its own.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-suspended-and-visitor-reads.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
// The read-auth-off node is the child run below; the flags are module consts read at import, so they are settled
// before the dynamic imports in main().
const READ_AUTH_OFF = process.env.SUSPENDED_VISITOR_READS_OPEN === '1';
if (!READ_AUTH_OFF) {
    delete process.env.ENFORCE_READ_AUTH;
    delete process.env.ENFORCE_WS_AUTH;
    delete process.env.ENFORCE_LEDGER_AUTH;
}
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const MODE = READ_AUTH_OFF ? '[read auth off]' : '[defaults]';
let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${MODE} ${msg}`);
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject; callsign: string };

function keypair(callsign: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pubKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey, callsign };
}

function signedHeaders(method: string, p: string, body: string, id: Id): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${p.split('?')[0]}\n${ts}\n${nonce}\n${body}`;
    return {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
}

type Answer = { status: number; text: string; body: any };

async function answerOf(res: Response): Promise<Answer> {
    const text = await res.text();
    let body: any;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, body };
}

async function get(p: string, id?: Id): Promise<Answer> {
    return answerOf(await fetch(`${BASE}${p}`, { headers: id ? signedHeaders('GET', p, '', id) : {} }));
}

async function post(p: string, payload: unknown, id?: Id): Promise<Answer> {
    const body = JSON.stringify(payload);
    return answerOf(await fetch(`${BASE}${p}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(id ? signedHeaders('POST', p, body, id) : {}) },
        body,
    }));
}

function signedWsQuery(id: Id): string {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`WS\n/ws\n${ts}\n${nonce}\n`), id.privateKey).toString('base64');
    return `pubkey=${id.pubKeyHex}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`;
}

type Socket = { ws: WebSocket; events: any[]; raw: string[] };

function openSocket(url: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { rejectUnauthorized: false });
        const events: any[] = [];
        const raw: string[] = [];
        ws.on('message', (d) => { raw.push(d.toString()); try { events.push(JSON.parse(d.toString())); } catch { /* */ } });
        ws.on('open', () => resolve({ ws, events, raw }));
        ws.on('error', reject);
        setTimeout(() => reject(new Error('socket did not open')), 3000);
    });
}

/** An offline ticket, as the app signs one: the payload and its signature, base64 JSON. */
function offlineTicket(inviter: Id): string {
    const payload = JSON.stringify({ i: inviter.pubKeyHex, t: Date.now() });
    const s = crypto.sign(null, Buffer.from(payload), inviter.privateKey).toString('base64');
    return Buffer.from(JSON.stringify({ p: payload, s })).toString('base64');
}

const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const CONTACT = 'olive.contact@example.test';
const POINT = 'lat=-28.64&lng=153.61';

async function main() {
    console.log(`Suspended members and visitors see what a non-member sees ${MODE}...\n`);
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { issueRekeyCode } = await import('./engine/member-wizards.js');
    const { registerOpenJoin, openJoinHash, openJoinAddressHash } = await import('./engine/open-join.js');
    const { knockerRefusal } = await import('./engine/knocks.js');
    const { registerVisitor } = await import('./engine/members.js');

    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    /** members.is_visitor, or null on a node without the column. */
    const visitorFlag = (pk: string): number | null => {
        try { return (db.prepare('SELECT is_visitor FROM members WHERE public_key = ?').get(pk) as any)?.is_visitor ?? null; } catch { return null; }
    };
    const row = (pk: string): any => db.prepare('SELECT * FROM members WHERE public_key = ?').get(pk);

    // ── The people ─────────────────────────────────────────────────────────────────────────────────────────────────
    const gen = keypair('GenesisGwen');
    se.seedGenesisMember(gen.pubKeyHex, gen.callsign);
    // Members seeded as the doors write them (an inviter and a code), with a photo and Beans.
    const seedMember = (callsign: string): Id => {
        const id = keypair(callsign);
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, avatar_url)
                    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?, ?)`)
            .run(id.pubKeyHex, callsign, gen.pubKeyHex, `INV-${callsign.toUpperCase()}`, AVATAR);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pubKeyHex);
        se.transfer('genesis', id.pubKeyHex, 50, `seed ${callsign}`, 'direct', true);
        return id;
    };
    const olive = seedMember('OliveOwner');   // shares her contact with the Community, hosts the poll's DMs
    db.prepare("UPDATE members SET contact_value = ?, contact_visibility = 'community' WHERE public_key = ?").run(CONTACT, olive.pubKeyHex);
    const vic = seedMember('VoterVic');       // the voter
    const sue = seedMember('SuspendedSue');   // suspended through a report, then lifted
    const dis = seedMember('DisabledDan');    // disabled by an admin, then lifted
    const rex = seedMember('RekeyRex');       // a member whose phone is lost: an operator issues a re-key code
    const reporter = seedMember('ReporterRae');

    // Real members, every way in.
    const joinWithInvite = async (id: Id) => {
        const invite = se.generateInvite(gen.pubKeyHex)!;
        const res = await post('/api/invite/redeem', { code: invite.code, publicKey: id.pubKeyHex, callsign: id.callsign });
        return { res, code: invite.code };
    };
    const joinWithTicket = async (id: Id) => {
        const ticketB64 = offlineTicket(gen);
        return post('/api/invite/redeem-offline', { ticketB64, publicKey: id.pubKeyHex, callsign: id.callsign });
    };
    const joinOpenDoor = (id: Id, sub: string) => registerOpenJoin(se.broadcast, {
        publicKey: id.pubKeyHex, callsign: id.callsign, provider: 'google',
        joinHash: openJoinHash('google', sub), ipHash: openJoinAddressHash(`test-${sub}`),
    });
    const ivy = keypair('InvitedIvy');
    const ivyJoin = await joinWithInvite(ivy);
    assert(ivyJoin.res.status === 200 && !ivyJoin.res.body?.alreadyMember, `a member joins with an invite (${ivyJoin.res.status} ${ivyJoin.res.text.slice(0, 120)})`);
    const tia = keypair('TicketTia');
    const tiaJoin = await joinWithTicket(tia);
    assert(tiaJoin.status === 200 && !tiaJoin.body?.alreadyMember, `a member joins with an offline ticket (${tiaJoin.status} ${tiaJoin.text.slice(0, 120)})`);
    const oona = keypair('OpenDoorOona');
    const oonaJoin = joinOpenDoor(oona, 'oona-sub');
    assert(oonaJoin.ok === true, `a member joins through the open door (${JSON.stringify(oonaJoin).slice(0, 120)})`);

    // A poll Vic votes on: its voters are member-only.
    const poll = se.createPost('poll', 'community', 'Where should the seed bank go?', '', 0, 'fixed', olive.pubKeyHex,
        undefined, undefined, undefined, false, undefined, false,
        { pollOptions: [{ id: 'opt_hall', text: 'The hall' }, { id: 'opt_shed', text: 'The shed' }] });
    assert(!!poll?.id, 'Olive opens a poll');
    const pollId = poll!.id;
    let voteIndex = 0;
    const vote = async () => {
        const optionId = voteIndex++ % 2 === 0 ? 'opt_shed' : 'opt_hall';
        const voted = await post(`/api/marketplace/posts/${pollId}/vote`, { optionId }, vic);
        assert(voted.status === 200, `Vic votes (${voted.status} ${voted.text.slice(0, 80)})`);
        await sleep(350);
    };
    await vote();
    const namesVoter = (text: string) => text.includes(vic.pubKeyHex) || text.includes(vic.callsign);

    // Visitors' rows, made the ways they are made.
    const dee = keypair('DmDee');
    const deeConv = await post('/api/messages/conversation', { type: 'dm', participants: [olive.pubKeyHex, dee.pubKeyHex], createdBy: olive.pubKeyHex }, olive);
    assert(deeConv.status === 200 && !!deeConv.body?.conversation?.id, `Olive opens a DM to a key with no account here (${deeConv.status} ${deeConv.text.slice(0, 100)})`);
    const deeConvId = deeConv.body?.conversation?.id as string;
    const deeMsg = await post('/api/messages/send', { conversationId: deeConvId, authorPubkey: olive.pubKeyHex, ciphertext: 'aGVsbG8=', nonce: 'bm9uY2U=' }, olive);
    assert(deeMsg.status === 200, `…and sends it a message (${deeMsg.status} ${deeMsg.text.slice(0, 80)})`);
    const tex = keypair('TransferTex');
    const texTx = se.transfer('genesis', tex.pubKeyHex, 5, 'welcome beans', 'direct', true);
    assert(!!texTx, 'a transfer to a key with no account here lands, with its 5 Beans');
    const tex2 = keypair('RefusedTex2');
    const refusedSend = await post('/api/ledger/transfer', { to: tex2.pubKeyHex, amount: 1 }, olive);
    assert(refusedSend.status === 400, `a send from a member with no trade yet is refused (${refusedSend.status}), after the node has made the recipient's row`);
    const rita = keypair('RemoteRita');
    registerVisitor(rita.pubKeyHex, rita.callsign, 'https://peer.example.test');
    const vo = keypair('DmVo');
    const voConv = await post('/api/messages/conversation', { type: 'dm', participants: [olive.pubKeyHex, vo.pubKeyHex], createdBy: olive.pubKeyHex }, olive);
    assert(voConv.status === 200, `Olive opens a DM to another key with no account here (${voConv.status} ${voConv.text.slice(0, 80)})`);
    for (const [label, id] of [['the DM', dee], ['the transfer', tex], ['the refused send', tex2], ['the federation handshake', rita], ['the second DM', vo]] as const) {
        assert(!!row(id.pubKeyHex) && visitorFlag(id.pubKeyHex) === 1, `${label} made a visitor's row (is_visitor ${visitorFlag(id.pubKeyHex)})`);
    }
    for (const [label, id] of [['the genesis member', gen], ['the invited member', ivy], ['the ticket member', tia], ['the open-door member', oona], ['a seeded member', olive]] as const) {
        assert(visitorFlag(id.pubKeyHex) === 0, `${label}'s row is a member's (is_visitor ${visitorFlag(id.pubKeyHex)})`);
    }

    // ── /ws sockets, opened before anyone is suspended ─────────────────────────────────────────────────────────────
    const wsBase = `${BASE.replace('https', 'wss')}/ws`;
    const nia = keypair('PendingNia'); // signs her connect before she has joined
    const sockets: Record<string, Socket> = READ_AUTH_OFF ? {} : {
        member: await openSocket(`${wsBase}?${signedWsQuery(gen)}`),
        sueBefore: await openSocket(`${wsBase}?${signedWsQuery(sue)}`),
        disBefore: await openSocket(`${wsBase}?${signedWsQuery(dis)}`),
        dee: await openSocket(`${wsBase}?${signedWsQuery(dee)}`),
        tex: await openSocket(`${wsBase}?${signedWsQuery(tex)}`),
        rita: await openSocket(`${wsBase}?${signedWsQuery(rita)}`),
        nia: await openSocket(`${wsBase}?${signedWsQuery(nia)}`),
        unsigned: await openSocket(wsBase),
    };
    const clear = () => { for (const s of Object.values(sockets)) { s.events.length = 0; s.raw.length = 0; } };
    const gotVoters = (s: Socket) => s.events.some(e => e.type === 'post_updated' && e.post?.id === pollId
        && Array.isArray(e.post.pollVotes) && e.post.pollVotes.some((v: any) => v.voterPubkey === vic.pubKeyHex));
    const heardVote = (s: Socket) => s.events.some(e => e.type === 'post_updated');

    // ── Suspensions and a re-key ───────────────────────────────────────────────────────────────────────────────────
    const report = se.submitReport(reporter.pubKeyHex, sue.pubKeyHex, 'Harassing people in the market chats');
    assert(!!report?.id, 'a member reports Sue');
    assert(se.actionReport(report!.id, false, true) === true && row(sue.pubKeyHex).status === 'suspended', 'a moderator actions the report and suspends Sue');
    se.adminSetUserStatus(dis.pubKeyHex, 'disabled');
    assert(row(dis.pubKeyHex).status === 'disabled', 'an admin suspends Dan (disabled)');
    issueRekeyCode(rex.pubKeyHex, 'owner:password');
    await sleep(200);
    if (!READ_AUTH_OFF) {
        sockets.sueAfter = await openSocket(`${wsBase}?${signedWsQuery(sue)}`);
        sockets.disAfter = await openSocket(`${wsBase}?${signedWsQuery(dis)}`);
        sockets.rex = await openSocket(`${wsBase}?${signedWsQuery(rex)}`);
        await sleep(150);
    }

    // ── 1. Member-only reads ───────────────────────────────────────────────────────────────────────────────────────
    const nonReaders: [string, Id][] = [
        ['a member suspended through a report', sue],
        ['a member disabled by an admin', dis],
        ['a DM-made visitor', dee],
        ['a transfer-made visitor', tex],
        ['a visitor made by a refused send', tex2],
        ['a federation visitor', rita],
        ["a re-key-invalidated key", rex],
    ];
    const readers: [string, Id][] = [
        ['the genesis member', gen],
        ['a member who joined with an invite', ivy],
        ['a member who joined with an offline ticket', tia],
        ['a member who joined through the open door', oona],
    ];

    /** What one reader gets of each member-only read. */
    const memberOnly = async (id: Id) => {
        const list = await get('/api/community/members', id);
        const profile = await get(`/api/profile/${olive.pubKeyHex}`, id);
        const board = await get('/api/marketplace/posts?type=poll', id);
        const feed = await get('/api/activity/feed', id);
        const feedSlash = await get('/api/activity/feed/', id);
        const distances = await get(`/api/community/members?${POINT}`, id);
        return { list, profile, board, feed, feedSlash, distances };
    };
    const expectNonReader = async (label: string, id: Id) => {
        const r = await memberOnly(id);
        assert(!r.list.text.includes(CONTACT) && !r.profile.text.includes(CONTACT),
            `${label}: no Community contact from the member list or the profile page (${r.list.status}, ${r.profile.status})`);
        assert(!namesVoter(r.board.text), `${label}: the board names no voter (${r.board.status})`);
        if (r.board.status === 200) {
            const p = (r.board.body?.posts ?? r.board.body ?? []).find?.((x: any) => x.id === pollId);
            assert(!!p && p.totalVotes === 1 && !('pollVotes' in p && Array.isArray(p.pollVotes) && p.pollVotes.length > 0),
                `${label}: the poll's count is there and its voters are not (totalVotes ${p?.totalVotes})`);
        }
        if (!READ_AUTH_OFF) {
            assert(r.feed.status === 403 && r.feedSlash.status === 403 && !namesVoter(r.feed.text),
                `${label}: no activity feed (${r.feed.status}, with a trailing slash ${r.feedSlash.status})`);
        }
        assert(r.distances.status === 403, `${label}: no distances to people (${r.distances.status})`);
    };
    const expectReader = async (label: string, id: Id) => {
        const r = await memberOnly(id);
        assert(r.list.status === 200 && r.list.text.includes(CONTACT), `${label}: Olive's Community contact on the member list (${r.list.status})`);
        assert(r.profile.status === 200 && r.profile.text.includes(CONTACT), `${label}: …and on her profile page (${r.profile.status})`);
        assert(r.board.status === 200 && r.board.text.includes(vic.pubKeyHex), `${label}: the poll's voters (${r.board.status})`);
        if (!READ_AUTH_OFF) {
            assert(r.feed.status === 200 && Array.isArray(r.feed.body?.feed) && r.feed.body.feed.length > 0, `${label}: the activity feed (${r.feed.status})`);
        }
        assert(r.distances.status === 200, `${label}: distances to people (${r.distances.status})`);
    };

    console.log('\n── 1. who gets what only members may read ──');
    for (const [label, id] of nonReaders) await expectNonReader(label, id);
    for (const [label, id] of readers) await expectReader(label, id);
    {
        const r = await memberOnly(keypair('NobodyNed'));
        assert(!r.list.text.includes(CONTACT) && !namesVoter(r.board.text) && r.distances.status === 403,
            `a signed key with no row gets none of it, as before (${r.list.status}, ${r.board.status}, ${r.distances.status})`);
    }

    // ── 2. The gate: a visitor's own, and a suspended member's own ────────────────────────────────────────────────
    if (!READ_AUTH_OFF) {
        console.log('\n── 2. a visitor reads its own messages and Beans; a suspended member their own account ──');
        const convs = await get(`/api/messages/conversations/${dee.pubKeyHex}`, dee);
        assert(convs.status === 200 && (convs.body?.conversations ?? []).some((c: any) => c.id === deeConvId),
            `the DM-made visitor reads its own conversation list, with Olive's DM in it (${convs.status})`);
        const thread = await get(`/api/messages/${deeConvId}`, dee);
        assert(thread.status === 200 && thread.text.includes('aGVsbG8='), `…and the DM itself, with Olive's message (${thread.status})`);
        const deeBalance = await get(`/api/ledger/balance/${dee.pubKeyHex}`, dee);
        assert(deeBalance.status === 200, `…and its own balance (${deeBalance.status})`);
        const texBalance = await get(`/api/ledger/balance/${tex.pubKeyHex}`, tex);
        assert(texBalance.status === 200 && Number(texBalance.body?.balance) === 5, `the transfer-made visitor reads its 5 Beans (${texBalance.status} ${texBalance.text.slice(0, 80)})`);
        const texTxs = await get(`/api/ledger/transactions?publicKey=${tex.pubKeyHex}`, tex);
        assert(texTxs.status === 200 && Array.isArray(texTxs.body) && texTxs.body.some((t: any) => t.to === tex.pubKeyHex && t.amount === 5),
            `…and the transfer that brought them (${texTxs.status})`);

        const oliveGen = se.createConversation('dm', [olive.pubKeyHex, gen.pubKeyHex], olive.pubKeyHex)!;
        const refusedToVisitor: [string, string, Id][] = [
            ['the member directory', '/api/members', dee],
            ["a member's profile", `/api/profile/${olive.pubKeyHex}`, dee],
            ['its standing here', '/api/community/me', dee],
            ["someone else's balance", `/api/ledger/balance/${olive.pubKeyHex}`, tex],
            ['the whole ledger', '/api/ledger/transactions', tex],
            ["someone else's transactions", `/api/ledger/transactions?publicKey=${olive.pubKeyHex}`, tex],
            ["someone else's conversation list", `/api/messages/conversations/${olive.pubKeyHex}`, dee],
            ['a DM it is not in', `/api/messages/${oliveGen.id}`, dee],
            ['the groups', '/api/groups', dee],
            ['a federation visitor: the member directory', '/api/members', rita],
        ];
        for (const [label, p, id] of refusedToVisitor) {
            const r = await get(p, id);
            assert(r.status === 403, `a visitor is refused ${label}, as a non-member is (${r.status})`);
        }

        const sueConvs = await get(`/api/messages/conversations/${sue.pubKeyHex}`, sue);
        assert(sueConvs.status === 200, `a suspended member still reads their own conversation list (${sueConvs.status})`);
        const sueMe = await get('/api/community/me', sue);
        assert(sueMe.status === 200 && sueMe.body?.publicKey === sue.pubKeyHex, `…their own standing (${sueMe.status})`);
        const sueBalance = await get(`/api/ledger/balance/${sue.pubKeyHex}`, sue);
        assert(sueBalance.status === 200, `…and their own balance (${sueBalance.status})`);
        const disMe = await get('/api/community/me', dis);
        assert(disMe.status === 200, `a disabled member still reads their own standing (${disMe.status})`);
        const sueDm = se.createConversation('dm', [olive.pubKeyHex, sue.pubKeyHex], olive.pubKeyHex)!;
        const sueSends = await post('/api/messages/send', { conversationId: sueDm.id, authorPubkey: sue.pubKeyHex, ciphertext: 'c29ycnk=', nonce: 'bm9uY2U=' }, sue);
        assert(sueSends.status === 200, `a suspended member still sends a message, as suspension allows (${sueSends.status} ${sueSends.text.slice(0, 80)})`);

        // ── 3. /ws ─────────────────────────────────────────────────────────────────────────────────────────────────
        console.log('\n── 3. /ws ──');
        const noFeed: [string, string][] = [
            ["a member suspended through a report: the socket opened before", 'sueBefore'],
            ['…and the one opened while suspended', 'sueAfter'],
            ["a disabled member: the socket opened before", 'disBefore'],
            ['…and the one opened while disabled', 'disAfter'],
            ["a DM-made visitor's", 'dee'],
            ["a transfer-made visitor's", 'tex'],
            ["a federation visitor's", 'rita'],
            ["a re-key-invalidated key's", 'rex'],
            ["a key with no row yet", 'nia'],
            ['an unsigned', 'unsigned'],
        ];
        clear();
        await vote();
        assert(gotVoters(sockets.member), "a member's socket gets the vote with its voters");
        for (const [label, key] of noFeed) {
            const s = sockets[key];
            assert(heardVote(s) && !gotVoters(s) && !s.raw.some(namesVoter), `${label} socket hears the poll changed and gets no voter`);
        }

        clear();
        const oliveToDee = await post('/api/messages/send', { conversationId: deeConvId, authorPubkey: olive.pubKeyHex, ciphertext: 'YWdhaW4=', nonce: 'bm9uY2U=' }, olive);
        const oliveToSue = await post('/api/messages/send', { conversationId: sueDm.id, authorPubkey: olive.pubKeyHex, ciphertext: 'aGk=', nonce: 'bm9uY2U=' }, olive);
        assert(oliveToDee.status === 200 && oliveToSue.status === 200, 'Olive messages the visitor and the suspended member');
        await sleep(350);
        const gotMessage = (s: Socket, conv: string) => s.events.some(e => e.type === 'new_message' && e.conversationId === conv);
        assert(gotMessage(sockets.dee, deeConvId), "the visitor's socket still gets its own message");
        assert(gotMessage(sockets.sueBefore, sueDm.id) && gotMessage(sockets.sueAfter, sueDm.id), "both of the suspended member's sockets still get their own message");
        assert(!gotMessage(sockets.member, deeConvId) && !gotMessage(sockets.tex, deeConvId), 'nobody else gets it');

        // A key with a socket signed before it joined joins: its socket becomes a member socket.
        clear();
        const niaJoin = await joinWithInvite(nia);
        assert(niaJoin.res.status === 200, 'Nia, whose socket is already open, joins with an invite');
        await sleep(300);
        assert(sockets.member.events.some(e => e.type === 'member_joined'), "a member's socket gets member_joined");
        for (const key of ['sueBefore', 'sueAfter', 'disBefore', 'dee', 'tex', 'rita', 'rex', 'unsigned']) {
            assert(!sockets[key].events.some(e => e.type === 'member_joined'), `the ${key} socket gets no member_joined (the member feed)`);
        }
        // member_joined for a key a re-key replaced (however it came to be sent) makes no member socket of its socket.
        se.broadcast({ type: 'member_joined', member: { publicKey: rex.pubKeyHex, callsign: rex.callsign, joinedAt: new Date().toISOString(), avatarUrl: null } });
        await sleep(100);
        clear();
        await vote();
        assert(gotVoters(sockets.nia), "Nia's socket, made a member socket when she joined, gets the voters");
        assert(!gotVoters(sockets.rex) && !sockets.rex.raw.some(namesVoter), "a replaced key's socket is not made a member socket by member_joined for it");

        // The suspension lifts: the sockets already open get the member feed again.
        se.adminSetUserStatus(sue.pubKeyHex, 'active');
        se.adminSetUserStatus(dis.pubKeyHex, 'active');
        await sleep(200);
        clear();
        await vote();
        assert(gotVoters(sockets.sueBefore) && gotVoters(sockets.sueAfter), "once Sue's suspension is lifted, both her open sockets get the voters again");
        assert(gotVoters(sockets.disBefore) && gotVoters(sockets.disAfter), "…and Dan's, once his is");
    }

    // The suspensions lift (again, for the read-auth-off run): each reads as a member at once.
    se.adminSetUserStatus(sue.pubKeyHex, 'active');
    se.adminSetUserStatus(dis.pubKeyHex, 'active');
    console.log('\n── 1b. a lifted suspension ──');
    await expectReader('Sue, her suspension lifted', sue);
    await expectReader('Dan, his suspension lifted', dis);

    // ── 4. A visitor joins ─────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. a visitor joins for real ──');
    {
        const probe = await get(`/api/community/membership/${dee.pubKeyHex}`);
        assert(probe.status === 200 && probe.body?.isMember === false, `the membership probe says the DM-made visitor is no member (${probe.text.slice(0, 80)})`);
        assert(knockerRefusal(vo.pubKeyHex) === null, `a visitor may ask to join (knockerRefusal ${knockerRefusal(vo.pubKeyHex)})`);
        const deeJoin = await joinWithInvite(dee);
        assert(deeJoin.res.status === 200 && !deeJoin.res.body?.alreadyMember, `the DM-made visitor joins with an invite, not as "already a member" (${deeJoin.res.text.slice(0, 120)})`);
        const deeRow = row(dee.pubKeyHex);
        const used = db.prepare('SELECT used_by FROM invite_codes WHERE code = ?').get(deeJoin.code) as any;
        assert(visitorFlag(dee.pubKeyHex) === 0 && deeRow.invited_by === gen.pubKeyHex && deeRow.invite_code === deeJoin.code && used?.used_by === dee.pubKeyHex,
            `its row is now a member's, with who invited it and the code, and the code is used (is_visitor ${visitorFlag(dee.pubKeyHex)}, invited_by ${String(deeRow.invited_by).slice(0, 8)})`);
        const after = await get(`/api/community/membership/${dee.pubKeyHex}`);
        assert(after.body?.isMember === true, 'the probe says it is a member now');
        await expectReader('the DM-made visitor, joined', dee);
        const convs = await get(`/api/messages/conversations/${dee.pubKeyHex}`, dee);
        assert(convs.status === 200 && (convs.body?.conversations ?? []).some((c: any) => c.id === deeConvId), 'it keeps its DM with Olive');

        const texJoin = await joinWithTicket(tex);
        assert(texJoin.status === 200 && !texJoin.body?.alreadyMember, `the transfer-made visitor joins with an offline ticket (${texJoin.text.slice(0, 120)})`);
        assert(visitorFlag(tex.pubKeyHex) === 0 && row(tex.pubKeyHex).invited_by === gen.pubKeyHex, 'its row is a member\'s now');
        assert(Number(se.getBalance(tex.pubKeyHex)?.balance) === 5, `it keeps its 5 Beans (${se.getBalance(tex.pubKeyHex)?.balance})`);
        await expectReader('the transfer-made visitor, joined', tex);

        const voJoin = joinOpenDoor(vo, 'vo-sub');
        assert(voJoin.ok === true, `the second DM-made visitor joins through the open door (${JSON.stringify(voJoin).slice(0, 100)})`);
        assert(visitorFlag(vo.pubKeyHex) === 0 && String(row(vo.pubKeyHex).invited_by).startsWith('open:'), 'its row is a member\'s now');
        await expectReader('the visitor who came in through the open door', vo);
        assert(knockerRefusal(vo.pubKeyHex) === 'already_member', 'and, a member now, it no longer knocks');

        if (!READ_AUTH_OFF) {
            clear();
            await vote();
            assert(gotVoters(sockets.dee) && gotVoters(sockets.tex), "the joined visitors' sockets, open all along, get the member feed now");
        }

        // A federation path meeting a member's row leaves it a member's.
        registerVisitor(ivy.pubKeyHex, 'Visitor-ivy', 'https://peer.example.test');
        assert(visitorFlag(ivy.pubKeyHex) === 0, 'registerVisitor on a member\'s row never makes it a visitor\'s');
        await expectReader('Ivy, after a federation path met her row', ivy);
    }

    // ── 5. Invites refuse a replaced key ──────────────────────────────────────────────────────────────────────────
    console.log('\n── 5. invites refuse a key a re-key replaced ──');
    {
        const invite = se.generateInvite(gen.pubKeyHex)!;
        const res = await post('/api/invite/redeem', { code: invite.code, publicKey: rex.pubKeyHex, callsign: 'RexAgain' });
        const used = db.prepare('SELECT used_by FROM invite_codes WHERE code = ?').get(invite.code) as any;
        assert(res.status === 400 && /replaced/i.test(res.body?.error ?? '') && !used?.used_by, `an invite code refuses it, unused (${res.status} ${res.text.slice(0, 100)})`);
        const ticket = await post('/api/invite/redeem-offline', { ticketB64: offlineTicket(gen), publicKey: rex.pubKeyHex, callsign: 'RexAgain' });
        const usedByRex = db.prepare('SELECT COUNT(*) AS n FROM invite_codes WHERE used_by = ?').get(rex.pubKeyHex) as any;
        assert(ticket.status === 400 && /replaced/i.test(ticket.body?.error ?? '') && usedByRex.n === 0, `an offline ticket refuses it, unused (${ticket.status} ${ticket.text.slice(0, 100)})`);
    }

    for (const s of Object.values(sockets)) s.ws.close();
    console.log(`\n${passed}/${run} checks passed ${MODE}.`);
    if (passed !== run) {
        console.error(`❌ ${run - passed} check(s) failed ${MODE}`);
        process.exit(1);
    }

    if (!READ_AUTH_OFF) {
        // The same people and reads on a node with read auth off: the gate doesn't run, so each route's own test decides.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beanpool-suspended-visitors-'));
        const child = spawnSync('pnpm', ['exec', 'tsx', fileURLToPath(import.meta.url)], {
            cwd: path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
            env: { ...process.env, SUSPENDED_VISITOR_READS_OPEN: '1', ENFORCE_READ_AUTH: 'false', BEANPOOL_DATA_DIR: dir },
            stdio: 'inherit',
        });
        fs.rmSync(dir, { recursive: true, force: true });
        if (child.status !== 0) {
            console.error('❌ the read-auth-off run failed');
            process.exit(1);
        }
    }
    console.log(`⭐️ Suspended members and visitors see what a non-member sees ${MODE}: PASSED`);
    process.exit(0);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
