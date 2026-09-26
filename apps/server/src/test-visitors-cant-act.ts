/**
 * A visitor's row can't act as a member: it replies in its own direct conversations and changes its own lines there,
 * sends Beans it holds (once past the send gate) and reads its own account, and nothing else a key with no row can't do (the director's rule, 2026-09-26, on Marty's answer on card
 * visitor-rows: "they receive messages and Beans but see only what a non-member sees"). #1182's deciding pass, item 4,
 * measured what a visitor's row could still write.
 *
 * The visitor (Vera) is made by a member's DM and holds Beans, as every visitor is. So that nothing but the rule can
 * refuse her, she also holds what a visitor's row could get before this rule (her row briefly unmarked to make it): a
 * name and a photo, an offer, a completed trade, a seat in a group and a Going RSVP to an event with a private note, a
 * line of her own in each one's chat, a keeper's row on two enterprises (with backing pledged to one) and the lead's row on
 * a third, where as lead she approved a request to keep it that is still waiting out its objection window.
 * Every request goes over HTTP through the real signature middleware, or over /ws.
 *
 *  1. The table: each write a member may make that a key with no row can't (#1182 item 4 rows 4-12: vouching, rating,
 *     reporting, posting and poll votes, trades, groups, RSVPs and event chat, crowdfund pledges; and the rest the
 *     sweep found: the People list area, friends, the profile, holiday mode, enterprises and keeping one, projects,
 *     crowdfunds and a crowdfund pledged to through an enterprise's pledge route, Decisions, Pulse channels, recovery,
 *     re-registering, deleting the row, event reminders). A member
 *     makes each one (so the body reaches the rule); the visitor and a key with no row are then refused it with the
 *     same status, code and words, and the visitor's attempt changes nothing, in any table (its activity stamp aside).
 * 1b. Keeping an enterprise (4111054995): an admin appoints no visitor's row to keep one, nor switches its operator access
 *     on, as for a key with no row. A visitor's row that keeps one anyway (from before this rule) approves, declines and
 *     reads no request to keep it, objects to no keeper change, proposes and votes in no lead succession, removes no
 *     keeper and no line from its discussion, marks it read and mutes it no more, steps down from none and releases no
 *     backing: each refused as a key with no row is, and nothing changes. The lead passes over it, a vote doesn't count
 *     it, an approval it made as lead doesn't land, the enterprise's page tells it nothing a key with no row isn't
 *     told, and an event the enterprise hosts reads to it without the note or who is going.
 * 1c. Node roles (4111202677): an owner makes no visitor's row moderator or admin, nor enrols its key, as for a key with
 *     no row. One that holds admin from before this rule signs in to Settings neither by the app's link nor by phone,
 *     a Settings session it opened then takes down no post, and signed as itself it pauses no enterprise, approves no
 *     request to keep one and removes no keeper; an owner still takes such a role away.
 *  2. The sweep: every registered write the middleware sees, signed by the visitor and by a key with no row with the
 *     same body, is answered the same, but for what the visitor may do (a line in its DM, marking it read, muting it,
 *     changing its lines there, Beans). Then every enterprise write again on a crowdfund, an enterprise with a goal,
 *     which takes another path through some of them (a pledge goes to the crowdfund), and on the enterprise it leads.
 *     Then for a visitor's row holding admin from before this rule: every write the middleware sees, signed by it; and
 *     every write on the admin surface the middleware never sees (/api/local/ and the rest), signed by it, and under a
 *     Settings session it opened before this rule (answered as one whose holder's role was taken away).
 * 2b. Succession (4111202724): a visitor's lead's row acts for nothing, so its keepers may replace it at once, and its own
 *     activity (a reply in its DM) cancels no proposal; the vote carries and the new lead answers a request to keep the
 *     enterprise. The same for a group it convenes. A member's lead active this month is not replaced (control).
 *  3. What a visitor keeps: it replies in its DM (the app may ask for the DM again first), marks it read and mutes it,
 *     edits and deletes its own lines there and reacts there (the director, 2026-09-26); it sends Beans it holds to a
 *     member, under the send gate as anyone is, and a visitor that never traded is told in plain words that it receives
 *     Beans and passes them on once it joins; it reads its own messages and Beans. Its own lines in a group's chat or an
 *     event's chat from before this rule it changes as a key with no row would (it can't), it opens no DM with a member
 *     it has none with, and can't open a DM with, or pay, a key that has no row here: refused, and no row is made.
 *  4. A refused transfer makes no row: a member's send the send gate refuses, or over what they hold, to a fresh key
 *     leaves that key without one; a send that goes through makes the recipient's visitor's row, holding the Beans.
 *  5. /ws: the visitor's socket gets its DM and its Beans, and neither the group's chat, nor the event's chat, nor the
 *     event's note (a member's socket gets all three); its RSVP is refused and hands back no note.
 * 5b. The gate (the director, 2026-09-26): the signature middleware refuses every signed write from a visitor's row that
 *     visitor-allowlist.ts VISITOR_WRITES doesn't name, before any route and any activity stamp, 403 not_a_member. The
 *     allowlist is exactly what the rule gives (this file's own list); every other write the middleware sees, signed by
 *     a visitor's row that keeps an enterprise, one holding admin and Vera, gets that answer and changes nothing, as does
 *     an allowlisted write whose body names what isn't the visitor's own; what she keeps still works through it; members
 *     and suspended members reach the route. Every other section measures the per-function checks behind the gate, as
 *     each review round did, with the gate off (setVisitorGateForTests).
 * 5c. The gate's follow-ups (the director, 2026-09-26), gate on: no member announcement (4111438869), no push about an event
 *     it is Going to from before this rule, a change, a cancellation or a reminder, reaches a visitor's phone, while a
 *     member's does, and a key with no row's gets none; it takes down its own listing from before this rule (4111438923)
 *     and nothing else about it changes, but not a listing of Alice's (naming Alice as the author or not), an
 *     enterprise's it keeps from before, nor its own event or poll; it sets only which of its pushes reach its phone
 *     (4111438819), and a body with holiday mode or any other key is the gate's refusal and changes nothing, while a
 *     member's reaches the route.
 *  6. After its own signed redeem of an invite the visitor is a member and does all of it.
 *  7. The global profile: three visitors' rows a week old are refused a report as a key with no row is, and hide
 *     nothing (three members of a week hide it); a place watch is refused as a key with no row is. A visitor changes its
 *     own lines in its own DM there too, and a line of any other DM is answered 403 members_only, as for a key with no row.
 *  8. Federation: a member of another community, relayed by a peer (federation-protocol.ts relay_message's own calls),
 *     still opens a DM with a member here and writes in it, as a visitor's row.
 *  9. A Settings sign-in by phone: a visitor's signed "No" is refused as a key with no row's is, and ends nothing.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-visitors-cant-act.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;
process.env.ADMIN_PASSWORD = 'VisitorsActPass123!';

import crypto from 'node:crypto';
import WebSocket from 'ws';
import { initTls } from './services/tls.js';
import {
    initStateEngine, transfer, createPost, acceptPost, completePostTransaction, createGroup, joinGroup, rsvpEvent,
    seedGenesisMember, createConversation, sendMessage, registerVisitor, getBalance, createTreasury,
    postGroupThreadMessage, postEventThreadMessage,
    adminAssignTreasuryOperator, requestToJoinEnterprise, approveKeeperRequest, proposeKeeperRemoval, stepDownAsKeeper,
    applyDueKeeperChanges, postEnterpriseThreadMessage, treasuryKeepers, keeperOf, canOperate, grantNodeRole, revokeNodeRole,
    dispatchPushNotification, isOnHoliday, getMemberPreferences, NOT_A_PUSH_SETTING_MESSAGE,
} from './state-engine.js';
import { runEventReminderSweep, reminderPushTitle } from './engine/event-reminders.js';
import { EVENT_UPDATED_PUSH_TITLE, EVENT_CANCELLED_PUSH_TITLE } from './engine/posts.js';
import { createPairing, declinePairing, approvePairing, describePairing, pairingMessage } from './settings-signin-pairing.js';
import { mintHandshakeToken, consumeHandshakeToken } from './admin-key-auth.js';
import { createCrowdfundProject } from './db/db.js';
import { createDecision } from './decisions-engine.js';
import { startHttpsServer, getKoaApp, resetAdminRateLimit } from './https-server.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { initAdminPassword } from './config/local-config.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { db } from './db/db.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

let BASE = '';
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const DAY = 86_400_000;
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const NOT_A_MEMBER = 'Only members of this community can do this.';
const NOTE = 'Gate code 4471, back shed';

type Id = { pk: string; priv: crypto.KeyObject; name: string };
type Res = { status: number; body: any };

function keypair(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey, name };
}

function makeMember(name: string, beans = 100, joinedDaysAgo = 30): Id {
    const id = keypair(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, avatar_url, status, updated_at)
                VALUES (?, ?, ?, 'genesis', 'TEST', ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
        .run(id.pk, name, ago(joinedDaysAgo * DAY), AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pk);
    if (beans > 0) transfer('genesis', id.pk, beans, `seed ${name}`, 'direct', true);
    return id;
}

/**
 * The limits a sweep of refusals would otherwise run into, so two keys making the same request are answered on its merits:
 * the admin surface's limiter and its tarpit for refused sign-ins, the auth endpoints' 15 a minute (every window closed),
 * and the join doors' knocks from one network a day (KNOCK_RULES.perAddressPerDay: the address each knock was made from is
 * forgotten, as the node forgets it after a day; the knocks stay).
 */
function resetLimits(): void {
    resetGatewayRateLimit();
    resetAdminRateLimit();
    resetAdminAuthTarpit();
    pruneAuthAttempts(Date.now() + 120_000);
    db.prepare('UPDATE join_requests SET ip_hash = NULL').run();
}

async function call(method: string, id: Id | null, path: string, body?: unknown): Promise<Res> {
    resetGatewayRateLimit();
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = {};
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const canonical = `${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`;
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(canonical), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? bodyString : undefined });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}

/** A request under a Settings session (x-admin-session, as an app's browser sends it after the exchange). */
async function callWithSession(session: string, method: string, path: string, body?: unknown): Promise<Res> {
    resetLimits();
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json', 'x-admin-session': session },
        body: body !== undefined ? JSON.stringify(body) : undefined });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}

/** A signed /ws socket and everything it is sent. */
type Sock = { ws: WebSocket; events: any[] };
function socket(id: Id): Promise<Sock> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`WS\n/ws\n${ts}\n${nonce}\n`), id.priv).toString('base64');
    const url = `${BASE.replace('https', 'wss')}/ws?pubkey=${id.pk}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`;
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { rejectUnauthorized: false });
        const s: Sock = { ws, events: [] };
        ws.on('message', d => { try { s.events.push(JSON.parse(d.toString())); } catch { /* */ } });
        ws.on('open', () => resolve(s));
        ws.on('error', reject);
    });
}
const settle = (ms = 150) => new Promise(r => setTimeout(r, ms));

/** Every push the node sent is answered here in place of Expo and never sent on, and kept here (section 5c). */
const pushed: { to: string; title: string; body: string }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    if (typeof url === 'string' && url.startsWith('https://exp.host/')) {
        try { for (const m of JSON.parse(String(init?.body ?? '[]'))) pushed.push({ to: m.to, title: m.title, body: m.body }); } catch { /* */ }
        return new Response('{"data":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(input, init);
}) as typeof fetch;

/**
 * The whole database, table by table, so an attempt can say which table changed. A signed write stamps its signer's
 * members.last_active_at before any route runs (https-server.ts requireSignature), whatever the route then answers, so
 * that column is left out: it is the activity stamp, not what the write asked for. So is event_reminders_sent, which
 * only the node's minute tick writes (engine/event-reminders.ts), whenever a reminder comes due during a long sweep; an
 * event's own update, which clears its rows there, changes `posts` too.
 */
function snapshot(): Map<string, string> {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'event_reminders_sent' ORDER BY name").all() as { name: string }[];
    const out = new Map<string, string>();
    for (const { name } of tables) {
        const h = crypto.createHash('sha256');
        for (const row of db.prepare(`SELECT * FROM "${name}"`).iterate() as Iterable<Record<string, unknown>>) {
            if (name === 'members') delete row.last_active_at;
            h.update(JSON.stringify(row));
        }
        out.set(name, h.digest('hex'));
    }
    return out;
}
const changedTables = (a: Map<string, string>, b: Map<string, string>) =>
    [...new Set([...a.keys(), ...b.keys()])].filter(t => a.get(t) !== b.get(t));

const hasRow = (pk: string) => !!db.prepare('SELECT 1 FROM members WHERE public_key = ?').get(pk);
const isVisitorRow = (pk: string) => (db.prepare('SELECT is_visitor FROM members WHERE public_key = ?').get(pk) as any)?.is_visitor === 1;
const balanceOf = (pk: string) => getBalance(pk).balance;
/** The same refusal: status, code and words. */
const same = (a: Res, b: Res) => a.status === b.status && a.body?.code === b.body?.code && a.body?.error === b.body?.error;
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body ?? null).slice(0, 140)}`;

/** Make what a visitor's row could make before this rule: its row is a member's for the length of `make`. */
function asBeforeThisRule(v: Id, make: () => void): void {
    db.prepare('UPDATE members SET is_visitor = 0 WHERE public_key = ?').run(v.pk);
    try { make(); } finally { db.prepare('UPDATE members SET is_visitor = 1 WHERE public_key = ?').run(v.pk); }
}

async function main(): Promise<void> {
    console.log("A visitor's row can't act as a member\n");
    initAdminPassword();
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    // The signature middleware refuses every signed write from a visitor's row that VISITOR_WRITES doesn't name
    // (visitor-allowlist.ts). Every section but 5b measures the per-function checks behind that gate, as each review round
    // measured them, so the gate is off for them; section 5b turns it on. Loaded so the suite runs to the end, and says
    // what fails, on a tree without it.
    const gate = await import('./visitor-allowlist.js').catch(() => null) as
        { VISITOR_WRITES: readonly { method: string; path: string }[]; setVisitorGateForTests(on: boolean): void } | null;
    gate?.setVisitorGateForTests(false);

    const founder = keypair('FounderVA');
    seedGenesisMember(founder.pk, founder.name);
    const alice = makeMember('AliceVA');
    const bob = makeMember('BobVA');
    const carol = makeMember('CarolVA');
    const mia = makeMember('MiaVA');          // the control: a member making every write in the table
    const offer = (m: Id, title: string, credits = 5) => createPost('offer', 'produce', title, `${title}, fresh`, credits, 'fixed', m.pk)!;
    for (const m of [alice, bob, carol, mia]) offer(m, `${m.name} seedlings`);

    // A trade each for Mia and Alice (standing for Decisions, a trade to rate) and for Bob.
    const miaBuys = acceptPost(offer(alice, 'Alice eggs').id, mia.pk);
    completePostTransaction(miaBuys.id, mia.pk);
    const aliceBuys = acceptPost(offer(bob, 'Bob bread').id, alice.pk);
    completePostTransaction(aliceBuys.id, alice.pk);
    db.prepare('UPDATE members SET can_vouch = 1 WHERE public_key = ?').run(mia.pk);

    // What the table's writes reach: listings, a poll, an event with a private note, a group, a crowdfund, a Decision.
    const aliceOffer = offer(alice, 'Alice lemons');
    const aliceOffer2 = offer(alice, 'Alice figs');
    const poll = createPost('poll', 'community', 'Market day?', '', 0, 'fixed', alice.pk, undefined, undefined, [], false,
        undefined, false, { pollOptions: [{ id: 'a', text: 'Saturday' }, { id: 'b', text: 'Sunday' }] } as any)!;
    const event = createPost('event', 'community', 'Working bee', 'Bring gloves', 0, 'fixed', alice.pk, -28.55, 153.5, [],
        false, undefined, false, { eventStartAt: inHours(24), eventPlaceName: 'The community garden', eventPrivateNote: NOTE } as any)!;
    rsvpEvent(event.id, bob.pk, 'going');
    const group = createGroup({ name: 'Garden club VA', createdBy: alice.pk, joinPolicy: 'open' } as any);
    joinGroup(group.id, bob.pk);
    const project = `proj-${crypto.randomUUID()}`;
    createCrowdfundProject(project, alice.pk, 'Community oven VA', 'A wood-fired oven', [], 500, null);
    const enterprise = createTreasury('Seed bank VA', AVATAR, 0, { leadKeeperPubkey: alice.pk, purpose: 'Seeds for everyone' } as any);
    const keyOf = (t: any): string => t.publicKey ?? t.treasury?.publicKey;
    const enterpriseKey = keyOf(enterprise);
    const decision = createDecision({ authorPubkey: alice.pk, title: 'Carol vouches', description: 'Carol has helped many of us',
        touches: 'member', effect: 'grant_voucher', subject: carol.pk } as any) as any;
    // Enterprises for a visitor's keeper's rows (section 1b): Lena leads an orchard; Cody and Quinn keep, and ask to keep, an
    // apiary the visitor leads; nobody keeps the mill.
    const lena = makeMember('LenaVA');
    const kai = makeMember('KaiVA');
    const tom = makeMember('TomVA');
    const cody = makeMember('CodyVA');
    const quinn = makeMember('QuinnVA');
    const orchard = keyOf(createTreasury('Orchard VA', AVATAR, 0, { leadKeeperPubkey: lena.pk, purpose: 'Apples' } as any));
    const mill = keyOf(createTreasury('Mill VA', AVATAR, 0, { purpose: 'Flour' } as any));

    // The visitor: Alice writes to her, and Beans reach her, as they reach every visitor.
    const vera = keypair('VeraVA');
    const veraDm = createConversation('dm', [alice.pk, vera.pk], alice.pk)!;
    const aliceLine = sendMessage(veraDm.id, alice.pk, 'aGkgVmVyYQ==', 'bjE=')!;
    transfer('genesis', vera.pk, 30, 'welcome gift', 'direct', true);
    assert(isVisitorRow(vera.pk) && balanceOf(vera.pk) === 30, "setup: Vera's row is a visitor's, made by Alice's DM, holding 30 Beans");
    // What a visitor's row could get before this rule, so that nothing but the rule refuses her below.
    let veraOffer = '';
    let veraTrade = '';
    let veraGroupLine = '';
    let veraEventLine = '';
    let apiary = '';
    let quinnChange = '';
    asBeforeThisRule(vera, () => {
        db.prepare("UPDATE members SET callsign = 'Vera', avatar_url = ? WHERE public_key = ?").run(AVATAR, vera.pk);
        veraOffer = offer(vera, 'Vera honey').id;
        const t = acceptPost(offer(bob, 'Bob jam', 20).id, vera.pk);
        completePostTransaction(t.id, vera.pk);
        veraTrade = t.id;
        joinGroup(group.id, vera.pk);
        rsvpEvent(event.id, vera.pk, 'going');
        veraGroupLine = postGroupThreadMessage(group.id, vera.pk, 'Vera was here').id;
        veraEventLine = postEventThreadMessage(event.id, vera.pk, 'Vera is coming').id;
        // And keeping enterprises (4111054995): a keeper's row on the seed bank, with 5 Beans of backing pledged, and on the
        // orchard; a lead's row on an apiary of her own, where as lead she approved Quinn's request to keep it, which is
        // still waiting out its objection window.
        adminAssignTreasuryOperator(enterpriseKey, vera.pk, 'admin');
        db.prepare('INSERT INTO enterprise_pledges (id, keeper, enterprise, amount, pledged_at, released_at) VALUES (?, ?, ?, 5, ?, NULL)')
            .run(crypto.randomUUID(), vera.pk, enterpriseKey, new Date().toISOString());
        adminAssignTreasuryOperator(orchard, vera.pk, 'admin');
        apiary = keyOf(createTreasury('Vera apiary VA', AVATAR, 0, { leadKeeperPubkey: vera.pk, purpose: 'Honey' } as any));
        adminAssignTreasuryOperator(apiary, cody.pk, 'admin');
        quinnChange = approveKeeperRequest(requestToJoinEnterprise(apiary, quinn.pk, 0).id, vera.pk).change!.id;
    });
    // The orchard's other keepers, bound after Vera.
    adminAssignTreasuryOperator(orchard, kai.pk, 'admin');
    adminAssignTreasuryOperator(orchard, tom.pk, 'admin');
    const keeperRole = (t: string, pk: string) =>
        (db.prepare('SELECT role FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?').get(t, pk) as { role: string } | undefined)?.role;
    assert(keeperRole(enterpriseKey, vera.pk) === 'keeper' && keeperRole(orchard, vera.pk) === 'keeper' && keeperRole(apiary, vera.pk) === 'lead'
        && (db.prepare("SELECT status FROM enterprise_keeper_changes WHERE id = ?").get(quinnChange) as any)?.status === 'pending',
        "setup: and a keeper's row on the seed bank (with a pledge) and the orchard, and the lead's on her apiary, with an approval pending");
    assert(isVisitorRow(vera.pk) && !!db.prepare("SELECT 1 FROM group_members WHERE group_id = ? AND member_pubkey = ? AND status = 'active'").get(group.id, vera.pk)
        && (db.prepare('SELECT status FROM event_rsvps WHERE post_id = ? AND member_pubkey = ?').get(event.id, vera.pk) as any)?.status === 'going',
        'setup: and from before this rule, a name and a photo, an offer, a completed trade, a group seat and a Going RSVP');
    assert(!!veraGroupLine && !!veraEventLine, "setup: and a line of her own in the group's chat and in the event's chat");
    const nobody = keypair('NobodyVA');

    // ── 1. The table ────────────────────────────────────────────────────────────────────────────
    console.log('\n── 1. Each write in the table: a member makes it; the visitor is refused it as a key with no row is');
    type Case = {
        name: string; method: string; path: (a: Id) => string; body?: (a: Id) => unknown;
        memberOk?: (r: Res) => boolean;
        /** How a key with no row is turned away, when it isn't a 4xx. */
        refused?: (r: Res) => boolean;
    };
    const ok = (r: Res) => r.status >= 200 && r.status < 300;
    const cases: Case[] = [
        // #1182 item 4, rows 4-12.
        { name: 'vouch (row 4)', method: 'POST', path: () => '/api/profile/vouch', body: () => ({ targetPubkey: carol.pk, level: 1 }) },
        { name: 'rate a completed trade (row 5)', method: 'POST', path: () => '/api/ratings',
            body: a => ({ raterPubkey: a.pk, targetPubkey: a === vera ? bob.pk : alice.pk, stars: 5, comment: 'Lovely', transactionId: a === vera ? veraTrade : miaBuys.id }) },
        { name: 'report a post (row 6)', method: 'POST', path: () => '/api/reports',
            body: a => ({ reporterPubkey: a.pk, targetPubkey: alice.pk, targetPostId: aliceOffer.id, reason: 'spam' }) },
        { name: 'post an offer (row 7)', method: 'POST', path: () => '/api/marketplace/posts',
            body: a => ({ type: 'offer', category: 'produce', title: `Plums from ${a.name}`, description: 'A box', credits: 3, priceType: 'fixed', authorPublicKey: a.pk }) },
        { name: 'post a poll (row 7)', method: 'POST', path: () => '/api/marketplace/posts',
            body: a => ({ type: 'poll', category: 'community', title: `Which day, ${a.name}?`, description: '', credits: 0, priceType: 'fixed', authorPublicKey: a.pk,
                pollOptions: [{ id: 'x', text: 'Monday' }, { id: 'y', text: 'Friday' }] }) },
        { name: 'vote in a poll (row 7)', method: 'POST', path: () => `/api/marketplace/posts/${poll.id}/vote`, body: a => ({ optionId: 'a', voterPublicKey: a.pk }) },
        { name: 'request a listing (row 8)', method: 'POST', path: () => '/api/marketplace/posts/request', body: a => ({ postId: aliceOffer.id, buyerPublicKey: a.pk }) },
        { name: 'accept an offer (row 8)', method: 'POST', path: () => '/api/marketplace/posts/accept', body: a => ({ postId: aliceOffer2.id, buyerPublicKey: a.pk }) },
        { name: 'join a group (row 9)', method: 'POST', path: () => `/api/groups/${group.id}/join` },
        { name: 'start a group (row 9)', method: 'POST', path: () => '/api/groups', body: a => ({ name: `Choir of ${a.name}`, joinPolicy: 'open' }) },
        { name: "write in a group's chat (row 9)", method: 'POST', path: () => `/api/groups/${group.id}/chat/message`, body: () => ({ text: 'Seedlings are in' }) },
        { name: 'RSVP Going to an event (row 10)', method: 'POST', path: () => `/api/marketplace/posts/${event.id}/rsvp`, body: () => ({ status: 'going' }),
            memberOk: r => ok(r) && r.body?.post?.eventPrivateNote === NOTE },
        { name: "write in an event's chat (row 10)", method: 'POST', path: () => `/api/marketplace/posts/${event.id}/chat/message`, body: () => ({ text: 'I can bring a ladder' }) },
        { name: 'set an event reminder (row 10)', method: 'PUT', path: () => `/api/events/${event.id}/reminder`, body: () => ({ offsets: [60] }) },
        { name: 'pledge to a crowdfund (row 11)', method: 'POST', path: () => `/api/crowdfund/projects/${project}/pledge`, body: a => ({ fromPubkey: a.pk, amount: 2 }) },
        // The same crowdfund through an enterprise's pledge route: it pledges to the crowdfund when the enterprise has a goal, as
        // every crowdfund has (pledgeDispatchHandler), and a note sends it there whatever the goal.
        { name: "pledge to a crowdfund through an enterprise's pledge route", method: 'POST', path: () => `/api/enterprise/${project}/pledge`, body: () => ({ amount: 2 }) },
        { name: "pledge to a crowdfund through a treasury's pledge route, with a note", method: 'POST', path: () => `/api/treasury/${project}/pledge`,
            body: () => ({ amount: 2, memo: 'For the oven' }) },
        // The rest a visitor's row could write (the sweep in section 2 found them).
        { name: 'set an area on the People list', method: 'POST', path: () => '/api/community/me/area', body: () => ({ lat: -28.55, lng: 153.51 }) },
        { name: 'add a friend', method: 'POST', path: () => '/api/friends/add', body: a => ({ ownerPubkey: a.pk, friendPubkey: carol.pk }) },
        { name: 'change the profile', method: 'POST', path: () => '/api/profile/update', body: a => ({ bio: `${a.name} grows garlic` }) },
        { name: 'set holiday mode', method: 'POST', path: () => '/api/members/holiday', body: () => ({ enabled: false }) },
        { name: 'start an enterprise', method: 'POST', path: () => '/api/enterprise', body: a => ({ name: `Bakery of ${a.name}`, purpose: 'Bread' }) },
        { name: 'ask to keep an enterprise', method: 'POST', path: () => `/api/enterprise/${enterpriseKey}/keepers/request`, body: () => ({ pledgedBacking: 0 }) },
        { name: "write in an enterprise's discussion", method: 'POST', path: () => `/api/enterprise/${enterpriseKey}/thread/message`, body: () => ({ text: 'When do you open?' }) },
        { name: 'propose a Commons project', method: 'POST', path: () => '/api/commons/projects',
            body: a => ({ proposerPubkey: a.pk, title: `Shade sails by ${a.name}`, description: 'For the market', requestedAmount: 10 }) },
        { name: 'start a crowdfund', method: 'POST', path: () => '/api/crowdfund/projects',
            body: a => ({ creatorPubkey: a.pk, title: `Kiln for ${a.name}`, description: 'A kiln', goalAmount: 50 }) },
        { name: 'propose a Decision', method: 'POST', path: () => '/api/commons/decisions',
            body: a => ({ title: `Bob vouches (${a.name})`, description: 'Bob has helped many of us', touches: 'member', effect: 'grant_voucher', subject: bob.pk }) },
        { name: 'vote on a Decision', method: 'POST', path: () => `/api/commons/decisions/${decision.id}/vote`, body: () => ({ support: true }) },
        { name: 'add a Pulse channel', method: 'POST', path: () => '/api/member/channels',
            body: a => ({ platform: 'youtube', url: `https://www.youtube.com/@${a.name.toLowerCase()}`, category: 'food' }) },
        { name: 'ask for a recovery sign-in nonce', method: 'POST', path: () => '/api/recovery/sso-nonce', body: () => ({}) },
        { name: "read its recovery keepers' status", method: 'POST', path: () => '/api/recovery/shares/status', body: () => ({}) },
        { name: 'list recoveries against its account', method: 'POST', path: () => '/api/recovery/collect/mine', body: () => ({}) },
        { name: 're-register under a new name', method: 'POST', path: () => '/api/community/register', body: a => ({ publicKey: a.pk, callsign: `${a.name} Renamed` }),
            memberOk: r => ok(r) && !!r.body?.member, refused: r => r.status === 200 && r.body?.member === null },
        // Last: a member deleting their own account.
        { name: 'delete its own account', method: 'POST', path: () => '/api/member/purge', body: () => ({}) },
    ];
    let miaAgain = mia;
    for (const c of cases) {
        // The member first, so the body is one that reaches the rule; then the key with no row, then the visitor.
        const control = c.name === 'delete its own account' ? (miaAgain = makeMember('MiaTwoVA')) : mia;
        const m = await call(c.method, control, c.path(control), c.body?.(control));
        const n = await call(c.method, nobody, c.path(nobody), c.body?.(nobody));
        const before = snapshot();
        const v = await call(c.method, vera, c.path(vera), c.body?.(vera));
        await settle(20);
        const changed = changedTables(before, snapshot());
        assert((c.memberOk ?? ok)(m), `${c.name}: a member makes it (${show(m)})`);
        assert((c.refused ?? (r => !ok(r)))(n) && same(v, n) && JSON.stringify(v.body) === JSON.stringify(n.body),
            `${c.name}: the visitor is refused as a key with no row is (visitor ${show(v)}; no row ${show(n)})`);
        assert(changed.length === 0, `${c.name}: and nothing changes${changed.length ? ` (changed: ${changed.join(', ')})` : ''}`);
    }
    void miaAgain;
    assert(isVisitorRow(vera.pk) && (db.prepare('SELECT status, callsign FROM members WHERE public_key = ?').get(vera.pk) as any)?.status === 'active',
        "Vera's row is still an active visitor's, under her own name");

    // Wes (section 1b): a visitor's row made after this rule, which keeps the mill from before it. Zed (section 1c): a visitor's row an
    // owner made admin before this rule. Swept again in sections 2 and 5b.
    let wes!: Id;
    let zed!: Id;
    /** A Settings session Zed opened while he could still open one (asBeforeThisRule), as verify-challenge and exchange open it. */
    const zedSessionBeforeThisRule = (): string => {
        let id = '';
        asBeforeThisRule(zed, () => { id = consumeHandshakeToken(mintHandshakeToken(zed.pk, 'admin').handshakeToken).sessionId ?? ''; });
        return id;
    };

    // ── 1b. Keeping an enterprise ───────────────────────────────────────────────────────────────
    console.log("\n── 1b. Keeping an enterprise: a visitor's keeper's or lead's row acts for none, and an admin appoints no visitor");
    {
        /** The visitor is refused as a key with no row is (same status, code and words), and nothing changes. */
        const refusedAsNoRow = async (what: string, who: Id, method: string, path: string, body?: unknown): Promise<void> => {
            const n = await call(method, nobody, path, body);
            const before = snapshot();
            const v = await call(method, who, path, body);
            await settle(20);
            const changed = changedTables(before, snapshot());
            assert(v.status >= 400 && same(v, n) && changed.length === 0,
                `${what}: refused as a key with no row is, and nothing changes (visitor ${show(v)}; no row ${show(n)}${changed.length ? `; changed: ${changed.join(', ')}` : ''})`);
        };
        const admin = async (method: string, path: string, body?: unknown): Promise<Res> => {
            resetGatewayRateLimit();
            const res = await fetch(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json', 'x-admin-password': process.env.ADMIN_PASSWORD! },
                body: body !== undefined ? JSON.stringify(body) : undefined });
            let json: any; try { json = await res.json(); } catch { /* empty */ }
            return { status: res.status, body: json };
        };
        const canOperateFlag = (pk: string) => (db.prepare('SELECT can_operate FROM members WHERE public_key = ?').get(pk) as any)?.can_operate;

        // Wes, a visitor made after this rule by a member's DM: an admin appoints him to keep the mill, which nobody keeps.
        wes = keypair('WesVA');
        createConversation('dm', [mia.pk, wes.pk], mia.pk);
        const appointWes = await admin('POST', `/api/local/admin/treasury/${mill}/operators`, { pubkey: wes.pk });
        const appointNobody = await admin('POST', `/api/local/admin/treasury/${mill}/operators`, { pubkey: nobody.pk });
        assert(isVisitorRow(wes.pk) && appointWes.status === 400 && appointWes.body?.error === 'Member not found' && same(appointWes, appointNobody)
            && !keeperRole(mill, wes.pk) && !canOperateFlag(wes.pk),
            `an admin can't appoint a visitor's row to keep an enterprise: "Member not found", as for a key with no row (visitor ${show(appointWes)}; no row ${show(appointNobody)})`);
        const switchWes = await admin('POST', `/api/local/admin/users/${wes.pk}/operator`, { granted: true });
        const switchNobody = await admin('POST', `/api/local/admin/users/${nobody.pk}/operator`, { granted: true });
        assert(switchWes.status === 400 && same(switchWes, switchNobody) && !canOperateFlag(wes.pk),
            `nor switch its operator access on (visitor ${show(switchWes)}; no row ${show(switchNobody)})`);

        // Mia asks to keep the mill and writes in its discussion.
        const miaAsks = requestToJoinEnterprise(mill, mia.pk, 0).id;
        const miaLine = postEnterpriseThreadMessage(mill, mia.pk, 'Is the mill grinding this week?').id;
        await refusedAsNoRow("Wes approves Mia's request to keep the mill", wes, 'POST', `/api/enterprise/${mill}/keepers/requests/${miaAsks}/approve`, {});
        // Were he bound anyway, as a row from before this rule is, as the mill's only keeper:
        asBeforeThisRule(wes, () => adminAssignTreasuryOperator(mill, wes.pk, 'admin'));
        assert(isVisitorRow(wes.pk) && keeperRole(mill, wes.pk) === 'keeper', "setup: Wes holds the mill's only keeper's row, from before this rule");
        await refusedAsNoRow("the mill's only keeper, a visitor, approves Mia's request", wes, 'POST', `/api/enterprise/${mill}/keepers/requests/${miaAsks}/approve`, {});
        await refusedAsNoRow('or declines it', wes, 'POST', `/api/enterprise/${mill}/keepers/requests/${miaAsks}/decline`, {});
        await refusedAsNoRow("or removes Mia's line from the mill's discussion", wes, 'POST', `/api/enterprise/${mill}/thread/remove`, { messageId: miaLine });
        assert(!keeperRole(mill, mia.pk) && (db.prepare('SELECT status FROM enterprise_keeper_requests WHERE id = ?').get(miaAsks) as any)?.status === 'pending',
            "Mia keeps no mill, and her request still waits");

        // The orchard: Lena leads it, and Vera (from before this rule), Kai and Tom keep it. Lena asks to remove Tom.
        const removeTom = proposeKeeperRemoval(orchard, lena.pk, tom.pk).change!.id;
        await refusedAsNoRow("Vera objects to the lead's removing Tom", vera, 'POST', `/api/enterprise/${orchard}/keepers/changes/${removeTom}/object`, {});
        const kaiObjects = await call('POST', kai, `/api/enterprise/${orchard}/keepers/changes/${removeTom}/object`, {});
        assert(kaiObjects.status === 200 && kaiObjects.body?.change?.status === 'objected', `a member who keeps it objects (control: ${show(kaiObjects)})`);
        // Lena has been away 40 days, so her keepers may choose another lead.
        db.prepare('UPDATE members SET last_active_at = ? WHERE public_key = ?').run(ago(40 * DAY), lena.pk);
        await refusedAsNoRow('Vera proposes herself as lead', vera, 'POST', `/api/enterprise/${orchard}/succession/propose`, { candidatePubkey: vera.pk });
        const kaiProposes = await call('POST', kai, `/api/enterprise/${orchard}/succession/propose`, { candidatePubkey: tom.pk });
        const proposal = kaiProposes.body?.proposal;
        assert(kaiProposes.status === 200 && proposal?.status === 'active' && proposal?.totalEligible === 2,
            `a member who keeps it proposes Tom, and the vote is Kai's and Tom's, not Vera's (control: ${show(kaiProposes)})`);
        await refusedAsNoRow('Vera votes for it', vera, 'POST', `/api/enterprise/${orchard}/succession/${proposal?.id}/vote`, { choice: 'yes' });
        // Lena steps down: the lead passes to the longest-serving keeper who can act, Kai, not Vera, whose row is older.
        const lenaLeaves = stepDownAsKeeper(orchard, lena.pk);
        assert(lenaLeaves.promoted === kai.pk && keeperRole(orchard, kai.pk) === 'lead' && keeperRole(orchard, vera.pk) === 'keeper',
            `when the lead steps down the lead passes to Kai, not to Vera (promoted ${String(lenaLeaves.promoted).slice(0, 8)})`);

        // The apiary Vera leads, from before this rule: Cody keeps it too, Pia asks to keep it, and Cody writes in its discussion.
        const pia = makeMember('PiaVA');
        const piaAsks = requestToJoinEnterprise(apiary, pia.pk, 0).id;
        const codyLine = postEnterpriseThreadMessage(apiary, cody.pk, 'Hives inspected').id;
        await refusedAsNoRow("Vera, its lead, approves Pia's request", vera, 'POST', `/api/enterprise/${apiary}/keepers/requests/${piaAsks}/approve`, {});
        await refusedAsNoRow('or declines it', vera, 'POST', `/api/enterprise/${apiary}/keepers/requests/${piaAsks}/decline`, {});
        await refusedAsNoRow('or reads who asks to keep it', vera, 'GET', `/api/enterprise/${apiary}/keepers/requests`);
        await refusedAsNoRow('or asks to remove Cody', vera, 'POST', `/api/enterprise/${apiary}/keepers/${cody.pk}/remove`, {});
        await refusedAsNoRow("or removes Cody's line from its discussion", vera, 'POST', `/api/enterprise/${apiary}/thread/remove`, { messageId: codyLine });
        await refusedAsNoRow('or marks its discussion read', vera, 'POST', '/api/messages/mark-read', { conversationId: apiary });
        await refusedAsNoRow('or mutes it', vera, 'POST', '/api/messages/mute', { conversationId: apiary, duration: '8h' });
        await refusedAsNoRow('or steps down from it', vera, 'POST', `/api/enterprise/${apiary}/keepers/step-down`, {});
        await refusedAsNoRow('or releases the backing she pledged the seed bank', vera, 'POST', `/api/enterprise/${enterpriseKey}/release`, {});
        const codyRemoves = await call('POST', cody, `/api/enterprise/${apiary}/thread/remove`, { messageId: codyLine });
        assert(codyRemoves.status === 200, `a member who keeps it removes the line (control: ${show(codyRemoves)})`);
        // Quinn's request, which Vera approved as lead before this rule: when its window ends it doesn't land.
        const due = applyDueKeeperChanges(apiary, Date.now() + 4 * DAY);
        const quinnRow = db.prepare('SELECT status, reason FROM enterprise_keeper_changes WHERE id = ?').get(quinnChange) as any;
        assert(due.applied === 0 && quinnRow?.status === 'failed' && quinnRow?.reason === 'The keeper who made this change is no longer the lead'
            && !keeperRole(apiary, quinn.pk) && keeperRole(apiary, vera.pk) === 'lead',
            `an approval Vera made as lead before this rule doesn't land when its window ends (${JSON.stringify(quinnRow)})`);

        // What each enterprise's page tells her about keeping it: what it tells a key with no row.
        const keeperView = (r: Res) => JSON.stringify([r.status, r.body?.isLeadOrSoleKeeperOrAdmin, r.body?.keeperRequests, r.body?.keeperChanges]);
        for (const [name, t] of [['the apiary', apiary], ['the orchard', orchard], ['the seed bank', enterpriseKey]] as const) {
            const v = await call('GET', vera, `/api/enterprise/${t}`);
            const n = await call('GET', nobody, `/api/enterprise/${t}`);
            assert(keeperView(v) === keeperView(n), `${name}'s page shows her what it shows a key with no row about keeping it (visitor ${keeperView(v)}; no row ${keeperView(n)})`);
        }
        assert(treasuryKeepers(apiary).find(k => k.publicKey === vera.pk)?.suspended === true && keeperOf(vera.pk).length === 0 && !canOperate(vera.pk),
            "the keepers' list shows her rows as ones that can't act, and she operates nothing");
        // An event the orchard hosts: whoever keeps it hosts it and reads its note and who is going; Vera doesn't.
        const orchardEvent = createPost('event', 'community', 'Apple picking', 'Bring a basket', 0, 'fixed', orchard, -28.55, 153.5, [], false, undefined, false,
            { eventStartAt: inHours(48), eventPlaceName: 'The orchard', eventPrivateNote: 'Orchard gate 5580' } as any)!;
        const kaiReads = await call('GET', kai, `/api/marketplace/posts?id=${orchardEvent.id}`);
        const veraReads = await call('GET', vera, `/api/marketplace/posts?id=${orchardEvent.id}`);
        assert(kaiReads.body?.[0]?.eventPrivateNote === 'Orchard gate 5580' && Array.isArray(kaiReads.body?.[0]?.eventRsvps),
            `a member who keeps the orchard hosts its event: its note and who is going (control: ${show(kaiReads)})`);
        assert(veraReads.status === 200 && veraReads.body?.[0]?.id === orchardEvent.id && !JSON.stringify(veraReads.body).includes('5580') && !veraReads.body?.[0]?.eventRsvps,
            `Vera, who keeps it too, reads the event without its note or who is going (${show(veraReads)})`);

        // ── 1c. Node roles (4111202677) ──
        console.log("\n── 1c. Node roles: an owner gives a visitor's row none, and one it holds from before this rule acts for nothing");
        const roleOf = (pk: string) => (db.prepare('SELECT role FROM node_roles WHERE member_pubkey = ?').get(pk) as { role: string } | undefined)?.role;
        const rolesNow = () => JSON.stringify(db.prepare('SELECT * FROM node_roles ORDER BY member_pubkey').all());
        for (const role of ['moderator', 'admin'] as const) {
            const n = await admin('POST', '/api/local/admin/node-roles', { pubkey: nobody.pk, role });
            const before = rolesNow();
            const v = await admin('POST', '/api/local/admin/node-roles', { pubkey: wes.pk, role });
            assert(v.status === 404 && v.body?.error === 'Member not found' && same(v, n) && rolesNow() === before,
                `the owner can't make Wes, a visitor's row, ${role}: "Member not found", as for a key with no row (visitor ${show(v)}; no row ${show(n)})`);
        }
        for (const role of ['admin', 'owner'] as const) {
            const n = await admin('POST', '/api/local/admin/auth/enrol', { memberPubkey: nobody.pk, role });
            const before = rolesNow();
            const v = await admin('POST', '/api/local/admin/auth/enrol', { memberPubkey: wes.pk, role });
            assert(v.status >= 400 && same(v, n) && rolesNow() === before && !roleOf(wes.pk),
                `nor enrol his key as an ${role}'s, as for a key with no row (visitor ${show(v)}; no row ${show(n)})`);
        }

        // Zed: a visitor's row made admin before this rule, which opened Settings sessions then. Ada is a member admin (control).
        zed = keypair('ZedVA');
        createConversation('dm', [mia.pk, zed.pk], mia.pk);
        asBeforeThisRule(zed, () => grantNodeRole(zed.pk, 'admin', 'owner:password'));
        const ada = makeMember('AdaVA');
        grantNodeRole(ada.pk, 'admin', 'owner:password');
        const zedSession = zedSessionBeforeThisRule();
        assert(isVisitorRow(zed.pk) && roleOf(zed.pk) === 'admin' && !!zedSession,
            "setup: Zed, a visitor's row, holds admin from before this rule, and a Settings session opened then");
        // He signs in to Settings as the app does (challenge, verify-challenge): refused as a key with no row is.
        const signIn = async (who: Id): Promise<Res> => {
            const c = await call('POST', null, '/api/local/admin/auth/challenge', {});
            return call('POST', null, '/api/local/admin/auth/verify-challenge', { challengeId: c.body?.challengeId, memberPubkey: who.pk,
                signature: crypto.sign(null, Buffer.from(String(c.body?.challenge)), who.priv).toString('base64') });
        };
        const zedIn = await signIn(zed);
        const nobodyIn = await signIn(nobody);
        const adaIn = await signIn(ada);
        assert(zedIn.status === 403 && same(zedIn, nobodyIn) && !zedIn.body?.handshakeToken,
            `Zed signs in to Settings: refused as a key with no row is, and no handshake (visitor ${show(zedIn)}; no row ${show(nobodyIn)})`);
        assert(adaIn.status === 200 && !!adaIn.body?.handshakeToken, `a member admin signs in (control: ${show(adaIn)})`);
        // And by phone, on a browser's sign-in code (settings-signin-pairing.ts): refused as a key with no row is; it still waits.
        const pairing = createPairing({ clientKey: 'visitors-cant-act-roles' });
        if (!pairing.ok) throw new Error(`no pairing: ${pairing.error}`);
        const approve = (id: Id) => approvePairing({ pairingId: pairing.pairingId, memberPubkey: id.pk,
            signature: crypto.sign(null, Buffer.from(pairingMessage('approve', pairing.pairingId, pairing.shortCode)), id.priv).toString('base64') });
        const pn = approve(nobody);
        const pz = approve(zed);
        assert(!pz.ok && !pn.ok && pz.status === pn.status && pz.error === pn.error && describePairing(pairing.pairingId).ok,
            `nor by phone: refused as a key with no row is, and the sign-in still waits (visitor ${JSON.stringify(pz)}; no row ${JSON.stringify(pn)})`);
        // The session he opened before this rule acts for nothing: it takes down no member's post (4111202677's last row).
        const bobPost = offer(bob, 'Bob pears').id;
        const zedTakesDown = await callWithSession(zedSession, 'POST', `/api/local/admin/posts/${bobPost}/delete`, {});
        const bobPostStatus = () => (db.prepare('SELECT status FROM posts WHERE id = ?').get(bobPost) as any)?.status;
        assert(zedTakesDown.status === 401 && zedTakesDown.body?.sessionExpired === true && bobPostStatus() === 'active',
            `his session from before this rule takes down no member's post: it is no longer a session (${show(zedTakesDown)})`);
        const adaSession = consumeHandshakeToken(adaIn.body?.handshakeToken).sessionId ?? '';
        const adaTakesDown = await callWithSession(adaSession, 'POST', `/api/local/admin/posts/${offer(bob, 'Bob quinces').id}/delete`, {});
        assert(adaTakesDown.status === 200, `a member admin's session takes one down (control: ${show(adaTakesDown)})`);
        // Signed as himself, he acts for no enterprise as admin: the forge, which Kai leads and Kit keeps, and Rex asks to keep.
        const kit = makeMember('KitVA');
        const rex = makeMember('RexVA');
        const forge = keyOf(createTreasury('Forge VA', AVATAR, 0, { leadKeeperPubkey: kai.pk, purpose: 'Iron' } as any));
        adminAssignTreasuryOperator(forge, kit.pk, 'admin');
        const rexAsks = requestToJoinEnterprise(forge, rex.pk, 0).id;
        await refusedAsNoRow("Zed, admin from before this rule, pauses the forge, which he doesn't keep", zed, 'POST', `/api/enterprise/${forge}/pause`, {});
        await refusedAsNoRow("approves Rex's request to keep it", zed, 'POST', `/api/enterprise/${forge}/keepers/requests/${rexAsks}/approve`, {});
        await refusedAsNoRow('or removes Kit, a member who keeps it', zed, 'POST', `/api/enterprise/${forge}/keepers/${kit.pk}/remove`, {});
        assert(!keeperRole(forge, rex.pk) && keeperRole(forge, kit.pk) === 'keeper', 'Rex keeps no forge, and Kit still keeps it');
        const adaPauses = await call('POST', ada, `/api/enterprise/${forge}/pause`, {});
        assert(ok(adaPauses), `a member admin pauses it (control: ${show(adaPauses)})`);
        // An owner still takes a visitor's row's role away, owner included.
        const yan = keypair('YanVA');
        createConversation('dm', [mia.pk, yan.pk], mia.pk);
        asBeforeThisRule(yan, () => grantNodeRole(yan.pk, 'owner', 'owner:password'));
        const takeYan = await admin('DELETE', `/api/local/admin/node-roles/${yan.pk}/owner`);
        assert(ok(takeYan) && !roleOf(yan.pk), `an owner takes away the owner's role a visitor's row holds from before this rule (${show(takeYan)})`);
    }

    // ── 2. The sweep ────────────────────────────────────────────────────────────────────────────
    console.log('\n── 2. Every registered write: the visitor is answered as a key with no row is, but for what it may do');
    // Every registered write, and how the sweeps below (and section 5b's) make one.
    const outside = (p: string) => ['/api/local/', '/api/admin/', '/api/manager/', '/api/pair/', '/api/pricing-guide/admin/', '/api/pricing-guide/reports']
        .some(prefix => p.startsWith(prefix)) || p === '/api/invite/redeem' || p === '/api/invite/redeem-offline';
    const app = getKoaApp() as any;
    const writes = [...new Set<string>(app.middleware.filter((m: any) => m.router).flatMap((m: any) => m.router.stack)
        .flatMap((l: any) => (l.methods as string[]).filter(m => m !== 'HEAD' && m !== 'GET').map(m => `${m} ${l.path}`)))].sort();
    const swept = writes.filter(r => !outside(r.split(' ')[1]));
    // What a visitor may do: a line in its DM, marking it read, muting it, editing and deleting its own lines there and reacting
    // there (the body names Alice's line in its DM), Beans (sections 3 and 4). Section 3 checks each, and that a line outside its
    // DM is answered as for a key with no row.
    const MAY = new Set(['POST /api/messages/send', 'POST /api/messages/mark-read', 'POST /api/messages/mute', 'POST /api/ledger/transfer',
        'POST /api/messages/edit', 'POST /api/messages/delete', 'POST /api/messages/react']);
    const materialise = (p: string, treasury = enterpriseKey) => p.replace(/:([A-Za-z]+)/g, (_, name: string) => {
        if (name === 'id') return p.startsWith('/api/groups/') ? group.id : p.startsWith('/api/marketplace/') ? event.id
            : p.startsWith('/api/crowdfund/') ? project : p.startsWith('/api/commons/decisions/') ? decision.id : 'sweep';
        return ({ pubkey: alice.pk, postId: event.id, messageId: aliceLine.id, treasury, provider: 'google' } as Record<string, string>)[name] ?? 'sweep';
    });
    const bodyFor = (a: Id) => ({
        publicKey: a.pk, authorPublicKey: a.pk, buyerPublicKey: a.pk, cancellerPublicKey: a.pk, confirmerPublicKey: a.pk, voterPublicKey: a.pk,
        authorPubkey: a.pk, from: a.pk, createdBy: a.pk, reporterPubkey: a.pk, raterPubkey: a.pk, ownerPubkey: a.pk, fromPubkey: a.pk,
        creatorPubkey: a.pk, proposerPubkey: a.pk,
        targetPubkey: alice.pk, friendPubkey: carol.pk, memberPubkey: alice.pk, to: alice.pk, candidatePubkey: bob.pk,
        participants: [a.pk, carol.pk], type: 'dm', id: aliceOffer.id, postId: aliceOffer.id, targetPostId: aliceOffer.id, groupId: group.id,
        conversationId: veraDm.id, messageId: aliceLine.id, transactionId: miaBuys.id, projectId: project,
        category: 'produce', title: `Swept ${a.name}`, description: 'Swept for the rule', credits: 1, priceType: 'fixed', amount: 1,
        ciphertext: 'aGk=', nonce: `bm9uY2U${crypto.randomBytes(3).toString('hex')}`, emoji: '👍', stars: 5, reason: 'spam', callsign: `Swept ${a.name}`,
        bio: 'Swept', text: 'Swept line', message: 'Swept line', status: 'going', support: true, choice: 'yes', optionId: 'a', enabled: false,
        duration: '8h', offsets: [60], lat: -28.5, lng: 153.5, radiusKm: 10, name: `Swept ${a.name}`, goalAmount: 10, requestedAmount: 10,
        platform: 'youtube', url: `https://www.youtube.com/@swept${a.name.toLowerCase()}`, touches: 'member', effect: 'grant_voucher', subject: bob.pk,
        token: 'ExponentPushToken[swept]', preferences: { chat: true },
    });
    {
        const differ: string[] = [];
        for (const route of swept) {
            const [method, path] = route.split(' ');
            if (MAY.has(route)) continue;
            const n = await call(method, nobody, materialise(path), bodyFor(nobody));
            const v = await call(method, vera, materialise(path), bodyFor(vera));
            if (!same(v, n)) differ.push(`${route}\n      visitor ${show(v)}\n      no row  ${show(n)}`);
        }
        assert(swept.length > 150, `the sweep takes every registered write the middleware sees: ${swept.length}`);
        assert(differ.length === 0, `every one is answered to the visitor as to a key with no row${differ.length ? `; ${differ.length} were not:\n    ${differ.join('\n    ')}` : ''}`);
        // Again for every enterprise route, on the crowdfund: an enterprise with a goal takes another path through some of them
        // (a pledge goes to the crowdfund), and the enterprise above has none.
        const onCrowdfund = swept.filter(r => r.includes(':treasury'));
        const differOnCrowdfund: string[] = [];
        for (const route of onCrowdfund) {
            const [method, path] = route.split(' ');
            const n = await call(method, nobody, materialise(path, project), bodyFor(nobody));
            const v = await call(method, vera, materialise(path, project), bodyFor(vera));
            if (!same(v, n)) differOnCrowdfund.push(`${route}\n      visitor ${show(v)}\n      no row  ${show(n)}`);
        }
        assert(onCrowdfund.length > 50 && differOnCrowdfund.length === 0,
            `every enterprise write, on a crowdfund (${onCrowdfund.length}), is answered to the visitor as to a key with no row${differOnCrowdfund.length ? `; ${differOnCrowdfund.length} were not:\n    ${differOnCrowdfund.join('\n    ')}` : ''}`);
        // And again on the apiary she leads from before this rule: a lead's row takes other paths again (4111054995).
        const differOnHers: string[] = [];
        for (const route of onCrowdfund) {
            const [method, path] = route.split(' ');
            const n = await call(method, nobody, materialise(path, apiary), bodyFor(nobody));
            const v = await call(method, vera, materialise(path, apiary), bodyFor(vera));
            if (!same(v, n)) differOnHers.push(`${route}\n      visitor ${show(v)}\n      no row  ${show(n)}`);
        }
        assert(differOnHers.length === 0,
            `every enterprise write, on the enterprise she leads (${onCrowdfund.length}), is answered to the visitor as to a key with no row${differOnHers.length ? `; ${differOnHers.length} were not:\n    ${differOnHers.join('\n    ')}` : ''}`);
        assert(isVisitorRow(vera.pk) && !db.prepare("SELECT 1 FROM members WHERE public_key = ? AND status = 'pruned'").get(vera.pk),
            'and the visitor is still a live visitor');

        // And a visitor's row holding a node role from before this rule (4111202677): Zed, admin. Every write the middleware sees,
        // signed by him and by a key with no row (a fresh one each time, so a knock or a push token of its own is compared with a
        // first one) with the same body, is answered the same, and changes nothing a key with no row's doesn't.
        /** The tables `make` changes. */
        const changes = async (make: () => Promise<Res>): Promise<{ r: Res; changed: string[] }> => {
            const before = snapshot();
            const r = await make();
            await settle(5);
            return { r, changed: changedTables(before, snapshot()) };
        };
        /** Answered the same, and the visitor changed no table the key with no row didn't. */
        const asNoRow = (route: string, v: { r: Res; changed: string[] }, n: { r: Res; changed: string[] }, who: string, other: string): string | null => {
            const extra = v.changed.filter(t => !n.changed.includes(t));
            return same(v.r, n.r) && extra.length === 0 ? null
                : `${route}\n      ${who} ${show(v.r)}\n      ${other} ${show(n.r)}${extra.length ? `\n      changed: ${extra.join(', ')}` : ''}`;
        };
        const differZed: string[] = [];
        for (const route of swept) {
            const [method, path] = route.split(' ');
            if (MAY.has(route)) continue;
            const stranger = keypair('StrangerVA');
            resetLimits();
            const n = await changes(() => call(method, stranger, materialise(path), bodyFor(stranger)));
            resetLimits();
            const v = await changes(() => call(method, zed, materialise(path), bodyFor(zed)));
            const d = asNoRow(route, v, n, 'admin visitor', 'no row       ');
            if (d) differZed.push(d);
        }
        assert(differZed.length === 0,
            `every one is answered to a visitor's row holding admin as to a key with no row, and changes nothing more${differZed.length ? `; ${differZed.length} were not:\n    ${differZed.join('\n    ')}` : ''}`);
        // The admin surface the middleware never sees (/api/local/ and the rest of `outside`): his signature is answered as a key with
        // no row's, and a Settings session he opened before this rule as one whose holder's role was taken away (Ex, a member who
        // was admin). Nothing changes either way.
        const adminWrites = writes.filter(r => outside(r.split(' ')[1]) && !r.split(' ')[1].startsWith('/api/pair/') && !r.split(' ')[1].startsWith('/api/invite/'));
        const ex = makeMember('ExVA');
        grantNodeRole(ex.pk, 'admin', 'owner:password');
        const exSessions = adminWrites.map(() => consumeHandshakeToken(mintHandshakeToken(ex.pk, 'admin').handshakeToken).sessionId ?? '');
        revokeNodeRole(ex.pk, 'admin', 'owner:password');
        const zedSessions = adminWrites.map(() => zedSessionBeforeThisRule());
        const differSigned: string[] = [];
        for (const route of adminWrites) {
            const [method, path] = route.split(' ');
            const stranger = keypair('StrangerVA');
            resetLimits();
            const n = await changes(() => call(method, stranger, materialise(path), bodyFor(stranger)));
            resetLimits();
            const v = await changes(() => call(method, zed, materialise(path), bodyFor(zed)));
            const d = asNoRow(route, v, n, 'admin visitor', 'no row       ');
            if (d) differSigned.push(d);
        }
        assert(adminWrites.length > 100 && differSigned.length === 0,
            `every admin write (${adminWrites.length}), signed by him, is answered as a key with no row's, and changes nothing more${differSigned.length ? `; ${differSigned.length} were not:\n    ${differSigned.join('\n    ')}` : ''}`);
        // Never swept with a session that still works: every admin route would run as admin, the public address's and the fleet's
        // included, which reach outside this test.
        const live = await callWithSession(zedSessionBeforeThisRule(), 'GET', '/api/local/admin/auth/session');
        const sessionActs = live.body?.authenticated !== false;
        assert(!sessionActs, `a session he opened before this rule is no longer one (${show(live)})`);
        if (!sessionActs) {
            const differSession: string[] = [];
            for (const [i, route] of adminWrites.entries()) {
                const [method, path] = route.split(' ');
                const n = await changes(() => callWithSession(exSessions[i], method, materialise(path), bodyFor(zed)));
                const v = await changes(() => callWithSession(zedSessions[i], method, materialise(path), bodyFor(zed)));
                const d = asNoRow(route, v, n, 'admin visitor', 'role taken   ');
                if (d) differSession.push(d);
            }
            assert(differSession.length === 0,
                `every admin write, under a session he opened before this rule, is answered as under one whose role was taken away, and changes nothing more${differSession.length ? `; ${differSession.length} were not:\n    ${differSession.join('\n    ')}` : ''}`);
        }
    }

    // ── 2b. Succession (4111202724) ─────────────────────────────────────────────────────────────
    console.log("\n── 2b. Succession: a visitor's lead's row may be replaced at once, and its own activity is no lead returning");
    {
        // The apiary Vera leads from before this rule (section 2 swept it with her as its lead): Cody keeps it, and now Dan.
        const dan = makeMember('DanVA');
        adminAssignTreasuryOperator(apiary, dan.pk, 'admin');
        const veraReplies = () => call('POST', vera, '/api/messages/send',
            { conversationId: veraDm.id, authorPubkey: vera.pk, ciphertext: 'c3RpbGwgaGVyZQ==', nonce: `bj${crypto.randomBytes(4).toString('hex')}` });
        const quiet = () => db.prepare('UPDATE members SET last_active_at = ? WHERE public_key = ?').run(ago(40 * DAY), vera.pk);
        // The reviewer's case: she has been quiet 40 days, so Cody's proposal opens; then she replies in her own DM.
        quiet();
        const propose = await call('POST', cody, `/api/enterprise/${apiary}/succession/propose`, { candidatePubkey: dan.pk });
        const proposal = propose.body?.proposal;
        assert(propose.status === 200 && proposal?.status === 'active', `setup: Cody proposes Dan to lead the apiary (${show(propose)})`);
        const proposalStatus = () => (db.prepare('SELECT status FROM enterprise_succession_proposals WHERE id = ?').get(proposal?.id) as any)?.status;
        const reply = await veraReplies();
        assert(reply.status === 200 && proposalStatus() === 'active',
            `Vera's reply in her own DM cancels nothing: the proposal is still open (reply ${reply.status}; proposal ${proposalStatus()})`);
        const danVotes = await call('POST', dan, `/api/enterprise/${apiary}/succession/${proposal?.id}/vote`, { choice: 'yes' });
        assert(ok(danVotes) && keeperRole(apiary, dan.pk) === 'lead' && keeperRole(apiary, vera.pk) === 'keeper',
            `Dan's vote carries it: he leads the apiary, and Vera's row is a keeper's (${show(danVotes)})`);
        const noa = makeMember('NoaVA');
        const noaAsks = requestToJoinEnterprise(apiary, noa.pk, 0).id;
        const danApproves = await call('POST', dan, `/api/enterprise/${apiary}/keepers/requests/${noaAsks}/approve`, {});
        assert(ok(danApproves), `and, as lead, answers a request to keep it, which nobody could while her row led it (${show(danApproves)})`);
        // And at once: the wax works, which she leads from before this rule too, though she replied a moment ago.
        let wax = '';
        asBeforeThisRule(vera, () => { wax = keyOf(createTreasury('Wax works VA', AVATAR, 0, { leadKeeperPubkey: vera.pk, purpose: 'Candles' } as any)); });
        adminAssignTreasuryOperator(wax, cody.pk, 'admin');
        adminAssignTreasuryOperator(wax, dan.pk, 'admin');
        await veraReplies();
        const waxPropose = await call('POST', cody, `/api/enterprise/${wax}/succession/propose`, { candidatePubkey: dan.pk });
        assert(waxPropose.status === 200 && waxPropose.body?.proposal?.status === 'active',
            `a proposal to replace her as lead of the wax works opens at once, though she replied a moment ago: her lead's row acts for nothing (${show(waxPropose)})`);
        // Control: a member's lead active within 30 days is not replaced this way.
        const press = keyOf(createTreasury('Press VA', AVATAR, 0, { leadKeeperPubkey: alice.pk, purpose: 'Cider' } as any));
        adminAssignTreasuryOperator(press, kai.pk, 'admin');
        adminAssignTreasuryOperator(press, tom.pk, 'admin');
        db.prepare('UPDATE members SET last_active_at = ? WHERE public_key = ?').run(new Date().toISOString(), alice.pk);
        const pressPropose = await call('POST', kai, `/api/enterprise/${press}/succession/propose`, { candidatePubkey: tom.pk });
        assert(pressPropose.status === 400 && /recorded node activity within the last 30 days/.test(pressPropose.body?.error ?? ''),
            `a member's lead active this month is not replaced (control: ${show(pressPropose)})`);

        // The same for groups Vera convenes from before this rule, with Cody and Dan their members.
        const groupHers = (name: string): string => {
            let id = '';
            asBeforeThisRule(vera, () => { id = createGroup({ name, createdBy: vera.pk, joinPolicy: 'open' } as any).id; });
            joinGroup(id, cody.pk);
            joinGroup(id, dan.pk);
            return id;
        };
        const hive = groupHers('Bee club VA');
        quiet();
        const groupPropose = await call('POST', cody, `/api/groups/${hive}/succession/propose`, { candidatePubkey: dan.pk });
        const groupProposal = groupPropose.body?.proposal;
        assert(groupPropose.status === 200 && groupProposal?.status === 'active', `setup: Cody proposes Dan to convene the bee club (${show(groupPropose)})`);
        const groupProposalStatus = () => (db.prepare('SELECT status FROM group_convenor_proposals WHERE id = ?').get(groupProposal?.id) as any)?.status;
        await veraReplies();
        assert(groupProposalStatus() === 'active', `her reply in her DM cancels no vote to replace her as convenor (${groupProposalStatus()})`);
        const danVotesGroup = await call('POST', dan, `/api/groups/${hive}/succession/${groupProposal?.id}/vote`, { choice: 'yes' });
        const danLeads = (db.prepare('SELECT lead_pubkey FROM groups WHERE id = ?').get(hive) as any)?.lead_pubkey === dan.pk;
        assert(ok(danVotesGroup) && groupProposalStatus() === 'passed' && danLeads, `Dan's vote carries it, and he leads the bee club (${show(danVotesGroup)})`);
        const guild = groupHers('Candle guild VA');
        await veraReplies();
        const guildPropose = await call('POST', cody, `/api/groups/${guild}/succession/propose`, { candidatePubkey: dan.pk });
        assert(guildPropose.status === 200 && guildPropose.body?.proposal?.status === 'active',
            `and a vote to replace her as convenor of the candle guild opens at once, though she replied a moment ago (${show(guildPropose)})`);
    }

    // ── 3. What a visitor keeps ─────────────────────────────────────────────────────────────────
    console.log('\n── 3. It replies in its DM and changes its own lines there, sends Beans it holds, reads its own account; it opens nothing and pays no key with no row');
    {
        const again = await call('POST', vera, '/api/messages/conversation', { type: 'dm', participants: [vera.pk, alice.pk], createdBy: vera.pk });
        assert(again.status === 200 && again.body?.conversation?.id === veraDm.id, `the app may ask for its DM again before it writes: the same one (${show(again)})`);
        const reply = await call('POST', vera, '/api/messages/send', { conversationId: veraDm.id, authorPubkey: vera.pk, ciphertext: 'dGhhbmtz', nonce: 'bjI=' });
        assert(reply.status === 200 && reply.body?.message?.authorPubkey === vera.pk, `it replies in its DM (${show(reply)})`);
        const read = await call('POST', vera, '/api/messages/mark-read', { conversationId: veraDm.id });
        const mute = await call('POST', vera, '/api/messages/mute', { conversationId: veraDm.id, duration: '8h' });
        assert(read.status === 200 && mute.status === 200, `marks it read and mutes it (${read.status} ${mute.status})`);
        // In its DM it edits and deletes its own lines and reacts, as anyone in a DM does (the director, 2026-09-26: messaging is
        // what Marty's answer gives a visitor, and a visitor that can't take its own words back is worse off for privacy).
        const ownLine = reply.body?.message?.id;
        const edit = await call('POST', vera, '/api/messages/edit', { messageId: ownLine, ciphertext: 'ZWRpdGVk', nonce: 'bjM=' });
        const edited = db.prepare('SELECT ciphertext, edited_at FROM messages WHERE id = ?').get(ownLine) as any;
        assert(edit.status === 200 && edited?.ciphertext === 'ZWRpdGVk' && !!edited.edited_at, `it edits its own line in its DM (${show(edit)})`);
        const react = await call('POST', vera, '/api/messages/react', { messageId: aliceLine.id, authorPubkey: vera.pk, emoji: '👍' });
        const aliceMeta = String((db.prepare('SELECT metadata FROM messages WHERE id = ?').get(aliceLine.id) as any)?.metadata ?? '');
        assert(react.status === 200 && aliceMeta.includes('👍') && aliceMeta.includes(vera.pk), `it reacts to Alice's line in its DM (${show(react)})`);
        const notHers = await call('POST', vera, '/api/messages/edit', { messageId: aliceLine.id, ciphertext: 'aGE=', nonce: 'bjY=' });
        const notHersGone = await call('POST', vera, '/api/messages/delete', { messageId: aliceLine.id });
        assert(notHers.status === 400 && notHers.body?.error === 'Only the author can edit a message'
            && notHersGone.status === 403 && notHersGone.body?.error === 'Only the author can delete a message'
            && (db.prepare('SELECT type FROM messages WHERE id = ?').get(aliceLine.id) as any)?.type === 'text',
            `and only its own lines, as anyone in a DM (${show(notHers)}; ${show(notHersGone)})`);
        const del = await call('POST', vera, '/api/messages/delete', { messageId: ownLine });
        assert(del.status === 200 && (db.prepare('SELECT type FROM messages WHERE id = ?').get(ownLine) as any)?.type === 'removed',
            `it deletes its own line in its DM, for both of them (${show(del)})`);
        // Outside a DM it is in, a line is answered as for a key with no row, and nothing changes: its own lines in the group's chat
        // and the event's chat, from before this rule.
        for (const [where, lineId] of [["the group's chat", veraGroupLine], ["the event's chat", veraEventLine]] as const) {
            for (const [what, path, body] of [
                ['edit', '/api/messages/edit', { messageId: lineId, ciphertext: 'ZWRpdGVk', nonce: 'bjc=' }],
                ['delete', '/api/messages/delete', { messageId: lineId }],
                ['react to', '/api/messages/react', { messageId: lineId, emoji: '👍' }],
            ] as const) {
                const n = await call('POST', nobody, path, body);
                const before = snapshot();
                const v = await call('POST', vera, path, body);
                const changed = changedTables(before, snapshot());
                assert(same(v, n) && v.status >= 400 && changed.length === 0,
                    `it can't ${what} its own line in ${where} from before this rule: answered as a key with no row is, and nothing changes (visitor ${show(v)}; no row ${show(n)}${changed.length ? `; changed: ${changed.join(', ')}` : ''})`);
            }
        }

        const newDm = await call('POST', vera, '/api/messages/conversation', { type: 'dm', participants: [vera.pk, carol.pk], createdBy: vera.pk });
        const noRowDm = await call('POST', nobody, '/api/messages/conversation', { type: 'dm', participants: [nobody.pk, carol.pk], createdBy: nobody.pk });
        assert(same(newDm, noRowDm) && newDm.status === 400, `it opens no DM with a member it has none with, refused as a key with no row is (${show(newDm)}; ${show(noRowDm)})`);
        assert(!db.prepare("SELECT 1 FROM conversation_participants a JOIN conversation_participants b ON a.conversation_id = b.conversation_id WHERE a.public_key = ? AND b.public_key = ?").get(vera.pk, carol.pk),
            'and no conversation is made');
        const fresh = keypair('FreshVA');
        const freshDm = await call('POST', vera, '/api/messages/conversation', { type: 'dm', participants: [vera.pk, fresh.pk], createdBy: vera.pk });
        assert(freshDm.status === 400 && !hasRow(fresh.pk), `nor with a key that has no row here, and that key gets none (${show(freshDm)})`);

        const veraBefore = balanceOf(vera.pk);
        const bobBefore = balanceOf(bob.pk);
        const send = await call('POST', vera, '/api/ledger/transfer', { from: vera.pk, to: bob.pk, amount: 5, memo: 'For the jam' });
        assert(send.status === 200 && Math.abs(balanceOf(vera.pk) - (veraBefore - 5)) < 1e-6 && Math.abs(balanceOf(bob.pk) - (bobBefore + 5)) < 1e-6,
            `it sends Beans it holds to a member (${show(send)})`);
        const over = await call('POST', vera, '/api/ledger/transfer', { from: vera.pk, to: bob.pk, amount: 10_000 });
        assert(over.status === 400 && Math.abs(balanceOf(vera.pk) - (veraBefore - 5)) < 1e-6, `and no more than it holds (${show(over)})`);
        const toFresh = await call('POST', vera, '/api/ledger/transfer', { from: vera.pk, to: fresh.pk, amount: 1 });
        assert(toFresh.status === 403 && toFresh.body?.code === 'not_a_member' && toFresh.body?.error === NOT_A_MEMBER && !hasRow(fresh.pk)
            && Math.abs(balanceOf(vera.pk) - (veraBefore - 5)) < 1e-6,
            `it can't pay a key that has no row here: refused, no row made, nothing moves (${show(toFresh)})`);
        // A visitor that never traded: the send gate refuses it as it refuses any new account, in words that say how.
        const vic = keypair('VicVA');
        transfer('genesis', vic.pk, 10, 'welcome gift', 'direct', true);
        const vicSend = await call('POST', vic, '/api/ledger/transfer', { from: vic.pk, to: bob.pk, amount: 1 });
        assert(isVisitorRow(vic.pk) && vicSend.status === 400 && /receive Beans/.test(vicSend.body?.error ?? '')
            && /pass them on once you join this community/.test(vicSend.body?.error ?? '') && balanceOf(vic.pk) === 10,
            `a visitor with no completed trade is refused by the send gate, told it receives Beans and can pass them on once it joins (${show(vicSend)})`);

        const balance = await call('GET', vera, `/api/ledger/balance/${vera.pk}`);
        const txs = await call('GET', vera, `/api/ledger/transactions?publicKey=${vera.pk}`);
        const convs = await call('GET', vera, `/api/messages/conversations/${vera.pk}`);
        const dm = await call('GET', vera, `/api/messages/${veraDm.id}`);
        assert(balance.status === 200 && txs.status === 200 && convs.status === 200 && dm.status === 200,
            `it reads its own balance, transactions, conversations and DM (${balance.status} ${txs.status} ${convs.status} ${dm.status})`);
        const others = await call('GET', vera, `/api/ledger/balance/${bob.pk}`);
        assert(others.status === 403, `and not someone else's (${others.status})`);
    }

    // ── 4. A refused transfer makes no row ──────────────────────────────────────────────────────
    console.log('\n── 4. A refused transfer makes no row; one that goes through makes a visitor\'s, with the Beans');
    {
        const newbie = makeMember('NewbieVA', 20);   // no completed trade: the send gate refuses a send
        const gated = keypair('GatedVA');
        const r1 = await call('POST', newbie, '/api/ledger/transfer', { from: newbie.pk, to: gated.pk, amount: 1 });
        assert(r1.status === 400 && !hasRow(gated.pk), `a send the send gate refuses leaves the recipient with no row (${show(r1)})`);
        const over = keypair('OverVA');
        const r2 = await call('POST', mia, '/api/ledger/transfer', { from: mia.pk, to: over.pk, amount: 100_000 });
        assert(r2.status === 400 && !hasRow(over.pk), `so does one over what the sender holds (${show(r2)})`);
        const paid = keypair('PaidVA');
        const r3 = await call('POST', mia, '/api/ledger/transfer', { from: mia.pk, to: paid.pk, amount: 2 });
        const acct = db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(paid.pk) as any;
        assert(r3.status === 200 && isVisitorRow(paid.pk) && Math.abs(Number(acct?.balance) - 2) < 1e-6 && Math.abs(balanceOf(paid.pk) - 2) < 1e-6,
            `a send that goes through makes the recipient's visitor's row, holding the Beans (${show(r3)}, ${JSON.stringify(acct)})`);
        // A key with no row here holds nothing to send: refused as this rule refuses a visitor's write, not a 500 (3b's note).
        const before = snapshot();
        const r4 = await call('POST', nobody, '/api/ledger/transfer', { from: nobody.pk, to: mia.pk, amount: 1 });
        const changed = changedTables(before, snapshot());
        assert(r4.status === 403 && r4.body?.code === 'not_a_member' && r4.body?.error === NOT_A_MEMBER && changed.length === 0 && !hasRow(nobody.pk),
            `a key with no row sends nothing: 403 not_a_member, in plain words, and nothing is written (${show(r4)}${changed.length ? `; changed: ${changed.join(', ')}` : ''})`);
    }

    // ── 5. /ws ──────────────────────────────────────────────────────────────────────────────────
    console.log("\n── 5. /ws: its DM and its Beans reach the visitor's socket; a group's chat and an event's chat and note never do");
    {
        const vs = await socket(vera);
        const bs = await socket(bob);
        await settle();
        vs.events.length = 0; bs.events.length = 0;
        const groupLine = await call('POST', alice, `/api/groups/${group.id}/chat/message`, { text: 'Group secret: the key is under the pot' });
        const eventLine = await call('POST', bob, `/api/marketplace/posts/${event.id}/chat/message`, { text: 'Event secret: park by the shed' });
        const noteEdit = await call('POST', alice, '/api/marketplace/posts/update', { id: event.id, authorPublicKey: alice.pk, eventPrivateNote: `${NOTE}, new code 9902` });
        const dmLine = await call('POST', alice, '/api/messages/send', { conversationId: veraDm.id, authorPubkey: alice.pk, ciphertext: 'bW9yZQ==', nonce: 'bjQ=' });
        const paid = await call('POST', alice, '/api/ledger/transfer', { from: alice.pk, to: vera.pk, amount: 1, memo: 'thanks' });
        assert(groupLine.status < 300 && eventLine.status < 300 && noteEdit.status === 200 && dmLine.status === 200 && paid.status === 200,
            `setup: a group line, an event line, a new note, a DM line and a payment to Vera (${groupLine.status} ${eventLine.status} ${noteEdit.status} ${dmLine.status} ${paid.status})`);
        await settle(400);
        const text = (s: Sock) => JSON.stringify(s.events);
        assert(vs.events.some(e => e.type === 'new_message' && e.conversationId === veraDm.id) && vs.events.some(e => e.type === 'transaction'),
            `the visitor's socket gets its DM line and its Beans (${vs.events.map(e => e.type).join(', ')})`);
        assert(!vs.events.some(e => e.conversationId === group.id || e.conversationId === event.id) && !/Group secret|Event secret|9902|4471/.test(text(vs))
            && !vs.events.some(e => e.type === 'post_updated' && e.post),
            "and not the group's chat, the event's chat, or the event's note, though a seat and a Going RSVP from before still name it");
        assert(bs.events.some(e => e.conversationId === group.id) && bs.events.some(e => e.conversationId === event.id),
            "a member's socket in the group and going to the event gets both chats (control)");
        const rsvp = await call('POST', vera, `/api/marketplace/posts/${event.id}/rsvp`, { status: 'going' });
        assert(rsvp.status === 400 && rsvp.body?.error === 'Member not found' && !JSON.stringify(rsvp.body).includes('4471'),
            `its RSVP is refused, and hands back no note (${show(rsvp)})`);
        const chat = await call('GET', vera, `/api/marketplace/posts/${event.id}/chat`);
        assert(chat.status === 403 && !JSON.stringify(chat.body).includes('4471'), `nor does the event's chat read (${chat.status})`);
        // Nor the event itself, by id or on the board: its Going RSVP from before this rule hands her no note.
        const byId = await call('GET', vera, `/api/marketplace/posts?id=${event.id}`);
        const board = await call('GET', vera, '/api/marketplace/posts?types=offer,need,poll,event');
        const bobReads = await call('GET', bob, `/api/marketplace/posts?id=${event.id}`);
        assert(byId.status === 200 && byId.body?.[0]?.id === event.id && board.status === 200 && board.body?.some((p: any) => p.id === event.id)
            && !/4471|9902/.test(JSON.stringify(byId.body) + JSON.stringify(board.body)) && /9902/.test(JSON.stringify(bobReads.body)),
            `nor the event itself, by id or on the board, though a member going reads the note (visitor ${show(byId)}; member ${show(bobReads)})`);
        vs.ws.close(); bs.ws.close();
    }

    // ── 5b. The gate ────────────────────────────────────────────────────────────────────────────
    console.log("\n── 5b. The gate: the signature middleware refuses every signed write from a visitor's row but what VISITOR_WRITES names");
    {
        gate?.setVisitorGateForTests(true);
        const GATE_ANSWER = JSON.stringify({ error: NOT_A_MEMBER, code: 'not_a_member' });
        // The allowlist is exactly what the rule gives a visitor: this list is the test's own, so the module's can't grow unseen.
        const EXPECTED = [
            // Its own direct conversations: asking for one it is in again, a reply, its own lines, reacting, marking read, muting.
            'POST /api/messages/conversation', 'POST /api/messages/send', 'POST /api/messages/edit', 'POST /api/messages/delete',
            'POST /api/messages/react', 'POST /api/messages/mark-read', 'POST /api/messages/mute',
            // Its phone, so what is sent to it reaches it: a push token, taking it away, which pushes it wants.
            'POST /api/push-tokens', 'DELETE /api/push-tokens', 'POST /api/members/preferences',
            // Beans it holds (the send gate then decides).
            'POST /api/ledger/transfer',
            // Taking down its own listing, from before this rule (4111438923).
            'POST /api/marketplace/posts/remove',
            // The join doors, signed by the joiner (its invite or ticket redeem is one the middleware never sees).
            'POST /api/join', 'POST /api/join/sso-nonce', 'POST /api/join/github/start', 'POST /api/join/github/poll', 'POST /api/join/knock',
            // What anyone may do, signed or not.
            'POST /api/pricing-guide/report',
        ].sort();
        const listed = (gate?.VISITOR_WRITES ?? []).map(w => `${w.method} ${w.path}`).sort();
        assert(JSON.stringify(listed) === JSON.stringify(EXPECTED),
            `the allowlist is exactly what the rule gives a visitor (${listed.join(', ') || 'no allowlist'})`);
        assert(listed.length > 0 && listed.every(r => writes.includes(r) && !outside(r.split(' ')[1])),
            'and each entry is a registered write the middleware sees');

        // Every other write the middleware sees, signed by a visitor's row, gets the gate's answer and changes nothing: Wes, who keeps
        // the mill from before this rule; Zed, admin from before it; Vera, with a seat, an RSVP, keeper's rows and her own lines
        // elsewhere. An allowlisted write naming what isn't the visitor's own (the body names another's DM, Alice's listing, or a
        // preference that isn't a push's) is refused the same.
        const OWN_ONLY = new Set(['POST /api/messages/conversation', 'POST /api/messages/send', 'POST /api/messages/edit', 'POST /api/messages/delete',
            'POST /api/messages/react', 'POST /api/messages/mark-read', 'POST /api/messages/mute', 'POST /api/members/preferences',
            'POST /api/marketplace/posts/remove']);
        for (const v of [wes, zed, vera]) {
            const stampBefore = (db.prepare('SELECT last_active_at FROM members WHERE public_key = ?').get(v.pk) as any)?.last_active_at;
            const notRefused: string[] = [];
            let tried = 0;
            for (const route of swept) {
                if (listed.includes(route) && !OWN_ONLY.has(route)) continue;
                const [method, path] = route.split(' ');
                // Vera's own DM is the body's: for her, the own-conversation writes name a group's line and chat instead.
                const body = v === vera && OWN_ONLY.has(route)
                    ? { ...bodyFor(v), conversationId: group.id, messageId: veraGroupLine, participants: [v.pk, carol.pk] }
                    : bodyFor(v);
                resetLimits();
                const before = snapshot();
                const r = await call(method, v, materialise(path), body);
                const changed = changedTables(before, snapshot());
                tried++;
                if (r.status !== 403 || JSON.stringify(r.body) !== GATE_ANSWER || changed.length) {
                    notRefused.push(`${route} ${show(r)}${changed.length ? ` changed: ${changed.join(', ')}` : ''}`);
                }
            }
            const stampAfter = (db.prepare('SELECT last_active_at FROM members WHERE public_key = ?').get(v.pk) as any)?.last_active_at;
            assert(isVisitorRow(v.pk) && tried > 150 && notRefused.length === 0,
                `${v.name}: every other write (${tried}) is refused 403 not_a_member "${NOT_A_MEMBER}", and changes nothing${notRefused.length ? `; ${notRefused.length} were not:\n    ${notRefused.join('\n    ')}` : ''}`);
            assert(stampAfter === stampBefore, `and a refused write stamps no activity on ${v.name}'s row (${stampBefore} → ${stampAfter})`);
        }

        // What Vera keeps, through the gate.
        const again = await call('POST', vera, '/api/messages/conversation', { type: 'dm', participants: [vera.pk, alice.pk], createdBy: vera.pk });
        const reply = await call('POST', vera, '/api/messages/send', { conversationId: veraDm.id, authorPubkey: vera.pk, ciphertext: 'Z2F0ZQ==', nonce: 'bjE3' });
        const line = reply.body?.message?.id;
        const edit = await call('POST', vera, '/api/messages/edit', { messageId: line, ciphertext: 'Z2F0ZSE=', nonce: 'bjE4' });
        const react = await call('POST', vera, '/api/messages/react', { messageId: aliceLine.id, emoji: '🌻' });
        const del = await call('POST', vera, '/api/messages/delete', { messageId: line });
        const read = await call('POST', vera, '/api/messages/mark-read', { conversationId: veraDm.id });
        const mute = await call('POST', vera, '/api/messages/mute', { conversationId: veraDm.id, duration: 'off' });
        const kept = [again, reply, edit, react, del, read, mute];
        assert(kept.every(r => r.status === 200) && again.body?.conversation?.id === veraDm.id,
            `in her DM she asks for it again, replies, edits, reacts, deletes her line, marks it read and unmutes it (${kept.map(r => r.status).join(' ')})`);
        const bobBefore = balanceOf(bob.pk);
        const send = await call('POST', vera, '/api/ledger/transfer', { from: vera.pk, to: bob.pk, amount: 1, memo: 'Through the gate' });
        assert(send.status === 200 && Math.abs(balanceOf(bob.pk) - (bobBefore + 1)) < 1e-6, `she sends Beans she holds (${show(send)})`);
        const token = await call('POST', vera, '/api/push-tokens', { publicKey: vera.pk, token: 'ExponentPushToken[vera-gate]', platform: 'android' });
        const prefs = await call('POST', vera, '/api/members/preferences', { publicKey: vera.pk, preferences: { notify_chat: false } });
        const untoken = await call('DELETE', vera, '/api/push-tokens', { publicKey: vera.pk, token: 'ExponentPushToken[vera-gate]' });
        assert(token.status === 200 && prefs.status === 200 && untoken.status === 200,
            `she registers her phone's push token, sets which pushes she wants, and takes the token away (${token.status} ${prefs.status} ${untoken.status})`);
        const balance = await call('GET', vera, `/api/ledger/balance/${vera.pk}`);
        const convs = await call('GET', vera, `/api/messages/conversations/${vera.pk}`);
        assert(balance.status === 200 && convs.status === 200, `and reads her own account (${balance.status} ${convs.status})`);
        // The join doors reach their routes, which decide: a knock, and its status read; the open door and its sign-in; a price report.
        const una = keypair('UnaVA');
        createConversation('dm', [carol.pk, una.pk], carol.pk);
        resetLimits();
        const knock = await call('POST', una, '/api/join/knock', { callsign: 'Una', message: 'I grow tomatoes near the river' });
        const status = await call('GET', una, '/api/join/knock/status');
        assert(isVisitorRow(una.pk) && knock.status === 201 && status.status === 200 && status.body?.status === 'pending',
            `a visitor's row knocks and reads its knock (${show(knock)}; ${show(status)})`);
        for (const [path, body] of [['/api/join', { provider: 'google', idToken: 'x', nonce: 'y', callsign: 'Una' }], ['/api/join/sso-nonce', {}],
            ['/api/pricing-guide/report', { itemId: 'no-such-item', reportType: 'too_high' }]] as const) {
            resetLimits();
            const r = await call('POST', una, path, body);
            assert(JSON.stringify(r.body) !== GATE_ANSWER, `${path} reaches its route, which answers (${show(r)})`);
        }

        // Members and suspended members are not the gate's: each reaches the route as before.
        const aliceSays = await call('POST', alice, '/api/messages/send', { conversationId: veraDm.id, authorPubkey: alice.pk, ciphertext: 'b2s=', nonce: 'bjE5' });
        const sid = makeMember('SidVA');
        db.prepare("UPDATE members SET status = 'suspended' WHERE public_key = ?").run(sid.pk);
        const sidPosts = await call('POST', sid, '/api/marketplace/posts', { type: 'offer', category: 'produce', title: 'Sid chutney', description: 'Jars', credits: 2, priceType: 'fixed', authorPublicKey: sid.pk });
        assert(aliceSays.status === 200 && JSON.stringify(sidPosts.body) !== GATE_ANSWER,
            `a member writes in the DM, and a suspended member is answered by the route, not the gate (${show(aliceSays)}; ${show(sidPosts)})`);
        gate?.setVisitorGateForTests(false);
    }

    // ── 5c. The gate's follow-ups ───────────────────────────────────────────────────────────────
    console.log("\n── 5c. The gate's follow-ups: no member's push reaches a visitor's phone, it sets only which of its pushes do, and it takes its own listing down");
    {
        gate?.setVisitorGateForTests(true);
        const GATE_ANSWER = JSON.stringify({ error: NOT_A_MEMBER, code: 'not_a_member' });
        type Measured = { r: Res; changed: string[] };
        /** What `make` was answered, and the tables it changed. */
        const measured = async (make: () => Promise<Res>): Promise<Measured> => {
            resetLimits();
            const before = snapshot();
            const r = await make();
            await settle(20);
            return { r, changed: changedTables(before, snapshot()) };
        };
        const refusedByGate = (m: Measured) => m.r.status === 403 && JSON.stringify(m.r.body) === GATE_ANSWER && m.changed.length === 0;
        const told = (m: Measured) => `${show(m.r)}${m.changed.length ? `; changed: ${m.changed.join(', ')}` : ''}`;
        const admin = async (method: string, path: string, body?: unknown): Promise<Res> => {
            resetLimits();
            const res = await fetch(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json', 'x-admin-password': process.env.ADMIN_PASSWORD! },
                body: body !== undefined ? JSON.stringify(body) : undefined });
            let json: any; try { json = await res.json(); } catch { /* empty */ }
            return { status: res.status, body: json };
        };

        // 4111438869: the push token the gate lets a visitor set gets what is sent to it, and no member's push. Bob (a member),
        // Vera and Nobody (a key with no row) each register a phone over HTTP, as the apps do.
        const TOKEN = { bob: 'ExponentPushToken[bob-5c]', vera: 'ExponentPushToken[vera-5c]', nobody: 'ExponentPushToken[nobody-5c]' };
        for (const [phone, token] of [[bob, TOKEN.bob], [vera, TOKEN.vera], [nobody, TOKEN.nobody]] as const) {
            const r = await call('POST', phone, '/api/push-tokens', { publicKey: phone.pk, token, platform: 'android' });
            assert(r.status === 200 && r.body?.success === true, `${phone.name} registers a phone's push token (${show(r)})`);
        }
        assert(isVisitorRow(vera.pk) && !hasRow(nobody.pk), "Vera's row is a visitor's, and Nobody has no row");
        /** Which of the three phones got a push with this title since `pushed` was last emptied. */
        const reached = (title: string) => {
            const got = (token: string) => pushed.some(p => p.to === token && p.title === title);
            return { bob: got(TOKEN.bob), vera: got(TOKEN.vera), nobody: got(TOKEN.nobody) };
        };
        const who = (r: { bob: boolean; vera: boolean; nobody?: boolean }) =>
            `member ${r.bob ? 'pushed' : 'not pushed'}, visitor ${r.vera ? 'pushed' : 'not pushed'}${r.nobody === undefined ? '' : `, no row ${r.nobody ? 'pushed' : 'not pushed'}`}`;

        // An admin's announcement: the /ws copy never reaches a visitor's socket (visitorMayReceive), nor now the push.
        pushed.length = 0;
        const announced = await admin('POST', '/api/local/admin/announcements', { title: 'Members meeting 5c', body: 'Hall, Tuesday 7pm', severity: 'info' });
        await settle(50);
        const announcement = reached('Members meeting 5c');
        assert(announced.status === 200 && announcement.bob && !announcement.vera && !announcement.nobody,
            `an admin's announcement is pushed to a member's phone, and not to a visitor's nor a key with no row's (${who(announcement)}; ${show(announced)})`);

        // An event Bob and Vera are Going to (hers from before this rule): Alice moves it, then cancels it, over HTTP.
        const bee = createPost('event', 'community', 'Probe bee 5c', 'Bring a hat', 0, 'fixed', alice.pk, -28.55, 153.5, [], false, undefined, false,
            { eventStartAt: inHours(30), eventPlaceName: 'The hall' } as any)!;
        rsvpEvent(bee.id, bob.pk, 'going');
        asBeforeThisRule(vera, () => { rsvpEvent(bee.id, vera.pk, 'going'); });
        pushed.length = 0;
        const moved = await call('POST', alice, '/api/marketplace/posts/update', { id: bee.id, authorPublicKey: alice.pk, eventStartAt: inHours(54) });
        await settle(50);
        const change = reached(EVENT_UPDATED_PUSH_TITLE);
        assert(moved.status === 200 && change.bob && !change.vera,
            `Alice moves an event Vera is Going to from before this rule: "${EVENT_UPDATED_PUSH_TITLE}" is pushed to Bob and not to Vera (${who(change)}; ${show(moved)})`);
        pushed.length = 0;
        const cancelled = await call('POST', alice, '/api/marketplace/posts/remove', { id: bee.id, authorPublicKey: alice.pk });
        await settle(50);
        const cancel = reached(EVENT_CANCELLED_PUSH_TITLE);
        assert(cancelled.status === 200 && cancelled.body?.success === true && cancel.bob && !cancel.vera,
            `and cancels it: "${EVENT_CANCELLED_PUSH_TITLE}" is pushed to Bob and not to Vera (${who(cancel)}; ${show(cancelled)})`);

        // Found while testing, the same class: a reminder. An event that starts in 50 minutes, which Bob and Vera (from before this
        // rule) are Going to with a reminder an hour before, chosen two hours ago; the node's own sweep sends it.
        const picnic = createPost('event', 'community', 'Probe picnic 5c', 'Bring a rug', 0, 'fixed', alice.pk, -28.55, 153.5, [], false, undefined, false,
            { eventStartAt: new Date(Date.now() + 50 * 60_000).toISOString(), eventPlaceName: 'The park' } as any)!;
        rsvpEvent(picnic.id, bob.pk, 'going');
        asBeforeThisRule(vera, () => { rsvpEvent(picnic.id, vera.pk, 'going'); });
        pushed.length = 0;
        db.prepare("UPDATE event_rsvps SET reminder_offsets = '[60]', updated_at = ? WHERE post_id = ?").run(ago(2 * 3_600_000), picnic.id);
        runEventReminderSweep(dispatchPushNotification);
        await settle(50);
        const reminder = reached(reminderPushTitle('Probe picnic 5c'));
        assert(reminder.bob && !reminder.vera, `the event's reminder is pushed to Bob and not to Vera (${who(reminder)})`);

        // 4111438923: she takes down her own listing, from before this rule, and nothing else.
        const aliceQuinces = offer(alice, 'Alice quinces 5c');
        const seedPackets = createPost('offer', 'produce', 'Seed packets 5c', 'Seeds', 1, 'fixed', enterpriseKey)!;
        let herEvent = '';
        let herPoll = '';
        asBeforeThisRule(vera, () => {
            herEvent = createPost('event', 'community', 'Vera open garden 5c', 'Come and see', 0, 'fixed', vera.pk, -28.55, 153.5, [], false, undefined, false,
                { eventStartAt: inHours(40), eventPlaceName: 'Her yard' } as any)!.id;
            herPoll = createPost('poll', 'community', 'Vera asks: honey or wax?', '', 0, 'fixed', vera.pk, undefined, undefined, [], false,
                undefined, false, { pollOptions: [{ id: 'h', text: 'Honey' }, { id: 'w', text: 'Wax' }] } as any)!.id;
        });
        rsvpEvent(herEvent, bob.pk, 'going');
        const notHerListing: [string, unknown][] = [
            ["Alice's listing, naming Alice as its author", { id: aliceQuinces.id, authorPublicKey: alice.pk }],
            ["Alice's listing, naming herself as its author", { id: aliceQuinces.id, authorPublicKey: vera.pk }],
            ["the listing of the seed bank, which she keeps from before this rule", { id: seedPackets.id, authorPublicKey: enterpriseKey }],
            ['her own event from before this rule (it would be cancelled, and Bob told)', { id: herEvent, authorPublicKey: vera.pk }],
            ['her own poll from before this rule', { id: herPoll, authorPublicKey: vera.pk }],
            ["a post that isn't there", { id: 'no-such-post-5c', authorPublicKey: vera.pk }],
        ];
        assert(keeperRole(enterpriseKey, vera.pk) === 'keeper', 'she still holds her keeper\'s row on the seed bank from before this rule');
        for (const [what, body] of notHerListing) {
            pushed.length = 0;
            const m = await measured(() => call('POST', vera, '/api/marketplace/posts/remove', body));
            assert(refusedByGate(m) && pushed.length === 0, `she can't take down ${what}: the gate's refusal, and nothing changes (${told(m)})`);
        }
        const postRow = () => db.prepare('SELECT * FROM posts WHERE id = ?').get(veraOffer) as Record<string, unknown>;
        const before = postRow();
        const takenDown = await measured(() => call('POST', vera, '/api/marketplace/posts/remove', { id: veraOffer, authorPublicKey: vera.pk }));
        const after = postRow();
        const differs = Object.keys(before).filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k])).sort();
        assert(before.active === 1 && before.type === 'offer' && takenDown.r.status === 200 && takenDown.r.body?.success === true
            && after.active === 0 && after.status === 'cancelled',
            `she takes down her own offer from before this rule (${told(takenDown)})`);
        assert(differs.join() === 'active,status,updated_at' && takenDown.changed.join() === 'posts',
            `and nothing else about it changes (the post's ${differs.join(', ')}; tables ${takenDown.changed.join(', ')})`);
        assert(isVisitorRow(vera.pk), 'and her row is still a visitor\'s');

        // 4111438819: which of its pushes reach its phone, and nothing more. The push settings the apps send are hers to set.
        const pushSettings = { notify_chat: true, notify_marketplace: false, notify_escrow: true, notify_recovery: true, eventReminderOffsets: [60] };
        const set = await measured(() => call('POST', vera, '/api/members/preferences', { publicKey: vera.pk, preferences: pushSettings }));
        const hers = getMemberPreferences(vera.pk);
        assert(set.r.status === 200 && set.r.body?.success === true && hers.notify_marketplace === 'false' && hers.notify_chat === 'true'
            && JSON.stringify(hers.eventReminderOffsets) === '[60]' && set.changed.join() === 'member_preferences',
            `she sets which of her pushes reach her phone: chat, marketplace, escrow, recovery and her event reminders (${told(set)})`);
        const fiftyMadeUp = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`made_up_${i}`, true]));
        const notPushSettings: [string, unknown][] = [
            ['holiday mode', { holiday_mode: true }],
            ['holiday mode beside a push setting', { notify_marketplace: true, holiday_mode: true }],
            ['fifty made-up keys', fiftyMadeUp],
            ["her reminders' stored key, past their check", { event_reminder_offsets: '[1]' }],
            ['a list', ['notify_chat']],
            ['text', 'notify_chat'],
        ];
        for (const [what, preferences] of notPushSettings) {
            const m = await measured(() => call('POST', vera, '/api/members/preferences', { publicKey: vera.pk, preferences }));
            assert(refusedByGate(m), `her preferences with ${what}: the gate's refusal, and nothing changes (${told(m)})`);
        }
        const rowsOf = (pk: string) => (db.prepare('SELECT COUNT(*) AS n FROM member_preferences WHERE public_key = ?').get(pk) as { n: number }).n;
        assert(!isOnHoliday(vera.pk) && getMemberPreferences(vera.pk).notify_marketplace === 'false',
            `she is not on holiday, and her push settings are as she set them (${rowsOf(vera.pk)} rows)`);
        // A member's body isn't the gate's to judge: it reaches the route, which takes the same push settings from anyone and refuses
        // a body with any other key whole (so a member's made-up key is the route's 400 now, where it was stored before).
        const miaSets = await measured(() => call('POST', mia, '/api/members/preferences', { publicKey: mia.pk, preferences: { notify_chat: true } }));
        assert(miaSets.r.status === 200 && miaSets.r.body?.success === true, `a member's preferences reach the route as before (${told(miaSets)})`);
        const miaMore = await measured(() => call('POST', mia, '/api/members/preferences', { publicKey: mia.pk, preferences: { notify_chat: true, chat: true } }));
        assert(miaMore.r.status === 400 && miaMore.r.body?.error === NOT_A_PUSH_SETTING_MESSAGE && miaMore.changed.length === 0,
            `and one with a key that isn't a push setting reaches it too, where the route, not the gate, refuses it whole (${told(miaMore)})`);
        gate?.setVisitorGateForTests(false);
    }

    // ── 6. Joining ──────────────────────────────────────────────────────────────────────────────
    console.log('\n── 6. After its own signed redeem, the visitor is a member and does all of it');
    {
        const invite = await call('POST', alice, '/api/invite/generate', { publicKey: alice.pk });
        const redeem = await call('POST', vera, '/api/invite/redeem', { code: invite.body?.invite?.code, publicKey: vera.pk, callsign: 'Vera' });
        assert(redeem.status === 200 && !isVisitorRow(vera.pk), `its own signed redeem makes its row a member's (${show(redeem)})`);
        const post = await call('POST', vera, '/api/marketplace/posts', { type: 'offer', category: 'produce', title: 'Vera honey, second batch', description: 'Jars', credits: 3, priceType: 'fixed', authorPublicKey: vera.pk });
        const rsvp = await call('POST', vera, `/api/marketplace/posts/${event.id}/rsvp`, { status: 'going' });
        const join = await call('POST', vera, `/api/groups/${group.id}/join`);
        const report = await call('POST', vera, '/api/reports', { reporterPubkey: vera.pk, targetPubkey: alice.pk, targetPostId: aliceOffer.id, reason: 'spam' });
        const pledge = await call('POST', vera, `/api/crowdfund/projects/${project}/pledge`, { fromPubkey: vera.pk, amount: 1 });
        const dmCarol = await call('POST', vera, '/api/messages/conversation', { type: 'dm', participants: [vera.pk, carol.pk], createdBy: vera.pk });
        const edit = await call('POST', vera, '/api/messages/react', { messageId: aliceLine.id, authorPubkey: vera.pk, emoji: '👍' });
        assert([post, rsvp, join, report, pledge, dmCarol, edit].every(ok) && rsvp.body?.post?.eventPrivateNote?.includes('9902'),
            `it posts, RSVPs (and reads the note), joins a group, reports, pledges, opens a DM and reacts (${[post, rsvp, join, report, pledge, dmCarol, edit].map(r => r.status).join(' ')})`);
        const fresh = keypair('FreshTwoVA');
        const pay = await call('POST', vera, '/api/ledger/transfer', { from: vera.pk, to: fresh.pk, amount: 1 });
        assert(pay.status === 200 && isVisitorRow(fresh.pk), `and pays a key with no row, which gets a visitor's row (${show(pay)})`);
    }

    // ── 7. The global profile ───────────────────────────────────────────────────────────────────
    console.log('\n── 7. Global profile: visitors report nothing and watch no place');
    {
        process.env.NODE_PROFILE = 'global';
        const target = createPost('offer', 'other', 'Honest offer', 'Nothing wrong with it', 0, 'fixed', carol.pk)!.id;
        const weekOld: Id[] = [];
        for (let i = 0; i < 3; i++) {
            const v = keypair(`OldVisitor${i}VA`);
            createConversation('dm', [carol.pk, v.pk], carol.pk);
            db.prepare('UPDATE members SET joined_at = ? WHERE public_key = ?').run(ago(10 * DAY), v.pk);
            weekOld.push(v);
        }
        const nr = await call('POST', nobody, '/api/reports', { reporterPubkey: nobody.pk, targetPubkey: carol.pk, targetPostId: target, reason: 'spam' });
        const answers = [];
        for (const v of weekOld) answers.push(await call('POST', v, '/api/reports', { reporterPubkey: v.pk, targetPubkey: carol.pk, targetPostId: target, reason: 'spam' }));
        const hidden = (db.prepare('SELECT hidden_by_reports_at FROM posts WHERE id = ?').get(target) as any)?.hidden_by_reports_at;
        assert(weekOld.every(v => isVisitorRow(v.pk)) && answers.every(a => same(a, nr) && a.status >= 400) && !hidden,
            `three visitors' rows of 10 days are each refused a report as a key with no row is, and hide nothing (${answers.map(show).join('; ')})`);
        for (const m of [alice, bob, mia]) await call('POST', m, '/api/reports', { reporterPubkey: m.pk, targetPubkey: carol.pk, targetPostId: target, reason: 'spam' });
        assert(!!(db.prepare('SELECT hidden_by_reports_at FROM posts WHERE id = ?').get(target) as any)?.hidden_by_reports_at,
            'three members of a week or more hide it (control)');
        const watcher = weekOld[0];
        const nw = await call('POST', nobody, '/api/global/watches', { lat: -28.6, lng: 153.4, radiusKm: 20 });
        const vw = await call('POST', watcher, '/api/global/watches', { lat: -28.6, lng: 153.4, radiusKm: 20 });
        const mw = await call('POST', alice, '/api/global/watches', { lat: -28.6, lng: 153.4, radiusKm: 20 });
        assert(same(vw, nw) && vw.status === 403 && !db.prepare('SELECT 1 FROM place_watches WHERE pubkey = ?').get(watcher.pk),
            `a visitor's place watch is refused as a key with no row's is, and none is kept (${show(vw)}; ${show(nw)})`);
        assert(ok(mw), `a member watches a place (${show(mw)})`);
        // On a node that shows visitors the listings and not the people, a visitor still changes its own lines in its own DM, and a
        // line anywhere else is answered as for a key with no row (403 members_only), with nothing changed.
        const w = weekOld[1];
        const wDm = createConversation('dm', [carol.pk, w.pk], carol.pk)!;
        const carolLine = sendMessage(wDm.id, carol.pk, 'aGVsbG8=', 'bjg=')!;
        const wReply = await call('POST', w, '/api/messages/send', { conversationId: wDm.id, authorPubkey: w.pk, ciphertext: 'aGk=', nonce: 'bjk=' });
        const wLine = wReply.body?.message?.id;
        const wEdit = await call('POST', w, '/api/messages/edit', { messageId: wLine, ciphertext: 'aGkh', nonce: 'bjEw' });
        const wReact = await call('POST', w, '/api/messages/react', { messageId: carolLine.id, emoji: '👍' });
        const wDelete = await call('POST', w, '/api/messages/delete', { messageId: wLine });
        const wRead = await call('GET', w, `/api/messages/${wDm.id}`);
        assert([wReply, wEdit, wReact, wDelete, wRead].every(r => r.status === 200)
            && (db.prepare('SELECT type FROM messages WHERE id = ?').get(wLine) as any)?.type === 'removed'
            && JSON.stringify(wRead.body).includes('👍'),
            `a visitor replies, edits and deletes its own line and reacts, in its own DM, and reads it with the reaction (${[wReply, wEdit, wReact, wDelete, wRead].map(show).join('; ')})`);
        for (const [what, path, body] of [
            ['edit', '/api/messages/edit', { messageId: aliceLine.id, ciphertext: 'aGE=', nonce: 'bjEx' }],
            ['delete', '/api/messages/delete', { messageId: aliceLine.id }],
            ['react to', '/api/messages/react', { messageId: aliceLine.id, emoji: '👍' }],
        ] as const) {
            const n = await call('POST', nobody, path, body);
            const before = snapshot();
            const v = await call('POST', w, path, body);
            const changed = changedTables(before, snapshot());
            assert(same(v, n) && v.status === 403 && v.body?.code === 'members_only' && changed.length === 0,
                `and can't ${what} a line of a DM it isn't in: answered as a key with no row is (visitor ${show(v)}; no row ${show(n)})`);
        }
        delete process.env.NODE_PROFILE;
    }

    // ── 8. Federation ───────────────────────────────────────────────────────────────────────────
    console.log('\n── 8. A member of another community, relayed by a peer, still writes to a member here');
    {
        // federation-protocol.ts relay_message, call for call: the sender becomes a visitor's row, then opens the DM and writes.
        const remote = keypair('RemoteVA');
        registerVisitor(remote.pk, 'Remote Rita', 'https://peer.example.org');
        const conv = createConversation('dm', [remote.pk, carol.pk], remote.pk);
        const line = conv ? sendMessage(conv.id, remote.pk, 'aGVsbG8gZnJvbSBhZmFy', 'bjU=', 'text') : null;
        assert(isVisitorRow(remote.pk) && !!conv && !!line && line.authorPubkey === remote.pk,
            'the relayed sender is a visitor\'s row, and its DM with a member here opens and takes its line');
    }

    // ── 9. A Settings sign-in by phone ──────────────────────────────────────────────────────────
    console.log("\n── 9. A visitor's \"No\" ends nobody's Settings sign-in by phone");
    {
        const pairing = createPairing({ clientKey: 'visitors-cant-act' });
        if (!pairing.ok) throw new Error(`no pairing: ${pairing.error}`);
        const decline = (id: Id) => declinePairing({ pairingId: pairing.pairingId, memberPubkey: id.pk,
            signature: crypto.sign(null, Buffer.from(pairingMessage('decline', pairing.pairingId, pairing.shortCode)), id.priv).toString('base64') });
        const visitor = keypair('PairVisitorVA');
        createConversation('dm', [carol.pk, visitor.pk], carol.pk);
        const n = decline(nobody);
        const v = decline(visitor);
        assert(isVisitorRow(visitor.pk) && !v.ok && !n.ok && v.status === n.status && v.error === n.error && describePairing(pairing.pairingId).ok,
            `a visitor's signed "No" is refused as a key with no row's is, and the sign-in still waits (visitor ${JSON.stringify(v)}; no row ${JSON.stringify(n)})`);
        const m = decline(alice);
        assert(m.ok && !describePairing(pairing.pairingId).ok, `a member's signed "No" ends it (control: ${JSON.stringify(m)})`);
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
