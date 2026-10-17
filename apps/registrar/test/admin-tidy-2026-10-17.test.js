// The /admin tidy (Marty, 2026-10-17: "a heap of old test ones — delete all the unused stuff", "bad UI"): "Remove from
// the list" (forget) and its bulk form, the hold facts /pending gives the page, and the page itself — released names
// collapsed, tables that fit their card. Every test here fails on 3bc19acd (origin/main): it has no forget route
// (404), /pending says nothing of holds, and the page lists released names among the held ones, its Action column in
// a no-wrap cell past the card's edge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import worker, { holdsName, isOwnRow, attestSweep } from '../src/index.js';
import { world, makeKey, liveName, nowS, routing } from './harness.js';

const DAY = 86400;
const COOLOFF = 30 * DAY;
const FREE_NOW = { free_now: true };
const SECRET = { 'x-admin-secret': 'test-admin-secret' };

const adminPost = async (w, path, body, headers = SECRET) => {
    const res = await worker.fetch(new Request(`https://beanpool.org/api/local/admin/registrar/${path}`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    }), w.env);
    return { status: res.status, body: await res.json() };
};
const forget = (w, name, headers) => adminPost(w, `${name}/forget`, undefined, headers);
const forgetMany = (w, body, headers) => adminPost(w, 'forget', body, headers);
const listed = async (w) => (await (await worker.fetch(new Request('https://beanpool.org/api/local/admin/registrar/pending', { headers: SECRET }), w.env)).json()).allocations;
const teardownOf = (w, name) => w.sqlite.prepare('SELECT kind, cf_id FROM teardown WHERE name=? ORDER BY kind').all(name).map((r) => ({ ...r }));
const removedEvents = (w, name) => w.events(name).filter((e) => e.event === 'removed');

// A live name the admin then released with "free now": released, nobody holds it.
async function freed(w, name) {
    const owner = await makeKey();
    await liveName(w, name, owner);
    const r = await w.admin(name, 'release', FREE_NOW);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(holdsName(w.env, await w.row(name)), false);
    return owner;
}

test('forget refuses every row that is not released — live, pending, paused, blocked — with a 409, and changes nothing', async () => {
    const w = await world();
    try {
        const keys = await Promise.all([makeKey(), makeKey(), makeKey(), makeKey(), makeKey()]);
        await liveName(w, 'livename', keys[0]);
        w.sqlite.prepare("INSERT INTO name_policy (pattern, tier) VALUES ('waiting', 'gated')").run();
        assert.equal((await w.claim(keys[1], { name: 'waiting' })).body.status, 'pending');
        await liveName(w, 'pausedname', keys[2]);
        assert.equal((await w.admin('pausedname', 'pause')).body.status, 'paused');
        await liveName(w, 'blockedname', keys[3]);
        assert.equal((await w.admin('blockedname', 'block')).body.status, 'blocked');
        // The test node's name (reserved by policy, its row made by hand), paused by the admin and still answered at:
        // no special case, the same refusal.
        w.sqlite.prepare(`INSERT INTO name_allocations (name, node_pubkey, hostname, mode, status, pause_reason, paused_at, attest_fails, requested_at)
            VALUES ('test', ?, 'test.beanpool.org', 'tunnel', 'paused', 'admin', ?, 0, ?)`).run(keys[4].pubHex, nowS() - DAY, nowS() - 60 * DAY);

        for (const [name, status] of [['livename', 'live'], ['waiting', 'pending'], ['pausedname', 'paused'], ['blockedname', 'blocked'], ['test', 'paused']]) {
            const before = await w.row(name);
            const route = routing(w, name);
            const r = await forget(w, name);
            assert.equal(r.status, 409, `${name}: ${JSON.stringify(r.body)}`);
            assert.equal(r.body.status, status);
            assert.match(r.body.error, new RegExp(`^${name} is ${status}: only a released name nobody holds can be removed from the list$`));
            assert.deepEqual(await w.row(name), before, `${name}: the row is untouched`);
            assert.deepEqual(routing(w, name), route, `${name}: Cloudflare is untouched`);
            assert.deepEqual(removedEvents(w, name), []);
        }
        assert.deepEqual((await forget(w, 'nosuchname')), { status: 404, body: { error: 'unknown name' } });
        assert.equal((await w.row('livename')).status, 'live');
        assert.equal((await w.status(keys[0])).body.status, 'live', 'the live name still answers its node as live');
    } finally { w.restore(); }
});

test('forget refuses a release still inside its hold (the owner\'s, the admin\'s, the admin\'s of a blocked name): Free now first', async () => {
    const w = await world();
    try {
        const [a, b, c, stranger] = await Promise.all([makeKey(), makeKey(), makeKey(), makeKey()]);
        await liveName(w, 'ownerrel', a);
        assert.equal((await w.release(a)).body.status, 'released');
        await liveName(w, 'adminrel', b);
        assert.equal((await w.admin('adminrel', 'release')).body.status, 'released');
        await liveName(w, 'blockrel', c);
        await w.admin('blockrel', 'block');
        assert.equal((await w.admin('blockrel', 'release')).body.reason, 'admin-held-all');

        for (const name of ['ownerrel', 'adminrel', 'blockrel']) {
            const before = await w.row(name);
            assert.equal(holdsName(w.env, before), true);
            const r = await forget(w, name);
            assert.equal(r.status, 409, `${name}: ${JSON.stringify(r.body)}`);
            assert.equal(r.body.status, 'released');
            assert.equal(r.body.held_until, before.released_at + COOLOFF);
            assert.match(r.body.error, /is still held .* free it now first$/);
            assert.deepEqual(await w.row(name), before, `${name}: untouched, still held`);
            assert.equal((await w.claim(stranger, { name })).status, 409, `${name}: still nobody else's to claim`);
        }
        // The key the admin blocked stays out through its release's hold: forget did not cut it short.
        assert.equal((await w.claim(c, { name: 'blockrel' })).status, 403);

        // Freed now, nobody holds it: then it can be removed.
        assert.equal((await w.admin('adminrel', 'release', FREE_NOW)).status, 200);
        assert.deepEqual(await forget(w, 'adminrel'), { status: 200, body: { status: 'abandoned', name: 'adminrel' } });
        // Past its hold, the owner's release keeps nobody else off the name, but its key can still take it back: forget
        // refuses it (r4302742456, the test below), and removes it once Free now has ended that. The admin's release of
        // the blocked name, past its hold, is free to that key too, but only as a new claimant: removed as it is.
        await w.backdate('ownerrel', { released_at: nowS() - COOLOFF - 60 });
        assert.equal((await forget(w, 'ownerrel')).status, 409);
        assert.equal((await w.admin('ownerrel', 'release', FREE_NOW)).status, 200);
        assert.equal((await forget(w, 'ownerrel')).status, 200);
        await w.backdate('blockrel', { released_at: nowS() - COOLOFF - 60 });
        assert.deepEqual(await forget(w, 'blockrel'), { status: 200, body: { status: 'abandoned', name: 'blockrel' } });
    } finally { w.restore(); }
});

// Review r4302742456: past its hold an owner's release, or the admin's default one, holds the name from nobody else, but
// its old key still takes it back as its own (isOwnRow): live without the admin's approval on a gated name, outside the
// new-name budget on an auto one. Abandoning the row would end that, so forget refuses it too: "Free now" first, which
// ends it on purpose.
test('forget refuses a release its old key can still take back, past the hold too: the take-back stays; Free now ends it', async () => {
    const w = await world();
    try {
        const [a, b, c, d] = await Promise.all([makeKey(), makeKey(), makeKey(), makeKey()]);
        // A gated name, approved, released by its owner; an auto one released by its owner; one the admin released with
        // its default hold — each past its hold. And a gated one, approved and released, that the admin then frees now.
        for (const n of ['gatedrel', 'gatedfreed']) w.sqlite.prepare("INSERT INTO name_policy (pattern, tier) VALUES (?, 'gated')").run(n);
        for (const [name, key] of [['gatedrel', a], ['gatedfreed', d]]) {
            assert.equal((await w.claim(key, { name })).body.status, 'pending');
            assert.equal((await w.admin(name, 'approve')).body.status, 'live');
            assert.equal((await w.release(key)).body.status, 'released');
        }
        await liveName(w, 'autorel', b);
        assert.equal((await w.release(b)).body.status, 'released');
        await liveName(w, 'adminheld', c);
        assert.equal((await w.admin('adminheld', 'release')).body.status, 'released');
        for (const n of ['gatedrel', 'gatedfreed', 'autorel', 'adminheld']) await w.backdate(n, { released_at: nowS() - COOLOFF - 60 });

        for (const [name, by] of [['gatedrel', 'owner'], ['autorel', 'owner'], ['adminheld', 'admin-held']]) {
            const before = await w.row(name);
            assert.equal(holdsName(w.env, before), false, `${name}: past its hold, nobody else is kept off it`);
            const r = await forget(w, name);
            assert.equal(r.status, 409, `${name}: ${JSON.stringify(r.body)}`);
            assert.deepEqual(r.body, { status: 'released', takes_back: true, error: `${name} can still be taken back by the key that released it (${by}): free it now first` });
            assert.deepEqual(await w.row(name), before, `${name}: untouched`);
            assert.deepEqual(removedEvents(w, name), []);
            const shown = (await listed(w)).find((x) => x.name === name);
            assert.deepEqual([shown.holds, shown.takes_back], [false, true], `${name}: /pending says its key can take it back`);
        }
        // The bulk form refuses it the same way, and its phone hears of nothing.
        const bulk = await forgetMany(w, { names: ['gatedrel', 'autorel'] });
        assert.deepEqual(bulk.body, { removed: [], refused: [
            { name: 'gatedrel', status: 'released', takes_back: true, error: 'gatedrel can still be taken back by the key that released it (owner): free it now first' },
            { name: 'autorel', status: 'released', takes_back: true, error: 'autorel can still be taken back by the key that released it (owner): free it now first' },
        ] });
        assert.equal(w.sqlite.prepare("SELECT COUNT(*) AS n FROM alert_outbox WHERE title LIKE 'You removed%'").get().n, 0);

        // The take-back is what it was: the gated name goes live again with no approval, and the auto one comes back
        // with the new-name budget spent (an own name is outside it).
        const back = await w.claim(a, { name: 'gatedrel' });
        assert.equal(back.status, 200, JSON.stringify(back.body));
        assert.equal(back.body.status, 'live');
        w.env.NEW_NAMES_PER_HOUR = '1';
        assert.equal((await w.claim(await makeKey(), { name: 'someother' })).status, 429, 'the budget is spent');
        const auto = await w.claim(b, { name: 'autorel' });
        assert.equal(auto.status, 200, JSON.stringify(auto.body));
        assert.equal(auto.body.status, 'live');
        delete w.env.NEW_NAMES_PER_HOUR;

        // Free now ends the take-back, on purpose: then nobody holds it, it can be removed, and its old key is a new
        // claimant — on a gated name, one that waits for the admin's approval again.
        assert.equal((await w.admin('gatedfreed', 'release', FREE_NOW)).status, 200);
        const freedRow = await w.row('gatedfreed');
        assert.equal(isOwnRow(freedRow, d.pubHex), false);
        assert.equal((await listed(w)).find((x) => x.name === 'gatedfreed').takes_back, false);
        assert.deepEqual(await forget(w, 'gatedfreed'), { status: 200, body: { status: 'abandoned', name: 'gatedfreed' } });
        const again = await w.claim(d, { name: 'gatedfreed' });
        assert.equal(again.status, 200, JSON.stringify(again.body));
        assert.equal(again.body.status, 'pending');
    } finally { w.restore(); }
});

test('forget of a release nobody holds: abandoned, an event, gone from the list — and still free to anyone, as before', async () => {
    const w = await world();
    try {
        const [owner, stranger] = await Promise.all([makeKey(), makeKey()]);
        await freed(w, 'cairnstest');
        // The owner's own release past its hold (a July test name): free to others, but its old key could still take it
        // back, which forget would end — so it is refused (the test above) until the admin frees it now, as /admin offers.
        await liveName(w, 'wow', owner);
        await w.release(owner);
        await w.backdate('wow', { released_at: nowS() - COOLOFF - 60 });
        assert.equal((await forget(w, 'wow')).status, 409);
        assert.equal((await w.admin('wow', 'release', FREE_NOW)).status, 200);

        for (const name of ['cairnstest', 'wow']) {
            const before = await w.row(name);
            const holder = (await w.holder(stranger, { name })).body;
            assert.deepEqual(holder, { name, held: 'free' });
            assert.equal((await w.available(name)).body.available, true);
            assert.ok((await listed(w)).some((a) => a.name === name), `${name} is listed before`);

            const r = await forget(w, name);
            assert.deepEqual(r, { status: 200, body: { status: 'abandoned', name } });
            const after = await w.row(name);
            assert.equal(after.status, 'abandoned');
            assert.equal(after.decision_seq, (before.decision_seq ?? 0) + 1, 'a decision: a request that read the row before misses');
            // Who may claim it is what it was: free, to anyone.
            assert.equal(holdsName(w.env, before), false);
            assert.equal(holdsName(w.env, after), false, 'holdsName and the released row agree: free before, free after');
            assert.deepEqual((await w.holder(stranger, { name })).body, holder);
            assert.equal((await w.available(name)).body.available, true);
            assert.ok(!(await listed(w)).some((a) => a.name === name), `${name} is gone from the list`);
            const ev = removedEvents(w, name);
            assert.equal(ev.length, 1);
            assert.match(ev[0].detail, /^removed from the list by the admin \(was released\/(admin|owner), free since \d{4}-\d\d-\d\dT[^)]+\): abandoned, free to anyone as it was$/);
        }
        // Again: nothing more to do, it says so (already), and no second event.
        assert.deepEqual(await forget(w, 'cairnstest'), { status: 200, body: { status: 'abandoned', name: 'cairnstest', already: true } });
        assert.equal(removedEvents(w, 'cairnstest').length, 1);

        // Claimed again: by a new key, and by the old one (a new claimant now: its row was abandoned).
        const c = await w.claim(stranger, { name: 'cairnstest' });
        assert.equal(c.status, 200, JSON.stringify(c.body));
        assert.equal(c.body.status, 'live');
        assert.equal((await w.row('cairnstest')).node_pubkey, stranger.pubHex);
        const back = await w.claim(owner, { name: 'wow' });
        assert.equal(back.status, 200, JSON.stringify(back.body));
        assert.equal(back.body.status, 'live');
        assert.equal((await w.row('cairnstest')).status, 'live');
        // Held again, it can't be removed.
        assert.equal((await forget(w, 'cairnstest')).status, 409);
    } finally { w.restore(); }
});

test('Remove all released: the bulk form removes only the releases nobody holds; the rest is refused, each saying why', async () => {
    const w = await world();
    try {
        const [k1, k2, k3] = await Promise.all([makeKey(), makeKey(), makeKey()]);
        await freed(w, 'tst1');
        await freed(w, 'tst2');
        await liveName(w, 'heldrel', k1);
        await w.release(k1);
        await liveName(w, 'livename', k2);
        await liveName(w, 'number1', k3);
        await w.admin('number1', 'pause');
        const before = Object.fromEntries(await Promise.all(['heldrel', 'livename', 'number1'].map(async (n) => [n, await w.row(n)])));

        const r = await forgetMany(w, { names: ['tst1', 'TST2', 'heldrel', 'livename', 'tst1'] });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.deepEqual(r.body.removed, ['tst1', 'tst2']);
        const until = before.heldrel.released_at + COOLOFF;
        assert.deepEqual(r.body.refused, [
            { name: 'heldrel', status: 'released', held_until: until, error: `heldrel is still held (owner) until ${new Date(until * 1000).toISOString()}: free it now first` },
            { name: 'livename', status: 'live', error: 'livename is live: only a released name nobody holds can be removed from the list' },
        ]);
        const r2 = await forgetMany(w, { names: ['number1', 'nosuchname'] });
        assert.deepEqual(r2, { status: 200, body: { removed: [], refused: [
            { name: 'number1', status: 'paused', error: 'number1 is paused: only a released name nobody holds can be removed from the list' },
            { name: 'nosuchname', error: 'unknown name' },
        ] } });
        for (const n of ['tst1', 'tst2']) {
            assert.equal((await w.row(n)).status, 'abandoned');
            assert.equal(removedEvents(w, n).length, 1);
        }
        for (const n of ['heldrel', 'livename', 'number1']) {
            assert.deepEqual(await w.row(n), before[n], `${n}: untouched`);
            assert.deepEqual(removedEvents(w, n), []);
        }
        // The admin's phone hears of it once, in a count — and not at all of a request that removed nothing.
        const told = w.sqlite.prepare("SELECT title, body, name FROM alert_outbox WHERE title LIKE 'You removed%'").all().map((x) => ({ ...x }));
        assert.deepEqual(told, [{ title: 'You removed 2 released names from the list', body: 'You removed 2 released names from the list: free to anyone, as they were.', name: null }]);

        // Bodies it refuses whole, touching nothing: more than 5 names (after folding case and repeats) among them.
        for (const body of [{}, { names: [] }, { names: 'tst1' }, { names: ['Not A Name!'] }, { names: Array.from({ length: 6 }, (_, i) => `name${i}`) }, '{not json']) {
            const bad = await forgetMany(w, body);
            assert.equal(bad.status, 400, JSON.stringify(body));
        }
        assert.equal((await w.row('livename')).status, 'live');
    } finally { w.restore(); }
});

// Review r4302742478: a forget of a name already removed did nothing, but both routes took its 200 as "removed": the
// phone was told again, and the bulk counted it. A double click, or Remove all released in two tabs, told the admin of
// removals that never happened.
test('a forget of a name already removed says so (already): no second event, no alert, not counted as removed', async () => {
    const w = await world();
    try {
        for (const n of ['twice', 'tabone', 'tabtwo']) await freed(w, n);
        const told = () => w.sqlite.prepare("SELECT title FROM alert_outbox WHERE title LIKE 'You removed%' ORDER BY id").all().map((x) => x.title);

        assert.deepEqual(await forget(w, 'twice'), { status: 200, body: { status: 'abandoned', name: 'twice' } });
        assert.deepEqual(await forget(w, 'twice'), { status: 200, body: { status: 'abandoned', name: 'twice', already: true } });
        assert.deepEqual(await forgetMany(w, { names: ['twice'] }), { status: 200, body: { removed: [], refused: [], already: ['twice'] } });
        assert.equal(removedEvents(w, 'twice').length, 1);
        assert.deepEqual(told(), ['You removed twice from the list']);

        // Two tabs, the same batch: the second removes nothing, and says which were removed already.
        assert.deepEqual((await forgetMany(w, { names: ['tabone', 'tabtwo'] })).body, { removed: ['tabone', 'tabtwo'], refused: [] });
        assert.deepEqual((await forgetMany(w, { names: ['tabone', 'tabtwo'] })).body, { removed: [], refused: [], already: ['tabone', 'tabtwo'] });
        assert.deepEqual(told(), ['You removed twice from the list', 'You removed 2 released names from the list']);
        for (const n of ['tabone', 'tabtwo']) assert.equal(removedEvents(w, n).length, 1);

        // The page counts only what this click removed, and names what was removed already.
        const p = await page(w);
        p.ctx.renderActive([row('tabone', 'released', { pause_reason: 'admin', released_at: 1 }), row('fresh', 'released', { pause_reason: 'admin', released_at: 1 })]);
        p.ctx.fetch = async (url, init = {}) => {
            p.sent.push({ url, init });
            return { ok: true, status: 200, json: async () => ({ removed: ['fresh'], refused: [], already: ['tabone'], allocations: [], events: [] }) };
        };
        await p.click({ 'data-forget-all': '1' });
        assert.equal(p.alerts.at(-1), 'Removed 1 from the list.\n\nAlready removed: tabone');
    } finally { w.restore(); }
});

test('one bulk request of 5 names stays inside D1\'s smallest per-invocation budget (50 queries), its alert sent in it too', async () => {
    // The alert channel set: the alert's send runs in the same invocation (waitUntil), and fails here (no network),
    // which is its costliest path.
    const w = await world({ env: { NTFY_URL: 'https://ntfy.example/beanpool-admin' } });
    try {
        const names = ['bulk1', 'bulk2', 'bulk3', 'bulk4', 'bulk5'];
        for (const n of names) await freed(w, n);
        const real = w.env.DB;
        let queries = 0;
        w.env.DB = { prepare: (sql) => { queries++; return real.prepare(sql); } };
        const r = await forgetMany(w, { names });
        w.env.DB = real;
        assert.deepEqual(r.body.removed, names);
        assert.ok(queries <= 50, `${queries} D1 queries`);
    } finally { w.restore(); }
});

test('forget deletes a tunnel and record a release left at Cloudflare first — or owes them, and the sweep deletes them', async () => {
    const w = await world();
    try {
        const [a, b, stranger] = await Promise.all([makeKey(), makeKey(), makeKey()]);
        // Two releases whose deletes Cloudflare refused: the rows still record their tunnel and record.
        for (const [name, key] of [['leftover', a], ['refused', b]]) {
            await liveName(w, name, key);
            w.cf.fail.deleteTunnel = true; w.cf.fail.deleteDns = true;
            assert.equal((await w.admin(name, 'release', FREE_NOW)).status, 200);
            w.cf.fail.deleteTunnel = false; w.cf.fail.deleteDns = false;
            const row = await w.row(name);
            assert.equal(row.status, 'released');
            assert.ok(row.tunnel_id && row.dns_record_id, `${name}: the release left both`);
            assert.ok(w.cf.liveTunnel(row.tunnel_id) && w.cf.recordAt(`${name}.beanpool.org`));
            assert.deepEqual(teardownOf(w, name).map((t) => t.kind), ['dns'], `${name}: the release owes its record, not its tunnel`);
        }

        // Cloudflare answers now: forget deletes both, and the row records neither.
        assert.equal((await forget(w, 'leftover')).status, 200);
        assert.deepEqual(routing(w, 'leftover'), { dns: null, tunnels: [] });
        const gone = await w.row('leftover');
        assert.deepEqual([gone.status, gone.tunnel_id, gone.dns_record_id], ['abandoned', null, null]);
        assert.match(removedEvents(w, 'leftover')[0].detail, /; its leftover tunnel and DNS record deleted at Cloudflare$/);

        // Cloudflare refuses again: the row keeps both, and both are owed — the tunnel too, which no release owes.
        const kept = await w.row('refused');
        w.cf.fail.deleteTunnel = true; w.cf.fail.deleteDns = true;
        assert.equal((await forget(w, 'refused')).status, 200);
        w.cf.fail.deleteTunnel = false; w.cf.fail.deleteDns = false;
        const owed = await w.row('refused');
        assert.deepEqual([owed.status, owed.tunnel_id, owed.dns_record_id], ['abandoned', kept.tunnel_id, kept.dns_record_id]);
        assert.deepEqual(teardownOf(w, 'refused'), [{ kind: 'dns', cf_id: kept.dns_record_id }, { kind: 'tunnel', cf_id: kept.tunnel_id }]);
        assert.match(removedEvents(w, 'refused')[0].detail, /Cloudflare refused the tunnel and DNS record: owed, the sweep retries$/);
        assert.ok(w.cf.liveTunnel(kept.tunnel_id));

        // The sweep deletes what is owed; nothing is left that nobody records.
        await attestSweep(w.env);
        assert.deepEqual(routing(w, 'refused'), { dns: null, tunnels: [] });
        assert.deepEqual(teardownOf(w, 'refused'), []);
        // And the name is anyone's: a new key's claim goes live on a fresh tunnel.
        const c = await w.claim(stranger, { name: 'refused' });
        assert.equal(c.status, 200, JSON.stringify(c.body));
        assert.equal(c.body.status, 'live');
        assert.notEqual((await w.row('refused')).tunnel_id, kept.tunnel_id);
    } finally { w.restore(); }
});

test('forget, one name or many, needs the admin secret: 401 without it, and nothing changes', async () => {
    const w = await world();
    try {
        await freed(w, 'guarded');
        const before = await w.row('guarded');
        const none = {};
        const wrong = { 'x-admin-secret': 'wrong' };
        for (const headers of [none, wrong]) {
            assert.deepEqual(await forget(w, 'guarded', headers), { status: 401, body: { error: 'unauthorized' } });
            assert.deepEqual(await forgetMany(w, { names: ['guarded'] }, headers), { status: 401, body: { error: 'unauthorized' } });
        }
        // No ADMIN_SECRET set: nobody is the admin, not even with the old secret.
        const secret = w.env.ADMIN_SECRET;
        w.env.ADMIN_SECRET = '';
        assert.equal((await forget(w, 'guarded')).status, 401);
        assert.equal((await forgetMany(w, { names: ['guarded'] })).status, 401);
        w.env.ADMIN_SECRET = secret;
        // A GET is no forget.
        const get = await worker.fetch(new Request('https://beanpool.org/api/local/admin/registrar/guarded/forget', { headers: SECRET }), w.env);
        assert.equal(get.status, 404);
        assert.deepEqual(await w.row('guarded'), before);
        assert.deepEqual(removedEvents(w, 'guarded'), []);
    } finally { w.restore(); }
});

test('/pending tells the page which rows hold their name now (holdsName), and until when a held release holds', async () => {
    const w = await world();
    try {
        const [a, b, c] = await Promise.all([makeKey(), makeKey(), makeKey()]);
        await liveName(w, 'livename', a);
        await liveName(w, 'heldrel', b);
        await w.release(b);
        await liveName(w, 'oldrel', c);
        await w.release(c);
        await w.backdate('oldrel', { released_at: nowS() - COOLOFF - 60 });
        await freed(w, 'freedname');
        const rows = Object.fromEntries((await listed(w)).map((x) => [x.name, x]));
        assert.deepEqual(Object.keys(rows).sort(), ['freedname', 'heldrel', 'livename', 'oldrel']);
        for (const [name, row] of Object.entries(rows)) assert.equal(row.holds, holdsName(w.env, await w.row(name)), name);
        assert.deepEqual(Object.fromEntries(Object.entries(rows).map(([n, x]) => [n, [x.holds, x.held_until ?? null]])), {
            livename: [true, null], heldrel: [true, rows.heldrel.released_at + COOLOFF], oldrel: [false, null], freedname: [false, null],
        });
        // A release says too whether its old key can still take it back (isOwnRow): past the hold too (r4302742456).
        for (const [name, row] of Object.entries(rows)) if (row.status === 'released') assert.equal(row.takes_back, isOwnRow(await w.row(name), row.node_pubkey), name);
        assert.deepEqual(Object.fromEntries(Object.entries(rows).map(([n, x]) => [n, x.takes_back ?? null])), {
            livename: null, heldrel: true, oldrel: true, freedname: false,
        });
    } finally { w.restore(); }
});

// ── The page ──────────────────────────────────────────────────────────────────────────────────────────────────────

// The served page: its CSS, and its script run against a stub document — what it draws and what its buttons send.
async function page(w) {
    const html = await (await worker.fetch(new Request('https://beanpool.org/admin'), w.env)).text();
    const css = html.split('<style>')[1].split('</style>')[0];
    const script = html.split('<script>')[1].split('</script>')[0];
    const els = {};
    const sent = [];
    const confirms = [];
    const alerts = [];
    const clicks = [];
    const released = { open: false };   // the Released section, as the admin left it
    const el = (id) => (els[id] ??= {
        id, innerHTML: '', value: '', textContent: '', style: {}, addEventListener() {},
        querySelector: (sel) => (sel === 'details.released' && /<details class="released"/.test(els[id].innerHTML) ? released : null),
    });
    const ctx = {
        console,
        document: {
            getElementById: el,
            addEventListener: (type, fn) => { if (type === 'click') clicks.push(fn); },
            querySelector: () => null,
        },
        sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        confirm: (text) => { confirms.push(text); return true; },
        alert: (text) => { alerts.push(text); },
        fetch: async (url, init = {}) => {
            sent.push({ url, init });
            const names = init.body ? JSON.parse(init.body).names : undefined;
            return { ok: true, status: 200, json: async () => ({ status: 'abandoned', removed: names || [], refused: [], allocations: [], events: [] }) };
        },
    };
    vm.createContext(ctx);
    vm.runInContext(script, ctx);
    // A click on an element carrying `attrs`, through the page's own click handlers.
    const click = async (attrs) => {
        const target = {
            closest: (sel) => {
                const m = /^\[([a-z-]+)\]$/.exec(sel);
                return m && attrs[m[1]] !== undefined ? { getAttribute: (k) => attrs[k] ?? null } : null;
            },
        };
        for (const fn of clicks) await fn({ target });
        await new Promise((r) => setImmediate(r));
    };
    return { css, ctx, els, sent, confirms, alerts, released, click };
}

const key = 'ab'.repeat(32);
const row = (name, status, extra = {}) => ({ name, status, node_pubkey: key, mode: 'tunnel', holds: status !== 'released', ...extra });

test('the page: held names first; released ones in a collapsed "Released (N)", each with Free now or Remove from the list', async () => {
    const w = await world();
    try {
        const p = await page(w);
        p.ctx.renderActive([
            row('livename', 'live'),
            row('number1', 'paused', { pause_reason: 'admin', paused_at: 1 }),
            row('testyeah', 'paused', { pause_reason: 'impostor', paused_at: 1 }),
            row('aitest1017', 'blocked', { pause_reason: 'admin', paused_at: 1 }),
            row('heldrel', 'released', { pause_reason: 'owner', released_at: 1, holds: true, held_until: 1790000000 }),
            row('cairns', 'released', { pause_reason: 'admin', released_at: 1 }),
            row('wow', 'released', { pause_reason: 'owner', released_at: 1 }),
            // A row that doesn't say whether it holds (an older Worker): treated as held, never offered for removal.
            { name: 'unsaid', status: 'released', pause_reason: 'owner', node_pubkey: key, mode: 'tunnel', released_at: 1 },
        ]);
        const html = p.els.activeTableContainer.innerHTML;
        const [held, rest] = html.split('<div class="released-head">');
        assert.ok(rest, 'a Released section');
        for (const n of ['livename', 'number1', 'testyeah', 'aitest1017']) assert.match(held, new RegExp(`id="row-${n}"`));
        for (const n of ['heldrel', 'cairns', 'wow', 'unsaid']) {
            assert.doesNotMatch(held, new RegExp(`row-${n}"`), `${n} is not among the held names`);
            assert.match(rest, new RegExp(`id="row-${n}"`));
        }
        assert.match(rest, /<details class="released"><summary>Released \(4\)<\/summary>/, 'collapsed by default');
        assert.match(rest, /<button data-forget-all="1"[^>]*>Remove all released \(2\)<\/button>/);
        assert.match(rest, /2 still held stay until their hold ends/);
        // Free now while held; Remove from the list once nobody holds it.
        assert.match(rest, /data-name="heldrel" data-action="release" data-free-now="1"/);
        assert.match(rest, /held for its key until /);
        for (const n of ['cairns', 'wow']) {
            assert.match(rest, new RegExp(`data-name="${n}" data-action="forget"[^>]*>Remove from the list<`));
            assert.doesNotMatch(rest, new RegExp(`data-name="${n}" data-action="release"`));
        }
        for (const n of ['heldrel', 'unsaid']) assert.doesNotMatch(rest, new RegExp(`data-name="${n}" data-action="forget"`));
        // Paused (the admin's or the sweep's) and blocked names can be released, with a "free now" box.
        for (const n of ['number1', 'testyeah', 'aitest1017']) {
            assert.match(held, new RegExp(`<input type="checkbox" data-free-now-for="${n}"> free now</label><button data-name="${n}" data-action="release"`));
        }
        assert.match(held, /data-name="number1" data-action="release" data-held-from-all="1"/, 'an admin pause: held from every key');
        assert.doesNotMatch(held, /data-name="testyeah" data-action="release" data-held-from-all/, 'a sweep pause: held for its key');
        assert.doesNotMatch(held, /data-name="livename" data-action="release"/);

        // Opened, it stays open when the list is drawn again (after an action).
        p.released.open = true;
        p.ctx.renderActive([row('cairns', 'released', { pause_reason: 'admin', released_at: 1 })]);
        assert.match(p.els.activeTableContainer.innerHTML, /<p [^>]*>No names held now\.<\/p>.*<details class="released" open><summary>Released \(1\)<\/summary>/s);
    } finally { w.restore(); }
});

test('the page: Remove from the list posts forget for that name; Remove all released sends only the free names, 5 a request', async () => {
    const w = await world();
    try {
        const p = await page(w);
        const free = Array.from({ length: 12 }, (_, i) => row(`test${i}`, 'released', { pause_reason: 'admin', released_at: 1 }));
        p.ctx.renderActive([row('livename', 'live'), row('heldrel', 'released', { pause_reason: 'owner', released_at: 1, holds: true }), ...free]);

        await p.click({ 'data-name': 'test7', 'data-action': 'forget' });
        assert.match(p.confirms.at(-1), /^Remove test7\.beanpool\.org from the list\?\n\nNobody holds it: it stays free to anyone/);
        const one = p.sent.filter((s) => /\/forget$/.test(s.url));
        assert.deepEqual(one.map((s) => [s.url, s.init.method, s.init.body]), [['/api/local/admin/registrar/test7/forget', 'POST', undefined]]);

        await p.click({ 'data-forget-all': '1' });
        assert.match(p.confirms.at(-1), /^Remove 12 released names nobody holds from the list\?/);
        const bulk = p.sent.filter((s) => s.url === '/api/local/admin/registrar/forget');
        assert.deepEqual(bulk.map((s) => JSON.parse(s.init.body).names.length), [5, 5, 2]);
        const names = bulk.flatMap((s) => JSON.parse(s.init.body).names);
        assert.deepEqual(names, free.map((f) => f.name), 'every free name once, and only those');
        assert.equal(bulk.every((s) => s.init.method === 'POST' && s.init.headers['content-type'] === 'application/json'), true);
        assert.match(p.alerts.at(-1), /^Removed 12 from the list\.$/);
    } finally { w.restore(); }
});

test('the page: a release its key can still take back keeps Free now, says so, and is left out of Remove all released', async () => {
    const w = await world();
    try {
        const p = await page(w);
        p.ctx.renderActive([
            row('heldrel', 'released', { pause_reason: 'owner', released_at: 1, holds: true, takes_back: true, held_until: 1790000000 }),
            row('oldrel', 'released', { pause_reason: 'owner', released_at: 1, takes_back: true }),
            row('oldadmin', 'released', { pause_reason: 'admin-held', released_at: 1, takes_back: true }),
            row('cairns', 'released', { pause_reason: 'admin', released_at: 1, takes_back: false }),
        ]);
        const html = p.els.activeTableContainer.innerHTML;
        assert.match(html, /<button data-forget-all="1"[^>]*>Remove all released \(1\)<\/button>/);
        assert.match(html, / 1 still held stays until its hold ends \(or "Free now"\)\. 2 stay while the keys that released them can take them back \("Free now" ends that\)\./);
        for (const n of ['oldrel', 'oldadmin']) {
            assert.match(html, new RegExp(`data-name="${n}" data-action="release" data-free-now="1" data-takes-back="1"[^>]*>Free now<`));
            assert.doesNotMatch(html, new RegExp(`data-name="${n}" data-action="forget"`));
        }
        assert.match(html, /free to others; its key can take it back/);
        assert.match(html, /data-name="heldrel" data-action="release" data-free-now="1" class/, 'a held release: Free now, as before');
        assert.match(html, /data-name="cairns" data-action="forget"[^>]*>Remove from the list</);

        // Its Free now says what it ends, and sends a release that frees it now.
        await p.click({ 'data-name': 'oldrel', 'data-action': 'release', 'data-free-now': '1', 'data-takes-back': '1' });
        assert.match(p.confirms.at(-1), /^⚠️ FREE oldrel\.beanpool\.org NOW\?\n\nIt is free to others already, but the key that released it can still take it back as its own/);
        const sent = p.sent.filter((s) => s.url === '/api/local/admin/registrar/oldrel/release');
        assert.deepEqual(sent.map((s) => s.init.body), [JSON.stringify({ free_now: true })]);
        // Remove all released sends only the one nobody can take back.
        await p.click({ 'data-forget-all': '1' });
        const bulk = p.sent.filter((s) => s.url === '/api/local/admin/registrar/forget');
        assert.deepEqual(bulk.map((s) => JSON.parse(s.init.body).names), [['cairns']]);
    } finally { w.restore(); }
});

test('the page\'s tables fit their card: column shares that add up to 100%, nothing no-wrap or wider than the card, stacked when narrow', async () => {
    const w = await world();
    try {
        const p = await page(w);
        // Shares of the card, never a width (or a minimum one) in px, rem or em on a table, its cells, its column
        // shares or its buttons. (A stacked cell's label, ::before, is a line inside a full-width cell, not a column.)
        const share = Object.fromEntries([...p.css.matchAll(/\.(w-[a-z-]+) \{ width: (\d+)%; \}/g)].map((m) => [m[1], Number(m[2])]));
        const rules = [...p.css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
        const tableRules = rules.filter((r) => /admin-table|\.acts|\.pair|\.btn|\.w-/.test(r.sel) && !r.sel.includes('::before'));
        assert.ok(tableRules.length >= 10, 'the table rules were found');
        for (const r of tableRules) assert.doesNotMatch(r.body, /(^|[\s;])(min-)?width:\s*\d+(\.\d+)?(px|rem|em)/, `${r.sel}: no fixed width`);
        assert.match(p.css, /\.admin-table\.stack \{ table-layout: fixed; \}/);
        assert.match(p.css, /\.admin-table th, \.admin-table td \{ overflow-wrap: anywhere; \}/);
        assert.match(p.css, /\.acts \{ display: flex; flex-wrap: wrap;/);
        assert.match(p.css, /\.pair \{ display: inline-flex; flex-wrap: wrap;/);
        // Below the card's widest (1000px), every .stack table's rows are stacked: no columns to run past the card.
        assert.match(p.css, /@media \(max-width: 1000px\) \{\s*\.admin-table\.stack thead \{ display: none; \}\s*\.admin-table\.stack, \.admin-table\.stack tbody, \.admin-table\.stack tr, \.admin-table\.stack td \{ display: block; width: 100%; \}/);

        p.ctx.renderActive([
            row('livename', 'live'), row('number1', 'paused', { pause_reason: 'admin', paused_at: 1 }),
            row('aitest1017', 'blocked', { pause_reason: 'admin', paused_at: 1 }), row('cairns', 'released', { pause_reason: 'admin', released_at: 1 }),
        ]);
        p.ctx.renderPending([{ name: 'sydney', status: 'pending', node_pubkey: key, mode: 'tunnel', requested_at: 1 }]);
        for (const id of ['activeTableContainer', 'pendingTableContainer']) {
            const html = p.els[id].innerHTML;
            const tables = html.match(/<table class="admin-table stack">.*?<\/thead>/gs);
            assert.ok(tables?.length, id);
            for (const head of tables) {
                const cols = [...head.matchAll(/<th class="(w-[a-z-]+)/g)].map((m) => m[1]);
                assert.equal(cols.length, [...head.matchAll(/<th[ >]/g)].length, `${id}: every column has a share`);
                assert.equal(cols.reduce((s, c) => s + share[c], 0), 100, `${id}: the shares fill the card exactly`);
            }
            assert.doesNotMatch(html, /white-space:\s*nowrap|width:\s*\d/, `${id}: no no-wrap cell, no inline width`);
            assert.doesNotMatch(html, /<td[^>]*text-align: right/, `${id}: the actions sit in a wrapping row, not a right-aligned cell`);
            assert.match(html, /<td><div class="acts">/);
        }
    } finally { w.restore(); }
});
