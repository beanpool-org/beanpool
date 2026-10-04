/* global process -- a Node script */
// The owner scripts never follow a redirect with a credential (#1571 review). fetch follows one by default, and to another
// origin it drops Authorization but keeps X-Admin-Password, so the node's admin password went wherever the node, or a
// proxy in front of it, pointed; that origin's answer was then read as the node's. Each script below runs against a
// stand-in A on localhost that answers with a 302 to B, another localhost port (another origin): the script stops with a
// plain message, B gets nothing, and no credential is printed. Nothing else is contacted.
// Run by test-all.sh (the `token_scripts` check): node --test scripts/credential-redirects.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fetchNoRedirect } from './automation-token.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = `bp_${'a'.repeat(12)}_${'b'.repeat(64)}`;
const PASSWORD = 'redirect-test-admin-pw-41c7';
const REPLICATION = 'redirect-test-replication-9f3e';
const EGGS = '1'.repeat(64);
const ALICE = 'a1'.repeat(32);
const ENROLL = { communityId: 'c1', genesis: { communityId: 'c1' }, primaryPeerId: '12D3KooWStandIn', primaryUrl: 'http://localhost' };

/** B: another origin. Records every request and whether a credential came with it; answers as a node would. */
async function otherOrigin() {
    const seen = [];
    const server = http.createServer((req, res) => {
        seen.push({ request: `${req.method} ${req.url}`, credential: Boolean(req.headers['x-admin-password'] || req.headers.authorization) });
        const p = req.url.split('?')[0];
        const body = p === '/api/local/admin/treasury' ? { treasuries: [] } : p === '/api/local/admin/backup-enroll' ? ENROLL : { success: true, publicKey: 'cd'.repeat(32), members: [] };
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** A: the node. Each path in `answers` gets its [status, body]; every other request a 302 to the same path on `to`. */
async function redirectingNode(to, answers = {}) {
    const seen = [];
    const server = http.createServer((req, res) => {
        const answer = answers[req.url.split('?')[0]];
        seen.push({ request: `${req.method} ${req.url}`, redirected: !answer });
        if (answer) return res.writeHead(answer[0], { 'Content-Type': 'application/json' }).end(JSON.stringify(answer[1]));
        res.writeHead(302, { Location: `${to}${req.url}` }).end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

function run(script, args, envExtra, cwd) {
    const env = { ...process.env, ...envExtra };
    for (const name of ['BEANPOOL_TOKEN', 'ADMIN_PASSWORD', 'BACKUP_REPLICATION_TOKEN', 'NODE_URL']) if (!(name in envExtra)) delete env[name];
    return new Promise((resolve) => {
        execFile(process.execPath, [path.join(DIR, script), ...args], { env, cwd, timeout: 20_000 },
            (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: `${stdout}${stderr}` }));
    });
}

const CREDENTIALS = [['a token', { BEANPOOL_TOKEN: TOKEN }], ['the admin password', { ADMIN_PASSWORD: PASSWORD }]];

const CASES = [
    ...CREDENTIALS.map(([label, env]) => ({
        name: `bootstrap-community-eggs with ${label}: the treasury list`,
        script: 'bootstrap-community-eggs.mjs', args: () => [], env: (a) => ({ ...env, NODE_URL: a }),
    })),
    ...CREDENTIALS.map(([label, env]) => ({
        name: `grant-operator with ${label}: the name lookup`,
        script: 'grant-operator.mjs', args: () => ['Community Eggs', ALICE], env: (a) => ({ ...env, NODE_URL: a }),
    })),
    ...CREDENTIALS.map(([label, env]) => ({
        name: `grant-operator with ${label}: the grant itself (keys given, no lookup)`,
        script: 'grant-operator.mjs', args: () => [EGGS, ALICE], env: (a) => ({ ...env, NODE_URL: a }),
    })),
    {
        name: 'setup-backup with a token: the enrolment bundle',
        script: 'setup-backup.mjs', args: (a, root) => ['--primary', a, '--data-dir', path.join(root, 'data')],
        env: () => ({ BEANPOOL_TOKEN: TOKEN, BACKUP_REPLICATION_TOKEN: REPLICATION }),
    },
    {
        name: 'setup-backup with the admin password: the enrolment bundle',
        script: 'setup-backup.mjs', args: (a, root) => ['--primary', a, '--data-dir', path.join(root, 'data')],
        env: () => ({ ADMIN_PASSWORD: PASSWORD }),
    },
    {
        name: 'setup-backup with the admin password: making the replication token',
        script: 'setup-backup.mjs', args: (a, root) => ['--primary', a, '--data-dir', path.join(root, 'data')],
        env: () => ({ ADMIN_PASSWORD: PASSWORD }), answers: { '/api/local/admin/backup-enroll': [200, ENROLL] },
    },
];

for (const c of CASES) {
    test(`${c.name}: a 302 to another origin is not followed`, async () => {
        const b = await otherOrigin();
        const a = await redirectingNode(b.url, c.answers);
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-redirect-test-'));
        try {
            const { code, out } = await run(c.script, c.args(a.url, root), c.env(a.url), root);
            assert.notEqual(code, 0, out);
            assert.deepEqual(b.seen, [], `the other origin got nothing: ${JSON.stringify(b.seen)}\n${out}`);
            assert.match(out, /redirect/i, out);
            assert.ok(out.includes(b.url), `it names where the redirect pointed: ${out}`);
            assert.ok(!out.includes(TOKEN) && !out.includes(PASSWORD) && !out.includes(REPLICATION), `no credential is printed: ${out}`);
            // The first redirect ends it: nothing more is sent to the node either (no create or grant after a redirected read).
            assert.equal(a.seen.filter((r) => r.redirected).length, 1, `one request redirected: ${JSON.stringify(a.seen)}`);
            assert.ok(a.seen.at(-1).redirected, `and nothing sent after it: ${JSON.stringify(a.seen)}`);
            assert.ok(!fs.existsSync(path.join(root, '.env')), 'setup-backup wrote no .env');
        } finally {
            await a.close();
            await b.close();
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
}

// The helper itself (fed.mjs's requests use it too; they go only to localhost forwards, so are not run here).
test('fetchNoRedirect: a 3xx throws a plain error naming where it pointed, and nothing reaches there', async () => {
    const b = await otherOrigin();
    const a = await redirectingNode(b.url, { '/ok': [200, { fine: true }] });
    try {
        const ok = await fetchNoRedirect(`${a.url}/ok`, { headers: { 'X-Admin-Password': PASSWORD } });
        assert.equal(ok.status, 200);
        assert.deepEqual(await ok.json(), { fine: true });
        await assert.rejects(fetchNoRedirect(`${a.url}/moved?x=1`, { headers: { 'X-Admin-Password': PASSWORD } }), (e) => {
            assert.ok(e.message.includes('HTTP 302') && e.message.includes(b.url) && !e.message.includes(PASSWORD), e.message);
            assert.equal(e.redirect, true);
            return true;
        });
        assert.deepEqual(b.seen, []);
    } finally {
        await a.close();
        await b.close();
    }
});

// A same-origin redirect (#1575 review): the message named the same origin, so the operator wasn't told what to change.
test('fetchNoRedirect: a same-origin path redirect names the address it points to and says to use that exact address', async () => {
    const seen = [];
    const server = http.createServer((req, res) => {
        seen.push(`${req.method} ${req.url}`);
        res.writeHead(308, { Location: '/beanpool/api/local/admin/status?k=v' }).end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const a = `http://127.0.0.1:${server.address().port}`;
    try {
        await assert.rejects(fetchNoRedirect(`${a}/api/local/admin/status?x=1`, { headers: { 'X-Admin-Password': PASSWORD } }), (e) => {
            assert.ok(e.message.includes(`redirected this path to ${a}/beanpool/api/local/admin/status.`), e.message);
            assert.match(e.message, /exact address/, e.message);
            assert.ok(!e.message.includes(PASSWORD) && !e.message.includes('k=v') && !e.message.includes('x=1'), e.message);
            assert.equal(e.redirect, true);
            return true;
        });
        assert.deepEqual(seen, ['GET /api/local/admin/status?x=1'], 'one request, nothing followed');
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('fetchNoRedirect: an http to https redirect says to use the https address', async () => {
    const server = http.createServer((req, res) => res.writeHead(301, { Location: `https://127.0.0.1:${server.address().port}${req.url}` }).end());
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
        await assert.rejects(fetchNoRedirect(`http://127.0.0.1:${port}/api/local/admin/status`, { headers: { 'X-Admin-Password': PASSWORD } }), (e) => {
            assert.ok(e.message.includes(`Use https://127.0.0.1:${port}:`) && /plain http/.test(e.message) && !e.message.includes(PASSWORD), e.message);
            return true;
        });
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});
