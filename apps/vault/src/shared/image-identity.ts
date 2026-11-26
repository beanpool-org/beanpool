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
 * The ESP is root's alone, so on the image root works this out before the vault's programs start
 * (beanpool-vault-identity.service, `vault-keyholder --identify`) and leaves the answer in a file they read
 * ({@link imageFromIdentityFile}): the keyholder and the API both.
 *
 * **Direct boot** (vault comeback design §2.8): on an SEV-SNP host with measured boot the host's firmware loads the UKI
 * itself, so there is no systemd-boot and no `LoaderEntrySelected`. The image is then named by its `roothash`: the UKI
 * in the ESP's `EFI/Linux/` whose own command line (its `.cmdline` section) names the roothash this kernel booted with.
 * The install image carries that UKI, and root's install step writes each new one there beside its system partition, so
 * the keyholder, the API's updater and the install step find the same image either way. Two different boot files naming
 * one roothash is not an answer. On SEV-SNP the chip's launch measurement is what proves which UKI started; this only
 * names it.
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

/** A UKI's `.cmdline` section (PE/COFF: the section table after the optional header), or null when it has none. */
export function ukiCmdline(file: Buffer): string | null {
    try {
        if (file.length < 0x40 || file.toString('latin1', 0, 2) !== 'MZ') return null;
        const pe = file.readUInt32LE(0x3c);
        if (file.toString('latin1', pe, pe + 4) !== 'PE\0\0') return null;
        const sections = file.readUInt16LE(pe + 6);
        const table = pe + 24 + file.readUInt16LE(pe + 20);
        for (let i = 0; i < sections; i++) {
            const at = table + i * 40;
            if (file.toString('latin1', at, at + 8).replace(/\0+$/, '') !== '.cmdline') continue;
            const size = Math.min(file.readUInt32LE(at + 8), file.readUInt32LE(at + 16));
            const start = file.readUInt32LE(at + 20);
            if (start + size > file.length) return null;
            return file.toString('utf8', start, start + size).replace(/\0+$/, '');
        }
    } catch {
        return null;
    }
    return null;
}

/** The UKI on the ESP whose own command line names `roothash` (direct boot: no boot loader named it). */
function imageByRoothash(roothash: string, espDirs: string[], efivars: string): { ok: true; image: ImageIdentity } | { ok: false; reason: string } {
    const found = new Map<string, string>();
    for (const esp of espDirs) {
        const dir = path.join(esp, 'EFI', 'Linux');
        if (!existsSync(dir)) continue;
        for (const name of readdirSync(dir).filter(f => /\.efi$/i.test(f)).sort()) {
            const ukiPath = path.join(dir, name);
            let bytes: Buffer;
            try {
                bytes = readFileSync(ukiPath);
            } catch {
                continue;
            }
            const cmdline = ukiCmdline(bytes);
            if (cmdline === null || roothashFromCmdline(cmdline) !== roothash) continue;
            const sha = crypto.createHash('sha256').update(bytes).digest('hex');
            if (!found.has(sha)) found.set(sha, ukiPath);
        }
    }
    if (found.size > 1) return { ok: false, reason: `${found.size} different boot files on the ESP name roothash ${roothash}` };
    const [entry] = [...found];
    if (!entry) return { ok: false, reason: `no LoaderEntrySelected in ${efivars}, and no UKI in EFI/Linux on the ESP names roothash ${roothash}` };
    const [ukiSha256, ukiPath] = entry;
    return { ok: true, image: { ukiSha256, roothash, imageHash: imageHashOf({ ukiSha256, roothash }), ukiPath } };
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
    const espDirs = paths.esp ? [paths.esp] : ['/efi', '/boot'];
    // The host's firmware loaded the UKI (measured direct boot): name it by its roothash.
    if (!entry) return imageByRoothash(roothash, espDirs, efivars);
    const base = withoutTries(entry).toLowerCase();
    for (const esp of espDirs) {
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

/** The answer root left in `file` (`vault-keyholder --identify <file>`, as {@link identifyImage} gives it). */
export function imageFromIdentityFile(file: string): { ok: true; image: ImageIdentity } | { ok: false; reason: string } {
    let r: { ok?: unknown; image?: Partial<ImageIdentity>; reason?: unknown };
    try {
        r = JSON.parse(readFileSync(file, 'utf8')) as typeof r;
    } catch {
        return { ok: false, reason: `${file} is missing or unreadable` };
    }
    if (r?.ok === true && r.image && /^[0-9a-f]{64}$/.test(r.image.imageHash ?? '')) return { ok: true, image: r.image as ImageIdentity };
    return { ok: false, reason: r?.ok === false && typeof r.reason === 'string' ? r.reason : `${file} is malformed` };
}

export function runningImage(paths: ImageIdentityPaths = {}): ImageIdentity | null {
    const r = identifyImage(paths);
    return r.ok ? r.image : null;
}
