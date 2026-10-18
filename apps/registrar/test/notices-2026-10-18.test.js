// Slice S2 of scratch/global-node/DESIGN-registrar-trust-fable.md (§3.2, §6) as decided by Marty on 2026-10-18 (D4):
// notices to the operators of names, carried by each node's own signed /status and never again once it says `seen`; a
// blocked key hears them too; one-use reply links that say nothing of the name or the key; and contact retention (a
// name's contact cleared once its hold is over). Every test here fails on origin/main (a77b76d1: no migration 0013, no
// /notices route, /status carries nothing, the sweep keeps every contact).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { attestSweep, checkReplyToken, redeemReplyToken, releaseCooloffS } from '../src/index.js';
import * as db from '../src/db.js';
import { world, liveName, makeKey, nowS, toHex } from './harness.js';

const REPLY_URL = 'https://beanpool.org/reply/';
const noticeWorld = (env = {}) => world({ env });

// A node's /status, as registrar-client.ts sends it: the path signed in x-bp-signature, and the query (`?name=`,
// `?notices=1`, `?seen=`) in x-bp-signature-query under the same timestamp. `notices: null`: an older node's, which
// asks for none.
async function status(w, key, query = {}) {
    const search = Object.entries({ notices: '1', ...query }).filter(([, v]) => v != null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const req = await w.signed('GET', '/api/registrar/status', key);
    if (search) {
        const ts = req.headers.get('x-bp-timestamp');
        const msg = `beanpool-registrar-request/v1\nGET\n/api/registrar/status?${search}\n${ts}\n`;
        const sig = toHex(await crypto.subtle.sign('Ed25519', key.keyPair.privateKey, new TextEncoder().encode(msg)));
        const signed = new Request(`https://beanpool.org/api/registrar/status?${search}`, { method: 'GET', headers: req.headers });
        signed.headers.set('x-bp-signature-query', sig);
        const res = await worker.fetch(signed, w.env);
        return { status: res.status, body: await res.json() };
    }
    const res = await worker.fetch(req, w.env);
    return { status: res.status, body: await res.json() };
}
async function admin(w, path, body, headers = { 'x-admin-secret': 'test-admin-secret' }) {
    const res = await worker.fetch(new Request(`https://beanpool.org/api/local/admin/registrar/${path}`, body === undefined
        ? { headers }
        : { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) }), w.env);
    return { status: res.status, body: await res.json() };
}
const send = (w, body) => admin(w, 'notices', { level: 'info', ...body });
const told = (w, like) => w.sqlite.prepare('SELECT title, body, name FROM alert_outbox WHERE title LIKE ? ORDER BY id').all(like).map((r) => ({ ...r }));
const row = (w, n) => w.sqlite.prepare('SELECT * FROM name_allocations WHERE name=?').get(n);
const tokens = (w) => w.sqlite.prepare('SELECT * FROM reply_tokens ORDER BY notice_id').all().map((r) => ({ ...r }));
const ids = (st) => (st.body.notices || []).map((n) => n.id);
const tokenOf = (link) => link.slice(REPLY_URL.length);
async function withClock(s, fn) {
    const real = Date.now;
    Date.now = () => s * 1000;
    try { return await fn(); } finally { Date.now = real; }
}

test('a notice sent appears once in the next /status, and never after the node says seen', async () => {
    const w = await noticeWorld();
    try {
        const key = await makeKey();
        await liveName(w, 'alpha', key);
        await w.verify('alpha');
        assert.equal(ids(await status(w, key)).length, 0, 'nothing before a notice is sent');
        const sent = await send(w, { to: { names: ['alpha'] }, text: 'Your name alpha is set up.\nThank you for running a node.' });
        assert.equal(sent.status, 200, JSON.stringify(sent.body));
        assert.equal(sent.body.recipients, 1);
        const id = sent.body.id;

        const first = await status(w, key);
        assert.equal(first.status, 200);
        assert.equal(first.body.status, 'live', 'the rest of the answer is as before');
        assert.deepEqual(ids(first), [id], 'carried once in the next /status');
        const n = first.body.notices[0];
        assert.deepEqual({ ...n, at: typeof n.at }, { id, at: 'number', level: 'info', text: 'Your name alpha is set up.\nThank you for running a node.', name: 'alpha' });
        assert.equal(n.link, undefined, 'no reply link without REPLY_URL');
        // Until the node says it has it, each /status carries it again (the answer may never have reached the node).
        assert.deepEqual(ids(await status(w, key, { name: 'alpha' })), [id]);
        // `seen`: never carried again — whatever the node sends after (a node that lost its mark sends none).
        assert.deepEqual(ids(await status(w, key, { name: 'alpha', seen: String(id) })), [], 'the /status that says seen carries nothing');
        assert.deepEqual(ids(await status(w, key)), [], 'nor any after it, without seen');
        assert.deepEqual(ids(await status(w, key, { seen: '0' })), []);
        const r = w.sqlite.prepare('SELECT * FROM notice_recipients WHERE notice_id=?').get(id);
        assert.ok(r.delivered_at && r.seen_at, 'delivered and seen recorded');
        // A seen that is not covered by its signature is not read: a replayed /status can't acknowledge for the node.
        const second = (await send(w, { to: { names: ['alpha'] }, text: 'Second notice.' })).body.id;
        assert.deepEqual(ids(await status(w, key)), [second]);
        // Nor is an unsigned ?notices=1, so it carries nothing; the signed /status after it still carries the notice.
        const unsigned = new Request(`https://beanpool.org/api/registrar/status?notices=1&seen=${second}`, { headers: (await w.signed('GET', '/api/registrar/status', key)).headers });
        assert.equal((await (await worker.fetch(unsigned, w.env)).json()).notices, undefined, 'an unsigned ?notices=1 carries nothing');
        assert.deepEqual(ids(await status(w, key)), [second], 'an unsigned ?seen= acknowledges nothing');
        assert.deepEqual(ids(await status(w, key, { seen: String(second) })), []);
        // Another key hears nothing of it.
        const other = await makeKey();
        await liveName(w, 'beta', other);
        assert.deepEqual(ids(await status(w, other)), []);
    } finally { w.restore(); }
});

// An older node asks for no notices (no `?notices=1`): it would keep the whole answer in its saved address, a live reply
// link included, and never show it or say seen (#2151 review 4306341021). It is carried none, nothing is marked
// delivered to it, and no reply link is made for it; a node that asks is carried the same notice after.
test('a /status without ?notices=1 (an older node) carries no notice and marks nothing delivered', async () => {
    const w = await noticeWorld({ REPLY_URL });
    try {
        const key = await makeKey();
        await liveName(w, 'old-node', key);
        const id = (await send(w, { to: { names: ['old-node'] }, text: 'Please tell us how setup went.', reply: true })).body.id;
        for (const query of [{ notices: null }, { notices: null, name: 'old-node' }, { notices: '0', name: 'old-node' }]) {
            const st = await status(w, key, query);
            assert.equal(st.status, 200);
            assert.equal(st.body.status, 'live', 'the rest of the answer is as before');
            assert.ok(st.body.tunnelToken);
            assert.equal(st.body.notices, undefined, JSON.stringify(query));
        }
        const r = w.sqlite.prepare('SELECT * FROM notice_recipients WHERE notice_id=?').get(id);
        assert.equal(r.delivered_at, null, 'not marked delivered');
        assert.equal(r.reply_token, null);
        assert.equal(tokens(w).length, 0, 'no reply link made for it');
        assert.equal((await admin(w, 'notices')).body.notices.find((x) => x.id === id).delivered, 0, '/admin counts it as not delivered');
        const asked = await status(w, key, { name: 'old-node' });
        assert.deepEqual(ids(asked), [id], 'a node that asks is carried it');
        assert.match(asked.body.notices[0].link, /^https:\/\/beanpool\.org\/reply\/[A-Za-z0-9_-]{43}$/);
        assert.equal((await admin(w, 'notices')).body.notices.find((x) => x.id === id).delivered, 1);
    } finally { w.restore(); }
});

test("a blocked key's /status still carries a notice; a released name's notices stop at release", async () => {
    const w = await noticeWorld();
    try {
        const key = await makeKey();
        await liveName(w, 'gamma', key);
        assert.equal((await w.admin('gamma', 'block')).body.status, 'blocked');
        const id = (await send(w, { to: { names: ['gamma'] }, level: 'action', text: 'This name was blocked with others made from the same network on 18 Oct. If this is a mistake, reply here.' })).body.id;
        const st = await status(w, key);
        assert.equal(st.body.status, 'blocked');
        assert.deepEqual(ids(st), [id], 'the blocked key hears it');
        assert.equal(st.body.notices[0].level, 'action');

        const k2 = await makeKey();
        await liveName(w, 'delta', k2);
        const id2 = (await send(w, { to: { names: ['delta'] }, text: 'A notice for delta.' })).body.id;
        assert.equal((await w.release(k2, { name: 'delta' })).body.status, 'released');
        const after = await status(w, k2);
        assert.equal(after.body.status, 'released');
        assert.deepEqual(ids(after), [], 'released: no longer carried');
        // A notice to a name nobody holds is refused, and nothing is kept of it.
        const none = await send(w, { to: { names: ['delta'] }, text: 'Too late.' });
        assert.equal(none.status, 400);
        assert.match(none.body.error, /no name in delta is held now/);
        assert.equal(w.sqlite.prepare('SELECT COUNT(*) AS n FROM notices WHERE id > ?').get(id2).n, 0);
    } finally { w.restore(); }
});

test('reply links: one use, past their time or their name nothing, the token random and only its hash kept', async () => {
    const w = await noticeWorld({ REPLY_URL });
    try {
        const key = await makeKey();
        await liveName(w, 'epsilon', key);
        const id = (await send(w, { to: { names: ['epsilon'] }, text: 'Please tell us how setup went.', reply: true })).body.id;
        const a = (await status(w, key)).body.notices[0];
        assert.match(a.link, /^https:\/\/beanpool\.org\/reply\/[A-Za-z0-9_-]{43}$/);
        const token = tokenOf(a.link);
        // Carried again before seen: the same link, made once.
        assert.equal((await status(w, key)).body.notices[0].link, a.link);
        assert.equal(tokens(w).length, 1);
        // Nothing in the token is the name or the key; the database keeps its SHA-256, never the token itself once seen.
        assert.ok(!token.includes('epsilon') && !token.toLowerCase().includes(key.pubHex.slice(0, 8)));
        assert.notEqual(tokens(w)[0].token_hash, token);
        await status(w, key, { seen: String(id) });
        const everything = JSON.stringify(w.sqlite.prepare('SELECT * FROM notice_recipients').all()) + JSON.stringify(tokens(w));
        assert.ok(!everything.includes(token), 'the token itself is gone once the node has seen it');

        assert.deepEqual(await checkReplyToken(w.env, token), { ok: true }, 'check says only that it works');
        assert.deepEqual(await redeemReplyToken(w.env, token), { ok: true, name: 'epsilon', notice_id: id });
        assert.deepEqual(await redeemReplyToken(w.env, token), { ok: false }, 'used once');
        assert.deepEqual(await checkReplyToken(w.env, token), { ok: false });
        assert.deepEqual(await checkReplyToken(w.env, 'x'.repeat(43)), { ok: false }, 'never one');
        assert.deepEqual(await checkReplyToken(w.env, `${token}=`), { ok: false }, 'not a token');
        // The admin hears of the reply: the name and the notice's number, never the words (they are in the feedback inbox).
        const reply = told(w, 'Reply from%');
        assert.equal(reply.length, 1);
        assert.match(reply[0].body, new RegExp(`answered notice #${id}`));
        assert.deepEqual(w.events('epsilon').filter((e) => e.event === 'notice-reply').length, 1);

        // Past its time: nothing.
        const id2 = (await send(w, { to: { names: ['epsilon'] }, text: 'Another?', reply: true })).body.id;
        const t2 = tokenOf((await status(w, key, { seen: String(id) })).body.notices.find((x) => x.id === id2).link);
        w.sqlite.prepare('UPDATE reply_tokens SET expires_at = ? WHERE notice_id = ?').run(nowS() - 1, id2);
        assert.deepEqual(await redeemReplyToken(w.env, t2), { ok: false }, 'expired');
        // Its name released: nothing (the link was the name's, not the person's).
        const id3 = (await send(w, { to: { names: ['epsilon'] }, text: 'And another.', reply: true })).body.id;
        const t3 = tokenOf((await status(w, key)).body.notices.find((x) => x.id === id3).link);
        assert.deepEqual(await checkReplyToken(w.env, t3), { ok: true });
        await w.release(key, { name: 'epsilon' });
        assert.deepEqual(await checkReplyToken(w.env, t3), { ok: false }, 'released: the link is dead');
        assert.deepEqual(await redeemReplyToken(w.env, t3), { ok: false });
        // A blocked name's link works: a false positive reaches the admin this way.
        const k2 = await makeKey();
        await liveName(w, 'zeta', k2);
        await w.admin('zeta', 'block');
        const id4 = (await send(w, { to: { names: ['zeta'] }, text: 'Blocked. Reply if this is a mistake.', reply: true })).body.id;
        const t4 = tokenOf((await status(w, k2)).body.notices.find((x) => x.id === id4).link);
        assert.deepEqual(await redeemReplyToken(w.env, t4), { ok: true, name: 'zeta', notice_id: id4 });
    } finally { w.restore(); }
});

test('the admin sends to a list, a source group or every name — one per key — and the words never reach an alert or a name event', async () => {
    const w = await noticeWorld({ SOURCE_KEY: 'a-test-source-key-not-a-real-one' });
    try {
        const k1 = await makeKey();
        const k2 = await makeKey();
        await liveName(w, 'eta', k1);
        await liveName(w, 'theta', k2);
        // k2 holds a second name (a rename): every name, but one notice for its key.
        await liveName(w, 'theta-two', k2);
        const all = await send(w, { to: { all: true }, text: 'Maintenance on Sunday: names keep working.', level: 'warning', days: 3 });
        assert.equal(all.status, 200, JSON.stringify(all.body));
        assert.equal(all.body.recipients, 2, 'one per key');
        assert.equal((await status(w, k2)).body.notices.length, 1);
        // Name events: the notice's number and level, never its words; the alert likewise.
        const ev = w.events('eta').find((e) => e.event === 'notice');
        assert.match(ev.detail, new RegExp(`notice #${all.body.id} \\(warning\\) sent by the admin to every name`));
        assert.ok(!JSON.stringify(w.sqlite.prepare('SELECT * FROM name_events').all()).includes('Maintenance'));
        const alert = told(w, '%sent a notice%');
        assert.equal(alert.length, 1);
        assert.match(alert[0].title, /You sent a notice to 2 names/);
        assert.ok(!JSON.stringify(alert).includes('Maintenance'));

        // A source group (the panel's): the names one source claimed in the last day.
        const req = await w.signed('POST', '/api/registrar/claim', await makeKey(), { mode: 'tunnel', name: 'from-src' });
        req.headers.set('cf-connecting-ip', '198.51.100.9');
        Object.defineProperty(req, 'cf', { value: { asn: 64500, asOrganization: 'Example Hosting', country: 'NL' } });
        assert.equal((await worker.fetch(req, w.env)).status, 200);
        const source = w.sqlite.prepare("SELECT source_hash FROM claim_sources WHERE name='from-src'").get().source_hash;
        const bySource = await send(w, { to: { source }, text: 'About your new names.' });
        assert.equal(bySource.body.recipients, 1);
        assert.deepEqual(w.sqlite.prepare('SELECT name FROM notice_recipients WHERE notice_id=?').all(bySource.body.id).map((r) => r.name), ['from-src']);
        // A network group (the panel's, its Notice button's { asn }) is that network's names with no source, as Reject
        // all and Block all read it: a keyed source's names on it are other groups, often other operators on a shared
        // host, and { asn } never reaches them (#2151 review 4306272063). from-src is keyed; from-net, a claim with no
        // address, is not.
        const keyless = await w.signed('POST', '/api/registrar/claim', await makeKey(), { mode: 'tunnel', name: 'from-net' });
        Object.defineProperty(keyless, 'cf', { value: { asn: 64500, asOrganization: 'Example Hosting', country: 'NL' } });
        assert.equal((await worker.fetch(keyless, w.env)).status, 200);
        assert.equal(w.sqlite.prepare("SELECT source_hash FROM claim_sources WHERE name='from-net'").get().source_hash, null);
        const byNet = await send(w, { to: { asn: 64500 }, text: 'About your network.' });
        assert.equal(byNet.body.recipients, 1);
        assert.deepEqual(w.sqlite.prepare('SELECT name FROM notice_recipients WHERE notice_id=?').all(byNet.body.id).map((r) => r.name), ['from-net'],
            'the network group\'s keyless name, never the keyed source\'s from-src');
        assert.deepEqual((await db.groupNames(w.env, { asn: 64500 }, nowS() - 86400, 100)).map((r) => r.name), ['from-net'], 'the names Block all acts on');

        // The list: counts of who it reached; one notice's recipients.
        await status(w, k1);
        await status(w, k1, { seen: String(all.body.id) });
        const list = (await admin(w, 'notices')).body;
        assert.equal(list.reply_links, false);
        const shown = list.notices.find((x) => x.id === all.body.id);
        assert.deepEqual([shown.recipients, shown.delivered, shown.seen, shown.replies, shown.audience], [2, 2, 1, 0, 'every name']);
        const who = (await admin(w, `notices?id=${all.body.id}`)).body.recipients;
        assert.deepEqual(who.map((r) => [r.name, !!r.delivered_at, !!r.seen_at]), [['eta', true, true], ['theta', true, false]]);

        // Refused: words a node can't show safely, too many, a bad level, reply links while REPLY_URL is unset, nobody.
        for (const [body, re] of [
            [{ to: { names: ['eta'] }, text: 'a\u202Eb' }, /control characters or characters that reorder text/],
            [{ to: { names: ['eta'] }, text: 'x'.repeat(501) }, /at most 500 characters/],
            [{ to: { names: ['eta'] }, text: '   ' }, /text must be the words to send/],
            [{ to: { names: ['eta'] }, text: 'ok', level: 'urgent' }, /level must be one of info, warning, action/],
            [{ to: { names: ['eta'] }, text: 'ok', days: 91 }, /days must be a whole number from 1 to 90/],
            [{ to: { names: ['eta'] }, text: 'ok', reply: true }, /REPLY_URL is not set/],
            [{ to: { names: ['Not A Name'] }, text: 'ok' }, /to must be/],
            [{ to: {}, text: 'ok' }, /to must be/],
        ]) {
            const r = await send(w, body);
            assert.equal(r.status, 400, JSON.stringify(body));
            assert.match(r.body.error, re);
        }
        // Only the admin.
        assert.equal((await admin(w, 'notices', { to: { all: true }, text: 'x' }, {})).status, 401);
        assert.equal((await admin(w, 'notices', undefined, {})).status, 401);
    } finally { w.restore(); }
});

test("a released name's contact is cleared once its hold is over (the sweep, one statement), and kept until then", async () => {
    const w = await noticeWorld();
    try {
        const key = await makeKey();
        const r = await w.claim(key, { name: 'iota', contact: 'iota-operator@example.org' });
        assert.equal(r.body.status, 'live');
        const k2 = await makeKey();
        await w.claim(k2, { name: 'kappa', contact: 'kappa@example.org' });
        const k3 = await makeKey();
        await w.claim(k3, { name: 'lambda', contact: 'lambda@example.org' });
        assert.equal((await w.release(key, { name: 'iota' })).body.status, 'released');
        await attestSweep(w.env);
        assert.equal(row(w, 'iota').contact, 'iota-operator@example.org', 'inside the hold: kept (its key may take it back)');
        // The hold over: cleared by the next sweep. A live name's contact stays.
        w.sqlite.prepare('UPDATE name_allocations SET released_at = ? WHERE name = ?').run(nowS() - releaseCooloffS(w.env) - 1, 'iota');
        await attestSweep(w.env);
        assert.equal(row(w, 'iota').contact, null, 'past the hold: null');
        assert.equal(row(w, 'kappa').contact, 'kappa@example.org', 'a live name keeps its contact');
        // Freed at once by the admin: nothing holds it, so cleared at the next sweep.
        assert.equal((await w.admin('lambda', 'release', { free_now: true })).status, 200);
        await attestSweep(w.env);
        assert.equal(row(w, 'lambda').contact, null);
        // Removed from the list: cleared at once.
        await w.admin('kappa', 'release', { free_now: true });
        w.sqlite.prepare("UPDATE name_allocations SET contact = 'kappa@example.org' WHERE name = 'kappa'").run();
        assert.equal((await w.admin('kappa', 'forget')).body.status, 'abandoned');
        assert.equal(row(w, 'kappa').contact, null);
    } finally { w.restore(); }
});

test('the sweep tidies once an hour: reply links never used past their time, notices a month past theirs with their recipients and links', async () => {
    const w = await noticeWorld({ REPLY_URL });
    try {
        const key = await makeKey();
        await liveName(w, 'mu-node', key);
        const old = (await send(w, { to: { names: ['mu-node'] }, text: 'Old news.', reply: true, days: 1 })).body.id;
        const fresh = (await send(w, { to: { names: ['mu-node'] }, text: 'News.', reply: true })).body.id;
        await status(w, key);
        assert.equal(tokens(w).length, 2);
        w.sqlite.prepare('UPDATE notices SET expires_at = ? WHERE id = ?').run(nowS() - 31 * 86400, old);
        w.sqlite.prepare('UPDATE reply_tokens SET expires_at = ? WHERE notice_id = ?').run(nowS() - 1, old);
        // Not the first sweep of an hour: nothing is tidied.
        const hour = Math.floor(nowS() / 3600) * 3600 + 3600;
        await withClock(hour + 600, () => attestSweep(w.env));
        assert.equal(tokens(w).length, 2);
        await withClock(hour + 10, () => attestSweep(w.env));
        assert.deepEqual(tokens(w).map((t) => t.notice_id), [fresh], 'the expired link went');
        assert.deepEqual(w.sqlite.prepare('SELECT id FROM notices').all().map((r) => r.id), [fresh], 'the old notice went');
        assert.deepEqual(w.sqlite.prepare('SELECT notice_id FROM notice_recipients').all().map((r) => r.notice_id), [fresh], 'with its recipients');

        // A used link is a reply /admin counts: it stays past its time, as long as its notice is listed; a link never
        // used goes at its time (#2151 review 4306272130).
        const link = (await status(w, key)).body.notices.find((n) => n.id === fresh).link;
        assert.equal((await redeemReplyToken(w.env, tokenOf(link))).ok, true);
        const unused = (await send(w, { to: { names: ['mu-node'] }, text: 'Later news.', reply: true })).body.id;
        await status(w, key);
        assert.deepEqual(tokens(w).map((t) => t.notice_id), [fresh, unused]);
        w.sqlite.prepare('UPDATE reply_tokens SET expires_at = ?').run(nowS() - 1);
        await withClock(hour + 3600 + 10, () => attestSweep(w.env));
        assert.deepEqual(tokens(w).map((t) => t.notice_id), [fresh], 'the used link stays past its time; the unused one went');
        const listed = (await admin(w, 'notices')).body.notices;
        assert.deepEqual(listed.map((x) => [x.id, x.replies]), [[unused, 0], [fresh, 1]], 'still one reply to the listed notice');
        assert.ok((await admin(w, `notices?id=${fresh}`)).body.recipients[0].replied_at, 'its recipient still shows the reply');
        // Its notice a month past its time: the used link goes with it.
        w.sqlite.prepare('UPDATE notices SET expires_at = ? WHERE id = ?').run(nowS() - 31 * 86400, fresh);
        await withClock(hour + 7200 + 10, () => attestSweep(w.env));
        assert.deepEqual(tokens(w), [], 'with its notice');
        assert.deepEqual(w.sqlite.prepare('SELECT id FROM notices').all().map((r) => r.id), [unused]);
    } finally { w.restore(); }
});

test('a database without migration 0012: /status answers as before, with no notices; /admin says the migration is missing', async () => {
    const w = await world({ migrations: ['0001_init.sql', '0002_states.sql', '0003_decision_seq.sql', '0004_teardown.sql', '0005_reserve_global.sql', '0006_request_nonces.sql', '0007_content_swap.sql', '0008_alerts.sql', '0009_watch.sql', '0010_reserve_our_hosts.sql', '0011_sources.sql'] });
    try {
        const key = await makeKey();
        await liveName(w, 'nu-node', key);
        const st = await status(w, key, { seen: '3' });
        assert.equal(st.status, 200);
        assert.equal(st.body.status, 'live');
        assert.ok(st.body.tunnelToken);
        assert.equal(st.body.notices, undefined);
        const list = await admin(w, 'notices');
        assert.equal(list.body.schema, false);
        await attestSweep(w.env);   // contact retention needs no new table; the tidying skips the missing ones
    } finally { w.restore(); }
});
