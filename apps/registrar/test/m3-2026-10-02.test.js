// M3 of the registrar review of 2026-10-01 (scratch/reviews/FABLE-sec-registrar.md): a swapped origin behind a live name
// was counted, never acted on. Design D2 (decided 2026-09-24: b): a name that answers its attest with a 2xx that is no
// attest at all, in 12 applied sweeps in a row (about an hour), is paused for its key, and its owner's heal resumes it.
// A run that is open asks the name again, so a second connector on a leaked tunnel token can't hide behind the owner's
// own answer. And the holder can rotate: its name onto a fresh tunnel, the old one (and every copy of its token) dead.
//
// The same world as ownership-states.test.js (test/harness.js): the Worker against an in-memory SQLite loaded with the
// migrations, and a fake Cloudflare. No network.

import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { attestSweep } from '../src/index.js';
import { nowS, toHex, world, liveName, makeKey, attestsAs, routing } from './harness.js';

const sign = async (key, message) => toHex(await crypto.subtle.sign('Ed25519', key.keyPair.privateKey, new TextEncoder().encode(message)));
const send = async (w, req) => { const res = await worker.fetch(req, w.env); return { status: res.status, body: await res.json() }; };
// A v1 request, as today's nodes sign it (registrar-client.ts).
async function signed(method, path, key, body) {
    const ts = String(nowS());
    const text = body === undefined ? '' : JSON.stringify(body);
    return new Request(`https://beanpool.org${path}`, {
        method, body: text || undefined,
        headers: {
            'content-type': 'application/json', 'x-bp-pubkey': key.pubHex, 'x-bp-timestamp': ts,
            'x-bp-signature': await sign(key, `beanpool-registrar-request/v1\n${method}\n${path}\n${ts}\n${text}`),
        },
    });
}
const rotate = async (w, key, body = {}) => send(w, await signed('POST', '/api/registrar/rotate', key, body));

// What a stranger's server answers at every path: its own page, 200.
const page = () => async () => new Response('<!doctype html><title>Welcome</title><p>This domain is parked.</p>', { status: 200, headers: { 'content-type': 'text/html' } });
// Answers that alternate, call by call, between two answerers: two connectors on one tunnel.
function alternating(first, second) {
    let n = 0;
    return async (nonce) => ((n++ % 2) ? second : first)(nonce);
}
// The answerer, with a count of how many times it was asked.
function counted(answer) {
    const f = async (nonce) => { f.calls++; return answer(nonce); };
    f.calls = 0;
    return f;
}
async function sweeps(w, n) {
    let s;
    for (let i = 0; i < n; i++) s = await attestSweep(w.env);
    return s;
}
const liveTunnels = (w, name) => routing(w, name).tunnels;
// A name's rotates as if they were made `s` seconds earlier: one rotate per ROTATE_EVERY_S (5 minutes) per name.
const ageRotates = (w, s = 600) => w.sqlite.prepare("UPDATE name_events SET at = at - ? WHERE event = 'rotated'").run(s);

// ── D2: a content swap is paused, after an hour of it ──────────────────────────────────────────────────────────────

test('D2: a name answering a 2xx that is no attest in 12 applied sweeps in a row is paused for its key — not before; its owner\'s heal resumes it on a fresh tunnel', async () => {
    const w = await world();
    try {
        const [owner, n1, n2, other] = await Promise.all([makeKey(), makeKey(), makeKey(), makeKey()]);
        await liveName(w, 'parked', owner);
        await liveName(w, 'alpha', n1); await liveName(w, 'bravo', n2);
        const before = await w.row('parked');
        w.nodes['parked.beanpool.org'] = page();

        for (let i = 1; i <= 11; i++) {
            const s = await attestSweep(w.env);
            assert.equal(s.action, 'applied', `sweep ${i}`);
            assert.equal(s.content_swap, 1, `sweep ${i}`);
        }
        let row = await w.row('parked');
        assert.equal(row.status, 'live', '11 sweeps (55 minutes) of it: still live');
        assert.equal(row.swap_fails, 11);
        assert.ok(w.cf.liveTunnel(before.tunnel_id));

        await attestSweep(w.env);
        row = await w.row('parked');
        assert.equal(row.status, 'paused', 'the 12th: paused');
        assert.equal(row.pause_reason, 'content-swap');
        assert.equal(row.node_pubkey, owner.pubHex, 'the name stays its key\'s');
        assert.equal(w.cf.liveTunnel(before.tunnel_id), null, 'the tunnel goes: a connector on a copy of its token dies with it');
        assert.equal(w.cf.recordAt('parked.beanpool.org'), null, 'routing is off');
        assert.ok(w.events('parked').some((e) => e.event === 'paused' && /no attest|content swap/i.test(e.detail || '')), JSON.stringify(w.events('parked')));
        assert.equal((await w.row('alpha')).status, 'live');
        assert.equal((await w.row('bravo')).status, 'live');

        // Held for its key: nobody else may have it.
        assert.equal((await w.available('parked')).body.available, false);
        assert.equal((await w.claim(other, { name: 'parked' })).status, 409);
        assert.deepEqual((await w.holder(other, { name: 'parked' })).body, { name: 'parked', held: 'other', holder_key: owner.pubHex });
        assert.equal((await w.holder(owner, { name: 'parked' })).body.held, 'you');
        const st = await w.status(owner);
        assert.equal(st.body.status, 'paused');
        assert.equal(st.body.reason, 'content-swap');
        assert.equal(st.body.tunnelToken, undefined);

        // Paused names aren't swept: more sweeps change nothing.
        await sweeps(w, 3);
        assert.equal((await w.row('parked')).status, 'paused');

        // The owner's node heals: a fresh tunnel whose token only its signed request gets, live at once.
        w.nodes['parked.beanpool.org'] = attestsAs(owner);
        const healed = await w.heal(owner, { name: 'parked' });
        assert.equal(healed.status, 200, JSON.stringify(healed.body));
        assert.equal(healed.body.status, 'live');
        row = await w.row('parked');
        assert.notEqual(row.tunnel_id, before.tunnel_id);
        assert.equal(healed.body.tunnelToken, `token-${row.tunnel_id}`);
        assert.equal(row.swap_fails, 0, 'live again: the run starts from nothing');
        assert.equal(w.cf.recordAt('parked.beanpool.org').content, `${row.tunnel_id}.cfargotunnel.com`);

        // One sweep of a page again is one, not thirteen.
        w.nodes['parked.beanpool.org'] = page();
        await attestSweep(w.env);
        row = await w.row('parked');
        assert.equal(row.status, 'live');
        assert.equal(row.swap_fails, 1);
    } finally { w.restore(); }
});

test('D2: the run must be unbroken — an answer from nothing, or the owner\'s own key (asked three times), ends it; a suspended sweep neither counts nor ends it', async () => {
    const w = await world();
    try {
        const [owner, n1, n2] = await Promise.all([makeKey(), makeKey(), makeKey()]);
        await liveName(w, 'parked', owner);
        await liveName(w, 'alpha', n1); await liveName(w, 'bravo', n2);
        const alpha = counted(attestsAs(n1));
        w.nodes['alpha.beanpool.org'] = alpha;
        w.nodes['parked.beanpool.org'] = page();

        await sweeps(w, 11);
        assert.equal((await w.row('parked')).swap_fails, 11);
        // Nothing answers (its server off, a network fault): no evidence either way, and the run is over.
        delete w.nodes['parked.beanpool.org'];
        await attestSweep(w.env);
        assert.equal((await w.row('parked')).swap_fails, 0, 'an answer from nothing ends the run');
        w.nodes['parked.beanpool.org'] = page();
        await sweeps(w, 11);
        let row = await w.row('parked');
        assert.equal(row.status, 'live');
        assert.equal(row.swap_fails, 11);

        // The owner's node answers: while a run is open it is asked three times, and three of its own answers end it.
        const own = counted(attestsAs(owner));
        w.nodes['parked.beanpool.org'] = own;
        await attestSweep(w.env);
        assert.equal(own.calls, 3, 'a name with an open run is asked again');
        row = await w.row('parked');
        assert.equal(row.swap_fails, 0, 'its own key, three times: the run is over');
        assert.equal(row.status, 'live');
        const asked = alpha.calls;
        await attestSweep(w.env);
        assert.equal(own.calls, 4, 'no run open: asked once');
        assert.equal(alpha.calls, asked + 1, 'a name with no run open is asked once');

        // A sweep that judges itself wrong (the canary not ok) changes nothing: the run neither grows nor ends.
        w.nodes['parked.beanpool.org'] = page();
        await sweeps(w, 5);
        assert.equal((await w.row('parked')).swap_fails, 5);
        w.env.CANARY_NAME = 'alpha';
        w.nodes['alpha.beanpool.org'] = async () => new Response('Bad Gateway', { status: 502 });
        const s = await sweeps(w, 20);
        assert.equal(s.action, 'suspended:canary');
        row = await w.row('parked');
        assert.equal(row.swap_fails, 5, 'twenty suspended sweeps: no count');
        assert.equal(row.status, 'live');
        w.nodes['alpha.beanpool.org'] = attestsAs(n1);
        await sweeps(w, 6);
        assert.equal((await w.row('parked')).status, 'live', '11 counted in all');
        await attestSweep(w.env);
        row = await w.row('parked');
        assert.equal(row.status, 'paused', 'the 12th counted sweep pauses it');
        assert.equal(row.pause_reason, 'content-swap');
    } finally { w.restore(); }
});

test('D2: the mass breaker counts content swaps — many names swapped at once is the registrar\'s fault, and acts on none', async () => {
    const w = await world();
    try {
        const keys = await Promise.all(Array.from({ length: 11 }, makeKey));
        const names = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9'].map((n) => `node-${n}`);
        for (let i = 0; i < names.length; i++) await liveName(w, names[i], keys[i]);
        w.nodes['node-n0.beanpool.org'] = page();
        w.nodes['node-n1.beanpool.org'] = page();
        w.nodes['node-n2.beanpool.org'] = attestsAs(keys[10]);   // another key
        const s = await attestSweep(w.env);
        assert.equal(s.content_swap, 2);
        assert.equal(s.impostor, 1);
        assert.equal(s.action, 'suspended:mass', 'three foreign answers among ten names is more than max(2, 10%)');
        for (const n of names) {
            const row = await w.row(n);
            assert.equal(row.status, 'live', n);
            assert.ok(!row.swap_fails && !row.attest_fails, `${n}: nothing counted (${row.swap_fails}, ${row.attest_fails})`);
        }
        // Two at once is still believable: counted.
        w.nodes['node-n2.beanpool.org'] = attestsAs(keys[2]);
        assert.equal((await attestSweep(w.env)).action, 'applied');
        assert.equal((await w.row('node-n0')).swap_fails, 1);
    } finally { w.restore(); }
});

// ── M3 (b): a second connector on a leaked tunnel token ────────────────────────────────────────────────────────────

test('M3b: another key answering at the name every other time (a second connector on a copy of the token) is paused — the owner\'s answer no longer hides it', async () => {
    const w = await world();
    try {
        const [owner, intruder, n1, n2] = await Promise.all([makeKey(), makeKey(), makeKey(), makeKey()]);
        await liveName(w, 'leaky', owner);
        await liveName(w, 'alpha', n1); await liveName(w, 'bravo', n2);
        const tunnel = (await w.row('leaky')).tunnel_id;
        w.nodes['leaky.beanpool.org'] = alternating(attestsAs(owner), attestsAs(intruder));
        let paused = false;
        for (let i = 0; i < 4 && !paused; i++) {
            await attestSweep(w.env);
            paused = (await w.row('leaky')).status === 'paused';
        }
        const row = await w.row('leaky');
        assert.equal(row.status, 'paused', 'paused within four sweeps');
        assert.equal(row.pause_reason, 'impostor');
        assert.equal(row.node_pubkey, owner.pubHex);
        assert.equal(w.cf.liveTunnel(tunnel), null, 'the tunnel both connectors rode is gone');

        // The owner's heal: a fresh tunnel, whose token only it gets.
        w.nodes['leaky.beanpool.org'] = attestsAs(owner);
        const healed = await w.heal(owner, { name: 'leaky' });
        assert.equal(healed.body.status, 'live');
        assert.equal(healed.body.tunnelToken, `token-${(await w.row('leaky')).tunnel_id}`);
    } finally { w.restore(); }
});

test('M3b: a page answering at the name every other time is paused as a content swap after 12 sweeps of it', async () => {
    const w = await world();
    try {
        const [owner, n1, n2] = await Promise.all([makeKey(), makeKey(), makeKey()]);
        await liveName(w, 'leaky', owner);
        await liveName(w, 'alpha', n1); await liveName(w, 'bravo', n2);
        w.nodes['leaky.beanpool.org'] = alternating(attestsAs(owner), page());
        // Sweep 1 asks once (no run open: the owner's answer); from sweep 2 every sweep sees the page.
        await sweeps(w, 12);
        let row = await w.row('leaky');
        assert.equal(row.status, 'live');
        assert.equal(row.swap_fails, 11);
        await attestSweep(w.env);
        row = await w.row('leaky');
        assert.equal(row.status, 'paused');
        assert.equal(row.pause_reason, 'content-swap');
    } finally { w.restore(); }
});

// ── M3 (a): a direct name's IP address passed to a stranger ────────────────────────────────────────────────────────

test('M3a: a direct name whose address now serves a stranger\'s site is paused; its owner\'s heal from the old address stays paused, from its new one goes live', async () => {
    const w = await world();
    try {
        const [owner, n1, n2] = await Promise.all([makeKey(), makeKey(), makeKey()]);
        const claimed = await w.claim(owner, { name: 'homebox', mode: 'direct', public_ip: '203.0.113.7' });
        assert.equal(claimed.body.status, 'live', JSON.stringify(claimed.body));
        await liveName(w, 'alpha', n1); await liveName(w, 'bravo', n2);
        // The community moved; its old address went to someone else, whose server answers every path with its page.
        w.nodes['homebox.beanpool.org'] = page();
        await sweeps(w, 12);
        let row = await w.row('homebox');
        assert.equal(row.status, 'paused');
        assert.equal(row.pause_reason, 'content-swap');
        assert.equal(w.cf.recordAt('homebox.beanpool.org'), null, 'beanpool.org no longer sends members there');

        // A heal from the same address: the stranger still answers there, so the name stays paused (and the record off).
        const same = await w.heal(owner, { name: 'homebox' });
        assert.equal(same.status, 200, JSON.stringify(same.body));
        assert.equal(same.body.status, 'paused');
        assert.equal(w.cf.recordAt('homebox.beanpool.org'), null);
        assert.equal((await w.row('homebox')).node_pubkey, owner.pubHex);

        // From its new address, where its own node answers: live.
        w.nodes['homebox.beanpool.org'] = attestsAs(owner);
        const moved = await w.heal(owner, { name: 'homebox', public_ip: '198.51.100.20' });
        assert.equal(moved.body.status, 'live', JSON.stringify(moved.body));
        assert.equal(moved.body.attest, 'ok');
        row = await w.row('homebox');
        assert.equal(row.public_ip, '198.51.100.20');
        assert.equal(w.cf.recordAt('homebox.beanpool.org').content, '198.51.100.20');
        assert.equal(row.swap_fails, 0);
    } finally { w.restore(); }
});

// ── Rotate: the holder moves its name onto a fresh tunnel ──────────────────────────────────────────────────────────

test('rotate: the owner moves its live name onto a fresh tunnel — a new token, the old tunnel and every copy of its token dead, the record re-pointed (never removed)', async () => {
    const w = await world();
    try {
        const owner = await makeKey();
        await liveName(w, 'riverbend', owner);
        const before = await w.row('riverbend');
        const oldToken = `token-${before.tunnel_id}`;
        const calls = w.cf.calls.length;

        const r = await rotate(w, owner, { name: 'riverbend' });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.status, 'live');
        const row = await w.row('riverbend');
        assert.notEqual(row.tunnel_id, before.tunnel_id);
        assert.equal(r.body.tunnelToken, `token-${row.tunnel_id}`, 'the owner gets the new tunnel\'s token');
        assert.notEqual(r.body.tunnelToken, oldToken);
        assert.equal(w.cf.liveTunnel(before.tunnel_id), null, 'the old tunnel is deleted: nothing runs on a copy of its token');
        assert.deepEqual(liveTunnels(w, 'riverbend'), [row.tunnel_id], 'one tunnel for the name');
        assert.equal(row.dns_record_id, before.dns_record_id, 'the same record');
        assert.equal(w.cf.recordAt('riverbend.beanpool.org').content, `${row.tunnel_id}.cfargotunnel.com`, 're-pointed at the new tunnel');
        assert.ok(!w.cf.calls.slice(calls).some((c) => c.startsWith('DELETE /zones/')), 'the record is never deleted (members\' resolvers would remember its absence)');
        const deleted = w.cf.calls.slice(calls).indexOf(`DELETE /accounts/acct/cfd_tunnel/${before.tunnel_id}`);
        const made = w.cf.calls.slice(calls).indexOf('POST /accounts/acct/cfd_tunnel');
        assert.ok(deleted >= 0 && made > deleted, `the old tunnel goes before the new one is made (Cloudflare refuses two of one name): ${deleted}, ${made}`);
        assert.equal(row.status, 'live');
        assert.ok(row.decision_seq > (before.decision_seq ?? 0), 'a decision: a request that read the row before it misses its write');
        assert.ok(w.events('riverbend').some((e) => e.event === 'rotated'), JSON.stringify(w.events('riverbend')));
        assert.equal((await w.status(owner)).body.tunnelToken, r.body.tunnelToken, '/status hands out the new token');

        // With an origin: the new tunnel leads there.
        ageRotates(w);
        const r2 = await rotate(w, owner, { name: 'riverbend', origin: 'http://127.0.0.1:9090' });
        assert.equal(r2.body.status, 'live', JSON.stringify(r2.body));
        const row2 = await w.row('riverbend');
        assert.equal(row2.origin, 'http://127.0.0.1:9090');
        assert.equal(w.cf.tunnels.get(row2.tunnel_id).ingress[0].service, 'http://127.0.0.1:9090');
        assert.equal(w.cf.liveTunnel(row.tunnel_id), null);

        // Without a name: the key's own.
        ageRotates(w);
        const r3 = await rotate(w, owner);
        assert.equal(r3.body.status, 'live', JSON.stringify(r3.body));
        assert.notEqual((await w.row('riverbend')).tunnel_id, row2.tunnel_id);
    } finally { w.restore(); }
});

test('rotate: only the name\'s own key, and only a name it may route — refused names change nothing', async () => {
    const w = await world();
    try {
        const [owner, other, k2, k3, k4, k5, k6] = await Promise.all(Array.from({ length: 7 }, makeKey));
        await liveName(w, 'riverbend', owner);
        const unchanged = async (name, r, status, why) => {
            const before = await w.row(name);
            const calls = w.cf.calls.length;
            const res = await r();
            assert.equal(res.status, status, `${why}: ${JSON.stringify(res.body)}`);
            assert.equal(res.body.tunnelToken, undefined, why);
            const after = await w.row(name);
            assert.deepEqual({ ...after, last_contact_at: null, proto: null }, { ...before, last_contact_at: null, proto: null }, `${why}: the row is as it was`);
            assert.deepEqual(w.cf.calls.slice(calls), [], `${why}: nothing at Cloudflare`);
        };
        await unchanged('riverbend', () => rotate(w, other, { name: 'riverbend' }), 404, 'another key');
        const forged = await signed('POST', '/api/registrar/rotate', owner, { name: 'riverbend' });
        forged.headers.set('x-bp-pubkey', other.pubHex);
        await unchanged('riverbend', () => send(w, forged), 401, 'a signature that is not the key\'s');

        await liveName(w, 'held', k2);
        assert.equal((await w.admin('held', 'pause')).status, 200);
        await unchanged('held', () => rotate(w, k2, { name: 'held' }), 403, 'paused by the admin');

        await liveName(w, 'stopped', k3);
        assert.equal((await w.admin('stopped', 'block')).status, 200);
        await unchanged('stopped', () => rotate(w, k3, { name: 'stopped' }), 403, 'blocked');

        await liveName(w, 'letgo', k4);
        assert.equal((await w.release(k4, { name: 'letgo' })).status, 200);
        await unchanged('letgo', () => rotate(w, k4, { name: 'letgo' }), 409, 'released (a take-back runs on a fresh tunnel anyway)');

        w.sqlite.prepare("INSERT OR REPLACE INTO name_policy (pattern, tier) VALUES ('waitlist', 'gated')").run();
        assert.equal((await w.claim(k5, { name: 'waitlist' })).body.status, 'pending');
        await unchanged('waitlist', () => rotate(w, k5, { name: 'waitlist' }), 409, 'awaiting approval');

        assert.equal((await w.claim(k6, { name: 'homebox', mode: 'direct', public_ip: '203.0.113.7' })).body.status, 'live');
        await unchanged('homebox', () => rotate(w, k6, { name: 'homebox' }), 400, 'a direct name runs no tunnel');

        assert.equal((await rotate(w, other, { name: 'nowhere' })).status, 404, 'no such name');
        assert.equal((await rotate(w, owner, { name: 'riverbend', origin: 'ftp://example.com' })).status, 400, 'a bad origin');
    } finally { w.restore(); }
});

test('rotate: one per name every 5 minutes — a second one sooner is a 429 and changes nothing; a heal is never held back', async () => {
    const w = await world();
    try {
        const owner = await makeKey();
        await liveName(w, 'riverbend', owner);
        assert.equal((await rotate(w, owner, { name: 'riverbend' })).status, 200);
        const row = await w.row('riverbend');
        const calls = w.cf.calls.length;
        const again = await rotate(w, owner, { name: 'riverbend' });
        assert.equal(again.status, 429, JSON.stringify(again.body));
        assert.ok(again.body.retry_after > 0 && again.body.retry_after <= 300, JSON.stringify(again.body));
        assert.equal(again.body.tunnelToken, undefined);
        assert.deepEqual(await w.row('riverbend'), { ...row, last_contact_at: (await w.row('riverbend')).last_contact_at }, 'the row is as it was');
        assert.deepEqual(w.cf.calls.slice(calls), [], 'nothing at Cloudflare');
        assert.equal((await w.heal(owner, { name: 'riverbend' })).body.status, 'live', 'its heal is not held back');
        ageRotates(w, 301);
        assert.equal((await rotate(w, owner, { name: 'riverbend' })).status, 200, 'five minutes on, it rotates again');
    } finally { w.restore(); }
});

test('rotate: a name the sweep paused comes back on a fresh tunnel, as its heal would', async () => {
    const w = await world();
    try {
        const [owner, intruder, n1, n2] = await Promise.all([makeKey(), makeKey(), makeKey(), makeKey()]);
        await liveName(w, 'swapped', owner);
        await liveName(w, 'alpha', n1); await liveName(w, 'bravo', n2);
        w.nodes['swapped.beanpool.org'] = attestsAs(intruder);
        await sweeps(w, 2);
        assert.equal((await w.row('swapped')).status, 'paused');
        w.nodes['swapped.beanpool.org'] = attestsAs(owner);
        const r = await rotate(w, owner, { name: 'swapped' });
        assert.equal(r.body.status, 'live', JSON.stringify(r.body));
        const row = await w.row('swapped');
        assert.equal(r.body.tunnelToken, `token-${row.tunnel_id}`);
        assert.equal(w.cf.recordAt('swapped.beanpool.org').content, `${row.tunnel_id}.cfargotunnel.com`);
    } finally { w.restore(); }
});

test('rotate: Cloudflare refusing to delete the old tunnel changes nothing (503); failing to make the new one leaves the old one dead, and the owner\'s heal makes it', async () => {
    const w = await world();
    try {
        const owner = await makeKey();
        await liveName(w, 'riverbend', owner);
        const before = await w.row('riverbend');

        w.cf.fail.deleteTunnel = true;
        const refused = await rotate(w, owner, { name: 'riverbend' });
        w.cf.fail.deleteTunnel = false;
        assert.equal(refused.status, 503, JSON.stringify(refused.body));
        assert.equal(refused.body.tunnelToken, undefined);
        let row = await w.row('riverbend');
        assert.equal(row.status, 'live');
        assert.equal(row.tunnel_id, before.tunnel_id, 'the old tunnel is still the row\'s: nothing changed');
        assert.ok(w.cf.liveTunnel(before.tunnel_id));
        assert.deepEqual(liveTunnels(w, 'riverbend'), [before.tunnel_id], 'no second tunnel');
        assert.equal(w.cf.recordAt('riverbend.beanpool.org').content, `${before.tunnel_id}.cfargotunnel.com`);
        assert.equal((await w.status(owner)).body.tunnelToken, `token-${before.tunnel_id}`, 'the node keeps working on its token');

        // The old one goes; Cloudflare then fails the new one's ingress.
        w.cf.fail.ingress = true;
        const failed = await rotate(w, owner, { name: 'riverbend' });
        w.cf.fail.ingress = false;
        assert.equal(failed.status, 502, JSON.stringify(failed.body));
        assert.equal(w.cf.liveTunnel(before.tunnel_id), null, 'the old token is dead all the same');
        assert.deepEqual(liveTunnels(w, 'riverbend'), [], 'and the half-made new tunnel was removed');
        row = await w.row('riverbend');
        assert.equal(row.node_pubkey, owner.pubHex);
        // The owner's heal (its node's next tick) makes the tunnel.
        const healed = await w.heal(owner, { name: 'riverbend' });
        assert.equal(healed.body.status, 'live', JSON.stringify(healed.body));
        row = await w.row('riverbend');
        assert.equal(healed.body.tunnelToken, `token-${row.tunnel_id}`);
        assert.equal(w.cf.recordAt('riverbend.beanpool.org').content, `${row.tunnel_id}.cfargotunnel.com`);
    } finally { w.restore(); }
});

test('race: the admin\'s pause landing while a rotate deletes the old tunnel stands — paused, nothing routed, no tunnel left', async () => {
    const w = await world();
    try {
        const owner = await makeKey();
        await liveName(w, 'riverbend', owner);
        let paused;
        w.cf.during(/^DELETE \/accounts\/acct\/cfd_tunnel\//, async () => { paused = await w.admin('riverbend', 'pause'); });
        const r = await rotate(w, owner, { name: 'riverbend' });
        assert.equal(paused?.status, 200, JSON.stringify(paused?.body));
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.status, 'paused');
        assert.equal(r.body.tunnelToken, undefined);
        const row = await w.row('riverbend');
        assert.equal(row.status, 'paused');
        assert.equal(row.pause_reason, 'admin');
        assert.equal(w.cf.recordAt('riverbend.beanpool.org'), null, 'not routed');
        assert.deepEqual(liveTunnels(w, 'riverbend'), [], 'no tunnel left alive for it');
    } finally { w.restore(); }
});
