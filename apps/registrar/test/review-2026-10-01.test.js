// The registrar review of 2026-10-01 (scratch/reviews/FABLE-sec-registrar.md): M2 the switchboard's `?n=`, L3 caps on
// what a keyholder may set, M1 a per-key claim limit, L1 a one-use nonce in signed requests (protocol v2) and L4 no
// Cloudflare ids or error bodies in an answer to a keyholder.
//
// The same world as ownership-states.test.js (test/harness.js): the Worker against an in-memory SQLite loaded with the
// migrations, and a fake Cloudflare. No network.

import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { attestSweep } from '../src/index.js';
import { nowS, toHex, world, liveName, makeKey, routing } from './harness.js';

const DAY = 86400;
const sign = async (key, message) => toHex(await crypto.subtle.sign('Ed25519', key.keyPair.privateKey, new TextEncoder().encode(message)));
const send = async (w, req) => { const res = await worker.fetch(req, w.env); return { status: res.status, body: await res.json() }; };
const page = async (w, path) => { const res = await worker.fetch(new Request(`https://beanpool.org${path}`), w.env); return { status: res.status, html: await res.text() }; };
const newNonce = () => toHex(crypto.getRandomValues(new Uint8Array(16)));

// A v2 request, as [url, init]: build it into a Request as often as a test sends it (a captured request, replayed).
async function v2(method, path, key, body, { nonce = newNonce(), ts = nowS(), signedNonce = nonce } = {}) {
    const text = body === undefined ? '' : JSON.stringify(body);
    const signature = await sign(key, `beanpool-registrar-request/v2\n${method}\n${path}\n${ts}\n${signedNonce}\n${text}`);
    const headers = { 'content-type': 'application/json', 'x-bp-pubkey': key.pubHex, 'x-bp-timestamp': String(ts), 'x-bp-proto': 'v2', 'x-bp-signature': signature };
    if (nonce !== null) headers['x-bp-nonce'] = nonce;
    return [`https://beanpool.org${path}`, { method, headers, body: text || undefined }];
}
const sendV2 = (w, [url, init]) => send(w, new Request(url, init));

// Every table but the nonces, row by row: what a refused request must leave as it found it.
const state = (w) => Object.fromEntries(
    w.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name <> 'request_nonces' ORDER BY name").all()
        .map(({ name }) => [name, w.sqlite.prepare(`SELECT * FROM "${name}"`).all().map((r) => ({ ...r }))]));

// ── M2: the switchboard vouches only for a name this registrar holds live ──────────────────────────────────────────

test('M2: /i/<code>?n= refuses any host the registrar does not hold as a live name — never sends the app elsewhere', async () => {
    const w = await world();
    try {
        const [owner, other] = await Promise.all([makeKey(), makeKey()]);
        await liveName(w, 'riverbend', owner);
        await liveName(w, 'stillwater', other);
        assert.equal((await w.admin('stillwater', 'pause')).status, 200);
        w.sqlite.prepare('INSERT INTO invites (code, node_name, created_at) VALUES (?, ?, ?)').run('INV-RIVER', 'riverbend', nowS());

        for (const n of ['evil.example.com', 'mullum-beanpool.org', 'riverbend.evil.example.com', 'riverbend.beanpool.org.evil.com',
            'https://evil.com', 'perth', 'perth.beanpool.org', 'stillwater', 'evil.com/riverbend.beanpool.org', '..', 'riverbend%2eevil.com']) {
            for (const code of ['anything', 'INV-RIVER', 'riverbend']) {
                const r = await page(w, `/i/${code}?n=${encodeURIComponent(n)}`);
                assert.equal(r.status, 404, `?n=${n} with code ${code}`);
                assert.doesNotMatch(r.html, /beanpool:\/\/join|Community node|evil|mullum-beanpool|perth/, `?n=${n}: no join link, no host named`);
            }
        }
        // Released: not held live, so not vouched for either.
        assert.equal((await w.release(owner, { name: 'riverbend' })).status, 200);
        assert.equal((await page(w, '/i/anything?n=riverbend')).status, 404, 'a released name');
        await w.claim(owner, { name: 'riverbend' });   // its own key takes it back, live again
        assert.equal((await w.row('riverbend')).status, 'live');

        // The one thing `?n=` may name: a live name of this registrar, by its label or its hostname.
        for (const n of ['riverbend', 'riverbend.beanpool.org', 'RiverBend', ' riverbend.beanpool.org ']) {
            const r = await page(w, `/i/INV-RIVER?n=${encodeURIComponent(n)}`);
            assert.equal(r.status, 200, `?n=${n}`);
            assert.ok(r.html.includes('beanpool://join?node=riverbend.beanpool.org&code=INV-RIVER'), `?n=${n}`);
            assert.ok(r.html.includes('Community node: riverbend.beanpool.org'), `?n=${n}`);
        }
        // Without `?n=`, codes resolve as before: an invite, or a live (or paused) name.
        assert.equal((await page(w, '/i/INV-RIVER')).status, 200);
        assert.equal((await page(w, '/i/stillwater')).status, 200, 'a paused community\'s own code still resolves');
        assert.equal((await page(w, '/i/nowhere')).status, 404);
    } finally { w.restore(); }
});

// ── L3: length caps and character checks on everything a keyholder sets ───────────────────────────────────────────

test('L3: claim, heal and update refuse an over-long or malformed field with a 400, and write nothing', async () => {
    const w = await world();
    try {
        const key = await makeKey();
        const long = (n) => 'x'.repeat(n);
        const bad = {
            'a 121-character community name': { community_name: long(121) },
            'a 121-character communityName': { communityName: long(121) },
            'a 20,000-byte community name': { community_name: long(20000) },
            'a 255-character contact': { contact: `${long(243)}@example.org` },
            'a newline inside the name': { community_name: 'River\nBend' },
            'a bell character': { contact: 'ops\u0007@example.org' },
            'a right-to-left override': { community_name: 'Bend\u202EreviR' },
            'a line separator': { community_name: 'River\u2028Bend' },
            'a number for a name': { community_name: 12345 },
            'an object for a contact': { contact: { evil: true } },
            'an origin that is a Cloudflare service, not a URL': { origin: 'http_status:404' },
            'an origin with a path': { origin: 'http://127.0.0.1:8080/admin' },
            'an origin with credentials': { origin: 'http://user:pass@127.0.0.1:8080' },
            'an origin with a query': { origin: 'http://127.0.0.1:8080?x=1' },
            'an ftp origin': { origin: 'ftp://127.0.0.1' },
            'an origin port over 65535': { origin: 'http://127.0.0.1:99999' },
            'a malformed IPv6 origin': { origin: 'http://[zz::1]:8080' },
            'a 201-character origin, every label valid': { origin: `http://${[long(60), long(60), long(60), long(20)].join('.')}:80` },
            'a 20,000-byte origin': { origin: `http://${long(20000)}` },
            'a public_ip that is no address': { mode: 'direct', public_ip: 'not-an-ip' },
            'a public_ip octet over 255': { mode: 'direct', public_ip: '1.2.3.256' },
            'an IPv6 public_ip (direct mode makes an A record)': { mode: 'direct', public_ip: '2001:db8::1' },
            'a number for a public_ip': { mode: 'direct', public_ip: 1234 },
        };
        const before = state(w);
        const calls = w.cf.calls.length;
        for (const [what, fields] of Object.entries(bad)) {
            const r = await w.claim(key, { name: 'riverbend', ...fields });
            assert.equal(r.status, 400, `claim with ${what}: ${JSON.stringify(r.body)}`);
            assert.equal(typeof r.body.error, 'string', what);
        }
        for (const body of [[], null, 'a string', 7]) {
            const r = await send(w, await (async () => {
                const ts = String(nowS());
                const text = JSON.stringify(body);
                const sig = await sign(key, `beanpool-registrar-request/v1\nPOST\n/api/registrar/claim\n${ts}\n${text}`);
                return new Request('https://beanpool.org/api/registrar/claim', { method: 'POST', body: text, headers: { 'x-bp-pubkey': key.pubHex, 'x-bp-timestamp': ts, 'x-bp-signature': sig } });
            })());
            assert.equal(r.status, 400, `claim body ${JSON.stringify(body)}`);
        }
        assert.deepEqual(state(w), before, 'no refused claim wrote anything (not even the claim\'s row)');
        assert.equal(w.cf.calls.length, calls, 'and none reached Cloudflare');

        // The limits themselves pass, in any script: communities are worldwide.
        const ok = { community_name: `Ngurra Bunya — 共同体 🌱 ${long(120)}`.slice(0, 120), contact: `${long(242)}@example.org` };
        assert.ok([...ok.community_name].length <= 120 && [...ok.community_name].length > 110);
        assert.equal(ok.contact.length, 254);
        const claimed = await w.claim(key, { name: 'riverbend', origin: 'http://127.0.0.1:8080', ...ok });
        assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
        assert.equal(claimed.body.status, 'live');
        const row = await w.row('riverbend');
        assert.equal(row.community_name, ok.community_name);
        assert.equal(row.contact, ok.contact);
        assert.equal(row.origin, 'http://127.0.0.1:8080');
        // Surrounding whitespace is trimmed, as it always was, and doesn't count.
        assert.equal((await w.heal(key, { community_name: `  ${long(120)}\n` })).status, 200);
        assert.equal((await w.row('riverbend')).community_name, long(120));

        // Every origin a node has sent passes: the loopback (today), the compose service (before), an IPv6 loopback.
        for (const origin of ['http://127.0.0.1:8080', 'http://beanpool-node:8080', 'https://[::1]:8443', 'http://localhost:3000/']) {
            const r = await w.heal(key, { origin });
            assert.equal(r.status, 200, `${origin}: ${JSON.stringify(r.body)}`);
            assert.equal((await w.row('riverbend')).origin, origin);
        }

        // A heal and an update are held to the same rules, and a refused one changes nothing.
        const kept = state(w);
        for (const [what, fields] of Object.entries(bad)) {
            const r = await w.heal(key, { name: 'riverbend', ...fields });
            assert.equal(r.status, 400, `heal with ${what}`);
        }
        for (const fields of [{ community_name: long(121) }, { communityName: long(121) }, { contact: long(255) }, { contact: 'a\u0000b' }, { community_name: ['x'] }]) {
            const r = await send(w, await (async () => {
                const ts = String(nowS());
                const text = JSON.stringify(fields);
                const sig = await sign(key, `beanpool-registrar-request/v1\nPOST\n/api/registrar/update\n${ts}\n${text}`);
                return new Request('https://beanpool.org/api/registrar/update', { method: 'POST', body: text, headers: { 'x-bp-pubkey': key.pubHex, 'x-bp-timestamp': ts, 'x-bp-signature': sig } });
            })());
            assert.equal(r.status, 400, `update with ${JSON.stringify(fields).slice(0, 60)}`);
        }
        assert.deepEqual(state(w), kept, 'no refused heal or update changed the row');

        // A direct name with an IPv4 address is fine.
        const direct = await makeKey();
        const d = await w.claim(direct, { name: 'hillside', mode: 'direct', public_ip: '203.0.113.7' });
        assert.equal(d.status, 200, JSON.stringify(d.body));
        assert.equal(w.cf.recordAt('hillside.beanpool.org')?.content, '203.0.113.7');
    } finally { w.restore(); }
});

// ── M1: names per key ───────────────────────────────────────────────────────────────────────────────────────────────

test('M1: a key holding CLAIM_LIMIT_PER_KEY names (3 by default) is refused a new one; under it is fine; another key is not affected', async () => {
    const w = await world();
    try {
        const [key, neighbour] = await Promise.all([makeKey(), makeKey()]);
        for (const name of ['alder', 'birch', 'cedar']) {
            const r = await w.claim(key, { name });
            assert.equal(r.status, 200, `${name}: ${JSON.stringify(r.body)}`);
            assert.equal(r.body.status, 'live', name);
        }
        const before = state(w);
        const calls = w.cf.calls.length;
        const refused = await w.claim(key, { name: 'dogwood' });
        assert.equal(refused.status, 403, JSON.stringify(refused.body));
        assert.equal(refused.body.limit, 3);
        assert.equal(refused.body.held, 3);
        assert.match(refused.body.error, /holds 3 names/);
        assert.deepEqual(state(w), before, 'the refused claim wrote nothing');
        assert.equal(w.cf.calls.length, calls, 'and made nothing at Cloudflare');
        assert.deepEqual(routing(w, 'dogwood'), { dns: null, tunnels: [] });
        assert.equal((await w.available('dogwood')).body.available, true, 'the name is still free for anyone');
        assert.equal((await w.claim(neighbour, { name: 'dogwood' })).body.status, 'live', 'another key takes it');

        // A gated claim waiting for the admin holds a name too.
        const gated = await makeKey();
        assert.equal((await w.claim(gated, { name: 'sydney' })).body.status, 'pending');
        assert.equal((await w.claim(gated, { name: 'elm' })).status, 200);
        assert.equal((await w.claim(gated, { name: 'fir' })).status, 200);
        assert.equal((await w.claim(gated, { name: 'gum' })).status, 403, 'pending counts');

        // The key's own names stay its to heal, at the limit.
        for (const name of ['alder', 'birch', 'cedar']) {
            assert.equal((await w.claim(key, { name })).body.status, 'live', `${name}: a claim of its own name is a heal`);
            assert.equal((await w.heal(key, { name })).body.status, 'live', `${name}: heal`);
        }
        assert.equal((await w.status(key)).body.status, 'live');
    } finally { w.restore(); }
});

test('M1: an owner\'s release counts until its hold ends, so a name can\'t be parked by claim-and-release; a freed one doesn\'t count', async () => {
    const w = await world();
    try {
        const key = await makeKey();
        for (const name of ['alder', 'birch', 'cedar']) assert.equal((await w.claim(key, { name })).body.status, 'live');
        assert.equal((await w.release(key, { name: 'alder' })).body.status, 'released');
        assert.equal((await w.claim(key, { name: 'dogwood' })).status, 403, 'a release still inside its hold counts');
        // Its own release, taken back: already counted, so allowed at the limit.
        assert.equal((await w.claim(key, { name: 'alder' })).body.status, 'live', 'a take-back is no new name');
        assert.equal((await w.release(key, { name: 'alder' })).body.status, 'released');
        // The hold over: free to anyone, and no longer this key's.
        await w.backdate('alder', { released_at: nowS() - 31 * DAY });
        const r = await w.claim(key, { name: 'dogwood' });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.status, 'live');
        // Its old release, past the hold, was free to anyone: taking it back now is a new name, and counts.
        const back = await w.claim(key, { name: 'alder' });
        assert.equal(back.status, 403, `a take-back past the hold, at the limit: ${JSON.stringify(back.body)}`);
        assert.equal((await w.row('alder')).status, 'released', 'the old release is left as it was');
        // The admin's release with "free now" frees a slot at once; its default release holds the name, and the slot.
        assert.equal((await w.admin('birch', 'release')).body.status, 'released');
        assert.equal((await w.claim(key, { name: 'elm' })).status, 403, 'an admin release holds the name for its key, and counts');
        assert.equal((await w.admin('birch', 'release', { free_now: true })).body.status, 'released');
        assert.equal((await w.claim(key, { name: 'elm' })).body.status, 'live', 'freed now: no longer counted');
        // A name the admin blocked is held under this key and counts; released by the admin, it is held from this key
        // too, so it is no longer this key's and doesn't.
        assert.equal((await w.admin('cedar', 'block')).body.status, 'blocked');
        assert.equal((await w.claim(key, { name: 'fir' })).status, 403, 'blocked counts');
        assert.equal((await w.admin('cedar', 'release')).body.reason, 'admin-held-all');
        assert.equal((await w.claim(key, { name: 'fir' })).body.status, 'live', 'admin-held-all does not');
    } finally { w.restore(); }
});

test('M1: CLAIM_LIMIT_PER_KEY sets the limit; an unusable value means 3', async () => {
    for (const [value, limit] of [['1', 1], ['5', 5], ['0', 3], ['-2', 3], ['lots', 3], [undefined, 3]]) {
        const w = await world({ env: value === undefined ? {} : { CLAIM_LIMIT_PER_KEY: value } });
        try {
            const key = await makeKey();
            for (let i = 0; i < limit; i++) {
                const r = await w.claim(key, { name: `grove${i}` });
                assert.equal(r.status, 200, `${value}: claim ${i + 1} of ${limit}: ${JSON.stringify(r.body)}`);
            }
            const r = await w.claim(key, { name: 'onetoomany' });
            assert.equal(r.status, 403, `${value}: claim ${limit + 1}`);
            assert.equal(r.body.limit, limit);
        } finally { w.restore(); }
    }
});

test('M1: a key already over the limit keeps, heals, releases and takes back every name it has; only a new one is refused', async () => {
    const w = await world({ env: { CLAIM_LIMIT_PER_KEY: '6' } });
    try {
        const key = await makeKey();
        const names = ['ash', 'beech', 'cherry', 'damson', 'elder'];
        for (const name of names) await liveName(w, name, key);
        w.env.CLAIM_LIMIT_PER_KEY = '3';   // the limit lowered (or set for the first time) under a key holding five
        for (const name of names) {
            assert.equal((await w.claim(key, { name })).body.status, 'live', `${name}: its claim heals it`);
            assert.equal((await w.heal(key, { name })).body.status, 'live', `${name}: heal`);
            assert.deepEqual((await w.holder(key, { name })).body.held, 'you', `${name}: still its`);
        }
        assert.equal((await w.release(key, { name: 'ash' })).body.status, 'released');
        assert.equal((await w.claim(key, { name: 'ash' })).body.status, 'live', 'its own release, taken back');
        const r = await w.claim(key, { name: 'fig' });
        assert.equal(r.status, 403);
        assert.equal(r.body.held, 5);
        assert.equal((await w.row('fig')), null);
        // Nothing of what it holds was touched by being over the limit.
        for (const name of names) {
            assert.equal((await w.row(name)).status, 'live', name);
            assert.equal(routing(w, name).tunnels.length, 1, name);
        }
        assert.equal((await attestSweep(w.env)).action, 'applied');
        for (const name of names) assert.equal((await w.row(name)).status, 'live', `${name} after a sweep`);
    } finally { w.restore(); }
});

test('M1: two claims by one key racing past the count — the one over the limit gives its name back before Cloudflare', async () => {
    const w = await world();
    try {
        const key = await makeKey();
        for (const name of ['alder', 'birch']) assert.equal((await w.claim(key, { name })).body.status, 'live');
        // A second claim lands between the first's count and its insert: both counted two.
        let second;
        w.beforeRun(/^INSERT INTO name_allocations/, async () => { second = await w.claim(key, { name: 'cedar' }); });
        const first = await w.claim(key, { name: 'dogwood' });
        assert.equal(second.status, 200, JSON.stringify(second.body));
        assert.equal(second.body.status, 'live');
        assert.equal(first.status, 403, JSON.stringify(first.body));
        assert.equal(await w.row('dogwood'), null, 'its row is gone again');
        assert.deepEqual(routing(w, 'dogwood'), { dns: null, tunnels: [] }, 'and nothing was made at Cloudflare');
        assert.equal((await w.available('dogwood')).body.available, true);

        // The same on a freed name another key held: the old row comes back exactly as it was.
        const old = await makeKey();
        await liveName(w, 'elm', old);
        assert.equal((await w.release(old, { name: 'elm' })).body.status, 'released');
        await w.backdate('elm', { released_at: nowS() - 31 * DAY });
        const was = await w.row('elm');
        assert.equal((await w.release(key, { name: 'cedar' })).body.status, 'released');   // two held + a release = 3
        await w.backdate('cedar', { released_at: nowS() - 31 * DAY });                      // … now two held
        let racer;
        w.beforeRun(/^UPDATE name_allocations SET node_pubkey=\?/, async () => { racer = await w.claim(key, { name: 'fir' }); });
        const taker = await w.claim(key, { name: 'elm' });
        assert.equal(racer.body.status, 'live', JSON.stringify(racer.body));
        assert.equal(taker.status, 403, JSON.stringify(taker.body));
        assert.deepEqual(await w.row('elm'), was, 'the freed row is back as it was');
        assert.equal((await w.available('elm')).body.available, true);
    } finally { w.restore(); }
});

// ── L1: a one-use nonce (signing protocol v2) ───────────────────────────────────────────────────────────────────────

test('L1: a v2 request is taken once — a replay inside the clock window is refused, and /status gives it no token', async () => {
    const w = await world();
    try {
        const key = await makeKey();
        const claim = await v2('POST', '/api/registrar/claim', key, { name: 'riverbend', mode: 'tunnel' });
        const claimed = await sendV2(w, claim);
        assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
        assert.equal(claimed.body.status, 'live');
        assert.equal(typeof claimed.body.tunnelToken, 'string');

        const status = await v2('GET', '/api/registrar/status', key);
        const first = await sendV2(w, status);
        assert.equal(first.status, 200);
        assert.equal(first.body.status, 'live');
        assert.equal(first.body.tunnelToken, claimed.body.tunnelToken, 'the holder gets its token');
        const replayed = await sendV2(w, status);
        assert.equal(replayed.status, 401, JSON.stringify(replayed.body));
        assert.deepEqual(replayed.body, { error: 'request already used' }, 'a captured /status hands out no token');

        // Each signed route: the first time works, the same request again doesn't, and changes nothing.
        const routes = [
            ['POST', '/api/registrar/heal', { name: 'riverbend' }],
            ['POST', '/api/registrar/update', { community_name: 'River Bend' }],
            ['POST', '/api/registrar/holder', { name: 'riverbend' }],
            ['POST', '/api/registrar/claim', { name: 'riverbend', mode: 'tunnel' }],
            ['POST', '/api/registrar/release', { name: 'riverbend' }],
        ];
        for (const [method, path, body] of routes) {
            const req = await v2(method, path, key, body);
            const once = await sendV2(w, req);
            assert.equal(once.status, 200, `${path}: ${JSON.stringify(once.body)}`);
            const before = state(w);
            const again = await sendV2(w, req);
            assert.equal(again.status, 401, `${path} replayed`);
            assert.deepEqual(again.body, { error: 'request already used' }, path);
            assert.deepEqual(state(w), before, `${path}: the replay changed nothing`);
        }
        assert.equal((await w.row('riverbend')).status, 'released');
        // A replayed release after its owner took the name back: refused (the reviewer's re-release case).
        const release = await v2('POST', '/api/registrar/release', key, { name: 'riverbend' });
        assert.equal((await w.claim(key, { name: 'riverbend' })).body.status, 'live', 'taken back');
        assert.equal((await sendV2(w, release)).status, 200);
        assert.equal((await w.claim(key, { name: 'riverbend' })).body.status, 'live', 'taken back again');
        assert.equal((await sendV2(w, release)).status, 401, 'the same release, replayed');
        assert.equal((await w.row('riverbend')).status, 'live', 'and the name stays live');
    } finally { w.restore(); }
});

test('L1: the nonce is inside the signed bytes and must be there; a fresh one is fine; one key\'s nonce is not another\'s', async () => {
    const w = await world();
    try {
        const [key, other] = await Promise.all([makeKey(), makeKey()]);
        await liveName(w, 'riverbend', key);
        const nonce = newNonce();
        const refused = { error: 'bad signature', accepted_proto: ['v1', 'v2'] };
        const bad = {
            'no nonce': await v2('GET', '/api/registrar/status', key, undefined, { nonce: null }),
            'a nonce swapped after signing': await v2('GET', '/api/registrar/status', key, undefined, { nonce: newNonce(), signedNonce: nonce }),
            'a short nonce': await v2('GET', '/api/registrar/status', key, undefined, { nonce: 'abc123' }),
            'an upper-case nonce': await v2('GET', '/api/registrar/status', key, undefined, { nonce: newNonce().toUpperCase() }),
            'a 64-character nonce': await v2('GET', '/api/registrar/status', key, undefined, { nonce: newNonce() + newNonce() }),
            'outside the clock window': await v2('GET', '/api/registrar/status', key, undefined, { ts: nowS() - 301 }),
        };
        for (const [what, req] of Object.entries(bad)) {
            const r = await sendV2(w, req);
            assert.equal(r.status, 401, `${what}: ${JSON.stringify(r.body)}`);
            assert.deepEqual(r.body, refused, what);
        }
        assert.equal(w.sqlite.prepare('SELECT COUNT(*) AS n FROM request_nonces').get().n, 0, 'a refused request records no nonce');
        // Fresh nonces, one after another: every one works.
        for (let i = 0; i < 3; i++) assert.equal((await sendV2(w, await v2('GET', '/api/registrar/status', key))).body.status, 'live');
        // The same nonce under another key is that key's own first use.
        assert.equal((await sendV2(w, await v2('GET', '/api/registrar/status', key, undefined, { nonce }))).status, 200);
        assert.equal((await sendV2(w, await v2('GET', '/api/registrar/status', other, undefined, { nonce }))).status, 200);
        assert.equal((await sendV2(w, await v2('GET', '/api/registrar/status', key, undefined, { nonce }))).status, 401, 'and the first key\'s second use is a replay, re-signed or not');
    } finally { w.restore(); }
});

test('L1: an old node (v1, no nonce) keeps working — every route, and a repeated request too, as before', async () => {
    const w = await world();
    try {
        const key = await makeKey();
        const claimed = await liveName(w, 'riverbend', key);
        assert.equal(typeof claimed.tunnelToken, 'string');
        for (let i = 0; i < 2; i++) assert.equal((await w.status(key)).body.tunnelToken, claimed.tunnelToken, 'v1 /status still answers the token');
        assert.equal((await w.heal(key, { name: 'riverbend' })).body.status, 'live');
        assert.equal((await w.holder(key, { name: 'riverbend' })).body.held, 'you');
        assert.equal((await w.release(key, { name: 'riverbend' }, '/api/registrar/offline')).body.status, 'released');
        assert.equal((await w.claim(key, { name: 'riverbend' })).body.status, 'live');
        // A v1 request sent twice inside its window verifies twice: v1 signs no nonce. That is what v2 closes, and why
        // nodes move to it (SEND_PROTO) once this Worker is live.
        const ts = String(nowS());
        const sig = await sign(key, `beanpool-registrar-request/v1\nGET\n/api/registrar/status\n${ts}\n`);
        const headers = { 'x-bp-pubkey': key.pubHex, 'x-bp-timestamp': ts, 'x-bp-signature': sig };
        for (let i = 0; i < 2; i++) assert.equal((await send(w, new Request('https://beanpool.org/api/registrar/status', { headers }))).status, 200);
        assert.equal(w.sqlite.prepare('SELECT COUNT(*) AS n FROM request_nonces').get().n, 0, 'v1 writes no nonce');
    } finally { w.restore(); }
});

test('L1: the sweep drops nonces that can no longer verify (over 600 s old) and keeps the rest', async () => {
    const w = await world();
    try {
        const key = await makeKey();
        const now = nowS();
        const add = w.sqlite.prepare('INSERT INTO request_nonces (pubkey, nonce, ts) VALUES (?, ?, ?)');
        add.run(key.pubHex, 'a'.repeat(32), now - 900);
        add.run(key.pubHex, 'b'.repeat(32), now - 500);
        add.run(key.pubHex, 'c'.repeat(32), now + 250);
        await attestSweep(w.env);
        assert.deepEqual(w.sqlite.prepare('SELECT nonce FROM request_nonces ORDER BY nonce').all().map((r) => r.nonce), ['b'.repeat(32), 'c'.repeat(32)]);
    } finally { w.restore(); }
});

// ── L4: no Cloudflare ids or error bodies to a keyholder ────────────────────────────────────────────────────────────

test('L4: a Cloudflare failure answers a keyholder a reference, never the account or zone id or Cloudflare\'s error', async () => {
    const w = await world();
    const logged = [];
    const realError = console.error;
    console.error = (...a) => { logged.push(a.map(String).join(' ')); };
    try {
        const key = await makeKey();
        const leaks = (text) => ['acct', 'zone', '/accounts/', '/zones/', 'cfd_tunnel', 'dns_records', 'internal error', 'CF ', '"code"']
            .filter((s) => text.includes(s));
        for (const which of ['postDns', 'ingress']) {
            w.cf.fail[which] = true;
            const res = await worker.fetch(await (async () => {
                const ts = String(nowS());
                const text = JSON.stringify({ name: `fail-${which.toLowerCase()}`, mode: 'tunnel' });
                const sig = await sign(key, `beanpool-registrar-request/v1\nPOST\n/api/registrar/claim\n${ts}\n${text}`);
                return new Request('https://beanpool.org/api/registrar/claim', { method: 'POST', body: text, headers: { 'x-bp-pubkey': key.pubHex, 'x-bp-timestamp': ts, 'x-bp-signature': sig } });
            })(), w.env);
            w.cf.fail[which] = false;
            const text = await res.text();
            assert.equal(res.status, 502, text);
            assert.deepEqual(leaks(text), [], `${which}: ${text}`);
            const body = JSON.parse(text);
            assert.deepEqual(Object.keys(body).sort(), ['error', 'ref'], text);
            assert.equal(body.error, 'provisioning failed');
            assert.match(body.ref, /^[0-9a-f]{8}$/);
            assert.ok(logged.some((l) => l.includes(body.ref) && (l.includes('/accounts/acct') || l.includes('/zones/zone'))),
                `${which}: the log has the detail, under the same ref`);
        }

        // Anything else that throws: a 500 with a reference, and the message only in the log.
        await liveName(w, 'riverbend', key);
        w.afterRead(/FROM name_allocations WHERE name=\?/, async () => { throw new Error('CF GET /accounts/acct/cfd_tunnel/x → [{"code":1000}] zone'); });
        const r = await w.heal(key, { name: 'riverbend' });
        assert.equal(r.status, 500);
        assert.deepEqual(Object.keys(r.body).sort(), ['error', 'ref']);
        assert.deepEqual(leaks(JSON.stringify(r.body)), []);
        assert.ok(logged.some((l) => l.includes(r.body.ref) && l.includes('/accounts/acct')), 'logged under its ref');

        // The admin, who isn't a keyholder, still sees what Cloudflare said when an approval fails.
        const gated = await makeKey();
        assert.equal((await w.claim(gated, { name: 'sydney' })).body.status, 'pending');
        w.cf.fail.postDns = true;
        const approve = await w.admin('sydney', 'approve');
        w.cf.fail.postDns = false;
        assert.equal(approve.status, 502);
        assert.match(approve.body.detail, /internal error/);
        assert.match(approve.body.ref, /^[0-9a-f]{8}$/);
    } finally {
        console.error = realError;
        w.restore();
    }
});
