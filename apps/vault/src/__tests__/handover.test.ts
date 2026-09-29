import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { buildBoundRequestHeaders, ed25519Signer } from '@beanpool/core';
// @ts-expect-error: a plain .mjs build script, no types
import { bundleVault } from '../../scripts/bundle.mjs';
import { confirmShare, custodianKey, genesis } from '../custodian/lib.js';
import type { CustodianShare } from '../shared/ceremony.js';
import { API_BUNDLE_ASSET, LocalDirectoryFeed, SIGNATURES_ASSET } from '../shared/release-feed.js';
import { addSignature, formatSignatures, sha256Hex, signRelease, type ReleaseSignatures } from '../shared/release.js';
import { makeRelease, publish, randomImage } from './release-kit.js';
import { unixFetch } from './unix-fetch.js';

/**
 * A release taking over without an unlock (key vault design §3; V3's row), as it runs on the image: the bundled
 * keyholder, the launcher and the API as their own processes, the API on a Unix socket behind the symlink Caddy uses,
 * and a directory standing in for GitHub Releases. The API checks the feed every second here (hourly on the image).
 *
 * Release 1.1.0 is refused while it has one signature, while its second is from a key that isn't a custodian, and while
 * its bundle isn't the one it names. With two custodian signatures and the right bundle: the new API serves, the
 * keyholder stays unlocked, and the old API exits.
 */

const dir = mkdtempSync(path.join(os.tmpdir(), 'bvh-'));
const children: ChildProcess[] = [];
afterAll(() => {
    for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
});

interface Proc {
    child: ChildProcess;
    out: () => string;
}

function start(args: string[], until: string): Promise<Proc> {
    const child = spawn('/bin/sh', ['-c', 'ulimit -c 0 && exec "$@"', 'sh', process.execPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let output = '';
    child.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { output += d.toString(); });
    return new Promise((resolve, reject) => {
        const timer = setInterval(() => {
            if (output.includes(until)) {
                clearInterval(timer);
                resolve({ child, out: () => output });
            }
        }, 50);
        child.once('exit', code => {
            clearInterval(timer);
            reject(new Error(`${args.join(' ')} exited with ${code}: ${output}`));
        });
    });
}

function stop(child: ChildProcess): Promise<void> {
    return new Promise(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
    });
}

const alive = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 20_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn().catch(() => null);
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await new Promise(r => setTimeout(r, 100));
    }
}

describe('a release hands over the API', () => {
    it('refused with one signature, an unknown key or a changed bundle; with two, the new API serves, the keyholder stays unlocked and the old API exits', async () => {
        const custodians = [0, 1, 2].map(() => custodianKey(crypto.randomBytes(32)));
        const rootKeys = custodians.map(c => c.publicKey);
        const bundles = path.join(dir, 'bundles');
        await bundleVault({ outDir: bundles, rootKeys });
        // Release 1.1.0's API: the same program, another file (so another hash).
        const nextBundle = path.join(dir, 'next', API_BUNDLE_ASSET);
        mkdirSync(path.dirname(nextBundle), { recursive: true });
        copyFileSync(path.join(bundles, API_BUNDLE_ASSET), nextBundle);
        appendFileSync(nextBundle, '// release 1.1.0\n');
        const hashA = sha256Hex(readFileSync(path.join(bundles, API_BUNDLE_ASSET)));
        const hashB = sha256Hex(readFileSync(nextBundle));

        const image = randomImage();
        const feedDir = path.join(dir, 'feed');
        const r1 = makeRelease({ version: '1.0.0', previous: null, custodianKeys: custodians, signers: custodians.slice(0, 2), image, apiBundleHash: hashA });
        publish(feedDir, r1);
        const imageHash = r1.manifest.imageHash;

        const run = path.join(dir, 'run');
        mkdirSync(run, { recursive: true });
        const khSocket = path.join(run, 'kh.sock');
        const apiSocket = path.join(run, 'api.sock');
        const cfg = (name: string, value: unknown) => {
            const file = path.join(dir, name);
            writeFileSync(file, JSON.stringify(value));
            return file;
        };
        const kh = await start(['--disable-sigusr1', path.join(bundles, 'vault-keyholder.mjs'), '--config',
            cfg('kh.json', { stateDir: path.join(dir, 'state'), socketPath: khSocket, genesisCustodians: rootKeys, releaseHash: imageHash })], 'listening');
        const apiConfig = cfg('api.json', {
            dataDir: path.join(dir, 'data'), keyholderSocket: khSocket, hosts: ['vault.test'], backupDir: path.join(dir, 'store'), socketPath: apiSocket,
            releasesDir: path.join(dir, 'releases'), feed: { directory: feedDir }, updateCheckSeconds: 1, imageHash,
        });
        const launcher = await start([path.join(bundles, 'vault-launcher.mjs'), '--config',
            cfg('launcher.json', { apiBundle: path.join(bundles, API_BUNDLE_ASSET), apiConfig, nodeArgs: ['--disable-sigusr1'] })], 'vault-launcher: listening');
        const firstPid = Number(/started the API \(.*\) as pid (\d+)/.exec(launcher.out())?.[1]);
        expect(firstPid).toBeGreaterThan(0);

        const fetch = unixFetch(apiSocket);
        const base = 'http://vault.test';
        const getJson = async (p: string) => (await fetch(`${base}${p}`)).json() as Promise<{ report: { text: string }; state: string; release: string }>;
        const report = async () => JSON.parse((await getJson('/v1/report')).report.text as string) as { update: { checkedAt: number; refused: unknown[]; running?: { version: string } }; api: string };
        const opts = { fetch, acceptNoHardwareProof: true, trust: { feed: new LocalDirectoryFeed(feedDir), rootKeys } };

        // Genesis and the two confirmations: open.
        const g = await genesis(base, custodians[0], opts);
        expect(g.status).toBe(200);
        const shares = g.body.custodianShares as CustodianShare[];
        await confirmShare(base, custodians[0], shares[0], opts);
        expect((await confirmShare(base, custodians[1], shares[1], opts)).body.state).toBe('open');
        expect(await getJson('/v1/health')).toMatchObject({ state: 'open', release: imageHash });
        expect((await report()).api).toBe(hashA);
        await until('the API to find itself in the feed', async () => (await report()).update.running?.version === '1.0.0');

        // Release 1.1.0 with one signature: refused.
        const r2 = makeRelease({ version: '1.1.0', previous: r1, custodianKeys: custodians, signers: [], apiBundleHash: hashB });
        const r2dir = publish(feedDir, r2, readFileSync(nextBundle));
        const setSigners = (signers: { seed: Uint8Array; publicKey: string }[]) => {
            let sigs: ReleaseSignatures | null = null;
            for (const s of signers) sigs = addSignature(r2.manifestText, sigs, signRelease(r2.manifestText, s.seed, s.publicKey));
            writeFileSync(path.join(r2dir, SIGNATURES_ASSET), formatSignatures(sigs as ReleaseSignatures));
        };
        // Refused by a check that started after the change (an earlier refusal with the same words doesn't count).
        const refusedFor = (reason: RegExp) => {
            const changedAt = Date.now();
            return until(`1.1.0 refused: ${reason}`, async () => {
                const u = (await report()).update;
                return u.checkedAt > changedAt && (u.refused as { release: string; reason: string }[]).some(r => r.release === 'vault-v1.1.0' && reason.test(r.reason)) && u;
            });
        };
        setSigners([custodians[1]]);
        await refusedFor(/one custodian signature/);
        // One custodian and a stranger: refused.
        setSigners([custodians[1], custodianKey(crypto.randomBytes(32))]);
        await refusedFor(/one custodian signature/);
        // Two custodians, but the bundle in the feed is not the one the manifest names: refused.
        setSigners([custodians[0], custodians[2]]);
        appendFileSync(path.join(r2dir, API_BUNDLE_ASSET), '// changed\n');
        await refusedFor(/not the one its manifest names/);
        expect((await report()).api).toBe(hashA);
        expect(alive(firstPid)).toBe(true);
        expect(existsSync(path.join(dir, 'releases', hashB))).toBe(false);

        // The right bundle: the new API takes over.
        copyFileSync(nextBundle, path.join(r2dir, API_BUNDLE_ASSET));
        await until('the new API to serve', async () => (await report()).api === hashB);
        const secondPid = Number([...launcher.out().matchAll(/switching: started .* as pid (\d+)/g)].pop()?.[1]);
        expect(secondPid).not.toBe(firstPid);
        await until('the old API to exit', async () => !alive(firstPid));
        expect(alive(secondPid)).toBe(true);

        // The keyholder never restarted and is still open: the new API serves a signed request without any unlock.
        expect(kh.child.exitCode).toBeNull();
        expect(await getJson('/v1/health')).toMatchObject({ state: 'open', release: imageHash });
        const member = crypto.randomBytes(32);
        const key = Buffer.from(ed25519.getPublicKey(member)).toString('hex');
        const body = JSON.stringify({ purpose: 'deposit', provider: 'google' });
        const headers = await buildBoundRequestHeaders({ method: 'POST', url: `${base}/v1/ticket`, body, publicKeyHex: key, sign: ed25519Signer(member) });
        const ticket = await fetch(`${base}/v1/ticket`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body });
        expect(ticket.status).toBe(200);
        expect(kh.out()).not.toContain('locked, listening on');
        const after = await until('the new API to know it is 1.1.0', async () => {
            const r = await report();
            return r.update.running?.version === '1.1.0' && r;
        });
        expect(after.api).toBe(hashB);

        await stop(launcher.child);
        await stop(kh.child);
        expect(alive(secondPid)).toBe(false);
    }, 120_000);
});

describe('the API knows which image booted from the file root leaves (the image\'s config: no imageHash)', () => {
    it('file missing: a plain "unknown", nothing handed over; once root\'s file is there: it finds itself in the feed and hands over', async () => {
        const custodians = [0, 1, 2].map(() => custodianKey(crypto.randomBytes(32)));
        const rootKeys = custodians.map(c => c.publicKey);
        const base3 = path.join(dir, 'b3');
        const bundles = path.join(base3, 'bundles');
        await bundleVault({ outDir: bundles, rootKeys });
        const nextBundle = path.join(base3, 'next', API_BUNDLE_ASSET);
        mkdirSync(path.dirname(nextBundle), { recursive: true });
        copyFileSync(path.join(bundles, API_BUNDLE_ASSET), nextBundle);
        appendFileSync(nextBundle, '// release 1.1.0\n');
        const hashA = sha256Hex(readFileSync(path.join(bundles, API_BUNDLE_ASSET)));
        const hashB = sha256Hex(readFileSync(nextBundle));

        const image = randomImage();
        const feedDir = path.join(base3, 'feed');
        const r1 = makeRelease({ version: '1.0.0', previous: null, custodianKeys: custodians, signers: custodians.slice(0, 2), image, apiBundleHash: hashA });
        publish(feedDir, r1);
        const imageHash = r1.manifest.imageHash;
        // What `vault-keyholder --identify` leaves in /run on the image.
        const identity = `${JSON.stringify({ ok: true, image: { ...image, imageHash, ukiPath: '/boot/EFI/Linux/beanpool-vault_1.0.0.efi' } })}\n`;
        const khIdentity = path.join(base3, 'kh-image.json');
        writeFileSync(khIdentity, identity);
        const apiIdentity = path.join(base3, 'api-image.json');

        const run = path.join(base3, 'run');
        mkdirSync(run, { recursive: true });
        const khSocket = path.join(run, 'kh.sock');
        const apiSocket = path.join(run, 'api.sock');
        const cfg = (name: string, value: unknown) => {
            const file = path.join(base3, name);
            writeFileSync(file, JSON.stringify(value));
            return file;
        };
        const kh = await start(['--disable-sigusr1', path.join(bundles, 'vault-keyholder.mjs'), '--config',
            cfg('kh.json', { stateDir: path.join(base3, 'state'), socketPath: khSocket, genesisCustodians: rootKeys, imageIdentityFile: khIdentity })], 'listening');
        const apiConfig = cfg('api.json', {
            dataDir: path.join(base3, 'data'), keyholderSocket: khSocket, hosts: ['vault.test'], backupDir: path.join(base3, 'store'), socketPath: apiSocket,
            releasesDir: path.join(base3, 'releases'), feed: { directory: feedDir }, updateCheckSeconds: 1, imageIdentityFile: apiIdentity,
        });
        const launcher = await start([path.join(bundles, 'vault-launcher.mjs'), '--config',
            cfg('launcher.json', { apiBundle: path.join(bundles, API_BUNDLE_ASSET), apiConfig, nodeArgs: ['--disable-sigusr1'] })], 'vault-launcher: listening');
        const firstPid = Number(/started the API \(.*\) as pid (\d+)/.exec(launcher.out())?.[1]);

        const fetch = unixFetch(apiSocket);
        const base = 'http://vault.test';
        type Update = { checkedAt: number; image: string | null; note: string | null; running: { version: string } | null; handover: unknown };
        const report = async () => JSON.parse(((await (await fetch(`${base}/v1/report`)).json()) as { report: { text: string } }).report.text) as { update: Update; api: string };
        const opts = { fetch, acceptNoHardwareProof: true, trust: { feed: new LocalDirectoryFeed(feedDir), rootKeys } };
        const g = await genesis(base, custodians[0], opts);
        expect(g.status).toBe(200);
        const shares = g.body.custodianShares as CustodianShare[];
        await confirmShare(base, custodians[0], shares[0], opts);
        expect((await confirmShare(base, custodians[1], shares[1], opts)).body.state).toBe('open');

        // Release 1.1.0 for the same image, two-signed, with its bundle: taken only by an API that knows its image.
        const r2 = makeRelease({ version: '1.1.0', previous: r1, custodianKeys: custodians, signers: custodians.slice(1), apiBundleHash: hashB });
        publish(feedDir, r2, readFileSync(nextBundle));

        // Root's file is missing: the image is unknown, said plainly, and nothing is handed over, check after check.
        const since = Date.now();
        const unknown = await until('checks without the file', async () => {
            const u = (await report()).update;
            return u.checkedAt > since + 2000 && u;
        });
        expect(unknown).toMatchObject({ image: null, running: null, handover: null, note: 'The booted image is unknown: no handover.' });
        expect((await report()).api).toBe(hashA);
        expect(alive(firstPid)).toBe(true);
        expect(launcher.out()).not.toContain('switching');

        // Root's file appears (the API reads it at every check): the API finds itself (1.0.0) and hands over to 1.1.0,
        // whose API starts with the file there and knows its image at once.
        writeFileSync(apiIdentity, identity);
        await until('the new API to serve', async () => (await report()).api === hashB, 30_000);
        const after = await until('the new API to know it is 1.1.0', async () => {
            const r = await report();
            return r.update.running?.version === '1.1.0' && r;
        });
        expect(after.update).toMatchObject({ image: imageHash, note: null });
        await until('the old API to exit', async () => !alive(firstPid));

        await stop(launcher.child);
        await stop(kh.child);
    }, 120_000);
});
