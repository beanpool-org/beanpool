#!/usr/bin/env node
/**
 * What a TEST build of the vault's image adds (the boot test; never a release): three throwaway custodian keys made
 * now, the boot test's driver (src/__tests__/image-boot-driver.ts) with a unit that runs it at boot, and the API's
 * config with its release feed a directory the driver fills (/var/lib/beanpool-vault-test/feed, checked every 5 s)
 * in place of GitHub.
 *
 *   node apps/vault/image/test-image/make.mjs --out <dir>
 *   apps/vault/image/build.sh --custodian-keys <dir>/keys.json --version 0.0.1 --out <image> --extra <dir>/extra
 *   apps/vault/image/boot-test.sh --image <image> --verdict vault-test
 *
 * <dir>/keys.json holds the public keys (printed too); the seeds go into the test image alone
 * (/etc/beanpool-vault-test/custodians.json), so the driver can run a genesis. Nothing here is kept after the run.
 */
/* global process, console, Buffer */
import crypto from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ed25519 } from '@noble/curves/ed25519.js';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const vault = path.resolve(here, '../..');
const i = process.argv.indexOf('--out');
if (i === -1 || !process.argv[i + 1]) {
    console.error('usage: node image/test-image/make.mjs --out <dir>');
    process.exit(2);
}
const out = path.resolve(process.argv[i + 1]);
const extra = path.join(out, 'extra');
mkdirSync(extra, { recursive: true });

const seeds = [0, 1, 2].map(() => crypto.randomBytes(32));
const keys = seeds.map(s => Buffer.from(ed25519.getPublicKey(s)).toString('hex'));
writeFileSync(path.join(out, 'keys.json'), `${JSON.stringify({ genesisCustodians: keys })}\n`);
mkdirSync(path.join(extra, 'etc/beanpool-vault-test'), { recursive: true });
writeFileSync(path.join(extra, 'etc/beanpool-vault-test/custodians.json'), `${JSON.stringify({ seeds: seeds.map(s => s.toString('hex')) })}\n`, { mode: 0o600 });

const driver = await build({
    absWorkingDir: vault,
    entryPoints: ['src/__tests__/image-boot-driver.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    write: false,
    logLevel: 'silent',
    external: ['node:*'],
    banner: { js: 'import { createRequire as __vaultCreateRequire } from \'node:module\';\nconst require = __vaultCreateRequire(import.meta.url);' },
});
mkdirSync(path.join(extra, 'usr/lib/beanpool-vault-test'), { recursive: true });
writeFileSync(path.join(extra, 'usr/lib/beanpool-vault-test/driver.mjs'), driver.outputFiles[0].contents, { mode: 0o644 });
cpSync(path.join(here, 'extra'), extra, { recursive: true });
const api = JSON.parse(readFileSync(path.join(vault, 'image/mkosi/mkosi.extra/etc/beanpool-vault/api.json'), 'utf8'));
api.feed = { directory: '/var/lib/beanpool-vault-test/feed' };
api.updateCheckSeconds = 5;
mkdirSync(path.join(extra, 'etc/beanpool-vault'), { recursive: true });
writeFileSync(path.join(extra, 'etc/beanpool-vault/api.json'), `${JSON.stringify(api, null, 2)}\n`, { mode: 0o644 });
console.log(`test image keys (public, throwaway): ${keys.join(' ')}`);
