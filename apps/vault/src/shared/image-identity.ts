import crypto from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { imageHashOf } from './release.js';

/**
 * Which image this machine booted (host design §5.1 item 5): the UKI's SHA-256 and the dm-verity root hash on the
 * kernel command line, combined as a release's `imageHash`. The keyholder reports it as `releaseHash` in every hello;
 * the API compares it with the releases in the feed.
 *
 * On the image, systemd-boot starts the UKI and records its file name in the EFI variable `LoaderEntrySelected`; the
 * UKI sits in the ESP's `EFI/Linux/` (with a `+left-done` boot-counting suffix until the boot is blessed). The command
 * line carries `roothash=`. Read on a machine that booted another way (a developer's, a test), this finds nothing and
 * says why: the release is then `unreleased`.
 *
 * What it proves: on platform `none`, nothing a hostile host couldn't fake (the host can change the ESP after boot, or
 * boot something else that answers the same). It catches mistakes: an image nobody signed, or an old one still running.
 */

const LOADER_GUID = '4a67b082-0a4c-41cf-b6c7-440b29bb8c4f';

export interface ImageIdentity {
    ukiSha256: string;
    roothash: string;
    imageHash: string;
    ukiPath: string;
}

export interface ImageIdentityPaths {
    cmdline?: string;
    efivars?: string;
    /** Where the ESP is mounted. */
    esp?: string;
}

/** `LoaderEntrySelected` as systemd-boot writes it: 4 bytes of attributes, then UTF-16LE with a final NUL. */
export function readEfiString(bytes: Buffer): string | null {
    if (bytes.length < 6) return null;
    const text = bytes.subarray(4).toString('utf16le').replace(/\0+$/, '');
    return text || null;
}

export function roothashFromCmdline(cmdline: string): string | null {
    for (const word of cmdline.trim().split(/\s+/)) {
        const m = /^(?:roothash|usrhash)=([0-9a-f]{64}(?:[0-9a-f]{64})?)$/.exec(word);
        if (m) return m[1];
    }
    return null;
}

/** An entry's file name without systemd-boot's boot-counting suffix (`name+3-0.efi` → `name.efi`). */
export function withoutTries(entry: string): string {
    return entry.replace(/\+\d+(-\d+)?(?=\.efi$)/i, '');
}

export function identifyImage(paths: ImageIdentityPaths = {}): { ok: true; image: ImageIdentity } | { ok: false; reason: string } {
    const read = (p: string) => {
        try {
            return readFileSync(p);
        } catch {
            return null;
        }
    };
    const cmdline = read(paths.cmdline ?? '/proc/cmdline');
    const roothash = cmdline ? roothashFromCmdline(cmdline.toString('utf8')) : null;
    if (!roothash) return { ok: false, reason: 'no roothash= on the kernel command line' };
    const efivars = paths.efivars ?? '/sys/firmware/efi/efivars';
    const entryVar = read(path.join(efivars, `LoaderEntrySelected-${LOADER_GUID}`));
    const entry = entryVar ? readEfiString(entryVar) : null;
    if (!entry) return { ok: false, reason: `no LoaderEntrySelected in ${efivars}` };
    const base = withoutTries(entry).toLowerCase();
    for (const esp of paths.esp ? [paths.esp] : ['/efi', '/boot']) {
        const dir = path.join(esp, 'EFI', 'Linux');
        if (!existsSync(dir)) continue;
        // The file that booted, or the same one renamed since (its boot blessed, or a case the firmware changed).
        const file = readdirSync(dir).find(f => f === entry) ?? readdirSync(dir).find(f => withoutTries(f).toLowerCase() === base);
        if (!file) continue;
        const ukiPath = path.join(dir, file);
        const ukiSha256 = crypto.createHash('sha256').update(readFileSync(ukiPath)).digest('hex');
        return { ok: true, image: { ukiSha256, roothash, imageHash: imageHashOf({ ukiSha256, roothash }), ukiPath } };
    }
    return { ok: false, reason: `the booted entry ${entry} is not in EFI/Linux on the ESP` };
}

export function runningImage(paths: ImageIdentityPaths = {}): ImageIdentity | null {
    const r = identifyImage(paths);
    return r.ok ? r.image : null;
}
