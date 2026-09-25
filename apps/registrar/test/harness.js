// The registrar's test world, shared by ownership-states.test.js and fuzz.test.js: the Worker against a real in-memory
// SQLite loaded with the migrations, a stateful fake of the Cloudflare API (tunnels + DNS records, with Cloudflare's
// collision errors, and refusals a test switches on), and nodes answering at hostnames. No network.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';
import * as db from '../src/db.js';

export const nowS = () => Math.floor(Date.now() / 1000);
export const toHex = (buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
export const migration = (m) => readFileSync(new URL(`../migrations/${m}`, import.meta.url), 'utf8');

// D1's prepare/bind/first/all/run over node:sqlite (run() reports meta.changes, as D1 does). `afterRead(re, run)`:
// once, just after the first first() whose SQL matches `re` has read its row, `run` runs to completion before the
// caller gets that row — a request landing between another request's read and its first write. `beforeRun(re, run)`:
// once, just before the first run() whose SQL matches `re` writes, `run` runs to completion — a request landing
// between another request's last Cloudflare call and its write. `atWrite(n, run)`: the same, just before the n-th run()
// from now; `writes()` counts the run() calls so far.
export function sqliteD1(migrations = ['0001_init.sql', '0002_states.sql', '0003_decision_seq.sql', '0004_teardown.sql']) {
    const sqlite = new DatabaseSync(':memory:');
    for (const m of migrations) sqlite.exec(migration(m));
    const readHooks = [];
    const runHooks = [];
    let runs = 0;
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
                    runs++;
                    const h = runHooks.findIndex((x) => (x.re ? x.re.test(sql) : x.n === runs));
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
    const atWrite = (n, run) => runHooks.push({ n: runs + n, run });
    return { sqlite, d1, all, afterRead, beforeRun, atWrite, writes: () => runs, runHooks };
}

// Cloudflare as far as the registrar uses it. A duplicate live tunnel name and a second record at a hostname are
// refused, as Cloudflare refuses them — so a POST-collision or a second tunnel shows up as a failure here.
// `during(re, run)`: once, just before Cloudflare answers the first call matching `re` (`${method} ${path}`),
// `run` runs to completion — an admin action landing between two of a request's Cloudflare calls. `at(n, run)`:
// the same, just before Cloudflare answers the n-th call from now.
export function fakeCloudflare() {
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

export async function makeKey() {
    const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    return { keyPair, pubHex: toHex(await crypto.subtle.exportKey('raw', keyPair.publicKey)) };
}
const sign = async (key, message) =>
    toHex(await crypto.subtle.sign('Ed25519', key.keyPair.privateKey, new TextEncoder().encode(message)));

// A node's /api/attest, signed by `key`.
export const attestsAs = (key) => async (nonce) => {
    const timestamp = nowS();
    return Response.json({ pubkey: key.pubHex, nonce, timestamp, signature: await sign(key, `beanpool-node-attest/v1\n${nonce}\n${timestamp}`) });
};

// One world per test: D1, fake Cloudflare, and nodes answering at hostnames — but only while Cloudflare routes the
// hostname (a DNS record exists), so an edge attest can only pass once the registrar has routing back up.
export async function world({ migrations, env: extra } = {}) {
    const { sqlite, d1, all, afterRead, beforeRun, atWrite, writes, runHooks } = sqliteD1(migrations);
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
        env, cf, nodes, sqlite, afterRead, beforeRun, atWrite, writes, runHooks,
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
export async function liveName(w, name, key) {
    const r = await w.claim(key, { name });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'live');
    w.nodes[`${name}.beanpool.org`] = attestsAs(key);
    return r.body;
}

// What routes a name, as far as Cloudflare goes: the record at its hostname, and its tunnels still alive.
export const routing = (w, name) => ({
    dns: w.cf.recordAt(`${name}.beanpool.org`)?.content ?? null,
    tunnels: [...w.cf.tunnels.values()].filter((t) => !t.deleted_at && t.name === `bp-${name}`).map((t) => t.id),
});
