import crypto from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { custodianKey } from '../custodian/lib.js';
import { sealKeyFile } from '../custodian/keyfile.js';
import { NO_HARDWARE_PROOF } from '../custodian/checker.js';
import { SIGNATURES_ASSET } from '../shared/release-feed.js';
import { get, startVault, type VaultUnderTest } from './harness.js';
import { makeRelease, publish } from './release-kit.js';
// @ts-expect-error: a plain .mjs build script, no types
import { bundleVault } from '../../scripts/bundle.mjs';

/**
 * The bundled custodian tool on a real terminal (a pty, driven by `expect`), as a custodian types into it. Piped stdin
 * (cli.test.ts) never takes the hidden passphrase read, so only a pty shows what follows it: the yes typed after the
 * passphrase is read and acted on, a "no" stops with a non-zero exit and nothing done, and Ctrl-C at the passphrase
 * leaves the terminal as it was (echo and line editing back) and exits non-zero. Before the fix the tool exited 0,
 * silently, right after "Type yes to go on:" (BLOCKERS.md §0).
 */

const hasExpect = spawnSync('sh', ['-c', 'command -v expect'], { stdio: 'ignore' }).status === 0;
if (!hasExpect && process.env.CI) throw new Error('expect is missing on CI: the custodian terminal test must run there (ci.yml installs it).');
if (!hasExpect) console.warn('cli-terminal.test.ts skipped: `expect` is not installed (brew/apt install expect to run it).');

const PASS = 'correct horse battery';
const dir = mkdtempSync(path.join(os.tmpdir(), 'bvt-'));
const custodians = [0, 1, 2].map(() => custodianKey(crypto.randomBytes(32)));
const keys = custodians.map((c, i) => {
    const file = path.join(dir, `key-${i}.json`);
    writeFileSync(file, sealKeyFile(c.seed, PASS), { mode: 0o600 });
    return file;
});
const tool = path.join(dir, 'bundles', 'vault-custodian.mjs');
let v: VaultUnderTest | null = null;

beforeAll(async () => {
    if (hasExpect) await bundleVault({ outDir: path.join(dir, 'bundles'), rootKeys: custodians.map(c => c.publicKey) });
});
afterEach(async () => {
    await v?.close();
    v = null;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Waits for the passphrase prompt, types it (or Ctrl-C mid-way), waits for the yes question and answers it. The tool runs
// under sh, which prints the terminal's settings once the tool has gone, then exits with the tool's code.
const SCRIPT = `
set timeout 60
log_user 1
spawn -noecho sh -c {node "$@"; code=$?; echo; echo "STTY-AFTER:"; stty -a; exit $code} sh {*}$argv
expect {
    -re {Passphrase for [^\\r\\n]*: $} {}
    timeout { puts "\\nPTY: no passphrase prompt"; exit 3 }
    eof { puts "\\nPTY: ended before the passphrase prompt"; exit 3 }
}
if {$env(PTY_MODE) eq "ctrlc"} {
    send -- "half\\003"
} else {
    send -- "$env(PTY_PASS)\\r"
    expect {
        -re {Type yes to go on: $} {}
        timeout { puts "\\nPTY: no yes prompt"; exit 3 }
        eof { puts "\\nPTY: ended before the yes prompt"; exit 3 }
    }
    sleep 0.3
    send -- "$env(PTY_ANSWER)\\r"
}
expect {
    eof {}
    timeout { puts "\\nPTY: did not end"; exit 3 }
}
lassign [wait] pid spawnid oserr code
puts "\\nPTY-EXIT=$code"
exit 0
`;
const scriptFile = path.join(dir, 'drive.exp');
writeFileSync(scriptFile, SCRIPT);

async function onTerminal(mode: 'yes' | 'no' | 'ctrlc', args: string[]): Promise<{ code: number; out: string; terminalRestored: boolean }> {
    const env: NodeJS.ProcessEnv = { ...process.env, PTY_MODE: mode, PTY_PASS: PASS, PTY_ANSWER: mode };
    delete env.VAULT_CUSTODIAN_PASSPHRASE;
    const out = await new Promise<string>((resolve, reject) => {
        const child = spawn('expect', ['-f', scriptFile, '--', tool, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let text = '';
        child.stdout.on('data', (d: Buffer) => { text += d.toString(); });
        child.stderr.on('data', (d: Buffer) => { text += d.toString(); });
        child.once('error', reject);
        child.once('exit', () => resolve(text));
    });
    const m = /PTY-EXIT=(\d+)/.exec(out);
    if (!m) throw new Error(`the pty run did not finish:\n${out}`);
    const stty = out.slice(out.indexOf('STTY-AFTER:'));
    return { code: Number(m[1]), out, terminalRestored: /(?<![-\w])icanon\b/.test(stty) && /(?<![-\w])echo\b/.test(stty) };
}

describe.skipIf(!hasExpect)('vault-custodian on a real terminal', () => {
    it('release sign: passphrase then "no" stops non-zero, nothing signed; Ctrl-C at the passphrase restores the terminal; passphrase then yes signs', async () => {
        const feedDir = path.join(dir, 'release-feed');
        publish(feedDir, makeRelease({ version: '1.0.0', previous: null, custodianKeys: custodians, signers: custodians.slice(0, 2) }));
        const bundle = path.join(dir, 'api-next.mjs');
        writeFileSync(bundle, 'console.log("the next API");\n');
        const proposal = path.join(dir, 'proposal');
        execFileSync(process.execPath, [tool, 'release', 'propose', '--version', '1.0.1', '--same-image', '--same-custodians', '--api-bundle', bundle, '--out', proposal, '--feed-dir', feedDir], { stdio: 'ignore' });
        const sign = ['release', 'sign', '--dir', proposal, '--key', keys[0], '--feed-dir', feedDir];
        const sigs = path.join(proposal, SIGNATURES_ASSET);

        const no = await onTerminal('no', sign);
        expect(no.code, no.out).toBe(1);
        expect(no.out).toContain('Not signed.');
        expect(no.out).not.toContain(PASS);
        expect(existsSync(sigs)).toBe(false);

        const stopped = await onTerminal('ctrlc', sign);
        expect(stopped.code, stopped.out).toBe(130);
        expect(stopped.out).toContain('Stopped (Ctrl-C)');
        expect(stopped.terminalRestored, stopped.out).toBe(true);
        expect(existsSync(sigs)).toBe(false);

        const yes = await onTerminal('yes', sign);
        expect(yes.code, yes.out).toBe(0);
        expect(yes.out).toContain('signed: 1 of 2');
        expect(yes.out).not.toContain(PASS);
        expect(yes.terminalRestored, yes.out).toBe(true);
        expect(existsSync(sigs)).toBe(true);
    });

    it('genesis under none: "no" sends nothing and exits non-zero; Ctrl-C restores the terminal; yes makes the shares and confirms its own', async () => {
        v = await startVault({ custodians, clock: { now: () => Date.now(), advance: () => undefined } });
        const out = path.join(dir, 'genesis-out');
        mkdirSync(out, { recursive: true });
        const genesis = ['genesis', '--url', v.baseUrl, '--key', keys[0], '--out', out, '--feed-dir', v.feedDir];
        const before = (await get(v, '/v1/health')).body.state;

        const no = await onTerminal('no', genesis);
        expect(no.code, no.out).toBe(1);
        expect(no.out).toContain(NO_HARDWARE_PROOF);
        expect(no.out).toContain('Nothing was sent');
        expect(readdirSync(out)).toHaveLength(0);
        expect((await get(v, '/v1/health')).body.state).toBe(before);

        const stopped = await onTerminal('ctrlc', genesis);
        expect(stopped.code, stopped.out).toBe(130);
        expect(stopped.terminalRestored, stopped.out).toBe(true);
        expect(readdirSync(out)).toHaveLength(0);

        const yes = await onTerminal('yes', genesis);
        expect(yes.code, yes.out).toBe(0);
        expect(yes.out).toMatch(/confirmed: 200 .*"switched":false/);
        expect(yes.out).not.toContain(PASS);
        expect(readdirSync(out)).toHaveLength(3);
    });
});
