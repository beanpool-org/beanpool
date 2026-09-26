/**
 * A key that isn't a live member of this node can't act on other people (#1159 round 3, review comments 4109135691
 * and 4109135769). A pruned account keeps its member row, its group roles and its open trades, and the old key of a
 * member being re-keyed (a lost or stolen phone) keeps its row too, set to 'suspended'. Both can still sign. Neither
 * may remove another member's event-chat message, close a trade, or bring someone in with an invite, and nothing
 * they are refused hands them a person.
 *
 * Every refusal below goes over HTTP through the real signature middleware.
 *
 *  1. Event chat: a pruned convenor removing another member's message from a group event, and a pruned host removing
 *     one from their own event (cancelled by the prune), are refused, and the message is kept. A live host still can,
 *     and the answer carries the writer's face as the chat shows it.
 *  2. Trades: the pruned party's reject, cancel-request, cancel and complete are refused with no person in the answer,
 *     including complete's answer for a trade it already completed; the live party closes every one of them, and a
 *     listing the prune cancelled stays down when its trade is cancelled.
 *  3. Re-key: the old key of a member being re-keyed is refused the same way (chat removal, a trade, an invite), and
 *     (4109566694, 4109566615) it can no longer delete the member's account, post as them (to one member, or to a
 *     group), change their profile, or edit another member's group event it convenes. The re-key then completes, signed
 *     by the new phone: the new key holds the member's account, with its Beans and profile.
 *  4. Invites: a pruned account can't make one; a code or an offline ticket it made before the prune no longer
 *     redeems, and the pre-flight check says so; a live member's and an admin's invites still redeem, the admin's
 *     even after the genesis member it hangs the code on has been pruned.
 *  5. The sweep, every other signed write that reaches another member or moves Beans: a pruned convenor runs the group
 *     no more (members, roles, invites, requests, details, lead, chat, posts, succession); a pruned voucher neither
 *     vouches nor unvouches; a pruned account rates, reports and reacts to nobody; the old key of a member being
 *     re-keyed opens, approves and buys no trade, messages and reacts to nobody, and pledges none of the member's Beans.
 *     A pruned convenor edits no event in its group (4109566615): the event is unchanged and nobody going is pushed that
 *     it moved; a live convenor still edits one, and the people going are told.
 *  6. The signature middleware refuses every signed request from a key a re-key replaced, pending or completed: every
 *     registered write it sees (each with a body that would reach its data), answered 403 `key_invalidated` before any
 *     handler runs, and nothing in the database changes. A signed read too; the same read unsigned is answered as
 *     before. The routes the middleware never sees (the admin surface, invite redemption) are left to their own checks,
 *     and invite redemption still refuses the replaced key itself. No flow needs a replaced key to sign.
 *  7. A re-key never brings back an account that was deleted (by its owner) or removed (pruned, by an admin or a
 *     community vote): completing it is refused in plain words, and nothing changes.
 *  8. Controls, unchanged: an ordinary member and a suspended one (the status a report suspension writes, not a re-key)
 *     still post, message and delete their own account; a member suspended by an admin or a vote ('disabled') is
 *     refused what it was before and can still delete their own account.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx apps/server/src/test-non-members-cant-act.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;
const PW = 'NonMembersPass123!';
process.env.ADMIN_PASSWORD = PW;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import {
    initStateEngine, transfer, createPost, acceptPost, requestPost, completePostTransaction,
    createGroup, joinGroup, rsvpEvent, postEventThreadMessage, adminPruneUser, seedGenesisMember,
    postGroupThreadMessage, vouchMember, createConversation, sendMessage, getBalance, proposeGroupConvenor,
    purgeMemberSelf,
} from './state-engine.js';
import { createCrowdfundProject } from './db/db.js';
import { issueRekeyCode } from './engine/member-wizards.js';
import { startHttpsServer, getKoaApp } from './https-server.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { initAdminPassword } from './config/local-config.js';
import { db } from './db/db.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

let BASE = '';
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject; callsign: string };

function keypair(callsign: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pubKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey, callsign };
}

function makeMember(callsign: string, beans = 100): Id {
    const id = keypair(callsign);
    db.prepare(
        `INSERT INTO members (public_key, callsign, joined_at, avatar_url, status, updated_at)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    ).run(id.pubKeyHex, callsign, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pubKeyHex);
    transfer('genesis', id.pubKeyHex, beans, `seed ${callsign}`, 'direct', true);
    return id;
}

async function signedFetch(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, id: Id, body?: unknown) {
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`;
    const headers: Record<string, string> = {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? bodyString : undefined });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}

async function unsigned(method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: method === 'POST' ? { 'Content-Type': 'application/json', ...headers } : headers,
        body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}

/** Whether an answer names any of these people, by key or by name. */
function namesAnyone(body: unknown, ...people: Id[]): boolean {
    const text = JSON.stringify(body ?? null).toLowerCase();
    return people.some(p => text.includes(p.pubKeyHex.toLowerCase()) || text.includes(p.callsign.toLowerCase()));
}

const messageType = (id: string): string | undefined =>
    (db.prepare('SELECT type FROM messages WHERE id = ?').get(id) as { type: string } | undefined)?.type;
const tradeStatus = (id: string): string | undefined =>
    (db.prepare('SELECT status FROM marketplace_transactions WHERE id = ?').get(id) as { status: string } | undefined)?.status;
const postStatus = (id: string): string | undefined =>
    (db.prepare('SELECT status FROM posts WHERE id = ?').get(id) as { status: string } | undefined)?.status;
const isMemberRow = (pk: string): boolean => !!db.prepare('SELECT 1 FROM members WHERE public_key = ?').get(pk);
const inviteCount = (pk: string): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM invite_codes WHERE created_by = ?').get(pk) as { n: number }).n;

function offer(author: Id, title: string, credits = 10) {
    const post = createPost('offer', 'produce', title, `${title}, fresh`, credits, 'fixed', author.pubKeyHex);
    if (!post) throw new Error(`could not list ${title}`);
    return post;
}

function event(host: Id, title: string, extra: Record<string, unknown> = {}) {
    const post = createPost('event', 'community', title, 'Bring a plate', 0, 'fixed', host.pubKeyHex, -28.55, 153.5, [],
        false, undefined, false, { eventStartAt: inHours(24), eventPlaceName: 'The old bowls club', ...extra } as any);
    if (!post) throw new Error(`could not post ${title}`);
    return post;
}

/**
 * Every push the node sent, answered here in place of Expo and never sent on: the device token it was for. The node
 * sends pushes with the global fetch; every other request goes through as it is.
 */
const pushes: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    if (typeof url === 'string' && url.startsWith('https://exp.host/')) {
        for (const m of JSON.parse(String(init?.body ?? '[]'))) pushes.push(m.to);
        return new Response('{"data":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(input, init);
}) as typeof fetch;
const settle = () => new Promise(r => setTimeout(r, 50));

/** An event's time, place, title and state, as its attendees see them. */
const eventRow = (id: string) => db.prepare('SELECT title, event_place_name, event_start_at, event_state, status FROM posts WHERE id = ?').get(id);
/** A member's account and profile, as the re-key hands it on. */
const accountOf = (pk: string) => db.prepare(
    'SELECT callsign, avatar_url, bio, contact_value, status FROM members WHERE public_key = ?').get(pk) as Record<string, unknown> | undefined;

/** The whole database, table by table, so a sweep can say which table changed, if any did. */
function snapshot(): Map<string, string> {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
    const out = new Map<string, string>();
    for (const { name } of tables) {
        const h = crypto.createHash('sha256');
        for (const row of db.prepare(`SELECT * FROM "${name}"`).iterate()) h.update(JSON.stringify(row));
        out.set(name, h.digest('hex'));
    }
    return out;
}
const changedTables = (a: Map<string, string>, b: Map<string, string>) =>
    [...new Set([...a.keys(), ...b.keys()])].filter(t => a.get(t) !== b.get(t));

/** An offline ticket, as the app signs one: the payload and its signature, base64 JSON. */
function offlineTicket(inviter: Id): string {
    const payload = JSON.stringify({ i: inviter.pubKeyHex, t: Date.now() });
    const s = crypto.sign(null, Buffer.from(payload), inviter.privateKey).toString('base64');
    return Buffer.from(JSON.stringify({ p: payload, s })).toString('base64');
}

async function main(): Promise<void> {
    console.log('A key that is not a live member cannot act on other people\n');
    initAdminPassword();
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const founder = keypair('FounderNM');
    seedGenesisMember(founder.pubKeyHex, founder.callsign);
    const alice = makeMember('AliceNM');
    const bob = makeMember('BobNM');
    const pruney = makeMember('PruneyNM');
    const rekeyee = makeMember('RekeyeeNM');
    const operator = makeMember('OperatorNM');
    // A second owner, so the founder can be pruned in section 4.
    db.prepare("INSERT OR IGNORE INTO node_roles (member_pubkey, role, granted_by) VALUES (?, 'owner', 'genesis')").run(alice.pubKeyHex);

    // Everyone who trades lists an offer first (CONTRIBUTION_REQUIRED).
    offer(alice, 'Alice seedlings');
    offer(bob, 'Bob bread');

    // ── Seeding, all before the prune ──────────────────────────────────────────────────────────────
    // Event chat: Pruney convenes a group, Alice hosts an event in it, Bob is going and writes twice.
    const group = createGroup({ name: 'Garden club NM', createdBy: pruney.pubKeyHex, joinPolicy: 'open' } as any);
    joinGroup(group.id, alice.pubKeyHex);
    joinGroup(group.id, bob.pubKeyHex);
    const groupEvent = event(alice, 'Group picnic', { audienceScope: 'group', targetGroupId: group.id });
    rsvpEvent(groupEvent.id, bob.pubKeyHex, 'going');
    const bobLine = postEventThreadMessage(groupEvent.id, bob.pubKeyHex, 'I will bring a salad');
    const bobSecondLine = postEventThreadMessage(groupEvent.id, bob.pubKeyHex, 'And a rug');
    // Pruney's own event: Alice is going and writes.
    const pruneyEvent = event(pruney, 'Pruney working bee');
    rsvpEvent(pruneyEvent.id, alice.pubKeyHex, 'going');
    const aliceLine = postEventThreadMessage(pruneyEvent.id, alice.pubKeyHex, 'See you there');

    // Trades with Pruney, one of each kind a prune leaves open, and one it had already completed.
    const pruneyOffer = offer(pruney, 'Pruney jam');
    const pruneyOffer2 = offer(pruney, 'Pruney honey');
    const aliceOffer1 = offer(alice, 'Alice eggs');
    const aliceOffer2 = offer(alice, 'Alice lemons');
    const aliceOffer3 = offer(alice, 'Alice figs');
    const tPruneyToReject = requestPost(pruneyOffer.id, alice.pubKeyHex);           // requested; Pruney decides
    const tPruneyRequested = requestPost(aliceOffer1.id, pruney.pubKeyHex);         // requested; Pruney asked
    const tPruneyBuying = acceptPost(aliceOffer2.id, pruney.pubKeyHex);             // pending; Pruney buys
    const tPruneySelling = acceptPost(pruneyOffer2.id, alice.pubKeyHex);            // pending; Pruney sells
    const tPruneyDone = acceptPost(aliceOffer3.id, pruney.pubKeyHex);               // completed by Pruney
    completePostTransaction(tPruneyDone.id, pruney.pubKeyHex);
    const pruneyOffer3 = offer(pruney, 'Pruney walnuts');
    const tPruneySelling2 = acceptPost(pruneyOffer3.id, alice.pubKeyHex);           // pending; Alice will cancel
    assert(tradeStatus(tPruneyToReject.id) === 'requested' && tradeStatus(tPruneyRequested.id) === 'requested'
        && tradeStatus(tPruneyBuying.id) === 'pending' && tradeStatus(tPruneySelling.id) === 'pending'
        && tradeStatus(tPruneyDone.id) === 'completed' && tradeStatus(tPruneySelling2.id) === 'pending',
        'seeded: two requested, three pending and one completed trade with Pruney');

    // Invites Pruney made while a member: a code, and an offline ticket.
    const pruneyCode = await signedFetch('POST', '/api/invite/generate', pruney, { publicKey: pruney.pubKeyHex });
    assert(pruneyCode.status === 200 && typeof pruneyCode.body?.invite?.code === 'string', 'a member makes an invite (control)');
    const pruneyTicket = offlineTicket(pruney);

    // The re-key: Rekeyee hosts an event Bob writes in, and has a trade waiting on them; then a re-key starts.
    const rekeyEvent = event(rekeyee, 'Rekeyee seed swap');
    rsvpEvent(rekeyEvent.id, bob.pubKeyHex, 'going');
    const bobRekeyLine = postEventThreadMessage(rekeyEvent.id, bob.pubKeyHex, 'Bringing tomato seed');
    const rekeyeeOffer = offer(rekeyee, 'Rekeyee chutney');
    const tRekeyee = requestPost(rekeyeeOffer.id, bob.pubKeyHex);

    // For the sweep (section 5): Pruney runs two groups, with Bob's chat line and post in one and Carol asking to join
    // the other; Pruney can vouch and has vouched for Carol, and has a DM with Alice. Rekeyee has a request waiting
    // on them, a DM with Bob, and Beans to pledge.
    const carol = makeMember('CarolNM');
    offer(carol, 'Carol plums');
    const bobGroupLine = postGroupThreadMessage(group.id, bob.pubKeyHex, 'Seedlings are in');
    const bobGroupPost = createPost('offer', 'produce', 'Bob spare pots', 'For the club', 1, 'fixed', bob.pubKeyHex,
        undefined, undefined, [], false, undefined, false, { audienceScope: 'group', targetGroupId: group.id });
    if (!bobGroupPost) throw new Error('could not post to the group');
    const askGroup = createGroup({ name: 'Seed library NM', createdBy: pruney.pubKeyHex, joinPolicy: 'request_to_join' } as any);
    joinGroup(askGroup.id, carol.pubKeyHex);
    db.prepare('UPDATE members SET can_vouch = 1 WHERE public_key = ?').run(pruney.pubKeyHex);
    vouchMember(pruney.pubKeyHex, carol.pubKeyHex, 1);
    const pruneyDm = createConversation('dm', [pruney.pubKeyHex, alice.pubKeyHex], pruney.pubKeyHex)!;
    const aliceDmLine = sendMessage(pruneyDm.id, alice.pubKeyHex, 'aGk=', 'n1')!;
    const rekeyeeDm = createConversation('dm', [rekeyee.pubKeyHex, bob.pubKeyHex], rekeyee.pubKeyHex)!;
    const bobDmLine = sendMessage(rekeyeeDm.id, bob.pubKeyHex, 'aGk=', 'n2')!;
    const rekeyeeOffer2 = offer(rekeyee, 'Rekeyee pickles');
    const tRekeyee2 = requestPost(rekeyeeOffer2.id, bob.pubKeyHex);
    const aliceOffer4 = offer(alice, 'Alice quinces');
    const aliceOffer5 = offer(alice, 'Alice walnuts');
    // A group whose only convenor (the operator) has gone quiet, so its members may vote on a new one.
    const quietGroup = createGroup({ name: 'Tool library NM', createdBy: operator.pubKeyHex, joinPolicy: 'open' } as any);
    for (const m of [pruney, bob, alice]) joinGroup(quietGroup.id, m.pubKeyHex);
    const project = `proj-${crypto.randomUUID()}`;
    createCrowdfundProject(project, alice.pubKeyHex, 'Community oven NM', 'A wood-fired oven', [], 500, null);

    // For the event edits (4109566615): Bob, who is going to Alice's events, has a phone to push to. Rekeyee convenes a
    // group with an event of Alice's that Bob is going to; Carol, a live member, convenes another (the control).
    db.prepare("INSERT INTO push_tokens (public_key, token, platform) VALUES (?, 'ExponentPushToken[bob-nm]', 'android')").run(bob.pubKeyHex);
    const rekeyGroup = createGroup({ name: 'Swap shop NM', createdBy: rekeyee.pubKeyHex, joinPolicy: 'open' } as any);
    joinGroup(rekeyGroup.id, alice.pubKeyHex);
    joinGroup(rekeyGroup.id, bob.pubKeyHex);
    const rekeyGroupEvent = event(alice, 'Swap shop night', { audienceScope: 'group', targetGroupId: rekeyGroup.id });
    rsvpEvent(rekeyGroupEvent.id, bob.pubKeyHex, 'going');
    const liveGroup = createGroup({ name: 'Choir NM', createdBy: carol.pubKeyHex, joinPolicy: 'open' } as any);
    joinGroup(liveGroup.id, alice.pubKeyHex);
    joinGroup(liveGroup.id, bob.pubKeyHex);
    const liveGroupEvent = event(alice, 'Choir practice', { audienceScope: 'group', targetGroupId: liveGroup.id });
    rsvpEvent(liveGroupEvent.id, bob.pubKeyHex, 'going');
    // The member whose phone was lost or stolen (4109566694): 50 Beans, a profile, and a group Alice is in.
    const phoneless = makeMember('PhonelessNM', 50);
    db.prepare("UPDATE members SET bio = 'Grows garlic', contact_value = 'phoneless@example.org', contact_visibility = 'community' WHERE public_key = ?")
        .run(phoneless.pubKeyHex);
    joinGroup(liveGroup.id, phoneless.pubKeyHex);

    adminPruneUser(pruney.pubKeyHex, 'owner:password');
    issueRekeyCode(rekeyee.pubKeyHex, operator.pubKeyHex);
    const phonelessRekey = issueRekeyCode(phoneless.pubKeyHex, operator.pubKeyHex);
    assert((db.prepare('SELECT status FROM members WHERE public_key = ?').get(pruney.pubKeyHex) as any)?.status === 'pruned',
        'Pruney is pruned (row kept)');
    assert(!!db.prepare('SELECT 1 FROM invalidated_keys WHERE public_key = ?').get(rekeyee.pubKeyHex),
        "Rekeyee's old key is invalidated while the re-key is pending");

    // ── 1. Event chat ──────────────────────────────────────────────────────────────────────────────
    console.log('\n── 1. Event chat');
    {
        const r = await signedFetch('POST', `/api/marketplace/posts/${groupEvent.id}/chat/remove`, pruney, { messageId: bobLine.id });
        assert(r.status === 403, `a pruned convenor cannot remove Bob's line from a group event (got ${r.status})`);
        assert(!namesAnyone(r.body, bob, alice), 'and the refusal names nobody');
        assert(messageType(bobLine.id) === 'text', "Bob's line is kept");

        const own = await signedFetch('POST', `/api/marketplace/posts/${pruneyEvent.id}/chat/remove`, pruney, { messageId: aliceLine.id });
        assert(own.status === 403, `a pruned host cannot remove Alice's line from their own event (got ${own.status})`);
        assert(!namesAnyone(own.body, alice), 'and the refusal names nobody');
        assert(messageType(aliceLine.id) === 'text', "Alice's line is kept");

        const host = await signedFetch('POST', `/api/marketplace/posts/${groupEvent.id}/chat/remove`, alice, { messageId: bobSecondLine.id });
        assert(host.status === 200 && messageType(bobSecondLine.id) === 'removed', `a live host still removes a line (got ${host.status})`);
        // The answer carries the writer's face as the chat itself shows it (it read a column getMember doesn't have).
        assert(typeof host.body?.message?.authorAvatar === 'string' && host.body.message.authorAvatar.startsWith(`/api/avatar/${bob.pubKeyHex}?`),
            `and answers with the writer's face, as GET .../chat does (got ${host.body?.message?.authorAvatar})`);
    }

    // ── 2. Trades ──────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 2. Trades');
    {
        const refused = async (label: string, path: string, body: Record<string, unknown>, txId: string, before: string) => {
            const r = await signedFetch('POST', path, pruney, body);
            assert(r.status === 403, `a pruned party's ${label} is refused (got ${r.status} ${JSON.stringify(r.body)})`);
            assert(!namesAnyone(r.body, alice) && r.body?.transaction === undefined, `and the ${label} refusal carries no trade and names nobody`);
            assert(tradeStatus(txId) === before, `the trade is still ${before}`);
        };
        await refused('reject', '/api/marketplace/transactions/reject',
            { transactionId: tPruneyToReject.id, authorPublicKey: pruney.pubKeyHex }, tPruneyToReject.id, 'requested');
        await refused('cancel-request', '/api/marketplace/transactions/cancel-request',
            { transactionId: tPruneyRequested.id, buyerPublicKey: pruney.pubKeyHex }, tPruneyRequested.id, 'requested');
        await refused('cancel', '/api/marketplace/transactions/cancel',
            { transactionId: tPruneyBuying.id, cancellerPublicKey: pruney.pubKeyHex }, tPruneyBuying.id, 'pending');
        await refused('complete', '/api/marketplace/transactions/complete',
            { transactionId: tPruneyBuying.id, confirmerPublicKey: pruney.pubKeyHex }, tPruneyBuying.id, 'pending');
        await refused('cancel (as seller)', '/api/marketplace/transactions/cancel',
            { transactionId: tPruneySelling.id, cancellerPublicKey: pruney.pubKeyHex }, tPruneySelling.id, 'pending');
        await refused('complete of a trade it had completed', '/api/marketplace/transactions/complete',
            { transactionId: tPruneyDone.id, confirmerPublicKey: pruney.pubKeyHex }, tPruneyDone.id, 'completed');

        // The live party closes every trade the prune left open.
        const cancelReq = await signedFetch('POST', '/api/marketplace/transactions/cancel-request', alice,
            { transactionId: tPruneyToReject.id, buyerPublicKey: alice.pubKeyHex });
        assert(cancelReq.status === 200 && tradeStatus(tPruneyToReject.id) === 'cancelled', `Alice withdraws her request to Pruney (got ${cancelReq.status})`);
        const reject = await signedFetch('POST', '/api/marketplace/transactions/reject', alice,
            { transactionId: tPruneyRequested.id, authorPublicKey: alice.pubKeyHex });
        assert(reject.status === 200 && tradeStatus(tPruneyRequested.id) === 'rejected', `Alice declines Pruney's request (got ${reject.status})`);
        const cancel = await signedFetch('POST', '/api/marketplace/transactions/cancel', alice,
            { transactionId: tPruneyBuying.id, cancellerPublicKey: alice.pubKeyHex });
        assert(cancel.status === 200 && tradeStatus(tPruneyBuying.id) === 'cancelled', `Alice cancels the sale Pruney was buying (got ${cancel.status})`);
        assert(postStatus(aliceOffer2.id) === 'active', 'and her listing is back on the board');
        const cancel2 = await signedFetch('POST', '/api/marketplace/transactions/cancel', alice,
            { transactionId: tPruneySelling2.id, cancellerPublicKey: alice.pubKeyHex });
        assert(cancel2.status === 200 && tradeStatus(tPruneySelling2.id) === 'cancelled', `Alice cancels a purchase from Pruney (got ${cancel2.status})`);
        assert(postStatus(pruneyOffer3.id) === 'cancelled', `and Pruney's listing, cancelled by the prune, stays down (got ${postStatus(pruneyOffer3.id)})`);
        const complete = await signedFetch('POST', '/api/marketplace/transactions/complete', alice,
            { transactionId: tPruneySelling.id, confirmerPublicKey: alice.pubKeyHex });
        assert(complete.status === 200 && tradeStatus(tPruneySelling.id) === 'completed', `Alice completes her purchase from Pruney (got ${complete.status})`);
    }

    // ── 3. The old key of a member being re-keyed ──────────────────────────────────────────────────
    console.log('\n── 3. Re-key');
    {
        const chat = await signedFetch('POST', `/api/marketplace/posts/${rekeyEvent.id}/chat/remove`, rekeyee, { messageId: bobRekeyLine.id });
        assert(chat.status === 403, `the old key cannot remove Bob's line from its own event (got ${chat.status})`);
        assert(!namesAnyone(chat.body, bob) && messageType(bobRekeyLine.id) === 'text', "names nobody, and Bob's line is kept");
        const reject = await signedFetch('POST', '/api/marketplace/transactions/reject', rekeyee,
            { transactionId: tRekeyee.id, authorPublicKey: rekeyee.pubKeyHex });
        assert(reject.status === 403 && !namesAnyone(reject.body, bob), `the old key cannot decline Bob's request (got ${reject.status})`);
        assert(tradeStatus(tRekeyee.id) === 'requested', "Bob's request is still open");
        const bobWithdraws = await signedFetch('POST', '/api/marketplace/transactions/cancel-request', bob,
            { transactionId: tRekeyee.id, buyerPublicKey: bob.pubKeyHex });
        assert(bobWithdraws.status === 200, `Bob can still withdraw it (got ${bobWithdraws.status})`);
        const before = inviteCount(rekeyee.pubKeyHex);
        const inv = await signedFetch('POST', '/api/invite/generate', rekeyee, { publicKey: rekeyee.pubKeyHex });
        assert(inv.status === 403 && inviteCount(rekeyee.pubKeyHex) === before, `the old key cannot make an invite (got ${inv.status})`);

        // The member's own account (4109566694). The old key's "own data" is exactly what the re-key hands to the new phone.
        const replaced = (r: { status: number; body: any }) => r.status === 403 && r.body?.code === 'key_invalidated';
        const account = JSON.stringify(accountOf(phoneless.pubKeyHex));
        const purge = await signedFetch('POST', '/api/member/purge', phoneless, {});
        assert(replaced(purge), `the old key cannot delete the member's account (got ${purge.status} ${JSON.stringify(purge.body)})`);
        assert(getBalance(phoneless.pubKeyHex).balance === 50 && JSON.stringify(accountOf(phoneless.pubKeyHex)) === account,
            `its 50 Beans and its profile are untouched (${getBalance(phoneless.pubKeyHex).balance}, ${JSON.stringify(accountOf(phoneless.pubKeyHex))})`);
        const rename = await signedFetch('POST', '/api/profile/update', phoneless,
            { callsign: 'Taken NM', bio: 'Not me', contact: { value: 'thief@example.org', visibility: 'community' } });
        assert(replaced(rename) && JSON.stringify(accountOf(phoneless.pubKeyHex)) === account,
            `nor rename them or change their contact details (got ${rename.status})`);
        const postsBy = () => (db.prepare('SELECT COUNT(*) AS n FROM posts WHERE author_pubkey = ?').get(phoneless.pubKeyHex) as { n: number }).n;
        const posts = postsBy();
        const garlic = (audience: Record<string, unknown>) => ({ type: 'offer', category: 'produce', title: 'Garlic, cheap',
            description: 'Message me', credits: 1, priceType: 'fixed', authorPublicKey: phoneless.pubKeyHex, ...audience });
        const direct = await signedFetch('POST', '/api/marketplace/posts', phoneless, garlic({ audienceScope: 'direct', targetPubkey: alice.pubKeyHex }));
        assert(replaced(direct) && postsBy() === posts, `nor post to Alice as them, and nothing is stored (got ${direct.status} ${JSON.stringify(direct.body)})`);
        const inGroup = await signedFetch('POST', '/api/marketplace/posts', phoneless, garlic({ audienceScope: 'group', targetGroupId: liveGroup.id }));
        assert(replaced(inGroup) && postsBy() === posts, `nor to a group Alice is in (got ${inGroup.status} ${JSON.stringify(inGroup.body)})`);

        // A convenor mid re-key moves no event in their group (4109566615).
        const swapNight = JSON.stringify(eventRow(rekeyGroupEvent.id));
        const pushed = pushes.length;
        const edit = await signedFetch('POST', '/api/marketplace/posts/update', rekeyee,
            { id: rekeyGroupEvent.id, authorPublicKey: rekeyee.pubKeyHex, title: 'Swap shop moved', eventPlaceName: 'A car park', eventStartAt: inHours(30) });
        await settle();
        assert(replaced(edit) && !namesAnyone(edit.body, alice), `the old key of a convenor cannot move Alice's group event (got ${edit.status} ${JSON.stringify(edit.body)})`);
        assert(JSON.stringify(eventRow(rekeyGroupEvent.id)) === swapNight && pushes.length === pushed,
            `the event is unchanged, and nobody going is pushed that it moved (${JSON.stringify(eventRow(rekeyGroupEvent.id))}, ${pushes.length - pushed} pushes)`);

        // Then the re-key completes, signed by the new phone with the operator's code: it holds the member's account, whole.
        const newPhone = keypair('PhonelessNM');
        const proof = crypto.sign(null, Buffer.from(phonelessRekey.code), newPhone.privateKey).toString('base64');
        const done = await signedFetch('POST', '/api/member/re-enroll', newPhone,
            { code: phonelessRekey.code, newPublicKey: newPhone.pubKeyHex, signature: proof });
        const moved = accountOf(newPhone.pubKeyHex);
        const was = JSON.parse(account);
        assert(done.status === 200 && done.body?.success === true, `the new phone completes the re-key (got ${done.status} ${JSON.stringify(done.body)})`);
        assert(getBalance(newPhone.pubKeyHex).balance === 50 && moved?.status === 'active' && moved?.callsign === 'PhonelessNM'
            && moved?.bio === 'Grows garlic' && moved?.avatar_url === was.avatar_url && moved?.contact_value === was.contact_value,
            `and the new key holds the member's account, with its 50 Beans and its profile (${getBalance(newPhone.pubKeyHex).balance}, ${JSON.stringify(moved)})`);
    }

    // ── 4. Invites ─────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. Invites');
    {
        const before = inviteCount(pruney.pubKeyHex);
        const gen = await signedFetch('POST', '/api/invite/generate', pruney, { publicKey: pruney.pubKeyHex });
        assert(gen.status === 403 && gen.body?.invite === undefined, `a pruned account cannot make an invite (got ${gen.status})`);
        assert(inviteCount(pruney.pubKeyHex) === before, 'and no code is written');

        const newcomer = keypair('NewcomerNM');
        const check = await unsigned('GET', `/api/invite/check?code=${encodeURIComponent(pruneyCode.body.invite.code)}`);
        assert(check.body?.valid === false && check.body?.reason === 'unknown_inviter',
            `the pre-flight check says a pruned member's code no longer works (got ${JSON.stringify(check.body)})`);
        const redeem = await unsigned('POST', '/api/invite/redeem',
            { code: pruneyCode.body.invite.code, publicKey: newcomer.pubKeyHex, callsign: newcomer.callsign });
        assert(redeem.status === 400 && !isMemberRow(newcomer.pubKeyHex), `a code made before the prune no longer redeems (got ${redeem.status})`);

        const ticketCheck = await unsigned('GET', `/api/invite/check?code=${encodeURIComponent('BP-' + pruneyTicket)}`);
        assert(ticketCheck.body?.valid === false && ticketCheck.body?.reason === 'unknown_inviter',
            `nor does its offline ticket pass the check (got ${JSON.stringify(ticketCheck.body)})`);
        const offline = await unsigned('POST', '/api/invite/redeem-offline',
            { ticketB64: pruneyTicket, publicKey: newcomer.pubKeyHex, callsign: newcomer.callsign });
        assert(offline.status === 400 && !isMemberRow(newcomer.pubKeyHex), `nor does an offline ticket it signed (got ${offline.status})`);

        // Controls: a live member's invite and an admin's still redeem.
        const aliceCode = await signedFetch('POST', '/api/invite/generate', alice, { publicKey: alice.pubKeyHex });
        const viaAlice = keypair('ViaAliceNM');
        const aliceRedeem = await unsigned('POST', '/api/invite/redeem',
            { code: aliceCode.body?.invite?.code, publicKey: viaAlice.pubKeyHex, callsign: viaAlice.callsign });
        assert(aliceRedeem.status === 200 && isMemberRow(viaAlice.pubKeyHex), `a live member's invite still redeems (got ${aliceRedeem.status})`);

        const seed = await unsigned('POST', '/api/admin/seed-invite', { password: PW });
        const viaAdmin = keypair('ViaAdminNM');
        const adminRedeem = await unsigned('POST', '/api/invite/redeem',
            { code: seed.body?.code, publicKey: viaAdmin.pubKeyHex, callsign: viaAdmin.callsign });
        assert(seed.status === 200 && adminRedeem.status === 200 && isMemberRow(viaAdmin.pubKeyHex),
            `an admin's invite still redeems (got ${seed.status}, ${adminRedeem.status})`);

        // The admin's invite hangs off the genesis member. Pruned, the node picks a live member instead.
        adminPruneUser(founder.pubKeyHex, 'owner:password');
        const seed2 = await unsigned('POST', '/api/admin/seed-invite', { password: PW });
        const viaAdmin2 = keypair('ViaAdminTwoNM');
        const adminRedeem2 = await unsigned('POST', '/api/invite/redeem',
            { code: seed2.body?.code, publicKey: viaAdmin2.pubKeyHex, callsign: viaAdmin2.callsign });
        assert(seed2.status === 200 && adminRedeem2.status === 200 && isMemberRow(viaAdmin2.pubKeyHex),
            `with the genesis member pruned, an admin's invite still redeems (got ${seed2.status}, ${adminRedeem2.status} ${JSON.stringify(adminRedeem2.body)})`);
    }


    // ── 5. The sweep: every other signed write that reaches another member or moves Beans ────────────
    console.log('\n── 5. The sweep');
    {
        const refused = (label: string, r: { status: number; body: any }, want = 403) =>
            assert(r.status === want && !namesAnyone(r.body, alice, bob, carol), `${label} (got ${r.status} ${JSON.stringify(r.body)})`);
        const groupRow = (gid: string, pk: string) =>
            db.prepare('SELECT role, status FROM group_members WHERE group_id = ? AND member_pubkey = ?').get(gid, pk) as { role: string; status: string } | undefined;

        // A pruned convenor runs the group no more.
        refused('a pruned convenor cannot remove Bob from the group',
            await signedFetch('DELETE', `/api/groups/${group.id}/members/${bob.pubKeyHex}`, pruney));
        assert(groupRow(group.id, bob.pubKeyHex)?.status === 'active', 'Bob is still in it');
        refused("nor change Bob's role",
            await signedFetch('PATCH', `/api/groups/${group.id}/members/${bob.pubKeyHex}`, pruney, { role: 'observer' }));
        assert(groupRow(group.id, bob.pubKeyHex)?.role === 'member', "Bob's role is unchanged");
        refused('nor invite anyone',
            await signedFetch('POST', `/api/groups/${group.id}/members`, pruney, { targetPubkey: carol.pubKeyHex }));
        assert(!groupRow(group.id, carol.pubKeyHex), 'Carol was not invited');
        refused("nor approve Carol's request to join",
            await signedFetch('POST', `/api/groups/${askGroup.id}/members`, pruney, { targetPubkey: carol.pubKeyHex, action: 'approve' }));
        assert(groupRow(askGroup.id, carol.pubKeyHex)?.status === 'pending_approval', "Carol's request is still waiting");
        refused("nor rename the group", await signedFetch('PATCH', `/api/groups/${group.id}`, pruney, { description: 'Taken over' }));
        assert((db.prepare('SELECT description FROM groups WHERE id = ?').get(group.id) as any)?.description !== 'Taken over', 'the group is unchanged');
        refused('nor hand the lead on', await signedFetch('POST', `/api/groups/${group.id}/lead`, pruney, { targetPubkey: alice.pubKeyHex }));
        refused("nor remove Bob's line from the group chat",
            await signedFetch('POST', `/api/groups/${group.id}/chat/remove`, pruney, { messageId: bobGroupLine.id }));
        assert(messageType(bobGroupLine.id) === 'text', "Bob's group line is kept");
        refused("nor delete Bob's group post", await signedFetch('DELETE', `/api/groups/${group.id}/posts/${bobGroupPost.id}`, pruney));
        refused("nor remove it from the market",
            await signedFetch('POST', '/api/marketplace/posts/remove', pruney, { id: bobGroupPost.id, authorPublicKey: pruney.pubKeyHex }));
        assert(postStatus(bobGroupPost.id) === 'active', "Bob's group post is kept");
        // Nor move Alice's event in the group (4109566615): the edit would go out under her name, and tell Bob it moved.
        const picnic = JSON.stringify(eventRow(groupEvent.id));
        const pushed = pushes.length;
        refused("nor move Alice's group event", await signedFetch('POST', '/api/marketplace/posts/update', pruney,
            { id: groupEvent.id, authorPublicKey: pruney.pubKeyHex, title: 'Picnic moved', eventPlaceName: 'A car park', eventStartAt: inHours(30) }));
        await settle();
        assert(JSON.stringify(eventRow(groupEvent.id)) === picnic && pushes.length === pushed,
            `the event is unchanged, and nobody going is pushed that it moved (${JSON.stringify(eventRow(groupEvent.id))}, ${pushes.length - pushed} pushes)`);
        // A live convenor still moves one in their group, and Bob, who is going, is told.
        const toBob = () => pushes.filter(t => t === 'ExponentPushToken[bob-nm]').length;
        const told = toBob();
        const live = await signedFetch('POST', '/api/marketplace/posts/update', carol,
            { id: liveGroupEvent.id, authorPublicKey: carol.pubKeyHex, eventPlaceName: 'The church hall', eventStartAt: inHours(30) });
        await settle();
        const practice = eventRow(liveGroupEvent.id) as { event_place_name: string; event_state: string } | undefined;
        assert(live.status === 200 && practice?.event_place_name === 'The church hall' && practice?.event_state === 'updated' && toBob() === told + 1,
            `a live convenor still moves Alice's group event, and Bob is pushed that it moved (got ${live.status}, ${JSON.stringify(practice)}, ${toBob() - told} to Bob)`);
        // Succession was already closed to them (its electorate asks for members.status = 'active'); kept as a check.
        const quietSince = new Date(Date.now() - 40 * 86_400_000).toISOString();
        db.prepare('UPDATE members SET last_active_at = ?, joined_at = ? WHERE public_key = ?').run(quietSince, quietSince, operator.pubKeyHex);
        refused('nor propose a new convenor where the convenor has gone quiet',
            await signedFetch('POST', `/api/groups/${quietGroup.id}/succession/propose`, pruney, { candidatePubkey: bob.pubKeyHex }));
        const opened = proposeGroupConvenor(quietGroup.id, bob.pubKeyHex, alice.pubKeyHex);
        refused('nor vote on the proposal a live member opened',
            await signedFetch('POST', `/api/groups/${quietGroup.id}/succession/${opened.proposal.id}/vote`, pruney, { choice: 'no' }));
        assert(!db.prepare('SELECT 1 FROM group_convenor_votes WHERE voter_pubkey = ?').get(pruney.pubKeyHex), 'and no vote is recorded');

        // Vouching hands out a credit floor; a pruned voucher's can_vouch outlasts the prune.
        const vouchOf = (pk: string) => db.prepare('SELECT elder_vouched_by, vouch_credit FROM members WHERE public_key = ?').get(pk) as any;
        const vouch = await signedFetch('POST', '/api/profile/vouch', pruney, { targetPubkey: bob.pubKeyHex });
        assert(vouch.status === 400 && !vouchOf(bob.pubKeyHex)?.elder_vouched_by, `a pruned voucher vouches for nobody (got ${vouch.status})`);
        const unvouch = await signedFetch('POST', '/api/profile/unvouch', pruney, { targetPubkey: carol.pubKeyHex });
        assert(unvouch.status === 400 && vouchOf(carol.pubKeyHex)?.elder_vouched_by === pruney.pubKeyHex,
            `nor takes Carol's vouch away (got ${unvouch.status})`);

        // Ratings and reports land on another member's record.
        const rating = await signedFetch('POST', '/api/ratings', pruney,
            { targetPubkey: alice.pubKeyHex, stars: 1, comment: 'bad', transactionId: tPruneyDone.id });
        assert(rating.status === 400 && !db.prepare('SELECT 1 FROM ratings WHERE rater_pubkey = ?').get(pruney.pubKeyHex),
            `a pruned account rates nobody (got ${rating.status})`);
        const report = await signedFetch('POST', '/api/reports', pruney, { targetPubkey: alice.pubKeyHex, reason: 'spam' });
        assert(report.status === 400 && !db.prepare('SELECT 1 FROM abuse_reports WHERE reporter_pubkey = ?').get(pruney.pubKeyHex),
            `nor reports anyone (got ${report.status})`);

        // A pruned participant's DM reaction still reached the other person.
        refused("a pruned account cannot react to Alice's DM",
            await signedFetch('POST', '/api/messages/react', pruney, { messageId: aliceDmLine.id, authorPubkey: pruney.pubKeyHex, emoji: '👍' }));

        // The old key of a member being re-keyed: trades, messages, Beans.
        refused("the old key cannot request Alice's offer",
            await signedFetch('POST', '/api/marketplace/posts/request', rekeyee, { postId: aliceOffer4.id, buyerPublicKey: rekeyee.pubKeyHex }));
        assert(!db.prepare('SELECT 1 FROM marketplace_transactions WHERE post_id = ?').get(aliceOffer4.id), 'and no trade is opened');
        refused("nor approve Bob's request (which would lock Bob's Beans in escrow)",
            await signedFetch('POST', '/api/marketplace/transactions/approve', rekeyee, { transactionId: tRekeyee2.id, authorPublicKey: rekeyee.pubKeyHex }));
        assert(tradeStatus(tRekeyee2.id) === 'requested', "Bob's request is still only a request");
        refused("nor buy Alice's offer outright",
            await signedFetch('POST', '/api/marketplace/posts/accept', rekeyee, { postId: aliceOffer5.id, buyerPublicKey: rekeyee.pubKeyHex }));
        assert(!db.prepare('SELECT 1 FROM marketplace_transactions WHERE post_id = ?').get(aliceOffer5.id), 'and no trade is opened');
        const before = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(rekeyeeDm.id) as { n: number };
        refused('nor message Bob as them',
            await signedFetch('POST', '/api/messages/send', rekeyee, { conversationId: rekeyeeDm.id, authorPubkey: rekeyee.pubKeyHex, ciphertext: 'aGk=', nonce: 'n3' }));
        assert((db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(rekeyeeDm.id) as { n: number }).n === before.n, 'and nothing is sent');
        refused("nor react to Bob's message",
            await signedFetch('POST', '/api/messages/react', rekeyee, { messageId: bobDmLine.id, authorPubkey: rekeyee.pubKeyHex, emoji: '👍' }));
        const held = getBalance(rekeyee.pubKeyHex).balance;
        refused("nor pledge the member's Beans to a project",
            await signedFetch('POST', `/api/crowdfund/projects/${project}/pledge`, rekeyee, { amount: 5 }));
        assert(getBalance(rekeyee.pubKeyHex).balance === held, `and the balance is untouched (${held})`);
        const livePledge = await signedFetch('POST', `/api/crowdfund/projects/${project}/pledge`, bob, { amount: 5 });
        assert(livePledge.status === 200, `a live member still pledges (got ${livePledge.status} ${JSON.stringify(livePledge.body)})`);
    }

    // ── 6. The middleware: every signed request from a key a re-key replaced ─────────────────────────
    console.log('\n── 6. The middleware refuses a replaced key');
    {
        const REPLACED = 'This key was replaced by a new one, so this community no longer accepts it. Use the device or the 12 words that hold the new key.';
        const isRefusal = (r: { status: number; body: any }) => r.status === 403 && r.body?.code === 'key_invalidated' && r.body?.error === REPLACED;
        /** The routes the middleware never sees (https-server.ts isSignatureBypassed): each has its own authorization. */
        const outside = (p: string) => ['/api/local/', '/api/admin/', '/api/manager/', '/api/pair/', '/api/pricing-guide/admin/', '/api/pricing-guide/reports']
            .some(prefix => p.startsWith(prefix)) || p === '/api/invite/redeem' || p === '/api/invite/redeem-offline';
        const app = getKoaApp() as any;
        const writes = [...new Set<string>(app.middleware.filter((m: any) => m.router).flatMap((m: any) => m.router.stack)
            .flatMap((l: any) => (l.methods as string[]).filter(m => m !== 'HEAD' && m !== 'GET').map(m => `${m} ${l.path}`)))].sort();
        const swept = writes.filter(r => !outside(r.split(' ')[1]));
        assert(swept.length > 150 && writes.length - swept.length > 100,
            `the sweep takes every registered write the middleware sees: ${swept.length} of ${writes.length} (the rest are the admin surface and invite redemption)`);
        const materialise = (p: string) => p.replace(/:([A-Za-z]+)/g, (_, name: string) => {
            if (name === 'id') return p.startsWith('/api/groups/') ? rekeyGroup.id : p.startsWith('/api/marketplace/') ? rekeyGroupEvent.id
                : p.startsWith('/api/crowdfund/') ? project : 'sweep';
            return ({ pubkey: alice.pubKeyHex, postId: rekeyGroupEvent.id, messageId: bobRekeyLine.id, treasury: alice.pubKeyHex, provider: 'google' } as
                Record<string, string>)[name] ?? 'sweep';
        });
        /** A body that would reach the route's data: the signer wherever a route names who acts, and someone else's things. */
        const bodyFor = (signer: Id) => {
            const k = signer.pubKeyHex;
            return {
                publicKey: k, authorPublicKey: k, buyerPublicKey: k, cancellerPublicKey: k, confirmerPublicKey: k, voterPublicKey: k,
                authorPubkey: k, from: k, createdBy: k, newPublicKey: k,
                targetPubkey: alice.pubKeyHex, friendPubkey: alice.pubKeyHex, memberPubkey: alice.pubKeyHex, toPubkey: alice.pubKeyHex,
                to: alice.pubKeyHex, candidatePubkey: bob.pubKeyHex, candidate: bob.pubKeyHex,
                id: rekeyGroupEvent.id, postId: aliceOffer4.id, groupId: rekeyGroup.id, targetGroupId: rekeyGroup.id, conversationId: rekeyeeDm.id,
                messageId: bobDmLine.id, transactionId: tRekeyee2.id, projectId: project, code: phonelessRekey.code,
                type: 'offer', category: 'produce', title: 'Swept NM', description: 'Swept', credits: 1, priceType: 'fixed', amount: 1,
                ciphertext: 'aGk=', nonce: 'c3dlcHQ=', emoji: '👍', stars: 5, reason: 'Swept', callsign: 'Swept NM', bio: 'Swept',
                token: 'ExponentPushToken[swept]', platform: 'android', status: 'going', choice: 'yes', optionId: 'a',
            };
        };
        const keys: Array<[string, Id]> = [['the old key of a member being re-keyed', rekeyee], ['the old key of a completed re-key', phoneless]];
        for (const [who, key] of keys) {
            // Each refusal is charged to the caller's address as an unsigned request would be (gateway-rate-limit.ts
            // gatewaySettle, as for a bad signature). This many from one address would trip it, so each pass starts clear.
            resetGatewayRateLimit();
            const before = snapshot();
            const pushed = pushes.length;
            const answered: string[] = [];
            for (const route of swept) {
                const [method, path] = route.split(' ') as ['POST' | 'PUT' | 'PATCH' | 'DELETE', string];
                const r = await signedFetch(method, materialise(path), key, bodyFor(key));
                if (!isRefusal(r)) answered.push(`${route} → ${r.status} ${JSON.stringify(r.body ?? null).slice(0, 90)}`);
            }
            await settle();
            const changed = changedTables(before, snapshot());
            assert(answered.length === 0, `${who}: every one of the ${swept.length} writes is refused 403 key_invalidated, in the middleware's words`
                + `${answered.length ? ` — ${answered.length} were not: ${answered.slice(0, 6).join(' | ')}` : ''}`);
            assert(changed.length === 0 && pushes.length === pushed,
                `${who}: and nothing changed, in any table, and nobody was pushed${changed.length ? ` (changed: ${changed.join(', ')})` : ''} (${pushes.length - pushed} pushes)`);
        }

        resetGatewayRateLimit();
        // Reads too, gated or public; unsigned, a request is answered as before.
        const gated = await signedFetch('GET', '/api/members', rekeyee);
        assert(isRefusal(gated), `a gated read by the replaced key is refused the same way (got ${gated.status} ${JSON.stringify(gated.body)})`);
        const signedPublic = await signedFetch('GET', '/api/community/info', rekeyee);
        assert(isRefusal(signedPublic), `so is a public read it signs (got ${signedPublic.status})`);
        const unsignedPublic = await unsigned('GET', '/api/community/info');
        assert(unsignedPublic.status === 200 && typeof unsignedPublic.body?.memberCount === 'number', `the same read unsigned is answered as before (got ${unsignedPublic.status})`);
        const unsignedWrite = await unsigned('POST', '/api/marketplace/posts', { type: 'offer', title: 'Unsigned', authorPublicKey: rekeyee.pubKeyHex });
        assert(unsignedWrite.status === 401, `and an unsigned write is refused as before, 401 (got ${unsignedWrite.status})`);

        // The routes the middleware never sees keep their own checks: invite redemption refuses the replaced key itself (#1170).
        const code = (await signedFetch('POST', '/api/invite/generate', alice, { publicKey: alice.pubKeyHex })).body?.invite?.code;
        for (const [who, key] of keys) {
            const r = await signedFetch('POST', '/api/invite/redeem', key, { code, publicKey: key.pubKeyHex, callsign: 'Second me NM' });
            assert(r.status === 400 && /replaced by a new one, so it can’t join with this invite/.test(r.body?.error ?? '') && r.body?.member === undefined,
                `${who}: redeeming an invite is refused by the redemption itself, outside the middleware (got ${r.status} ${JSON.stringify(r.body)})`);
        }
        const used = db.prepare('SELECT used_by FROM invite_codes WHERE code = ?').get(code) as { used_by: string | null } | undefined;
        assert(!!used && used.used_by === null, 'and the code is still unused');
    }

    // ── 7. A deleted or removed account stays that way ───────────────────────────────────────────────
    console.log('\n── 7. A re-key never brings back a deleted or removed account');
    {
        const GONE = 'This account was deleted or removed from this community, so it can’t be moved to a new key.';
        const ends: Array<[string, (pk: string) => void]> = [
            ['deleted by its owner', pk => { purgeMemberSelf(pk); }],
            ['pruned by an admin', pk => adminPruneUser(pk, 'owner:password')],
        ];
        for (const [how, end] of ends) {
            const member = makeMember(how.startsWith('deleted') ? 'DeleterNM' : 'RemovedNM');
            const rekey = issueRekeyCode(member.pubKeyHex, operator.pubKeyHex);
            end(member.pubKeyHex);
            const row = JSON.stringify(accountOf(member.pubKeyHex));
            const before = snapshot();
            const phone = keypair(`${member.callsign} new`);
            const proof = crypto.sign(null, Buffer.from(rekey.code), phone.privateKey).toString('base64');
            const r = await signedFetch('POST', '/api/member/re-enroll', phone, { code: rekey.code, newPublicKey: phone.pubKeyHex, signature: proof });
            assert(r.status === 400 && r.body?.error === GONE, `completing the re-key of an account ${how} is refused in plain words (got ${r.status} ${JSON.stringify(r.body)})`);
            const changed = changedTables(before, snapshot());
            assert(changed.length === 0 && !isMemberRow(phone.pubKeyHex) && JSON.stringify(accountOf(member.pubKeyHex)) === row,
                `and nothing changes: the row stays pruned under the old key, and the new key holds nothing${changed.length ? ` (changed: ${changed.join(', ')})` : ''}`);
        }
    }

    // ── 8. Controls: what ordinary and suspended members could do, they still can ─────────────────────
    console.log('\n── 8. Controls');
    {
        const cases: Array<[string, 'active' | 'suspended' | 'disabled', number, number]> = [
            // [who, their status, the post's answer, the message's answer]; each then deletes their own account.
            ['an ordinary member', 'active', 200, 200],
            ['a member a report suspended', 'suspended', 200, 200],
            ['a member suspended by an admin or a vote', 'disabled', 400, 400],
        ];
        for (const [who, status, postWant, messageWant] of cases) {
            const member = makeMember(`Control ${status} NM`);
            const dm = createConversation('dm', [member.pubKeyHex, alice.pubKeyHex], member.pubKeyHex)!;
            db.prepare('UPDATE members SET status = ? WHERE public_key = ?').run(status, member.pubKeyHex);
            const post = await signedFetch('POST', '/api/marketplace/posts', member, { type: 'offer', category: 'produce', title: `Honey from ${status}`,
                description: 'Jars', credits: 3, priceType: 'fixed', authorPublicKey: member.pubKeyHex });
            const message = await signedFetch('POST', '/api/messages/send', member,
                { conversationId: dm.id, authorPubkey: member.pubKeyHex, ciphertext: 'aGk=', nonce: `bm9uY2Ut${status}` });
            const purge = await signedFetch('POST', '/api/member/purge', member, {});
            const after = accountOf(member.pubKeyHex);
            assert(post.status === postWant && message.status === messageWant,
                `${who}: a post and a message are answered as before, ${postWant} and ${messageWant} (got ${post.status} ${message.status} ${JSON.stringify(message.body)})`);
            assert(purge.status === 200 && after?.status === 'pruned' && after?.callsign === 'Deleted Member',
                `${who}: and they can still delete their own account (got ${purge.status} ${JSON.stringify(purge.body)})`);
        }
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
