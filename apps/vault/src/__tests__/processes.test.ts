import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { custodianKey, genesis, presentShare } from '../custodian/lib.js';
import type { CustodianShare } from '../shared/ceremony.js';

/**
 * The two programs as they run: vault-keyholder and vault-api in their own processes (their `main.ts`, through tsx),
 * talking over the Unix socket, started with core dumps off as V3's unit will. Genesis, a keyholder restart (locked),
 * an unlock, and the keyholder refusing to start with a heap-snapshot flag. Every process here is one this test
 * started, stopped by its own PID.
 */

const VAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const children: ChildProcess[] = [];
const dir = mkdtempSync(path.join(os.tmpdir(), 'bvp-'));

afterAll(async () => {
    for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
});

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => {
            const port = (s.address() as net.AddressInfo).port;
            s.close(() => resolve(port));
        });
    });
}

interface Started {
    child: ChildProcess;
    out: () => string;
}

/** Starts `script` with `--config`, core dumps off, and resolves once it says it is listening (or rejects if it exits). */
function start(script: string, config: string, env: Record<string, string> = {}): Promise<Started> {
    const child = spawn('/bin/sh', ['-c', 'ulimit -c 0 && exec "$@"', 'sh', process.execPath, '--import', 'tsx', script, '--config', config], {
        cwd: VAULT_ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let output = '';
    child.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { output += d.toString(); });
    return new Promise((resolve, reject) => {
        const timer = setInterval(() => {
            if (output.includes('listening')) {
                clearInterval(timer);
                resolve({ child, out: () => output });
            }
        }, 50);
        child.once('exit', code => {
            clearInterval(timer);
            reject(Object.assign(new Error(`${script} exited with ${code}: ${output}`), { output, code }));
        });
    });
}

function stop(child: ChildProcess): Promise<number | null> {
    return new Promise(resolve => {
        if (child.exitCode !== null) return resolve(child.exitCode);
        child.once('exit', code => resolve(code));
        child.kill('SIGTERM');
    });
}

describe('the two programs', () => {
    it('start, genesis, restart locked, unlock', async () => {
        const custodians = [0, 1, 2].map(() => custodianKey(crypto.randomBytes(32)));
        const socketPath = path.join(dir, 'kh.sock');
        const keyholderConfig = path.join(dir, 'keyholder.json');
        const apiConfig = path.join(dir, 'api.json');
        const port = await freePort();
        writeFileSync(keyholderConfig, JSON.stringify({ stateDir: path.join(dir, 'state'), socketPath, genesisCustodians: custodians.map(c => c.publicKey) }));
        writeFileSync(apiConfig, JSON.stringify({ dataDir: path.join(dir, 'data'), keyholderSocket: socketPath, hosts: ['127.0.0.1'], backupDir: path.join(dir, 'store'), port, host: '127.0.0.1' }));

        let keyholder = await start('src/keyholder/main.ts', keyholderConfig);
        expect(keyholder.out()).toContain('vault-keyholder: fresh');
        const api = await start('src/api/main.ts', apiConfig);
        const url = `http://127.0.0.1:${port}`;
        const health = async () => (await (await fetch(`${url}/v1/health`)).json() as { state: string }).state;
        expect(await health()).toBe('locked');

        const g = await genesis(url, custodians[0], { acceptNoHardwareProof: true });
        expect(g.status).toBe(200);
        const shares = g.body.custodianShares as CustodianShare[];
        expect(await health()).toBe('open');

        expect(await stop(keyholder.child)).toBe(0);
        expect(await health()).toBe('locked');
        keyholder = await start('src/keyholder/main.ts', keyholderConfig);
        expect(keyholder.out()).toContain('vault-keyholder: locked');
        expect(await health()).toBe('locked');
        await presentShare(url, custodians[2], shares[2], { acceptNoHardwareProof: true });
        const opened = await presentShare(url, custodians[0], shares[0], { acceptNoHardwareProof: true });
        expect(opened.body.state).toBe('open');
        expect(await health()).toBe('open');

        await stop(api.child);
        await stop(keyholder.child);
    });

    it('the keyholder will not start with a flag that could dump its memory', async () => {
        const config = path.join(dir, 'keyholder-2.json');
        writeFileSync(config, JSON.stringify({ stateDir: path.join(dir, 'state-2'), socketPath: path.join(dir, 'kh2.sock'), genesisCustodians: [] }));
        const refused = await start('src/keyholder/main.ts', config, { NODE_OPTIONS: '--heapsnapshot-signal=SIGUSR2' }).then(
            () => { throw new Error('it started'); },
            (e: { output: string; code: number }) => e,
        );
        expect(refused.code).toBe(1);
        expect(refused.output).toContain('not starting');
    });
});
