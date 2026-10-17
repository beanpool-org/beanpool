// The control room behind Cloudflare Access (Marty, 2026-10-17: "people shouldn't be seeing this page at all unless they
// have 2FA" — "convert the admin page to be 2FA, not a key"), and "Free all and remove" (18 Oct: every July test name
// gone; 43 of the 45 released rows on the live D1 were released by their own key, which forget refuses).
// A locally made RSA key pair stands in for the team's Access keys: the Worker's fetch of
// https://<team>/cdn-cgi/access/certs is answered here, and counted. Each world has its own team, so its own key cache.
// On origin/main (40b66e85) 18 of these 19 fail — no /whoami (404), the JWT ignored and ADMIN_SECRET still accepted
// under Access, /admin served to anyone, events saying "the admin"; the bulk forget ignores free_now and refuses a
// release its old key can take back. The one that passes there is the guard that node routes need nothing (measured).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import worker, { holdsName, isOwnRow } from '../src/index.js';
import { world, makeKey, liveName, nowS, routing } from './harness.js';

const DAY = 86400;
const AUD = 'aud-test-0123456789abcdef0123456789abcdef';
const EMAIL = 'martin@cytec.com.au';
const SECRET = { 'x-admin-secret': 'test-admin-secret' };
const ADMIN_API = '/api/local/admin/registrar';
const SKEW = 60;   // src/access.js ACCESS_SKEW_S

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const enc = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

async function rsaKey() {
    const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    return { pair, kid: crypto.randomUUID().replace(/-/g, ''), jwk: await crypto.subtle.exportKey('jwk', pair.publicKey) };
}
// As https://<team>/cdn-cgi/access/certs lists a key.
const certOf = (k) => ({ kid: k.kid, kty: 'RSA', alg: 'RS256', use: 'sig', e: k.jwk.e, n: k.jwk.n });

// A world with Access configured: ACCESS_TEAM_DOMAIN (its own), ACCESS_AUD, ADMIN_EMAILS (two, one upper-case, spaced).
// ADMIN_SECRET is still set (harness), so a test can show it opens nothing. `certs.answer`: replaces the certs answer.
async function accessWorld({ env } = {}) {
    const team = `t${crypto.randomUUID().slice(0, 8)}.cloudflareaccess.com`;
    const key = await rsaKey();
    const w = await world({ env: { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: AUD, ADMIN_EMAILS: `someone@example.org, ${EMAIL.toUpperCase()}`, ...env } });
    const certs = { keys: [key], calls: 0, answer: null };
    const inner = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        if (url.hostname !== team) return inner(input, init);
        assert.equal(url.pathname, '/cdn-cgi/access/certs');
        certs.calls++;
        if (certs.answer) return certs.answer();
        return Response.json({ keys: certs.keys.map(certOf), public_cert: { kid: key.kid, cert: 'not used' }, public_certs: [] });
    };
    // Access's app token, as Cloudflare signs it; `extra` overrides a claim (undefined leaves it out).
    const claims = (extra) => ({
        aud: [AUD], email: EMAIL, exp: nowS() + 3600, iat: nowS(), nbf: nowS(), iss: `https://${team}`,
        type: 'app', identity_nonce: 'n0nce', sub: 'user-1', country: 'AU', ...extra,
    });
    const mint = async (extra = {}, { k = key, signer = k, header = {} } = {}) => {
        const h = enc({ alg: 'RS256', kid: k.kid, typ: 'JWT', ...header });
        const p = enc(claims(extra));
        const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signer.pair.privateKey, new TextEncoder().encode(`${h}.${p}`));
        return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
    };
    // The harness's admin(), signed in by Access instead of the secret.
    const admin = async (name, action, body) => call(w, req(`${ADMIN_API}/${name}/${action}`, { method: 'POST', token: await mint(), body }));
    return Object.assign(w, { team, key, certs, mint, admin });
}

// A request as Access passes it on: its token in Cf-Access-Jwt-Assertion; a POST as the page sends it (x-bp-admin: 1).
function req(path, { method = 'GET', token, headers = {}, body } = {}) {
    return new Request(`https://beanpool.org${path}`, {
        method,
        headers: {
            ...(token === undefined ? {} : { 'cf-access-jwt-assertion': token }),
            ...(method === 'POST' ? { 'x-bp-admin': '1', 'content-type': 'application/json' } : {}),
            ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}
async function call(w, r) {
    const res = await worker.fetch(r, w.env);
    const text = await res.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* the page, or its refusal */ }
    return { status: res.status, body, headers: res.headers };
}

// Every admin route: the page, the API (its bulk forget both ways, every per-name action), and a path it doesn't know.
const ROUTES = [
    ['GET', '/admin'], ['GET', '/admin/'], ['GET', '/admin.html'],
    ['GET', `${ADMIN_API}/whoami`], ['GET', `${ADMIN_API}/pending`], ['GET', `${ADMIN_API}/events`],
    ['GET', `${ADMIN_API}/alerts`], ['GET', `${ADMIN_API}/servers`],
    ['POST', `${ADMIN_API}/alerts/settings`, { category: 'names', mode: 'off' }], ['POST', `${ADMIN_API}/alerts/test`],
    ['POST', `${ADMIN_API}/forget`, { names: ['guarded'] }], ['POST', `${ADMIN_API}/forget`, { names: ['guarded'], free_now: true }],
    ...['approve', 'pause', 'resume', 'block', 'release', 'revoke', 'forget'].map((a) => ['POST', `${ADMIN_API}/guarded/${a}`, a === 'release' ? { free_now: true } : undefined]),
    ['GET', `${ADMIN_API}/no-such-route`],
];
const isPage = (path) => !path.startsWith(ADMIN_API);

// What an admin route's refusal must leave: the row, Cloudflare, the events, the alert settings and the outbox.
const snapshot = async (w) => ({
    row: await w.row('guarded'), route: routing(w, 'guarded'), events: w.events('guarded'),
    settings: w.sqlite.prepare('SELECT * FROM alert_settings').all().map((r) => ({ ...r })),
    outbox: w.sqlite.prepare('SELECT COUNT(*) AS n FROM alert_outbox').get().n,
});

test('a valid Access token opens every admin route: whoami names the email, the page is served, actions work', async () => {
    const w = await accessWorld();
    try {
        await liveName(w, 'guarded', await makeKey());
        const token = await w.mint();
        assert.deepEqual((await call(w, req(`${ADMIN_API}/whoami`, { token }))).body, { email: EMAIL, via: 'cloudflare-access' });
        for (const path of ['/admin', '/admin/', '/admin.html']) {
            const r = await call(w, req(path, { token }));
            assert.equal(r.status, 200, path);
            assert.match(r.body, /<title>BeanPool DNS & Tunnel Registrar/);
            assert.equal(r.headers.get('x-frame-options'), 'DENY');
        }
        const pending = await call(w, req(`${ADMIN_API}/pending`, { token }));
        assert.equal(pending.status, 200);
        assert.deepEqual(pending.body.allocations.map((a) => a.name), ['guarded']);
        assert.equal((await call(w, req(`${ADMIN_API}/events`, { token }))).status, 200);
        assert.equal((await call(w, req(`${ADMIN_API}/alerts`, { token }))).status, 200);
        assert.equal((await call(w, req(`${ADMIN_API}/servers`, { token }))).status, 200);
        assert.deepEqual((await call(w, req(`${ADMIN_API}/guarded/pause`, { method: 'POST', token }))).body, { status: 'paused', name: 'guarded', reason: 'admin' });
        assert.equal((await w.row('guarded')).status, 'paused');
        assert.equal((await call(w, req(`${ADMIN_API}/no-such-route`, { token }))).status, 404, 'signed in, an unknown path is a 404');
        // An email in ADMIN_EMAILS whatever its case, and the token's whatever its case: one person.
        const shouted = await w.mint({ email: 'Martin@Cytec.COM.au' });
        assert.deepEqual((await call(w, req(`${ADMIN_API}/whoami`, { token: shouted }))).body, { email: EMAIL, via: 'cloudflare-access' });
        // The other listed admin too.
        assert.deepEqual((await call(w, req(`${ADMIN_API}/whoami`, { token: await w.mint({ email: 'someone@example.org' }) }))).body, { email: 'someone@example.org', via: 'cloudflare-access' });
        assert.equal(w.certs.calls, 1, 'the team\'s keys were fetched once, then cached');
    } finally { w.restore(); }
});

test('every admin route refuses (401) a missing, malformed, forged, expired, early, wrong-aud, wrong-iss or unlisted token — and the old secret', async () => {
    const w = await accessWorld();
    try {
        await liveName(w, 'guarded', await makeKey());
        const before = await snapshot(w);
        const other = await rsaKey();
        const good = await w.mint();
        const [h, p] = good.split('.');
        const now = nowS();
        const modes = {
            'no token': { token: undefined },
            'an empty header': { token: '' },
            'not a JWT': { token: 'not-a-jwt' },
            'two parts': { token: `${h}.${p}` },
            'four parts': { token: `${good}.x` },
            'not base64url': { token: `${h}.${p}.abc+def/` },
            'a header that is not JSON': { token: `${b64url(Buffer.from('nope'))}.${p}.${good.split('.')[2]}` },
            'signed by another key under the team key\'s kid': { token: await w.mint({}, { signer: other }) },
            'a payload swapped after signing': { token: `${h}.${enc({ aud: [AUD], email: EMAIL, exp: now + 3600, iss: `https://${w.team}`, sub: 'mallory' })}.${good.split('.')[2]}` },
            'alg none': { token: `${enc({ alg: 'none', kid: w.key.kid })}.${p}.` },
            'alg HS256': { token: await w.mint({}, { header: { alg: 'HS256' } }) },
            'no kid': { token: await w.mint({}, { header: { kid: undefined } }) },
            'expired past the skew': { token: await w.mint({ exp: now - SKEW - 5 }) },
            'no exp': { token: await w.mint({ exp: undefined }) },
            'exp not a number': { token: await w.mint({ exp: String(now + 3600) }) },
            'not valid yet (nbf)': { token: await w.mint({ nbf: now + SKEW + 60 }) },
            'issued in the future (iat)': { token: await w.mint({ iat: now + SKEW + 60 }) },
            'another app\'s aud': { token: await w.mint({ aud: ['0'.repeat(64)] }) },
            'aud as another string': { token: await w.mint({ aud: 'something-else' }) },
            'no aud': { token: await w.mint({ aud: undefined }) },
            'another team\'s iss': { token: await w.mint({ iss: 'https://evil.cloudflareaccess.com' }) },
            'iss over http': { token: await w.mint({ iss: `http://${w.team}` }) },
            'no iss': { token: await w.mint({ iss: undefined }) },
            'an email not listed': { token: await w.mint({ email: 'someone-else@cytec.com.au' }) },
            'a listed email inside a longer one': { token: await w.mint({ email: `${EMAIL}.evil.example` }) },
            'no email (a service token)': { token: await w.mint({ email: undefined, common_name: 'svc.access' }) },
            'an email that is not a string': { token: await w.mint({ email: [EMAIL] }) },
            'an unknown kid': { token: await w.mint({}, { k: other }) },
            'the old ADMIN_SECRET header, no token': { token: undefined, headers: SECRET },
            'the old ADMIN_SECRET header, a bad token': { token: await w.mint({ email: 'nobody@example.org' }), headers: SECRET },
            'Access\'s plain email header, no token': { token: undefined, headers: { 'cf-access-authenticated-user-email': EMAIL } },
        };
        for (const [mode, { token, headers }] of Object.entries(modes)) {
            for (const [method, path, body] of ROUTES) {
                const r = await call(w, req(path, { method, token, headers, body }));
                assert.equal(r.status, 401, `${mode}: ${method} ${path} → ${r.status} ${JSON.stringify(r.body)}`);
                if (isPage(path)) assert.equal(r.body, 'Sign in through Cloudflare Access to open the control room.\n', `${mode}: ${path}`);
                else assert.deepEqual(r.body, { error: 'unauthorized', sign_in: 'cloudflare-access' }, `${mode}: ${method} ${path}`);
            }
        }
        assert.deepEqual(await snapshot(w), before, 'nothing changed: not the row, Cloudflare, the events, the alert settings or the outbox');
        // Inside the skew, the same token is good: a minute of clock difference never locks the admin out.
        for (const token of [await w.mint({ exp: now - 30 }), await w.mint({ nbf: now + 30, iat: now + 30 })])
            assert.equal((await call(w, req(`${ADMIN_API}/whoami`, { token }))).status, 200);
    } finally { w.restore(); }
});

test('an unknown kid fetches the team\'s keys once more, then 401 — and not again for a while; a rotated key is found by that fetch', async () => {
    const w = await accessWorld();
    try {
        const whoami = async (token) => (await call(w, req(`${ADMIN_API}/whoami`, { token }))).status;
        assert.equal(await whoami(await w.mint()), 200);
        assert.equal(w.certs.calls, 1);
        assert.equal(await whoami(await w.mint()), 200);
        assert.equal(w.certs.calls, 1, 'a known kid: from the cache');
        const stranger = await rsaKey();
        assert.equal(await whoami(await w.mint({}, { k: stranger })), 401);
        assert.equal(w.certs.calls, 2, 'one refresh for the unknown kid');
        assert.equal(await whoami(await w.mint({}, { k: await rsaKey() })), 401);
        assert.equal(await whoami(await w.mint({}, { k: stranger })), 401);
        assert.equal(w.certs.calls, 2, 'made-up kids right after do not each fetch again');
        assert.equal(await whoami(await w.mint()), 200, 'the team key still works');
    } finally { w.restore(); }

    // Cloudflare rotates: the new key is listed before tokens are signed with it. The first such token's unknown kid
    // fetches the list again and finds it.
    const r = await accessWorld();
    try {
        assert.equal((await call(r, req(`${ADMIN_API}/whoami`, { token: await r.mint() }))).status, 200);
        const next = await rsaKey();
        r.certs.keys.unshift(next);
        assert.equal((await call(r, req(`${ADMIN_API}/whoami`, { token: await r.mint({}, { k: next }) }))).status, 200);
        assert.equal(r.certs.calls, 2);
    } finally { r.restore(); }
});

test('requests that arrive while the rotation\'s fetch is under way wait for it: every token under the new key is let in, one fetch for them all', async () => {
    // PR #2111 review: the first request's unknown kid started the fetch, and the ones right behind it (two tabs, a
    // double click) were refused by the 30-second guard without waiting for it — 1 of 4 let in, 2 fetches (measured).
    const w = await accessWorld();
    try {
        assert.equal((await call(w, req(`${ADMIN_API}/whoami`, { token: await w.mint() }))).status, 200);
        const next = await rsaKey();
        w.certs.keys.unshift(next);
        w.certs.answer = async () => {
            await new Promise((ok) => setTimeout(ok, 50));
            return Response.json({ keys: w.certs.keys.map(certOf) });
        };
        // Four under the new key, and last a made-up kid: it waits for the same fetch, is refused, and fetches nothing.
        const token = await w.mint({}, { k: next });
        const stranger = await w.mint({}, { k: await rsaKey() });
        const all = await Promise.all([token, token, token, token, stranger].map((t) => call(w, req(`${ADMIN_API}/whoami`, { token: t }))));
        assert.deepEqual(all.map((r) => r.status), [200, 200, 200, 200, 401]);
        assert.deepEqual(all.slice(0, 4).map((r) => r.body.email), [EMAIL, EMAIL, EMAIL, EMAIL]);
        assert.equal(w.certs.calls, 2, 'the first fetch, then one for the new key');
    } finally { w.restore(); }
});

test('the team\'s keys unreachable or unusable: fail closed (401), never the secret; good again once they answer', async () => {
    const w = await accessWorld();
    try {
        const token = await w.mint();
        const whoami = async (headers = {}) => call(w, req(`${ADMIN_API}/whoami`, { token, headers }));
        const answers = {
            'a 500': () => new Response('oops', { status: 500 }),
            'a 404': () => new Response('not found', { status: 404 }),
            'no network': () => { throw new TypeError('fetch failed'); },
            'not JSON': () => new Response('<html>', { status: 200 }),
            'no keys': () => Response.json({ keys: [] }),
            'no RSA key': () => Response.json({ keys: [{ kid: w.key.kid, kty: 'EC', crv: 'P-256', x: 'AA', y: 'AA' }] }),
            'a key of another alg': () => Response.json({ keys: [{ ...certOf(w.key), alg: 'RS512' }] }),
            'a broken key': () => Response.json({ keys: [{ ...certOf(w.key), n: '!!' }] }),
            'a short key': () => Response.json({ keys: [{ ...certOf(w.key), n: certOf(w.key).n.slice(0, 170) }] }),
            'a modulus atob refuses, beside nothing usable': () => Response.json({ keys: [{ ...certOf(w.key), n: 'A'.repeat(345) }] }),
        };
        for (const [what, answer] of Object.entries(answers)) {
            w.certs.answer = answer;
            const r = await whoami(SECRET);
            assert.equal(r.status, 401, `${what}: ${JSON.stringify(r.body)}`);
            assert.deepEqual(r.body, { error: 'unauthorized', sign_in: 'cloudflare-access' });
        }
        // One unusable key beside the team's never spoils it.
        w.certs.answer = () => Response.json({ keys: [{ ...certOf(w.key), kid: 'bad', n: 'A'.repeat(345) }, { kid: 'short', kty: 'RSA', n: 'AQAB', e: 'AQAB' }, certOf(w.key)] });
        assert.equal((await whoami()).status, 200, 'the keys answer again: signed in');
        assert.equal((await call(w, req(`${ADMIN_API}/whoami`, { token: await w.mint({}, { k: { ...w.key, kid: 'short' }, signer: w.key }) }))).status, 401, 'a short key is no key');
    } finally { w.restore(); }
});

test('node-facing /api/registrar/* routes and invites need no token under Access, and a token there changes nothing', async () => {
    const w = await accessWorld();
    try {
        const key = await makeKey();
        assert.equal((await call(w, req('/api/registrar/health'))).body.status, 'ok');
        assert.equal((await w.available('nodename')).status, 200);
        await liveName(w, 'nodename', key);
        assert.equal((await w.status(key)).body.status, 'live');
        assert.equal((await w.heal(key, {})).status, 200);
        assert.equal((await w.holder(key, { name: 'nodename' })).status, 200);
        assert.equal((await w.release(key)).body.status, 'released');
        // A garbage Access header on a node route is ignored, not refused.
        const r = await worker.fetch(new Request('https://beanpool.org/api/registrar/available?name=othername', { headers: { 'cf-access-jwt-assertion': 'garbage' } }), w.env);
        assert.equal(r.status, 200);
        assert.equal(w.certs.calls, 0, 'no node route ever asked for the team\'s keys');
    } finally { w.restore(); }
});

test('under Access, an admin POST needs x-bp-admin: 1 and, when it says one, this site\'s Origin — a cross-site form gets 403', async () => {
    const w = await accessWorld();
    try {
        await liveName(w, 'guarded', await makeKey());
        const token = await w.mint();
        const before = await snapshot(w);
        const post = (headers) => call(w, new Request(`https://beanpool.org${ADMIN_API}/guarded/block`, { method: 'POST', headers: { 'cf-access-jwt-assertion': token, ...headers } }));
        for (const headers of [{}, { 'x-bp-admin': '0' }, { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' },
            { 'x-bp-admin': '1', origin: 'https://evil.example' }, { 'x-bp-admin': '1', origin: 'null' }, { 'x-bp-admin': '1', origin: 'http://beanpool.org' }]) {
            const r = await post(headers);
            assert.deepEqual(r, { ...r, status: 403, body: { error: 'cross-site request refused' } }, JSON.stringify(headers));
        }
        assert.deepEqual(await snapshot(w), before);
        assert.equal((await post({ 'x-bp-admin': '1', origin: 'https://beanpool.org' })).body.status, 'blocked');
        assert.equal((await post({ 'x-bp-admin': '1' })).body.status, 'blocked', 'no Origin (a same-origin GET-less client): the header is enough');
        // A GET needs neither: it changes nothing, and another site can't read its answer.
        assert.equal((await call(w, req(`${ADMIN_API}/pending`, { token }))).status, 200);
    } finally { w.restore(); }
});

test('under Access the events and alerts name the admin by email where they said "the admin"', async () => {
    const w = await accessWorld();
    try {
        const [a, b] = await Promise.all([makeKey(), makeKey()]);
        const token = await w.mint();
        const act = (name, action, body) => call(w, req(`${ADMIN_API}/${name}/${action}`, { method: 'POST', token, body }));
        await liveName(w, 'guarded', a);
        assert.equal((await act('guarded', 'pause')).status, 200);
        assert.equal((await act('guarded', 'resume')).status, 200);
        assert.equal((await act('guarded', 'block')).status, 200);
        assert.equal((await act('guarded', 'block')).status, 200);
        assert.equal((await act('guarded', 'release', { free_now: true })).status, 200);
        assert.equal((await act('guarded', 'forget')).status, 200);
        w.sqlite.prepare("INSERT INTO name_policy (pattern, tier) VALUES ('waiting', 'gated')").run();
        assert.equal((await w.claim(b, { name: 'waiting' })).body.status, 'pending');
        assert.equal((await act('waiting', 'approve')).status, 200);
        const said = [...w.events('guarded'), ...w.events('waiting')].map((e) => e.detail).filter((d) => /admin|martin/.test(d));
        assert.deepEqual(said.map((d) => d.replace(/ \(was .*$|: .*$/, '')), [
            `paused by ${EMAIL}`, `resumed by ${EMAIL}`, `blocked by ${EMAIL}`, `blocked again by ${EMAIL}`,
            `released by ${EMAIL}`, `removed from the list by ${EMAIL}`, `approved by ${EMAIL}`,
        ]);
        assert.ok(said.every((d) => !d.includes('the admin')), said.join('\n'));
        const titles = w.sqlite.prepare("SELECT title FROM alert_outbox WHERE category='admin' ORDER BY id").all().map((r) => r.title);
        assert.deepEqual(titles, [
            `${EMAIL} paused guarded`, `${EMAIL} resumed guarded`, `${EMAIL} blocked guarded`, `${EMAIL} blocked guarded`,
            `${EMAIL} released guarded`, `${EMAIL} removed guarded from the list`, `${EMAIL} approved waiting`,
        ]);
    } finally { w.restore(); }
});

test('with ACCESS_* unset the ADMIN_SECRET header still works (a self-hoster with no Access), and a token alone opens nothing', async () => {
    const w = await world();
    try {
        await liveName(w, 'guarded', await makeKey());
        const whoami = (headers) => call(w, new Request(`https://beanpool.org${ADMIN_API}/whoami`, { headers }));
        assert.deepEqual((await whoami(SECRET)).body, { email: null, via: 'admin-secret' });
        assert.deepEqual(await whoami({}), { ...(await whoami({})), status: 401, body: { error: 'unauthorized' } });
        assert.equal((await whoami({ 'x-admin-secret': 'wrong' })).status, 401);
        assert.equal((await whoami({ 'cf-access-jwt-assertion': 'eyJhbGciOiJSUzI1NiJ9.e30.x' })).status, 401);
        // The page is served (the secret guards the API), with its secret box; a POST needs no x-bp-admin.
        assert.equal((await call(w, req('/admin'))).status, 200);
        assert.equal((await w.admin('guarded', 'pause')).body.status, 'paused');
        assert.match(w.events('guarded').at(-1).detail, /^paused by the admin \(was live\)$/);
        assert.equal(w.sqlite.prepare("SELECT title FROM alert_outbox WHERE category='admin'").get().title, 'You paused guarded');
    } finally { w.restore(); }
});

test('Access set but incomplete (any ACCESS_* var without the rest): nobody gets in — never back to the secret', async () => {
    for (const env of [{ ADMIN_EMAILS: EMAIL }, { ACCESS_AUD: AUD }, { ACCESS_TEAM_DOMAIN: 'x.cloudflareaccess.com', ACCESS_AUD: AUD, ADMIN_EMAILS: ' , ' },
        { ACCESS_TEAM_DOMAIN: 'x.cloudflareaccess.com', ACCESS_AUD: AUD, ADMIN_EMAILS: '  ' }]) {
        const w = await world({ env });
        try {
            for (const [method, path, body] of ROUTES) {
                const r = await call(w, req(path, { method, headers: SECRET, body }));
                assert.equal(r.status, 401, `${JSON.stringify(env)}: ${method} ${path}`);
            }
        } finally { w.restore(); }
    }
    // ACCESS_TEAM_DOMAIN may be given as a URL: the same team.
    const w = await accessWorld();
    try {
        w.env.ACCESS_TEAM_DOMAIN = `https://${w.team}/`;
        assert.equal((await call(w, req(`${ADMIN_API}/whoami`, { token: await w.mint() }))).status, 200);
    } finally { w.restore(); }
});

// ── Free all and remove ───────────────────────────────────────────────────────────────────────────────────────────

const freeAll = (w, names, extra = {}, headers = SECRET) => call(w, new Request(`https://beanpool.org${ADMIN_API}/forget`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ names, free_now: true, ...extra }),
}));
const count = (w, name, event) => w.events(name).filter((e) => e.event === event).length;

// The live D1's July rows: released by their own key before 'owner' was written (pause_reason NULL), long past the hold —
// and one inside it; the admin's own "free now" ('admin'), and the admin's release of a name it blocked (inside its hold).
async function julyRows(w) {
    const keys = Object.fromEntries(await Promise.all(['old1', 'old2', 'recent', 'adminfree', 'heldall', 'live1', 'paused1', 'blocked1', 'waiting'].map(async (n) => [n, await makeKey()])));
    for (const [name, ago] of [['old1', 90 * DAY], ['old2', 60 * DAY], ['recent', 5 * DAY]]) {
        await liveName(w, name, keys[name]);
        assert.equal((await w.release(keys[name])).body.status, 'released');
        await w.backdate(name, { pause_reason: null, released_at: nowS() - ago });
    }
    await liveName(w, 'adminfree', keys.adminfree);
    assert.equal((await w.admin('adminfree', 'release', { free_now: true })).status, 200);
    await liveName(w, 'heldall', keys.heldall);
    await w.admin('heldall', 'block');
    assert.equal((await w.admin('heldall', 'release')).body.reason, 'admin-held-all');
    await liveName(w, 'live1', keys.live1);
    await liveName(w, 'paused1', keys.paused1);
    await w.admin('paused1', 'pause');
    await liveName(w, 'blocked1', keys.blocked1);
    await w.admin('blocked1', 'block');
    w.sqlite.prepare("INSERT INTO name_policy (pattern, tier) VALUES ('waiting', 'gated')").run();
    assert.equal((await w.claim(keys.waiting, { name: 'waiting' })).body.status, 'pending');
    return keys;
}

test('Free all and remove: a release its own key can still take back (NULL reason) is freed, then removed — one event of each, its take-back gone', async () => {
    const w = await world();
    try {
        const keys = await julyRows(w);
        // Today: forget refuses the old key's releases (it can take them back) and the held ones.
        for (const n of ['old1', 'old2']) assert.equal(isOwnRow(await w.row(n), keys[n].pubHex), true, `${n} is still its key's to take back`);
        assert.equal((await call(w, new Request(`https://beanpool.org${ADMIN_API}/old1/forget`, { method: 'POST', headers: SECRET }))).status, 409);
        const releasedBefore = Object.fromEntries(['old1', 'old2', 'recent', 'adminfree', 'heldall'].map((n) => [n, count(w, n, 'released')]));

        const out = [];
        for (const batch of [['old1', 'old2'], ['recent', 'adminfree'], ['heldall']]) {
            const r = await freeAll(w, batch);
            assert.equal(r.status, 200, JSON.stringify(r.body));
            out.push(r.body);
        }
        assert.deepEqual(out, [
            { removed: ['old1', 'old2'], refused: [], freed: ['old1', 'old2'] },
            { removed: ['recent', 'adminfree'], refused: [], freed: ['recent'] },
            { removed: ['heldall'], refused: [], freed: ['heldall'] },
        ]);
        for (const n of ['old1', 'old2', 'recent', 'adminfree', 'heldall']) {
            const row = await w.row(n);
            assert.equal(row.status, 'abandoned', n);
            assert.equal(holdsName(w.env, row), false, `${n}: nobody holds it`);
            assert.equal(isOwnRow(row, keys[n].pubHex), false, `${n}: its old key can no longer take it back`);
            assert.equal(count(w, n, 'removed'), 1, `${n}: one removed event`);
            assert.equal(count(w, n, 'released'), releasedBefore[n] + (n === 'adminfree' ? 0 : 1), `${n}: freed once (adminfree was free already)`);
        }
        // Freed exactly as its own "Free now" frees it: the admin's release, free now.
        assert.match(w.events('old1').filter((e) => e.event === 'released').at(-1).detail, /^released by the admin \(was released\): free now$/);
        assert.match(w.events('old1').at(-1).detail, /^removed from the list by the admin \(was released\/admin, free since /);
        // Its old key sees it abandoned: nothing of its own to heal or take back.
        assert.equal((await w.status(keys.old1)).body.status, 'abandoned');
    } finally { w.restore(); }
});

test('Free all and remove never touches a live, pending, paused or blocked name: refused, untouched', async () => {
    const w = await world();
    try {
        await julyRows(w);
        for (const name of ['live1', 'waiting', 'paused1', 'blocked1']) {
            const before = { row: await w.row(name), route: routing(w, name), events: w.events(name) };
            const r = await freeAll(w, [name]);
            assert.equal(r.status, 200);
            assert.deepEqual(r.body.removed, []);
            assert.deepEqual(r.body.freed, []);
            assert.equal(r.body.refused.length, 1);
            assert.equal(r.body.refused[0].name, name);
            assert.match(r.body.refused[0].error, new RegExp(`^${name} is (live|pending|paused|blocked): only a released name`));
            assert.deepEqual({ row: await w.row(name), route: routing(w, name), events: w.events(name) }, before, name);
        }
        // A batch mixing both: the released one goes, the live one stays.
        const mixed = await freeAll(w, ['old1', 'live1']);
        assert.deepEqual([mixed.body.removed, mixed.body.refused.map((x) => x.name)], [['old1'], ['live1']]);
        assert.equal((await w.row('live1')).status, 'live');
        // More than a request takes, or a bad name: 400, nothing done.
        assert.equal((await freeAll(w, ['old2', 'recent', 'heldall'])).status, 400);
        assert.equal((await freeAll(w, ['Not A Name'])).status, 400);
        assert.equal((await w.row('old2')).status, 'released');
        // Without free_now: true it is Remove all released, which still refuses what its key can take back.
        const plain = await call(w, new Request(`https://beanpool.org${ADMIN_API}/forget`, { method: 'POST', headers: SECRET, body: JSON.stringify({ names: ['old2'], free_now: 'yes' }) }));
        assert.equal(plain.body.refused[0].takes_back, true);
    } finally { w.restore(); }
});

test('Free all and remove is idempotent: the same names again remove nothing, write no event, tell nothing', async () => {
    const w = await world();
    try {
        await julyRows(w);
        assert.deepEqual((await freeAll(w, ['old1', 'adminfree'])).body, { removed: ['old1', 'adminfree'], refused: [], freed: ['old1'] });
        const events = { old1: w.events('old1'), adminfree: w.events('adminfree') };
        const outbox = w.sqlite.prepare('SELECT COUNT(*) AS n FROM alert_outbox').get().n;
        for (let i = 0; i < 2; i++)
            assert.deepEqual((await freeAll(w, ['old1', 'adminfree'])).body, { removed: [], refused: [], already: ['old1', 'adminfree'], freed: [] });
        assert.deepEqual({ old1: w.events('old1'), adminfree: w.events('adminfree') }, events);
        assert.equal(w.sqlite.prepare('SELECT COUNT(*) AS n FROM alert_outbox').get().n, outbox);
    } finally { w.restore(); }
});

test('Free all and remove tells the phone once per click (its run), not once per batch; a request with no run once per request', async () => {
    const w = await world();
    try {
        await julyRows(w);
        const admin = () => w.sqlite.prepare("SELECT title, body, once FROM alert_outbox WHERE category='admin' AND (title LIKE '%freed%' OR title LIKE '%removed%') ORDER BY id").all().map((r) => ({ ...r }));
        const run = 'run-0123456789';
        for (const batch of [['old1', 'old2'], ['recent', 'adminfree']]) assert.equal((await freeAll(w, batch, { run, total: 4 })).status, 200);
        assert.deepEqual(admin(), [{
            title: 'You freed and removed 4 released names', once: `free-all:${run}`,
            body: 'You chose Free all and remove for 4 released names: each freed now (its old server can no longer take it back), then removed from the list, free to anyone. What each one did is under Name events.',
        }]);
        // No run (a hand-made request): told as Remove all released's are, with what it freed.
        assert.equal((await freeAll(w, ['heldall'])).status, 200);
        assert.deepEqual(admin().slice(1).map((r) => [r.title, r.body]), [['You freed and removed heldall from the list',
            'You freed and removed heldall.beanpool.org from the list: free to anyone; its old server can no longer take it back.']]);
    } finally { w.restore(); }
});

test('one Free all and remove request (2 names) stays inside D1\'s smallest per-invocation budget (50 queries), even when Cloudflare refuses every delete', async () => {
    const w = await world({ env: { NTFY_URL: 'https://ntfy.example/beanpool-admin' } });
    try {
        for (const name of ['spent1', 'spent2']) {
            const k = await makeKey();
            await liveName(w, name, k);
            w.cf.fail.deleteTunnel = true; w.cf.fail.deleteDns = true;
            await w.release(k);
            await w.backdate(name, { pause_reason: null, released_at: nowS() - 60 * DAY });
        }
        const real = w.env.DB;
        let queries = 0;
        w.env.DB = { prepare: (sql) => { queries++; return real.prepare(sql); } };
        const r = await freeAll(w, ['spent1', 'spent2'], { run: 'run-budget-01', total: 2 });
        w.env.DB = real;
        w.cf.fail.deleteTunnel = false; w.cf.fail.deleteDns = false;
        assert.deepEqual(r.body.removed, ['spent1', 'spent2']);
        assert.ok(queries <= 50, `${queries} D1 queries`);
    } finally { w.restore(); }
});

test('Free all and remove under Access: needs the token like every admin route, and names the admin by email', async () => {
    const w = await accessWorld();
    try {
        await julyRows(w);
        assert.equal((await freeAll(w, ['old1'], {}, { ...SECRET, 'x-bp-admin': '1' })).status, 401);
        assert.equal((await w.row('old1')).status, 'released');
        const r = await freeAll(w, ['old1'], { run: 'run-access-01', total: 1 }, { 'cf-access-jwt-assertion': await w.mint(), 'x-bp-admin': '1' });
        assert.deepEqual(r.body, { removed: ['old1'], refused: [], freed: ['old1'] });
        assert.deepEqual(w.events('old1').slice(-2).map((e) => e.detail.replace(/ \(was .*$/, '')), [`released by ${EMAIL}`, `removed from the list by ${EMAIL}`]);
        assert.equal(w.sqlite.prepare("SELECT title FROM alert_outbox WHERE once='free-all:run-access-01'").get().title, `${EMAIL} freed and removed 1 released name`);
    } finally { w.restore(); }
});

// ── The page ──────────────────────────────────────────────────────────────────────────────────────────────────────

// The served page's script against a stub document (as admin-tidy and holder run it), with `answer(url, init)` as the
// Worker. Returns what it drew, sent, confirmed and stored.
async function page(w, answer, { token } = {}) {
    const html = (await call(w, req('/admin', { token }))).body;
    const script = html.split('<script>')[1].split('</script>')[0];
    const els = {};
    const sent = [];
    const confirms = [];
    const alerts = [];
    const clicks = [];
    const stored = [];
    const removedKeys = [];
    const el = (id) => (els[id] ??= { id, innerHTML: '', value: '', textContent: '', style: {}, addEventListener(type, fn) { (this.on ??= {})[type] = fn; }, querySelector: () => null });
    const ctx = {
        console,
        location: { hash: '', href: '' },
        document: { getElementById: el, addEventListener: (type, fn) => { if (type === 'click') clicks.push(fn); }, querySelector: () => null },
        sessionStorage: { getItem: () => 'leftover', setItem: (k, v) => stored.push([k, v]), removeItem: (k) => removedKeys.push(k) },
        confirm: (text) => { confirms.push(text); return true; },
        alert: (text) => { alerts.push(text); },
        fetch: async (url, init = {}) => {
            sent.push({ url, init });
            const [status, body] = answer(url, init);
            return { ok: status >= 200 && status < 300, status, json: async () => body };
        },
    };
    vm.createContext(ctx);
    vm.runInContext(script, ctx);
    const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
    await settle();
    const click = async (attrs) => {
        const target = { closest: (sel) => { const m = /^\[([a-z-]+)\]$/.exec(sel); return m && attrs[m[1]] !== undefined ? { getAttribute: (k) => attrs[k] ?? null } : null; } };
        for (const fn of clicks) await fn({ target });
        await settle();
    };
    return { html, ctx, els, sent, confirms, alerts, stored, removedKeys, click, settle };
}
const key = 'ab'.repeat(32);
const row = (name, status, extra = {}) => ({ name, status, node_pubkey: key, mode: 'tunnel', holds: status !== 'released', ...extra });

test('the page under Access: no secret box, "Signed in as <email>", the data loaded with x-bp-admin and no secret; nothing stored', async () => {
    const w = await accessWorld();
    try {
        const token = await w.mint();
        const p = await page(w, (url) => (url.endsWith('/whoami') ? [200, { email: EMAIL, via: 'cloudflare-access' }] : [200, { allocations: [row('livename', 'live')], events: [] }]), { token });
        assert.match(p.html, /<div id="secretRow" class="row-wrap" style="display: none;/, 'the secret box is hidden from the start');
        assert.doesNotMatch(p.html, /Super Admin Credentials|Save &amp; Connect|Save & Connect/);
        assert.equal(p.els.signInStatus.textContent, `Signed in as ${EMAIL} (Cloudflare Access: email code and authenticator).`);
        assert.equal(p.els.secretRow.style.display, 'none');
        assert.equal(p.els.headerLogoutBtn.style.display, 'inline-flex');
        assert.deepEqual(p.sent.map((s) => s.url).slice(0, 2), ['/api/local/admin/registrar/whoami', '/api/local/admin/registrar/pending']);
        assert.match(p.els.activeTableContainer.innerHTML, /id="row-livename"/);
        for (const s of p.sent) {
            assert.equal(s.init.headers['x-bp-admin'], '1', s.url);
            assert.equal(s.init.headers['x-admin-secret'], undefined, s.url);
        }
        // The secret an older page kept in this tab is dropped, and nothing is stored.
        assert.deepEqual(p.removedKeys, ['bp_registrar_admin_secret']);
        assert.deepEqual(p.stored, []);
        // An action carries the page's header too.
        await p.ctx.adminAction('livename', 'pause', null);
        const pause = p.sent.find((s) => s.url.endsWith('/livename/pause'));
        assert.deepEqual([pause.init.method, pause.init.headers['x-bp-admin'], pause.init.headers['x-admin-secret']], ['POST', '1', undefined]);
        // Sign out is Access's own.
        p.els.headerLogoutBtn.on.click();
        assert.equal(p.ctx.location.href, '/cdn-cgi/access/logout');
    } finally { w.restore(); }
});

test('the page: Access says not signed in → a reload prompt, no box; no Access → the secret box, the secret in memory only', async () => {
    const w = await world();
    try {
        const out = await page(w, () => [401, { error: 'unauthorized', sign_in: 'cloudflare-access' }]);
        assert.equal(out.els.signInStatus.textContent, 'Not signed in. Reload the page to sign in through Cloudflare Access.');
        assert.equal(out.els.secretRow.style.display, 'none');
        assert.equal(out.sent.length, 1, 'nothing loaded');

        let accepted = false;
        const p = await page(w, (url, init) => {
            if (url.endsWith('/whoami')) return init.headers['x-admin-secret'] === 'typed-secret' ? (accepted = true, [200, { email: null, via: 'admin-secret' }]) : [401, { error: 'unauthorized' }];
            return [200, { allocations: [row('livename', 'live')], events: [] }];
        });
        assert.equal(p.els.secretRow.style.display, 'flex');
        assert.equal(p.els.signInStatus.textContent, 'This registrar has no Cloudflare Access in front: enter its ADMIN_SECRET.');
        p.els.adminSecretInput.value = 'wrong';
        p.els.saveSecretBtn.on.click();
        await p.settle();
        assert.equal(p.els.signInStatus.textContent, 'That is not the ADMIN_SECRET.');
        p.els.adminSecretInput.value = ' typed-secret ';
        p.els.saveSecretBtn.on.click();
        await p.settle();
        assert.ok(accepted);
        assert.equal(p.els.adminSecretInput.value, '', 'the box is emptied once read');
        assert.equal(p.els.signInStatus.textContent, 'Connected with the ADMIN_SECRET (this registrar has no Cloudflare Access in front).');
        assert.equal(p.els.secretRow.style.display, 'none');
        assert.match(p.els.activeTableContainer.innerHTML, /id="row-livename"/);
        assert.equal(p.sent.find((s) => s.url.endsWith('/pending')).init.headers['x-admin-secret'], 'typed-secret');
        assert.deepEqual(p.stored, [], 'never written to sessionStorage');
        // Sign out forgets it: the tables are cleared and the box is back.
        p.els.headerLogoutBtn.on.click();
        await p.settle();
        assert.equal(p.els.secretRow.style.display, 'flex');
        assert.match(p.els.activeTableContainer.innerHTML, /Signed out\./);
        assert.equal(p.sent.at(-1).init.headers['x-admin-secret'], undefined);
    } finally { w.restore(); }
});

test('the page: "Free all and remove (N)" counts every released name; its confirm says N; it sends them all, 2 a request, freeing', async () => {
    const w = await accessWorld();
    try {
        const token = await w.mint();
        const p = await page(w, (url, init) => {
            if (url.endsWith('/whoami')) return [200, { email: EMAIL, via: 'cloudflare-access' }];
            if (url.endsWith('/forget') && init.body) {
                const names = JSON.parse(init.body).names;
                return [200, { removed: names, refused: [], freed: names }];
            }
            return [200, { allocations: [], events: [] }];
        }, { token });
        const released = [
            ...Array.from({ length: 4 }, (_, i) => row(`july${i}`, 'released', { pause_reason: null, released_at: 1, takes_back: true })),
            row('heldrel', 'released', { pause_reason: 'owner', released_at: 1, holds: true, takes_back: true, held_until: 1790000000 }),
            row('cairns', 'released', { pause_reason: 'admin', released_at: 1, takes_back: false }),
        ];
        p.ctx.renderActive([row('livename', 'live'), row('pausedname', 'paused', { pause_reason: 'admin', paused_at: 1 }), ...released]);
        const html = p.els.activeTableContainer.innerHTML;
        assert.match(html, /<button data-free-all="1" class="btn-revoke" title="[^"]*">Free all and remove \(6\)<\/button>/);
        assert.match(html, /<button data-forget-all="1"[^>]*>Remove all released \(1\)<\/button>/, 'Remove all released is still there, for the free ones');

        await p.click({ 'data-free-all': '1' });
        assert.equal(p.confirms.at(-1), 'Free and remove 6 released names? Their old servers can no longer take them back.');
        const bulk = p.sent.filter((s) => s.url === '/api/local/admin/registrar/forget').map((s) => ({ headers: s.init.headers, body: JSON.parse(s.init.body) }));
        assert.deepEqual(bulk.map((b) => b.body.names), [['july0', 'july1'], ['july2', 'july3'], ['heldrel', 'cairns']], 'every released name once, and only those');
        assert.ok(bulk.every((b) => b.body.free_now === true && b.body.total === 6 && b.headers['x-bp-admin'] === '1'));
        assert.equal(new Set(bulk.map((b) => b.body.run)).size, 1, 'one run for the click');
        assert.match(bulk[0].body.run, /^[A-Za-z0-9-]{8,64}$/);
        assert.equal(p.alerts.at(-1), 'Freed and removed 6.');

        // Declined: nothing sent.
        const before = p.sent.length;
        p.ctx.confirm = (text) => { p.confirms.push(text); return false; };
        p.ctx.renderActive([row('one', 'released', { pause_reason: null, released_at: 1, takes_back: true })]);
        await p.click({ 'data-free-all': '1' });
        assert.equal(p.confirms.at(-1), 'Free and remove 1 released name? Their old servers can no longer take them back.');
        assert.equal(p.sent.length, before);
        // No released names: no button.
        p.ctx.renderActive([row('livename', 'live')]);
        assert.doesNotMatch(p.els.activeTableContainer.innerHTML, /data-free-all/);
    } finally { w.restore(); }
});
