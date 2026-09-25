/**
 * The listings, not the people (global node G9a, scratch/global-node/DESIGN-g9a-guest-view-fable.md §2, §3, §5, §8).
 *
 * On the global profile a guest (an unsigned request, a key that is not a member here, a pruned account) sees each
 * listing, its photos and its rough area, and nobody: no author key, name, face or standing, no trade, no voter, no
 * typed place, no exact spot. A member sees what they always saw. Over REAL HTTPS through the real signature
 * middleware, with the node's own public-read allowlist:
 *
 *   1. the allowlists are exported, and `features.guestListingsOnly` says which kind of node this is
 *   2. the sweep: for an unsigned caller, a signed key that is not a member and a pruned account, every entry of
 *      PUBLIC_READ_EXACT (the posts listing in each of its read shapes) and one materialised example of every
 *      PUBLIC_READ_PATTERNS entry (a pattern with no example fails, so a new public route must be listed here). No body
 *      holds a member's key or name, an /api/avatar/ URL, the event's typed place or a place finer than its area; no
 *      person field (author, taker, keeper, voter, owner, key, name) holds a real value
 *   3. the guest shape: every listing there, every person neutral (`'hidden'`, `''`, null, 0), the counts kept,
 *      'pending' kept, the area for the place; direct, group and hidden posts out; one member's listings, a group's or
 *      a person's refused 403; the membership probe names only the signer; the Commons decisions, pool balance and
 *      Pulse feed for members only; `X-BeanPool-View: guest`
 *   4. a member's body is the engine's member read, byte for byte, with `X-BeanPool-View: member`
 *   5. ETag: a guest's token never gets a member a 304, a member's never gets a guest one, a key that joins or is
 *      pruned is never confirmed its old view
 *   6. the socket: an unsigned socket, and one signed by a non-member, get `{ type }` doorbells only
 *   7. precision: 200 query points (the antimeridian and both poles among them), on both nearest-first paths (circles,
 *      and one pass with a radius or a filter): each guest lat/lng is roundToArea of the place, each distance the
 *      whole km from the area, the order the order of the areas' distances, a radius holds exactly the areas inside
 *      it, and no place appears. Counted: how often the place itself would have answered differently
 *   8. a local node (NODE_PROFILE unset, in a child process): nothing changes; a guest's body is the engine's read for
 *      that reader, names, keys and places included, and no view header is sent; faces are public by key, avatar URLs
 *      carry no `k=`, and the recovery lookup matches a prefix with photos
 *   9. faces and names (G9a-2): /api/avatar/:pk without its key is 404 to anyone; the member-only key a member's
 *      members list carries opens it, unsigned as an <img> asks; a wrong key, another member's, or the key of a photo
 *      since changed is 404, as is a conditional request without one; a member's listings carry keyed URLs, a guest's
 *      none. The recovery lookup matches the typed name exactly (case forgiven) with no photo or join date
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
const LOCAL_RUN = process.env.GUEST_VIEW_LOCAL === '1';
if (LOCAL_RUN) delete process.env.NODE_PROFILE;
else process.env.NODE_PROFILE = 'global';

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const MODE = LOCAL_RUN ? '[local]' : '[global]';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${MODE} ${msg}`);
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let BASE = '';

// ── the reference rules: this suite's own copies ────────────────────────────────────────────────
const R_KM = 6371;
const rad = (d: number) => d * Math.PI / 180;
function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
    return R_KM * 2 * Math.atan2(Math.sqrt(Math.min(1, a)), Math.sqrt(Math.max(0, 1 - a)));
}
/** A place's area: 0.1° to the nearest step, halves up (design §5). */
const area = (deg: number) => Math.round(deg * 10) / 10 + 0;

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
async function call(method: 'GET' | 'POST', id: Id | null, urlPath: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
    beforeCall();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = { ...extra };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${urlPath.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${urlPath}`, { method, headers, body: method === 'GET' ? undefined : raw });
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

/** The fields that name a person, and may hold only nothing, `''` or `'hidden'` for a guest. */
const PERSON_FIELDS = new Set(['authorPublicKey', 'acceptedBy', 'createdBy', 'voterPubkey', 'memberPubkey', 'ownerPubkey', 'publicKey', 'callsign',
    'authorCallsign', 'acceptedByCallsign', 'voterCallsign', 'memberCallsign', 'targetPubkey', 'assignedTo', 'authorPubkey']);

/** Every place in the body where a person field holds a real value, as `path=value`. `allow(path)` lets a route's own. */
function personValues(value: unknown, allow: (p: string) => boolean, at = '$'): string[] {
    if (Array.isArray(value)) return value.flatMap((v, i) => personValues(v, allow, `${at}[${i}]`));
    if (!value || typeof value !== 'object') return [];
    const out: string[] = [];
    for (const [k, v] of Object.entries(value)) {
        const p = `${at}.${k}`;
        if (PERSON_FIELDS.has(k) && typeof v === 'string' && v !== '' && v !== 'hidden' && !allow(p)) out.push(`${p}=${v.slice(0, 24)}`);
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
    const { db } = await import('./db/db.js');
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
        ...placed.flatMap(p => [String(p.lat), String(p.lng), p.lat.toFixed(3), p.lng.toFixed(3)])
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
    assert(info.status === 200 && info.body?.features?.guestListingsOnly === !LOCAL_RUN,
        `/api/community/info reports features.guestListingsOnly ${!LOCAL_RUN} (got ${JSON.stringify(info.body?.features?.guestListingsOnly)})`);

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
    console.log('\n── 2. the sweep: every public read, as an unsigned caller, a non-member signer and a pruned account ──');
    /** One materialised request per pattern, with what that route may echo because the caller typed it. */
    const patternExamples: Array<{ path: string; echoes?: string[] }> = [
        { path: `/api/community/membership/${alice.pk}`, echoes: [alice.pk] },
        { path: '/api/members/callsign-available/SentinelAlice', echoes: ['SentinelAlice'] },
        { path: '/api/crowdfund/projects/proj-sentinel' },
        { path: `/api/treasury/${alice.pk}`, echoes: [alice.pk] },
        { path: `/api/enterprise/${alice.pk}`, echoes: [alice.pk] },
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
    const exactReads = [...(EXACT ?? [])].flatMap(p => p === POSTS ? postReads : [p === '/api/invite/check' ? `${p}?code=NOPE-NOPE` : p]);
    const guests: Array<[string, Id | null]> = [['unsigned', null], ['a non-member signer', outsider], ['a pruned account', pruned]];
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
            if (typeof r.body === 'object' && r.body) persons.push(...personValues(r.body, allowPerson(p.split('?')[0])).map(v => `${p}: ${v}`));
        }
        assert(failures.length === 0, `${who}: none of ${n} public reads holds a member's key or name, a face URL, the typed place or a place finer than its area${failures.length ? ` — ${failures.slice(0, 6).join(' | ')}` : ''}`);
        assert(persons.length === 0, `${who}: no person field holds a real value in any of them${persons.length ? ` — ${persons.slice(0, 6).join(' | ')}` : ''}`);
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
        }
    }
    {
        const own = await call('GET', alice, `/api/community/membership/${alice.pk}`);
        assert(own.body?.callsign === 'SentinelAlice', `the membership probe, signed by that very key, names its holder (got ${JSON.stringify(own.body)})`);
        const other = await call('GET', bob, `/api/community/membership/${alice.pk}`);
        assert(other.body?.callsign === null, 'signed by another member, it names nobody either');
        for (const p of ['/api/commons/decisions', '/api/commons/decisions/dec-sentinel', '/api/commons/balance', '/api/pulse/feed']) {
            const r = await call('GET', bob, p);
            assert(r.status === 200, `a member reads ${p} (got ${r.status})`);
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
        assert(prunedNow.status === 200 && prunedNow.headers.get('x-beanpool-view') === 'guest' && !prunedNow.text.includes(alice.pk),
            `pruned, the same key sending its member ETag gets 200 and the guest view (got ${prunedNow.status})`);
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
        for (const [who, id] of [['unsigned', null], ['a non-member signer', outsider], ['a pruned account', pruned], ['a member', bob]] as const) {
            const r = await call('GET', id, keyless);
            assert(r.status === 404 && r.body?.error === 'Avatar not found', `${who}: Alice's face without its key is 404 Avatar not found (got ${r.status})`);
        }
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

    // ── 8. a local node ────────────────────────────────────────────────────────────────────────
    console.log('\n── 8. a local node: nothing changes (a fresh process, NODE_PROFILE unset) ──');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beanpool-guest-view-local-'));
    const env: NodeJS.ProcessEnv = { ...process.env, GUEST_VIEW_LOCAL: '1', BEANPOOL_DATA_DIR: dataDir };
    delete env.NODE_PROFILE;
    const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], { env, stdio: 'inherit' });
    fs.rmSync(dataDir, { recursive: true, force: true });
    assert(child.status === 0, `the local run passed (exit ${child.status})`);

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
            const lookup = await call('GET', id, '/api/recovery/lookup/sentinel');
            assert(Array.isArray(lookup.body) && lookup.body.length === 1 && lookup.body[0].publicKey === alice.pk && lookup.body[0].avatarUrl === TINY_PNG && !!lookup.body[0].joinedAt,
                `${who}: the recovery lookup matches a prefix, with the photo and join date, as before`);
        }
        const members = await call('GET', bob, '/api/members');
        const posts = await call('GET', bob, `${POSTS}?${ALL_TYPES}`);
        assert(members.text.includes(`/api/avatar/${alice.pk}?size=thumb&v=`) && !members.text.includes('&k=') && !posts.text.includes('&k='),
            'avatar URLs carry no key here');
        assert(!!members.headers.get('cache-control')?.startsWith('public'), `/api/members keeps its cache header (${members.headers.get('cache-control')})`);
    }
}

main()
    .then(() => {
        console.log(`\n${passed}/${run} passed ${MODE}`);
        process.exit(passed === run ? 0 : 1);
    })
    .catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
