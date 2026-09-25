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

// D1's prepare/bind/first/all/run over node:sqlite (run() reports meta.changes, as D1 does). `afterRead(re, run)`:
// once, just after the first first() whose SQL matches `re` has read its row, `run` runs to completion before the
// caller gets that row — a request landing between another request's read and its first write. `beforeRun(re, run)`:
// once, just before the first run() whose SQL matches `re` writes, `run` runs to completion — a request landing
// between another request's last Cloudflare call and its write.
function sqliteD1(migrations = ['0001_init.sql', '0002_states.sql', '0003_decision_seq.sql', '0004_teardown.sql']) {
    const sqlite = new DatabaseSync(':memory:');
    for (const m of migrations) sqlite.exec(migration(m));
    const readHooks = [];
    const runHooks = [];
    const d1 = {
        prepare(sql) {
            const stmt = sqlite.prepare(sql);
            let args = [];
            return {
                bind(...a) { args = a; return this; },
                async first() {
                    const r = stmt.get(...args);
                    const h = readHooks.findIndex((x) => x.re.test(sql));
                    if (h >= 0) await readHooks.splice(h, 1)[0].run();
                    return r ? { ...r } : null;
                },
                async all() { return { results: stmt.all(...args).map((r) => ({ ...r })) }; },
                async run() {
                    const h = runHooks.findIndex((x) => x.re.test(sql));
                    if (h >= 0) await runHooks.splice(h, 1)[0].run();
                    const r = stmt.run(...args);
                    return { success: true, meta: { changes: Number(r.changes) } };
                },
            };
        },
    };
    const all = (sql, ...a) => sqlite.prepare(sql).all(...a).map((r) => ({ ...r }));
    const afterRead = (re, run) => readHooks.push({ re, run });
    const beforeRun = (re, run) => runHooks.push({ re, run });
    return { sqlite, d1, all, afterRead, beforeRun };
}

// Cloudflare as far as the registrar uses it. A duplicate live tunnel name and a second record at a hostname are
// refused, as Cloudflare refuses them — so a POST-collision or a second tunnel shows up as a failure here.
// `during(re, run)`: once, just before Cloudflare answers the first call matching `re` (`${method} ${path}`),
// `run` runs to completion — an admin action landing between two of a request's Cloudflare calls. `at(n, run)`:
// the same, just before Cloudflare answers the n-th call from now.
function fakeCloudflare() {
    const calls = [];
    const tunnels = new Map();   // id → { id, name, created_at, deleted_at, ingress }
    const dns = new Map();       // id → { id, type, name (fqdn), content, proxied }
    const fail = { deleteTunnel: false, ingress: false, deleteDns: false, patchDns: false, postDns: false };
    const hooks = [];
    let seq = 0;
    const ok = (result) => Response.json({ success: true, result });
    const err = (status, code, message) => Response.json({ success: false, errors: [{ code, message }] }, { status });
    async function handle(method, url, body) {
        const p = url.pathname.replace('/client/v4', '');
        calls.push(`${method} ${p}`);
        const h = hooks.findIndex((x) => (x.re ? x.re.test(`${method} ${p}`) : x.n === calls.length));
        if (h >= 0) await hooks.splice(h, 1)[0].run();
        let m;
        if (method === 'POST' && p === '/accounts/acct/cfd_tunnel') {
            if ([...tunnels.values()].some((t) => !t.deleted_at && t.name === body.name)) return err(409, 1013, 'tunnel name already in use');
            const t = { id: `tun-${++seq}`, name: body.name, created_at: new Date().toISOString(), deleted_at: null };
            tunnels.set(t.id, t);
            return ok(t);
        }
        if (method === 'GET' && p === '/accounts/acct/cfd_tunnel') {
            const name = url.searchParams.get('name');
            const live = url.searchParams.get('is_deleted') === 'false';
            return ok([...tunnels.values()].filter((t) => (!name || t.name === name) && (!live || !t.deleted_at)));
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
            if (fail.postDns) return err(500, 1000, 'internal error');
            const fqdn = `${body.name}.beanpool.org`;
            if ([...dns.values()].some((r) => r.name === fqdn)) return err(400, 81053, 'An A, AAAA, or CNAME record with that host already exists.');
            const r = { id: `dns-${++seq}`, type: body.type, name: fqdn, content: body.content, proxied: body.proxied };
            dns.set(r.id, r);
            return ok(r);
        }
        if ((m = p.match(/^\/zones\/zone\/dns_records\/([^/]+)$/))) {
            const r = dns.get(m[1]);
            if (method === 'DELETE' && fail.deleteDns) return err(500, 1000, 'internal error');
            if (method === 'PATCH' && fail.patchDns) return err(500, 1000, 'internal error');
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
    const during = (re, run) => hooks.push({ re, run });
    const at = (n, run) => hooks.push({ n: calls.length + n, run });
    return { calls, tunnels, dns, fail, hooks, during, at, handle, recordAt, liveTunnel };
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
    const { sqlite, d1, all, afterRead, beforeRun } = sqliteD1(migrations);
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
        env, cf, nodes, sqlite, afterRead, beforeRun,
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

test('a take-back on a tunnel its release could not delete: routed only after an edge re-attest under the owner\'s key', async () => {
    const w = await world();
    try {
        const [owner, intruder, n1, n2] = await Promise.all([makeKey(), makeKey(), makeKey(), makeKey()]);
        await liveName(w, 'swapped', owner);
        await liveName(w, 'alpha', n1); await liveName(w, 'bravo', n2);
        const tunnel = (await w.row('swapped')).tunnel_id;

        // Paused for an impostor on a tunnel Cloudflare will not delete; the owner's heal re-attests and is refused.
        w.nodes['swapped.beanpool.org'] = attestsAs(intruder);
        w.cf.fail.deleteTunnel = true;
        await attestSweep(w.env); await attestSweep(w.env);
        assert.equal((await w.heal(owner)).body.attest, 'impostor');

        // Release, then claim: a take-back on that same tunnel (Cloudflare still refuses to delete it). It re-attests
        // as the heal did, sees the impostor, and is not routed.
        assert.equal((await w.release(owner)).body.status, 'released');
        assert.equal((await w.row('swapped')).tunnel_id, tunnel);
        const back = await w.claim(owner, { name: 'swapped' });
        assert.equal(back.status, 200, JSON.stringify(back.body));
        assert.equal(back.body.status, 'paused');
        assert.equal(back.body.reason, 'impostor');
        assert.equal(back.body.attest, 'impostor');
        assert.equal(back.body.tunnelToken, undefined);
        assert.equal(w.cf.recordAt('swapped.beanpool.org'), null, 'routing is off again');
        let row = await w.row('swapped');
        assert.equal(row.status, 'paused');
        assert.equal(row.pause_reason, 'impostor');
        assert.equal(row.node_pubkey, owner.pubHex, 'still the owner\'s');
        assert.equal(row.tunnel_id, tunnel);
        assert.equal((await w.status(owner)).body.reason, 'impostor');

        // The owner's own node answering through it: the same take-back goes live, on the tunnel it kept.
        await w.release(owner);
        w.nodes['swapped.beanpool.org'] = attestsAs(owner);
        const ok = await w.claim(owner, { name: 'swapped' });
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        assert.equal(ok.body.status, 'live');
        assert.equal(ok.body.attest, 'ok');
        assert.equal(ok.body.tunnelToken, `token-${tunnel}`);
        row = await w.row('swapped');
        assert.equal(row.tunnel_id, tunnel, 'reused, not duplicated');
        assert.equal(row.pause_reason, null);
        assert.ok(row.last_ok_at >= nowS() - 5);
        assert.equal(w.cf.recordAt('swapped.beanpool.org').content, `${tunnel}.cfargotunnel.com`);
        assert.deepEqual(w.events('swapped').map((e) => e.event).slice(-5), ['released', 'claimed', 'paused', 'released', 'claimed']);
    } finally { w.restore(); }
});

test('a take-back deletes a tunnel its release left behind, and goes live on a fresh one', async () => {
    const w = await world();
    try {
        const owner = await makeKey();
        await liveName(w, 'lakeview', owner);
        const old = (await w.row('lakeview')).tunnel_id;
        w.cf.fail.deleteTunnel = true;                    // Cloudflare refuses the release's delete…
        await w.release(owner);
        assert.equal((await w.row('lakeview')).tunnel_id, old);
        assert.ok(w.cf.liveTunnel(old));
        w.cf.fail.deleteTunnel = false;                   // … and accepts the take-back's
        delete w.nodes['lakeview.beanpool.org'];          // the node dropped its token on release: nothing answers

        const back = await w.claim(owner, { name: 'lakeview' });
        assert.equal(back.status, 200, JSON.stringify(back.body));
        assert.equal(back.body.status, 'live');
        assert.equal(back.body.attest, undefined, 'a fresh tunnel needs no re-attest');
        const row = await w.row('lakeview');
        assert.notEqual(row.tunnel_id, old);
        assert.equal(w.cf.liveTunnel(old), null, 'whatever was connected to the old tunnel is cut off');
        assert.equal(back.body.tunnelToken, `token-${row.tunnel_id}`);
        assert.equal([...w.cf.tunnels.values()].filter((t) => !t.deleted_at && t.name === 'bp-lakeview').length, 1);
        assert.equal(w.cf.recordAt('lakeview.beanpool.org').content, `${row.tunnel_id}.cfargotunnel.com`);
    } finally { w.restore(); }
});

test('a take-back whose provisioning fails stays paused for its key, approval kept; its next claim heals it', async () => {
    const w = await world();
    try {
        const [owner, other] = await Promise.all([makeKey(), makeKey()]);
        assert.equal((await w.claim(owner, { name: 'perth' })).body.status, 'pending');   // gated in the 0001 seed
        assert.equal((await w.admin('perth', 'approve')).body.status, 'live');
        await w.release(owner);

        w.cf.fail.ingress = true;
        assert.equal((await w.claim(owner, { name: 'perth' })).status, 502);
        const row = await w.row('perth');
        assert.equal(row.status, 'paused', 'not pending: the admin already let this key have it');
        assert.equal(row.pause_reason, 'unverified');
        assert.equal(row.node_pubkey, owner.pubHex);
        assert.equal(row.decided_by, 'admin');
        assert.equal((await w.status(owner)).body.status, 'paused');
        assert.equal((await w.claim(other, { name: 'perth' })).status, 409);

        w.cf.fail.ingress = false;
        const healed = await w.claim(owner, { name: 'perth' });
        assert.equal(healed.status, 200, JSON.stringify(healed.body));
        assert.equal(healed.body.status, 'live', 'no second approval needed');
        const now = await w.row('perth');
        assert.equal(healed.body.tunnelToken, `token-${now.tunnel_id}`);
        assert.equal(now.decided_by, 'admin');
        assert.ok(w.cf.recordAt('perth.beanpool.org'));
    } finally { w.restore(); }
});

test('a take-back that fails on a kept tunnel is retried as a heal, and still re-attests', async () => {
    const w = await world();
    try {
        const [owner, intruder, n1, n2] = await Promise.all([makeKey(), makeKey(), makeKey(), makeKey()]);
        await liveName(w, 'swapped', owner);
        await liveName(w, 'alpha', n1); await liveName(w, 'bravo', n2);
        const tunnel = (await w.row('swapped')).tunnel_id;
        w.nodes['swapped.beanpool.org'] = attestsAs(intruder);
        w.cf.fail.deleteTunnel = true;                    // for the whole test
        await attestSweep(w.env); await attestSweep(w.env);
        await w.release(owner);

        w.cf.fail.ingress = true;
        assert.equal((await w.claim(owner, { name: 'swapped' })).status, 502);
        assert.equal((await w.row('swapped')).status, 'paused', 'held for its key, and not live');
        w.cf.fail.ingress = false;
        const retry = await w.claim(owner, { name: 'swapped' });
        assert.equal(retry.status, 200, JSON.stringify(retry.body));
        assert.equal(retry.body.status, 'paused');
        assert.equal(retry.body.attest, 'impostor');
        assert.equal(retry.body.tunnelToken, undefined);
        assert.equal(w.cf.recordAt('swapped.beanpool.org'), null);
        assert.equal((await w.row('swapped')).tunnel_id, tunnel);
    } finally { w.restore(); }
});

test('a direct take-back is routed only after an edge re-attest under its key, as a heal from a pause is', async () => {
    const w = await world();
    try {
        const [owner, other] = await Promise.all([makeKey(), makeKey()]);
        const direct = { name: 'openfield', mode: 'direct', public_ip: '203.0.113.7' };
        assert.equal((await w.claim(owner, direct)).body.status, 'live');
        await w.release(owner);

        // Another key answers at the address: not routed, and still the owner's.
        w.nodes['openfield.beanpool.org'] = attestsAs(other);
        const imp = await w.claim(owner, direct);
        assert.equal(imp.status, 200, JSON.stringify(imp.body));
        assert.equal(imp.body.status, 'paused');
        assert.equal(imp.body.reason, 'impostor');
        assert.equal(w.cf.recordAt('openfield.beanpool.org'), null);
        assert.equal((await w.row('openfield')).node_pubkey, owner.pubHex);

        // Released again, and nothing answers yet: not routed, and not called an impostor.
        await w.release(owner);
        delete w.nodes['openfield.beanpool.org'];
        const quiet = await w.claim(owner, direct);
        assert.equal(quiet.body.status, 'paused');
        assert.equal(quiet.body.reason, 'unverified');
        assert.equal(quiet.body.attest, 'unverifiable');
        assert.equal(w.cf.recordAt('openfield.beanpool.org'), null);

        // Its own node answering: the next claim (a heal) routes it.
        w.nodes['openfield.beanpool.org'] = attestsAs(owner);
        const ok = await w.claim(owner, direct);
        assert.equal(ok.body.status, 'live');
        assert.equal(ok.body.attest, 'ok');
        const rec = w.cf.recordAt('openfield.beanpool.org');
        assert.deepEqual([rec.type, rec.content], ['A', '203.0.113.7']);
        assert.equal((await w.row('openfield')).status, 'live');
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

test('an admin pause survives the owner\'s release-then-claim: the release is refused, as a block\'s is', async () => {
    const w = await world();
    try {
        const owner = await makeKey();
        await liveName(w, 'stillwater', owner);
        await w.admin('stillwater', 'pause');
        const before = await w.row('stillwater');

        // A release would turn the owner's next claim into a take-back — live again, with no admin resume.
        for (const path of ['/api/registrar/release', '/api/registrar/offline']) {
            const rel = await w.release(owner, {}, path);
            assert.equal(rel.status, 403, JSON.stringify(rel.body));
            assert.deepEqual(rel.body, { error: 'paused by the admin' });
        }
        assert.deepEqual(await w.row('stillwater'), before, 'the refused release changed nothing');
        const claim = await w.claim(owner, { name: 'stillwater' });
        assert.equal(claim.status, 200);
        assert.equal(claim.body.status, 'paused');
        assert.equal(claim.body.reason, 'admin');
        assert.equal(claim.body.tunnelToken, undefined);
        assert.equal(w.cf.recordAt('stillwater.beanpool.org'), null, 'routing stays off');
        assert.equal((await w.row('stillwater')).pause_reason, 'admin');

        // Only the admin lifts it: resume still works, and so does the admin's own release of a paused name.
        assert.equal((await w.admin('stillwater', 'resume')).body.status, 'live');
        assert.ok(w.cf.recordAt('stillwater.beanpool.org'));
        await w.admin('stillwater', 'pause');
        assert.equal((await w.admin('stillwater', 'release')).body.status, 'released');
        assert.equal((await w.available('stillwater')).body.available, true);
        assert.deepEqual(w.events('stillwater').map((e) => e.event), ['claimed', 'paused', 'resumed', 'paused', 'released']);
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

test('a gated claim the admin never approved, released by its key, is free at once; an auto one is held', async () => {
    const w = await world();
    try {
        const [first, second, auto, other] = await Promise.all([makeKey(), makeKey(), makeKey(), makeKey()]);
        assert.equal((await w.claim(first, { name: 'sydney' })).body.status, 'pending');   // gated in the 0001 seed
        const rel = await w.release(first);
        assert.equal(rel.status, 200, JSON.stringify(rel.body));
        assert.deepEqual(rel.body, { status: 'released', name: 'sydney' }, 'nothing is held, so no held_until');
        const row = await w.row('sydney');
        assert.equal(row.status, 'released');
        assert.equal(row.pause_reason, 'withdrawn');
        assert.deepEqual((await w.available('sydney')).body, { available: true, reason: 'needs-approval', tier: 'gated' });
        const st = await w.status(first);
        assert.equal(st.body.status, 'released');
        assert.equal(st.body.reason, 'withdrawn');
        assert.equal(st.body.held_until, undefined);

        // Any key may queue for it now, the old one included, and the admin decides as for any gated claim.
        const next = await w.claim(second, { name: 'sydney' });
        assert.equal(next.status, 200, JSON.stringify(next.body));
        assert.equal(next.body.status, 'pending');
        assert.equal((await w.row('sydney')).node_pubkey, second.pubHex);
        assert.equal(w.cf.calls.length, 0, 'none of this reached Cloudflare');
        assert.deepEqual(w.events('sydney').map((e) => e.event), ['claimed', 'released', 'claimed']);

        // A pending AUTO name is one whose provisioning failed: policy let that key have it, so it is held.
        w.cf.fail.ingress = true;
        assert.equal((await w.claim(auto, { name: 'hillside' })).status, 502);
        w.cf.fail.ingress = false;
        const held = await w.release(auto);
        assert.equal(held.body.status, 'released');
        assert.equal(held.body.held_until, (await w.row('hillside')).released_at + COOLOFF);
        assert.equal((await w.row('hillside')).pause_reason, 'owner');
        assert.equal((await w.available('hillside')).body.available, false);
        assert.equal((await w.claim(other, { name: 'hillside' })).status, 409);
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

// ── Races: a decision landing while a request is at Cloudflare ────────────────────────────────────────────────
// A heal or claim reads the row, works at Cloudflare (ensure; on a kept tunnel, an edge re-attest of up to 15 s),
// then writes. Whatever the admin decides in between must stand, and routing must end as that decision says.
// `w.cf.during` runs the admin action between two of the request's Cloudflare calls.

// What routes a name, as far as Cloudflare goes: the record at its hostname, and its tunnels still alive.
const routing = (w, name) => ({
    dns: w.cf.recordAt(`${name}.beanpool.org`)?.content ?? null,
    tunnels: [...w.cf.tunnels.values()].filter((t) => !t.deleted_at && t.name === `bp-${name}`).map((t) => t.id),
});

// A live name the sweep paused for an impostor: tunnel and DNS removed — or the tunnel kept, when Cloudflare
// refused its delete. Two neighbours keep the sweep believable.
async function impostorPaused(w, name, { keptTunnel = false } = {}) {
    const [owner, intruder, n1, n2] = await Promise.all([makeKey(), makeKey(), makeKey(), makeKey()]);
    await liveName(w, name, owner);
    await liveName(w, `${name}-a`, n1); await liveName(w, `${name}-b`, n2);
    w.nodes[`${name}.beanpool.org`] = attestsAs(intruder);
    w.cf.fail.deleteTunnel = keptTunnel;
    await attestSweep(w.env); await attestSweep(w.env);
    w.cf.fail.deleteTunnel = false;
    const row = await w.row(name);
    assert.equal(row.status, 'paused');
    assert.equal(row.pause_reason, 'impostor');
    assert.equal(!!w.cf.liveTunnel(row.tunnel_id), keptTunnel);
    return { owner, intruder, row };
}

// After a race: the same decision again, then the admin's release, still do what they say.
async function stillAdministrable(w, name, action) {
    const again = await w.admin(name, action);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.status, action === 'pause' ? 'paused' : 'blocked');
    assert.equal((await w.admin(name, 'release')).body.status, 'released');
    assert.deepEqual(routing(w, name), { dns: null, tunnels: [] }, 'released: nothing left at Cloudflare');
    assert.equal((await w.available(name)).body.available, true);
}

test('race: an admin pause landing while the owner\'s claim heals an impostor pause stands — not routed, no token', async () => {
    const w = await world();
    try {
        const { owner } = await impostorPaused(w, 'midpause');
        w.nodes['midpause.beanpool.org'] = attestsAs(owner);
        // The heal has made a fresh tunnel and set its ingress; the pause lands before it puts the record up.
        let paused;
        w.cf.during(/^POST \/zones\/zone\/dns_records$/, async () => { paused = await w.admin('midpause', 'pause'); });
        const r = await w.claim(owner, { name: 'midpause' });
        assert.equal(w.cf.hooks.length, 0, 'the pause landed mid-request');
        assert.equal(paused.body.status, 'paused');
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.status, 'paused');
        assert.equal(r.body.reason, 'admin');
        assert.equal(r.body.tunnelToken, undefined, 'the owner got no token');
        const row = await w.row('midpause');
        assert.equal(row.status, 'paused');
        assert.equal(row.pause_reason, 'admin');
        assert.deepEqual(routing(w, 'midpause'), { dns: null, tunnels: [] }, 'not routed; the tunnel the heal made is gone');
        assert.equal((await w.status(owner)).body.reason, 'admin');
        await stillAdministrable(w, 'midpause', 'pause');
    } finally { w.restore(); }
});

test('race: an admin pause landing during the heal\'s edge re-attest stands; the node\'s next heals leave it off', async () => {
    const w = await world();
    try {
        const { owner, row: before } = await impostorPaused(w, 'midattest', { keptTunnel: true });
        // The owner's node, back on the kept tunnel, answers the heal's re-attest — while the admin pauses.
        let paused;
        w.nodes['midattest.beanpool.org'] = async (nonce) => { paused = await w.admin('midattest', 'pause'); return attestsAs(owner)(nonce); };
        const r = await w.heal(owner);
        assert.equal(paused.body.status, 'paused');
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.status, 'paused');
        assert.equal(r.body.reason, 'admin');
        const row = await w.row('midattest');
        assert.equal(row.status, 'paused');
        assert.equal(row.pause_reason, 'admin');
        assert.equal(row.tunnel_id, before.tunnel_id, 'an admin pause keeps the tunnel');
        assert.equal(routing(w, 'midattest').dns, null, 'not routed');

        // The node's routine heals leave it alone; only the admin's resume brings it back.
        w.nodes['midattest.beanpool.org'] = attestsAs(owner);
        for (let i = 0; i < 2; i++) assert.equal((await w.heal(owner)).body.reason, 'admin');
        assert.equal(routing(w, 'midattest').dns, null);
        assert.equal((await w.admin('midattest', 'resume')).body.status, 'live');
        assert.equal(routing(w, 'midattest').dns, `${before.tunnel_id}.cfargotunnel.com`);
    } finally { w.restore(); }
});

test('race: an admin pause landing mid-repair of a live name stands, and the record the repair re-made goes', async () => {
    const w = await world();
    try {
        const owner = await makeKey();
        await liveName(w, 'midrepair', owner);
        // The pause lands just before the heal looks the record up: the heal finds none and makes one.
        let paused;
        w.cf.during(/^GET \/zones\/zone\/dns_records$/, async () => { paused = await w.admin('midrepair', 'pause'); });
        const r = await w.heal(owner);
        assert.equal(paused.body.status, 'paused');
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.status, 'paused');
        assert.equal(r.body.reason, 'admin');
        const row = await w.row('midrepair');
        assert.equal(row.status, 'paused');
        assert.equal(row.pause_reason, 'admin');
        assert.equal(row.dns_record_id, null);
        assert.equal(routing(w, 'midrepair').dns, null, 'the record the heal made is gone');
        assert.equal((await w.heal(owner)).body.reason, 'admin');
        assert.equal(routing(w, 'midrepair').dns, null);
        await stillAdministrable(w, 'midrepair', 'pause');
    } finally { w.restore(); }
});

test('race: an admin block landing while the owner heals an impostor pause stands — blocked, not routed, no token', async () => {
    const w = await world();
    try {
        const { owner } = await impostorPaused(w, 'midblock');
        w.nodes['midblock.beanpool.org'] = attestsAs(owner);
        // The heal has made a fresh tunnel; the block lands before it sets the ingress.
        let blocked;
        w.cf.during(/^PUT \/accounts\/acct\/cfd_tunnel\/[^/]+\/configurations$/, async () => { blocked = await w.admin('midblock', 'block'); });
        const r = await w.claim(owner, { name: 'midblock' });
        assert.equal(blocked.body.status, 'blocked');
        assert.equal(r.status, 403, JSON.stringify(r.body));
        assert.deepEqual(r.body, { error: 'name blocked' });
        const row = await w.row('midblock');
        assert.equal(row.status, 'blocked');
        assert.deepEqual([row.tunnel_id, row.dns_record_id], [null, null]);
        assert.deepEqual(routing(w, 'midblock'), { dns: null, tunnels: [] });
        await stillAdministrable(w, 'midblock', 'block');
    } finally { w.restore(); }
});

test('race: an admin block landing as the owner\'s heal of its live name starts stands, and what the heal re-made goes', async () => {
    const w = await world();
    try {
        const owner = await makeKey();
        await liveName(w, 'earlyblock', owner);
        const before = await w.row('earlyblock');
        // The block lands before the heal checks its tunnel: the heal finds it gone and makes a new one.
        let blocked;
        w.cf.during(/^GET \/accounts\/acct\/cfd_tunnel\/[^/]+$/, async () => { blocked = await w.admin('earlyblock', 'block'); });
        const r = await w.claim(owner, { name: 'earlyblock' });   // today's nodes heal with a claim
        assert.equal(blocked.body.status, 'blocked');
        assert.equal(r.status, 403, JSON.stringify(r.body));
        assert.equal(r.body.tunnelToken, undefined);
        const row = await w.row('earlyblock');
        assert.equal(row.status, 'blocked');
        assert.deepEqual([row.tunnel_id, row.dns_record_id], [null, null]);
        assert.equal(w.cf.liveTunnel(before.tunnel_id), null);
        assert.deepEqual(routing(w, 'earlyblock'), { dns: null, tunnels: [] }, 'the tunnel and record the heal made are gone');
        await stillAdministrable(w, 'earlyblock', 'block');
    } finally { w.restore(); }
});

test('race: the owner\'s heal landing while the admin\'s block is at Cloudflare is refused; nothing is left routed', async () => {
    const w = await world();
    try {
        const owner = await makeKey();
        await liveName(w, 'lateheal', owner);
        // The heal arrives between the block's record delete and its tunnel delete.
        let healed;
        w.cf.during(/^DELETE \/accounts\/acct\/cfd_tunnel\//, async () => { healed = await w.heal(owner); });
        const b = await w.admin('lateheal', 'block');
        assert.equal(b.body.status, 'blocked');
        assert.equal(healed.status, 403, JSON.stringify(healed.body));
        const row = await w.row('lateheal');
        assert.equal(row.status, 'blocked');
        assert.deepEqual([row.tunnel_id, row.dns_record_id], [null, null]);
        assert.deepEqual(routing(w, 'lateheal'), { dns: null, tunnels: [] });
        await stillAdministrable(w, 'lateheal', 'block');
    } finally { w.restore(); }
});

test('race: an admin block landing while the owner takes its release back stands — blocked, not routed, no token', async () => {
    const w = await world();
    try {
        const owner = await makeKey();
        await liveName(w, 'takeblock', owner);
        await w.release(owner);
        let blocked;
        w.cf.during(/^POST \/zones\/zone\/dns_records$/, async () => { blocked = await w.admin('takeblock', 'block'); });
        const r = await w.claim(owner, { name: 'takeblock' });
        assert.equal(blocked.body.status, 'blocked');
        assert.equal(r.status, 403, JSON.stringify(r.body));
        assert.deepEqual(r.body, { error: 'name blocked' });
        const row = await w.row('takeblock');
        assert.equal(row.status, 'blocked');
        assert.equal(row.node_pubkey, owner.pubHex);
        assert.deepEqual(routing(w, 'takeblock'), { dns: null, tunnels: [] });
        await stillAdministrable(w, 'takeblock', 'block');
    } finally { w.restore(); }
});

test('race: an admin block landing on a new claim mid-provisioning stands', async () => {
    const w = await world();
    try {
        const owner = await makeKey();
        let blocked;
        w.cf.during(/^PUT \/accounts\/acct\/cfd_tunnel\/[^/]+\/configurations$/, async () => { blocked = await w.admin('newblock', 'block'); });
        const r = await w.claim(owner, { name: 'newblock' });
        assert.equal(blocked.body.status, 'blocked');
        assert.equal(r.status, 403, JSON.stringify(r.body));
        const row = await w.row('newblock');
        assert.equal(row.status, 'blocked');
        assert.equal(row.node_pubkey, owner.pubHex);
        assert.deepEqual(routing(w, 'newblock'), { dns: null, tunnels: [] });
        await stillAdministrable(w, 'newblock', 'block');
    } finally { w.restore(); }
});

test('race: an approval whose claim was withdrawn meanwhile, and the name queued for by another key, does not go live', async () => {
    const w = await world();
    try {
        const [first, second] = await Promise.all([makeKey(), makeKey()]);
        assert.equal((await w.claim(first, { name: 'sydney' })).body.status, 'pending');   // gated in the 0001 seed
        // While the approval makes its tunnel, the first key withdraws and a second key queues for the name.
        let withdrawn, queued;
        w.cf.during(/^POST \/accounts\/acct\/cfd_tunnel$/, async () => {
            withdrawn = await w.release(first);
            queued = await w.claim(second, { name: 'sydney' });
        });
        const ap = await w.admin('sydney', 'approve');
        assert.equal(withdrawn.body.status, 'released');
        assert.equal(queued.body.status, 'pending');
        assert.equal(ap.status, 409, JSON.stringify(ap.body));
        let row = await w.row('sydney');
        assert.equal(row.node_pubkey, second.pubHex);
        assert.equal(row.status, 'pending', 'the second key\'s claim still waits for the admin');
        assert.equal(row.decided_at, null);
        assert.deepEqual(routing(w, 'sydney'), { dns: null, tunnels: [] }, 'what the approval made is gone');

        // Approving the claim that is there now works as ever.
        assert.equal((await w.admin('sydney', 'approve')).body.status, 'live');
        row = await w.row('sydney');
        assert.equal(row.node_pubkey, second.pubHex);
        assert.equal(routing(w, 'sydney').dns, `${row.tunnel_id}.cfargotunnel.com`);
    } finally { w.restore(); }
});

// ── Admin resume: heal's rule ─────────────────────────────────────────────────────────────────────────────────
test('admin resume after an impostor pause on a kept tunnel re-attests: the intruder is not routed, the owner\'s node is', async () => {
    const w = await world();
    try {
        const { owner, row: before } = await impostorPaused(w, 'keptone', { keptTunnel: true });
        // The intruder still answers through the kept tunnel, and Cloudflare still refuses to delete it.
        w.cf.fail.deleteTunnel = true;
        const refused = await w.admin('keptone', 'resume');
        assert.equal(refused.status, 200, JSON.stringify(refused.body));
        assert.equal(refused.body.status, 'paused');
        assert.equal(refused.body.reason, 'impostor');
        assert.equal(refused.body.attest, 'impostor');
        let row = await w.row('keptone');
        assert.equal(row.status, 'paused');
        assert.equal(row.pause_reason, 'impostor');
        assert.equal(row.tunnel_id, before.tunnel_id);
        assert.equal(routing(w, 'keptone').dns, null, 'the intruder is not routed');
        assert.ok(w.events('keptone').some((e) => e.event === 'resume-refused'));

        // The owner's own node on the kept tunnel: the same resume goes live on it, once the re-attest passes.
        w.nodes['keptone.beanpool.org'] = attestsAs(owner);
        const ok = await w.admin('keptone', 'resume');
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        assert.equal(ok.body.status, 'live');
        assert.equal(ok.body.attest, 'ok');
        row = await w.row('keptone');
        assert.equal(row.status, 'live');
        assert.equal(row.tunnel_id, before.tunnel_id, 'the kept tunnel, reused');
        assert.equal(row.pause_reason, null);
        assert.ok(row.last_ok_at >= nowS() - 5);
        assert.equal(routing(w, 'keptone').dns, `${before.tunnel_id}.cfargotunnel.com`);
    } finally { w.restore(); }
});

test('admin resume after an impostor pause deletes a kept tunnel first when Cloudflare lets it: live at once on a fresh one', async () => {
    const w = await world();
    try {
        const { owner, row: before } = await impostorPaused(w, 'keptfresh', { keptTunnel: true });
        const r = await w.admin('keptfresh', 'resume');
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.status, 'live');
        const row = await w.row('keptfresh');
        assert.notEqual(row.tunnel_id, before.tunnel_id);
        assert.equal(w.cf.liveTunnel(before.tunnel_id), null, 'whatever rode the old tunnel is cut off');
        assert.deepEqual(routing(w, 'keptfresh'), { dns: `${row.tunnel_id}.cfargotunnel.com`, tunnels: [row.tunnel_id] });
        // The owner's node hears the fresh tunnel's token from /status, as after any impostor pause.
        assert.equal((await w.status(owner)).body.tunnelToken, `token-${row.tunnel_id}`);
    } finally { w.restore(); }
});

test('admin resume of its own pause re-attests the kept tunnel: with the node away it lifts the pause, and the node\'s heal routes it', async () => {
    const w = await world();
    try {
        const owner = await makeKey();
        await liveName(w, 'awaynode', owner);
        const before = await w.row('awaynode');
        await w.admin('awaynode', 'pause');
        delete w.nodes['awaynode.beanpool.org'];                // the node is away: nothing answers the re-attest
        const r = await w.admin('awaynode', 'resume');
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.status, 'paused');
        assert.equal(r.body.reason, 'unverified');
        assert.equal(r.body.attest, 'unverifiable');
        assert.equal(routing(w, 'awaynode').dns, null, 'not routed while nothing proves the owner answers');
        assert.equal((await w.row('awaynode')).pause_reason, 'unverified', 'the admin\'s hold is lifted');

        // Back, on the kept tunnel: its own heal re-attests and routes it.
        w.nodes['awaynode.beanpool.org'] = attestsAs(owner);
        const healed = await w.heal(owner);
        assert.equal(healed.body.status, 'live');
        assert.equal(healed.body.attest, 'ok');
        assert.equal(routing(w, 'awaynode').dns, `${before.tunnel_id}.cfargotunnel.com`);
    } finally { w.restore(); }
});

test('race: an admin block landing during a resume\'s edge re-attest stands; the resume changes nothing', async () => {
    const w = await world();
    try {
        const owner = await makeKey();
        await liveName(w, 'resumeblock', owner);
        await w.admin('resumeblock', 'pause');
        let blocked;
        w.nodes['resumeblock.beanpool.org'] = async (nonce) => { blocked = await w.admin('resumeblock', 'block'); return attestsAs(owner)(nonce); };
        const r = await w.admin('resumeblock', 'resume');
        assert.equal(blocked?.body.status, 'blocked', 'the block landed during the re-attest');
        assert.equal(r.status, 409, JSON.stringify(r.body));
        assert.equal(r.body.status, 'blocked');
        assert.equal((await w.row('resumeblock')).status, 'blocked');
        assert.deepEqual(routing(w, 'resumeblock'), { dns: null, tunnels: [] });
        await stillAdministrable(w, 'resumeblock', 'block');
    } finally { w.restore(); }
});

test('race: the owner\'s heal going live on the kept tunnel as the admin resumes it: resume stands down, the name stays routed', async () => {
    const w = await world();
    try {
        const { owner, row: before } = await impostorPaused(w, 'keptlive', { keptTunnel: true });
        w.nodes['keptlive.beanpool.org'] = attestsAs(owner);   // the owner's node is back on the kept tunnel
        // The heal runs, and goes live, just after the resume has read the row.
        let healed;
        w.afterRead(/^SELECT \* FROM name_allocations WHERE name=\?$/, async () => { healed = await w.heal(owner); });
        const r = await w.admin('keptlive', 'resume');
        assert.deepEqual([healed?.body.status, healed.body.attest], ['live', 'ok'], JSON.stringify(healed?.body));
        assert.equal(r.status, 400, JSON.stringify(r.body));
        assert.match(r.body.error, /cannot resume a live name/);
        const row = await w.row('keptlive');
        assert.deepEqual([row.status, row.tunnel_id], ['live', before.tunnel_id]);
        assert.ok(w.cf.liveTunnel(before.tunnel_id), 'the tunnel the owner\'s node is live on is not deleted');
        assert.deepEqual(routing(w, 'keptlive'), { dns: `${before.tunnel_id}.cfargotunnel.com`, tunnels: [before.tunnel_id] });
    } finally { w.restore(); }
});

test('race: the owner\'s heal landing while resume deletes the kept tunnel does not go live on it; the resume routes the name', async () => {
    const w = await world();
    try {
        const { owner, row: before } = await impostorPaused(w, 'keptdel', { keptTunnel: true });
        w.nodes['keptdel.beanpool.org'] = attestsAs(owner);
        let healed;
        w.cf.during(/^DELETE \/accounts\/acct\/cfd_tunnel\//, async () => { healed = await w.heal(owner); });
        const r = await w.admin('keptdel', 'resume');
        assert.ok(healed, 'the heal landed');
        assert.notEqual(healed.body.status, 'live', `not on the tunnel being deleted: ${JSON.stringify(healed.body)}`);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.status, 'live');
        const row = await w.row('keptdel');
        assert.equal(row.status, 'live');
        assert.notEqual(row.tunnel_id, before.tunnel_id);
        assert.equal(w.cf.liveTunnel(before.tunnel_id), null);
        assert.deepEqual(routing(w, 'keptdel'), { dns: `${row.tunnel_id}.cfargotunnel.com`, tunnels: [row.tunnel_id] });
        assert.equal((await w.status(owner)).body.tunnelToken, `token-${row.tunnel_id}`, 'the owner\'s node hears the fresh tunnel');
    } finally { w.restore(); }
});

test('a kept tunnel Cloudflare won\'t delete stays on the row when a pause lands while resume tries to delete it', async () => {
    const w = await world();
    try {
        const { row: before } = await impostorPaused(w, 'keptpause', { keptTunnel: true });
        w.cf.fail.deleteTunnel = true;
        let paused;
        w.cf.during(/^DELETE \/accounts\/acct\/cfd_tunnel\//, async () => { paused = await w.admin('keptpause', 'pause'); });
        const r = await w.admin('keptpause', 'resume');
        assert.equal(paused?.body.status, 'paused');
        assert.equal(r.status, 409, JSON.stringify(r.body));
        const row = await w.row('keptpause');
        assert.deepEqual([row.status, row.pause_reason, row.tunnel_id], ['paused', 'admin', before.tunnel_id], 'the tunnel is still recorded');
        assert.equal(routing(w, 'keptpause').dns, null);
        // So a later block can still remove it.
        w.cf.fail.deleteTunnel = false;
        assert.equal((await w.admin('keptpause', 'block')).body.status, 'blocked');
        assert.deepEqual(routing(w, 'keptpause'), { dns: null, tunnels: [] });
    } finally { w.restore(); }
});

// ── A decision that changes no status still stands ───────────────────────────────────────────────────────────
// Blocking a blocked name, or pausing a paused one, lands while the admin's resume is at Cloudflare — before each
// of the resume's Cloudflare calls in turn, and during its edge re-attest. The resume must not route over it.
const DIRECT = { mode: 'direct', public_ip: '198.51.100.7' };

// A live name the admin then blocked or paused; its owner's node answers at it (while it is routed).
async function heldByAdmin(w, name, action, mode) {
    const owner = await makeKey();
    const r = await w.claim(owner, { name, ...(mode === 'direct' ? DIRECT : {}) });
    assert.equal(r.body.status, 'live', JSON.stringify(r.body));
    w.nodes[`${name}.beanpool.org`] = attestsAs(owner);
    assert.equal((await w.admin(name, action)).status, 200);
    return owner;
}

for (const [action, mode] of [['block', 'tunnel'], ['block', 'direct'], ['pause', 'tunnel'], ['pause', 'direct']]) {
    const state = action === 'block' ? 'blocked' : 'paused';
    test(`race: a second ${action} landing mid-resume (${mode}) stands, at every Cloudflare call and during the re-attest`, async () => {
        const name = `again-${action}-${mode}`;
        const host = `${name}.beanpool.org`;
        // The resume undisturbed, for its Cloudflare calls and whether it re-attests.
        let calls, attests = 0;
        {
            const w = await world();
            try {
                const owner = await heldByAdmin(w, name, action, mode);
                w.nodes[host] = async (nonce) => { attests++; return attestsAs(owner)(nonce); };
                const n0 = w.cf.calls.length;
                const r = await w.admin(name, 'resume');
                assert.equal(r.body.status, 'live', JSON.stringify(r.body));
                calls = w.cf.calls.slice(n0);
            } finally { w.restore(); }
        }
        const points = [...calls.map((c, i) => ({ at: `before ${c}`, n: i + 1 })), ...(attests ? [{ at: 'during the re-attest' }] : [])];
        assert.ok(points.length >= 3, JSON.stringify(points));
        for (const p of points) {
            const w = await world();
            try {
                const owner = await heldByAdmin(w, name, action, mode);
                let again;
                const decide = async () => { again = await w.admin(name, action); };
                if (p.n) w.cf.at(p.n, decide);
                else w.nodes[host] = async (nonce) => { await decide(); return attestsAs(owner)(nonce); };
                const r = await w.admin(name, 'resume');
                const why = `second ${action} ${p.at}: resume answered ${r.status} ${JSON.stringify(r.body)}`;
                assert.equal(again?.status, 200, `the second ${action} landed — ${why}`);
                assert.equal(again.body.status, state, why);
                assert.equal(r.status, 409, why);
                assert.equal(r.body.status, state, why);
                const row = await w.row(name);
                assert.deepEqual([row.status, row.pause_reason], [state, 'admin'], why);
                assert.equal(routing(w, name).dns, null, `not routed — ${why}`);
                if (action === 'block') assert.deepEqual(routing(w, name).tunnels, [], why);
                else if (mode === 'tunnel') assert.deepEqual(routing(w, name).tunnels, [row.tunnel_id], `the pause keeps its tunnel — ${why}`);

                // The owner's next heal, and its next claim (today's nodes heal with one), don't route it.
                w.nodes[host] = attestsAs(owner);
                const body = mode === 'direct' ? DIRECT : {};
                for (const h of [await w.heal(owner, body), await w.claim(owner, { name, ...body })]) {
                    if (action === 'block') assert.equal(h.status, 403, `${why}; then ${JSON.stringify(h.body)}`);
                    else assert.deepEqual([h.body.status, h.body.reason, h.body.tunnelToken], ['paused', 'admin', undefined], why);
                }
                assert.equal(routing(w, name).dns, null, `still not routed after the owner's heal — ${why}`);
                assert.equal((await w.row(name)).status, state, why);
            } finally { w.restore(); }
        }
    });
}

// ── A request that lost the name leaves the new owner's record alone ─────────────────────────────────────────
// The admin releases a name while its old key's heal is at Cloudflare, and a new key claims it and goes live before
// the heal finds the record at the hostname — which is now the new owner's.
const OLD_IP = '198.51.100.1';
const NEW_IP = '203.0.113.9';
const MOVED_IP = '198.51.100.2';
const modeBody = (mode, ip) => (mode === 'direct' ? { mode, public_ip: ip } : { mode });

for (const [was, next] of [['tunnel', 'tunnel'], ['direct', 'direct'], ['direct', 'tunnel'], ['tunnel', 'direct']]) {
    test(`race: released mid-heal and claimed by another key: the old heal leaves the new owner's record alone (${was} → ${next})`, async () => {
        const w = await world();
        try {
            const name = `handover-${was}-${next}`;
            const host = `${name}.beanpool.org`;
            const [oldKey, newKey] = await Promise.all([makeKey(), makeKey()]);
            assert.equal((await w.claim(oldKey, { name, ...modeBody(was, OLD_IP) })).body.status, 'live');
            let released, claimed, theirs, mark;
            w.cf.during(/^GET \/zones\/zone\/dns_records$/, async () => {
                released = await w.admin(name, 'release');
                claimed = await w.claim(newKey, { name, ...modeBody(next, NEW_IP) });
                theirs = { ...w.cf.recordAt(host) };
                mark = w.cf.calls.length;
            });
            const r = await w.heal(oldKey, modeBody(was, OLD_IP));
            assert.equal(released?.body.status, 'released');
            assert.equal(claimed.body.status, 'live', JSON.stringify(claimed.body));
            assert.equal(r.status, 409, JSON.stringify(r.body));
            const row = await w.row(name);
            assert.deepEqual([row.node_pubkey, row.status], [newKey.pubHex, 'live']);
            const target = next === 'direct' ? NEW_IP : `${row.tunnel_id}.cfargotunnel.com`;
            assert.deepEqual([theirs.id, theirs.content], [row.dns_record_id, target], 'the new owner\'s claim put up its record');
            assert.deepEqual(w.cf.recordAt(host), theirs, 'the new owner\'s record, as its claim left it');
            assert.deepEqual(w.cf.calls.slice(mark).filter((c) => c.includes(theirs.id)), [], 'the old heal made no call on it');
            assert.deepEqual(routing(w, name), { dns: target, tunnels: next === 'tunnel' ? [row.tunnel_id] : [] });
            if (next === 'tunnel') assert.equal((await w.status(newKey)).body.tunnelToken, `token-${row.tunnel_id}`);
        } finally { w.restore(); }
    });
}

test('race: a record the new owner adopted, re-pointed by the old key\'s heal just after, is pointed back at the new owner (direct)', async () => {
    const w = await world();
    try {
        const name = 'adopted';
        const host = `${name}.beanpool.org`;
        const [oldKey, newKey] = await Promise.all([makeKey(), makeKey()]);
        assert.equal((await w.claim(oldKey, { name, ...modeBody('direct', OLD_IP) })).body.status, 'live');
        const mine = w.cf.recordAt(host).id;
        // The old key's node moved: its heal re-points its record. As that PATCH goes out, the admin releases the name
        // (Cloudflare refuses the record's delete, so the record stays), and a new key claims it, adopting the record.
        let released, claimed;
        w.cf.during(/^PATCH \/zones\/zone\/dns_records\//, async () => {
            w.cf.fail.deleteDns = true;
            released = await w.admin(name, 'release');
            claimed = await w.claim(newKey, { name, ...modeBody('direct', NEW_IP) });
            w.cf.fail.deleteDns = false;
        });
        const r = await w.heal(oldKey, modeBody('direct', MOVED_IP));
        assert.equal(released?.body.status, 'released');
        assert.equal(claimed.body.status, 'live', JSON.stringify(claimed.body));
        assert.equal(r.status, 409, JSON.stringify(r.body));
        const row = await w.row(name);
        assert.deepEqual([row.node_pubkey, row.status, row.dns_record_id], [newKey.pubHex, 'live', mine]);
        assert.deepEqual([w.cf.recordAt(host)?.id, w.cf.recordAt(host)?.content], [mine, NEW_IP], 'the new owner\'s address, not the old key\'s');
    } finally { w.restore(); }
});

test('race: a record the old key\'s heal put up that the new owner\'s row doesn\'t know goes; the new owner is routed again at once', async () => {
    const w = await world();
    try {
        const name = 'unknown-record';
        const host = `${name}.beanpool.org`;
        const [oldKey, newKey] = await Promise.all([makeKey(), makeKey()]);
        assert.equal((await w.claim(oldKey, { name, ...modeBody('direct', OLD_IP) })).body.status, 'live');
        // The old key moves to a tunnel: its heal replaces its A record with a CNAME. As it deletes the A record, the
        // admin releases the name (the record's delete refused) and a new key claims it, adopting that record; then
        // the heal's delete lands on it and the heal puts up its CNAME.
        let claimed;
        w.cf.during(/^DELETE \/zones\/zone\/dns_records\//, async () => {
            w.cf.fail.deleteDns = true;
            await w.admin(name, 'release');
            claimed = await w.claim(newKey, { name, ...modeBody('direct', NEW_IP) });
            w.cf.fail.deleteDns = false;
        });
        const r = await w.heal(oldKey, { mode: 'tunnel' });
        assert.equal(claimed.body.status, 'live', JSON.stringify(claimed.body));
        assert.equal(r.status, 409, JSON.stringify(r.body));
        assert.equal((await w.row(name)).node_pubkey, newKey.pubHex);
        // Nothing routes the name to the old key — and, the new owner being live, its own record is back at once
        // (PR 1b: this asserted `dns: null` before, i.e. a live name left dark, which nothing re-made).
        assert.deepEqual(routing(w, name), { dns: NEW_IP, tunnels: [] }, 'nothing routes the name to the old key; the new owner is routed');
        await routedAsRow(w, name, 'after the old key\'s heal');

        // The new owner's next heal finds it routed, and the row knows it.
        w.nodes[host] = attestsAs(newKey);
        const h = await w.heal(newKey, modeBody('direct', NEW_IP));
        assert.equal(h.body.status, 'live', JSON.stringify(h.body));
        const row = await w.row(name);
        assert.deepEqual([w.cf.recordAt(host)?.id, w.cf.recordAt(host)?.content], [row.dns_record_id, NEW_IP]);
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
            r.fails ?? 0, r.lastAttest ?? null, r.requested, 'decided' in r ? r.decided : r.requested, 'auto');
}

test('migration 0002: incident victims go back to their original key, paused; a later other-key holder is recorded, not evicted', async () => {
    const w = await world({ migrations: ['0001_init.sql'] });
    try {
        const [yarra, victim2, taker, oldtimer, offliner, impostored, handmade] = await Promise.all(Array.from({ length: 7 }, makeKey));
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
        // A victim whose row was made by hand, with no decided_at: its claim time says it was live before the cut-off.
        oldRow(w.sqlite, { name: 'handmade', key: handmade, status: 'revoked', fails: 2, requested: CUTOFF - 20 * DAY, decided: null });

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
        const hm = await w.row('handmade');
        assert.equal(hm.status, 'paused');
        assert.equal(hm.pause_reason, 'incident-2026-09-24', 'a victim, not an impostor');
        assert.equal(hm.node_pubkey, handmade.pubHex);
        assert.deepEqual(w.events('handmade').map((e) => e.event), ['incident-restore']);
        assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM name_allocations WHERE status='revoked'").get().n, 0);

        // A second run stops at its first statement and changes nothing.
        const snapshot = () => JSON.stringify([
            w.sqlite.prepare('SELECT * FROM name_allocations ORDER BY name').all(),
            w.sqlite.prepare('SELECT * FROM name_events ORDER BY id').all(),
        ]);
        const before = snapshot();
        assert.throws(() => w.sqlite.exec(migration('0002_states.sql')), /duplicate column/);
        assert.equal(snapshot(), before);
        w.sqlite.exec(migration('0003_decision_seq.sql'));   // the Worker below reads 0003's column
        w.sqlite.exec(migration('0004_teardown.sql'));       // … and may write 0004's table

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

// ── No name left dark, no tunnel orphaned (registrar PR 1b) ──────────────────────────────────────────────────────
// PR 1's last confirmation (on f806687c) found orderings that end with a live name whose hostname routes nothing —
// which nothing re-makes today: a node never heals a name /status calls live — or with a bp-<name> tunnel no row
// records, which makes Cloudflare refuse every later tunnel for the name. Each is replayed below; `routedAsRow` is
// the invariant they broke.

// A live row's hostname routes exactly what the row says: the record it records, pointing at its tunnel (alive) or
// its address. A row that isn't live has no record at its hostname. And no bp-<name> tunnel is alive but the row's.
async function routedAsRow(w, name, why) {
    const row = await w.row(name);
    const rec = w.cf.recordAt(`${name}.beanpool.org`);
    const stray = routing(w, name).tunnels.filter((id) => id !== row?.tunnel_id);
    assert.deepEqual(stray, [], `${why}: no tunnel for the name but the row's`);
    if (row?.status !== 'live') { assert.equal(rec, null, `${why}: ${row?.status ?? 'no'} row, nothing at its hostname`); return row; }
    assert.ok(rec, `${why}: live, so its hostname has a record`);
    assert.equal(rec.id, row.dns_record_id, `${why}: the record is the one the row records`);
    assert.equal(rec.content, row.mode === 'direct' ? row.public_ip : `${row.tunnel_id}.cfargotunnel.com`, `${why}: pointing where the row says`);
    if (row.mode === 'tunnel') assert.ok(w.cf.liveTunnel(row.tunnel_id), `${why}: its tunnel is alive`);
    return row;
}

const unreachableTunnel = async () => new Response('no connector on this tunnel', { status: 530 });

test('race: an admin resume landing during the owner\'s heal re-attest: the name ends live, with its record', async () => {
    const w = await world();
    try {
        const name = 'resumeheal';
        const { owner, row: before } = await impostorPaused(w, name, { keptTunnel: true });
        // The owner's heal re-attests through the kept tunnel. Meanwhile the admin resumes: that deletes the kept
        // tunnel, makes a fresh one, re-points the same record and goes live at once — so the heal's re-attest,
        // through the tunnel just deleted, fails.
        let resumed;
        w.nodes[`${name}.beanpool.org`] = async () => { resumed = await w.admin(name, 'resume'); return unreachableTunnel(); };
        const r = await w.heal(owner);
        assert.equal(resumed?.body.status, 'live', JSON.stringify(resumed?.body));
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.status, 'live', 'the heal answers the row as it now is');
        const row = await routedAsRow(w, name, 'after the heal');
        assert.notEqual(row.tunnel_id, before.tunnel_id);
        assert.equal((await w.status(owner)).body.tunnelToken, `token-${row.tunnel_id}`);
    } finally { w.restore(); }
});

test('race: two heals from one key, the second landing just before the first goes live: the row and Cloudflare agree', async () => {
    const w = await world();
    try {
        const name = 'twoheals';
        const owner = await makeKey();
        await liveName(w, name, owner);
        // Paused with its tunnel and record gone (as the 09-24 incident left its victims), so a heal makes a fresh tunnel.
        const old = await w.row(name);
        w.cf.dns.delete(old.dns_record_id);
        w.cf.tunnels.get(old.tunnel_id).deleted_at = new Date().toISOString();
        await w.backdate(name, { status: 'paused', pause_reason: 'incident-2026-09-24', paused_at: nowS() });
        // A second heal (the node's UI claiming beside its agent) lands just before the first one's go-live write.
        // The node has no token for the fresh tunnel yet, so the second heal's re-attest fails.
        w.nodes[`${name}.beanpool.org`] = unreachableTunnel;
        let second;
        w.beforeRun(/^UPDATE name_allocations SET status=\?, pause_reason=\?, paused_at=\?, attest_fails=\? WHERE/, async () => { second = await w.heal(owner); });
        const first = await w.claim(owner, { name });
        assert.ok(second, 'the second heal landed');
        const why = `first ${first.status} ${JSON.stringify(first.body)}; second ${second.status} ${JSON.stringify(second.body)}`;
        const row = await routedAsRow(w, name, why);
        // Either way, the node's next claim routes it.
        if (row.status !== 'live') {
            w.nodes[`${name}.beanpool.org`] = attestsAs(owner);
            const again = await w.claim(owner, { name });
            assert.equal(again.body.status, 'live', `${why}; then ${JSON.stringify(again.body)}`);
            await routedAsRow(w, name, `${why}; then the next claim`);
        }
    } finally { w.restore(); }
});

test('race: a bare heal overtaken by the same key\'s heal to a tunnel: the row and Cloudflare agree, nothing stray', async () => {
    const w = await world();
    try {
        const name = 'modeswitch';
        const owner = await makeKey();
        assert.equal((await w.claim(owner, { name, ...modeBody('direct', OLD_IP) })).body.status, 'live');
        // The bare heal has read the row (direct); before it goes on, the same key's heal moves the name to a tunnel.
        let moved;
        w.afterRead(/FROM name_allocations WHERE node_pubkey=\?/, async () => { moved = await w.heal(owner, { mode: 'tunnel' }); });
        const bare = await w.heal(owner);
        assert.equal(moved?.body.status, 'live', JSON.stringify(moved?.body));
        const row = await routedAsRow(w, name, `the bare heal answered ${bare.status} ${JSON.stringify(bare.body)}`);
        assert.deepEqual([row.status, row.mode], ['live', 'tunnel']);
    } finally { w.restore(); }
});

test('the sweep puts back a live name\'s missing record, and its tunnel, whatever left it dark; a node merely asleep is only looked at', async () => {
    const w = await world();
    try {
        const [owner, sleeper, n1] = await Promise.all([makeKey(), makeKey(), makeKey()]);
        await liveName(w, 'darkname', owner);
        await liveName(w, 'sleepy', sleeper);
        await liveName(w, 'darkname-a', n1);
        const before = await w.row('darkname');
        const asleep = await w.row('sleepy');
        w.nodes['sleepy.beanpool.org'] = unreachableTunnel;   // routed, but its node's connector is down
        // The record goes, with no request or decision behind it: the end state of every ordering above.
        w.cf.dns.delete(before.dns_record_id);
        const mark = w.cf.calls.length;
        const s = await attestSweep(w.env);
        assert.equal(s.unverifiable, 2);
        let row = await routedAsRow(w, 'darkname', 'after the sweep');
        assert.equal(row.tunnel_id, before.tunnel_id, 'its tunnel was still there: kept');
        assert.ok(w.events('darkname').some((e) => e.event === 'repaired'), JSON.stringify(w.events('darkname')));
        assert.deepEqual(await w.row('sleepy'), asleep, 'the sleeping node\'s row is untouched');
        assert.deepEqual(w.cf.calls.slice(mark).filter((c) => c.includes(asleep.tunnel_id) || c.includes(asleep.dns_record_id)),
            [`GET /accounts/acct/cfd_tunnel/${asleep.tunnel_id}`], 'the sleeping node\'s routing was only looked at');
        assert.equal((await attestSweep(w.env)).ok, 2, 'the next sweep reaches it');

        // Record and tunnel both gone: a fresh tunnel, whose token its owner's node gets from /status.
        w.cf.dns.delete(row.dns_record_id);
        w.cf.tunnels.get(row.tunnel_id).deleted_at = new Date().toISOString();
        await attestSweep(w.env);
        row = await routedAsRow(w, 'darkname', 'after the second sweep');
        assert.notEqual(row.tunnel_id, before.tunnel_id);
        assert.equal((await w.status(owner)).body.tunnelToken, `token-${row.tunnel_id}`);
    } finally { w.restore(); }
});

test('the sweep puts back every dark live name even when so many are dark that it suspends its verdicts', async () => {
    const w = await world();
    try {
        const names = ['one', 'two', 'three'];
        for (const n of names) await liveName(w, `dark-${n}`, await makeKey());
        for (const n of names) w.cf.dns.delete((await w.row(`dark-${n}`)).dns_record_id);
        const s = await attestSweep(w.env);
        assert.equal(s.action, 'suspended:unverifiable');
        for (const n of names) await routedAsRow(w, `dark-${n}`, `dark-${n} after the suspended sweep`);
        assert.equal((await attestSweep(w.env)).ok, 3);
    } finally { w.restore(); }
});

for (const action of ['pause', 'block']) {
    test(`race: an admin ${action}'s clean-up racing the admin's release and a new key's claim: the new owner keeps its record`, async () => {
        const w = await world();
        try {
            const name = `taken-${action}`;
            const [oldKey, newKey] = await Promise.all([makeKey(), makeKey()]);
            await liveName(w, name, oldKey);
            // As Cloudflare takes the decision's record delete, the admin releases the name and a new key claims it.
            let released, claimed;
            w.cf.during(/^DELETE \/zones\/zone\/dns_records\//, async () => {
                released = await w.admin(name, 'release');
                claimed = await w.claim(newKey, { name });
            });
            const d = await w.admin(name, action);
            assert.equal(d.status, 200, JSON.stringify(d.body));
            assert.equal(released?.body.status, 'released');
            assert.equal(claimed.body.status, 'live', JSON.stringify(claimed.body));
            const row = await routedAsRow(w, name, `after the ${action}`);
            assert.deepEqual([row.node_pubkey, row.status], [newKey.pubHex, 'live']);
            assert.equal((await w.status(newKey)).body.tunnelToken, `token-${row.tunnel_id}`);
        } finally { w.restore(); }
    });

    test(`race: an admin ${action}'s clean-up racing an admin resume: the resumed name keeps its record`, async () => {
        const w = await world();
        try {
            const name = `resumed-${action}`;
            const owner = await makeKey();
            await liveName(w, name, owner);
            // Another tab resumes as Cloudflare takes the decision's record delete: it finds the name routed, re-attests
            // (a pause's kept tunnel) or makes a fresh tunnel (after a block), and goes live.
            let resumed;
            w.cf.during(/^DELETE \/zones\/zone\/dns_records\//, async () => { resumed = await w.admin(name, 'resume'); });
            const d = await w.admin(name, action);
            assert.equal(d.status, 200, JSON.stringify(d.body));
            assert.equal(resumed?.body.status, 'live', JSON.stringify(resumed?.body));
            const row = await routedAsRow(w, name, `after the ${action}`);
            assert.equal(row.status, 'live');
            assert.equal((await w.status(owner)).body.tunnelToken, `token-${row.tunnel_id}`);
        } finally { w.restore(); }
    });
}

test('a take-over whose tunnel delete Cloudflare refused: the sweep retries it, and once Cloudflare recovers the new key\'s claim goes live', async () => {
    const w = await world();
    try {
        const name = 'refusedtunnel';
        const [oldKey, newKey] = await Promise.all([makeKey(), makeKey()]);
        await liveName(w, name, oldKey);
        const old = (await w.row(name)).tunnel_id;
        w.cf.fail.deleteTunnel = true;
        assert.equal((await w.admin(name, 'release')).body.status, 'released');
        assert.equal((await w.row(name)).tunnel_id, old, 'the released row keeps the tunnel Cloudflare would not delete');

        // The new key's claim wins the name, but Cloudflare still refuses to delete the old bp-<name> tunnel, so no
        // tunnel can be made for it: no token, the name pending for the new key.
        const during = await w.claim(newKey, { name });
        assert.notEqual(during.status, 200, JSON.stringify(during.body));
        assert.equal(during.body.tunnelToken, undefined);
        let row = await w.row(name);
        assert.deepEqual([row.node_pubkey, row.status], [newKey.pubHex, 'pending']);
        await attestSweep(w.env);
        assert.ok(w.cf.liveTunnel(old), 'still refused');

        // Cloudflare recovers: the next sweep deletes the old tunnel, before anyone claims again.
        w.cf.fail.deleteTunnel = false;
        await attestSweep(w.env);
        assert.equal(w.cf.liveTunnel(old), null, 'the sweep retried the delete');

        const after = await w.claim(newKey, { name });
        assert.equal(after.status, 200, JSON.stringify(after.body));
        assert.equal(after.body.status, 'live');
        row = await routedAsRow(w, name, 'after the claim');
        assert.equal(after.body.tunnelToken, `token-${row.tunnel_id}`);
    } finally { w.restore(); }
});

test('a take-over whose tunnel delete was refused, claimed again once Cloudflare recovers but before a sweep: the claim deletes it itself', async () => {
    const w = await world();
    try {
        const name = 'claimclears';
        const [oldKey, newKey] = await Promise.all([makeKey(), makeKey()]);
        await liveName(w, name, oldKey);
        const old = (await w.row(name)).tunnel_id;
        w.cf.fail.deleteTunnel = true;
        await w.admin(name, 'release');
        assert.notEqual((await w.claim(newKey, { name })).status, 200);
        w.cf.fail.deleteTunnel = false;
        const after = await w.claim(newKey, { name });
        assert.equal(after.body.status, 'live', JSON.stringify(after.body));
        assert.equal(w.cf.liveTunnel(old), null);
        await routedAsRow(w, name, 'after the claim');
    } finally { w.restore(); }
});

test('a bp-<name> tunnel no row records: a claim deletes it when provably stale, else answers 503 and leaves it', async () => {
    const w = await world();
    try {
        // Older than the claiming tenure (lost track of before this fix): deleted, and the claim goes live.
        const [oldKey, newKey] = await Promise.all([makeKey(), makeKey()]);
        await liveName(w, 'strayed', oldKey);
        const stray = (await w.row('strayed')).tunnel_id;
        await w.backdate('strayed', { tunnel_id: null });
        w.cf.tunnels.get(stray).created_at = new Date(Date.now() - 3600_000).toISOString();
        await w.admin('strayed', 'release');
        const r = await w.claim(newKey, { name: 'strayed' });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.status, 'live');
        assert.equal(w.cf.liveTunnel(stray), null, 'the stray tunnel went');
        await routedAsRow(w, 'strayed', 'after the take-over');

        // Made moments ago in this tenure and not recorded yet — maybe a request in flight: left alone, 503.
        const owner = await makeKey();
        await liveName(w, 'inflight', owner);
        const mine = await w.row('inflight');
        w.cf.tunnels.get(mine.tunnel_id).deleted_at = new Date().toISOString();    // its own tunnel is gone …
        w.cf.tunnels.set('tun-young', { id: 'tun-young', name: 'bp-inflight', created_at: new Date().toISOString(), deleted_at: null });
        const busy = await w.heal(owner);
        assert.equal(busy.status, 503, JSON.stringify(busy.body));
        assert.match(busy.body.error, /try again/);
        assert.ok(w.cf.liveTunnel('tun-young'), 'a tunnel that may be a request\'s in flight is not deleted');
        assert.deepEqual(await w.row('inflight'), mine, 'nothing written');
        // … ten minutes on, nobody has recorded it: it is nobody's, and goes.
        w.cf.tunnels.get('tun-young').created_at = new Date(Date.now() - 11 * 60_000).toISOString();
        const healed = await w.heal(owner);
        assert.equal(healed.body.status, 'live', JSON.stringify(healed.body));
        assert.equal(w.cf.liveTunnel('tun-young'), null);
        const row = await routedAsRow(w, 'inflight', 'after the heal');
        assert.equal(healed.body.tunnelToken, `token-${row.tunnel_id}`);
    } finally { w.restore(); }
});

for (const action of ['pause', 'block', 'release']) {
    test(`an admin ${action} whose record delete Cloudflare refused: the sweep removes the record once Cloudflare recovers`, async () => {
        const w = await world();
        try {
            const name = `refused-${action}`;
            const owner = await makeKey();
            await liveName(w, name, owner);
            w.cf.fail.deleteDns = true;
            assert.equal((await w.admin(name, action)).status, 200);
            assert.ok(w.cf.recordAt(`${name}.beanpool.org`), `Cloudflare refused the ${action}'s record delete`);
            await attestSweep(w.env);
            assert.ok(w.cf.recordAt(`${name}.beanpool.org`), 'still refused');

            w.cf.fail.deleteDns = false;
            await attestSweep(w.env);
            await routedAsRow(w, name, `after the ${action}, Cloudflare recovered, and a sweep`);
        } finally { w.restore(); }
    });
}

test('a heal moving a name from its tunnel to a direct address never takes the tunnel down first; a tunnel it can\'t delete after is owed', async () => {
    const w = await world();
    try {
        const name = 'movesdirect';
        const owner = await makeKey();
        await liveName(w, name, owner);
        const tunnel = (await w.row(name)).tunnel_id;
        // The CNAME must give way to an A record, and Cloudflare refuses the delete: the move fails — and the name is
        // still routed on its tunnel.
        w.cf.fail.deleteDns = true;
        assert.equal((await w.heal(owner, modeBody('direct', NEW_IP))).status, 502);
        w.cf.fail.deleteDns = false;
        let row = await routedAsRow(w, name, 'after the refused move');
        assert.deepEqual([row.status, row.mode, row.tunnel_id], ['live', 'tunnel', tunnel]);

        // Moved; the old tunnel's delete refused: owed, and the sweep deletes it once Cloudflare recovers.
        w.cf.fail.deleteTunnel = true;
        const moved = await w.heal(owner, modeBody('direct', NEW_IP));
        assert.equal(moved.body.status, 'live', JSON.stringify(moved.body));
        w.cf.fail.deleteTunnel = false;
        assert.ok(w.cf.liveTunnel(tunnel), 'refused');
        await attestSweep(w.env);
        assert.equal(w.cf.liveTunnel(tunnel), null, 'the sweep deleted the old tunnel');
        row = await routedAsRow(w, name, 'after the move');
        assert.deepEqual([row.mode, row.public_ip, row.tunnel_id], ['direct', NEW_IP, null]);
    } finally { w.restore(); }
});

test('a take-over that changes mode, the old record\'s delete refused: the old key\'s node is never the new key\'s live name, and the sweep removes its record once Cloudflare recovers', async () => {
    const w = await world();
    try {
        const name = 'oldaddress';
        const host = `${name}.beanpool.org`;
        const [oldKey, newKey] = await Promise.all([makeKey(), makeKey()]);
        assert.equal((await w.claim(oldKey, { name, ...modeBody('direct', OLD_IP) })).body.status, 'live');
        w.cf.fail.deleteDns = true;
        await w.admin(name, 'release');
        assert.equal(routing(w, name).dns, OLD_IP, 'Cloudflare refused the release\'s delete');

        // The new key claims it for a tunnel: its CNAME must replace the old key's A record, whose delete is refused.
        const during = await w.claim(newKey, { name });
        assert.notEqual(during.body.status, 'live', JSON.stringify(during.body));
        assert.equal(during.body.tunnelToken, undefined);
        assert.deepEqual([(await w.row(name)).node_pubkey, (await w.row(name)).status], [newKey.pubHex, 'pending']);
        assert.deepEqual(routing(w, name).tunnels, [], 'no tunnel of the failed claim is left');

        // Cloudflare recovers: the next sweep deletes the old key's record, before the new key claims again.
        w.cf.fail.deleteDns = false;
        await attestSweep(w.env);
        assert.equal(w.cf.recordAt(host), null, 'the old key\'s node is no longer reachable at the name');

        const after = await w.claim(newKey, { name });
        assert.equal(after.body.status, 'live', JSON.stringify(after.body));
        const row = await routedAsRow(w, name, 'after the claim');
        assert.equal(routing(w, name).dns, `${row.tunnel_id}.cfargotunnel.com`);
    } finally { w.restore(); }
});

// A re-attest that fails takes routing back off (routeIfOnlyOwner) — heal, take-back and resume alike. The row is
// then paused, which the sweep's attest and its upkeep never look at, so a record Cloudflare refused to delete is
// owed: otherwise it would keep routing whoever failed the re-attest — here an impostor — for good.
for (const via of ['heal', 'take-back', 'resume']) {
    test(`a ${via} whose re-attest finds an impostor, its record delete refused: the sweep removes the record once Cloudflare recovers`, async () => {
        const w = await world();
        try {
            const name = `reattest-${via}`;
            const host = `${name}.beanpool.org`;
            const [owner, intruder, n1, n2] = await Promise.all([makeKey(), makeKey(), makeKey(), makeKey()]);
            assert.equal((await w.claim(owner, { name, ...modeBody('direct', OLD_IP) })).body.status, 'live');
            await liveName(w, `${name}-a`, n1); await liveName(w, `${name}-b`, n2);
            w.nodes[host] = attestsAs(intruder);
            await attestSweep(w.env); await attestSweep(w.env);
            assert.deepEqual([(await w.row(name)).status, (await w.row(name)).pause_reason], ['paused', 'impostor']);
            if (via === 'take-back') assert.equal((await w.release(owner)).body.status, 'released');

            // The intruder still answers at the owner's address: routing goes back up for the re-attest, which sees
            // it, and Cloudflare refuses to take the record down again.
            w.cf.fail.deleteDns = true;
            const r = via === 'heal' ? await w.heal(owner) : via === 'take-back' ? await w.claim(owner, { name, ...modeBody('direct', OLD_IP) }) : await w.admin(name, 'resume');
            assert.equal(r.status, 200, JSON.stringify(r.body));
            assert.deepEqual([r.body.status, r.body.reason, r.body.attest], ['paused', 'impostor', 'impostor']);
            const row = await w.row(name);
            assert.deepEqual([row.status, row.pause_reason, row.node_pubkey], ['paused', 'impostor', owner.pubHex]);
            assert.equal(routing(w, name).dns, OLD_IP, 'Cloudflare refused the delete');
            await attestSweep(w.env);
            assert.equal(routing(w, name).dns, OLD_IP, 'still refused');

            w.cf.fail.deleteDns = false;
            await attestSweep(w.env);
            await routedAsRow(w, name, `after the ${via}, Cloudflare recovered, and a sweep`);
            assert.equal((await w.row(name)).node_pubkey, owner.pubHex, 'still the owner\'s');
        } finally { w.restore(); }
    });
}

// ── An owed record is settled only once nothing routes it wrongly ────────────────────────────────────────────
// The sweep settles an owed record that a live row records by repairing that row's routing (settleOwed). The entry
// goes only once the hostname routes as the row says, and only while the row is still the one it repaired: a
// take-down landing meanwhile owes the same id onto this entry (INSERT OR IGNORE, a no-op), and a repair Cloudflare
// refused leaves the record pointing wherever a missed request left it. Either way, dropping the entry then would
// leave nothing to remove or re-point the record once Cloudflare recovers.
for (const mode of ['tunnel', 'direct']) {
    test(`a block landing while the sweep settles the name's owed record, deletes refused: nothing routes it once Cloudflare recovers (${mode})`, async () => {
        const w = await world();
        try {
            const name = `killswitch-${mode}`;
            const [owner, n1, n2] = await Promise.all([makeKey(), makeKey(), makeKey()]);
            assert.equal((await w.claim(owner, { name, ...modeBody(mode, OLD_IP) })).body.status, 'live');
            w.nodes[`${name}.beanpool.org`] = attestsAs(owner);
            await liveName(w, `${name}-a`, n1); await liveName(w, `${name}-b`, n2);
            // An outage refusing deletes: a pause (its record owed), then a resume, live again on that record.
            w.cf.fail.deleteDns = true; w.cf.fail.deleteTunnel = true;
            assert.equal((await w.admin(name, 'pause')).body.status, 'paused');
            assert.equal((await w.admin(name, 'resume')).body.status, 'live');
            // The sweep settles that entry; as its repair looks the record up, the admin blocks the name.
            let blocked;
            w.cf.during(/^GET \/zones\/zone\/dns_records$/, async () => { blocked = await w.admin(name, 'block'); });
            await attestSweep(w.env);
            assert.equal(blocked?.body.status, 'blocked');
            assert.ok(w.sqlite.prepare('SELECT 1 FROM teardown WHERE kind=\'dns\' AND name=?').get(name), 'the block\'s refused record is still owed');
            w.cf.fail.deleteDns = false; w.cf.fail.deleteTunnel = false;
            await attestSweep(w.env);
            assert.equal(routing(w, name).dns, null, 'a blocked name has nothing at its hostname');
        } finally { w.restore(); }
    });
}

test('an owed record the live row records, re-pointed by a missed heal: the sweep keeps it owed until it routes the row again', async () => {
    const w = await world();
    try {
        const name = 'repointed';
        const [oldKey, newKey] = await Promise.all([makeKey(), makeKey()]);
        assert.equal((await w.claim(oldKey, { name, ...modeBody('direct', OLD_IP) })).body.status, 'live');
        // The 'adopted' race above; Cloudflare refuses record deletes from the release on …
        w.cf.during(/^PATCH \/zones\/zone\/dns_records\//, async () => {
            w.cf.fail.deleteDns = true;
            await w.admin(name, 'release');
            assert.equal((await w.claim(newKey, { name, ...modeBody('direct', NEW_IP) })).body.status, 'live');
            // … and the undo's PATCH-back, and every PATCH after it.
            w.cf.during(/^PATCH \/zones\/zone\/dns_records\//, async () => { w.cf.fail.patchDns = true; });
        });
        assert.equal((await w.heal(oldKey, modeBody('direct', MOVED_IP))).status, 409);
        assert.equal(routing(w, name).dns, MOVED_IP, 'the undo could neither point the record back nor delete it');
        // Something answers there that isn't a BeanPool node: not dark, so only the owed entry brings the sweep here.
        w.nodes[`${name}.beanpool.org`] = async () => new Response('not a BeanPool node', { status: 200 });
        await attestSweep(w.env);                                   // still refusing
        w.cf.fail.patchDns = false; w.cf.fail.deleteDns = false;
        await attestSweep(w.env);
        assert.equal((await w.row(name)).node_pubkey, newKey.pubHex);
        assert.equal(routing(w, name).dns, NEW_IP, 'the new owner\'s address, not the old key\'s');
        await routedAsRow(w, name, 'after Cloudflare recovered and a sweep');
    } finally { w.restore(); }
});

// ── A request whose routing target changed underneath it misses ──────────────────────────────────────────────
// The conditional writes compare the row's routing target (mode, address, origin) as well as its tunnel and record
// ids: a move to a new address keeps the record's id (a PATCH), so ids alone can't tell that a request is acting on a
// target the row no longer records. Left to it, the row and Cloudflare disagree for good: nodes never heal a live name.
test('race: a bare heal overtaken by the same key\'s heal to a new address: Cloudflare routes the address the row records', async () => {
    const w = await world();
    try {
        const name = 'movedip';
        const owner = await makeKey();
        assert.equal((await w.claim(owner, { name, ...modeBody('direct', OLD_IP) })).body.status, 'live');
        w.cf.during(/^GET \/zones\/zone\/dns_records$/, async () => { await w.heal(owner, modeBody('direct', NEW_IP)); });
        await w.heal(owner);
        assert.equal(routing(w, name).dns, (await w.row(name)).public_ip);
        await routedAsRow(w, name, 'after both heals');
    } finally { w.restore(); }
});

// The admin's pause is the admin's to lift, but the owner's heal still records where its node now is (heal's
// admin-pause branch). That write, too, holds only while the row is as the heal read it.
for (const [was, next] of [['tunnel', 'direct'], ['direct', 'tunnel']]) {
    for (const order of ['the heal lands mid-resume', 'the resume lands mid-heal']) {
        test(`race: the owner's heal moving its admin-paused name (${was} → ${next}) as the admin resumes it, ${order}: the row and Cloudflare agree`, async () => {
            const w = await world();
            try {
                const name = `pausedmove-${was}`;
                const owner = await makeKey();
                assert.equal((await w.claim(owner, { name, ...modeBody(was, OLD_IP) })).body.status, 'live');
                w.nodes[`${name}.beanpool.org`] = attestsAs(owner);
                assert.equal((await w.admin(name, 'pause')).body.status, 'paused');
                let healed, resumed;
                if (order === 'the heal lands mid-resume') {
                    w.cf.during(/^GET \/zones\/zone\/dns_records$/, async () => { healed = await w.heal(owner, modeBody(next, NEW_IP)); });
                    resumed = await w.admin(name, 'resume');
                } else {
                    // The heal has read the row (paused by the admin); the resume runs whole before the heal writes.
                    w.afterRead(/FROM name_allocations WHERE node_pubkey=\?/, async () => { resumed = await w.admin(name, 'resume'); });
                    healed = await w.heal(owner, modeBody(next, NEW_IP));
                }
                const why = `${order}: resume ${resumed?.status} ${JSON.stringify(resumed?.body)}; heal ${healed?.status} ${JSON.stringify(healed?.body)}`;
                assert.ok(resumed && healed, why);
                const row = await routedAsRow(w, name, why);
                assert.equal(await w.status(owner).then((s) => s.body.tunnelToken), row.status === 'live' && row.mode === 'tunnel' ? `token-${row.tunnel_id}` : undefined, why);

                // Either way the name ends on its node's new target: the admin resumes it if it is still paused, and the
                // node heals.
                if (row.status !== 'live') assert.equal((await w.admin(name, 'resume')).body.status, 'live', why);
                const h = await w.heal(owner, modeBody(next, NEW_IP));
                assert.equal(h.body.status, 'live', `${why}; then ${JSON.stringify(h.body)}`);
                const after = await routedAsRow(w, name, `${why}; then the node's heal`);
                assert.equal(after.mode, next, why);
            } finally { w.restore(); }
        });
    }
}

// The same for a gated claim still waiting for the admin: its owner's heal records where its node now is (heal's
// awaiting-approval branch), and the admin's approval goes live.
for (const order of ['the heal lands mid-approval', 'the approval lands mid-heal']) {
    test(`race: the owner's heal moving its gated claim to a direct address as the admin approves it, ${order}: the row and Cloudflare agree`, async () => {
        const w = await world();
        try {
            const owner = await makeKey();
            assert.equal((await w.claim(owner, { name: 'perth' })).body.status, 'pending');   // gated in the 0001 seed
            w.nodes['perth.beanpool.org'] = attestsAs(owner);
            let healed, approved;
            if (order === 'the heal lands mid-approval') {
                w.cf.during(/^GET \/zones\/zone\/dns_records$/, async () => { healed = await w.heal(owner, modeBody('direct', NEW_IP)); });
                approved = await w.admin('perth', 'approve');
            } else {
                // The heal has read the row (pending); the approval runs whole before the heal writes.
                w.afterRead(/FROM name_allocations WHERE node_pubkey=\?/, async () => { approved = await w.admin('perth', 'approve'); });
                healed = await w.heal(owner, modeBody('direct', NEW_IP));
            }
            const why = `${order}: approve ${approved?.status} ${JSON.stringify(approved?.body)}; heal ${healed?.status} ${JSON.stringify(healed?.body)}`;
            assert.ok(approved && healed, why);
            await routedAsRow(w, 'perth', why);

            // Either way the name ends on its node's new address: the admin approves it if it is still pending, and
            // the node heals.
            if ((await w.row('perth')).status !== 'live') assert.equal((await w.admin('perth', 'approve')).body.status, 'live', why);
            const h = await w.heal(owner, modeBody('direct', NEW_IP));
            assert.equal(h.body.status, 'live', `${why}; then ${JSON.stringify(h.body)}`);
            const after = await routedAsRow(w, 'perth', `${why}; then the node's heal`);
            assert.deepEqual([after.mode, after.public_ip], ['direct', NEW_IP], why);
        } finally { w.restore(); }
    });
}

// Upkeep looks at a live name nothing answers at. Behind a proxied A record that is Cloudflare's 52x (521–523: the
// address refuses, times out or is unreachable), as a tunnel with no connector is its 530.
test('the sweep repairs a live direct name whose record points where nothing answers (Cloudflare\'s 52x); a node merely down is only looked at', async () => {
    const w = await world();
    try {
        const [owner, sleeper, n1] = await Promise.all([makeKey(), makeKey(), makeKey()]);
        assert.equal((await w.claim(owner, { name: 'strayaddr', ...modeBody('direct', OLD_IP) })).body.status, 'live');
        assert.equal((await w.claim(sleeper, { name: 'downaddr', ...modeBody('direct', NEW_IP) })).body.status, 'live');
        await liveName(w, 'strayaddr-a', n1);
        const nothingThere = async () => new Response('origin unreachable', { status: 522 });
        w.nodes['strayaddr.beanpool.org'] = nothingThere;
        w.nodes['downaddr.beanpool.org'] = nothingThere;
        // strayaddr's record points at an address its row doesn't record, with no request or decision behind it.
        w.cf.recordAt('strayaddr.beanpool.org').content = MOVED_IP;
        const asleep = await w.row('downaddr');
        const mark = w.cf.calls.length;
        await attestSweep(w.env);
        const row = await routedAsRow(w, 'strayaddr', 'after the sweep');
        assert.equal(row.public_ip, OLD_IP);
        assert.ok(w.events('strayaddr').some((e) => e.event === 'repaired'), JSON.stringify(w.events('strayaddr')));
        assert.deepEqual(await w.row('downaddr'), asleep, 'the node that is merely down: its row untouched');
        assert.deepEqual(w.cf.calls.slice(mark).filter((c) => c.includes(asleep.dns_record_id)), [], 'and its record only looked up');
        w.nodes['strayaddr.beanpool.org'] = attestsAs(owner);
        assert.equal((await attestSweep(w.env)).ok, 2, 'the next sweep reaches it');
    } finally { w.restore(); }
});
