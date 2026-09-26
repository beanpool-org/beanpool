/**
 * The listings, not the people (global node G9a, scratch/global-node/DESIGN-g9a-guest-view-fable.md §2, §3, §5, §8).
 *
 * On the global profile a guest (an unsigned request, a key that is not a member here) sees each
 * listing, its photos and its rough area, and nobody: no author key, name, face or standing, no trade, no voter, no
 * typed place, no exact spot. A member sees what they always saw. Over REAL HTTPS through the real signature
 * middleware, with the node's own public-read allowlist:
 *
 *   1. the allowlists are exported, and `features.guestListingsOnly` says which kind of node this is
 *   2. the sweep: for an unsigned caller and a signed key that is not a member, every entry of
 *      PUBLIC_READ_EXACT (the posts listing in each of its read shapes) and one materialised example of every
 *      PUBLIC_READ_PATTERNS entry (a pattern with no example fails, so a new public route must be listed here). No body
 *      holds a member's key or name, an /api/avatar/ URL, the event's typed place or a place finer than its area; no
 *      person field (author, taker, keeper, voter, owner, key, name) holds a real value
 *  2b. every public read that takes a point (found by asking each one with a bad point and a good one, and in the code
 *      by every module that reads a point from a query) is one this suite measures below; one that isn't fails here
 *   3. the guest shape: every listing there, every person neutral (`'hidden'`, `''`, null, 0), the counts kept,
 *      'pending' kept, the area for the place; direct, group and hidden posts out; one member's listings, a group's or
 *      a person's refused 403; the membership probe names only the signer; the Commons decisions, pool balance and
 *      Pulse feed for members only; `X-BeanPool-View: guest`
 *   4. a member's body is the engine's member read, byte for byte, with `X-BeanPool-View: member`
 *   5. ETag: a guest's token never gets a member a 304, a member's never gets a guest one, a key that joins or is
 *      pruned is never confirmed its old view
 *
 *   A pruned account is no guest: the signature middleware refuses every request it signs, a public read included
 *   (403 account_closed, #1177), so each section checks it gets exactly that, and nobody named.
 *   6. the socket: an unsigned socket, and one signed by a non-member, get `{ type }` doorbells only
 *   7. precision: 200 query points (the antimeridian and both poles among them), on both nearest-first paths (circles,
 *      and one pass with a radius or a filter): each guest lat/lng is roundToArea of the place, each distance the
 *      whole km from the area, the order the order of the areas' distances, a radius holds exactly the areas inside
 *      it, and no place appears. Counted: how often the place itself would have answered differently
 *  7b. the landing card (/api/global/home, G5), which counts the listings within 50 km of any point: from 200 points
 *      (the antimeridian and both poles among them) and on both sides of 40 listings' 50 km edges, a guest's count is
 *      of the listings whose AREA is within 50 km, a member's of those whose place is. And the deciding review's attack
 *      (4108073735), automated: bisecting where an unsigned count drops, on 8 rays, and fitting the point 50 km from
 *      every drop, converges on the lone listing's area centre, never the listing
 *  7c. the communities (/api/global/communities, and the card's): each distance and the order are from the place each
 *      community shows in the body (the public directory's), and from nothing else
 *   8. the other combinations, each in a child process (below); among them a local node (NODE_PROFILE unset): nothing
 *      changes; a guest's body is the engine's read for that reader, names, keys and places included, and no view
 *      header is sent; an enterprise names its keepers; faces are public by key, avatar URLs
 *      carry no `k=`, and the recovery lookup matches a prefix with photos; where an operator keeps the directory there,
 *      the landing card's count is from each listing's place, as the listing shows it; a non-member signer reads a trust
 *      profile and a code's holder gets a member's card, as before; a pruned account is refused every read it signs,
 *      as on every node (#1177 settles #1156's call); and a HEAD
 *      to a gated read is refused as its GET is, on this node too
 *   9. faces and names (G9a-2): /api/avatar/:pk without its key is 404 to anyone; the member-only key a member's
 *      members list carries opens it, unsigned as an <img> asks; a wrong key, another member's, or the key of a photo
 *      since changed is 404, as is a conditional request without one; a member's listings carry keyed URLs, a guest's
 *      none. The recovery lookup matches the typed name exactly (case forgiven) with no photo or join date
 *  10. the Beans constructs (an enterprise Alice leads and Bob keeps and backs, a crowdfund Bob runs, a Commons project
 *      Alice proposed): where they are switched on and so is the visitors' view, every read of them is for members
 *      only, trailing slash or not, and a member reads them naming their people; where they are off, 404 to everyone
 *  11. every route the node serves, every method (a route this suite doesn't list fails), as an unsigned caller, a key
 *      that is no member here and a pruned account, with a body for each write that names a member where the route
 *      takes one: no answer holds a member's key or name beyond what the request sent, a face URL, its member-only key
 *      or a member's photo, and a HEAD to every read answers as its GET. With the pruned account where pruning leaves
 *      it: convening a group Alice is in, in a DM with her, holding a code and a ticket. Also the review's walk (the
 *      exact recovery lookup's key opens no trust profile, Alice's or the member who brought her in), the size oracle
 *      (an unsigned HEAD /api/groups?member=), and a member re-entering, signing with their own key, still reading
 *      their own card from a redeem
 *
 * The rule is the switch's, whatever else is switched on, so a switch can't hide a leak from this suite: sections 1, 2,
 * 2b, 7b, 7c, 10 and 11 run again in a child process for each other combination that matters (§8's local run is one of them):
 *   - global with the Beans switched back on (beans, escrow, enterprises, treasuries, crowdfund), as an operator may
 *   - local with `guestListingsOnly` overridden on, and the directory (`directoryMirror`) so the landing card is there
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-guest-view.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
// Module consts read at import, so they are settled before the dynamic imports in main(). The node ships with read
// auth on and the member-only /ws feed; that is what a visitor meets.
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.ENFORCE_LEDGER_AUTH;
/** Which node this run is: the global node as it ships, or one of the child runs (the header's list). */
type Combo = 'global' | 'global+money' | 'local+guest' | 'local';
const COMBO: Combo = (process.env.GUEST_VIEW_COMBO as Combo | undefined) || 'global';
const LOCAL_RUN = COMBO === 'local';
if (COMBO === 'local' || COMBO === 'local+guest') delete process.env.NODE_PROFILE;
else process.env.NODE_PROFILE = 'global';
/** A visitor gets the listings and not the people here. */
const GUEST_VIEW = COMBO !== 'local';
/** Beans, and the enterprises, treasuries and crowdfunds that hold them, are on here. */
const MONEY_ON = COMBO !== 'global';
/** The operator's `node_config` overrides that make this combination, written before boot as an operator's would be. */
const OVERRIDES: Record<string, string> = COMBO === 'global+money'
    ? { beans: 'true', escrow: 'true', enterprises: 'true', treasuries: 'true', crowdfund: 'true' }
    : COMBO === 'local+guest' ? { guestListingsOnly: 'true', directoryMirror: 'true' } : {};

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const MODE = `[${COMBO}]`;
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${MODE} ${msg}`);
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let BASE = '';
/** Every request this run sent, by method: the sweep's size, printed at the end so a change to it shows. */
const requestsSent: Record<string, number> = {};

// ── what this run started, stopped on any exit ──────────────────────────────────────────────────
// The other combinations run in child processes (section 8), each with its own node and data directory. A run that
// fails, throws or is killed takes them with it: in CI, a parent blocked in spawnSync outlived test-all's timeout, and
// the rest of its run landed in the next suite's log (run 36193976409). So the children are spawned async and stopped on
// this process's exit, a signal ends the run through that exit, and a child stops when its parent is gone however it
// went (SIGKILL included): its IPC channel closes. Each node runs in its own process, so it stops with it.
const children = new Set<ChildProcess>();
const ownedDirs = new Set<string>();
process.on('exit', () => {
    for (const c of children) c.kill('SIGTERM');
    for (const d of ownedDirs) fs.rmSync(d, { recursive: true, force: true });
});
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(sig, () => {
        console.error(`${MODE} ${sig}: stopping this run and every process it started`);
        process.exit(128 + os.constants.signals[sig]);
    });
}
if (process.env.GUEST_VIEW_CHILD === '1') {
    // A child combination: the data directory was made for it, and it stops when its parent does.
    if (process.env.BEANPOOL_DATA_DIR) ownedDirs.add(process.env.BEANPOOL_DATA_DIR);
    process.on('disconnect', () => process.exit(1));
    process.channel?.unref();
}

// ── the reference rules: this suite's own copies ────────────────────────────────────────────────
const R_KM = 6371;
const rad = (d: number) => d * Math.PI / 180;
function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
    return R_KM * 2 * Math.atan2(Math.sqrt(Math.min(1, a)), Math.sqrt(Math.max(0, 1 - a)));
}
/** A place's area: 0.1° to the nearest step, halves up (design §5). */
const area = (deg: number) => Math.round(deg * 10) / 10 + 0;
type Place = { lat: number; lng: number };
const km = (a: Place, b: Place) => haversine(a.lat, a.lng, b.lat, b.lng);
const cellOf = (p: Place): Place => ({ lat: area(p.lat), lng: area(p.lng) });
/** The point `dist` km from `p` on a bearing (degrees from north), on this suite's sphere. */
function destination(p: Place, dist: number, bearing: number): Place {
    const d = dist / R_KM, b = rad(bearing), f1 = rad(p.lat), l1 = rad(p.lng);
    const f2 = Math.asin(Math.sin(f1) * Math.cos(d) + Math.cos(f1) * Math.sin(d) * Math.cos(b));
    const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(f1), Math.cos(d) - Math.sin(f1) * Math.sin(f2));
    return { lat: f2 * 180 / Math.PI, lng: ((l2 * 180 / Math.PI + 540) % 360) - 180 };
}
/** The point `dist` km from every one of `points`, least squares, by an ever finer grid: what an attacker would fit. */
function fitCentre(points: Place[], dist: number): Place {
    const cost = (c: Place) => points.reduce((s, p) => s + (km(c, p) - dist) ** 2, 0);
    let best: Place = { lat: points.reduce((s, p) => s + p.lat, 0) / points.length, lng: points.reduce((s, p) => s + p.lng, 0) / points.length };
    for (let step = 0.5; step > 1e-8; step /= 4) {
        let next = best;
        for (let i = -10; i <= 10; i++) {
            for (let j = -10; j <= 10; j++) {
                const c = { lat: best.lat + i * step, lng: best.lng + j * step };
                if (cost(c) < cost(next)) next = c;
            }
        }
        best = next;
    }
    return best;
}
const span = (xs: number[]) => xs.length ? `${Math.min(...xs).toFixed(3)} to ${Math.max(...xs).toFixed(3)} km` : 'none';

/** Seeded, so a failure reproduces. */
function prng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ── identities and requests ─────────────────────────────────────────────────────────────────────
interface Id { pk: string; priv: crypto.KeyObject }
function newId(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey };
}

interface Res { status: number; body: any; text: string; headers: Headers }
let beforeCall: () => void = () => {};
type Method = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
async function call(method: Method, id: Id | null, urlPath: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
    beforeCall();
    requestsSent[method] = (requestsSent[method] ?? 0) + 1;
    const bodiless = method === 'GET' || method === 'HEAD';
    const raw = bodiless ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = { ...extra };
    if (!bodiless) headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${urlPath.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${urlPath}`, { method, headers, body: bodiless ? undefined : raw });
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString('latin1');
    let parsed: any = text;
    try { parsed = JSON.parse(buf.toString('utf8')); } catch { /* not JSON (an image, a 304) */ }
    return { status: res.status, body: parsed, text: buf.toString('utf8'), headers: res.headers };
}

function signedWsQuery(id: Id): string {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`WS\n/ws\n${ts}\n${nonce}\n`), id.priv).toString('base64');
    return `pubkey=${id.pk}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`;
}
function openSocket(url: string): Promise<{ ws: WebSocket; raw: string[] }> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { rejectUnauthorized: false });
        const raw: string[] = [];
        ws.on('message', (d) => raw.push(d.toString()));
        ws.on('open', () => resolve({ ws, raw }));
        ws.on('error', reject);
        setTimeout(() => reject(new Error('socket did not open')), 3000);
    });
}

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';
const PLACE_NAME = 'Sentinel Hall, 42 Quartzite Crescent';
const OFFER_AT = { lat: -28.53417, lng: 153.49871 };
const EVENT_AT = { lat: -28.64213, lng: 153.61237 };
const TRADE_AT = { lat: -28.70061, lng: 153.40389 };
const PENDING_AT = { lat: -28.51977, lng: 153.55519 };
const KEEPER_AT = { lat: -28.61803, lng: 153.47777 };
const BOB_AT = { lat: -28.58821, lng: 153.52263 };
const ENTERPRISE_AT = { lat: -28.57731, lng: 153.44129 };
/** A listing alone in its part of the world, 5.07 km from its area's centre: the deciding review's target (4108073735). */
const LONE_AT = { lat: -31.123456, lng: 146.654321 };
/** The landing card's radius (routes/global-directory.ts NEARBY_POSTS_RADIUS_KM). */
const NEARBY_KM = 50;
/** Communities in the public directory (the mirror's cache), each at the place it publishes. */
const COMMUNITIES = [
    { key: 'dir-ridge', name: 'Ridge Commons', lat: -28.61, lng: 153.47, radiusKm: 20 },
    { key: 'dir-plains', name: 'Plains Exchange', lat: -31.4, lng: 146.2, radiusKm: 40 },
    { key: 'dir-fjord', name: 'Fjord Swap', lat: 69.65, lng: 18.96, radiusKm: 15 },
    { key: 'dir-dateline', name: 'Dateline Traders', lat: -17.72, lng: 179.95, radiusKm: 30 },
    { key: 'dir-far-side', name: 'Far Side Circle', lat: -17.69, lng: -179.93, radiusKm: 30 },
    { key: 'dir-unplaced', name: 'Somewhere Unplaced', lat: null, lng: null, radiusKm: null },
] as const;

/** The fields that name a person, and may hold only nothing, `''` or `'hidden'` for a guest. */
const PERSON_FIELDS = new Set(['authorPublicKey', 'acceptedBy', 'createdBy', 'voterPubkey', 'memberPubkey', 'ownerPubkey', 'publicKey', 'callsign',
    'authorCallsign', 'acceptedByCallsign', 'voterCallsign', 'memberCallsign', 'targetPubkey', 'assignedTo', 'authorPubkey',
    // The Beans constructs': a keeper's pledge, a crowdfund's creator, a project's proposer, who paused or wound one up
    // and who placed it.
    'keeper', 'creator_pubkey', 'proposerPubkey', 'proposerCallsign', 'pausedBy', 'windUpInitiatedBy', 'locationAuthSigner']);
/** A face URL with its member-only key (G9a-2): never in a guest's body, on any route. */
const KEYED_FACE = /[?&]k=[A-Za-z0-9_-]{22}/;

/** Every place in the body where a person field holds a real value, as `path=value`. `allow(path, value)` lets a route's own. */
function personValues(value: unknown, allow: (p: string, v: string) => boolean, at = '$'): string[] {
    if (Array.isArray(value)) return value.flatMap((v, i) => personValues(v, allow, `${at}[${i}]`));
    if (!value || typeof value !== 'object') return [];
    const out: string[] = [];
    for (const [k, v] of Object.entries(value)) {
        const p = `${at}.${k}`;
        if (PERSON_FIELDS.has(k) && typeof v === 'string' && v !== '' && v !== 'hidden' && !allow(p, v)) out.push(`${p}=${v.slice(0, 24)}`);
        out.push(...personValues(v, allow, p));
    }
    return out;
}

async function main(): Promise<void> {
    console.log(`\n=== The listings, not the people (G9a) ${MODE} ===\n`);
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { initStateEngine, createPost, createGroup, getPosts } = se;
    const https = await import('./https-server.js') as any;
    const { db, createCrowdfundProject, initSchema } = await import('./db/db.js');
    const { getProfileSwitches } = await import('./config/node-profile.js');
    const { writeDirectoryRows } = await import('./engine/directory-cache.js');
    // Before boot, where the faces' keys are decided (engine/avatar-keys.ts); the schema first, as boot would lay it.
    initSchema();
    for (const [k, v] of Object.entries(OVERRIDES)) db.prepare('INSERT OR REPLACE INTO node_config (key, value) VALUES (?, ?)').run(`nodeProfile.${k}`, v);
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { pruneAuthAttempts } = await import('./auth-rate-limit.js');
    beforeCall = () => { resetGatewayRateLimit(); pruneAuthAttempts(Date.now() + 120_000); };

    await initTls();
    initStateEngine();
    const port = await https.startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    // ── the community ──────────────────────────────────────────────────────────────────────────
    const member = (callsign: string, status = 'active'): Id => {
        const id = newId();
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, avatar_url)
                    VALUES (?, ?, ?, ?, 'seed', ?, ?)`)
            .run(id.pk, callsign, status, new Date(Date.now() - 60 * 86_400_000).toISOString(), `INV-${callsign.toUpperCase()}`, TINY_PNG);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
        return id;
    };
    const alice = member('SentinelAlice');
    const bob = member('SentinelBob');
    const pruned = member('SentinelPruned');
    const grid = member('SentinelGrid');
    const outsider = newId(); // signs, but no member here
    const joiner = newId(); // signs as a stranger, then joins mid-session (§5)

    const post = (author: Id, title: string, at?: { lat: number; lng: number }, options: any = {}, type: 'offer' | 'poll' | 'event' = 'offer', category = 'other') =>
        createPost(type, category, title, `${title}, described`, 0, 'fixed', author.pk, at?.lat, at?.lng, options.photos, false, undefined, false, options)!;

    const offer = post(alice, 'Sentinel ladder to lend', OFFER_AT, { photos: [TINY_PNG] });
    const event = post(alice, 'Sentinel working bee', EVENT_AT, {
        eventStartAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        eventPlaceName: PLACE_NAME, eventPrivateNote: 'Sentinel side gate code 4417',
    }, 'event', 'community');
    const poll = post(alice, 'Sentinel poll: where should the tool library go', undefined, {
        pollOptions: [{ id: 'opt_hall', text: 'The hall' }, { id: 'opt_shed', text: 'The shed' }],
    }, 'poll', 'community');
    const trade = post(alice, 'Sentinel bike repair, done', TRADE_AT);
    const pendingPost = post(alice, 'Sentinel pumpkin seedlings', PENDING_AT);
    const keeperPost = post(grid, 'Sentinel keeper post', KEEPER_AT);
    const bobOffer = post(bob, 'Sentinel sourdough starter', BOB_AT);
    const direct = post(alice, 'Sentinel direct offer for Bob', OFFER_AT, { audienceScope: 'direct', targetPubkey: bob.pk });
    const club = createGroup({ name: 'Sentinel club', createdBy: alice.pk });
    const groupPost = post(alice, 'Sentinel club offer', OFFER_AT, { audienceScope: 'group', targetGroupId: club.id });
    const hiddenPost = post(bob, 'Sentinel reported offer', BOB_AT);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO poll_votes (post_id, voter_pubkey, option_id, signature) VALUES (?, ?, 'opt_shed', 'test')`).run(poll.id, bob.pk);
    db.prepare(`INSERT INTO event_rsvps (post_id, member_pubkey, status, signature) VALUES (?, ?, 'going', 'test')`).run(event.id, bob.pk);
    db.prepare(`UPDATE posts SET status = 'completed', accepted_by = ?, accepted_at = ?, completed_at = ?, pending_transaction_id = 'ptx-sentinel-done', updated_at = ? WHERE id = ?`)
        .run(bob.pk, now, now, now, trade.id);
    db.prepare(`UPDATE posts SET status = 'pending', accepted_by = ?, accepted_at = ?, pending_transaction_id = 'ptx-sentinel-pending', updated_at = ? WHERE id = ?`)
        .run(bob.pk, now, now, pendingPost.id);
    // The keeper behind a post (an enterprise's, on a local node): `created_by` names them.
    db.prepare('UPDATE posts SET created_by = ? WHERE id = ?').run(alice.pk, keeperPost.id);
    db.prepare('UPDATE posts SET hidden_by_reports_at = ? WHERE id = ?').run(now, hiddenPost.id);
    // The Commons: a decision by Alice to suspend Bob; the Pulse: a channel and an item of Alice's.
    db.prepare(`INSERT INTO decisions (id, author_pubkey, title, description, touches, effect, subject, params, franchise, closes_at)
                VALUES ('dec-sentinel', ?, 'Sentinel: suspend a member', 'Sentinel reasons', 'member', 'suspend', ?, ?, '1m1v', ?)`)
        .run(alice.pk, bob.pk, JSON.stringify({ memberPubkey: bob.pk }), new Date(Date.now() + 5 * 86_400_000).toISOString());
    db.prepare(`INSERT INTO creator_channels (id, owner_pubkey, platform, url, handle, category) VALUES ('chan-sentinel', ?, 'youtube', 'https://youtube.example/@sentinelalice', 'sentinelalice', 'food')`)
        .run(alice.pk);
    db.prepare(`INSERT INTO pulse_items (id, channel_id, owner_pubkey, platform, url, title, published_at, category, source)
                VALUES ('item_sentinel', 'chan-sentinel', ?, 'youtube', 'https://youtube.example/watch?v=sentinel', 'Sentinel video', ?, 'food', 'manual')`)
        .run(alice.pk, now);
    // A message with an attachment between Alice and Bob: its public binary route serves ciphertext only.
    db.prepare(`INSERT INTO conversations (id, type, created_by) VALUES ('conv-sentinel', 'dm', ?)`).run(alice.pk);
    db.prepare(`INSERT INTO conversation_participants (conversation_id, public_key) VALUES ('conv-sentinel', ?), ('conv-sentinel', ?)`).run(alice.pk, bob.pk);
    db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type) VALUES ('msg-sentinel', 'conv-sentinel', ?, 'Y2lwaGVy', 'bm9uY2U=', 'image')`).run(alice.pk);
    db.prepare(`INSERT INTO message_attachments (message_id, data, nonce, mime) VALUES ('msg-sentinel', 'ZW5jcnlwdGVk', 'bm9uY2U=', 'image/jpeg')`).run();
    db.prepare("UPDATE members SET status = 'pruned' WHERE public_key = ?").run(pruned.pk);
    // Alice can be recovered with a sign-in, so the recovery lookup finds her.
    db.prepare(`INSERT INTO recovery_shares (owner_pubkey, holder_type, holder_ref, share_index, encrypted_share, share_iv, share_tag)
                VALUES (?, 'sso', 'google', 1, 'c2hhcmU=', 'aXY=', 'dGFn')`).run(alice.pk);
    // The Beans constructs (§10), seeded on every run, switched on or not: an enterprise Alice leads and Bob keeps, placed
    // to the metre, that Alice paused and Bob started winding up; a crowdfund Bob runs; a Commons project Alice proposed.
    const enterprise = se.createTreasury('Sentinel Tool Library', TINY_PNG, 0, {
        leadKeeperPubkey: alice.pk, purpose: 'Sentinel tools to borrow', lat: ENTERPRISE_AT.lat, lng: ENTERPRISE_AT.lng,
    }).publicKey;
    se.adminAssignTreasuryOperator(enterprise, bob.pk);
    db.prepare('UPDATE members SET paused_by = ?, wind_up_initiated_by = ? WHERE public_key = ?').run(alice.pk, bob.pk, enterprise);
    // Bob backs it. A pledge is ledger history, which keeps the money switches on (node-profile lockToLedger), so only
    // where they are on already: the global node as it ships stays as it ships.
    if (MONEY_ON) db.prepare("INSERT INTO enterprise_pledges (id, keeper, enterprise, amount) VALUES ('pledge-sentinel', ?, ?, 5)").run(bob.pk, enterprise);
    const crowdfund = newId().pk;
    createCrowdfundProject(crowdfund, bob.pk, 'Sentinel roof fund', 'Sentinel roof for the hall', [TINY_PNG], 100, null);
    const commonsProject = se.createProject(alice.pk, 'Sentinel community garden', 'Sentinel beds by the hall', 50)!;

    // Posts spread over the world for the precision checks (§7): the antimeridian and both poles among them, and a
    // few sharing one area. Each with a place worked out to 7 decimals.
    const rand = prng(20260926);
    const places: Array<{ lat: number; lng: number }> = [];
    const r7 = (x: number) => Math.round(x * 1e7) / 1e7;
    for (let i = 0; i < 40; i++) places.push({ lat: r7(Math.asin(2 * rand() - 1) * 180 / Math.PI), lng: r7(-180 + 360 * rand()) });
    for (let i = 0; i < 16; i++) places.push({ lat: r7(-60 + 120 * rand()), lng: r7((rand() < 0.5 ? 179.8 : -180) + 0.2 * rand()) });
    for (let i = 0; i < 8; i++) places.push({ lat: r7(89.75 + 0.25 * rand()), lng: r7(-180 + 360 * rand()) });
    for (let i = 0; i < 8; i++) places.push({ lat: r7(-90 + 0.25 * rand()), lng: r7(-180 + 360 * rand()) });
    for (let i = 0; i < 6; i++) places.push({ lat: r7(51.4712 + 0.02 * rand()), lng: r7(-0.1291 + 0.02 * rand()) });
    for (let i = 0; i < places.length; i++) post(grid, `Grid post ${i}`, places[i], {}, 'offer', 'grid');
    // Grid posts: one each; later ones updated later, so ties break the same way on both sides.
    const lone = post(grid, 'Sentinel lone offer', LONE_AT);
    writeDirectoryRows(COMMUNITIES.map(c => ({ key: c.key, name: c.name, url: `https://${c.key}.example`, lat: c.lat, lng: c.lng, radiusKm: c.radiusKm,
        memberCount: 5, contactEmail: null, contactPhone: null, registryUpdatedAt: now })), now);

    /** Every post's place, from the database itself. */
    const truth = new Map((db.prepare('SELECT id, lat, lng FROM posts').all() as Array<{ id: string; lat: number | null; lng: number | null }>)
        .map(r => [r.id, r]));
    const placed = [...truth.values()].filter(r => r.lat !== null && r.lng !== null) as Array<{ id: string; lat: number; lng: number }>;

    // People, not the node's own accounts (SYSTEM, and the BeanPool account the curated Pulse items belong to).
    const memberRows = db.prepare("SELECT public_key, callsign FROM members WHERE public_key != 'SYSTEM' AND COALESCE(is_treasury, 0) = 0").all() as Array<{ public_key: string; callsign: string }>;
    /** What must never reach a guest: every member's key and name, the typed place, the event's note, and every place finer than its area. */
    const sentinels: string[] = [
        ...memberRows.flatMap(m => [m.public_key, m.callsign]),
        PLACE_NAME, 'Quartzite', 'side gate code',
        ...[...placed, ENTERPRISE_AT].flatMap(p => [String(p.lat), String(p.lng), p.lat.toFixed(3), p.lng.toFixed(3)])
            .filter(s => !/^-?\d+\.\d?0*$/.test(s)),
    ];
    // Times are left out of the search for places: 03:58:26.135Z holds "26.135", and a time is nobody's place.
    const withoutTimes = (text: string) => text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, 'T');
    const leaks = (text: string, allowed: string[] = []) => {
        const t = withoutTimes(text);
        return sentinels.filter(s => !allowed.includes(s) && t.includes(s));
    };

    // ── 1. the allowlists, and what the node says it is ────────────────────────────────────────
    console.log('── 1. the public-read allowlists, and features.guestListingsOnly ──');
    const EXACT: ReadonlySet<string> | undefined = https.PUBLIC_READ_EXACT;
    const PATTERNS: readonly RegExp[] | undefined = https.PUBLIC_READ_PATTERNS;
    assert(EXACT instanceof Set && EXACT.size > 10 && Array.isArray(PATTERNS) && PATTERNS.length > 5,
        `https-server exports PUBLIC_READ_EXACT and PUBLIC_READ_PATTERNS for this sweep (got ${EXACT?.size ?? 'none'} / ${PATTERNS?.length ?? 'none'})`);
    const info = await call('GET', null, '/api/community/info');
    assert(info.status === 200 && info.body?.features?.guestListingsOnly === GUEST_VIEW,
        `/api/community/info reports features.guestListingsOnly ${GUEST_VIEW} (got ${JSON.stringify(info.body?.features?.guestListingsOnly)})`);
    // The combination is real, not pinned back by a lock: what this run means to test is what the node does.
    const money = { beans: info.body?.features?.beans, enterprises: info.body?.features?.enterprises, crowdfund: getProfileSwitches().crowdfund };
    assert(money.beans === MONEY_ON && money.enterprises === MONEY_ON && money.crowdfund === MONEY_ON,
        `Beans, enterprises and crowdfunds are ${MONEY_ON ? 'on' : 'off'} here (got ${JSON.stringify(money)})`);

    const POSTS = '/api/marketplace/posts';
    // Every type, and a page that holds every post seeded here.
    const ALL_TYPES = 'types=offer,need,poll,event&limit=200';
    const postReads = [
        POSTS,
        `${POSTS}?${ALL_TYPES}`,
        `${POSTS}?id=${event.id}`,
        `${POSTS}?id=${trade.id}`,
        `${POSTS}?${ALL_TYPES}&sync=true`,
        `${POSTS}?${ALL_TYPES}&updatedAfter=2000-01-01T00:00:00.000Z`,
        `${POSTS}?q=Sentinel`,
        `${POSTS}?${ALL_TYPES}&lat=-28.5&lng=153.5&radiusKm=60&sort=distance`,
        `${POSTS}?${ALL_TYPES}&lat=-28.55&lng=153.51&sort=distance`,
        `${POSTS}?${ALL_TYPES}&lat=-28.55&lng=153.51&sort=recent`,
        `${POSTS}?audienceScope=public&${ALL_TYPES}`,
    ];
    if (LOCAL_RUN) {
        await localChecks();
        return;
    }

    // ── 2. the sweep ───────────────────────────────────────────────────────────────────────────
    console.log('\n── 2. the sweep: every public read, as an unsigned caller and a non-member signer (a pruned account is refused them all) ──');
    /** One materialised request per pattern, with what that route may echo because the caller typed it. */
    const patternExamples: Array<{ path: string; echoes?: string[] }> = [
        { path: `/api/community/membership/${alice.pk}`, echoes: [alice.pk] },
        { path: '/api/members/callsign-available/SentinelAlice', echoes: ['SentinelAlice'] },
        { path: `/api/crowdfund/projects/${crowdfund}` },
        { path: `/api/treasury/${enterprise}` },
        { path: `/api/enterprise/${enterprise}` },
        { path: '/api/commons/decisions/dec-sentinel' },
        { path: '/api/recovery/lookup/sentinel' },
        // The exact name: the lookup names who was asked for, by the name typed and the key recovery may need.
        { path: '/api/recovery/lookup/SentinelAlice', echoes: ['SentinelAlice', alice.pk] },
        { path: `/api/marketplace/posts/${offer.id}/photos/0` },
        { path: '/api/messages/msg-sentinel/attachment' },
        { path: '/api/pulse/items/item_sentinel/thumbnail' },
        { path: `/api/avatar/${alice.pk}`, echoes: [alice.pk] },
    ];
    for (const re of PATTERNS ?? []) {
        assert(patternExamples.some(e => re.test(e.path.split('?')[0])),
            `PUBLIC_READ_PATTERNS ${re} has an example in this sweep (a new public pattern must be listed here)`);
    }
    /** The other reads that take a point (2b), each read with one as well. */
    const withPoint = new Set(['/api/global/home', '/api/global/communities']);
    const exactReads = [...(EXACT ?? [])].flatMap(p => p === POSTS ? postReads
        : withPoint.has(p) ? [p, `${p}?lat=-28.55&lng=153.51`, `${p}?lat=${LONE_AT.lat}&lng=${LONE_AT.lng}`]
            : [p === '/api/invite/check' ? `${p}?code=NOPE-NOPE` : p]);
    const guests: Array<[string, Id | null]> = [['unsigned', null], ['a non-member signer', outsider]];
    /**
     * A pruned account is no guest: the signature middleware refuses every request it signs, a public read included
     * (https-server.ts CLOSED_ACCOUNT_REFUSAL, #1177). Each read below answered it as a guest until then.
     */
    const closedAccount = (r: { status: number; body: any; text: string }) => r.status === 403 && r.body?.code === 'account_closed' && leaks(r.text).length === 0;
    const prunedRefused = async (label: string, paths: string[]) => {
        const wrong: string[] = [];
        for (const p of paths) {
            const r = await call('GET', pruned, p);
            if (!closedAccount(r) || r.text.includes('/api/avatar/')) wrong.push(`${p} → ${r.status} ${r.text.slice(0, 80)}`);
        }
        assert(wrong.length === 0, `a pruned account: ${label}, all ${paths.length} of them, refused 403 account_closed and naming nobody`
            + `${wrong.length ? ` — ${wrong.slice(0, 4).join(' | ')}` : ''}`);
    };
    const allowPerson = (route: string) => (p: string) =>
        // The peers are communities, not people; a callsign check echoes the name it was asked about; the health
        // tree's branch is a fixed placeholder (state-engine getCommunityHealth), never a member.
        (route === '/api/node/info' && /^\$\.peerNodes\[\d+\]\.callsign$/.test(p))
        || (route.startsWith('/api/members/callsign-available/') && p === '$.callsign')
        || (route === '/api/community/health' && p === '$.tree.widestBranch.callsign')
        || (route === '/api/recovery/lookup/SentinelAlice' && /^\$\[0\]\.(publicKey|callsign)$/.test(p));
    for (const [who, id] of guests) {
        const failures: string[] = [];
        const persons: string[] = [];
        let n = 0;
        for (const { path: p, echoes } of [...exactReads.map(path => ({ path, echoes: [] as string[] })), ...patternExamples]) {
            const r = await call('GET', id, p);
            n++;
            const found = leaks(r.text, echoes);
            if (found.length) failures.push(`${p} → ${r.status}: ${found.slice(0, 3).join(', ')}`);
            if (r.text.includes('/api/avatar/')) failures.push(`${p} → ${r.status}: an /api/avatar/ URL`);
            if (KEYED_FACE.test(r.text)) failures.push(`${p} → ${r.status}: a face's member-only key`);
            if (typeof r.body === 'object' && r.body) persons.push(...personValues(r.body, allowPerson(p.split('?')[0])).map(v => `${p}: ${v}`));
        }
        assert(failures.length === 0, `${who}: none of ${n} public reads holds a member's key or name, a face URL, the typed place or a place finer than its area${failures.length ? ` — ${failures.slice(0, 6).join(' | ')}` : ''}`);
        assert(persons.length === 0, `${who}: no person field holds a real value in any of them${persons.length ? ` — ${persons.slice(0, 6).join(' | ')}` : ''}`);
    }
    // Not the device-pairing poll: the middleware never sees /api/pair/ (isSignatureBypassed), a relay that knows no member.
    await prunedRefused('every public read it signs', [...exactReads, ...patternExamples.map(e => e.path)].filter(p => !p.startsWith('/api/pair/')));

    // ── 2b. every read that takes a point is measured ──────────────────────────────────────────
    console.log('\n── 2b. every read a visitor can send a point to is one this suite measures ──');
    /**
     * Every read a guest can send a point (`lat`, `lng`) to, and how this suite measures what it works out from one: a
     * count, a distance, an order or a radius can only ever place a listing at its area's centre. A read that takes a
     * point and isn't here fails below, so the next one can't slip past a body-only sweep.
     */
    const POINT_READS: Record<string, string> = {
        [POSTS]: "section 7: each place, distance, order, radius and page is its area's",
        '/api/global/home': "section 7b: the nearby count is of the listings whose area is within 50 km, and the bisection finds the area",
        '/api/global/communities': "section 7c: each distance and the order are from the place each community shows (the public directory's)",
    };
    /** The People lists take a point from a member only (routes/community.ts peoplePoint): gated, refused to every guest. */
    const PEOPLE_POINT_READS = ['/api/community/members', '/api/members'];
    const publicReads = [...new Set([...(EXACT ?? []), ...patternExamples.map(e => e.path)])];
    const takesPoint = new Set<string>();
    for (const p of publicReads) {
        const url = p === '/api/invite/check' ? `${p}?code=NOPE-NOPE` : p;
        const plus = (q: string) => `${url}${url.includes('?') ? '&' : '?'}${q}`;
        for (const id of [null, outsider]) {
            // A point that isn't one is a 400 that names it (routes/distance-query.ts) where a read parses points...
            const bad = await call('GET', id, plus('lat=nope&lng=nope'));
            const a = await call('GET', id, url);
            // ...and a read that reads one some other way answers differently with one than, twice, without.
            const b = await call('GET', id, plus('lat=-28.55&lng=153.51'));
            const c = await call('GET', id, url);
            const namesPoint = bad.status === 400 && (a.status !== 400 || /\b(lat|lng)\b/.test(String(bad.body?.error ?? '')));
            const movedByPoint = a.status === c.status && a.text === c.text && (b.status !== a.status || b.text !== a.text);
            if (namesPoint || movedByPoint) takesPoint.add(p);
        }
    }
    const unmeasured = [...takesPoint].filter(p => !(p in POINT_READS));
    assert(unmeasured.length === 0, `every public read that takes a point is one this suite measures (found ${[...takesPoint].join(', ') || 'none'})`
        + `${unmeasured.length ? ` — not measured: ${unmeasured.join(', ')}` : ''}`);
    assert(Object.keys(POINT_READS).every(p => takesPoint.has(p)),
        `and the probe finds each of them, so it would find a new one (${Object.keys(POINT_READS).filter(p => !takesPoint.has(p)).join(', ') || 'all found'})`);
    {
        // In the code, too: every module that reads a point from a query, and how many times, is one whose reads are
        // listed above. The parser itself is routes/distance-query.ts.
        const src = path.dirname(fileURLToPath(import.meta.url));
        const found: Record<string, number> = {};
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const f = path.join(dir, e.name);
                if (e.isDirectory()) { if (e.name !== 'node_modules') walk(f); continue; }
                if (!/\.ts$/.test(e.name) || /^test-|\.test\.ts$/.test(e.name) || f.endsWith(path.join('routes', 'distance-query.ts'))) continue;
                const n = (fs.readFileSync(f, 'utf8').match(/\bparse(Point|DistanceQuery)\(|\bquery(\.|\[['"])(lat|lng|lon|latitude|longitude|near)\b/g) ?? []).length;
                if (n) found[path.relative(src, f)] = n;
            }
        };
        walk(src);
        const KNOWN: Record<string, number> = {
            [path.join('routes', 'marketplace.ts')]: 1, // the listing (POSTS)
            [path.join('routes', 'global-directory.ts')]: 2, // the communities and the landing card
            [path.join('routes', 'community.ts')]: 1, // peoplePoint: the People lists, members only
        };
        assert(JSON.stringify(Object.entries(found).sort()) === JSON.stringify(Object.entries(KNOWN).sort()),
            `the code reads a point from a query in the modules this suite knows, and no others (${JSON.stringify(found)}); a new one needs its reads in POINT_READS and measured`);
    }
    for (const [who, id] of guests) {
        const refused: string[] = [];
        for (const p of PEOPLE_POINT_READS) {
            const r = await call('GET', id, `${p}?lat=-28.55&lng=153.51`);
            if (r.status !== (id ? 403 : 401) || leaks(r.text).length) refused.push(`${p} → ${r.status}`);
        }
        assert(refused.length === 0, `${who}: the People lists refuse a guest's point (${refused.join(', ') || `${PEOPLE_POINT_READS.length} refused`})`);
    }
    await prunedRefused("the People lists, with a point", PEOPLE_POINT_READS.map(p => `${p}?lat=-28.55&lng=153.51`));

    // ── 10. the Beans constructs ───────────────────────────────────────────────────────────────
    console.log(`\n── 10. the enterprise, treasury, crowdfund and Commons project reads (${MONEY_ON ? 'switched on' : 'switched off'}) ──`);
    const MONEY_READS = ['/api/enterprises', '/api/treasuries', '/api/enterprises/map', '/api/map/enterprises', '/api/treasuries/map',
        `/api/enterprise/${enterprise}`, `/api/treasury/${enterprise}`, '/api/crowdfund/projects', `/api/crowdfund/projects/${crowdfund}`, '/api/commons/projects'];
    for (const [who, id] of guests) {
        const wrong: string[] = [];
        for (const p of MONEY_READS.flatMap(p => [p, `${p}/`])) {
            const r = await call('GET', id, p);
            // Switched off, the feature gate's 404; but a trailing slash is not on the allowlist, so the read gate,
            // which comes first, refuses it as it refuses any gated read.
            const want = MONEY_ON || p.endsWith('/') ? (id ? 403 : 401) : 404;
            if (r.status !== want || KEYED_FACE.test(r.text) || leaks(r.text).length) wrong.push(`${p} → ${r.status} ${r.text.slice(0, 80)}`);
        }
        assert(wrong.length === 0, `${who}: every one of them, trailing slash or not, is ${MONEY_ON ? 'for members only' : 'refused, switched off'} `
            + `and names nobody (${MONEY_READS.length * 2} reads)${wrong.length ? ` — ${wrong.slice(0, 4).join(' | ')}` : ''}`);
    }
    await prunedRefused('the enterprise, treasury, crowdfund and Commons project reads, trailing slash or not', MONEY_READS.flatMap(p => [p, `${p}/`]));
    {
        const r = Object.fromEntries(await Promise.all(MONEY_READS.map(async p => [p, await call('GET', bob, p)] as const)));
        const statuses = MONEY_READS.map(p => r[p].status);
        assert(statuses.every(st => st === (MONEY_ON ? 200 : 404)), `a member reads them: ${MONEY_ON ? '200' : '404, switched off'} (got ${statuses.join(' ')})`);
        if (MONEY_ON) {
            // What a guest would have been sent: the people behind each one, by key, name and a face that opens.
            const detail = r[`/api/enterprise/${enterprise}`].body;
            const keepers = new Map((detail?.keepers ?? []).map((k: any) => [k.publicKey, k]));
            const face = (keepers.get(alice.pk) as any)?.avatarUrl as string | undefined;
            assert((keepers.get(alice.pk) as any)?.callsign === 'SentinelAlice' && keepers.has(bob.pk) && detail?.pledges?.[0]?.keeper === bob.pk
                && detail?.pausedBy === alice.pk && detail?.windUpInitiatedBy === bob.pk && detail?.lat === ENTERPRISE_AT.lat,
                "the enterprise names its keepers, Bob's pledge, who paused it and who is winding it up, at its exact place");
            assert(!!face && KEYED_FACE.test(face) && (await call('GET', null, face)).status === 200, `with a keeper's face that opens (${face})`);
            const listed = (r['/api/enterprises'].body?.treasuries ?? []).find((e: any) => e.publicKey === enterprise);
            assert(listed?.keepers?.some((k: any) => k.publicKey === alice.pk), 'the enterprises list names its keepers too');
            const cf = (r['/api/crowdfund/projects'].body?.projects ?? []).find((p: any) => p.id === crowdfund);
            assert(cf?.creator_pubkey === bob.pk && r[`/api/crowdfund/projects/${crowdfund}`].body?.project?.creator_pubkey === bob.pk,
                'the crowdfund names Bob, who runs it');
            const proj = (r['/api/commons/projects'].body?.projects ?? []).find((p: any) => p.id === commonsProject.id);
            assert(proj?.proposerPubkey === alice.pk && proj?.proposerCallsign === 'SentinelAlice', 'the Commons project names Alice, who proposed it');
            const pin = (r['/api/enterprises/map'].body?.enterprises ?? []).find((e: any) => e.publicKey === enterprise);
            assert(pin?.lat === ENTERPRISE_AT.lat && KEYED_FACE.test(pin?.avatar ?? ''), "the map pin holds the enterprise's exact place and its keyed face");
        }
    }

    // ── 7b and 7c: the landing card and the communities, from any point ─────────────────────────
    await pointChecks();
    if (COMBO !== 'global') {
        await everyRoute();
        return;
    }

    // ── 3. the guest shape ─────────────────────────────────────────────────────────────────────
    console.log('\n── 3. what a guest gets ──');
    for (const [who, id] of guests) {
        const r = await call('GET', id, `${POSTS}?${ALL_TYPES}`);
        const byId = new Map((Array.isArray(r.body) ? r.body : []).map((p: any) => [p.id, p]));
        assert(r.status === 200 && r.headers.get('x-beanpool-view') === 'guest', `${who}: 200 with X-BeanPool-View: guest (got ${r.status} ${r.headers.get('x-beanpool-view')})`);
        const listed = [offer, event, poll, pendingPost, keeperPost, bobOffer].every(p => byId.has(p.id));
        assert(listed, `${who}: every public listing is there — the offer, the event, the poll, the pending one, the keeper's, Bob's`);
        assert(![direct, groupPost, hiddenPost].some(p => byId.has(p.id)), `${who}: the direct post, the group post and the hidden one are not`);
        const shaped = [...byId.values()].every((p: any) => p.authorPublicKey === 'hidden' && p.authorCallsign === '' && p.authorAvatarUrl === null
            && p.authorEnergyCycled === 0 && p.authorFoundingNeeded === false && p.acceptedByCallsign === '');
        assert(shaped, `${who}: every listing names nobody — author 'hidden', names '', face null, standing 0/false`);
        const absent = ['acceptedBy', 'acceptedAt', 'pendingTransactionId', 'completedAt', 'createdBy', 'pollVotes', 'userVotedOptionId', 'myRsvp',
            'eventRsvps', 'eventPrivateNote', 'eventPlaceName', 'reachPeers', 'targetPubkey', 'assignedTo', 'targetGroupId', 'targetGroupName', 'hiddenByReportsAt'];
        const present = [...byId.values()].flatMap((p: any) => absent.filter(f => f in p).map(f => `${p.title}: ${f}`));
        assert(present.length === 0, `${who}: no trade, keeper, voter, RSVP, typed place, note or scope field (${present.slice(0, 4).join('; ') || 'none'})`);
        const pollOut: any = byId.get(poll.id);
        assert(pollOut?.totalVotes === 1 && pollOut.pollOptions?.find((o: any) => o.id === 'opt_shed')?.votes === 1, `${who}: the poll keeps its counts`);
        const eventOut: any = byId.get(event.id);
        assert(eventOut?.goingCount === 1 && eventOut.eventStartAt && eventOut.eventState === 'scheduled', `${who}: the event keeps its time, state and going count`);
        assert((byId.get(pendingPost.id) as any)?.status === 'pending', `${who}: a pending listing stays 'pending' (spoken for, by nobody named)`);
        const offerOut: any = byId.get(offer.id);
        assert(offerOut?.lat === area(OFFER_AT.lat) && offerOut?.lng === area(OFFER_AT.lng) && offerOut?.photos?.length === 1,
            `${who}: the offer is at its area (${offerOut?.lat}, ${offerOut?.lng}) with its photo`);
        const sync = await call('GET', id, `${POSTS}?${ALL_TYPES}&sync=true`);
        const syncById = new Map((Array.isArray(sync.body) ? sync.body : []).map((p: any) => [p.id, p]));
        const tradeOut: any = syncById.get(trade.id);
        assert(tradeOut?.status === 'completed' && !('acceptedBy' in tradeOut) && tradeOut.authorPublicKey === 'hidden',
            `${who}: a sync read carries the completed trade as a completed listing, nobody named`);
        const hiddenOut: any = syncById.get(hiddenPost.id);
        assert(!hiddenOut || (hiddenOut.status === 'cancelled' && hiddenOut.title === '' && hiddenOut.authorPublicKey === 'hidden'),
            `${who}: a hidden post reaches a sync read as a removal naming nobody, if at all`);
        for (const q of [`author=${alice.pk}`, 'audienceScope=group', 'audienceScope=direct', `targetGroupId=${club.id}`, `assignedTo=${bob.pk}`]) {
            const refused = await call('GET', id, `${POSTS}?${q}`);
            assert(refused.status === 403 && refused.body?.code === 'members_only', `${who}: ?${q.split('=')[0]}=… is refused 403 members_only (got ${refused.status})`);
        }
        const probe = await call('GET', id, `/api/community/membership/${alice.pk}`);
        assert(probe.status === 200 && probe.body?.isMember === true && probe.body?.callsign === null,
            `${who}: the membership probe says Alice's key is a member and names nobody (got ${JSON.stringify(probe.body)})`);
        for (const p of ['/api/commons/decisions', '/api/commons/decisions/dec-sentinel', '/api/commons/balance', '/api/pulse/feed']) {
            const gated = await call('GET', id, p);
            assert(gated.status === (id ? 403 : 401), `${who}: ${p} is for members only (got ${gated.status})`);
            // The router answers a path with one trailing slash as the path itself, so the gate must hold there too.
            const slashed = await call('GET', id, `${p}/`);
            assert(slashed.status === (id ? 403 : 401), `${who}: ${p}/ is for members only too (got ${slashed.status})`);
        }
    }
    await prunedRefused('the listings in every shape, the membership probe and the members-only reads', [
        `${POSTS}?${ALL_TYPES}`, `${POSTS}?${ALL_TYPES}&sync=true`, `${POSTS}?author=${alice.pk}`, `/api/community/membership/${alice.pk}`,
        `/api/community/membership/${pruned.pk}`, '/api/commons/decisions', '/api/commons/balance', '/api/pulse/feed',
    ]);
    {
        const own = await call('GET', alice, `/api/community/membership/${alice.pk}`);
        assert(own.body?.callsign === 'SentinelAlice', `the membership probe, signed by that very key, names its holder (got ${JSON.stringify(own.body)})`);
        const other = await call('GET', bob, `/api/community/membership/${alice.pk}`);
        assert(other.body?.callsign === null, 'signed by another member, it names nobody either');
        for (const p of ['/api/commons/decisions', '/api/commons/decisions/dec-sentinel', '/api/commons/balance', '/api/pulse/feed']) {
            const r = await call('GET', bob, p);
            assert(r.status === 200, `a member reads ${p} (got ${r.status})`);
            const slashed = await call('GET', bob, `${p}/`);
            assert(slashed.status === 200, `a member reads ${p}/ as the same route, so a guest's refusal there is the gate's (got ${slashed.status})`);
        }
        const feed = await call('GET', bob, '/api/pulse/feed');
        assert(feed.text.includes(alice.pk) && feed.text.includes('SentinelAlice'), 'the Pulse feed a member reads names its creators, as it always did');
    }

    // ── 4. a member's view is the member's ─────────────────────────────────────────────────────
    console.log('\n── 4. a member sees what they always saw ──');
    for (const q of [`${ALL_TYPES}`, `${ALL_TYPES}&sync=true`, `${ALL_TYPES}&lat=-28.55&lng=153.51&sort=distance`]) {
        const r = await call('GET', bob, `${POSTS}?${q}`);
        const params = new URLSearchParams(q);
        const want = getPosts({
            types: ['offer', 'need', 'poll', 'event'], excludeEvents: false, limit: 200, offset: 0, viewerPubkey: bob.pk, includeVoters: true,
            sync: params.get('sync') === 'true', beansOnly: false, includeHidden: false,
            near: params.has('lat') ? { lat: Number(params.get('lat')), lng: Number(params.get('lng')) } : undefined,
            sortByDistance: params.get('sort') === 'distance',
        } as any);
        assert(r.status === 200 && r.headers.get('x-beanpool-view') === 'member' && r.text === JSON.stringify(want),
            `Bob, a member, ?${q}: X-BeanPool-View: member and exactly the engine's member read (${r.text.length} bytes)`);
    }
    {
        const r = await call('GET', bob, `${POSTS}?${ALL_TYPES}`);
        const byId = new Map((r.body as any[]).map(p => [p.id, p]));
        assert(byId.get(offer.id)?.authorPublicKey === alice.pk && byId.get(offer.id)?.lat === OFFER_AT.lat && byId.get(direct.id)
            && byId.get(poll.id)?.pollVotes?.[0]?.voterPubkey === bob.pk,
            "the member's read has the author, the exact place, the post for them and the voters");
    }

    // ── 5. ETag: one view's token never confirms the other ─────────────────────────────────────
    console.log('\n── 5. ETag ──');
    {
        const url = `${POSTS}?${ALL_TYPES}`;
        const g = await call('GET', null, url);
        const m = await call('GET', bob, url);
        assert(!!g.headers.get('etag') && !!m.headers.get('etag') && g.headers.get('etag') !== m.headers.get('etag'), 'a guest and a member get different ETags');
        const mWithG = await call('GET', bob, url, undefined, { 'If-None-Match': g.headers.get('etag')! });
        assert(mWithG.status === 200 && mWithG.text.includes(alice.pk), `a member sending a guest's ETag gets 200 and the member's body (got ${mWithG.status})`);
        const gWithM = await call('GET', null, url, undefined, { 'If-None-Match': m.headers.get('etag')! });
        assert(gWithM.status === 200 && !gWithM.text.includes(alice.pk), `a guest sending a member's ETag gets 200 and the guest's body (got ${gWithM.status})`);
        const gAgain = await call('GET', null, url, undefined, { 'If-None-Match': g.headers.get('etag')! });
        const mAgain = await call('GET', bob, url, undefined, { 'If-None-Match': m.headers.get('etag')! });
        assert(gAgain.status === 304 && mAgain.status === 304, `each view's own token is still a 304 (${gAgain.status}, ${mAgain.status})`);
        const before = await call('GET', joiner, url);
        assert(before.headers.get('x-beanpool-view') === 'guest', 'a key that is not a member yet gets the guest view');
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code) VALUES (?, 'SentinelJoiner', 'active', ?, 'seed', 'INV-J')`)
            .run(joiner.pk, now);
        const after = await call('GET', joiner, url, undefined, { 'If-None-Match': before.headers.get('etag')! });
        assert(after.status === 200 && after.headers.get('x-beanpool-view') === 'member' && after.text.includes(alice.pk),
            `the same key, once a member, sending its guest ETag gets 200 and the member's view (got ${after.status})`);
        const asMember = await call('GET', joiner, url);
        db.prepare("UPDATE members SET status = 'pruned' WHERE public_key = ?").run(joiner.pk);
        const prunedNow = await call('GET', joiner, url, undefined, { 'If-None-Match': asMember.headers.get('etag')! });
        // Refused outright since #1177 (it was a 200 with the guest view): never a 304, and nothing of the member's view.
        assert(prunedNow.status === 403 && prunedNow.body?.code === 'account_closed' && !prunedNow.text.includes(alice.pk),
            `pruned, the same key sending its member ETag is refused 403 account_closed, never confirmed its old view (got ${prunedNow.status})`);
    }

    // ── 6. the socket ──────────────────────────────────────────────────────────────────────────
    console.log('\n── 6. the /ws doorbell ──');
    {
        const wsBase = `${BASE.replace('https', 'wss')}/ws`;
        const sockets = { unsigned: await openSocket(wsBase), outsider: await openSocket(`${wsBase}?${signedWsQuery(outsider)}`), member: await openSocket(`${wsBase}?${signedWsQuery(bob)}`) };
        await sleep(200);
        const made = await call('POST', alice, POSTS, { type: 'offer', category: 'other', title: 'Sentinel live offer', description: 'Sentinel live', authorPublicKey: alice.pk, lat: 12.34567, lng: 45.67891 });
        assert(made.status === 200 && made.body?.success, `Alice posts over HTTP (got ${made.status} ${made.text.slice(0, 100)})`);
        await sleep(400);
        for (const [who, s] of [['an unsigned', sockets.unsigned], ['a non-member-signed', sockets.outsider]] as const) {
            // The greeting every socket gets on connect is the node's counts (/api/community/info's); after it, doorbells.
            const events = s.raw.map(m => { try { return JSON.parse(m); } catch { return { type: '?' }; } }).filter(e => e.type !== 'state_snapshot');
            const shapes = events.map(e => Object.keys(e).join(','));
            assert(events.length > 0 && shapes.every(k => k === 'type'), `${who} socket gets doorbells only: { type } (${events.length} after the greeting: ${[...new Set(shapes)].join(' / ')})`);
            assert(!s.raw.some(m => m.includes(alice.pk) || m.includes('Sentinel')), `${who} socket is sent nothing of the post or its author`);
        }
        assert(sockets.member.raw.some(m => m.includes('Sentinel live offer')), "a member's socket gets the post, as always");
        for (const s of Object.values(sockets)) s.ws.close();
        db.prepare('DELETE FROM posts WHERE id = ?').run(made.body?.post?.id ?? '');
        se.bumpPostsVersion();
    }

    // ── 7. precision ───────────────────────────────────────────────────────────────────────────
    console.log('\n── 7. precision: 200 query points, both nearest-first paths ──');
    // Which read a request made: circles (a box joined to the listing) or one pass. The server runs in this process.
    const reads = { circles: 0, passes: 0 };
    const prepare = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => {
        const st = prepare(sql);
        const kind = /CROSS JOIN posts p/.test(sql) ? 'circles' : /haversine_km|area_km/.test(sql) && !/WHERE p\.id IN/.test(sql) ? 'passes' : undefined;
        if (kind) {
            const all = st.all.bind(st);
            (st as any).all = (...params: unknown[]) => { reads[kind]++; return all(...params); };
        }
        return st;
    };
    const cellKm = (q: { lat: number; lng: number }, p: { lat: number; lng: number }) => haversine(q.lat, q.lng, area(p.lat), area(p.lng));
    const trueKm = (q: { lat: number; lng: number }, p: { lat: number; lng: number }) => haversine(q.lat, q.lng, p.lat, p.lng);
    const queries: Array<{ lat: number; lng: number }> = [];
    for (let i = 0; i < 20; i++) queries.push({ lat: -70 + 140 * rand(), lng: rand() < 0.5 ? 179.9 + 0.1 * rand() : -180 + 0.1 * rand() });
    for (let i = 0; i < 10; i++) queries.push({ lat: 89.9 + 0.1 * rand(), lng: -180 + 360 * rand() });
    for (let i = 0; i < 10; i++) queries.push({ lat: -90 + 0.1 * rand(), lng: -180 + 360 * rand() });
    queries.push({ lat: 90, lng: 0 }, { lat: -90, lng: 0 }, { lat: 0, lng: 180 }, { lat: 0, lng: -180 }, { lat: 51.48, lng: -0.12 });
    // Close to a post, where the small circles answer and an area just across a box's edge would be lost.
    for (let i = 0; i < 60; i++) {
        const p = placed[Math.floor(rand() * placed.length)];
        queries.push({ lat: Math.max(-90, Math.min(90, p.lat + 0.2 * (rand() - 0.5))), lng: Math.max(-180, Math.min(180, p.lng + 0.2 * (rand() - 0.5))) });
    }
    while (queries.length < 200) queries.push({ lat: Math.asin(2 * rand() - 1) * 180 / Math.PI, lng: -180 + 360 * rand() });

    const problems: string[] = [];
    let byCirclesAlone = 0;
    const teeth = { order: 0, radius: 0, distance: 0 };
    const placeText = (text: string) => { const t = withoutTimes(text); return placed.find(p => t.includes(String(p.lat)) || t.includes(String(p.lng))); };
    /** Checks one guest page: each place is its area, each distance the whole km from it, in the areas' order. */
    const checkPage = (label: string, q: { lat: number; lng: number }, r: Res): any[] => {
        const page: any[] = Array.isArray(r.body) ? r.body : [];
        if (r.status !== 200) { problems.push(`${label}: ${r.status}`); return []; }
        const leak = placeText(r.text);
        if (leak) problems.push(`${label}: the place of ${leak.id} appears`);
        let prev = -1;
        let prevTrue = -1;
        for (const p of page) {
            const t = truth.get(p.id);
            if (!t || t.lat === null || t.lng === null) { if (p.distanceKm !== null) problems.push(`${label}: ${p.id} has no place but distanceKm ${p.distanceKm}`); continue; }
            const tp = { lat: t.lat, lng: t.lng };
            if (p.lat !== area(tp.lat) || p.lng !== area(tp.lng)) problems.push(`${label}: ${p.id} at ${p.lat},${p.lng}, its area is ${area(tp.lat)},${area(tp.lng)}`);
            const d = cellKm(q, tp);
            if (!Number.isInteger(p.distanceKm) || Math.abs(p.distanceKm - d) > 0.5 + 1e-6) problems.push(`${label}: ${p.id} distanceKm ${p.distanceKm}, from its area ${d.toFixed(3)}`);
            if (Math.abs(d - Math.round(d)) < 0.5 - 1e-6 && p.distanceKm !== Math.round(trueKm(q, tp))) teeth.distance++;
            if (d < prev - 1e-9) problems.push(`${label}: ${p.id} (${d.toFixed(4)} km from its area) after one ${prev.toFixed(4)} km`);
            if (trueKm(q, tp) < prevTrue - 1e-9) teeth.order++;
            prev = d;
            prevTrue = trueKm(q, tp);
        }
        return page;
    };
    const gridPlaced = placed.filter(p => (db.prepare('SELECT category FROM posts WHERE id = ?').get(p.id) as any).category === 'grid');
    for (let i = 0; i < queries.length; i++) {
        const q = queries[i];
        const at = `lat=${q.lat}&lng=${q.lng}`;
        const who = i % 2 ? outsider : null;
        // Circles: nearest first, a page, no radius, no filter.
        const c0 = reads.circles, p0 = reads.passes;
        const circlePage = checkPage(`#${i} circles`, q, await call('GET', who, `${POSTS}?${at}&sort=distance&limit=5`));
        // Circles first; where none out to 3,000 km holds the page, one pass gives it (posts.ts postRowsNear).
        if (reads.circles === c0) problems.push(`#${i}: the page without a filter did not search circles`);
        if (reads.passes === p0) byCirclesAlone++;
        // Nothing nearer by area was passed over.
        const onPage = new Set(circlePage.map(p => p.id));
        const worst = Math.max(...circlePage.filter(p => truth.get(p.id)?.lat != null).map(p => cellKm(q, truth.get(p.id) as any)));
        const skipped = placed.filter(p => !onPage.has(p.id) && cellKm(q, p) < worst - 1e-9 && truth.has(p.id)
            && !(db.prepare("SELECT 1 FROM posts WHERE id = ? AND (status NOT IN ('active','pending') OR audience_scope != 'public' OR hidden_by_reports_at IS NOT NULL OR type = 'event')").get(p.id)));
        if (skipped.length) problems.push(`#${i} circles: ${skipped.length} nearer by area left off the page`);
        // One pass, with a radius: exactly the areas inside it.
        const target = gridPlaced[Math.floor(rand() * gridPlaced.length)];
        const radius = Math.max(0.001, cellKm(q, target) + (rand() < 0.5 ? 0.001 : -0.001));
        const c1 = reads.circles, p1 = reads.passes;
        const radiusPage = checkPage(`#${i} radius`, q, await call('GET', who, `${POSTS}?${at}&category=grid&radiusKm=${radius}&sort=distance&limit=200`));
        if (reads.passes === p1 || reads.circles !== c1) problems.push(`#${i}: the radius read was not one pass`);
        const got = new Set(radiusPage.map(p => p.id));
        const want = gridPlaced.filter(p => cellKm(q, p) <= radius && Math.abs(cellKm(q, p) - radius) > 1e-6);
        const unsure = new Set(gridPlaced.filter(p => Math.abs(cellKm(q, p) - radius) <= 1e-6).map(p => p.id));
        const missing = want.filter(p => !got.has(p.id));
        const extra = [...got].filter(id => !unsure.has(id) && !want.some(p => p.id === id));
        if (missing.length || extra.length) problems.push(`#${i} radius ${radius.toFixed(3)}: ${missing.length} inside by area missing, ${extra.length} outside by area returned`);
        if (gridPlaced.some(p => (trueKm(q, p) <= radius) !== (cellKm(q, p) <= radius))) teeth.radius++;
        // One pass, a filter (a category), no radius: the areas' order over every post.
        const c2 = reads.circles, p2 = reads.passes;
        const filtered = checkPage(`#${i} one pass`, q, await call('GET', who, `${POSTS}?${at}&category=grid&sort=distance&limit=200`));
        if (reads.passes === p2 || reads.circles !== c2) problems.push(`#${i}: the filtered read was not one pass`);
        if (filtered.length !== gridPlaced.length) problems.push(`#${i} one pass: ${filtered.length} of ${gridPlaced.length} grid posts`);
    }
    delete (db as any).prepare;
    assert(byCirclesAlone >= 60, `the circles alone gave the page for ${byCirclesAlone} of 200 points, and one pass after them for the rest`);
    assert(problems.length === 0, `200 query points × 3 reads: every place is its area, every distance the whole km from it, in the areas' order, a radius holds exactly the areas inside it, no place appears${problems.length ? ` — ${problems.length} problems: ${problems.slice(0, 5).join(' | ')}` : ''}`);
    console.log(`  (the place itself would have answered differently: ${teeth.order} orderings, ${teeth.radius} radius reads, ${teeth.distance} distances)`);
    assert(teeth.order > 0 && teeth.radius > 0 && teeth.distance > 0, 'the checks have teeth: reading the place instead of the area would have failed each of them');
    {
        const m = await call('GET', bob, `${POSTS}?lat=-28.5&lng=153.5&sort=distance&limit=200`);
        const o = (m.body as any[]).find(p => p.id === offer.id);
        assert(o?.lat === OFFER_AT.lat && o?.distanceKm === Math.round(haversine(-28.5, 153.5, OFFER_AT.lat, OFFER_AT.lng) * 10) / 10,
            `a member's distances are still from the place, to 0.1 km (${o?.distanceKm})`);
    }

    // ── 9. faces and names (G9a-2) ─────────────────────────────────────────────────────────────
    console.log('\n── 9. faces behind a member-only key, and the recovery lookup ──');
    {
        const PNG_BYTES = Buffer.from(TINY_PNG.split(',')[1], 'base64');
        const avatarOf = async (who: Id, route: '/api/community/members' | '/api/members', of: Id) => {
            const r = await call('GET', who, route);
            return { url: ((r.body as any[]) ?? []).find(m => m.publicKey === of.pk)?.avatarUrl as string | undefined, cache: r.headers.get('cache-control') };
        };
        const direct = await avatarOf(bob, '/api/community/members', alice);
        const plain = await avatarOf(bob, '/api/members', alice);
        assert(!!direct.url && /[?&]k=[A-Za-z0-9_-]{22}$/.test(direct.url) && direct.url === plain.url,
            `a member's members lists carry Alice's face with its member-only key (${direct.url})`);
        assert(!!plain.cache?.startsWith('private'), `and /api/members, holding those keys, is private to a shared cache (${plain.cache})`);
        const keyless = `/api/avatar/${alice.pk}?size=thumb&v=${new URL(`https://x${direct.url}`).searchParams.get('v')}`;
        for (const [who, id] of [['unsigned', null], ['a non-member signer', outsider], ['a member', bob]] as const) {
            const r = await call('GET', id, keyless);
            assert(r.status === 404 && r.body?.error === 'Avatar not found', `${who}: Alice's face without its key is 404 Avatar not found (got ${r.status})`);
        }
        await prunedRefused("Alice's face without its key", [keyless]);
        const img = await call('GET', null, direct.url!);
        assert(img.status === 200 && img.headers.get('content-type') === 'image/png' && Buffer.from(img.text, 'utf8').length > 0,
            `the keyed URL opens it unsigned, as an <img> asks (got ${img.status} ${img.headers.get('content-type')})`);
        const res = await fetch(`${BASE}${direct.url}`);
        assert(Buffer.from(await res.arrayBuffer()).equals(PNG_BYTES), 'and serves her photo');
        const etag = img.headers.get('etag')!;
        const conditional = await call('GET', null, keyless, undefined, { 'If-None-Match': etag });
        assert(conditional.status === 404, `a conditional request without the key is 404, not 304 (got ${conditional.status})`);
        const k = new URL(`https://x${direct.url}`).searchParams.get('k') ?? '';
        const wrong = direct.url!.replace(`k=${k}`, `k=${k[0] === 'A' ? 'B' : 'A'}${k.slice(1)}`);
        assert((await call('GET', null, wrong)).status === 404, 'a key one character wrong is 404');
        const bobUrl = (await avatarOf(bob, '/api/community/members', bob)).url!;
        const bobKey = new URL(`https://x${bobUrl}`).searchParams.get('k') ?? '';
        assert((await call('GET', null, direct.url!.replace(`k=${k}`, `k=${bobKey}`))).status === 404, "another member's key is 404 for Alice's face");
        assert((await call('GET', null, `/api/avatar/${outsider.pk}?k=${k}`)).status === 404, 'a key for a key with no member is 404');
        // Alice changes her photo: the old URL and its key open nothing; the new ones do.
        const NEW_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
        db.prepare('UPDATE members SET avatar_url = ?, profile_updated_at = ? WHERE public_key = ?').run(NEW_PNG, new Date().toISOString(), alice.pk);
        assert((await call('GET', null, direct.url!)).status === 404, 'after a photo change, the old URL and its key are 404');
        const changed = await avatarOf(bob, '/api/community/members', alice);
        assert(!!changed.url && changed.url !== direct.url && (await call('GET', null, changed.url)).status === 200,
            `and the members list's new URL opens the new photo (${changed.url})`);
        const memberPosts = await call('GET', bob, `${POSTS}?${ALL_TYPES}`);
        const aliceOffer = (memberPosts.body as any[]).find(p => p.id === offer.id);
        assert(aliceOffer?.authorAvatarUrl === changed.url, "a member's listings carry the same keyed URL");
        const guestPosts = await call('GET', null, `${POSTS}?${ALL_TYPES}`);
        assert((guestPosts.body as any[]).every(p => p.authorAvatarUrl === null) && !guestPosts.text.includes('k='),
            "a guest's carry no face at all");
        // The recovery lookup: a stranger there can't list members by typing a letter, or see their faces.
        for (const [q, want] of [['sentinel', 0], ['S', 0], ['SentinelAl', 0], ['SentinelAlice', 1], ['sentinelalice', 1], [' SENTINELALICE ', 1]] as const) {
            const r = await call('GET', null, `/api/recovery/lookup/${encodeURIComponent(q)}`);
            const found = Array.isArray(r.body) ? r.body : [];
            assert(r.status === 200 && found.length === want, `the recovery lookup for "${q}" finds ${want} (got ${r.status} ${found.length})`);
            if (want) {
                assert(found[0].publicKey === alice.pk && found[0].callsign === 'SentinelAlice' && found[0].avatarUrl === null && found[0].joinedAt === null
                    && found[0].canRecoverBySso === true, `the exact match names her by the name typed and her key, with no photo or join date (${JSON.stringify(found[0])})`);
            }
        }
    }

    // ── 11. every route, every method (last: its writes change what the sections above read) ─────
    await everyRoute();

    // ── 8. the other combinations, each in a fresh process ─────────────────────────────────────
    for (const [combo, what] of [
        ['global+money', 'the global node with the Beans switched back on: sections 1, 2, 2b, 10, 7b, 7c and 11'],
        ['local+guest', 'a local node with guestListingsOnly overridden on: sections 1, 2, 2b, 10, 7b, 7c and 11'],
        ['local', 'a local node: nothing changes (NODE_PROFILE unset)'],
    ] as const) {
        console.log(`\n── 8. ${what} ──`);
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `beanpool-guest-view-${combo.replace('+', '-')}-`));
        ownedDirs.add(dataDir);
        const env: NodeJS.ProcessEnv = { ...process.env, GUEST_VIEW_COMBO: combo, GUEST_VIEW_CHILD: '1', BEANPOOL_DATA_DIR: dataDir };
        delete env.NODE_PROFILE;
        // Async, with an IPC channel the child watches (above): this process stays free to stop it on a signal.
        const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], { env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
        children.add(child);
        const status = await new Promise<number | null>(resolve => {
            child.on('exit', code => resolve(code));
            child.on('error', () => resolve(null));
        });
        children.delete(child);
        fs.rmSync(dataDir, { recursive: true, force: true });
        ownedDirs.delete(dataDir);
        assert(status === 0, `the ${combo} run passed (exit ${status})`);
    }

    /**
     * 11. Every route the node serves, every method, as an unsigned caller, a key that is no member here and a pruned
     * account (the deciding review's crawl, round 3). A write that hands back a person is a read by another name, and
     * neither the read gate nor the public-read sweep above ever sees it: POST /api/trust/profile gave any signer a
     * member's name, standing and the faces of the members who brought them in (4108354076). So every route, with a
     * body for each write that names a member wherever the route takes one; and a HEAD for every read, answered as its
     * GET is (4108354205). A route this table doesn't list fails, so the next one is swept too.
     */
    async function everyRoute(): Promise<void> {
        console.log('\n── 11. every route the node serves, every method, as an unsigned caller, a non-member signer and a pruned account ──');
        const { resetAdminRateLimit } = https;
        const { resetChatRateLimit } = await import('./chat-rate-limit.js');
        const { resetAdminAuthTarpit } = await import('./admin-auth.js');
        const { resetPasswordBrake } = await import('./password-brake.js');
        const { pruneGithubPolls } = await import('./github-poll-rate-limit.js');
        const earlier = beforeCall;
        beforeCall = () => {
            earlier();
            resetAdminRateLimit?.(); resetChatRateLimit(); resetAdminAuthTarpit(); resetPasswordBrake(); pruneGithubPolls(Date.now() + 3_600_000);
        };
        // The admin tarpit (admin-auth.ts) sleeps before it refuses: 250 ms even from the floor resetAdminAuthTarpit leaves
        // it at, on each of the ~180 admin reads, writes and HEADs a caller sends here. That was about 400 s of this suite's
        // 435 (45 s a caller, 9 sweeps) and put it past test-all's timeout. The sleep decides only WHEN the 401 goes out, never
        // its status or body, which is all this sweep reads (test-admin-auth measures the delay itself). So for this section a
        // timer set from admin-auth fires at once; every other timer keeps its delay.
        const realSetTimeout = globalThis.setTimeout;
        let tarpitsAnsweredAtOnce = 0;
        globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
            const tarpit = /[\\/]admin-auth\.[cm]?[jt]s:\d+/.test(new Error().stack ?? '');
            if (tarpit) tarpitsAnsweredAtOnce++;
            return realSetTimeout(fn, tarpit ? 0 : ms, ...args);
        }) as unknown as typeof setTimeout;
        // Bob brought Alice in and vouches for her as an elder, and they are friends: her trust profile names him, with his face.
        db.prepare('UPDATE members SET invited_by = ?, elder_vouched_by = ? WHERE public_key = ?').run(bob.pk, bob.pk, alice.pk);
        db.prepare('INSERT OR IGNORE INTO friends (owner_pubkey, friend_pubkey) VALUES (?, ?), (?, ?)').run(alice.pk, bob.pk, bob.pk, alice.pk);
        // What a pruned account still holds, since pruning leaves its rows: it convenes a group Alice is in, and it is in a
        // DM with Alice, who reacted to its messages and wrote one of her own there.
        const prunedClub = se.createGroup({ name: 'Sentinel pruned club', createdBy: bob.pk });
        db.prepare(`INSERT OR REPLACE INTO group_members (group_id, member_pubkey, role, status) VALUES (?, ?, 'convenor', 'active'), (?, ?, 'member', 'active')`)
            .run(prunedClub.id, pruned.pk, prunedClub.id, alice.pk);
        db.prepare(`INSERT INTO conversations (id, type, created_by) VALUES ('conv-pruned', 'dm', ?)`).run(alice.pk);
        db.prepare(`INSERT INTO conversation_participants (conversation_id, public_key) VALUES ('conv-pruned', ?), ('conv-pruned', ?)`).run(alice.pk, pruned.pk);
        const reactedByAlice = JSON.stringify({ reactions: [{ emoji: '❤️', author: alice.pk }] });
        for (const [mid, author] of [['msg-pruned-alice', alice.pk], ['msg-pruned-own', pruned.pk], ['msg-pruned-own-2', pruned.pk]]) {
            db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, metadata) VALUES (?, 'conv-pruned', ?, 'Y2lwaGVy', 'bm9uY2U=', 'text', ?)`)
                .run(mid, author, reactedByAlice);
        }
        // And the event chats and trades pruning leaves it (4109135691): an event of its own and one in the group it
        // convenes, each with a line of Alice's; a request it made, one waiting on it, a deal it is in, and one it completed.
        // Made while it was a member, as they would have been.
        db.prepare("UPDATE members SET status = 'active' WHERE public_key = ?").run(pruned.pk);
        const inAWeek = { eventStartAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), eventPlaceName: PLACE_NAME };
        const prunedEvent = post(pruned, 'Sentinel pruned working bee', EVENT_AT, inAWeek, 'event', 'community');
        const prunedOffer = post(pruned, 'Sentinel pruned jam', OFFER_AT);
        db.prepare("UPDATE members SET status = 'pruned' WHERE public_key = ?").run(pruned.pk);
        const clubEvent = post(alice, 'Sentinel pruned club picnic', EVENT_AT, { ...inAWeek, audienceScope: 'group', targetGroupId: prunedClub.id }, 'event', 'community');
        se.rsvpEvent(prunedEvent.id, alice.pk, 'going');
        const aliceLines = [prunedEvent, clubEvent].map(e => se.postEventThreadMessage(e.id, alice.pk, 'Sentinel: bringing the urn').id);
        for (const [id, postId, buyer, seller, status] of [
            ['mt-pruned-asks', offer.id, pruned.pk, alice.pk, 'requested'],       // it asked for Alice's offer
            ['mt-pruned-decides', prunedOffer.id, alice.pk, pruned.pk, 'requested'], // Alice asked for its jam
            ['mt-pruned-pending', bobOffer.id, pruned.pk, bob.pk, 'pending'],     // it is buying from Bob
            ['mt-pruned-done', trade.id, pruned.pk, alice.pk, 'completed'],       // it bought from Alice
        ]) {
            db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at)
                        VALUES (?, ?, ?, ?, 1, ?, ?)`).run(id, postId, buyer, seller, status, new Date().toISOString());
        }
        const tradeStatuses = () => (db.prepare("SELECT id, status FROM marketplace_transactions WHERE id LIKE 'mt-pruned-%' ORDER BY id").all() as { id: string; status: string }[])
            .map(r => `${r.id}=${r.status}`).join(' ');
        const tradesBefore = tradeStatuses();
        const clubEventNow = () => JSON.stringify(db.prepare('SELECT title, event_place_name, event_start_at, event_state FROM posts WHERE id = ?').get(clubEvent.id));
        const clubEventBefore = clubEventNow();
        // A code and a paper ticket from Bob, as anyone he invites holds.
        const code = se.generateInvite(bob.pk)!.code;
        const ticketPayload = JSON.stringify({ i: bob.pk, t: Date.now() });
        const ticketB64 = Buffer.from(JSON.stringify({ p: ticketPayload, s: crypto.sign(null, Buffer.from(ticketPayload), bob.priv).toString('base64') })).toString('base64');
        const noPerson = (r: Res, sent: string[] = []) => !leaks(r.text, sent).length && !r.text.includes('/api/avatar/') && !KEYED_FACE.test(r.text);

        // 11a. The review's walk: a name typed at the recovery lookup gives a key, as designed; that key opens nothing more.
        {
            const typed = await call('GET', null, '/api/recovery/lookup/SentinelAlice');
            const key = typed.body?.[0]?.publicKey as string | undefined;
            assert(typed.status === 200 && key === alice.pk, `the exact recovery lookup gives Alice's key, as designed (${typed.status})`);
            assert((await call('GET', null, `/api/avatar/${key}?size=thumb`)).status === 404, 'her face by that key alone is 404');
            const walk: Array<[string, Id | null, number]> = [['unsigned', null, 401], ['a non-member signer', newId(), 403], ['a pruned account', pruned, 403]];
            for (const [who, id, want] of walk) {
                for (const [whose, target] of [["Alice's", alice.pk], ["Bob's, who brought her in", bob.pk]] as const) {
                    const r = await call('POST', id, '/api/trust/profile', { targetPubkey: target });
                    assert(r.status === want && noPerson(r, [target]),
                        `${who}: POST /api/trust/profile for ${whose} key is refused ${want} and names nobody (got ${r.status} ${r.text.slice(0, 160)})`);
                }
            }
            const m = await call('POST', grid, '/api/trust/profile', { targetPubkey: alice.pk });
            const face = m.body?.vouchedInBy?.avatarUrl as string | undefined;
            assert(m.status === 200 && m.body?.callsign === 'SentinelAlice' && m.body?.vouchedInBy?.publicKey === bob.pk && m.body?.elderVouch?.publicKey === bob.pk
                && !!face && KEYED_FACE.test(face) && (await call('GET', null, face)).status === 200,
                `a member reads it as before: her name, and Bob who brought her in, with a face that opens (${m.status})`);
        }

        // 11b. HEAD: the router answers a HEAD with the GET handler, so a gate that looked only at GET let an unsigned HEAD
        // run any gated read, and its Content-Length told a stranger what the GET would not (4108354205).
        {
            const inGroup = await call('HEAD', null, `/api/groups?member=${alice.pk}`);
            const nowhere = await call('HEAD', null, `/api/groups?member=${newId().pk}`);
            assert(inGroup.status === 401 && nowhere.status === 401 && inGroup.headers.get('content-length') === nowhere.headers.get('content-length'),
                `an unsigned HEAD /api/groups?member= is 401 like its GET, the same length for a member in a group as for a stranger `
                + `(${inGroup.status}/${inGroup.headers.get('content-length')} vs ${nowhere.status}/${nowhere.headers.get('content-length')})`);
            for (const p of ['/api/members', '/api/pulse/feed', '/api/commons/decisions/dec-sentinel', '/api/enterprises']) {
                const got = await Promise.all([null, newId(), pruned, bob].map(async id => [(await call('GET', id, p)).status, (await call('HEAD', id, p)).status]));
                assert(got.every(([g, h]) => g === h) && got[0][1] === (p === '/api/enterprises' && !MONEY_ON ? 404 : 401),
                    `HEAD ${p} answers as GET does, unsigned, as a non-member, pruned and as a member (GET/HEAD ${got.map(x => x.join('/')).join(', ')})`);
            }
        }

        // 11c. The redeem card: a code or a ticket names nobody to its holder, but a member re-entering, who signs the
        // redeem with their own key, still reads their own photo from it (native utils/db.ts redeemInvite).
        {
            const redeemers: Array<[string, Id | null]> = [['unsigned', null], ['a non-member signer', newId()], ['a pruned account', pruned], ['Bob, signing for Alice', bob]];
            for (const [who, id] of redeemers) {
                const r1 = await call('POST', id, '/api/invite/redeem', { code, publicKey: alice.pk, callsign: 'Sentinel joiner' });
                const r2 = await call('POST', id, '/api/invite/redeem-offline', { ticketB64, publicKey: alice.pk, callsign: 'Sentinel joiner' });
                assert([r1, r2].every(r => r.status === 200 && r.body?.alreadyMember === true && r.body?.member === undefined && noPerson(r, [alice.pk])),
                    `${who}: redeeming a code and a ticket for Alice's key says she is a member and gives no card (${r1.status} ${r1.text.slice(0, 100)} | ${r2.status} ${r2.text.slice(0, 100)})`);
            }
            // The card holds the photo itself, as stored: the phone keeps it only if the node can serve it.
            const photo = (db.prepare('SELECT avatar_url FROM members WHERE public_key = ?').get(alice.pk) as { avatar_url: string }).avatar_url;
            const own = await call('POST', alice, '/api/invite/redeem', { code, publicKey: alice.pk, callsign: 'Sentinel joiner' });
            const ownTicket = await call('POST', alice, '/api/invite/redeem-offline', { ticketB64, publicKey: alice.pk, callsign: 'Sentinel joiner' });
            assert([own, ownTicket].every(r => r.status === 200 && r.body?.member?.callsign === 'SentinelAlice' && r.body?.member?.avatarUrl === photo),
                `Alice re-entering, signing with her own key, gets her own card and photo as before (${own.status} ${ownTicket.status})`);
        }

        // A face goes out as a keyed link or as the photo itself (the redeem card held the photo). So every member but the
        // pruned account gets a photo no listing, enterprise or crowdfund holds, and the sweep looks for it too.
        const FACE = 'data:image/png;base64,U2VudGluZWwgZmFjZSwgYSBtZW1iZXIncyBvd24=';
        db.prepare("UPDATE members SET avatar_url = ? WHERE public_key NOT IN ('SYSTEM', ?) AND COALESCE(is_treasury, 0) = 0").run(FACE, pruned.pk);

        // 11d. The sweep.
        /** A write's body, unless the route has its own below: every field a route names someone by, each naming Alice. */
        const BAIT: Record<string, unknown> = {
            targetPubkey: alice.pk, friendPubkey: alice.pk, memberPubkey: alice.pk, toPubkey: alice.pk, to: alice.pk, candidate: alice.pk,
            id: offer.id, postId: offer.id, groupId: club.id, conversationId: 'conv-sentinel', messageId: 'msg-sentinel', decisionId: 'dec-sentinel',
            projectId: crowdfund, treasury: enterprise, channelId: 'chan-sentinel', itemId: 'item_sentinel', amount: 1,
        };
        /** A write's own body, in place of BAIT, where BAIT won't reach the part of it that could hand back a person. */
        const BODIES: Record<string, Record<string, unknown>> = {
            'POST /api/trust/profile': { targetPubkey: alice.pk },
            'POST /api/friends/add': { friendPubkey: alice.pk },
            // Anyone holding a code or a ticket, naming a member's key they have not signed for.
            'POST /api/invite/redeem': { code, publicKey: alice.pk, callsign: 'Sentinel joiner' },
            'POST /api/invite/redeem-offline': { ticketB64, publicKey: alice.pk, callsign: 'Sentinel joiner' },
            // A Pulse item's id, and the report names its owner.
            'POST /api/reports': { targetPulseItemId: 'item_sentinel', reason: 'Sentinel check' },
            // The pruned convenor: inviting Grid, changing Alice's role, renaming the group.
            'POST /api/groups/:id/members': { targetPubkey: grid.pk },
            'PATCH /api/groups/:id/members/:pubkey': { role: 'member' },
            'PATCH /api/groups/:id': { description: 'Sentinel pruned club, still' },
            // The pruned account's DM with Alice: each message carries her reaction.
            'POST /api/messages/react': { messageId: 'msg-pruned-alice', emoji: '👍' },
            'POST /api/messages/edit': { messageId: 'msg-pruned-own', ciphertext: 'ZWRpdGVk', nonce: 'bm9uY2U=' },
            'POST /api/messages/delete': { messageId: 'msg-pruned-own-2' },
            'POST /api/messages/mark-read': { conversationId: 'conv-pruned' },
            'POST /api/messages/mute': { conversationId: 'conv-pruned', duration: '8h' },
            'POST /api/messages/send': { conversationId: 'conv-pruned', ciphertext: 'c2VudA==', nonce: 'bm9uY2U=' },
            // The event chat of the group it convenes (the URL's :id, below): Alice's line.
            'POST /api/marketplace/posts/:id/chat/remove': { messageId: aliceLines[1] },
            // Moving that event, as its convenor: the answer is Alice's event, and the move tells everyone going (4109566615).
            'POST /api/marketplace/posts/update': { id: clubEvent.id, authorPublicKey: pruned.pk, title: 'Sentinel picnic moved',
                eventPlaceName: 'Sentinel car park', eventStartAt: new Date(Date.now() + 8 * 86_400_000).toISOString() },
            // Its trades: each answer is the trade, with the other party.
            'POST /api/marketplace/transactions/reject': { transactionId: 'mt-pruned-decides', authorPublicKey: pruned.pk },
            'POST /api/marketplace/transactions/cancel-request': { transactionId: 'mt-pruned-asks', buyerPublicKey: pruned.pk },
            'POST /api/marketplace/transactions/cancel': { transactionId: 'mt-pruned-pending', cancellerPublicKey: pruned.pk },
            'POST /api/marketplace/transactions/complete': { transactionId: 'mt-pruned-done', confirmerPublicKey: pruned.pk },
            // An invite, which would bring its holder in as someone new.
            'POST /api/invite/generate': { publicKey: pruned.pk },
            // Asking to join (G6), past the body checks to the knock itself, where knocks are on: its answer is the signer's own.
            'POST /api/join/knock': { callsign: 'Sentinel knocker', message: 'Sentinel knock, asking to join' },
        };
        /** What a read answers by design with more than was asked: the exact recovery match names its key (section 9). */
        const ECHOES: Record<string, string[]> = { 'GET /api/recovery/lookup/:callsign': [alice.pk] };
        /** A read's query, for every GET: each parameter a read names someone by, naming Alice. */
        const BAIT_QUERY = `member=${alice.pk}&publicKey=${alice.pk}&pubkey=${alice.pk}&targetPubkey=${alice.pk}`;
        /** Every route this node serves. A route not listed here fails below: list it, with a body in BODIES if BAIT won't reach its data. */
        const EVERY_ROUTE = new Set<string>([
            'GET /', 'GET /.well-known/apple-app-site-association', 'GET /.well-known/apple-developer-domain-association.txt',
            'GET /.well-known/assetlinks.json', 'GET /app', 'POST /app/auth/apple', 'GET /apple-app-site-association', 'GET /settings',
            'GET /settings-legacy', 'GET /settings.js', 'GET /settings/(.*)', 'GET /trust',
            'GET /api/activity/feed',
            'POST /api/admin/check-update', 'POST /api/admin/reports', 'POST /api/admin/seed-invite', 'POST /api/admin/thresholds',
            'POST /api/admin/thresholds/get',
            'GET /api/attest',
            'GET /api/avatar/:pubkey',
            'POST /api/channels/mine', 'GET /api/channels/options',
            'GET /api/commons/balance', 'GET /api/commons/decisions', 'POST /api/commons/decisions', 'GET /api/commons/decisions/:id',
            'POST /api/commons/decisions/:id/vote', 'GET /api/commons/projects', 'POST /api/commons/projects', 'POST /api/commons/projects/delete',
            'POST /api/commons/projects/update',
            'GET /api/community/health', 'GET /api/community/info', 'GET /api/community/me', 'POST /api/community/me/area', 'GET /api/community/members',
            'GET /api/community/membership/:publicKey', 'POST /api/community/register',
            'GET /api/crowdfund/projects', 'POST /api/crowdfund/projects', 'GET /api/crowdfund/projects/:id', 'POST /api/crowdfund/projects/:id/pledge',
            'POST /api/crowdfund/projects/delete', 'POST /api/crowdfund/projects/update',
            'GET /api/directory/info',
            'POST /api/enterprise', 'GET /api/enterprise/:treasury', 'DELETE /api/enterprise/:treasury/backing',
            'POST /api/enterprise/:treasury/backing', 'POST /api/enterprise/:treasury/backing/release',
            'POST /api/enterprise/:treasury/keepers/:pubkey/remove', 'POST /api/enterprise/:treasury/keepers/changes/:changeId/object',
            'POST /api/enterprise/:treasury/keepers/request', 'GET /api/enterprise/:treasury/keepers/requests',
            'POST /api/enterprise/:treasury/keepers/requests/:requestId/approve', 'POST /api/enterprise/:treasury/keepers/requests/:requestId/decline',
            'POST /api/enterprise/:treasury/keepers/step-down', 'GET /api/enterprise/:treasury/ledger', 'DELETE /api/enterprise/:treasury/location',
            'POST /api/enterprise/:treasury/location', 'POST /api/enterprise/:treasury/pause', 'DELETE /api/enterprise/:treasury/pledge',
            'POST /api/enterprise/:treasury/pledge', 'POST /api/enterprise/:treasury/pledge/release', 'POST /api/enterprise/:treasury/release',
            'POST /api/enterprise/:treasury/resume', 'GET /api/enterprise/:treasury/succession',
            'POST /api/enterprise/:treasury/succession/:proposalId/vote', 'POST /api/enterprise/:treasury/succession/propose',
            'GET /api/enterprise/:treasury/thread', 'POST /api/enterprise/:treasury/thread/message',
            'DELETE /api/enterprise/:treasury/thread/message/:messageId', 'POST /api/enterprise/:treasury/thread/remove',
            'POST /api/enterprise/:treasury/wind-up/cancel', 'POST /api/enterprise/:treasury/wind-up/finalise',
            'POST /api/enterprise/:treasury/wind-up/initiate',
            'GET /api/enterprises', 'GET /api/enterprises/:treasury/thread', 'POST /api/enterprises/:treasury/thread/message',
            'DELETE /api/enterprises/:treasury/thread/message/:messageId', 'POST /api/enterprises/:treasury/thread/remove', 'GET /api/enterprises/map',
            'GET /api/enterprises/statuses',
            'PUT /api/events/:postId/reminder', 'GET /api/events/mine',
            'POST /api/federation/commission', 'GET /api/federation/commission/capacity', 'GET /api/federation/links', 'POST /api/federation/purchase',
            'GET /api/federation/reachable-peers',
            'GET /api/friends/:publicKey', 'POST /api/friends/add', 'POST /api/friends/remove',
            'POST /api/funnel-event',
            'GET /api/global/communities', 'GET /api/global/home', 'GET /api/global/watches', 'POST /api/global/watches',
            'DELETE /api/global/watches/:id',
            'GET /api/groups', 'POST /api/groups', 'GET /api/groups/:id', 'PATCH /api/groups/:id', 'GET /api/groups/:id/chat',
            'POST /api/groups/:id/chat/message', 'POST /api/groups/:id/chat/remove', 'POST /api/groups/:id/join', 'POST /api/groups/:id/lead',
            'GET /api/groups/:id/members', 'POST /api/groups/:id/members', 'DELETE /api/groups/:id/members/:pubkey',
            'PATCH /api/groups/:id/members/:pubkey', 'DELETE /api/groups/:id/posts/:postId', 'GET /api/groups/:id/succession',
            'POST /api/groups/:id/succession/:proposalId/vote', 'POST /api/groups/:id/succession/propose',
            'GET /api/invite/check', 'POST /api/invite/generate', 'GET /api/invite/mine/:publicKey', 'POST /api/invite/redeem',
            'POST /api/invite/redeem-offline', 'GET /api/invite/tree',
            'POST /api/join', 'POST /api/join/github/poll', 'POST /api/join/github/start', 'POST /api/join/knock',
            'GET /api/join/knock/status', 'GET /api/join/knocks', 'POST /api/join/knocks/:id/approve', 'POST /api/join/knocks/:id/decline',
            'POST /api/join/sso-nonce',
            'GET /api/ledger/balance/:publicKey', 'GET /api/ledger/export', 'GET /api/ledger/transactions', 'POST /api/ledger/transfer',
            'POST /api/local/admin/2fa/disable', 'POST /api/local/admin/2fa/setup', 'GET /api/local/admin/2fa/status',
            'POST /api/local/admin/2fa/verify', 'POST /api/local/admin/announcements',
            'GET /api/local/admin/app-addresses', 'POST /api/local/admin/app-addresses/confirm', 'POST /api/local/admin/app-addresses/remove',
            'POST /api/local/admin/auth/break-glass-mode',
            'GET /api/local/admin/auth/break-glass-status', 'POST /api/local/admin/auth/break-glass/enrol',
            'GET /api/local/admin/auth/break-glass/status', 'POST /api/local/admin/auth/challenge', 'GET /api/local/admin/auth/challenge/:challengeId',
            'POST /api/local/admin/auth/enrol', 'POST /api/local/admin/auth/exchange', 'POST /api/local/admin/auth/logout',
            'POST /api/local/admin/auth/pairing', 'GET /api/local/admin/auth/pairing/:id', 'POST /api/local/admin/auth/pairing/:id/approve',
            'POST /api/local/admin/auth/pairing/:id/decline', 'POST /api/local/admin/auth/pairing/:id/wait', 'POST /api/local/admin/auth/revoke-all',
            'GET /api/local/admin/auth/session', 'POST /api/local/admin/auth/verify-challenge', 'POST /api/local/admin/backup',
            'POST /api/local/admin/backup-config', 'GET /api/local/admin/backup-enroll', 'POST /api/local/admin/backup-status',
            'POST /api/local/admin/backup/verify', 'POST /api/local/admin/branches/:pubkey/prune', 'POST /api/local/admin/commons/projects',
            'POST /api/local/admin/commons/reject', 'POST /api/local/admin/csrf-token', 'POST /api/local/admin/data', 'POST /api/local/admin/decisions',
            'POST /api/local/admin/decisions/:id/accelerate', 'POST /api/local/admin/decisions/:id/halt', 'GET /api/local/admin/diagnostics',
            'POST /api/local/admin/diagnostics', 'POST /api/local/admin/directory/push', 'GET /api/local/admin/disputes',
            'GET /api/local/admin/disputes/:id', 'POST /api/local/admin/disputes/:id/resolve', 'GET /api/local/admin/gateway',
            'POST /api/local/admin/gateway', 'POST /api/local/admin/health', 'POST /api/local/admin/inbox', 'POST /api/local/admin/inbox/send',
            'GET /api/local/admin/knocks', 'POST /api/local/admin/ledger-audit', 'POST /api/local/admin/ledger-rebaseline', 'POST /api/local/admin/logs',
            'POST /api/local/admin/members/:pubkey/offboard', 'GET /api/local/admin/members/:pubkey/offboard/preview',
            'POST /api/local/admin/members/:pubkey/rekey/complete', 'POST /api/local/admin/members/:pubkey/rekey/issue-code',
            'GET /api/local/admin/members/:pubkey/rekey/status', 'POST /api/local/admin/members/:pubkey/unmute', 'GET /api/local/admin/members/muted',
            'GET /api/local/admin/node-roles', 'POST /api/local/admin/node-roles', 'DELETE /api/local/admin/node-roles/:pubkey/:role',
            'POST /api/local/admin/node/config', 'GET /api/local/admin/onboarding-funnel', 'POST /api/local/admin/onboarding-funnel',
            'POST /api/local/admin/posts/:id/delete', 'POST /api/local/admin/posts/:id/restore', 'POST /api/local/admin/posts/bulk-delete',
            'POST /api/local/admin/public-address/claim', 'GET /api/local/admin/public-address/logs', 'POST /api/local/admin/public-address/offline',
            'POST /api/local/admin/public-address/restart-sidecar', 'GET /api/local/admin/public-address/status',
            'POST /api/local/admin/public-address/update', 'GET /api/local/admin/pulse/channels', 'POST /api/local/admin/pulse/channels',
            'POST /api/local/admin/pulse/channels/remove', 'POST /api/local/admin/replication-access', 'POST /api/local/admin/replication-config/get',
            'POST /api/local/admin/replication-config/save', 'POST /api/local/admin/replication-resync', 'POST /api/local/admin/replication-token/clear',
            'POST /api/local/admin/replication-token/generate', 'POST /api/local/admin/replication-token/mode',
            'POST /api/local/admin/replication-token/status', 'GET /api/local/admin/reports', 'POST /api/local/admin/reports/:id/action',
            'POST /api/local/admin/reports/:id/dismiss', 'POST /api/local/admin/restore', 'POST /api/local/admin/restore/phone/wait',
            'GET /api/local/admin/shutdown-status', 'POST /api/local/admin/shutdown-status', 'POST /api/local/admin/shutdown-status/acknowledge',
            'POST /api/local/admin/snapshots/config', 'POST /api/local/admin/snapshots/create', 'POST /api/local/admin/snapshots/delete',
            'GET /api/local/admin/snapshots/download', 'POST /api/local/admin/snapshots/list', 'POST /api/local/admin/storage/clean',
            'GET /api/local/admin/storage/clean-preview', 'POST /api/local/admin/storage/clean-preview', 'GET /api/local/admin/storage/disk-health',
            'POST /api/local/admin/storage/disk-health', 'GET /api/local/admin/stranded-escrows',
            'POST /api/local/admin/stranded-escrows/:escrowId/write-off', 'GET /api/local/admin/sync-audit-log', 'GET /api/local/admin/sync-delta',
            'GET /api/local/admin/sync-snapshot', 'GET /api/local/admin/takeover-envelope', 'POST /api/local/admin/takeover/cancel',
            'POST /api/local/admin/takeover/confirm', 'POST /api/local/admin/takeover/open', 'POST /api/local/admin/takeover/phone/start',
            'POST /api/local/admin/takeover/phone/wait', 'POST /api/local/admin/takeover/progress', 'POST /api/local/admin/takeover/recovery-code',
            'POST /api/local/admin/takeover/recovery-code/check', 'POST /api/local/admin/takeover/status', 'POST /api/local/admin/takeover/words-checks',
            'POST /api/local/admin/treasury', 'POST /api/local/admin/treasury/:treasury/ceiling', 'DELETE /api/local/admin/treasury/:treasury/location',
            'POST /api/local/admin/treasury/:treasury/location', 'POST /api/local/admin/treasury/:treasury/need',
            'POST /api/local/admin/treasury/:treasury/offer', 'GET /api/local/admin/treasury/:treasury/operators',
            'POST /api/local/admin/treasury/:treasury/operators', 'DELETE /api/local/admin/treasury/:treasury/operators/:pubkey',
            'GET /api/local/admin/unlock/:sessionId', 'POST /api/local/admin/unlock/:sessionId', 'POST /api/local/admin/unlock/cancel',
            'POST /api/local/admin/users/:pubkey/elder', 'POST /api/local/admin/users/:pubkey/freeze', 'POST /api/local/admin/users/:pubkey/operator',
            'POST /api/local/admin/users/:pubkey/prune', 'POST /api/local/admin/users/:pubkey/status', 'POST /api/local/admin/users/:pubkey/suspend',
            'POST /api/local/admin/users/:pubkey/tier', 'POST /api/local/admin/users/:pubkey/voucher', 'POST /api/local/admin/ws-connections',
            'POST /api/local/admin/ws-ticket',
            'POST /api/local/change-password', 'GET /api/local/community-info', 'GET /api/local/connectors', 'POST /api/local/connectors',
            'POST /api/local/connectors/connect', 'POST /api/local/connectors/credit-cap', 'POST /api/local/connectors/disconnect',
            'POST /api/local/connectors/remove', 'GET /api/local/dashboard', 'POST /api/local/federation/links/ceiling', 'POST /api/local/reset',
            'GET /api/local/status', 'POST /api/local/update-identity', 'POST /api/local/verify-password',
            'GET /api/manager/backups/download-db', 'GET /api/manager/backups/download-history', 'GET /api/manager/backups/download-identity',
            'GET /api/manager/backups/history', 'POST /api/manager/backups/replication-config', 'POST /api/manager/backups/snapshots/create',
            'POST /api/manager/backups/snapshots/delete', 'POST /api/manager/backups/snapshots/list', 'GET /api/manager/backups/status',
            'POST /api/manager/backups/trigger',
            'GET /api/map/enterprises',
            'POST /api/marketplace/polls/close', 'POST /api/marketplace/polls/vote', 'GET /api/marketplace/posts', 'POST /api/marketplace/posts',
            'GET /api/marketplace/posts/:id/chat', 'POST /api/marketplace/posts/:id/chat/message', 'POST /api/marketplace/posts/:id/chat/remove',
            'POST /api/marketplace/posts/:id/close', 'GET /api/marketplace/posts/:id/photos/:orderNum', 'POST /api/marketplace/posts/:id/rsvp',
            'POST /api/marketplace/posts/:id/vote', 'POST /api/marketplace/posts/accept', 'POST /api/marketplace/posts/pause',
            'POST /api/marketplace/posts/remove', 'POST /api/marketplace/posts/request', 'POST /api/marketplace/posts/resume',
            'POST /api/marketplace/posts/update', 'GET /api/marketplace/transactions', 'POST /api/marketplace/transactions/approve',
            'POST /api/marketplace/transactions/cancel', 'POST /api/marketplace/transactions/cancel-request',
            'POST /api/marketplace/transactions/complete', 'POST /api/marketplace/transactions/reject',
            'POST /api/member/channels', 'POST /api/member/channels/:id', 'POST /api/member/channels/:id/delete',
            'POST /api/member/channels/:id/disconnect-oauth', 'POST /api/member/channels/:id/verify-oauth',
            'POST /api/member/pulse/channels/:id/dismiss-nudge', 'POST /api/member/pulse/items/:id/delete', 'POST /api/member/pulse/items/:id/mute',
            'POST /api/member/pulse/nudges', 'POST /api/member/pulse/oauth-exchange', 'POST /api/member/pulse/oauth-ingest',
            'POST /api/member/pulse/preview', 'POST /api/member/pulse/submit', 'POST /api/member/purge', 'POST /api/member/re-enroll',
            'GET /api/members', 'GET /api/members/:publicKey/channels', 'GET /api/members/callsign-available/:callsign', 'POST /api/members/holiday',
            'GET /api/members/preferences', 'POST /api/members/preferences',
            'GET /api/messages/:conversationId', 'GET /api/messages/:id/attachment', 'POST /api/messages/conversation',
            'GET /api/messages/conversations/:publicKey', 'POST /api/messages/delete', 'POST /api/messages/edit', 'POST /api/messages/mark-read',
            'POST /api/messages/mute', 'POST /api/messages/react', 'POST /api/messages/send',
            'GET /api/node-admin/me', 'GET /api/node-admin/queue',
            'GET /api/node/config', 'GET /api/node/identity-epoch', 'GET /api/node/info', 'POST /api/node/owner/lock-open-check',
            'GET /api/node/owner/words-check', 'POST /api/node/owner/words-check', 'GET /api/node/takeover-envelope/header',
            'GET /api/notices', 'POST /api/notices/seen',
            'POST /api/pair/cancel', 'POST /api/pair/init', 'GET /api/pair/poll', 'POST /api/pair/transfer',
            'GET /api/pricing-guide', 'POST /api/pricing-guide/admin/aggregate', 'POST /api/pricing-guide/admin/config',
            'POST /api/pricing-guide/admin/item', 'DELETE /api/pricing-guide/admin/item/:id', 'POST /api/pricing-guide/admin/pin',
            'POST /api/pricing-guide/admin/reset', 'POST /api/pricing-guide/report', 'GET /api/pricing-guide/reports',
            'POST /api/pricing-guide/reports/:id/status',
            'GET /api/profile/:publicKey', 'POST /api/profile/unvouch', 'POST /api/profile/update', 'POST /api/profile/vouch',
            'GET /api/pulse/feed', 'GET /api/pulse/items/:id/thumbnail', 'GET /api/pulse/oauth/config',
            'DELETE /api/push-tokens', 'POST /api/push-tokens',
            'POST /api/ratings', 'GET /api/ratings/:publicKey',
            'POST /api/recovery/collect', 'POST /api/recovery/collect/cancel', 'POST /api/recovery/collect/fragments',
            'POST /api/recovery/collect/github/poll', 'POST /api/recovery/collect/github/start', 'POST /api/recovery/collect/hub',
            'POST /api/recovery/collect/mine', 'POST /api/recovery/collect/sso', 'POST /api/recovery/collect/sso-nonce',
            'POST /api/recovery/collect/status', 'GET /api/recovery/lookup/:callsign', 'DELETE /api/recovery/shares',
            'POST /api/recovery/shares/hub-fragment', 'POST /api/recovery/shares/sso', 'DELETE /api/recovery/shares/sso/:provider',
            'POST /api/recovery/shares/status', 'POST /api/recovery/sso-nonce', 'POST /api/recovery/sso/github/poll',
            'POST /api/recovery/sso/github/start',
            'POST /api/reports',
            'GET /api/treasuries', 'GET /api/treasuries/map', 'GET /api/treasuries/statuses',
            'POST /api/treasury', 'GET /api/treasury/:treasury', 'POST /api/treasury/:treasury/approve', 'DELETE /api/treasury/:treasury/backing',
            'GET /api/treasury/:treasury/backing', 'POST /api/treasury/:treasury/backing', 'POST /api/treasury/:treasury/backing/release',
            'POST /api/treasury/:treasury/complete', 'POST /api/treasury/:treasury/event', 'POST /api/treasury/:treasury/keepers/:pubkey/remove',
            'POST /api/treasury/:treasury/keepers/changes/:changeId/object', 'POST /api/treasury/:treasury/keepers/request',
            'GET /api/treasury/:treasury/keepers/requests', 'POST /api/treasury/:treasury/keepers/requests/:requestId/approve',
            'POST /api/treasury/:treasury/keepers/requests/:requestId/decline', 'POST /api/treasury/:treasury/keepers/step-down',
            'GET /api/treasury/:treasury/ledger', 'DELETE /api/treasury/:treasury/location', 'POST /api/treasury/:treasury/location',
            'POST /api/treasury/:treasury/need', 'POST /api/treasury/:treasury/offer', 'POST /api/treasury/:treasury/pause',
            'DELETE /api/treasury/:treasury/pledge', 'POST /api/treasury/:treasury/pledge', 'POST /api/treasury/:treasury/pledge/release',
            'GET /api/treasury/:treasury/pledges', 'POST /api/treasury/:treasury/reject', 'POST /api/treasury/:treasury/release',
            'POST /api/treasury/:treasury/resume', 'GET /api/treasury/:treasury/succession', 'POST /api/treasury/:treasury/succession/:proposalId/vote',
            'POST /api/treasury/:treasury/succession/propose', 'POST /api/treasury/:treasury/sweep', 'GET /api/treasury/:treasury/thread',
            'POST /api/treasury/:treasury/thread/message', 'DELETE /api/treasury/:treasury/thread/message/:messageId',
            'POST /api/treasury/:treasury/thread/remove', 'POST /api/treasury/:treasury/wind-up/cancel', 'POST /api/treasury/:treasury/wind-up/finalise',
            'POST /api/treasury/:treasury/wind-up/initiate',
            'POST /api/trust/profile',
            'GET /api/version',
            'GET /api/your-groups',
            // Only where an operator runs the Apple probe (APPLE_PROBE=1, routes/apple-probe.ts).
            'GET /apple-probe', 'POST /apple-probe',
        ]);
        const ID_BY_PREFIX: Array<[RegExp, string]> = [
            [/^\/api\/groups\//, prunedClub.id], [/^\/api\/marketplace\/posts\/:id\/chat/, clubEvent.id], [/^\/api\/marketplace\/posts\//, offer.id], [/^\/api\/commons\/decisions\//, 'dec-sentinel'],
            [/^\/api\/crowdfund\/projects\//, crowdfund], [/^\/api\/messages\//, 'msg-sentinel'], [/^\/api\/pulse\/items\//, 'item_sentinel'],
            [/^\/api\/member\/pulse\/items\//, 'item_sentinel'], [/^\/api\/member\/(pulse\/)?channels\//, 'chan-sentinel'],
            [/^\/api\/local\/admin\/posts\//, offer.id], [/^\/api\/local\/admin\/decisions\//, 'dec-sentinel'],
        ];
        const materialise = (routePath: string) => routePath
            .replace('(.*)', 'sentinel')
            .replace(/:([A-Za-z]+)/g, (_, name: string) => {
                if (name === 'id') return ID_BY_PREFIX.find(([re]) => re.test(routePath))?.[1] ?? 'sentinel';
                return ({
                    treasury: enterprise, pubkey: alice.pk, publicKey: alice.pk, postId: routePath.startsWith('/api/events/') ? event.id : groupPost.id,
                    conversationId: 'conv-sentinel', messageId: 'msg-sentinel', callsign: 'SentinelAlice', orderNum: '0',
                } as Record<string, string>)[name] ?? 'sentinel';
            });

        const app = https.getKoaApp();
        const served = [...new Set<string>(app.middleware.filter((m: any) => m.router).flatMap((m: any) => m.router.stack)
            .flatMap((l: any) => (l.methods as string[]).filter(m => m !== 'HEAD').map(m => `${m} ${l.path}`)))].sort();
        const unlisted = served.filter(r => !EVERY_ROUTE.has(r));
        assert(served.length > 400 && unlisted.length === 0, `every one of the ${served.length} routes the node serves is listed in this sweep, `
            + `with a body for each write (a new route must be listed here)${unlisted.length ? ` — not listed: ${unlisted.slice(0, 10).join(', ')}` : ''}`);

        const guestsHere: Array<[string, () => Id | null]> = [['unsigned', () => null], ['a non-member signer', () => newId()], ['a pruned account', () => pruned]];
        const tally: Record<string, number> = {};
        const serverErrors = new Set<string>();
        for (const [who, idFor] of guestsHere) {
            const failures: string[] = [];
            const unexamined: string[] = [];
            const headMismatch: string[] = [];
            for (const route of served) {
                const [method, routePath] = route.split(' ') as [Method, string];
                let url = materialise(routePath);
                const body = method === 'GET' ? undefined : BODIES[route] ?? BAIT;
                if (method === 'GET') url = `${url}?${BAIT_QUERY}`;
                const id = idFor();
                const r = await call(method, id, url, body);
                tally[`${r.status}`] = (tally[`${r.status}`] ?? 0) + 1;
                if (r.status === 429) unexamined.push(route);
                if (r.status >= 500) serverErrors.add(`${route} ${r.status}`);
                // What the request itself sent may come back (a key or a name it asked about), and so may the caller's own.
                const sent = [...url.split('?')[0].split('/'), ...(url.match(/[0-9a-f]{64}/g) ?? []),
                    ...Object.values(body ?? {}).filter((v): v is string => typeof v === 'string'), ...(ECHOES[route] ?? [])];
                const own = id ? [id.pk, ...memberRows.filter(m => m.public_key === id.pk).map(m => m.callsign)] : [];
                const found = leaks(r.text, [...sent, ...own]);
                if (found.length) failures.push(`${route} → ${r.status}: ${found.slice(0, 3).map(f => f.slice(0, 16)).join(', ')}`);
                if (r.text.includes('/api/avatar/')) failures.push(`${route} → ${r.status}: an /api/avatar/ URL`);
                if (KEYED_FACE.test(r.text)) failures.push(`${route} → ${r.status}: a face's member-only key`);
                if (r.text.includes(FACE.split(',')[1])) failures.push(`${route} → ${r.status}: a member's photo`);
                if (typeof r.body === 'object' && r.body) {
                    const allowed = allowPerson(url.split('?')[0]);
                    const persons = personValues(r.body, (p, v) => own.includes(v) || sent.includes(v) || allowed(p));
                    if (persons.length) failures.push(`${route} → ${r.status}: ${persons.slice(0, 2).join(', ')}`);
                }
                if (method === 'GET') {
                    const h = await call('HEAD', idFor(), url);
                    if (h.status !== r.status) headMismatch.push(`${route} GET ${r.status} HEAD ${h.status}`);
                }
            }
            if (failures.length) console.error(`  ${MODE} ${who}, every answer that gave a person:\n    ${failures.join('\n    ')}`);
            assert(failures.length === 0, `${who}: none of the ${served.length} routes (every method, a body naming a member for each write) gives a person, `
                + `a face URL, its member-only key or a member's photo${failures.length ? ` — ${failures.length}: ${failures.slice(0, 8).join(' | ')}` : ''}`);
            assert(unexamined.length === 0, `${who}: every route answered, none held back by a rate limit (so each was examined)${unexamined.length ? ` — 429: ${unexamined.slice(0, 6).join(', ')}` : ''}`);
            assert(headMismatch.length === 0, `${who}: a HEAD to every read answers as its GET does${headMismatch.length ? ` — ${headMismatch.slice(0, 6).join(' | ')}` : ''}`);
        }
        console.log(`  (answers by status: ${Object.entries(tally).map(([k, v]) => `${k}×${v}`).join(', ')}; a server error, which names nobody either: ${[...serverErrors].join(', ') || 'none'})`);
        const gets = served.filter(r => r.startsWith('GET ')).length;
        console.log(`  (cases ${MODE}: ${served.length} routes, every method, × ${guestsHere.length} callers = ${served.length * guestsHere.length}, `
            + `and a HEAD for each of the ${gets} GETs × ${guestsHere.length} = ${gets * guestsHere.length}; the admin tarpit answered at once ${tarpitsAnsweredAtOnce} times)`);
        const stillPruned = (db.prepare('SELECT status FROM members WHERE public_key = ?').get(pruned.pk) as { status: string }).status;
        assert(stillPruned === 'pruned', `the pruned account is still pruned after the sweep (${stillPruned})`);
        // 11e. What the sweep sent it could not change: Alice's lines, its trades, the event it convenes, and no invite of its own.
        {
            for (const [label, ev, line] of [['its own event', prunedEvent, aliceLines[0]], ['the group event it convenes', clubEvent, aliceLines[1]]] as const) {
                const read = await call('GET', pruned, `/api/marketplace/posts/${ev.id}/chat`);
                const remove = await call('POST', pruned, `/api/marketplace/posts/${ev.id}/chat/remove`, { messageId: line });
                const kept = (db.prepare('SELECT type FROM messages WHERE id = ?').get(line) as { type: string }).type;
                assert(read.status === 403 && remove.status === 403 && noPerson(read, [pruned.pk]) && noPerson(remove, [pruned.pk]) && kept === 'text',
                    `the pruned account neither reads nor removes Alice's line in ${label}, and it is kept (${read.status} ${remove.status} ${kept})`);
            }
            assert(tradeStatuses() === tradesBefore, `its trades are as they were (${tradeStatuses()})`);
            assert(clubEventNow() === clubEventBefore, `the group event it convenes has not moved (${clubEventNow()})`);
            assert(!db.prepare('SELECT 1 FROM invite_codes WHERE created_by = ?').get(pruned.pk), 'and it made no invite');
        }
        beforeCall = earlier;
        globalThis.setTimeout = realSetTimeout;
    }

    /**
     * The deciding review's attack on the landing card (4108073735), automated, with unsigned reads of /api/global/home
     * only: from `from`, 8 rays out; on each, the point where the count of listings within 50 km drops from 1 to 0,
     * bisected to about a decimetre; then the point 50 km from every drop.
     */
    async function bisectHome(from: Place): Promise<{ ok: boolean; drops: Place[]; centre: Place; requests: number }> {
        let requests = 0;
        const count = async (p: Place) => {
            requests++;
            const r = await call('GET', null, `/api/global/home?lat=${p.lat}&lng=${p.lng}`);
            return r.status === 200 ? r.body?.nearbyPosts?.count as number : -r.status;
        };
        let ok = await count(from) === 1;
        const drops: Place[] = [];
        for (let bearing = 0; bearing < 360; bearing += 45) {
            let lo = 0, hi = 120;
            ok = ok && await count(destination(from, hi, bearing)) === 0;
            for (let k = 0; k < 20; k++) {
                const mid = (lo + hi) / 2;
                if (await count(destination(from, mid, bearing)) === 1) lo = mid; else hi = mid;
            }
            drops.push(destination(from, (lo + hi) / 2, bearing));
        }
        return { ok, drops, centre: fitCentre(drops, NEARBY_KM), requests };
    }

    async function pointChecks(): Promise<void> {
        console.log('\n── 7b. /api/global/home: the nearby count is the areas\', from 200 points, at 40 edges, and against the review\'s bisection ──');
        const HOME = '/api/global/home';
        const hrand = prng(4108073735);
        const cellKm = (q: Place, p: Place) => km(q, cellOf(p));
        /** The listings a reader's count is of: the listing's own read for that reader (swept above), each at its place. */
        const visibleTo = async (id: Id | null) => {
            const r = await call('GET', id, `${POSTS}?${ALL_TYPES}`);
            return ((Array.isArray(r.body) ? r.body : []) as any[]).map(p => truth.get(p.id))
                .filter((t): t is { id: string; lat: number; lng: number } => !!t && t.lat !== null && t.lng !== null);
        };
        const readers: Array<[string, Id | null]> = [...guests, ['a member', bob]];
        const seen = new Map<Id | null, Array<{ id: string; lat: number; lng: number }>>();
        for (const [, id] of readers) seen.set(id, await visibleTo(id));
        assert(guests.every(([, id]) => seen.get(id)!.length === seen.get(null)!.length) && seen.get(null)!.length > 50
            && seen.get(bob)!.length > seen.get(null)!.length && seen.get(null)!.some(p => p.id === lone.id),
            `the listings each count is of: ${seen.get(null)!.length} for each guest, ${seen.get(bob)!.length} for a member, the lone one among them`);
        /** How many of `set` are within 50 km of q by `dist`, cut at 99 as the card does; unsure within a micrometre. */
        const reference = (set: Place[], q: Place, dist: (q: Place, p: Place) => number) => {
            let n = 0, unsure = false;
            for (const p of set) {
                const d = dist(q, p);
                if (Math.abs(d - NEARBY_KM) <= 1e-9) unsure = true;
                else if (d <= NEARBY_KM) n++;
            }
            return { n: Math.min(n, 99), unsure };
        };
        const countOf = async (id: Id | null, q: Place) => {
            const r = await call('GET', id, `${HOME}?lat=${q.lat}&lng=${q.lng}`);
            return r.status === 200 ? r.body?.nearbyPosts?.count as number : -r.status;
        };
        const wrong: string[] = [];
        const teeth = { points: 0, edges: 0, sameBothSides: 0 };
        /** A guest's count is the areas', a member's the places'. */
        const checkAt = async (label: string, q: Place, g: [string, Id | null]) => {
            const [who, id] = g;
            const byArea = reference(seen.get(id)!, q, cellKm);
            const got = await countOf(id, q);
            if (!byArea.unsure && got !== byArea.n) wrong.push(`${label} ${who}: ${got}, by area ${byArea.n}, by place ${reference(seen.get(id)!, q, km).n}`);
            const byPlace = reference(seen.get(bob)!, q, km);
            const member = await countOf(bob, q);
            if (!byPlace.unsure && member !== byPlace.n) wrong.push(`${label} a member: ${member}, by place ${byPlace.n}`);
            return { got, byArea, byPlace: reference(seen.get(id)!, q, km) };
        };

        const points: Place[] = [];
        for (let i = 0; i < 20; i++) points.push({ lat: -70 + 140 * hrand(), lng: hrand() < 0.5 ? 179.9 + 0.1 * hrand() : -180 + 0.1 * hrand() });
        for (let i = 0; i < 10; i++) points.push({ lat: 89.9 + 0.1 * hrand(), lng: -180 + 360 * hrand() });
        for (let i = 0; i < 10; i++) points.push({ lat: -90 + 0.1 * hrand(), lng: -180 + 360 * hrand() });
        points.push({ lat: 90, lng: 0 }, { lat: -90, lng: 0 }, { lat: 0, lng: 180 }, { lat: 0, lng: -180 }, { lat: 51.48, lng: -0.12 });
        // About a circle's width from a listing, where the 50 km edge falls among them.
        const guestSeen = seen.get(null)!;
        for (let i = 0; i < 80; i++) points.push(destination(guestSeen[Math.floor(hrand() * guestSeen.length)], 40 + 20 * hrand(), 360 * hrand()));
        while (points.length < 200) points.push({ lat: Math.asin(2 * hrand() - 1) * 180 / Math.PI, lng: -180 + 360 * hrand() });
        for (let i = 0; i < points.length; i++) {
            const r = await checkAt(`#${i}`, points[i], guests[i % guests.length]);
            if (!r.byArea.unsure && r.byPlace.n !== r.byArea.n) teeth.points++;
        }
        // Either side of a listing's own 50 km edge: 20 m apart, the place's count changes; the area's only where the
        // area's edge falls between them too.
        for (let i = 0; i < 40; i++) {
            const p = guestSeen[Math.floor(hrand() * guestSeen.length)];
            const bearing = 360 * hrand();
            const g = guests[i % guests.length];
            const inner = await checkAt(`edge ${i} inside`, destination(p, NEARBY_KM - 0.01, bearing), g);
            const outer = await checkAt(`edge ${i} outside`, destination(p, NEARBY_KM + 0.01, bearing), g);
            if (inner.byPlace.n !== outer.byPlace.n) teeth.edges++;
            if (inner.byArea.n === outer.byArea.n && inner.got === outer.got) teeth.sameBothSides++;
        }
        assert(wrong.length === 0, `200 points and 40 listings' edges, as each guest and as a member: a guest's count is of the listings whose area is `
            + `within 50 km, a member's of those whose place is${wrong.length ? ` — ${wrong.length} wrong: ${wrong.slice(0, 5).join(' | ')}` : ''}`);
        console.log(`  (the place itself would have given a guest another count at ${teeth.points} of 200 points and across ${teeth.edges} of 40 edges;`
            + ` a guest's count was the same on both sides of ${teeth.sameBothSides} of them)`);
        assert(teeth.points > 0 && teeth.edges >= 30 && teeth.sameBothSides >= 30,
            "the checks have teeth: counting from the place would have failed at points and across edges, where a guest's count doesn't move");

        // The review's attack. The lone listing has nothing else within 170 km, so each drop is its.
        const cell = cellOf(LONE_AT);
        const crowd = placed.filter(p => p.id !== lone.id && km(p, LONE_AT) < 170);
        assert(crowd.length === 0 && Math.abs(km(LONE_AT, cell) - 5.07) < 0.01,
            `the lone listing is alone within 170 km, ${km(LONE_AT, cell).toFixed(3)} km from its area's centre (${cell.lat}, ${cell.lng})`);
        const attack = await bisectHome(cell);
        const fromCell = attack.drops.map(d => km(d, cell));
        const fromPlace = attack.drops.map(d => km(d, LONE_AT));
        assert(attack.ok && fromCell.every(d => Math.abs(d - NEARBY_KM) < 0.005),
            `unsigned, bisecting where the count drops on 8 rays (${attack.requests} reads): every drop is 50 km from the area's centre `
            + `(${span(fromCell)}), not from the listing (${span(fromPlace)})`);
        assert(km(attack.centre, cell) < 0.005 && km(attack.centre, LONE_AT) > 5,
            `the fit converges on the area's centre (${(km(attack.centre, cell) * 1000).toFixed(1)} m from it), never the listing `
            + `(${km(attack.centre, LONE_AT).toFixed(3)} km from it)`);

        console.log('\n── 7c. the communities: distances and order from the places they show ──');
        const off: string[] = [];
        let listed = 0;
        for (let i = 0; i < points.length; i += 4) {
            const q = points[i];
            const [, id] = guests[i % guests.length];
            const at = `lat=${q.lat}&lng=${q.lng}`;
            for (const [route, r] of [['communities', await call('GET', id, `/api/global/communities?${at}&limit=50`)], ['home', await call('GET', id, `${HOME}?${at}`)]] as const) {
                let prev = -1;
                for (const c of (r.body?.communities ?? []) as any[]) {
                    listed++;
                    const seeded = COMMUNITIES.find(s => s.key === c.key);
                    if (!seeded || c.lat !== seeded.lat || c.lng !== seeded.lng) off.push(`${route} #${i}: ${c.key} at ${c.lat},${c.lng}`);
                    const d = c.lat === null || c.lng === null ? null : km(q, c);
                    if (d === null ? c.distanceKm !== null : typeof c.distanceKm !== 'number' || Math.abs(c.distanceKm - d) > 0.05 + 1e-9) {
                        off.push(`${route} #${i}: ${c.key} distanceKm ${c.distanceKm}, from the place it shows ${d?.toFixed(3)}`);
                    }
                    if (c.distanceKm !== null && c.distanceKm < prev) off.push(`${route} #${i}: ${c.key} after one ${prev} km away`);
                    if (c.distanceKm !== null) prev = c.distanceKm;
                }
            }
        }
        assert(off.length === 0 && listed > 100, `50 points × 2 reads, ${listed} communities: each at the place it publishes, each distance from that `
            + `place and in its order${off.length ? ` — ${off.slice(0, 5).join(' | ')}` : ''}`);
    }

    async function localChecks(): Promise<void> {
        console.log('── a local node: a guest reads what the engine gives that reader, as before G9a ──');
        for (const [who, id] of [['unsigned', null], ['a non-member signer', outsider]] as const) {
            for (const p of postReads) {
                const r = await call('GET', id, p);
                const params = new URL(`https://x${p}`).searchParams;
                const want = getPosts({
                    id: params.get('id') ?? undefined, types: params.has('types') ? ['offer', 'need', 'poll', 'event'] : undefined,
                    excludeEvents: !params.get('id') && !params.has('types'), query: params.get('q') ?? undefined,
                    limit: params.has('limit') ? Number(params.get('limit')) : 50, offset: 0,
                    updatedAfter: params.get('updatedAfter') ?? undefined, viewerPubkey: id?.pk, sync: params.get('sync') === 'true', beansOnly: false,
                    audienceScope: params.get('audienceScope') ?? undefined, includeHidden: false, includeVoters: false,
                    near: params.has('lat') ? { lat: Number(params.get('lat')), lng: Number(params.get('lng')), radiusKm: params.has('radiusKm') ? Number(params.get('radiusKm')) : undefined } : undefined,
                    sortByDistance: params.get('sort') === 'distance',
                } as any);
                assert(r.status === 200 && r.text === JSON.stringify(want) && r.headers.get('x-beanpool-view') === null,
                    `${who} ${p.replace(POSTS, '')}: the engine's read for that reader, no view header`);
            }
            const list = await call('GET', id, `${POSTS}?${ALL_TYPES}`);
            assert(list.text.includes(alice.pk) && list.text.includes('SentinelAlice') && list.text.includes(String(OFFER_AT.lat)) && list.text.includes(PLACE_NAME),
                `${who}: the listings name their authors and places, as on every local node`);
            const byAuthor = await call('GET', id, `${POSTS}?author=${alice.pk}`);
            assert(byAuthor.status === 200 && Array.isArray(byAuthor.body) && byAuthor.body.length > 0, `${who}: ?author= is answered (${byAuthor.status})`);
            const probe = await call('GET', id, `/api/community/membership/${alice.pk}`);
            assert(probe.body?.callsign === 'SentinelAlice', `${who}: the membership probe names the member (${JSON.stringify(probe.body)})`);
            for (const p of ['/api/commons/decisions', '/api/commons/balance', '/api/pulse/feed']) {
                const r = await call('GET', id, p);
                assert(r.status === 200, `${who}: ${p} is public (${r.status})`);
            }
            const face = await call('GET', id, `/api/avatar/${alice.pk}?size=thumb`);
            assert(face.status === 200 && face.headers.get('content-type') === 'image/png', `${who}: a face is public by key, as before (${face.status})`);
            const ent = await call('GET', id, `/api/enterprise/${enterprise}`);
            assert(ent.status === 200 && ent.body?.keepers?.some((k: any) => k.publicKey === alice.pk) && !KEYED_FACE.test(ent.text),
                `${who}: an enterprise is public and names its keepers, as before (${ent.status})`);
            const lookup = await call('GET', id, '/api/recovery/lookup/sentinel');
            assert(Array.isArray(lookup.body) && lookup.body.length === 1 && lookup.body[0].publicKey === alice.pk && lookup.body[0].avatarUrl === TINY_PNG && !!lookup.body[0].joinedAt,
                `${who}: the recovery lookup matches a prefix, with the photo and join date, as before`);
        }
        const members = await call('GET', bob, '/api/members');
        const posts = await call('GET', bob, `${POSTS}?${ALL_TYPES}`);
        assert(members.text.includes(`/api/avatar/${alice.pk}?size=thumb&v=`) && !members.text.includes('&k=') && !posts.text.includes('&k='),
            'avatar URLs carry no key here');

        // Round 3's rules are the visitors' view's: here a signer who is no member still reads a trust profile, and a
        // code's holder still gets a member's card. A pruned account is refused every read it signs, here as on every node
        // (#1177 settles #1156's call: it passed the gated reads here until then). A HEAD to a gated read is refused as its
        // GET is on every node.
        db.prepare('UPDATE members SET invited_by = ?, elder_vouched_by = ? WHERE public_key = ?').run(bob.pk, bob.pk, alice.pk);
        const tp = await call('POST', outsider, '/api/trust/profile', { targetPubkey: alice.pk });
        assert(tp.status === 200 && tp.body?.callsign === 'SentinelAlice' && tp.body?.vouchedInBy?.publicKey === bob.pk,
            `a non-member signer reads Alice's trust profile, naming Bob who brought her in, as before (${tp.status})`);
        const code = se.generateInvite(bob.pk)!.code;
        const card = await call('POST', null, '/api/invite/redeem', { code, publicKey: alice.pk, callsign: 'Sentinel joiner' });
        assert(card.status === 200 && card.body?.alreadyMember === true && card.body?.member?.callsign === 'SentinelAlice',
            `an unsigned redeem naming Alice's key gets her card, as before (${card.status})`);
        for (const p of ['/api/members', `${POSTS}?${ALL_TYPES}`]) {
            const prunedRead = await call('GET', pruned, p);
            assert(prunedRead.status === 403 && prunedRead.body?.code === 'account_closed' && !prunedRead.text.includes(alice.pk),
                `a pruned account is refused ${p} here too, 403 account_closed, naming nobody (${prunedRead.status})`);
        }
        for (const [who, id, want] of [['unsigned', null, 401], ['a non-member signer', outsider, 403]] as const) {
            const got = await Promise.all([`/api/groups?member=${alice.pk}`, '/api/members'].map(async p => [(await call('GET', id, p)).status, (await call('HEAD', id, p)).status]));
            assert(got.every(([g, h]) => g === want && h === want), `${who}: a HEAD to a gated read is ${want}, as its GET (GET/HEAD ${got.map(x => x.join('/')).join(', ')})`);
        }
        assert(!!members.headers.get('cache-control')?.startsWith('public'), `/api/members keeps its cache header (${members.headers.get('cache-control')})`);

        // The landing card (G5), where an operator keeps the directory on a local node: the count is from each listing's
        // place, for anyone, as before G9a. The listing shows every reader that place anyway.
        db.prepare('INSERT OR REPLACE INTO node_config (key, value) VALUES (?, ?)').run('nodeProfile.directoryMirror', 'true');
        for (const [who, id] of [['unsigned', null], ['a non-member signer', outsider]] as const) {
            const counts: unknown[] = [];
            for (const d of [NEARBY_KM - 0.01, NEARBY_KM + 0.01]) {
                const q = destination(LONE_AT, d, 0);
                counts.push((await call('GET', id, `/api/global/home?lat=${q.lat}&lng=${q.lng}`)).body?.nearbyPosts?.count);
            }
            assert(counts[0] === 1 && counts[1] === 0, `${who}: the card counts the lone listing 10 m inside its own 50 km, not 10 m outside (${counts.join(', ')})`);
        }
        const attack = await bisectHome(cellOf(LONE_AT));
        const fromPlace = attack.drops.map(d => km(d, LONE_AT));
        assert(attack.ok && fromPlace.every(d => Math.abs(d - NEARBY_KM) < 0.005) && km(attack.centre, LONE_AT) < 0.005,
            `so the bisection finds the listing's place (drops ${span(fromPlace)} from it, the fit ${(km(attack.centre, LONE_AT) * 1000).toFixed(1)} m away), as before`);
        db.prepare('DELETE FROM node_config WHERE key = ?').run('nodeProfile.directoryMirror');
    }
}

main()
    .then(() => {
        console.log(`\n(requests sent ${MODE}: ${Object.values(requestsSent).reduce((a, b) => a + b, 0)} — `
            + `${Object.entries(requestsSent).sort().map(([m, n]) => `${m} ${n}`).join(', ')})`);
        console.log(`${passed}/${run} passed ${MODE}`);
        process.exit(passed === run ? 0 : 1);
    })
    .catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
