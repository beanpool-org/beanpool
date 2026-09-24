// Ownership states (design scratch/registrar/DESIGN-2026-09-24-fable.md §2.1, §2.2, §2.5, §6.1; decisions §11):
// a name belongs to the node key that claimed it. The registrar may stop routing it, but only its owner's release
// (after a 30-day hold for that key), the admin's release, or abandonment ever lets another key have it.
//
// Runs the Worker against a real in-memory SQLite loaded with the migrations, and a stateful fake of the
// Cloudflare API (tunnels + DNS records, with Cloudflare's collision errors), so what is asserted is what the
// Worker leaves behind at Cloudflare, not only which calls it made. No network.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';
import worker, { attestSweep } from '../src/index.js';
import * as db from '../src/db.js';

const nowS = () => Math.floor(Date.now() / 1000);
const toHex = (buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
const migration = (m) => readFileSync(new URL(`../migrations/${m}`, import.meta.url), 'utf8');
const DAY = 86400;
const COOLOFF = 30 * DAY;

// D1's prepare/bind/first/all/run over node:sqlite (run() reports meta.changes, as D1 does).
function sqliteD1(migrations = ['0001_init.sql', '0002_states.sql']) {
    const sqlite = new DatabaseSync(':memory:');
    for (const m of migrations) sqlite.exec(migration(m));
    const d1 = {
        prepare(sql) {
            const stmt = sqlite.prepare(sql);
            let args = [];
            return {
                bind(...a) { args = a; return this; },
                async first() { const r = stmt.get(...args); return r ? { ...r } : null; },
                async all() { return { results: stmt.all(...args).map((r) => ({ ...r })) }; },
                async run() { const r = stmt.run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
            };
        },
    };
    const all = (sql, ...a) => sqlite.prepare(sql).all(...a).map((r) => ({ ...r }));
    return { sqlite, d1, all };
}

// Cloudflare as far as the registrar uses it. A duplicate live tunnel name and a second record at a hostname are
// refused, as Cloudflare refuses them — so a POST-collision or a second tunnel shows up as a failure here.
function fakeCloudflare() {
    const calls = [];
    const tunnels = new Map();   // id → { id, name, deleted_at, ingress }
    const dns = new Map();       // id → { id, type, name (fqdn), content, proxied }
    const fail = { deleteTunnel: false, ingress: false };
    let seq = 0;
    const ok = (result) => Response.json({ success: true, result });
    const err = (status, code, message) => Response.json({ success: false, errors: [{ code, message }] }, { status });
    async function handle(method, url, body) {
        const p = url.pathname.replace('/client/v4', '');
        calls.push(`${method} ${p}`);
        let m;
        if (method === 'POST' && p === '/accounts/acct/cfd_tunnel') {
            if ([...tunnels.values()].some((t) => !t.deleted_at && t.name === body.name)) return err(409, 1013, 'tunnel name already in use');
            const t = { id: `tun-${++seq}`, name: body.name, deleted_at: null };
            tunnels.set(t.id, t);
            return ok(t);
        }
        if ((m = p.match(/^\/accounts\/acct\/cfd_tunnel\/([^/]+)$/))) {
            const t = tunnels.get(m[1]);
            if (method === 'GET') return t ? ok(t) : err(404, 1003, 'tunnel not found');   // a deleted one comes back with deleted_at
            if (method === 'DELETE') {
                if (fail.deleteTunnel) return err(500, 1000, 'internal error');
                if (!t || t.deleted_at) return err(404, 1003, 'tunnel not found');
                t.deleted_at = new Date().toISOString();
                return ok(t);
            }
        }
        if ((m = p.match(/^\/accounts\/acct\/cfd_tunnel\/([^/]+)\/token$/)) && method === 'GET') {
            const t = tunnels.get(m[1]);
            return t && !t.deleted_at ? ok(`token-${t.id}`) : err(404, 1003, 'tunnel not found');
        }
        if ((m = p.match(/^\/accounts\/acct\/cfd_tunnel\/([^/]+)\/configurations$/)) && method === 'PUT') {
            const t = tunnels.get(m[1]);
            if (!t || t.deleted_at) return err(404, 1003, 'tunnel not found');
            if (fail.ingress) return err(500, 1000, 'internal error');
            t.ingress = body.config.ingress;
            return ok({});
        }
        if (p === '/zones/zone/dns_records' && method === 'GET')
            return ok([...dns.values()].filter((r) => r.name === url.searchParams.get('name')));
        if (p === '/zones/zone/dns_records' && method === 'POST') {
            const fqdn = `${body.name}.beanpool.org`;
            if ([...dns.values()].some((r) => r.name === fqdn)) return err(400, 81053, 'An A, AAAA, or CNAME record with that host already exists.');
            const r = { id: `dns-${++seq}`, type: body.type, name: fqdn, content: body.content, proxied: body.proxied };
            dns.set(r.id, r);
            return ok(r);
        }
        if ((m = p.match(/^\/zones\/zone\/dns_records\/([^/]+)$/))) {
            const r = dns.get(m[1]);
            if (!r) return err(404, 81044, 'Record does not exist.');
            if (method === 'PATCH') {
                // A record's type can't be changed in place (CNAME ↔ A): the caller must delete and re-create it.
                if (body.type && body.type !== r.type) return err(400, 1004, 'DNS Validation Error: record type cannot be changed');
                Object.assign(r, body);
                return ok(r);
            }
            if (method === 'DELETE') { dns.delete(m[1]); return ok({ id: m[1] }); }
        }
        throw new Error(`fake cloudflare: unhandled ${method} ${p}`);
    }
    const recordAt = (fqdn) => [...dns.values()].find((r) => r.name === fqdn) || null;
    const liveTunnel = (id) => { const t = tunnels.get(id); return t && !t.deleted_at ? t : null; };
    return { calls, tunnels, dns, fail, handle, recordAt, liveTunnel };
}

async function makeKey() {
    const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    return { keyPair, pubHex: toHex(await crypto.subtle.exportKey('raw', keyPair.publicKey)) };
}
const sign = async (key, message) =>
    toHex(await crypto.subtle.sign('Ed25519', key.keyPair.privateKey, new TextEncoder().encode(message)));

// A node's /api/attest, signed by `key`.
const attestsAs = (key) => async (nonce) => {
    const timestamp = nowS();
    return Response.json({ pubkey: key.pubHex, nonce, timestamp, signature: await sign(key, `beanpool-node-attest/v1\n${nonce}\n${timestamp}`) });
};

// One world per test: D1, fake Cloudflare, and nodes answering at hostnames — but only while Cloudflare routes the
// hostname (a DNS record exists), so an edge attest can only pass once the registrar has routing back up.
async function world({ migrations, env: extra } = {}) {
    const { sqlite, d1, all } = sqliteD1(migrations);
    const cf = fakeCloudflare();
    const nodes = {};
    const env = {
        BASE_DOMAIN: 'beanpool.org', ATTEST_FAIL_LIMIT: '2', ADMIN_SECRET: 'test-admin-secret',
        CF_ACCOUNT_ID: 'acct', CF_ZONE_ID: 'zone', CF_API_TOKEN: 'not-a-token', DB: d1, ...extra,
    };
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        if (url.hostname === 'api.cloudflare.com') return cf.handle(init.method || 'GET', url, init.body ? JSON.parse(init.body) : null);
        if (url.pathname !== '/api/attest' || !nodes[url.hostname]) throw new Error(`test network: no route to ${url}`);
        if (!cf.recordAt(url.hostname)) throw new Error(`test network: ${url.hostname} does not resolve`);
        return nodes[url.hostname](url.searchParams.get('nonce'));
    };

    const signed = async (method, path, key, body) => {
        const ts = String(nowS());
        const text = body === undefined ? '' : JSON.stringify(body);
        return new Request(`https://beanpool.org${path}`, {
            method, body: text || undefined,
            headers: {
                'content-type': 'application/json', 'x-bp-pubkey': key.pubHex, 'x-bp-timestamp': ts,
                'x-bp-signature': await sign(key, `beanpool-registrar-request/v1\n${method}\n${path}\n${ts}\n${text}`),
            },
        });
    };
    const call = async (req) => { const res = await worker.fetch(req, env); return { status: res.status, body: await res.json() }; };
    const w = {
        env, cf, nodes, sqlite,
        restore: () => { globalThis.fetch = original; },
        row: async (name) => db.getAllocation(env, name),
        events: (name) => all('SELECT event, detail FROM name_events WHERE name=? ORDER BY id', name),
        claim: async (key, body) => call(await signed('POST', '/api/registrar/claim', key, { mode: 'tunnel', ...body })),
        heal: async (key, body = {}) => call(await signed('POST', '/api/registrar/heal', key, body)),
        release: async (key, body = {}, path = '/api/registrar/release') => call(await signed('POST', path, key, body)),
        status: async (key) => call(await signed('GET', '/api/registrar/status', key)),
        available: async (name) => call(new Request(`https://beanpool.org/api/registrar/available?name=${name}`)),
        admin: async (name, action) => call(new Request(`https://beanpool.org/api/local/admin/registrar/${name}/${action}`, {
            method: 'POST', headers: { 'x-admin-secret': 'test-admin-secret' },
        })),
        invite: async (code) => (await worker.fetch(new Request(`https://beanpool.org/i/${code}`), env)).status,
        backdate: async (name, fields) => db.updateAllocation(env, name, fields),
    };
    return w;
}

// A name claimed and live, its node answering at it under its own key.
async function liveName(w, name, key) {
    const r = await w.claim(key, { name });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'live');
    w.nodes[`${name}.beanpool.org`] = attestsAs(key);
    return r.body;
}

test('a paused name is taken: available says so, another key\'s claim is 409, and nothing moves', async () => {
    const w = await world();
    try {
        const [owner, other] = await Promise.all([makeKey(), makeKey()]);
        await liveName(w, 'riverside', owner);
        const paused = await w.admin('riverside', 'pause');
        assert.equal(paused.body.status, 'paused');
        const before = await w.row('riverside');
        assert.equal(before.pause_reason, 'admin');
        assert.equal(w.cf.recordAt('riverside.beanpool.org'), null, 'routing is off');
        assert.ok(w.cf.liveTunnel(before.tunnel_id), 'an admin pause keeps the tunnel');

        assert.deepEqual((await w.available('riverside')).body, { available: false, reason: 'taken', tier: 'auto' });
        const grab = await w.claim(other, { name: 'riverside' });
        assert.equal(grab.status, 409);
        assert.deepEqual(grab.body, { error: 'name taken', owner: 'other' });
        assert.deepEqual(await w.row('riverside'), before, 'the refused claim changed nothing');

        // Paused by the sweep or by the incident: just as taken.
        for (const reason of ['impostor', 'incident-2026-09-24']) {
            await w.backdate('riverside', { pause_reason: reason });
            assert.equal((await w.available('riverside')).body.available, false, reason);
            assert.equal((await w.claim(other, { name: 'riverside' })).status, 409, reason);
        }
        // An invite for a paused community still resolves (it exists; the app shows it unreachable).
        assert.equal(await w.invite('riverside'), 200);
    } finally { w.restore(); }
});

test('the owner\'s heal after an impostor pause: a fresh tunnel only its signed request gets, then live', async () => {
    const w = await world();
    try {
        const [owner, intruder, n1, n2] = await Promise.all([makeKey(), makeKey(), makeKey(), makeKey()]);
        await liveName(w, 'swapped', owner);
        await liveName(w, 'alpha', n1); await liveName(w, 'bravo', n2);
        const oldTunnel = (await w.row('swapped')).tunnel_id;

        w.nodes['swapped.beanpool.org'] = attestsAs(intruder);
        await attestSweep(w.env); await attestSweep(w.env);
        const paused = await w.row('swapped');
        assert.equal(paused.status, 'paused');
        assert.equal(paused.pause_reason, 'impostor');
        assert.equal(paused.node_pubkey, owner.pubHex);
        assert.equal(w.cf.liveTunnel(oldTunnel), null, 'the tunnel the impostor rode is gone');
        assert.equal(w.cf.recordAt('swapped.beanpool.org'), null);

        // The node's status says why (today's nodes then claim again, which is a heal for the owner).
        const st = await w.status(owner);
        assert.equal(st.body.status, 'paused');
        assert.equal(st.body.reason, 'impostor');
        assert.equal(st.body.since, paused.paused_at);
        assert.equal(st.body.tunnelToken, undefined);

        w.nodes['swapped.beanpool.org'] = attestsAs(owner);
        const healed = await w.claim(owner, { name: 'swapped' });
        assert.equal(healed.status, 200, JSON.stringify(healed.body));
        assert.equal(healed.body.status, 'live');
        const row = await w.row('swapped');
        assert.notEqual(row.tunnel_id, oldTunnel);
        assert.equal(healed.body.tunnelToken, `token-${row.tunnel_id}`, 'the owner gets the new tunnel\'s token');
        assert.equal(row.pause_reason, null);
        assert.equal(row.attest_fails, 0);
        assert.equal(w.cf.recordAt('swapped.beanpool.org').content, `${row.tunnel_id}.cfargotunnel.com`);
        assert.ok(w.events('swapped').some((e) => e.event === 'paused'));
        assert.ok(w.events('swapped').some((e) => e.event === 'resumed'));
    } finally { w.restore(); }
});

test('the owner\'s heal when the old path is still there: live only after an edge re-attest under its own key', async () => {
    const w = await world();
    try {
        const [owner, intruder, n1, n2] = await Promise.all([makeKey(), makeKey(), makeKey(), makeKey()]);
        await liveName(w, 'swapped', owner);
        await liveName(w, 'alpha', n1); await liveName(w, 'bravo', n2);
        const tunnel = (await w.row('swapped')).tunnel_id;

        // The sweep pauses, but Cloudflare refuses to delete the tunnel: the registrar must keep its id, not
        // forget a tunnel someone else may still be connected to.
        w.nodes['swapped.beanpool.org'] = attestsAs(intruder);
        w.cf.fail.deleteTunnel = true;
        await attestSweep(w.env); await attestSweep(w.env);
        w.cf.fail.deleteTunnel = false;
        assert.equal((await w.row('swapped')).status, 'paused');
        assert.equal((await w.row('swapped')).tunnel_id, tunnel);
        assert.ok(w.cf.liveTunnel(tunnel));
        assert.equal(w.cf.recordAt('swapped.beanpool.org'), null);

        // The impostor still answers through that tunnel: the heal re-routes, re-attests, sees the impostor,
        // and takes routing down again. The name stays paused — and the owner's.
        const refused = await w.heal(owner);
        assert.equal(refused.status, 200);
        assert.equal(refused.body.status, 'paused');
        assert.equal(refused.body.reason, 'impostor');
        assert.equal(refused.body.attest, 'impostor');
        assert.equal(refused.body.tunnelToken, undefined);
        assert.equal(w.cf.recordAt('swapped.beanpool.org'), null, 'routing is off again');
        assert.equal((await w.row('swapped')).node_pubkey, owner.pubHex);

        // Once the owner's node answers through it, the same heal resumes.
        w.nodes['swapped.beanpool.org'] = attestsAs(owner);
        const calls = w.cf.calls.length;
        const healed = await w.heal(owner);
        assert.equal(healed.body.status, 'live');
        assert.equal(healed.body.attest, 'ok');
        assert.deepEqual(healed.body.changed, ['dns']);
        assert.equal(healed.body.tunnelToken, undefined, '/heal sends a token only for a new tunnel');
        const row = await w.row('swapped');
        assert.equal(row.tunnel_id, tunnel, 'the surviving tunnel was reused, not duplicated');
        assert.ok(row.last_ok_at >= nowS() - 5);
        assert.equal(w.cf.recordAt('swapped.beanpool.org').content, `${tunnel}.cfargotunnel.com`);
        assert.ok(!w.cf.calls.slice(calls).some((c) => c.startsWith('DELETE')), 'a heal never deprovisions first');
    } finally { w.restore(); }
});

test('an admin pause is lifted only by the admin; the owner\'s heal leaves it alone', async () => {
    const w = await world();
    try {
        const owner = await makeKey();
        await liveName(w, 'hillcrest', owner);
        await w.admin('hillcrest', 'pause');
        const calls = w.cf.calls.length;
        for (const attempt of [() => w.heal(owner), () => w.claim(owner, { name: 'hillcrest' })]) {
            const r = await attempt();
            assert.equal(r.status, 200);
            assert.equal(r.body.status, 'paused');
            assert.equal(r.body.reason, 'admin');
        }
        assert.equal(w.cf.calls.length, calls, 'no Cloudflare change');
        assert.equal(w.cf.recordAt('hillcrest.beanpool.org'), null);

        const resumed = await w.admin('hillcrest', 'resume');
        assert.equal(resumed.body.status, 'live');
        assert.ok(w.cf.recordAt('hillcrest.beanpool.org'));
        assert.deepEqual(w.events('hillcrest').map((e) => e.event), ['claimed', 'paused', 'resumed']);
    } finally { w.restore(); }
});

test('a released name: held 30 days for the same key, refused to others, then free', async () => {
    const w = await world();
    try {
        const [owner, other] = await Promise.all([makeKey(), makeKey()]);
        await liveName(w, 'lakeside', owner);
        const first = await w.row('lakeside');

        // Today's nodes call /offline; it is release now.
        const rel = await w.release(owner, {}, '/api/registrar/offline');
        assert.equal(rel.status, 200);
        assert.equal(rel.body.status, 'released');
        let row = await w.row('lakeside');
        assert.equal(row.status, 'released');
        assert.equal(row.pause_reason, 'owner');
        assert.equal(rel.body.held_until, row.released_at + COOLOFF);
        assert.equal(w.cf.liveTunnel(first.tunnel_id), null);
        assert.equal(w.cf.recordAt('lakeside.beanpool.org'), null);
        assert.equal((await w.status(owner)).body.status, 'released');
        assert.equal(await w.invite('lakeside'), 404);

        // Held: taken to everyone else.
        assert.deepEqual((await w.available('lakeside')).body, { available: false, reason: 'taken', tier: 'auto' });
        assert.equal((await w.claim(other, { name: 'lakeside' })).status, 409);

        // The same key takes it back inside the hold ("I clicked the wrong button").
        const back = await w.claim(owner, { name: 'lakeside' });
        assert.equal(back.body.status, 'live');
        assert.ok(back.body.tunnelToken);
        row = await w.row('lakeside');
        assert.equal(row.node_pubkey, owner.pubHex);
        assert.equal(row.released_at, null);

        // Released again; one minute short of 30 days the hold still stands.
        await w.release(owner);
        await w.backdate('lakeside', { released_at: nowS() - COOLOFF + 60 });
        assert.equal((await w.available('lakeside')).body.available, false);
        assert.equal((await w.claim(other, { name: 'lakeside' })).status, 409);

        // Past the hold: another key may claim it, and gets its own tunnel — never the old owner's.
        await w.backdate('lakeside', { released_at: nowS() - COOLOFF - 1 });
        assert.deepEqual((await w.available('lakeside')).body, { available: true, reason: 'free', tier: 'auto' });
        const taken = await w.claim(other, { name: 'lakeside' });
        assert.equal(taken.body.status, 'live');
        row = await w.row('lakeside');
        assert.equal(row.node_pubkey, other.pubHex);
        assert.equal(taken.body.tunnelToken, `token-${row.tunnel_id}`);
        assert.equal([...w.cf.tunnels.values()].filter((t) => !t.deleted_at && t.name === 'bp-lakeside').length, 1);
        // … and now it is the new owner's name: the old key is refused like anyone.
        assert.equal((await w.claim(owner, { name: 'lakeside' })).status, 409);
        assert.deepEqual(w.events('lakeside').map((e) => e.event), ['claimed', 'released', 'claimed', 'released', 'claimed']);
    } finally { w.restore(); }
});

test('admin block: the name is blocked — held, never free, and its owner cannot heal or release it', async () => {
    const w = await world();
    try {
        const [owner, other] = await Promise.all([makeKey(), makeKey()]);
        await liveName(w, 'badname', owner);
        const before = await w.row('badname');

        const blocked = await w.admin('badname', 'block');
        assert.deepEqual(blocked.body, { status: 'blocked', name: 'badname' });
        const row = await w.row('badname');
        assert.equal(row.status, 'blocked');
        assert.equal(row.node_pubkey, owner.pubHex);
        assert.equal(w.cf.liveTunnel(before.tunnel_id), null);
        assert.equal(w.cf.recordAt('badname.beanpool.org'), null);

        assert.equal((await w.available('badname')).body.available, false);
        assert.equal((await w.claim(other, { name: 'badname' })).status, 409);
        assert.deepEqual((await w.claim(owner, { name: 'badname' })).body, { error: 'name blocked' });
        assert.equal((await w.heal(owner)).status, 403);
        assert.equal((await w.release(owner)).status, 403);
        assert.equal((await w.row('badname')).status, 'blocked', 'still blocked after all of that');
        const st = await w.status(owner);
        assert.equal(st.body.status, 'blocked');
        assert.equal(st.body.reason, 'admin');
        assert.equal(await w.invite('badname'), 404);

        // `revoke` is block's old name: an admin revoke no longer frees anything.
        await liveName(w, 'otherbad', other);
        assert.equal((await w.admin('otherbad', 'revoke')).body.status, 'blocked');
        assert.equal((await w.available('otherbad')).body.available, false);

        // Only the admin's release frees a name — at once, to anyone.
        assert.equal((await w.admin('badname', 'release')).body.status, 'released');
        assert.deepEqual((await w.available('badname')).body, { available: true, reason: 'free', tier: 'auto' });
        assert.equal((await w.claim(other, { name: 'badname' })).body.status, 'live');
        assert.deepEqual(w.events('badname').map((e) => e.event), ['claimed', 'blocked', 'released', 'claimed']);
    } finally { w.restore(); }
});

test('the admin rejecting a pending (gated) claim frees the name; approving one runs ensure', async () => {
    const w = await world();
    try {
        const [first, second] = await Promise.all([makeKey(), makeKey()]);
        const p = await w.claim(first, { name: 'sydney' });              // gated in the 0001 seed
        assert.equal(p.body.status, 'pending');
        assert.equal((await w.available('sydney')).body.available, false);
        assert.equal((await w.claim(second, { name: 'sydney' })).status, 409);
        // The owner's own re-claim while pending just waits.
        assert.equal((await w.claim(first, { name: 'sydney' })).body.status, 'pending');
        assert.equal(w.cf.calls.length, 0);

        assert.equal((await w.admin('sydney', 'release')).body.status, 'released');
        assert.equal((await w.available('sydney')).body.reason, 'needs-approval');
        assert.equal((await w.claim(second, { name: 'sydney' })).body.status, 'pending');
        assert.equal((await w.admin('sydney', 'approve')).body.status, 'live');
        const row = await w.row('sydney');
        assert.equal(row.node_pubkey, second.pubHex);
        assert.equal(row.decided_by, 'admin');
        assert.ok(w.cf.recordAt('sydney.beanpool.org'));
    } finally { w.restore(); }
});

test('a gated name the admin released: its old key waits for approval again; the owner\'s own release does not', async () => {
    const w = await world();
    try {
        const owner = await makeKey();
        assert.equal((await w.claim(owner, { name: 'perth' })).body.status, 'pending');   // gated in the 0001 seed
        assert.equal((await w.admin('perth', 'approve')).body.status, 'live');

        // The owner's own release, taken back inside the hold: approved before, so live again at once.
        await w.release(owner);
        const back = await w.claim(owner, { name: 'perth' });
        assert.equal(back.body.status, 'live');
        assert.ok(back.body.tunnelToken);

        // The admin's release: the name is not that key's any more, so it is just another claimant.
        assert.equal((await w.admin('perth', 'release')).body.status, 'released');
        const from = w.cf.calls.length;
        const again = await w.claim(owner, { name: 'perth' });
        assert.equal(again.status, 200, JSON.stringify(again.body));
        assert.equal(again.body.status, 'pending');
        assert.equal(again.body.tunnelToken, undefined);
        const row = await w.row('perth');
        assert.equal(row.status, 'pending');
        assert.equal(row.node_pubkey, owner.pubHex);
        assert.equal(row.decided_at, null);
        assert.equal(w.cf.recordAt('perth.beanpool.org'), null, 'not routed until the admin approves');
        assert.ok(!w.cf.calls.slice(from).some((c) => c.startsWith('POST') || c.startsWith('PUT') || c.startsWith('PATCH')));
        assert.equal((await w.admin('perth', 'approve')).body.status, 'live');
    } finally { w.restore(); }
});

test('ensure: an existing record is PATCHed, never POSTed over; an intact name is left alone', async () => {
    const w = await world();
    try {
        const [owner, n1] = await Promise.all([makeKey(), makeKey()]);
        // A record already at the hostname, pointing elsewhere (a leftover, or a host tunnel being moved).
        w.cf.dns.set('dns-stale', { id: 'dns-stale', type: 'CNAME', name: 'meadow.beanpool.org', content: 'old-host.cfargotunnel.com', proxied: true });

        const r = await w.claim(owner, { name: 'meadow' });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.status, 'live');
        const row = await w.row('meadow');
        assert.equal(row.dns_record_id, 'dns-stale', 'the existing record is adopted');
        assert.equal(w.cf.dns.get('dns-stale').content, `${row.tunnel_id}.cfargotunnel.com`);
        assert.ok(w.cf.calls.includes('PATCH /zones/zone/dns_records/dns-stale'));
        assert.ok(!w.cf.calls.includes('POST /zones/zone/dns_records'), 'never POST over an existing record');
        assert.equal([...w.cf.dns.values()].filter((d) => d.name === 'meadow.beanpool.org').length, 1);

        // A heal of an intact live name: nothing re-made, nothing deleted, no second tunnel or record.
        let from = w.cf.calls.length;
        const same = await w.heal(owner);
        assert.equal(same.body.status, 'live');
        assert.deepEqual(same.body.changed, []);
        assert.equal(same.body.tunnelToken, undefined);
        assert.deepEqual(w.cf.calls.slice(from), [
            `GET /accounts/acct/cfd_tunnel/${row.tunnel_id}`,
            `PUT /accounts/acct/cfd_tunnel/${row.tunnel_id}/configurations`,
            'GET /zones/zone/dns_records',
        ]);

        // A claim by the owner of a live name (today's nodes send one after any non-live status) is the same
        // heal, and keeps answering with the token as claim always has.
        from = w.cf.calls.length;
        const again = await w.claim(owner, { name: 'meadow' });
        assert.equal(again.body.status, 'live');
        assert.equal(again.body.tunnelToken, `token-${row.tunnel_id}`);
        assert.ok(!w.cf.calls.slice(from).some((c) => c.startsWith('POST') || c.startsWith('DELETE')));

        // The record deleted out of band: the heal makes exactly one, POSTed because none exists.
        w.cf.dns.delete('dns-stale');
        const fixed = await w.heal(owner);
        assert.deepEqual(fixed.body.changed, ['dns']);
        assert.equal([...w.cf.dns.values()].filter((d) => d.name === 'meadow.beanpool.org').length, 1);

        // The tunnel deleted out of band: a new one, and /heal hands its token over.
        await liveName(w, 'nearby', n1);
        w.cf.tunnels.get((await w.row('meadow')).tunnel_id).deleted_at = 'gone';
        const retunnel = await w.heal(owner);
        assert.deepEqual(retunnel.body.changed, ['tunnel', 'dns']);
        const now = await w.row('meadow');
        assert.equal(retunnel.body.tunnelToken, `token-${now.tunnel_id}`);
        assert.equal(w.cf.recordAt('meadow.beanpool.org').content, `${now.tunnel_id}.cfargotunnel.com`);
    } finally { w.restore(); }
});

test('ensure: a tunnel made for a provisioning that then fails is removed, so the retry can make one', async () => {
    const w = await world();
    try {
        const owner = await makeKey();
        w.cf.fail.ingress = true;
        const failed = await w.claim(owner, { name: 'hillside' });
        assert.equal(failed.status, 502, JSON.stringify(failed.body));
        const row = await w.row('hillside');
        assert.equal(row.status, 'pending', 'held by its key; its next claim retries');
        assert.equal(row.node_pubkey, owner.pubHex);
        assert.equal(row.tunnel_id, null);
        const bp = () => [...w.cf.tunnels.values()].filter((t) => !t.deleted_at && t.name === 'bp-hillside');
        assert.equal(bp().length, 0, 'the half-made tunnel is gone');

        w.cf.fail.ingress = false;
        const retry = await w.claim(owner, { name: 'hillside' });
        assert.equal(retry.status, 200, JSON.stringify(retry.body));
        assert.equal(retry.body.status, 'live');
        assert.equal(bp().length, 1);
        assert.equal(retry.body.tunnelToken, `token-${bp()[0].id}`);
        assert.equal((await w.row('hillside')).tunnel_id, bp()[0].id);
    } finally { w.restore(); }
});

test('ensure: moving tunnel ↔ direct replaces the record (its type can\'t be PATCHed), one record throughout', async () => {
    const w = await world();
    try {
        const owner = await makeKey();
        await liveName(w, 'riverbend', owner);
        const tunnelRow = await w.row('riverbend');
        const records = () => [...w.cf.dns.values()].filter((d) => d.name === 'riverbend.beanpool.org');

        const direct = await w.heal(owner, { mode: 'direct', public_ip: '203.0.113.7' });
        assert.equal(direct.status, 200, JSON.stringify(direct.body));
        assert.equal(direct.body.status, 'live');
        assert.deepEqual(direct.body.changed, ['dns']);
        assert.deepEqual(records().map((d) => [d.type, d.content]), [['A', '203.0.113.7']]);
        assert.equal(w.cf.liveTunnel(tunnelRow.tunnel_id), null, 'the old tunnel has nothing left to serve');
        let row = await w.row('riverbend');
        assert.equal(row.mode, 'direct');
        assert.equal(row.tunnel_id, null);
        assert.equal(row.dns_record_id, records()[0].id);

        const back = await w.heal(owner, { mode: 'tunnel' });
        assert.equal(back.status, 200, JSON.stringify(back.body));
        assert.equal(back.body.status, 'live');
        assert.deepEqual(back.body.changed, ['tunnel', 'dns']);
        row = await w.row('riverbend');
        assert.equal(back.body.tunnelToken, `token-${row.tunnel_id}`);
        assert.deepEqual(records().map((d) => [d.type, d.content]), [['CNAME', `${row.tunnel_id}.cfargotunnel.com`]]);
        assert.equal(row.dns_record_id, records()[0].id);
        assert.ok(!w.cf.calls.some((c) => c.startsWith('PATCH')), 'a type change is never PATCHed');
    } finally { w.restore(); }
});

test('two keys racing for a freed name: exactly one wins; a lock that cannot count rows never reports a win', async () => {
    const w = await world();
    try {
        const [owner, a, b] = await Promise.all([makeKey(), makeKey(), makeKey()]);
        await liveName(w, 'crossroads', owner);
        await w.admin('crossroads', 'release');                          // free at once, to anyone
        const [ra, rb] = await Promise.all([w.claim(a, { name: 'crossroads' }), w.claim(b, { name: 'crossroads' })]);
        assert.deepEqual([ra.status, rb.status].sort(), [200, 409], JSON.stringify([ra.body, rb.body]));
        const winner = ra.status === 200 ? a : b;
        const row = await w.row('crossroads');
        assert.equal(row.node_pubkey, winner.pubHex);
        assert.equal(row.status, 'live');
        assert.equal([...w.cf.tunnels.values()].filter((t) => !t.deleted_at && t.name === 'bp-crossroads').length, 1);

        // A driver whose run() doesn't report meta.changes: can't tell, so not a win.
        const blind = { DB: { prepare: () => ({ bind() { return this; }, async run() { return { success: true }; } }) } };
        assert.equal(await db.replaceAllocation(blind, 'crossroads', row, { status: 'pending' }), false);
    } finally { w.restore(); }
});

test('status: the owner\'s row in any state, with reason and since; signed contact is recorded', async () => {
    const w = await world();
    try {
        const [owner, stranger] = await Promise.all([makeKey(), makeKey()]);
        await liveName(w, 'orchard', owner);
        await w.backdate('orchard', { last_contact_at: null });
        const live = await w.status(owner);
        assert.equal(live.body.status, 'live');
        assert.equal(live.body.reason, null);
        assert.ok(live.body.tunnelToken);
        assert.ok((await w.row('orchard')).last_contact_at >= nowS() - 5, 'a signed request restarts the abandonment clock');
        assert.equal((await w.row('orchard')).proto, 'v1');

        await w.backdate('orchard', { warned_at: nowS() - 10 });
        await w.status(owner);
        assert.equal((await w.row('orchard')).warned_at, null, 'contact clears an abandonment warning');

        await w.release(owner);
        const rel = await w.status(owner);
        assert.equal(rel.body.status, 'released');
        assert.equal(rel.body.reason, 'owner');
        assert.equal(rel.body.since, (await w.row('orchard')).released_at);
        assert.equal(rel.body.held_until, rel.body.since + COOLOFF);

        assert.deepEqual((await w.status(stranger)).body, { status: 'none' });
    } finally { w.restore(); }
});

test('the sweep logs every run, counts content-swaps without acting on them, and stamps last_ok_at', async () => {
    const w = await world();
    try {
        const [a, b, c] = await Promise.all([makeKey(), makeKey(), makeKey()]);
        await liveName(w, 'alpha', a); await liveName(w, 'bravo', b); await liveName(w, 'charlie', c);
        w.nodes['charlie.beanpool.org'] = async () => new Response('<html>not a node</html>', { status: 200 });
        const s = await attestSweep(w.env);
        assert.equal(s.action, 'applied');
        assert.equal(s.content_swap, 1);
        const log = w.sqlite.prepare('SELECT live_count, ok, unverifiable, impostor, content_swap, action FROM sweep_log').all().map((r) => ({ ...r }));
        assert.deepEqual(log, [{ live_count: 3, ok: 2, unverifiable: 1, impostor: 0, content_swap: 1, action: 'applied' }]);
        assert.equal((await w.row('charlie')).status, 'live', 'a content-swap is counted, never acted on here');
        assert.ok((await w.row('alpha')).last_ok_at >= nowS() - 5);
    } finally { w.restore(); }
});

test('/admin: the served script parses, and the admin endpoints need the secret', async () => {
    // ADMIN_HTML is a template literal: a `\n` or `\'` in its source becomes a raw newline or quote in the served
    // script. Before this PR the revoke confirm text did exactly that and no /admin button could work.
    const w = await world();
    try {
        const html = await (await worker.fetch(new Request('https://beanpool.org/admin'), w.env)).text();
        const script = html.split('<script>')[1].split('</script>')[0];
        assert.doesNotThrow(() => new vm.Script(script));
        for (const action of ['pause', 'resume', 'block', 'release', 'approve']) assert.match(script, new RegExp(`${action}:`));

        const owner = await makeKey();
        await liveName(w, 'guarded', owner);
        for (const path of ['/api/local/admin/registrar/guarded/block', '/api/local/admin/registrar/guarded/release']) {
            const res = await worker.fetch(new Request(`https://beanpool.org${path}`, { method: 'POST', headers: { 'x-admin-secret': 'wrong' } }), w.env);
            assert.equal(res.status, 401);
        }
        assert.equal((await worker.fetch(new Request('https://beanpool.org/api/local/admin/registrar/events'), w.env)).status, 401);
        assert.equal((await w.row('guarded')).status, 'live');
        const ev = await worker.fetch(new Request('https://beanpool.org/api/local/admin/registrar/events?name=guarded', {
            headers: { 'x-admin-secret': 'test-admin-secret' },
        }), w.env);
        assert.deepEqual((await ev.json()).events.map((e) => e.event), ['claimed']);
    } finally { w.restore(); }
});

// ── Migration 0002 ────────────────────────────────────────────────────────────────────────────────────────────
const CUTOFF = 1790233200;          // 2026-09-24 17:00 AEST
const WINDOW = 1788134400;          // 2026-08-31

// A row as the pre-0002 Worker left it.
function oldRow(sqlite, r) {
    sqlite.prepare(`INSERT INTO name_allocations (name, node_pubkey, hostname, mode, status, tunnel_id, dns_record_id,
                    attest_fails, last_attest_at, requested_at, decided_at, decided_by)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(r.name, r.key.pubHex, `${r.name}.beanpool.org`, 'tunnel', r.status, `tun-old-${r.name}`, `dns-old-${r.name}`,
            r.fails ?? 0, r.lastAttest ?? null, r.requested, r.decided ?? r.requested, 'auto');
}

test('migration 0002: incident victims go back to their original key, paused; a later other-key holder is recorded, not evicted', async () => {
    const w = await world({ migrations: ['0001_init.sql'] });
    try {
        const [yarra, victim2, taker, oldtimer, offliner, impostored] = await Promise.all(Array.from({ length: 6 }, makeKey));
        // yarravalley: revoked by the incident, never re-claimed.
        oldRow(w.sqlite, { name: 'yarravalley', key: yarra, status: 'revoked', fails: 2, lastAttest: CUTOFF - 9 * DAY, requested: CUTOFF - 60 * DAY });
        // test: revoked by the incident, then claimed by ANOTHER key inside the window (the old row was overwritten).
        oldRow(w.sqlite, { name: 'test', key: taker, status: 'live', requested: WINDOW + 10 * DAY });
        // A victim whose key has since taken another name.
        oldRow(w.sqlite, { name: 'creekside', key: victim2, status: 'revoked', fails: 2, requested: CUTOFF - 40 * DAY });
        oldRow(w.sqlite, { name: 'creekside2', key: victim2, status: 'live', requested: CUTOFF - 2 * DAY });
        // Untouched: live since before the window.
        oldRow(w.sqlite, { name: 'oldtown', key: oldtimer, status: 'live', lastAttest: nowS() - 300, requested: WINDOW - 90 * DAY });
        // /offline'd (attest_fails 0), and an impostor revoke of a name that went live after the cut-off.
        oldRow(w.sqlite, { name: 'quietnode', key: offliner, status: 'revoked', requested: WINDOW - 30 * DAY });
        oldRow(w.sqlite, { name: 'newbie', key: impostored, status: 'revoked', fails: 2, requested: CUTOFF + DAY });

        w.sqlite.exec(migration('0002_states.sql'));

        const yv = await w.row('yarravalley');
        assert.equal(yv.status, 'paused');
        assert.equal(yv.pause_reason, 'incident-2026-09-24');
        assert.equal(yv.node_pubkey, yarra.pubHex, 'owned by its ORIGINAL key');
        assert.ok(yv.paused_at >= nowS() - 5);
        assert.equal(yv.last_ok_at, CUTOFF - 9 * DAY, 'last_ok_at starts from the last recorded attest');
        assert.equal(w.events('yarravalley')[0].event, 'incident-restore');

        const t = await w.row('test');
        assert.equal(t.status, 'live', 'the later holder is not evicted');
        assert.equal(t.node_pubkey, taker.pubHex);
        const review = w.events('test');
        assert.equal(review.length, 1);
        assert.equal(review[0].event, 'incident-review');
        assert.match(review[0].detail, /NOT evicted/);
        assert.match(review[0].detail, new RegExp(taker.pubHex.slice(0, 16)));

        assert.equal((await w.row('creekside')).status, 'paused');
        assert.deepEqual(w.events('creekside').map((e) => e.event), ['incident-restore', 'incident-review']);
        assert.match(w.events('creekside')[1].detail, /creekside2 \(live\)/);

        assert.equal((await w.row('oldtown')).status, 'live');
        assert.deepEqual(w.events('oldtown'), []);

        const q = await w.row('quietnode');
        assert.equal(q.status, 'released');
        assert.ok(q.released_at >= nowS() - 5, 'held 30 days for its key from the migration');
        assert.equal((await w.row('newbie')).status, 'paused');
        assert.equal((await w.row('newbie')).pause_reason, 'impostor');
        assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM name_allocations WHERE status='revoked'").get().n, 0);

        // A second run stops at its first statement and changes nothing.
        const snapshot = () => JSON.stringify([
            w.sqlite.prepare('SELECT * FROM name_allocations ORDER BY name').all(),
            w.sqlite.prepare('SELECT * FROM name_events ORDER BY id').all(),
        ]);
        const before = snapshot();
        assert.throws(() => w.sqlite.exec(migration('0002_states.sql')), /duplicate column/);
        assert.equal(snapshot(), before);

        // And the Worker on top: the victim's own node heals it (today's nodes do so with a claim) on a fresh
        // tunnel; the taker's key cannot have it; the taker keeps `test`.
        assert.equal((await w.available('yarravalley')).body.available, false);
        assert.equal((await w.claim(taker, { name: 'yarravalley' })).status, 409);
        const healed = await w.claim(yarra, { name: 'yarravalley' });
        assert.equal(healed.body.status, 'live');
        const now = await w.row('yarravalley');
        assert.notEqual(now.tunnel_id, 'tun-old-yarravalley');
        assert.equal(healed.body.tunnelToken, `token-${now.tunnel_id}`);
        assert.equal(w.cf.recordAt('yarravalley.beanpool.org').content, `${now.tunnel_id}.cfargotunnel.com`);
        assert.equal((await w.row('test')).node_pubkey, taker.pubHex);
    } finally { w.restore(); }
});
