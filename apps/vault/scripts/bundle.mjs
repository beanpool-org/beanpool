#!/usr/bin/env node
/**
 * The vault's release bundles (key vault design §3): one ES module file per program, everything it imports inside it,
 * and the vault's genesis custodian keys baked in (src/shared/pinned.ts). The same commit, lockfile and keys give the
 * same bytes on any machine: no timestamps, no absolute paths, no source maps, a pinned esbuild.
 *
 *   node scripts/bundle.mjs --custodian-keys <file> --out <dir>
 *
 * `<file>` is `{"genesisCustodians": ["<hex>", "<hex>", "<hex>"]}` (public keys only). It writes vault-keyholder.mjs,
 * vault-api.mjs, vault-launcher.mjs and vault-custodian.mjs, and bundles.json with each file's SHA-256. The workspace
 * packages it imports (@beanpool/core, @beanpool/signin) must be built first (`pnpm --filter ... build`).
 */
/* global process, console */
import crypto from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export const VAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PROGRAMS = {
    'vault-keyholder.mjs': 'src/keyholder/main.ts',
    'vault-api.mjs': 'src/api/main.ts',
    'vault-launcher.mjs': 'src/launcher/main.ts',
    'vault-custodian.mjs': 'src/custodian/cli.ts',
};

const KEY_RE = /^[0-9a-f]{64}$/;

export function readCustodianKeys(file) {
    const keys = JSON.parse(readFileSync(file, 'utf8')).genesisCustodians;
    if (!Array.isArray(keys) || keys.length !== 3 || !keys.every(k => KEY_RE.test(k)) || new Set(keys).size !== 3) {
        throw new Error(`${file}: genesisCustodians is three different 64-character lower-case hex keys.`);
    }
    return keys;
}

/** Builds the four programs into `outDir`; returns {file: sha256}. */
export async function bundleVault({ outDir, rootKeys }) {
    mkdirSync(outDir, { recursive: true });
    const hashes = {};
    for (const [out, entry] of Object.entries(PROGRAMS)) {
        const result = await build({
            absWorkingDir: VAULT_ROOT,
            entryPoints: [entry],
            bundle: true,
            platform: 'node',
            format: 'esm',
            target: 'node22',
            write: false,
            minify: false,
            sourcemap: false,
            legalComments: 'eof',
            charset: 'utf8',
            logLevel: 'silent',
            // Built-ins stay imports; so does node:sqlite, which db.ts loads with require.
            external: ['node:*'],
            banner: { js: '// BeanPool key vault. Built by apps/vault/scripts/bundle.mjs from the BeanPool repository.\nimport { createRequire as __vaultCreateRequire } from \'node:module\';\nconst require = __vaultCreateRequire(import.meta.url);' },
            define: { __BEANPOOL_VAULT_ROOT_KEYS__: JSON.stringify(rootKeys) },
        });
        const bytes = result.outputFiles[0].contents;
        writeFileSync(path.join(outDir, out), bytes, { mode: 0o644 });
        hashes[out] = crypto.createHash('sha256').update(bytes).digest('hex');
    }
    writeFileSync(path.join(outDir, 'bundles.json'), `${JSON.stringify(hashes, null, 2)}\n`);
    return hashes;
}

function arg(name) {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const keysFile = arg('--custodian-keys');
    const outDir = arg('--out');
    if (!keysFile || !outDir) {
        console.error('usage: node scripts/bundle.mjs --custodian-keys <file> --out <dir>');
        process.exit(2);
    }
    const hashes = await bundleVault({ outDir: path.resolve(outDir), rootKeys: readCustodianKeys(keysFile) });
    for (const [file, hash] of Object.entries(hashes)) console.log(`${hash}  ${file}`);
}
