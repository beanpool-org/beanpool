#!/usr/bin/env node
/* global process, console, setTimeout */
/**
 * The data partition helper (mkosi.extra/usr/lib/beanpool-vault/vault-data.mjs) on loop devices, as root on Linux
 * (CI runs it in .github/workflows/vault-image.yml; it needs cryptsetup, mkfs.ext4, losetup and blkid):
 *
 *   1. a blank partition, the keyholder locked and then open: formatted as LUKS2 under the key, and mounted;
 *   2. again after a restart, with the same key: opened, not formatted again (what it held is still there);
 *   3. with another key: left alone (exit 3), nothing opened;
 *   4. a partition holding a file system (not this vault's volume): left alone (exit 3), not formatted.
 *
 * The keyholder is a stand-in socket that answers as listenDiskKey does: nothing while locked, 32 bytes while open.
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync, statSync, truncateSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mkosi/mkosi.extra/usr/lib/beanpool-vault/vault-data.mjs');
const dir = mkdtempSync(path.join(os.tmpdir(), 'bvd-'));
const name = `vault-data-test-${process.pid}`;
const mount = path.join(dir, 'mnt');
const socketPath = path.join(dir, 'disk.sock');
const loops = [];
let failed = 0;

function sh(cmd, args, input) {
    const r = spawnSync(cmd, args, { input });
    return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

function must(cmd, args, input) {
    const r = sh(cmd, args, input);
    if (!r.ok) throw new Error(`${cmd} ${args.join(' ')}: ${r.out}`);
    return r.out;
}

function check(what, ok) {
    console.log(`data-test: ${ok ? 'PASS' : 'FAIL'} ${what}`);
    if (!ok) failed++;
}

function loopDevice(sizeMb) {
    const file = path.join(dir, `disk-${loops.length}.img`);
    writeFileSync(file, '');
    truncateSync(file, sizeMb * 1024 * 1024);
    const dev = must('losetup', ['-f', '--show', file]);
    loops.push(dev);
    return dev;
}

/** The stand-in keyholder: `state.key` null is locked. */
const state = { key: null };
const server = net.createServer(s => (state.key ? s.end(state.key) : s.end()));

function helperRun(device) {
    return new Promise(resolve => {
        const child = spawn(process.execPath, [helper], {
            env: {
                ...process.env, VAULT_DATA_DEVICE: device, VAULT_DATA_NAME: name, VAULT_DATA_MOUNT: mount,
                VAULT_DATA_KEY_SOCKET: socketPath, VAULT_DATA_OWNER: 'root:root', VAULT_DATA_POLL_MS: '200',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { out += d; });
        child.once('exit', code => resolve({ code, out }));
    });
}

function mounted() {
    return statSync(mount).dev !== statSync(dir).dev;
}

function closeVolume() {
    if (mounted()) must('umount', [mount]);
    if (existsSync(`/dev/mapper/${name}`)) must('cryptsetup', ['close', name]);
}

async function main() {
    must('mkdir', ['-p', mount]);
    await new Promise(resolve => server.listen(socketPath, resolve));
    const key = crypto.randomBytes(32);

    // 1. Blank, locked for a moment, then open.
    const blank = loopDevice(64);
    setTimeout(() => { state.key = key; }, 1000);
    const first = await helperRun(blank);
    check(`a blank partition is formatted and mounted once the vault opens (exit ${first.code})`, first.code === 0 && mounted());
    check('it waited while the vault was locked', first.out.includes('waiting for two custodians'));
    check('it is LUKS2 under the key', sh('cryptsetup', ['isLuks', '--type', 'luks2', blank]).ok
        && sh('cryptsetup', ['open', '--test-passphrase', '--key-file', '-', blank], key).ok);
    writeFileSync(path.join(mount, 'kept'), 'still here\n');
    closeVolume();

    // 2. After a restart: opened, not formatted again.
    const again = await helperRun(blank);
    check(`after a restart it is opened again (exit ${again.code})`, again.code === 0 && mounted());
    check('not formatted again: what it held is there', existsSync(path.join(mount, 'kept')) && readFileSync(path.join(mount, 'kept'), 'utf8') === 'still here\n');
    closeVolume();

    // 3. Another key: left alone.
    state.key = crypto.randomBytes(32);
    const other = await helperRun(blank);
    check(`another key is refused (exit ${other.code})`, other.code === 3 && !mounted() && !existsSync(`/dev/mapper/${name}`));

    // 4. A partition holding something else: left alone, not formatted.
    state.key = key;
    const foreign = loopDevice(64);
    must('mkfs.ext4', ['-q', foreign]);
    const refused = await helperRun(foreign);
    check(`a partition holding another file system is left alone (exit ${refused.code})`, refused.code === 3 && !mounted());
    check('and is still that file system', must('blkid', ['-p', '-o', 'value', '-s', 'TYPE', foreign]) === 'ext4');
}

main().catch(e => {
    console.log(`data-test: FAIL ${e.message}`);
    failed++;
}).finally(() => {
    try {
        closeVolume();
    } catch {
        // Best effort.
    }
    for (const l of loops) sh('losetup', ['-d', l]);
    server.close();
    rmSync(dir, { recursive: true, force: true });
    console.log(failed ? `data-test: ${failed} FAILED` : 'data-test: ALL PASS');
    process.exit(failed ? 1 : 0);
});
