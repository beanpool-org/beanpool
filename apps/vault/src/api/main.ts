#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { LocalDirectoryStore } from './backup-store.js';
import { createVaultApi } from './server.js';

/**
 * `vault-api --config <file>`. The config:
 *
 *   {"dataDir": "...", "keyholderSocket": "...", "hosts": ["vault.beanpool.org"], "backupDir": "...",
 *    "port": 8443, "host": "127.0.0.1", "trustProxy": true}
 *
 * `backupDir` is a local directory standing in for the object store until its client and credentials exist (design
 * §4: a second provider in another country). Every hour: a backup, and holds, deletion records and nonces expire.
 */

function argValue(name: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
    const configPath = argValue('--config');
    if (!configPath) {
        console.error('usage: vault-api --config <file>');
        process.exit(2);
    }
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
        dataDir: string; keyholderSocket: string; hosts: string[]; backupDir: string; port?: number; host?: string;
        trustProxy?: boolean; expoAccessToken?: string;
    };
    const api = createVaultApi({
        dataDir: config.dataDir,
        keyholderSocket: config.keyholderSocket,
        hosts: config.hosts,
        store: new LocalDirectoryStore(config.backupDir),
        trustProxy: config.trustProxy,
        expoAccessToken: config.expoAccessToken,
    });
    const port = await api.listen(config.port ?? 8443, config.host ?? '127.0.0.1');
    const timer = setInterval(() => {
        api.maintenance().catch(e => console.error(`vault-api: maintenance: ${(e as Error).message}`));
    }, 60 * 60 * 1000);
    const stop = () => {
        clearInterval(timer);
        void api.close().finally(() => process.exit(0));
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    console.log(`vault-api: listening on ${config.host ?? '127.0.0.1'}:${port}`);
}

void main();
