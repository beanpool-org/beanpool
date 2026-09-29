#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { identifyImage } from '../shared/image-identity.js';
import { rootKeysFor } from '../shared/pinned.js';
import { IMAGE_INBOX, IMAGE_TRANSFER, IMAGE_WORK } from '../shared/staged-image.js';
import { installStaged } from './install.js';

/**
 * `vault-install`: the monthly restart's install step, as root (install.ts; usr/lib/beanpool-vault/monthly-restart).
 * It checks what the API staged from the custodian keys this file was built with, and has systemd-sysupdate install it
 * into the other slot only if every check passes. Exit 0: a new image is installed and boots at the restart. Exit 1:
 * nothing was installed (nothing staged, or refused: the journal says why). Exit 2: not a built bundle.
 */

const SYSUPDATE = '/usr/lib/systemd/systemd-sysupdate';

async function main(): Promise<void> {
    const rootKeys = rootKeysFor(undefined);
    if (!rootKeys) {
        console.error('vault-install: no pinned custodian keys: build it with scripts/bundle.mjs');
        process.exit(2);
    }
    const result = await installStaged({
        inbox: IMAGE_INBOX, transferDir: IMAGE_TRANSFER, workDir: IMAGE_WORK, rootKeys,
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
