import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error: a plain .mjs build script, no types
import { bundleVault } from '../../scripts/bundle.mjs';
import { sha256Hex, type ReleaseFiles } from '../shared/release.js';
import { keys3, makeRelease, randomImage, type MadeRelease } from './release-kit.js';

/**
 * The launcher as the image runs it (#1314 round 3, 4138896272): the bundled program (`vault-launcher.mjs`, its keys
 * pinned at build), as its own process, with nothing else holding it up. Its restarts and its step back from a release
 * that keeps failing happen only while that process lives: when the API in service exits, the launcher must not exit
 * with it (on the image systemd then started a fresh launcher, with no memory of the failures, for ever).
 */

const dir = mkdtempSync(path.join(os.tmpdir(), 'bvp-'));
const children: ChildProcess[] = [];
afterAll(() => {
    for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
});

/**
 * An API bundle for `version`: passes its self-test, says it listens, and then either stays (asking for the switch in
 * `ask`, once, if that file is there) or exits after `exitAfterMs`.
 */
function fakeApi(file: string, version: string, rootKeys: string[], behaviour: { ask?: string; exitAfterMs?: number }): string {
    writeFileSync(file, `import crypto from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
if (process.argv.includes('--self-test')) {
    const own = crypto.createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
    console.log(JSON.stringify({ ok: true, rootKeys: ${JSON.stringify(rootKeys)}, bundleSha256: own }));
    process.exit(0);
}
process.on('message', m => {
    if (m && m.type === 'drain') process.exit(0);
});
process.send({ type: 'ready' });
console.log('fake-api ${version}: listening');
const ASK = ${JSON.stringify(behaviour.ask ?? null)};
if (ASK && existsSync(ASK)) {
    const { id, request } = JSON.parse(readFileSync(ASK, 'utf8'));
    unlinkSync(ASK);
    process.send({ type: 'switch', id, request });
}
const EXIT_AFTER = ${JSON.stringify(behaviour.exitAfterMs ?? null)};
if (EXIT_AFTER !== null) setTimeout(() => process.exit(3), EXIT_AFTER);
else setInterval(() => undefined, 1 << 30);
`);
    return file;
}

const files = (r: MadeRelease): ReleaseFiles => ({ manifestText: r.manifestText, signaturesText: r.signaturesText, label: r.label });

async function until(what: string, fn: () => boolean, ms = 30_000): Promise<void> {
    const end = Date.now() + ms;
    while (!fn()) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await new Promise(r => setTimeout(r, 50));
    }
}

describe('the launcher program lives through the exits of the API it runs', () => {
    it('an API that says it listens and exits: the launcher stays up, starts it again, and after three exits steps back', async () => {
        const root = keys3();
        const rootKeys = root.map(k => k.publicKey);
        const bundles = path.join(dir, 'bundles');
        await bundleVault({ outDir: bundles, rootKeys });
        const work = path.join(dir, 'work');
        mkdirSync(work);
        const ask = path.join(work, 'ask.json');
        const imageApi = fakeApi(path.join(work, 'api-1.0.0.mjs'), '1.0.0', rootKeys, { ask });
        const failing = fakeApi(path.join(work, 'api-1.0.1.mjs'), '1.0.1', rootKeys, { exitAfterMs: 300 });
        const image = randomImage();
        const r1 = makeRelease({ version: '1.0.0', previous: null, custodianKeys: root, signers: root.slice(0, 2), image, apiBundleHash: sha256Hex(readFileSync(imageApi)) });
        const r2 = makeRelease({ version: '1.0.1', previous: r1, custodianKeys: root, signers: root.slice(1), image, apiBundleHash: sha256Hex(readFileSync(failing)) });
        // The image's API asks for 1.0.1 as soon as it listens (the API's hourly check, in short).
        writeFileSync(ask, JSON.stringify({ id: 1, request: { bundlePath: failing, release: files(r2), chain: [files(r1), files(r2)] } }));
        // Which image booted, as root leaves it in /run on the image (`vault-keyholder --identify`).
        const identity = path.join(work, 'image.json');
        writeFileSync(identity, JSON.stringify({ ok: true, image: { ...image, imageHash: r1.manifest.imageHash, ukiPath: '/boot/EFI/Linux/beanpool-vault_1.0.0.efi' } }));
        const config = path.join(work, 'launcher.json');
        writeFileSync(config, JSON.stringify({ apiBundle: imageApi, apiConfig: path.join(work, 'api.json'), nodeArgs: [], imageIdentityFile: identity }));

        const launcher = spawn(process.execPath, [path.join(bundles, 'vault-launcher.mjs'), '--config', config], { stdio: ['ignore', 'pipe', 'pipe'] });
        children.push(launcher);
        let out = '';
        launcher.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
        launcher.stderr?.on('data', (d: Buffer) => { out += d.toString(); });
        const alive = () => launcher.exitCode === null && launcher.signalCode === null;
        const count = (s: string) => out.split(s).length - 1;

        // The switch to 1.0.1; the image's API drains and exits.
        await until('the switch to 1.0.1', () => out.includes(`started ${failing} as pid`) && /pid \d+ is serving/.test(out));
        // 1.0.1 exits: the launcher is still there, and starts it again after a second (the pause resets once it listens).
        await until('1.0.1 started again after its first exit', () => !alive() || count(`started the API (${failing})`) >= 1);
        expect(alive(), `the launcher exited (${launcher.exitCode ?? launcher.signalCode}) with its child:\n${out}`).toBe(true);
        expect(out).toContain('exited (3); starting it again in 1000 ms');
        await until('1.0.1 started again after its second exit', () => !alive() || count(`started the API (${failing})`) >= 2);
        expect(alive(), out).toBe(true);
        expect(count('exited (3); starting it again in 1000 ms')).toBe(2);

        // The third exit in ten minutes: back to the API in service before the switch, which listens and stays.
        await until('the step back', () => !alive() || out.includes('release 1.0.1 keeps failing'));
        expect(alive(), out).toBe(true);
        // (The API in service before the switch was the image's own.)
        expect(out).toContain('release 1.0.1 keeps failing: back to the image\'s own API; it may be taken again from ');
        await until('the image\'s API in service again', () => count(`started the API (${imageApi})`) >= 2 && count('fake-api 1.0.0: listening') >= 2);
        const pid = Number([...out.matchAll(/started the API \(.*api-1\.0\.0\.mjs\) as pid (\d+)/g)].pop()?.[1]);
        await until('it to listen', () => out.includes(`the API (pid ${pid}) is listening`));
        // It stays: nothing else is started, and the launcher lives on.
        const before = out;
        await new Promise(r => setTimeout(r, 1500));
        expect(alive(), out).toBe(true);
        expect(out.slice(before.length)).not.toMatch(/started|exited/);
        expect(count(`started the API (${failing})`)).toBe(2);

        // systemd's stop: the API goes, then the launcher.
        const code = await new Promise<number | null>(resolve => {
            launcher.once('exit', c => resolve(c));
            launcher.kill('SIGTERM');
        });
        expect(code).toBe(0);
        let apiGone = false;
        try {
            process.kill(pid, 0);
        } catch {
            apiGone = true;
        }
        expect(apiGone).toBe(true);
    }, 90_000);
});
