// The /admin tidy (Marty, 2026-10-17: "a heap of old test ones — delete all the unused stuff", "bad UI"): "Remove from
// the list" (forget) and its bulk form, the hold facts /pending gives the page, and the page itself — released names
// collapsed, tables that fit their card. Every test here fails on 3bc19acd (origin/main): it has no forget route
// (404), /pending says nothing of holds, and the page lists released names among the held ones, its Action column in
// a no-wrap cell past the card's edge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import worker, { holdsName, attestSweep } from '../src/index.js';
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
        // Past its hold, the owner's release holds nothing either.
        await w.backdate('ownerrel', { released_at: nowS() - COOLOFF - 60 });
        assert.equal((await forget(w, 'ownerrel')).status, 200);
    } finally { w.restore(); }
});

test('forget of a release nobody holds: abandoned, an event, gone from the list — and still free to anyone, as before', async () => {
    const w = await world();
    try {
        const [owner, stranger] = await Promise.all([makeKey(), makeKey()]);
        await freed(w, 'cairnstest');
        // The owner's own release past its hold (a July test name): free, and its old key could take it back.
        await liveName(w, 'wow', owner);
        await w.release(owner);
        await w.backdate('wow', { released_at: nowS() - COOLOFF - 60 });

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
        // Again: nothing more to do, and no second event.
        assert.deepEqual(await forget(w, 'cairnstest'), { status: 200, body: { status: 'abandoned', name: 'cairnstest' } });
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

        const r = await forgetMany(w, { names: ['tst1', 'TST2', 'heldrel', 'livename', 'number1', 'nosuchname', 'tst1'] });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.deepEqual(r.body.removed, ['tst1', 'tst2']);
        const until = before.heldrel.released_at + COOLOFF;
        assert.deepEqual(r.body.refused, [
            { name: 'heldrel', status: 'released', held_until: until, error: `heldrel is still held (owner) until ${new Date(until * 1000).toISOString()}: free it now first` },
            { name: 'livename', status: 'live', error: 'livename is live: only a released name nobody holds can be removed from the list' },
            { name: 'number1', status: 'paused', error: 'number1 is paused: only a released name nobody holds can be removed from the list' },
            { name: 'nosuchname', error: 'unknown name' },
        ]);
        for (const n of ['tst1', 'tst2']) {
            assert.equal((await w.row(n)).status, 'abandoned');
            assert.equal(removedEvents(w, n).length, 1);
        }
        for (const n of ['heldrel', 'livename', 'number1']) {
            assert.deepEqual(await w.row(n), before[n], `${n}: untouched`);
            assert.deepEqual(removedEvents(w, n), []);
        }
        // The admin's phone hears of it once, in a count.
        const told = w.sqlite.prepare("SELECT title, body, name FROM alert_outbox WHERE title LIKE 'You removed%'").all().map((x) => ({ ...x }));
        assert.deepEqual(told, [{ title: 'You removed 2 released names from the list', body: 'You removed 2 released names from the list: free to anyone, as they were.', name: null }]);

        // Bodies it refuses whole, touching nothing.
        for (const body of [{}, { names: [] }, { names: 'tst1' }, { names: ['Not A Name!'] }, { names: Array.from({ length: 51 }, (_, i) => `name${i}`) }, '{not json']) {
            const bad = await forgetMany(w, body);
            assert.equal(bad.status, 400, JSON.stringify(body));
        }
        assert.equal((await w.row('livename')).status, 'live');
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

test('the page: Remove from the list posts forget for that name; Remove all released sends only the free names, 50 a request', async () => {
    const w = await world();
    try {
        const p = await page(w);
        const free = Array.from({ length: 120 }, (_, i) => row(`test${i}`, 'released', { pause_reason: 'admin', released_at: 1 }));
        p.ctx.renderActive([row('livename', 'live'), row('heldrel', 'released', { pause_reason: 'owner', released_at: 1, holds: true }), ...free]);

        await p.click({ 'data-name': 'test7', 'data-action': 'forget' });
        assert.match(p.confirms.at(-1), /^Remove test7\.beanpool\.org from the list\?\n\nNobody holds it: it stays free to anyone/);
        const one = p.sent.filter((s) => /\/forget$/.test(s.url));
        assert.deepEqual(one.map((s) => [s.url, s.init.method, s.init.body]), [['/api/local/admin/registrar/test7/forget', 'POST', undefined]]);

        await p.click({ 'data-forget-all': '1' });
        assert.match(p.confirms.at(-1), /^Remove 120 released names nobody holds from the list\?/);
        const bulk = p.sent.filter((s) => s.url === '/api/local/admin/registrar/forget');
        assert.deepEqual(bulk.map((s) => JSON.parse(s.init.body).names.length), [50, 50, 20]);
        const names = bulk.flatMap((s) => JSON.parse(s.init.body).names);
        assert.deepEqual(names, free.map((f) => f.name), 'every free name once, and only those');
        assert.equal(bulk.every((s) => s.init.method === 'POST' && s.init.headers['content-type'] === 'application/json'), true);
        assert.match(p.alerts.at(-1), /^Removed 120 from the list\.$/);
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
