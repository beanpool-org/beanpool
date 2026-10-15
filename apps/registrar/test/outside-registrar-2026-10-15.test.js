// F1 of the registrar review of 2026-10-15 (scratch/reviews/fable-security-registrar.md): a claim took over whatever
// record and bp- tunnel it found at a label name_policy didn't reserve — `vault`, one of our servers, among them. T3a/b/c
// of the review with the expectation flipped: another key's new tenure refuses (409) and leaves Cloudflare as it was;
// our servers' names are reserved (migration 0010); a community's own name still heals over a record at its hostname.
//
// The same world as ownership-states.test.js (test/harness.js): in-memory SQLite with the migrations, a fake Cloudflare.

import test from 'node:test';
import assert from 'node:assert/strict';
import { world, liveName, makeKey, routing } from './harness.js';

const HOST = 'ourthing.beanpool.org';
const OURS = ['vault', 'auth', 'mullum1', 'mullum2', 'mullum3', 'test-mirror', 'p2p-mullum2'];

// A record and a tunnel of ours, made by hand at Cloudflare, outside the registrar.
const handRecord = (w, name = HOST) => {
    const r = { id: 'hand-dns-1', type: 'A', name, content: '203.0.113.7', proxied: true };
    w.cf.dns.set(r.id, r);
    return { ...r };
};
const handTunnel = (w, name = 'bp-ourthing') => {
    const t = { id: 'hand-tun-1', name, created_at: new Date(Date.now() - 86400_000).toISOString(), deleted_at: null };
    w.cf.tunnels.set(t.id, t);
    return { ...t };
};
const refusedAlerts = (w, name) => w.sqlite.prepare('SELECT title, body FROM alert_outbox WHERE title = ?').all(`Claim refused: ${name}`);

for (const [label, mode, body] of [
    ['T3a: a tunnel claim', 'tunnel', {}],
    ['T3b: a direct claim', 'direct', { public_ip: '198.51.100.9' }],
]) {
    test(`${label} at a label with a record the registrar did not make is refused (409); the record is untouched`, async () => {
        const w = await world({ env: { NTFY_URL: 'https://ntfy.invalid/topic' } });
        try {
            const stranger = await makeKey();
            const before = handRecord(w);
            const r = await w.claim(stranger, { name: 'ourthing', mode, ...body });
            assert.equal(r.status, 409, JSON.stringify(r.body));
            assert.equal(r.body.error, 'name in use outside the registrar');
            assert.deepEqual(w.cf.dns.get(before.id), before, 'the hand-made record is exactly as it was');
            assert.equal([...w.cf.dns.values()].length, 1, 'no record made');
            assert.deepEqual(routing(w, 'ourthing').tunnels, [], 'no tunnel made');
            assert.equal(await w.row('ourthing'), null, 'no row: the name is nobody\'s');
            assert.ok(!w.cf.calls.some((c) => /^(PATCH|DELETE|POST|PUT) /.test(c)), `no write to Cloudflare: ${w.cf.calls.join(', ')}`);
            const ev = w.events('ourthing');
            assert.equal(ev.length, 1);
            assert.equal(ev[0].event, 'claim-refused');
            assert.match(ev[0].detail, /an A record at Cloudflare the registrar did not make/);
            const told = refusedAlerts(w, 'ourthing');
            assert.equal(told.length, 1, 'the admin is told');
            assert.match(told[0].body, /ourthing\.beanpool\.org already has an A record/);
            assert.doesNotMatch(told[0].body, new RegExp(stranger.pubHex.slice(0, 16)), 'no key in the alert');
            // Asked again (its node retries every 5 minutes): refused again, told once.
            assert.equal((await w.claim(stranger, { name: 'ourthing', mode, ...body })).status, 409);
            assert.equal(refusedAlerts(w, 'ourthing').length, 1);
            assert.deepEqual(w.cf.dns.get(before.id), before);
        } finally { w.restore(); }
    });
}

test('T3c: a claim at a label with a bp- tunnel the registrar did not make is refused (409); the tunnel is untouched', async () => {
    const w = await world();
    try {
        const stranger = await makeKey();
        const before = handTunnel(w);
        const r = await w.claim(stranger, { name: 'ourthing' });
        assert.equal(r.status, 409, JSON.stringify(r.body));
        assert.equal(r.body.error, 'name in use outside the registrar');
        assert.deepEqual(w.cf.tunnels.get(before.id), before, 'the hand-made tunnel is exactly as it was');
        assert.equal([...w.cf.tunnels.values()].length, 1, 'no tunnel made');
        assert.equal(w.cf.recordAt(HOST), null, 'no record made');
        assert.equal(await w.row('ourthing'), null);
        assert.match(w.events('ourthing')[0].detail, /1 bp-ourthing tunnel at Cloudflare/);
    } finally { w.restore(); }
});

test('a gated claim at a label with a hand-made record or tunnel: the admin\'s approve is refused (409), Cloudflare untouched', async () => {
    const w = await world();
    try {
        const before = handRecord(w, 'sydney.beanpool.org');
        const tun = handTunnel(w, 'bp-sydney');
        const key = await makeKey();
        assert.equal((await w.claim(key, { name: 'sydney' })).body.status, 'pending');   // gated: waits, reaches no Cloudflare
        assert.equal(w.cf.calls.length, 0);
        const r = await w.admin('sydney', 'approve');
        assert.equal(r.status, 409, JSON.stringify(r.body));
        assert.equal(r.body.error, 'name in use outside the registrar');
        assert.equal((await w.row('sydney')).status, 'pending', 'still waiting; the admin decides');
        assert.deepEqual(w.cf.dns.get(before.id), before);
        assert.deepEqual(w.cf.tunnels.get(tun.id), tun);
        assert.ok(!w.cf.calls.some((c) => /^(PATCH|DELETE|POST|PUT) /.test(c)), w.cf.calls.join(', '));
        assert.match(w.events('sydney').at(-1).detail, /^approve by the admin refused: an A record and 1 bp-sydney tunnel/);
    } finally { w.restore(); }
});

test('our servers\' names are reserved (0010): vault and the rest answer 403, Cloudflare untouched', async () => {
    const w = await world();
    try {
        const tiers = Object.fromEntries(w.sqlite.prepare(`SELECT pattern, tier FROM name_policy WHERE pattern IN (${OURS.map(() => '?').join(',')})`)
            .all(...OURS).map((r) => [r.pattern, r.tier]));
        assert.deepEqual(tiers, Object.fromEntries(OURS.map((n) => [n, 'blocked'])));
        const stranger = await makeKey();
        const before = handRecord(w, 'vault.beanpool.org');
        for (const name of OURS) {
            const r = await w.claim(stranger, { name });
            assert.equal(r.status, 403, `${name}: ${JSON.stringify(r.body)}`);
            assert.equal(r.body.error, 'name reserved');
            assert.equal((await w.available(name)).body.available, false, name);
        }
        assert.deepEqual(w.cf.dns.get(before.id), before);
        // `test` is not one of 0010's: 0001 already blocks it on a fresh database (the live one has no such row).
        assert.equal((await w.claim(stranger, { name: 'test' })).status, 403, 'test is blocked by 0001 on a fresh database');
    } finally { w.restore(); }
});

test('a free name the last tenure routed is still taken by a new key: only what no row records or owes is refused', async () => {
    const w = await world();
    try {
        const [first, second] = await Promise.all([makeKey(), makeKey()]);
        await liveName(w, 'riverbend', first);
        // The first key releases it, and the admin frees it now; Cloudflare refuses to delete the record, so the
        // released row still records it.
        w.cf.fail.deleteDns = true;
        assert.equal((await w.admin('riverbend', 'release', { free_now: true })).status, 200);
        const left = w.cf.recordAt('riverbend.beanpool.org');
        assert.ok(left, 'the record Cloudflare would not delete is still there');
        w.cf.fail.deleteDns = false;
        const r = await w.claim(second, { name: 'riverbend' });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.status, 'live');
        assert.equal((await w.row('riverbend')).node_pubkey, second.pubHex);
    } finally { w.restore(); }
});

test('a community\'s own name still heals over a record at its hostname (node-address-never-lost)', async () => {
    const w = await world();
    try {
        const owner = await makeKey();
        await liveName(w, 'riverbend', owner);
        const row = await w.row('riverbend');
        // Its record went (by hand, or lost at Cloudflare) and something else stands at the hostname now.
        w.cf.dns.delete(row.dns_record_id);
        handRecord(w, 'riverbend.beanpool.org');
        const r = await w.claim(owner, { name: 'riverbend' });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.status, 'live');
        assert.equal(routing(w, 'riverbend').dns, `${row.tunnel_id}.cfargotunnel.com`, 'routed to its own tunnel again');
    } finally { w.restore(); }
});

// NB1 of the #1978 review (P-C4): a new tenure that passed the check but failed at Cloudflare stays pending for its key,
// and that key's next claim (or /heal) retries it. The retry takes over nothing made since, as the claim would not have.
test('a pending claim retried after a hand record appeared at its label is refused (409); the record is untouched', async () => {
    const w = await world();
    try {
        const stranger = await makeKey();
        w.cf.fail.ingress = true;
        assert.equal((await w.claim(stranger, { name: 'futurebox' })).status, 502);
        w.cf.fail.ingress = false;
        const pending = await w.row('futurebox');
        assert.equal(pending.status, 'pending');
        const before = handRecord(w, 'futurebox.beanpool.org');
        w.cf.calls.length = 0;
        for (const retry of [() => w.claim(stranger, { name: 'futurebox' }), () => w.heal(stranger, { name: 'futurebox' })]) {
            const r = await retry();
            assert.equal(r.status, 409, JSON.stringify(r.body));
            assert.equal(r.body.error, 'name in use outside the registrar');
        }
        assert.deepEqual(w.cf.dns.get(before.id), before, 'the hand-made record is exactly as it was');
        assert.deepEqual(routing(w, 'futurebox').tunnels, [], 'no tunnel made');
        assert.ok(!w.cf.calls.some((c) => /^(PATCH|DELETE|POST|PUT) /.test(c)), `no write to Cloudflare: ${w.cf.calls.join(', ')}`);
        assert.deepEqual(await w.row('futurebox'), pending, 'the row is as it was: still pending for its key');
        assert.match(w.events('futurebox').at(-1).detail, /refused: an A record at Cloudflare the registrar did not make/);
    } finally { w.restore(); }
});

// What the pending tenure itself made before it stopped (a Worker that died part way, or a record Cloudflare made but
// answered an error for) is its own: a CNAME to a bp-<name> tunnel made at or after the claim. Its retry finishes.
for (const [label, deleted] of [['still live', false], ['since deleted', true]]) {
    test(`a pending claim whose own CNAME is left at its label (to a tunnel ${label}) is finished by its retry: live`, async () => {
        const w = await world();
        try {
            const key = await makeKey();
            w.cf.fail.ingress = true;
            assert.equal((await w.claim(key, { name: 'halfway' })).status, 502);
            w.cf.fail.ingress = false;
            const since = (await w.row('halfway')).requested_at - 700;   // long enough ago that the tunnel is stale
            await w.backdate('halfway', { requested_at: since });
            const t = { id: 'tun-left', name: 'bp-halfway', created_at: new Date((since + 5) * 1000).toISOString(), deleted_at: deleted ? new Date().toISOString() : null };
            w.cf.tunnels.set(t.id, t);
            w.cf.dns.set('dns-left', { id: 'dns-left', type: 'CNAME', name: 'halfway.beanpool.org', content: 'tun-left.cfargotunnel.com', proxied: true });
            const r = await w.claim(key, { name: 'halfway' });
            assert.equal(r.status, 200, JSON.stringify(r.body));
            assert.equal(r.body.status, 'live');
            const row = await w.row('halfway');
            assert.equal(row.dns_record_id, 'dns-left', 'its own record adopted');
            assert.equal(routing(w, 'halfway').dns, `${row.tunnel_id}.cfargotunnel.com`);
        } finally { w.restore(); }
    });
}

test('a pending claim retried over a bp- tunnel made before the claim, at a name never held, is refused (409)', async () => {
    const w = await world();
    try {
        const key = await makeKey();
        w.cf.fail.ingress = true;
        assert.equal((await w.claim(key, { name: 'ourthing' })).status, 502);
        w.cf.fail.ingress = false;
        const before = handTunnel(w);   // a day old: made before this tenure began
        const r = await w.claim(key, { name: 'ourthing' });
        assert.equal(r.status, 409, JSON.stringify(r.body));
        assert.deepEqual(w.cf.tunnels.get(before.id), before);
    } finally { w.restore(); }
});

// NB2 (P-C5): every host record at the hostname is checked, not only the first Cloudflare lists.
test('a claim where the last tenure\'s record stands beside a hand AAAA record is refused (409); both are untouched', async () => {
    const w = await world();
    try {
        const [first, second] = await Promise.all([makeKey(), makeKey()]);
        await liveName(w, 'tworecs', first);
        w.cf.fail.deleteDns = true;
        assert.equal((await w.admin('tworecs', 'release', { free_now: true })).status, 200);
        w.cf.fail.deleteDns = false;
        const released = await w.row('tworecs');
        const recorded = { ...w.cf.dns.get(released.dns_record_id) };
        const aaaa = { id: 'hand-aaaa', type: 'AAAA', name: 'tworecs.beanpool.org', content: '2001:db8::1', proxied: true };
        w.cf.dns.set(aaaa.id, { ...aaaa });   // listed after the recorded one
        w.cf.calls.length = 0;
        const r = await w.claim(second, { name: 'tworecs' });
        assert.equal(r.status, 409, JSON.stringify(r.body));
        assert.equal(r.body.error, 'name in use outside the registrar');
        assert.deepEqual(w.cf.dns.get(aaaa.id), aaaa, 'the hand AAAA is intact');
        assert.deepEqual(w.cf.dns.get(recorded.id), recorded);
        assert.deepEqual(await w.row('tworecs'), released, 'the released row is unchanged');
        assert.ok(!w.cf.calls.some((c) => /^(PATCH|DELETE|POST|PUT) /.test(c)), w.cf.calls.join(', '));
        assert.match(w.events('tworecs').at(-1).detail, /refused: an AAAA record at Cloudflare/);
    } finally { w.restore(); }
});

// NB6: the alert says how to reserve a name — a migration — not the Block action.
test('the refusal alert reads "an A record" and points at a name_policy migration', async () => {
    const w = await world({ env: { NTFY_URL: 'https://ntfy.invalid/topic' } });
    try {
        handRecord(w);
        assert.equal((await w.claim(await makeKey(), { name: 'ourthing' })).status, 409);
        const [told] = refusedAlerts(w, 'ourthing');
        assert.match(told.body, /ourthing\.beanpool\.org already has an A record the registrar did not make\. Nothing was changed\./);
        assert.match(told.body, /add a name_policy row \(blocked\) by migration/);
        assert.doesNotMatch(told.body, /reserve the name \(blocked\)/);
    } finally { w.restore(); }
});
