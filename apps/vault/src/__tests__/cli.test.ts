import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { custodianKey, type CustodianKey } from '../custodian/lib.js';
import { get, startVault, type VaultUnderTest } from './harness.js';

/**
 * The stub custodian tool as a custodian runs it (`src/custodian/cli.ts` through tsx): every flag and file is checked
 * before anything is sent, and new shares are saved before this custodian's own is confirmed.
 */

const VAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = mkdtempSync(path.join(os.tmpdir(), 'bvc-'));
let v: VaultUnderTest | null = null;

afterEach(async () => {
    await v?.close();
    v = null;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function cli(...args: string[]): Promise<{ code: number | null; out: string }> {
    return new Promise(resolve => {
        const child = spawn(process.execPath, ['--import', 'tsx', 'src/custodian/cli.ts', ...args], { cwd: VAULT_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
        child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
        child.once('exit', code => resolve({ code, out }));
    });
}

function keyFile(name: string, key: CustodianKey): string {
    const file = path.join(dir, name);
    writeFileSync(file, JSON.stringify({ seed: Buffer.from(key.seed).toString('hex') }));
    return file;
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
                await cli('genesis', '--url', url, '--key', key, '--no-hardware-proof'),
                await cli('reshare', '--url', url, '--key', key, '--share', share, '--new-custodians', three, '--no-hardware-proof'),
                await cli('reshare', '--url', url, '--key', key, '--share', share, '--new-custodians', 'aa,bb', '--out', dir, '--no-hardware-proof'),
                await cli('unlock', '--url', url, '--key', key, '--no-hardware-proof'),
                await cli('unlock', '--url', url, '--key', key, '--share', path.join(dir, 'no-such-share.json'), '--no-hardware-proof'),
                await cli('confirm', '--url', url, '--key', key),
                await cli('fetch-share', '--url', url, '--key', key, '--out'),
            ];
            expect(runs.map(r => r.code !== 0)).toEqual(runs.map(() => true));
            expect(runs[0].out).toContain('missing --out');
            expect(runs[1].out).toContain('missing --out');
            expect(runs[2].out).toContain('--new-custodians');
            expect(runs[3].out).toContain('missing --share');
            expect(requests).toEqual([]);
        } finally {
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });

    it('genesis saves the shares and confirms its own; another custodian fetches theirs and confirms; they unlock it after a restart', async () => {
        // The tool signs with the real time, so this vault runs on it.
        v = await startVault({ clock: { now: () => Date.now(), advance: () => undefined } });
        const keys = v.custodians.map((c, i) => keyFile(`c${i}.json`, c));
        const out0 = path.join(dir, 'out-0');
        const out1 = path.join(dir, 'out-1');

        const g = await cli('genesis', '--url', v.baseUrl, '--key', keys[0], '--out', out0, '--no-hardware-proof');
        expect(g.code).toBe(0);
        expect(g.out).toMatch(/confirmed: 200 .*"switched":false/);
        expect(readdirSync(out0)).toHaveLength(3);
        expect((await get(v, '/v1/health')).body.state).toBe('locked');

        const f = await cli('fetch-share', '--url', v.baseUrl, '--key', keys[1], '--out', out1);
        expect(f.code).toBe(0);
        expect(f.out).toMatch(/confirmed: 200 .*"switched":true/);
        expect(readdirSync(out1)).toHaveLength(1);
        expect((await get(v, '/v1/health')).body.state).toBe('open');

        await v.restartKeyholder();
        const share0 = path.join(out0, readdirSync(out0).find(n => n.includes(v!.custodians[0].publicKey.slice(0, 8)))!);
        const share1 = path.join(out1, readdirSync(out1)[0]);
        expect((await cli('unlock', '--url', v.baseUrl, '--key', keys[0], '--share', share0, '--no-hardware-proof')).code).toBe(0);
        const opened = await cli('unlock', '--url', v.baseUrl, '--key', keys[1], '--share', share1, '--no-hardware-proof');
        expect(opened.out).toContain('"state":"open"');
        expect((await get(v, '/v1/health')).body.state).toBe('open');
    });
});
