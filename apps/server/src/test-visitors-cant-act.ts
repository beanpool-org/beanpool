/**
 * A visitor's row can't act as a member: it replies in its own direct conversations and changes its own lines there,
 * sends Beans it holds (once past the send gate) and reads its own account, and nothing else a key with no row can't do (the director's rule, 2026-09-26, on Marty's answer on card
 * visitor-rows: "they receive messages and Beans but see only what a non-member sees"). #1182's deciding pass, item 4,
 * measured what a visitor's row could still write.
 *
 * The visitor (Vera) is made by a member's DM and holds Beans, as every visitor is. So that nothing but the rule can
 * refuse her, she also holds what a visitor's row could get before this rule (her row briefly unmarked to make it): a
 * name and a photo, an offer, a completed trade, a seat in a group and a Going RSVP to an event with a private note, and a
 * line of her own in each one's chat.
 * Every request goes over HTTP through the real signature middleware, or over /ws.
 *
 *  1. The table: each write a member may make that a key with no row can't (#1182 item 4 rows 4-12: vouching, rating,
 *     reporting, posting and poll votes, trades, groups, RSVPs and event chat, crowdfund pledges; and the rest the
 *     sweep found: the People list area, friends, the profile, holiday mode, enterprises and keeping one, projects,
 *     crowdfunds and a crowdfund pledged to through an enterprise's pledge route, Decisions, Pulse channels, recovery,
 *     re-registering, deleting the row, event reminders). A member
 *     makes each one (so the body reaches the rule); the visitor and a key with no row are then refused it with the
 *     same status, code and words, and the visitor's attempt changes nothing, in any table (its activity stamp aside).
 *  2. The sweep: every registered write the middleware sees, signed by the visitor and by a key with no row with the
 *     same body, is answered the same, but for what the visitor may do (a line in its DM, marking it read, muting it,
 *     changing its lines there, Beans). Then every enterprise write again on a crowdfund, an enterprise with a goal,
 *     which takes another path through some of them (a pledge goes to the crowdfund).
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
} from './state-engine.js';
import { createPairing, declinePairing, describePairing, pairingMessage } from './settings-signin-pairing.js';
import { createCrowdfundProject } from './db/db.js';
import { createDecision } from './decisions-engine.js';
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

/** Every push the node sent is answered here in place of Expo and never sent on. */
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    if (typeof url === 'string' && url.startsWith('https://exp.host/')) {
        return new Response('{"data":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(input, init);
}) as typeof fetch;

/**
 * The whole database, table by table, so an attempt can say which table changed. A signed write stamps its signer's
 * members.last_active_at before any route runs (https-server.ts requireSignature), whatever the route then answers, so
 * that column is left out: it is the activity stamp, not what the write asked for.
 */
function snapshot(): Map<string, string> {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
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
    const enterpriseKey = (enterprise as any).publicKey ?? (enterprise as any).treasury?.publicKey;
    const decision = createDecision({ authorPubkey: alice.pk, title: 'Carol vouches', description: 'Carol has helped many of us',
        touches: 'member', effect: 'grant_voucher', subject: carol.pk } as any) as any;

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
    });
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

    // ── 2. The sweep ────────────────────────────────────────────────────────────────────────────
    console.log('\n── 2. Every registered write: the visitor is answered as a key with no row is, but for what it may do');
    {
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
        assert(isVisitorRow(vera.pk) && !db.prepare("SELECT 1 FROM members WHERE public_key = ? AND status = 'pruned'").get(vera.pk),
            'and the visitor is still a live visitor');
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
        vs.ws.close(); bs.ws.close();
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
