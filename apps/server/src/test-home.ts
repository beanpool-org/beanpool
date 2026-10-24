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
 *  5b. the card frame (scratch/home/CARD-FRAME-DESIGN-fable.md §5.2 item 6, slice F1): a member's version-2 layout holds
 *      a saved search and a card of a type no node knows; `cards=needs,search-k7mq` builds the search from its stored
 *      settings (counted), keyed by its instance id; an instance id the layout doesn't hold is dropped from the ask, the
 *      unknown type is kept in the answer's layout and never built; with no `cards=` a card not in the list is not built;
 *      the same ask in another order is the same tag; a settings change moves the tag and a 304 still answers an unchanged
 *      Home; `community.place` is the node's location to two decimals, absent when unset, part of the tag (a move is a
 *      200, no move a 304); none on the global node
 *  5d. W3, real content in the cards (scratch/global-node/DESIGN-home-wide-and-content-fable.md §2, §5 row W3): deals
 *      rows (the listing, the other party, whose step, when), the enterprise's balance, keepers, month and latest line for
 *      its keeper, Decide rows ("You voted" the signer's own) and the first open poll's question, each group's last line
 *      (a locked one's bytes only while short, `🔒 Message` kept), four Pulse items with `publishedAt`, the member's own
 *      month on Beans (circulation fees apart), and the community's figures; a second member's deal, balance, month,
 *      notice and group line never in the first's answer (also in the read-auth-off run); the tag moves on a new group
 *      line, and on the member's own line in a chat no card shows (the chat stamp), and not on another member's trade;
 *      `cards=` still skips the new reads
 *   6. the size: the default Home under 4 KB gzipped and every card under 8 KB gzipped and 24 KB raw (§2 "Budget"), with
 *      fixture data, titles of thousands of characters included (each text is cut) and three locked group lines at
 *      their cap; each card's size and what W3 added to it printed, and what a cold landing and a 304 cost (requests,
 *      bytes, server time), the enterprise card's server time over a book of a thousand lines included
 *   7. H0b on a local node: the Beans card is each signer's own balance as the ledger holds it, and Beans and escrow stay
 *      on (and so their cards) where the ledger has moved, whatever an override says
 *   8. the other runs, each in a child process with its own node: the global profile (below), a local node with
 *      ENFORCE_READ_AUTH=false, and a fresh local node whose ledger never moved
 *      (`me.interestsUpdatedAt`, the node's stamp for the member's interests, is in `me` too: PR #1479 round 2)
 *   9. the deciding review's five findings (#1472, 950e1a15): a 300,000-character category sent through the signed
 *      listing route and a Pulse link of 300,000 characters as the harvester stores it leave the answer a few KB (A); a
 *      suspended member's `me` says `standing: 'suspended'` (C); "Coming up" is the soonest events by start, an event
 *      posted 20 days before 100 newer ones included (D); `me.firstOffer` is there whether or not `steps` is hidden (E)
 *
 * The global run (NODE_PROFILE=global, child): an unsigned reader and a key that is no member here get the visitors'
 * subset (`welcome`, find, market, events, community; no `me`, no layout, no Pulse, no `joined`, even when asked), naming
 * nobody; a member gets their own Home, with `joined` a count by area and no names, the `find` card the landing card's
 * own body, and H0b: with Beans and escrow off, no Beans card and no deals, though a balance and a deal
 * written behind the switches' back are there to show; the visitors' answer stays under 4 KB gzipped, and W3 gives it
 * nothing new but `community.listings` (every key it holds is one it held before), nor the global member's community card
 * the local figures (joined this week, events coming up, the Commons pot). And (review A, C,
 * D): a 300,000-character category leaves the visitors' answer a few KB; a disabled member gets their own `me`
 * (`standing: 'suspended'`), never `welcome`, and the visitors' view of the listings; "Coming up" within 50 km is the
 * soonest by start, read from each event's area, with 101 upcoming.
 *
 * The fresh-ledger run (a local node whose ledger never moved, child; review B): the enterprise card follows
 * `features.enterprises` (enterprises AND treasuries), so with treasuries switched off a keeper gets no enterprise card.
 *
 * The read-auth-off run (ENFORCE_READ_AUTH=false, child, H0b): the route refuses an unsigned call (401) and a non-member
 * (403) itself, and the Beans card is the signer's own whatever key the query names; and W3's privacy checks (5d) hold
 * there too.
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
// The server runs in this process with a 5 s keep-alive; the money section pays 1000 times without yielding, and on CI's
// Node 22 the next request then reused a socket the server had closed ("fetch failed", four runs on 24 Oct).
import { localFetch } from './keepalive-test-fetch.js';

const MODE = `[${RUN}]`;
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${MODE} ${msg}`);
}
const DAY = 86_400_000;
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';
/** The budget (DESIGN-home-wide-and-content-fable.md §2): the default Home under 4 KB gzipped; every card under 8 KB gzipped and 24 KB raw. */
const FOUR_KB = 4 * 1024;
const EIGHT_KB = 8 * 1024;
const EVERY_CARD_RAW = 24 * 1024;
/** A default Home's raw bytes, as before W3: every text is cut, so a default answer is a few KB whatever anyone typed. */
const DEFAULT_RAW = 16 * 1024;

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
    const res = await localFetch(`${BASE}${urlPath}`, { headers: { ...(id ? signedHeaders('GET', urlPath, '', id) : {}), ...extra } });
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
    const res = await localFetch(`${BASE}${urlPath}`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...signedHeaders('POST', urlPath, body, id) } });
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
    const { setMemberPhoto } = await import('@beanpool/engine');
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
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, area_lat, area_lng, earned_credit)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(id.pk, name, opts.status ?? 'active', opts.joinedAt ?? new Date(Date.now() - 60 * DAY).toISOString(), owner.pk,
                `INV-${name.toUpperCase()}`, opts.area?.lat ?? null, opts.area?.lng ?? null, opts.earned ?? 0);
        setMemberPhoto(db, id.pk, TINY_PNG); // the photo goes where every writer puts it (member_photos, the row's avatar_ref)
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

    /**
     * Review A: what one member could type into a listing's category before #1493 held it to 50 characters, and a feed into
     * a Pulse link. The listing is made through the route; its category is then stored as such a listing still holds it.
     */
    const HUGE = 300_000;
    const hugeCategory = `cat${'c'.repeat(HUGE)}`;
    const hugeListing = async (who: Id) => {
        const r = await postJson('/api/marketplace/posts', who, {
            type: 'offer', category: 'garden', title: 'HomeSentinel huge category', description: 'An ordinary offer', credits: 0,
            authorPublicKey: who.pk, lat: BYRON.lat + 0.01, lng: BYRON.lng + 0.01, photos: [TINY_PNG],
        });
        const id = r.body?.id ?? r.body?.post?.id;
        if (id) db.prepare('UPDATE posts SET category = ? WHERE id = ?').run(hugeCategory, id);
        assert((r.status === 200 || r.status === 201) && !!id, `setup: ${who.name}'s signed listing, stored with a ${HUGE}-character category (${r.status} ${r.text.slice(0, 120)})`);
        return id;
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

    // ── W3's fixtures and privacy checks (5d; the read-auth-off run makes the same and checks the same) ─────────────
    const monthStart = (() => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); })();
    const lastMonth = new Date(monthStart - DAY).toISOString();
    let lastLineAt = 0;
    /**
     * A payment between two parties as a settled deal moves it: through the escrow path, which a member's first trade
     * needs no earlier one for (the send gate is for a direct gift), and with no fee, so the figures are the amounts.
     */
    const pay = (from: Id, to: string, amount: number, memo: string) => se.transfer(from.pk, to, amount, memo, 'escrow', true);
    /** A chat line as the node stores one: plaintext-v1 as an older app sent it, or a sealed group line's bytes. Each one later than the last. */
    const chatLine = (conversationId: string, author: Id, text: string, sealed?: { ciphertext: string; nonce: string; metadata: string | null }) => {
        lastLineAt = Math.max(Date.now(), lastLineAt + 1);
        const id = crypto.randomUUID();
        db.prepare('INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(id, conversationId, author.pk, sealed?.ciphertext ?? Buffer.from(text).toString('base64'), sealed?.nonce ?? 'plaintext-v1', 'text',
                sealed?.metadata ?? null, new Date(lastLineAt).toISOString());
        return id;
    };
    /** A sealed group line's bytes (shape only, as group-test-payload.ts makes them) whose three parts come to `chars` characters. */
    const sealedLine = (chars: number) => {
        const nonce = `group-xc20p-v1:${crypto.randomBytes(24).toString('base64')}`;
        const metadata = '{"epoch":1}';
        const left = chars - nonce.length - metadata.length;
        const ciphertext = crypto.randomBytes(Math.ceil(left * 3 / 4) + 3).toString('base64').slice(0, left);
        return { ciphertext, nonce, metadata };
    };
    /**
     * W3's fixtures (DESIGN-home-wide-and-content-fable.md §5 row W3), made where they move no earlier section's figures:
     * Alice keeps an enterprise Bob paid this month and once last month; Bob writes a line in Alice's group; Carol has a
     * group of her own with a line, Alice not in it; Mia and Ned pay each other this month (and Ned paid Mia once last
     * month), and Ned pays Bob; a second open Decision. The payments only where Beans move (MONEY).
     */
    const w3Fixtures = async () => {
        const { ensureGroupThread } = await import('./engine/group-thread.js');
        const ent = se.createTreasury('HomeSentinel Bakery', 'bundled://sprout', 0, { leadKeeperPubkey: alice.pk });
        const carols = se.createGroup({ name: 'HomeSentinel carol circle', createdBy: carol.pk });
        ensureGroupThread(group.id);
        ensureGroupThread(carols.id);
        chatLine(carols.id, carol, 'HomeSentinel carol circle line');
        const bobsLine = chatLine(group.id, bob, 'HomeSentinel who has a ladder?');
        db.prepare(`INSERT INTO decisions (id, author_pubkey, title, description, touches, effect, franchise, status, opens_at, closes_at)
                    VALUES ('dec-home-2', ?, 'HomeSentinel bus shelter', 'A shelter', 'pool', 'grant', '1m1v', 'open', ?, ?)`)
            .run(carol.pk, new Date(Date.now() - 3600_000).toISOString(), new Date(Date.now() + 5 * DAY).toISOString()); // one open Decision an author
        const mia = member('HomeWenMia', { balance: 30, earned: 10 });
        const ned = member('HomeWenNed', { balance: 40, earned: 10 });
        if (MONEY) {
            se.reconcileLedgerFromDb();
            const backdate = (t: { id: string } | null) => { if (t) db.prepare('UPDATE transactions SET timestamp = ? WHERE id = ?').run(lastMonth, t.id); return !!t; };
            const paid = [
                backdate(pay(bob, ent.publicKey, 2, 'HomeSentinel last month')),
                !!pay(bob, ent.publicKey, 3, 'HomeSentinel for the bakery'),
                backdate(pay(ned, mia.pk, 0.65, 'HomeSentinel last month')),
                !!pay(ned, mia.pk, 4.25, 'HomeSentinel thanks'),
                !!pay(mia, ned.pk, 1.75, 'HomeSentinel back'),
                !!pay(ned, bob.pk, 2.35, 'HomeSentinel for Bob'),
            ];
            assert(paid.every(Boolean), `setup W3: Bob pays the bakery (once last month), Mia and Ned pay each other, Ned pays Bob (${paid.join(',')})`);
        }
        return { ent, carols, bobsLine, mia, ned };
    };
    type W3 = Awaited<ReturnType<typeof w3Fixtures>>;
    /** The signer's own figures for this month, read as the ledger holds them (getTransactions): circulation fees apart. */
    const ownMonthOf = (id: Id) => {
        const lines = se.getTransactions(id.pk, 500).filter(t => Date.parse(t.timestamp) >= monthStart);
        const fee = (t: { id: string; to: string }) => t.to === 'COMMONS_POOL' && t.id.startsWith('demurrage_');
        const r2 = (n: number) => Math.round(n * 100) / 100;
        return {
            trades: lines.filter(t => !fee(t)).length,
            in: r2(lines.filter(t => !fee(t) && t.to === id.pk).reduce((n, t) => n + t.amount - (t.taxFee || 0), 0)),
            out: r2(lines.filter(t => !fee(t) && t.from === id.pk).reduce((n, t) => n + t.amount, 0)),
            fees: r2(lines.filter(fee).reduce((n, t) => n + t.amount, 0)),
        };
    };
    /**
     * §2 "What never shows", as a test: a second member's deal, balance, month, notice and group line are never in the first
     * member's answer, and a group's last line is only its members'.
     */
    const w3Privacy = async (w3: W3) => {
        console.log(`\n── 5d. W3 ${MODE}: nobody else's deal, balance, month, notice or group line ──`);
        const a = await get(`/api/home?${ALL}`, alice);
        const lines = (a.body?.cards?.groups?.items ?? []).map((g: any) => g.last?.text);
        assert(a.status === 200 && lines.includes('HomeSentinel who has a ladder?') && !a.text.includes('HomeSentinel carol circle'),
            `Alice's groups carry her group's last line and never Carol's circle, which she is not in, nor its line (${JSON.stringify(lines)})`);
        const c = await get(`/api/home?${ALL}`, carol);
        assert(c.status === 200 && (c.body?.cards?.groups?.items ?? []).some((g: any) => g.last?.text === 'HomeSentinel carol circle line')
            && !c.text.includes('HomeSentinel who has a ladder?'),
            `Carol's circle's line is hers, and Alice's group's line is not (${JSON.stringify((c.body?.cards?.groups?.items ?? []).map((g: any) => g.last?.text))})`);
        const dealsWith = (r: Res) => (r.body?.cards?.deals?.items ?? []).map((d: any) => `${d.txId}:${d.with}`);
        assert(!a.text.includes('tx-home-carol') && !dealsWith(a).some((d: string) => d.includes('HomeCarol')) && !a.text.includes('HomeSentinel carol notice'),
            `Alice's deals are hers alone (${JSON.stringify(dealsWith(a))}), and Carol's notice is not in her answer`);
        if (!MONEY) return;
        const m = await get(`/api/home?${ALL}&publicKey=${w3.ned.pk}`, w3.mia);
        const ned = ownMonthOf(w3.ned);
        const nedBalance = se.getBalance(w3.ned.pk).balance;
        assert(m.status === 200 && m.body?.cards?.beans?.balance === se.getBalance(w3.mia.pk).balance && !hasNumber(m.text, nedBalance) && !hasNumber(m.text, ned.out),
            `Mia naming Ned's key gets her own Beans and month, never Ned's balance ${nedBalance} or his ${ned.out} out (${JSON.stringify(m.body?.cards?.beans)})`);
        const aMonth = a.body?.cards?.beans?.month;
        const aliceOwn = ownMonthOf(alice);
        assert(!!aMonth && aMonth.trades === aliceOwn.trades && aMonth.in === aliceOwn.in && aMonth.out === aliceOwn.out && !hasNumber(a.text, 4.25),
            `Alice's month is her own (${JSON.stringify(aMonth)}), never Mia's 4.25 in`);
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
        const head = await localFetch(`${BASE}/api/home`, { method: 'HEAD' });
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
        // Her face: the URL the members list gives her, made from her row's avatar_ref, never from the photo itself.
        const carolRef = (db.prepare('SELECT avatar_ref FROM members WHERE public_key = ?').get(carol.pk) as { avatar_ref: string | null }).avatar_ref;
        // Keyed (k=) on every node since the public-routes audit's SEC-PUB-02: a face opens only from a URL a member was handed.
        const carolFace = new RegExp(`^/api/avatar/${carol.pk}\\?size=thumb&v=${carolRef}&k=[A-Za-z0-9_-]{22}$`);
        assert(!!carolRef && carolFace.test(c.joined?.names?.[0]?.avatarUrl ?? ''),
            `joined: with her photo's URL, made from avatar_ref (${c.joined?.names?.[0]?.avatarUrl}, ref ${carolRef})`);
        assert(c.groups?.items?.some((g: any) => g.name === 'HomeSentinel garden group'), `groups: hers (${JSON.stringify(c.groups)})`);
        const pulse = c.pulse?.items ?? [];
        // Up to four since W3 (§2), and the week holds three.
        assert(pulse.length === 3 && pulse[0].category === 'garden' && /^\/api\/pulse\/items\/item-home-2\/thumbnail$/.test(pulse[0].thumbnailUrl),
            `pulse: the week's three, her starred garden first, thumbnails through the node (${JSON.stringify(pulse.map((p: any) => [p.category, p.thumbnailUrl]))})`);
        assert(c.beans?.balance === 42.5 && typeof c.beans?.room === 'number' && typeof c.beans?.tier === 'string', `beans: her own 42.5 (${JSON.stringify(c.beans)})`);
        assert(c.notices?.unseen === 1 && c.notices?.first?.id === aliceNotice && c.notices.first.line === 'A moderator kept your post.',
            `notices: hers, its first line (${JSON.stringify(c.notices)})`);
        assert(typeof c.community?.members === 'number' && c.community.members >= 5 && typeof c.community?.tradesThisMonth === 'number',
            `community: counts (${JSON.stringify(c.community)})`);
        assert(c.find === undefined && c.safety === undefined && c.interests === undefined && c.invite === undefined,
            'no find on a local node, no safety for a member who came in by invite, and nothing for the two cards with no data of their own');
        assert(JSON.stringify(r.body?.me?.interests) === '["garden"]' && JSON.stringify(r.body?.layout?.order) === '["needs","market"]',
            `me.interests and the layout, unknown ids dropped (${JSON.stringify(r.body?.me?.interests)} ${JSON.stringify(r.body?.layout)})`);
        // The node's stamp beside them (PR #1479 round 2): interests kept before it read as stamped at 1970; none kept, null.
        assert(r.body?.me?.interestsUpdatedAt === new Date(0).toISOString(),
            `me.interestsUpdatedAt: interests kept before the node stamped them read as stamped at 1970 (${r.body?.me?.interestsUpdatedAt})`);
        const bobsOwn = await get('/api/home', bob);
        assert(bobsOwn.status === 200 && bobsOwn.body?.me?.interestsUpdatedAt === null && JSON.stringify(bobsOwn.body?.me?.interests) === '[]',
            `and null for a member who keeps none (${bobsOwn.status} ${bobsOwn.body?.me?.interestsUpdatedAt})`);
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

        // A vote on removing Alice is never a vote Alice is asked to cast: she can't vote in it (the voter rule refuses her), so
        // the line would stay all week. Carol, who may vote, is asked (#2430, deciding review r4365798773).
        const carolVotes = async () => ((await get('/api/home', carol)).body?.cards?.needs?.items ?? []).find((i: any) => i.kind === 'vote')?.count ?? 0;
        const carolBefore = await carolVotes();
        db.prepare(`INSERT INTO decisions (id, author_pubkey, title, description, touches, effect, subject, franchise, status, opens_at, closes_at)
                    VALUES ('dec-home-remove-alice', 'SYSTEM', 'HomeSentinel remove alice', 'A removal', 'member', 'remove_member', ?, '1m1v', 'open', ?, ?)`)
            .run(alice.pk, new Date(Date.now() - 3600_000).toISOString(), new Date(Date.now() + 6 * DAY).toISOString()); // as a pause opens it (S2)
        const aliceNeeds = (await get('/api/home', alice)).body?.cards?.needs?.items ?? [];
        assert(!aliceNeeds.some((i: any) => i.kind === 'vote'), `a vote on removing her is no vote Alice is asked to cast (${JSON.stringify(aliceNeeds)})`);
        const carolAfter = await carolVotes();
        assert(carolAfter === carolBefore + 1, `and Carol, who may vote in it, is asked (${carolBefore} → ${carolAfter})`);
        db.prepare("DELETE FROM decisions WHERE id = 'dec-home-remove-alice'").run();
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
        // The Tips card is the apps' own (no data): asked for or not, the node assembles nothing for it and answers none.
        const tips = await get('/api/home?cards=tips', alice);
        assert(tips.status === 200 && cardsOf(tips).length === 0 && def.body?.cards?.tips === undefined && homeCardBuilds.tips === undefined,
            `tips is never a card of the answer, nor assembled (${cardsOf(tips).join(',')})`);
        const none = await get('/api/home?cards=', alice);
        assert(none.status === 200 && cardsOf(none).length === 0 && none.body?.me, '`cards=` empty: no cards, still her me and layout');
    }

    // ── 5b. the card frame ──────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 5b. the card frame: card instances, keyed by instance id ──');
    {
        const { updateLocalConfig } = await import('./config/local-config.js');
        const builds = () => ({ ...homeCardBuilds });
        const erin = member('HomeFrameErin', { area: BYRON });
        const future = { id: 'zzz-future-1', type: 'zzz-future', settings: { any: ['thing', 1, null], nested: { ü: true } } };
        const frame = (q: string, agoMs: number) => ({
            v: 2,
            cards: [{ id: 'steps', type: 'steps' }, { id: 'search-k7mq', type: 'search', settings: { q, kind: 'offer', km: 25 } }, future, { id: 'market', type: 'market' }],
            dismissed: {},
            updatedAt: new Date(Date.now() - agoMs).toISOString(),
        });
        const savedFrame = await postJson('/api/members/preferences', erin, { publicKey: erin.pk, preferences: { 'home.layout': frame('loaf', 60_000) } });
        assert(savedFrame.status === 200, `setup: Erin saves a version-2 layout with a saved search and a zzz-future card (${savedFrame.status} ${savedFrame.text.slice(0, 120)})`);
        let before = builds();
        const asked = await get('/api/home?cards=needs,search-k7mq', erin);
        let after = builds();
        const search = asked.body?.cards?.['search-k7mq'];
        assert(asked.status === 200 && JSON.stringify(cardsOf(asked)) === '["needs","search-k7mq"]' && (after.search ?? 0) === (before.search ?? 0) + 1,
            `the saved search is built once, keyed by its instance id (${cardsOf(asked).join(',')}; builds ${before.search ?? 0} → ${after.search ?? 0})`);
        assert(search?.q === 'loaf' && search?.kind === 'offer' && search?.km === 25 && search?.items?.length >= 1
            && search.items.every((i: { title: string; type: string }) => /loaf/.test(i.title) && i.type === 'offer'),
            `from the settings stored on her account: offers matching "loaf" within 25 km (${JSON.stringify(search)?.slice(0, 200)})`);
        assert(JSON.stringify(asked.body?.layout?.cards?.[2]) === JSON.stringify(future),
            `the answer's layout keeps the zzz-future card byte for byte (${JSON.stringify(asked.body?.layout?.cards?.[2])})`);
        before = builds();
        const stray = await get('/api/home?cards=needs,search-zzzz,zzz-future-1', erin);
        after = builds();
        assert(stray.status === 200 && JSON.stringify(cardsOf(stray)) === '["needs"]' && (after.search ?? 0) === (before.search ?? 0),
            `an instance id her layout doesn't hold is dropped from the ask, and the unknown type is never built (${cardsOf(stray).join(',')})`);
        before = builds();
        const plain = await get('/api/home', erin);
        after = builds();
        assert(plain.status === 200 && ['needs', 'steps', 'market', 'search-k7mq', 'community'].every(id => cardsOf(plain).includes(id) || id === 'steps' || id === 'market'),
            `with no cards=, her list is her Home (${cardsOf(plain).join(',')})`);
        assert((after.events ?? 0) === (before.events ?? 0) && (after.pulse ?? 0) === (before.pulse ?? 0) && (after.joined ?? 0) === (before.joined ?? 0)
            && (after.search ?? 0) === (before.search ?? 0) + 1 && (after.steps ?? 0) === (before.steps ?? 0) + 1 && (after.community ?? 0) === (before.community ?? 0) + 1,
            `and a card not in her list (Coming up, the Pulse, Who joined) is never assembled: events ${before.events ?? 0} → ${after.events ?? 0}`);
        const reordered = await get('/api/home?cards=search-k7mq,needs', erin);
        assert(!!asked.etag && reordered.etag === asked.etag, `the same ask in another order is the same tag (${asked.etag} / ${reordered.etag})`);
        const unchanged = await get('/api/home?cards=needs,search-k7mq', erin, { 'If-None-Match': asked.etag! });
        assert(unchanged.status === 304, `an unchanged Home is still a 304 (${unchanged.status})`);
        const resaved = await postJson('/api/members/preferences', erin, { publicKey: erin.pk, preferences: { 'home.layout': frame('rye', 30_000) } });
        const moved = await get('/api/home?cards=needs,search-k7mq', erin, { 'If-None-Match': asked.etag! });
        assert(resaved.status === 200 && moved.status === 200 && moved.etag !== asked.etag && moved.body?.cards?.['search-k7mq']?.q === 'rye'
            && moved.body.cards['search-k7mq'].items.some((i: { title: string }) => /rye/.test(i.title)),
            `a settings change moves the rows, and the tag with them (${moved.status}, ${JSON.stringify(moved.body?.cards?.['search-k7mq'])?.slice(0, 160)})`);
        const again = await get('/api/home?cards=needs,search-k7mq', erin, { 'If-None-Match': moved.etag! });
        assert(again.status === 304, `and the new tag is a 304 again (${again.status})`);
        const noPlace = await get('/api/home?cards=community', erin);
        assert(noPlace.status === 200 && !!noPlace.body?.cards?.community && !('place' in noPlace.body.cards.community),
            `community.place is absent while the node has no location (${JSON.stringify(noPlace.body?.cards?.community)})`);
        updateLocalConfig({ location: { lat: -28.55555, lng: 153.49999 } });
        const placed = await get('/api/home?cards=community', erin);
        assert(JSON.stringify(placed.body?.cards?.community?.place) === JSON.stringify({ lat: -28.56, lng: 153.5 }),
            `and the node's location to two decimals once it has one (${JSON.stringify(placed.body?.cards?.community?.place)})`);
        const status = await get('/api/local/status', null, { Origin: 'https://evil.example' });
        assert(JSON.stringify(status.body?.location) === JSON.stringify({ lat: -28.56, lng: 153.5 }),
            `/api/local/status, which answers anyone, gives the location rounded to two decimals too (${JSON.stringify(status.body?.location)})`);
        // Public-routes audit SEC-PUB-04: no wildcard, so another site's page can't read it from a visitor's browser.
        assert(status.headers.get('access-control-allow-origin') === null,
            `/api/local/status asked from another origin carries no Access-Control-Allow-Origin (${status.headers.get('access-control-allow-origin')})`);
        // F5 (the sun and moon card): the place is part of the answer's tag, so a move is a fresh answer and no move a 304.
        const samePlace = await get('/api/home?cards=community', erin, { 'If-None-Match': placed.etag! });
        assert(samePlace.status === 304, `an unchanged place is still a 304 (${samePlace.status})`);
        updateLocalConfig({ location: { lat: 64.14655, lng: -21.94263 } });
        const movedPlace = await get('/api/home?cards=community', erin, { 'If-None-Match': placed.etag! });
        assert(movedPlace.status === 200 && movedPlace.etag !== placed.etag
            && JSON.stringify(movedPlace.body?.cards?.community?.place) === JSON.stringify({ lat: 64.15, lng: -21.94 }),
            `a moved place moves the tag, rounded both ways (${movedPlace.status}, ${JSON.stringify(movedPlace.body?.cards?.community?.place)})`);
        updateLocalConfig({ location: { lat: 64.1451, lng: -21.9449 } });
        const nearby = await get('/api/home?cards=community', erin, { 'If-None-Match': movedPlace.etag! });
        assert(nearby.status === 304, `a move inside the same hundredth of a degree is no change to a member: a 304 (${nearby.status})`);
        updateLocalConfig({ location: null });
        const unplaced = await get('/api/home?cards=community', erin, { 'If-None-Match': movedPlace.etag! });
        assert(unplaced.status === 200 && !('place' in (unplaced.body?.cards?.community ?? {})), `and unset again, the place goes and the tag with it (${unplaced.status})`);
        // Public-routes audit NEW-1: the service area's centre is the manager's same pin, so anyone but an owner or admin gets
        // it to two decimals too; the owner gets it exact (the manager's Node Identity screen saves it back). With "Share
        // Location & Radius" on: off, anyone but a member, owner or admin gets none (test-share-location-off).
        {
            const { updateNodeConfig } = await import('./state-engine.js');
            updateNodeConfig({ serviceRadius: { lat: -28.55555, lng: 153.49999, radiusKm: 25 }, publishLocation: true });
            const rounded = JSON.stringify({ lat: -28.56, lng: 153.5, radiusKm: 25 });
            const areaUnsigned = await get('/api/node/config');
            assert(areaUnsigned.status === 200 && JSON.stringify(areaUnsigned.body?.serviceRadius) === rounded,
                `/api/node/config, unsigned, gives the service area's centre to two decimals (${areaUnsigned.status} ${JSON.stringify(areaUnsigned.body?.serviceRadius)})`);
            const areaMember = await get('/api/node/config', erin);
            assert(JSON.stringify(areaMember.body?.serviceRadius) === rounded,
                `and so does a member's signed read (${JSON.stringify(areaMember.body?.serviceRadius)})`);
            const { grantNodeRole } = await import('./engine/node-roles.js');
            const { mintHandshakeToken, consumeHandshakeToken } = await import('./admin-key-auth.js');
            const owner = member('HomeAreaOwner');
            grantNodeRole(owner.pk, 'owner', 'owner:password');
            const ownerSession = consumeHandshakeToken(mintHandshakeToken(owner.pk, 'owner').handshakeToken).sessionId!;
            const areaOwner = await get('/api/node/config', null, { 'X-Admin-Session': ownerSession });
            assert(areaOwner.status === 200 && JSON.stringify(areaOwner.body?.serviceRadius) === JSON.stringify({ lat: -28.55555, lng: 153.49999, radiusKm: 25 }),
                `an owner's session gets the exact centre (${areaOwner.status} ${JSON.stringify(areaOwner.body?.serviceRadius)})`);
            const areaStale = await get('/api/node/config', null, { 'X-Admin-Session': 'a'.repeat(64) });
            assert(areaStale.status === 200 && JSON.stringify(areaStale.body?.serviceRadius) === rounded,
                `a session the node doesn't know (a cookie that ran out) still gets the public answer, never a 401 (${areaStale.status} ${JSON.stringify(areaStale.body?.serviceRadius)})`);
            // Review of #2049, B1: with "publish location" on (the default), the directory preview gives the same centre to
            // anyone, owner included, as it is what a push sends the directory (getDirectoryInfo).
            updateNodeConfig({ publishLocation: true });
            const dirUnsigned = await get('/api/directory/info');
            assert(dirUnsigned.status === 200 && JSON.stringify(dirUnsigned.body?.serviceRadius) === rounded,
                `/api/directory/info, unsigned, with publish location on, gives the centre to two decimals (${dirUnsigned.status} ${JSON.stringify(dirUnsigned.body?.serviceRadius)})`);
            const dirOwner = await get('/api/directory/info', null, { 'X-Admin-Session': ownerSession });
            assert(dirOwner.status === 200 && JSON.stringify(dirOwner.body?.serviceRadius) === rounded,
                `and so to an owner: it shows what a push sends (${dirOwner.status} ${JSON.stringify(dirOwner.body?.serviceRadius)})`);
            const { getDirectoryInfo } = await import('./state-engine.js');
            assert(JSON.stringify(getDirectoryInfo().serviceRadius) === rounded,
                `a push to the directory sends it to two decimals (${JSON.stringify(getDirectoryInfo().serviceRadius)})`);
            updateNodeConfig({ serviceRadius: undefined, publishLocation: undefined });
        }
        // Review of #1697, finding 2: a pending listing never takes a saved search's row. Four live matches and the two newest
        // pending: the card shows the four (main's read let the pending two take two of its five slots and showed three).
        for (let i = 0; i < 4; i++) post(bob, 'offer', 'garden', `HomeZebrafish live ${i}`);
        for (let i = 0; i < 2; i++) { const at = new Date(Date.now() + 60_000 + i * 1000).toISOString(); db.prepare("UPDATE posts SET status = 'pending', created_at = ?, updated_at = ? WHERE id = ?").run(at, at, post(bob, 'offer', 'garden', `HomeZebrafish pending ${i}`).id); }
        const zebra = { v: 2, cards: [{ id: 'search-zbra', type: 'search', settings: { q: 'HomeZebrafish', kind: 'any' } }], dismissed: {}, updatedAt: new Date(Date.now() - 20_000).toISOString() };
        const savedZebra = await postJson('/api/members/preferences', erin, { publicKey: erin.pk, preferences: { 'home.layout': zebra } });
        const zebraCard = (await get('/api/home?cards=needs,search-zbra', erin)).body?.cards?.['search-zbra'];
        assert(savedZebra.status === 200 && zebraCard?.items?.length === 4 && zebraCard.items.every((i: { title: string }) => /live/.test(i.title)) && zebraCard.more === false,
            `a saved search shows the four live matches and no pending one (${JSON.stringify(zebraCard?.items?.map((i: { title: string }) => i.title))}, more ${zebraCard?.more})`);
        // Review of #1697, finding 3: an instance stored under a card type's id with another type is built as that card type, with
        // or without cards=: one stored layout, one body per key.
        const odd = { v: 2, cards: [{ id: 'beans', type: 'search', settings: { q: 'loaf', kind: 'any' } }], dismissed: {}, updatedAt: new Date(Date.now() - 10_000).toISOString() };
        const savedOdd = await postJson('/api/members/preferences', erin, { publicKey: erin.pk, preferences: { 'home.layout': odd } });
        const listed = (await get('/api/home', erin)).body?.cards?.beans;
        const askedBeans = (await get('/api/home?cards=needs,beans', erin)).body?.cards?.beans;
        assert(savedOdd.status === 200 && !!listed && JSON.stringify(listed) === JSON.stringify(askedBeans) && !('q' in listed),
            `a 'beans' id stored with another type is the Beans card both ways (${JSON.stringify(listed)?.slice(0, 120)} / ${JSON.stringify(askedBeans)?.slice(0, 120)})`);
    }

    // ── 5c. a saved search is the Market's own search ───────────────────────────────────────────────────────────
    console.log('\n── 5c. a saved search: the rows the Market\'s own search gives (slice F4, §5.2 item 19) ──');
    {
        const { searchTermsFor } = await import('@beanpool/core');
        // A place nobody else lists near, so only these listings are within 5 km of it; each a little further than the last.
        const FAR = { lat: -29.5, lng: 152.0 };
        const fay = member('HomeSearchFay', { area: FAR });
        const gus = member('HomeSearchGus'); // no area: no point
        const at = (author: Id, type: 'offer' | 'need', title: string, dLat: number) =>
            se.createPost(type, 'food', title, `${title} description`, MONEY ? 5 : 0, 'fixed', author.pk, FAR.lat + dLat, FAR.lng, [TINY_PNG], false, undefined, false, {} as any)!;
        // The nearest is a need with "chicken" in it and no "egg": only the synonym map (eggs → chicken) finds it.
        const coop = at(bob, 'need', 'HomeQuail chicken coop wanted', 0.001);
        const near = [1, 2, 3, 4, 5].map(i => at(bob, 'offer', `HomeQuail fresh eggs ${i}`, 0.001 + i * 0.002));
        const far = at(carol, 'offer', 'HomeQuail eggs out of town', 0.1); // ~11 km: outside 5 km, newest
        assert(!!coop && near.length === 5 && !!far, 'setup: six listings within 5 km of Fay and one ~11 km away');
        const saveSearch = (who: Id, settings: Record<string, unknown>) => postJson('/api/members/preferences', who, { publicKey: who.pk, preferences: {
            'home.layout': { v: 2, cards: [{ id: 'search-eggs', type: 'search', settings }], dismissed: {}, updatedAt: new Date(Date.now() - 5_000).toISOString() },
        } });
        // The Market's own search: a point and a radius, and no `sort`, so the node orders it as its Market does (newest
        // first; nearest first on the global profile, distanceSortDefault).
        const market = async (who: Id, q: string, point?: { lat: number; lng: number }, km?: number) => {
            const where = point ? `&lat=${point.lat}&lng=${point.lng}&radiusKm=${km}` : '';
            const res = await get(`/api/marketplace/posts?q=${encodeURIComponent(searchTermsFor(q).join(' '))}${where}&limit=50`, who);
            return { status: res.status, rows: (Array.isArray(res.body) ? res.body : []).filter((p: { type: string; status: string }) => (p.type === 'offer' || p.type === 'need') && p.status === 'active') };
        };
        const ids = (rows: { id: string }[]) => rows.map(r => r.id);

        const savedFay = await saveSearch(fay, { q: 'eggs', kind: 'any', km: 5 });
        const fayCard = (await get('/api/home?cards=needs,search-eggs', fay)).body?.cards?.['search-eggs'];
        const fayMarket = await market(fay, 'eggs', FAR, 5);
        assert(savedFay.status === 200 && fayMarket.status === 200 && fayMarket.rows.length === 6,
            `setup: the Market's search for eggs within 5 km of Fay finds six (${fayMarket.status}, ${fayMarket.rows.length})`);
        assert(JSON.stringify(ids(fayCard?.items ?? [])) === JSON.stringify(ids(fayMarket.rows).slice(0, 4)) && fayCard?.more === true,
            `the card's four rows are the Market's first four for q=eggs within 5 km, in the Market's order, and more (${JSON.stringify(fayCard?.items?.map((i: { title: string }) => i.title))}, more ${fayCard?.more})`);
        // The order is the Market's on a local community: the newest matches first (Marty's "shows its newest matches").
        // The coop is the nearest and the oldest. (Nearest first where the Market sorts so, the global run's case.)
        assert(!switches.distanceSortDefault && JSON.stringify(ids(fayCard?.items ?? [])) === JSON.stringify([...near].reverse().slice(0, 4).map(p => p.id))
            && !fayCard.items.some((i: { id: string }) => i.id === coop.id),
            `newest first within 5 km: eggs 5, 4, 3, 2, never the nearest-but-oldest coop ahead of them (${JSON.stringify(fayCard?.items?.map((i: { title: string }) => i.title))})`);
        assert(fayCard?.q === 'eggs' && fayCard?.km === 5 && !fayCard.items.some((i: { id: string }) => i.id === far.id)
            && fayCard.items.every((i: { distanceKm: number | null }) => typeof i.distanceKm === 'number' && i.distanceKm <= 5),
            `the answer keeps the words as typed and the 5 km bound: nothing from out of town (${fayCard?.q}, ${fayCard?.km})`);

        // No point: km is ignored, as the sheet hides the distance; the rows are the Market's newest-first search.
        const savedGus = await saveSearch(gus, { q: 'eggs', kind: 'any', km: 5 });
        const gusCard = (await get('/api/home?cards=needs,search-eggs', gus)).body?.cards?.['search-eggs'];
        const gusMarket = await market(gus, 'eggs');
        assert(savedGus.status === 200 && gusCard?.km === null && gusCard.items.length === 4 && gusCard.more === true
            && JSON.stringify(ids(gusCard.items)) === JSON.stringify(ids(gusMarket.rows).slice(0, 4)) && gusCard.items[0].id === far.id,
            `with no point km is ignored: the Market's own newest four, the out-of-town listing first (${JSON.stringify(gusCard?.items?.map((i: { title: string }) => i.title))})`);

        // A kind narrows as the Market's tab does: needs only.
        await saveSearch(fay, { q: 'eggs', kind: 'need', km: 5 });
        const needs = (await get('/api/home?cards=needs,search-eggs', fay)).body?.cards?.['search-eggs'];
        assert(JSON.stringify(ids(needs?.items ?? [])) === JSON.stringify([coop.id]) && needs?.more === false,
            `kind 'need' is the one need, and synonyms: "eggs" finds the chicken coop wanted, as the Market's search does (${JSON.stringify(needs?.items?.map((i: { title: string }) => i.title))})`);

        // 41 characters: the node stores a layout by shape and bounds only (F1), and the card reads the words cut to the
        // sheet's 40, so nothing longer is ever searched or answered.
        const long = `eggs ${'q'.repeat(36)}`;
        const savedLong = await saveSearch(fay, { q: long, kind: 'any', km: 5 });
        const longCard = (await get('/api/home?cards=needs,search-eggs', fay)).body?.cards?.['search-eggs'];
        assert(long.length === 41 && savedLong.status === 200 && longCard?.q === long.slice(0, 40),
            `a 41-character q is read as its first 40 (${savedLong.status}, ${longCard?.q?.length})`);

        // Words the synonym map's own object holds as properties ("constructor") are plain words, not a crash of the read.
        await saveSearch(fay, { q: 'constructor', kind: 'any' });
        const odd = await get('/api/home?cards=needs,search-eggs', fay);
        assert(odd.status === 200 && Array.isArray(odd.body?.cards?.['search-eggs']?.items),
            `a saved search for "constructor" is answered (${odd.status})`);

        // Words in any script are searched as words, and words that expand to nothing (one CJK character, punctuation
        // alone) are searched as typed: never the newest listings, unfiltered, under the member's own words (review 1716 #1).
        const eggsRu = at(bob, 'offer', 'HomeKestrel свежие яйца', 0.3);
        const garden = at(bob, 'offer', 'Jardín comunitario HomeKestrel', 0.3);
        const duck = at(bob, 'offer', 'HomeKestrel duck 蛋 by the dozen', 0.3);
        const newest = at(carol, 'offer', 'HomeKestrel spade to lend', 0.3); // the newest, and none of the words above
        assert(!!eggsRu && !!garden && !!duck && !!newest, 'setup: listings in Cyrillic, with an accent, with a CJK word, and a newest unrelated one');
        const answer = async (q: string) => {
            await saveSearch(gus, { q, kind: 'any' });
            return (await get('/api/home?cards=needs,search-eggs', gus)).body?.cards?.['search-eggs'];
        };
        const titles = (card: { items?: { title: string }[] } | undefined) => JSON.stringify(card?.items?.map(i => i.title));
        const ru = await answer('яйца');
        const ruMarket = await market(gus, 'яйца');
        assert(ru?.q === 'яйца' && JSON.stringify(ids(ru.items)) === JSON.stringify([eggsRu.id]) && ru.more === false
            && JSON.stringify(ids(ruMarket.rows)) === JSON.stringify([eggsRu.id]),
            `a saved search for "яйца" answers its listing, as the Market's search does, not the newest unrelated ones (${titles(ru)}, Market ${titles({ items: ruMarket.rows })})`);
        const es = await answer('jardín');
        assert(JSON.stringify(ids(es?.items ?? [])) === JSON.stringify([garden.id]),
            `"jardín" finds "Jardín comunitario" (${titles(es)})`);
        const zh = await answer('蛋');
        assert(JSON.stringify(ids(zh?.items ?? [])) === JSON.stringify([duck.id]) && zh?.more === false,
            `"蛋" is searched as typed: the one listing with it (${titles(zh)})`);
        const bang = await answer('!!!');
        assert(bang?.q === '!!!' && Array.isArray(bang.items) && bang.items.length === 0 && bang.more === false,
            `"!!!" answers nothing, never the newest listings unfiltered (${titles(bang)})`);
        // Quote marks alone leave nothing to ask, a NUL never reaches FTS5, and a one-character CJK word beside another
        // word is still searched (#1716 confirmation, findings 1–3).
        for (const q of ['"', "'", '"\''])
            assert((await answer(q))?.items?.length === 0, `${JSON.stringify(q)} answers nothing, never the newest listings unfiltered`);
        const nul = await answer('jardín\u0000');
        assert(JSON.stringify(ids(nul?.items ?? [])) === JSON.stringify([garden.id]), `a NUL in the words is dropped, the card still answers (${titles(nul)})`);
        const mixed = await answer('jardín 蛋');
        assert(JSON.stringify(ids(mixed?.items ?? []).sort()) === JSON.stringify([garden.id, duck.id].sort()),
            `"jardín 蛋" finds both words' listings (${titles(mixed)})`);

        // What a member may see in the Market and nothing more: a listing posted to a group Fay is not in, or to one other
        // member, is never in her saved search, though it is the newest and nearest match; the group's own member's saved
        // search finds the group's listing, as their Market does.
        const hal = member('HomeHarrierHal'); // his own layout, so no other section's Home changes under it
        const hens = se.createGroup({ name: 'HomeHarrier hens', createdBy: hal.pk });
        const groupOnly = se.createPost('offer', 'food', 'HomeHarrier eggs for the hens group', 'for the group', 0, 'fixed', hal.pk, FAR.lat + 0.0005, FAR.lng,
            [TINY_PNG], false, undefined, false, { audienceScope: 'group', targetGroupId: hens.id } as any)!;
        const toCarol = se.createPost('offer', 'food', 'HomeHarrier eggs for Carol only', 'for one', 0, 'fixed', hal.pk, FAR.lat + 0.0005, FAR.lng,
            [TINY_PNG], false, undefined, false, { audienceScope: 'direct', targetPubkey: carol.pk } as any)!;
        const open = at(hal, 'offer', 'HomeHarrier eggs for anyone', 0.0005);
        assert(!!groupOnly && !!toCarol && !!open, 'setup: a group-only, a one-member and an open listing, each "HomeHarrier", newest, within 1 km of Fay');
        await saveSearch(fay, { q: 'HomeHarrier', kind: 'any', km: 5 });
        const fayHarrier = (await get('/api/home?cards=needs,search-eggs', fay)).body?.cards?.['search-eggs'];
        const fayHarrierMarket = await market(fay, 'HomeHarrier', FAR, 5);
        assert(JSON.stringify(ids(fayHarrier?.items ?? [])) === JSON.stringify([open.id]) && fayHarrier?.more === false
            && JSON.stringify(ids(fayHarrierMarket.rows)) === JSON.stringify([open.id]),
            `members-only as the Market: Fay's saved search shows the open listing alone, never the group's or Carol's (${titles(fayHarrier)}, Market ${titles({ items: fayHarrierMarket.rows })})`);
        await saveSearch(hal, { q: 'HomeHarrier', kind: 'any' });
        const halHarrier = (await get('/api/home?cards=needs,search-eggs', hal)).body?.cards?.['search-eggs'];
        assert(ids(halHarrier?.items ?? []).includes(groupOnly.id) && ids(halHarrier?.items ?? []).includes(open.id),
            `the group's own member finds the group's listing in their saved search, as in their Market (${titles(halHarrier)})`);
    }

    // ── 5d. W3: the cards carry real content ────────────────────────────────────────────────────────────────────
    console.log('\n── 5d. W3: each card\'s slice (DESIGN-home-wide-and-content-fable.md §2) ──');
    const w3 = await w3Fixtures();
    await w3Privacy(w3);
    {
        // Two more of the week's Pulse items, so there are five to choose four from.
        for (const i of [4, 5]) {
            db.prepare(`INSERT INTO pulse_items (id, channel_id, owner_pubkey, platform, external_id, url, title, thumbnail_url, published_at, category, source, muted, curated, created_at, updated_at)
                        VALUES (?, 'chan-home', ?, 'rss', ?, ?, ?, NULL, ?, 'food', 'autolist', 0, 0, ?, ?)`)
                .run(`item-home-${i}`, bob.pk, `ext-${i}`, `https://blog.example.org/${i}`, `HomeSentinel pulse ${i}`,
                    new Date(Date.now() - i * 3600_000).toISOString(), new Date().toISOString(), new Date().toISOString());
        }
        const r = await get(`/api/home?${ALL}`, alice);
        const c = r.body?.cards ?? {};

        // Deals: her one open deal as a row, with the other party by name and whose step it is.
        const dealRow = c.deals?.items?.[0];
        assert(c.deals?.items?.length === 1 && dealRow?.txId === 'tx-home-alice' && dealRow.postId === alicesOffer.id && dealRow.title === 'HomeSentinel alice drill'
            && dealRow.with === 'HomeBob' && dealRow.waitsOnMe === true && Number.isFinite(Date.parse(dealRow.at)) && c.deals.open === 1 && c.deals.waitingOnMe?.txId === 'tx-home-alice',
            `deals: her deal as a row, the listing, with Bob, waiting on her, since when; the counts as before (${JSON.stringify(c.deals)})`);
        const bobs = (await get(`/api/home?cards=deals`, bob)).body?.cards?.deals;
        assert(JSON.stringify(bobs?.items?.map((d: any) => [d.txId, d.with, d.waitsOnMe])) === JSON.stringify([['tx-home-carol', 'HomeCarol', true], ['tx-home-alice', 'HomeAlice', false]]),
            `Bob's two: the one waiting on him first, then the one waiting on Alice, each naming its other party (${JSON.stringify(bobs?.items)})`);

        // A deal whose listing row is gone (deciding review of #2416): Needs you still comes, its line with no bare colon.
        {
            const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(alicesOffer.id) as Record<string, unknown>;
            const fk = db.pragma('foreign_keys', { simple: true });
            db.pragma('foreign_keys = OFF');
            db.prepare('DELETE FROM posts WHERE id = ?').run(alicesOffer.id);
            try {
                const gone = (await get('/api/home?cards=needs,deals', alice)).body?.cards ?? {};
                const line = gone.needs?.items?.find((i: any) => i.kind === 'deal');
                assert(line?.label === 'A deal is waiting for you' && line.target?.txId === 'tx-home-alice' && gone.deals?.items?.[0]?.title === '',
                    `needs: a deal whose listing is gone keeps the card, "A deal is waiting for you" with no title (${JSON.stringify(gone.needs)})`);
            } finally {
                const cols = Object.keys(row);
                db.prepare(`INSERT INTO posts (${cols.join(', ')}) VALUES (${cols.map(c => '@' + c).join(', ')})`).run(row);
                db.pragma(`foreign_keys = ${fk ? 'ON' : 'OFF'}`);
            }
        }

        // The enterprise: its balance (open, #1286), keepers, this month's figures and its latest line, for its keeper.
        const e = c.enterprise;
        const entBalance = se.getBalance(w3.ent.publicKey).balance;
        assert(e?.id === w3.ent.publicKey && e.name === 'HomeSentinel Bakery' && e.keepers === 1 && e.balance === entBalance && entBalance === 5,
            `enterprise: the bakery, one keeper, its balance as the ledger holds it (${JSON.stringify(e)}, ledger ${entBalance})`);
        assert(JSON.stringify(e?.month) === JSON.stringify({ trades: 1, in: 3, out: 0 })
            && e?.latest?.amount === 3 && e.latest.who === 'HomeBob' && e.latest.kind === 'member' && Number.isFinite(Date.parse(e.latest.at)),
            `enterprise: this month one line, 3 in (last month's 2 left out), the latest +3 from Bob (${JSON.stringify(e?.month)} ${JSON.stringify(e?.latest)})`);

        // Decide: the open Decisions as rows, soonest first, "You voted" hers (she voted on the compost bay in section 4), and the poll.
        assert(JSON.stringify(c.decide?.items?.map((d: any) => [d.id, d.title, d.voted])) === JSON.stringify([['dec-home-1', 'HomeSentinel compost bay', true], ['dec-home-2', 'HomeSentinel bus shelter', false]])
            && c.decide.items.every((d: any) => Number.isFinite(Date.parse(d.closesAt))) && c.decide.open === 2,
            `decide: two rows, soonest first, voted as she voted (${JSON.stringify(c.decide?.items)})`);
        assert(c.decide?.poll?.id === poll.id && c.decide.poll.title === 'HomeSentinel which day' && Number.isFinite(Date.parse(c.decide.poll.closesAt)) && c.decide.polls === 1,
            `decide: the first open poll's question (${JSON.stringify(c.decide?.poll)})`);
        const bobsDecide = (await get('/api/home?cards=decide', bob)).body?.cards?.decide;
        assert(JSON.stringify(bobsDecide?.items?.map((d: any) => d.voted)) === '[false,false]', `and Bob's rows say he voted on neither: a ballot is its voter's own (${JSON.stringify(bobsDecide?.items)})`);

        // Groups: each group's last line, who and when.
        const garden = c.groups?.items?.find((g: any) => g.id === group.id);
        assert(garden?.last?.who === 'HomeBob' && garden.last.text === 'HomeSentinel who has a ladder?' && Number.isFinite(Date.parse(garden.last.at)) && garden.last.locked === undefined,
            `groups: her group's last line, Bob's, and when (${JSON.stringify(garden)})`);

        // Pulse: four, each with when it was published.
        const pulse = c.pulse?.items ?? [];
        assert(pulse.length === 4 && pulse[0].category === 'garden' && pulse.every((p: any) => Number.isFinite(Date.parse(p.publishedAt))),
            `pulse: four of the week's five, her starred garden first, each with publishedAt (${JSON.stringify(pulse.map((p: any) => [p.id, p.publishedAt]))})`);

        // Beans: the member's own month; Mia's, with a line from last month left out.
        const aliceMonth = ownMonthOf(alice);
        assert(c.beans?.balance === 42.5 && JSON.stringify(c.beans?.month) === JSON.stringify({ ...aliceMonth, more: false }),
            `beans: her own month as her ledger holds it (${JSON.stringify(c.beans?.month)}, ledger ${JSON.stringify(aliceMonth)})`);
        const miaBeans = (await get('/api/home?cards=beans', w3.mia)).body?.cards?.beans;
        const miaOwn = ownMonthOf(w3.mia);
        assert(miaOwn.trades === 2 && miaOwn.in === 4.25 && miaOwn.out === 1.75 && JSON.stringify(miaBeans?.month) === JSON.stringify({ ...miaOwn, more: false })
            && miaBeans?.balance === se.getBalance(w3.mia.pk).balance,
            `beans: Mia's month, 2 trades, 4.25 in, 1.75 out, last month's 0.65 left out (${JSON.stringify(miaBeans)})`);

        // A payment that carries the 1.5% fee (review of #2416): "in" on both cards is what the payee was credited, net of
        // the fee, as the latest line and the balance say it, never the amount paid. `pay` takes no fee, so these don't use it.
        const r2 = (n: number) => Math.round(n * 100) / 100;
        const [entBefore, miaBefore] = [se.getBalance(w3.ent.publicKey).balance, se.getBalance(w3.mia.pk).balance];
        const feePaid = [
            !!se.transfer(bob.pk, w3.ent.publicKey, 10, 'HomeSentinel with a fee', 'escrow'),
            !!se.transfer(w3.ned.pk, w3.mia.pk, 10, 'HomeSentinel with a fee', 'escrow'),
        ];
        const entRose = r2(se.getBalance(w3.ent.publicKey).balance - entBefore);
        const miaRose = r2(se.getBalance(w3.mia.pk).balance - miaBefore);
        assert(feePaid.every(Boolean) && entRose === 9.85 && miaRose === 9.85,
            `setup: Bob pays the bakery and Ned pays Mia 10 Beans each, the fee taken (${feePaid.join(',')}; credited ${entRose} and ${miaRose})`);
        const fe = (await get('/api/home?cards=enterprise', alice)).body?.cards?.enterprise;
        assert(fe?.month?.trades === e.month.trades + 1 && fe.month.in === r2(e.month.in + entRose) && fe.month.out === e.month.out
            && fe.latest?.amount === entRose && fe.balance === se.getBalance(w3.ent.publicKey).balance,
            `enterprise: the payment with a fee adds what the bakery was credited, ${entRose}, to this month's in, as its latest line and balance say (${JSON.stringify(fe?.month)} ${JSON.stringify(fe?.latest)}, balance ${fe?.balance})`);
        const miaFee = (await get('/api/home?cards=beans', w3.mia)).body?.cards?.beans?.month;
        assert(miaFee?.trades === miaOwn.trades + 1 && miaFee.in === r2(miaOwn.in + miaRose) && miaFee.out === miaOwn.out && miaFee.fees === miaOwn.fees,
            `beans: Mia's month adds what she was credited, ${miaRose}, not the 10 Ned paid (${JSON.stringify(miaFee)})`);

        // Community: the figures. Listings to anyone answered; the rest to a member who reads as one.
        const info = se.getPublicCommunityInfo();
        const joined7d = (db.prepare(`SELECT COUNT(*) AS c FROM members WHERE joined_at >= ? AND status = 'active' AND COALESCE(is_treasury, 0) = 0 AND COALESCE(is_visitor, 0) = 0
                                         AND length(public_key) = 64 AND public_key NOT GLOB '*[^0-9a-f]*'`).get(new Date(Date.now() - 7 * DAY).toISOString()) as { c: number }).c;
        assert(c.community?.listings === info.postCount && c.community.joined7d === joined7d && joined7d === 1 && c.community.eventsSoon === 1
            && c.community.commonsPot === Math.round(info.commonsBalance) && Number.isInteger(c.community.commonsPot),
            `community: ${info.postCount} listings, ${joined7d} joined this week (Carol), one event in the fortnight, the Commons pot in whole Beans (${JSON.stringify(c.community)})`);
        const d = await get(`/api/home?${ALL}`, dan);
        assert(d.status === 200 && d.body?.cards?.community?.listings === info.postCount
            && ['joined7d', 'eventsSoon', 'commonsPot'].every(k => !(k in (d.body?.cards?.community ?? {}))),
            `a suspended member's community card: the listings count, none of what a member reads (${JSON.stringify(d.body?.cards?.community)})`);
        // An event that is running (started an hour ago, ends in two) is coming up: counted as the Events card beside the
        // figure lists it (review of #2416), and once it has ended, in neither. Posted with a start ahead, then moved.
        const running = post(carol, 'event', 'general', 'HomeSentinel running now', {
            eventStartAt: new Date(Date.now() + DAY).toISOString(), eventEndAt: new Date(Date.now() + DAY + 3600_000).toISOString(),
        });
        db.prepare('UPDATE posts SET event_start_at = ?, event_end_at = ? WHERE id = ?')
            .run(new Date(Date.now() - 3600_000).toISOString(), new Date(Date.now() + 2 * 3600_000).toISOString(), running.id);
        const soon = (await get('/api/home?cards=events,community', alice)).body?.cards;
        const soonTitles = (soon?.events?.items ?? []).map((i: any) => i.title);
        assert(soonTitles.length === 2 && soonTitles.includes('HomeSentinel running now') && soon?.community?.eventsSoon === soonTitles.length,
            `community: a running event is among those coming up, as many as the Events card lists (${soon?.community?.eventsSoon}; ${JSON.stringify(soonTitles)})`);
        db.prepare('UPDATE posts SET event_end_at = ? WHERE id = ?').run(new Date(Date.now() - 60_000).toISOString(), running.id);
        const ended = (await get('/api/home?cards=events,community', alice)).body?.cards;
        assert(ended?.community?.eventsSoon === 1 && !(ended?.events?.items ?? []).some((i: any) => i.id === running.id),
            `and once it has ended, in neither (${ended?.community?.eventsSoon}; ${JSON.stringify((ended?.events?.items ?? []).map((i: any) => i.title))})`);
        // Nor an event the board leaves out for its host's sake (second review of #2416): a host on holiday's, a paused
        // enterprise's. Bob's in two days and the bakery's in four (posted as Carol's, then moved to the bakery, which posts
        // no events of its own here); counted as the Events card lists them at each step, then each host put back and both ended.
        const holidayEvent = post(bob, 'event', 'general', 'HomeSentinel holiday host', {
            eventStartAt: new Date(Date.now() + 2 * DAY).toISOString(), eventEndAt: new Date(Date.now() + 2 * DAY + 3600_000).toISOString(),
        });
        const pausedEvent = post(carol, 'event', 'general', 'HomeSentinel paused bakery', {
            eventStartAt: new Date(Date.now() + 4 * DAY).toISOString(), eventEndAt: new Date(Date.now() + 4 * DAY + 3600_000).toISOString(),
        });
        db.prepare('UPDATE posts SET author_pubkey = ? WHERE id = ?').run(w3.ent.publicKey, pausedEvent.id);
        const boardStep = async () => {
            const b = (await get('/api/home?cards=events,community', alice)).body?.cards;
            return { titles: (b?.events?.items ?? []).map((i: any) => i.title) as string[], soon: b?.community?.eventsSoon };
        };
        const onBoard = await boardStep();
        setPref(bob, 'holiday_mode', true);
        const onHoliday = await boardStep();
        db.prepare('UPDATE members SET paused = 1 WHERE public_key = ?').run(w3.ent.publicKey);
        const paused = await boardStep();
        db.prepare("DELETE FROM member_preferences WHERE public_key = ? AND pref_key = 'holiday_mode'").run(bob.pk);
        db.prepare('UPDATE members SET paused = 0 WHERE public_key = ?').run(w3.ent.publicKey);
        db.prepare('UPDATE posts SET event_end_at = ? WHERE id IN (?, ?)').run(new Date(Date.now() - 60_000).toISOString(), holidayEvent.id, pausedEvent.id);
        assert(onBoard.titles.length === 3 && onBoard.soon === 3,
            `setup: with every host on the board, three events in the card and in the figure (${onBoard.soon}; ${JSON.stringify(onBoard.titles)})`);
        assert(onHoliday.titles.length === 2 && !onHoliday.titles.includes('HomeSentinel holiday host') && onHoliday.soon === onHoliday.titles.length,
            `community: Bob on holiday, his event in neither the card nor the figure (${onHoliday.soon}; ${JSON.stringify(onHoliday.titles)})`);
        assert(JSON.stringify(paused.titles) === '["HomeSentinel seed swap"]' && paused.soon === 1,
            `community: the bakery paused too, its event in neither: one, the seed swap (${paused.soon}; ${JSON.stringify(paused.titles)})`);

        // Who joined this week, in the figure and on the card (second review of #2416): the figure is the community's, the
        // reader counted as `members` counts them; the Joined card is the people new to the reader, never the reader. Carol
        // joined this week; with Mia moved into the week too (and back after), Carol's card names Mia alone and her figure
        // counts both, while Alice, here for months, reads 2 on both.
        const miaJoinedAt = (db.prepare('SELECT joined_at FROM members WHERE public_key = ?').get(w3.mia.pk) as { joined_at: string }).joined_at;
        db.prepare('UPDATE members SET joined_at = ? WHERE public_key = ?').run(new Date(Date.now() - DAY).toISOString(), w3.mia.pk);
        const carolsWeek = (await get('/api/home?cards=joined,community', carol)).body?.cards;
        const alicesWeek = (await get('/api/home?cards=joined,community', alice)).body?.cards;
        db.prepare('UPDATE members SET joined_at = ? WHERE public_key = ?').run(miaJoinedAt, w3.mia.pk);
        assert(carolsWeek?.joined?.count7d === 1 && JSON.stringify(carolsWeek.joined.names?.map((n: any) => n.callsign)) === '["HomeWenMia"]'
            && carolsWeek?.community?.joined7d === 2,
            `joined: Carol, new this week herself, has Mia alone on the Joined card and both of them in the figure (${JSON.stringify(carolsWeek?.joined)}, figure ${carolsWeek?.community?.joined7d})`);
        assert(alicesWeek?.joined?.count7d === 2 && alicesWeek?.community?.joined7d === 2,
            `and Alice, here for months, 2 on both (card ${alicesWeek?.joined?.count7d}, figure ${alicesWeek?.community?.joined7d})`);

        // A locked line: its bytes while ciphertext, nonce and metadata come to 512 characters at most, "🔒 Message" always.
        const short = sealedLine(512);
        chatLine(group.id, bob, '', short);
        const lockedShort = (await get('/api/home?cards=groups', alice)).body?.cards?.groups?.items?.find((g: any) => g.id === group.id)?.last;
        assert(lockedShort?.text === '🔒 Message' && JSON.stringify(lockedShort?.locked) === JSON.stringify(short),
            `a locked line of 512 characters: "🔒 Message" and its bytes as stored, for the app to open (${JSON.stringify(lockedShort)?.slice(0, 160)})`);
        const long = sealedLine(513);
        chatLine(group.id, bob, '', long);
        const lockedLongRes = await get('/api/home?cards=groups', alice);
        const lockedLong = lockedLongRes.body?.cards?.groups?.items?.find((g: any) => g.id === group.id)?.last;
        assert(lockedLong?.text === '🔒 Message' && lockedLong?.who === 'HomeBob' && lockedLong.locked === undefined && !lockedLongRes.text.includes(long.ciphertext.slice(0, 40)),
            `one of 513: "🔒 Message" kept, its bytes nowhere in the answer (${JSON.stringify(lockedLong)})`);

        // cards= still skips the work of every card not asked for.
        const builds = () => ({ ...homeCardBuilds });
        const before = builds();
        await get('/api/home?cards=community', alice);
        const after = builds();
        assert(['deals', 'enterprise', 'decide', 'groups', 'pulse', 'beans'].every(k => (after[k] ?? 0) === (before[k] ?? 0)) && (after.community ?? 0) === (before.community ?? 0) + 1,
            `cards=community builds the community card alone: no ledger, chat, Decision or Pulse read (${JSON.stringify(after)})`);
    }
    {
        // The tag (§2 "Budget"): a new group line moves it, and so does the member's own line in a chat when no card
        // that shows it is asked for (the chat stamp); another member's trade does not, a fee to the Commons included.
        const start = await get('/api/home', alice);
        chatLine(group.id, bob, 'HomeSentinel the ladder is back');
        const moved = await get('/api/home', alice, { 'If-None-Match': start.etag! });
        assert(moved.status === 200 && moved.etag !== start.etag && moved.text.includes('HomeSentinel the ladder is back'),
            `a new line in her group moves the tag, and the answer has it (${moved.status})`);
        const needsOnly = await get('/api/home?cards=needs', alice);
        chatLine(group.id, alice, 'HomeSentinel her own line, from her laptop');
        const stamped = await get('/api/home?cards=needs', alice, { 'If-None-Match': needsOnly.etag! });
        const sansAt = (b: any) => JSON.stringify({ ...b, generatedAt: undefined });
        assert(stamped.status === 200 && stamped.etag !== needsOnly.etag && sansAt(stamped.body) === sansAt(needsOnly.body),
            `her own line moves the tag of a Home that doesn't show it (cards=needs): the chat stamp (${stamped.status}, the body ${sansAt(stamped.body) === sansAt(needsOnly.body) ? 'unchanged' : 'changed'})`);
        const steady = await get('/api/home', alice);
        const potBefore = se.getPublicCommunityInfo().commonsBalance;
        const traded = [
            !!pay(w3.ned, bob.pk, 1, 'HomeSentinel thanks'),
            !!se.transfer(w3.ned.pk, carol.pk, 1, 'HomeSentinel with a fee', 'escrow'),
        ];
        const potAfter = se.getPublicCommunityInfo().commonsBalance;
        assert(traded.every(Boolean) && potAfter > potBefore && Math.round(potAfter) === Math.round(potBefore),
            `setup: Ned pays Bob, and pays Carol with the 1.5% fee to the Commons (pot ${potBefore} → ${potAfter}, whole Beans the same)`);
        const notMoved = await get('/api/home', alice, { 'If-None-Match': steady.etag! });
        assert(notMoved.status === 304, `another member's trades leave her tag as it was: a 304 (${notMoved.status})`);
    }

    // ── 6. the size ─────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 6. the size, and what a landing costs ──');
    {
        // Titles of thousands of characters, everywhere a card shows one: each is cut. A member's new title is held to 200
        // characters since #1493, so each listing is stored with its long title as one from before then still holds it.
        const long = (s: string) => `${s} ${'x'.repeat(5000)}`;
        const storedLong = (made: { id: string }, title: string) => db.prepare('UPDATE posts SET title = ? WHERE id = ?').run(long(title), made.id);
        for (let i = 0; i < 6; i++) storedLong(post(bob, 'offer', 'garden', `HomeSentinel long ${i}`), `HomeSentinel long ${i}`);
        storedLong(post(carol, 'event', 'general', 'HomeSentinel long event', {
            eventStartAt: new Date(Date.now() + DAY).toISOString(), eventEndAt: new Date(Date.now() + DAY + 3600_000).toISOString(), eventPlaceName: 'H'.repeat(80),
        }), 'HomeSentinel long event');
        db.prepare("UPDATE groups SET name = ? WHERE id = ?").run(long('HomeSentinel group'), group.id);
        keepNotice(alice.pk, long('HomeSentinel long notice'), long('line'), { kind: 'moderation' });
        db.prepare('UPDATE pulse_items SET title = ?').run(long('HomeSentinel long pulse'));
        // W3's texts (§2 "Budget": thousand-character fixtures): the Decisions' and the poll's titles, the enterprise's
        // name, Bob's name (on her deal, his group lines, the Pulse and the enterprise's latest line) and a group line;
        // and three of her chats each ending on a locked line at its cap, whose bytes are carried (1.5 KB, incompressible).
        db.prepare("UPDATE decisions SET title = ? WHERE id IN ('dec-home-1', 'dec-home-2')").run(long('HomeSentinel long decision'));
        storedLong(poll, 'HomeSentinel long poll');
        db.prepare('UPDATE members SET callsign = ? WHERE public_key = ?').run(long('HomeSentinel bakery'), w3.ent.publicKey);
        db.prepare('UPDATE members SET callsign = ? WHERE public_key = ?').run(long('HomeBob'), bob.pk);
        const { ensureGroupThread } = await import('./engine/group-thread.js');
        const chats = [group.id, ...[1, 2].map(i => se.createGroup({ name: `HomeSentinel group ${i}`, createdBy: alice.pk }).id)];
        for (const id of chats) db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(long('HomeSentinel group'), id);
        for (const id of chats) {
            ensureGroupThread(id);
            chatLine(id, bob, long('HomeSentinel long line'));
            chatLine(id, bob, '', sealedLine(512));
        }
        const full = await get(`/api/home?${ALL}`, alice);
        const raw = Buffer.byteLength(full.text);
        const zipped = gz(full.text);
        const lockedCarried = (full.body?.cards?.groups?.items ?? []).filter((g: any) => g.last?.locked).length;
        assert(full.status === 200 && zipped < EIGHT_KB && raw < EVERY_CARD_RAW && lockedCarried === 3,
            `the whole Home, every card, ${lockedCarried} locked lines carried, is ${raw} bytes, ${zipped} gzipped: under 8 KB gzipped and 24 KB raw (§2)`);
        assert(!full.text.includes('x'.repeat(200)), 'no text in it runs past its cut');
        // Each card's size, and what W3 added to it (the card without W3's fields, measured the same way).
        const withoutW3: Record<string, (card: any) => unknown> = {
            deals: ({ items: _i, ...rest }) => rest,
            enterprise: ({ keepers: _k, balance: _b, month: _m, latest: _l, ...rest }) => rest,
            decide: ({ items: _i, poll: _p, ...rest }) => rest,
            groups: (g) => ({ ...g, items: g.items.map(({ last: _l, ...item }: any) => item) }),
            pulse: (p) => ({ ...p, items: p.items.slice(0, 2).map(({ publishedAt: _p, ...item }: any) => item) }),
            beans: ({ month: _m, ...rest }) => rest,
            community: ({ listings: _l, joined7d: _j, eventsSoon: _e, commonsPot: _c, ...rest }) => rest,
        };
        const sized = Object.entries(full.body?.cards ?? {}).map(([id, card]) => {
            const text = JSON.stringify(card);
            const before = withoutW3[id] ? JSON.stringify(withoutW3[id](card)) : text;
            return `${id} ${Buffer.byteLength(text)} B (${gz(text)} gz)${withoutW3[id] ? `, W3 +${Buffer.byteLength(text) - Buffer.byteLength(before)} B` : ''}`;
        });
        console.log(`  each card, raw (gzipped alone) and what W3 added: ${sized.join('; ')}`);
        const missing = Object.keys(withoutW3).filter(id => !(id in (full.body?.cards ?? {})));
        assert(missing.length === 0, `every card W3 fills is in the measure (${missing.length ? `missing ${missing.join(',')}` : Object.keys(withoutW3).join(',')})`);
        const fresh = member('HomeNewcomer', { joinedAt: new Date().toISOString() });
        const newcomer = await get('/api/home', fresh);
        assert(newcomer.status === 200 && gz(newcomer.text) < FOUR_KB,
            `a newcomer's default Home is ${Buffer.byteLength(newcomer.text)} B, ${gz(newcomer.text)} B gzipped: under 4 KB (§2)`);

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
        assert(gz(plain.text) < FOUR_KB && Buffer.byteLength(plain.text) < DEFAULT_RAW,
            `her default Home, every text at its longest and three locked lines in it, is ${Buffer.byteLength(plain.text)} B, ${gz(plain.text)} B gzipped: under 4 KB (§2)`);
        db.prepare('UPDATE members SET callsign = ? WHERE public_key = ?').run('HomeBob', bob.pk);

        // The enterprise card's server time over a book of a thousand lines (§7 "Not verified": getEnterpriseLedger reads
        // the enterprise's whole book, its `since` filtering in JavaScript), printed beside the card it costs.
        if (MONEY) {
            const medianOf = async (path: string, who: Id) => {
                const ms: number[] = [];
                for (let i = 0; i < 11; i++) ms.push((await get(path, who)).ms);
                return ms.sort((a, b) => a - b)[5];
            };
            const entTimes = () => medianOf('/api/home?cards=enterprise', alice);
            const bobsBeans = async () => [(db.prepare('SELECT COUNT(*) AS c FROM transactions WHERE from_pubkey = ? OR to_pubkey = ?').get(bob.pk, bob.pk) as { c: number }).c,
                await medianOf('/api/home?cards=beans', bob)];
            const [bobFewLines, bobFew] = await bobsBeans();
            // The control: a card that reads no ledger, measured beside them (the writes themselves slow every read a little).
            const control = () => medianOf('/api/home?cards=community', alice);
            const controlFew = await control();
            const lines = () => (db.prepare('SELECT COUNT(*) AS c FROM transactions WHERE from_pubkey = ? OR to_pubkey = ?').get(w3.ent.publicKey, w3.ent.publicKey) as { c: number }).c;
            const [fewLines, few] = [lines(), await entTimes()];
            const t0 = performance.now();
            let paid = 0;
            for (let i = 0; i < 1000; i++) if (pay(bob, w3.ent.publicKey, 0.01, 'HomeSentinel a penny')) paid++;
            const writeMs = performance.now() - t0;
            const [manyLines, many] = [lines(), await entTimes()];
            const book = (await get('/api/home?cards=enterprise', alice)).body?.cards?.enterprise;
            console.log(`  the enterprise card: median ${few.toFixed(1)} ms a request with ${fewLines} lines on its book, ${many.toFixed(1)} ms with ${manyLines}`
                + ` (${writeMs.toFixed(0)} ms to write them); month ${JSON.stringify(book?.month)}`);
            const [bobManyLines, bobMany] = await bobsBeans();
            const controlMany = await control();
            console.log(`  the Beans card (the payer's own month): median ${bobFew.toFixed(1)} ms with ${bobFewLines} lines in his history, ${bobMany.toFixed(1)} ms with ${bobManyLines};`
                + ` the control (cards=community, no ledger read): ${controlFew.toFixed(1)} ms before the writes, ${controlMany.toFixed(1)} ms after`);
            // 1002: this month's two lines from 5d (Bob's 3, and his 10 with the fee), then the thousand.
            assert(paid === 1000 && book?.month?.trades === 1002, `setup: a thousand more lines on the bakery's book this month (${paid}, month ${JSON.stringify(book?.month)})`);
        }

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
        assert(gz(after.text) < FOUR_KB && Buffer.byteLength(after.text) < DEFAULT_RAW && !after.text.includes('c'.repeat(200)),
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
        assert(gz(everyCard.text) < EIGHT_KB && Buffer.byteLength(everyCard.text) < EVERY_CARD_RAW && !everyCard.text.includes('c'.repeat(200)) && !everyCard.text.includes('u'.repeat(200)),
            `A: every card, both in view: ${Buffer.byteLength(everyCard.text)} B (${gz(everyCard.text)} B gz)`);

        // D: "Coming up" is the soonest by start, not the 100 most recently updated.
        const cafe = hundredAndOneEvents();
        const ev = await get('/api/home?cards=events', alice);
        const items = ev.body?.cards?.events?.items ?? [];
        const starts = items.map((i: any) => Date.parse(i.startsAt));
        assert(items[0]?.id === cafe.id && items.length === 3 && starts.every((t: number, i: number) => i === 0 || starts[i - 1] <= t),
            `D: with 101+ upcoming, the soonest first, the repair cafe posted 20 days earlier included (${items.map((i: any) => i.title.slice(13, 50)).join(' | ')})`);

        // D2 (event times slice 5): a repeating event's line carries its pattern and last date for the ↻ caption, never the
        // host's clock or each date's length; a one-off carries neither.
        db.prepare('UPDATE posts SET event_repeat = ?, event_repeat_until = ? WHERE id = ?')
            .run('{"freq":"weekly","interval":1,"byDay":"FR","time":"18:00","minutes":120}', '2027-12-17', cafe.id);
        const rep = await get('/api/home?cards=events', alice);
        const repItems = rep.body?.cards?.events?.items ?? [];
        const series = repItems.find((i: any) => i.id === cafe.id);
        assert(JSON.stringify(series?.repeat) === '{"freq":"weekly","interval":1,"byDay":"FR"}' && series?.repeatUntil === '2027-12-17'
            && repItems.filter((i: any) => i.id !== cafe.id).every((i: any) => i.repeat === undefined && i.repeatUntil === undefined),
            `D2: the series' line says how it repeats, the one-offs nothing (${JSON.stringify(series)})`);

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
            assert(gz(r.text) < FOUR_KB, `${who}: ${Buffer.byteLength(r.text)} bytes, ${gz(r.text)} gzipped, under 4 KB`);
            // W3 (§2 "What never shows"): every field a visitor's answer holds is one it held before W3, but the listings count.
            const before: Record<string, string[]> = {
                answer: ['generatedAt', 'profile', 'features', 'welcome', 'me', 'layout', 'cards'],
                community: ['name', 'members', 'communities'],
                market: ['items', 'total14d', 'more', 'examples'],
                marketItem: ['id', 'type', 'title', 'category', 'credits', 'photoUrl', 'distanceKm'],
                events: ['items', 'radiusKm'],
                eventItem: ['id', 'title', 'startsAt', 'endsAt', 'place', 'rsvp', 'distanceKm', 'startLocal', 'tz', 'online', 'repeat', 'repeatUntil'],
            };
            const extra = (o: any, keys: string[]) => Object.keys(o ?? {}).filter(k => !keys.includes(k));
            const added = [
                ...extra(r.body, before.answer), ...extra(r.body?.cards?.community, [...before.community, 'listings']),
                ...extra(r.body?.cards?.market, before.market), ...(r.body?.cards?.market?.items ?? []).flatMap((i: any) => extra(i, before.marketItem)),
                ...extra(r.body?.cards?.events, before.events), ...(r.body?.cards?.events?.items ?? []).flatMap((i: any) => extra(i, before.eventItem)),
            ];
            assert(added.length === 0 && r.body?.cards?.community?.listings === se.getPublicCommunityInfo().postCount,
                `${who}: W3 gives the visitors' answer nothing new but community.listings (${r.body?.cards?.community?.listings}${added.length ? `; new: ${added.join(',')}` : ''})`);
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
        // W3 (§2): global's figures are members, communities listed and listings; the local ones are not there.
        assert(typeof c.community?.listings === 'number' && ['joined7d', 'eventsSoon', 'commonsPot'].every(k => !(k in (c.community ?? {}))),
            `the global community card: members, communities and listings, no week's joins, events or Commons pot (${JSON.stringify(c.community)})`);
        // F5: the worldwide community has no place of its own, wherever its server is: the sun and moon card uses her area.
        const { updateLocalConfig } = await import('./config/local-config.js');
        updateLocalConfig({ location: { lat: 40.71, lng: -74.01 } });
        const placedGlobal = await get('/api/home?cards=community', alice);
        const visitorGlobal = await get(`/api/home?cards=community&lat=${BYRON.lat}&lng=${BYRON.lng}`, null);
        assert(placedGlobal.status === 200 && !!placedGlobal.body?.cards?.community && !('place' in placedGlobal.body.cards.community)
            && visitorGlobal.status === 200 && !('place' in (visitorGlobal.body?.cards?.community ?? {})),
            `no community.place on the global node, for a member or a visitor, though its config has a location (${JSON.stringify(placedGlobal.body?.cards?.community)})`);
        updateLocalConfig({ location: null });
        // A saved search on the global node: the Market's own order there, nearest first (distanceSortDefault), within km.
        {
            const OWL = { lat: -30.5, lng: 151.0 };
            const gwen = member('HomeOwlGwen', { area: OWL });
            const owl = (title: string, dLat: number) => se.createPost('offer', 'food', title, `${title} description`, 0, 'fixed', bob.pk, OWL.lat + dLat, OWL.lng,
                [TINY_PNG], false, undefined, false, {} as any)!;
            const nearOld = owl('HomeOwl eggs near', 0.001);
            const farNew = owl('HomeOwl eggs further', 0.02);
            const saved = await postJson('/api/members/preferences', gwen, { publicKey: gwen.pk, preferences: {
                'home.layout': { v: 2, cards: [{ id: 'search-owls', type: 'search', settings: { q: 'HomeOwl', kind: 'any', km: 5 } }], dismissed: {}, updatedAt: new Date(Date.now() - 5_000).toISOString() },
            } });
            const card = (await get('/api/home?cards=needs,search-owls', gwen)).body?.cards?.['search-owls'];
            const mkt = await get(`/api/marketplace/posts?q=HomeOwl&lat=${OWL.lat}&lng=${OWL.lng}&radiusKm=5&limit=50`, gwen);
            const mktIds = (Array.isArray(mkt.body) ? mkt.body : []).map((p: { id: string }) => p.id);
            assert(saved.status === 200 && JSON.stringify(card?.items?.map((i: { id: string }) => i.id)) === JSON.stringify([nearOld.id, farNew.id])
                && JSON.stringify(mktIds) === JSON.stringify([nearOld.id, farNew.id]),
                `global: a saved search is nearest first, as the Market's search is here (${JSON.stringify(card?.items?.map((i: { title: string }) => i.title))}, Market ${mktIds.length})`);
        }
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
        assert(!!vItem && vItem.category.length <= 40 && gz(v.text) < FOUR_KB && Buffer.byteLength(v.text) < DEFAULT_RAW && !v.text.includes('c'.repeat(200)),
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
        assert(on.body?.cards?.enterprise?.lifecycle === 'ongoing',
            `the card says it is an enterprise, so its heading is "Your enterprise" (${on.body?.cards?.enterprise?.lifecycle})`);
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
        // W3's privacy checks with read auth off: nobody else's deal, balance, month, notice or group line.
        await w3Privacy(await w3Fixtures());
    }
}

try {
    await main();
} catch (e: any) {
    assert(false, `threw: ${e?.stack || e}`);
}
console.log(`\n${MODE} ${passed}/${run} passed`);
process.exit(passed === run && run > 0 ? 0 : 1);
