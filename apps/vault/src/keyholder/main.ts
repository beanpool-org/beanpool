#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { runningImage } from '../shared/image-identity.js';
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
 * which the custodian's tool checks against the newest two-signed release. `releaseHash` in the config overrides it
 * (tests and rehearsals, which boot no image); without either it is `unreleased`.
 *
 * It starts locked (or fresh, before a genesis) and stays so until two custodians unlock it. On SIGTERM or SIGINT it
 * wipes what it holds and exits; an uncaught error does the same, with no core file (hygiene.ts).
 */

function argValue(name: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
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
    };
    const releaseHash = config.releaseHash ?? runningImage()?.imageHash;
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
