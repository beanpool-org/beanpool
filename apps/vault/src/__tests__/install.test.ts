import crypto from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { custodianKey } from '../custodian/lib.js';
import { INSTALL_SPARE_BYTES, installStaged, type InstallOptions } from '../install/install.js';
import { sha256Hex, type ReleaseFiles } from '../shared/release.js';
import { stagedNames } from '../shared/staged-image.js';
import { keys3, makeRelease, randomImage, type MadeRelease } from './release-kit.js';

/**
 * The monthly restart's install step (install.ts, #1314 BLOCKING 2): root decides what boots next, from the keys it was
 * built with, whatever the API's user put in its inbox. Nothing reaches systemd-sysupdate (here a stand-in that
 * records what its source directory holds) unless the release has two custodian signatures in the chain from the
 * pinned keys, is newer than the running one, and its files are the ones it names, under its version.
 */

const dir = mkdtempSync(path.join(os.tmpdir(), 'bvi-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;

interface Image {
    uki: Buffer;
    root: Buffer;
    verity: Buffer;
    image: { ukiSha256: string; roothash: string };
}

function newImage(): Image {
    const uki = crypto.randomBytes(300);
    const root = crypto.randomBytes(500);
    const verity = crypto.randomBytes(50);
    // A stand-in root hash for this root partition and verity tree (verifyRoot below checks the same).
    return { uki, root, verity, image: { ukiSha256: sha256Hex(uki), roothash: sha256Hex(Buffer.concat([root, verity])) } };
}

function setUp() {
    n++;
    const root = keys3();
    const running = newImage();
    const next = newImage();
    const r1 = makeRelease({ version: '1.0.0', previous: null, custodianKeys: root, signers: root.slice(0, 2), image: running.image });
    const r2 = makeRelease({ version: '1.1.0', previous: r1, custodianKeys: root, signers: root.slice(1), image: next.image });
    const inbox = path.join(dir, `inbox-${n}`);
    const transferDir = path.join(dir, `install-${n}`);
    const workDir = path.join(dir, `install-${n}.work`);
    mkdirSync(inbox, { recursive: true });
    /** What the transfer source held each time systemd-sysupdate ran. */
    const installed: Record<string, Buffer>[] = [];
    const opts = (over: Partial<InstallOptions> = {}): InstallOptions => ({
        inbox, transferDir, workDir, rootKeys: root.map(k => k.publicKey),
        runningImage: () => r1.manifest.imageHash,
        verifyRoot: async (rootFile, verityFile, roothash) => sha256Hex(Buffer.concat([readFileSync(rootFile), readFileSync(verityFile)])) === roothash,
        sysupdate: () => {
            installed.push(Object.fromEntries(readdirSync(transferDir).map(f => [f, readFileSync(path.join(transferDir, f))])));
            return true;
        },
        log: () => undefined,
        ...over,
    });
    /** Stages as the API does (updater.ts): the three files under the release's names, and the chain up to it. */
    const stage = (release: MadeRelease, img: Image, chain: ReleaseFiles[], over: { version?: string; uki?: Buffer; root?: Buffer } = {}) => {
        const names = stagedNames(over.version ?? release.manifest.version, release.manifest.image.roothash);
        writeFileSync(path.join(inbox, names.uki), over.uki ?? img.uki);
        writeFileSync(path.join(inbox, names.root), over.root ?? img.root);
        writeFileSync(path.join(inbox, names.verity), img.verity);
        writeFileSync(path.join(inbox, names.release), JSON.stringify({ version: release.manifest.version, imageHash: release.manifest.imageHash, chain }));
        return names;
    };
    const nothingInstalled = () => {
        expect(installed).toEqual([]);
        expect(existsSync(transferDir) ? readdirSync(transferDir) : []).toEqual([]);
        expect(readdirSync(inbox)).toEqual([]);
    };
    return { root, running, next, r1, r2, inbox, transferDir, installed, opts, stage, nothingInstalled };
}

describe('the monthly restart installs only what root checks from the pinned keys', () => {
    it('a two-signed newer release: its files, root\'s copies, are moved where systemd-sysupdate reads, and installed', async () => {
        const t = setUp();
        const names = t.stage(t.r2, t.next, [t.r1, t.r2]);
        expect(await installStaged(t.opts())).toEqual({ installed: true, version: '1.1.0' });
        expect(t.installed).toHaveLength(1);
        expect(Object.keys(t.installed[0]).sort()).toEqual([names.uki, names.root, names.verity].sort());
        expect(t.installed[0][names.uki].equals(t.next.uki)).toBe(true);
        expect(t.installed[0][names.root].equals(t.next.root)).toBe(true);
        expect(readdirSync(t.inbox)).toEqual([]);
        expect(readdirSync(t.transferDir)).toEqual([]);
    });

    it('unsigned files (no release with them), as the API\'s user wrote them in the reviewer\'s test: nothing installed', async () => {
        const t = setUp();
        const names = stagedNames('9.9.9', crypto.randomBytes(32).toString('hex'));
        writeFileSync(path.join(t.inbox, names.uki), Buffer.concat([Buffer.from('NOT-A-SIGNED-RELEASE'), crypto.randomBytes(1000)]));
        writeFileSync(path.join(t.inbox, names.root), crypto.randomBytes(500));
        writeFileSync(path.join(t.inbox, names.verity), crypto.randomBytes(50));
        expect(await installStaged(t.opts())).toMatchObject({ installed: false, reason: expect.stringContaining('unsigned') });
        t.nothingInstalled();
        // The same files with a chain that doesn't hold 9.9.9.
        writeFileSync(path.join(t.inbox, names.uki), crypto.randomBytes(100));
        writeFileSync(path.join(t.inbox, names.release), JSON.stringify({ chain: [t.r1, t.r2] }));
        expect(await installStaged(t.opts())).toMatchObject({ installed: false, reason: expect.stringContaining('release 9.9.9 is not in the chain') });
        t.nothingInstalled();
    });

    it('one custodian signature, or a stranger\'s second: nothing installed', async () => {
        for (const signers of [(r: ReturnType<typeof keys3>) => [r[1]], (r: ReturnType<typeof keys3>) => [r[1], custodianKey(crypto.randomBytes(32))]]) {
            const t = setUp();
            const r2 = makeRelease({ version: '1.1.0', previous: t.r1, custodianKeys: t.root, signers: signers(t.root), image: t.next.image });
            t.stage(r2, t.next, [t.r1, r2]);
            expect(await installStaged(t.opts())).toMatchObject({ installed: false, reason: expect.stringMatching(/release 1\.1\.0 is not in the chain .*one custodian signature/) });
            t.nothingInstalled();
        }
    });

    it('a changed boot file, or a system partition that fails its verity check: nothing installed', async () => {
        const t = setUp();
        t.stage(t.r2, t.next, [t.r1, t.r2], { uki: Buffer.concat([t.next.uki, Buffer.from('x')]) });
        expect(await installStaged(t.opts())).toMatchObject({ installed: false, reason: 'the boot file is not the one release 1.1.0 names' });
        t.nothingInstalled();
        const root = Buffer.from(t.next.root);
        root[0] ^= 1;
        t.stage(t.r2, t.next, [t.r1, t.r2], { root });
        expect(await installStaged(t.opts())).toMatchObject({ installed: false, reason: 'the system partition does not match release 1.1.0\'s root hash' });
        t.nothingInstalled();
    });

    it('file names that don\'t carry the release\'s version: nothing installed', async () => {
        const t = setUp();
        // The boot file under 1.1.0, its partitions under 9.9.9.
        const names = t.stage(t.r2, t.next, [t.r1, t.r2]);
        const other = stagedNames('9.9.9', t.r2.manifest.image.roothash);
        for (const k of ['root', 'verity'] as const) {
            writeFileSync(path.join(t.inbox, other[k]), readFileSync(path.join(t.inbox, names[k])));
            rmSync(path.join(t.inbox, names[k]));
        }
        expect(await installStaged(t.opts())).toMatchObject({ installed: false, reason: expect.stringContaining('partitions staged under another version') });
        t.nothingInstalled();
        // All of them under 9.9.9, with 1.1.0's chain.
        t.stage(t.r2, t.next, [t.r1, t.r2], { version: '9.9.9' });
        writeFileSync(path.join(t.inbox, stagedNames('9.9.9', t.r2.manifest.image.roothash).release), JSON.stringify({ chain: [t.r1, t.r2] }));
        rmSync(path.join(t.inbox, stagedNames('1.1.0', t.r2.manifest.image.roothash).release), { force: true });
        expect(await installStaged(t.opts())).toMatchObject({ installed: false, reason: expect.stringContaining('release 9.9.9 is not in the chain') });
        t.nothingInstalled();
    });

    it('an older release, the running one, or one naming the running image: nothing installed', async () => {
        // This machine runs 1.1.0's image; 1.0.0 (older) is staged.
        const t = setUp();
        t.stage(t.r1, t.running, [t.r1, t.r2]);
        expect(await installStaged(t.opts({ runningImage: () => t.r2.manifest.imageHash }))).toMatchObject({ installed: false, reason: 'release 1.0.0 is not newer than 1.1.0, the release this machine runs' });
        t.nothingInstalled();
        // The running release itself.
        t.stage(t.r2, t.next, [t.r1, t.r2]);
        expect(await installStaged(t.opts({ runningImage: () => t.r2.manifest.imageHash }))).toMatchObject({ installed: false, reason: 'release 1.1.0 is not newer than 1.1.0, the release this machine runs' });
        t.nothingInstalled();
        // A newer release that names the image already running (so it is the running release: an API-only one).
        const r3 = makeRelease({ version: '1.2.0', previous: t.r2, custodianKeys: t.root, signers: t.root, image: t.next.image });
        t.stage(r3, t.next, [t.r1, t.r2, r3]);
        expect(await installStaged(t.opts({ runningImage: () => t.r2.manifest.imageHash }))).toMatchObject({ installed: false, reason: 'release 1.2.0 is not newer than 1.2.0, the release this machine runs' });
        t.nothingInstalled();
        // An image this machine can't place in the chain, or none known: "newer" can't be checked.
        t.stage(t.r2, t.next, [t.r1, t.r2]);
        expect(await installStaged(t.opts({ runningImage: () => randomImage().ukiSha256 }))).toMatchObject({ installed: false, reason: expect.stringContaining('not a release in that chain') });
        t.nothingInstalled();
        t.stage(t.r2, t.next, [t.r1, t.r2]);
        expect(await installStaged(t.opts({ runningImage: () => null }))).toMatchObject({ installed: false, reason: expect.stringContaining('is unknown') });
        t.nothingInstalled();
    });

    it('a link in the inbox is not followed, and what it points at is left as it was', async () => {
        const t = setUp();
        const names = t.stage(t.r2, t.next, [t.r1, t.r2]);
        const target = path.join(dir, `elsewhere-${n}`);
        writeFileSync(target, t.next.uki);
        rmSync(path.join(t.inbox, names.uki));
        symlinkSync(target, path.join(t.inbox, names.uki));
        expect(await installStaged(t.opts())).toMatchObject({ installed: false, reason: expect.stringContaining('a link') });
        t.nothingInstalled();
        expect(readFileSync(target).equals(t.next.uki)).toBe(true);
    });

    it('no room on the state partition for root\'s copies: refused before copying, said plainly, and left for the report', async () => {
        const t = setUp();
        const names = t.stage(t.r2, t.next, [t.r1, t.r2]);
        const need = [names.uki, names.root, names.verity].reduce((sum, name) => sum + readFileSync(path.join(t.inbox, name)).length, 0);
        const resultFile = path.join(dir, `result-${n}.json`);
        const asked: string[] = [];
        // What is free where root copies to: its copies and 64 MiB to spare, less one byte.
        const free = need + INSTALL_SPARE_BYTES - 1;
        const r = await installStaged(t.opts({ resultFile, clock: () => 42, freeBytes: d => { asked.push(d); return free; } }));
        const reason = `no room on the state partition for root's copies of release 1.1.0: they need 0 MiB and ${Math.floor(free / 1048576)} MiB are free`;
        expect(r).toEqual({ installed: false, reason });
        expect(asked).toEqual([path.join(dir, `install-${n}.work`)]);
        t.nothingInstalled();
        expect(JSON.parse(readFileSync(resultFile, 'utf8'))).toEqual({ at: 42, installed: false, reason });
        expect(statSync(resultFile).mode & 0o777).toBe(0o644);
        // With that byte free: installed, and that is left for the report instead.
        t.stage(t.r2, t.next, [t.r1, t.r2]);
        expect(await installStaged(t.opts({ resultFile, clock: () => 43, freeBytes: () => free + 1 }))).toEqual({ installed: true, version: '1.1.0' });
        expect(JSON.parse(readFileSync(resultFile, 'utf8'))).toEqual({ at: 43, installed: true, version: '1.1.0' });
        // A restart with nothing staged says that.
        await installStaged(t.opts({ resultFile, clock: () => 44 }));
        expect(JSON.parse(readFileSync(resultFile, 'utf8'))).toEqual({ at: 44, installed: false, reason: 'nothing is staged' });
    });

    it('systemd-sysupdate failing: reported, and the transfer source is emptied', async () => {
        const t = setUp();
        t.stage(t.r2, t.next, [t.r1, t.r2]);
        expect(await installStaged(t.opts({ sysupdate: () => false }))).toEqual({ installed: false, reason: 'systemd-sysupdate failed' });
        expect(readdirSync(t.transferDir)).toEqual([]);
        expect(await installStaged(t.opts())).toEqual({ installed: false, reason: 'nothing is staged' });
    });
});
