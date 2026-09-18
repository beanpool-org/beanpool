import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker, { tokenMatches, MAX_BODY_BYTES } from '../src/index.js';
import { senderKey } from '../src/ratelimit.js';

// A real SQLite behind a minimal D1-shaped API, loaded with the real schema.sql — so the SQL the
// Worker sends (ON CONFLICT … RETURNING, COALESCE updates) is exercised, not pattern-matched.
function createD1() {
    const db = new DatabaseSync(':memory:');
    db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
    const stmt = (sql, args = []) => ({
        bind: (...a) => stmt(sql, a),
        async first() { return db.prepare(sql).get(...args) ?? null; },
        async all() { return { results: db.prepare(sql).all(...args), success: true, meta: {} }; },
        async run() {
            const r = db.prepare(sql).run(...args);
            return { success: true, meta: { changes: Number(r.changes) } };
        },
        _exec() {
            const p = db.prepare(sql);
            return /\bRETURNING\b|^\s*SELECT/i.test(sql)
                ? { results: p.all(...args), success: true, meta: {} }
                : { results: [], success: true, meta: { changes: Number(p.run(...args).changes) } };
        },
    });
    return {
        raw: db,
        prepare: (sql) => stmt(sql),
        async batch(list) {
            db.exec('BEGIN');
            try { const out = list.map((s) => s._exec()); db.exec('COMMIT'); return out; }
            catch (e) { db.exec('ROLLBACK'); throw e; }
        },
    };
}

const ADMIN = 'test-admin-token-please-ignore';
const mkEnv = (over = {}) => ({ DB: createD1(), FEEDBACK_ADMIN_TOKEN: ADMIN, RATE_PER_HOUR: '5', RATE_PER_DAY: '20', CORS_ORIGINS: '*', ...over });
const BASE = 'https://beanpool.org';
const IP = '203.0.113.77';

const good = (over = {}) => ({
    text: 'Please add a way to list firewood for trade by the load.',
    kind: 'idea', source: 'member-app', appVersion: '1.2.37', platform: 'android', lang: 'es-AR',
    community: '', website: '', ...over,
});

function post(env, body, { ip = IP, origin = 'https://mullum.beanpool.org', headers = {} } = {}) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return worker.fetch(new Request(`${BASE}/api/feedback`, {
        method: 'POST', body: text,
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, origin, ...headers },
    }), env);
}

const admin = (env, path, { method = 'GET', token = ADMIN, body } = {}) =>
    worker.fetch(new Request(`${BASE}/api/feedback/admin/${path}`, {
        method,
        headers: { ...(token !== null ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    }), env);

const rows = (env) => env.DB.raw.prepare('SELECT * FROM feedback_items ORDER BY id').all();

// Every text value in every table, for "the IP is nowhere" assertions.
function everyStoredValue(env) {
    const tables = env.DB.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
    return tables.flatMap((t) => env.DB.raw.prepare(`SELECT * FROM "${t}"`).all().flatMap((r) => Object.values(r).map(String)));
}

function withClock(ms, fn) {
    const real = Date.now;
    Date.now = () => ms;
    return Promise.resolve().then(fn).finally(() => { Date.now = real; });
}

// --- Submission & storage ---

test('a valid suggestion is stored as new with exactly the allowed fields', async () => {
    const env = mkEnv();
    const res = await post(env, good({ community: '  Mullum Mullum  ' }), { headers: { 'user-agent': 'SecretAgent/1.0' } });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { ok: true });
    const [row] = rows(env);
    assert.equal(row.text, good().text);
    assert.equal(row.kind, 'idea');
    assert.equal(row.source, 'member-app');
    assert.equal(row.app_version, '1.2.37');
    assert.equal(row.platform, 'android');
    assert.equal(row.lang, 'es-AR');
    assert.equal(row.community, 'Mullum Mullum');
    assert.equal(row.status, 'new');
    assert.ok(Math.abs(row.received_at - Date.now() / 1000) < 5);
    assert.deepEqual(Object.keys(row).sort(), [
        'app_version', 'community', 'github_url', 'id', 'kind', 'lang', 'note', 'platform', 'received_at', 'source', 'status', 'text', 'updated_at',
    ]);
});

test('no IP, user agent or member key is stored anywhere in the database', async () => {
    const env = mkEnv();
    const res = await post(env, { ...good(), pubkey: 'a'.repeat(64), memberKey: 'b'.repeat(64) }, {
        ip: '198.51.100.23', headers: { 'user-agent': 'SecretAgent/1.0', 'x-forwarded-for': '198.51.100.23' },
    });
    assert.equal(res.status, 201);
    const all = everyStoredValue(env);
    assert.ok(all.length > 0);
    for (const v of all) {
        assert.ok(!v.includes('198.51.100.23'), `IP found in stored value: ${v}`);
        assert.ok(!v.includes('SecretAgent'), `user agent found in stored value: ${v}`);
        assert.ok(!v.includes('a'.repeat(64)) && !v.includes('b'.repeat(64)), 'member key found in a stored value');
    }
});

test('an empty community stays null — the member chose not to say', async () => {
    const env = mkEnv();
    await post(env, good({ community: '   ' }));
    await post(env, good({ community: undefined }), { ip: '203.0.113.1' });
    assert.deepEqual(rows(env).map((r) => r.community), [null, null]);
});

test('missing kind defaults to other; diagnostic fields that do not parse are dropped, not fatal', async () => {
    const env = mkEnv();
    const res = await post(env, good({ kind: undefined, appVersion: '<script>', platform: 'x'.repeat(50), lang: 'not a tag!' }));
    assert.equal(res.status, 201);
    const [row] = rows(env);
    assert.equal(row.kind, 'other');
    assert.equal(row.app_version, null);
    assert.equal(row.platform, null);
    assert.equal(row.lang, null);
});

// --- Validation ---

test('validation: text length is 10–2000 characters after trim', async () => {
    const env = mkEnv();
    for (const [text, status] of [
        ['short', 400], ['     123456789     ', 400], [undefined, 400], [42, 400],
        ['x'.repeat(2001), 400], ['x'.repeat(2000), 201], ['  0123456789  ', 201],
    ]) {
        const res = await post(env, good({ text }));
        assert.equal(res.status, status, `text=${String(text).slice(0, 20)}… → ${res.status}`);
    }
});

test('validation: length counts characters, not UTF-16 units — 2000 emoji or Devanagari fit', async () => {
    const env = mkEnv();
    assert.equal((await post(env, good({ text: '🌱'.repeat(2000) }))).status, 201);
    assert.equal((await post(env, good({ text: '🌱'.repeat(2001) }), { ip: '10.9.9.9' })).status, 400);
});

test('validation: kind, source and community are checked', async () => {
    const env = mkEnv();
    const cases = [
        [good({ kind: 'rant' }), /kind/],
        [good({ source: 'somewhere' }), /source/],
        [good({ source: undefined }), /source/],
        [good({ community: 'c'.repeat(81) }), /community/],
        [good({ community: 7 }), /community/],
    ];
    for (const [body, re] of cases) {
        const res = await post(env, body);
        assert.equal(res.status, 400);
        assert.match((await res.json()).error, re);
    }
    for (const source of ['member-app', 'web', 'settings-app']) {
        assert.equal((await post(env, good({ source }), { ip: `10.1.1.${source.length}` })).status, 201);
    }
    assert.equal(rows(env).length, 3);
});

test('validation: non-JSON, arrays and null bodies are refused', async () => {
    const env = mkEnv();
    for (const body of ['not json', '[1,2]', 'null', '']) {
        assert.equal((await post(env, body)).status, 400, `body ${JSON.stringify(body)}`);
    }
    assert.equal(rows(env).length, 0);
});

test('oversized bodies are refused before parsing — by content-length and by streamed size', async () => {
    const env = mkEnv();
    const big = JSON.stringify(good({ text: 'x'.repeat(MAX_BODY_BYTES) }));
    assert.equal((await post(env, big)).status, 413);

    // No content-length: a chunked stream that goes over the cap.
    const stream = new ReadableStream({
        start(c) { for (let i = 0; i < 40; i++) c.enqueue(new TextEncoder().encode('x'.repeat(1024))); c.close(); },
    });
    const res = await worker.fetch(new Request(`${BASE}/api/feedback`, { method: 'POST', body: stream, duplex: 'half', headers: { 'cf-connecting-ip': IP } }), env);
    assert.equal(res.status, 413);
    assert.equal(rows(env).length, 0);
});

test('control characters are stripped from the text', async () => {
    const env = mkEnv();
    await post(env, good({ text: 'Line one  is here\nand line two' }));
    assert.equal(rows(env)[0].text, 'Line one is here\nand line two');
});

// --- Honeypot ---

test('honeypot: a filled hidden field looks like success but stores and counts nothing', async () => {
    const env = mkEnv();
    for (let i = 0; i < 10; i++) {
        const res = await post(env, good({ website: 'http://spam.example' }));
        assert.equal(res.status, 201);
        assert.deepEqual(await res.json(), { ok: true });
    }
    assert.equal(rows(env).length, 0);
    // Not counted against the sender either: a real submission from the same IP still goes through.
    assert.equal((await post(env, good())).status, 201);
    assert.equal(rows(env).length, 1);
});

// --- Rate limit ---

test('rate limit: 5 per hour per sender, then a friendly 429 with Retry-After; other senders unaffected', async () => {
    const env = mkEnv();
    const t0 = Date.UTC(2026, 8, 21, 10, 15, 0);
    await withClock(t0, async () => {
        for (let i = 0; i < 5; i++) assert.equal((await post(env, good())).status, 201, `submission ${i + 1}`);
        const res = await post(env, good());
        assert.equal(res.status, 429);
        const body = await res.json();
        assert.equal(body.ok, false);
        assert.match(body.error, /try again/i);
        assert.equal(res.headers.get('retry-after'), String(45 * 60));
        assert.equal(res.headers.get('access-control-allow-origin'), '*', 'the app must be able to read the 429');
        assert.equal((await post(env, good(), { ip: '198.51.100.9' })).status, 201);
    });
    assert.equal(rows(env).length, 6);
    // The hourly window moves on.
    await withClock(t0 + 3600_000, async () => assert.equal((await post(env, good())).status, 201));
});

test('rate limit: IPv6 senders are limited by their /64, not the single address (#919 review)', async () => {
    const env = mkEnv();
    await withClock(Date.UTC(2026, 8, 21, 10, 15, 0), async () => {
        const statuses = [];
        for (let i = 1; i <= 8; i++) statuses.push((await post(env, good(), { ip: `2001:db8:abcd:12::${i.toString(16)}` })).status);
        assert.deepEqual(statuses, [201, 201, 201, 201, 201, 429, 429, 429]);
        // A different /64 is a different sender.
        assert.equal((await post(env, good(), { ip: '2001:db8:abcd:13::1' })).status, 201);
    });
});

test('senderKey: IPv4 as is; IPv6 folded to its /64 however it is written', () => {
    assert.equal(senderKey('203.0.113.77'), '203.0.113.77');
    assert.equal(senderKey('2001:db8:abcd:12::1'), '2001:db8:abcd:12::/64');
    assert.equal(senderKey('2001:0db8:abcd:0012:ffff:0:0:9'), '2001:db8:abcd:12::/64');
    assert.equal(senderKey('2001:db8::1'), '2001:db8:0:0::/64');
    assert.equal(senderKey(''), 'unknown');
    assert.equal(senderKey('::ffff:203.0.113.77'), '203.0.113.77');
    assert.notEqual(senderKey('::ffff:203.0.113.77'), senderKey('::ffff:198.51.100.9'));
});

test('rate limit: a global daily cap holds even when every sender is different', async () => {
    const env = mkEnv({ RATE_GLOBAL_PER_DAY: '3' });
    await withClock(Date.UTC(2026, 8, 21, 10, 15, 0), async () => {
        const statuses = [];
        for (let i = 1; i <= 5; i++) statuses.push((await post(env, good(), { ip: `198.51.100.${i}` })).status);
        assert.deepEqual(statuses, [201, 201, 201, 429, 429]);
    });
});

test('rate limit: 20 per UTC day per sender even when spread over hours', async () => {
    const env = mkEnv();
    const day = Date.UTC(2026, 8, 21, 0, 30, 0);
    let accepted = 0;
    for (let h = 0; h < 6; h++) {
        await withClock(day + h * 3600_000, async () => {
            for (let i = 0; i < 5; i++) if ((await post(env, good())).status === 201) accepted++;
        });
    }
    assert.equal(accepted, 20);
});

test('rate limit: the salt rotates daily and yesterday’s salt and counters are deleted', async () => {
    const env = mkEnv();
    const d1 = Date.UTC(2026, 8, 21, 23, 0, 0);
    await withClock(d1, async () => { for (let i = 0; i < 6; i++) await post(env, good()); });
    const salt1 = env.DB.raw.prepare('SELECT salt FROM rate_salts').all();
    assert.equal(salt1.length, 1);
    const hash1 = env.DB.raw.prepare('SELECT DISTINCT hash FROM rate_buckets WHERE hash != \'global\'').all();
    assert.equal(hash1.length, 1);
    assert.ok(!hash1[0].hash.includes(IP));

    await withClock(d1 + 2 * 3600_000, async () => assert.equal((await post(env, good())).status, 201, 'new day, new allowance'));
    const salts = env.DB.raw.prepare('SELECT day, salt FROM rate_salts').all();
    assert.deepEqual(salts.map((s) => s.day), ['2026-09-22']);
    assert.notEqual(salts[0].salt, salt1[0].salt);
    const days = env.DB.raw.prepare('SELECT DISTINCT day FROM rate_buckets').all().map((r) => r.day);
    assert.deepEqual(days, ['2026-09-22']);
    const hash2 = env.DB.raw.prepare('SELECT DISTINCT hash FROM rate_buckets WHERE hash != \'global\'').all();
    assert.notEqual(hash2[0].hash, hash1[0].hash, 'same IP must not hash the same across days');
});

test('the daily cron purges old salts and counters', async () => {
    const env = mkEnv();
    await withClock(Date.UTC(2026, 8, 21, 12), () => post(env, good()));
    await withClock(Date.UTC(2026, 8, 22, 0, 5), () => worker.scheduled({}, env));
    assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM rate_salts').get().n, 0);
    assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM rate_buckets').get().n, 0);
    assert.equal(rows(env).length, 1, 'the suggestion itself is kept');
});

// --- Admin ---

test('admin: every admin route needs the bearer token', async () => {
    const env = mkEnv();
    await post(env, good());
    for (const [path, method] of [['items', 'GET'], ['items?status=new', 'GET'], ['items/1', 'POST']]) {
        for (const token of [null, '', 'wrong', ADMIN + 'x', ADMIN.slice(0, -1)]) {
            const res = await admin(env, path, { method, token, body: method === 'POST' ? { status: 'spam' } : undefined });
            assert.equal(res.status, 401, `${method} ${path} token=${token}`);
        }
    }
    assert.equal(rows(env)[0].status, 'new', 'nothing changed without auth');
});

test('admin: with no token configured the admin API is closed, even to an empty bearer', async () => {
    const env = mkEnv({ FEEDBACK_ADMIN_TOKEN: undefined });
    assert.equal((await admin(env, 'items', { token: '' })).status, 401);
    assert.equal((await admin(env, 'items', { token: 'undefined' })).status, 401);
    const env2 = mkEnv({ FEEDBACK_ADMIN_TOKEN: '' });
    assert.equal((await admin(env2, 'items', { token: '' })).status, 401);
});

test('admin: list by status with limit and total', async () => {
    const env = mkEnv({ RATE_PER_HOUR: '100', RATE_PER_DAY: '100' });
    for (let i = 0; i < 4; i++) await post(env, good({ text: `Suggestion number ${i} is here` }));
    let res = await admin(env, 'items?status=new&limit=3');
    assert.equal(res.status, 200);
    let body = await res.json();
    assert.equal(body.items.length, 3);
    assert.equal(body.total, 4);
    assert.equal(body.items[0].text, 'Suggestion number 0 is here');
    assert.equal(res.headers.get('access-control-allow-origin'), null);

    assert.equal((await admin(env, 'items?status=bogus')).status, 400);
    res = await admin(env, 'items?status=spam');
    body = await res.json();
    assert.deepEqual(body, { items: [], total: 0 });
});

test('admin: set status, github_url and note; bad input refused; unknown id 404', async () => {
    const env = mkEnv();
    await post(env, good());
    let res = await admin(env, 'items/1', { method: 'POST', body: { status: 'triaged', note: 'cluster: firewood trading' } });
    assert.equal(res.status, 200);
    res = await admin(env, 'items/1', { method: 'POST', body: { status: 'filed', github_url: 'https://github.com/beanpool-org/beanpool/discussions/12' } });
    assert.equal(res.status, 200);
    const [row] = rows(env);
    assert.equal(row.status, 'filed');
    assert.equal(row.note, 'cluster: firewood trading', 'an update without a note keeps the earlier one');
    assert.equal(row.github_url, 'https://github.com/beanpool-org/beanpool/discussions/12');
    assert.ok(row.updated_at > 0);

    assert.equal((await admin(env, 'items/1', { method: 'POST', body: { status: 'deleted' } })).status, 400);
    assert.equal((await admin(env, 'items/1', { method: 'POST', body: { status: 'filed', github_url: 'https://evil.example/x' } })).status, 400);
    assert.equal((await admin(env, 'items/999', { method: 'POST', body: { status: 'spam' } })).status, 404);
    assert.equal((await admin(env, 'items/abc', { method: 'POST', body: { status: 'spam' } })).status, 404);
});

test('nothing else is readable publicly', async () => {
    const env = mkEnv();
    await post(env, good());
    for (const [path, method] of [['/api/feedback', 'GET'], ['/api/feedback/items', 'GET'], ['/api/feedback/1', 'GET'], ['/', 'GET'], ['/api/feedback/admin', 'GET']]) {
        const res = await worker.fetch(new Request(`${BASE}${path}`, { method }), env);
        assert.ok([401, 404, 405].includes(res.status), `${method} ${path} → ${res.status}`);
        assert.ok(!(await res.text()).includes('firewood'), `${method} ${path} leaked a suggestion`);
    }
});

test('tokenMatches is exact', async () => {
    assert.equal(await tokenMatches('abc', 'abc'), true);
    assert.equal(await tokenMatches('abc', 'abd'), false);
    assert.equal(await tokenMatches('ab', 'abc'), false);
    assert.equal(await tokenMatches('', ''), false);
    assert.equal(await tokenMatches(null, 'abc'), false);
    assert.equal(await tokenMatches('abc', undefined), false);
});

// --- CORS ---

test('CORS: public preflight and POST allow the app origins; admin routes send no CORS headers', async () => {
    const env = mkEnv();
    const pre = await worker.fetch(new Request(`${BASE}/api/feedback`, {
        method: 'OPTIONS',
        headers: { origin: 'https://some-village.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    }), env);
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
    assert.match(pre.headers.get('access-control-allow-methods'), /POST/);
    assert.match(pre.headers.get('access-control-allow-headers'), /content-type/);
    assert.equal(pre.headers.get('access-control-allow-credentials'), null);

    const res = await post(env, good());
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const bad = await post(env, good({ text: 'short' }));
    assert.equal(bad.headers.get('access-control-allow-origin'), '*', 'the app must be able to read a 400 message');

    const adminPre = await worker.fetch(new Request(`${BASE}/api/feedback/admin/items`, { method: 'OPTIONS', headers: { origin: 'https://x.example' } }), env);
    assert.equal(adminPre.headers.get('access-control-allow-origin'), null);
    const adminGet = await admin(env, 'items');
    assert.equal(adminGet.headers.get('access-control-allow-origin'), null);
});

test('CORS: a narrowed CORS_ORIGINS reflects listed origins only', async () => {
    const env = mkEnv({ CORS_ORIGINS: 'https://mullum.beanpool.org, https://castlemaine.beanpool.org' });
    const ok = await post(env, good(), { origin: 'https://castlemaine.beanpool.org' });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://castlemaine.beanpool.org');
    assert.match(ok.headers.get('vary'), /Origin/);
    const other = await post(env, good(), { origin: 'https://elsewhere.example', ip: '10.2.2.2' });
    assert.equal(other.headers.get('access-control-allow-origin'), null);
});
