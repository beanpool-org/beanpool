import crypto from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { custodianKey, type CustodianKey } from '../custodian/lib.js';
import { installForRestart, type RestartOptions } from '../install/install.js';
import { sha256Hex, type ReleaseFiles } from '../shared/release.js';
import { formatRestartRequest, RESTART_PURPOSE, signRestartRequest, type RestartRequest } from '../shared/restart-request.js';
import { stagedNames } from '../shared/staged-image.js';
import { keys3, makeRelease, type MadeRelease } from './release-kit.js';

/**
 * The custodians' restart (D3, Marty 2026-10-06: nothing restarts the vault on a schedule). Root's step
 * (installForRestart) acts only on a request two custodians of the running release signed, within the hour, never
 * acted on before, naming exactly the staged release, whose image passes root's own checks; and it checks all of that
 * before it stops anything. Anything else: refused, the request removed, and the API never stopped, nothing removed,
 * nothing installed (so the caller doesn't reboot). The API's user writes the request file and the inbox, so both are
 * what a hostile API could put there.
 */

const dir = mkdtempSync(path.join(os.tmpdir(), 'bvr-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const NOW = Date.UTC(2026, 9, 6, 7);
const MIN = 60 * 1000;

function newImage() {
    const uki = crypto.randomBytes(300);
    const root = crypto.randomBytes(500);
    const verity = crypto.randomBytes(50);
    return { uki, root, verity, image: { ukiSha256: sha256Hex(uki), roothash: sha256Hex(Buffer.concat([root, verity])) } };
}

function setUp() {
    n++;
    const custodians = keys3();
    const running = newImage();
    const next = newImage();
    const r1 = makeRelease({ version: '1.0.0', previous: null, custodianKeys: custodians, signers: custodians.slice(0, 2), image: running.image });
    const r2 = makeRelease({ version: '1.1.0', previous: r1, custodianKeys: custodians, signers: custodians.slice(1), image: next.image });
    const base = path.join(dir, `t-${n}`);
    const inbox = path.join(base, 'staged');
    const requestDir = path.join(base, 'restart');
    const releases = path.join(base, 'releases');
    for (const d of [inbox, requestDir, releases, path.join(base, 'backups'), path.join(base, 'restore')]) mkdirSync(d, { recursive: true });
    const requestFile = path.join(requestDir, 'request.json');
    const calls: string[] = [];
    const opts = (over: Partial<RestartOptions> = {}): RestartOptions => ({
        requestFile, usedFile: path.join(base, 'restart-used.json'),
        inbox, transferDir: path.join(base, 'install'), workDir: path.join(base, 'install.work'), rootKeys: custodians.map(k => k.publicKey),
        runningImage: () => r1.manifest.imageHash,
        verifyRoot: async (rootFile, verityFile, roothash) => sha256Hex(Buffer.concat([readFileSync(rootFile), readFileSync(verityFile)])) === roothash,
        sysupdate: () => {
            calls.push(`sysupdate ${readdirSync(path.join(base, 'install')).sort().join(' ')}`);
            return true;
        },
        stopApi: () => {
            calls.push('stop the API');
            return true;
        },
        apiDirs: { releases, backups: path.join(base, 'backups'), restore: path.join(base, 'restore'), backupMaxBytes: 1 << 20, restoreMarker: path.join(base, 'no-marker') },
        resultFile: path.join(base, 'install-result.json'),
        clock: () => NOW,
        log: () => undefined,
        ...over,
    });
    const stage = (release: MadeRelease, img: ReturnType<typeof newImage>, chain: ReleaseFiles[], over: { uki?: Buffer } = {}) => {
        const names = stagedNames(release.manifest.version, release.manifest.image.roothash);
        writeFileSync(path.join(inbox, names.uki), over.uki ?? img.uki);
        writeFileSync(path.join(inbox, names.root), img.root);
        writeFileSync(path.join(inbox, names.verity), img.verity);
        writeFileSync(path.join(inbox, names.release), JSON.stringify({ version: release.manifest.version, imageHash: release.manifest.imageHash, chain }));
        return names;
    };
    /** The request two custodians sign for `release` (by default the staged one, signed a minute ago). */
    const request = (release: MadeRelease, over: Partial<RestartRequest> = {}): string => formatRestartRequest({
        v: 1, purpose: RESTART_PURPOSE, version: release.manifest.version, imageHash: release.manifest.imageHash,
        ukiSha256: release.manifest.image.ukiSha256, roothash: release.manifest.image.roothash, at: NOW - MIN, nonce: crypto.randomBytes(16).toString('hex'), ...over,
    });
    /** What the API writes for root (it only carries the request and the signatures it was given). */
    const send = (text: string, signers: CustodianKey[]) => writeFileSync(requestFile, JSON.stringify({ v: 1, request: text, signatures: signers.map(k => signRestartRequest(text, k.seed, k.publicKey)) }));
    /** Refused: the API never stopped, nothing installed, the staged image and the API's files where they were. */
    const keptRunning = (stagedBefore: string[]) => {
        expect(calls).toEqual([]);
        expect(existsSync(requestFile)).toBe(false);
        expect(readdirSync(inbox).sort()).toEqual(stagedBefore);
        expect(readdirSync(releases)).toEqual(['api-1.0.0.mjs']);
    };
    writeFileSync(path.join(releases, 'api-1.0.0.mjs'), 'the API\'s download');
    return { custodians, r1, r2, next, running, inbox, requestFile, calls, opts, stage, request, send, keptRunning };
}

describe('root restarts the vault only for a request two custodians signed for the staged image (D3, 2026-10-06)', () => {
    it('no request: nothing happens at all', async () => {
        const t = setUp();
        const names = t.stage(t.r2, t.next, [t.r1, t.r2]);
        expect(await installForRestart(t.opts())).toEqual({ installed: false, reason: 'no restart request' });
        t.keptRunning(Object.values(names).sort());
    });

    it('a valid request: the image is checked, then the API stops, its leftovers go, and the image is installed', async () => {
        const t = setUp();
        const names = t.stage(t.r2, t.next, [t.r1, t.r2]);
        t.send(t.request(t.r2), [t.custodians[0], t.custodians[2]]);
        expect(await installForRestart(t.opts())).toEqual({ installed: true, version: '1.1.0' });
        expect(t.calls).toEqual(['stop the API', `sysupdate ${[names.uki, names.root, names.verity].sort().join(' ')}`]);
        expect(existsSync(t.requestFile)).toBe(false);
        expect(readdirSync(t.inbox)).toEqual([]);
        expect(readdirSync(path.dirname(t.requestFile).replace(/restart$/, 'releases'))).toEqual([]);
    });

    it('one custodian\'s signature, or a second from a stranger or the API\'s own key: refused, and the vault keeps running', async () => {
        const t = setUp();
        const names = Object.values(t.stage(t.r2, t.next, [t.r1, t.r2])).sort();
        const stranger = custodianKey(crypto.randomBytes(32));
        for (const signers of [[t.custodians[1]], [t.custodians[1], stranger], [t.custodians[1], t.custodians[1]], []]) {
            t.send(t.request(t.r2), signers);
            expect(await installForRestart(t.opts())).toMatchObject({ installed: false, reason: expect.stringMatching(/signed by [01] of the running release's custodians, not 2/) });
            t.keptRunning(names);
        }
    });

    it('a stale request, one dated ahead of the clock, or a replay of one acted on: refused', async () => {
        const t = setUp();
        const names = Object.values(t.stage(t.r2, t.next, [t.r1, t.r2])).sort();
        const two = t.custodians.slice(0, 2);
        t.send(t.request(t.r2, { at: NOW - 61 * MIN }), two);
        expect(await installForRestart(t.opts())).toMatchObject({ installed: false, reason: expect.stringContaining('stale') });
        t.keptRunning(names);
        t.send(t.request(t.r2, { at: NOW + 6 * MIN }), two);
        expect(await installForRestart(t.opts())).toMatchObject({ installed: false, reason: expect.stringContaining('ahead of the vault\'s clock') });
        t.keptRunning(names);

        // Acted on once (systemd-sysupdate failed, so this image still runs and 1.1.0 is still newer) ...
        const once = t.request(t.r2);
        t.send(once, two);
        expect(await installForRestart(t.opts({ sysupdate: () => false }))).toEqual({ installed: false, reason: 'systemd-sysupdate failed' });
        // ... the same request again, within its hour, with the image staged again: refused as a replay.
        t.calls.length = 0;
        t.stage(t.r2, t.next, [t.r1, t.r2]);
        t.send(once, two);
        expect(await installForRestart(t.opts({ clock: () => NOW + 30 * MIN }))).toMatchObject({ installed: false, reason: expect.stringContaining('a replay') });
        expect(t.calls).toEqual([]);
    });

    it('a request naming another image than the staged one, or anything else of it changed: refused', async () => {
        const t = setUp();
        const names = Object.values(t.stage(t.r2, t.next, [t.r1, t.r2])).sort();
        const other = newImage();
        const r3 = makeRelease({ version: '1.2.0', previous: t.r2, custodianKeys: t.custodians, signers: t.custodians.slice(0, 2), image: other.image });
        const two = t.custodians.slice(0, 2);
        for (const text of [t.request(r3), t.request(t.r2, { ukiSha256: other.image.ukiSha256 }), t.request(t.r2, { roothash: other.image.roothash }), t.request(t.r2, { imageHash: t.r1.manifest.imageHash })]) {
            t.send(text, two);
            expect(await installForRestart(t.opts())).toMatchObject({ installed: false, reason: expect.stringMatching(/names release 1\.[12]\.0's image, not the staged release 1\.1\.0's/) });
            t.keptRunning(names);
        }
    });

    it('a request that is not canonical, or signatures over other text: refused', async () => {
        const t = setUp();
        const names = Object.values(t.stage(t.r2, t.next, [t.r1, t.r2])).sort();
        const text = t.request(t.r2);
        const spaced = JSON.stringify(JSON.parse(text), null, 1);
        t.send(spaced, t.custodians.slice(0, 2));
        expect(await installForRestart(t.opts())).toMatchObject({ installed: false, reason: 'the restart request is not in its canonical form' });
        t.keptRunning(names);
        const sigs = t.custodians.slice(0, 2).map(k => signRestartRequest(t.request(t.r2), k.seed, k.publicKey));
        writeFileSync(t.requestFile, JSON.stringify({ v: 1, request: text, signatures: sigs }));
        expect(await installForRestart(t.opts())).toMatchObject({ installed: false, reason: expect.stringContaining('signed by 0 of') });
        t.keptRunning(names);
    });

    it('no staged image, or a staged image that fails root\'s checks, under a valid request: refused before the API is stopped', async () => {
        const t = setUp();
        t.send(t.request(t.r2), t.custodians.slice(0, 2));
        expect(await installForRestart(t.opts())).toMatchObject({ installed: false, reason: expect.stringContaining('nothing is staged') });
        t.keptRunning([]);
        const names = Object.values(t.stage(t.r2, t.next, [t.r1, t.r2], { uki: Buffer.concat([t.next.uki, Buffer.from('x')]) })).sort();
        t.send(t.request(t.r2), t.custodians.slice(0, 2));
        expect(await installForRestart(t.opts())).toMatchObject({ installed: false, reason: 'the boot file is not the one release 1.1.0 names' });
        t.keptRunning(names);
    });

    it('a request file that is a link, a directory, or too large: refused, and removed (never what a link points at)', async () => {
        const t = setUp();
        const names = Object.values(t.stage(t.r2, t.next, [t.r1, t.r2])).sort();
        const target = path.join(dir, `target-${n}`);
        const text = t.request(t.r2);
        writeFileSync(target, JSON.stringify({ v: 1, request: text, signatures: t.custodians.slice(0, 2).map(k => signRestartRequest(text, k.seed, k.publicKey)) }));
        symlinkSync(target, t.requestFile);
        expect(await installForRestart(t.opts())).toMatchObject({ installed: false, reason: expect.stringContaining('not a regular file') });
        t.keptRunning(names);
        expect(existsSync(target)).toBe(true);
        mkdirSync(path.join(t.requestFile, 'x'), { recursive: true });
        expect(await installForRestart(t.opts())).toMatchObject({ installed: false, reason: expect.stringContaining('not a regular file') });
        t.keptRunning(names);
        writeFileSync(t.requestFile, Buffer.alloc(17 * 1024, 0x20));
        expect(await installForRestart(t.opts())).toMatchObject({ installed: false, reason: expect.stringContaining('not a regular file') });
        t.keptRunning(names);
    });

    it('what root decided is left for the report, refused or installed', async () => {
        const t = setUp();
        t.stage(t.r2, t.next, [t.r1, t.r2]);
        t.send(t.request(t.r2), [t.custodians[0]]);
        await installForRestart(t.opts());
        const file = path.join(path.dirname(path.dirname(t.requestFile)), 'install-result.json');
        expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ at: NOW, installed: false, reason: expect.stringContaining('signed by 1 of') });
        t.send(t.request(t.r2), t.custodians.slice(1));
        await installForRestart(t.opts());
        expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ at: NOW, installed: true, version: '1.1.0' });
    });
});
