/**
 * A listing's photos are its audience's, on a node whose listings are a public read too (review of #1333, 2026-09-30).
 *
 * On a local community every listing-photo URL carries its key (engine/photo-keys.ts). On a node whose listings are a
 * public read (the global profile's visitors' view, or ENFORCE_READ_AUTH=false) none did, so the photos of a GROUP's
 * listing or a listing for ONE person went to anyone holding the listing's id: 200 and the image, which also said the
 * listing was there. Now a listing's photo URLs carry the key unless the listing is on the public board, and the route
 * answers an unkeyed or wrongly keyed request for such a photo as it answers a photo that isn't there.
 *
 * Every combination runs in its own process on its own data dir, the real server over TLS through the real signature
 * middleware: `global` (NODE_PROFILE=global, this process), `open` (ENFORCE_READ_AUTH=false on a local node) and `local`
 * (the default: every listing keyed, as before; nothing changes there). Alice writes; Bob is in her group and the one
 * her direct listing is for; Carol is a member of neither; a stranger signs nothing; an outsider signs with a key that
 * is no member here.
 *
 *  0. (public-read runs) The upgrade on a node with no listing off the board with a photo: nothing to heal, and a heal
 *     under way for an earlier change (its photoKeysSince) goes on.
 *  1. (public-read runs) The upgrade on a node that has them, played as a restart over a record from before (the shape
 *     `open`): Bob's phone, which last synced before it, gets his group's and his direct listing again at its next sync,
 *     with URLs that open; Carol's gets neither. A restart that changes nothing keeps the record.
 *  2. The route: a board listing's photos open unkeyed (a public read) or not (local); a group's and a direct listing's,
 *     each photo of them, are 404 `Photo not found` unkeyed (signed or not, HEAD too), with a wrong key, with another
 *     photo's key, exactly as a listing nobody has; 200 at the URL a member's read carries. A trailing slash is refused
 *     too (401 where reads are enforced: it is outside the public-read allowlist's pattern).
 *  3. The reads: Bob's list, sync and read by id, and Alice's, carry keyed URLs for those listings, a board listing
 *     plain (a public read) or keyed (local). Carol's, a stranger's and an outsider's reads hold neither listing nor its
 *     id nor any key.
 *  4. Every other place the node emits a photo URL: the live event of an edit (to Bob's socket, keyed; Carol's and a
 *     stranger's hear no URL of it), a trade's cover (one read, and the list), an escrow dispute's photos, an event on
 *     Bob's own calendar (GET /api/events/mine), the chat list's listing photo (Bob's keyed; Carol, in a chat about a
 *     listing she can't see, gets none), and the pricing guide (a board listing's photo only, never the group's).
 *  5. An audience change. Public → group: the updated_at moves (posts_touch_updated_at), the old plain URL is 404, and
 *     Bob's next delta from before the change carries the keyed URL, which opens; Carol's delta carries none. Group →
 *     public: the plain URL opens, the keyed URL Bob held still opens, and his next delta carries the plain one.
 *  6. (public-read runs) A new secret (a restore from a backup older than it): the old keyed URL is 404, and Bob's next
 *     sync from before it heals with URLs that open.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-photo-keys-audience.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.CF_API_TOKEN;
delete process.env.CF_ZONE_ID;
type Combo = 'global' | 'open' | 'local';
const COMBO: Combo = (process.env.PKA_COMBO as Combo | undefined) || 'global';
// Module consts read at import: settled before the dynamic imports in main().
delete process.env.ENFORCE_WS_AUTH;
delete process.env.ENFORCE_LEDGER_AUTH;
if (COMBO === 'open') process.env.ENFORCE_READ_AUTH = 'false'; else delete process.env.ENFORCE_READ_AUTH;
if (COMBO === 'global') process.env.NODE_PROFILE = 'global'; else delete process.env.NODE_PROFILE;
/** The listings are a public read here, so a board listing's photo URL is plain. */
const PUBLIC_READ = COMBO !== 'local';

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { setMemberPhoto } from '@beanpool/engine';

const MODE = `[${COMBO}]`;
let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${MODE} ${msg}`);
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';
/** A second picture (one red pixel), so a listing's two photos differ. */
const RED_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGM4IScHAAK2AQU0pnWqAAAAAElFTkSuQmCC';
const SYNC = '/api/marketplace/posts?limit=1000&sync=true&types=offer,need,poll,event';

type Id = { pk: string; privateKey: crypto.KeyObject };
function newId(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
}
function signedHeaders(method: string, p: string, body: string, id: Id): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${p.split('?')[0]}\n${ts}\n${nonce}\n${body}`;
    return {
        'X-Public-Key': id.pk,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
}

let beforeCall: () => void = () => {};
type Res = { status: number; text: string; body: any };
async function call(method: 'GET' | 'HEAD', p: string, id?: Id): Promise<Res> {
    beforeCall();
    const res = await fetch(`${BASE}${p}`, { method, headers: id ? signedHeaders(method, p, '', id) : {} });
    const text = method === 'HEAD' ? '' : await res.text();
    let body: any;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, body };
}
const get = (p: string, id?: Id) => call('GET', p, id);
async function post(p: string, payload: unknown, id: Id): Promise<Res> {
    beforeCall();
    const body = JSON.stringify(payload);
    const res = await fetch(`${BASE}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...signedHeaders('POST', p, body, id) }, body });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, body: json };
}

function signedWsQuery(id: Id): string {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`WS\n/ws\n${ts}\n${nonce}\n`), id.privateKey).toString('base64');
    return `pubkey=${id.pk}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`;
}
type Sock = { ws: WebSocket; raw: string[] };
function openSocket(url: string): Promise<Sock> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { rejectUnauthorized: false });
        const raw: string[] = [];
        ws.on('message', d => raw.push(d.toString()));
        ws.on('open', () => resolve({ ws, raw }));
        ws.on('error', reject);
        setTimeout(() => reject(new Error('socket did not open')), 3000);
    });
}

const hasKey = (url: unknown) => typeof url === 'string' && /[?&]k=[A-Za-z0-9_-]{22}(?:&|$)/.test(url);
const bare = (postId: string, n: number) => `/api/marketplace/posts/${postId}/photos/${n}`;
const posts = (r: Res): any[] => Array.isArray(r.body) ? r.body : [];
const find = (r: Res, id: string) => posts(r).find(p => p.id === id);

async function main(): Promise<void> {
    console.log(`\n=== A listing's photos are its audience's ${MODE} ===\n`);
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { getProfileSwitches } = await import('./config/node-profile.js');
    const photoKeys = await import('./engine/photo-keys.js');
    const { savePricingGuideItem } = await import('./db/pricing-guide-db.js');
    const { runPricingAggregationCycle } = await import('./pricing-aggregator.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { pruneAuthAttempts } = await import('./auth-rate-limit.js');
    beforeCall = () => { resetGatewayRateLimit(); pruneAuthAttempts(Date.now() + 120_000); };

    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    assert(getProfileSwitches().guestListingsOnly === (COMBO === 'global'), `setup: the visitors' view is ${COMBO === 'global' ? 'on' : 'off'}`);

    const member = (callsign: string): Id => {
        const id = newId();
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                    VALUES (?, ?, 'active', ?, 'seed', ?)`)
            .run(id.pk, callsign, new Date(Date.now() - 60 * DAY).toISOString(), `INV-${callsign.toUpperCase()}`);
        setMemberPhoto(db, id.pk, TINY_PNG);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
        return id;
    };
    const alice = member('AudAlice');
    const bob = member('AudBob');
    const carol = member('AudCarol');
    const outsider = newId();
    const club = se.createGroup({ name: 'Audience club', createdBy: alice.pk });
    db.prepare("INSERT INTO group_members (group_id, member_pubkey, role, status) VALUES (?, ?, 'member', 'active')").run(club.id, bob.pk);

    const AT = { lat: -28.55, lng: 153.5 };
    const make = (title: string, photos: string[], options: any = {}, type: 'offer' | 'event' = 'offer', category = 'food') => {
        const p = se.createPost(type, category, title, `${title}, described`, 0, 'fixed', alice.pk, AT.lat, AT.lng, photos, false, undefined, false, options)!;
        // Priced (the pricing guide learns from priced listings), and set back an hour, so a cursor from before now
        // leaves it out of a delta. Explicit updated_at: posts_touch_updated_at leaves a write that sets it alone.
        db.prepare('UPDATE posts SET credits = 5, updated_at = ? WHERE id = ?').run(new Date(Date.now() - HOUR).toISOString(), p.id);
        return p.id as string;
    };
    const shapeRow = () => (db.prepare("SELECT value FROM node_config WHERE key = 'photoKeysShape'").get() as { value: string } | undefined)?.value;
    const sinceRow = () => (db.prepare("SELECT value FROM node_config WHERE key = 'photoKeysSince'").get() as { value: string } | undefined)?.value;
    /** A restart as far as the photos' keys go: what the boot decides (engine/photo-keys.ts installPhotoKeysAtBoot). */
    const restartKeys = () => photoKeys.installPhotoKeysAtBoot();
    /** The record a node had before this change: its listings a public read, so nothing keyed (`open`). */
    const recordFromBefore = (since = new Date(0).toISOString()) => {
        const put = db.prepare('INSERT OR REPLACE INTO node_config (key, value) VALUES (?, ?)');
        put.run('photoKeysShape', 'open');
        put.run('photoKeysSince', since);
        db.prepare('DELETE FROM photo_url_heals').run();
    };

    // ── 0. the upgrade, with nothing off the board ────────────────────────────────────────────
    const pub = make('Quokka kettle for the board', [TINY_PNG, RED_PNG]);
    if (PUBLIC_READ) {
        console.log('── 0. the upgrade on a node with no listing off the board with a photo ──');
        // With a heal under way from an earlier change (a take-over two hours ago): it goes on.
        const earlier = new Date(Date.now() - 2 * HOUR).toISOString();
        recordFromBefore(earlier);
        restartKeys();
        assert(shapeRow()?.startsWith('offboard-keyed:') === true && sinceRow() === earlier,
            `no URL a phone holds changed: the shape is recorded (${shapeRow()}) and photoKeysSince is kept, not moved nor cleared (${sinceRow()})`);
        recordFromBefore();
        restartKeys();
        assert(Date.parse(sinceRow() ?? '') === 0, `with no earlier change, no sync is answered whole (photoKeysSince ${sinceRow()})`);
        const r = await get(`${SYNC}&updatedAfter=${encodeURIComponent(new Date(Date.now() - 30 * MIN).toISOString())}`, bob);
        assert(r.status === 200 && posts(r).length === 0, `Bob's next delta is a delta: nothing (got ${r.status}, ${posts(r).length} rows)`);
    }

    const grp = make('Zanzibar lantern for the club', [TINY_PNG, RED_PNG], { audienceScope: 'group', targetGroupId: club.id });
    const dm = make('Marimba lessons for Bob', [TINY_PNG], { audienceScope: 'direct', targetPubkey: bob.pk });
    const ev = make('Club picnic', [TINY_PNG], {
        audienceScope: 'group', targetGroupId: club.id, eventStartAt: new Date(Date.now() + 7 * DAY).toISOString(),
    }, 'event', 'community');
    db.prepare(`INSERT INTO event_rsvps (post_id, member_pubkey, status, signature) VALUES (?, ?, 'going', 'test')`).run(ev, bob.pk);
    const flip = make('Kayak paddle, board then club', [TINY_PNG]);
    const flipBack = make('Sewing machine, club then board', [TINY_PNG], { audienceScope: 'group', targetGroupId: club.id });
    const offBoard = [grp, dm, ev];
    // Bob's phone last synced half an hour ago (its cursor: that sync less five minutes).
    const bobCursor = new Date(Date.now() - 35 * MIN).toISOString();

    // ── 1. the upgrade, with listings off the board ───────────────────────────────────────────
    if (PUBLIC_READ) {
        console.log('\n── 1. the upgrade on a node with listings off the board: a restart over the record from before ──');
        recordFromBefore();
        restartKeys();
        const since = Date.parse(sinceRow() ?? '');
        assert(shapeRow() !== 'open' && since > Date.now() - MIN, `the shape changed (${shapeRow()}) and photoKeysSince is now (${sinceRow()})`);
        const r = await get(`${SYNC}&updatedAfter=${encodeURIComponent(bobCursor)}`, bob);
        for (const [what, id] of [['his group\'s listing', grp], ['the listing for him', dm], ['his group\'s event', ev]] as const) {
            const p = find(r, id);
            const urls: string[] = p?.photos ?? [];
            const opened = await Promise.all(urls.map(u => get(u).then(x => x.status)));
            assert(!!p && urls.length > 0 && urls.every(hasKey) && opened.every(s => s === 200),
                `Bob's next sync from before the change carries ${what} again, every photo URL keyed and opening (${JSON.stringify(opened)})`);
        }
        const c = await get(`${SYNC}&updatedAfter=${encodeURIComponent(bobCursor)}`, carol);
        assert(c.status === 200 && offBoard.every(id => !c.text.includes(id)), `Carol's next sync holds none of them (got ${c.status})`);
        const before = sinceRow();
        restartKeys();
        assert(sinceRow() === before, `a restart that changes nothing keeps photoKeysSince (${before} → ${sinceRow()})`);
    }

    // What each reader's read hands out.
    const bobList = await get(`${SYNC}`, bob);
    const urlOf = (r: Res, id: string, n: number): string | undefined => find(r, id)?.photos?.[n];

    // ── 2. the route ──────────────────────────────────────────────────────────────────────────
    console.log('\n── 2. the route ──');
    {
        const nobody = await get(bare(crypto.randomUUID(), 0));
        assert(nobody.status === 404 && nobody.body?.error === 'Photo not found', `a listing nobody has: 404 Photo not found (got ${nobody.status} ${nobody.text.slice(0, 60)})`);
        for (const n of [0, 1]) {
            const r = await get(bare(pub, n));
            assert(r.status === (PUBLIC_READ ? 200 : 404), `the board listing's photo ${n}, unkeyed: ${PUBLIC_READ ? '200, as before' : '404 (every listing keyed here)'} (got ${r.status})`);
        }
        const photosOf: [string, string, number][] = [['the group\'s listing', grp, 2], ['the direct listing', dm, 1], ['the group\'s event', ev, 1]];
        for (const [what, id, count] of photosOf) {
            for (let n = 0; n < count; n++) {
                const unkeyed = await get(bare(id, n));
                assert(unkeyed.status === 404 && unkeyed.text === nobody.text, `${what}, photo ${n}, unkeyed: 404, the same answer as a listing nobody has (got ${unkeyed.status} ${unkeyed.text.slice(0, 60)})`);
                const versioned = await get(`${bare(id, n)}?v=${Date.now()}`);
                assert(versioned.status === 404, `… with a made-up version: 404 (got ${versioned.status})`);
                const signed = await get(bare(id, n), bob);
                assert(signed.status === 404, `… signed by Bob, who may see it, but unkeyed: 404 (an <img> can't sign; got ${signed.status})`);
                const head = await call('HEAD', bare(id, n));
                assert(head.status === 404, `… a HEAD, unkeyed: 404 (got ${head.status})`);
                // Outside the public-read allowlist's pattern, so a node that enforces reads asks for a signature first.
                const slash = await get(`${bare(id, n)}/`);
                assert(slash.status === 404 || slash.status === 401, `… with a trailing slash: refused, 404 or 401 (got ${slash.status})`);
                const wrong = await get(`${bare(id, n)}?v=0&k=${crypto.randomBytes(16).toString('base64url').slice(0, 22)}`);
                assert(wrong.status === 404 && wrong.text === nobody.text, `… with a wrong key: 404 (got ${wrong.status})`);
                const url = urlOf(bobList, id, n);
                assert(hasKey(url), `Bob's sync carries ${what}'s photo ${n} keyed (${url})`);
                const ok = url ? await get(url) : null;
                assert(ok?.status === 200, `… and that URL opens, unsigned, as an <img> asks (got ${ok?.status})`);
                const keyHead = url ? await call('HEAD', url) : null;
                assert(keyHead?.status === 200, `… a HEAD to it too (got ${keyHead?.status})`);
            }
        }
        // Another photo's key: photo 1's key on photo 0 of the same listing, and the group listing's key on the direct one.
        const k1 = new URL(`https://x${urlOf(bobList, grp, 1) ?? ''}`).searchParams.get('k') ?? '';
        const v0 = new URL(`https://x${urlOf(bobList, grp, 0) ?? ''}`).searchParams.get('v') ?? '0';
        const swapped = await get(`${bare(grp, 0)}?v=${v0}&k=${k1}`);
        assert(!!k1 && swapped.status === 404, `photo 1's key on photo 0: 404 (got ${swapped.status})`);
        const k0 = new URL(`https://x${urlOf(bobList, grp, 0) ?? ''}`).searchParams.get('k') ?? '';
        const across = await get(`${bare(dm, 0)}?v=0&k=${k0}`);
        assert(!!k0 && across.status === 404, `the group listing's key on the direct listing's photo: 404 (got ${across.status})`);
        const pubUrl = urlOf(bobList, pub, 0);
        assert(PUBLIC_READ ? !hasKey(pubUrl) : hasKey(pubUrl), `the board listing's URL in Bob's read is ${PUBLIC_READ ? 'plain, as before' : 'keyed, as before'} (${pubUrl})`);
        const pubOpen = pubUrl ? await get(pubUrl) : null;
        assert(pubOpen?.status === 200, `… and opens (got ${pubOpen?.status})`);
    }

    // ── 3. the reads ──────────────────────────────────────────────────────────────────────────
    console.log('\n── 3. the reads ──');
    {
        const byId = await get(`/api/marketplace/posts?id=${grp}`, bob);
        assert(byId.status === 200 && (find(byId, grp)?.photos ?? []).length === 2 && find(byId, grp).photos.every(hasKey),
            `Bob's read of the group's listing by id carries keyed URLs (got ${byId.status})`);
        const list = await get('/api/marketplace/posts?types=offer,need,poll,event', bob);
        assert([grp, dm, ev].every(id => (find(list, id)?.photos ?? []).length > 0 && find(list, id).photos.every(hasKey)),
            'Bob\'s board read carries every one of them keyed');
        const own = await get(SYNC, alice);
        assert([grp, dm, ev].every(id => (find(own, id)?.photos ?? []).length > 0 && find(own, id).photos.every(hasKey)),
            'Alice, their author, reads them keyed');
        const readers: [string, Id | undefined][] = [['Carol, a member of neither', carol], ['a stranger (unsigned)', undefined], ['an outsider (a key that is no member here)', outsider]];
        for (const [who, id] of readers) {
            for (const p of [SYNC, '/api/marketplace/posts?types=offer,need,poll,event', `/api/marketplace/posts?id=${grp}`, `/api/marketplace/posts?id=${dm}`]) {
                const r = await get(p, id);
                const leaked = offBoard.filter(x => r.text.includes(x));
                const keyed = posts(r).flatMap(x => x.photos ?? []).filter(hasKey);
                assert(leaked.length === 0 && (PUBLIC_READ ? keyed.length === 0 : true),
                    `${who}: ${p.replace('/api/marketplace/posts', '').slice(0, 50)} holds none of them, nor their ids${PUBLIC_READ ? ', nor any key' : ''} (got ${r.status}, ${leaked.length} ids, ${keyed.length} keys)`);
            }
        }
    }

    // ── 4. every other emitter ────────────────────────────────────────────────────────────────
    console.log('\n── 4. every other place the node emits a photo URL ──');
    {
        // The live event of an edit.
        const wsBase = `${BASE.replace('https', 'wss')}/ws`;
        const bobSock = await openSocket(`${wsBase}?${signedWsQuery(bob)}`);
        const carolSock = await openSocket(`${wsBase}?${signedWsQuery(carol)}`);
        const strangerSock = await openSocket(wsBase);
        await sleep(300);
        const edited = await post('/api/marketplace/posts/update', { id: grp, authorPublicKey: alice.pk, title: 'Zanzibar lantern for the club, renamed' }, alice);
        assert(edited.status === 200 && (edited.body?.post?.photos ?? []).every(hasKey), `Alice edits the group's listing; her answer carries keyed URLs (got ${edited.status} ${edited.text.slice(0, 80)})`);
        await sleep(500);
        const heard = bobSock.raw.map(t => { try { return JSON.parse(t); } catch { return null; } })
            .find(e => e?.type === 'post_updated' && e.post?.id === grp);
        const heardUrls: string[] = heard?.post?.photos ?? [];
        const heardOpen = await Promise.all(heardUrls.map(u => get(u).then(x => x.status)));
        assert(heardUrls.length === 2 && heardUrls.every(hasKey) && heardOpen.every(s => s === 200),
            `Bob's socket hears the edit with keyed URLs that open (${JSON.stringify(heardOpen)})`);
        for (const [who, s] of [['Carol\'s socket', carolSock], ['a stranger\'s socket', strangerSock]] as const) {
            assert(!s.raw.some(t => t.includes(`/api/marketplace/posts/${grp}/photos/`)), `${who} hears no URL of it`);
        }
        for (const s of [bobSock, carolSock, strangerSock]) s.ws.close();

        // A trade's cover, and an escrow dispute's photos.
        db.prepare("INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at) VALUES (?, ?, ?, ?, 5, 'pending', ?)")
            .run('aud-tx-grp', grp, bob.pk, alice.pk, new Date(Date.now() - 10 * DAY).toISOString());
        db.prepare("INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at) VALUES (?, ?, ?, ?, 5, 'pending', ?)")
            .run('aud-tx-pub', pub, bob.pk, alice.pk, new Date(Date.now() - 10 * DAY).toISOString());
        const one = se.getMarketplaceTransaction('aud-tx-grp');
        const oneOpen = one?.coverImage ? (await get(one.coverImage)).status : null;
        assert(hasKey(one?.coverImage) && oneOpen === 200, `a trade's cover (one read) is keyed and opens (${one?.coverImage}: ${oneOpen})`);
        const listed = se.getMarketplaceTransactions(bob.pk);
        const lg = listed.find(t => t.id === 'aud-tx-grp');
        const lp = listed.find(t => t.id === 'aud-tx-pub');
        const lgOpen = lg?.coverImage ? (await get(lg.coverImage)).status : null;
        assert(hasKey(lg?.coverImage) && lgOpen === 200, `… and in Bob's list (${lg?.coverImage}: ${lgOpen})`);
        assert(PUBLIC_READ ? !hasKey(lp?.coverImage) : hasKey(lp?.coverImage), `a board listing's cover is ${PUBLIC_READ ? 'plain' : 'keyed'} (${lp?.coverImage})`);
        const dPhotos: string[] = se.getEscrowDispute('aud-tx-grp')?.post?.photos ?? [];
        const dOpen = await Promise.all(dPhotos.map(u => get(u).then(x => x.status)));
        assert(dPhotos.length === 2 && dPhotos.every(hasKey) && dOpen.every(s => s === 200),
            `an escrow dispute's photos are keyed and open (${JSON.stringify(dPhotos)}: ${JSON.stringify(dOpen)})`);
        const listedPhotos: string[] = se.getEscrowDisputes(7, 50, 0, 'all').find(d => d.id === 'aud-tx-grp')?.post?.photos ?? [];
        assert(listedPhotos.length === 2 && listedPhotos.every(hasKey), `and in the disputes list (${JSON.stringify(listedPhotos)})`);

        // An event on Bob's own calendar.
        const mine = await get('/api/events/mine', bob);
        const mev = (mine.body?.events ?? []).find((e: any) => e.postId === ev);
        const mevOpen = mev?.photo ? (await get(mev.photo)).status : null;
        assert(mine.status === 200 && hasKey(mev?.photo) && mevOpen === 200, `the group's event on Bob's calendar carries a keyed photo that opens (got ${mine.status}, ${mev?.photo}: ${mevOpen})`);

        // The chat list's listing photo.
        const conv = (id: string, a: Id, b: Id, postId: string) => {
            db.prepare("INSERT INTO conversations (id, type, post_id, created_by) VALUES (?, 'dm', ?, ?)").run(id, postId, a.pk);
            db.prepare('INSERT INTO conversation_participants (conversation_id, public_key) VALUES (?, ?), (?, ?)').run(id, a.pk, id, b.pk);
        };
        conv('aud-conv-bob', alice, bob, grp);
        conv('aud-conv-carol', alice, carol, grp);
        const bobChats = await get(`/api/messages/conversations/${bob.pk}`, bob);
        const bc = (bobChats.body?.conversations ?? []).find((c: any) => c.id === 'aud-conv-bob');
        const bcOpen = bc?.postPhoto ? (await get(bc.postPhoto)).status : null;
        assert(bobChats.status === 200 && hasKey(bc?.postPhoto) && bcOpen === 200,
            `Bob's chat list shows the listing's photo keyed, and it opens (got ${bobChats.status} ${bobChats.text.slice(0, 80)}; ${bc?.postPhoto}: ${bcOpen})`);
        const carolChats = await get(`/api/messages/conversations/${carol.pk}`, carol);
        assert(carolChats.status === 200 && !carolChats.text.includes(`/api/marketplace/posts/${grp}/photos/`),
            `Carol, in a chat about a listing she can't see, gets no photo of it (got ${carolChats.status} ${carolChats.text.slice(0, 80)})`);

        // The pricing guide: a board listing's photo only.
        savePricingGuideItem({ category: 'food', emoji: '🏮', name: 'Zanzibar lantern', description: 'A lantern', priceBeans: 3 });
        savePricingGuideItem({ category: 'food', emoji: '🫖', name: 'Quokka kettle', description: 'A kettle', priceBeans: 3 });
        runPricingAggregationCycle();
        for (const [who, id] of [['Bob', bob], ['a stranger', undefined]] as const) {
            const guide = await get('/api/pricing-guide', id);
            const items: any[] = guide.body?.items ?? [];
            const lantern = items.find(i => i.name === 'Zanzibar lantern');
            const kettle = items.find(i => i.name === 'Quokka kettle');
            assert(guide.status === 200 && !!lantern && !lantern.thumbnailUrl && offBoard.every(x => !guide.text.includes(x)),
                `the pricing guide shows ${who} no photo of the group's listing, nor its id (got ${guide.status}, ${lantern?.thumbnailUrl})`);
            const mayRead = PUBLIC_READ || id === bob;
            const kOpen = kettle?.thumbnailUrl ? (await get(kettle.thumbnailUrl)).status : null;
            assert(mayRead ? kOpen === 200 : !kettle?.thumbnailUrl,
                `… and ${mayRead ? `the board listing's photo, which opens (${kettle?.thumbnailUrl}: ${kOpen})` : 'no photo of the board listing either (a local community\'s listings are its members\')'}`);
        }
    }

    // ── 5. an audience change ─────────────────────────────────────────────────────────────────
    console.log('\n── 5. an audience change ──');
    {
        const cursor = new Date(Date.now() - 5 * MIN).toISOString();
        const oldUrl = urlOf(bobList, flip, 0)!;
        const beforeOpen = await get(oldUrl);
        assert(beforeOpen.status === 200, `the board listing's URL Bob holds opens (${oldUrl}: ${beforeOpen.status})`);
        const was = (db.prepare('SELECT updated_at FROM posts WHERE id = ?').get(flip) as { updated_at: string }).updated_at;
        // As any write would: the audience only, and posts_touch_updated_at moves updated_at.
        db.prepare("UPDATE posts SET audience_scope = 'group', target_group_id = ? WHERE id = ?").run(club.id, flip);
        const now = (db.prepare('SELECT updated_at FROM posts WHERE id = ?').get(flip) as { updated_at: string }).updated_at;
        assert(Date.parse(now) > Date.parse(was) && now > cursor, `public → group moves the listing's updated_at (${was} → ${now})`);
        const plain = await get(bare(flip, 0));
        assert(plain.status === 404, `its plain URL is 404 from then on (got ${plain.status})`);
        if (PUBLIC_READ) {
            const held = await get(oldUrl);
            assert(held.status === 404, `the plain URL Bob's phone holds is 404 (got ${held.status})`);
        }
        const delta = await get(`${SYNC}&updatedAfter=${encodeURIComponent(cursor)}`, bob);
        const nu = urlOf(delta, flip, 0);
        const nuOpen = nu ? (await get(nu)).status : null;
        assert(hasKey(nu) && nuOpen === 200, `Bob's next delta from before the change carries the keyed URL, which opens (${nu}: ${nuOpen})`);
        const cd = await get(`${SYNC}&updatedAfter=${encodeURIComponent(cursor)}`, carol);
        assert(cd.status === 200 && !cd.text.includes(`/api/marketplace/posts/${flip}/photos/`), `Carol's next delta carries no URL of it (got ${cd.status})`);

        const keyedHeld = urlOf(bobList, flipBack, 0)!;
        assert(hasKey(keyedHeld) && (await get(keyedHeld)).status === 200, `the group listing's keyed URL Bob holds opens (${keyedHeld})`);
        db.prepare("UPDATE posts SET audience_scope = 'public', target_group_id = NULL WHERE id = ?").run(flipBack);
        const plainBack = await get(bare(flipBack, 0));
        assert(plainBack.status === (PUBLIC_READ ? 200 : 404), `group → public: its plain URL is ${PUBLIC_READ ? '200' : '404 (every listing keyed here)'} (got ${plainBack.status})`);
        const stillKeyed = await get(keyedHeld);
        assert(stillKeyed.status === 200, `the keyed URL Bob held still opens (got ${stillKeyed.status})`);
        const back = await get(`${SYNC}&updatedAfter=${encodeURIComponent(cursor)}`, bob);
        const backUrl = urlOf(back, flipBack, 0);
        assert(PUBLIC_READ ? (!!backUrl && !hasKey(backUrl)) : hasKey(backUrl), `Bob's next delta carries it ${PUBLIC_READ ? 'plain' : 'keyed'} (${backUrl})`);
    }

    // ── 6. a new secret ───────────────────────────────────────────────────────────────────────
    if (PUBLIC_READ) {
        console.log('\n── 6. a new secret (a restore from a backup older than it) ──');
        const held = urlOf(bobList, dm, 0)!;
        const cursor = new Date(Date.now() - MIN).toISOString();
        await sleep(20);
        db.prepare("DELETE FROM node_config WHERE key = 'photoKeySecret'").run();
        restartKeys();
        assert(Date.parse(sinceRow() ?? '') > Date.parse(cursor), `photoKeysSince moves (${sinceRow()})`);
        const old = await get(held);
        assert(old.status === 404, `the keyed URL made with the old secret is 404 (got ${old.status})`);
        const r = await get(`${SYNC}&updatedAfter=${encodeURIComponent(cursor)}`, bob);
        const nu = urlOf(r, dm, 0);
        const nuOpen = nu ? (await get(nu)).status : null;
        assert(hasKey(nu) && nu !== held && nuOpen === 200, `Bob's next sync from before it carries the new keyed URL, which opens (${nu}: ${nuOpen})`);
        const pubUrl = urlOf(r, pub, 0);
        const pubOpen = pubUrl ? (await get(pubUrl)).status : null;
        assert(!hasKey(pubUrl) && pubOpen === 200, `the board listing's stays plain and opens (${pubUrl}: ${pubOpen})`);
    }

    console.log(`\n${MODE} ${passed}/${run} passed`);
    return;
}

async function parent(): Promise<void> {
    let ok = true;
    try {
        await main();
    } catch (e) {
        console.error(`✗ ${MODE} threw:`, e);
        ok = false;
    }
    ok &&= passed === run;
    if (process.env.PKA_CHILD === '1') process.exit(ok ? 0 : 1);
    for (const combo of ['open', 'local'] as const) {
        console.log(`\n── the ${combo} run, in a fresh process ──`);
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `beanpool-photo-audience-${combo}-`));
        const env: NodeJS.ProcessEnv = { ...process.env, PKA_COMBO: combo, PKA_CHILD: '1', BEANPOOL_DATA_DIR: dataDir };
        const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], { env, stdio: ['ignore', 'inherit', 'inherit'] });
        const status = await new Promise<number | null>(resolve => {
            child.on('exit', code => resolve(code));
            child.on('error', () => resolve(null));
        });
        fs.rmSync(dataDir, { recursive: true, force: true });
        run++;
        if (status === 0) { passed++; console.log(`✓ the ${combo} run passed`); } else { ok = false; console.error(`✗ the ${combo} run failed (exit ${status})`); }
    }
    console.log(`\n${ok ? 'PASS' : 'FAIL'}: test-photo-keys-audience`);
    process.exit(ok ? 0 : 1);
}

parent();
