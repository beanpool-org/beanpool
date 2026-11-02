/**
 * Slice G3 (DESIGN-list-on-global-fable.md §11): the web app's tick reaches the global community from the member's own
 * community, through the real middleware. `TEST_COPY_PROFILE=local` is the same run on a local community.
 *
 *   Global: a signed create from another origin answers 201, readable, with the headers the web app signs with and nothing
 *   else; so do its edit, read by id, cancelled date, and remove, and the signer's own "am I a member?". The answer is `*`, never
 *   the origin, with no Vary and no credentials: the same whoever asks, so an Origin keys nothing, and nothing it said is
 *   left in the post, in the log or anywhere in the database. From another site only a copy passes: an ordinary post, and an
 *   edit, a remove or a read that reaches one, are refused, however the id is written. An unsigned call, a search, a member's
 *   listings, a blank id (which the route reads as no id, the whole board) and every other route get no allowance. What is
 *   sent counts as a phone's does: a signed call needs a real signature and the member's
 *   limits hold, and money stays refused. Global's own web app, and an origin the operator lists, are as they were.
 *   Local: nothing of it opens, on any of those routes, and the ordinary post stays as it was.
 *
 * Run: via scripts/run-server-suites.mjs (SERVER_SUITES_ONLY=test-copy-cors, which runs both)
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
process.env.NODE_PROFILE = process.env.TEST_COPY_PROFILE === 'local' ? 'community' : 'global';

import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildBoundRequestHeaders } from '@beanpool/core';
import { localFetch } from './keepalive-test-fetch.js';
import { TEST_PHOTOS } from './post-test-helper.js';

const ONLOCAL = process.env.TEST_COPY_PROFILE === 'local';
const ORIGIN = 'https://secret-valley.example';
const LISTED = 'https://listed.example';
const POSTS = '/api/marketplace/posts';
const SIGNED_HEADERS = ['content-type', 'x-public-key', 'x-signature', 'x-timestamp', 'x-nonce', 'x-signed-for'];

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

interface Id { pk: string; priv: crypto.KeyObject }
function newId(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey };
}

type Answer = { res: Response; body: any };

async function preflight(path: string, method: string, origin = ORIGIN, headers: string[] = SIGNED_HEADERS): Promise<Response> {
    const res = await localFetch(`${BASE}${path}`, {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': headers.join(',') },
    });
    await res.text();
    return res;
}

/** Signed as the web app signs it (apps/pwa lib/api.ts signedFetchAt), from a page on `origin`, with what a browser adds. */
async function signed(id: Id, method: 'GET' | 'POST' | 'DELETE', path: string, sent?: unknown, origin: string | null = ORIGIN, site = 'cross-site'): Promise<Answer> {
    const url = `${BASE}${path}`;
    const text = sent === undefined ? '' : JSON.stringify(sent);
    const bound = await buildBoundRequestHeaders({ method, url, body: text, publicKeyHex: id.pk, sign: (b) => crypto.sign(null, Buffer.from(b), id.priv) });
    const res = await localFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...bound, ...(origin ? { Origin: origin, 'Sec-Fetch-Site': site } : {}) },
        ...(sent === undefined ? {} : { body: text }),
    });
    const raw = await res.text();
    let body: any;
    try { body = JSON.parse(raw); } catch { body = undefined; }
    return { res, body };
}

const acao = (r: Response) => r.headers.get('access-control-allow-origin');
const lower = (s: string | null): string[] => (s ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

function everyTextFileHolds(dir: string, needle: string): string[] {
    const found: string[] = [];
    for (const name of readdirSync(dir)) {
        const file = join(dir, name);
        if (statSync(file).isDirectory()) found.push(...everyTextFileHolds(file, needle));
        else if (readFileSync(file).includes(needle)) found.push(file);
    }
    return found;
}

const copyBody = (id: string, me: Id, extra: Record<string, unknown> = {}) => ({
    id, type: 'offer', category: 'food', title: 'Tomatoes', description: 'From the garden', authorPublicKey: me.pk,
    lat: -28.7, lng: 153.5, photos: TEST_PHOTOS, shownPrice: { beans: 20, per: 'fixed' },
    shownFrom: { host: 'secret-valley.example', postId: 'home-1' }, ...extra,
});

async function onGlobal(member: Id, db: any): Promise<void> {
    console.log('── the preflights ──');
    for (const [path, method] of [[POSTS, 'POST'], [`${POSTS}/update`, 'POST'], [`${POSTS}/remove`, 'POST'], [`${POSTS}/takes-questions`, 'POST'], [`${POSTS}?id=x`, 'GET'], ['/api/events/x/skip', 'POST'], ['/api/events/x/skip?date=2030-01-01', 'DELETE'], [`/api/community/membership/${member.pk}`, 'GET'], ['/api/me/unread', 'GET']] as const) {
        const pre = await preflight(path, method);
        assert(pre.status === 204 && acao(pre) === '*', `${method} ${path}: allowed from another origin (${pre.status}, ${acao(pre)})`);
        assert(lower(pre.headers.get('access-control-allow-methods')).includes(method.toLowerCase()), `${method} ${path}: its method is named`);
        assert(pre.headers.get('access-control-allow-credentials') === null, `${method} ${path}: never with credentials`);
        assert(!(pre.headers.get('vary') ?? '').toLowerCase().includes('origin'), `${method} ${path}: no Vary on the Origin`);
        const allowed = lower(pre.headers.get('access-control-allow-headers'));
        assert(SIGNED_HEADERS.every((h) => allowed.includes(h)) && allowed.length === SIGNED_HEADERS.length, `${method} ${path}: the signature's headers and no others (${allowed.join(' ')})`);
    }

    console.log('── what a tick does, signed, from another origin ──');
    const id = crypto.randomUUID();
    const made = await signed(member, 'POST', POSTS, copyBody(id, member));
    assert(made.res.status === 200 && made.body?.post?.shownCopy === true, `a signed create from another origin lands, as the route has always answered it, 200 (${made.res.status} ${JSON.stringify(made.body?.error ?? '')})`);
    assert(acao(made.res) === '*', `its answer is readable there (${acao(made.res)})`);
    assert(made.res.headers.get('access-control-allow-credentials') === null, 'with no credentials');
    assert(!made.body?.post?.shownFrom, 'a community the directory does not show has no line');
    const stored = db.prepare('SELECT shown_from_host, shown_from_post_id, credits, lat, lng FROM posts WHERE id = ?').get(id) as any;
    assert(stored?.shown_from_host === '' && stored?.shown_from_post_id === null, `nothing of where it came from is kept (${JSON.stringify(stored)})`);
    assert(stored?.credits === 0, 'money stays refused: it holds 0 Beans');
    const seen = await signed(member, 'GET', `${POSTS}?id=${id}`);
    assert(seen.res.status === 200 && acao(seen.res) === '*' && seen.body?.[0]?.shownCopy === true, `the read by id (${seen.res.status}, ${acao(seen.res)})`);
    const some = await signed(member, 'GET', `${POSTS}?ids=${id},${crypto.randomUUID()}`);
    assert(some.res.status === 200 && acao(some.res) === '*' && some.body?.length === 1, `the read by ids (${some.res.status}, ${acao(some.res)})`);
    const edited = await signed(member, 'POST', `${POSTS}/update`, { id, title: 'Ripe tomatoes', credits: 500, authorPublicKey: member.pk });
    assert(edited.res.status === 200 && acao(edited.res) === '*' && edited.body?.post?.title === 'Ripe tomatoes', `the edit (${edited.res.status} ${JSON.stringify(edited.body?.error ?? '')})`);
    assert((db.prepare('SELECT credits FROM posts WHERE id = ?').get(id) as any)?.credits === 0, 'an edit from another origin moves no money');
    const again = await signed(member, 'POST', POSTS, copyBody(id, member));
    assert(again.res.status === 400 && again.body?.code === 'post_id_taken' && acao(again.res) === '*', `a create on an id global holds says so in a code a browser can read (${again.res.status} ${again.body?.code}, ${acao(again.res)})`);
    const standing = await signed(member, 'GET', `/api/community/membership/${member.pk}`);
    assert(standing.res.status === 200 && acao(standing.res) === '*' && standing.body?.isMember === true, `the signer's own "am I a member?" (${standing.res.status})`);
    const elsesStanding = await signed(newId(), 'GET', `/api/community/membership/${member.pk}`);
    assert(elsesStanding.res.status === 403, `another key's standing stays refused (${elsesStanding.res.status})`);

    console.log('── from another site, only a copy ──');
    const plainId = crypto.randomUUID();
    const plain = await signed(member, 'POST', POSTS, { ...copyBody(plainId, member), shownFrom: undefined, shownPrice: undefined, credits: 5 });
    assert(plain.res.status === 403 && plain.body?.code === 'copy_only', `an ordinary post from another site is refused (${plain.res.status} ${plain.body?.code})`);
    assert(!db.prepare('SELECT 1 FROM posts WHERE id = ?').get(plainId), 'and nothing was stored');
    const fromNext = await signed(member, 'POST', POSTS, { ...copyBody(plainId, member), shownFrom: undefined, shownPrice: undefined, credits: 5 }, 'https://next.example', 'same-site');
    assert(fromNext.res.status === 403, `a neighbour under one domain is another origin all the same (${fromNext.res.status})`);
    const own = await signed(member, 'POST', POSTS, { ...copyBody(plainId, member), shownFrom: undefined, shownPrice: undefined, credits: 0 }, BASE, 'same-origin');
    assert(own.res.status === 200 && !own.body?.post?.shownCopy, `global's own web app posts as it always has (${own.res.status} ${JSON.stringify(own.body?.error ?? '')})`);
    const noSite = await signed(member, 'POST', `${POSTS}/update`, { id: plainId, title: 'From a script', authorPublicKey: member.pk }, null);
    assert(noSite.res.status === 200, `a phone sends no Origin, and is as it was (${noSite.res.status})`);
    const editOther = await signed(member, 'POST', `${POSTS}/update`, { id: plainId, title: 'Across', authorPublicKey: member.pk });
    assert(editOther.res.status === 403 && editOther.body?.code === 'copy_only', `an edit of an ordinary post from another site is refused (${editOther.res.status})`);
    const removeOther = await signed(member, 'POST', `${POSTS}/remove`, { id: plainId, authorPublicKey: member.pk });
    assert(removeOther.res.status === 403, `so is its remove (${removeOther.res.status})`);
    const unread = await signed(member, 'GET', '/api/me/unread');
    assert(unread.res.status === 200 && typeof unread.body?.requests === 'number' && acao(unread.res) === '*', `the signer's own counts open from another site, for the one Message requests row (${unread.res.status}, ${acao(unread.res)})`);
    const doorOther = await signed(member, 'POST', `${POSTS}/takes-questions`, { id: plainId, on: true });
    assert(doorOther.res.status === 403, `and a door on it (${doorOther.res.status})`);
    const readOther = await signed(member, 'GET', `${POSTS}?id=${plainId}`);
    assert(readOther.res.status === 403, `so is a read by id of it (${readOther.res.status})`);
    const readBoth = await signed(member, 'GET', `${POSTS}?ids=${id},${plainId}`);
    assert(readBoth.res.status === 403, `and a read that takes one along (${readBoth.res.status})`);
    const skipOther = await signed(member, 'POST', `/api/events/${plainId}/skip`, { date: '2030-01-04' });
    assert(skipOther.res.status === 403, `and a date of it (${skipOther.res.status})`);
    // The driver binds a list as its items, so `[x]` reaches post x as `x` does. The guard can't read that as "names no post".
    const rowOf = () => db.prepare('SELECT title, status FROM posts WHERE id = ?').get(plainId) as { title: string; status: string };
    const asFound = rowOf();
    for (const [what, value] of [['a list', [plainId]], ['a list in a list', [[plainId]]], ['an object', { id: plainId }], ['a number', 1]] as const) {
        const editList = await signed(member, 'POST', `${POSTS}/update`, { id: value, title: 'Through a list', authorPublicKey: member.pk });
        assert(editList.res.status === 403 && editList.body?.code === 'copy_only', `an edit naming its post as ${what} is refused (${editList.res.status} ${editList.body?.code})`);
        const removeList = await signed(member, 'POST', `${POSTS}/remove`, { id: value, authorPublicKey: member.pk });
        assert(removeList.res.status === 403 && removeList.body?.code === 'copy_only', `so is a remove (${removeList.res.status} ${removeList.body?.code})`);
    }
    assert(JSON.stringify(rowOf()) === JSON.stringify(asFound), `and the ordinary post is as it was (${JSON.stringify(rowOf())})`);

    console.log('── nothing else opens ──');
    const unsigned = await localFetch(`${BASE}${POSTS}?id=${id}`, { headers: { Origin: ORIGIN } });
    await unsigned.text();
    assert(acao(unsigned) === null, `an unsigned read of the same URL is not readable there (${acao(unsigned)})`);
    const unsignedPre = await preflight(POSTS, 'POST', ORIGIN, ['content-type']);
    assert(acao(unsignedPre) === null, 'a preflight that does not say it will sign gets nothing');
    for (const [path, method] of [
        [`${POSTS}?author=${member.pk}`, 'GET'], [`${POSTS}?q=tomatoes`, 'GET'], [`${POSTS}?id=x&author=y`, 'GET'], [POSTS, 'GET'],
        [`${POSTS}/accept`, 'POST'], [`${POSTS}/request`, 'POST'], [`${POSTS}/pause`, 'POST'], ['/api/marketplace/transactions/approve', 'POST'],
        ['/api/community/members', 'GET'], ['/api/messages', 'POST'], ['/api/events/x/rsvp', 'POST'], ['/api/join/open', 'POST'], ['/api/community/membership/x/y', 'GET'],
        [`${POSTS}/${id}`, 'GET'], ['/api/community/me', 'GET'], [`${POSTS}?id=${id}&id=${plainId}`, 'GET'], [`${POSTS}?ids=${id}&ids=${plainId}`, 'GET'],
        // A blank id is no id to the route, and no id is the whole board, whichever way it is spelled.
        [`${POSTS}?id=`, 'GET'], [`${POSTS}?id`, 'GET'], [`${POSTS}?%69d=`, 'GET'], [`${POSTS}?id=%20`, 'GET'], [`${POSTS}?id=+`, 'GET'], [`${POSTS}?id=%09`, 'GET'],
        [`${POSTS}?id=&id=`, 'GET'], [`${POSTS}?id=&ids=`, 'GET'], [`${POSTS}?ids=`, 'GET'], [`${POSTS}?ids`, 'GET'], [`${POSTS}?ids=,`, 'GET'], [`${POSTS}?ids=%20`, 'GET'],
        [`${POSTS}?ids=%20,%20`, 'GET'], [`${POSTS}?ids=&ids=`, 'GET'],
        // And the same read by another name or method: none of these is the listings' read by id.
        [`${POSTS}?ID=`, 'GET'], [`${POSTS}?ID=x`, 'GET'], [`${POSTS}?id[]=`, 'GET'], [`${POSTS}?id[]=x`, 'GET'], [`${POSTS}/?id=`, 'GET'], [`${POSTS}/?id=x`, 'GET'], [`${POSTS}?id=x`, 'HEAD'],
    ] as const) {
        const closed = await preflight(path, method);
        assert(acao(closed) === null && closed.headers.get('access-control-allow-headers') === null, `${method} ${path}: no allowance (${acao(closed)})`);
    }
    // What the preflights above stop, the read itself: a page can mint a key for free, so the signature stops nobody here.
    for (const blank of ['?id=', '?id', '?%69d=']) {
        const board = await signed(newId(), 'GET', `${POSTS}${blank}`);
        assert(acao(board.res) === null, `${blank}, signed by a throwaway key: the board isn't readable there (${board.res.status}, ${acao(board.res)})`);
    }
    const padded = await signed(newId(), 'GET', `${POSTS}?id=%20${plainId}`);
    assert(padded.res.status === 403 && padded.body?.code === 'copy_only', `an id with a space on it reads as that id: refused (${padded.res.status})`);

    console.log('── a call counts as a phone\'s does ──');
    const stranger = await signed(newId(), 'POST', POSTS, copyBody(crypto.randomUUID(), newId()));
    assert(stranger.res.status >= 400 && stranger.res.status < 500, `a key that is not the body's author is refused (${stranger.res.status})`);
    const forged = await localFetch(`${BASE}${POSTS}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'Sec-Fetch-Site': 'cross-site', 'x-public-key': member.pk, 'x-signature': 'AAAA', 'x-timestamp': String(Date.now()), 'x-nonce': 'n'.repeat(32) },
        body: JSON.stringify(copyBody(crypto.randomUUID(), member)),
    });
    await forged.text();
    assert(forged.status === 403, `a signature that doesn't verify stays refused (${forged.status})`);
    let limited = 0;
    for (let i = 0; i < 5; i++) {
        const more = await signed(member, 'POST', POSTS, copyBody(crypto.randomUUID(), member));
        if (more.res.status === 429 || (more.res.status === 400 && /day|limit|today/i.test(more.body?.error ?? '')) || more.res.status === 403) limited++;
    }
    assert(limited > 0, `the new account's day limit counts these (${limited} of 5 refused)`);

    console.log('── the Origin is left nowhere ──');
    const dir = process.env.BEANPOOL_DATA_DIR!;
    db.pragma?.('wal_checkpoint(TRUNCATE)');
    assert(everyTextFileHolds(dir, 'secret-valley').length === 0, `no file under the data folder holds the origin or the host (${everyTextFileHolds(dir, 'secret-valley').join(' ')})`);

    console.log('── an origin the operator lists keeps its rule ──');
    const { updateGatewayConfig } = await import('./config/local-config.js');
    updateGatewayConfig({ corsAllowedOrigins: [LISTED] });
    const listed = await signed(member, 'POST', `${POSTS}/update`, { id: plainId, title: 'Listed', authorPublicKey: member.pk }, LISTED);
    assert(listed.res.status === 200 && acao(listed.res) === LISTED, `a listed origin edits an ordinary post as it always could (${listed.res.status}, ${acao(listed.res)})`);
    updateGatewayConfig({ corsAllowedOrigins: [] });

    const removed = await signed(member, 'POST', `${POSTS}/remove`, { id, authorPublicKey: member.pk });
    assert(removed.res.status === 200 && acao(removed.res) === '*', `the remove (${removed.res.status}, ${acao(removed.res)})`);
}

async function onLocal(member: Id): Promise<void> {
    for (const [path, method] of [[POSTS, 'POST'], [`${POSTS}/update`, 'POST'], [`${POSTS}/remove`, 'POST'], [`${POSTS}/takes-questions`, 'POST'], [`${POSTS}?id=x`, 'GET'], ['/api/events/x/skip', 'POST'], [`/api/community/membership/${member.pk}`, 'GET'], ['/api/me/unread', 'GET']] as const) {
        const pre = await preflight(path, method);
        assert(acao(pre) === null && pre.headers.get('access-control-allow-headers') === null, `${method} ${path}: a local community allows no other origin (${acao(pre)})`);
    }
    const made = await signed(member, 'POST', POSTS, copyBody(crypto.randomUUID(), member));
    assert(acao(made.res) === null, `a signed create from another origin is not readable there: the browser refuses it (${made.res.status}, ${acao(made.res)})`);
    const own = await signed(member, 'POST', POSTS, { ...copyBody(crypto.randomUUID(), member), shownFrom: undefined, shownPrice: undefined, credits: 0 }, BASE, 'same-origin');
    assert(own.body?.code !== 'copy_only', `its own web app is as it was (${own.res.status})`);
    const unrefused = await signed(member, 'POST', `${POSTS}/update`, { id: 'x', title: 'y', authorPublicKey: member.pk });
    assert(unrefused.body?.code !== 'copy_only', 'the guard never runs here: nothing was opened for it to hold');
}

async function main(): Promise<void> {
    console.log(`\n=== G3: the web app's tick on ${ONLOCAL ? 'a local community' : 'the global community'} ===\n`);
    if (!process.env.BEANPOOL_DATA_DIR) throw new Error('BEANPOOL_DATA_DIR must be set');
    const { initTls } = await import('./services/tls.js');
    const { initStateEngine, seedGenesisMember, registerMember } = await import('./state-engine.js') as any;
    const { updateGatewayConfig } = await import('./config/local-config.js');
    const { db } = await import('./db/db.js');
    await initTls();
    initStateEngine();
    const member = newId();
    seedGenesisMember(newId().pk, 'Olive');
    updateGatewayConfig({ corsAllowedOrigins: [], rateLimiting: { enabled: false } } as any);
    const { startHttpsServer } = await import('./https-server.js');
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    if (registerMember) registerMember(member.pk, 'River');
    db.prepare("INSERT OR IGNORE INTO members (public_key, callsign, joined_at, status) VALUES (?, ?, ?, 'active')").run(member.pk, 'River', new Date().toISOString());
    await (ONLOCAL ? onLocal(member) : onGlobal(member, db));
    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ The web app reaches global for a copy and nothing else, and a local community opened nothing.');
}

// The suite is both runs: the local one in a process of its own, as its profile is read at boot.
if (!ONLOCAL) {
    const entry = process.argv[1];
    const local = spawnSync(process.execPath, [...process.execArgv, entry], {
        stdio: 'inherit', env: { ...process.env, TEST_COPY_PROFILE: 'local', BEANPOOL_DATA_DIR: `${process.env.BEANPOOL_DATA_DIR}-local` },
    });
    if (local.status !== 0) { console.error('❌ The local run failed'); process.exit(1); }
}
main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error('❌ Test failed:', e); process.exit(1); });
