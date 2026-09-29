#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { identifyImage, imageFromIdentityFile } from '../shared/image-identity.js';
import { BUILT_ROOT_KEYS, rootKeysFor } from '../shared/pinned.js';
import { GitHubReleaseFeed, LocalDirectoryFeed, type ReleaseFeed } from '../shared/release-feed.js';
import { sha256Hex } from '../shared/release.js';
import { nextMonthlyRestart } from '../shared/schedule.js';
import { LocalDirectoryStore } from './backup-store.js';
import { selfTest } from './self-test.js';
import { createVaultApi } from './server.js';
import { Updater, type LauncherLink, type SwitchRequest } from './updater.js';

/**
 * `vault-api --config <file>` (or `--self-test`). The config:
 *
 *   {"dataDir": "...", "keyholderSocket": "...", "hosts": ["vault.beanpool.org"], "backupDir": "...",
 *    "socketPath": "/run/beanpool-vault/api/api.sock", "trustProxy": true,
 *    "releasesDir": "/var/lib/beanpool-vault/releases", "feed": {"github": "beanpool-org/beanpool"}}
 *
 * - `requireDataMount`: `dataDir` is the data partition's mount point (the image); nothing opens until it is mounted.
 * - `socketPath`: listen on a Unix socket behind that symlink (the image; Caddy connects through it), so a newer API
 *   can take over (updater.ts, launcher.ts). Without it, `port` and `host` (tests, a rehearsal).
 * - `backupDir` is a local directory standing in for the object store until its client and credentials exist (design
 *   §4: a second provider in another country).
 * - `feed`: `{"github": "owner/name"}` or `{"directory": "..."}`; without it releases aren't checked.
 * - `stagedDir`: where a new image is staged for the monthly restart (updater.ts); without it, only reported.
 * - `rootKeys`: for a run from source only (tests). A built bundle pins its keys and ignores these.
 * - `imageIdentityFile`: where root leaves which image booted (the image: `/run/beanpool-vault-image.json`, written by
 *   beanpool-vault-identity.service before the vault's programs start, as the keyholder reads it). The ESP it is
 *   worked out from is root's alone. Read again at every release check; missing or unreadable, the image is unknown
 *   and nothing is handed over or staged. Without it the API looks at the machine itself (image-identity.ts).
 * - `imageHash`: the image this machine booted, for tests and rehearsals; it overrides both.
 *
 * Every hour: a backup, and holds, deletion records and nonces expire; and the release check (at start too).
 */

interface ApiConfig {
    dataDir: string;
    keyholderSocket: string;
    hosts: string[];
    backupDir: string;
    port?: number;
    host?: string;
    socketPath?: string;
    trustProxy?: boolean;
    expoAccessToken?: string;
    releasesDir?: string;
    stagedDir?: string;
    feed?: { github?: string; directory?: string };
    updateCheckSeconds?: number;
    imageHash?: string;
    imageIdentityFile?: string;
    rootKeys?: string[];
    requireDataMount?: boolean;
}

function argValue(name: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
}

/** SHA-256 of this file when it is a built bundle; null when run from source. */
function ownBundleHash(): string | null {
    if (!BUILT_ROOT_KEYS) return null;
    return sha256Hex(readFileSync(fileURLToPath(import.meta.url)));
}

/** The launcher that started this process, over the IPC channel it opened; null when started any other way. */
function launcherLink(): LauncherLink | null {
    if (typeof process.send !== 'function' || process.env.BEANPOOL_VAULT_LAUNCHER !== '1') return null;
    let nextId = 1;
    const waiting = new Map<number, (r: { ok: true } | { ok: false; reason: string }) => void>();
    process.on('message', (m: { type?: string; id?: number; ok?: boolean; reason?: string }) => {
        if (m?.type !== 'switch-result' || typeof m.id !== 'number') return;
        waiting.get(m.id)?.(m.ok ? { ok: true } : { ok: false, reason: String(m.reason ?? 'refused') });
        waiting.delete(m.id);
    });
    return {
        requestSwitch: (request: SwitchRequest) => new Promise(resolve => {
            const id = nextId++;
            waiting.set(id, resolve);
            process.send?.({ type: 'switch', id, request });
        }),
    };
}

async function main(): Promise<void> {
    if (process.argv.includes('--self-test')) {
        const report = await selfTest(fileURLToPath(import.meta.url));
        console.log(JSON.stringify(report));
        process.exit(report.ok ? 0 : 1);
    }
    const configPath = argValue('--config');
    if (!configPath) {
        console.error('usage: vault-api --config <file> | --self-test');
        process.exit(2);
    }
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as ApiConfig;
    const own = ownBundleHash();
    const launcher = launcherLink();
    const feed: ReleaseFeed | null = config.feed?.directory ? new LocalDirectoryFeed(config.feed.directory)
        : config.feed?.github ? new GitHubReleaseFeed({ repo: config.feed.github }) : null;
    // As the keyholder does (keyholder/main.ts): the config's hash, else root's file, else the machine itself.
    const image = (): string | null => {
        if (config.imageHash) return config.imageHash;
        const r = config.imageIdentityFile ? imageFromIdentityFile(config.imageIdentityFile) : identifyImage();
        return r.ok ? r.image.imageHash : null;
    };
    const updater = feed && config.releasesDir ? new Updater({
        feed, rootKeys: rootKeysFor(config.rootKeys), ownBundleHash: own, runningImageHash: image, releasesDir: config.releasesDir, launcher,
        stagedDir: config.stagedDir,
    }) : null;

    const api = createVaultApi({
        dataDir: config.dataDir,
        keyholderSocket: config.keyholderSocket,
        hosts: config.hosts,
        store: new LocalDirectoryStore(config.backupDir),
        trustProxy: config.trustProxy,
        expoAccessToken: config.expoAccessToken,
        requireDataMount: config.requireDataMount,
        about: () => ({ api: own ?? 'source', update: updater?.status ?? null, nextRestart: new Date(nextMonthlyRestart(Date.now())).toISOString() }),
    });
    const where = config.socketPath ? await api.listenUnix(config.socketPath) : `${config.host ?? '127.0.0.1'}:${await api.listen(config.port ?? 8443, config.host ?? '127.0.0.1')}`;

    const hourly = setInterval(() => {
        api.maintenance().catch(e => console.error(`vault-api: maintenance: ${(e as Error).message}`));
    }, 60 * 60 * 1000);
    const check = () => {
        updater?.check().then(s => {
            if (s.handover && !s.handover.ok) console.error(`vault-api: release ${s.handover.to.version} not taken: ${s.handover.reason}`);
        }, e => console.error(`vault-api: release check: ${(e as Error).message}`));
    };
    const updates = setInterval(check, (config.updateCheckSeconds ?? 3600) * 1000);
    let leaving = false;
    const leave = (how: 'drain' | 'stop') => {
        if (leaving) return;
        leaving = true;
        clearInterval(hourly);
        clearInterval(updates);
        const done = how === 'drain' ? api.drain() : api.close();
        void done.finally(() => process.exit(0));
    };
    process.on('SIGTERM', () => leave('stop'));
    process.on('SIGINT', () => leave('stop'));
    process.on('message', (m: { type?: string }) => {
        if (m?.type === 'drain') leave('drain');
    });
    console.log(`vault-api: listening on ${where}; api ${own ?? 'source'}`);
    process.send?.({ type: 'ready' });
    check();
}

void main();
