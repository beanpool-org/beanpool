#!/opt/node/bin/node
// The data partition (key vault design §2.1), run as root by beanpool-vault-data.service.
//
// Waits until the keyholder is unlocked, takes K_disk from its root-only socket (the keyholder's listenDiskKey: 32
// bytes while open, nothing while locked), opens the partition labelled vault-data with it (LUKS2, formatted with it
// the first time, when the partition is still blank), and mounts it where the API keeps its database. K_disk is a
// random 256-bit key, so no password stretching is used; the key goes to cryptsetup on its standard input and is
// wiped here after.
//
// A partition that holds something else, or is LUKS under another key (another vault's), is left alone: the vault
// then stays locked to the outside, and the journal says why. The cold path (design §4) reinstalls onto a blank disk.
/* global process, console, setTimeout, Buffer */
import { spawnSync } from 'node:child_process';
import { chmodSync, chownSync, existsSync, statSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

// The environment overrides these only for image/data-test.mjs (a loop device, a stand-in keyholder); the image's unit
// sets none of them.
const env = process.env;
const DEVICE = env.VAULT_DATA_DEVICE ?? '/dev/disk/by-partlabel/vault-data';
const NAME = env.VAULT_DATA_NAME ?? 'vault-data';
const MAPPED = `/dev/mapper/${NAME}`;
const MOUNT = env.VAULT_DATA_MOUNT ?? '/var/lib/beanpool-vault/data';
const KEY_SOCKET = env.VAULT_DATA_KEY_SOCKET ?? '/run/beanpool-vault/disk-key/disk.sock';
const OWNER = env.VAULT_DATA_OWNER ?? 'vault-api:vault-api-socket';
const POLL_MS = Number(env.VAULT_DATA_POLL_MS ?? 5000);
// Exit status that systemd is told not to restart on (the unit's RestartPreventExitStatus).
const REFUSED = 3;

const log = message => console.log(`vault-data: ${message}`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function mounted() {
    try {
        return statSync(MOUNT).dev !== statSync(path.dirname(MOUNT)).dev;
    } catch {
        return false;
    }
}

function readKey() {
    return new Promise(resolve => {
        const chunks = [];
        const s = net.createConnection(KEY_SOCKET);
        s.on('data', c => chunks.push(c));
        s.on('end', () => resolve(Buffer.concat(chunks)));
        s.on('error', () => resolve(Buffer.alloc(0)));
    });
}

function run(cmd, args, input) {
    const r = spawnSync(cmd, args, { input, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

function must(cmd, args, input) {
    const r = run(cmd, args, input);
    if (!r.ok) throw new Error(`${cmd} ${args[0]}: ${r.out.slice(0, 300)}`);
    return r.out;
}

async function main() {
    if (mounted()) return log('the data partition is already open');
    if (!existsSync(DEVICE)) {
        log(`no partition labelled ${NAME}: the first boot makes it (usr/lib/repart.d)`);
        process.exit(1);
    }
    let key = Buffer.alloc(0);
    for (let waited = 0; key.length !== 32; waited++) {
        key = await readKey();
        if (key.length === 32) break;
        if (waited % 60 === 0) log('waiting for two custodians to unlock the vault');
        await sleep(POLL_MS);
    }
    try {
        if (!existsSync(MAPPED)) {
            if (!run('cryptsetup', ['isLuks', DEVICE]).ok) {
                const found = run('blkid', ['-p', '-o', 'value', '-s', 'TYPE', DEVICE]);
                if (found.ok && found.out) {
                    log(`the data partition holds ${found.out}, not this vault's volume: left alone`);
                    process.exit(REFUSED);
                }
                log('formatting the data partition (the first unlock)');
                must('cryptsetup', ['luksFormat', '--batch-mode', '--type', 'luks2', '--cipher', 'aes-xts-plain64', '--key-size', '512',
                    '--pbkdf', 'pbkdf2', '--pbkdf-force-iterations', '1000', '--label', NAME, '--key-file', '-', DEVICE], key);
                must('cryptsetup', ['open', '--key-file', '-', DEVICE, NAME], key);
                must('mkfs.ext4', ['-q', '-L', NAME, MAPPED]);
            } else if (!run('cryptsetup', ['open', '--key-file', '-', DEVICE, NAME], key).ok) {
                log('the data partition is locked with another key (another vault\'s?): left alone');
                process.exit(REFUSED);
            }
        }
        must('mount', ['-o', 'nodev,nosuid,noexec', MAPPED, MOUNT]);
        const [user, groupName] = OWNER.split(':');
        const api = must('id', ['-u', user]);
        const group = must('getent', ['group', groupName]).split(':')[2];
        chownSync(MOUNT, Number(api), Number(group));
        chmodSync(MOUNT, 0o700);
        log('the data partition is open');
    } finally {
        key.fill(0);
    }
}

main().catch(e => {
    log(e.message);
    process.exit(1);
});
