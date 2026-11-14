/**
 * Test Suite: a community's say over its name on its members' listings on the global community (DESIGN-list-on-global-fable.md
 * §2, §4, §11 G5). The community's share switch rides in its directory push as `listingsFromHere` (true or false); the
 * registry keeps it; a global node's mirror reads it, and a copy whose community says false draws no from-line and no door,
 * within one mirror run. Absent (an older node, or a registry from before the column) reads as on, and a value that is not a
 * plain false is on. Boots the real server on the global profile, with the registry a FIXTURE on 127.0.0.1, and goes
 * through the real middleware over HTTPS, signed:
 *
 *   1. a row checked: the switch is always a boolean, and only a plain false is off (snake_case or camelCase); a standby's copy
 *      of the cache is held to the same
 *   2. a mirror run takes it from the registry, and the cache keeps it
 *   3. copies under each row: a row that says false draws no from-line and no door for a visitor, a member or the author, and
 *      the copy keeps its host; the author's own read, and the create's answer, say why (`shownNameOff`)
 *   4. switched off: within one mirror run every copy from that community loses its line and its door, the ETag of the body
 *      with the line is not confirmed, and an RSVP refusal names no community
 *   5. switched on again: the line comes back at the next run on the same copies, the ones made while it was off included
 *   6. the Find card is unchanged: the switch is about copies, never about being found
 *
 * Contacts no registry: DIRECTORY_MIRROR_URL is the fixture on 127.0.0.1.
 *
 * Run: via scripts/run-server-suites.mjs (SERVER_SUITES_ONLY=test-listings-from-here)
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
process.env.NODE_PROFILE = 'global';

import crypto from 'node:crypto';
import http from 'node:http';
import { localFetch } from './keepalive-test-fetch.js';
import { TEST_PHOTOS } from './post-test-helper.js';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

// ── the fixture registry: GET is the view a global node's mirror reads ──────────────────────────────────────────────
let table: Record<string, unknown>[] = [];
const registry = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
        const u = new URL(req.url || '/', 'http://fixture');
        const limit = Number(u.searchParams.get('limit') ?? table.length);
        const offset = Number(u.searchParams.get('offset') ?? 0);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(table.slice(offset, offset + limit)));
    });
});
await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', resolve));
process.env.DIRECTORY_MIRROR_URL = `http://127.0.0.1:${(registry.address() as { port: number }).port}/rest/v1/directory_listed?select=*`;
process.env.DIRECTORY_MIRROR_KEY = 'sb_publishable_TEST-listings-from-here';

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };
function keypair(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pubKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
}
function signedHeaders(method: string, p: string, body: string, id: Id): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = { method, path: p.split('?')[0], timestamp: ts, nonce, body };
    return {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': signRequest(id.privateKey, canonical),
        [SIGNED_FOR_HEADER]: signedForHost(),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
}
type Answer = { status: number; body: any; text: string; etag: string | null };
async function call(method: 'GET' | 'POST', p: string, id: Id | null, payload?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const res = await localFetch(`${BASE}${p}`, {
        method,
        headers: { ...(id ? signedHeaders(method, p, body, id) : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
        ...(body ? { body } : {}),
    });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: parsed, text, etag: res.headers.get('etag') };
}

const HOUR = 60 * 60 * 1000;
const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();
const EXACT = { lat: -37.06412, lng: 144.21733 };
const PRICE = { price_c: 2000, per: 'fixed' };
/** Four communities in the registry, each under a name no node has. */
const RIVERBEND = { host: 'riverbend.example.org', name: 'Riverbend Commons' };
const OLDTOWN = { host: 'oldtown.example.org', name: 'Oldtown Exchange' };
const QUIET = { host: 'quietvalley.example.org', name: 'Quiet Valley' };
const FORGED = { host: 'oddhill.example.org', name: 'Odd Hill' };

/** A row of the registry's view, as the website and a global node's mirror read it; `listings_from_here` as given, or left out. */
function viewRow(c: { host: string; name: string }, listingsFromHere?: unknown): Record<string, unknown> {
    return {
        node_id: `peer-${c.host}`, shown_name: c.name, community_name: c.name, node_url: `https://${c.host}`,
        last_seen_at: new Date().toISOString(), accepting_knocks: true,
        ...(listingsFromHere === undefined ? {} : { listings_from_here: listingsFromHere }),
    };
}

async function main() {
    console.log('A community\'s say over its name on its members\' listings on the global community...\n');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { updateGatewayConfig, DEFAULT_GATEWAY_CONFIG } = await import('./config/local-config.js');
    const { NODE_PROFILE_KEY } = await import('./config/node-profile.js');
    const { setMemberPhoto } = await import('@beanpool/engine');
    const { normaliseRegistryRow, mergeReplicatedDirectory, shownCommunityAt } = await import('./engine/directory-cache.js');
    const { runDirectoryMirror } = await import('./services/directory-mirror.js');
    const { EVENT_COPY_CODE } = await import('./engine/event-copy.js');

    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    const { stopPricingAggregatorWorker } = await import('./pricing-aggregator.js');
    stopPricingAggregatorWorker();
    updateGatewayConfig({ ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: false, maxRequestsPerMinute: 120 } });
    db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`${NODE_PROFILE_KEY}.probation`, 'false');

    const longAgo = new Date(Date.now() - 400 * 24 * HOUR).toISOString();
    const member = (name: string): Id => {
        const id = keypair();
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, is_treasury, updated_at)
                    VALUES (?, ?, 'active', ?, 'genesis', 'TEST', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(id.pubKeyHex, name, longAgo);
        setMemberPhoto(db, id.pubKeyHex, 'data:image/png;base64,iVBORw0KGgo=');
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pubKeyHex);
        return id;
    };
    const robin = member('RobinSeller');
    const sam = member('SamReader');

    // ── 1. A row checked ──
    console.log('── 1. A row checked: always a boolean, and only a plain false is off ──');
    const checked = (extra: Record<string, unknown>) => normaliseRegistryRow({ ...viewRow(RIVERBEND), ...extra }) as any;
    assert(checked({ listings_from_here: false })?.listingsFromHere === false, 'a row that says false is off');
    assert(checked({ listingsFromHere: false })?.listingsFromHere === false, 'and so is one that says it in camelCase');
    assert(checked({ listings_from_here: true })?.listingsFromHere === true, 'a row that says true is on');
    assert(checked({})?.listingsFromHere === true, 'a row that says nothing (an older node, or a registry from before the column) is on');
    for (const [what, forged] of [['null', null], ['the text "false"', 'false'], ['the text "no"', 'no'], ['0', 0], ['1', 1], ['an object', { off: true }], ['a list', [false]]] as const) {
        const v = checked({ listings_from_here: forged })?.listingsFromHere;
        assert(v === true, `a forged ${what} is normalised to a boolean, and reads as on (${JSON.stringify(v)})`);
    }
    // A standby's copy of the cache (engine/sync.ts): held to the same, and one from a main server from before it is on.
    const copied = (extra: Record<string, unknown>) => ({
        key: `peer-copied-${crypto.randomUUID()}`, listed: true, name: 'Copied Commons', url: 'https://copied.example.org', lat: null, lng: null, radiusKm: null,
        memberCount: null, contactEmail: null, contactPhone: null, registryUpdatedAt: new Date().toISOString(),
        firstSeenAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...extra,
    });
    const offCopy = copied({ listingsFromHere: false });
    const oldCopy = copied({});
    const forgedCopy = copied({ listingsFromHere: 'false' });
    const merged = mergeReplicatedDirectory([offCopy, oldCopy, forgedCopy]);
    const cacheOf = (key: string) => (db.prepare('SELECT listings_from_here FROM directory_cache WHERE community_key = ?').get(key) as { listings_from_here: number | null } | undefined)?.listings_from_here;
    assert(merged.written === 3, `a standby takes the three copied rows (${JSON.stringify(merged)})`);
    assert(cacheOf(offCopy.key) === 0 && cacheOf(oldCopy.key) === 1 && cacheOf(forgedCopy.key) === 1,
        `a copied false stays off; a copy from before the switch, and a forged one, are on (${cacheOf(offCopy.key)}, ${cacheOf(oldCopy.key)}, ${cacheOf(forgedCopy.key)})`);

    // ── 2. A mirror run takes it ──
    console.log('\n── 2. A mirror run takes it ──');
    table = [viewRow(RIVERBEND, true), viewRow(OLDTOWN), viewRow(QUIET, false), viewRow(FORGED, 'false')];
    const first = await runDirectoryMirror();
    assert(first.ran === true && (first as any).ok === true && (first as any).added === 4, `the mirror takes the four rows (${JSON.stringify(first)})`);
    const kept = (c: { host: string }) => cacheOf(`peer-${c.host}`);
    assert(kept(RIVERBEND) === 1 && kept(OLDTOWN) === 1 && kept(QUIET) === 0 && kept(FORGED) === 1,
        `the cache keeps on, absent as on, off, and forged as on (${kept(RIVERBEND)}, ${kept(OLDTOWN)}, ${kept(QUIET)}, ${kept(FORGED)})`);
    assert((shownCommunityAt(QUIET.host) as any)?.listingsFromHere === false && (shownCommunityAt(OLDTOWN.host) as any)?.listingsFromHere === true,
        'the row read back says so');

    // ── 3. Copies under each row ──
    console.log('\n── 3. Copies under each row ──');
    const offer = (c: { host: string }, title: string) => call('POST', '/api/marketplace/posts', robin, {
        id: crypto.randomUUID(), type: 'offer', category: 'food', title, description: 'Fresh this morning', authorPublicKey: robin.pubKeyHex,
        ...EXACT, photos: TEST_PHOTOS, tags: [], freeTags: [], shownPrice: PRICE,
        shownFrom: { host: c.host, postId: crypto.randomUUID(), name: 'A name the phone made up' },
    });
    const event = (c: { host: string }, title: string) => call('POST', '/api/marketplace/posts', robin, {
        id: crypto.randomUUID(), type: 'event', category: 'community', title, description: 'Bring a plate', authorPublicKey: robin.pubKeyHex,
        ...EXACT, eventStartAt: inHours(48), eventEndAt: inHours(50), photos: TEST_PHOTOS,
        shownFrom: { host: c.host, postId: crypto.randomUUID(), name: 'A name the phone made up' },
    });
    const made: Record<string, Answer> = {
        riverbend: await offer(RIVERBEND, 'Riverbend loaves'),
        riverbendEvent: await event(RIVERBEND, 'Riverbend street party'),
        oldtown: await offer(OLDTOWN, 'Oldtown honey'),
        quiet: await offer(QUIET, 'Quiet Valley eggs'),
        forged: await offer(FORGED, 'Odd Hill apples'),
    };
    for (const [what, a] of Object.entries(made)) assert(a.status === 200 && a.body?.post?.shownCopy === true, `${what}: a copy is made (${a.status} ${a.text.slice(0, 120)})`);
    const idOf = (what: string): string => made[what].body?.post?.id;
    const stored = (id: string) => db.prepare('SELECT shown_from_host FROM posts WHERE id = ?').get(id) as { shown_from_host: string | null } | undefined;
    const read = async (id: string, who: Id | null) => (await call('GET', `/api/marketplace/posts?id=${id}`, who)).body?.[0];

    assert(made.quiet.body?.post?.shownFrom === undefined && made.quiet.body?.post?.shownNameOff === true,
        `the create's answer for a community that says no: no from-line, and why, for the phone's one line (${JSON.stringify({ from: made.quiet.body?.post?.shownFrom, off: made.quiet.body?.post?.shownNameOff })})`);
    assert(made.riverbend.body?.post?.shownFrom?.name === RIVERBEND.name && made.riverbend.body?.post?.shownNameOff === undefined,
        'the create\'s answer for a community that says yes: its from-line, and nothing about a name kept off');
    assert(stored(idOf('quiet'))?.shown_from_host === QUIET.host, 'the copy keeps the host of a listed community that says no: its line comes back if it says yes');
    for (const [who, reader] of [['a visitor', null], ['a member', sam], ['its author', robin]] as const) {
        const quiet = await read(idOf('quiet'), reader);
        assert(quiet?.shownCopy === true && quiet?.shownFrom === undefined, `${who}: the copy from a community that says no draws no from-line and no door`);
        for (const what of ['riverbend', 'oldtown', 'forged'] as const) {
            const name = { riverbend: RIVERBEND.name, oldtown: OLDTOWN.name, forged: FORGED.name }[what];
            assert((await read(idOf(what), reader))?.shownFrom?.name === name, `${who}: the copy from ${name} (${what === 'oldtown' ? 'said nothing' : what === 'forged' ? 'a forged value' : 'says yes'}) draws its line`);
        }
    }
    const visitorText = (await call('GET', `/api/marketplace/posts?id=${idOf('quiet')}`, null)).text;
    assert(!visitorText.includes(QUIET.name) && !visitorText.includes(QUIET.host), 'a visitor\'s read holds neither the community\'s name nor its address');
    assert((await read(idOf('quiet'), robin))?.shownNameOff === true, 'its author\'s own read says why there is no line');
    assert((await read(idOf('quiet'), sam))?.shownNameOff === undefined && (await read(idOf('quiet'), null))?.shownNameOff === undefined,
        'nobody else\'s read says anything about it');

    // ── 4. Switched off: gone within one mirror run ──
    console.log('\n── 4. Switched off: gone within one mirror run ──');
    const before = await call('GET', `/api/marketplace/posts?id=${idOf('riverbend')}`, null);
    assert(before.body?.[0]?.shownFrom?.name === RIVERBEND.name, 'before: the line is there');
    table = [viewRow(RIVERBEND, false), viewRow(OLDTOWN), viewRow(QUIET, false), viewRow(FORGED, 'false')];
    const off = await runDirectoryMirror();
    assert(off.ran === true && (off as any).ok === true && (off as any).updated === 1 && (off as any).added === 0 && (off as any).removed === 0,
        `one run, one row changed (${JSON.stringify(off)})`);
    const after = await call('GET', `/api/marketplace/posts?id=${idOf('riverbend')}`, null, undefined, before.etag ? { 'If-None-Match': before.etag } : {});
    assert(after.status === 200, `the ETag of the body with the line is not confirmed (${after.status})`);
    assert(after.body?.[0]?.shownCopy === true && after.body?.[0]?.shownFrom === undefined, 'after one run: no from-line and no door on the copy');
    for (const [who, reader] of [['a member', sam], ['its author', robin]] as const) {
        for (const what of ['riverbend', 'riverbendEvent'] as const) {
            const copy = await read(idOf(what), reader);
            assert(copy?.shownCopy === true && copy?.shownFrom === undefined, `${who}: the ${what === 'riverbend' ? 'Offer' : 'event'} from Riverbend has no line now`);
        }
    }
    assert((await read(idOf('riverbend'), robin))?.shownNameOff === true, 'and its author\'s read says why');
    const all = (await call('GET', '/api/marketplace/posts', sam)).body ?? [];
    assert(Array.isArray(all) && all.length >= 5 && !all.some((p: any) => p?.shownFrom?.host === RIVERBEND.host), `no copy in the whole list draws Riverbend's line (${all.length} read)`);
    assert(all.some((p: any) => p?.shownFrom?.host === OLDTOWN.host), 'another community\'s line is untouched');
    const rsvp = await call('POST', `/api/marketplace/posts/${idOf('riverbendEvent')}/rsvp`, sam, { status: 'going' });
    assert(rsvp.status === 409 && rsvp.body?.code === EVENT_COPY_CODE && !String(rsvp.body?.error).includes(RIVERBEND.name),
        `an RSVP on the event copy is still refused, and names no community (${rsvp.status} ${rsvp.body?.error})`);
    assert(stored(idOf('riverbend'))?.shown_from_host === RIVERBEND.host, 'the copy\'s own words are untouched');

    // ── 5. Switched on again ──
    console.log('\n── 5. Switched on again ──');
    table = [viewRow(RIVERBEND, true), viewRow(OLDTOWN), viewRow(QUIET, true), viewRow(FORGED, 'false')];
    const on = await runDirectoryMirror();
    assert(on.ran === true && (on as any).ok === true && (on as any).updated === 2, `one run, two rows changed (${JSON.stringify(on)})`);
    assert((await read(idOf('riverbend'), null))?.shownFrom?.name === RIVERBEND.name, 'the line comes back on the same copy');
    const quietBack = await read(idOf('quiet'), sam);
    assert(quietBack?.shownFrom?.name === QUIET.name && quietBack?.shownFrom?.door === 'ask', 'and on the copy made while it was off, with the door');
    assert((await read(idOf('quiet'), robin))?.shownNameOff === undefined, 'its author\'s read no longer says a name is kept off');
    const rsvpBack = await call('POST', `/api/marketplace/posts/${idOf('riverbendEvent')}/rsvp`, sam, { status: 'going' });
    assert(rsvpBack.status === 409 && String(rsvpBack.body?.error).includes(RIVERBEND.name), `the RSVP refusal names the community again (${rsvpBack.body?.error})`);

    // ── 6. The Find card is unchanged ──
    console.log('\n── 6. The Find card is unchanged ──');
    table = [viewRow(RIVERBEND, true), viewRow(OLDTOWN), viewRow(QUIET, false), viewRow(FORGED, 'false')];
    await runDirectoryMirror();
    const found = await call('GET', `/api/global/communities?q=${encodeURIComponent('Quiet')}`, null);
    assert(found.status === 200 && (found.body?.communities ?? []).some((c: any) => c?.name === QUIET.name),
        `a community that keeps its name off copies is still found (${found.status} ${found.text.slice(0, 160)})`);

    await new Promise<void>((resolve) => registry.close(() => resolve()));
    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ A community\'s name on its members\' listings checks PASSED.');
}

main().then(() => process.exit(0)).catch((e) => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
