/**
 * Pinning a post, the node's half (scratch/fable-design/DESIGN-pinning-fable.md, slice 1), over REAL HTTP through the signature
 * middleware for everything a route does, and on the engine for what no route drives (each given its own clock):
 *
 *  1. Who: an owner and an admin pin; a moderator, a member, a stranger's key, a visitor's row, a paused owner and an
 *     unsigned request can't; an automation token and an admin password reach nothing; a role in the body is read by nobody;
 *     the assistant has no tool for it.
 *  2. How long: 1, 3 or 7 days, as numbers; nothing else, and no end a client names.
 *  3. How many: three for the community; the fourth is 409 in plain words; renewing one isn't a fourth; two racing writes for
 *     the last place are one pin and one refusal, as is a burst of them.
 *  4. The order: the Market's own read leads with the pins, newest first, and pages on without repeats. Inside every filter:
 *     a pinned poll isn't under Offers, a search, a tag, a radius, one member's listings and a sync read lead with nothing.
 *  5. Order only: a post a reader can't see is no more seen for a stamp on it, and leads for nobody.
 *  6. What takes no pin: a group's, a person's, another community's, paused, hidden, removed, taken up, ended, closed, cancelled.
 *  7. How it ends, with no sweep: by the clock on every read, a held tag included; when its post leaves the board, and a post
 *     that comes back comes back unpinned; a repeating event's next date. The hygiene clears the stamps, and a main server's
 *     alone. An author on holiday holds no place, and can't come back past the three.
 *  8. Taking one off: an owner, an admin, the author, an enterprise's keeper; nobody else, in one answer.
 *  9. Every pin write moves `updated_at` and the listings' version, and no Bean.
 * 10. A standby: it takes no pin, an ordinary delta brings the stamps and takes them off, and a take-over keeps them.
 * 11. Refusals in the member's language, for all 24 catalogs.
 *
 * Run: via scripts/run-server-suites.mjs (SERVER_SUITES_ONLY=test-post-pinning)
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGS } from '@beanpool/core';
import { setMemberPhoto } from '@beanpool/engine';
import { initTls } from './services/tls.js';
import {
    initStateEngine, exportSyncState, importRemoteState, setNodeRole, grantNodeRole, runMarketplaceHygiene, getPosts,
} from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { startP2P } from './p2p.js';
import { pinMainServerForTests } from './standby-pin-test-helper.js';
import { TEST_PHOTOS } from './post-test-helper.js';
import { localFetch } from './keepalive-test-fetch.js';
import { issueAutomationToken } from './automation-tokens.js';
import { getPostsVersion } from './engine/versions.js';
import { PINS_FULL, PIN_ENDED, pinPost } from './engine/pins.js';
import { rollDueSeries, setSeriesDateSkipped } from './engine/event-series-roll.js';
import { AGENT_TOOLS } from './agent/tools.js';
import { OWNER_READ_TOOLS } from './agent/owner-reads.js';
import { OWNER_POST_TOOLS, OWNER_TEND_TOOLS } from './agent/owner-posts.js';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ FAIL: ${msg}`);
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const DAY = 86_400_000;
const TYPES = 'offer,need,poll,event';
const SYD = 'Australia/Sydney';

function makeIdentity(callsign: string, member = true): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    if (member) {
        db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, status, joined_at, updated_at)
                    VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
            .run(pubKeyHex, callsign);
        setMemberPhoto(db, pubKeyHex, AVATAR);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pubKeyHex);
    }
    return { pubKeyHex, privateKey };
}

async function signed(method: 'GET' | 'POST', pathAndQuery: string, body: unknown, id: Id, extra: Record<string, string> = {}) {
    const bodyString = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${pathAndQuery.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`;
    const headers: Record<string, string> = {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts), 'X-Nonce': nonce, ...extra,
    };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    const res = await localFetch(`${BASE}${pathAndQuery}`, { method, headers, body: method === 'POST' ? bodyString : undefined });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, error: json?.error as string | undefined, code: json?.code as string | undefined, etag: res.headers.get('etag') };
}

const stamps = (id: string) => db.prepare('SELECT pinned_until, pinned_at, updated_at FROM posts WHERE id = ?').get(id) as { pinned_until: string | null; pinned_at: string | null; updated_at: string };
const stampCount = () => (db.prepare('SELECT COUNT(*) AS n FROM posts WHERE pinned_until IS NOT NULL').get() as { n: number }).n;
const clearPins = () => db.prepare('UPDATE posts SET pinned_until = NULL, pinned_at = NULL WHERE pinned_until IS NOT NULL').run();
/** A change to a post after every write so far: it is first in any read by last change, unless a pin leads. */
const touched = async (id: string) => {
    await new Promise(r => setTimeout(r, 5));
    db.prepare('UPDATE posts SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
};

async function main(): Promise<void> {
    console.log('\nPinning a post: the node\n');
    await initTls();
    initStateEngine();
    const p2pNode = await startP2P(0, 0);
    const nodeId = p2pNode.peerId.toString();
    pinMainServerForTests(`/ip4/127.0.0.1/tcp/4043/p2p/${nodeId}`);
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const owner = makeIdentity('OwnerOl');
    const admin = makeIdentity('AdminAb');
    const admin2 = makeIdentity('AdminAce');
    const moderator = makeIdentity('ModMo');
    const member = makeIdentity('MemberMia');
    const author = makeIdentity('AuthorAl');
    const reader = makeIdentity('ReaderRo');
    const stranger = makeIdentity('StrangerSy', false);
    grantNodeRole(owner.pubKeyHex, 'owner', 'owner:password');
    grantNodeRole(admin.pubKeyHex, 'admin', 'owner:password');
    grantNodeRole(admin2.pubKeyHex, 'admin', 'owner:password');
    grantNodeRole(moderator.pubKeyHex, 'moderator', 'owner:password');

    let n = 0;
    const post = async (who: Id, body: Record<string, unknown> = {}): Promise<string> => {
        n++;
        const r = await signed('POST', '/api/marketplace/posts', {
            type: 'offer', category: 'Food', title: `Listing ${n}`, description: 'Plenty', price_c: 500 /* 5 Beans */, authorPublicKey: who.pubKeyHex,
            photos: TEST_PHOTOS, lat: -33.8688, lng: 151.2093, ...body,
        }, who);
        const id = r.body?.post?.id ?? r.body?.id;
        if (!id) throw new Error(`could not post: ${r.status} ${r.error}`);
        return id;
    };
    const pin = (id: string, who: Id, body: Record<string, unknown> = { days: 3 }, extra: Record<string, string> = {}) =>
        signed('POST', `/api/marketplace/posts/${id}/pin`, body, who, extra);
    const unpin = (id: string, who: Id) => signed('POST', `/api/marketplace/posts/${id}/unpin`, {}, who);
    const market = async (who: Id = reader, query = `types=${TYPES}&limit=50`, extra: Record<string, string> = {}) => {
        const r = await signed('GET', `/api/marketplace/posts?${query}`, null, who, extra);
        return { ...r, ids: (Array.isArray(r.body) ? r.body : []).map((p: any) => p.id as string), rows: (Array.isArray(r.body) ? r.body : []) as any[] };
    };

    const info = await localFetch(`${BASE}/api/community/info`);
    assert((await info.json() as any).features?.pins === true, 'a node says it takes pins, so an app offers one only there');

    // ── 1. Who ─────────────────────────────────────────────────────────────────────────────────
    console.log('── 1. Who may pin ──');
    const a = await post(author);
    const b = await post(author);
    const byOwner = await pin(a, owner);
    assert(byOwner.status === 200 && byOwner.body?.success === true && typeof byOwner.body?.pinnedUntil === 'string',
        `an owner pins (got ${byOwner.status} ${byOwner.error ?? ''})`);
    const byAdmin = await pin(b, admin);
    assert(byAdmin.status === 200, `an admin pins (got ${byAdmin.status} ${byAdmin.error ?? ''})`);
    clearPins();

    const refused = async (who: Id, label: string) => {
        const r = await pin(a, who);
        assert(r.status === 403 && r.code === 'pin_not_allowed' && /owner or admin/.test(r.error ?? '') && stamps(a).pinned_until === null,
            `${label} can't pin (got ${r.status} ${r.code} ${r.error ?? ''})`);
    };
    await refused(moderator, 'a moderator');
    await refused(member, 'a member');
    await refused(author, "the post's own author");
    await refused(stranger, "a key that isn't a member");

    // Whatever a client says of itself. A role in the body is read by nobody; another key named is the middleware's spoof check.
    const claims = await pin(a, member, { days: 3, role: 'owner', isOwner: true, isAdmin: true, nodeRole: 'admin', actor: owner.pubKeyHex });
    assert(claims.status === 403 && claims.code === 'pin_not_allowed' && stamps(a).pinned_until === null, `a role in the body is read by nobody (got ${claims.status})`);
    const spoof = await pin(a, member, { days: 3, authorPublicKey: owner.pubKeyHex });
    assert(spoof.status === 403 && stamps(a).pinned_until === null, `an owner's key named in the body is refused by the middleware (got ${spoof.status})`);

    const visitor = makeIdentity('VisitorVi');
    db.prepare('UPDATE members SET is_visitor = 1 WHERE public_key = ?').run(visitor.pubKeyHex);
    const byVisitor = await pin(a, visitor);
    assert(byVisitor.status === 403 && stamps(a).pinned_until === null, `a visitor's row can't pin (got ${byVisitor.status} ${byVisitor.code})`);

    const heldOwner = makeIdentity('PausedPeg');
    grantNodeRole(heldOwner.pubKeyHex, 'owner', 'owner:password');
    db.prepare("UPDATE members SET status = 'disabled' WHERE public_key = ?").run(heldOwner.pubKeyHex);
    const byHeld = await pin(a, heldOwner);
    assert(byHeld.status === 403 && stamps(a).pinned_until === null, `an owner whose account is paused holds no role that acts (got ${byHeld.status} ${byHeld.code})`);

    const open = await localFetch(`${BASE}/api/marketplace/posts/${a}/pin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"days":3}' });
    assert(open.status === 401 && stamps(a).pinned_until === null, `an unsigned request can't (got ${open.status})`);
    for (const scope of ['admin', 'agent'] as const) {
        const issued = issueAutomationToken({ name: `pinner ${scope}`, scope, expiresAt: Date.now() + DAY, createdBy: owner.pubKeyHex }) as any;
        const tokenTry = await localFetch(`${BASE}/api/marketplace/posts/${a}/pin`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${issued.token}` }, body: '{"days":3}',
        });
        assert(tokenTry.status === 401 && stamps(a).pinned_until === null, `the owner's ${scope} token reaches no pin (got ${tokenTry.status})`);
    }
    const byPassword = await localFetch(`${BASE}/api/marketplace/posts/${a}/pin`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Password': process.env.ADMIN_PASSWORD ?? 'x' }, body: '{"days":3}',
    });
    assert(byPassword.status === 401 && stamps(a).pinned_until === null, `an admin password reaches no pin (got ${byPassword.status})`);
    const toolNames = [...AGENT_TOOLS, ...OWNER_READ_TOOLS, ...OWNER_POST_TOOLS, ...OWNER_TEND_TOOLS].map(t => t.name);
    assert(toolNames.length > 0 && !toolNames.some(name => /pin/i.test(name.replace(/ping/i, ''))), `the assistant has no tool for it (${toolNames.length} tools read)`);

    // ── 2. How long ────────────────────────────────────────────────────────────────────────────
    console.log('\n── 2. How long ──');
    for (const days of [1, 3, 7]) {
        const before = Date.now();
        const r = await pin(a, owner, { days });
        const left = Date.parse(r.body?.pinnedUntil ?? '') - Date.parse(r.body?.pinnedAt ?? '');
        assert(r.status === 200 && left === days * DAY && stamps(a).pinned_until === r.body?.pinnedUntil && Date.parse(r.body?.pinnedAt) >= before - 1000,
            `pinned for ${days} day(s) ends ${days} day(s) from now (got ${r.status}, ${left} ms)`);
    }
    clearPins();
    for (const days of [0, 2, 8, 14, 30, -1, 1.5, '7', null, [7]]) {
        const r = await pin(a, owner, { days });
        assert(r.status === 400 && r.code === 'pin_bad_days' && stamps(a).pinned_until === null, `${JSON.stringify(days)} days is refused (got ${r.status} ${r.code})`);
    }
    const noDays = await pin(a, owner, {});
    assert(noDays.status === 400 && noDays.code === 'pin_bad_days', `a pin with no length is refused (got ${noDays.status})`);
    const namedEnd = await pin(a, owner, { days: 1, pinnedUntil: '2099-01-01T00:00:00.000Z', until: '2099-01-01T00:00:00.000Z' });
    assert(namedEnd.status === 200 && Date.parse(stamps(a).pinned_until!) - Date.now() <= DAY, `a client can't name the end (got ${stamps(a).pinned_until})`);
    clearPins();

    // ── 3. How many ────────────────────────────────────────────────────────────────────────────
    console.log('\n── 3. How many ──');
    const c = await post(author);
    const d = await post(author);
    const e = await post(member);
    for (const id of [a, b, c]) await pin(id, admin);
    const fourth = await pin(d, owner);
    assert(fourth.status === 409 && fourth.code === 'pins_full' && fourth.error === PINS_FULL && stamps(d).pinned_until === null,
        `the fourth is refused for the community, whoever pinned the others (got ${fourth.status} ${fourth.error ?? ''})`);
    const firstEnd = stamps(a).pinned_until!;
    await new Promise(r => setTimeout(r, 5));
    const renewed = await pin(a, owner, { days: 7 });
    assert(renewed.status === 200 && stamps(a).pinned_until !== firstEnd && Date.parse(stamps(a).pinned_until!) - Date.now() > 6 * DAY,
        `pinning a pinned post again sets a new end from now, at three (got ${renewed.status})`);
    assert(stampCount() === 3, `still three (got ${stampCount()})`);
    await unpin(c, owner);
    const race = await Promise.all([pin(d, admin), pin(e, admin2)]);
    const raceWon = race.filter(r => r.status === 200).length;
    const raceLost = race.filter(r => r.status === 409 && r.code === 'pins_full').length;
    assert(raceWon === 1 && raceLost === 1 && stampCount() === 3, `two racing writes for the last place: one pin, one refusal (${race.map(r => r.status)}, ${stampCount()} pinned)`);
    clearPins();
    const burstIds = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(() => post(author)));
    const burst = await Promise.all(burstIds.map((id, i) => pin(id, i % 2 ? admin : admin2)));
    assert(burst.filter(r => r.status === 200).length === 3 && burst.filter(r => r.code === 'pins_full').length === 5 && stampCount() === 3,
        `a burst of eight: three pins and five refusals (${burst.map(r => r.status)})`);
    clearPins();

    // ── 4. The order ───────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. The order ──');
    const old = await post(author, { title: 'Oldest offer', category: 'Garden' });
    const need = await post(author, { type: 'need', title: 'A need', category: 'Food' });
    const poll = await post(owner, { type: 'poll', title: 'What shall we plant?', description: 'Vote', pollOptions: ['Beans', 'Peas'], durationDays: 7 });
    const newest = await post(author, { title: 'Newest offer' });
    const none = await market();
    assert(none.ids[0] === newest, `with nothing pinned the Market is newest first (first is ${none.ids[0]})`);
    await pin(old, owner);
    await new Promise(r => setTimeout(r, 5));
    await pin(need, admin);
    await new Promise(r => setTimeout(r, 5));
    const pinned = await pin(poll, admin);
    assert(pinned.status === 200, `a poll is pinned (got ${pinned.status} ${pinned.error ?? ''})`);
    const led = await market();
    assert(led.ids.slice(0, 3).join() === [poll, need, old].join(), `the pins lead, newest pin first (got ${led.ids.slice(0, 3)})`);
    assert(new Set(led.ids).size === led.ids.length, 'no post is on the page twice');
    assert(led.rows[0].pinnedUntil === stamps(poll).pinned_until && led.rows[0].pinnedAt === stamps(poll).pinned_at, 'a pinned row carries its two stamps');
    assert(!('pinnedUntil' in (led.rows.find(p => p.id === newest) ?? { pinnedUntil: 1 })), 'a row nobody pinned reads as it did');
    assert(none.etag !== led.etag, 'the tag moved');

    const allIds = led.ids;
    const pageOne = await market(reader, `types=${TYPES}&limit=2&offset=0`);
    const pageTwo = await market(reader, `types=${TYPES}&limit=2&offset=2`);
    const pageThree = await market(reader, `types=${TYPES}&limit=2&offset=4`);
    assert([...pageOne.ids, ...pageTwo.ids, ...pageThree.ids].join() === allIds.slice(0, 6).join(),
        `pages of two run on through the pins, none repeated and none skipped (${pageOne.ids.length}, ${pageTwo.ids.length}, ${pageThree.ids.length})`);
    const pageOf3 = await market(reader, `types=${TYPES}&limit=3`);
    assert(pageOf3.ids.join() === [poll, need, old].join(), `a page the pins fill is the pins (got ${pageOf3.ids})`);

    const offers = await market(reader, `type=offer&limit=50`);
    assert(offers.ids[0] === old && !offers.ids.includes(poll) && !offers.ids.includes(need), `under Offers, the pinned Offer alone leads (got ${offers.ids[0]})`);
    const polls = await market(reader, `type=poll&limit=50`);
    assert(polls.ids[0] === poll && !polls.ids.includes(old), `under Polls, the pinned poll alone (got ${polls.ids[0]})`);
    const needs = await market(reader, `type=need&limit=50`);
    assert(needs.ids[0] === need, 'under Needs, the pinned Need');
    const garden = await market(reader, `types=${TYPES}&category=Garden&limit=50`);
    assert(garden.ids[0] === old && !garden.ids.includes(need), `a pinned Food post is not under Garden (got ${garden.ids})`);
    const food = await market(reader, `types=${TYPES}&category=Food&limit=50`);
    assert(!food.ids.includes(old) && food.ids[0] === need, `nor the Garden one under Food (got ${food.ids[0]})`);

    // A pin moves updated_at, as an edit does, and these reads go by it: an edit since, so a lift could only be the pin's.
    await new Promise(r => setTimeout(r, 5));
    await signed('POST', '/api/marketplace/posts/update', { id: newest, authorPublicKey: author.pubKeyHex, title: 'Newest offer, edited' }, author);
    const search = await market(reader, `types=${TYPES}&q=plenty&limit=50`);
    assert(search.status === 200 && search.ids.includes(old) && search.ids[0] === newest, `a search leads with no pin (first is ${search.ids[0]})`);
    const radius = await market(reader, `types=${TYPES}&lat=-33.8688&lng=151.2093&radiusKm=50&limit=50`);
    assert(radius.status === 200 && radius.ids.includes(old) && radius.ids[0] !== poll, `a radius leads with no pin (first is ${radius.ids[0]})`);
    const theirs = await market(reader, `types=${TYPES}&author=${author.pubKeyHex}&limit=50`);
    assert(theirs.ids.includes(old) && theirs.ids[0] === newest, `one member's listings lead with no pin (first is ${theirs.ids[0]})`);
    const syncRead = await market(reader, `types=${TYPES}&sync=true&limit=50`);
    assert(syncRead.ids[0] === newest && syncRead.ids.includes(poll) && syncRead.rows.find(p => p.id === poll)?.pinnedUntil === stamps(poll).pinned_until,
        `a sync read keeps its order and carries the stamps (first is ${syncRead.ids[0]})`);
    const delta = await market(reader, `types=${TYPES}&updatedAfter=${encodeURIComponent(new Date(Date.now() - DAY).toISOString())}&limit=50`);
    assert(delta.status === 200 && delta.ids.includes(poll) && delta.ids[0] === newest, `a delta keeps its own order (first is ${delta.ids[0]})`);
    const internal = getPosts({ limit: 50 });
    assert(internal[0].id === newest, `and a read that doesn't ask for pinsFirst leads with nothing (first is ${internal[0].id})`);

    // ── 5. Order only ──────────────────────────────────────────────────────────────────────────
    console.log('\n── 5. Order only ──');
    clearPins();
    const groupId = crypto.randomUUID();
    db.prepare(`INSERT INTO groups (id, name, slug, created_by) VALUES (?, 'Garden club', 'garden-club', ?)`).run(groupId, author.pubKeyHex);
    for (const k of [author, moderator]) {
        db.prepare(`INSERT INTO group_members (group_id, member_pubkey, role, status) VALUES (?, ?, 'member', 'active')`).run(groupId, k.pubKeyHex);
    }
    const groupPost = await post(author, { title: 'Club only', audienceScope: 'group', targetGroupId: groupId });
    const directPost = await post(author, { title: 'For one person', audienceScope: 'direct', targetPubkey: moderator.pubKeyHex });
    const groupTry = await pin(groupPost, owner);
    assert(groupTry.status === 400 && groupTry.code === 'pin_not_public' && /public/.test(groupTry.error ?? '') && stamps(groupPost).pinned_until === null,
        `a group's post can't be pinned (got ${groupTry.status} ${groupTry.code})`);
    const directTry = await pin(directPost, owner);
    assert(directTry.status === 400 && directTry.code === 'pin_not_public', `nor a post for one person (got ${directTry.status})`);
    // However a stamp came to be on one: a read keeps the audience's rules, for everyone.
    db.prepare('UPDATE posts SET pinned_until = ?, pinned_at = ? WHERE id = ?').run(new Date(Date.now() + DAY).toISOString(), new Date().toISOString(), groupPost);
    await touched(newest);
    const outsider = await market(reader);
    assert(!outsider.ids.includes(groupPost), 'a stamp shows a group\'s post to nobody outside it');
    const insider = await market(moderator);
    assert(insider.ids.includes(groupPost) && insider.ids[0] === newest, `and leads for nobody inside it (first is ${insider.ids[0]})`);
    clearPins();
    // A moderator reads what is hidden from everyone else: where it falls, never on top.
    await pin(old, owner);
    db.prepare('UPDATE posts SET hidden_by_reports_at = ? WHERE id = ?').run(new Date().toISOString(), old);
    await touched(newest);
    const hiddenRead = await market(moderator);
    assert(hiddenRead.ids.includes(old) && hiddenRead.ids[0] === newest, `a moderator's read of a hidden post leads with nothing (first is ${hiddenRead.ids[0]})`);
    const hiddenToMembers = await market(reader);
    assert(!hiddenToMembers.ids.includes(old), 'and a member reads no hidden post');
    db.prepare('UPDATE posts SET hidden_by_reports_at = NULL WHERE id = ?').run(old);
    clearPins();

    // ── 6. What takes no pin ───────────────────────────────────────────────────────────────────
    console.log('\n── 6. What takes no pin ──');
    const endedWith = async (id: string, label: string, code = 'pin_ended') => {
        const r = await pin(id, owner);
        assert(r.status === 400 && r.code === code && stamps(id).pinned_until === null, `${label} takes no pin (got ${r.status} ${r.code})`);
        if (code === 'pin_ended') assert(r.error === PIN_ENDED, `in plain words (${r.error})`);
    };
    const paused = await post(author);
    await signed('POST', '/api/marketplace/posts/pause', { postId: paused, authorPublicKey: author.pubKeyHex }, author);
    await endedWith(paused, 'a paused post');
    const hidden = await post(author);
    db.prepare('UPDATE posts SET hidden_by_reports_at = ? WHERE id = ?').run(new Date().toISOString(), hidden);
    await endedWith(hidden, 'a post hidden by reports');
    const removed = await post(author);
    db.prepare("UPDATE posts SET removed_by_moderator_at = ?, active = 0, status = 'cancelled' WHERE id = ?").run(new Date().toISOString(), removed);
    await endedWith(removed, 'a removed post');
    const taken = await post(author);
    db.prepare("UPDATE posts SET status = 'pending' WHERE id = ?").run(taken);
    await endedWith(taken, 'a post taken up');
    const done = await post(author);
    db.prepare("UPDATE posts SET status = 'completed' WHERE id = ?").run(done);
    await endedWith(done, 'a completed post');
    const closedPoll = await post(owner, { type: 'poll', title: 'Closed?', description: 'Vote', pollOptions: ['Yes', 'No'], durationDays: 7 });
    await signed('POST', `/api/marketplace/posts/${closedPoll}/close`, {}, owner);
    await endedWith(closedPoll, 'a closed poll');
    const pastPoll = await post(owner, { type: 'poll', title: 'Past?', description: 'Vote', pollOptions: ['Yes', 'No'], durationDays: 7 });
    db.prepare('UPDATE posts SET poll_closes_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), pastPoll);
    await endedWith(pastPoll, 'a poll past its close');
    const clockIn = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 11) + '10:00';
    const eventBody = (days: number) => ({ type: 'event', title: `Working bee ${days}`, description: 'Bring gloves', eventStartLocal: clockIn(days), eventTz: SYD, eventPlaceName: 'The hall' });
    const event = await post(author, eventBody(4));
    const endedEvent = await post(author, eventBody(5));
    db.prepare('UPDATE posts SET event_start_at = ?, event_end_at = ? WHERE id = ?').run(new Date(Date.now() - 2 * 3_600_000).toISOString(), new Date(Date.now() - 1000).toISOString(), endedEvent);
    await endedWith(endedEvent, 'an event that has ended');
    const cancelledEvent = await post(author, eventBody(6));
    db.prepare("UPDATE posts SET event_state = 'cancelled' WHERE id = ?").run(cancelledEvent);
    await endedWith(cancelledEvent, 'a cancelled event');
    const linked = await post(author);
    db.prepare('UPDATE posts SET origin_node = ? WHERE id = ?').run('https://other.example', linked);
    await endedWith(linked, "another community's post", 'pin_not_local');
    const gone = await pin('no-such-post', owner);
    assert(gone.status === 404 && gone.code === 'pin_not_found', `a post that isn't there (got ${gone.status} ${gone.code})`);
    const holiday = await post(reader);
    db.prepare("INSERT OR REPLACE INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, 'holiday_mode', 'true')").run(reader.pubKeyHex);
    await endedWith(holiday, "a post whose author is away");
    db.prepare("DELETE FROM member_preferences WHERE public_key = ? AND pref_key = 'holiday_mode'").run(reader.pubKeyHex);
    const eventPin = await pin(event, owner);
    assert(eventPin.status === 200, `an event on the board takes one (got ${eventPin.status} ${eventPin.error ?? ''})`);
    clearPins();

    // ── 7. How it ends ─────────────────────────────────────────────────────────────────────────
    console.log('\n── 7. How it ends ──');
    const clockPost = await post(author);
    const latest = await post(author);
    // Ends in a moment: pinned a day ago, less a moment.
    pinPost(clockPost, admin.pubKeyHex, 1, Date.now() - DAY + 1200);
    const whilePinned = await market();
    assert(whilePinned.ids[0] === clockPost && whilePinned.ids[1] === latest, `pinned, it leads (first is ${whilePinned.ids[0]})`);
    await new Promise(r => setTimeout(r, 1300));
    const heldTag = await market(reader, `types=${TYPES}&limit=50`, { 'If-None-Match': whilePinned.etag ?? '' });
    assert(heldTag.status === 200 && heldTag.ids[0] === latest, `past its end, a held tag is answered with the ordinary order (got ${heldTag.status}, first ${heldTag.ids[0]})`);
    assert(stamps(clockPost).pinned_until !== null, 'with no sweep run: the stamp is still on the row');
    const afterEnd = await market();
    const lastChanges = afterEnd.rows.map(p => p.updatedAt as string);
    assert(afterEnd.ids[0] === latest && afterEnd.ids.includes(clockPost) && lastChanges.every((at, i) => i === 0 || at <= lastChanges[i - 1]),
        'and it orders as an ordinary post, by its last change');

    // A place freed by the clock is free before any sweep.
    clearPins();
    for (const id of [a, b]) await pin(id, owner);
    pinPost(c, owner.pubKeyHex, 1, Date.now() - 2 * DAY);
    assert(stampCount() === 3, 'three stamps, one past its end');
    const lastPlace = await pin(d, owner);
    assert(lastPlace.status === 200 && stamps(c).pinned_until === null && stampCount() === 3, `one past its end holds no place (got ${lastPlace.status}, ${stampCount()} stamps)`);
    clearPins();

    // A post that leaves the board loses its pin in that write, and comes back without it.
    const leaves = async (label: string, leave: (id: string) => Promise<void> | void, back: (id: string) => Promise<void> | void) => {
        const id = await post(author);
        await pin(id, owner);
        await leave(id);
        assert(stamps(id).pinned_until === null && stamps(id).pinned_at === null, `${label}: the pin ended, no sweep run`);
        await back(id);
        await touched(latest);
        const read = await market();
        assert(read.ids[0] === latest && read.ids.includes(id) && stamps(id).pinned_until === null, `${label}: back, it is unpinned (first is ${read.ids[0]})`);
    };
    await leaves('paused and resumed',
        async id => { await signed('POST', '/api/marketplace/posts/pause', { postId: id, authorPublicKey: author.pubKeyHex }, author); },
        async id => { await signed('POST', '/api/marketplace/posts/resume', { postId: id, authorPublicKey: author.pubKeyHex }, author); });
    await leaves('hidden and restored',
        id => { db.prepare('UPDATE posts SET hidden_by_reports_at = ? WHERE id = ?').run(new Date().toISOString(), id); },
        id => { db.prepare('UPDATE posts SET hidden_by_reports_at = NULL WHERE id = ?').run(id); });
    await leaves('taken up and called off',
        id => { db.prepare("UPDATE posts SET status = 'pending' WHERE id = ?").run(id); },
        id => { db.prepare("UPDATE posts SET status = 'active' WHERE id = ?").run(id); });

    const poll2 = await post(owner, { type: 'poll', title: 'Close me', description: 'Vote', pollOptions: ['Yes', 'No'], durationDays: 7 });
    await pin(poll2, owner);
    await signed('POST', `/api/marketplace/posts/${poll2}/close`, {}, owner);
    assert(stamps(poll2).pinned_until === null, 'a poll closed ends its pin');
    const remove = await post(author);
    await pin(remove, owner);
    await signed('POST', '/api/marketplace/posts/remove', { id: remove, postId: remove, authorPublicKey: author.pubKeyHex }, author);
    assert(stamps(remove).pinned_until === null, 'a post taken down ends its pin');

    // A repeating event: a pin is on a date, never on the series.
    const byDay = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][new Date(`${clockIn(3)}Z`).getUTCDay()];
    const series = await post(owner, { ...eventBody(3), title: 'Weekly market', eventEndLocal: clockIn(3).replace('10:00', '12:00'), eventRepeat: { freq: 'weekly', interval: 1, byDay } });
    await pin(series, owner);
    assert(stamps(series).pinned_until !== null, 'a repeating event is pinned for its date');
    const seriesRow = db.prepare('SELECT event_end_at, event_start_local FROM posts WHERE id = ?').get(series) as any;
    rollDueSeries(undefined, Date.parse(seriesRow.event_end_at) + 1000);
    const rolled = db.prepare('SELECT event_start_local FROM posts WHERE id = ?').get(series) as any;
    assert(rolled.event_start_local !== seriesRow.event_start_local && stamps(series).pinned_until === null && stamps(series).pinned_at === null,
        `the roll to its next date takes the pin off (moved to ${rolled.event_start_local})`);
    await pin(series, owner);
    setSeriesDateSkipped(undefined, undefined, series, owner.pubKeyHex, rolled.event_start_local.slice(0, 10), true);
    assert(stamps(series).pinned_until === null, 'and so does cancelling the date it was pinned for');
    clearPins();

    // The hygiene clears what time ended, and what is off the board for its author's sake; a main server's alone.
    const swept = await post(author);
    const kept = await post(author);
    const away = await post(reader);
    await pin(kept, owner);
    await pin(away, owner);
    pinPost(swept, owner.pubKeyHex, 1, Date.now() - 2 * DAY);
    db.prepare("INSERT OR REPLACE INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, 'holiday_mode', 'true')").run(reader.pubKeyHex);
    const awayRead = await market(reader, `types=${TYPES}&limit=50`);
    assert(awayRead.ids[0] === kept, `an author away: the post is off the board and leads for nobody (first is ${awayRead.ids[0]})`);
    const stale = stamps(swept).updated_at;
    setNodeRole('backup');
    runMarketplaceHygiene();
    setNodeRole('primary');
    assert(stamps(swept).pinned_until !== null, 'a standby sweeps nothing');
    await new Promise(r => setTimeout(r, 5));
    const versionBefore = getPostsVersion();
    runMarketplaceHygiene();
    assert(stamps(swept).pinned_until === null && stamps(swept).pinned_at === null && stamps(swept).updated_at !== stale, 'the hygiene clears a pin past its end, stamped so a delta carries it');
    assert(stamps(away).pinned_until === null, "and one whose author is off the board");
    assert(stamps(kept).pinned_until !== null, 'and leaves a live one alone');
    assert(getPostsVersion() === versionBefore + 1, `the listings' version moves once (by ${getPostsVersion() - versionBefore})`);
    const versionIdle = getPostsVersion();
    runMarketplaceHygiene();
    assert(getPostsVersion() === versionIdle, 'with nothing to clear it moves nothing');
    db.prepare("DELETE FROM member_preferences WHERE public_key = ? AND pref_key = 'holiday_mode'").run(reader.pubKeyHex);
    const backRead = await market();
    assert(backRead.ids[0] === kept && backRead.ids.includes(away) && stamps(away).pinned_until === null, 'an author back from holiday comes back unpinned');
    clearPins();

    // An author away can't come back past the three.
    const offBoard = await post(reader);
    await pin(offBoard, owner);
    db.prepare("INSERT OR REPLACE INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, 'holiday_mode', 'true')").run(reader.pubKeyHex);
    for (const id of [a, b, c]) {
        const r = await pin(id, owner);
        assert(r.status === 200, `a place held by an author away is free (got ${r.status} ${r.error ?? ''})`);
    }
    db.prepare("DELETE FROM member_preferences WHERE public_key = ? AND pref_key = 'holiday_mode'").run(reader.pubKeyHex);
    assert(stampCount() === 3 && stamps(offBoard).pinned_until === null, `back again they make no fourth (${stampCount()} stamps)`);
    clearPins();

    // ── 8. Taking one off ──────────────────────────────────────────────────────────────────────
    console.log('\n── 8. Taking one off ──');
    const offs = await post(author);
    for (const [who, label] of [[owner, 'an owner'], [admin, 'an admin'], [author, 'its author']] as Array<[Id, string]>) {
        await pin(offs, owner);
        const r = await unpin(offs, who);
        assert(r.status === 200 && stamps(offs).pinned_until === null && stamps(offs).pinned_at === null, `${label} takes it off (got ${r.status} ${r.code})`);
    }
    await pin(offs, owner);
    const offBy = await Promise.all([unpin(offs, moderator), unpin(offs, member), unpin(offs, stranger)]);
    const missing = await unpin('no-such-post', member);
    assert(offBy.every(r => r.status === 403 && r.code === 'pin_off_not_allowed') && stamps(offs).pinned_until !== null, `a moderator, a member and a stranger can't (${offBy.map(r => r.status)})`);
    assert(missing.status === 403 && missing.error === offBy[1].error, 'and one that isn\'t there reads alike');
    const twice = await unpin(offs, owner);
    const thrice = await unpin(offs, owner);
    assert(twice.status === 200 && thrice.status === 200, 'taking off one that is off is nothing');

    // An enterprise's listing: its keeper is its author here.
    const enterprise = makeIdentity('EnterpriseEd');
    db.prepare('UPDATE members SET is_treasury = 1 WHERE public_key = ?').run(enterprise.pubKeyHex);
    const keeper = makeIdentity('KeeperKe');
    db.prepare('UPDATE members SET can_operate = 1 WHERE public_key = ?').run(keeper.pubKeyHex);
    db.prepare('INSERT INTO treasury_operators (treasury_pubkey, member_pubkey) VALUES (?, ?)').run(enterprise.pubKeyHex, keeper.pubKeyHex);
    const shopPost = 'pin-enterprise-post';
    db.prepare(`INSERT INTO posts (id, type, category, title, description, price_c, author_pubkey, created_at, active, status, updated_at) VALUES (?, 'offer', 'Food', 'Bread', 'Fresh', 500, ?, ?, 1, 'active', ?)`) // 5 Beans
        .run(shopPost, enterprise.pubKeyHex, new Date().toISOString(), new Date().toISOString());
    const shopPin = await pin(shopPost, owner);
    assert(shopPin.status === 200, `an enterprise's listing is pinned like any (got ${shopPin.status} ${shopPin.error ?? ''})`);
    const byKeeper = await unpin(shopPost, keeper);
    assert(byKeeper.status === 200 && stamps(shopPost).pinned_until === null, `its keeper takes it off (got ${byKeeper.status} ${byKeeper.code})`);
    clearPins();

    // ── 9. The write ───────────────────────────────────────────────────────────────────────────
    console.log('\n── 9. The write ──');
    const beans = () => JSON.stringify(db.prepare('SELECT public_key, balance_c FROM accounts ORDER BY public_key').all());
    const ledgerRows = () => (db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n;
    const beansBefore = beans();
    const ledgerBefore = ledgerRows();
    const written = await post(author);
    const atFirst = stamps(written).updated_at;
    await new Promise(r => setTimeout(r, 5));
    const v0 = getPostsVersion();
    await pin(written, owner);
    const pinnedStamp = stamps(written);
    assert(pinnedStamp.updated_at !== atFirst && pinnedStamp.updated_at === pinnedStamp.pinned_at && getPostsVersion() === v0 + 1,
        `a pin moves updated_at and the listings' version (by ${getPostsVersion() - v0})`);
    await new Promise(r => setTimeout(r, 5));
    const v1 = getPostsVersion();
    await unpin(written, owner);
    assert(stamps(written).updated_at !== pinnedStamp.updated_at && getPostsVersion() === v1 + 1, 'and so does taking it off');
    const v2 = getPostsVersion();
    await pin(written, moderator);
    await unpin(written, owner);
    assert(getPostsVersion() === v2, 'a refused pin and an idle take-off move nothing');
    await pin(written, owner);
    await pin(written, owner, { days: 7 });
    await unpin(written, author);
    assert(beans() === beansBefore && ledgerRows() === ledgerBefore, 'no Bean moved and no balance was written');
    const muted = makeIdentity('MutedMo');
    grantNodeRole(muted.pubKeyHex, 'admin', 'owner:password');
    db.prepare('UPDATE members SET moderation_muted_until = ? WHERE public_key = ?').run('9999-12-31T23:59:59.999Z', muted.pubKeyHex);
    const mutedTry = await pin(written, muted);
    assert(mutedTry.status === 403 && mutedTry.code === 'moderation_muted' && stamps(written).pinned_until === null, `a pin publishes, so a muted admin can't (got ${mutedTry.status} ${mutedTry.code})`);
    await pin(written, owner);
    const mutedOff = await unpin(written, muted);
    assert(mutedOff.status === 200, `taking one off stays open to them (got ${mutedOff.status})`);
    clearPins();

    // ── 10. A standby ──────────────────────────────────────────────────────────────────────────
    console.log('\n── 10. A standby ──');
    const copied = await post(author);
    const copied2 = await post(author);
    const unchanged = await post(author);
    db.prepare(`UPDATE posts SET updated_at = '2001-01-01T00:00:00.000Z' WHERE id = ?`).run(unchanged);
    // The cursor a standby holds: everything before this it has, so what it reads next is the delta from here.
    const cursor = new Date(Date.now() - 1000).toISOString();
    await pin(copied, owner);
    await pin(copied2, owner);
    await unpin(copied2, owner);
    const held = { ...stamps(copied) };
    setNodeRole('backup');
    const onStandby = await pin(a, owner);
    const offStandby = await unpin(copied, owner);
    setNodeRole('primary');
    assert(onStandby.status === 409 && onStandby.code === 'standby' && stamps(a).pinned_until === null, `a standby takes no pin (got ${onStandby.status} ${onStandby.code})`);
    assert(offStandby.status === 409 && stamps(copied).pinned_until === held.pinned_until, `and takes none off (got ${offStandby.status})`);

    const payload = await exportSyncState(nodeId, cursor);
    const exported = (payload.posts ?? []).find((p: any) => p.id === copied) as any;
    assert(!(payload.posts ?? []).some((p: any) => p.id === unchanged), 'this is a delta: a post unchanged since the cursor is not in it');
    assert(exported?.pinnedUntil === held.pinned_until && exported?.pinnedAt === held.pinned_at, `a delta carries the stamps, from the bump a pin makes (got ${JSON.stringify([exported?.pinnedUntil, exported?.pinnedAt])})`);
    assert((payload.posts ?? []).some((p: any) => p.id === copied2 && p.pinnedUntil === undefined), 'and one taken off, with no stamp');
    db.prepare(`UPDATE posts SET pinned_until = NULL, pinned_at = NULL, updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).run(copied);
    const newer = new Date(Date.now() + 60_000).toISOString();
    db.prepare(`UPDATE posts SET pinned_until = ?, pinned_at = ?, updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).run(newer, newer, copied2);
    setNodeRole('backup');
    await importRemoteState(payload as any);
    assert(stamps(copied).pinned_until === held.pinned_until && stamps(copied).pinned_at === held.pinned_at && stamps(copied).updated_at === held.updated_at,
        'the ordinary delta brings a pin to a standby, the stamp the main server gave it');
    assert(stamps(copied2).pinned_until === null && stamps(copied2).pinned_at === null, 'and takes one off that the main server took off');
    // The take-over: the standby's rows are the community's from here.
    setNodeRole('primary');
    const after = await market();
    assert(after.ids[0] === copied, `a take-over keeps the pin on top (first is ${after.ids[0]})`);
    for (const id of [a, b]) await pin(id, owner);
    const pastThree = await pin(c, owner);
    assert(pastThree.status === 409 && pastThree.code === 'pins_full', `and it still counts towards the three (got ${pastThree.status})`);
    clearPins();

    // ── 11. Words ──────────────────────────────────────────────────────────────────────────────
    console.log('\n── 11. Words ──');
    await pin(a, owner);
    await pin(b, owner);
    await pin(c, owner);
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const lang of LANGS.filter(l => l !== 'en')) {
        const catalog = JSON.parse(fs.readFileSync(path.join(here, '..', 'words', `${lang}.json`), 'utf8'));
        const full = await pin(d, owner, { days: 3 }, { 'X-Language': lang });
        assert(full.status === 409 && full.code === 'pins_full' && !!catalog[PINS_FULL] && full.error === catalog[PINS_FULL],
            `${lang}: the refusal is in its words, the code unchanged (${full.error})`);
    }
    clearPins();

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
