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
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'setup-backup.mjs');
const NODE_WORDS = 'Turn on two-factor sign-in in Settings, or use an automation token made from your phone';
const REFUSAL = JSON.stringify({ error: NODE_WORDS, code: 'password_needs_2fa' });
const HINT = 'The password path needs a token now: set BEANPOOL_TOKEN';

/** A primary that answers each path from `routes` (status, body); anything else is 404. `seen` holds each request's path and password header. */
async function standIn(routes) {
    const seen = [];
    const server = http.createServer((req, res) => {
        seen.push({ path: req.url.split('?')[0], adminPw: req.headers['x-admin-password'] ?? null, authorization: req.headers.authorization ?? null });
        const [status, body] = routes[req.url.split('?')[0]] ?? [404, '{}'];
        res.writeHead(status, { 'Content-Type': 'application/json' }).end(body);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://localhost:${server.address().port}`, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Runs the script with the password only (no BEANPOOL_TOKEN); resolves with its exit code and output. */
function runScript(primary, dataDir) {
    const env = { ...process.env };
    delete env.BEANPOOL_TOKEN;
    delete env.BACKUP_REPLICATION_TOKEN;
    delete env.ADMIN_PASSWORD;
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

// Two-factor sign-in on: the primary answers the password with no code 401 totpRequired, right password or not, and this
// script sends no code. It used to print "Check ADMIN_PASSWORD." (#1575 review); it says the path needs a token now.
for (const [step, routes] of [
    ['the enrolment bundle', { '/api/local/admin/backup-enroll': [401, JSON.stringify({ error: '2FA code required', totpRequired: true })] }],
    ['making the replication token', {
        '/api/local/admin/backup-enroll': [200, JSON.stringify({ communityId: 'c1', genesis: { communityId: 'c1' }, primaryPeerId: '12D3KooWStandIn', primaryUrl: 'http://localhost' })],
        '/api/local/admin/replication-token/status': [401, JSON.stringify({ error: '2FA code required', totpRequired: true })],
    }],
]) {
    test(`two-factor sign-in on, at ${step}: the password path needs a token now, and nothing is written`, async () => {
        const primary = await standIn(routes);
        const dataDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bp-setup-backup-test-')), 'data');
        try {
            const { code, out } = await runScript(primary.url, dataDir);
            assert.notEqual(code, 0, out);
            assert.ok(out.includes('two-factor sign-in on, and this script sends no code'), `says why: ${out}`);
            assert.ok(out.includes(HINT), `the way out: ${out}`);
            assert.ok(!/Check (ADMIN_PASSWORD|--admin-pw)/.test(out), `no "check the password": ${out}`);
            assert.ok(!out.includes('turn on two-factor'), `no circle back to two-factor: ${out}`);
            assert.ok(!out.includes('pw-only'), 'the password is never printed');
            assert.ok(!fs.existsSync(dataDir), 'nothing written');
        } finally {
            await primary.close();
            fs.rmSync(path.dirname(dataDir), { recursive: true, force: true });
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

// The standby's .env holds the replication token, which reads the whole ledger: owner-only (0600), like
// manager-nodes.json (#1571 review). A new one is made 0600; an existing one is set to 0600 when updated.
for (const [label, before] of [['a new .env', null], ['an existing 0644 .env', 0o644]]) {
    test(`${label} is left 0600 (owner only)`, async () => {
        const primary = await standIn({ '/api/local/admin/backup-enroll': [200, JSON.stringify(ENROLL)] });
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-setup-backup-test-'));
        const envPath = path.join(root, '.env');
        try {
            if (before !== null) {
                fs.writeFileSync(envPath, 'OTHER=kept\n');
                fs.chmodSync(envPath, before);
            }
            const { code, out } = await runWithToken(primary.url, root, [], { BACKUP_REPLICATION_TOKEN: REPLICATION });
            assert.equal(code, 0, out);
            assert.equal((fs.statSync(envPath).mode & 0o777).toString(8), '600', out);
            if (before !== null) assert.ok(fs.readFileSync(envPath, 'utf8').includes('OTHER=kept'), 'other lines kept');
        } finally {
            await primary.close();
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
}

// The legacy admin password from ADMIN_PASSWORD, not argv: argv shows in `ps` (#1571 review). --admin-pw still works,
// with one warning; the environment wins when both are set.
const ENV_PW = 'env-admin-pw-5d1c';
const ARG_PW = 'arg-admin-pw-9e2a';

/** Runs the script without BEANPOOL_TOKEN (the password path), with `envExtra` and the replication token set. */
function runLegacy(primary, root, args, envExtra) {
    const env = { ...process.env, BACKUP_REPLICATION_TOKEN: REPLICATION, ...envExtra };
    delete env.BEANPOOL_TOKEN;
    if (!('ADMIN_PASSWORD' in envExtra)) delete env.ADMIN_PASSWORD;
    return new Promise((resolve) => {
        execFile(process.execPath, [SCRIPT, '--primary', primary, '--data-dir', path.join(root, 'data'), ...args], { env, timeout: 20_000 },
            (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: `${stdout}${stderr}` }));
    });
}

for (const [label, args, envExtra, sent, warnings, notUsed] of [
    ['from ADMIN_PASSWORD: sent, no warning', [], { ADMIN_PASSWORD: ENV_PW }, ENV_PW, 0, false],
    ['from --admin-pw, as before: sent, with one warning that argv shows in ps', ['--admin-pw', ARG_PW], {}, ARG_PW, 1, false],
    ['in both: ADMIN_PASSWORD is sent and --admin-pw is not used', ['--admin-pw', ARG_PW], { ADMIN_PASSWORD: ENV_PW }, ENV_PW, 0, true],
]) {
    test(`the admin password ${label}`, async () => {
        const primary = await standIn({ '/api/local/admin/backup-enroll': [200, JSON.stringify(ENROLL)] });
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-setup-backup-test-'));
        try {
            const { code, out } = await runLegacy(primary.url, root, args, envExtra);
            assert.equal(code, 0, out);
            assert.deepEqual(primary.seen.map((r) => r.path), ['/api/local/admin/backup-enroll'], out);
            assert.equal(primary.seen[0].adminPw, sent, 'the password the primary got');
            assert.equal(out.split('--admin-pw shows in `ps`').length - 1, warnings, `the argv warning, ${warnings} time(s): ${out}`);
            assert.equal(out.includes('ADMIN_PASSWORD is set: --admin-pw is not used.'), notUsed, out);
            assert.ok(!out.includes(ENV_PW) && !out.includes(ARG_PW) && !out.includes(REPLICATION), `no credential is printed: ${out}`);
            assert.ok(!fs.readFileSync(path.join(root, '.env'), 'utf8').includes(sent), 'the password is never written to .env');
        } finally {
            await primary.close();
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
}

test('a wrong ADMIN_PASSWORD at the enrolment bundle: "Check ADMIN_PASSWORD"', async () => {
    const primary = await standIn({ '/api/local/admin/backup-enroll': [401, JSON.stringify({ error: 'Unauthorized' })] });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-setup-backup-test-'));
    try {
        const { code, out } = await runLegacy(primary.url, root, [], { ADMIN_PASSWORD: ENV_PW });
        assert.notEqual(code, 0, out);
        assert.ok(out.includes('Check ADMIN_PASSWORD.'), out);
        assert.ok(!out.includes(ENV_PW), out);
    } finally {
        await primary.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// The command the node's Settings backup tab shows (apps/server/static/settings.js, generateBackupCommand): the
// secrets go in the environment, in front of the node command, never as arguments, which show in `ps` (#1571 review).
// The function is run as the page runs it, and the command it shows is then run as shown, placeholders filled in.
const SETTINGS_JS = path.join(path.dirname(SCRIPT), '..', 'apps', 'server', 'static', 'settings.js');

/** The command generateBackupCommand puts on the page, for a primary at `primaryUrl`. */
async function shownBackupCommand(primaryUrl) {
    const src = fs.readFileSync(SETTINGS_JS, 'utf8');
    const start = src.indexOf('async function generateBackupCommand()');
    assert.ok(start >= 0, 'generateBackupCommand is in settings.js');
    let depth = 0, end = src.indexOf('{', start);
    for (let i = end; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
    }
    const els = {};
    for (const id of ['backup-enroll-btn', 'backup-enroll-status', 'backup-setup-command', 'backup-enroll-result']) {
        els[id] = { textContent: '', style: {}, classList: { add() {}, remove() {} }, disabled: false };
    }
    const ctx = vm.createContext({
        API: '/api/local', authToken: 'a-session', adminHeaders: () => ({}),
        fetch: async () => ({ ok: true, json: async () => ({ primaryUrl }) }),
        document: { getElementById: (id) => els[id] || null },
    });
    vm.runInContext(`${src.slice(start, end)}\nthis.generateBackupCommand = generateBackupCommand;`, ctx);
    await ctx.generateBackupCommand();
    assert.equal(els['backup-enroll-status'].textContent, '', 'no error shown');
    return els['backup-setup-command'].textContent;
}

test('the Settings backup tab shows the secrets in the environment, not as arguments, and the command runs as shown', async () => {
    const primary = await standIn({ '/api/local/admin/backup-enroll': [200, JSON.stringify(ENROLL)] });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-setup-backup-test-'));
    try {
        const cmd = await shownBackupCommand(primary.url);
        const at = cmd.indexOf('node scripts/setup-backup.mjs');
        assert.ok(at > 0, `the node command comes after the environment: ${cmd}`);
        const [envPart, argv] = [cmd.slice(0, at), cmd.slice(at)];
        assert.match(envPart, /^BEANPOOL_TOKEN='<[A-Z_]+>' BACKUP_REPLICATION_TOKEN='<[A-Z_]+>' $/, cmd);
        assert.equal(argv, `node scripts/setup-backup.mjs --primary ${primary.url}`, 'the arguments carry no secret');
        assert.doesNotMatch(argv, /<|--admin-pw|--token/, cmd);

        // Run as shown, the placeholders filled in, from the repository root (where the page says to run it).
        const filled = envPart.replace(/^BEANPOOL_TOKEN='<[A-Z_]+>'/, `BEANPOOL_TOKEN='${AUTOMATION}'`)
            .replace(/BACKUP_REPLICATION_TOKEN='<[A-Z_]+>'/, `BACKUP_REPLICATION_TOKEN='${REPLICATION}'`) + argv;
        const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` };
        for (const name of ['BEANPOOL_TOKEN', 'BACKUP_REPLICATION_TOKEN', 'ADMIN_PASSWORD']) delete env[name];
        const { code, out } = await new Promise((resolve) => {
            execFile('/bin/sh', ['-c', `${filled} --data-dir "$DATA_DIR"`], { cwd: path.join(path.dirname(SCRIPT), '..'), env: { ...env, DATA_DIR: path.join(root, 'data') }, timeout: 20_000 },
                (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: `${stdout}${stderr}` }));
        });
        assert.equal(code, 0, out);
        assert.equal(primary.seen[0]?.authorization, `Bearer ${AUTOMATION}`, 'the automation token reached the primary');
        assert.equal(primary.seen[0]?.adminPw, null, 'no password sent');
        assert.ok(fs.readFileSync(path.join(root, '.env'), 'utf8').includes(`BACKUP_REPLICATION_TOKEN=${REPLICATION}`), 'the replication token is in .env');
        assert.doesNotMatch(out, /shows in `ps`/, out);
    } finally {
        await primary.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
});
