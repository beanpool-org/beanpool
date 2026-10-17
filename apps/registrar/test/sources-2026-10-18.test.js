// Slice S3 of scratch/global-node/DESIGN-registrar-trust-fable.md (§4, §6) as decided by Marty on 2026-10-18: where new
// names come from (claim_sources), held — never refused — over any limit (D6), "Block all" by source, probation, the
// "Hold all new names" switch, the DNS cap (CAPACITY 200: told at 120), and the live limits as private settings in D1.
// Every test here fails on origin/main (7f4e9b08 and after, before migration 0011).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { attestSweep, sourceAddress } from '../src/index.js';
import { world, makeKey, attestsAs, nowS } from './harness.js';

const KEY = 'a-test-source-key-not-a-real-one';
const sourceWorld = (env = {}) => world({ env: { SOURCE_KEY: KEY, ...env } });

// A signed claim as Cloudflare's edge hands it to the Worker: the client's address in CF-Connecting-IP, its network and
// country in request.cf.
const FROM = {
    bot: { ip: '198.51.100.7', cf: { asn: 64500, asOrganization: 'Example Hosting', country: 'NL' } },
    home: { ip: '203.0.113.20', cf: { asn: 64501, asOrganization: 'Example Broadband', country: 'AU' } },
    other: { ip: '192.0.2.44', cf: { asn: 64500, asOrganization: 'Example Hosting', country: 'NL' } },
};
async function claimFrom(w, from, key, body) {
    const req = await w.signed('POST', '/api/registrar/claim', key, { mode: 'tunnel', ...body });
    req.headers.set('cf-connecting-ip', from.ip);
    Object.defineProperty(req, 'cf', { value: from.cf });
    const res = await worker.fetch(req, w.env);
    return { status: res.status, body: await res.json() };
}
async function admin(w, path, body) {
    const res = await worker.fetch(new Request(`https://beanpool.org/api/local/admin/registrar/${path}`, body === undefined
        ? { headers: { 'x-admin-secret': 'test-admin-secret' } }
        : { method: 'POST', headers: { 'x-admin-secret': 'test-admin-secret', 'content-type': 'application/json' }, body: JSON.stringify(body) }), w.env);
    return { status: res.status, body: await res.json() };
}
const page = async (w, path) => (await worker.fetch(new Request(`https://beanpool.org${path}`), w.env)).status;
const told = (w, like) => w.sqlite.prepare('SELECT title, body, name FROM alert_outbox WHERE title LIKE ? ORDER BY id').all(like).map((r) => ({ ...r }));
const row = (w, n) => w.sqlite.prepare('SELECT * FROM name_allocations WHERE name=?').get(n);
const liveTunnels = (w) => [...w.cf.tunnels.values()].filter((t) => !t.deleted_at).length;

test('the 4th new name from one source in an hour is HELD for approval — not a 429 — and approving it makes it live', async () => {
    const w = await sourceWorld();
    try {
        const keys = await Promise.all([1, 2, 3, 4, 5].map(() => makeKey()));
        for (const i of [0, 1, 2]) assert.equal((await claimFrom(w, FROM.bot, keys[i], { name: `bot-${i}` })).body.status, 'live');
        const fourth = await claimFrom(w, FROM.bot, keys[3], { name: 'bot-3' });
        assert.equal(fourth.status, 200, JSON.stringify(fourth.body));
        assert.deepEqual([fourth.body.status, fourth.body.note], ['pending', 'awaiting approval']);
        assert.equal(row(w, 'bot-3').held_reason, 'source');
        assert.equal(liveTunnels(w), 3, 'nothing made at Cloudflare for a held name');
        // Its node waits, as for a gated claim: /status says awaiting approval, never provisioning (it never asks again).
        const st = (await w.status(keys[3])).body;
        assert.deepEqual([st.status, st.reason], ['pending', 'awaiting-approval']);
        // Another source is not held for it.
        assert.equal((await claimFrom(w, FROM.home, keys[4], { name: 'homenode' })).body.status, 'live');
        // One alert, in counts and the network, never the address or a name.
        const held = told(w, 'New names held%');
        assert.equal(held.length, 1, JSON.stringify(held));
        assert.match(held[0].body, /more than 3 new names from one source in an hour \(AS64500 Example Hosting, NL\)/);
        assert.equal(held[0].name, null);
        for (const ip of Object.values(FROM).map((f) => f.ip)) assert.ok(!JSON.stringify(held).includes(ip));
        // A second one held in the same hour is not told again.
        assert.equal((await claimFrom(w, FROM.bot, await makeKey(), { name: 'bot-4' })).body.status, 'pending');
        assert.equal(told(w, 'New names held%').length, 1);
        // The admin's list: awaiting approval, with where it came from.
        const listed = (await admin(w, 'pending')).body.allocations.find((a) => a.name === 'bot-3');
        assert.equal(listed.awaiting_approval, true);
        assert.equal(listed.held_reason, 'source');
        assert.deepEqual({ ...listed.source, id: typeof listed.source.id }, { id: 'string', asn: 64500, as_org: 'Example Hosting', country: 'NL' });
        // Approved: live, by the admin, held no more; the token reaches its node through /status.
        assert.equal((await w.admin('bot-3', 'approve')).body.status, 'live');
        assert.deepEqual([row(w, 'bot-3').status, row(w, 'bot-3').held_reason, row(w, 'bot-3').decided_by], ['live', null, 'admin']);
        const after = (await w.status(keys[3])).body;
        assert.equal(after.status, 'live');
        assert.ok(after.tunnelToken);
        // A day's limit too: past it (with the hour's room) still held.
        w.sqlite.prepare('UPDATE claim_sources SET at = at - 7200').run();
        w.setting('source_per_day', 5);
        assert.equal((await claimFrom(w, FROM.bot, await makeKey(), { name: 'bot-5' })).body.status, 'pending', 'the day\'s 5 from that source');
    } finally { w.restore(); }
});

test('a source\'s "Block all" rejects its held names, blocks its live ones, and refuses its next claim 403', async () => {
    const w = await sourceWorld();
    try {
        const keys = await Promise.all(Array.from({ length: 6 }, () => makeKey()));
        for (const i of [0, 1, 2]) assert.equal((await claimFrom(w, FROM.bot, keys[i], { name: `farm-${i}` })).body.status, 'live');
        for (const i of [3, 4]) assert.equal((await claimFrom(w, FROM.bot, keys[i], { name: `farm-${i}` })).body.status, 'pending');
        assert.equal((await claimFrom(w, FROM.home, keys[5], { name: 'honest' })).body.status, 'live');
        // The panel groups them by source: the farm's 5 names in one group, with its network and how many are held.
        const panel = (await admin(w, 'sources')).body;
        assert.equal(panel.source_key_set, true);
        const farm = panel.groups.find((g) => g.names === 5);
        assert.ok(farm, JSON.stringify(panel.groups));
        assert.deepEqual([farm.asn, farm.as_org, farm.country, farm.held, farm.live, farm.keys], [64500, 'Example Hosting', 'NL', 2, 3, 5]);
        assert.ok(!JSON.stringify(panel).includes(FROM.bot.ip), 'no address in the panel');
        // Block all, in the page's batches until it says no more.
        const run = 'run-block-farm-0001';
        let r, rounds = 0;
        const blocked = [], rejected = [];
        do {
            r = await admin(w, 'sources', { source: farm.source, block: true, run, total: 5 });
            assert.equal(r.status, 200, JSON.stringify(r.body));
            blocked.push(...r.body.blocked); rejected.push(...r.body.rejected);
            assert.deepEqual(r.body.refused, []);
        } while (r.body.more && ++rounds < 10);
        assert.deepEqual(rejected.sort(), ['farm-3', 'farm-4']);
        assert.deepEqual(blocked.sort(), ['farm-0', 'farm-1', 'farm-2']);
        for (const i of [0, 1, 2]) assert.equal(row(w, `farm-${i}`).status, 'blocked');
        for (const i of [3, 4]) assert.deepEqual([row(w, `farm-${i}`).status, row(w, `farm-${i}`).pause_reason], ['released', 'admin'], 'rejected: free at once');
        assert.equal(liveTunnels(w), 1, 'only the honest name still has a tunnel');
        assert.equal(row(w, 'honest').status, 'live');
        // Its next claim of a new name: 403, nothing written; another source still claims.
        const again = await claimFrom(w, FROM.bot, await makeKey(), { name: 'farm-9' });
        assert.equal(again.status, 403, JSON.stringify(again.body));
        assert.equal(row(w, 'farm-9'), undefined);
        assert.equal((await claimFrom(w, FROM.other, await makeKey(), { name: 'farm-free' })).body.status, 'live', 'same network, another source');
        // One alert for the click, in counts and the network.
        const did = told(w, '%blocked a source%');
        assert.equal(did.length, 1, JSON.stringify(did));
        assert.match(did[0].body, /Block all for one source \(AS64500 Example Hosting, NL\): 5 names/);
        // The block is listed, and lifting it lets the source claim again.
        const list = (await admin(w, 'sources')).body.blocked;
        assert.deepEqual(list.map((b) => b.kind), ['source']);
        assert.equal((await admin(w, 'blocked', { kind: 'source', value: farm.source, remove: true })).body.removed, true);
        assert.equal((await claimFrom(w, FROM.bot, await makeKey(), { name: 'farm-9' })).status, 200);
    } finally { w.restore(); }
});

test('"Reject all held" frees a source\'s held names and leaves its live ones; a network blocked by hand is refused 403', async () => {
    const w = await sourceWorld();
    try {
        for (let i = 0; i < 5; i++) await claimFrom(w, FROM.bot, await makeKey(), { name: `rj-${i}` });
        const farm = (await admin(w, 'sources')).body.groups[0];
        const r = await admin(w, 'sources', { source: farm.source });
        assert.deepEqual(r.body.rejected.sort(), ['rj-3', 'rj-4']);
        assert.deepEqual(r.body.blocked, []);
        assert.equal(r.body.more, false);
        for (const i of [0, 1, 2]) assert.equal(row(w, `rj-${i}`).status, 'live');
        assert.equal((await admin(w, 'sources')).body.blocked.length, 0, 'no block written');
        // A network blocked by hand: every new name from it refused, until lifted.
        assert.equal((await admin(w, 'blocked', { kind: 'asn', value: 64501, days: 1 })).status, 200);
        assert.equal((await claimFrom(w, FROM.home, await makeKey(), { name: 'from-home' })).status, 403);
        assert.equal((await admin(w, 'blocked', { kind: 'asn', value: 64501, remove: true })).body.removed, true);
        assert.equal((await claimFrom(w, FROM.home, await makeKey(), { name: 'from-home' })).body.status, 'live');
        assert.equal((await admin(w, 'blocked', { kind: 'asn', value: 'x' })).status, 400);
    } finally { w.restore(); }
});

test('probation: a new name is live but "not found" on /i/ and the directory waits, until 3 ok sweeps and an hour', async () => {
    const w = await sourceWorld();
    try {
        const key = await makeKey(), other = await makeKey();
        const c = await claimFrom(w, FROM.home, key, { name: 'newtown', community_name: 'New Town' });
        assert.deepEqual([c.body.status, c.body.probation], ['live', true]);
        w.nodes['newtown.beanpool.org'] = attestsAs(key);
        // A verified name beside it, so the sweep sees its verifier working.
        assert.equal((await claimFrom(w, FROM.home, other, { name: 'oldtown' })).body.status, 'live');
        w.sqlite.prepare("UPDATE name_allocations SET verified_at = 1 WHERE name = 'oldtown'").run();
        w.nodes['oldtown.beanpool.org'] = attestsAs(other);
        const onProbation = async () => {
            assert.equal(await page(w, '/i/anything?n=newtown'), 404);
            assert.equal(await page(w, '/i/newtown'), 404);
            assert.equal((await w.status(key)).body.probation, true);
        };
        await onProbation();
        assert.equal(await page(w, '/i/anything?n=oldtown'), 200, 'a verified name is answered');
        assert.equal((await w.status(other)).body.probation, undefined);
        // No "New community" at the claim.
        assert.deepEqual(told(w, 'New communit%'), []);
        // Three ok sweeps, but not yet an hour: still on probation.
        for (let i = 0; i < 3; i++) await attestSweep(w.env);
        assert.equal(row(w, 'newtown').ok_sweeps, 3);
        await onProbation();
        // An hour on, the next ok sweep ends it — unless an answer that is not its own comes first: the count starts again.
        w.sqlite.prepare("UPDATE name_allocations SET decided_at = decided_at - 3700 WHERE name = 'newtown'").run();
        w.nodes['newtown.beanpool.org'] = async () => new Response('nope', { status: 503 });
        await attestSweep(w.env);
        assert.equal(row(w, 'newtown').ok_sweeps, 0, 'an answer that was not its own starts the count again');
        await onProbation();
        w.nodes['newtown.beanpool.org'] = attestsAs(key);
        for (let i = 0; i < 2; i++) await attestSweep(w.env);
        await onProbation();
        await attestSweep(w.env);
        assert.ok(row(w, 'newtown').verified_at > 0, 'verified on the third ok sweep in a row');
        assert.equal(await page(w, '/i/anything?n=newtown'), 200);
        assert.equal(await page(w, '/i/newtown'), 200);
        assert.equal((await w.status(key)).body.probation, undefined, 'its node lists itself now');
        assert.ok(w.events('newtown').some((e) => e.event === 'verified'));
        // The "New community" alert, at verification, once.
        const nc = told(w, 'New communit%');
        assert.equal(nc.length, 1, JSON.stringify(nc));
        assert.match(nc[0].body, /newtown\.beanpool\.org — "New Town" is live and verified/);
        await attestSweep(w.env);
        assert.equal(told(w, 'New communit%').length, 1);
        // A bot's burst verified in one sweep is one message.
        w.setting('probation_sweeps', 1);
        w.setting('probation_s', 0);
        for (let i = 0; i < 4; i++) {
            const k = await makeKey();
            await claimFrom(w, { ip: `198.51.100.${100 + i}`, cf: {} }, k, { name: `burst-${i}` });
            w.nodes[`burst-${i}.beanpool.org`] = attestsAs(k);
        }
        await attestSweep(w.env);
        const burst = told(w, 'New communities%');
        assert.equal(burst.length, 1, JSON.stringify(told(w, 'New communit%')));
        assert.match(burst[0].title, /4 verified/);
    } finally { w.restore(); }
});

test('"Hold all new names": an auto claim waits for approval, names held now are untouched; it lets go by itself after 24 h', async () => {
    const w = await sourceWorld();
    try {
        const owner = await makeKey();
        assert.equal((await claimFrom(w, FROM.home, owner, { name: 'already' })).body.status, 'live');
        w.nodes['already.beanpool.org'] = attestsAs(owner);
        const on = await admin(w, 'settings', { hold: true });
        assert.equal(on.status, 200, JSON.stringify(on.body));
        assert.equal(on.body.hold.on, true);
        assert.ok(on.body.hold.until > nowS() + 23 * 3600);
        const k = await makeKey();
        const r = await claimFrom(w, FROM.home, k, { name: 'whileheld' });
        assert.equal(r.body.status, 'pending');
        assert.equal(row(w, 'whileheld').held_reason, 'hold-all');
        assert.deepEqual([(await w.status(k)).body.reason], ['awaiting-approval']);
        // Names already held are untouched: the owner's claim and heal of its own name still work.
        assert.equal((await claimFrom(w, FROM.home, owner, { name: 'already' })).body.status, 'live');
        assert.equal((await w.heal(owner, { name: 'already' })).body.status, 'live');
        assert.equal(told(w, '%changed the registrar\'s settings').length, 1, 'the switch is told');
        // Off: claims go live again.
        await admin(w, 'settings', { hold: false });
        // (Each from its own address from here: one source's fourth would be held for that.)
        assert.equal((await claimFrom(w, { ip: '203.0.113.31', cf: {} }, await makeKey(), { name: 'afteroff' })).body.status, 'live');
        // On again, then 24 h pass: off by itself.
        await admin(w, 'settings', { hold: true });
        assert.equal((await claimFrom(w, { ip: '203.0.113.32', cf: {} }, await makeKey(), { name: 'heldagain' })).body.status, 'pending');
        w.sqlite.prepare("UPDATE settings SET value = ? WHERE key = 'hold_new_names_until'").run(String(nowS() - 1));
        assert.equal((await claimFrom(w, { ip: '203.0.113.33', cf: {} }, await makeKey(), { name: 'letgo' })).body.status, 'live');
    } finally { w.restore(); }
});

test('the DNS cap (CAPACITY 200): the 121st name alerts, and from the 161st every new auto name is held', async () => {
    const w = await sourceWorld();
    try {
        const k = (i) => i.toString(16).padStart(4, '0').repeat(16);
        const add = (from, to) => {
            const ins = w.sqlite.prepare("INSERT INTO name_allocations (name, node_pubkey, hostname, mode, status, attest_fails, requested_at, decided_at, decided_by, verified_at) VALUES (?, ?, ?, 'tunnel', 'live', 0, ?, ?, 'admin', 1)");
            for (let i = from; i < to; i++) ins.run(`fill-${i}`, k(i), `fill-${i}.beanpool.org`, nowS() - 86400 * 3, nowS() - 86400 * 3);
        };
        add(0, 119);
        assert.equal((await claimFrom(w, FROM.home, await makeKey(), { name: 'the-120th' })).body.status, 'live');
        assert.deepEqual(told(w, 'Names near the DNS cap%'), [], 'nothing at 120');
        assert.equal((await claimFrom(w, { ip: '203.0.113.21', cf: {} }, await makeKey(), { name: 'the-121st' })).body.status, 'live');
        const cap = told(w, 'Names near the DNS cap%');
        assert.equal(cap.length, 1, JSON.stringify(cap));
        assert.match(cap[0].title, /121 of 200/);
        assert.match(cap[0].body, /from 160 every new name is held/);
        // Told once a day, not once a name.
        assert.equal((await claimFrom(w, { ip: '203.0.113.22', cf: {} }, await makeKey(), { name: 'the-122nd' })).body.status, 'live');
        assert.equal(told(w, 'Names near the DNS cap%').length, 1);
        // 160 names: the 161st is held for the admin, whose last places they are.
        add(122, 160);
        const r = await claimFrom(w, { ip: '203.0.113.23', cf: {} }, await makeKey(), { name: 'the-161st' });
        assert.equal(r.body.status, 'pending');
        assert.equal(row(w, 'the-161st').held_reason, 'near-full');
        assert.equal((await w.admin('the-161st', 'approve')).body.status, 'live', 'the admin gives it');
        // Raised to a Pro zone's 1,000 in /admin: the gate moves with it (80%), and so does the alert line (60%).
        assert.equal((await admin(w, 'settings', { key: 'capacity', value: 1000 })).status, 200);
        assert.equal((await claimFrom(w, { ip: '203.0.113.24', cf: {} }, await makeKey(), { name: 'after-pro' })).body.status, 'live');
    } finally { w.restore(); }
});

test('the live limits are settings in D1: a row there beats the env and the default; /admin writes them, refusing nonsense', async () => {
    const w = await sourceWorld({ NEW_NAMES_PER_HOUR: '40' });
    try {
        const panel = (await admin(w, 'sources')).body;
        const get = (p, key) => p.settings.find((x) => x.key === key);
        assert.deepEqual([get(panel, 'source_per_hour').value, get(panel, 'source_per_hour').set], [3, null], 'the default');
        assert.equal(get(panel, 'new_names_per_hour').value, 40, 'the env, with no row');
        assert.equal(get(panel, 'capacity').value, 200);
        assert.equal(get(panel, 'capacity_alert_at').value, 120);
        // Raised in /admin: the 4th and 5th from one source go live, the 6th is held.
        const set = await admin(w, 'settings', { key: 'source_per_hour', value: 5 });
        assert.equal(set.status, 200, JSON.stringify(set.body));
        assert.equal(get(set.body, 'source_per_hour').value, 5);
        assert.equal(get(set.body, 'source_per_hour').set.value, '5');
        for (let i = 0; i < 5; i++) assert.equal((await claimFrom(w, FROM.bot, await makeKey(), { name: `lim-${i}` })).body.status, 'live', `lim-${i}`);
        assert.equal((await claimFrom(w, FROM.bot, await makeKey(), { name: 'lim-5' })).body.status, 'pending');
        // A D1 row beats the env.
        assert.equal(get((await admin(w, 'settings', { key: 'new_names_per_hour', value: 5 })).body, 'new_names_per_hour').value, 5);
        assert.equal((await claimFrom(w, FROM.home, await makeKey(), { name: 'budgeted' })).body.status, 'pending', 'the 5 live this hour spent it');
        assert.equal(row(w, 'budgeted').held_reason, 'budget');
        // The per-key limit and the sweep's strikes read it too.
        await admin(w, 'settings', { key: 'claim_limit_per_key', value: 1 });
        const one = await makeKey();
        await w.setting('new_names_per_hour', 100);
        assert.equal((await claimFrom(w, FROM.home, one, { name: 'firstone' })).body.status, 'live');
        assert.equal((await claimFrom(w, FROM.home, one, { name: 'secondone' })).status, 403, 'one name a key');
        // Nonsense is refused, and nothing changes.
        for (const bad of [{ key: 'source_per_hour', value: 0 }, { key: 'source_per_hour', value: 'lots' }, { key: 'source_per_hour', value: 1.5 }, { key: 'no_such', value: 3 }]) {
            const r = await admin(w, 'settings', bad);
            assert.equal(r.status, 400, JSON.stringify(bad));
        }
        assert.equal(get((await admin(w, 'sources')).body, 'source_per_hour').value, 5);
        // Back to the default.
        assert.equal(get((await admin(w, 'settings', { key: 'source_per_hour', value: null })).body, 'source_per_hour').value, 3);
        // Every change is told.
        assert.ok(told(w, '%changed the registrar\'s settings').length >= 4);
        // The admin's routes answer only the admin.
        const anon = await worker.fetch(new Request('https://beanpool.org/api/local/admin/registrar/settings', { method: 'POST', body: '{"key":"source_per_hour","value":99}' }), w.env);
        assert.equal(anon.status, 401);
    } finally { w.restore(); }
});

test('privacy: no address is stored — a keyed hash only, and none without SOURCE_KEY; sources go after 24 h; IPv6 counts by its /64', async () => {
    const w = await sourceWorld();
    try {
        await claimFrom(w, FROM.bot, await makeKey(), { name: 'priv-a' });
        const dump = JSON.stringify(w.sqlite.prepare('SELECT * FROM claim_sources').all());
        assert.ok(!dump.includes(FROM.bot.ip), 'the address is in no column');
        const r = w.sqlite.prepare('SELECT * FROM claim_sources').get();
        assert.match(r.source_hash, /^[0-9a-f]{64}$/);
        assert.deepEqual([r.asn, r.as_org, r.country, r.name], [64500, 'Example Hosting', 'NL', 'priv-a']);
        // The hash is keyed: another SOURCE_KEY gives another one for the same address.
        w.env.SOURCE_KEY = 'another-key';
        await claimFrom(w, FROM.bot, await makeKey(), { name: 'priv-b' });
        const hashes = w.sqlite.prepare('SELECT DISTINCT source_hash FROM claim_sources').all();
        assert.equal(hashes.length, 2);
        // Without the secret: no hash at all, so no per-source budget — the claims still work.
        delete w.env.SOURCE_KEY;
        for (let i = 0; i < 5; i++) assert.equal((await claimFrom(w, FROM.home, await makeKey(), { name: `nokey-${i}` })).body.status, 'live');
        assert.equal(w.sqlite.prepare("SELECT COUNT(*) AS n FROM claim_sources WHERE name LIKE 'nokey-%' AND source_hash IS NULL").get().n, 5);
        assert.equal((await admin(w, 'sources')).body.source_key_set, false);
        // A day on, the sweep deletes them.
        w.sqlite.prepare("UPDATE claim_sources SET at = at - 86401 WHERE name LIKE 'nokey-%'").run();
        await attestSweep(w.env);
        assert.equal(w.sqlite.prepare("SELECT COUNT(*) AS n FROM claim_sources WHERE name LIKE 'nokey-%'").get().n, 0);
        assert.equal(w.sqlite.prepare('SELECT COUNT(*) AS n FROM claim_sources').get().n, 2);
        // IPv6: one host's /64 is one source, however it spells its address; IPv4 in IPv6 is the IPv4 address.
        assert.equal(sourceAddress('2001:db8:1:2::1'), '2001:db8:1:2::/64');
        assert.equal(sourceAddress('2001:0DB8:0001:0002:ffff:0:0:9'), '2001:db8:1:2::/64');
        assert.equal(sourceAddress('::ffff:198.51.100.7'), '198.51.100.7');
        assert.equal(sourceAddress('not an address'), null);
        assert.equal(sourceAddress('1::2::3'), null);
        w.env.SOURCE_KEY = KEY;
        for (let i = 0; i < 4; i++) await claimFrom(w, { ip: `2001:db8:1:2::${i + 1}`, cf: {} }, await makeKey(), { name: `six-${i}` });
        assert.equal(row(w, 'six-3').held_reason, 'source', 'four addresses of one /64 are one source');
        // The alerts carry no address either.
        assert.ok(!JSON.stringify(w.sqlite.prepare('SELECT * FROM alert_outbox').all()).includes('2001:db8'));
    } finally { w.restore(); }
});

test('a busy network is told once a day, and nothing is held for that alone', async () => {
    const w = await sourceWorld();
    try {
        w.setting('asn_per_day', 2);
        for (let i = 0; i < 4; i++) {
            const r = await claimFrom(w, { ip: `198.51.100.${10 + i}`, cf: { asn: 64999, asOrganization: 'Busy Cloud', country: 'DE' } }, await makeKey(), { name: `busy-${i}` });
            assert.equal(r.body.status, 'live', `busy-${i}: four sources, one network`);
        }
        const t = told(w, 'Many new names from AS64999');
        assert.equal(t.length, 1, JSON.stringify(t));
        assert.match(t[0].body, /3 in the last 24 hours from AS64999 Busy Cloud \(DE\)/);
    } finally { w.restore(); }
});

// D1 allows 50 queries an invocation on Workers Free: one request of Block all (its batch of names, the block, the alert)
// stays well inside it, with alerts on and Cloudflare refusing every delete (each refusal is owed: more queries).
test('one Block all request stays inside D1\'s 50 queries, with alerts on and Cloudflare refusing deletes', async () => {
    const w = await sourceWorld({ NTFY_URL: 'https://ntfy.test/bp-topic' });
    const inner = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => (new URL(typeof input === 'string' ? input : input.url).hostname === 'ntfy.test'
        ? new Response('{"id":"x"}', { status: 200 }) : inner(input, init));
    try {
        for (let i = 0; i < 6; i++) await claimFrom(w, FROM.bot, await makeKey(), { name: `q-${i}` });
        const farm = (await admin(w, 'sources')).body.groups[0];
        w.cf.fail.deleteTunnel = true;
        w.cf.fail.deleteDns = true;
        const DB = w.env.DB;
        let most = 0;
        for (let round = 0; round < 5; round++) {
            let n = 0;
            const counted = (stmt) => ({ bind: (...a) => counted(stmt.bind(...a)), first: (...a) => (n++, stmt.first(...a)), all: (...a) => (n++, stmt.all(...a)), run: (...a) => (n++, stmt.run(...a)) });
            w.env.DB = { prepare: (sql) => counted(DB.prepare(sql)) };
            const r = await admin(w, 'sources', { source: farm.source, block: true, run: 'run-q-budget-01', total: 6 });
            w.env.DB = DB;
            assert.equal(r.status, 200, JSON.stringify(r.body));
            most = Math.max(most, n);
            if (!r.body.more) break;
        }
        assert.ok(most <= 45, `a Block all request ran ${most} D1 queries`);
        for (let i = 0; i < 6; i++) assert.ok(['blocked', 'released'].includes(row(w, `q-${i}`).status), `q-${i}: ${row(w, `q-${i}`).status}`);
    } finally { globalThis.fetch = inner; w.restore(); }
});
