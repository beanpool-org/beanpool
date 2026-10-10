// The control room's outside checks (src/watch.js; design scratch/global-node/DESIGN-alerts-fable.md §2.3, slice S2):
// the Worker on the harness, our servers faked behind the harness's fetch stub (nothing real is contacted), a fake
// ntfy, and a stepped clock. What is proven: down is said after two failed looks, not one, again at 24 h, cleared
// once; a 3xx and a timeout are failed looks and a redirect is never followed; the vault's report is believed only
// under the ticket key (another key's is "report unverifiable", a ZIP-215-only signature is refused, an old one is
// "stale"), backups and the off-box copy come from it, a locked vault is urgent; a release change and a watchdog
// restart are told once; our nodes on different releases are told after a day; the daily line goes at 08:00 Brisbane,
// once, with what the digest held; the sweep is untouched; no secret reaches a log line.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import worker, { attestSweep } from '../src/index.js';
import * as watch from '../src/watch.js';
import { world, makeKey, migration, workerdFetchInit } from './harness.js';

const SECRET = 's3cr3t';
const TOPIC = `https://ntfy.test/bp-control-room-${SECRET}-topic`;
const WITH_NTFY = { NTFY_URL: TOPIC, NTFY_TOKEN: `tk_${SECRET}_ntfy_token` };
const TARGETS = JSON.stringify([
    { name: 'global', url: 'https://global.watch.test' },
    { name: 'vault', url: 'https://vault.watch.test', kind: 'vault' },
    { name: 'mullum', url: 'https://mullum.watch.test' },
]);
// 2026-10-10 12:00 UTC = 22:00 Brisbane: ten hours from the next 08:00, so only the daily tests meet it.
const T0 = Date.UTC(2026, 9, 10, 12, 0, 0);
const toHex = (b) => Buffer.from(b).toString('hex');

// A node: /api/version and /api/community/health, or a failure a test switches on.
function nodeServer({ version = '1.2.30', commit = 'aaaaaaa1111111', recoveries = 0 } = {}) {
    const s = { version, commit, recoveries, fail: null, hits: [] };
    s.handle = (path) => {
        s.hits.push(path);
        if (s.fail === 'unreachable') throw new TypeError('fetch failed');
        if (s.fail === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        if (s.fail === '302') return new Response(null, { status: 302, headers: { location: 'https://elsewhere.watch.test/landing' } });
        if (typeof s.fail === 'number') return new Response('no', { status: s.fail });
        if (path === '/api/version') return Response.json({ version: s.version, commit: s.commit, buildTime: 'x', node: 'n', extra: { added: 1 } });
        if (path === '/api/community/health') return Response.json({ nodeName: 'X', version: s.version, watchdog: { present: true, recoveries: s.recoveries, healthy: true } });
        return new Response('not found', { status: 404 });
    };
    return s;
}

// The vault: /v1/health and a report signed by its ticket key (or another, or old, or saying something is failing).
async function vaultServer() {
    const ticket = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const other = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const s = {
        state: 'open', release: 'rel-1111aaaa2222bbbb', fail: null, signer: 'ticket', ageMs: 0, report: {}, hits: [], forged: null,
        pubHex: toHex(await crypto.subtle.exportKey('raw', ticket.publicKey)), ticket,
    };
    s.text = () => JSON.stringify({
        v: 1, day: '2026-10-10', at: Date.now() - s.ageMs, openSince: Date.now() - 3600_000,
        backups: { lastOkAt: Date.now() - 600_000, failuresInARow: 0, error: null },
        offsite: { lastOkAt: Date.now() - 600_000, failuresInARow: 0, error: null, reachedBucketAt: Date.now() - 600_000 },   // an added field
        alerts: { active: [], channels: ['webhook'] }, release: s.release, somethingNew: { a: 1 }, ...s.report,
    });
    s.handle = async (path) => {
        s.hits.push(path);
        if (s.fail === 'unreachable') throw new TypeError('fetch failed');
        if (path === '/v1/health') return Response.json({ state: s.state, release: s.release, since: new Date(Date.now() - 86400_000).toISOString(), added: true });
        if (path === '/v1/report') {
            const text = s.text();
            if (s.forged) return Response.json({ report: { text, signature: s.forged(text) } });
            const key = s.signer === 'ticket' ? ticket : other;
            const sig = await crypto.subtle.sign('Ed25519', key.privateKey, new TextEncoder().encode(`beanpool-vault-report/1\n${text}`));
            return Response.json({ report: { text, signature: Buffer.from(sig).toString('base64url') }, previous: null, ticketKey: s.pubHex });
        }
        return new Response('{}', { status: 404 });
    };
    return s;
}

async function room({ env = {}, ticketKey = true } = {}) {
    const vault = await vaultServer();
    const servers = { 'global.watch.test': nodeServer(), 'vault.watch.test': vault, 'mullum.watch.test': nodeServer() };
    const w = await world({ env: { ...WITH_NTFY, WATCH_TARGETS: TARGETS, ...(ticketKey ? { VAULT_TICKET_KEYS: vault.pubHex } : {}), ...env } });
    const sent = [];
    const requests = [];
    const inner = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => {
        workerdFetchInit(init);
        const url = new URL(typeof input === 'string' ? input : input.url);
        if (url.hostname === 'ntfy.test') {
            sent.push({ headers: Object.fromEntries(new Headers(init.headers).entries()), body: String(init.body ?? '') });
            return new Response('{"id":"x"}', { status: 200 });
        }
        if (url.hostname.endsWith('.watch.test')) {
            requests.push({ url: url.href, redirect: init.redirect, signal: !!init.signal });
            const s = servers[url.hostname];
            if (!s) throw new TypeError(`test network: no route to ${url.hostname}`);
            return s.handle(url.pathname);
        }
        return inner(input, init);
    };
    const realNow = Date.now;
    let t = T0;
    Date.now = () => t;
    const step = (s) => { t += s * 1000; };
    const at = (ms) => { t = ms; };
    const lines = [];
    const real = { log: console.log, warn: console.warn, error: console.error };
    for (const k of Object.keys(real)) console[k] = (...a) => { lines.push(a.map(String).join(' ')); };
    // One cron tick of the watch: 5 minutes on, then a look at everything.
    const tick = async () => { step(300); return watch.watchOurServers(w.env); };
    const admin = async (path, { method = 'GET', body, secret = 'test-admin-secret' } = {}) => {
        const res = await worker.fetch(new Request(`https://beanpool.org/api/local/admin/registrar/${path}`, {
            method, headers: secret ? { 'x-admin-secret': secret } : {}, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }), w.env);
        return { status: res.status, body: await res.json() };
    };
    const titles = () => sent.map((m) => m.headers.title);
    const done = () => {
        Object.assign(console, real);
        Date.now = realNow;
        w.restore();
        assert.deepEqual(lines.filter((l) => l.includes(SECRET)), [], 'no console line carries the topic or the token');
    };
    return { w, servers, vault, mullum: servers['mullum.watch.test'], global: servers['global.watch.test'], sent, requests, step, at, tick, admin, titles, lines, done };
}

test('down: nothing after one failed look, urgent after two, nothing more until 24 h ("still"), cleared once', async () => {
    const r = await room();
    try {
        await r.tick();
        assert.deepEqual(r.titles(), [], 'all answer: nothing said (the first look has nothing to compare a release with)');
        r.mullum.fail = 'unreachable';
        await r.tick();
        assert.deepEqual(r.titles(), [], 'one failed look is not down');
        await r.tick();
        assert.deepEqual(r.titles(), ['mullum down']);
        const m = r.sent[0];
        assert.equal(m.headers.priority, '5');
        assert.equal(m.headers.tags, 'red_circle');
        assert.equal(m.headers.click, 'https://beanpool.org/admin');
        assert.match(m.body, /^mullum \(mullum\.watch\.test\) does not answer from outside: unreachable, 2 looks in a row 5 minutes apart\. Since 2026-10-10 12:15 UTC\.$/);
        for (let i = 0; i < 5; i++) await r.tick();
        assert.equal(r.sent.length, 1, 'still down: not told again within the day');
        r.step(24 * 3600 - 5 * 300);
        await r.tick();
        assert.deepEqual(r.titles().slice(1), ['Still: mullum down']);
        assert.match(r.sent[1].body, /^Still, since 2026-10-10 12:15 UTC: mullum \(mullum\.watch\.test\) does not answer/);
        r.mullum.fail = null;
        await r.tick();
        assert.deepEqual(r.titles().slice(2), ['Resolved: mullum down']);
        assert.equal(r.sent[2].headers.priority, '2');
        assert.match(r.sent[2].body, /mullum \(mullum\.watch\.test\) answers again \(HTTP 200\)\.$/);
        await r.tick(); await r.tick();
        assert.equal(r.sent.length, 3, 'cleared once');
        // A failed look between answers says nothing.
        r.mullum.fail = 'unreachable'; await r.tick();
        r.mullum.fail = null; await r.tick();
        r.mullum.fail = 'unreachable'; await r.tick();
        r.mullum.fail = null; await r.tick();
        assert.equal(r.sent.length, 3, 'one failed look at a time is never down');
    } finally { r.done(); }
});

test('a 3xx is a failed look and its redirect is never followed; a timeout is a failed look; every look is 15 s, redirect manual', async () => {
    const r = await room();
    try {
        r.global.fail = '302';
        r.mullum.fail = 'timeout';
        await r.tick(); await r.tick();
        assert.deepEqual(r.titles(), ['global down (+1 more)'], 'raised in one tick: one message (the alert book batches what waits)');
        assert.equal(r.sent[0].headers.priority, '5');
        assert.match(r.sent[0].body, /global \(global\.watch\.test\) does not answer from outside: HTTP 302, 2 looks in a row/);
        assert.match(r.sent[0].body, /mullum \(mullum\.watch\.test\) does not answer from outside: timed out, 2 looks in a row/);
        assert.ok(!r.requests.some((q) => q.url.includes('elsewhere')), 'the redirect target was never asked');
        assert.ok(r.requests.length > 0 && r.requests.every((q) => q.redirect === 'manual' && q.signal), 'every look: redirect manual, with an abort signal');
        assert.equal(watch.WATCH_TIMEOUT_MS, 15_000);
        // A 5xx too; and /admin's servers panel shows each one's last look.
        r.global.fail = 503;
        const s = await r.admin('servers');
        assert.equal(s.status, 200);
        const g = s.body.targets.find((t) => t.name === 'global');
        assert.equal(g.last.ok, false);
        assert.equal(g.last.status, 'HTTP 302');
        assert.equal(g.day.looks, 2);
        assert.equal((await r.admin('servers', { secret: 'wrong' })).status, 401, 'the panel needs the admin secret');
    } finally { r.done(); }
});

test('the vault: a report signed by the ticket key is "fine"; another key\'s is "report unverifiable" after two looks (high), never fine', async () => {
    const r = await room();
    try {
        await r.tick();
        assert.deepEqual(r.titles(), []);
        let v = (await r.admin('servers')).body.targets.find((t) => t.name === 'vault');
        assert.equal(v.last.state, 'open');
        assert.equal(v.last.report, 'fine');
        assert.equal(v.last.version, 'rel-1111aaaa2222bbbb');
        r.vault.signer = 'other';
        await r.tick();
        v = (await r.admin('servers')).body.targets.find((t) => t.name === 'vault');
        assert.equal(v.last.report, 'unverifiable', 'a report under another key is never fine');
        assert.deepEqual(r.titles(), [], 'one look is not enough');
        await r.tick();
        assert.deepEqual(r.titles(), ['vault report']);
        assert.equal(r.sent[0].headers.priority, '4');
        assert.match(r.sent[0].body, /^vault: report unverifiable — its report is not signed by the vault's ticket key, 2 looks in a row\./);
        r.vault.signer = 'ticket';
        await r.tick();
        assert.deepEqual(r.titles().slice(1), ['Resolved: vault report']);
        assert.match(r.sent[1].body, /its report is signed by the ticket key and from now again/);
        // A garbled signature, a missing report: the same.
        r.vault.forged = () => 'not-base64url!';
        await r.tick(); await r.tick();
        assert.deepEqual(r.titles().slice(2), ['vault report']);
        assert.match(r.sent[2].body, /report unverifiable/);
    } finally { r.done(); }
});

// A signature only ZIP-215 takes (as apps/server test-names-list.ts and test-storm-smalls.ts build it): R is the
// identity point encoded with y = p + 1 (non-canonical). Strict RFC 8032 Ed25519 (zip215: false) must refuse it.
const ED_L = 2n ** 252n + 27742317777372353535851937790883648493n;
const leToBig = (b) => { let n = 0n; for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]); return n; };
const bigToLe32 = (v) => { const out = new Uint8Array(32); let n = v; for (let i = 0; i < 32; i++) { out[i] = Number(n & 0xffn); n >>= 8n; } return out; };
async function zip215OnlySignature(privateKey, pubHex, message) {
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', privateKey));
    const seed = pkcs8.slice(-32);
    const h = createHash('sha512').update(seed).digest();
    h[0] &= 248; h[31] &= 127; h[31] |= 64;
    const scalar = leToBig(h.subarray(0, 32));
    const canonicalIdentity = new Uint8Array(32); canonicalIdentity[0] = 1;
    const nonCanonicalIdentity = new Uint8Array(32).fill(0xff); nonCanonicalIdentity[0] = 0xee; nonCanonicalIdentity[31] = 0x7f;
    const k = leToBig(createHash('sha512').update(Buffer.concat([canonicalIdentity, Buffer.from(pubHex, 'hex'), Buffer.from(message)])).digest()) % ED_L;
    return Buffer.from([...nonCanonicalIdentity, ...bigToLe32((k * scalar) % ED_L)]).toString('base64url');
}

test('the vault: a ZIP-215-only signature under the ticket key is refused (strict Ed25519, zip215 false)', async () => {
    const r = await room();
    try {
        r.vault.forged = null;
        const text = r.vault.text();
        const sig = await zip215OnlySignature(r.vault.ticket.privateKey, r.vault.pubHex, `beanpool-vault-report/1\n${text}`);
        const c = await watch.checkReport({ report: { text, signature: sig } }, [r.vault.pubHex], Date.now());
        assert.equal(c.verdict, 'unverifiable');
        // The same text, properly signed, is fine: the refusal is the signature's, not the text's.
        const good = Buffer.from(await crypto.subtle.sign('Ed25519', r.vault.ticket.privateKey, new TextEncoder().encode(`beanpool-vault-report/1\n${text}`))).toString('base64url');
        assert.equal((await watch.checkReport({ report: { text, signature: good } }, [r.vault.pubHex], Date.now())).verdict, 'fine');
        // A second pinned key (a rotation, newest first) is believed too; a key that is not pinned is not.
        const other = await makeKey();
        assert.equal((await watch.checkReport({ report: { text, signature: good } }, [other.pubHex, r.vault.pubHex], Date.now())).verdict, 'fine');
        assert.equal((await watch.checkReport({ report: { text, signature: good } }, [other.pubHex], Date.now())).verdict, 'unverifiable');
    } finally { r.done(); }
});

test('the vault: an old report is "stale" (high, two looks); backups and the off-box copy failing come from its signed report at once', async () => {
    const r = await room();
    try {
        await r.tick();
        r.vault.ageMs = 3600_000;   // signed an hour ago: a replay, or its clock is wrong
        await r.tick();
        assert.deepEqual(r.titles(), []);
        await r.tick();
        assert.deepEqual(r.titles(), ['vault report']);
        assert.equal(r.sent[0].headers.priority, '4');
        assert.match(r.sent[0].body, /^vault: report stale — its signed report is from 2026-10-10 11:15 UTC, not now \(a replay, or its clock is wrong\), 2 looks in a row\./);
        r.vault.ageMs = 0;
        await r.tick();
        assert.deepEqual(r.titles().slice(1), ['Resolved: vault report']);
        // Backups: the newest three hours old. Off-box: the vault raised it itself.
        r.vault.report = { backups: { lastOkAt: Date.now() - 3 * 3600_000, failuresInARow: 4 }, openSince: Date.now() - 86400_000, alerts: { active: ['offsite'] } };
        await r.tick();
        assert.deepEqual(r.titles().slice(2), ['vault backups (+1 more)'], 'both at the first look, in one message');
        assert.equal(r.sent[2].headers.priority, '4');
        assert.match(r.sent[2].body, /its signed report says backups are failing \(4 failed in a row; the newest at 2026-10-10 \d\d:\d\d UTC\)/);
        assert.match(r.sent[2].body, /its signed report says the off-box copy is failing \(0 failed in a row; the newest at 2026-10-10 \d\d:\d\d UTC\)/);
        // Under another key, the same words are not believed: backups are not said to be fine, and stay raised.
        r.vault.signer = 'other';
        r.vault.report = {};
        await r.tick();
        assert.equal(r.sent.length, 3, 'an unverifiable report clears nothing');
        r.vault.signer = 'ticket';
        await r.tick();
        assert.deepEqual(r.titles().slice(3), ['Resolved: vault backups (+1 more)']);
        assert.match(r.sent[3].body, /backups work again[\s\S]*backups go off the box again/);
    } finally { r.done(); }
});

test('the vault: locked two looks is urgent; open again is resolved; a raised report stays raised while it is locked', async () => {
    const r = await room();
    try {
        r.vault.signer = 'other';
        await r.tick(); await r.tick();
        assert.deepEqual(r.titles(), ['vault report']);
        r.vault.state = 'locked';
        await r.tick();
        assert.deepEqual(r.titles(), ['vault report'], 'one locked look: nothing');
        assert.ok(!r.vault.hits.slice(-1).includes('/v1/report'), 'a locked vault is not asked for its report');
        await r.tick();
        assert.deepEqual(r.titles().slice(1), ['vault locked']);
        assert.equal(r.sent[1].headers.priority, '5');
        assert.match(r.sent[1].body, /answers locked, 2 looks in a row: deposits and restores wait until two custodians unlock it/);
        r.vault.signer = 'ticket';
        r.vault.state = 'open';
        await r.tick();
        assert.deepEqual(r.titles().slice(2), ['Resolved: vault locked (+1 more)']);
        assert.match(r.sent[2].body, /answers open again[\s\S]*signed by the ticket key and from now again/);
    } finally { r.done(); }
});

test('no VAULT_TICKET_KEYS: the report is "not checked", never "fine", and nothing about it is raised', async () => {
    const r = await room({ ticketKey: false });
    try {
        r.vault.signer = 'other';
        for (let i = 0; i < 3; i++) await r.tick();
        assert.deepEqual(r.titles(), []);
        const s = (await r.admin('servers')).body;
        assert.equal(s.ticket_key_set, false);
        assert.equal(s.targets.find((t) => t.name === 'vault').last.report, 'not checked');
        assert.ok(!r.vault.hits.includes('/v1/report'), 'not even asked for');
        assert.deepEqual(watch.ticketKeys({ VAULT_TICKET_KEYS: 'zz, ' + 'A'.repeat(64) + ',' + 'b'.repeat(64) + ',' + 'c'.repeat(64) }), ['a'.repeat(64), 'b'.repeat(64)], 'hex, lower-cased, two at most');
    } finally { r.done(); }
});

test('a release change is told once (default; the vault\'s high); a watchdog restart once (high)', async () => {
    const r = await room();
    try {
        await r.tick();
        r.mullum.version = '1.2.31';
        r.mullum.commit = 'bbbbbbb2222222';
        await r.tick();
        assert.deepEqual(r.titles(), ['mullum now runs 1.2.31 (bbbbbbb)']);
        assert.equal(r.sent[0].headers.priority, '3');
        assert.equal(r.sent[0].body, 'Release changed: mullum now runs 1.2.31 (bbbbbbb), was 1.2.30 (aaaaaaa).');
        await r.tick(); await r.tick();
        assert.equal(r.sent.length, 1, 'told once');
        // Same version, another commit (our nodes run main): a change too. Down and back on the same: none.
        r.global.commit = 'ccccccc3333333';
        await r.tick();
        assert.deepEqual(r.titles().slice(1), ['global now runs 1.2.30 (ccccccc)']);
        r.global.fail = 'unreachable'; await r.tick();
        r.global.fail = null; await r.tick();
        assert.equal(r.sent.length, 2, 'a failed look between two of the same release is no change');
        r.vault.release = 'rel-3333cccc4444dddd';
        await r.tick();
        assert.deepEqual(r.titles().slice(2), ['vault now runs rel-3333cccc4444dddd']);
        assert.equal(r.sent[2].headers.priority, '4');
        assert.match(r.sent[2].body, /^Release changed: vault now runs rel-3333cccc4444dddd, was rel-1111aaaa2222bbbb\. A vault release needs its custodians: check it was planned\.$/);
        r.global.recoveries = 2;
        await r.tick();
        assert.deepEqual(r.titles().slice(3), ['global restarted by its watchdog']);
        assert.equal(r.sent[3].headers.priority, '4');
        assert.match(r.sent[3].body, /\(0 → 2 recoveries\): the node hung/);
        await r.tick(); await r.tick();
        assert.equal(r.sent.length, 4, 'told once');
    } finally { r.done(); }
});

test('our nodes on different releases: nothing for a day, then told (default) and daily while it lasts; cleared when they agree', async () => {
    const r = await room();
    try {
        await r.tick();
        r.mullum.version = '1.2.31';
        await r.tick();
        assert.deepEqual(r.titles(), ['mullum now runs 1.2.31 (aaaaaaa)']);
        r.step(23 * 3600);
        await r.tick();
        assert.equal(r.sent.length, 1, 'under a day: nothing');
        r.step(3600);
        await r.tick();
        assert.deepEqual(r.titles().slice(1), ['Our nodes run different releases']);
        assert.equal(r.sent[1].headers.priority, '3');
        assert.match(r.sent[1].body, /^Our nodes run different releases, since 2026-10-10 12:10 UTC: global 1\.2\.30 \(aaaaaaa\) · mullum 1\.2\.31 \(aaaaaaa\)\./);
        assert.ok(!r.sent[1].body.includes('vault'), 'the vault is not a node');
        await r.tick();
        assert.equal(r.sent.length, 2);
        r.step(24 * 3600);
        await r.tick();
        assert.deepEqual(r.titles().slice(2), ['Still: Our nodes run different releases']);
        r.global.version = '1.2.31';
        await r.tick();
        assert.deepEqual(r.titles().slice(3).filter((t) => !t.includes('now runs')), ['Resolved: Our nodes run different releases']);
    } finally { r.done(); }
});

test('the daily line: at 08:00 Brisbane (22:00 UTC, winter and summer alike — Queensland keeps no DST), once a day, carrying what the digest held', async () => {
    const r = await room();
    try {
        // Hold the admin's own actions for the digest, and make two.
        assert.equal((await r.admin('alerts/settings', { method: 'POST', body: { category: 'admin', mode: 'digest' } })).status, 200);
        const key = await makeKey();
        assert.equal((await r.w.claim(key, { name: 'sydney', community_name: 'Sydney Commons', contact: 'ops@sydney.example' })).body.status, 'pending');
        assert.equal((await r.w.admin('sydney', 'approve')).body.status, 'live');
        assert.equal((await r.w.admin('sydney', 'pause')).body.status, 'paused');
        assert.deepEqual(r.titles(), ['Name request: sydney'], 'the names category is on; the admin\'s actions are held');
        assert.equal((await r.admin('alerts')).body.held_for_digest, 2);
        r.sent.length = 0;

        // 2026-10-10 21:55 UTC = 07:55 Brisbane (Sydney is on daylight time then; Brisbane is not): no line.
        r.at(Date.UTC(2026, 9, 10, 21, 50, 0));
        await r.tick();
        assert.deepEqual(r.titles(), []);
        await r.tick();   // 22:00 UTC = 08:00 Brisbane
        assert.deepEqual(r.titles(), ['Daily: 3 of 3 servers answer, 0 names live, 2 held']);
        const m = r.sent[0];
        assert.equal(m.headers.priority, '1', 'min: no sound');
        assert.equal(m.headers.tags, 'bar_chart');
        const body = m.body.split('\n');
        assert.equal(body[0], 'Our servers: 3 of 3 answer.');
        assert.equal(body[1], 'global 1.2.30 (aaaaaaa) · mullum 1.2.30 (aaaaaaa)');
        assert.equal(body[2], 'vault: open, release rel-1111aaaa, report fine.');
        assert.equal(body[3], '0 names live.');
        assert.equal(body[4], 'Nothing raised.');
        assert.equal(body[5], 'Held for this summary (2):');
        assert.match(body[6], /^- 2026-10-10 12:00 UTC: You approved sydney\.beanpool\.org\.$/);
        assert.match(body[7], /^- 2026-10-10 12:00 UTC: You paused sydney\.beanpool\.org\.$/);
        assert.ok(!m.body.includes('ops@sydney'), 'never the contact');
        const st = (await r.admin('alerts')).body;
        assert.equal(st.held_for_digest, 0, 'what it carried is no longer held');
        assert.deepEqual(st.recent.filter((x) => x.held).map((x) => !!x.sent_at), [true, true]);
        // Once a day: the rest of the 08:00 hour, and the day after until 08:00, nothing.
        for (let i = 0; i < 11; i++) await r.tick();
        r.at(Date.UTC(2026, 9, 11, 21, 50, 0));
        await r.tick();   // 21:55 UTC = 07:55 Brisbane
        assert.equal(r.titles().filter((t) => t.startsWith('Daily')).length, 1);
        await r.tick();   // 2026-10-11 22:00 UTC = 2026-10-12 08:00 Brisbane
        assert.deepEqual(r.titles().filter((t) => t.startsWith('Daily')), ['Daily: 3 of 3 servers answer, 0 names live, 2 held', 'Daily: 3 of 3 servers answer, 0 names live']);
        assert.ok(!r.sent.at(-1).body.includes('Held for this summary'));

        // Winter (no daylight time anywhere in Australia's east): still 22:00 UTC, never 21:00 (07:00 Brisbane).
        const dailies = async (fromUtcMs, ticks) => {
            r.at(fromUtcMs - 300_000);   // tick() steps 5 minutes, then looks
            r.sent.length = 0;
            for (let i = 0; i < ticks; i++) await r.tick();
            return r.titles().filter((t) => t.startsWith('Daily')).length;
        };
        assert.equal(await dailies(Date.UTC(2026, 6, 1, 20, 55, 0), 2), 0, '20:55 and 21:00 UTC: 06:55 and 07:00 Brisbane');
        assert.equal(await dailies(Date.UTC(2026, 6, 1, 21, 55, 0), 2), 1, '22:00 UTC: 08:00 Brisbane');
        // A day whose 08:00 hour had no tick gets no line late: 09:00 Brisbane is silent (the silence is the sign).
        assert.equal(await dailies(Date.UTC(2026, 6, 2, 23, 0, 0), 3), 0, '09:00 Brisbane, the 08:00 hour missed');
        assert.equal(watch.brisbaneDay(Date.UTC(2026, 6, 1, 22, 0, 0) / 1000), '2026-07-02');
        assert.equal(watch.brisbaneDay(Date.UTC(2026, 6, 1, 13, 59, 0) / 1000), '2026-07-01');
    } finally { r.done(); }
});

test('the daily line says what is down, what is raised, and that the vault report is not checked with no key', async () => {
    const r = await room({ ticketKey: false });
    try {
        r.at(Date.UTC(2026, 9, 10, 21, 45, 0));
        r.mullum.fail = 503;
        await r.tick(); await r.tick();   // 21:55 UTC: mullum down raised
        assert.deepEqual(r.titles(), ['mullum down']);
        await r.tick();   // 22:00 UTC
        const m = r.sent.at(-1);
        assert.equal(m.headers.title, 'Daily: 2 of 3 servers answer, 0 names live');
        assert.match(m.body, /^Our servers: 2 of 3 answer\.\nglobal 1\.2\.30 \(aaaaaaa\) · mullum down \(HTTP 503\)\nvault: open, release rel-1111aaaa, report not checked \(VAULT_TICKET_KEYS is not set\)\.\n0 names live\.\nRaised now \(1\): mullum \(mullum\.watch\.test\) does not answer from outside: HTTP 503, \d looks in a row 5 minutes apart\.$/);
    } finally { r.done(); }
});

// Two cron entries (wrangler.toml), each its own invocation: Cloudflare lets one invocation have 6 connections waiting
// for headers (a 7th is queued, and its 15 s runs out in the queue), so servers that hang must never sit in the sweep's.
test('each cron runs only its own job: the sweep on */5, the watch on 2-57/5; a database without 0009 leaves the sweep untouched', async () => {
    const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
    assert.match(toml, /^crons = \["\*\/5 \* \* \* \*", "2-57\/5 \* \* \* \*"\]$/m, 'wrangler.toml has the two entries scheduled() knows');
    const r = await room();
    const sweeps = () => r.w.sqlite.prepare('SELECT COUNT(*) AS n FROM sweep_log').get().n;
    const looks = () => r.w.sqlite.prepare('SELECT COUNT(*) AS n FROM watch_log').get().n;
    try {
        let later = [];
        await worker.scheduled({ cron: '*/5 * * * *' }, r.w.env, { waitUntil: (p) => later.push(p) });
        const swept = await later[0];
        await Promise.all(later);
        assert.equal(swept.action, 'applied', 'the sweep ran');
        assert.equal(sweeps(), 1);
        assert.equal(r.requests.length, 0, "the sweep's invocation looks at none of our servers");
        assert.equal(looks(), 0);
        later = [];
        await worker.scheduled({ cron: '2-57/5 * * * *' }, r.w.env, { waitUntil: (p) => later.push(p) });
        const watched = await later[0];
        await Promise.all(later);
        assert.deepEqual(watched.map((x) => [x.name, x.ok]), [['global', true], ['vault', true], ['mullum', true]]);
        assert.equal(looks(), 3);
        assert.equal(sweeps(), 1, "the watch's invocation runs no sweep");
    } finally { r.done(); }

    const BEFORE_0009 = ['0001_init.sql', '0002_states.sql', '0003_decision_seq.sql', '0004_teardown.sql', '0005_reserve_global.sql', '0006_request_nonces.sql', '0007_content_swap.sql', '0008_alerts.sql'];
    const w = await world({ migrations: BEFORE_0009, env: { WATCH_TARGETS: TARGETS } });
    const inner = globalThis.fetch;
    globalThis.fetch = async (input, init) => (new URL(typeof input === 'string' ? input : input.url).hostname.endsWith('.watch.test')
        ? Response.json({ version: '1', state: 'open' }) : inner(input, init));
    const lines = [];
    const real = console.error;
    console.error = (...a) => lines.push(a.map(String).join(' '));
    try {
        let later = [];
        await worker.scheduled({ cron: '*/5 * * * *' }, w.env, { waitUntil: (p) => later.push(p) });
        assert.equal((await later[0]).action, 'applied', 'the sweep ran');
        await Promise.all(later);
        later = [];
        await worker.scheduled({ cron: '2-57/5 * * * *' }, w.env, { waitUntil: (p) => later.push(p) });
        assert.ok(Array.isArray(await later[0]), 'the watch ended without throwing');
        await Promise.all(later);
        assert.ok(lines.some((l) => l.startsWith('[WATCH]') && l.includes('no such table')), 'and logged why');
        const k = await makeKey();
        assert.equal((await w.claim(k, { name: 'yarrabank' })).body.status, 'live', 'claims still work');
    } finally { console.error = real; w.restore(); }
});

test('the watch looks at 3 servers at a time at most: never more than 6 connections waiting at once', async () => {
    const FIVE = JSON.stringify(['global', 'vault', 'mullum', 'castlemaine', 'test'].map((n) => ({ name: n, url: `https://${n}.watch.test`, ...(n === 'vault' ? { kind: 'vault' } : {}) })));
    const r = await room({ env: { WATCH_TARGETS: FIVE } });
    r.servers['castlemaine.watch.test'] = nodeServer();
    r.servers['test.watch.test'] = nodeServer();
    // Every look waits for its headers until let go: one at a time, oldest first.
    const waiting = [];
    let peak = 0, peakServers = 0;
    for (const [host, s] of Object.entries(r.servers)) {
        const handle = s.handle;
        s.handle = async (path) => {
            await new Promise((go) => waiting.push({ host, go }));
            return handle(path);
        };
    }
    try {
        let done = false;
        const p = r.tick().then((x) => { done = true; return x; });
        while (!done) {
            for (let i = 0; i < 5; i++) await new Promise((res) => setTimeout(res, 2));
            peak = Math.max(peak, waiting.length);
            peakServers = Math.max(peakServers, new Set(waiting.map((x) => x.host)).size);
            waiting.shift()?.go();
        }
        const seen = await p;
        assert.deepEqual(seen.map((x) => [x.name, x.ok]), [['global', true], ['vault', true], ['mullum', true], ['castlemaine', true], ['test', true]]);
        assert.ok(peak <= 6, `at most 6 connections waiting at once (was ${peak})`);
        assert.equal(peakServers, 3, 'three servers at a time');
    } finally { r.done(); }
});

test('migration 0009: two tables; re-running changes nothing; WATCH_TARGETS skips what is not a name and an http(s) address', async () => {
    const BEFORE = ['0001_init.sql', '0002_states.sql', '0003_decision_seq.sql', '0004_teardown.sql', '0005_reserve_global.sql', '0006_request_nonces.sql', '0007_content_swap.sql', '0008_alerts.sql'];
    const w = await world({ migrations: BEFORE });
    try {
        w.sqlite.exec(migration('0009_watch.sql'));
        w.sqlite.exec("INSERT INTO watch_log (ran_at, target, ok, status) VALUES (1, 'global', 1, 'HTTP 200')");
        w.sqlite.exec("INSERT INTO watch_marks (key, value) VALUES ('daily', '2026-10-10')");
        const dump = () => JSON.stringify(['watch_log', 'watch_marks'].map((t) => w.sqlite.prepare(`SELECT * FROM ${t}`).all()));
        const schema = () => JSON.stringify(w.sqlite.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all());
        const [before, shape] = [dump(), schema()];
        w.sqlite.exec(migration('0009_watch.sql'));
        assert.equal(dump(), before);
        assert.equal(schema(), shape);
        // A target's newest looks and the 30-day prune read by their indexes.
        const plan = (q, ...a) => w.sqlite.prepare(`EXPLAIN QUERY PLAN ${q}`).all(...a).map((x) => x.detail).join(' | ');
        assert.match(plan('SELECT * FROM watch_log WHERE target=? ORDER BY id DESC LIMIT 2', 'g'), /idx_watch_log_target/);
        assert.match(plan('DELETE FROM watch_log WHERE ran_at < ?', 1), /idx_watch_log_ran/);
    } finally { w.restore(); }
    const lines = [];
    const real = console.error;
    console.error = (...a) => lines.push(a.map(String).join(' '));
    try {
        const got = watch.watchTargets({ WATCH_TARGETS: JSON.stringify([
            { name: 'ok-one', url: 'https://a.example/' }, { name: 'Bad Name', url: 'https://b.example' }, { name: 'ftp', url: 'ftp://c.example' },
            { name: 'ok-one', url: 'https://dup.example' }, { name: 'v', url: 'http://127.0.0.1:8796', kind: 'vault' },
        ]) });
        assert.deepEqual(got, [{ name: 'ok-one', url: 'https://a.example', kind: 'node' }, { name: 'v', url: 'http://127.0.0.1:8796', kind: 'vault' }]);
        assert.equal(lines.length, 3);
        assert.deepEqual(watch.watchTargets({ WATCH_TARGETS: 'not json' }), []);
        assert.deepEqual(watch.watchTargets({}), []);
    } finally { console.error = real; }
});

// The served page's "Our servers" panel against a stub DOM, as alerts.test.js runs it.
test('/admin "Our servers": a row per server, what it answers and runs, escaped; says when the vault report is not checked', async () => {
    const w = await world();
    try {
        const html = await (await worker.fetch(new Request('https://beanpool.org/admin'), w.env)).text();
        assert.match(html, /🛰️ Our servers/);
        const script = html.split('<script>')[1].split('</script>')[0];
        const els = {};
        const ctx = {
            console, location: { hash: '' },
            document: {
                getElementById: (id) => (els[id] ??= { id, innerHTML: '', value: '', textContent: '', className: '', style: {}, addEventListener() {}, scrollIntoView() {} }),
                addEventListener() {}, querySelector: () => null,
            },
            sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
            confirm: () => true, alert() {}, fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
        };
        vm.createContext(ctx);
        vm.runInContext(script, ctx);
        ctx.renderServers({ targets: [] });
        assert.match(els.serversContainer.innerHTML, /Nothing is watched: WATCH_TARGETS is not set/);
        ctx.renderServers({
            ticket_key_set: false, fleet_differs_since: 1_791_000_000, daily_sent_for: '2026-10-11',
            targets: [
                { name: 'global', url: 'https://global.beanpool.org', kind: 'node', last_ok_at: 1, day: { looks: 288, ok: 287 },
                    last: { ran_at: 1, ok: true, ms: 120, status: 'HTTP 200', version: '1.2.31<script>', commit: 'abcdef0123', recoveries: 2 } },
                { name: 'vault', url: 'https://vault.beanpool.org', kind: 'vault', last_ok_at: 1, day: { looks: 2, ok: 0 },
                    last: { ran_at: 2, ok: false, ms: 15000, status: 'timed out' } },
            ],
        });
        const h = els.serversContainer.innerHTML;
        assert.match(h, /The vault report is not checked: VAULT_TICKET_KEYS/);
        assert.match(h, /Our nodes run different releases, since/);
        assert.match(h, /<tr id="server-global">/);
        assert.match(h, /answers \(HTTP 200, 120 ms\)/);
        assert.match(h, /1\.2\.31&lt;script&gt;/, 'what a server says is escaped');
        assert.match(h, /\(abcdef0\)/);
        assert.match(h, /watchdog restarts: 2/);
        assert.match(h, /does not answer: timed out/);
        assert.match(h, /287 of 288 looks answered/);
        assert.match(h, /Last daily summary: 2026-10-11/);
    } finally { w.restore(); }
});
