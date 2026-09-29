#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { identifyImage } from '../shared/image-identity.js';
import { checkMemoryHygiene, hygieneRefusal } from './hygiene.js';
import { Keyholder } from './keyholder.js';
import { listenDiskKey, listenKeyholder } from './server.js';

/**
 * `vault-keyholder --config <file>`. The config (on the image's read-only system partition, beside the pinned keys):
 *
 *   {"stateDir": "...", "socketPath": "...", "socketMode": 432, "diskKeySocket": "...",
 *    "genesisCustodians": ["<hex>", "<hex>", "<hex>"]}
 *
 * `socketMode` (0660 on the image) lets the API's user in through the keyholder's group; `diskKeySocket` serves the
 * data partition's key to root (server.ts listenDiskKey).
 * The hello's `releaseHash` is the image this machine booted (image-identity.ts: the UKI and its dm-verity root hash),
 * which the custodian's tool checks against the newest two-signed release. On the image, root works it out before the
 * keyholder starts (`vault-keyholder --identify <file>`, beanpool-vault-identity.service: the ESP is root's alone) and
 * the config names that file (`imageIdentityFile`). `releaseHash` in the config overrides it (tests and rehearsals,
 * which boot no image); without either the keyholder looks itself, and failing that it is `unreleased`.
 *
 * It starts locked (or fresh, before a genesis) and stays so until two custodians unlock it. On SIGTERM or SIGINT it
 * wipes what it holds and exits; an uncaught error does the same, with no core file (hygiene.ts).
 */

function argValue(name: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
}

/** The image this machine booted, or why not, from a file root wrote (`--identify`) or from the machine itself. */
function releaseFrom(config: { releaseHash?: string; imageIdentityFile?: string }): { hash?: string; why: string } {
    if (config.releaseHash) return { hash: config.releaseHash, why: 'from the config' };
    let r: ReturnType<typeof identifyImage>;
    if (config.imageIdentityFile) {
        try {
            r = JSON.parse(readFileSync(config.imageIdentityFile, 'utf8')) as ReturnType<typeof identifyImage>;
        } catch {
            return { why: `${config.imageIdentityFile} is missing or unreadable` };
        }
    } else {
        r = identifyImage();
    }
    return r.ok && /^[0-9a-f]{64}$/.test(r.image?.imageHash ?? '') ? { hash: r.image.imageHash, why: 'booted' } : { why: r.ok ? 'malformed' : r.reason };
}

async function main(): Promise<void> {
    // Root, before the keyholder starts: which image booted (reads the ESP, which only root may), into a file.
    const identifyTo = argValue('--identify');
    if (identifyTo) {
        const r = identifyImage();
        writeFileSync(identifyTo, `${JSON.stringify(r)}\n`, { mode: 0o644 });
        console.log(`vault-keyholder: image ${r.ok ? r.image.imageHash : `unknown (${r.reason})`}`);
        return;
    }
    const configPath = argValue('--config');
    if (!configPath) {
        console.error('usage: vault-keyholder --config <file>');
        process.exit(2);
    }
    const hygiene = checkMemoryHygiene();
    const refusal = hygieneRefusal(hygiene);
    if (refusal) {
        console.error(`vault-keyholder: not starting: ${refusal}`);
        process.exit(1);
    }
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
        stateDir: string; socketPath: string; genesisCustodians: string[]; releaseHash?: string; socketMode?: number; diskKeySocket?: string;
        imageIdentityFile?: string;
    };
    const release = releaseFrom(config);
    const releaseHash = release.hash;
    console.log(`vault-keyholder: release ${releaseHash ?? `unreleased (${release.why})`}`);
    const kh = new Keyholder({ stateDir: config.stateDir, genesisCustodians: config.genesisCustodians, releaseHash, hygiene });
    const server = await listenKeyholder(kh, config.socketPath, config.socketMode ?? 0o600);
    const disk = config.diskKeySocket ? await listenDiskKey(kh, config.diskKeySocket) : null;
    const stop = (code: number) => {
        kh.lock();
        void Promise.allSettled([server.close(), disk?.close()]).finally(() => process.exit(code));
    };
    process.on('SIGTERM', () => stop(0));
    process.on('SIGINT', () => stop(0));
    process.on('uncaughtException', () => {
        kh.lock();
        process.exit(1);
    });
    console.log(`vault-keyholder: ${kh.status().state}, listening on ${config.socketPath}; memory: ${JSON.stringify(hygiene)}`);
}

void main();
