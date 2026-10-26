/* global process, Buffer -- a Node script */
// Tests for scripts/bootstrap-community-eggs.mjs against a stand-in node on localhost (nothing else is contacted).
// Run by test-all.sh (the `token_scripts` check): node --test scripts/bootstrap-community-eggs.test.mjs
//
// The treasury list decides whether to create one. An answer that is not OK (a rate limit, a restart, a refused
// credential) is not "no Community Eggs yet": the script stops with the node's words and creates nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bootstrap-community-eggs.mjs');
const TOKEN = `bp_${'a'.repeat(12)}_${'b'.repeat(64)}`;

// The eggs Offer's photo (EGGS_PHOTO): the node refuses a new Offer with none. A 1×1 PNG, written to a file once.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';
const FIXTURES = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-eggs-test-'));
const EGGS_PHOTO = path.join(FIXTURES, 'eggs.png');
fs.writeFileSync(EGGS_PHOTO, Buffer.from(PNG_BASE64, 'base64'));
const NOT_A_PICTURE = path.join(FIXTURES, 'eggs.txt');
fs.writeFileSync(NOT_A_PICTURE, 'a dozen eggs');
process.on('exit', () => fs.rmSync(FIXTURES, { recursive: true, force: true }));

/** A node that answers GET /api/local/admin/treasury with `listAnswer` and records every request (and each body, by route). */
async function standIn(listAnswer) {
    const requests = [];
    const bodies = {};
    const server = http.createServer((req, res) => {
        requests.push(`${req.method} ${req.url}`);
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            if (body) bodies[req.url] = JSON.parse(body);
            if (req.method === 'GET' && req.url === '/api/local/admin/treasury') {
                const [status, answer] = listAnswer;
                return res.writeHead(status, { 'Content-Type': 'application/json' }).end(answer);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true, publicKey: 'ab'.repeat(32) }));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${server.address().port}`, requests, bodies, close: () => new Promise((resolve) => server.close(resolve)) };
}

function runScript(nodeUrl, extraEnv = {}) {
    const env = { ...process.env, NODE_URL: nodeUrl, BEANPOOL_TOKEN: TOKEN, ...extraEnv };
    delete env.ADMIN_PASSWORD;
    if (!('EGGS_PHOTO' in extraEnv)) delete env.EGGS_PHOTO;
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
        const { code, out } = await runScript(node.url, { EGGS_PHOTO });
        assert.equal(code, 0, out);
        assert.equal(node.requests[1], 'POST /api/local/admin/treasury', out);
        assert.ok(node.requests[2]?.endsWith('/offer'), out);
        // The Offer carries EGGS_PHOTO as a data URL: the node refuses a new Offer with no photo.
        const offer = node.bodies[node.requests[2].split(' ')[1]];
        assert.deepEqual(offer?.photos, [`data:image/png;base64,${PNG_BASE64}`], out);
    } finally {
        await node.close();
    }
});

test('with no EGGS_PHOTO it still creates the treasury, then posts no offer and says a photo is needed', async () => {
    const node = await standIn([200, JSON.stringify({ treasuries: [] })]);
    try {
        const { code, out } = await runScript(node.url);
        assert.notEqual(code, 0, out);
        assert.deepEqual(node.requests, ['GET /api/local/admin/treasury', 'POST /api/local/admin/treasury'], `no offer was sent: ${out}`);
        assert.ok(out.includes('every Offer in the Market needs a photo'), out);
        assert.ok(out.includes('EGGS_PHOTO'), out);
        assert.ok(!out.includes(TOKEN), 'the token is never printed');
    } finally {
        await node.close();
    }
});

test('an EGGS_PHOTO that is not a picture, or cannot be read, stops before any request', async () => {
    const node = await standIn([200, JSON.stringify({ treasuries: [] })]);
    try {
        for (const [photo, words] of [[NOT_A_PICTURE, 'is not a JPEG, PNG or WebP picture'], [path.join(FIXTURES, 'missing.jpg'), 'Could not read EGGS_PHOTO']]) {
            const { code, out } = await runScript(node.url, { EGGS_PHOTO: photo });
            assert.notEqual(code, 0, out);
            assert.ok(out.includes(words), out);
        }
        assert.deepEqual(node.requests, [], 'nothing was asked');
    } finally {
        await node.close();
    }
});

test('a bp_ value that is not the whole token, or one with a line break in it, is refused before any request', async () => {
    const node = await standIn([200, JSON.stringify({ treasuries: [] })]);
    try {
        for (const bad of ['bp_short', `${TOKEN.slice(0, 40)}\n${TOKEN.slice(40)}`]) {
            const env = { ...process.env, NODE_URL: node.url, BEANPOOL_TOKEN: bad };
            const { code, out } = await new Promise((resolve) => execFile(process.execPath, [SCRIPT], { env, timeout: 20_000 },
                (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: `${stdout}${stderr}` })));
            assert.notEqual(code, 0, out);
            assert.ok(out.includes('BEANPOOL_TOKEN is not an automation token'), out);
            assert.ok(!out.includes(TOKEN.slice(40)), 'the value is not repeated');
        }
        assert.deepEqual(node.requests, [], 'nothing was asked');
    } finally {
        await node.close();
    }
});
