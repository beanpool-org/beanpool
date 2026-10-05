/**
 * A listing's photos go to whoever may still see the listing (#1645's confirmation review, "The 2 driver misses").
 *
 * A cancelled listing's photo still loaded at the keyed URL its readers had been handed: removePost is a soft cancel
 * (`active` 0, status `cancelled`), and the photo route asked only whether the URL's key was right. So anyone who held
 * the URL (a member who had scrolled past it, a chat's thumbnail, a link passed on) kept the photo of a listing nobody
 * may read any more. Now a listing taken off (`active` 0) shows its photos as a hidden one does: to its author and the
 * moderators when they sign the request, to whoever may still read it by id (a cancelled event's hosts and the people
 * Going), and to nobody else; any other request is answered as a photo that isn't there (404 `Photo not found`).
 * Everything else is as before: a listing on the board, paused by its author, or with a completed trade (`active` 1).
 *
 * Every run is the real server over TLS through the real signature middleware, in its own process on its own data dir:
 * `local` (the default: every listing-photo URL keyed), `global` (NODE_PROFILE=global: a board listing's URL plain, a
 * public read) and `preview` (a local node with PRIVATE_PREVIEW=1, whose early gate lets a non-member's <img> through only
 * with the key). Alice writes; Bob is in her group and Going to her event; Carol is another member; Mo is an admin; an
 * outsider signs with a key that is no member here; a stranger signs nothing. Each reader asks at the URL the author's
 * read handed out before the listing was taken off.
 *
 *  1. Unchanged: a live listing, one paused by its author, one whose trade completed. 200 to every reader, the cache
 *     header as before.
 *  2. Taken off: cancelled by its author, a group listing cancelled, a listing paused by its author's suspension. 404 to
 *     the stranger (GET and HEAD), the outsider, Bob and Carol; 200 to the author and the admin, signed, never cached
 *     by anyone (`private, no-store`).
 *  3. A cancelled event: 200 to Bob, who is Going, and to Alice, signed; 404 to Carol and the stranger.
 *  4. A listing gone, its row deleted and its photos' rows left (foreign keys are off): 404 to everyone, the author included.
 *     It was 200 at its key.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-photo-off-listing.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.CF_API_TOKEN;
delete process.env.CF_ZONE_ID;
type Combo = 'local' | 'global' | 'preview';
const COMBO: Combo = (process.env.POL_COMBO as Combo | undefined) || 'local';
// Module consts read at import: settled before the dynamic imports in main().
delete process.env.ENFORCE_WS_AUTH;
delete process.env.ENFORCE_LEDGER_AUTH;
delete process.env.ENFORCE_READ_AUTH;
if (COMBO === 'global') process.env.NODE_PROFILE = 'global'; else delete process.env.NODE_PROFILE;
if (COMBO === 'preview') process.env.PRIVATE_PREVIEW = '1'; else delete process.env.PRIVATE_PREVIEW;

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setMemberPhoto } from '@beanpool/engine';

const MODE = `[${COMBO}]`;
let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${MODE} ${msg}`);
}
const DAY = 24 * 60 * 60 * 1000;
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';

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
type Res = { status: number; text: string; body: any; cache: string | null; type: string | null };
async function call(method: 'GET' | 'HEAD', p: string, id?: Id): Promise<Res> {
    beforeCall();
    const res = await fetch(`${BASE}${p}`, { method, headers: id ? signedHeaders(method, p, '', id) : {} });
    const text = method === 'HEAD' ? '' : await res.text();
    let body: any;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, body, cache: res.headers.get('cache-control'), type: res.headers.get('content-type') };
}
const get = (p: string, id?: Id) => call('GET', p, id);
const head = (p: string, id?: Id) => call('HEAD', p, id);

async function main(): Promise<void> {
    console.log(`\n=== A listing's photos go to whoever may still see it ${MODE} ===\n`);
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { getProfileSwitches } = await import('./config/node-profile.js');
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
    const alice = member('OffAlice');
    const bob = member('OffBob');
    const carol = member('OffCarol');
    const dave = member('OffDave');
    const mo = member('OffMo');
    db.prepare("INSERT INTO node_roles (member_pubkey, role) VALUES (?, 'admin')").run(mo.pk);
    const outsider = newId();
    const club = se.createGroup({ name: 'Off club', createdBy: alice.pk });
    db.prepare("INSERT INTO group_members (group_id, member_pubkey, role, status) VALUES (?, ?, 'member', 'active')").run(club.id, bob.pk);

    const make = (title: string, author: Id = alice, options: any = {}, type: 'offer' | 'event' = 'offer', category = 'food'): string => {
        const p = se.createPost(type, category, title, `${title}, described`, 0, 'fixed', author.pk, -28.55, 153.5, [TINY_PNG], false, undefined, false, options)!;
        return p.id as string;
    };
    /** The URL of the listing's first photo, as its author's read by id hands it out. */
    const urlOf = async (postId: string, author: Id = alice): Promise<string> => {
        const r = await get(`/api/marketplace/posts?id=${postId}&types=offer,need,poll,event`, author);
        const url = Array.isArray(r.body) ? r.body[0]?.photos?.[0] : undefined;
        if (typeof url !== 'string') throw new Error(`no photo URL for ${postId} (${r.status} ${r.text.slice(0, 120)})`);
        return url;
    };

    // Every listing made, and its URL read, while it is live.
    const live = make('Quokka kettle, still listed');
    const paused = make('Wombat blanket, paused by its author');
    const traded = make('Echidna lamp, traded');
    const cancelled = make('Bilby teapot, cancelled');
    const grp = make('Dingo drum for the club, cancelled', alice, { audienceScope: 'group', targetGroupId: club.id });
    const suspended = make('Possum scarf, its author suspended', dave);
    const ev = make('Platypus picnic, cancelled', alice, { eventStartAt: new Date(Date.now() + 7 * DAY).toISOString() }, 'event', 'community');
    const gone = make('Kookaburra clock, deleted');
    db.prepare(`INSERT INTO event_rsvps (post_id, member_pubkey, status, signature) VALUES (?, ?, 'going', 'test')`).run(ev, bob.pk);
    const url: Record<string, string> = {};
    for (const id of [live, paused, traded, cancelled, grp, ev, gone]) url[id] = await urlOf(id);
    url[suspended] = await urlOf(suspended, dave);
    const plainBoardUrl = COMBO === 'global';
    assert(/[?&]k=/.test(url[cancelled]) === !plainBoardUrl && /[?&]k=/.test(url[grp]),
        `setup: a board listing's URL is ${plainBoardUrl ? 'plain' : 'keyed'} here, a group's keyed (${url[cancelled]})`);

    // Each one as it is taken off, or not.
    assert(se.pausePost(paused, alice.pk), 'setup: Alice pauses one listing');
    db.prepare("UPDATE posts SET status = 'completed', completed_at = ? WHERE id = ?").run(new Date().toISOString(), traded);
    assert(se.removePost(cancelled, alice.pk), 'setup: Alice cancels one listing (removePost: active 0, status cancelled)');
    assert(se.removePost(grp, alice.pk), "setup: Alice cancels her group's listing");
    assert(se.removePost(ev, alice.pk), 'setup: Alice cancels her event');
    // A report's suspension, as state-engine.ts resolves one: the member suspended, every live listing of theirs paused.
    db.prepare("UPDATE members SET status = 'suspended' WHERE public_key = ?").run(dave.pk);
    db.prepare("UPDATE posts SET active = 0, status = 'paused' WHERE author_pubkey = ? AND active = 1").run(dave.pk);
    db.prepare('DELETE FROM posts WHERE id = ?').run(gone);
    const row = (id: string) => db.prepare('SELECT active, status FROM posts WHERE id = ?').get(id) as { active: number; status: string };
    assert(row(cancelled).active === 0 && row(cancelled).status === 'cancelled' && row(paused).active === 1 && row(paused).status === 'paused'
        && row(traded).active === 1 && row(suspended).active === 0,
        `setup: the rows (cancelled ${JSON.stringify(row(cancelled))}, paused ${JSON.stringify(row(paused))}, suspended ${JSON.stringify(row(suspended))})`);
    // Foreign keys are off (db.ts), so the listing's row goes and its photos' stay, as when a linked community's listings go
    // (federation-listings.ts).
    assert(!!db.prepare('SELECT 1 FROM post_photos WHERE post_id = ?').get(gone), "setup: the deleted listing's photo rows outlive it");

    const readers: [string, Id | undefined][] = [
        ['the stranger (unsigned)', undefined], ['the outsider (signed, no member)', outsider],
        ['Bob', bob], ['Carol', carol], ['Mo (admin)', mo],
    ];

    // ── 1. unchanged ──────────────────────────────────────────────────────────────────────────
    console.log('\n── 1. a live listing, one paused by its author, one traded: as before ──');
    for (const [what, id] of [['the live listing', live], ['the listing paused by its author', paused], ['the traded listing', traded]] as const) {
        const cache = plainBoardUrl ? 'public, max-age=31536000, immutable' : 'private, max-age=31536000, immutable';
        for (const [who, reader] of [...readers, ['Alice', alice] as [string, Id]]) {
            const r = await get(url[id], reader);
            assert(r.status === 200 && r.type === 'image/png' && r.cache === cache,
                `${what}: ${who} gets the photo (got ${r.status} ${r.type} "${r.cache}")`);
        }
        const h = await head(url[id]);
        assert(h.status === 200, `${what}: HEAD unsigned 200 (got ${h.status})`);
    }

    // ── 2. taken off ──────────────────────────────────────────────────────────────────────────
    console.log('\n── 2. taken off: cancelled, a group listing cancelled, paused by its author\'s suspension ──');
    for (const [what, id, author] of [
        ['the cancelled listing', cancelled, alice], ["the group's cancelled listing", grp, alice], ["the suspended author's listing", suspended, dave],
    ] as const) {
        for (const [who, reader] of readers.filter(([w]) => !w.startsWith('Mo'))) {
            const r = await get(url[id], reader);
            assert(r.status === 404 && r.body?.error === 'Photo not found', `${what}: ${who} gets 404 Photo not found (got ${r.status} ${r.text.slice(0, 40)})`);
        }
        const h = await head(url[id]);
        assert(h.status === 404, `${what}: HEAD unsigned 404 (got ${h.status})`);
        for (const [who, reader] of [['its author', author], ['Mo (admin)', mo]] as const) {
            const r = await get(url[id], reader);
            assert(r.status === 200 && r.type === 'image/png' && r.cache === 'private, no-store',
                `${what}: ${who}, signed, gets the photo, never cached (got ${r.status} ${r.type} "${r.cache}")`);
        }
    }
    // The wrong key is still no photo, for the author too.
    {
        const wrong = url[cancelled].includes('k=') ? url[cancelled].replace(/k=[^&]+/, 'k=AAAAAAAAAAAAAAAAAAAAAA') : `${url[cancelled]}&k=AAAAAAAAAAAAAAAAAAAAAA`;
        const r = await get(wrong, alice);
        assert(r.status === (plainBoardUrl ? 200 : 404), `the cancelled listing at a wrong key: ${plainBoardUrl ? '200 to its author (a board listing asks no key here)' : '404, its author too'} (got ${r.status})`);
    }

    // ── 3. a cancelled event ──────────────────────────────────────────────────────────────────
    console.log('\n── 3. a cancelled event: its host and the people Going ──');
    for (const [who, reader, want] of [
        ['Alice (host)', alice, 200], ['Bob (Going)', bob, 200], ['Carol', carol, 404], ['the outsider', outsider, 404], ['the stranger', undefined, 404],
    ] as const) {
        const r = await get(url[ev], reader);
        assert(r.status === want && (want === 404 || r.cache === 'private, no-store'), `the cancelled event: ${who} gets ${want} (got ${r.status} "${r.cache}")`);
    }
    {
        const byId = await get(`/api/marketplace/posts?id=${ev}&types=offer,need,poll,event`, bob);
        assert(Array.isArray(byId.body) && byId.body.length === 1, `…as Bob may still read the event by id (got ${byId.status}, ${Array.isArray(byId.body) ? byId.body.length : '?'} rows)`);
        const carolById = await get(`/api/marketplace/posts?id=${ev}&types=offer,need,poll,event`, carol);
        assert(!Array.isArray(carolById.body) || carolById.body.length === 0, `…and Carol may not (got ${carolById.status})`);
    }

    // ── 4. gone ───────────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. a listing deleted, its photos\' rows left ──');
    for (const [who, reader] of [['its author', alice], ['the stranger', undefined]] as const) {
        const r = await get(url[gone], reader);
        assert(r.status === 404, `the deleted listing: ${who} gets 404 (got ${r.status})`);
    }

    console.log(`\n${MODE} ${passed}/${run} passed`);
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
    if (process.env.POL_CHILD === '1') process.exit(ok ? 0 : 1);
    for (const combo of ['global', 'preview'] as const) {
        console.log(`\n── the ${combo} run, in a fresh process ──`);
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `beanpool-photo-off-${combo}-`));
        const env: NodeJS.ProcessEnv = { ...process.env, POL_COMBO: combo, POL_CHILD: '1', BEANPOOL_DATA_DIR: dataDir };
        const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], { env, stdio: ['ignore', 'inherit', 'inherit'] });
        const status = await new Promise<number | null>(resolve => {
            child.on('exit', code => resolve(code));
            child.on('error', () => resolve(null));
        });
        fs.rmSync(dataDir, { recursive: true, force: true });
        run++;
        if (status === 0) { passed++; console.log(`✓ the ${combo} run passed`); } else { ok = false; console.error(`✗ the ${combo} run failed (exit ${status})`); }
    }
    console.log(`\n${ok ? 'PASS' : 'FAIL'}: test-photo-off-listing (${passed}/${run})`);
    process.exit(ok ? 0 : 1);
}

parent();
