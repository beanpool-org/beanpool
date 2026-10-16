// The fixes from the verified registrar audit (scratch/reviews/verify-audit-registrar.md, 2026-10-16): REG-01 (a direct
// name with no address to point at), REG-02 (/update of a key with several names), REG-03 (the body cap), REG-05 (the
// budget of new auto names) and REG-06 (/admin framed). Each test here failed on cea6229a.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadableStream } from 'node:stream/web';
import { world, makeKey, liveName, nowS, toHex } from './harness.js';
import worker from '../src/index.js';

const sign = async (key, message) => toHex(await crypto.subtle.sign('Ed25519', key.keyPair.privateKey, new TextEncoder().encode(message)));
async function signedPost(w, path, key, body) {
    const ts = String(nowS());
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const req = new Request(`https://beanpool.org${path}`, {
        method: 'POST', body: text,
        headers: { 'content-type': 'application/json', 'x-bp-pubkey': key.pubHex, 'x-bp-timestamp': ts,
            'x-bp-signature': await sign(key, `beanpool-registrar-request/v1\nPOST\n${path}\n${ts}\n${text}`) },
    });
    const res = await worker.fetch(req, w.env);
    return { status: res.status, body: await res.json() };
}
const label = (w, n) => w.sqlite.prepare('SELECT community_name FROM name_allocations WHERE name=?').get(n)?.community_name ?? null;

test('REG-02: /update {name} changes that name only, and only for its own key; no name keeps the old answer', async () => {
    const w = await world();
    try {
        const k = await makeKey(), other = await makeKey();
        await liveName(w, 'alpha', k);
        w.sqlite.prepare("UPDATE name_allocations SET requested_at = requested_at - 100 WHERE name='alpha'").run();
        await liveName(w, 'beta', k);
        await liveName(w, 'gamma', other);
        const r = await signedPost(w, '/api/registrar/update', k, { name: 'alpha', community_name: 'Alpha' });
        assert.equal(r.status, 200);
        assert.equal(r.body.name, 'alpha');
        assert.equal(label(w, 'alpha'), 'Alpha');
        assert.equal(label(w, 'beta'), null);
        // Another key's name: 404, and its row untouched.
        const r2 = await signedPost(w, '/api/registrar/update', k, { name: 'gamma', community_name: 'x' });
        assert.equal(r2.status, 404);
        assert.equal(label(w, 'gamma'), null);
        // A name nobody holds, and a malformed one: 404.
        assert.equal((await signedPost(w, '/api/registrar/update', k, { name: 'nobody-here', community_name: 'x' })).status, 404);
        assert.equal((await signedPost(w, '/api/registrar/update', k, { name: 'Bad_Name', community_name: 'x' })).status, 404);
        // Its own name in a state /update does not serve (released): 404.
        assert.equal((await w.release(k, { name: 'alpha' })).status, 200);
        assert.equal((await signedPost(w, '/api/registrar/update', k, { name: 'alpha', community_name: 'Again' })).status, 404);
        assert.equal(label(w, 'alpha'), 'Alpha');
        // An older node sends no name: the key's newest held name, as before.
        const r3 = await signedPost(w, '/api/registrar/update', k, { community_name: 'Newest' });
        assert.equal(r3.status, 200);
        assert.equal(r3.body.name, 'beta');
        assert.equal(label(w, 'beta'), 'Newest');
    } finally { w.restore(); }
});

test('REG-01: a direct claim or heal with no public_ip known is a 400 and writes nothing; a direct row that has one still heals', async () => {
    const w = await world();
    try {
        const k = await makeKey();
        const r = await w.claim(k, { name: 'testdirect', mode: 'direct' });
        assert.equal(r.status, 400);
        assert.match(r.body.error, /public_ip/);
        assert.equal(await w.row('testdirect'), null);
        assert.deepEqual(w.cf.calls, []);
        // A gated name too: nothing waits for an approve that could only fail.
        const g = await w.claim(k, { name: 'sydney', mode: 'direct' });
        assert.equal(g.status, 400);
        assert.equal(await w.row('sydney'), null);
        // With an address: live, and a heal that doesn't repeat it keeps it.
        const ok = await w.claim(k, { name: 'direct-ok', mode: 'direct', public_ip: '203.0.113.9' });
        assert.equal(ok.body.status, 'live');
        const again = await w.claim(k, { name: 'direct-ok', mode: 'direct' });
        assert.equal(again.status, 200);
        assert.equal(again.body.status, 'live');
        assert.equal((await w.heal(k, { name: 'direct-ok' })).body.status, 'live');
        // A live tunnel name healed into direct with no address: 400, and the row is as it was.
        await liveName(w, 'tunnelname', k);
        const before = await w.row('tunnelname');
        const h = await w.heal(k, { name: 'tunnelname', mode: 'direct' });
        assert.equal(h.status, 400);
        assert.deepEqual(await w.row('tunnelname'), before);
        const c = await w.claim(k, { name: 'tunnelname', mode: 'direct' });
        assert.equal(c.status, 400);
        assert.deepEqual(await w.row('tunnelname'), before);
    } finally { w.restore(); }
});

test('REG-03: a POST body over 64 KB is a 413, read no further; a normal one still works', async () => {
    const w = await world();
    try {
        const k = await makeKey();
        const big = await signedPost(w, '/api/registrar/holder', k, { name: 'cairns', pad: 'x'.repeat(65 * 1024) });
        assert.equal(big.status, 413);
        // No content-length, streamed in chunks (HTTP/2, chunked): still capped.
        let sent = 0;
        const stream = new ReadableStream({ pull(c) { if (sent >= 8) return c.close(); sent++; c.enqueue(new Uint8Array(16 * 1024).fill(120)); } });
        const res = await worker.fetch(new Request('https://beanpool.org/api/registrar/claim', { method: 'POST', body: stream, duplex: 'half' }), w.env);
        assert.equal(res.status, 413);
        assert.ok(sent < 8, `stopped reading after ${sent} chunks`);
        // The admin's POSTs too.
        const adminBig = await worker.fetch(new Request('https://beanpool.org/api/local/admin/registrar/alerts/settings', {
            method: 'POST', headers: { 'x-admin-secret': 'test-admin-secret' }, body: 'x'.repeat(65 * 1024),
        }), w.env);
        assert.equal(adminBig.status, 413);
        // Exactly 64 KB is not over.
        const edge = await worker.fetch(new Request('https://beanpool.org/api/registrar/holder', { method: 'POST', body: 'y'.repeat(64 * 1024) }), w.env);
        assert.notEqual(edge.status, 413);
        const ok = await signedPost(w, '/api/registrar/holder', k, { name: 'cairns' });
        assert.equal(ok.status, 200);
        assert.equal((await w.claim(k, { name: 'small-body' })).body.status, 'live');
    } finally { w.restore(); }
});

const budgetAlerts = (w) => w.sqlite.prepare("SELECT title, body, name FROM alert_outbox WHERE title LIKE 'New-name budget%' ORDER BY id").all();

test('REG-05: new auto names are budgeted per hour across all keys (20 by default), then 429 and one alert in counts', async () => {
    const w = await world();
    try {
        let live = 0, refused = 0;
        for (let i = 0; i < 25; i++) {
            const r = await w.claim(await makeKey(), { name: `spam-${i}` });
            if (r.body.status === 'live') live++;
            if (r.status === 429) { refused++; assert.ok(r.body.retry_after > 0); }
        }
        assert.equal(live, 20);
        assert.equal(refused, 5);
        assert.equal([...w.cf.tunnels.values()].filter((t) => !t.deleted_at).length, 20);
        assert.equal(await w.row('spam-24'), null);
        // Told once for the hour, in counts: no name, no key.
        const told = budgetAlerts(w);
        assert.equal(told.length, 1, JSON.stringify(told));
        assert.equal(told[0].name, null);
        assert.match(told[0].body, /20 new names in the last hour/);
        assert.doesNotMatch(told[0].body, /spam-/);
        // A gated claim makes nothing at Cloudflare: not budgeted.
        const g = await w.claim(await makeKey(), { name: 'sydney' });
        assert.equal(g.body.status, 'pending');
        // A key's own name still heals over the budget.
        const own = await makeKey();
        w.sqlite.prepare('UPDATE name_allocations SET decided_at = decided_at - 7200').run();
        await liveName(w, 'ownname', own);
        w.sqlite.prepare("UPDATE name_allocations SET decided_at = strftime('%s','now')").run();
        assert.equal((await w.claim(own, { name: 'ownname' })).body.status, 'live');
        assert.equal((await w.heal(own, { name: 'ownname' })).body.status, 'live');
    } finally { w.restore(); }
});

test('REG-05: the daily ceiling holds when the hour has room; both are env-tunable', async () => {
    const w = await world({ env: { NEW_NAMES_PER_HOUR: '3', NEW_NAMES_PER_DAY: '5' } });
    try {
        const claim = async (n) => w.claim(await makeKey(), { name: n });
        for (const n of ['day-a', 'day-b', 'day-c']) assert.equal((await claim(n)).body.status, 'live');
        assert.equal((await claim('day-d')).status, 429);   // the hour's 3
        // Two hours on: the hour has room again, and the day has 2 left.
        w.sqlite.prepare('UPDATE name_allocations SET decided_at = decided_at - 7200').run();
        assert.equal((await claim('day-d')).body.status, 'live');
        assert.equal((await claim('day-e')).body.status, 'live');
        const r = await claim('day-f');
        assert.equal(r.status, 429);
        assert.match(r.body.error, /in the last 24 hours/);
        const told = budgetAlerts(w);
        assert.equal(told.length, 2, JSON.stringify(told));
        assert.match(told[1].body, /5 new names in the last 24 hours/);
        // A day on, all of it is free again.
        w.sqlite.prepare('UPDATE name_allocations SET decided_at = decided_at - 86400').run();
        assert.equal((await claim('day-f')).body.status, 'live');
    } finally { w.restore(); }
});

test('REG-06: /admin can not be framed', async () => {
    const w = await world();
    try {
        for (const p of ['/admin', '/admin/', '/admin.html']) {
            const res = await worker.fetch(new Request(`https://beanpool.org${p}`), w.env);
            assert.equal(res.status, 200);
            assert.equal(res.headers.get('x-frame-options'), 'DENY');
            assert.match(res.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
            assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
            assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
        }
    } finally { w.restore(); }
});
