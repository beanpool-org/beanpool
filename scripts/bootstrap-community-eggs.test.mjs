/* global process -- a Node script */
// Tests for scripts/bootstrap-community-eggs.mjs against a stand-in node on localhost (nothing else is contacted).
// Run by test-all.sh (the `token_scripts` check): node --test scripts/bootstrap-community-eggs.test.mjs
//
// The treasury list decides whether to create one. An answer that is not OK (a rate limit, a restart, a refused
// credential) is not "no Community Eggs yet": the script stops with the node's words and creates nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bootstrap-community-eggs.mjs');
const TOKEN = `bp_${'a'.repeat(12)}_${'b'.repeat(64)}`;

/** A node that answers GET /api/local/admin/treasury with `listAnswer` and records every request. */
async function standIn(listAnswer) {
    const requests = [];
    const server = http.createServer((req, res) => {
        requests.push(`${req.method} ${req.url}`);
        if (req.method === 'GET' && req.url === '/api/local/admin/treasury') {
            const [status, body] = listAnswer;
            return res.writeHead(status, { 'Content-Type': 'application/json' }).end(body);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true, publicKey: 'ab'.repeat(32) }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

function runScript(nodeUrl) {
    const env = { ...process.env, NODE_URL: nodeUrl, BEANPOOL_TOKEN: TOKEN };
    delete env.ADMIN_PASSWORD;
    return new Promise((resolve) => {
        execFile(process.execPath, [SCRIPT], { env, timeout: 20_000 },
            (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: `${stdout}${stderr}` }));
    });
}

for (const [label, answer] of [
    ['429', [429, JSON.stringify({ error: 'Too many requests, slow down' })]],
    ['503', [503, JSON.stringify({ error: 'Node is restarting' })]],
    ['401', [401, JSON.stringify({ error: 'Unauthorized' })]],
    ['403', [403, JSON.stringify({ error: 'This token cannot reach this route' })]],
]) {
    test(`a ${label} on the treasury list stops with the node's words and creates nothing`, async () => {
        const node = await standIn(answer);
        try {
            const { code, out } = await runScript(node.url);
            assert.notEqual(code, 0, out);
            assert.deepEqual(node.requests, ['GET /api/local/admin/treasury'], `only the list was asked: ${out}`);
            assert.ok(out.includes(`HTTP ${label}`), out);
            assert.ok(out.includes(JSON.parse(answer[1]).error), `the node's words: ${out}`);
            assert.ok(!out.includes(TOKEN), 'the token is never printed');
        } finally {
            await node.close();
        }
    });
}

test('a node that cannot be reached stops and creates nothing', async () => {
    const node = await standIn([200, '{}']);
    const url = node.url;
    await node.close();
    const { code, out } = await runScript(url);
    assert.notEqual(code, 0, out);
    assert.ok(!out.includes(TOKEN), 'the token is never printed');
});

test('an OK list with no Community Eggs still creates one and posts its offer', async () => {
    const node = await standIn([200, JSON.stringify({ treasuries: [] })]);
    try {
        const { code, out } = await runScript(node.url);
        assert.equal(code, 0, out);
        assert.equal(node.requests[1], 'POST /api/local/admin/treasury', out);
        assert.ok(node.requests[2]?.endsWith('/offer'), out);
    } finally {
        await node.close();
    }
});
