import { spawn } from 'node:child_process';
import { readFileSync, statfsSync, statSync } from 'node:fs';

/**
 * A new image on its way to the monthly restart (key vault design §3). The API downloads a release's image files into
 * its inbox (updater.ts); root checks them there from the pinned keys and moves only what passes to where
 * systemd-sysupdate reads (install/install.ts). Both name the files the way the image's usr/lib/sysupdate.d
 * transfers expect.
 */

/** The API's inbox, the root-only transfer source systemd-sysupdate reads, and root's scratch space (the image). */
export const IMAGE_INBOX = '/var/lib/beanpool-vault/staged';
export const IMAGE_TRANSFER = '/var/lib/beanpool-vault/install';
export const IMAGE_WORK = '/var/lib/beanpool-vault/install.work';

/** The staged release's chain file (`{version, imageHash, stagedAt, chain}`) is no larger than this. */
export const STAGED_RELEASE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * What root's install step did at the last monthly restart (install.ts), for the API's `/v1/report`: root writes it
 * (0644, in root's directory), the API only reads it. On the state partition, so it outlasts the restart.
 */
export const INSTALL_RESULT_FILE = '/var/lib/beanpool-vault/install-result.json';

export interface InstallRecord {
    at: number;
    installed: boolean;
    version?: string;
    reason?: string;
    /** What root's step removed of what the API left on the state partition, or why it couldn't. */
    cleanup?: string;
}

/** The install record in `file`, or null (none yet, or not one). */
export function readInstallRecord(file: string): InstallRecord | null {
    try {
        if (statSync(file).size > 64 * 1024) return null;
        const o = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
        if (typeof o.at !== 'number' || typeof o.installed !== 'boolean') return null;
        return {
            at: o.at, installed: o.installed,
            ...(typeof o.version === 'string' ? { version: o.version.slice(0, 32) } : {}),
            ...(typeof o.reason === 'string' ? { reason: o.reason.slice(0, 500) } : {}),
            ...(typeof o.cleanup === 'string' ? { cleanup: o.cleanup.slice(0, 500) } : {}),
        };
    } catch {
        return null;
    }
}

/** The file system saying it is full (or a quota reached). */
export function isNoRoom(e: unknown): boolean {
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    return code === 'ENOSPC' || code === 'EDQUOT';
}

/** Bytes free on the file system holding `dir`: for root (who may use the blocks ext4 keeps back) or for others. */
export function freeBytes(dir: string, forRoot: boolean): number {
    const s = statfsSync(dir);
    return (forRoot ? s.bfree : s.bavail) * s.bsize;
}

export function mib(bytes: number): string {
    return `${Math.floor(bytes / (1024 * 1024))} MiB`;
}

/**
 * Checks a system partition image against its verity tree and the root hash its release names: `veritysetup verify`
 * on the image (cryptsetup-bin). Replaceable in tests.
 */
export type VerifyRoot = (rootFile: string, verityFile: string, roothash: string) => Promise<boolean>;

export const veritysetupVerify: VerifyRoot = (rootFile, verityFile, roothash) => new Promise(resolve => {
    const child = spawn('veritysetup', ['verify', rootFile, verityFile, roothash], { stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('exit', code => resolve(code === 0));
});

/** A GPT partition UUID from 16 bytes of hex, as systemd derives a verity pair's from the root hash's two halves. */
export function uuidOfHex(hex32: string): string {
    return `${hex32.slice(0, 8)}-${hex32.slice(8, 12)}-${hex32.slice(12, 16)}-${hex32.slice(16, 20)}-${hex32.slice(20, 32)}`;
}

/**
 * The files of a staged image, named as the image's usr/lib/sysupdate.d transfers expect: the partition UUIDs are the
 * halves of the root hash, which is how the new UKI's roothash= finds its own partitions. `release` holds the chain
 * of two-signed releases up to this one, for root to check.
 */
export function stagedNames(version: string, roothash: string) {
    return {
        uki: `beanpool-vault_${version}.efi`,
        root: `beanpool-vault_${version}_${uuidOfHex(roothash.slice(0, 32))}.root.raw`,
        verity: `beanpool-vault_${version}_${uuidOfHex(roothash.slice(roothash.length - 32))}.root-verity.raw`,
        release: `beanpool-vault_${version}.staged.json`,
    };
}
