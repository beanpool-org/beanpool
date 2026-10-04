/* global process -- a Node script */
// Tests for scripts/grant-operator.mjs against a stand-in node on localhost (nothing else is contacted).
// Run by test-all.sh (the `token_scripts` check): node --test scripts/grant-operator.test.mjs
//
// <treasury> <callsign-or-pubkey>: the names are looked up on the admin reads the token opens (the treasury list and
// the manager's member list). The members-only reads the script used to ask unsigned are refused on a node with read
// auth on (the default), and the name was then sent as if it were a key. A name that matches nothing, or more than one,
// stops with a plain message and grants nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'grant-operator.mjs');
const TOKEN = `bp_${'a'.repeat(12)}_${'b'.repeat(64)}`;
const EGGS = '1'.repeat(64);
const ALICE = 'a1'.repeat(32);
const BOB1 = 'b1'.repeat(32);
const BOB2 = 'b2'.repeat(32);

/** A node: members-only reads refused unsigned, as with read auth on; the admin reads answer the token only. */
async function standIn({ treasuryList = [200, { treasuries: [{ name: 'Community Eggs', publicKey: EGGS, callsign: null }] }] } = {}) {
    const requests = [];
    const grants = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            requests.push(`${req.method} ${req.url}`);
            const send = (status, json) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(json));
            const p = req.url.split('?')[0];
            if (p === '/api/community/members' || p === '/api/treasuries') return send(401, { error: 'Missing cryptographic signature headers' });
            if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'Unauthorized' });
            if (req.method === 'GET' && p === '/api/local/admin/treasury') return send(treasuryList[0], treasuryList[1]);
            if (req.method === 'POST' && p === '/api/local/admin/data') {
                return send(200, { members: [
                    { publicKey: ALICE, callsign: 'alice' }, { publicKey: BOB1, callsign: 'bob' }, { publicKey: BOB2, callsign: 'Bob' },
                ] });
            }
            const m = /^\/api\/local\/admin\/treasury\/([^/]+)\/operators$/.exec(p);
            if (req.method === 'POST' && m) {
                grants.push({ treasury: decodeURIComponent(m[1]), pubkey: JSON.parse(body || '{}').pubkey });
                return send(200, { success: true });
            }
            send(404, { error: 'Not found' });
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${server.address().port}`, requests, grants, close: () => new Promise((resolve) => server.close(resolve)) };
}

function runScript(nodeUrl, args) {
    const env = { ...process.env, NODE_URL: nodeUrl, BEANPOOL_TOKEN: TOKEN };
    delete env.ADMIN_PASSWORD;
    return new Promise((resolve) => {
        execFile(process.execPath, [SCRIPT, ...args], { env, timeout: 20_000 },
            (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: `${stdout}${stderr}` }));
    });
}

test('a treasury name and a callsign resolve to their keys, read with the token', async () => {
    const node = await standIn();
    try {
        const { code, out } = await runScript(node.url, ['Community Eggs', 'alice']);
        assert.equal(code, 0, out);
        assert.deepEqual(node.grants, [{ treasury: EGGS, pubkey: ALICE }], out);
        assert.ok(!out.includes(TOKEN), 'the token is never printed');
    } finally {
        await node.close();
    }
});

test('the --treasury form and a callsign in another case resolve too', async () => {
    const node = await standIn();
    try {
        const { code, out } = await runScript(node.url, ['ALICE', '--treasury', 'community eggs']);
        assert.equal(code, 0, out);
        assert.deepEqual(node.grants, [{ treasury: EGGS, pubkey: ALICE }], out);
    } finally {
        await node.close();
    }
});

test('public keys are used as given', async () => {
    const node = await standIn();
    try {
        const { code, out } = await runScript(node.url, [EGGS, ALICE]);
        assert.equal(code, 0, out);
        assert.deepEqual(node.grants, [{ treasury: EGGS, pubkey: ALICE }], out);
    } finally {
        await node.close();
    }
});

for (const [label, args, words] of [
    ['a callsign that matches nobody', ['Community Eggs', 'carol'], 'No member is called "carol"'],
    ['a callsign two members share', ['Community Eggs', 'bob'], '2 members are called "bob"'],
    ['a treasury name that matches nothing', ['Village Bakery', 'alice'], 'No treasury is called "Village Bakery"'],
]) {
    test(`${label}: a plain message, and nothing is granted`, async () => {
        const node = await standIn();
        try {
            const { code, out } = await runScript(node.url, args);
            assert.notEqual(code, 0, out);
            assert.ok(out.includes(words), out);
            assert.deepEqual(node.grants, [], out);
        } finally {
            await node.close();
        }
    });
}

test('a refused treasury list stops with the node\'s words, and nothing is granted', async () => {
    const node = await standIn({ treasuryList: [429, { error: 'Too many requests, slow down' }] });
    try {
        const { code, out } = await runScript(node.url, ['Community Eggs', 'alice']);
        assert.notEqual(code, 0, out);
        assert.ok(out.includes('HTTP 429') && out.includes('Too many requests, slow down'), out);
        assert.deepEqual(node.grants, [], out);
    } finally {
        await node.close();
    }
});
