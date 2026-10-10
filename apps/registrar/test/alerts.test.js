// The control room's alerts (src/alerts.js; design scratch/global-node/DESIGN-alerts-fable.md §2, slice S1): the Worker
// on the harness, with a fake ntfy behind the harness's fetch stub, a stepped clock, and every console line kept. What
// is proven: each event is one message with its title, priority, tag and tap; a message says the name and its
// community name, never the contact address; a condition is told raised, still at 24 h, cleared; a failed send is
// retried in one message; the hourly cap mutes the 21st; no channel means nothing sent; no secret reaches a log line.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import worker, { attestSweep } from '../src/index.js';
import * as alerts from '../src/alerts.js';
import { world, liveName, makeKey, attestsAs, migration } from './harness.js';

const SECRET = 's3cr3t';
const TOPIC = `https://ntfy.test/bp-control-room-${SECRET}-topic`;
const TOKEN = `tk_${SECRET}_ntfy_token`;
const CONTACT = 'ops-person@sydney.example';
const WITH_NTFY = { NTFY_URL: TOPIC, NTFY_TOKEN: TOKEN };

// A world whose fetch also answers ntfy.test (status `ntfy.status`), a clock that moves only when `step` says, and the
// console kept in `lines`. `done()` puts everything back and checks no secret reached a log line.
async function room(env = WITH_NTFY) {
    const w = await world({ env });
    const sent = [];
    const ntfy = { status: 200 };
    const inner = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        if (url.hostname !== 'ntfy.test') return inner(input, init);
        sent.push({ url: url.href, method: init.method, headers: Object.fromEntries(new Headers(init.headers).entries()), body: String(init.body ?? ''), status: ntfy.status });
        return new Response('{"id":"x"}', { status: ntfy.status });
    };
    const realNow = Date.now;
    let t = realNow();
    Date.now = () => t;
    const step = (s) => { t += s * 1000; };
    const toNextHour = () => { t = (Math.floor(t / 3_600_000) + 1) * 3_600_000 + 1000; };
    const lines = [];
    const real = { log: console.log, warn: console.warn, error: console.error };
    for (const k of Object.keys(real)) console[k] = (...a) => { lines.push(a.map(String).join(' ')); };
    const admin = async (path, { method = 'GET', body, secret = 'test-admin-secret' } = {}) => {
        const res = await worker.fetch(new Request(`https://beanpool.org/api/local/admin/registrar/${path}`, {
            method, headers: secret ? { 'x-admin-secret': secret } : {}, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }), w.env);
        return { status: res.status, body: await res.json() };
    };
    const done = () => {
        Object.assign(console, real);
        Date.now = realNow;
        w.restore();
        const leaked = lines.filter((l) => l.includes(SECRET));
        assert.deepEqual(leaked, [], 'no console line carries the topic or the token');
    };
    return { w, sent, ntfy, step, toNextHour, lines, admin, done };
}

const noContact = (sent) => {
    for (const s of sent) assert.ok(!JSON.stringify(s).includes(CONTACT) && !JSON.stringify(s).includes('ops-person'), `the contact address is in no request: ${JSON.stringify(s)}`);
};

test('a gated claim is one message: title, priority, tag, tap, token — the name and community name, never the contact', async () => {
    const r = await room();
    try {
        const key = await makeKey();
        const c = await r.w.claim(key, { name: 'sydney', community_name: 'Sydney Commons', contact: CONTACT });   // gated in the 0001 seed
        assert.equal(c.body.status, 'pending');
        assert.equal(r.sent.length, 1, 'exactly one message');
        const m = r.sent[0];
        assert.equal(m.url, TOPIC);
        assert.equal(m.method, 'POST');
        assert.equal(m.headers.title, 'Name request: sydney');
        assert.equal(m.headers.priority, '3');
        assert.equal(m.headers.tags, 'seedling');
        assert.equal(m.headers.click, 'https://beanpool.org/admin#sydney');
        assert.equal(m.headers.actions, 'view, Open control room, https://beanpool.org/admin#sydney', 'one view action, no http action');
        assert.equal(m.headers.authorization, `Bearer ${TOKEN}`);
        assert.equal(m.body, 'Name request: sydney.beanpool.org — "Sydney Commons", tunnel. 1 waiting for your approval.');

        // Its node asking again is the same request, not a new one.
        await r.w.claim(key, { name: 'sydney', community_name: 'Sydney Commons', contact: CONTACT });
        assert.equal(r.sent.length, 1);

        // The admin approves: one more, low.
        assert.equal((await r.w.admin('sydney', 'approve')).body.status, 'live');
        assert.equal(r.sent.length, 2, 'approve is exactly one message');
        assert.equal(r.sent[1].headers.title, 'You approved sydney');
        assert.equal(r.sent[1].headers.priority, '2');
        assert.equal(r.sent[1].body, 'You approved sydney.beanpool.org.');

        // A new community on an auto name: one message, with the count of live names.
        const k2 = await makeKey();
        assert.equal((await r.w.claim(k2, { name: 'yarrabank', community_name: 'Yarra Bank LETS', contact: CONTACT })).body.status, 'live');
        assert.equal(r.sent.length, 3);
        assert.equal(r.sent[2].headers.title, 'New community: yarrabank');
        assert.equal(r.sent[2].headers.priority, '3');
        assert.equal(r.sent[2].headers.click, 'https://beanpool.org/admin#yarrabank');
        assert.equal(r.sent[2].body, 'New community: yarrabank.beanpool.org — "Yarra Bank LETS" is live (tier auto). 2 names live.');

        // The contact the claims carried is stored (the admin page shows it) but in no request.
        assert.equal((await r.w.row('yarrabank')).contact, CONTACT);
        noContact(r.sent);
        for (const s of r.sent) assert.ok(!/Ʀ/.test(s.body));
    } finally { r.done(); }
});

test('the sweep pausing an impostor is one high message that names no key', async () => {
    const r = await room();
    try {
        const [owner, intruder, n1, n2] = await Promise.all([makeKey(), makeKey(), makeKey(), makeKey()]);
        await liveName(r.w, 'swapped', owner);
        await liveName(r.w, 'alpha', n1); await liveName(r.w, 'bravo', n2);
        r.sent.length = 0;
        r.w.nodes['swapped.beanpool.org'] = attestsAs(intruder);
        await attestSweep(r.w.env);
        assert.equal(r.sent.length, 0, 'one impostor answer is counted, not told');
        await attestSweep(r.w.env);
        assert.equal((await r.w.row('swapped')).status, 'paused');
        assert.equal(r.sent.length, 1);
        const m = r.sent[0];
        assert.equal(m.headers.title, 'Routing paused: swapped');
        assert.equal(m.headers.priority, '4');
        assert.equal(m.headers.tags, 'warning');
        assert.equal(m.headers.click, 'https://beanpool.org/admin#swapped');
        assert.equal(m.body, "Routing paused: swapped.beanpool.org — another node's key answered 2× in a row. Name kept for its owner, whose heal resumes it.");
        for (const k of [owner, intruder]) assert.ok(!m.body.includes(k.pubHex.slice(0, 16)), 'no key in the words');
    } finally { r.done(); }
});

test('a suspended sweep is urgent once, "still" after 24 h, and "cleared" once when sweeps act again', async () => {
    const r = await room({ ...WITH_NTFY, CANARY_NAME: 'canary' });   // a canary that is not live: every sweep suspends
    try {
        await attestSweep(r.w.env);
        assert.equal(r.sent.length, 1);
        assert.equal(r.sent[0].headers.title, 'Attest sweep suspended');
        assert.equal(r.sent[0].headers.priority, '5');
        assert.equal(r.sent[0].headers.tags, 'red_circle');
        assert.equal(r.sent[0].headers.click, 'https://beanpool.org/admin');
        assert.match(r.sent[0].body, /^Attest sweep suspended: the canary canary did not attest ok\. Acting on nothing\. Since \d{4}-\d\d-\d\d \d\d:\d\d UTC\.$/);

        r.step(300); await attestSweep(r.w.env);
        assert.equal(r.sent.length, 1, 'the next sweep, still suspended, tells nothing');
        r.step(86400 - 301); await attestSweep(r.w.env);
        assert.equal(r.sent.length, 1, 'a second short of a day: nothing');
        r.step(1); await attestSweep(r.w.env);
        assert.equal(r.sent.length, 2, 'a day on: still');
        assert.equal(r.sent[1].headers.title, 'Still: Attest sweep suspended');
        assert.equal(r.sent[1].headers.priority, '5');
        assert.match(r.sent[1].body, /^Still, since \d{4}-\d\d-\d\d \d\d:\d\d UTC: Attest sweep suspended/);
        r.step(300); await attestSweep(r.w.env);
        assert.equal(r.sent.length, 2);

        delete r.w.env.CANARY_NAME;
        r.step(300); await attestSweep(r.w.env);
        assert.equal(r.sent.length, 3, 'cleared once');
        assert.equal(r.sent[2].headers.title, 'Resolved: Attest sweep suspended');
        assert.equal(r.sent[2].headers.priority, '2');
        assert.equal(r.sent[2].headers.tags, 'white_check_mark');
        assert.match(r.sent[2].body, /^Resolved \(since .* UTC\): Attest sweeps act again/);
        r.step(300); await attestSweep(r.w.env);
        assert.equal(r.sent.length, 3, 'and not again');
        assert.deepEqual((await r.admin('alerts')).body.active, []);
    } finally { r.done(); }
});

test('ntfy answering 503: the events wait, and five minutes on go in ONE message; the log says the status, never the address', async () => {
    const r = await room();
    try {
        r.ntfy.status = 503;
        const [k1, k2] = await Promise.all([makeKey(), makeKey()]);
        await r.w.claim(k1, { name: 'sydney', community_name: 'Sydney Commons', contact: CONTACT });
        await r.w.claim(k2, { name: 'perth', community_name: 'Perth Swap', contact: CONTACT });
        assert.equal(r.sent.length, 1, 'tried once; the second waits for the retry, not a new try');
        let st = (await r.admin('alerts')).body.channel;
        assert.deepEqual({ set: st.set, token: st.token, waiting: st.waiting, failed: st.failed_in_a_row, status: st.last_status, ok: st.last_ok_at },
            { set: true, token: true, waiting: 2, failed: 1, status: 'HTTP 503', ok: null });
        assert.ok(r.lines.some((l) => l.includes('[ALERT_SEND]') && l.includes('HTTP 503')), 'the failure is logged, by its status');

        r.ntfy.status = 200;
        r.step(299); await attestSweep(r.w.env);
        assert.equal(r.sent.length, 1, '4 min 59 s on: not yet');
        r.step(1); await attestSweep(r.w.env);
        assert.equal(r.sent.length, 2, 'the retry is one message');
        const m = r.sent[1];
        assert.equal(m.headers.title, 'Name request: sydney (+1 more)');
        assert.equal(m.headers.click, 'https://beanpool.org/admin', 'two names: the control room, not one row');
        assert.match(m.body, /sydney\.beanpool\.org — "Sydney Commons"/);
        assert.match(m.body, /perth\.beanpool\.org — "Perth Swap", tunnel\. 2 waiting/);
        r.step(300); await attestSweep(r.w.env);
        assert.equal(r.sent.length, 2, 'nothing sent twice');
        st = (await r.admin('alerts')).body;
        assert.equal(st.channel.waiting, 0);
        assert.equal(st.channel.failed_in_a_row, 0);
        assert.ok(st.channel.last_ok_at);
        assert.ok(!JSON.stringify(st).includes(SECRET), '/admin shows whether the channel is set, never its address or token');
        noContact(r.sent);
    } finally { r.done(); }
});

test('the hourly cap: 20 messages, the 21st is one "muted" line, then nothing until the next hour', async () => {
    const r = await room();
    try {
        r.toNextHour();
        const ev = (i) => ({ category: 'names', priority: 3, tag: 'seedling', name: `name-${i}`, title: `Event ${i}`, body: `Event ${i}.` });
        for (let i = 1; i <= 20; i++) await alerts.notify(r.w.env, ev(i));
        assert.equal(r.sent.length, 20);
        await alerts.notify(r.w.env, ev(21));
        assert.equal(r.sent.length, 21);
        assert.equal(r.sent[20].headers.title, 'Muted: 1 more this hour');
        assert.equal(r.sent[20].body, 'muted: 1 more this hour, see /admin');
        assert.equal(r.sent[20].headers.click, 'https://beanpool.org/admin');
        await alerts.notify(r.w.env, ev(22));
        await alerts.notify(r.w.env, ev(23));
        assert.equal(r.sent.length, 21, 'muted for the rest of the hour');
        const st = (await r.admin('alerts')).body;
        assert.deepEqual(st.cap, { per_hour: 20, sent: 21, muted: 3 });
        assert.deepEqual(st.recent.slice(0, 3).map((e) => [e.title, e.muted]), [['Event 23', 1], ['Event 22', 1], ['Event 21', 1]], '/admin keeps what was muted');
        assert.equal(st.channel.waiting, 0);

        r.toNextHour();
        await alerts.notify(r.w.env, ev(24));
        assert.equal(r.sent.length, 22, 'a new hour: sent again');
        assert.equal(r.sent[21].headers.title, 'Event 24');
    } finally { r.done(); }
});

test('the cap holds with senders racing, and more than 50 waiting keeps the newest 50, the rest counted', async () => {
    const r = await room();
    try {
        r.toNextHour();
        const ev = (i) => ({ category: 'names', priority: 3, tag: 'seedling', name: null, title: `Event ${i}`, body: `Event ${i}.` });
        await Promise.all(Array.from({ length: 30 }, (_, i) => alerts.notify(r.w.env, ev(i + 1))));
        const lines = r.sent.filter((m) => !m.headers.title.startsWith('Muted'));
        assert.ok(lines.length <= 20, `${lines.length} messages in the hour`);
        assert.ok(r.sent.length - lines.length <= 1, 'at most one muted line');
        const st = (await r.admin('alerts')).body;
        assert.ok(st.cap.sent <= 21, JSON.stringify(st.cap));
    } finally { r.done(); }

    const q = await room({});
    try {
        for (let i = 1; i <= 55; i++) await alerts.notify(q.w.env, { category: 'names', priority: 3, name: null, title: `Event ${i}`, body: `Event ${i}.` });
        let st = (await q.admin('alerts')).body.channel;
        assert.equal(st.waiting, 50);
        assert.equal(st.dropped, 5);
        q.w.env.NTFY_URL = TOPIC;
        await q.admin('alerts/test', { method: 'POST' });
        assert.equal(q.sent.length, 1, 'everything waiting in one message');
        assert.equal(q.sent[0].headers.title, 'Event 7 (+49 more)', 'the newest 50: the test pushed out one more');
        st = (await q.admin('alerts')).body.channel;
        assert.equal(st.waiting, 0);
        assert.equal(st.dropped, 6);
    } finally { q.done(); }
});

test('with ctx.waitUntil (the real runtime), the claim answers first and the message is sent after', async () => {
    const r = await room();
    try {
        const key = await makeKey();
        const later = [];
        const ts = String(Math.floor(Date.now() / 1000));
        const text = JSON.stringify({ name: 'sydney', mode: 'tunnel', community_name: 'Sydney Commons' });
        const sig = Buffer.from(await crypto.subtle.sign('Ed25519', key.keyPair.privateKey,
            new TextEncoder().encode(`beanpool-registrar-request/v1\nPOST\n/api/registrar/claim\n${ts}\n${text}`))).toString('hex');
        const res = await worker.fetch(new Request('https://beanpool.org/api/registrar/claim', {
            method: 'POST', body: text, headers: { 'content-type': 'application/json', 'x-bp-pubkey': key.pubHex, 'x-bp-timestamp': ts, 'x-bp-signature': sig },
        }), r.w.env, { waitUntil: (p) => later.push(p) });
        assert.equal((await res.json()).status, 'pending');
        assert.equal(later.length, 1, 'the send was handed to waitUntil');
        await Promise.all(later);
        assert.equal(r.sent.length, 1);
        assert.equal(r.sent[0].headers.title, 'Name request: sydney');
    } finally { r.done(); }
});

test('no NTFY_URL: nothing is sent, the events wait, and /admin and the test button say so', async () => {
    const r = await room({});
    try {
        const [k1, k2] = await Promise.all([makeKey(), makeKey()]);
        await r.w.claim(k1, { name: 'sydney', community_name: 'Sydney Commons', contact: CONTACT });
        await r.w.claim(k2, { name: 'yarrabank', community_name: 'Yarra Bank LETS', contact: CONTACT });
        await r.w.admin('sydney', 'approve');
        r.w.nodes['sydney.beanpool.org'] = attestsAs(k1);
        r.w.nodes['yarrabank.beanpool.org'] = attestsAs(k2);
        await attestSweep(r.w.env);   // applied: both answer as themselves
        assert.equal(r.sent.length, 0, 'not one request to ntfy');
        const st = (await r.admin('alerts')).body;
        assert.equal(st.channel.set, false);
        assert.equal(st.channel.token, false);
        assert.equal(st.channel.waiting, 3, 'kept for the first channel that is set');
        const t = await r.admin('alerts/test', { method: 'POST' });
        assert.equal(t.status, 200);
        assert.equal(t.body.sent, false);
        assert.match(t.body.error, /NTFY_URL is not set, so nothing was sent/);
        assert.equal(r.sent.length, 0);
        // A topic that is not a URL is no channel either.
        r.w.env.NTFY_URL = 'not a url';
        await alerts.notify(r.w.env, alerts.adminDid(r.w.env, 'sydney', 'pause', { status: 'paused' }));
        assert.equal(r.sent.length, 0);
        // Set: the test button sends everything waiting, now.
        r.w.env.NTFY_URL = TOPIC;
        const sent = await r.admin('alerts/test', { method: 'POST' });
        assert.deepEqual(sent.body, { sent: true, status: 'HTTP 200' });
        assert.equal(r.sent.length, 1);
        assert.equal(r.sent[0].headers.title, 'Name request: sydney (+4 more)');
        assert.match(r.sent[0].body, /Test from the beanpool\.org registrar's control room/);
        assert.equal(r.sent[0].headers.authorization, undefined, 'no token set: no Authorization header');
        noContact(r.sent);
    } finally { r.done(); }
});

test('categories: off keeps nothing, digest holds for the summary; the toggles and the test button need the admin secret', async () => {
    const r = await room();
    try {
        for (const [path, method] of [['alerts', 'GET'], ['alerts/settings', 'POST'], ['alerts/test', 'POST']]) {
            const res = await r.admin(path, { method, secret: null, body: method === 'POST' ? { category: 'names', mode: 'off' } : undefined });
            assert.equal(res.status, 401, path);
            const wrong = await r.admin(path, { method, secret: 'wrong', body: method === 'POST' ? { category: 'names', mode: 'off' } : undefined });
            assert.equal(wrong.status, 401, path);
        }
        assert.equal(r.sent.length, 0);
        assert.deepEqual((await r.admin('alerts')).body.settings, { names: 'on', health: 'on', uptake: 'on', admin: 'on' });

        const off = await r.admin('alerts/settings', { method: 'POST', body: { category: 'names', mode: 'off' } });
        assert.equal(off.status, 200);
        assert.equal(off.body.settings.names, 'off');
        const [k1, k2] = await Promise.all([makeKey(), makeKey()]);
        await r.w.claim(k1, { name: 'sydney', community_name: 'Sydney Commons' });
        assert.equal(r.sent.length, 0, 'off: nothing sent');
        assert.equal((await r.admin('alerts')).body.recent.length, 0, 'off: nothing kept');

        await r.admin('alerts/settings', { method: 'POST', body: { category: 'names', mode: 'digest' } });
        await r.w.claim(k2, { name: 'perth', community_name: 'Perth Swap' });
        assert.equal(r.sent.length, 0, 'digest: not sent now');
        const st = (await r.admin('alerts')).body;
        assert.equal(st.held_for_digest, 1);
        assert.deepEqual(st.recent.map((e) => [e.title, e.held]), [['Name request: perth', 1]]);
        assert.equal(st.channel.waiting, 0, 'a held event is not waiting to be sent');

        // Admin actions are their own category, still on.
        await r.w.admin('perth', 'approve');
        assert.equal(r.sent.length, 1);
        assert.equal(r.sent[0].headers.title, 'You approved perth');

        for (const body of [{ category: 'names', mode: 'loud' }, { category: 'people', mode: 'on' }, {}]) {
            assert.equal((await r.admin('alerts/settings', { method: 'POST', body })).status, 400, JSON.stringify(body));
        }
    } finally { r.done(); }
});

test('the test button sends at once, even inside the five minutes after a failure', async () => {
    const r = await room();
    try {
        r.ntfy.status = 503;
        const failed = await r.admin('alerts/test', { method: 'POST' });
        assert.deepEqual(failed.body, { sent: false, error: 'not sent: HTTP 503' });
        r.ntfy.status = 200;
        const ok = await r.admin('alerts/test', { method: 'POST' });
        assert.deepEqual(ok.body, { sent: true, status: 'HTTP 200' });
        assert.equal(r.sent.length, 2);
        assert.equal(r.sent[1].headers.title, 'Test from the registrar (+1 more)', 'the one that failed goes with it');
    } finally { r.done(); }
});

test('words: a resume the re-attest refused, a release, a content-swap pause — and a community name in any script stays out of the headers', async () => {
    const env = { BASE_DOMAIN: 'beanpool.org' };
    assert.equal(alerts.adminDid(env, 'x-y', 'resume', { status: 'paused', attest: 'unverifiable' }).body,
        "You resumed x-y.beanpool.org, but it stays paused: edge re-attest unverifiable. Its node's heal re-attests.");
    assert.equal(alerts.adminDid(env, 'x-y', 'release', { status: 'released' }).body, 'You released x-y.beanpool.org (free now).');
    assert.equal(alerts.adminDid(env, 'x-y', 'revoke', { status: 'blocked' }).title, 'You blocked x-y');
    assert.equal(alerts.routingPaused(env, 'x-y', 'content-swap', 12).body,
        'Routing paused: x-y.beanpool.org — something other than its node answered in 12 sweeps in a row. Name kept for its owner, whose heal resumes it.');
    const m = alerts.composeAlert(env, [{ ...alerts.nameRequest(env, { name: 'tokyo', community_name: '東京コモンズ', mode: 'direct' }, 1), at: 0 }]);
    assert.match(m.body, /"東京コモンズ", direct/);
    assert.match(m.title, /^[\x20-\x7e]+$/, 'a header is printable ASCII');
    assert.doesNotThrow(() => new Headers({ Title: m.title }));
});

const BEFORE_0008 = ['0001_init.sql', '0002_states.sql', '0003_decision_seq.sql', '0004_teardown.sql', '0005_reserve_global.sql', '0006_request_nonces.sql', '0007_content_swap.sql'];

test('migration 0008: four tables and the categories, all on; re-running changes nothing, the admin\'s choices included', async () => {
    const w = await world({ migrations: BEFORE_0008 });
    try {
        const dump = () => JSON.stringify(['alert_settings', 'alert_state', 'alert_outbox', 'alert_channel'].map((t) => w.sqlite.prepare(`SELECT * FROM ${t}`).all()));
        const schema = () => JSON.stringify(w.sqlite.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all());
        w.sqlite.exec(migration('0008_alerts.sql'));
        assert.deepEqual(w.sqlite.prepare('SELECT category, mode FROM alert_settings ORDER BY category').all().map((r) => ({ ...r })),
            [{ category: 'admin', mode: 'on' }, { category: 'health', mode: 'on' }, { category: 'names', mode: 'on' }, { category: 'uptake', mode: 'on' }]);
        w.sqlite.exec("UPDATE alert_settings SET mode='off' WHERE category='uptake'");
        w.sqlite.exec("INSERT INTO alert_state (key, since, last_told_at, detail) VALUES ('sweep-suspended', 1, 1, 'x')");
        const [before, shape] = [dump(), schema()];
        w.sqlite.exec(migration('0008_alerts.sql'));
        assert.equal(dump(), before, 'rows as they were');
        assert.equal(schema(), shape, 'schema as it was');
        assert.throws(() => w.sqlite.exec("UPDATE alert_settings SET mode='loud' WHERE category='names'"), /CHECK constraint/);
    } finally { w.restore(); }
});

test('a database without 0008 (the Worker deployed first): every request works, nothing is sent, the log says why', async () => {
    const r = await room();
    r.w.restore();
    const w = await world({ migrations: BEFORE_0008, env: WITH_NTFY });
    const inner = globalThis.fetch;
    globalThis.fetch = async (input, init) => (new URL(typeof input === 'string' ? input : input.url).hostname === 'ntfy.test'
        ? (r.sent.push(input), new Response('{}')) : inner(input, init));
    try {
        const [k1, k2] = await Promise.all([makeKey(), makeKey()]);
        assert.equal((await w.claim(k1, { name: 'sydney', community_name: 'Sydney Commons' })).body.status, 'pending');
        assert.equal((await w.claim(k2, { name: 'yarrabank' })).body.status, 'live');
        assert.equal((await w.admin('sydney', 'approve')).body.status, 'live');
        await attestSweep(w.env);
        assert.equal(r.sent.length, 0);
        assert.ok(r.lines.some((l) => l.startsWith('[ALERT]') && l.includes('no such table')), 'logged');
    } finally { w.restore(); r.done(); }
});

// The served page's script against a stub DOM (as holder.test.js runs it): a row carries its name's id, and a tap on
// /admin#<name> lights that row and scrolls to it once the tables are drawn.
test('/admin: #<name> lights and scrolls to that row; the alerts panel says when no channel is set', async () => {
    const w = await world();
    try {
        const html = await (await worker.fetch(new Request('https://beanpool.org/admin'), w.env)).text();
        const script = html.split('<script>')[1].split('</script>')[0];
        const els = {};
        const scrolled = [];
        const ctx = {
            console,
            location: { hash: '#sydney' },
            document: {
                getElementById: (id) => (els[id] ??= { id, innerHTML: '', value: '', textContent: '', className: '', style: {}, addEventListener() {}, scrollIntoView: (o) => scrolled.push([id, o]) }),
                addEventListener() {},
                querySelector: () => null,
            },
            sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
            confirm: () => true, alert() {},
            fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
        };
        vm.createContext(ctx);
        vm.runInContext(script, ctx);
        ctx.renderPending([{ name: 'sydney', status: 'pending', node_pubkey: 'ab'.repeat(32), mode: 'tunnel', requested_at: 1 }]);
        assert.match(els.pendingTableContainer.innerHTML, /<tr id="row-sydney">/);
        ctx.showFragment();
        assert.equal(JSON.stringify(scrolled), JSON.stringify([['row-sydney', { block: 'center' }]]));
        assert.equal(els['row-sydney'].className, 'lit');
        ctx.location.hash = '#<img src=x>';
        ctx.showFragment();
        assert.equal(scrolled.length, 1, 'only a name is looked up');

        ctx.renderAlerts({ channel: { set: false, waiting: 2 }, cap: { per_hour: 20, sent: 0, muted: 0 }, settings: { names: 'digest' }, active: [], recent: [] });
        assert.match(els.alertsContainer.innerHTML, /Not set: NTFY_URL is not a Worker secret, so nothing is sent \(2 waiting for it\)/);
        assert.match(els.alertsContainer.innerHTML, /data-alert-category="names" data-alert-mode="digest" class="on"/);
        assert.match(els.alertsContainer.innerHTML, /data-alert-test="1"/);
        ctx.renderAlerts({ channel: { set: true, token: true, waiting: 0, last_ok_at: 1 }, cap: {}, settings: {}, active: [],
            recent: [{ at: 1, title: '<b>x</b>', body: '"Q&A"', sent_at: 1 }] });
        assert.match(els.alertsContainer.innerHTML, /ntfy: <b style="color: #10b981;">set<\/b>, with a token/);
        assert.match(els.alertsContainer.innerHTML, /&lt;b&gt;x&lt;\/b&gt;/, 'stored words are escaped');
    } finally { w.restore(); }
});
