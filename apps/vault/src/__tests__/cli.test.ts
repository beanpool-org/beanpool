import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { x25519 } from '@noble/curves/ed25519.js';
import { vaultB64 } from '@beanpool/core';
import { custodianKey, type CustodianKey } from '../custodian/lib.js';
import { NO_HARDWARE_PROOF } from '../custodian/checker.js';
import { API_BUNDLE_ASSET, MANIFEST_ASSET, SIGNATURES_ASSET } from '../shared/release-feed.js';
import { parseManifest, parseSignatures, sha256Hex } from '../shared/release.js';
import { doGenesis, get, startVault, type VaultUnderTest } from './harness.js';
import { makeRelease, publish } from './release-kit.js';
import { StubS3 } from './stubs.js';

/**
 * The custodian tool as a custodian runs it (`src/custodian/cli.ts` through tsx): every flag and file is checked
 * before anything is sent; the release and host checks come before any part goes; `none` asks for a typed yes; new
 * shares are saved before this custodian's own is confirmed; and a release is proposed, signed by two and verified.
 */

const VAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = mkdtempSync(path.join(os.tmpdir(), 'bvc-'));
let v: VaultUnderTest | null = null;

afterEach(async () => {
    await v?.close();
    v = null;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function cli(args: string[], opts: { input?: string; env?: Record<string, string> } = {}): Promise<{ code: number | null; out: string }> {
    return new Promise(resolve => {
        const child = spawn(process.execPath, ['--import', 'tsx', 'src/custodian/cli.ts', ...args], {
            cwd: VAULT_ROOT, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, VAULT_CUSTODIAN_PASSPHRASE: '', ...opts.env },
        });
        let out = '';
        child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
        child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
        child.stdin.end(opts.input ?? '');
        child.once('exit', code => resolve({ code, out }));
    });
}

function keyFile(name: string, key: CustodianKey): string {
    const file = path.join(dir, name);
    writeFileSync(file, JSON.stringify({ seed: Buffer.from(key.seed).toString('hex') }));
    return file;
}

function rootKeysFile(name: string, keys: CustodianKey[]): string {
    const file = path.join(dir, name);
    writeFileSync(file, JSON.stringify({ genesisCustodians: keys.map(k => k.publicKey) }));
    return file;
}

/** A vault on the real clock (the tool signs with it), and the tool's flags for its feed and keys. */
async function realTimeVault(): Promise<{ vault: VaultUnderTest; feed: string[] }> {
    const vault = await startVault({ clock: { now: () => Date.now(), advance: () => undefined } });
    return { vault, feed: ['--feed-dir', vault.feedDir, '--root-keys', rootKeysFile(`root-${crypto.randomBytes(4).toString('hex')}.json`, vault.custodians)] };
}

describe('vault-custodian', () => {
    it('sends nothing while a flag or a file it needs is missing', async () => {
        const requests: string[] = [];
        const server = http.createServer((req, res) => {
            requests.push(`${req.method} ${req.url}`);
            res.writeHead(500).end('{}');
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const key = keyFile('k.json', custodianKey(crypto.randomBytes(32)));
        const share = path.join(dir, 'share.json');
        writeFileSync(share, JSON.stringify({ v: 1, custodian: 'aa', box: {} }));
        const three = [0, 1, 2].map(() => custodianKey(crypto.randomBytes(32)).publicKey).join(',');
        try {
            const runs = [
                await cli(['genesis', '--url', url, '--key', key, '--no-hardware-proof']),
                await cli(['reshare', '--url', url, '--key', key, '--share', share, '--new-custodians', three, '--no-hardware-proof']),
                await cli(['reshare', '--url', url, '--key', key, '--share', share, '--new-custodians', 'aa,bb', '--out', dir, '--no-hardware-proof']),
                await cli(['unlock', '--url', url, '--key', key, '--no-hardware-proof']),
                await cli(['unlock', '--url', url, '--key', key, '--share', path.join(dir, 'no-such-share.json'), '--no-hardware-proof']),
                await cli(['confirm', '--url', url, '--key', key]),
                await cli(['fetch-share', '--url', url, '--key', key, '--out']),
                // Every flag there, but no pinned keys to check releases from: nothing goes.
                await cli(['unlock', '--url', url, '--key', key, '--share', share, '--no-hardware-proof']),
            ];
            expect(runs.map(r => r.code !== 0)).toEqual(runs.map(() => true));
            expect(runs[0].out).toContain('missing --out');
            expect(runs[1].out).toContain('missing --out');
            expect(runs[2].out).toContain('--new-custodians');
            expect(runs[3].out).toContain('missing --share');
            expect(runs[7].out).toContain('no pinned custodian keys');
            expect(requests).toEqual([]);
        } finally {
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });

    it('genesis saves the shares and confirms its own; another custodian fetches theirs and confirms; they unlock it after a restart', async () => {
        const { vault, feed } = await realTimeVault();
        v = vault;
        const keys = v.custodians.map((c, i) => keyFile(`c${i}.json`, c));
        const out0 = path.join(dir, 'out-0');
        const out1 = path.join(dir, 'out-1');

        const g = await cli(['genesis', '--url', v.baseUrl, '--key', keys[0], '--out', out0, '--no-hardware-proof', ...feed]);
        expect(g.code).toBe(0);
        expect(g.out).toContain('release in force: 1.0.0 (host policy: none)');
        expect(g.out).toMatch(/confirmed: 200 .*"switched":false/);
        expect(readdirSync(out0)).toHaveLength(3);
        expect((await get(v, '/v1/health')).body.state).toBe('locked');

        const f = await cli(['fetch-share', '--url', v.baseUrl, '--key', keys[1], '--out', out1]);
        expect(f.code).toBe(0);
        expect(f.out).toMatch(/confirmed: 200 .*"switched":true/);
        expect(readdirSync(out1)).toHaveLength(1);
        expect((await get(v, '/v1/health')).body.state).toBe('open');

        await v.restartKeyholder();
        const share0 = path.join(out0, readdirSync(out0).find(n => n.includes(v!.custodians[0].publicKey.slice(0, 8)))!);
        const share1 = path.join(out1, readdirSync(out1)[0]);
        expect((await cli(['unlock', '--url', v.baseUrl, '--key', keys[0], '--share', share0, '--no-hardware-proof', ...feed])).code).toBe(0);
        const opened = await cli(['unlock', '--url', v.baseUrl, '--key', keys[1], '--share', share1, '--no-hardware-proof', ...feed]);
        expect(opened.out).toContain('"state":"open"');
        expect((await get(v, '/v1/health')).body.state).toBe('open');
    });

    it('under none it shows the warning and sends the part only when the custodian types yes', async () => {
        const { vault, feed } = await realTimeVault();
        v = vault;
        const key = keyFile('w0.json', v.custodians[0]);
        const g = await cli(['genesis', '--url', v.baseUrl, '--key', key, '--out', path.join(dir, 'w-out'), '--no-hardware-proof', ...feed]);
        expect(g.code).toBe(0);
        const shares = path.join(dir, 'w-out');
        await cli(['fetch-share', '--url', v.baseUrl, '--key', keyFile('w1.json', v.custodians[1]), '--out', shares]);
        await v.restartKeyholder();
        const share0 = path.join(shares, readdirSync(shares).find(n => n.includes(v!.custodians[0].publicKey.slice(0, 8)))!);

        const no = await cli(['unlock', '--url', v.baseUrl, '--key', key, '--share', share0, ...feed], { input: 'no\n' });
        expect(no.code).toBe(1);
        expect(no.out).toContain(NO_HARDWARE_PROOF);
        expect(no.out).toContain('Nothing was sent');
        expect(v.keyholder().status().sharesPresent).toBe(0);
        const silent = await cli(['unlock', '--url', v.baseUrl, '--key', key, '--share', share0, ...feed]);
        expect(silent.code).toBe(1);
        expect(v.keyholder().status().sharesPresent).toBe(0);

        const yes = await cli(['unlock', '--url', v.baseUrl, '--key', key, '--share', share0, ...feed], { input: 'yes\n' });
        expect(yes.code).toBe(0);
        expect(yes.out).toContain(NO_HARDWARE_PROOF);
        expect(v.keyholder().status().sharesPresent).toBe(1);
    });

    it('a release naming tdx, and a vault with no evidence: refused, and the vault receives only the hello', async () => {
        const custodians = [0, 1, 2].map(() => custodianKey(crypto.randomBytes(32)));
        const h = (bytes: number) => 'cd'.repeat(bytes);
        const r = makeRelease({
            version: '2.0.0', previous: null, custodianKeys: custodians, signers: custodians.slice(0, 2),
            hostPolicy: { platform: 'tdx', mrtd: [h(48)], googleEndorsementRoot: h(32), rtmr1: h(48), rtmr2: h(48), minTeeTcbSvn: h(16), tcbStatus: ['UpToDate'], debug: false },
        });
        const feedDir = path.join(dir, 'tdx-feed');
        publish(feedDir, r);
        const requests: string[] = [];
        const server = http.createServer((req, res) => {
            requests.push(`${req.method} ${req.url}`);
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
                bootId: vaultB64(crypto.randomBytes(16)), helloPub: vaultB64(x25519.getPublicKey(crypto.randomBytes(32))),
                releaseHash: r.manifest.imageHash, platform: 'tdx', evidence: null,
            }));
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const share = path.join(dir, 'tdx-share.txt');
        writeFileSync(share, JSON.stringify({ v: 1, custodian: custodians[0].publicKey, box: {} }));
        try {
            const run = await cli(['unlock', '--url', url, '--key', keyFile('t0.json', custodians[0]), '--share', share, '--no-hardware-proof',
                '--feed-dir', feedDir, '--root-keys', rootKeysFile('t-root.json', custodians)]);
            expect(run.code).toBe(1);
            expect(run.out).toContain('requires tdx evidence and the vault sent none. Nothing was sent.');
            expect(requests).toEqual(['POST /v1/unlock/hello']);
        } finally {
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });

    it('a passphrase-protected key: made by new-key, needed to sign, and a wrong one opens nothing', async () => {
        const file = path.join(dir, 'protected.json');
        const made = await cli(['new-key', '--out', file], { env: { VAULT_CUSTODIAN_PASSPHRASE: 'a long passphrase' } });
        expect(made.code).toBe(0);
        const publicKey = made.out.trim();
        expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ v: 2, publicKey });
        expect((await cli(['public-key', '--key', file])).out.trim()).toBe(publicKey);
        expect((await cli(['new-key', '--out', file], { env: { VAULT_CUSTODIAN_PASSPHRASE: 'a long passphrase' } })).out).toContain('not overwritten');
        const wrong = await cli(['release', 'sign', '--dir', dir, '--key', file, '--feed-dir', path.join(dir, 'none'), '--root-keys', rootKeysFile('p-root.json', [0, 1, 2].map(() => custodianKey(crypto.randomBytes(32))))], {
            env: { VAULT_CUSTODIAN_PASSPHRASE: 'not the passphrase' },
        });
        expect(wrong.code).not.toBe(0);
    });
});

describe('vault-custodian release', () => {
    it('propose, then two custodians sign, verify says the vault would take it; a non-signer and a stale proposal are refused', async () => {
        const custodians = [0, 1, 2].map(() => custodianKey(crypto.randomBytes(32)));
        const keys = custodians.map((c, i) => keyFile(`r${i}.json`, c));
        const feedDir = path.join(dir, 'release-feed');
        const r1 = makeRelease({ version: '1.0.0', previous: null, custodianKeys: custodians, signers: custodians.slice(0, 2) });
        publish(feedDir, r1);
        const feed = ['--feed-dir', feedDir, '--root-keys', rootKeysFile('r-root.json', custodians)];
        const bundle = path.join(dir, 'api-next.mjs');
        writeFileSync(bundle, 'console.log("the next API");\n');
        const out = path.join(dir, 'proposal');

        const proposed = await cli(['release', 'propose', '--version', '1.0.1', '--same-image', '--same-custodians', '--api-bundle', bundle, '--out', out, ...feed]);
        expect(proposed.code).toBe(0);
        const m = parseManifest(readFileSync(path.join(out, MANIFEST_ASSET), 'utf8'));
        expect(m).toMatchObject({ version: '1.0.1', previous: r1.hash, imageHash: r1.manifest.imageHash, apiBundleHash: sha256Hex(readFileSync(bundle)), hostPolicy: { platform: 'none' } });
        expect(existsSync(path.join(out, API_BUNDLE_ASSET))).toBe(true);

        const stranger = keyFile('r-stranger.json', custodianKey(crypto.randomBytes(32)));
        expect((await cli(['release', 'sign', '--dir', out, '--key', stranger, '--yes', ...feed])).out).toContain('is not one of the custodians who sign');
        expect((await cli(['release', 'sign', '--dir', out, '--key', keys[0], ...feed], { input: 'no\n' })).code).toBe(1);
        expect(existsSync(path.join(out, SIGNATURES_ASSET))).toBe(false);
        const first = await cli(['release', 'sign', '--dir', out, '--key', keys[0], ...feed], { input: 'yes\n' });
        expect(first.out).toContain('signed: 1 of 2');
        const early = await cli(['release', 'verify', '--dir', out, ...feed]);
        expect(early.code).toBe(1);
        expect(early.out).toContain('would NOT take it');
        expect((await cli(['release', 'sign', '--dir', out, '--key', keys[2], '--yes', ...feed])).out).toContain('signed: 2 of 2');
        expect(parseSignatures(readFileSync(path.join(out, SIGNATURES_ASSET), 'utf8')).signatures).toHaveLength(2);
        const verified = await cli(['release', 'verify', '--dir', out, ...feed]);
        expect(verified.code).toBe(0);
        expect(verified.out).toContain('the vault would take it');

        // Published (as a maintainer would upload the three files), status shows it; a proposal made before is stale.
        mkdirSync(path.join(feedDir, 'vault-v1.0.1'));
        cpSync(out, path.join(feedDir, 'vault-v1.0.1'), { recursive: true });
        const status = await cli(['release', 'status', ...feed]);
        expect(status.out).toContain('newest: 1.0.1');
        const stale = await cli(['release', 'sign', '--dir', out, '--key', keys[1], '--yes', ...feed]);
        expect(stale.code).toBe(1);
        expect(stale.out).toContain('it follows 1.0.0, but the newest release is 1.0.1');
    });

    it('a release with a new image takes the image build\'s image.json, and only under the version the image was built as', async () => {
        const custodians = [0, 1, 2].map(() => custodianKey(crypto.randomBytes(32)));
        const feedDir = path.join(dir, 'image-feed');
        publish(feedDir, makeRelease({ version: '1.0.0', previous: null, custodianKeys: custodians, signers: custodians.slice(0, 2) }));
        const feed = ['--feed-dir', feedDir, '--root-keys', rootKeysFile('i-root.json', custodians)];
        const bundle = path.join(dir, 'api-image.mjs');
        writeFileSync(bundle, 'console.log("api");\n');
        const image = { ukiSha256: 'aa'.repeat(32), roothash: 'bb'.repeat(32), imageHash: '57eb176c60c16bb844292af03c2115d80255728ab0ee75fed10f81bcbab76b8d' };
        const imageJson = path.join(dir, 'image.json');
        writeFileSync(imageJson, JSON.stringify({ version: '1.1.0', ...image }));
        const wrong = await cli(['release', 'propose', '--version', '1.2.0', '--image', imageJson, '--same-custodians', '--api-bundle', bundle, '--out', path.join(dir, 'p-wrong'), ...feed]);
        expect(wrong.code).not.toBe(0);
        expect(wrong.out).toContain('is image version 1.1.0');
        const right = await cli(['release', 'propose', '--version', '1.1.0', '--image', imageJson, '--same-custodians', '--api-bundle', bundle, '--out', path.join(dir, 'p-right'), ...feed]);
        expect(right.code).toBe(0);
        expect(parseManifest(readFileSync(path.join(dir, 'p-right', MANIFEST_ASSET), 'utf8'))).toMatchObject({ version: '1.1.0', imageHash: image.imageHash, image: { ukiSha256: image.ukiSha256, roothash: image.roothash } });
    });

    it('settings: a bad file goes nowhere; two custodians send the same file; backups lists both stores; watch --once says what it sees', async () => {
        const { vault, feed } = await realTimeVault();
        v = vault;
        const g = await doGenesis(v);
        const keys = v.custodians.map((c, i) => keyFile(`s${i}.json`, c));
        const s3 = await new StubS3().start();
        try {
            const file = path.join(dir, 'settings.json');
            writeFileSync(file, JSON.stringify({ v: 1, offsite: s3.settings() }));
            const bad = path.join(dir, 'bad-settings.json');
            writeFileSync(bad, JSON.stringify({ v: 1, alerts: { webhook: { url: 'http://hooks.example.org/x' } } }));
            const refused = await cli(['settings', 'send', '--url', v.baseUrl, '--key', keys[0], '--file', bad, '--no-hardware-proof', ...feed]);
            expect(refused.code).not.toBe(0);
            expect(refused.out).toContain('must be https://');

            const hash = await cli(['settings', 'hash', '--file', file]);
            const local = /^([0-9a-f]{64}) /.exec(hash.out)?.[1];
            expect(local).toBeTruthy();
            const first = await cli(['settings', 'send', '--url', v.baseUrl, '--key', keys[0], '--file', file, '--no-hardware-proof', ...feed]);
            expect(first.code).toBe(0);
            expect(first.out).toContain('Waiting for a second custodian');
            const second = await cli(['settings', 'send', '--url', v.baseUrl, '--key', keys[1], '--file', file, '--no-hardware-proof', ...feed]);
            expect(second.code).toBe(0);
            expect(second.out).toContain('"state":"in_force"');
            expect(second.out).toContain('The vault took your file as it is (the same hash).');
            expect(second.out).not.toContain(s3.secretAccessKey);

            const name = await v.api.runBackup();
            const listed = await cli(['backups', '--url', v.baseUrl, '--key', keys[2]]);
            expect(listed.out).toContain(`on the vault (1): ${name}`);
            expect(listed.out).toContain(`off the box (1): ${name}`);

            const fine = await cli(['watch', '--url', v.baseUrl, '--ticket-key', g.ticketKey, '--once']);
            expect(fine).toMatchObject({ code: 0, out: expect.stringMatching(/ open, report signed; fine/) });
            await v.restartKeyholder();
            const locked = await cli(['watch', '--url', v.baseUrl, '--ticket-key', g.ticketKey, '--once']);
            expect(locked).toMatchObject({ code: 1, out: expect.stringMatching(/ locked; problems: locked/) });
        } finally {
            await s3.stop();
        }
    });
});
