import crypto from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { stagedNames, Updater, uuidOfHex, type LauncherLink, type SwitchRequest } from '../api/updater.js';
import { installStaged } from '../install/install.js';
import { Launcher } from '../launcher/launcher.js';
import { LocalDirectoryFeed, ROOT_ASSET, UKI_ASSET, VERITY_ASSET, type ReleaseFeed } from '../shared/release-feed.js';
import { sha256Hex } from '../shared/release.js';
import { restartStatus } from '../shared/restart-request.js';
import { doGenesis, get, startVault } from './harness.js';
import { keys3, makeRelease, publish, randomImage, type MadeRelease } from './release-kit.js';

/**
 * The release check in the API (updater.ts) and the launcher's own check of a switch (launcher.ts), in process: what
 * is taken, what waits for the monthly restart, and what is never taken.
 */

const dir = mkdtempSync(path.join(os.tmpdir(), 'bvu-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;

function setUp() {
    const root = keys3();
    const feedDir = path.join(dir, `feed-${++n}`);
    const bundleA = crypto.randomBytes(64);
    const bundleB = crypto.randomBytes(64);
    const image = randomImage();
    const r1 = makeRelease({ version: '1.0.0', previous: null, custodianKeys: root, signers: root.slice(0, 2), image, apiBundleHash: sha256Hex(bundleA) });
    publish(feedDir, r1, bundleA);
    const asked: SwitchRequest[] = [];
    const launcher: LauncherLink = { requestSwitch: async req => { asked.push(req); return { ok: true }; } };
    const updater = (over: Partial<ConstructorParameters<typeof Updater>[0]> = {}) => new Updater({
        feed: new LocalDirectoryFeed(feedDir), rootKeys: root.map(k => k.publicKey), ownBundleHash: sha256Hex(bundleA),
        runningImageHash: () => r1.manifest.imageHash, releasesDir: path.join(feedDir, '..', `releases-${n}`), launcher, ...over,
    });
    return { root, feedDir, bundleA, bundleB, image, r1, asked, updater };
}

describe('the release check', () => {
    it('a newer release for this image: its bundle is checked, kept, and handed to the launcher with the chain', async () => {
        const { root, feedDir, bundleB, r1, asked, updater } = setUp();
        const r2 = makeRelease({ version: '1.0.1', previous: r1, custodianKeys: root, signers: root.slice(1), apiBundleHash: sha256Hex(bundleB) });
        publish(feedDir, r2, bundleB);
        const s = await updater().check();
        expect(s).toMatchObject({ running: { version: '1.0.0' }, newest: { version: '1.0.1' }, imageWaiting: null, handover: { ok: true, to: { version: '1.0.1' } } });
        expect(asked).toHaveLength(1);
        expect(readFileSync(asked[0].bundlePath).equals(bundleB)).toBe(true);
        expect(asked[0].chain.map(c => c.label)).toEqual(['vault-v1.0.0', 'vault-v1.0.1']);
    });

    it('a release with a new image waits for the monthly restart: nothing is handed over, and the report says so', async () => {
        const { root, feedDir, bundleB, r1, asked, updater } = setUp();
        const r2 = makeRelease({ version: '1.1.0', previous: r1, custodianKeys: root, signers: root, image: randomImage(), apiBundleHash: sha256Hex(bundleB) });
        publish(feedDir, r2, bundleB);
        const s = await updater().check();
        expect(s).toMatchObject({ running: { version: '1.0.0' }, imageWaiting: { version: '1.1.0', imageHash: r2.manifest.imageHash }, handover: null });
        expect(asked).toEqual([]);
    });

    it('never backwards, and an API that can\'t find itself in the feed takes nothing', async () => {
        const { root, feedDir, bundleA, bundleB, r1, asked, updater } = setUp();
        const r2 = makeRelease({ version: '1.0.1', previous: r1, custodianKeys: root, signers: root, apiBundleHash: sha256Hex(bundleB) });
        publish(feedDir, r2, bundleB);
        // This API is 1.0.1: 1.0.0 is older, so nothing.
        expect(await updater({ ownBundleHash: sha256Hex(bundleB) }).check()).toMatchObject({ running: { version: '1.0.1' }, handover: null });
        // An API that is no release in the feed (a withheld one, a changed file): nothing, and it says why.
        const s = await updater({ ownBundleHash: sha256Hex(Buffer.concat([bundleA, Buffer.from('x')])) }).check();
        expect(s).toMatchObject({ running: null, handover: null, note: expect.stringContaining('not a release in the feed') });
        // Built without keys (a source run): nothing at all.
        expect((await updater({ rootKeys: null }).check()).note).toMatch(/not checked/);
        expect(asked).toEqual([]);
    });

    it('a feed that can\'t be read changes nothing and says so', async () => {
        const { updater } = setUp();
        const u = updater({ feed: { list: async () => { throw new Error('offline'); }, asset: async () => new Uint8Array(), assetToFile: async () => '' } });
        expect(await u.check()).toMatchObject({ error: expect.stringContaining('offline'), handover: null });
    });
});

describe('a new image is staged for the monthly restart', () => {
    function withImage(ukiBytes: Buffer, uki = ukiBytes) {
        const t = setUp();
        const image = { ukiSha256: sha256Hex(ukiBytes), roothash: crypto.randomBytes(32).toString('hex') };
        const r2 = makeRelease({ version: '1.1.0', previous: t.r1, custodianKeys: t.root, signers: t.root, image, apiBundleHash: sha256Hex(t.bundleB) });
        const d = publish(t.feedDir, r2, t.bundleB);
        writeFileSync(path.join(d, UKI_ASSET), uki);
        writeFileSync(path.join(d, ROOT_ASSET), Buffer.from('the system partition'));
        writeFileSync(path.join(d, VERITY_ASSET), Buffer.from('its verity tree'));
        return { ...t, image, r2, stagedDir: path.join(t.feedDir, '..', `staged-${n}`) };
    }

    it('its files, checked, under the names the image\'s sysupdate transfers take; not fetched again', async () => {
        const uki = crypto.randomBytes(100);
        const { image, stagedDir, updater, asked } = withImage(uki);
        const verified: string[][] = [];
        const u = updater({ stagedDir, verifyRoot: async (root, verity, roothash) => { verified.push([path.basename(root), path.basename(verity), roothash]); return true; } });
        const s = await u.check();
        expect(s.imageWaiting).toMatchObject({ version: '1.1.0', staged: true });
        expect(asked).toEqual([]);
        const names = stagedNames('1.1.0', image.roothash);
        expect(names.root).toBe(`beanpool-vault_1.1.0_${uuidOfHex(image.roothash.slice(0, 32))}.root.raw`);
        expect(readdirSync(stagedDir).sort()).toEqual([names.uki, names.release, names.root, names.verity].sort());
        expect(readFileSync(path.join(stagedDir, names.uki)).equals(uki)).toBe(true);
        expect(verified).toEqual([[names.root, names.verity, image.roothash]]);
        // The chain up to it, for root's own check at the restart (install.ts).
        const staged = JSON.parse(readFileSync(path.join(stagedDir, names.release), 'utf8')) as { chain: { label: string }[] };
        expect(staged.chain.map(c => c.label)).toEqual(['vault-v1.0.0', 'vault-v1.1.0']);
        await u.check();
        expect(verified).toHaveLength(1);
    });

    it('a UKI that is not the one its release names, or a partition that fails its verity check: nothing stays', async () => {
        const bad = withImage(crypto.randomBytes(100), crypto.randomBytes(100));
        const s = await bad.updater({ stagedDir: bad.stagedDir, verifyRoot: async () => true }).check();
        expect(s.imageWaiting).toMatchObject({ staged: false, error: expect.stringContaining('UKI is not the one') });
        expect(existsSync(bad.stagedDir) ? readdirSync(bad.stagedDir) : []).toEqual([]);

        const tampered = withImage(crypto.randomBytes(100));
        const t = await tampered.updater({ stagedDir: tampered.stagedDir, verifyRoot: async () => false }).check();
        expect(t.imageWaiting).toMatchObject({ staged: false, error: expect.stringContaining('root hash') });
        expect(readdirSync(tampered.stagedDir)).toEqual([]);
    });
});

describe('the image staged is the one the newest release names, from the release that brought it (#1314 round 2)', () => {
    /** An image's three files, with a stand-in root hash both verifyRoot below and install.test.ts check. */
    function imageFiles() {
        const uki = crypto.randomBytes(300);
        const root = crypto.randomBytes(500);
        const verity = crypto.randomBytes(50);
        return { uki, root, verity, image: { ukiSha256: sha256Hex(uki), roothash: sha256Hex(Buffer.concat([root, verity])) } };
    }
    const verifyRoot = async (rootFile: string, verityFile: string, roothash: string) => sha256Hex(Buffer.concat([readFileSync(rootFile), readFileSync(verityFile)])) === roothash;

    function setUpImages() {
        const t = setUp();
        const stagedDir = path.join(t.feedDir, '..', `staged-${n}`);
        /** A release with a new image: its files published with it (`vault-release propose --image`). */
        const imageRelease = (version: string, previous: MadeRelease, files: ReturnType<typeof imageFiles>, bundle = crypto.randomBytes(64)) => {
            const r = makeRelease({ version, previous, custodianKeys: t.root, signers: t.root.slice(0, 2), image: files.image, apiBundleHash: sha256Hex(bundle) });
            const d = publish(t.feedDir, r, bundle);
            writeFileSync(path.join(d, UKI_ASSET), files.uki);
            writeFileSync(path.join(d, ROOT_ASSET), files.root);
            writeFileSync(path.join(d, VERITY_ASSET), files.verity);
            return r;
        };
        /** An API-only release (`--same-image`): the manifest, the signatures and its bundle; no image files. */
        const apiRelease = (version: string, previous: MadeRelease, bundle = crypto.randomBytes(64)) => {
            const r = makeRelease({ version, previous, custodianKeys: t.root, signers: t.root.slice(1), apiBundleHash: sha256Hex(bundle) });
            publish(t.feedDir, r, bundle);
            return r;
        };
        /** Root's install step at the monthly restart, on this inbox (install.ts), with a stand-in systemd-sysupdate. */
        const install = async () => {
            const transferDir = path.join(t.feedDir, '..', `install-${n}`);
            const installed: string[][] = [];
            const result = await installStaged({
                inbox: stagedDir, transferDir, workDir: `${transferDir}.work`, rootKeys: t.root.map(k => k.publicKey),
                runningImage: () => t.r1.manifest.imageHash, verifyRoot, log: () => undefined,
                sysupdate: () => { installed.push(readdirSync(transferDir).sort()); return true; },
            });
            return { result, installed };
        };
        return { ...t, stagedDir, imageRelease, apiRelease, install, check: () => t.updater({ stagedDir, verifyRoot }).check() };
    }

    it('an image release, then an API-only release: the image stays staged, and root\'s step installs it', async () => {
        const t = setUpImages();
        const b = imageFiles();
        const r2 = t.imageRelease('1.1.0', t.r1, b);
        expect((await t.check()).imageWaiting).toMatchObject({ version: '1.1.0', imageHash: r2.manifest.imageHash, staged: true });
        const names = stagedNames('1.1.0', b.image.roothash);
        const before = readdirSync(t.stagedDir).sort();
        expect(before).toEqual(Object.values(names).sort());

        // An API fix for the new image (1.1.1, no image files) before the restart: the image staged is left as it is.
        t.apiRelease('1.1.1', r2);
        const s = await t.check();
        expect(s.newest).toMatchObject({ version: '1.1.1' });
        expect(s.imageWaiting).toEqual({ version: '1.1.0', hash: r2.hash, imageHash: r2.manifest.imageHash, staged: true });
        expect(readdirSync(t.stagedDir).sort()).toEqual(before);
        expect(readFileSync(path.join(t.stagedDir, names.uki)).equals(b.uki)).toBe(true);

        const { result, installed } = await t.install();
        expect(result).toEqual({ installed: true, version: '1.1.0' });
        expect(installed).toEqual([[names.uki, names.root, names.verity].sort()]);
    });

    it('both in the feed before the first check: the image is staged from the release that brought it, under its version', async () => {
        const t = setUpImages();
        const b = imageFiles();
        const r2 = t.imageRelease('1.1.0', t.r1, b);
        t.apiRelease('1.1.2', t.apiRelease('1.1.1', r2));
        expect((await t.check()).imageWaiting).toMatchObject({ version: '1.1.0', imageHash: r2.manifest.imageHash, staged: true });
        expect((await t.install()).result).toEqual({ installed: true, version: '1.1.0' });
    });

    it('image, API-only, then a newer image: the newer image is staged, and the older one goes', async () => {
        const t = setUpImages();
        const b = imageFiles();
        const c = imageFiles();
        const r2 = t.imageRelease('1.1.0', t.r1, b);
        await t.check();
        const r3 = t.apiRelease('1.1.1', r2);
        expect((await t.check()).imageWaiting).toMatchObject({ version: '1.1.0', staged: true });
        const r4 = t.imageRelease('1.2.0', r3, c);
        expect((await t.check()).imageWaiting).toEqual({ version: '1.2.0', hash: r4.hash, imageHash: r4.manifest.imageHash, staged: true });
        expect(readdirSync(t.stagedDir).sort()).toEqual(Object.values(stagedNames('1.2.0', c.image.roothash)).sort());
        // And an API fix for that one after it changes nothing staged.
        t.apiRelease('1.2.1', r4);
        expect((await t.check()).imageWaiting).toMatchObject({ version: '1.2.0', staged: true });
        expect((await t.install()).result).toEqual({ installed: true, version: '1.2.0' });
    });

    it('an API-only release for the running image, with a newer image and its API fix after it: the handover and the staging both happen', async () => {
        const t = setUpImages();
        // 1.0.1: an API fix for the image this machine runs (1.0.0's), then 1.1.0 (a new image), then 1.1.1 (its API fix).
        const r2 = t.apiRelease('1.0.1', t.r1, t.bundleB);
        const r3 = t.imageRelease('1.1.0', r2, imageFiles());
        t.apiRelease('1.1.1', r3);
        const s = await t.check();
        expect(s).toMatchObject({ running: { version: '1.0.0' }, newest: { version: '1.1.1' }, imageWaiting: { version: '1.1.0', staged: true }, handover: { ok: true, to: { version: '1.0.1' } } });
        expect(t.asked).toHaveLength(1);
        expect(readFileSync(t.asked[0].bundlePath).equals(t.bundleB)).toBe(true);
        expect((await t.install()).result).toEqual({ installed: true, version: '1.1.0' });
    });

    it('a feed cut short below the running release, or a chain naming an older image again: nothing is staged (#1314 round 3, 4138896811)', async () => {
        const t = setUpImages();
        // 1.0.1 brings image A (with its files), 1.0.2 is its API fix, 1.1.0 brings A2: this machine booted A2 and runs
        // 1.1.0's bundle.
        const a = imageFiles();
        const a2 = imageFiles();
        const bundle110 = crypto.randomBytes(64);
        const r101 = t.imageRelease('1.0.1', t.r1, a);
        const r102 = t.apiRelease('1.0.2', r101);
        const r110 = t.imageRelease('1.1.0', r102, a2, bundle110);
        const check = () => t.updater({ stagedDir: t.stagedDir, verifyRoot, ownBundleHash: sha256Hex(bundle110), runningImageHash: () => r110.manifest.imageHash }).check();
        const inbox = () => (existsSync(t.stagedDir) ? readdirSync(t.stagedDir) : []);
        expect(await check()).toMatchObject({ running: { version: '1.1.0' }, newest: { version: '1.1.0' }, imageWaiting: null });

        // The feed withholds 1.1.0: the API can't place itself, and the newest (1.0.2) names A, older than what runs.
        const withheld = path.join(t.feedDir, 'vault-v1.1.0');
        const kept = path.join(t.feedDir, '..', `withheld-${n}`);
        renameSync(withheld, kept);
        expect(await check()).toMatchObject({ running: null, newest: { version: '1.0.2' }, imageWaiting: null, note: expect.stringContaining('not a release in the feed') });
        expect(inbox()).toEqual([]);

        // Whole again, and 1.2.0 after 1.1.0 names A again (which 1.0.1 brought): older than 1.1.0, so nothing either.
        renameSync(kept, withheld);
        const r120 = makeRelease({ version: '1.2.0', previous: r110, custodianKeys: t.root, signers: t.root.slice(0, 2), image: a.image });
        publish(t.feedDir, r120);
        expect(await check()).toMatchObject({ running: { version: '1.1.0' }, newest: { version: '1.2.0' }, imageWaiting: null });
        expect(inbox()).toEqual([]);
    });
});

/** 1.0.0 runs; 1.0.1 is an API fix for its image (a handover); 1.1.0 is a new image (staged). */
function setUpInbox() {
    const t = setUp();
    const r2 = makeRelease({ version: '1.0.1', previous: t.r1, custodianKeys: t.root, signers: t.root.slice(1), apiBundleHash: sha256Hex(t.bundleB) });
    publish(t.feedDir, r2, t.bundleB);
    const uki = crypto.randomBytes(100);
    const image = { ukiSha256: sha256Hex(uki), roothash: crypto.randomBytes(32).toString('hex') };
    const r3 = makeRelease({ version: '1.1.0', previous: r2, custodianKeys: t.root, signers: t.root, image, apiBundleHash: sha256Hex(crypto.randomBytes(64)) });
    const d = publish(t.feedDir, r3);
    writeFileSync(path.join(d, UKI_ASSET), uki);
    writeFileSync(path.join(d, ROOT_ASSET), Buffer.from('the system partition'));
    writeFileSync(path.join(d, VERITY_ASSET), Buffer.from('its verity tree'));
    const stagedDir = path.join(t.feedDir, '..', `staged-${n}`);
    mkdirSync(stagedDir, { mode: 0o700 });
    const names = Object.values(stagedNames('1.1.0', image.roothash)).sort();
    return { ...t, stagedDir, names, u: t.updater({ stagedDir, verifyRoot: async () => true }) };
}

describe('the API owns its inbox: whatever is in it can\'t stop a check (#1314 round 2)', () => {
    it('a directory (one under a name it stages too, one it can\'t write), a link to a directory outside, and a directory holding a link out: all gone, what the links point at survives, the image is staged and the handover runs', async () => {
        const t = setUpInbox();
        const outside = path.join(t.feedDir, '..', `outside-${n}`);
        mkdirSync(outside);
        writeFileSync(path.join(outside, 'precious'), 'not the inbox\'s');
        // As a compromised API might leave them (the reviewer's `mkdir`, and more).
        mkdirSync(path.join(t.stagedDir, 'beanpool-vault_x', 'locked'), { recursive: true });
        writeFileSync(path.join(t.stagedDir, 'beanpool-vault_x', 'locked', 'f'), 'x');
        chmodSync(path.join(t.stagedDir, 'beanpool-vault_x', 'locked'), 0o500);
        chmodSync(path.join(t.stagedDir, 'beanpool-vault_x'), 0o500);
        mkdirSync(path.join(t.stagedDir, 'beanpool-vault_1.1.0.efi'));
        writeFileSync(path.join(t.stagedDir, 'beanpool-vault_1.1.0.efi', 'f'), 'x');
        symlinkSync(outside, path.join(t.stagedDir, 'beanpool-vault_9.9.9.efi'));
        mkdirSync(path.join(t.stagedDir, 'junk'));
        symlinkSync(outside, path.join(t.stagedDir, 'junk', 'out'));
        writeFileSync(path.join(t.stagedDir, 'stray'), 'x');

        const s = await t.u.check();
        expect(s.imageWaiting).toEqual({ version: '1.1.0', hash: expect.any(String), imageHash: expect.any(String), staged: true });
        expect(s.handover).toMatchObject({ ok: true, to: { version: '1.0.1' } });
        expect(readdirSync(t.stagedDir).sort()).toEqual(t.names);
        expect(readFileSync(path.join(outside, 'precious'), 'utf8')).toBe('not the inbox\'s');
    });

    it('an image already staged: what is put beside it (or in place of one of its files) goes at the next check', async () => {
        const t = setUpInbox();
        expect((await t.u.check()).imageWaiting).toMatchObject({ staged: true });
        mkdirSync(path.join(t.stagedDir, 'beanpool-vault_9.9.9.efi'));
        const uki = t.names.find(x => x.endsWith('.efi')) as string;
        rmSync(path.join(t.stagedDir, uki));
        mkdirSync(path.join(t.stagedDir, uki));
        expect((await t.u.check()).imageWaiting).toMatchObject({ staged: true });
        expect(readdirSync(t.stagedDir).sort()).toEqual(t.names);
        expect(statSync(path.join(t.stagedDir, uki)).isFile()).toBe(true);
    });

    // Root reads and writes past file modes: a file it can't remove can't be made there.
    it.skipIf(process.getuid?.() === 0)('an entry it can\'t remove: said in imageWaiting.error, and the handover still runs; once it can, the next check stages', async () => {
        const t = setUpInbox();
        writeFileSync(path.join(t.stagedDir, 'stray'), 'x');
        chmodSync(t.stagedDir, 0o500);
        try {
            const s = await t.u.check();
            expect(s.imageWaiting).toMatchObject({ version: '1.1.0', staged: false, error: expect.stringMatching(/^the inbox could not be cleared \(stray: EACCES\)/) });
            expect(s.handover).toMatchObject({ ok: true, to: { version: '1.0.1' } });
        } finally {
            chmodSync(t.stagedDir, 0o700);
        }
        const again = await t.u.check();
        expect(again.imageWaiting).toEqual({ version: '1.1.0', hash: expect.any(String), imageHash: expect.any(String), staged: true });
        expect(readdirSync(t.stagedDir).sort()).toEqual(t.names);
    });

    it.skipIf(process.getuid?.() === 0)('/v1/report shows it', async () => {
        const t = setUpInbox();
        const u = t.u;
        const v = await startVault({ about: () => ({ api: 'source', update: u.status, restart: restartStatus(u.status.imageWaiting) }) });
        try {
            await doGenesis(v);
            writeFileSync(path.join(t.stagedDir, 'stray'), 'x');
            chmodSync(t.stagedDir, 0o500);
            try {
                await u.check();
            } finally {
                chmodSync(t.stagedDir, 0o700);
            }
            const r = await get(v, '/v1/report');
            expect(r.status).toBe(200);
            const update = (JSON.parse(r.body.report.text as string) as { update: { imageWaiting: { staged: boolean; error: string } } }).update;
            expect(update.imageWaiting).toMatchObject({ staged: false, error: expect.stringContaining('the inbox could not be cleared (stray: EACCES)') });
        } finally {
            await v.close();
        }
    });
});

describe('room on the state partition, and what the monthly restart installed, in the report (#1314 round 2)', () => {
    it('a staging that fails for space says so, leaves no partial file, and the handover still runs', async () => {
        const t = setUpInbox();
        const feed = new LocalDirectoryFeed(t.feedDir);
        const full: ReleaseFeed = {
            list: () => feed.list(),
            asset: (r, name, max) => feed.asset(r, name, max),
            assetToFile: async (r, name, file, max) => {
                if (name !== ROOT_ASSET) return feed.assetToFile(r, name, file, max);
                // The file system fills up part way through the system partition.
                writeFileSync(`${file}.part`, 'part of it');
                throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
            },
        };
        const s = await t.updater({ feed: full, stagedDir: t.stagedDir, verifyRoot: async () => true }).check();
        expect(s.imageWaiting).toMatchObject({
            version: '1.1.0', staged: false, error: expect.stringMatching(/^no room for the image on the state partition, \d+ MiB free without it: ENOSPC/),
        });
        expect(readdirSync(t.stagedDir)).toEqual([]);
        expect(s.handover).toMatchObject({ ok: true, to: { version: '1.0.1' } });
    });

    it('a handover bundle that can\'t be kept for room says so, leaves no partial file and hands nothing over; with room, it does (#1314 round 3 note)', async () => {
        const { root, feedDir, bundleB, r1, asked, updater } = setUp();
        const r2 = makeRelease({ version: '1.0.1', previous: r1, custodianKeys: root, signers: root.slice(1), apiBundleHash: sha256Hex(bundleB) });
        publish(feedDir, r2, bundleB);
        const releasesDir = path.join(feedDir, '..', `releases-${n}`);
        // The file system fills up part way through the bundle.
        const full = (file: string, bytes: Uint8Array) => {
            writeFileSync(file, bytes.subarray(0, 10));
            throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
        };
        const s = await updater({ writeFile: full }).check();
        expect(s.error).toBe('Release 1.0.1\'s API bundle could not be kept (no room on the state partition): ENOSPC: no space left on device, write');
        expect(s.handover).toBeNull();
        expect(asked).toEqual([]);
        expect(readdirSync(path.join(releasesDir, sha256Hex(bundleB)))).toEqual([]);
        // Room again: kept, and handed over.
        const again = await updater().check();
        expect(again).toMatchObject({ error: null, handover: { ok: true, to: { version: '1.0.1' } } });
        expect(readdirSync(path.join(releasesDir, sha256Hex(bundleB)))).toEqual(['vault-api.mjs']);
    });

    it('a handover bundle whose partial file can\'t be removed: said, and the check still ends', async () => {
        const { root, feedDir, bundleB, r1, asked, updater } = setUp();
        const r2 = makeRelease({ version: '1.0.1', previous: r1, custodianKeys: root, signers: root.slice(1), apiBundleHash: sha256Hex(bundleB) });
        publish(feedDir, r2, bundleB);
        // A directory (holding something) where the partial file goes: the write fails, and so does its removal.
        const part = path.join(feedDir, '..', `releases-${n}`, sha256Hex(bundleB), 'vault-api.mjs.part');
        mkdirSync(path.join(part, 'x'), { recursive: true });
        const s = await updater().check();
        expect(s.error).toMatch(/^Release 1\.0\.1's API bundle could not be kept: EISDIR/);
        expect(asked).toEqual([]);
        expect(existsSync(part)).toBe(true);
    });

    it('/v1/report says what root\'s install step did at the last restart (installed, or why not), from the file root leaves', async () => {
        const t = setUpInbox();
        const resultFile = path.join(t.feedDir, '..', `install-result-${n}.json`);
        const u = t.updater({ stagedDir: t.stagedDir, verifyRoot: async () => true, installResultFile: resultFile });
        const v = await startVault({ about: () => ({ api: 'source', update: u.status, restart: restartStatus(u.status.imageWaiting) }) });
        try {
            await doGenesis(v);
            const lastInstall = async () => {
                await u.check();
                const r = await get(v, '/v1/report');
                return (JSON.parse(r.body.report.text as string) as { update: { lastInstall: unknown } }).update.lastInstall;
            };
            expect(await lastInstall()).toBeNull();
            writeFileSync(resultFile, JSON.stringify({ at: 1, installed: false, reason: 'no room on the state partition for root\'s copies of release 1.1.0: they need 1137 MiB and 900 MiB are free' }));
            expect(await lastInstall()).toEqual({ at: 1, installed: false, reason: expect.stringContaining('no room on the state partition') });
            writeFileSync(resultFile, JSON.stringify({ at: 2, installed: true, version: '1.1.0' }));
            expect(await lastInstall()).toEqual({ at: 2, installed: true, version: '1.1.0' });
            writeFileSync(resultFile, 'not json');
            expect(await lastInstall()).toBeNull();
        } finally {
            await v.close();
        }
    });
});

describe('the launcher checks a switch itself', () => {
    it('refuses a release outside the chain from its own keys, and a bundle that is not the one the release names', async () => {
        const { root, feedDir, bundleA, bundleB, r1 } = setUp();
        const r2 = makeRelease({ version: '1.0.1', previous: r1, custodianKeys: root, signers: root, apiBundleHash: sha256Hex(bundleB) });
        publish(feedDir, r2, bundleB);
        const file = path.join(dir, `bundle-${n}.mjs`);
        writeFileSync(file, bundleB);
        // The API in service is 1.0.0's (the image's bundle).
        const inService = path.join(dir, `bundle-${n}-a.mjs`);
        writeFileSync(inService, bundleA);
        const request = { bundlePath: file, release: r2, chain: [r1, r2] };
        const launcher = (keys: string[]) => new Launcher({
            node: process.execPath, nodeArgs: [], imageBundle: inService, apiArgs: [], rootKeys: keys, runningImage: () => r1.manifest.imageHash, log: () => undefined,
        });
        expect(launcher(root.map(k => k.publicKey)).verify(request)).toEqual({ ok: true });
        expect(launcher(keys3().map(k => k.publicKey)).verify(request)).toEqual({ ok: false, reason: 'that release is not in the chain from the pinned keys' });
        writeFileSync(file, Buffer.concat([bundleB, Buffer.from('\n')]));
        expect(launcher(root.map(k => k.publicKey)).verify(request)).toEqual({ ok: false, reason: 'the bundle is not the one its release names' });
    });

    it('never backwards: not to an older or the same release (1.1.0 to 1.0.0 was taken), and not to another image\'s', async () => {
        const { root, feedDir, bundleA, bundleB, r1 } = setUp();
        const r2 = makeRelease({ version: '1.1.0', previous: r1, custodianKeys: root, signers: root, apiBundleHash: sha256Hex(bundleB) });
        publish(feedDir, r2, bundleB);
        const a = path.join(dir, `older-${n}.mjs`);
        const b = path.join(dir, `newer-${n}.mjs`);
        writeFileSync(a, bundleA);
        writeFileSync(b, bundleB);
        const launcher = new Launcher({
            node: process.execPath, nodeArgs: [], imageBundle: a, apiArgs: [], rootKeys: root.map(k => k.publicKey), runningImage: () => r1.manifest.imageHash, log: () => undefined,
        });
        // (The API in service is named by the hash its file was checked as when it started.)
        // 1.1.0's API in service asks for 1.0.0's (the chain as it is, or cut short before 1.1.0): refused.
        expect(launcher.verify({ bundlePath: a, release: r1, chain: [r1, r2] }, sha256Hex(bundleB))).toEqual({ ok: false, reason: 'never backwards: 1.0.0 is not newer than 1.1.0' });
        expect(launcher.verify({ bundlePath: a, release: r1, chain: [r1] }, sha256Hex(bundleB))).toEqual({ ok: false, reason: 'the API in service is not a release in that chain' });
        // The same release again: refused.
        expect(launcher.verify({ bundlePath: b, release: r2, chain: [r1, r2] }, sha256Hex(bundleB))).toEqual({ ok: false, reason: 'never backwards: 1.1.0 is not newer than 1.1.0' });
        // Forwards, from 1.0.0's: taken.
        expect(launcher.verify({ bundlePath: b, release: r2, chain: [r1, r2] }, sha256Hex(bundleA))).toEqual({ ok: true });
        // A newer release for another image waits for the restart: not taken by the launcher.
        const bundleC = crypto.randomBytes(64);
        const r3 = makeRelease({ version: '1.2.0', previous: r2, custodianKeys: root, signers: root, image: randomImage(), apiBundleHash: sha256Hex(bundleC) });
        const c = path.join(dir, `other-image-${n}.mjs`);
        writeFileSync(c, bundleC);
        expect(launcher.verify({ bundlePath: c, release: r3, chain: [r1, r2, r3] }, sha256Hex(bundleB))).toEqual({ ok: false, reason: 'release 1.2.0 is for another image: it waits for the custodians\' restart' });
    });

    it('the release in service is found by bundle and booted image: two images sharing a bundle, and a chain cut short (#1314 round 3, 4138896586)', async () => {
        // 1.0.0 (image A, bundle B0) -> 1.0.1 (A, B) -> 1.0.2 (A, B2) -> 1.1.0 (A2, B): 1.1.0 is A2 built from a newer
        // snapshot with no API change, so the same bundle bytes as 1.0.1. This machine booted A2 and runs B.
        const root = keys3();
        const [b0, b, b2] = [0, 1, 2].map(() => crypto.randomBytes(64));
        const imageA = randomImage();
        const imageA2 = randomImage();
        const r100 = makeRelease({ version: '1.0.0', previous: null, custodianKeys: root, signers: root.slice(0, 2), image: imageA, apiBundleHash: sha256Hex(b0) });
        const r101 = makeRelease({ version: '1.0.1', previous: r100, custodianKeys: root, signers: root.slice(0, 2), image: imageA, apiBundleHash: sha256Hex(b) });
        const r102 = makeRelease({ version: '1.0.2', previous: r101, custodianKeys: root, signers: root.slice(0, 2), image: imageA, apiBundleHash: sha256Hex(b2) });
        const r110 = makeRelease({ version: '1.1.0', previous: r102, custodianKeys: root, signers: root.slice(0, 2), image: imageA2, apiBundleHash: sha256Hex(b) });
        const inService = path.join(dir, `a2-bundle-${++n}.mjs`);
        writeFileSync(inService, b);
        const f102 = path.join(dir, `b2-bundle-${n}.mjs`);
        writeFileSync(f102, b2);
        const booted = { image: r110.manifest.imageHash as string | null };
        const launcher = new Launcher({
            node: process.execPath, nodeArgs: [], imageBundle: inService, apiArgs: [], rootKeys: root.map(k => k.publicKey), runningImage: () => booted.image, log: () => undefined,
        });
        const ask = (chain: MadeRelease[]) => launcher.verify({ bundlePath: f102, release: r102, chain });
        // The whole chain: the API in service is 1.1.0 (bundle B on image A2), and 1.0.2 is older.
        expect(ask([r100, r101, r102, r110])).toEqual({ ok: false, reason: 'never backwards: 1.0.2 is not newer than 1.1.0' });
        // Cut at 1.0.2 (a feed withholding 1.1.0): B was 1.0.1's bundle too, but 1.0.1 is for image A, not the booted
        // one, so the API in service is not placed: refused (it was taken, 1.0.1 standing in for the release in service).
        expect(ask([r100, r101, r102])).toEqual({ ok: false, reason: 'the API in service is not a release in that chain' });
        // On image A (booted A, running 1.0.1's B), 1.0.2 is taken, and on A2 a release for A never is.
        booted.image = r101.manifest.imageHash;
        expect(ask([r100, r101, r102])).toEqual({ ok: true });
        booted.image = r110.manifest.imageHash;
        const b3 = crypto.randomBytes(64);
        const r111 = makeRelease({ version: '1.1.1', previous: r110, custodianKeys: root, signers: root.slice(0, 2), image: imageA, apiBundleHash: sha256Hex(b3) });
        const f111 = path.join(dir, `b3-bundle-${n}.mjs`);
        writeFileSync(f111, b3);
        expect(launcher.verify({ bundlePath: f111, release: r111, chain: [r100, r101, r102, r110, r111] })).toEqual({ ok: false, reason: 'release 1.1.1 is for another image: it waits for the custodians\' restart' });
        // The booted image unknown (root's file missing): nothing is switched to.
        booted.image = null;
        expect(ask([r100, r101, r102, r110])).toEqual({ ok: false, reason: 'the image this machine booted is unknown' });
    });

    it('refuses a bundle whose self-test fails or was built with other keys', async () => {
        const file = path.join(dir, 'fails.mjs');
        writeFileSync(file, 'console.log(JSON.stringify({ ok: false, failed: ["sqlite"] })); process.exit(1);\n');
        const l = new Launcher({ node: process.execPath, nodeArgs: [], imageBundle: file, apiArgs: [], rootKeys: keys3().map(k => k.publicKey), runningImage: () => null, log: () => undefined });
        expect(await l.selfTest(file)).toEqual({ ok: false, reason: 'the self-test failed: sqlite' });
        const other = path.join(dir, 'other-keys.mjs');
        writeFileSync(other, `console.log(JSON.stringify({ ok: true, rootKeys: ${JSON.stringify(keys3().map(k => k.publicKey))} }));\n`);
        expect(await l.selfTest(other)).toEqual({ ok: false, reason: 'the new API is built with other custodian keys' });
    });
});
