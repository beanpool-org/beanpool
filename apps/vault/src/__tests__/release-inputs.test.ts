import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ed25519 } from '@noble/curves/ed25519.js';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error: a plain .mjs build script, no types
import { commandText, isEd25519Point, outputLines, parseCustodianKeys, releaseInputs } from '../../image/release-inputs.mjs';

/**
 * The vault-image workflow's inputs for a release image (image/release-inputs.mjs; .github/workflows/vault-image.yml,
 * run by hand): the PUBLIC custodian list, the version, the host profile and the networks. Empty, the workflow is the
 * throwaway build it always was; given, they are checked in seconds before any build. A refusal never repeats the
 * value: it may be a key file, a seed or a passphrase pasted by mistake, and the run's log is public.
 */

const dir = mkdtempSync(path.join(os.tmpdir(), 'bvri-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const script = fileURLToPath(new URL('../../image/release-inputs.mjs', import.meta.url));

const publicKey = (seed = crypto.randomBytes(32)) => Buffer.from(ed25519.getPublicKey(seed)).toString('hex');
const KEYS = [publicKey(), publicKey(), publicKey()];
const list = (keys: unknown) => JSON.stringify({ genesisCustodians: keys });
const RELEASE = {
    custodian_keys: list(KEYS), version: '1.1.0', host: 'servury',
    network: 'static:192.0.2.10/23,192.0.2.1', network6: 'static:2001:db8:0:39c::1/64,fe80::1',
};
/** A seed (32 random bytes, hex) that is not a point on the curve: about half of them. */
function offCurveSeed() {
    for (;;) {
        const hex = crypto.randomBytes(32).toString('hex');
        if (!isEd25519Point(hex)) return hex;
    }
}
/** The thrown message, or '' when nothing was thrown. */
function refusal(f: () => unknown): string {
    try {
        f();
    } catch (e) {
        return (e as Error).message;
    }
    return '';
}

describe('the release image\'s inputs', () => {
    it('all empty (or absent) is the throwaway build: nothing to check, the release jobs do not run', () => {
        expect(releaseInputs({})).toBeNull();
        expect(releaseInputs({ custodian_keys: '', version: '', host: '', network: '', network6: '' })).toBeNull();
        expect(releaseInputs(undefined)).toBeNull();
        expect(releaseInputs({ custodian_keys: '  ', version: '\n' })).toBeNull();
    });

    it('a release: the keys in the order given, every setting, and the artifact vault-image-<version>-<host>', () => {
        expect(releaseInputs(RELEASE)).toEqual({
            keys: KEYS, version: '1.1.0', host: 'servury',
            network: 'static:192.0.2.10/23,192.0.2.1', network6: 'static:2001:db8:0:39c::1/64,fe80::1',
            artifact: 'vault-image-1.1.0-servury',
        });
        // Order is kept: the image pins the keys in this order and the reshare names them so.
        const reversed = [...KEYS].reverse();
        expect(releaseInputs({ ...RELEASE, custodian_keys: list(reversed) }).keys).toEqual(reversed);
        // Pretty-printed JSON and spaces around a value are the same list.
        expect(releaseInputs({ ...RELEASE, custodian_keys: `\n${JSON.stringify({ genesisCustodians: KEYS }, null, 2)}\n`, version: ' 1.1.0 ' }))
            .toMatchObject({ keys: KEYS, version: '1.1.0' });
    });

    it('host, network and network6 left empty are build.sh\'s defaults: none, dhcp, ra', () => {
        expect(releaseInputs({ custodian_keys: list(KEYS), version: '1.1.0' })).toEqual({
            keys: KEYS, version: '1.1.0', host: 'none', network: 'dhcp', network6: 'ra', artifact: 'vault-image-1.1.0-none',
        });
        expect(releaseInputs({ ...RELEASE, network6: '' })).toMatchObject({ network6: 'ra' });
    });

    it('settings without the custodian list, or without a version, are refused (never a throwaway image labelled as a release)', () => {
        expect(refusal(() => releaseInputs({ version: '1.1.0', host: 'servury' }))).toMatch(/custodian_keys is empty but other settings are given/);
        expect(refusal(() => releaseInputs({ network: 'static:192.0.2.10/23,192.0.2.1' }))).toMatch(/custodian_keys is empty/);
        expect(refusal(() => releaseInputs({ ...RELEASE, version: '' }))).toMatch(/version is empty/);
        for (const v of ['1.1', 'v1.1.0', '01.1.0', '1.1.0-rc1']) expect(refusal(() => releaseInputs({ ...RELEASE, version: v })), v).toMatch(/not MAJOR\.MINOR\.PATCH/);
        expect(refusal(() => releaseInputs({ ...RELEASE, version: '1.1.0\n2' }))).toMatch(/^version: not a setting/);
        expect(refusal(() => releaseInputs({ ...RELEASE, version: 110 }))).toMatch(/version: not text/);
    });

    it('the list, a key file or a key pasted into another field is refused there too, without repeating it', () => {
        const seed = crypto.randomBytes(32).toString('hex');
        const keyFile = JSON.stringify({ v: 2, publicKey: KEYS[0], ct: crypto.randomBytes(48).toString('base64url') });
        for (const name of ['version', 'host', 'network', 'network6']) {
            for (const value of [list(KEYS), keyFile, seed, seed.toUpperCase(), `static:${seed}`, 'correct horse battery staple', 'x'.repeat(101)]) {
                const message = refusal(() => releaseInputs({ ...RELEASE, [name]: value }));
                expect(message, `${name} = ${value.slice(0, 20)}`).toBe(`${name}: not a setting (letters, digits and . : / , _ - only, and never a key; the value is not repeated here)`);
            }
        }
        // A plain setting is still checked, and named, by its own check.
        expect(refusal(() => releaseInputs({ ...RELEASE, host: 'Servury' }))).toMatch(/--host "Servury"/);
    });

    it('a host, network or network6 the image build would refuse is refused here, by the same code (image-settings.mjs)', () => {
        expect(refusal(() => releaseInputs({ ...RELEASE, host: 'nosuchhost' }))).toMatch(/nosuchhost/);
        expect(refusal(() => releaseInputs({ ...RELEASE, host: '../servury' }))).not.toBe('');
        expect(refusal(() => releaseInputs({ ...RELEASE, network: 'static:192.0.2.10/23' }))).toMatch(/--network/);
        expect(refusal(() => releaseInputs({ ...RELEASE, network6: 'static:2001:db8::1/64' }))).toMatch(/--network6/);
        // Static IPv6 with DHCP IPv4: build.sh refuses it, so this does.
        expect(refusal(() => releaseInputs({ ...RELEASE, network: '' }))).toMatch(/network6 static needs network static/);
        // A gateway outside the /64 that is not link-local: refused by the image's own check (an on-link gateway like
        // that is a setting the image does not have yet).
        expect(refusal(() => releaseInputs({ ...RELEASE, network6: 'static:2001:db8:0:39c::1/64,2001:db8::1' }))).toMatch(/not inside .*nor link-local/);
    });
});

describe('the custodian list: three different PUBLIC keys and nothing else', () => {
    // Each of these must be refused, and the message must not contain the value given.
    const seed = offCurveSeed();
    const secretKey = crypto.randomBytes(32).toString('hex') + KEYS[0]; // seed ‖ public key (NaCl's 64-byte secret key)
    const keyFile = JSON.stringify({
        v: 2, publicKey: KEYS[0], kdf: { name: 'scrypt', N: 131072, r: 8, p: 1, salt: crypto.randomBytes(16).toString('base64url') },
        nonce: crypto.randomBytes(24).toString('base64url'), ct: crypto.randomBytes(48).toString('base64url'),
    });
    const pem = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const BAD: Record<string, [string, RegExp]> = {
        'two keys': [list(KEYS.slice(0, 2)), /has 2 entries, not 3/],
        'four keys': [list([...KEYS, publicKey()]), /has 4 entries, not 3/],
        'no keys': [list([]), /has 0 entries, not 3/],
        'the same key twice': [list([KEYS[0], KEYS[1], KEYS[0]]), /two of the keys are the same/],
        'upper-case hex': [list([KEYS[0].toUpperCase(), KEYS[1], KEYS[2]]), /key 1 is not 64 lower-case hex/],
        'a key one character short': [list([KEYS[0], KEYS[1].slice(1), KEYS[2]]), /key 2 is not 64 lower-case hex/],
        'a key one character long': [list([KEYS[0], KEYS[1], `${KEYS[2]}0`]), /key 3 is not 64 lower-case hex/],
        'a 0x prefix': [list([`0x${KEYS[0]}`, KEYS[1], KEYS[2]]), /key 1 is not 64 lower-case hex/],
        'a number for a key': [list([1, KEYS[1], KEYS[2]]), /key 1 is not text/],
        'a seed (not on the curve) in place of a public key': [list([KEYS[0], seed, KEYS[2]]), /key 2 is not an Ed25519 public key/],
        'a 128-hex secret key': [list([secretKey, KEYS[1], KEYS[2]]), /128 hex characters: a private key/],
        'a custodian key file': [keyFile, /custodian KEY FILE/],
        'an old key file with its seed': [JSON.stringify({ seed: crypto.randomBytes(32).toString('hex') }), /custodian KEY FILE/],
        'the list plus a passphrase': [JSON.stringify({ genesisCustodians: KEYS, passphrase: 'correct horse battery staple' }), /custodian KEY FILE/],
        'another field beside the list': [JSON.stringify({ genesisCustodians: KEYS, note: 'x' }), /2 field\(s\); the only field is genesisCustodians/],
        'another name for the list': [JSON.stringify({ custodians: KEYS }), /the only field is genesisCustodians/],
        'a PEM private key': [pem, /PEM private key/],
        'twelve words': ['abandon ability able about above absent absorb abstract absurd abuse access accident', /not JSON/],
        'a bare key': [KEYS[0], /not JSON/],
        'a bare list': [JSON.stringify(KEYS), /not a JSON object/],
        'null': ['null', /not a JSON object/],
        'the list as text': [JSON.stringify({ genesisCustodians: KEYS.join(',') }), /genesisCustodians is not a list/],
        'far too long': [JSON.stringify({ genesisCustodians: KEYS, pad: 'x'.repeat(2000) }), /far longer than three public keys/],
    };
    for (const [name, [text, why]] of Object.entries(BAD)) {
        it(`refuses ${name}, without repeating it`, () => {
            const message = refusal(() => parseCustodianKeys(text));
            expect(message).toMatch(why);
            expect(message).toMatch(/^custodian_keys: .*The value is not repeated here/);
            expect(message).not.toContain(text);
            // Not even one key's worth of it (a seed or secret inside the value).
            for (const hex of text.match(/[0-9a-fA-F]{32,}/g) ?? []) expect(message).not.toContain(hex);
            // The same refusal through the whole inputs check.
            expect(refusal(() => releaseInputs({ ...RELEASE, custodian_keys: text }))).toBe(message);
        });
    }

    it('takes three real public keys, pretty-printed or not', () => {
        expect(parseCustodianKeys(list(KEYS))).toEqual(KEYS);
        expect(parseCustodianKeys(JSON.stringify({ genesisCustodians: KEYS }, null, 4))).toEqual(KEYS);
    });

    it('the curve check agrees with @noble/curves (strict RFC 8032 decoding) on real keys, random bytes and the edge cases', () => {
        const noble = (hex: string) => {
            try {
                ed25519.Point.fromHex(hex, false);
                return true;
            } catch {
                return false;
            }
        };
        for (let i = 0; i < 200; i++) expect(isEd25519Point(publicKey())).toBe(true);
        let on = 0;
        for (let i = 0; i < 1000; i++) {
            const hex = crypto.randomBytes(32).toString('hex');
            expect(isEd25519Point(hex), hex).toBe(noble(hex));
            if (noble(hex)) on++;
        }
        // About half of random 32-byte strings are points: why a seed is caught only about half the time.
        expect(on).toBeGreaterThan(400);
        expect(on).toBeLessThan(600);
        const p = 2n ** 255n - 19n;
        const le = (n: bigint, odd = false) => {
            const b = Buffer.from(n.toString(16).padStart(64, '0'), 'hex').reverse();
            if (odd) b[31] |= 0x80;
            return b.toString('hex');
        };
        const edges = {
            'y = 1, x = 0 (the identity)': le(1n),
            'y = 1 with the odd-x bit (x = 0 has no odd root)': le(1n, true),
            'y = p - 1, x = 0': le(p - 1n),
            'y = p (not canonical)': le(p),
            'y = p + 1 (not canonical; the identity mod p)': le(p + 1n),
            'y = 2^255 - 1 (not canonical)': le(2n ** 255n - 1n),
            'y = 0': le(0n),
        };
        for (const [name, hex] of Object.entries(edges)) expect(isEd25519Point(hex), name).toBe(noble(hex));
        expect(isEd25519Point(le(p))).toBe(false);
        expect(isEd25519Point('zz'.repeat(32))).toBe(false);
    });
});

describe('release-inputs.mjs as the workflow runs it: inputs from the event file, settings to $GITHUB_OUTPUT', () => {
    const run = (inputs: unknown, args?: string[]) => {
        const event = path.join(dir, `event-${crypto.randomUUID()}.json`);
        const output = path.join(dir, `output-${crypto.randomUUID()}`);
        writeFileSync(event, JSON.stringify(inputs === undefined ? {} : { inputs }));
        writeFileSync(output, '');
        const r = spawnSync(process.execPath, [script, ...(args ?? [])], {
            encoding: 'utf8', env: { PATH: process.env.PATH ?? '', GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output },
        });
        return { status: r.status, stdout: r.stdout, stderr: r.stderr, output: readFileSync(output, 'utf8') };
    };

    it('a release: exit 0, the settings and the public keys printed, every value written for the build job', () => {
        const r = run(RELEASE);
        expect(r.stderr).toBe('');
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('release image 1.1.0, host servury, network static:192.0.2.10/23,192.0.2.1, network6 static:2001:db8:0:39c::1/64,fe80::1; artifact vault-image-1.1.0-servury');
        for (const [i, k] of KEYS.entries()) expect(r.stdout).toContain(`  ${i + 1}. ${k}`);
        expect(r.output).toBe([
            `keys={"genesisCustodians":["${KEYS[0]}","${KEYS[1]}","${KEYS[2]}"]}`,
            'version=1.1.0', 'host=servury', 'network=static:192.0.2.10/23,192.0.2.1',
            'network6=static:2001:db8:0:39c::1/64,fe80::1', 'artifact=vault-image-1.1.0-servury', '',
        ].join('\n'));
        // The keys line is exactly what build.sh's bundle step reads.
        expect(JSON.parse(r.output.split('\n')[0].slice('keys='.length))).toEqual({ genesisCustodians: KEYS });
    });

    it('a refused list: exit 2, an ::error:: line, nothing written for the build, and the value in neither stream', () => {
        const seed = offCurveSeed();
        const r = run({ ...RELEASE, custodian_keys: list([KEYS[0], seed, KEYS[2]]) });
        expect(r.status).toBe(2);
        expect(r.stdout).toMatch(/^::error title=Release image inputs refused::custodian_keys: key 2 is not an Ed25519 public key/);
        expect(r.output).toBe('');
        expect(r.stdout + r.stderr).not.toContain(seed);
        // Nor the other keys of the refused value: nothing of it is printed.
        for (const k of KEYS) expect(r.stdout + r.stderr).not.toContain(k);
    });

    it('a key file pasted by mistake: refused, and not a byte of its sealed half or its salt printed', () => {
        const ct = crypto.randomBytes(48).toString('base64url');
        const salt = crypto.randomBytes(16).toString('base64url');
        const r = run({ ...RELEASE, custodian_keys: JSON.stringify({ v: 2, publicKey: KEYS[0], kdf: { name: 'scrypt', salt }, nonce: 'n', ct }) });
        expect(r.status).toBe(2);
        expect(r.stdout).toMatch(/custodian KEY FILE/);
        for (const s of [ct, salt, KEYS[0]]) expect(r.stdout + r.stderr).not.toContain(s);
        expect(r.output).toBe('');
    });

    it('only spaces given, settings without keys, no event file or a stray argument: refused, nothing written', () => {
        for (const inputs of [{ custodian_keys: ' ', version: '' }, { version: '1.1.0' }]) {
            const r = run(inputs);
            expect(r.status, JSON.stringify(inputs)).toBe(2);
            expect(r.stdout).toMatch(/^::error /);
            expect(r.output).toBe('');
        }
        expect(run(RELEASE, ['--keys', 'x']).status).toBe(2);
        const none = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
        expect(none.status).toBe(2);
        expect(none.stdout).toMatch(/no event file/);
    });

    it('--event names the event file in place of $GITHUB_EVENT_PATH', () => {
        const event = path.join(dir, 'named-event.json');
        writeFileSync(event, JSON.stringify({ inputs: RELEASE }));
        const r = spawnSync(process.execPath, [script, '--event', event], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('artifact vault-image-1.1.0-servury');
    });

    it('an ::error:: message keeps to one line: % and line breaks are escaped as the runner reads them', () => {
        expect(commandText('50% done\r\nnext')).toBe('50%25 done%0D%0Anext');
        const r = run({ ...RELEASE, host: 'a%b\nc' });
        expect(r.status).toBe(2);
        expect(r.stdout.split('\n')[0]).toMatch(/^::error title=Release image inputs refused::host: not a setting/);
        expect(r.stdout.split('\n')).toHaveLength(2); // the one line and the final newline
    });

    it('every output value is one line, or nothing is written', () => {
        const ok = releaseInputs(RELEASE);
        expect(outputLines(ok).split('\n')).toHaveLength(7);
        expect(refusal(() => outputLines({ ...ok, network: 'dhcp\nkeys=x' }))).toMatch(/network: more than one line/);
    });
});
