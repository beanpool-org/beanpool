// No registrar test reaches the network (test/harness.js, its fetch trap). Before it nothing stopped a fetch no fake
// served from going out for real, between worlds and in the five files that never loaded the harness (none did, measured
// 18 Oct with a preload that refused the process's real fetch), and inside a world such a fetch threw a plain error the
// Worker caught: src/access.js turns a failed certs fetch into a 401, src/alerts.js a failed send into a retry, so a test
// expecting either could pass on a host nothing served — five did, sending their alerts to ntfy.example and ntfy.invalid.
// Here: what the trap refuses, that a test which reached for the network fails even when the code under test caught the
// refusal, that one after a file's last test fails the file, and that every file of the run loads the trap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NETWORK_ALLOWLIST, networkRefused, noNetwork, world, unreachable } from './harness.js';

const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
// A token src/access.js reads far enough to ask the team for its keys: an RS256 header with a kid, a claims object.
const TOKEN = `${enc({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${enc({ email: 'a@example.org' })}.${'A'.repeat(342)}`;
const ACCESS = (team) => ({ ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: 'aud-1', ADMIN_EMAILS: 'a@example.org' });

test('the trap: every fetch no fake serves is refused (a TypeError) and kept; a world still answers its own hosts; the allowlist is empty', async () => {
    assert.deepEqual(NETWORK_ALLOWLIST, [], 'no host is let through to the real network');
    assert.equal(globalThis.fetch, noNetwork, 'outside a world the process\'s fetch is the trap');
    for (const input of ['https://example.org/a', new URL('https://example.org/b'), new Request('https://example.org/c', { method: 'POST' })])
        await assert.rejects(fetch(input), (e) => e instanceof TypeError && /is served by no fake/.test(e.message));
    const w = await world({ env: ACCESS('t-trap.cloudflareaccess.com'), serve: { 'ntfy.down': unreachable } });
    try {
        await assert.rejects(fetch('https://t-trap.cloudflareaccess.com/cdn-cgi/access/certs'), /is served by no fake/);
        await assert.rejects(fetch('https://ntfy.elsewhere/topic', { method: 'POST' }), /is served by no fake/);
        // What the world serves is not the network: its Cloudflare, a host it was given, its nodes (here none: down).
        assert.equal((await fetch('https://api.cloudflare.com/client/v4/zones/zone/dns_records?name=x.beanpool.org')).status, 200);
        await assert.rejects(fetch('https://ntfy.down/topic'), (e) => e instanceof TypeError && e.message === 'fetch failed');
        await assert.rejects(fetch('https://nobody.beanpool.org/api/attest?nonce=1'), /^Error: test network: no route to/);
    } finally { w.restore(); }
    assert.equal(globalThis.fetch, noNetwork, 'a world puts the trap back');
    // Kept, in order — taken here so this test's own end doesn't fail it.
    assert.deepEqual(networkRefused.splice(0), [
        'https://example.org/a', 'https://example.org/b', 'https://example.org/c',
        'https://t-trap.cloudflareaccess.com/cdn-cgi/access/certs', 'https://ntfy.elsewhere/topic',
    ]);
});

// `body` as a test file of its own, run by its own `node --test`; its TAP and its exit code.
function runFile(body) {
    const dir = mkdtempSync(join(tmpdir(), 'registrar-no-network-'));
    try {
        const file = join(dir, 'fixture.test.mjs');
        writeFileSync(file, `import test from 'node:test';\nimport assert from 'node:assert/strict';\n` +
            `import worker from ${JSON.stringify(new URL('../src/index.js', import.meta.url).href)};\n` +
            `import { world } from ${JSON.stringify(new URL('./harness.js', import.meta.url).href)};\n${body}`);
        const env = { ...process.env };
        delete env.NODE_TEST_CONTEXT;   // this process is a test runner's child: the fixture's runner must report as a parent
        const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { env, encoding: 'utf8', timeout: 60_000 });
        const result = (name) => new RegExp(`^(not ok|ok) \\d+ - ${name}$`, 'm').exec(r.stdout)?.[1] ?? 'missing';
        return { status: r.status, out: r.stdout + r.stderr, result };
    } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('a test that reached for the network fails even when the code under test caught the refusal — the Worker under Access with no certs fake answers 401, as expected, and its test still fails', async () => {
    const r = runFile(`
test('swallowed', async () => { try { await fetch('https://example.org/'); } catch { /* caught, as the Worker catches */ } });
test('certs with no fake', async () => {
    const w = await world({ env: ${JSON.stringify(ACCESS('t-nofake.cloudflareaccess.com'))} });
    try {
        const res = await worker.fetch(new Request('https://beanpool.org/api/local/admin/registrar/whoami', { headers: { 'cf-access-jwt-assertion': ${JSON.stringify(TOKEN)} } }), w.env);
        assert.equal(res.status, 401);
        console.log('[FIXTURE] the Worker answered 401');
    } finally { w.restore(); }
});
test('clean', async () => {
    const w = await world();
    try { assert.equal((await worker.fetch(new Request('https://beanpool.org/api/registrar/health'), w.env)).status, 200); } finally { w.restore(); }
});
`);
    assert.deepEqual(['swallowed', 'certs with no fake', 'clean'].map(r.result), ['not ok', 'not ok', 'ok'], r.out);
    assert.match(r.out, /\[FIXTURE\] the Worker answered 401/, 'its own assertion passed: only the trap failed it');
    assert.match(r.out, /this test reached for the network, served by no fake: https:\/\/example\.org\//);
    assert.match(r.out, /this test reached for the network, served by no fake: https:\/\/t-nofake\.cloudflareaccess\.com\/cdn-cgi\/access\/certs/);
    assert.notEqual(r.status, 0);
});

test('a fetch after a file\'s last test fails the file', async () => {
    const r = runFile(`test('passes, then fetches once it has ended', () => { setTimeout(() => { fetch('https://late.example/x').catch(() => {}); }, 20); });\n`);
    assert.equal(r.result('passes, then fetches once it has ended'), 'ok', r.out);
    assert.match(r.out, /\[TEST_NETWORK\] reached for the network after the file's last test, served by no fake: https:\/\/late\.example\/x/);
    assert.notEqual(r.status, 0, 'the run fails');
    // And a file that never reaches for it passes: the trap alone fails nothing.
    const clean = runFile(`test('nothing fetched', () => {});\n`);
    assert.equal(clean.status, 0, clean.out);
});

test('every file of the registrar test run loads the harness, so the trap', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const files = pkg.scripts.test.split(/\s+/).filter((a) => a.startsWith('test/'));
    assert.ok(files.length >= 17 && files.includes('test/no-network.test.js'), pkg.scripts.test);
    for (const f of files) {
        const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
        assert.match(src, /^import\b[^;]*'\.\/harness\.js';/m, `${f} does not load test/harness.js`);
    }
});
