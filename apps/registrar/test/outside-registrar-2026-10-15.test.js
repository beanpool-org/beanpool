// F1 of the registrar review of 2026-10-15 (scratch/reviews/fable-security-registrar.md): a claim took over whatever
// record and bp- tunnel it found at a label name_policy didn't reserve — `vault`, one of our servers, among them. T3a/b/c
// of the review with the expectation flipped: another key's new tenure refuses (409) and leaves Cloudflare as it was;
// our servers' names are reserved (migration 0010); a community's own name still heals over a record at its hostname.
//
// The same world as ownership-states.test.js (test/harness.js): in-memory SQLite with the migrations, a fake Cloudflare.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

// ---------- Round 1 of the #1985 review (scratch/reviews/opus-1985.md) ----------

const writes = (w) => w.cf.calls.filter((c) => /^(PATCH|DELETE|POST|PUT) /.test(c));
const recordsAt = (w, name) => [...w.cf.dns.values()].filter((r) => r.name === `${name}.beanpool.org`);
const tryCall = async (f) => { try { return await f(); } catch (e) { return { status: 'threw', body: String(e.message) }; } };
// The Worker dies (the node's 5 s abort cancels it) just after Cloudflare made the record, before the row's write.
function dieAfterDnsPost(w) {
    w.cf.during(/^POST \/zones\/zone\/dns_records$/, async () => {
        w.beforeRun(/^UPDATE name_allocations SET/, () => { throw new Error('test: the Worker was cancelled'); });
    });
}
// Cloudflare makes the record but answers an error (a 5xx after the commit, a subrequest that timed out).
function dnsPostErrsButMakes(w) {
    const handle = w.cf.handle;
    let once = true;
    w.cf.handle = async (method, url, body) => {
        const res = await handle(method, url, body);
        if (once && method === 'POST' && url.pathname.endsWith('/zones/zone/dns_records')) {
            once = false;
            return Response.json({ success: false, errors: [{ code: 1000, message: 'made, then 504' }] }, { status: 504 });
        }
        return res;
    };
}
// Eleven minutes pass: the tenure and every tunnel at the name move back `s` seconds.
async function age(w, name, s) {
    await w.backdate(name, { requested_at: (await w.row(name)).requested_at - s });
    for (const t of w.cf.tunnels.values()) if (t.name === `bp-${name}`) t.created_at = new Date(Date.parse(t.created_at) - s * 1000).toISOString();
}

// NB-1: a pending DIRECT tenure's own A record — at the IP its row declares — is its own, as a CNAME to its own
// tunnel is. Its honest retry finishes; a hand A record at another IP is still refused.
for (const [label, cut] of [['the Worker died after Cloudflare made it', dieAfterDnsPost], ['Cloudflare made it but answered an error', dnsPostErrsButMakes]]) {
    test(`a pending direct claim whose own A record is left (${label}) is finished by its retry, by claim and by /heal: live`, async () => {
        for (const retry of ['claim', 'heal']) {
            const w = await world();
            try {
                const key = await makeKey();
                const body = { name: 'direbox', mode: 'direct', public_ip: '198.51.100.20' };
                cut(w);
                await tryCall(() => w.claim(key, body));
                assert.equal((await w.row('direbox')).status, 'pending');
                const [left, ...more] = recordsAt(w, 'direbox');
                assert.deepEqual(more, []);
                assert.equal(left.type, 'A'); assert.equal(left.content, body.public_ip);
                const r = await w[retry](key, body);
                assert.equal(r.status, 200, `${retry}: ${JSON.stringify(r.body)}`);
                assert.equal(r.body.status, 'live');
                assert.equal((await w.row('direbox')).dns_record_id, left.id, 'its own record adopted');
                assert.deepEqual(recordsAt(w, 'direbox'), [left], 'no second record');
            } finally { w.restore(); }
        }
    });
}

test('a pending direct claim retried after a hand A record at ANOTHER IP appeared is refused (409); the record is untouched', async () => {
    const w = await world();
    try {
        const key = await makeKey();
        const body = { name: 'direhand', mode: 'direct', public_ip: '198.51.100.22' };
        w.cf.fail.postDns = true;
        assert.equal((await w.claim(key, body)).status, 502);
        w.cf.fail.postDns = false;
        const before = handRecord(w, 'direhand.beanpool.org');   // 203.0.113.7: not the row's public_ip
        for (const retry of ['claim', 'heal']) {
            const r = await w[retry](key, body);
            assert.equal(r.status, 409, `${retry}: ${JSON.stringify(r.body)}`);
        }
        assert.deepEqual(w.cf.dns.get(before.id), before);
        assert.equal((await w.row('direhand')).status, 'pending');
    } finally { w.restore(); }
});

// NB-2: the admin's approve is a pending tenure's first ensure() too; what an earlier approve of it made is its own.
test('an approve that died after Cloudflare made the CNAME is finished by a later approve: live, its own record kept', async () => {
    const w = await world();
    try {
        const key = await makeKey();
        assert.equal((await w.claim(key, { name: 'sydney' })).body.status, 'pending');   // gated
        dieAfterDnsPost(w);
        await tryCall(() => w.admin('sydney', 'approve'));
        assert.equal((await w.row('sydney')).status, 'pending');
        const [left, ...more] = recordsAt(w, 'sydney');
        assert.deepEqual(more, []);
        const again = await w.admin('sydney', 'approve');
        assert.equal(again.status, 503, `its tunnel may still be a request in flight: ${JSON.stringify(again.body)}`);
        await age(w, 'sydney', 660);
        const later = await w.admin('sydney', 'approve');
        assert.equal(later.status, 200, JSON.stringify(later.body));
        assert.equal(later.body.status, 'live');
        const row = await w.row('sydney');
        assert.equal(row.dns_record_id, left.id, 'its own record adopted');
        assert.equal(routing(w, 'sydney').dns, `${row.tunnel_id}.cfargotunnel.com`);
        assert.equal((await w.heal(key, { name: 'sydney' })).body.status, 'live', 'and its owner heals it');
    } finally { w.restore(); }
});

// NB-4: Cloudflare pages its tunnel list. The pending check asks for the most one page holds, and an answer that is
// still one page of several is "can't tell" (502, retried), never "not the claim's".
async function pendingWithPastTunnels(w, key, n) {
    w.cf.fail.ingress = true;
    assert.equal((await w.claim(key, { name: 'halfway' })).status, 502);
    w.cf.fail.ingress = false;
    const since = (await w.row('halfway')).requested_at - 700;
    await w.backdate('halfway', { requested_at: since });
    // Earlier tenures' tunnels, all deleted (every rotate, re-made heal and take-back leaves one), listed first.
    for (let i = 0; i < n; i++) w.cf.tunnels.set(`tun-old-${i}`, { id: `tun-old-${i}`, name: 'bp-halfway', created_at: new Date((since - 86400 * (i + 2)) * 1000).toISOString(), deleted_at: new Date((since - 86400) * 1000).toISOString() });
    // This tenure's own, made after the claim and since deleted, with its CNAME left (Cloudflare made it, answered an error).
    w.cf.tunnels.set('tun-left', { id: 'tun-left', name: 'bp-halfway', created_at: new Date((since + 5) * 1000).toISOString(), deleted_at: new Date().toISOString() });
    const rec = { id: 'dns-left', type: 'CNAME', name: 'halfway.beanpool.org', content: 'tun-left.cfargotunnel.com', proxied: true };
    w.cf.dns.set(rec.id, { ...rec });
    return rec;
}

test('a pending claim\'s own CNAME, its tunnel listed after 25 earlier tunnels of the name, is finished by its retry: live', async () => {
    const w = await world();
    try {
        const key = await makeKey();
        const rec = await pendingWithPastTunnels(w, key, 25);
        const r = await w.claim(key, { name: 'halfway' });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.status, 'live');
        assert.equal((await w.row('halfway')).dns_record_id, rec.id, 'its own record adopted');
    } finally { w.restore(); }
});

test('a pending claim\'s retry whose tunnel list is one page of several answers 502 (retried), changing nothing', async () => {
    const w = await world();
    try {
        const key = await makeKey();
        const rec = await pendingWithPastTunnels(w, key, 2);
        w.cf.paging.max = 2;   // more of the name's tunnels than one answer holds
        const pending = await w.row('halfway');
        w.cf.calls.length = 0;
        for (const retry of ['claim', 'heal']) {
            const r = await w[retry](key, { name: 'halfway' });
            assert.equal(r.status, 502, `${retry}: ${JSON.stringify(r.body)}`);
            assert.equal(r.body.error, 'provisioning failed');
        }
        assert.deepEqual(w.cf.dns.get(rec.id), rec);
        assert.deepEqual(writes(w), []);
        assert.deepEqual(await w.row('halfway'), pending, 'still pending for its key');
        assert.ok(!w.events('halfway').some((e) => e.event === 'claim-refused'), 'not refused: can\'t tell');
    } finally { w.restore(); }
});

// A count Cloudflare reports differently from its list must never be "can't tell" for good: only total_pages, or a
// full page that doesn't say it is the only one, means more pages.
for (const [label, reshape] of [
    ['no result_info', () => undefined],
    ['a total_count larger than the list (counted differently), one page', (i) => ({ ...i, total_count: i.total_count + 40 })],
    ['result_info without total_count or total_pages', (i) => ({ page: i.page, per_page: i.per_page, count: i.count })],
]) {
    test(`a pending claim's retry whose tunnel list has ${label} is finished: live, never a 502 loop`, async () => {
        const w = await world();
        try {
            const key = await makeKey();
            const rec = await pendingWithPastTunnels(w, key, 2);
            w.cf.paging.info = reshape;
            const r = await w.claim(key, { name: 'halfway' });
            assert.equal(r.status, 200, JSON.stringify(r.body));
            assert.equal(r.body.status, 'live');
            assert.equal((await w.row('halfway')).dns_record_id, rec.id, 'its own record adopted');
        } finally { w.restore(); }
    });
}

test('a pending claim\'s retry whose tunnel list is a full page that doesn\'t say it is the only one answers 502 (retried)', async () => {
    const w = await world();
    try {
        const key = await makeKey();
        await pendingWithPastTunnels(w, key, 2);
        w.cf.paging.max = 3;   // the name's 3 tunnels fill the page exactly
        w.cf.paging.info = (i) => ({ page: i.page, per_page: i.per_page, count: i.count });
        const r = await w.claim(key, { name: 'halfway' });
        assert.equal(r.status, 502, JSON.stringify(r.body));
        assert.ok(!w.events('halfway').some((e) => e.event === 'claim-refused'), 'not refused: can\'t tell');
    } finally { w.restore(); }
});

// NB-6: /rotate on a pending row runs its heal, which refuses what the registrar did not make. Refused, it rotated
// nothing: no `rotated` in the trail, and the name's one rotate per 5 minutes is not used up.
test('a refused /rotate on a pending row logs no rotate and leaves the name its rotate', async () => {
    const w = await world();
    try {
        const key = await makeKey();
        w.cf.fail.ingress = true;
        assert.equal((await w.claim(key, { name: 'rotbox' })).status, 502);
        w.cf.fail.ingress = false;
        const before = handRecord(w, 'rotbox.beanpool.org');
        const r = await w.rotate(key, { name: 'rotbox' });
        assert.equal(r.status, 409, JSON.stringify(r.body));
        assert.equal(r.body.error, 'name in use outside the registrar');
        assert.deepEqual(w.cf.dns.get(before.id), before);
        assert.ok(!w.events('rotbox').some((e) => e.event === 'rotated'), JSON.stringify(w.events('rotbox')));
        // The hand record goes (it was a mistake); the owner's rotate at once is not held back.
        w.cf.dns.delete(before.id);
        const again = await w.rotate(key, { name: 'rotbox' });
        assert.equal(again.status, 200, JSON.stringify(again.body));
        assert.equal(again.body.status, 'live');
        assert.equal(again.body.rotated, true);
    } finally { w.restore(); }
});

// NB-5: the restore runbook says what a restore undoes and how to find it, and the bookmark step it relies on is in
// this README, not only in a rehearsal note.
test('README: a D1 restore reverts every row changed since; the diff finds them; Deploy takes the bookmark', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replace(/[ \t]*\n[ \t]*(?![#\n])/g, ' ');   // lines unwrapped
    const section = (heading, next) => { const i = readme.indexOf(heading); assert.ok(i >= 0, heading); const j = readme.indexOf(next, i + heading.length); return readme.slice(i, j < 0 ? undefined : j); };
    const restore = section('### Hand records, and restoring D1', '\n#');
    assert.match(restore, /every row changed since the restore point reverts/);
    assert.doesNotMatch(restore, /created or claimed since the restore point is gone/);
    assert.match(restore, /compare-registrar-dbs\.mjs rows /);
    const deploy = section('\n## Deploy', '\n## ');
    assert.match(deploy, /npx wrangler d1 time-travel info beanpool-registrar/, 'the bookmark is taken before a run that migrates');
    assert.match(deploy, /npx wrangler d1 time-travel restore beanpool-registrar --bookmark=/);
});
