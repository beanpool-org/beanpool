// GET/POST /reply/<token> (src/reply.js): an operator's reply to a notice from the address service, filed in the feedback
// inbox under the name its link was made for. The link is checked and its one use taken through the registrar's
// ReplyTokens entrypoint; here that binding runs the registrar's own functions (apps/registrar/src/index.js
// checkReplyToken, redeemReplyToken) on a registrar database made from its migrations, so the contract between the two
// Workers is what is tested. Fails on origin/main (a77b76d1): no /reply route.
/* global URL, Buffer, crypto, TextEncoder, Request, URLSearchParams */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';
import { checkReplyToken, redeemReplyToken } from '../../registrar/src/index.js';

// A real SQLite behind the D1 calls both Workers make (prepare/bind/first/all/run, and batch for the rate limit's purge).
function d1(sqlFiles) {
    const db = new DatabaseSync(':memory:');
    for (const sql of sqlFiles) db.exec(sql);
    const stmt = (sql, args = []) => ({
        bind: (...a) => stmt(sql, a),
        async first() { const r = db.prepare(sql).get(...args); return r ? { ...r } : null; },
        async all() { return { results: db.prepare(sql).all(...args).map((r) => ({ ...r })), success: true, meta: {} }; },
        async run() { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
        _exec() {
            const p = db.prepare(sql);
            return /\bRETURNING\b|^\s*SELECT/i.test(sql) ? { results: p.all(...args).map((r) => ({ ...r })) } : { results: [], meta: { changes: Number(p.run(...args).changes) } };
        },
    });
    return {
        raw: db,
        prepare: (sql) => stmt(sql),
        async batch(list) { db.exec('BEGIN'); try { const out = list.map((s) => s._exec()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } },
    };
}
const MIGRATIONS = new URL('../../registrar/migrations/', import.meta.url);
const registrarDb = () => d1(readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(new URL(f, MIGRATIONS), 'utf8')));
const feedbackDb = () => d1([readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')]);

const nowS = () => Math.floor(Date.now() / 1000);
const sha256Hex = async (t) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t))).toString('hex');
const KEY = 'ab'.repeat(32);

// A registrar holding `name` for KEY, and a reply link made for its notice #7 — as the registrar's /status makes one.
async function setup({ status = 'live', binding = true } = {}) {
    const reg = { DB: registrarDb(), BASE_DOMAIN: 'beanpool.org' };
    reg.DB.raw.prepare("INSERT INTO name_allocations (name, node_pubkey, hostname, mode, status, attest_fails, requested_at) VALUES ('kestrel', ?, 'kestrel.beanpool.org', 'tunnel', ?, 0, ?)").run(KEY, status, nowS());
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
    reg.DB.raw.prepare('INSERT INTO reply_tokens (token_hash, notice_id, node_pubkey, name, at, expires_at) VALUES (?, 7, ?, ?, ?, ?)').run(await sha256Hex(token), KEY, 'kestrel', nowS(), nowS() + 14 * 86400);
    const calls = [];
    const env = {
        DB: feedbackDb(), RATE_PER_HOUR: '5', RATE_PER_DAY: '20', CORS_ORIGINS: '*', FEEDBACK_ADMIN_TOKEN: 'test-admin-token',
        ...(binding ? { REGISTRAR: {
            check: async (t) => { calls.push('check'); return checkReplyToken(reg, t); },
            redeem: async (t) => { calls.push('redeem'); return redeemReplyToken(reg, t); },
        } } : {}),
    };
    return { reg, env, token, calls };
}
const get = (env, token) => worker.fetch(new Request(`https://beanpool.org/reply/${token}`), env);
const post = (env, token, fields, ip = '203.0.113.9') => worker.fetch(new Request(`https://beanpool.org/reply/${token}`, {
    method: 'POST', body: new URLSearchParams(fields).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip },
}), env);
const items = (env) => env.DB.raw.prepare('SELECT * FROM feedback_items ORDER BY id').all().map((r) => ({ ...r }));
const REPLY = 'We are a real community garden; the names were made by our volunteers on one laptop.';

test('a working link shows the form, and says nothing of the name or the key; the page sends no Referer', async () => {
    const { env, token } = await setup();
    const res = await get(env, token);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<form method="post">/);
    assert.match(html, /Reply to the address service/);
    assert.ok(!html.includes('kestrel') && !html.includes(KEY.slice(0, 8)), 'neither the name nor the key');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(res.headers.get('content-security-policy'), /form-action 'self'/);
});

test('a reply is filed under the name, once: the link works one time, then says it does not', async () => {
    const { env, reg, token } = await setup();
    const res = await post(env, token, { text: `  ${REPLY}  `, website: '' });
    assert.equal(res.status, 201);
    assert.match(await res.text(), /your reply was sent/);
    const [row] = items(env);
    assert.deepEqual({ text: row.text, kind: row.kind, source: row.source, community: row.community, status: row.status, note: row.note },
        { text: REPLY, kind: 'other', source: 'address-reply', community: 'kestrel', status: 'new', note: 'reply to notice #7' });
    // The registrar took the link's one use, and told its admin (the name and the notice, never the words).
    assert.ok(reg.DB.raw.prepare('SELECT used_at FROM reply_tokens').get().used_at);
    const told = reg.DB.raw.prepare('SELECT title, body FROM alert_outbox').all();
    assert.equal(told.length, 1);
    assert.match(told[0].title, /Reply from kestrel/);
    assert.ok(!JSON.stringify(told).includes('volunteers'));
    // Used: a second reply, and the form itself, are refused.
    const again = await post(env, token, { text: REPLY });
    assert.equal(again.status, 410);
    assert.match(await again.text(), /This reply link does not work/);
    assert.equal((await get(env, token)).status, 410);
    assert.equal(items(env).length, 1);
    // Nothing stored here names the sender's connection.
    const everything = env.DB.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
        .flatMap((t) => env.DB.raw.prepare(`SELECT * FROM "${t.name}"`).all().flatMap((r) => Object.values(r).map(String)));
    assert.ok(!everything.some((v) => v.includes('203.0.113.9')));
});

test('a link for a released name, a made-up link and a malformed one all say it does not work', async () => {
    const released = await setup({ status: 'released' });
    assert.equal((await get(released.env, released.token)).status, 410);
    assert.equal((await post(released.env, released.token, { text: REPLY })).status, 410);
    assert.equal(items(released.env).length, 0);
    const { env, calls } = await setup();
    assert.equal((await get(env, 'A'.repeat(43))).status, 410, 'never a link');
    calls.length = 0;
    assert.equal((await get(env, 'not-a-token')).status, 410);
    assert.equal((await get(env, `${'A'.repeat(43)}/x`)).status, 410);
    assert.deepEqual(calls, [], 'a malformed link never reaches the registrar');
});

test('a reply too short keeps the words on the form and leaves the link unused; the hidden field stores nothing', async () => {
    const { env, token } = await setup();
    const short = await post(env, token, { text: 'too short' });
    assert.equal(short.status, 400);
    const html = await short.text();
    assert.match(html, /at least 10 characters/);
    assert.match(html, />too short<\/textarea>/);
    // Escaped on the way back.
    const sneaky = await post(env, token, { text: '<b>' });
    assert.ok((await sneaky.text()).includes('&lt;b&gt;</textarea>'));
    const bot = await post(env, token, { text: REPLY, website: 'http://spam.example' });
    assert.equal(bot.status, 201, 'looks like success');
    assert.equal(items(env).length, 0);
    assert.equal((await get(env, token)).status, 200, 'the link still works');
});

test("the feedback service's per-connection limit applies, before the link is used", async () => {
    const { env, token } = await setup();
    for (let i = 0; i < 5; i++) {
        const r = await worker.fetch(new Request('https://beanpool.org/api/feedback', {
            method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
            body: JSON.stringify({ text: `Suggestion number ${i} for the project.`, kind: 'idea', source: 'web' }),
        }), env);
        assert.equal(r.status, 201);
    }
    const res = await post(env, token, { text: REPLY });
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get('retry-after')) > 0);
    assert.ok((await res.text()).includes(REPLY), 'the words are still there');
    assert.equal((await get(env, token)).status, 200, 'the link was not used');
});

test('no registrar binding: replies are not set up here; a registrar that fails: try again, the words shown back', async () => {
    const none = await setup({ binding: false });
    assert.equal((await get(none.env, none.token)).status, 503);
    assert.match(await (await post(none.env, none.token, { text: REPLY })).text(), /Replies are not set up here/);
    const { env, token } = await setup();
    env.REGISTRAR = { check: async () => { throw new Error('down'); }, redeem: async () => { throw new Error('down'); } };
    assert.equal((await get(env, token)).status, 503);
    const res = await post(env, token, { text: REPLY });
    assert.equal(res.status, 503);
    assert.ok((await res.text()).includes(REPLY));
    assert.equal(items(env).length, 0);
});

test('the public suggestion endpoint cannot pose as a reply', async () => {
    const { env } = await setup();
    const r = await worker.fetch(new Request('https://beanpool.org/api/feedback', {
        method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.1' },
        body: JSON.stringify({ text: 'Pretending to be a reply about a name.', source: 'address-reply' }),
    }), env);
    assert.equal(r.status, 400);
    assert.equal(items(env).length, 0);
});
