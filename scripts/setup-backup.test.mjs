/* global process -- a Node script */
// Tests for scripts/setup-backup.mjs against a stand-in primary on localhost (nothing else is contacted).
// Run by test-all.sh (the `setup_backup` check): node --test scripts/setup-backup.test.mjs
//
// Sign-in step 7c: a primary with two-factor sign-in off refuses the admin password sent with a request, 403
// password_needs_2fa. The script prints the primary's words and the way out, at either step that sends the password.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'setup-backup.mjs');
const NODE_WORDS = 'Turn on two-factor sign-in in Settings, or use an automation token made from your phone';
const REFUSAL = JSON.stringify({ error: NODE_WORDS, code: 'password_needs_2fa' });
const HINT = 'turn on two-factor sign-in on the primary, or set BEANPOOL_TOKEN';

/** A primary that answers each path from `routes` (status, body); anything else is 404. */
async function standIn(routes) {
    const server = http.createServer((req, res) => {
        const [status, body] = routes[req.url.split('?')[0]] ?? [404, '{}'];
        res.writeHead(status, { 'Content-Type': 'application/json' }).end(body);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://localhost:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Runs the script with the password only (no BEANPOOL_TOKEN); resolves with its exit code and output. */
function runScript(primary, dataDir) {
    const env = { ...process.env };
    delete env.BEANPOOL_TOKEN;
    delete env.BACKUP_REPLICATION_TOKEN;
    return new Promise((resolve) => {
        execFile(process.execPath, [SCRIPT, '--primary', primary, '--admin-pw', 'pw-only', '--data-dir', dataDir], { env, timeout: 20_000 },
            (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: `${stdout}${stderr}` }));
    });
}

for (const [step, routes] of [
    ['the enrolment bundle', { '/api/local/admin/backup-enroll': [403, REFUSAL] }],
    ['making the replication token', {
        '/api/local/admin/backup-enroll': [200, JSON.stringify({ communityId: 'c1', genesis: { communityId: 'c1' }, primaryPeerId: '12D3KooWStandIn', primaryUrl: 'http://localhost' })],
        '/api/local/admin/replication-token/status': [403, REFUSAL],
    }],
]) {
    test(`a password refused for needing two-factor sign-in at ${step}: the primary's words and the way out`, async () => {
        const primary = await standIn(routes);
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-setup-backup-test-'));
        try {
            const { code, out } = await runScript(primary.url, dataDir);
            assert.notEqual(code, 0, out);
            assert.ok(out.includes(NODE_WORDS), `the primary's words: ${out}`);
            assert.ok(out.includes(HINT), `the way out: ${out}`);
            assert.ok(!out.includes('pw-only'), 'the password is never printed');
        } finally {
            await primary.close();
            fs.rmSync(dataDir, { recursive: true, force: true });
        }
    });
}

test('a wrong password at the enrolment bundle: still "Check --admin-pw"', async () => {
    const primary = await standIn({ '/api/local/admin/backup-enroll': [401, JSON.stringify({ error: 'Unauthorized' })] });
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-setup-backup-test-'));
    try {
        const { code, out } = await runScript(primary.url, dataDir);
        assert.notEqual(code, 0, out);
        assert.ok(out.includes('Check --admin-pw.'), out);
        assert.ok(!out.includes(HINT), out);
    } finally {
        await primary.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});

// The replication token from the environment (BACKUP_REPLICATION_TOKEN), not argv: argv shows in `ps` (#1550 review).
const AUTOMATION = `bp_${'a'.repeat(12)}_${'b'.repeat(64)}`;
const REPLICATION = 'rep-token-0123456789abcdef';
const ENROLL = { communityId: 'c1', genesis: { communityId: 'c1' }, primaryPeerId: '12D3KooWStandIn', primaryUrl: 'http://localhost' };

/** Runs the script with BEANPOOL_TOKEN and `envExtra`, the data dir one level down so .env lands in the temp dir. */
function runWithToken(primary, root, args, envExtra) {
    const env = { ...process.env, BEANPOOL_TOKEN: AUTOMATION, ...envExtra };
    if (!('BACKUP_REPLICATION_TOKEN' in envExtra)) delete env.BACKUP_REPLICATION_TOKEN;
    return new Promise((resolve) => {
        execFile(process.execPath, [SCRIPT, '--primary', primary, '--data-dir', path.join(root, 'data'), ...args], { env, timeout: 20_000 },
            (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: `${stdout}${stderr}` }));
    });
}

for (const [label, args, envExtra, warns] of [
    ['from BACKUP_REPLICATION_TOKEN', [], { BACKUP_REPLICATION_TOKEN: REPLICATION }, false],
    ['from --token, as before, with a warning that argv shows in ps', ['--token', REPLICATION], {}, true],
]) {
    test(`the replication token ${label}: written to .env, never printed`, async () => {
        const primary = await standIn({ '/api/local/admin/backup-enroll': [200, JSON.stringify(ENROLL)] });
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-setup-backup-test-'));
        try {
            const { code, out } = await runWithToken(primary.url, root, args, envExtra);
            assert.equal(code, 0, out);
            assert.ok(fs.readFileSync(path.join(root, '.env'), 'utf8').includes(`BACKUP_REPLICATION_TOKEN=${REPLICATION}\n`) ||
                fs.readFileSync(path.join(root, '.env'), 'utf8').endsWith(`BACKUP_REPLICATION_TOKEN=${REPLICATION}`), out);
            assert.equal(/shows in `?ps`?/.test(out), warns, `the argv warning ${warns ? 'is' : 'is not'} printed: ${out}`);
            assert.ok(!out.includes(REPLICATION) && !out.includes(AUTOMATION), `no credential is printed: ${out}`);
        } finally {
            await primary.close();
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
}

test('with BEANPOOL_TOKEN and no replication token: it stops before anything is fetched and names the variable', async () => {
    const primary = await standIn({ '/api/local/admin/backup-enroll': [200, JSON.stringify(ENROLL)] });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-setup-backup-test-'));
    try {
        const { code, out } = await runWithToken(primary.url, root, [], {});
        assert.notEqual(code, 0, out);
        assert.ok(out.includes('BACKUP_REPLICATION_TOKEN'), out);
        assert.ok(!fs.existsSync(path.join(root, '.env')), 'nothing written');
    } finally {
        await primary.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
});
