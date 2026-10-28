/**
 * A stranger at a community's door: the public card (front doors S15, scratch/fable-design/DESIGN-doors-follow-through-
 * fable.md §4.2; routes/community-card.ts). Over REAL HTTPS through the real middleware, read auth on, as a local
 * community ships:
 *
 *   1. `/` for a browser with no account here is the card, not a redirect to a sign-in form: plain HTML, no script,
 *      under the web app's document policy, with Open Graph tags; the community's name, its member count, its area
 *      and "takes requests to join"; Ask to join to the global community's lobby with this community first, I have an
 *      invite, Already a member, Look around the global community
 *   2. what a stranger reads (Marty, 28 Sep): the card's HTML and GET /api/community/card, unsigned and signed by a key
 *      that is no member, carry no member's name or key, no face, no listing, no balance and no point (not the place,
 *      not rounded); the JSON is the card's fields and nothing else
 *   3. the switches: no member count with "Share member count" off; no area with "Share Location & Radius" off, or
 *      with no town or area named; "by invite" with requests to join off, or the door admins-only; no Ask to join link
 *      while the community isn't listed; a community with no name of its own shows its host
 *   4. the self-hosted node: GLOBAL_COMMUNITY_URL=off, its own domain: "Ask to join from the BeanPool app", and nothing
 *      that links to beanpool.org
 *   5. an Android phone's Ask to join opens the app's card screen, falling back to the lobby
 *   6. who still goes to the web app: a browser that keeps an account here (the web app's hint cookie), any other query
 *      (`?post=`, a sign-in's return), the global community's lobby; `?lang=` and Accept-Language pick the words
 *   7. the owner's town or area: saved by the node config route (text, cut; null clears; anything else refused), and
 *      said by the public node config only where the place is
 *
 * Fail-first: run against origin/main, every section fails (`/` redirects every stranger to /app, and the card's route
 * is gated). Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-community-card.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.PUBLIC_ADDRESS_NAME;
delete process.env.PUBLIC_ADDRESS_AUTO;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.NODE_PROFILE;
delete process.env.GLOBAL_COMMUNITY_URL;
delete process.env.DIRECTORY_UNLISTED;
delete process.env.PRIVATE_PREVIEW;
process.env.REGISTRAR_URL = 'http://127.0.0.1:1';
process.env.DIRECTORY_REGISTRY_URL = 'http://127.0.0.1:1/directory-register';
const ADMIN_PASSWORD = 'CommunityCardAdmin123!';
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;

import crypto from 'node:crypto';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

// Unique enough that a substring can only be these.
const HOST = 'card-test.example.org';
const NAME = 'Sentinelvale Commons';
const AREA = 'Sentinelvale and around';
// The place, and what a stranger's rounding of it would print: neither may appear.
const PLACE = { lat: -37.0657, lng: 144.2169, radiusKm: 12 };
const PLACE_DIGITS = ['37.0657', '144.2169', '-37.07', '144.22', '37.06', '144.21'];
const BALANCE = 4217.5;

interface Id { pk: string; priv: crypto.KeyObject }
function newId(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey };
}

let beforeCall: () => void = () => {};
interface Res { status: number; text: string; body: any; headers: Headers }
async function get(path: string, opts: { id?: Id | null; headers?: Record<string, string> } = {}): Promise<Res> {
    beforeCall();
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = opts.id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`GET\n${path.split('?')[0]}\n${ts}\n${nonce}\n`), opts.id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${path}`, { headers, redirect: 'manual' });
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* HTML */ }
    return { status: res.status, text, body, headers: res.headers };
}

/** The card's Ask to join link in a page, or null. */
const askHref = (html: string) => /<a [^>]*data-door="ask"[^>]*href="([^"]*)"/.exec(html)?.[1]?.replace(/&amp;/g, '&') ?? null;
const hasDoor = (html: string, door: string) => new RegExp(`data-door="${door}"`).test(html);

async function main(): Promise<void> {
    console.log('\n=== A stranger at a community\'s door: the public card (S15) ===\n');
    const { initTls } = await import('./services/tls.js');
    const { initAdminPassword, updateLocalConfig } = await import('./config/local-config.js');
    const se = await import('./state-engine.js');
    const { initStateEngine, updateNodeConfig } = se;
    const { wrapCreatePost, TEST_PHOTO } = await import('./post-test-helper.js');
    const { setMemberPhoto } = await import('@beanpool/engine');
    const createPost = wrapCreatePost(se.createPost);
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { setSwitchOverride } = await import('./config/node-profile.js');
    const { APP_DOCUMENT_CSP } = await import('./app-document-csp.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { pruneAuthAttempts } = await import('./auth-rate-limit.js');
    beforeCall = () => { resetGatewayRateLimit(); pruneAuthAttempts(Date.now() + 120_000); };

    await initTls();
    initAdminPassword();
    initStateEngine();
    const ADMIN = (await import('./admin-auth-test-harness.js')).ownerSessionHeaders();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    // ── the community: three members, one with Beans, a listing; named, on its own domain, listed ────────────────
    const member = (callsign: string): Id => {
        const id = newId();
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code) VALUES (?, ?, 'active', ?, 'seed', ?)`)
            .run(id.pk, callsign, new Date(Date.now() - 30 * 86_400_000).toISOString(), `INV-${callsign.toUpperCase()}`);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, 0)').run(id.pk, 0);
        setMemberPhoto(db, id.pk, TEST_PHOTO);
        return id;
    };
    const alice = member('SentinelAlice');
    const bob = member('SentinelBob');
    const carol = member('SentinelCarol');
    db.prepare('UPDATE accounts SET balance = ? WHERE public_key = ?').run(BALANCE, alice.pk);
    createPost('offer', 'tools', 'Sentinel ladder to lend', 'Sentinel ladder, described', 5, 'fixed', alice.pk, PLACE.lat, PLACE.lng, undefined, false, undefined, false, {});
    const outsider = newId();
    const members = [alice, bob, carol];
    const memberCount = (db.prepare("SELECT COUNT(*) AS c FROM members WHERE status != 'pruned'").get() as { c: number }).c;

    updateLocalConfig({ communityName: NAME, contactEmail: 'sentinel-owner@example.invalid' } as any);
    updateNodeConfig({
        serviceRadius: PLACE, publishLocation: true, publishMembers: true,
        publicAddress: { mode: 'own', hostname: HOST, status: 'live', since: new Date().toISOString() },
        lastDirectoryPush: new Date().toISOString(),
        areaName: AREA,
    } as any);

    /** Everything a stranger must never read, in a body. */
    const leaks = (text: string): string[] => {
        const found: string[] = [];
        for (const m of members) if (text.includes(m.pk)) found.push('a member key');
        for (const n of ['SentinelAlice', 'SentinelBob', 'SentinelCarol']) if (text.includes(n)) found.push(n);
        if (text.includes('Sentinel ladder')) found.push('a listing');
        if (text.includes('/api/avatar/')) found.push('a face');
        if (text.includes('4217')) found.push('a balance');
        if (text.includes('sentinel-owner@')) found.push('the contact');
        for (const d of PLACE_DIGITS) if (text.includes(d)) found.push(`a point (${d})`);
        return found;
    };

    // ── 1. the card at `/` ─────────────────────────────────────────────────────────────────────────────────────
    const page = await get('/');
    assert(page.status === 200 && (page.headers.get('content-type') || '').includes('text/html'),
        `GET / for a stranger is the card, 200 HTML (got ${page.status} ${page.headers.get('location') ?? ''})`);
    assert(page.text.includes('data-testid="community-card"'), 'the page is the community card');
    assert(!/<script/i.test(page.text) && !/\son[a-z]+=/i.test(page.text), 'the card runs no script: no <script>, no inline handler');
    assert(page.headers.get('content-security-policy') === APP_DOCUMENT_CSP, "the card is served under the web app's document policy (no inline script on the seed's origin)");
    assert(page.text.includes(`<h1 dir="auto">${NAME}</h1>`), 'the card names the community');
    assert(page.text.includes(`<meta property="og:title" content="${NAME}">`) && /<meta property="og:description" content="[^"]+">/.test(page.text),
        'a link to it previews with the name and a description (Open Graph)');
    assert(page.text.includes(`data-fact="members">${memberCount} members<`), `the card says how many members (${memberCount}), with the count shared`);
    assert(page.text.includes(`data-fact="area" dir="auto">${AREA}, within about 12 km<`), "the card names the area in the owner's words, with the radius");
    assert(page.text.includes('Takes requests to join'), 'the card says it takes requests to join');
    assert(askHref(page.text) === `https://global.beanpool.org/?ask=${HOST}`,
        `Ask to join opens the global community's lobby with this community first (got ${askHref(page.text)})`);
    assert(/data-door="invite" href="\/app\?door=invite"/.test(page.text), 'I have an invite opens the invite form');
    assert(/data-door="signin" href="\/app\?door=signin"/.test(page.text), 'Already a member opens the sign-in');
    assert(/data-door="global" href="https:\/\/global\.beanpool\.org"/.test(page.text), 'Look around the global community is there');

    // ── 2. what a stranger reads ───────────────────────────────────────────────────────────────────────────────
    const unsigned = await get('/api/community/card');
    const signed = await get('/api/community/card', { id: outsider });
    assert(unsigned.status === 200 && signed.status === 200, `GET /api/community/card is public under read auth, unsigned and signed by a non-member (${unsigned.status}, ${signed.status})`);
    assert(JSON.stringify(unsigned.body) === JSON.stringify(signed.body), 'a non-member signer reads what an unsigned caller does');
    const keys = Object.keys(unsigned.body ?? {}).sort().join(',');
    assert(keys === 'area,askUrl,globalUrl,host,joining,members,name', `the card's JSON is the card's fields and nothing else (${keys})`);
    assert(unsigned.body?.name === NAME && unsigned.body?.host === HOST && unsigned.body?.members === memberCount
        && unsigned.body?.area?.name === AREA && unsigned.body?.area?.radiusKm === 12 && unsigned.body?.joining === 'requests',
        `the JSON says the name, host, members, area and joining (${JSON.stringify(unsigned.body)})`);
    for (const [who, text] of [['the page', page.text], ['the JSON, unsigned', unsigned.text], ['the JSON, signed by a non-member', signed.text]] as const) {
        const found = leaks(text);
        assert(found.length === 0, `${who} carries no member name or key, face, listing, balance, contact or point${found.length ? ` — found ${found.join(', ')}` : ''}`);
    }
    // The point is the area's words alone: no lat/lng field at any depth.
    const latLng = /"(lat|lng|latitude|longitude)"\s*:/.test(unsigned.text);
    assert(!latLng, 'the JSON has no lat or lng field');

    // ── 3. the switches ────────────────────────────────────────────────────────────────────────────────────────
    updateNodeConfig({ publishMembers: false });
    let p = await get('/');
    let j = (await get('/api/community/card')).body;
    assert(j?.members === null && !p.text.includes('data-fact="members"') && !p.text.includes(`${memberCount} members`),
        'with "Share member count" off, no member count, on the page or in the JSON');
    updateNodeConfig({ publishMembers: true, publishLocation: false });
    p = await get('/');
    j = (await get('/api/community/card')).body;
    assert(j?.area === null && !p.text.includes(AREA), 'with "Share Location & Radius" off, no area: the town is the place in words');
    updateNodeConfig({ publishLocation: true, areaName: null } as any);
    j = (await get('/api/community/card')).body;
    assert(j?.area === null, 'with no town or area named, no area (never the point instead)');
    updateNodeConfig({ areaName: AREA } as any);

    setSwitchOverride('knocks', false);
    p = await get('/');
    j = (await get('/api/community/card')).body;
    assert(j?.joining === 'invite' && j?.askUrl === null && p.text.includes('Takes new members by invite') && askHref(p.text) === null && !p.text.includes('data-door="ask'),
        'with requests to join off, "by invite" and no Ask to join');
    setSwitchOverride('knocks', true);
    db.prepare("INSERT INTO node_config (key, value) VALUES ('door', 'admins') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    j = (await get('/api/community/card')).body;
    assert(j?.joining === 'invite', 'with only admins inviting, "by invite" (the directory says the same)');
    db.prepare("DELETE FROM node_config WHERE key = 'door'").run();

    updateNodeConfig({ lastDirectoryPush: undefined } as any);
    p = await get('/');
    j = (await get('/api/community/card')).body;
    assert(j?.joining === 'requests' && j?.askUrl === null && askHref(p.text) === null && p.text.includes('Ask to join from the BeanPool app.'),
        "not in the directory yet: the lobby couldn't show it, so no lobby link; Ask to join from the BeanPool app");
    updateNodeConfig({ lastDirectoryPush: new Date().toISOString() });

    updateLocalConfig({ communityName: 'BeanPool Community' } as any);
    p = await get('/');
    j = (await get('/api/community/card')).body;
    assert(j?.name === null && p.text.includes(`<h1 dir="auto">${HOST}</h1>`), 'a community with no name of its own shows its host, never "BeanPool Community"');
    updateLocalConfig({ communityName: '<img src=x onerror=alert(1)>Vale' } as any);
    p = await get('/');
    assert(!p.text.includes('<img src=x') && p.text.includes('&lt;img src=x onerror=alert(1)&gt;Vale'), "the community's name is escaped, never markup");
    updateLocalConfig({ communityName: NAME } as any);

    // ── 4. the self-hosted node: its own domain, no global community ──────────────────────────────────────────
    process.env.GLOBAL_COMMUNITY_URL = 'off';
    p = await get('/');
    j = (await get('/api/community/card')).body;
    assert(j?.askUrl === null && j?.globalUrl === null, 'GLOBAL_COMMUNITY_URL=off: no lobby link and no global community in the JSON');
    assert(p.text.includes('Ask to join from the BeanPool app.') && askHref(p.text) === null && !hasDoor(p.text, 'global'),
        'the self-hosted card says "Ask to join from the BeanPool app", with no link to a global community');
    assert(!/beanpool\.org/i.test(p.text), 'the self-hosted card links nothing of beanpool.org');
    process.env.GLOBAL_COMMUNITY_URL = 'https://lobby.example.net';
    j = (await get('/api/community/card')).body;
    assert(j?.askUrl === `https://lobby.example.net/?ask=${HOST}` && j?.globalUrl === 'https://lobby.example.net',
        "a node that names its own global community sends strangers there, not to ours");
    for (const [named, ask] of [
        ['https://lobby.example.net/', `https://lobby.example.net/?ask=${HOST}`],
        ['https://lobby.example.net/lobby/', `https://lobby.example.net/lobby/?ask=${HOST}`],
        ['https://lobby.example.net/?a=b#top', `https://lobby.example.net/?ask=${HOST}`],
    ]) {
        process.env.GLOBAL_COMMUNITY_URL = named;
        j = (await get('/api/community/card')).body;
        assert(j?.askUrl === ask, `GLOBAL_COMMUNITY_URL=${named}: Ask to join is ${ask}, never a doubled slash or a second query (${j?.askUrl})`);
    }
    delete process.env.GLOBAL_COMMUNITY_URL;

    // ── 5. an Android phone ───────────────────────────────────────────────────────────────────────────────────
    const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
    p = await get('/', { headers: { 'User-Agent': ANDROID } });
    const href = askHref(p.text) ?? '';
    assert(href.startsWith(`intent://community-card?node=${encodeURIComponent(`https://${HOST}`)}#Intent;scheme=beanpool;package=org.beanpool.pillar;`)
        && href.includes(`S.browser_fallback_url=${encodeURIComponent(`https://global.beanpool.org/?ask=${HOST}`)};`) && href.endsWith('end'),
        `on Android, Ask to join opens the app's card screen, else the lobby (${href.slice(0, 90)}…)`);
    assert(p.headers.get('vary')?.toLowerCase().includes('user-agent') === true, 'the answer varies by User-Agent, so no cache hands a computer the phone\'s');

    // ── 6. who still goes to the web app ──────────────────────────────────────────────────────────────────────
    const hinted = await get('/', { headers: { Cookie: 'bp_account_here=1' } });
    assert(hinted.status === 302 && hinted.headers.get('location') === '/app', `a browser that keeps an account here opens the web app as before (${hinted.status} ${hinted.headers.get('location')})`);
    const post = await get('/?post=abc-123');
    assert(post.status === 302 && post.headers.get('location') === '/app?post=abc-123', 'a shared post link still goes to the web app, query and all');
    const es = await get('/?lang=es');
    assert(es.status === 200 && es.text.startsWith('<!doctype html>\n<html lang="es"'), '?lang=es: the card in Spanish (its lang attribute)');
    const ar = await get('/', { headers: { 'Accept-Language': 'ar-EG,ar;q=0.9,en;q=0.5' } });
    assert(ar.text.includes('<html lang="ar" dir="rtl">'), "Accept-Language picks the card's language, right to left for Arabic");
    process.env.NODE_PROFILE = 'global';
    const lobby = await get('/');
    assert(lobby.status === 302 && lobby.headers.get('location') === '/app', "the global community's root stays its lobby");
    delete process.env.NODE_PROFILE;

    // ── 7. the owner's town or area ─────────────────────────────────────────────────────────────────────────────
    const save = async (body: unknown) => {
        beforeCall();
        const res = await fetch(`${BASE}/api/local/admin/node/config`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...ADMIN }, body: JSON.stringify(body) });
        return { status: res.status, body: await res.json().catch(() => null) as any };
    };
    let saved = await save({ areaName: `  Sentinel‮ton\n${'x'.repeat(80)}` });
    j = (await get('/api/community/card')).body;
    assert(saved.status === 200 && j?.area?.name === `Sentinelton ${'x'.repeat(48)}`,
        `the node config route keeps the town or area cleaned and cut to 60 characters (${JSON.stringify(j?.area?.name)})`);
    saved = await save({ areaName: 42 });
    assert(saved.status === 400 && saved.body?.code === 'bad_area_name', 'a town or area that is not text is refused');
    saved = await save({ areaName: null });
    j = (await get('/api/community/card')).body;
    assert(saved.status === 200 && j?.area === null, 'null clears it');
    await save({ areaName: AREA });
    const cfg = await get('/api/node/config');
    assert(cfg.body?.areaName === AREA, 'the public node config says the area with the place shared');
    updateNodeConfig({ publishLocation: false });
    const cfgOff = await get('/api/node/config');
    assert(cfgOff.body?.areaName === null && cfgOff.body?.serviceRadius === null, 'and nothing of it with the place off, as the place');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ community-card checks PASSED.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
