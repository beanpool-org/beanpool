// The public status line (src/status.js; design scratch/global-node/DESIGN-global-mothership-fable.md §3.2 U4, slice
// A8, accepted by Marty 2026-10-18): the Worker on the harness with a fake watch log of 20 days in watch_log, our
// servers faked behind the harness's fetch stub, a fake KV namespace, and a stepped clock. What is proven: each watch
// tick writes status.json to KV with, per server STATUS_SERVERS names and the registrar itself, whether it answered its
// last look, its last incident and its share of looks answered over 90 days, counted from the log; a community's node
// that is watched is never in it, nor any address, version or IP; GET /api/registrar/status.json serves it with cache
// headers (404 before the first tick and with no KV); an incident begins at the first of two failed looks and ends at the
// first answer, and the registrar's missed ticks are one; a tick whose status write failed loses nothing; a quiet tick
// spends 2 D1 queries on it; status.json is bounded; /admin links the page.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import * as watch from '../src/watch.js';
import { ADMIN_HTML } from '../src/admin-html.js';
import { world, workerdFetchInit } from './harness.js';

const TARGETS = JSON.stringify([
    { name: 'global', url: 'https://global.watch.test' },
    { name: 'vault', url: 'https://vault.watch.test', kind: 'vault' },
    { name: 'mullum', url: 'https://mullum.watch.test' },
    { name: 'test', url: 'https://test.watch.test' },
]);
// 2026-10-10 12:00 UTC: the watch tests' clock. The log's looks are 5 minutes apart, ending 5 minutes before it.
const T0S = Date.UTC(2026, 9, 10, 12, 0, 0) / 1000;
const LOG_DAYS = 20;
const NAMES = ['global', 'vault', 'mullum', 'test'];

function fakeKV() {
    const m = new Map();
    const kv = { m, puts: 0, gets: [], async get(k, o) { kv.gets.push(o); return m.has(k) ? m.get(k) : null; }, async put(k, v) { kv.puts++; m.set(k, String(v)); } };
    return kv;
}

// The fake watch log: a look at each server every 5 minutes for 20 days before T0, but for an hour the registrar's
// checks did not run (5 days back: no look at anything), 7 looks in a row global timed out (35 minutes, 3 days back),
// one look test gave a 502 (2 days back), and 100 that mullum — a community's node, watched but never published —
// did not answer.
function fakeLog() {
    const rows = [];
    const ticks = LOG_DAYS * 288;
    const gap = new Set(Array.from({ length: 12 }, (_, i) => 5 * 288 + i));
    const globalDown = new Set(Array.from({ length: 7 }, (_, i) => 3 * 288 + i));
    const mullumDown = new Set(Array.from({ length: 100 }, (_, i) => 288 + i * 7));
    for (let i = ticks; i >= 1; i--) {
        if (gap.has(i)) continue;
        const ranAt = T0S - i * 300;
        for (const target of NAMES) {
            const fail = (target === 'global' && globalDown.has(i)) || (target === 'test' && i === 2 * 288) || (target === 'mullum' && mullumDown.has(i));
            const status = !fail ? 'HTTP 200' : target === 'global' ? 'timed out' : target === 'test' ? 'HTTP 502' : 'unreachable';
            rows.push({ ran_at: ranAt, target, ok: fail ? 0 : 1, status, version: '1.2.30', commit: 'aaaaaaa1111111' });
        }
    }
    return { rows, ticks: ticks - gap.size, first: T0S - ticks * 300 };
}

async function room({ env = {}, kv = fakeKV(), log = true, migrations } = {}) {
    const w = await world({ migrations, env: { WATCH_TARGETS: TARGETS, STATUS_SERVERS: 'global,test', ...(kv ? { STATUS: kv } : {}), ...env } });
    const history = fakeLog();
    if (log) {
        const ins = w.sqlite.prepare('INSERT INTO watch_log (ran_at, target, ok, ms, status, version, commit_sha) VALUES (?,?,?,?,?,?,?)');
        for (const r of history.rows) ins.run(r.ran_at, r.target, r.ok, 40, r.status, r.version, r.commit);
    }
    const servers = Object.fromEntries(NAMES.map((n) => [`${n}.watch.test`, { fail: null }]));
    const inner = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => {
        workerdFetchInit(init);
        const url = new URL(typeof input === 'string' ? input : input.url);
        if (!url.hostname.endsWith('.watch.test')) return inner(input, init);
        const s = servers[url.hostname];
        if (s.fail === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        if (s.fail === 'unreachable') throw new TypeError('fetch failed');
        if (typeof s.fail === 'number') return new Response('no', { status: s.fail });
        if (url.pathname === '/v1/health') return Response.json({ state: 'open', release: 'rel-1' });
        return Response.json({ version: '1.2.30', commit: 'aaaaaaa1111111', watchdog: { recoveries: 0 } });
    };
    const realNow = Date.now;
    let t = T0S * 1000 - 300_000;   // the log's last look: the first tick is 5 minutes on, at T0
    Date.now = () => t;
    const lines = [];
    const real = { log: console.log, warn: console.warn, error: console.error };
    for (const k of Object.keys(real)) console[k] = (...a) => { lines.push(a.map(String).join(' ')); };
    const tick = async (s = 300) => { t += s * 1000; return watch.watchOurServers(w.env); };
    const doc = () => (kv.m.has('status.json') ? JSON.parse(kv.m.get('status.json')) : null);
    const server = (name) => doc()?.servers.find((x) => x.name === name);
    const get = async (env = w.env) => {
        const res = await worker.fetch(new Request('https://beanpool.org/api/registrar/status.json'), env);
        return { status: res.status, headers: Object.fromEntries(res.headers.entries()), text: await res.text() };
    };
    const done = () => { Object.assign(console, real); Date.now = realNow; w.restore(); };
    const nowS = () => Math.floor(t / 1000);
    return { w, kv, servers, history, tick, doc, server, get, lines, done, nowS, at: (s) => { t = s * 1000; } };
}

const share = (ok, looks) => Math.floor((ok * 10000) / looks) / 100;
const slot = (s) => Math.floor((s + 30) / 300);
const dayOf = (s) => new Date(s * 1000).toISOString().slice(0, 10);

test('a tick writes status.json from the watch log: our servers STATUS_SERVERS names and the registrar, never a community node, no address, version or IP', async () => {
    const r = await room();
    try {
        assert.equal(r.doc(), null);
        assert.equal((await r.get()).status, 404, 'before the first tick there is nothing to serve');
        await r.tick();
        const d = r.doc();
        assert.equal(r.kv.puts, 1, 'one KV write a tick');
        assert.deepEqual(Object.keys(d), ['v', 'at', 'every_s', 'window_days', 'servers']);
        assert.equal(d.v, 1);
        assert.equal(d.at, T0S);
        assert.equal(d.every_s, 300);
        assert.equal(d.window_days, 90);
        assert.deepEqual(d.servers.map((s) => s.name), ['global', 'test', 'registrar'], 'STATUS_SERVERS in its order, then the registrar');

        // Counted from the log (20 days, all inside 90) and this tick's look.
        const looks = r.history.ticks + 1;
        const g = r.server('global');
        assert.deepEqual(g, {
            name: 'global', up: true, checked_at: T0S, looks, answered: looks - 7, percent: share(looks - 7, looks),
            since: dayOf(r.history.first), incident: null,
        }, "global: its 7 timed-out looks counted (the log's incidents before the first tick are counted, not named)");
        assert.equal(g.percent, 99.87);
        const ts = r.server('test');
        assert.equal(ts.answered, looks - 1, "test's one 502");
        assert.equal(ts.percent, share(looks - 1, looks));
        assert.equal(ts.up, true);
        // The registrar: its ticks (each looked at every server) of the 5-minute slots since its first tick; the hour
        // its checks did not run is 12 missed.
        const reg = r.server('registrar');
        const slots = slot(T0S) - slot(r.history.first) + 1;
        assert.equal(slots, LOG_DAYS * 288 + 1);
        assert.deepEqual(reg, {
            name: 'registrar', up: true, checked_at: T0S, looks: slots, answered: slots - 12, percent: share(slots - 12, slots),
            since: dayOf(r.history.first), incident: null,
        });
        assert.equal(reg.percent, 99.79);

        const text = r.kv.m.get('status.json');
        for (const never of ['mullum', 'vault', 'watch.test', 'http', '1.2.30', 'aaaaaaa', 'rel-1', 'castlemaine'])
            assert.ok(!text.includes(never), `status.json never carries "${never}"`);
        assert.doesNotMatch(text, /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, 'no IP address');
        assert.ok(!r.lines.some((l) => l.startsWith('[STATUS]')), r.lines.join('\n'));
    } finally { r.done(); }
});

test('GET /api/registrar/status.json serves what the tick wrote, a minute in caches, to any site; 404 with no KV', async () => {
    const r = await room();
    try {
        await r.tick();
        const res = await r.get();
        assert.equal(res.status, 200);
        assert.equal(res.text, r.kv.m.get('status.json'), 'as written');
        assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
        assert.equal(res.headers['cache-control'], 'public, max-age=60');
        assert.equal(res.headers['access-control-allow-origin'], '*');
        assert.equal(res.headers['x-content-type-options'], 'nosniff');
        assert.deepEqual(r.kv.gets.at(-1), { cacheTtl: 60 }, "KV's own edge cache, a minute");
        const post = await worker.fetch(new Request('https://beanpool.org/api/registrar/status.json', { method: 'POST', body: '{}' }), r.w.env);
        assert.equal(post.status, 404, 'GET only');
        const none = await r.get({ ...r.w.env, STATUS: undefined });
        assert.equal(none.status, 404);
        assert.deepEqual(JSON.parse(none.text), { error: 'no status is published here' });
    } finally { r.done(); }
});

test('an incident: one failed look is not one (up: false); two begin it at the first; the first answer ends it; why is a code', async () => {
    const r = await room();
    try {
        await r.tick();
        const t1 = r.nowS();
        r.servers['test.watch.test'].fail = 'timeout';
        await r.tick();
        assert.equal(r.server('test').up, false, 'one failed look: not up');
        assert.equal(r.server('test').incident, null, 'and no incident');
        await r.tick();
        assert.deepEqual(r.server('test').incident, { began_at: t1 + 300, ended_at: null, why: 'timed-out' }, 'two in a row: begun at the first');
        r.servers['test.watch.test'].fail = 502;
        await r.tick();
        assert.deepEqual(r.server('test').incident, { began_at: t1 + 300, ended_at: null, why: 'timed-out' }, 'still down: as it began');
        r.servers['test.watch.test'].fail = null;
        await r.tick();
        assert.equal(r.server('test').up, true);
        assert.deepEqual(r.server('test').incident, { began_at: t1 + 300, ended_at: t1 + 1200, why: 'timed-out' }, 'ended at the first answer');
        await r.tick();
        assert.deepEqual(r.server('test').incident, { began_at: t1 + 300, ended_at: t1 + 1200, why: 'timed-out' }, 'the last incident stays');
        assert.equal(r.server('test').answered, r.server('test').looks - 1 - 3, 'its 3 failed looks counted, with the log\'s one');
        assert.equal(r.server('global').incident, null, 'global untouched');

        // The next one replaces it, with what it said: an HTTP error, something else at the address, unreachable.
        for (const [fail, why] of [[503, 'http-503'], ['unreachable', 'unreachable']]) {
            r.servers['global.watch.test'].fail = fail;
            await r.tick();
            const began = r.nowS();
            await r.tick();
            assert.deepEqual(r.server('global').incident, { began_at: began, ended_at: null, why });
            r.servers['global.watch.test'].fail = null;
            await r.tick();
            assert.equal(r.server('global').incident.ended_at, r.nowS());
        }
        assert.equal(r.server('test').incident.why, 'timed-out', "one server's incident is its own");
    } finally { r.done(); }
});

test("the registrar: its checks missed two ticks or more is an incident from the first missed to the next that ran; one missed is not", async () => {
    const r = await room();
    try {
        await r.tick();
        await r.tick(600);   // one tick missed
        assert.equal(r.server('registrar').incident, null);
        const before = r.server('registrar');
        assert.equal(before.looks - before.answered, 12 + 1);
        const last = r.nowS();
        await r.tick(1200);   // three missed
        const reg = r.server('registrar');
        assert.deepEqual(reg.incident, { began_at: last + 300, ended_at: r.nowS(), why: 'checks-missed' });
        assert.equal(reg.looks - reg.answered, 12 + 1 + 3);
        assert.equal(reg.percent, share(reg.answered, reg.looks));
        assert.equal(r.server('global').incident, null, 'a server is not down because the checks did not look');
        assert.equal(r.server('global').looks, r.history.ticks + 3, 'nor counted for the ticks that did not run');
    } finally { r.done(); }
});

test('a tick whose status write fails loses nothing: the next counts it; status.json is then one tick old', async () => {
    const r = await room();
    try {
        await r.tick();
        r.w.beforeRun(/INSERT INTO watch_days/, async () => { throw new Error('D1: too many queries in this invocation'); });
        r.servers['global.watch.test'].fail = 'timeout';
        await r.tick();
        assert.equal(r.doc().at, T0S, 'not written this tick');
        assert.ok(r.lines.some((l) => l.startsWith('[STATUS]') && l.includes('too many queries')), 'and logged why');
        const looks = r.w.sqlite.prepare("SELECT COUNT(*) AS n FROM watch_log WHERE target='global'").get().n;
        await r.tick();
        const g = r.server('global');
        assert.equal(g.looks, looks + 1, 'the failed tick\'s look counted');
        assert.equal(g.answered, g.looks - 7 - 2);
        assert.equal(r.server('registrar').looks - r.server('registrar').answered, 12, 'and its tick');
        assert.deepEqual(g.incident, { began_at: T0S + 300, ended_at: null, why: 'timed-out' }, 'begun at its first failed look, the one whose write failed');
    } finally { r.done(); }
});

test('D1: a quiet tick spends 2 queries on the status, its first 3; with no STATUS binding none and nothing is written', async () => {
    const counts = async (kv) => {
        const r = await room({ kv });
        const out = [];
        try {
            let n = 0;
            const prepare = r.w.env.DB.prepare.bind(r.w.env.DB);
            r.w.env.DB.prepare = (sql) => { n++; return prepare(sql); };
            for (let i = 0; i < 3; i++) { n = 0; await r.tick(); out.push(n); }
        } finally { r.done(); }
        return out;
    };
    const kv = fakeKV();
    const withKv = await counts(kv);
    const without = await counts(null);
    assert.deepEqual(withKv.map((n, i) => n - without[i]), [3, 2, 2], `with ${withKv}, without ${without}`);
    assert.equal(kv.puts, 3);
});

test('a first tick counts watch_log\'s whole days only; days past 100 go at the first tick of a UTC day; status.json stays small', async () => {
    const r = await room({ env: { STATUS_SERVERS: 'global, test,mullum-not-watched,registrar,vault,global' } });
    try {
        // watch_log back to its 30 days (from 10 Sep 12:00): that partial day is not counted, the whole day after it is.
        const ins = r.w.sqlite.prepare('INSERT INTO watch_log (ran_at, target, ok, ms, status) VALUES (?,?,?,?,?)');
        for (let s = Date.UTC(2026, 8, 10, 12, 0, 0) / 1000; s < Date.UTC(2026, 8, 12) / 1000; s += 300) ins.run(s, 'global', 0, 40, 'timed out');
        r.w.sqlite.prepare("INSERT INTO watch_days (target, day, looks, ok) VALUES ('global', '2026-07-01', 288, 0), ('global', '2026-07-02', 288, 0)").run();
        await r.tick();
        const d = r.doc();
        assert.deepEqual(d.servers.map((s) => s.name), ['global', 'test', 'vault', 'registrar'], 'unwatched names and "registrar" skipped, a repeat once');
        const fromDay = dayOf(T0S - (T0S % 86400) - 29 * 86400);
        assert.equal(r.server('global').since, fromDay, "from watch_log's oldest whole day");
        const g = r.w.sqlite.prepare("SELECT COUNT(*) AS looks, SUM(ok) AS ok FROM watch_log WHERE target='global' AND ran_at >= ?").get(Date.parse(`${fromDay}T00:00:00Z`) / 1000);
        assert.deepEqual([r.server('global').looks, r.server('global').answered], [g.looks, g.ok]);
        assert.equal(g.looks, 288 + r.history.ticks + 1, 'the whole day of 11 Sep, the log, this tick');
        assert.equal(r.server('registrar').since, fromDay);

        r.at(Date.UTC(2026, 9, 11, 0, 0, 0) / 1000 - 300);
        await r.tick();
        const days = () => r.w.sqlite.prepare("SELECT day FROM watch_days WHERE target='global' AND day < '2026-08-01' ORDER BY day").all().map((x) => x.day);
        assert.deepEqual(days(), [], 'past 100 days (before 3 Jul): gone at 00:00');
        r.w.sqlite.prepare("INSERT INTO watch_days (target, day, looks, ok) VALUES ('global', '2026-07-01', 1, 0), ('global', '2026-07-04', 1, 0)").run();
        await r.tick();
        assert.deepEqual(days(), ['2026-07-01', '2026-07-04'], 'and only at the first tick of the day');

        // Bounded: six servers (the most) with long names and incidents is under 2 KB.
        const long = Array.from({ length: 7 }, (_, i) => `server-${i}-${'x'.repeat(23)}`);
        const r2 = await room({ log: false, env: {
            WATCH_TARGETS: JSON.stringify(long.map((name) => ({ name, url: `https://${name}.watch.test` }))), STATUS_SERVERS: long.join(','),
        } });
        try {
            for (const name of long) r2.servers[`${name}.watch.test`] = { fail: 'timeout' };
            await r2.tick(); await r2.tick();
            for (const name of long) r2.servers[`${name}.watch.test`].fail = null;
            await r2.tick();
            assert.equal(r2.doc().servers.length, 6, 'five servers and the registrar at most');
            assert.ok(r2.doc().servers.every((s) => s.name === 'registrar' || s.incident), 'each with an incident');
            assert.ok(r2.kv.m.get('status.json').length < 2048, `${r2.kv.m.get('status.json').length} bytes`);
        } finally { r2.done(); }
    } finally { r.done(); }
});

test('migration 0011: re-running changes nothing; a database without it publishes nothing and logs why, the watch untouched', async () => {
    const r = await room();
    try {
        await r.tick();
        const before = r.w.sqlite.prepare('SELECT * FROM watch_days ORDER BY target, day').all();
        r.w.sqlite.exec(readFileSync(new URL('../migrations/0011_status.sql', import.meta.url), 'utf8'));
        assert.deepEqual(r.w.sqlite.prepare('SELECT * FROM watch_days ORDER BY target, day').all(), before);
    } finally { r.done(); }
    const BEFORE_0011 = ['0001_init.sql', '0002_states.sql', '0003_decision_seq.sql', '0004_teardown.sql', '0005_reserve_global.sql', '0006_request_nonces.sql', '0007_content_swap.sql', '0008_alerts.sql', '0009_watch.sql', '0010_reserve_our_hosts.sql'];
    const old = await room({ migrations: BEFORE_0011 });
    try {
        const seen = await old.tick();
        assert.deepEqual(seen.map((s) => [s.name, s.ok]), [['global', true], ['vault', true], ['mullum', true], ['test', true]], 'the watch looked');
        assert.equal(old.kv.puts, 0, 'nothing published');
        assert.ok(old.lines.some((l) => l.startsWith('[STATUS]') && l.includes('no such table')), old.lines.join('\n'));
        assert.equal(old.w.sqlite.prepare('SELECT COUNT(*) AS n FROM watch_log WHERE ran_at = ?').get(T0S).n, 4);
    } finally { old.done(); }
});

test('STATUS_SERVERS names our servers only (never mullum or castlemaine); unset, only the registrar is shown; /admin links the page', async () => {
    const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
    const listed = toml.match(/^STATUS_SERVERS = "([^"]*)"/m)?.[1];
    assert.equal(listed, 'global,test', "wrangler.toml shows global and test: ours, a community's never");
    const ours = ['global', 'test', 'vault'];
    for (const name of listed.split(',')) assert.ok(ours.includes(name), `${name} is one of our servers`);
    assert.match(toml, /^# \[\[kv_namespaces\]\]\n# binding = "STATUS"/m, 'the STATUS binding is written down, for its id to be filled in');

    const r = await room({ env: { STATUS_SERVERS: undefined } });
    try {
        await r.tick();
        assert.deepEqual(r.doc().servers.map((s) => s.name), ['registrar']);
    } finally { r.done(); }

    assert.match(ADMIN_HTML, /<a href="\/status"[^>]*>beanpool\.org\/status<\/a>/, '/admin links the public status page');
    assert.match(ADMIN_HTML, /\/api\/registrar\/status\.json/, 'and the JSON it draws');
});
