#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { rootKeysFor } from '../shared/pinned.js';
import { Launcher } from './launcher.js';

/**
 * `vault-launcher --config <file>`: runs vault-api and hands it over to newer releases (launcher.ts). The config:
 *
 *   {"apiBundle": "/usr/lib/beanpool-vault/vault-api.mjs", "apiConfig": "/etc/beanpool-vault/api.json",
 *    "nodeArgs": ["--disable-sigusr1"]}
 *
 * The pinned custodian keys are the ones this file was built with (a source run passes `rootKeys` in the config).
 */

function argValue(name: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
    const configPath = argValue('--config');
    if (!configPath) {
        console.error('usage: vault-launcher --config <file>');
        process.exit(2);
    }
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { apiBundle: string; apiConfig: string; nodeArgs?: string[]; rootKeys?: string[] };
    const rootKeys = rootKeysFor(config.rootKeys);
    if (!rootKeys) {
        console.error('vault-launcher: no pinned custodian keys: build it with scripts/bundle.mjs');
        process.exit(2);
    }
    const launcher = new Launcher({
        node: process.execPath, nodeArgs: config.nodeArgs ?? ['--disable-sigusr1'], imageBundle: config.apiBundle,
        apiArgs: ['--config', config.apiConfig], rootKeys,
    });
    // The launcher lives until systemd stops it, whatever it waits on: between an API's exit and its restart (or a
    // fallback) nothing else may hold the event loop open, and an unref'd timer would let the process end there.
    const keepalive = setInterval(() => undefined, 1 << 30);
    const stop = () => {
        void launcher.stop().finally(() => {
            clearInterval(keepalive);
            process.exit(0);
        });
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    await launcher.start();
    console.log('vault-launcher: listening');
}

main().catch(e => {
    console.error(`vault-launcher: ${(e as Error).message}`);
    process.exit(1);
});
