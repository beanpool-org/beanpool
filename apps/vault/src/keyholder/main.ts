#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { checkMemoryHygiene, hygieneRefusal } from './hygiene.js';
import { Keyholder } from './keyholder.js';
import { listenKeyholder } from './server.js';

/**
 * `vault-keyholder --config <file>`. The config (V3 bakes it into the image, beside the pinned custodian keys):
 *
 *   {"stateDir": "...", "socketPath": "...", "genesisCustodians": ["<hex>", "<hex>", "<hex>"], "releaseHash": "..."}
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
        stateDir: string; socketPath: string; genesisCustodians: string[]; releaseHash?: string;
    };
    const kh = new Keyholder({ stateDir: config.stateDir, genesisCustodians: config.genesisCustodians, releaseHash: config.releaseHash, hygiene });
    const server = await listenKeyholder(kh, config.socketPath);
    const stop = (code: number) => {
        kh.lock();
        void server.close().finally(() => process.exit(code));
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
