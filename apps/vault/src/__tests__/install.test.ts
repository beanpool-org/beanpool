import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalDirectoryStore } from '../api/backup-store.js';
import { custodianKey } from '../custodian/lib.js';
import { clearApiDirs, INSTALL_SPARE_BYTES, installStaged, processesOf, type ApiDirs, type InstallOptions } from '../install/install.js';
import { backupsPastBudget, MAX_BACKUP_FILES } from '../shared/backup-format.js';
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
/** A block: backup sizes here are whole blocks, so a file's length and the blocks it holds agree (APFS and ext4). */
const K = 4096;

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

describe('backupsPastBudget, the one rule for root and the API (confirm 5, NB-1)', () => {
    const MiB = 1 << 20;
    /** The newest name there can be (all names here are older). */
    const latest = 'bv-20261231T000000Z.bin';

    it('a backup costs its blocks when they are more than its length: one byte long with 400 MiB preallocated (fallocate --keep-size) is past a 64 MiB budget', () => {
        const backups = [
            { name: 'bv-20260903T000000Z.bin', size: 1, blocks: (400 * MiB) / 512 },
            { name: 'bv-20260902T000000Z.bin', size: 10 * MiB, blocks: (10 * MiB) / 512 },
            // Several small ones whose blocks fit alone but not together.
            { name: 'bv-20260901T000000Z.bin', size: 1, blocks: (30 * MiB) / 512 },
            { name: 'bv-20260831T000000Z.bin', size: 1, blocks: (30 * MiB) / 512 },
        ];
        expect(backupsPastBudget(backups, 64 * MiB, { latest }).sort()).toEqual(['bv-20260831T000000Z.bin', 'bv-20260903T000000Z.bin']);
        // A sparse file (length past its blocks) still costs its length.
        expect(backupsPastBudget([{ name: 'bv-20260903T000000Z.bin', size: 65 * MiB, blocks: 0 }], 64 * MiB, { latest })).toEqual(['bv-20260903T000000Z.bin']);
    });

    it('no more than maxFiles stay, whatever they cost: the newest', () => {
        const empty = Array.from({ length: 1005 }, (_, i) => ({ name: `bv-20260801T000000Z-${i + 1}.bin`, size: 0, blocks: 0 }));
        expect(backupsPastBudget(empty, 64 * MiB, { latest }).sort()).toEqual([1, 2, 3, 4, 5].map(i => `bv-20260801T000000Z-${i}.bin`).sort());
        expect(MAX_BACKUP_FILES).toBe(1000);
        expect(backupsPastBudget(empty.slice(0, 3), 64 * MiB, { latest, maxFiles: 2 })).toEqual(['bv-20260801T000000Z-1.bin']);
    });
});

describe('the monthly restart removes what the API left on the state partition, once the API is stopped (#1314 round 3, 4138896706)', () => {
    /** The API's directories as a compromised API might leave them (the reviewer filled releases/ with fallocate). */
    function planted() {
        const base = path.join(dir, `api-${++n}`);
        const d: ApiDirs = {
            releases: path.join(base, 'releases'), backups: path.join(base, 'backups'), restore: path.join(base, 'restore'), backupMaxBytes: 7 * K,
            restoreMarker: path.join(base, 'keyholder', 'restore-pending.json'),
        };
        for (const p of [d.releases, d.backups, d.restore, path.dirname(d.restoreMarker)]) mkdirSync(p, { recursive: true });
        const outside = path.join(base, 'outside');
        mkdirSync(outside);
        writeFileSync(path.join(outside, 'precious'), 'not the API\'s');
        // releases/: a big file, a release's bundle, a deep tree, a link out.
        writeFileSync(path.join(d.releases, 'junk'), Buffer.alloc(2 << 20));
        mkdirSync(path.join(d.releases, 'a'.repeat(64)));
        writeFileSync(path.join(d.releases, 'a'.repeat(64), 'vault-api.mjs'), 'a bundle');
        mkdirSync(path.join(d.releases, 'deep', 'b', 'c'), { recursive: true });
        writeFileSync(path.join(d.releases, 'deep', 'b', 'c', 'f'), 'x');
        symlinkSync(outside, path.join(d.releases, 'link-out'));
        // backups/: three backups (3 blocks each: two fit in 7), a file that is no backup, a directory and a link
        // under backup names, a partial write.
        for (const day of ['01', '02', '03']) writeFileSync(path.join(d.backups, `bv-202609${day}T000000Z.bin`), Buffer.alloc(3 * K));
        writeFileSync(path.join(d.backups, 'junk'), Buffer.alloc(1 << 20));
        mkdirSync(path.join(d.backups, 'bv-20260904T000000Z.bin'));
        writeFileSync(path.join(d.backups, 'bv-20260904T000000Z.bin', 'inside'), 'x');
        symlinkSync(path.join(outside, 'precious'), path.join(d.backups, 'bv-20260905T000000Z.bin'));
        // A FIFO under a backup name: removed, never opened (opening one would wait for a writer).
        execFileSync('mkfifo', [path.join(d.backups, 'bv-20260907T000000Z.bin')]);
        writeFileSync(path.join(d.backups, 'bv-20260906T000000Z.bin.part'), 'x');
        // restore/: a pending restore's file, its partial, a directory. (Pending only while the keyholder's marker is.)
        writeFileSync(path.join(d.restore, 'restore-pending.bin'), Buffer.alloc(500));
        writeFileSync(path.join(d.restore, 'restore-pending.bin.part'), 'x');
        mkdirSync(path.join(d.restore, 'junk'));
        return { d, outside };
    }
    /** The keyholder's marker: custodians restored a backup into a fresh vault, and the unlock hasn't finished it. */
    const markPending = (d: ApiDirs) => writeFileSync(d.restoreMarker, '{"backup":"bv-20260903T000000Z.bin"}');

    it('its releases, whatever in backups is no backup or past the budget, strays in restore, and a directory named like a boot file in the inbox go; the staged image installs', async () => {
        const t = setUp();
        const { d, outside } = planted();
        markPending(d);
        t.stage(t.r2, t.next, [t.r1, t.r2]);
        // A directory named like a second boot file: with the API running, root refuses "more than one boot file".
        mkdirSync(path.join(t.inbox, 'beanpool-vault_1.2.0.efi'));
        writeFileSync(path.join(t.inbox, 'beanpool-vault_1.2.0.efi', 'inside'), 'x');
        const order: string[] = [];
        const resultFile = path.join(dir, `result-${n}.json`);
        const r = await installStaged(t.opts({
            apiDirs: d, resultFile, clock: () => 7,
            stopApi: () => { order.push(`stop, inbox ${readdirSync(t.inbox).length}, releases ${readdirSync(d.releases).length}`); return true; },
            sysupdate: () => { order.push('sysupdate'); t.installed.push({}); return true; },
        }));
        expect(r).toEqual({ installed: true, version: '1.1.0' });
        // Stopped first, before anything of the API's user was touched.
        expect(order).toEqual(['stop, inbox 5, releases 4', 'sysupdate']);
        expect(readdirSync(d.releases)).toEqual([]);
        expect(readdirSync(d.backups).sort()).toEqual(['bv-20260902T000000Z.bin', 'bv-20260903T000000Z.bin']);
        expect(readdirSync(d.restore).sort()).toEqual(['restore-pending.bin', 'restore-pending.bin.part']);
        expect(readdirSync(t.inbox)).toEqual([]);
        expect(readFileSync(path.join(outside, 'precious'), 'utf8')).toBe('not the API\'s');
        const record = JSON.parse(readFileSync(resultFile, 'utf8')) as { cleanup?: string };
        expect(record).toEqual({
            at: 7, installed: true, version: '1.1.0',
            cleanup: 'removed what the API left on the state partition: 4 in releases, 5 in backups that are not a backup, 1 backup past the budget, 1 in restore',
        });
    });

    it('nothing staged: the API\'s leftovers go all the same (the reviewer\'s case: releases/ filled, nothing could be staged)', async () => {
        const t = setUp();
        const { d } = planted();
        expect(await installStaged(t.opts({ apiDirs: d, stopApi: () => true }))).toEqual({ installed: false, reason: 'nothing is staged' });
        expect(readdirSync(d.releases)).toEqual([]);
        t.nothingInstalled();
    });

    it('no restore pending (no marker from the keyholder): restore/ is emptied, the pending file and its partial included (verify 4, NB-1)', async () => {
        const t = setUp();
        const { d } = planted();
        const resultFile = path.join(dir, `result-${n}.json`);
        await installStaged(t.opts({ apiDirs: d, resultFile, stopApi: () => true }));
        expect(readdirSync(d.restore)).toEqual([]);
        expect((JSON.parse(readFileSync(resultFile, 'utf8')) as { cleanup: string }).cleanup).toMatch(/, 3 in restore$/);
    });

    it('a restore pending (the keyholder\'s marker): its file and its partial stay whatever their size, and nothing else in restore/ (verify 4, NB-1)', async () => {
        const t = setUp();
        const { d } = planted();
        markPending(d);
        writeFileSync(path.join(d.restore, 'restore-pending.bin'), Buffer.alloc(7 * K + 1));
        writeFileSync(path.join(d.restore, 'restore-pending.bin.part'), Buffer.alloc(14 * K));
        await installStaged(t.opts({ apiDirs: d, stopApi: () => true }));
        expect(readdirSync(d.restore).sort()).toEqual(['restore-pending.bin', 'restore-pending.bin.part']);
        expect(statSync(path.join(d.restore, 'restore-pending.bin')).size).toBe(7 * K + 1);
        expect(statSync(path.join(d.restore, 'restore-pending.bin.part')).size).toBe(14 * K);
        // Only regular files: a directory under the pending name goes, marker or not.
        rmSync(path.join(d.restore, 'restore-pending.bin'));
        mkdirSync(path.join(d.restore, 'restore-pending.bin'));
        await installStaged(t.opts({ apiDirs: d, stopApi: () => true }));
        expect(readdirSync(d.restore)).toEqual(['restore-pending.bin.part']);
    });

    it('a newest backup larger than the budget goes too (the API never writes one); older ones that fit stay (verify 4, the director\'s hard cap)', async () => {
        const t = setUp();
        const { d } = planted();
        writeFileSync(path.join(d.backups, 'bv-20260903T000000Z.bin'), Buffer.alloc(7 * K + 1));
        const resultFile = path.join(dir, `result-${n}.json`);
        await installStaged(t.opts({ apiDirs: d, resultFile, stopApi: () => true }));
        expect(readdirSync(d.backups).sort()).toEqual(['bv-20260901T000000Z.bin', 'bv-20260902T000000Z.bin']);
        expect((JSON.parse(readFileSync(resultFile, 'utf8')) as { cleanup: string }).cleanup).toContain('1 backup past the budget');
    });

    it('root\'s step and the API\'s rotation keep the same backups from the same files (backupsPastBudget)', async () => {
        const files: [string, number][] = [
            ['bv-20260901T000000Z.bin', 3 * K], ['bv-20260902T000000Z.bin', 3 * K], ['bv-20260903T000000Z.bin', 7 * K + 1], ['bv-20260904T000000Z.bin', 3 * K],
        ];
        // The API: 0904 is the backup it writes, into a store holding the rest.
        const store = path.join(dir, `store-${++n}`);
        mkdirSync(store);
        for (const [name, size] of files.slice(0, 3)) writeFileSync(path.join(store, name), Buffer.alloc(size));
        await new LocalDirectoryStore(store, { maxBytes: 7 * K }).put(files[3][0], Buffer.alloc(files[3][1]));
        // Root: the same four files.
        const base = path.join(dir, `api-${++n}`);
        const d: ApiDirs = {
            releases: path.join(base, 'releases'), backups: path.join(base, 'backups'), restore: path.join(base, 'restore'), backupMaxBytes: 7 * K,
            restoreMarker: path.join(base, 'keyholder', 'restore-pending.json'),
        };
        mkdirSync(d.backups, { recursive: true });
        for (const [name, size] of files) writeFileSync(path.join(d.backups, name), Buffer.alloc(size));
        clearApiDirs(d, () => undefined);
        // The one past the budget on its own goes; of the rest, the newest two fit together, the oldest doesn't.
        const kept = ['bv-20260902T000000Z.bin', 'bv-20260904T000000Z.bin'];
        expect({ api: readdirSync(store).sort(), root: readdirSync(d.backups).sort() }).toEqual({ api: kept, root: kept });
    });

    it('many empty files under backup names: no more than MAX_BACKUP_FILES stay, the oldest go (confirm 5, NB-1: they cost no bytes, but inodes)', async () => {
        const t = setUp();
        const { d } = planted();
        const cap = 1000;
        // The planted three (0901-0903), and cap + 2 empty ones newer than them, in one second.
        for (let i = 1; i <= cap + 2; i++) writeFileSync(path.join(d.backups, `bv-20260906T000000Z-${i}.bin`), '');
        await installStaged(t.opts({ apiDirs: d, stopApi: () => true }));
        const left = readdirSync(d.backups).filter(f => f.startsWith('bv-'));
        // The newest 1,000 (MAX_BACKUP_FILES) stay: the empty ones from the highest suffix down. The two oldest of
        // them and the planted three go.
        expect(left).toHaveLength(cap);
        expect(left).toContain(`bv-20260906T000000Z-${cap + 2}.bin`);
        expect(left).toContain('bv-20260906T000000Z-3.bin');
        for (const gone of ['bv-20260906T000000Z-2.bin', 'bv-20260906T000000Z-1.bin', 'bv-20260903T000000Z.bin']) expect(left).not.toContain(gone);
        expect(MAX_BACKUP_FILES).toBe(cap);
    });

    it('a backup named later than the one the API writes (planted, or the clock set back): both sides drop it and keep the one written (confirm 5, NB-2)', async () => {
        // 0910 is named later than 0904, which the API writes on 5 September; 0910 and 0904 don't fit together.
        const files: [string, number][] = [['bv-20260901T000000Z.bin', 3 * K], ['bv-20260910T000000Z.bin', 5 * K], ['bv-20260904T000000Z.bin', 3 * K]];
        const store = path.join(dir, `store-${++n}`);
        mkdirSync(store);
        for (const [name, size] of files.slice(0, 2)) writeFileSync(path.join(store, name), Buffer.alloc(size));
        await new LocalDirectoryStore(store, { maxBytes: 7 * K }).put(files[2][0], Buffer.alloc(files[2][1]));
        const base = path.join(dir, `api-${++n}`);
        const d: ApiDirs = {
            releases: path.join(base, 'releases'), backups: path.join(base, 'backups'), restore: path.join(base, 'restore'), backupMaxBytes: 7 * K,
            restoreMarker: path.join(base, 'keyholder', 'restore-pending.json'),
        };
        mkdirSync(d.backups, { recursive: true });
        for (const [name, size] of files) writeFileSync(path.join(d.backups, name), Buffer.alloc(size));
        // Root's step on 5 September, on the same files.
        clearApiDirs(d, () => undefined, Date.UTC(2026, 8, 5, 12));
        const kept = ['bv-20260901T000000Z.bin', 'bv-20260904T000000Z.bin'];
        expect({ api: readdirSync(store).sort(), root: readdirSync(d.backups).sort() }).toEqual({ api: kept, root: kept });
    });

    it('the API not stopped: nothing of its user\'s is walked into or removed whole, and the record says so', async () => {
        const t = setUp();
        const { d } = planted();
        t.stage(t.r2, t.next, [t.r1, t.r2]);
        mkdirSync(path.join(t.inbox, 'beanpool-vault_1.2.0.efi'));
        const resultFile = path.join(dir, `result-${n}.json`);
        const r = await installStaged(t.opts({ apiDirs: d, resultFile, stopApi: () => false }));
        expect(r).toMatchObject({ installed: false, reason: expect.stringContaining('more than one boot file') });
        expect(readdirSync(d.releases)).toHaveLength(4);
        expect(readdirSync(d.backups)).toHaveLength(8);
        // Its files unlinked, the directory left alone.
        expect(readdirSync(t.inbox)).toEqual(['beanpool-vault_1.2.0.efi']);
        expect(JSON.parse(readFileSync(resultFile, 'utf8'))).toMatchObject({ cleanup: 'the API could not be stopped: what it left on the state partition stays until the next restart' });
    });

    it('whether a user still runs a process is read from /proc: any of its four user ids', () => {
        const proc = path.join(dir, `proc-${++n}`);
        const status = (pid: string, uids: string) => {
            mkdirSync(path.join(proc, pid), { recursive: true });
            writeFileSync(path.join(proc, pid, 'status'), `Name:\tnode\nUmask:\t0007\nUid:\t${uids}\nGid:\t0\t0\t0\t0\n`);
        };
        status('1', '0\t0\t0\t0');
        status('20', '997\t997\t997\t997');
        status('21', '0\t0\t997\t0');
        status('22', '1997\t1997\t1997\t1997');
        mkdirSync(path.join(proc, 'self'));
        mkdirSync(path.join(proc, '23'));
        expect(processesOf(997, proc).sort((a, b) => a - b)).toEqual([20, 21]);
        expect(processesOf(998, proc)).toEqual([]);
    });
});
