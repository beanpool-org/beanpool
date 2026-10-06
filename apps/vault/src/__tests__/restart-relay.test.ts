import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { askRestart, custodianKey, type CustodianKey } from '../custodian/lib.js';
import { checkRestartRequest, formatRestartRequest, RESTART_PURPOSE, signRestartRequest, type SignedRestartRequest } from '../shared/restart-request.js';
import { doGenesis, get, startVault, type VaultUnderTest } from './harness.js';
import { makeRelease, publish, randomImage, type MadeRelease } from './release-kit.js';

/**
 * The custodians' restart through the API (D3, 2026-10-06), over HTTP through the real middleware: the API only carries
 * a request two custodians signed to the file root acts on; it takes a signature only from a custodian in force, of
 * that exact text, for the image waiting here. What it writes is checked again by root (restart.test.ts); with no
 * custodian's seed, nothing the API can write passes that check. And `vault-custodian restart`, as two custodians run it.
 */

const VAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = mkdtempSync(path.join(os.tmpdir(), 'bvrr-'));
let v: VaultUnderTest | null = null;
afterEach(async () => {
    await v?.close();
    v = null;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;

async function setUp(clock?: { now: () => number; advance: (ms: number) => void }) {
    n++;
    const requestFile = path.join(dir, `restart-${n}`, 'request.json');
    mkdirSync(path.dirname(requestFile), { recursive: true });
    let waiting: { version: string; imageHash: string; staged: boolean } | null = null;
    v = await startVault({ restartRequestFile: requestFile, imageWaiting: () => waiting, ...(clock ? { clock } : {}) });
    await doGenesis(v);
    const r2 = makeRelease({ version: '1.1.0', previous: v.release as MadeRelease, custodianKeys: v.custodians, signers: v.custodians.slice(0, 2), image: randomImage() });
    publish(v.feedDir, r2);
    const vault = v;
    const request = (over: { at?: number; version?: string } = {}) => formatRestartRequest({
        v: 1, purpose: RESTART_PURPOSE, version: over.version ?? r2.manifest.version, imageHash: r2.manifest.imageHash, ukiSha256: r2.manifest.image.ukiSha256,
        roothash: r2.manifest.image.roothash, at: over.at ?? vault.clock.now(), nonce: crypto.randomBytes(16).toString('hex'),
    });
    const sign = (text: string, k: CustodianKey) => askRestart(vault.baseUrl, k, { request: text, signature: signRestartRequest(text, k.seed, k.publicKey).sig }, vault.call());
    /** Root's own check of what the API left, from the custodians' keys (as install.ts makes it). */
    const rootCheck = () => checkRestartRequest(readFileSync(requestFile, 'utf8'), {
        trusted: vault.custodians.map(c => c.publicKey), now: vault.clock.now(), used: new Set(),
        staged: { version: r2.manifest.version, imageHash: r2.manifest.imageHash, ukiSha256: r2.manifest.image.ukiSha256, roothash: r2.manifest.image.roothash },
    });
    return { v: vault, r2, requestFile, request, sign, rootCheck, wait: (w: typeof waiting) => { waiting = w; } };
}

describe('the API only carries two custodians\' restart request to root', () => {
    it('one signature waits; a second custodian\'s on the same text is written for root, and passes root\'s check', async () => {
        const t = await setUp();
        t.wait({ version: '1.1.0', imageHash: t.r2.manifest.imageHash, staged: true });
        const text = t.request();
        expect(await t.sign(text, t.v.custodians[0])).toMatchObject({ status: 200, body: { state: 'waiting', signedBy: [t.v.custodians[0].publicKey] } });
        expect(existsSync(t.requestFile)).toBe(false);
        // The same custodian twice is still one.
        expect(await t.sign(text, t.v.custodians[0])).toMatchObject({ status: 200, body: { state: 'waiting' } });
        expect(existsSync(t.requestFile)).toBe(false);
        // The second custodian sees what waits, and signs that.
        const asked = await askRestart(t.v.baseUrl, t.v.custodians[2], {}, t.v.call());
        expect(asked).toMatchObject({ status: 200, body: { imageWaiting: { version: '1.1.0', staged: true }, pending: { request: text, signedBy: [t.v.custodians[0].publicKey] } } });
        expect(await t.sign(text, t.v.custodians[2])).toMatchObject({ status: 200, body: { state: 'sent' } });
        const file = JSON.parse(readFileSync(t.requestFile, 'utf8')) as SignedRestartRequest;
        expect(file.request).toBe(text);
        expect(file.signatures.map(s => s.key).sort()).toEqual([t.v.custodians[0].publicKey, t.v.custodians[2].publicKey].sort());
        expect(t.rootCheck()).toMatchObject({ ok: true });
    });

    it('takes nothing from a stranger, a signature of other text, a request for another image, a stale one, or with no image staged', async () => {
        const t = await setUp();
        const text = t.request();
        expect(await t.sign(text, t.v.custodians[0])).toMatchObject({ status: 409, body: { code: 'no_image_waiting' } });
        t.wait({ version: '1.1.0', imageHash: t.r2.manifest.imageHash, staged: false });
        expect(await t.sign(text, t.v.custodians[0])).toMatchObject({ status: 409, body: { code: 'no_image_waiting' } });
        t.wait({ version: '1.1.0', imageHash: t.r2.manifest.imageHash, staged: true });
        const stranger = custodianKey(crypto.randomBytes(32));
        expect((await t.sign(text, stranger)).status).toBe(403);
        const other = t.request();
        const k = t.v.custodians[1];
        expect(await askRestart(t.v.baseUrl, k, { request: text, signature: signRestartRequest(other, k.seed, k.publicKey).sig }, t.v.call())).toMatchObject({ status: 400, body: { code: 'bad_signature' } });
        expect(await t.sign(t.request({ version: '1.2.0' }), k)).toMatchObject({ status: 409, body: { code: 'not_the_waiting_image' } });
        expect(await t.sign(t.request({ at: t.v.clock.now() - 61 * 60 * 1000 }), k)).toMatchObject({ status: 409, body: { code: 'stale' } });
        expect(await t.sign(JSON.stringify(JSON.parse(text), null, 1), k)).toMatchObject({ status: 400, body: { code: 'bad_request' } });
        expect(existsSync(t.requestFile)).toBe(false);
    });

    it('a hostile API holds no custodian seed: what it can write from one custodian\'s signature, or its own, root refuses', async () => {
        const t = await setUp();
        t.wait({ version: '1.1.0', imageHash: t.r2.manifest.imageHash, staged: true });
        const text = t.request();
        const one = signRestartRequest(text, t.v.custodians[0].seed, t.v.custodians[0].publicKey);
        const apiOwn = custodianKey(crypto.randomBytes(32));
        for (const signatures of [[one], [one, one], [one, signRestartRequest(text, apiOwn.seed, apiOwn.publicKey)], [one, { key: t.v.custodians[1].publicKey, sig: one.sig }]]) {
            writeFileSync(t.requestFile, JSON.stringify({ v: 1, request: text, signatures }));
            expect(t.rootCheck()).toMatchObject({ ok: false, reason: expect.stringContaining('signed by 1 of the running release\'s custodians, not 2') });
        }
    });

    it('/v1/report says whether the custodians\' restart is needed, and has no planned restart', async () => {
        const t = await setUp();
        const report = async () => JSON.parse((await get(t.v, '/v1/report')).body.report.text as string) as Record<string, unknown>;
        // (startVault gives no `about`: the report's own default.)
        expect(await report()).toMatchObject({ restart: { imageWaiting: null, custodianRestartNeeded: false } });
        expect(JSON.stringify(await report())).not.toContain('nextRestart');
    });
});

function keyFile(name: string, key: CustodianKey): string {
    const file = path.join(dir, name);
    writeFileSync(file, JSON.stringify({ seed: Buffer.from(key.seed).toString('hex') }));
    return file;
}

function cli(args: string[], input: string): Promise<{ code: number | null; out: string }> {
    return new Promise(resolve => {
        const child = spawn(process.execPath, ['--import', 'tsx', 'src/custodian/cli.ts', ...args], {
            cwd: VAULT_ROOT, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, VAULT_CUSTODIAN_PASSPHRASE: '' },
        });
        let out = '';
        child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
        child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
        child.stdin.end(input);
        child.once('exit', code => resolve({ code, out }));
    });
}

describe('vault-custodian restart, piped', () => {
    it('says what will happen and asks yes; "no" sends nothing; two custodians\' yes leave a request root accepts, and say how to unlock', async () => {
        const t = await setUp({ now: () => Date.now(), advance: () => undefined });
        t.wait({ version: '1.1.0', imageHash: t.r2.manifest.imageHash, staged: true });
        const rootKeys = path.join(dir, `root-${n}.json`);
        writeFileSync(rootKeys, JSON.stringify({ genesisCustodians: t.v.custodians.map(c => c.publicKey) }));
        const flags = (i: number) => ['restart', '--url', t.v.baseUrl, '--key', keyFile(`k-${n}-${i}.json`, t.v.custodians[i]), '--feed-dir', t.v.feedDir, '--root-keys', rootKeys];

        const no = await cli(flags(0), 'no\n');
        expect(no.code, no.out).toBe(1);
        expect(no.out).toContain('This restarts the vault to install release 1.1.0');
        expect(no.out).toContain('the vault stays LOCKED until two custodians unlock it');
        expect(no.out).toContain('Not signed. Nothing was sent.');
        expect((await askRestart(t.v.baseUrl, t.v.custodians[0], {}, t.v.call())).body.pending).toBeNull();

        const first = await cli(flags(0), 'yes\n');
        expect(first.code, first.out).toBe(0);
        expect(first.out).toContain('You sign first');
        expect(first.out).toContain('Signed. Waiting for a second custodian');
        expect(existsSync(t.requestFile)).toBe(false);

        const second = await cli(flags(1), 'yes\n');
        expect(second.code, second.out).toBe(0);
        expect(second.out).toContain('yours is the second signature');
        expect(second.out).toContain('Watch for it coming back LOCKED');
        expect(second.out).toContain(`vault-custodian unlock --url ${t.v.baseUrl} --key <key file> --share <share file>`);
        expect(t.rootCheck()).toMatchObject({ ok: true });
    }, 60_000);

    it('with no image waiting, nothing is asked and nothing sent', async () => {
        const t = await setUp({ now: () => Date.now(), advance: () => undefined });
        const rootKeys = path.join(dir, `root-${n}.json`);
        writeFileSync(rootKeys, JSON.stringify({ genesisCustodians: t.v.custodians.map(c => c.publicKey) }));
        const r = await cli(['restart', '--url', t.v.baseUrl, '--key', keyFile(`k-${n}.json`, t.v.custodians[0]), '--feed-dir', t.v.feedDir, '--root-keys', rootKeys], 'yes\n');
        expect(r.code, r.out).toBe(1);
        expect(r.out).toContain('No new image is waiting on the vault');
        expect(r.out).not.toContain('Type yes');
    }, 60_000);
});
