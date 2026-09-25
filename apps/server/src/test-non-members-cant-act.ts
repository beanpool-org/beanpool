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
 *  3. Re-key: the old key of a member being re-keyed is refused the same way (chat removal, a trade, an invite).
 *  4. Invites: a pruned account can't make one; a code or an offline ticket it made before the prune no longer
 *     redeems, and the pre-flight check says so; a live member's and an admin's invites still redeem, the admin's
 *     even after the genesis member it hangs the code on has been pruned.
 *  5. The sweep, every other signed write that reaches another member or moves Beans: a pruned convenor runs the group
 *     no more (members, roles, invites, requests, details, lead, chat, posts, succession); a pruned voucher neither
 *     vouches nor unvouches; a pruned account rates, reports and reacts to nobody; the old key of a member being
 *     re-keyed opens, approves and buys no trade, messages and reacts to nobody, and pledges none of the member's Beans.
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
} from './state-engine.js';
import { createCrowdfundProject } from './db/db.js';
import { issueRekeyCode } from './engine/member-wizards.js';
import { startHttpsServer } from './https-server.js';
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

function makeMember(callsign: string): Id {
    const id = keypair(callsign);
    db.prepare(
        `INSERT INTO members (public_key, callsign, joined_at, avatar_url, status, updated_at)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    ).run(id.pubKeyHex, callsign, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pubKeyHex);
    transfer('genesis', id.pubKeyHex, 100, `seed ${callsign}`, 'direct', true);
    return id;
}

async function signedFetch(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, id: Id, body?: unknown) {
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

    adminPruneUser(pruney.pubKeyHex, 'owner:password');
    issueRekeyCode(rekeyee.pubKeyHex, operator.pubKeyHex);
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
        const propose = await signedFetch('POST', `/api/groups/${group.id}/succession/propose`, pruney, { candidatePubkey: bob.pubKeyHex });
        assert(propose.status === 403 && propose.body?.error?.includes('Only members of this community'),
            `nor propose a new convenor (got ${propose.status} ${JSON.stringify(propose.body)})`);
        const quietSince = new Date(Date.now() - 40 * 86_400_000).toISOString();
        db.prepare('UPDATE members SET last_active_at = ?, joined_at = ? WHERE public_key = ?').run(quietSince, quietSince, operator.pubKeyHex);
        const opened = proposeGroupConvenor(quietGroup.id, bob.pubKeyHex, alice.pubKeyHex);
        const vote = await signedFetch('POST', `/api/groups/${quietGroup.id}/succession/${opened.proposal.id}/vote`, pruney, { choice: 'no' });
        assert(vote.status === 403 && vote.body?.error?.includes('Only members of this community'),
            `nor vote on one (got ${vote.status} ${JSON.stringify(vote.body)})`);

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

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
