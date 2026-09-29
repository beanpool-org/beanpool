import crypto from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Updater, type LauncherLink, type SwitchRequest } from '../api/updater.js';
import { Launcher } from '../launcher/launcher.js';
import { LocalDirectoryFeed } from '../shared/release-feed.js';
import { sha256Hex } from '../shared/release.js';
import { keys3, makeRelease, publish, randomImage } from './release-kit.js';

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
        const u = updater({ feed: { list: async () => { throw new Error('offline'); }, asset: async () => new Uint8Array() } });
        expect(await u.check()).toMatchObject({ error: expect.stringContaining('offline'), handover: null });
    });
});

describe('the launcher checks a switch itself', () => {
    it('refuses a release outside the chain from its own keys, and a bundle that is not the one the release names', async () => {
        const { root, feedDir, bundleB, r1 } = setUp();
        const r2 = makeRelease({ version: '1.0.1', previous: r1, custodianKeys: root, signers: root, apiBundleHash: sha256Hex(bundleB) });
        publish(feedDir, r2, bundleB);
        const file = path.join(dir, `bundle-${n}.mjs`);
        writeFileSync(file, bundleB);
        const request = { bundlePath: file, release: r2, chain: [r1, r2] };
        const launcher = (keys: string[]) => new Launcher({ node: process.execPath, nodeArgs: [], imageBundle: file, apiArgs: [], rootKeys: keys, log: () => undefined });
        expect(launcher(root.map(k => k.publicKey)).verify(request)).toEqual({ ok: true });
        expect(launcher(keys3().map(k => k.publicKey)).verify(request)).toEqual({ ok: false, reason: 'that release is not in the chain from the pinned keys' });
        writeFileSync(file, Buffer.concat([bundleB, Buffer.from('\n')]));
        expect(launcher(root.map(k => k.publicKey)).verify(request)).toEqual({ ok: false, reason: 'the bundle is not the one its release names' });
    });

    it('refuses a bundle whose self-test fails or was built with other keys', async () => {
        const file = path.join(dir, 'fails.mjs');
        writeFileSync(file, 'console.log(JSON.stringify({ ok: false, failed: ["sqlite"] })); process.exit(1);\n');
        const l = new Launcher({ node: process.execPath, nodeArgs: [], imageBundle: file, apiArgs: [], rootKeys: keys3().map(k => k.publicKey), log: () => undefined });
        expect(await l.selfTest(file)).toEqual({ ok: false, reason: 'the self-test failed: sqlite' });
        const other = path.join(dir, 'other-keys.mjs');
        writeFileSync(other, `console.log(JSON.stringify({ ok: true, rootKeys: ${JSON.stringify(keys3().map(k => k.publicKey))} }));\n`);
        expect(await l.selfTest(other)).toEqual({ ok: false, reason: 'the new API is built with other custodian keys' });
    });
});
