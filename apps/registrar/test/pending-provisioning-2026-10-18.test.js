// The stuck-pending bug (temp, aitest1017, 17 Oct; scratch/global-node/DESIGN-registrar-trust-fable.md §5): a claim of an
// auto name inserts its row 'pending', then makes the name at Cloudflare in about seven calls. When that did not finish —
// Cloudflare failed, or the node stopped waiting after 5 s and the Worker was cut off — the row stayed pending, /status
// called it 'awaiting-approval', the node waited for an approval nobody would give, and /admin listed it under "Awaiting
// your approval". The Worker's side of slice S1:
//   F1 a pending auto row is 'provisioning' (status, claim, heal), /pending says awaiting_approval per row, and /admin
//      lists it under "Setting up" (Finish now, Reject), apart from the gated claims;
//   F2 claim, heal and approve run under waitUntil, so a node that hangs up never cuts the work off (and, from the review
//      of #2125, rotate and release: Cloudflare work written to the row first);
//   F3 the sweep finishes a pending auto row over 2 minutes old (at most 3 a sweep), never a gated one.
// Every test here but one fails on origin/main 583a6cb0: /status answers 'awaiting-approval', /pending carries no
// awaiting_approval and the page one list, a claim cut off mid-way stays pending, and the sweep never looks at a pending
// row. The one is F3's guard (a blocked key's orphan, and one something else routes, are left alone), which main passes
// by finishing nothing at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import worker, { attestSweep } from '../src/index.js';
import { world, makeKey, attestsAs, routing, liveName } from './harness.js';

const SECRET = { 'x-admin-secret': 'test-admin-secret' };
const listed = async (w) => (await (await worker.fetch(new Request('https://beanpool.org/api/local/admin/registrar/pending', { headers: SECRET }), w.env)).json()).allocations;
// Mid-ensure: the tunnel is made, its ingress not yet set.
const MID_ENSURE = /^PUT \/accounts\/acct\/cfd_tunnel\/[^/]+\/configurations$/;
const claimBody = (name) => ({ name, mode: 'tunnel', origin: 'http://127.0.0.1:8080', community_name: `${name} commons` });

// A claim of `name` whose Cloudflare refused its tunnel: the row is the key's, pending, nothing made — then Cloudflare
// works again. `ago`: how long ago the claim was (requested_at moved back), for the sweep's two minutes.
async function orphan(w, key, name, ago = 0) {
    w.cf.fail.createTunnel = true;
    const r = await w.claim(key, { name });
    w.cf.fail.createTunnel = false;
    assert.equal(r.status, 502, JSON.stringify(r.body));
    assert.equal((await w.row(name)).status, 'pending');
    if (ago) await w.backdate(name, { requested_at: (await w.row(name)).requested_at - ago });
    return w.row(name);
}

// A live row is routed as it says: its record points at its tunnel, which Cloudflare has.
function routedLive(w, name, row) {
    assert.equal(row.status, 'live', `${name}: ${JSON.stringify(row)}`);
    const r = routing(w, name);
    assert.deepEqual(r.tunnels, [row.tunnel_id], `${name}: one tunnel, the row's (${JSON.stringify(r)})`);
    assert.equal(r.dns, `${row.tunnel_id}.cfargotunnel.com`, `${name}: its record points at it`);
}

// ── F1: honest words ──────────────────────────────────────────────────────────────────────────────────────────────

test('F1: a claim whose Cloudflare refused its tunnel is pending auto: /status says provisioning, never awaiting approval', async () => {
    const w = await world();
    try {
        const key = await makeKey();
        await orphan(w, key, 'temp');
        const st = await w.status(key);
        assert.equal(st.status, 200);
        assert.equal(st.body.status, 'pending');
        assert.equal(st.body.reason, 'provisioning', `an auto name waits for nobody's approval (${JSON.stringify(st.body)})`);
        assert.equal(st.body.tunnelToken, undefined, 'and has no token yet');

        // A gated claim is the one that waits for the admin.
        const gated = await makeKey();
        assert.equal((await w.claim(gated, { name: 'sydney' })).body.status, 'pending');   // gated in the 0001 seed
        assert.equal((await w.status(gated)).body.reason, 'awaiting-approval');
        const h = await w.heal(gated, { name: 'sydney' });
        assert.equal(h.body.reason, 'awaiting-approval', JSON.stringify(h.body));
    } finally { w.restore(); }
});

test('F1: a claim or heal that answers its pending auto row as it now is says provisioning too', async () => {
    const w = await world();
    try {
        const key = await makeKey();
        await orphan(w, key, 'temp');
        // The claim (its own name: a heal) misses: a decision lands on the row just after the claim read it, so it makes
        // nothing and answers the row as it now is — still pending, still an auto name being made.
        w.beforeRun(/^UPDATE name_allocations SET/, async () => {
            await w.backdate('temp', { decision_seq: ((await w.row('temp')).decision_seq ?? 0) + 1 });
        });
        const c = await w.claim(key, claimBody('temp'));
        assert.equal(c.status, 200, JSON.stringify(c.body));
        assert.deepEqual([c.body.status, c.body.reason], ['pending', 'provisioning'], JSON.stringify(c.body));
    } finally { w.restore(); }
});

test('F1: /pending says per row whether it awaits the admin; only a gated claim does', async () => {
    const w = await world();
    try {
        const [a, b, c] = await Promise.all([makeKey(), makeKey(), makeKey()]);
        await orphan(w, a, 'temp');
        assert.equal((await w.claim(b, { name: 'sydney' })).body.status, 'pending');
        assert.equal((await w.claim(c, claimBody('fine'))).body.status, 'live');
        const rows = Object.fromEntries((await listed(w)).map((r) => [r.name, r]));
        assert.equal(rows.temp.awaiting_approval, false, 'a pending auto name awaits nobody');
        assert.equal(rows.sydney.awaiting_approval, true, 'a gated claim awaits the admin');
        assert.equal(rows.fine.awaiting_approval, false, 'a live name awaits nobody');
    } finally { w.restore(); }
});

test('F1: Finish now (an approve) makes a pending auto name live and keeps it auto; a gated approve is the admin\'s', async () => {
    const w = await world();
    try {
        const [a, b] = await Promise.all([makeKey(), makeKey()]);
        await orphan(w, a, 'temp');
        const f = await w.admin('temp', 'approve');
        assert.equal(f.body.status, 'live', JSON.stringify(f.body));
        const row = await w.row('temp');
        routedLive(w, 'temp', row);
        assert.equal(row.decided_by, 'auto', 'nobody approved it: it stays auto (and counts in the new-name budget)');
        assert.match(w.events('temp').at(-1).detail, /^finished by the admin \(an auto name/);
        assert.equal((await w.status(a)).body.tunnelToken, `token-${row.tunnel_id}`, 'its node gets the token from /status');

        assert.equal((await w.claim(b, { name: 'sydney' })).body.status, 'pending');
        assert.equal((await w.admin('sydney', 'approve')).body.status, 'live');
        assert.equal((await w.row('sydney')).decided_by, 'admin');
        assert.deepEqual(w.events('sydney').at(-1), { event: 'approved', detail: 'approved by the admin' });
    } finally { w.restore(); }
});

// The served page against a stub document: what renderPending draws where.
async function page(w) {
    const html = await (await worker.fetch(new Request('https://beanpool.org/admin'), w.env)).text();
    const script = html.split('<script>')[1].split('</script>')[0];
    const els = {};
    const sent = [];
    const confirms = [];
    const clicks = [];
    const el = (id) => (els[id] ??= { id, innerHTML: '', value: '', textContent: '', style: {}, addEventListener() {}, querySelector: () => null });
    const ctx = {
        console,
        document: { getElementById: el, addEventListener: (type, fn) => { if (type === 'click') clicks.push(fn); }, querySelector: () => null },
        sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        confirm: (text) => { confirms.push(text); return true; },
        alert() {},
        fetch: async (url, init = {}) => { sent.push({ url, init }); return { ok: true, status: 200, json: async () => ({ status: 'live', allocations: [], events: [] }) }; },
    };
    vm.createContext(ctx);
    vm.runInContext(script, ctx);
    const click = async (attrs) => {
        const target = { closest: (sel) => { const m = /^\[([a-z-]+)\]$/.exec(sel); return m && attrs[m[1]] !== undefined ? { getAttribute: (k) => attrs[k] ?? null } : null; } };
        for (const fn of clicks) await fn({ target });
        await new Promise((r) => setImmediate(r));
    };
    return { html, ctx, els, sent, confirms, click };
}

test('F1: /admin lists a pending auto name under "Setting up" (Finish now, Reject), apart from "Awaiting your approval"', async () => {
    const w = await world();
    try {
        const p = await page(w);
        assert.match(p.html, /⏳ Awaiting your approval</);
        assert.match(p.html, /⚙️ Setting up</);
        assert.doesNotMatch(p.html, /Pending Name Claims \(Awaiting Your Approval\)/);
        const key = 'ab'.repeat(32);
        p.ctx.renderPending([
            { name: 'sydney', status: 'pending', node_pubkey: key, mode: 'tunnel', requested_at: 1, awaiting_approval: true },
            { name: 'temp', status: 'pending', node_pubkey: key, mode: 'tunnel', requested_at: 1, awaiting_approval: false },
        ]);
        const approval = p.els.pendingTableContainer.innerHTML;
        const setup = p.els.setupTableContainer.innerHTML;
        assert.match(approval, /<tr id="row-sydney">/);
        assert.doesNotMatch(approval, /row-temp/, 'an auto name is not shown as awaiting approval');
        assert.match(approval, /data-name="sydney" data-action="approve" class="btn-approve">Approve</);
        assert.match(setup, /<tr id="row-temp">/);
        assert.doesNotMatch(setup, /row-sydney/);
        assert.match(setup, /data-name="temp" data-action="finish" class="btn-approve">Finish now</);
        assert.match(setup, /data-name="temp" data-action="release" data-free-now="1" class="btn-revoke"[^>]*>Reject</);

        // Finish now is an approve under the hood; Reject frees the name at once, as for a gated claim.
        await p.click({ 'data-action': 'finish', 'data-name': 'temp' });
        assert.match(p.confirms.at(-1), /^Finish setting up temp\.beanpool\.org now\?/);
        assert.equal(p.sent.at(-1).url, '/api/local/admin/registrar/temp/approve');
        await p.click({ 'data-action': 'release', 'data-name': 'temp', 'data-free-now': '1' });
        assert.equal(p.sent.at(-1).url, '/api/local/admin/registrar/temp/release');
        assert.deepEqual(JSON.parse(p.sent.at(-1).init.body), { free_now: true });

        p.ctx.renderPending([]);
        assert.match(p.els.pendingTableContainer.innerHTML, /No name claims awaiting your approval/);
        assert.match(p.els.setupTableContainer.innerHTML, /No names being set up/);
    } finally { w.restore(); }
});

// ── F2: the work finishes whoever is still listening ──────────────────────────────────────────────────────────────

test('F2: a claim whose node hangs up mid-way still goes live (waitUntil), and its node gets the token from /status', async () => {
    const w = await world();
    try {
        const key = await makeKey();
        assert.ok(await w.cutAt(MID_ENSURE, await w.signed('POST', '/api/registrar/claim', key, claimBody('temp'))), 'the node hung up mid-ensure');
        const row = await w.row('temp');
        routedLive(w, 'temp', row);
        assert.equal(row.decided_by, 'auto');
        const st = await w.status(key);
        assert.deepEqual([st.body.status, st.body.tunnelToken], ['live', `token-${row.tunnel_id}`]);
    } finally { w.restore(); }
});

test('F2: a heal of a pending auto name, its node hanging up mid-way, still finishes it', async () => {
    const w = await world();
    try {
        const key = await makeKey();
        await orphan(w, key, 'temp');
        assert.ok(await w.cutAt(MID_ENSURE, await w.signed('POST', '/api/registrar/heal', key, { name: 'temp', origin: 'http://127.0.0.1:8080' })));
        routedLive(w, 'temp', await w.row('temp'));
    } finally { w.restore(); }
});

test('F2: an approve, its admin\'s page closed mid-way, still makes the name live', async () => {
    const w = await world();
    try {
        const key = await makeKey();
        assert.equal((await w.claim(key, { name: 'sydney' })).body.status, 'pending');
        assert.ok(await w.cutAt(MID_ENSURE, w.adminRequest('sydney', 'approve')));
        routedLive(w, 'sydney', await w.row('sydney'));
    } finally { w.restore(); }
});

test('F2: a rotate whose node hangs up mid-way still lands: the old tunnel gone, the fresh one routed and its token in /status', async () => {
    const w = await world();
    try {
        const key = await makeKey();
        await liveName(w, 'temp', key);
        const old = (await w.row('temp')).tunnel_id;
        assert.ok(await w.cutAt(MID_ENSURE, await w.signed('POST', '/api/registrar/rotate', key, { name: 'temp' })), 'the node hung up mid-ensure');
        const row = await w.row('temp');
        routedLive(w, 'temp', row);
        assert.notEqual(row.tunnel_id, old, 'on a fresh tunnel');
        assert.equal(w.cf.liveTunnel(old), null, 'the old one deleted');
        assert.equal((await w.status(key)).body.tunnelToken, `token-${row.tunnel_id}`, 'its node gets the new token from /status');
    } finally { w.restore(); }
});

test('F2: a release whose node hangs up mid-way still takes the name down: no record, no tunnel', async () => {
    const w = await world();
    try {
        const key = await makeKey();
        await liveName(w, 'temp', key);
        assert.ok(await w.cutAt(/^DELETE \/zones\/zone\/dns_records\//, await w.signed('POST', '/api/registrar/release', key, { name: 'temp' })), 'the node hung up at the record\'s delete');
        const row = await w.row('temp');
        assert.deepEqual([row.status, row.tunnel_id, row.dns_record_id], ['released', null, null], JSON.stringify(row));
        assert.deepEqual(routing(w, 'temp'), { dns: null, tunnels: [] }, 'nothing at Cloudflare routes a released name');
    } finally { w.restore(); }
});

// ── F3: the sweep finishes orphans ────────────────────────────────────────────────────────────────────────────────

test('F3: the sweep finishes a pending auto name over 2 minutes old; never a gated one, nor a claim still in flight', async () => {
    const w = await world();
    try {
        const [a, b, c] = await Promise.all([makeKey(), makeKey(), makeKey()]);
        await orphan(w, a, 'temp', 180);
        await orphan(w, c, 'young', 30);
        assert.equal((await w.claim(b, { name: 'sydney' })).body.status, 'pending');
        await w.backdate('sydney', { requested_at: (await w.row('sydney')).requested_at - 180 });

        await attestSweep(w.env);

        const row = await w.row('temp');
        routedLive(w, 'temp', row);
        assert.deepEqual([row.decided_by, row.pause_reason], ['auto', null]);
        const ev = w.events('temp').at(-1);
        assert.equal(ev.event, 'healed');
        assert.match(ev.detail, /^finished by the sweep \(its claim's answer never reached its node\)/);
        assert.equal((await w.status(a)).body.tunnelToken, `token-${row.tunnel_id}`, 'its node gets the token from /status');
        assert.equal((await w.row('sydney')).status, 'pending', 'a gated claim waits for the admin');
        assert.equal(routing(w, 'sydney').tunnels.length, 0);
        assert.equal((await w.row('young')).status, 'pending', 'a claim 30 s old may still be finishing itself');
    } finally { w.restore(); }
});

test('F3: at most 3 a sweep; the rest the next', async () => {
    const w = await world();
    try {
        const keys = await Promise.all([1, 2, 3, 4].map(() => makeKey()));
        for (const [i, k] of keys.entries()) await orphan(w, k, `orphan${i + 1}`, 300);
        const live = async () => (await Promise.all([1, 2, 3, 4].map((i) => w.row(`orphan${i}`)))).filter((r) => r.status === 'live').length;
        await attestSweep(w.env);
        assert.equal(await live(), 3, 'three finished in the first sweep');
        await attestSweep(w.env);
        assert.equal(await live(), 4, 'the fourth in the next');
    } finally { w.restore(); }
});

test('F3: the sweep leaves an orphan of a key the admin blocked, and one something else routes', async () => {
    const w = await world();
    try {
        const [a, b] = await Promise.all([makeKey(), makeKey()]);
        // a holds a name the admin blocked: its other claim is not finished by the registrar.
        assert.equal((await w.claim(a, claimBody('badname'))).body.status, 'live');
        w.nodes['badname.beanpool.org'] = attestsAs(a);
        assert.equal((await w.admin('badname', 'block')).body.status, 'blocked');
        await orphan(w, a, 'second', 180);
        // b's name: a record the registrar did not make appeared at its hostname after the claim.
        await orphan(w, b, 'handmade', 180);
        w.cf.dns.set('dns-hand', { id: 'dns-hand', type: 'A', name: 'handmade.beanpool.org', content: '203.0.113.9', proxied: true });

        await attestSweep(w.env);

        assert.equal((await w.row('second')).status, 'pending', 'a blocked key\'s claim is not finished');
        assert.equal(routing(w, 'second').tunnels.length, 0);
        assert.equal((await w.row('handmade')).status, 'pending', 'a name something else routes is not taken over');
        assert.equal(w.cf.recordAt('handmade.beanpool.org').id, 'dns-hand', 'and that record is untouched');
        assert.equal(routing(w, 'handmade').tunnels.length, 0);
    } finally { w.restore(); }
});

test('F3: an orphan Cloudflare refuses again stays pending, and the next sweep finishes it', async () => {
    const w = await world();
    try {
        const key = await makeKey();
        await orphan(w, key, 'temp', 180);
        w.cf.fail.postDns = true;
        await attestSweep(w.env);
        assert.equal((await w.row('temp')).status, 'pending');
        assert.equal(routing(w, 'temp').tunnels.length, 0, 'the tunnel the failed try made is gone');
        w.cf.fail.postDns = false;
        await attestSweep(w.env);
        routedLive(w, 'temp', await w.row('temp'));
    } finally { w.restore(); }
});

// A claim whose Worker was cut off after createTunnel (past even waitUntil's 30 s) leaves a live bp-<name> tunnel no row
// records. Cloudflare refuses a second one of that name (1013), and createTunnelFor called it nobody's only once it was
// STALE_TUNNEL_S (10 minutes) old: until then the sweep left the name pending and its node's heal got 503 (review of #2125).
async function orphanWithTunnel(w, key, name, { ago = 180, tunnelAge } = {}) {
    const row = await orphan(w, key, name, ago);
    const createdAt = tunnelAge === undefined ? row.requested_at + 3 : Math.floor(Date.now() / 1000) - tunnelAge;
    const t = { id: `tun-left-${name}`, name: `bp-${name}`, created_at: new Date(createdAt * 1000).toISOString(), deleted_at: null };
    w.cf.tunnels.set(t.id, t);
    return t;
}

test('F3: an orphan whose cut-off claim left its tunnel at Cloudflare is finished by the sweep, and by its heal, in minutes', async () => {
    const w = await world();
    try {
        const [a, b] = await Promise.all([makeKey(), makeKey()]);
        const left = await orphanWithTunnel(w, a, 'temp');
        await attestSweep(w.env);
        const row = await w.row('temp');
        routedLive(w, 'temp', row);
        assert.equal(w.cf.liveTunnel(left.id), null, 'the leftover went: the claim that made it ended long ago');
        assert.equal((await w.status(a)).body.tunnelToken, `token-${row.tunnel_id}`);

        const other = await orphanWithTunnel(w, b, 'other');
        const h = await w.heal(b, { name: 'other' });
        assert.equal(h.status, 200, JSON.stringify(h.body));
        assert.equal(h.body.status, 'live', JSON.stringify(h.body));
        routedLive(w, 'other', await w.row('other'));
        assert.equal(w.cf.liveTunnel(other.id), null);
    } finally { w.restore(); }
});

test('F3: a pending name\'s tunnel made moments ago may be a request\'s in flight: the sweep and a heal leave it, and the name pending', async () => {
    const w = await world();
    try {
        const key = await makeKey();
        const young = await orphanWithTunnel(w, key, 'temp', { tunnelAge: 10 });
        const before = await w.row('temp');
        await attestSweep(w.env);
        assert.deepEqual(await w.row('temp'), before, 'nothing written');
        assert.ok(w.cf.liveTunnel(young.id), 'another request\'s tunnel is not deleted from under it');
        const h = await w.heal(key, { name: 'temp' });
        assert.equal(h.status, 503, JSON.stringify(h.body));
        assert.ok(w.cf.liveTunnel(young.id));
    } finally { w.restore(); }
});
