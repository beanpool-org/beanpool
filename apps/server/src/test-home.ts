/**
 * Home in one request: GET /api/home (scratch/global-node/DESIGN-home-dashboard-fable.md §5, slices H0 and H0b). Over
 * REAL HTTPS through the real signature middleware, on a node as it ships (every ENFORCE_* variable removed).
 *
 * The local run (NODE_PROFILE unset):
 *   1. who is answered: an unsigned call 401 and a key that is no member here 403, both with code members_only; a member
 *      200 with their own `me`, their layout and their cards; a bad point and `cards` given twice are 400s
 *   2. the cards hold the member's real things: a deal waiting on them, a vote, unread from a person, a kept notice, the
 *      Market's newest with their starred category first (never fewer), events coming up, open polls, who joined (faces
 *      and names on a local node), their groups, the Pulse, their own Beans, the community's counts
 *   3. privacy: another member's deal, notice, balance and vote are never in the first member's answer, a key in the
 *      query names nobody, and a suspended member gets their own cards and none of the community's
 *   4. the ETag: a repeat with If-None-Match is a 304 with no body; the tag changes when a listing is added, when a vote
 *      is cast and when a notice is marked seen (none of which the version counters alone would see), and not when two
 *      other members pay each other; two members' tags differ
 *   5. `cards=` skips work: a card not asked for is never assembled (counted: a hidden Pulse runs no Pulse query), unknown
 *      ids are dropped, and with no `cards=` the member's own layout's hidden cards are skipped, but never `needs`
 *   6. the size: under 6 KB gzipped with fixture data, titles of thousands of characters included (each text is cut), and
 *      what a cold landing and a 304 cost (requests, bytes, server time), printed
 *   7. H0b on a local node: the Beans card is each signer's own balance as the ledger holds it, and Beans and escrow stay
 *      on (and so their cards) where the ledger has moved, whatever an override says
 *   8. the other runs, each in a child process with its own node: the global profile (below), a local node with
 *      ENFORCE_READ_AUTH=false, and a fresh local node whose ledger never moved
 *   9. the deciding review's five findings (#1472, 950e1a15): a 300,000-character category sent through the signed
 *      listing route and a Pulse link of 300,000 characters as the harvester stores it leave the answer a few KB (A); a
 *      suspended member's `me` says `standing: 'suspended'` (C); "Coming up" is the soonest events by start, an event
 *      posted 20 days before 100 newer ones included (D); `me.firstOffer` is there whether or not `steps` is hidden (E)
 *
 * The global run (NODE_PROFILE=global, child): an unsigned reader and a key that is no member here get the visitors'
 * subset (`welcome`, find, market, events, community; no `me`, no layout, no Pulse, no `joined`, even when asked), naming
 * nobody; a member gets their own Home, with `joined` a count by area and no names, the `find` card the landing card's
 * own body, and H0b: with Beans and escrow off, no Beans card and no deals, though a balance and a deal
 * written behind the switches' back are there to show; the visitors' answer stays under 6 KB gzipped. And (review A, C,
 * D): a 300,000-character category leaves the visitors' answer a few KB; a disabled member gets their own `me`
 * (`standing: 'suspended'`), never `welcome`, and the visitors' view of the listings; "Coming up" within 50 km is the
 * soonest by start, read from each event's area, with 101 upcoming.
 *
 * The fresh-ledger run (a local node whose ledger never moved, child; review B): the enterprise card follows
 * `features.enterprises` (enterprises AND treasuries), so with treasuries switched off a keeper gets no enterprise card.
 *
 * The read-auth-off run (ENFORCE_READ_AUTH=false, child, H0b): the route refuses an unsigned call (401) and a non-member
 * (403) itself, and the Beans card is the signer's own whatever key the query names.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-home.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
// Module consts read at import: settled before the dynamic imports in main().
delete process.env.ENFORCE_WS_AUTH;
delete process.env.ENFORCE_LEDGER_AUTH;
type RunKind = 'local' | 'global' | 'open-reads' | 'fresh-ledger';
const RUN: RunKind = (process.env.HOME_TEST_RUN as RunKind | undefined) || 'local';
/**
 * Beans move on this run's node: a local node. The global node's ledger never moves (its money switches are off), nor
 * does the fresh-ledger node's, so its money switches can be changed.
 */
const MONEY = RUN === 'local' || RUN === 'open-reads';
if (RUN === 'global') process.env.NODE_PROFILE = 'global';
else delete process.env.NODE_PROFILE;
if (RUN === 'open-reads') process.env.ENFORCE_READ_AUTH = 'false';
else delete process.env.ENFORCE_READ_AUTH;

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lockedDm } from './dm-test-payload.js';

const MODE = `[${RUN}]`;
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${MODE} ${msg}`);
}
const DAY = 86_400_000;
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';
const SIX_KB = 6 * 1024;

// ── the child runs: stopped with this process, however it ends ──────────────────────────────────────────────────────
const children = new Set<ChildProcess>();
const ownedDirs = new Set<string>();
process.on('exit', () => {
    for (const c of children) c.kill('SIGTERM');
    for (const d of ownedDirs) fs.rmSync(d, { recursive: true, force: true });
});
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(sig, () => process.exit(128 + os.constants.signals[sig]));
}
if (process.env.HOME_TEST_CHILD === '1') {
    if (process.env.BEANPOOL_DATA_DIR) ownedDirs.add(process.env.BEANPOOL_DATA_DIR);
    process.on('disconnect', () => process.exit(1));
    process.channel?.unref();
}

// ── keys and signed requests ────────────────────────────────────────────────────────────────────────────────────────
type Id = { pk: string; privateKey: crypto.KeyObject; name: string };
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey, name };
}
function signedHeaders(method: string, urlPath: string, body: string, id: Id): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    return {
        'X-Public-Key': id.pk,
        'X-Signature': crypto.sign(null, Buffer.from(`${method}\n${urlPath.split('?')[0]}\n${ts}\n${nonce}\n${body}`), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
}
let BASE = '';
let beforeCall: () => void = () => {};
type Res = { status: number; text: string; body: any; etag: string | null; headers: Headers; ms: number };
async function get(urlPath: string, id?: Id | null, extra: Record<string, string> = {}): Promise<Res> {
    beforeCall();
    const started = performance.now();
    const res = await fetch(`${BASE}${urlPath}`, { headers: { ...(id ? signedHeaders('GET', urlPath, '', id) : {}), ...extra } });
    const text = await res.text();
    const ms = performance.now() - started;
    let body: any;
    try { body = JSON.parse(text); } catch { /* empty (304) */ }
    return { status: res.status, text, body, etag: res.headers.get('etag'), headers: res.headers, ms };
}
/** A signed POST with a JSON body, through the real signature middleware. */
async function postJson(urlPath: string, id: Id, payload: unknown): Promise<Res> {
    beforeCall();
    const started = performance.now();
    const body = JSON.stringify(payload);
    const res = await fetch(`${BASE}${urlPath}`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...signedHeaders('POST', urlPath, body, id) } });
    const text = await res.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, body: parsed, etag: res.headers.get('etag'), headers: res.headers, ms: performance.now() - started };
}
const gz = (s: string) => zlib.gzipSync(Buffer.from(s)).length;
/** A balance as a JSON number anywhere in an answer: a bare substring also matches part of a distance or a time. */
const hasNumber = (text: string, n: number) => new RegExp(`[:\\[,]${String(n).replace('.', '\\.')}[,\\]}]`).test(text);
/** The request's own header bytes, as a client sends them (no Cloudflare in front): the floor of what any request costs. */
const headerBytes = (h: Record<string, string>) => Object.entries(h).reduce((n, [k, v]) => n + k.length + v.length + 4, 0);

async function main(): Promise<void> {
    console.log(`\n=== Home in one request (${RUN}) ===\n`);
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { keepNotice, markKeptNoticesSeen } = await import('./engine/kept-notices.js');
    // A tree without the route (origin/main) runs every step anyway, so each fails as an assertion rather than an abort.
    const homeCardBuilds: Record<string, number> = await import('./routes/home-answer.js' as string)
        .then(m => m.homeCardBuilds as Record<string, number>).catch(() => ({}));
    const { getProfileSwitches } = await import('./config/node-profile.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { pruneAuthAttempts } = await import('./auth-rate-limit.js');
    beforeCall = () => { resetGatewayRateLimit(); pruneAuthAttempts(Date.now() + 120_000); };

    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    const switches = getProfileSwitches();
    assert(switches.guestListingsOnly === (RUN === 'global'), `setup: ${RUN === 'global' ? 'the global node, with' : 'a local node, without'} the visitors' view`);

    const owner = newId('HomeOwner');
    se.seedGenesisMember(owner.pk, 'HomeOwner');
    // The node's first member, from long before this week.
    db.prepare('UPDATE members SET joined_at = ? WHERE public_key = ?').run(new Date(Date.now() - 90 * DAY).toISOString(), owner.pk);
    const member = (name: string, opts: { status?: string; balance?: number; earned?: number; joinedAt?: string; area?: { lat: number; lng: number } } = {}): Id => {
        const id = newId(name);
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, avatar_url, area_lat, area_lng, earned_credit)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(id.pk, name, opts.status ?? 'active', opts.joinedAt ?? new Date(Date.now() - 60 * DAY).toISOString(), owner.pk,
                `INV-${name.toUpperCase()}`, TINY_PNG, opts.area?.lat ?? null, opts.area?.lng ?? null, opts.earned ?? 0);
        db.prepare('INSERT OR REPLACE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, 0)').run(id.pk, MONEY ? opts.balance ?? 0 : 0);
        return id;
    };
    const BYRON = { lat: -28.6, lng: 153.6 };
    const alice = member('HomeAlice', { balance: 42.5, area: BYRON });
    const bob = member('HomeBob', { balance: 50, earned: 20, area: BYRON }); // has traded: he may send Beans
    const carol = member('HomeCarol', { balance: 7.25, joinedAt: new Date(Date.now() - 2 * DAY).toISOString(), area: { lat: -28.7, lng: 153.5 } });
    const dan = member('HomeDan', { status: 'disabled' }); // suspended: a member, who reads as a non-member while it lasts
    const outsider = newId('HomeOutsider'); // signs, but no member here
    se.reconcileLedgerFromDb();

    // Listings: Bob's food, newest, and his garden offer, older; Carol's bread; an event and a poll.
    const post = (author: Id, type: 'offer' | 'need' | 'poll' | 'event', category: string, title: string, extra: Record<string, unknown> = {}) =>
        se.createPost(type, category, title, `${title} description`, MONEY && (type === 'offer' || type === 'need') ? 5 : 0, 'fixed', author.pk,
            BYRON.lat + 0.01, BYRON.lng + 0.01, type === 'poll' ? undefined : [TINY_PNG], false, undefined, false, extra as any)!;
    const garden = post(bob, 'offer', 'garden', 'HomeSentinel seedlings');
    db.prepare('UPDATE posts SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 3 * DAY).toISOString(), garden.id);
    const foods = [1, 2, 3, 4].map(i => post(bob, 'offer', 'food', `HomeSentinel loaf ${i}`));
    const carolsBread = post(carol, 'offer', 'food', 'HomeSentinel carol rye');
    const alicesOffer = post(alice, 'offer', 'tools', 'HomeSentinel alice drill');
    const event = post(carol, 'event', 'general', 'HomeSentinel seed swap', {
        eventStartAt: new Date(Date.now() + 3 * DAY).toISOString(), eventEndAt: new Date(Date.now() + 3 * DAY + 2 * 3600_000).toISOString(),
        eventPlaceName: 'HomeSentinel Town Hall',
    });
    const poll = post(bob, 'poll', 'general', 'HomeSentinel which day', { pollOptions: [{ id: 'a', text: 'Sat' }, { id: 'b', text: 'Sun' }], durationDays: 3 });
    assert(!!garden && foods.length === 4 && !!carolsBread && !!alicesOffer && !!event && !!poll, 'setup: listings, an event and a poll');

    // Deals: Bob asks for Alice's drill (waits on her); Bob and Carol have one of their own, in progress.
    const deal = (id: string, postId: string, buyer: Id, seller: Id, status: string) =>
        db.prepare('INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status) VALUES (?, ?, ?, ?, 5, ?)')
            .run(id, postId, buyer.pk, seller.pk, status);
    if (MONEY) deal('tx-home-alice', alicesOffer.id, bob, alice, 'requested');
    if (MONEY) deal('tx-home-carol', carolsBread.id, bob, carol, 'pending');

    // A vote open now that closes in 20 hours; a DM from Bob to Alice, unread; a notice each for Alice and Carol.
    db.prepare(`INSERT INTO decisions (id, author_pubkey, title, description, touches, effect, franchise, status, opens_at, closes_at)
                VALUES ('dec-home-1', ?, 'HomeSentinel compost bay', 'A new bay', 'pool', 'grant', '1m1v', 'open', ?, ?)`)
        .run(bob.pk, new Date(Date.now() - 3600_000).toISOString(), new Date(Date.now() + 20 * 3600_000).toISOString());
    const dm = se.createConversation('dm', [bob.pk, alice.pk], bob.pk);
    if (dm) { const line = lockedDm(); se.sendMessage(dm.id, bob.pk, line.ciphertext, line.nonce); }
    const aliceNotice = keepNotice(alice.pk, 'HomeSentinel alice notice', 'A moderator kept your post.\nMore words.', { kind: 'moderation' });
    keepNotice(carol.pk, 'HomeSentinel carol notice', 'Only for Carol.', { kind: 'moderation' });

    // A group Alice is in; Pulse items from Bob's channel; Alice stars garden and hides the Pulse (and, in vain, needs).
    const group = se.createGroup({ name: 'HomeSentinel garden group', createdBy: alice.pk });
    db.prepare(`INSERT INTO creator_channels (id, owner_pubkey, platform, url, category, created_at, updated_at)
                VALUES ('chan-home', ?, 'rss', 'https://blog.example.org/feed', 'food', ?, ?)`).run(bob.pk, new Date().toISOString(), new Date().toISOString());
    for (const [i, cat] of [[1, 'food'], [2, 'garden'], [3, 'arts']] as const) {
        db.prepare(`INSERT INTO pulse_items (id, channel_id, owner_pubkey, platform, external_id, url, title, thumbnail_url, published_at, category, source, muted, curated, created_at, updated_at)
                    VALUES (?, 'chan-home', ?, 'rss', ?, ?, ?, 'https://cdn.example.org/t.jpg', ?, ?, 'autolist', 0, 0, ?, ?)`)
            .run(`item-home-${i}`, bob.pk, `ext-${i}`, `https://blog.example.org/${i}`, `HomeSentinel pulse ${i}`,
                new Date(Date.now() - i * 3600_000).toISOString(), cat, new Date().toISOString(), new Date().toISOString());
    }
    const setPref = (id: Id, key: string, value: unknown) => db.prepare(
        'INSERT INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, ?, ?) ON CONFLICT(public_key, pref_key) DO UPDATE SET pref_value = excluded.pref_value',
    ).run(id.pk, key, JSON.stringify(value));
    setPref(alice, 'interests', ['garden', 'not-a-category']);
    setPref(alice, 'home.layout', { v: 1, order: ['needs', 'market', 'bogus'], hidden: ['pulse', 'needs'], dismissed: {}, updatedAt: new Date().toISOString() });

    const setOverride = (name: string, value: string | null) => value === null
        ? db.prepare('DELETE FROM node_config WHERE key = ?').run(`nodeProfile.${name}`)
        : db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`nodeProfile.${name}`, value);
    const ALL = 'cards=needs,safety,find,steps,interests,deals,enterprise,events,market,decide,groups,joined,pulse,beans,notices,invite,community';
    const cardsOf = (r: Res) => Object.keys(r.body?.cards ?? {});

    /** Review A: what one member can type into a listing's category, and a feed into a Pulse link. */
    const HUGE = 300_000;
    const hugeCategory = `cat${'c'.repeat(HUGE)}`;
    const hugeListing = async (who: Id) => {
        const r = await postJson('/api/marketplace/posts', who, {
            type: 'offer', category: hugeCategory, title: 'HomeSentinel huge category', description: 'An ordinary offer', credits: 0,
            authorPublicKey: who.pk, lat: BYRON.lat + 0.01, lng: BYRON.lng + 0.01, photos: [TINY_PNG],
        });
        assert(r.status === 200 || r.status === 201, `setup: ${who.name}'s signed listing with a ${HUGE}-character category is accepted, as the route does (${r.status} ${r.text.slice(0, 120)})`);
        return r.body?.id ?? r.body?.post?.id;
    };
    /**
     * Review D: 101 upcoming events. "the repair cafe" starts in 12 hours and was posted (and last updated) 20 days before
     * the other 100, which 25 hosts post now, each starting 2 to 12 days out (a host may have 5 upcoming).
     */
    const hundredAndOneEvents = () => {
        const cafe = post(bob, 'event', 'general', 'HomeSentinel tomorrow: the repair cafe', {
            eventStartAt: new Date(Date.now() + 12 * 3600_000).toISOString(), eventEndAt: new Date(Date.now() + 14 * 3600_000).toISOString(),
        });
        const old = new Date(Date.now() - 20 * DAY).toISOString();
        db.prepare('UPDATE posts SET created_at = ?, updated_at = ? WHERE id = ?').run(old, old, cafe.id);
        for (let h = 0; h < 25; h++) {
            const host = member(`HomeHost${h}`, { area: BYRON });
            for (let k = 0; k < 4; k++) {
                const start = Date.now() + (2 + ((h * 4 + k) % 11)) * DAY;
                post(host, 'event', 'general', `HomeSentinel weekly market ${h}-${k}`, {
                    eventStartAt: new Date(start).toISOString(), eventEndAt: new Date(start + 3600_000).toISOString(),
                });
            }
        }
        const upcoming = (db.prepare("SELECT COUNT(*) AS c FROM posts WHERE type = 'event' AND event_start_at > ?").get(new Date().toISOString()) as { c: number }).c;
        assert(upcoming >= 101, `setup: ${upcoming} upcoming events, the repair cafe the soonest and the least recently updated`);
        return cafe;
    };

    if (RUN === 'global') return globalRun();
    if (RUN === 'open-reads') return openReadsRun();
    if (RUN === 'fresh-ledger') return freshLedgerRun();

    // ── 1. who is answered ──────────────────────────────────────────────────────────────────────────────────────
    console.log('── 1. who is answered on a local node ──');
    {
        const unsigned = await get('/api/home');
        assert(unsigned.status === 401 && unsigned.body?.code === 'members_only' && !unsigned.text.includes('HomeSentinel'),
            `an unsigned call is refused 401 members_only, naming nothing (got ${unsigned.status} ${unsigned.text.slice(0, 80)})`);
        const stranger = await get('/api/home', outsider);
        assert(stranger.status === 403 && stranger.body?.code === 'members_only' && !stranger.text.includes('HomeSentinel'),
            `a key that is no member here is refused 403 members_only (got ${stranger.status} ${stranger.text.slice(0, 80)})`);
        const head = await fetch(`${BASE}/api/home`, { method: 'HEAD' });
        assert(head.status === 401, `and a HEAD is refused as its GET (got ${head.status})`);
        const mine = await get('/api/home', alice);
        assert(mine.status === 200 && mine.body?.me?.joinedAt && mine.body?.profile === 'local' && typeof mine.body?.features?.beans === 'boolean',
            `Alice gets her Home: me, profile, features (got ${mine.status} ${mine.text.slice(0, 120)})`);
        assert(mine.body?.welcome === undefined && mine.headers.get('x-beanpool-view') === null,
            'a member\'s Home is no visitor\'s welcome, and a node with one view says nothing of views');
        assert(mine.headers.get('cache-control') === 'private, max-age=0, must-revalidate' && /^W\/"home-[0-9a-f]{24}"$/.test(mine.etag ?? ''),
            `private, revalidated, a weak tag (${mine.headers.get('cache-control')} ${mine.etag})`);
        const bad = await get('/api/home?lat=nope&lng=1', alice);
        assert(bad.status === 400 && /lat|lng/.test(bad.body?.error ?? ''), `a bad point is a 400 that names it (got ${bad.status})`);
        const twice = await get('/api/home?cards=needs&cards=market', alice);
        assert(twice.status === 400, `cards given twice is a 400 (got ${twice.status})`);
    }

    // ── 2. the cards ────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 2. the cards hold the member\'s real things ──');
    {
        const r = await get(`/api/home?${ALL}`, alice);
        const c = r.body?.cards ?? {};
        const kinds = (c.needs?.items ?? []).map((i: any) => i.kind);
        assert(kinds.includes('deal') && kinds.includes('vote') && kinds.includes('message'),
            `needs: a deal, a vote and unread from a person (${kinds.join(', ')})`);
        const dealLine = c.needs?.items?.find((i: any) => i.kind === 'deal');
        assert(dealLine?.accent === true && dealLine?.target?.txId === 'tx-home-alice' && dealLine?.label?.includes('HomeSentinel alice drill'),
            `the deal line is amber, opens her deal and names it (${JSON.stringify(dealLine)})`);
        const voteLine = c.needs?.items?.find((i: any) => i.kind === 'vote');
        assert(voteLine?.accent === true && /closes in (19|20) hours/.test(voteLine?.label ?? '') && typeof voteLine?.closesAt === 'string',
            `the vote line says when, in hours, and carries closesAt for the app to word (${voteLine?.label})`);
        const msgLine = c.needs?.items?.find((i: any) => i.kind === 'message');
        assert(msgLine?.label === 'Unread message from HomeBob' && msgLine?.target?.conversationId === dm?.id, `unread from Bob (${msgLine?.label})`);
        assert(c.deals?.open === 1 && c.deals?.waitingOnMe?.txId === 'tx-home-alice', `deals: one open, waiting on her (${JSON.stringify(c.deals)})`);
        const titles = (c.market?.items ?? []).map((i: any) => i.title);
        assert(titles.length === 4 && titles[0] === 'HomeSentinel seedlings' && c.market.items.every((i: any) => typeof i.credits === 'number' && typeof i.photoUrl === 'string'),
            `market: four, her starred garden first though older, each with Beans and a photo (${titles.join(' | ')})`);
        assert(c.market?.total14d >= 7 && c.market?.examples === undefined, `and the count of the fortnight's listings (${c.market?.total14d})`);
        assert(c.events?.items?.[0]?.id === event.id && c.events.items[0].place === 'HomeSentinel Town Hall', `events: the seed swap, with its place for a member (${JSON.stringify(c.events?.items?.[0])})`);
        assert(c.decide?.open === 1 && c.decide?.polls === 1, `decide: one Decision and one poll open (${JSON.stringify(c.decide)})`);
        assert(c.joined?.count7d === 1 && c.joined?.names?.[0]?.callsign === 'HomeCarol', `joined: Carol this week, by name (${JSON.stringify(c.joined)})`);
        assert(c.groups?.items?.some((g: any) => g.name === 'HomeSentinel garden group'), `groups: hers (${JSON.stringify(c.groups)})`);
        const pulse = c.pulse?.items ?? [];
        assert(pulse.length === 2 && pulse[0].category === 'garden' && /^\/api\/pulse\/items\/item-home-2\/thumbnail$/.test(pulse[0].thumbnailUrl),
            `pulse: two, her starred garden first, thumbnails through the node (${JSON.stringify(pulse.map((p: any) => [p.category, p.thumbnailUrl]))})`);
        assert(c.beans?.balance === 42.5 && typeof c.beans?.room === 'number' && typeof c.beans?.tier === 'string', `beans: her own 42.5 (${JSON.stringify(c.beans)})`);
        assert(c.notices?.unseen === 1 && c.notices?.first?.id === aliceNotice && c.notices.first.line === 'A moderator kept your post.',
            `notices: hers, its first line (${JSON.stringify(c.notices)})`);
        assert(typeof c.community?.members === 'number' && c.community.members >= 5 && typeof c.community?.tradesThisMonth === 'number',
            `community: counts (${JSON.stringify(c.community)})`);
        assert(c.find === undefined && c.safety === undefined && c.interests === undefined && c.invite === undefined,
            'no find on a local node, no safety for a member who came in by invite, and nothing for the two cards with no data of their own');
        assert(JSON.stringify(r.body?.me?.interests) === '["garden"]' && JSON.stringify(r.body?.layout?.order) === '["needs","market"]',
            `me.interests and the layout, unknown ids dropped (${JSON.stringify(r.body?.me?.interests)} ${JSON.stringify(r.body?.layout)})`);
        const order = cardsOf(r);
        assert(order.indexOf('needs') < order.indexOf('deals') && order.indexOf('market') < order.indexOf('pulse') && order[order.length - 1] === 'community',
            `cards in the default order, community last (${order.join(',')})`);
    }

    // ── 3. privacy ──────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 3. nobody else\'s deal, notice, balance or vote ──');
    {
        const a = await get(`/api/home?${ALL}`, alice);
        assert(!a.text.includes('tx-home-carol') && !a.text.includes('HomeSentinel carol notice') && !hasNumber(a.text, 7.25) && (a.text.match(/"balance":/g) ?? []).length === 1 && a.body?.cards?.beans?.balance === 42.5,
            "Alice's answer holds no deal, notice or balance of anyone else's");
        const b = await get(`/api/home?${ALL}&publicKey=${alice.pk}`, bob);
        assert(b.status === 200 && b.body?.cards?.beans?.balance === 50 && !hasNumber(b.text, 42.5) && !b.text.includes(aliceNotice ?? 'none') && b.body?.cards?.notices === undefined,
            `Bob naming Alice's key in the query gets his own Beans and none of her things (${b.body?.cards?.beans?.balance})`);
        assert(b.body?.cards?.deals?.open === 2 && !b.body?.cards?.needs?.items?.some((i: any) => i.kind === 'message'),
            `Bob's deals are his two, and Alice's unread is not his (${JSON.stringify(b.body?.cards?.deals)})`);
        const d = await get(`/api/home?${ALL}`, dan);
        const danCards = cardsOf(d);
        assert(d.status === 200 && ['market', 'events', 'joined', 'pulse', 'decide'].every(k => !danCards.includes(k)) && danCards.includes('community'),
            `a suspended member gets their own cards and the community's counts, none of what others post (${d.status} ${danCards.join(',')})`);
        assert(!d.text.includes('HomeSentinel') && !d.text.includes('HomeCarol'), 'naming no listing and no member');
        assert(d.body?.me?.standing === 'suspended' && d.body?.welcome === undefined && a.body?.me?.standing === 'member',
            `review C: the suspended member's me says so plainly (standing ${d.body?.me?.standing}), Alice's says member (${a.body?.me?.standing}), and nobody is invited to join`);
    }

    // ── 4. the ETag ─────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. the ETag ──');
    {
        const first = await get('/api/home', alice);
        const again = await get('/api/home', alice, { 'If-None-Match': first.etag! });
        assert(again.status === 304 && again.text === '', `a repeat with If-None-Match is a 304 with no body (got ${again.status}, ${again.text.length} bytes)`);
        const bobs = await get('/api/home', bob);
        assert(bobs.etag !== first.etag, 'two members never share a tag');
        const bobWithAlices = await get('/api/home', bob, { 'If-None-Match': first.etag! });
        assert(bobWithAlices.status === 200, "Alice's tag never gets Bob a 304");

        // Two other members pay each other: nothing of Alice's Home moves.
        const paid = se.transfer(bob.pk, carol.pk, 1, 'HomeSentinel thanks', 'escrow');
        const afterPay = await get('/api/home', alice, { 'If-None-Match': first.etag! });
        assert(!!paid && afterPay.status === 304, `Bob paying Carol leaves Alice's tag as it was: a 304 (paid ${!!paid}, got ${afterPay.status})`);

        // A listing added: the tag moves.
        post(carol, 'offer', 'food', 'HomeSentinel fresh jam');
        const afterPost = await get('/api/home', alice, { 'If-None-Match': first.etag! });
        assert(afterPost.status === 200 && afterPost.etag !== first.etag && afterPost.text.includes('HomeSentinel fresh jam'),
            `a new listing moves the tag, and the answer has it (got ${afterPost.status})`);

        // What no version counter sees: a notice marked seen, a vote cast. Each moves the tag.
        const t1 = afterPost.etag!;
        markKeptNoticesSeen(alice.pk, [aliceNotice!]);
        const afterSeen = await get('/api/home', alice, { 'If-None-Match': t1 });
        assert(afterSeen.status === 200 && afterSeen.body?.cards?.notices === undefined, `a notice marked seen moves the tag, and the card goes (got ${afterSeen.status})`);
        const t2 = afterSeen.etag!;
        db.prepare("INSERT INTO decision_votes (decision_id, voter_pubkey, support, weight, credits_used) VALUES ('dec-home-1', ?, 1, 1, 1)").run(alice.pk);
        const afterVote = await get('/api/home', alice, { 'If-None-Match': t2 });
        assert(afterVote.status === 200 && !afterVote.body?.cards?.needs?.items?.some((i: any) => i.kind === 'vote'),
            `a vote cast moves the tag, and the vote line goes (got ${afterVote.status})`);
        const steady = await get('/api/home', alice, { 'If-None-Match': afterVote.etag! });
        assert(steady.status === 304, `and with nothing else changed, a 304 again (got ${steady.status})`);
    }

    // ── 5. cards= skips work ────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 5. cards= limits the work ──');
    {
        const builds = () => ({ ...homeCardBuilds });
        let before = builds();
        const some = await get('/api/home?cards=needs,market,bogus', alice);
        let after = builds();
        assert(JSON.stringify(cardsOf(some)) === '["needs","market"]', `only the cards asked for, an unknown id dropped (${cardsOf(some).join(',')})`);
        assert((after.pulse ?? 0) === (before.pulse ?? 0) && (after.joined ?? 0) === (before.joined ?? 0) && (after.market ?? 0) === (before.market ?? 0) + 1,
            `a card not asked for is never assembled: Pulse ${before.pulse ?? 0} → ${after.pulse ?? 0}, Market +1`);
        before = builds();
        await get('/api/home?cards=pulse', alice);
        after = builds();
        assert((after.pulse ?? 0) === (before.pulse ?? 0) + 1, 'and one asked for is');
        // No cards=: her layout hides the Pulse, and needs (which can't be hidden).
        before = builds();
        const def = await get('/api/home', alice);
        after = builds();
        assert((after.pulse ?? 0) === (before.pulse ?? 0) && def.body?.cards?.pulse === undefined, 'with no cards=, her hidden Pulse runs no Pulse query');
        assert((after.needs ?? 0) === (before.needs ?? 0) + 1, 'but needs, which can\'t be hidden, is assembled');
        const none = await get('/api/home?cards=', alice);
        assert(none.status === 200 && cardsOf(none).length === 0 && none.body?.me, '`cards=` empty: no cards, still her me and layout');
    }

    // ── 6. the size ─────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 6. the size, and what a landing costs ──');
    {
        // Titles of thousands of characters, everywhere a card shows one: each is cut.
        const long = (s: string) => `${s} ${'x'.repeat(5000)}`;
        for (let i = 0; i < 6; i++) post(bob, 'offer', 'garden', long(`HomeSentinel long ${i}`));
        post(carol, 'event', 'general', long('HomeSentinel long event'), {
            eventStartAt: new Date(Date.now() + DAY).toISOString(), eventEndAt: new Date(Date.now() + DAY + 3600_000).toISOString(), eventPlaceName: 'H'.repeat(80),
        });
        db.prepare("UPDATE groups SET name = ? WHERE id = ?").run(long('HomeSentinel group'), group.id);
        keepNotice(alice.pk, long('HomeSentinel long notice'), long('line'), { kind: 'moderation' });
        db.prepare('UPDATE pulse_items SET title = ?').run(long('HomeSentinel long pulse'));
        const full = await get(`/api/home?${ALL}`, alice);
        const raw = Buffer.byteLength(full.text);
        const zipped = gz(full.text);
        assert(full.status === 200 && zipped < SIX_KB, `the whole Home, every card, is ${raw} bytes, ${zipped} gzipped: under 6 KB (§5.2)`);
        assert(!full.text.includes('x'.repeat(200)), 'no text in it runs past its cut');

        // What a landing costs, measured here (localhost, no Cloudflare): one request for the whole screen, and a 304.
        const headers = signedHeaders('GET', '/api/home', '', alice);
        const times: number[] = [];
        for (let i = 0; i < 20; i++) times.push((await get('/api/home', alice)).ms);
        const notModified = await get('/api/home', alice, { 'If-None-Match': full.etag ?? '' });
        const plain = await get('/api/home', alice);
        const n304 = await get('/api/home', alice, { 'If-None-Match': plain.etag! });
        const respHeaders = [...n304.headers.entries()].reduce((n, [k, v]) => n + k.length + v.length + 4, 0);
        times.sort((a, b) => a - b);
        console.log(`  cost: 1 request per landing; default answer ${Buffer.byteLength(plain.text)} B (${gz(plain.text)} B gz), every card ${raw} B (${zipped} B gz);`
            + ` a 304: 0 B body + ~${respHeaders} B response headers, ~${headerBytes(headers)} B signed request headers;`
            + ` median ${times[10].toFixed(1)} ms, worst ${times[19].toFixed(1)} ms a request on localhost (assembly included)`);
        assert(notModified.status === 200 && n304.status === 304, 'a stale tag gets the answer, the current one a 304');

        // Against today's landing (§5.4): the Market's first page and the header's "needs you" reads, which the phone
        // makes on opening (apps/native index.tsx, NeedsYouIcons.tsx); /api/community/info is read by both, so it is left
        // out of both. Measured on this fixture, signed as Alice.
        const today = [
            '/api/marketplace/posts?types=offer,need,poll,event&limit=50', `/api/marketplace/transactions?publicKey=${alice.pk}`,
            '/api/commons/decisions?status=open', '/api/your-groups', `/api/messages/conversations/${alice.pk}`, '/api/node-admin/me',
        ];
        let todayBytes = 0, todayGz = 0, todayOk = 0;
        for (const p of today) {
            const r = await get(p, alice);
            if (r.status === 200) todayOk++;
            todayBytes += Buffer.byteLength(r.text);
            todayGz += gz(r.text);
        }
        console.log(`  today's landing: ${today.length} signed requests, ${todayBytes} B (${todayGz} B gz) of bodies; Home: 1 signed request, `
            + `${Buffer.byteLength(plain.text)} B (${gz(plain.text)} B gz)`);
        assert(todayOk === today.length && Buffer.byteLength(plain.text) < todayBytes,
            `one Home read is fewer requests (1 against ${today.length}) and fewer bytes (${Buffer.byteLength(plain.text)} against ${todayBytes}) than today's landing reads`);
    }

    // ── 7. H0b: the money cards on a local node ─────────────────────────────────────────────────────────────────
    // A node whose ledger has moved keeps Beans and escrow on whatever an override says (config/node-profile.ts
    // lockToLedger), so the cards' switches are tested off on the global node, where they are (the global run).
    console.log('\n── 7. H0b: the money cards on a local node ──');
    {
        setOverride('beans', 'false');
        setOverride('escrow', 'false');
        const r = await get(`/api/home?${ALL}`, alice);
        assert(r.body?.features?.beans === true && r.body?.cards?.beans?.balance === 42.5 && r.body?.cards?.deals?.open === 1,
            `a local node whose ledger has moved keeps Beans and escrow on, overridden or not, and so the cards (${JSON.stringify(r.body?.cards?.beans)})`);
        setOverride('beans', null);
        setOverride('escrow', null);
        for (const id of [bob, carol]) {
            const own = (await get(`/api/home?cards=beans`, id)).body?.cards?.beans?.balance;
            const ledger = se.getBalance(id.pk).balance;
            assert(own === ledger, `${id.name}'s Beans card is ${id.name}'s own balance, as the ledger holds it (${own} = ${ledger})`);
        }
    }

    // ── 9. the deciding review's findings (#1472 at 950e1a15) ─────────────────────────────────────────────────────
    console.log('\n── 9. the deciding review\'s findings ──');
    {
        // A: a listing's category and a Pulse link are cut or left out, so the answer stays a few KB whatever anyone typed.
        const before = await get('/api/home', carol);
        const hugeId = await hugeListing(bob);
        const after = await get('/api/home', carol);
        const item = after.body?.cards?.market?.items?.find((i: any) => i.id === hugeId);
        assert(!!item && item.category.length <= 40 && item.category.startsWith('catccc'),
            `A: the listing is on Carol's Market card, its category cut to ${item?.category?.length} characters`);
        assert(gz(after.text) < SIX_KB && Buffer.byteLength(after.text) < 16 * 1024 && !after.text.includes('c'.repeat(200)),
            `A: Carol's default Home is ${Buffer.byteLength(after.text)} B (${gz(after.text)} B gz) with it, ${Buffer.byteLength(before.text)} B before: a few KB`);
        const hugeUrl = `https://blog.example.org/${'u'.repeat(HUGE)}`;
        db.prepare(`INSERT INTO pulse_items (id, channel_id, owner_pubkey, platform, external_id, url, title, thumbnail_url, published_at, category, source, muted, curated, created_at, updated_at)
                    VALUES ('item-home-huge', 'chan-home', ?, 'rss', 'ext-huge', ?, 'HomeSentinel huge link', NULL, ?, 'food', 'autolist', 0, 0, ?, ?)`)
            .run(bob.pk, hugeUrl, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
        const pulse = await get('/api/home?cards=pulse', carol);
        const huge = pulse.body?.cards?.pulse?.items?.find((i: any) => i.id === 'item-home-huge');
        assert(!!huge && huge.url === null && Buffer.byteLength(pulse.text) < 4096 && !pulse.text.includes('u'.repeat(200)),
            `A: a harvested Pulse link of ${hugeUrl.length} characters is left out (url ${huge ? (huge.url === null ? 'null' : `${String(huge.url).length} characters`) : 'item missing'}), the item kept: ${Buffer.byteLength(pulse.text)} B (${gz(pulse.text)} B gz)`);
        const everyCard = await get(`/api/home?${ALL}`, carol);
        assert(gz(everyCard.text) < SIX_KB && Buffer.byteLength(everyCard.text) < 16 * 1024 && !everyCard.text.includes('c'.repeat(200)) && !everyCard.text.includes('u'.repeat(200)),
            `A: every card, both in view: ${Buffer.byteLength(everyCard.text)} B (${gz(everyCard.text)} B gz)`);

        // D: "Coming up" is the soonest by start, not the 100 most recently updated.
        const cafe = hundredAndOneEvents();
        const ev = await get('/api/home?cards=events', alice);
        const items = ev.body?.cards?.events?.items ?? [];
        const starts = items.map((i: any) => Date.parse(i.startsAt));
        assert(items[0]?.id === cafe.id && items.length === 3 && starts.every((t: number, i: number) => i === 0 || starts[i - 1] <= t),
            `D: with 101+ upcoming, the soonest first, the repair cafe posted 20 days earlier included (${items.map((i: any) => i.title.slice(13, 50)).join(' | ')})`);

        // E: whether the first Offer is done is in `me`, whether or not the steps card is shown.
        const erin = member('HomeErin', { joinedAt: new Date(Date.now() - 40 * DAY).toISOString() });
        setPref(erin, 'home.layout', { v: 1, order: [], hidden: ['steps'], dismissed: {}, updatedAt: new Date().toISOString() });
        const e1 = await get('/api/home', erin);
        assert(e1.status === 200 && e1.body?.cards?.steps === undefined && e1.body?.features?.invites === true && e1.body?.me?.firstOffer === false,
            `E: Erin hides First steps and has no Offer: me.firstOffer ${e1.body?.me?.firstOffer} (cards ${cardsOf(e1).join(',')})`);
        post(erin, 'offer', 'tools', 'HomeSentinel erin first offer');
        const e2 = await get('/api/home', erin);
        assert(e2.body?.me?.firstOffer === true && e2.body?.cards?.steps === undefined, `E: her first Offer posted, me.firstOffer ${e2.body?.me?.firstOffer}, steps still hidden`);
        const a = await get('/api/home?cards=', alice);
        assert(a.body?.me?.firstOffer === true, `E: with no card asked for at all, Alice's me.firstOffer is there (${a.body?.me?.firstOffer})`);
    }

    // ── 8. the other runs ───────────────────────────────────────────────────────────────────────────────────────
    for (const [kind, what] of [
        ['global', 'the global profile'], ['open-reads', 'a local node with ENFORCE_READ_AUTH=false'], ['fresh-ledger', 'a local node whose ledger never moved'],
    ] as const) {
        console.log(`\n── 8. ${what}, in its own process ──`);
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `beanpool-home-${kind}-`));
        ownedDirs.add(dataDir);
        const env: NodeJS.ProcessEnv = { ...process.env, HOME_TEST_RUN: kind, HOME_TEST_CHILD: '1', BEANPOOL_DATA_DIR: dataDir };
        const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], { env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
        children.add(child);
        const status = await new Promise<number | null>(resolve => {
            child.on('exit', code => resolve(code));
            child.on('error', () => resolve(null));
        });
        children.delete(child);
        fs.rmSync(dataDir, { recursive: true, force: true });
        ownedDirs.delete(dataDir);
        assert(status === 0, `the ${kind} run passed (exit ${status})`);
    }

    // ── the global run ──────────────────────────────────────────────────────────────────────────────────────────
    async function globalRun(): Promise<void> {
        console.log('── the visitors\' Home, and a member\'s, on the global node ──');
        const memberNames = [alice, bob, carol, dan, owner].flatMap(m => [m.pk, m.name]);
        const names = (text: string) => memberNames.filter(s => text.includes(s));
        for (const [who, id] of [['an unsigned reader', null], ['a key that is no member here', outsider]] as const) {
            const r = await get(`/api/home?${ALL}&lat=${BYRON.lat}&lng=${BYRON.lng}`, id);
            const cards = cardsOf(r);
            assert(r.status === 200 && r.body?.welcome === true && r.body?.me === null && r.body?.layout === null,
                `${who}: 200, welcome, no me, no layout (got ${r.status} ${r.text.slice(0, 100)})`);
            assert(r.headers.get('x-beanpool-view') === 'guest', `${who}: the answer says it is the visitors' view (${r.headers.get('x-beanpool-view')})`);
            assert(cards.every(k => ['find', 'market', 'events', 'community'].includes(k)) && cards.includes('community') && cards.includes('find'),
                `${who}: only the visitors' cards, though every card was asked for (${cards.join(',')})`);
            assert(names(r.text).length === 0 && !r.text.includes('/api/avatar/') && !r.text.includes('HomeSentinel Town Hall'),
                `${who}: names nobody, no face, not the event's typed place (${names(r.text).join(',')})`);
            const m = r.body?.cards?.market;
            assert(Array.isArray(m?.items) && m.items.length <= 3 && m.items.every((i: any) => Number.isInteger(i.distanceKm) && i.credits === undefined),
                `${who}: at most three listings, each a whole-km distance from its area, no price where Beans are off (${JSON.stringify(m?.items?.map((i: any) => i.distanceKm))})`);
            assert(r.body?.cards?.events?.items?.[0]?.place === null && r.body?.cards?.events?.items?.[0]?.rsvp === null, `${who}: an event with no place and no RSVP`);
            const landing = await get(`/api/global/home?lat=${BYRON.lat}&lng=${BYRON.lng}`, id);
            assert(JSON.stringify(r.body?.cards?.find) === JSON.stringify(landing.body), `${who}: the find card is the landing card's own body`);
            assert(gz(r.text) < SIX_KB, `${who}: ${Buffer.byteLength(r.text)} bytes, ${gz(r.text)} gzipped, under 6 KB`);
        }
        const a = await get(`/api/home?${ALL}`, alice);
        const c = a.body?.cards ?? {};
        assert(a.status === 200 && a.body?.welcome === undefined && a.body?.me?.area?.lat === BYRON.lat, `a member gets their own Home, measured from their area (${a.status})`);
        assert(a.headers.get('x-beanpool-view') === 'member', `and the answer says it is a member's view (${a.headers.get('x-beanpool-view')})`);
        assert(c.joined?.count7d === 1 && c.joined?.radiusKm === 50 && c.joined?.names === undefined && !a.text.includes('HomeCarol'),
            `joined: a count within 50 km, no names (${JSON.stringify(c.joined)})`);
        assert(c.beans === undefined && c.deals === undefined && !c.needs?.items?.some((i: any) => i.kind === 'deal'),
            `no Beans and no deals where they are off (${cardsOf(a).join(',')})`);
        // H0b, with something to hide: a balance and a deal written behind the switches' back (the ledger "never moved"
        // is kept while Beans are configured off, config/node-profile.ts), so only the cards' own gates keep them out.
        db.prepare('UPDATE accounts SET balance = 42.5 WHERE public_key = ?').run(alice.pk);
        se.reconcileLedgerFromDb();
        db.prepare("INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status) VALUES ('tx-home-global', ?, ?, ?, 0, 'requested')")
            .run(alicesOffer.id, bob.pk, alice.pk);
        const s = getProfileSwitches();
        const gated = await get(`/api/home?${ALL}`, alice);
        assert(!s.beans && !s.escrow && se.getBalance(alice.pk).balance === 42.5, 'setup: Beans and escrow still off, Alice holding 42.5 and asked for a deal');
        assert(gated.status === 200 && gated.body?.cards?.beans === undefined && !hasNumber(gated.text, 42.5),
            `Beans off: no Beans card and her balance nowhere in her answer (${cardsOf(gated).join(',')})`);
        assert(gated.body?.cards?.deals === undefined && !gated.body?.cards?.needs?.items?.some((i: any) => i.kind === 'deal') && !gated.text.includes('tx-home-global'),
            'escrow off: no deals card and no deal line, though a deal waits on her');
        assert(c.find?.point === 'area' && typeof c.community?.communities === 'number' && c.community?.tradesThisMonth === undefined,
            `find from her area; the community card counts communities, no trades (${JSON.stringify(c.community)})`);
        const words = await get('/api/home?cards=safety', alice);
        assert(words.body?.cards?.safety === undefined, 'no safety card for a member with no 12-words row');
        db.prepare("INSERT INTO open_joins (member_pubkey, provider, join_hash, joined_at) VALUES (?, 'words', ?, ?)").run(alice.pk, `words:${crypto.randomUUID()}`, new Date().toISOString());
        const words2 = await get('/api/home?cards=safety', alice);
        assert(words2.body?.cards?.safety?.words === true, `a 12-words member gets the safety card (${JSON.stringify(words2.body?.cards)})`);
        const d = await get(`/api/home?${ALL}&lat=${BYRON.lat}&lng=${BYRON.lng}`, dan);
        assert(d.status === 200 && !cardsOf(d).includes('pulse') && !cardsOf(d).includes('joined') && d.headers.get('x-beanpool-view') === 'guest',
            `a suspended member gets the visitors' subset of the community's cards, and the answer says so (${cardsOf(d).join(',')}; ${d.headers.get('x-beanpool-view')})`);
        assert(d.body?.welcome === undefined && d.body?.me?.standing === 'suspended' && !!d.body?.me?.joinedAt,
            `review C: a disabled member is never sent the visitors' welcome (Join): their own me, standing ${d.body?.me?.standing} (welcome ${d.body?.welcome})`);
        assert(d.body?.cards?.events?.items?.[0]?.place === null && !d.text.includes('HomeSentinel Town Hall'), 'and the listings in the visitors\' view');

        // Review A on global: one listing's huge category in every nearby visitor's Home.
        const hugeId = await hugeListing(bob);
        const v = await get(`/api/home?lat=${BYRON.lat}&lng=${BYRON.lng}`, null);
        const vItem = v.body?.cards?.market?.items?.find((i: any) => i.id === hugeId);
        assert(!!vItem && vItem.category.length <= 40 && gz(v.text) < SIX_KB && Buffer.byteLength(v.text) < 16 * 1024 && !v.text.includes('c'.repeat(200)),
            `A: a visitor near the listing gets ${Buffer.byteLength(v.text)} B (${gz(v.text)} B gz), its category cut (${vItem?.category?.length ?? 'listing missing'})`);

        // Review D on global: within 50 km, from each event's area for a visitor, soonest first.
        const cafe = hundredAndOneEvents();
        for (const [who, id] of [['a visitor', null], ['a member', alice]] as const) {
            const ev = await get(`/api/home?cards=events&lat=${BYRON.lat}&lng=${BYRON.lng}`, id);
            const items = ev.body?.cards?.events?.items ?? [];
            const starts = items.map((i: any) => Date.parse(i.startsAt));
            assert(items[0]?.id === cafe.id && items.length === 3 && ev.body?.cards?.events?.radiusKm === 50 && starts.every((t: number, i: number) => i === 0 || starts[i - 1] <= t),
                `D: ${who} within 50 km, 101+ upcoming: the soonest first (${items.map((i: any) => i.title.slice(13, 50)).join(' | ')})`);
        }
    }

    // ── the fresh-ledger run ────────────────────────────────────────────────────────────────────────────────────
    async function freshLedgerRun(): Promise<void> {
        console.log('── a local node whose ledger never moved: the enterprise card follows features.enterprises ──');
        const ent = se.createTreasury('HomeSentinel Ent', 'bundled://sprout', 0, { leadKeeperPubkey: alice.pk });
        const on = await get('/api/home?cards=enterprise', alice);
        assert(on.body?.features?.enterprises === true && on.body?.cards?.enterprise?.id === ent.publicKey,
            `setup: Alice keeps HomeSentinel Ent, and with enterprises and treasuries on she gets its card (${JSON.stringify(on.body?.cards?.enterprise)})`);
        setOverride('treasuries', 'false');
        const s = getProfileSwitches();
        const off = await get('/api/home?cards=enterprise', alice);
        assert(s.enterprises && !s.treasuries && off.body?.features?.enterprises === false,
            `setup: treasuries switched off, enterprises on, so features.enterprises is false (${off.body?.features?.enterprises})`);
        assert(off.status === 200 && off.body?.cards?.enterprise === undefined,
            `review B: no enterprise card where features.enterprises is off (${JSON.stringify(off.body?.cards?.enterprise)})`);
        const page = await get(`/api/enterprise/${ent.publicKey}`, alice);
        assert(page.status === 404, `the screen the card would lead to answers 404 there (${page.status} ${page.text.slice(0, 80)})`);
        setOverride('treasuries', null);
    }

    // ── the read-auth-off run ───────────────────────────────────────────────────────────────────────────────────
    async function openReadsRun(): Promise<void> {
        console.log('── ENFORCE_READ_AUTH=false: the route holds its own line ──');
        const unsigned = await get(`/api/home?publicKey=${alice.pk}`);
        assert(unsigned.status === 401 && !hasNumber(unsigned.text, 42.5), `an unsigned call is still refused, 401 (got ${unsigned.status})`);
        const stranger = await get(`/api/home?publicKey=${alice.pk}`, outsider);
        assert(stranger.status === 403 && !hasNumber(stranger.text, 42.5), `a non-member is still refused, 403 (got ${stranger.status})`);
        const a = await get(`/api/home?${ALL}`, alice);
        assert(a.status === 200 && a.body?.cards?.beans?.balance === 42.5, `Alice's Beans are her own 42.5 (${JSON.stringify(a.body?.cards?.beans)})`);
        const b = await get(`/api/home?${ALL}&publicKey=${alice.pk}`, bob);
        assert(b.status === 200 && b.body?.cards?.beans?.balance === 50 && !hasNumber(b.text, 42.5),
            `Bob naming Alice's key gets his own 50, never her 42.5 (${JSON.stringify(b.body?.cards?.beans)})`);
    }
}

try {
    await main();
} catch (e: any) {
    assert(false, `threw: ${e?.stack || e}`);
}
console.log(`\n${MODE} ${passed}/${run} passed`);
process.exit(passed === run && run > 0 ? 0 : 1);
