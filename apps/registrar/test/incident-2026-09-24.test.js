// The 2026-09-24 incident, as tests. A registrar deploy that could not verify the nodes' signing format
// classed every node as a `mismatch` and, two sweeps later, revoked `test` and `yarravalley`: tunnel and
// DNS deleted, name free for anyone. The rule since (scratch/registrar/DESIGN-2026-09-24-fable.md §2.3,
// §2.4): something the registrar cannot VERIFY is never evidence against a node, and a sweep that looks
// wrong as a whole acts on nobody.
//
// Unlike the other suites this runs db.js against a real in-memory SQLite loaded with the migrations, so the
// queries under test are the ones D1 runs. No network: every fetch is answered here (or throws), and
// Cloudflare API calls are only recorded, never sent.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker, { attestOne, attestSweep } from '../src/index.js';
import * as db from '../src/db.js';

const nowS = () => Math.floor(Date.now() / 1000);
const toHex = (buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');

// D1's prepare/bind/first/all/run over node:sqlite (run() reports meta.changes, as D1 does).
function sqliteD1() {
    const sqlite = new DatabaseSync(':memory:');
    for (const m of ['0001_init.sql', '0002_states.sql'])
        sqlite.exec(readFileSync(new URL(`../migrations/${m}`, import.meta.url), 'utf8'));
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
    const rows = () => sqlite.prepare('SELECT * FROM name_allocations ORDER BY name').all().map((r) => ({ ...r }));
    return { d1, rows };
}

function makeEnv(extra = {}) {
    const { d1, rows } = sqliteD1();
    const env = {
        BASE_DOMAIN: 'beanpool.org', ATTEST_FAIL_LIMIT: '2', ADMIN_SECRET: 'test-admin-secret',
        CF_ACCOUNT_ID: 'acct', CF_ZONE_ID: 'zone', CF_API_TOKEN: 'not-a-token',
        DB: d1, ...extra,
    };
    return { env, rows };
}

async function makeKey() {
    const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    return { keyPair, pubHex: toHex(await crypto.subtle.exportKey('raw', keyPair.publicKey)) };
}

const sign = async (key, message) =>
    toHex(await crypto.subtle.sign('Ed25519', key.keyPair.privateKey, new TextEncoder().encode(message)));

// What a node's /api/attest answers (apps/server/src/services/registrar-client.ts buildAttestation), signed
// by `key` under `tag`. The node's real tag is 'beanpool-node-attest/v1'.
const attestsAs = (key, tag = 'beanpool-node-attest/v1') => async (nonce) => {
    const timestamp = nowS();
    return Response.json({ pubkey: key.pubHex, nonce, timestamp, signature: await sign(key, `${tag}\n${nonce}\n${timestamp}`) });
};
// A newer node than this verifier: its own key, a signing tag the registrar does not have. On 09-24 it was
// the other way round (tagged nodes, untagged Worker); to the verifier the two look identical.
const attestsUnderUnknownTag = (key) => attestsAs(key, 'beanpool-node-attest/v2');
const down = () => async () => new Response('Bad Gateway', { status: 502 });

// Routes the Worker's fetches: `nodes` maps a hostname to its /api/attest behaviour. Cloudflare API calls
// are recorded and answered with success; anything else is a test bug and throws.
function network(nodes) {
    const cfCalls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        if (url.hostname === 'api.cloudflare.com') {
            cfCalls.push(`${init.method || 'GET'} ${url.pathname}`);
            return Response.json({ success: true, result: {} });
        }
        const node = nodes[url.hostname];
        if (!node || url.pathname !== '/api/attest') throw new Error(`test network: no route to ${url}`);
        return node(url.searchParams.get('nonce'));
    };
    return { cfCalls, restore: () => { globalThis.fetch = original; } };
}

// A live tunnel allocation, as handleClaim + provision leave it.
async function seedLive(env, name, key) {
    await db.insertAllocation(env, {
        name, node_pubkey: key.pubHex, hostname: `${name}.beanpool.org`, mode: 'tunnel', status: 'live',
        requested_at: nowS() - 86400,
    });
    await db.updateAllocation(env, name, {
        tunnel_id: `tun-${name}`, dns_record_id: `dns-${name}`, decided_at: nowS() - 86400, decided_by: 'auto',
    });
}

const row = (rows, name) => rows().find((r) => r.name === name);

async function signedPost(url, key, body) {
    const ts = String(nowS());
    const path = new URL(url).pathname;
    const text = JSON.stringify(body);
    return new Request(url, {
        method: 'POST', body: text,
        headers: {
            'content-type': 'application/json', 'x-bp-pubkey': key.pubHex, 'x-bp-timestamp': ts,
            'x-bp-signature': await sign(key, `beanpool-registrar-request/v1\nPOST\n${path}\n${ts}\n${text}`),
        },
    });
}

async function signedGet(url, key) {
    const ts = String(nowS());
    const path = new URL(url).pathname;
    return new Request(url, {
        method: 'GET',
        headers: {
            'x-bp-pubkey': key.pubHex, 'x-bp-timestamp': ts,
            'x-bp-signature': await sign(key, `beanpool-registrar-request/v1\nGET\n${path}\n${ts}\n`),
        },
    });
}

test('incident (1): an attest signed under a tag the verifier lacks is unverifiable, and the name survives', async () => {
    const { env, rows } = makeEnv();
    const [yarra, a, b, c] = await Promise.all([makeKey(), makeKey(), makeKey(), makeKey()]);
    await seedLive(env, 'yarravalley', yarra);
    // Healthy neighbours keep the sweep sound, so what is tested is the verdict, not the circuit breaker.
    await seedLive(env, 'alpha', a); await seedLive(env, 'bravo', b); await seedLive(env, 'charlie', c);
    const before = row(rows, 'yarravalley');
    const net = network({
        'yarravalley.beanpool.org': attestsUnderUnknownTag(yarra),
        'alpha.beanpool.org': attestsAs(a), 'bravo.beanpool.org': attestsAs(b), 'charlie.beanpool.org': attestsAs(c),
    });
    try {
        for (let sweep = 1; sweep <= 3; sweep++) {
            const summary = await attestSweep(env);
            const now = row(rows, 'yarravalley');
            assert.equal(now.status, 'live', `sweep ${sweep}: yarravalley must stay live`);
            assert.equal(now.attest_fails, 0, `sweep ${sweep}: an unverifiable attest must not count`);
            assert.equal(summary?.action, 'applied', `sweep ${sweep}: the sweep was sound and acted`);
        }
        assert.deepEqual(row(rows, 'yarravalley'), before, 'nothing about the row changed');
        assert.equal(await attestOne(env, before), 'unverifiable');
        assert.ok(row(rows, 'alpha').last_attest_at, 'the sweep did act: the healthy neighbours were marked ok');
        assert.deepEqual(net.cfCalls, [], 'no Cloudflare resource was touched');
    } finally { net.restore(); }
});

test('incident (2): three live names, all unverifiable — the sweep acts on none and changes no row', async () => {
    const { env, rows } = makeEnv();
    const keys = await Promise.all([makeKey(), makeKey(), makeKey()]);
    const names = ['test', 'yarravalley', 'cairns'];
    for (let i = 0; i < 3; i++) await seedLive(env, names[i], keys[i]);
    const before = rows();
    const net = network(Object.fromEntries(names.map((n, i) => [`${n}.beanpool.org`, attestsUnderUnknownTag(keys[i])])));
    try {
        for (let sweep = 1; sweep <= 3; sweep++) {
            const summary = await attestSweep(env);
            assert.deepEqual(rows(), before, `sweep ${sweep}: no row changed`);
            assert.match(String(summary?.action), /^suspended/, `sweep ${sweep}: the registrar must suspend itself`);
            assert.equal(summary.unverifiable, 3);
        }
        assert.deepEqual(net.cfCalls, [], 'no Cloudflare resource was touched');
    } finally { net.restore(); }
});

test('incident (2b): many impostors at once is the registrar at fault — suspended, nothing revoked', async () => {
    // Every node answers with a valid signature under a key the registrar does not have on file: what a
    // stale D1 restore or a key-comparison bug here would look like. Real impostors are rare and
    // independent; three in one sweep is the registrar.
    const { env, rows } = makeEnv();
    const names = ['alpha', 'bravo', 'charlie'];
    const onFile = await Promise.all(names.map(() => makeKey()));
    const answering = await Promise.all(names.map(() => makeKey()));
    for (let i = 0; i < 3; i++) await seedLive(env, names[i], onFile[i]);
    const before = rows();
    const net = network(Object.fromEntries(names.map((n, i) => [`${n}.beanpool.org`, attestsAs(answering[i])])));
    try {
        for (let sweep = 1; sweep <= 3; sweep++) {
            const summary = await attestSweep(env);
            assert.deepEqual(rows(), before, `sweep ${sweep}: no row changed`);
            assert.equal(summary.action, 'suspended:mass');
            assert.equal(summary.impostor, 3);
        }
        assert.deepEqual(net.cfCalls, []);
    } finally { net.restore(); }
});

test('incident (2c): a small fleet where EVERY live name is an impostor is the registrar at fault too', async () => {
    // max(2, 10% of live) can never be exceeded while live <= 2, so on its own it leaves a small fleet (the
    // live set after 09-24) with no breaker: a key-comparison bug would revoke every name in two sweeps.
    for (const names of [['alpha', 'bravo'], ['alpha']]) {
        const { env, rows } = makeEnv();
        const onFile = await Promise.all(names.map(() => makeKey()));
        const answering = await Promise.all(names.map(() => makeKey()));
        for (let i = 0; i < names.length; i++) await seedLive(env, names[i], onFile[i]);
        const before = rows();
        const nodes = Object.fromEntries(names.map((n, i) => [`${n}.beanpool.org`, attestsAs(answering[i])]));
        const net = network(nodes);
        try {
            for (let sweep = 1; sweep <= 3; sweep++) {
                const summary = await attestSweep(env);
                assert.deepEqual(rows(), before, `live=${names.length} sweep ${sweep}: no row changed`);
                assert.equal(summary.action, 'suspended:mass', `live=${names.length} sweep ${sweep}`);
                assert.equal(summary.impostor, names.length);
            }
            assert.deepEqual(net.cfCalls, []);

            // Control: once one name answers under its own key, the sweep is believable and acts.
            if (names.length > 1) {
                nodes['alpha.beanpool.org'] = attestsAs(onFile[0]);
                const summary = await attestSweep(env);
                assert.equal(summary.action, 'applied');
                assert.equal(row(rows, 'bravo').attest_fails, 1);
            }
        } finally { net.restore(); }
    }
});

// Until PR 1 (ownership states) part 3 and the control at the end of 3b asserted status 'revoked' — the interim kill
// switch, which also freed the name, so the impostor could claim it next (design §1 failure 9; the design's PR 0 row
// says "today's revoke still (until PR1)"). The kill switch now pauses: routing stops exactly as before (tunnel and
// DNS deleted, asserted unchanged below) but the name stays its owner's. Only the status string changed; the checks
// that the name is still held are new.
test('incident (3): an attest validly signed by ANOTHER key is an impostor; twice → paused, name kept (the kill switch survives)', async () => {
    const { env, rows } = makeEnv();
    const [owner, intruder, n1, n2] = await Promise.all([makeKey(), makeKey(), makeKey(), makeKey()]);
    await seedLive(env, 'swapped', owner);
    await seedLive(env, 'alpha', n1); await seedLive(env, 'bravo', n2);
    const net = network({
        'swapped.beanpool.org': attestsAs(intruder),
        'alpha.beanpool.org': attestsAs(n1), 'bravo.beanpool.org': attestsAs(n2),
    });
    try {
        assert.equal(await attestOne(env, row(rows, 'swapped')), 'impostor');

        let summary = await attestSweep(env);
        assert.equal(summary.action, 'applied');
        assert.equal(row(rows, 'swapped').status, 'live');
        assert.equal(row(rows, 'swapped').attest_fails, 1);
        assert.deepEqual(net.cfCalls, []);

        summary = await attestSweep(env);
        assert.equal(summary.action, 'applied');
        assert.equal(row(rows, 'swapped').status, 'paused');
        assert.equal(row(rows, 'swapped').pause_reason, 'impostor');
        assert.equal(row(rows, 'swapped').attest_fails, 2);
        assert.deepEqual(net.cfCalls.sort(), [
            'DELETE /client/v4/accounts/acct/cfd_tunnel/tun-swapped',
            'DELETE /client/v4/zones/zone/dns_records/dns-swapped',
        ]);
        for (const n of ['alpha', 'bravo']) {
            assert.equal(row(rows, n).status, 'live');
            assert.equal(row(rows, n).attest_fails, 0);
        }

        // The name is still the owner's: taken to everyone else, the intruder's key included.
        assert.equal(row(rows, 'swapped').node_pubkey, owner.pubHex);
        const avail = await (await worker.fetch(new Request('https://beanpool.org/api/registrar/available?name=swapped'), env)).json();
        assert.equal(avail.available, false);
        assert.equal(avail.reason, 'taken');
        const grab = await worker.fetch(await signedPost('https://beanpool.org/api/registrar/claim', intruder, { name: 'swapped', mode: 'tunnel' }), env);
        assert.equal(grab.status, 409);
        assert.equal(row(rows, 'swapped').node_pubkey, owner.pubHex);
        assert.equal(row(rows, 'swapped').status, 'paused');
    } finally { net.restore(); }
});

test('incident (3b): an unverifiable verdict ends a run of impostor verdicts — sightings apart never pause', async () => {
    // attest_fails counts CONSECUTIVE impostor verdicts. A name that goes quiet between two sightings (asleep,
    // down, or answering in a format this verifier can't check) must not carry the first sighting over to one
    // days or weeks later: that is the drift-then-revoke path again, only slower.
    const { env, rows } = makeEnv();
    const [owner, intruder, n1, n2] = await Promise.all([makeKey(), makeKey(), makeKey(), makeKey()]);
    await seedLive(env, 'swapped', owner);
    await seedLive(env, 'alpha', n1); await seedLive(env, 'bravo', n2);
    const nodes = {
        'swapped.beanpool.org': attestsAs(intruder),
        'alpha.beanpool.org': attestsAs(n1), 'bravo.beanpool.org': attestsAs(n2),
    };
    const net = network(nodes);
    try {
        let summary = await attestSweep(env);
        assert.equal(summary.action, 'applied');
        assert.equal(row(rows, 'swapped').attest_fails, 1);

        for (const [label, quiet] of [['down', down()], ['unknown tag', attestsUnderUnknownTag(owner)]]) {
            nodes['swapped.beanpool.org'] = quiet;
            for (let sweep = 1; sweep <= 3; sweep++) {
                summary = await attestSweep(env);
                assert.equal(summary.action, 'applied', `${label} sweep ${sweep}: the sweep was sound and acted`);
                assert.equal(summary.unverifiable, 1);
                assert.equal(row(rows, 'swapped').status, 'live');
                assert.equal(row(rows, 'swapped').attest_fails, 0, `${label} sweep ${sweep}: the run of impostor verdicts is over`);
                assert.equal(row(rows, 'swapped').last_attest_at, null, `${label} sweep ${sweep}: unverifiable is not an ok either`);
            }

            nodes['swapped.beanpool.org'] = attestsAs(intruder);
            summary = await attestSweep(env);
            assert.equal(summary.action, 'applied');
            assert.equal(row(rows, 'swapped').status, 'live', `${label}: one sighting after a quiet spell must not pause`);
            assert.equal(row(rows, 'swapped').attest_fails, 1, `${label}: it starts a new run`);
        }
        assert.deepEqual(net.cfCalls, [], 'no Cloudflare resource was touched');

        // Control: the next sweep is a second CONSECUTIVE sighting, and that still pulls routing (see part 3).
        summary = await attestSweep(env);
        assert.equal(summary.action, 'applied');
        assert.equal(row(rows, 'swapped').status, 'paused');
        assert.equal(row(rows, 'swapped').pause_reason, 'impostor');
        assert.equal(row(rows, 'swapped').attest_fails, 2);
    } finally { net.restore(); }
});

test('incident (4): a failed canary means nothing is acted on — not even a real impostor', async () => {
    const { env, rows } = makeEnv({ CANARY_NAME: 'test' });
    const [canary, owner, intruder, honest] = await Promise.all([makeKey(), makeKey(), makeKey(), makeKey()]);
    await seedLive(env, 'test', canary);
    await seedLive(env, 'swapped', owner);
    await seedLive(env, 'alpha', honest);
    const nodes = {
        'test.beanpool.org': down(),
        'swapped.beanpool.org': attestsAs(intruder),
        'alpha.beanpool.org': attestsAs(honest),
    };
    const before = rows();
    const net = network(nodes);
    try {
        for (let sweep = 1; sweep <= 3; sweep++) {
            const summary = await attestSweep(env);
            assert.deepEqual(rows(), before, `sweep ${sweep}: nothing was acted on, nor any ok recorded …`);
            assert.equal(summary.action, 'suspended:canary');
            assert.equal(summary.impostor, 1, '… although the impostor was seen');
        }
        assert.deepEqual(net.cfCalls, []);

        // Control: the same world with a healthy canary acts — the canary is what held it.
        nodes['test.beanpool.org'] = attestsAs(canary);
        const summary = await attestSweep(env);
        assert.equal(summary.action, 'applied');
        assert.equal(row(rows, 'swapped').attest_fails, 1);
    } finally { net.restore(); }
});

test('incident (4b): a configured canary that is not live suspends the sweep', async () => {
    const { env, rows } = makeEnv({ CANARY_NAME: 'test' });
    const [owner, intruder] = await Promise.all([makeKey(), makeKey()]);
    await seedLive(env, 'swapped', owner);
    const before = rows();
    const net = network({ 'swapped.beanpool.org': attestsAs(intruder) });
    try {
        const summary = await attestSweep(env);
        assert.deepEqual(rows(), before);
        assert.equal(summary.action, 'suspended:canary');
        assert.deepEqual(net.cfCalls, []);
    } finally { net.restore(); }
});

test('status: an owner whose name was revoked hears "revoked", not "none"', async () => {
    const { env } = makeEnv();
    const [owner, other, stranger] = await Promise.all([makeKey(), makeKey(), makeKey()]);
    await seedLive(env, 'yarravalley', owner);
    await db.updateAllocation(env, 'yarravalley', { status: 'revoked', attest_fails: 2 });
    const net = network({});
    try {
        const res = await worker.fetch(await signedGet('https://beanpool.org/api/registrar/status', owner), env);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.status, 'revoked');
        assert.equal(body.name, 'yarravalley');
        assert.equal(body.hostname, 'yarravalley.beanpool.org');
        assert.equal(body.tunnelToken, undefined, 'a revoked name carries no tunnel token');

        // A key that also holds a live name hears about the live one, as before.
        await seedLive(env, 'cairns', other);
        await db.insertAllocation(env, {
            name: 'oldname', node_pubkey: other.pubHex, hostname: 'oldname.beanpool.org', mode: 'tunnel',
            status: 'pending', requested_at: nowS() - 999999,
        });
        await db.updateAllocation(env, 'oldname', { status: 'revoked' });
        const other1 = await (await worker.fetch(await signedGet('https://beanpool.org/api/registrar/status', other), env)).json();
        assert.equal(other1.status, 'live');
        assert.equal(other1.name, 'cairns');

        // A key with no row at all still hears "none".
        const none = await (await worker.fetch(await signedGet('https://beanpool.org/api/registrar/status', stranger), env)).json();
        assert.deepEqual(none, { status: 'none' });
        // Only the live name asked Cloudflare for a token; the revoked one did not.
        assert.deepEqual(net.cfCalls, ['GET /client/v4/accounts/acct/cfd_tunnel/tun-cairns/token']);
    } finally { net.restore(); }
});
