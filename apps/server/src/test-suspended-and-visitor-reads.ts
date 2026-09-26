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
 *     how every send reaches the row, with Beans), the recipient of a send the node refused (POST /api/ledger/transfer),
 *     which gets no row, a federation visitor, and the old key of a member being re-keyed each get no Community contact
 *     (the member list and the profile page), no voters (the board), no activity feed and no distances. A real member
 *     made every way there is (the genesis member, an invite, an offline ticket, the open door) gets all four, as do the
 *     suspended and the disabled member once their suspension is lifted.
 *  2. The gate: a visitor reads its own conversation list, its DM and its Beans (balance, transactions) and nothing
 *     else gated (the directory, a profile, its standing, someone else's Beans or chats, the whole ledger, groups). A
 *     suspended member still reads their own messages, standing and balance, and still sends a message.
 *  3. /ws: a suspended or disabled member's socket (opened before the suspension, or after it), a visitor's, a replaced
 *     key's and a stranger's get no voters and no member feed (member_joined), while a member's gets both; a suspended
 *     member's and a visitor's still get their own messages. A socket signed before its key joined is made a member
 *     socket when member_joined goes out for it, but never for a replaced key. A lifted suspension, and a visitor who
 *     joins, bring the member feed back to the socket already open.
 *  4. A visitor joins: the membership probe says it is no member until then; an invite, an offline ticket (each redeem
 *     signed by the visitor's own key, as both apps sign it) and the open door each make its row a member's (not
 *     "already a member"), use the code, keep its DMs and Beans, and it reads as a member. It may knock.
 *     registerVisitor never makes a member's row a visitor's.
 *  5. Invites refuse a key a re-key replaced: an invite code and an offline ticket, and neither is used.
 *  6. Replication: the export carries the mark (never the member directory); a standby takes it on a row it never had
 *     and on an older copy, takes a visitor's join (who invited them, the code), and keeps its own mark when a main
 *     server from before the column sends none. The main server's copy says its visitors are marked, and a standby
 *     that copies it writes the one-time marker; a copy from before the column writes none.
 *  7. Only a visitor's own key makes its row a member's: an unsigned redeem, or one signed by another key, naming a
 *     visitor (by a DM, or federation), code or ticket, is refused and writes nothing (no rename, no inviter or code,
 *     no joined_at, no feed line, the code and the ticket unused); the visitor's own signed redeem of the same code and
 *     ticket then joins, keeping its DM and Beans; a key with no row still joins unsigned. A visitor's row brings
 *     nobody in: it can't make an invite (the answer a key with no row gets), a code it made before this version and a
 *     ticket it signs admit nobody, itself included, and it can neither approve nor decline a knock (403 not_member,
 *     as a key with no row). A member, and a suspended or a disabled one, still makes an invite; a member answers
 *     knocks; a suspended member still can't (#1177). A visitor's own knock is on the members' list and in the
 *     operator's count, survives the tidy-up, and a member approves it from the list; the visitor then joins with its
 *     own signed redeem of that invite (4110436318).
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
    const { knockerRefusal, openKnockCount, tidyKnocks } = await import('./engine/knocks.js');
    const { registerVisitor } = await import('./engine/members.js');
    // The signature middleware refuses a visitor's write that isn't its own (visitor-allowlist.ts) before any route. The
    // writes below measure each route's own check behind it, with it off, then ask the gate's answer with it on. Loaded so
    // the suite runs to the end, and says what fails, on a tree without it.
    const { setVisitorGateForTests } = await import('./visitor-allowlist.js')
        .catch(() => ({ setVisitorGateForTests: (_on: boolean) => { /* no gate on this tree */ } }));

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

    // Real members, every way in. Unsigned, as a key with no row may redeem; `signer` signs the redeem, as both apps do.
    const joinWithInvite = async (id: Id, signer?: Id) => {
        const invite = se.generateInvite(gen.pubKeyHex)!;
        const res = await post('/api/invite/redeem', { code: invite.code, publicKey: id.pubKeyHex, callsign: id.callsign }, signer);
        return { res, code: invite.code };
    };
    const joinWithTicket = async (id: Id, signer?: Id) => {
        const ticketB64 = offlineTicket(gen);
        return post('/api/invite/redeem-offline', { ticketB64, publicKey: id.pubKeyHex, callsign: id.callsign }, signer);
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
    // A refused send makes no row (test-visitors-cant-act section 4): the recipient reads below as the key with no row it is.
    assert(refusedSend.status === 400 && !row(tex2.pubKeyHex),
        `a send from a member with no trade yet is refused (${refusedSend.status}), and the recipient gets no row`);
    const rita = keypair('RemoteRita');
    registerVisitor(rita.pubKeyHex, rita.callsign, 'https://peer.example.test');
    const vo = keypair('DmVo');
    const voConv = await post('/api/messages/conversation', { type: 'dm', participants: [olive.pubKeyHex, vo.pubKeyHex], createdBy: olive.pubKeyHex }, olive);
    assert(voConv.status === 200, `Olive opens a DM to another key with no account here (${voConv.status} ${voConv.text.slice(0, 80)})`);
    for (const [label, id] of [['the DM', dee], ['the transfer', tex], ['the federation handshake', rita], ['the second DM', vo]] as const) {
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
        ['the recipient of a refused send (no row)', tex2],
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
        // Each visitor signs its own redeem, as both apps do: only its own key makes its row a member's (§7).
        const deeJoin = await joinWithInvite(dee, dee);
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

        const texJoin = await joinWithTicket(tex, tex);
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

    // ── 6. Replication: a standby knows who is a visitor ───────────────────────────────────────────────────────────
    if (!READ_AUTH_OFF) {
        console.log('\n── 6. replication: a standby holds the visitor mark, and a visitor who joined ──');
        const { startP2P } = await import('./p2p.js');
        const { addConnector } = await import('./connector-manager.js');
        const zed = keypair('ZedVisitor');
        const yan = keypair('YanVisitor');
        se.transfer('genesis', zed.pubKeyHex, 1, 'hello', 'direct', true);
        se.transfer('genesis', yan.pubKeyHex, 1, 'hello', 'direct', true);
        const p2p = await startP2P(4296, 4297);
        const nodeId = p2p.peerId.toString();
        addConnector(`/ip4/127.0.0.1/tcp/4297/p2p/${nodeId}`, 'mirror', 'self-test-peer');
        const payload: any = await se.exportSyncState(nodeId);
        const exported = (pk: string) => (payload.members ?? []).find((m: any) => m.publicKey === pk);
        assert(exported(zed.pubKeyHex)?.isVisitor === true && exported(dee.pubKeyHex)?.isVisitor === false && exported(gen.pubKeyHex)?.isVisitor === false,
            'the export carries isVisitor: true for a visitor, false for a member and for a visitor who joined');
        const directory = (await get('/api/members', gen)).body;
        assert(Array.isArray(directory) && directory.length > 0 && directory.every((m: any) => !('isVisitor' in m)), 'the member directory never carries it');
        // A standby that never had Zed (the insert path), holds Yan as a member (an older copy: the update path), and
        // holds Dee as the visitor she was before she joined.
        const OLD = '2000-01-01T00:00:00.000Z';
        db.prepare('DELETE FROM members WHERE public_key = ?').run(zed.pubKeyHex);
        db.prepare('DELETE FROM accounts WHERE public_key = ?').run(zed.pubKeyHex);
        db.prepare('UPDATE members SET is_visitor = 0, updated_at = ? WHERE public_key = ?').run(OLD, yan.pubKeyHex);
        db.prepare('UPDATE members SET is_visitor = 1, invited_by = NULL, invite_code = NULL, updated_at = ? WHERE public_key = ?').run(OLD, dee.pubKeyHex);
        se.setNodeRole('backup');
        await se.importRemoteState(payload);
        se.setNodeRole('primary');
        assert(visitorFlag(zed.pubKeyHex) === 1, `a visitor the standby never had arrives as a visitor (is_visitor ${visitorFlag(zed.pubKeyHex)})`);
        assert(visitorFlag(yan.pubKeyHex) === 1, `an older copy takes the mark (is_visitor ${visitorFlag(yan.pubKeyHex)})`);
        const deeBack = row(dee.pubKeyHex);
        assert(deeBack.is_visitor === 0 && deeBack.invited_by === gen.pubKeyHex && !!deeBack.invite_code,
            `a visitor who joined on the main server is a member on the standby, with who invited her and the code (is_visitor ${deeBack.is_visitor}, invited_by ${String(deeBack.invited_by).slice(0, 8)})`);
        // A main server from before the column sends no isVisitor: the standby keeps its own mark.
        db.prepare('UPDATE members SET updated_at = ? WHERE public_key = ?').run(OLD, yan.pubKeyHex);
        const { signature: _sig, publicKey: _pub, visitorsMarked: _marked, ...unsigned } = payload;
        void _sig; void _pub; void _marked;
        const legacy = await se.signSyncPayload({ ...unsigned, members: (payload.members ?? []).filter((m: any) => m.publicKey === yan.pubKeyHex).map((m: any) => {
            const { isVisitor: _dropped, ...rest } = m;
            void _dropped;
            return rest;
        }) });
        se.setNodeRole('backup');
        await se.importRemoteState(legacy);
        se.setNodeRole('primary');
        assert(visitorFlag(yan.pubKeyHex) === 1, `a copy from a main server that predates the column leaves the mark as it is (is_visitor ${visitorFlag(yan.pubKeyHex)})`);

        // A standby marks nobody itself (db.ts markExistingVisitors): its copy lacks some of what the rule reads. The main
        // server says in every copy that its marks are made, and the standby then writes the one-time marker, so a
        // promotion doesn't mark again on less evidence. A copy from a main server that predates the column says nothing,
        // and the standby's pass is left to run if it is promoted.
        const marker = () => (db.prepare("SELECT value FROM node_config WHERE key = 'migration_mark_visitors_v1'").get() as { value: string } | undefined)?.value ?? null;
        assert(payload.visitorsMarked === true, `the main server's copy says its visitors are marked (visitorsMarked ${payload.visitorsMarked})`);
        db.prepare("DELETE FROM node_config WHERE key = 'migration_mark_visitors_v1'").run();
        se.setNodeRole('backup');
        await se.importRemoteState(legacy);
        se.setNodeRole('primary');
        assert(marker() === null, `a standby that copies a main server from before the column writes no marker, so its own pass runs if it is promoted (${marker()})`);
        se.setNodeRole('backup');
        await se.importRemoteState(payload);
        se.setNodeRole('primary');
        assert(marker() !== null, `a standby that copies a main server whose visitors are marked writes the marker: a promotion keeps the main server's marks (${marker()})`);

        // A whole copy gives the main server's mark to a row the standby holds at the same stamp without it: what an import
        // from before the column left (4110436371). The same version of the row, and the main server is the only writer
        // of a standby's copy, so its mark is the row's, either way; the row keeps the main server's stamp. (The touch
        // trigger restamps a change of the mark, so each stamp here is put back by itself.)
        const holdAtStamp = (pk: string, flag: number, stamp: string) => {
            db.prepare('UPDATE members SET is_visitor = ? WHERE public_key = ?').run(flag, pk);
            db.prepare('UPDATE members SET updated_at = ? WHERE public_key = ?').run(stamp, pk);
        };
        const zedStamp = exported(zed.pubKeyHex)?.updatedAt as string;
        const deeStamp = exported(dee.pubKeyHex)?.updatedAt as string;
        holdAtStamp(zed.pubKeyHex, 0, zedStamp);
        holdAtStamp(dee.pubKeyHex, 1, deeStamp);
        se.setNodeRole('backup');
        await se.importRemoteState(payload);
        se.setNodeRole('primary');
        assert(visitorFlag(zed.pubKeyHex) === 1 && row(zed.pubKeyHex).updated_at === zedStamp,
            `a whole copy marks a visitor's row the standby holds unmarked at the same stamp, and keeps the stamp (is_visitor ${visitorFlag(zed.pubKeyHex)}, ${row(zed.pubKeyHex).updated_at} / ${zedStamp})`);
        assert(visitorFlag(dee.pubKeyHex) === 0 && row(dee.pubKeyHex).updated_at === deeStamp,
            `…and the other way, a member's row held as a visitor's at the same stamp is a member's again (is_visitor ${visitorFlag(dee.pubKeyHex)}, ${row(dee.pubKeyHex).updated_at} / ${deeStamp})`);
        await p2p.stop();
    }

    // ── 7. Only a visitor's own key joins with its row; a visitor's row brings nobody in ───────────────────────────
    console.log('\n── 7. only a visitor itself joins with its row, and a visitor brings nobody in ──');
    {
        const feedLines = (pk: string) => (db.prepare("SELECT COUNT(*) AS n FROM activity_feed WHERE event_type = 'member_joined' AND actor_pubkey = ?").get(pk) as { n: number }).n;
        const codeUser = (code: string) => (db.prepare('SELECT used_by FROM invite_codes WHERE code = ?').get(code) as { used_by: string | null } | undefined)?.used_by ?? null;
        const codesUsedBy = (pk: string) => (db.prepare('SELECT COUNT(*) AS n FROM invite_codes WHERE used_by = ?').get(pk) as { n: number }).n;
        const snapshot = (pk: string) => {
            const r = row(pk);
            return JSON.stringify([r.callsign, r.invited_by, r.invite_code, r.joined_at, r.is_visitor, r.updated_at]);
        };

        // Val: a visitor made by a member's DM, with Beans. Vera: a federation visitor.
        const val = keypair('VisitorVal');
        const valConv = await post('/api/messages/conversation', { type: 'dm', participants: [olive.pubKeyHex, val.pubKeyHex], createdBy: olive.pubKeyHex }, olive);
        se.transfer('genesis', val.pubKeyHex, 3, 'beans for Val', 'direct', true);
        const vera = keypair('VisitorVera');
        registerVisitor(vera.pubKeyHex, vera.callsign, 'https://peer.example.test');
        assert(valConv.status === 200 && visitorFlag(val.pubKeyHex) === 1 && visitorFlag(vera.pubKeyHex) === 1,
            `two visitors: Val (a DM and 3 Beans) and Vera (federation) (${valConv.status}, ${visitorFlag(val.pubKeyHex)}, ${visitorFlag(vera.pubKeyHex)})`);
        const code = se.generateInvite(gen.pubKeyHex)!.code;
        const ticketB64 = offlineTicket(gen);
        const before = new Map([[val.pubKeyHex, snapshot(val.pubKeyHex)], [vera.pubKeyHex, snapshot(vera.pubKeyHex)]]);
        // The name the deciding pass measured: the genesis member's, so an unsigned redeem can't dress a visitor as her.
        const attempts: [string, string, Record<string, string>, Id | undefined, Id][] = [
            ["an unsigned invite redeem naming a DM-made visitor's key", '/api/invite/redeem', { code, publicKey: val.pubKeyHex, callsign: gen.callsign }, undefined, val],
            ["an invite redeem signed by another key (a member's) naming it", '/api/invite/redeem', { code, publicKey: val.pubKeyHex, callsign: gen.callsign }, olive, val],
            ['an unsigned offline-ticket redeem naming it', '/api/invite/redeem-offline', { ticketB64, publicKey: val.pubKeyHex, callsign: gen.callsign }, undefined, val],
            ["an offline-ticket redeem signed by another key (a member's) naming it", '/api/invite/redeem-offline', { ticketB64, publicKey: val.pubKeyHex, callsign: gen.callsign }, olive, val],
            ["an unsigned invite redeem naming a federation visitor's key", '/api/invite/redeem', { code, publicKey: vera.pubKeyHex, callsign: gen.callsign }, undefined, vera],
            ['an unsigned offline-ticket redeem naming it', '/api/invite/redeem-offline', { ticketB64, publicKey: vera.pubKeyHex, callsign: gen.callsign }, undefined, vera],
        ];
        for (const [label, p, body, signer, target] of attempts) {
            const r = await post(p, body, signer);
            assert(r.status === 400 && r.body?.success !== true && !r.body?.member,
                `${label} is refused (${r.status} ${r.text.slice(0, 140)})`);
            assert(snapshot(target.pubKeyHex) === before.get(target.pubKeyHex) && feedLines(target.pubKeyHex) === 0 && codesUsedBy(target.pubKeyHex) === 0,
                `…and writes nothing: no rename, no inviter or code, no joined_at, no feed line, no code used, still a visitor (${row(target.pubKeyHex).callsign}, is_visitor ${visitorFlag(target.pubKeyHex)})`);
        }
        assert(codeUser(code) === null, 'the invite code is still unused after all of them');

        // The visitor's own signed redeem, of the same code and the same ticket (so neither was used above).
        const valJoin = await post('/api/invite/redeem', { code, publicKey: val.pubKeyHex, callsign: val.callsign }, val);
        const valRow = row(val.pubKeyHex);
        assert(valJoin.status === 200 && valJoin.body?.success === true && !valJoin.body?.alreadyMember && visitorFlag(val.pubKeyHex) === 0
            && valRow.invited_by === gen.pubKeyHex && valRow.invite_code === code && codeUser(code) === val.pubKeyHex && feedLines(val.pubKeyHex) === 1,
            `Val's own signed redeem of the same code makes her row a member's and uses the code (${valJoin.status} ${valJoin.text.slice(0, 100)})`);
        assert(Number(se.getBalance(val.pubKeyHex)?.balance) === 3, `…she keeps her 3 Beans (${se.getBalance(val.pubKeyHex)?.balance})`);
        const valConvs = await get(`/api/messages/conversations/${val.pubKeyHex}`, val);
        assert(valConvs.status === 200 && (valConvs.body?.conversations ?? []).some((c: any) => c.id === valConv.body?.conversation?.id),
            `…and her DM with Olive (${valConvs.status})`);
        await expectReader('Val, joined with her own signed redeem', val);
        const veraJoin = await post('/api/invite/redeem-offline', { ticketB64, publicKey: vera.pubKeyHex, callsign: vera.callsign }, vera);
        assert(veraJoin.status === 200 && !veraJoin.body?.alreadyMember && visitorFlag(vera.pubKeyHex) === 0 && row(vera.pubKeyHex).invited_by === gen.pubKeyHex,
            `Vera's own signed redeem of the same ticket makes her row a member's (${veraJoin.status} ${veraJoin.text.slice(0, 100)})`);

        // A key with no row still joins unsigned, code and ticket, as before.
        const nell = keypair('NewNell');
        const nellJoin = await post('/api/invite/redeem', { code: se.generateInvite(gen.pubKeyHex)!.code, publicKey: nell.pubKeyHex, callsign: nell.callsign });
        assert(nellJoin.status === 200 && !nellJoin.body?.alreadyMember && visitorFlag(nell.pubKeyHex) === 0,
            `a key with no row still joins with an unsigned invite redeem (${nellJoin.status} ${nellJoin.text.slice(0, 100)})`);
        const nora = keypair('NewNora');
        const noraJoin = await post('/api/invite/redeem-offline', { ticketB64: offlineTicket(gen), publicKey: nora.pubKeyHex, callsign: nora.callsign });
        assert(noraJoin.status === 200 && !noraJoin.body?.alreadyMember && visitorFlag(nora.pubKeyHex) === 0,
            `…and with an unsigned offline-ticket redeem (${noraJoin.status} ${noraJoin.text.slice(0, 100)})`);

        // A visitor's row brings nobody in: no invite, no offline ticket, no answer to a knock. A key with no row gets the
        // same answers.
        const wes = keypair('VisitorWes');
        se.transfer('genesis', wes.pubKeyHex, 1, 'hello', 'direct', true);
        const nobody = keypair('NobodyNat');
        assert(visitorFlag(wes.pubKeyHex) === 1 && !row(nobody.pubKeyHex), 'Wes is a visitor (a transfer); Nat has no row');
        setVisitorGateForTests(false);
        const wesMakes = await post('/api/invite/generate', { publicKey: wes.pubKeyHex }, wes);
        const natMakes = await post('/api/invite/generate', { publicKey: nobody.pubKeyHex }, nobody);
        assert(wesMakes.status === 403 && wesMakes.status === natMakes.status && wesMakes.text === natMakes.text,
            `a visitor can't make an invite: the answer a key with no row gets (${wesMakes.status} ${wesMakes.text.slice(0, 80)} / ${natMakes.status} ${natMakes.text.slice(0, 80)})`);
        setVisitorGateForTests(true);
        const wesMakesGated = await post('/api/invite/generate', { publicKey: wes.pubKeyHex }, wes);
        assert(wesMakesGated.status === 403 && wesMakesGated.body?.code === 'not_a_member',
            `…and through the signature middleware's gate, 403 not_a_member before the route (${wesMakesGated.status} ${wesMakesGated.text.slice(0, 80)})`);
        assert(se.generateInvite(wes.pubKeyHex) === null && !db.prepare('SELECT 1 FROM invite_codes WHERE created_by = ?').get(wes.pubKeyHex), '…and no code is written');

        // Members still do, a suspended and a disabled one included, as #1177 left them.
        const sam = seedMember('SuspendedSam');
        const samReport = se.submitReport(reporter.pubKeyHex, sam.pubKeyHex, 'Spamming the market chats');
        assert(!!samReport?.id && se.actionReport(samReport!.id, false, true) === true && row(sam.pubKeyHex).status === 'suspended', 'Sam is suspended through a report');
        const dora = seedMember('DisabledDora');
        se.adminSetUserStatus(dora.pubKeyHex, 'disabled');
        for (const [label, id] of [['a member', olive], ['a suspended member', sam], ['a disabled member', dora]] as const) {
            const made = await post('/api/invite/generate', { publicKey: id.pubKeyHex }, id);
            assert(made.status === 200 && !!made.body?.invite?.code, `${label} still makes an invite (${made.status} ${made.text.slice(0, 80)})`);
        }

        // A code a visitor made before this version (on main, `generateInvite` asked only for the act test), and an
        // offline ticket a visitor signs: neither brings in someone new, nor the visitor itself.
        const wesCode = 'INV-WESV-ISIT';
        db.prepare('INSERT INTO invite_codes (code, created_by, created_at) VALUES (?, ?, ?)').run(wesCode, wes.pubKeyHex, new Date().toISOString());
        const pip = keypair('NewPip');
        const checked = await get(`/api/invite/check?code=${wesCode}`);
        assert(checked.status === 200 && checked.body?.valid === false, `the pre-flight check calls a visitor's code no good (${checked.text.slice(0, 100)})`);
        const viaWesCode = await post('/api/invite/redeem', { code: wesCode, publicKey: pip.pubKeyHex, callsign: pip.callsign });
        assert(viaWesCode.status === 400 && !row(pip.pubKeyHex) && codeUser(wesCode) === null,
            `a code a visitor made brings nobody in, and stays unused (${viaWesCode.status} ${viaWesCode.text.slice(0, 100)})`);
        const selfRedeem = await post('/api/invite/redeem', { code: wesCode, publicKey: wes.pubKeyHex, callsign: 'WesTheMember' }, wes);
        assert(selfRedeem.status === 400 && visitorFlag(wes.pubKeyHex) === 1 && codeUser(wesCode) === null,
            `…nor the visitor itself, with its own signed redeem (${selfRedeem.status} ${selfRedeem.text.slice(0, 100)})`);
        const viaWesTicket = await post('/api/invite/redeem-offline', { ticketB64: offlineTicket(wes), publicKey: pip.pubKeyHex, callsign: pip.callsign });
        assert(viaWesTicket.status === 400 && !row(pip.pubKeyHex),
            `an offline ticket a visitor signs brings nobody in (${viaWesTicket.status} ${viaWesTicket.text.slice(0, 100)})`);
        const selfTicket = await post('/api/invite/redeem-offline', { ticketB64: offlineTicket(wes), publicKey: wes.pubKeyHex, callsign: 'WesTheMember' }, wes);
        assert(selfTicket.status === 400 && visitorFlag(wes.pubKeyHex) === 1 && codesUsedBy(wes.pubKeyHex) === 0,
            `…nor the visitor itself (${selfTicket.status} ${selfTicket.text.slice(0, 100)})`);

        // Knocks: a visitor neither approves nor declines one; a member does both; a suspended member still doesn't.
        const knockBody = (id: Id) => ({ callsign: id.callsign, message: `Hello from ${id.callsign}, I live nearby.`, fromNode: 'https://global.beanpool.org/' });
        const kay = keypair('KnockingKay');
        const knockId = (id: Id) => (db.prepare('SELECT id FROM join_requests WHERE pubkey = ?').get(id.pubKeyHex) as { id: string } | undefined)?.id ?? '';
        const kayKnock = await post('/api/join/knock', knockBody(kay), kay);
        const kayId = knockId(kay);
        assert(kayKnock.status === 201 && !!kayId, `Kay asks to join (${kayKnock.status} ${kayKnock.text.slice(0, 100)})`);
        for (const verb of ['approve', 'decline']) {
            setVisitorGateForTests(false);
            const byWes = await post(`/api/join/knocks/${kayId}/${verb}`, {}, wes);
            const byNat = await post(`/api/join/knocks/${kayId}/${verb}`, {}, nobody);
            assert(byWes.status === 403 && byWes.body?.code === 'not_member' && byWes.status === byNat.status && byWes.body?.code === byNat.body?.code,
                `a visitor can't ${verb} a knock: 403 not_member, as a key with no row (${byWes.status} ${byWes.body?.code} / ${byNat.status} ${byNat.body?.code})`);
            setVisitorGateForTests(true);
            const byWesGated = await post(`/api/join/knocks/${kayId}/${verb}`, {}, wes);
            assert(byWesGated.status === 403 && byWesGated.body?.code === 'not_a_member',
                `…and through the gate, 403 not_a_member before the route (${byWesGated.status} ${byWesGated.body?.code})`);
        }
        const kayRow = db.prepare('SELECT status, invite_code FROM join_requests WHERE id = ?').get(kayId) as { status: string; invite_code: string | null } | undefined;
        assert(kayRow?.status === 'pending' && !kayRow?.invite_code, `…and Kay's knock is still waiting, with no invite (${kayRow?.status})`);
        const samAnswers = await post(`/api/join/knocks/${kayId}/approve`, {}, sam);
        assert(samAnswers.status === 403 && samAnswers.body?.code === 'not_active',
            `a suspended member still can't answer a knock, as #1177 left them (${samAnswers.status} ${samAnswers.body?.code})`);
        const oliveApproves = await post(`/api/join/knocks/${kayId}/approve`, {}, olive);
        assert(oliveApproves.status === 200 && !!oliveApproves.body?.invite, `a member approves Kay's knock (${oliveApproves.status} ${oliveApproves.text.slice(0, 100)})`);
        const kim = keypair('KnockingKim');
        const kimKnock = await post('/api/join/knock', knockBody(kim), kim);
        const oliveDeclines = await post(`/api/join/knocks/${knockId(kim)}/decline`, {}, olive);
        assert(kimKnock.status === 201 && oliveDeclines.status === 200, `a member declines Kim's knock (${kimKnock.status}, ${oliveDeclines.status} ${oliveDeclines.text.slice(0, 100)})`);

        // A visitor's knock (4110436318): its row is no member's, so what it sent is on the members' list and in the
        // operator's count, the tidy-up leaves it, and a member's invite from the list lets it in with its own signed
        // redeem. Not a knock accepted and then shown to nobody.
        const kit = keypair('KnockingKit');
        const kitConv = await post('/api/messages/conversation', { type: 'dm', participants: [olive.pubKeyHex, kit.pubKeyHex], createdBy: olive.pubKeyHex }, olive);
        assert(kitConv.status === 200 && visitorFlag(kit.pubKeyHex) === 1, `Kit is a visitor: Olive messaged her (${kitConv.status}, is_visitor ${visitorFlag(kit.pubKeyHex)})`);
        const countBefore = openKnockCount();
        const kitKnock = await post('/api/join/knock', knockBody(kit), kit);
        assert(kitKnock.status === 201 && kitKnock.body?.knock?.status === 'pending', `Kit asks to join (${kitKnock.status} ${kitKnock.text.slice(0, 100)})`);
        const kitListed = async () => {
            const list = await get('/api/join/knocks?limit=50', olive);
            return { list, knock: (list.body?.knocks ?? []).find((k: any) => k.pubkey === kit.pubKeyHex) };
        };
        const listed = await kitListed();
        assert(listed.list.status === 200 && listed.knock?.callsign === kit.callsign && listed.knock?.message === knockBody(kit).message && listed.knock?.fromNode === 'global.beanpool.org',
            `a visitor's knock is on the members' list, with what it sent (${listed.list.status}, total ${listed.list.body?.total}, ${listed.knock ? 'listed' : 'not listed'})`);
        assert(openKnockCount() === countBefore + 1 && listed.list.body?.total === openKnockCount(),
            `…and in the operator's count (${countBefore} → ${openKnockCount()}, the list's total ${listed.list.body?.total})`);
        tidyKnocks();
        const kitRow = db.prepare('SELECT status, callsign, message, from_node FROM join_requests WHERE pubkey = ?').get(kit.pubKeyHex) as any;
        const afterTidy = await kitListed();
        assert(kitRow?.status === 'pending' && kitRow?.callsign === kit.callsign && kitRow?.message === knockBody(kit).message && kitRow?.from_node === 'global.beanpool.org'
            && afterTidy.knock?.id === listed.knock?.id,
            `the tidy-up leaves it whole and listed (${kitRow?.status}, callsign '${kitRow?.callsign}', ${afterTidy.knock ? 'listed' : 'not listed'})`);
        const kitApproved = await post(`/api/join/knocks/${listed.knock?.id}/approve`, {}, olive);
        assert(kitApproved.status === 200 && !!kitApproved.body?.invite?.code, `a member approves it from the list (${kitApproved.status} ${kitApproved.text.slice(0, 100)})`);
        const kitStatus = await get('/api/join/knock/status', kit);
        assert(kitStatus.body?.status === 'approved' && kitStatus.body?.invite === kitApproved.body?.invite?.code,
            `Kit's app reads the invite (${kitStatus.status} ${kitStatus.body?.status})`);
        const kitJoin = await post('/api/invite/redeem', { code: kitStatus.body?.invite, publicKey: kit.pubKeyHex, callsign: kit.callsign }, kit);
        const kitMember = row(kit.pubKeyHex);
        assert(kitJoin.status === 200 && kitJoin.body?.success === true && !kitJoin.body?.alreadyMember && visitorFlag(kit.pubKeyHex) === 0
            && kitMember.invite_code === kitStatus.body?.invite && kitMember.invited_by === olive.pubKeyHex && codeUser(kitStatus.body?.invite) === kit.pubKeyHex,
            `Kit joins with her own signed redeem of that invite: her row is a member's, invited by Olive, the code used (${kitJoin.status} ${kitJoin.text.slice(0, 100)})`);
        assert(knockerRefusal(kit.pubKeyHex) === 'already_member' && !(await kitListed()).knock,
            `…and, a member now, she knocks no more and her knock is off the list (${knockerRefusal(kit.pubKeyHex)})`);
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
