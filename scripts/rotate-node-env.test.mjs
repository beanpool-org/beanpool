// rotate-node-env.sh on a node whose admin password is retired (PR #1587 review): the node ignores ADMIN_PASSWORD, so
// the script must not report it set. Runs the script's own remote updater (the python it sends over SSH) locally
// against a throwaway project dir, with a fake `docker` on PATH that only records that it ran.
//
//   node --test scripts/rotate-node-env.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'rotate-node-env.sh');
const UPDATER = fs.readFileSync(SCRIPT, 'utf8').match(/UPDATE_SCRIPT=\$\(cat << 'REMOTE_PYTHON'\n([\s\S]*?)\nREMOTE_PYTHON\n/)?.[1];

function project(config) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-rotate-'));
    fs.mkdirSync(path.join(dir, 'data'));
    fs.writeFileSync(path.join(dir, 'data', 'local-config.json'), JSON.stringify(config, null, 2));
    fs.writeFileSync(path.join(dir, '.env'), 'ADMIN_PASSWORD="old-one"\n');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\necho ran > "${path.join(dir, 'docker-ran')}"\n`, { mode: 0o755 });
    return dir;
}

function update(dir, dryRun, pairs) {
    const r = spawnSync('python3', ['-c', UPDATER, dryRun ? '1' : '0', dir, 'bp-test'], {
        input: pairs.join('\n') + '\n', encoding: 'utf8', env: { ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}` },
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const RETIRED = { isLocked: true, adminHash: null, salt: null, passwordRetired: { at: 1, by: 'ab'.repeat(32), byCallsign: 'Olive' } };

test('the updater is found in the script', () => {
    assert.ok(UPDATER && UPDATER.includes('updates = {}'));
});

test('a retired node: ADMIN_PASSWORD alone is not set, nothing is written or restarted, and the exit says so (3)', () => {
    const dir = project(RETIRED);
    const r = update(dir, false, ['ADMIN_PASSWORD=new-password-1234']);
    assert.equal(r.code, 3, r.out);
    assert.match(r.out, /\[not set\] ADMIN_PASSWORD: this node's admin password is retired/);
    assert.doesNotMatch(r.out, /\[success\]|\[admin-lock\]|\[restarted\]/);
    assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), 'ADMIN_PASSWORD="old-one"\n');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'data', 'local-config.json'), 'utf8')), RETIRED);
    assert.ok(!fs.existsSync(path.join(dir, 'docker-ran')), 'no restart');
});

test('a retired node: the other keys are still set, ADMIN_PASSWORD is left as it was, and the exit is still 3', () => {
    const dir = project(RETIRED);
    const r = update(dir, false, ['ADMIN_PASSWORD=new-password-1234', 'OTHER_KEY=value']);
    assert.equal(r.code, 3, r.out);
    assert.match(r.out, /\[added\] OTHER_KEY/);
    assert.doesNotMatch(r.out, /\[admin-lock\]/);
    assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), 'ADMIN_PASSWORD="old-one"\nOTHER_KEY="value"\n');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'data', 'local-config.json'), 'utf8')), RETIRED);
    assert.ok(fs.existsSync(path.join(dir, 'docker-ran')), 'restarted for the other key');
});

test('a retired node, dry run: says it would not set ADMIN_PASSWORD (exit 3)', () => {
    const dir = project(RETIRED);
    const r = update(dir, true, ['ADMIN_PASSWORD=new-password-1234', 'OTHER_KEY=value']);
    assert.equal(r.code, 3, r.out);
    assert.match(r.out, /\[not set\] ADMIN_PASSWORD/);
    assert.doesNotMatch(r.out, /Would reset isLocked/);
});

test('a node with a password: ADMIN_PASSWORD rotates as before', () => {
    const dir = project({ isLocked: true, adminHash: 'h', salt: 's' });
    const r = update(dir, false, ['ADMIN_PASSWORD=new-password-1234']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /\[updated\] ADMIN_PASSWORD/);
    assert.match(r.out, /\[admin-lock\] Cleared isLocked/);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'local-config.json'), 'utf8'));
    assert.equal(cfg.isLocked, false);
    assert.ok(!('adminHash' in cfg) && !('salt' in cfg));
});
