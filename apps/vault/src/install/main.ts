#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { RESTORE_MARKER_NAME } from '../shared/backup-format.js';
import { identifyImage } from '../shared/image-identity.js';
import { rootKeysFor } from '../shared/pinned.js';
import { RESTART_REQUEST_FILE, RESTART_USED_FILE } from '../shared/restart-request.js';
import { IMAGE_INBOX, IMAGE_TRANSFER, IMAGE_WORK, INSTALL_RESULT_FILE } from '../shared/staged-image.js';
import { installForRestart, processesOf, type ApiDirs } from './install.js';

/**
 * `vault-install --restart-request`: the custodians' restart's install step, as root (install.ts, installForRestart;
 * usr/lib/beanpool-vault/custodian-restart, run by beanpool-vault-restart.path). It reads and removes the restart
 * request the API left, checks it and what the API staged from the custodian keys this file was built with, and has
 * systemd-sysupdate install it into the other slot only if every check passes. Exit 0: a new image is installed and
 * boots at the restart. Exit 1: nothing was installed (no request, nothing staged, or refused: the journal says why,
 * and so does the API's /v1/report, from INSTALL_RESULT_FILE); a refused request stopped nothing. Exit 2: not a built
 * bundle, or run without --restart-request (nothing installs without two custodians asking).
 *
 * Once every check passes, it stops the API (the machine restarts next), and removes what the API's user left on the state partition
 * only once no process of that user runs (install.ts). The API's directories and its local backups' budget come from
 * the image's own api.json, on the verified system partition.
 */

const SYSUPDATE = '/usr/lib/systemd/systemd-sysupdate';
const API_UNIT = 'beanpool-vault-api.service';
const API_USER = 'vault-api';
const API_CONFIG = '/etc/beanpool-vault/api.json';
const KEYHOLDER_CONFIG = '/etc/beanpool-vault/keyholder.json';

/** The API's unit stopped, and no process of its user left: true only then. */
function stopApi(): boolean {
    const stop = spawnSync('systemctl', ['stop', API_UNIT], { stdio: 'inherit' });
    const uid = Number(spawnSync('id', ['-u', API_USER], { encoding: 'utf8' }).stdout?.trim());
    if (stop.status !== 0 || !Number.isInteger(uid) || uid <= 0) return false;
    const left = processesOf(uid);
    if (left.length) console.log(`vault-install: ${API_USER} still runs pid ${left.join(', ')}`);
    return left.length === 0;
}

/** From the image's own api.json and keyholder.json; undefined (nothing of the API's is removed) if either is unusable. */
function apiDirs(): ApiDirs | undefined {
    try {
        const c = JSON.parse(readFileSync(API_CONFIG, 'utf8')) as { releasesDir?: string; backupDir?: string; restoreDir?: string; backupMaxBytes?: number; settingsFile?: string };
        const k = JSON.parse(readFileSync(KEYHOLDER_CONFIG, 'utf8')) as { stateDir?: string };
        if (!c.releasesDir || !c.backupDir || !c.restoreDir || !Number.isFinite(c.backupMaxBytes) || !k.stateDir) return undefined;
        return {
            releases: c.releasesDir, backups: c.backupDir, restore: c.restoreDir, backupMaxBytes: c.backupMaxBytes as number,
            settings: c.settingsFile ? path.dirname(c.settingsFile) : undefined,
            restoreMarker: path.join(k.stateDir, RESTORE_MARKER_NAME),
        };
    } catch {
        return undefined;
    }
}

async function main(): Promise<void> {
    const rootKeys = rootKeysFor(undefined);
    if (!rootKeys) {
        console.error('vault-install: no pinned custodian keys: build it with scripts/bundle.mjs');
        process.exit(2);
    }
    if (!process.argv.includes('--restart-request')) {
        console.error('vault-install: only the custodians\' restart installs a new image (vault-install --restart-request)');
        process.exit(2);
    }
    const result = await installForRestart({
        requestFile: RESTART_REQUEST_FILE, usedFile: RESTART_USED_FILE,
        inbox: IMAGE_INBOX, transferDir: IMAGE_TRANSFER, workDir: IMAGE_WORK, rootKeys, resultFile: INSTALL_RESULT_FILE, stopApi, apiDirs: apiDirs(),
        runningImage: () => {
            const r = identifyImage();
            return r.ok ? r.image.imageHash : null;
        },
        sysupdate: () => spawnSync(SYSUPDATE, ['--definitions=/usr/lib/sysupdate.d', 'update'], { stdio: 'inherit' }).status === 0,
    });
    console.log(result.installed
        ? `vault-install: release ${result.version} is installed and boots at the restart`
        : `vault-install: nothing installed: ${result.reason}`);
    process.exit(result.installed ? 0 : 1);
}

main().catch(e => {
    console.error(`vault-install: nothing installed: ${(e as Error).message}`);
    process.exit(1);
});
