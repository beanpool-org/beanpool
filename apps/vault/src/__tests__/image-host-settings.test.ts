import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { parseHostPolicy } from '../shared/release.js';
import {
    DEFAULT_VAULT_NAME,
    hostPolicy,
    imageJson,
    nameFiles,
    networkFile,
    parseName,
    parseNetwork,
    parseNetwork6,
    readHostProfile,
    // @ts-expect-error: a plain .mjs build script, no types
} from '../../image/image-settings.mjs';

/**
 * The image build's settings for an SEV-SNP host (vault comeback design §3.2; image/build.sh, image/image-settings.mjs):
 * the IPv6 address a host sets by hand (`--network6`), the vault's own name (`--name`), the host profile (`--host`:
 * image/host-profiles/) and the release host policy it gives with the build's launch measurement, and image.json, which
 * records each only when it is not the default. The image itself is built by the vault-image workflow only.
 */

const dir = mkdtempSync(path.join(os.tmpdir(), 'bvh-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const image = fileURLToPath(new URL('../../image', import.meta.url));
const run = (...args: string[]) => spawnSync(process.execPath, [path.join(image, 'image-settings.mjs'), ...args], { encoding: 'utf8' });
const MEASUREMENT = 'ab'.repeat(48);
const H = 'a'.repeat(64);

describe('--network6: IPv6 set by hand', () => {
    it('ra is the image as it was; static takes a global address and a gateway inside the prefix or link-local', () => {
        expect(parseNetwork6('ra')).toEqual({ kind: 'ra', value: 'ra' });
        expect(parseNetwork6('static:2001:db8:0:39c::1/64,fe80::1')).toEqual({
            kind: 'static', value: 'static:2001:db8:0:39c::1/64,fe80::1', address: '2001:db8:0:39c::1', prefix: 64, gateway: 'fe80::1',
        });
        expect(parseNetwork6('static:2001:db8::10/64,2001:db8::1').gateway).toBe('2001:db8::1');
        expect(parseNetwork6('static:2001:db8:1:2:3:4:5:6/128,fe80::1').prefix).toBe(128);
    });

    it.each([
        '', 'RA', 'dhcp', 'static:', 'static:2001:db8::10/64', 'static:2001:db8::10/64,', 'static:2001:DB8::10/64,2001:db8::1',
        'static:2001:db8::10/0,2001:db8::1', 'static:2001:db8::10/129,2001:db8::1', 'static:2001:db8::10/064,2001:db8::1',
        'static:2001:db8::10%eth0/64,fe80::1', 'static:::ffff:192.0.2.1/96,fe80::1', 'static:2001:db8:::10/64,fe80::1',
        'static:2001:db8::1::2/64,fe80::1', 'static:2001:db8:0:0:0:0:0:0:1/64,fe80::1', 'static:2001:db8:0:0:0:0:1/64,fe80::1',
        'static:12345::1/64,fe80::1', 'static:fe80::10/64,fe80::1', 'static:ff02::10/64,fe80::1', 'static:::1/64,fe80::1',
        'static:2001:db8::10/64,2001:db9::1', 'static:2001:db8::10/64,2001:db8::10', 'static:2001:db8::10/64,ff02::1',
        'static:2001:db8::10/64,::', 'static:2001:db8::10/64,fe80::1 ', 'static:2001:db8::10/64,fe80::1\n[Network]\nDNS=::1',
    ])('refuses %j', (value) => {
        expect(() => parseNetwork6(value)).toThrow(/--network6/);
    });

    it('writes both addresses and both gateways into one file, and takes no router advertisements', () => {
        expect(networkFile(parseNetwork('static:192.0.2.10/23,192.0.2.1'), parseNetwork6('static:2001:db8:0:39c::1/64,fe80::1'))).toBe([
            '# Written by build.sh --network static:192.0.2.10/23,192.0.2.1 --network6 static:2001:db8:0:39c::1/64,fe80::1, over the DHCP file: the',
            '# host has no DHCP and sets IPv6 by hand too. The addresses are public and part of the image and its hash. The',
            '# vault\'s own resolver and time come from its config, not from the network.',
            '[Match]',
            'Type=ether',
            'Kind=!*',
            '',
            '[Network]',
            'Address=192.0.2.10/23',
            'Gateway=192.0.2.1',
            'Address=2001:db8:0:39c::1/64',
            'Gateway=fe80::1',
            'IPv6AcceptRA=no',
            'LinkLocalAddressing=ipv6',
            '',
        ].join('\n'));
        // The IPv4-only file is the one it always was.
        expect(networkFile(parseNetwork('static:192.0.2.10/24,192.0.2.1'), parseNetwork6('ra'))).toBe(networkFile(parseNetwork('static:192.0.2.10/24,192.0.2.1')));
        expect(() => networkFile(parseNetwork('dhcp'), parseNetwork6('static:2001:db8::10/64,fe80::1'))).toThrow(/needs --network static/);
    });
});

describe('--name: the vault\'s own name', () => {
    const caddyfile = readFileSync(path.join(image, 'mkosi/mkosi.extra/etc/caddy/Caddyfile'), 'utf8');
    const apiJson = readFileSync(path.join(image, 'mkosi/mkosi.extra/etc/beanpool-vault/api.json'), 'utf8');

    it('takes a lower-case DNS name of two labels or more', () => {
        for (const n of [DEFAULT_VAULT_NAME, 'keyvault.beanpool.org', 'vault.example.org', 'a-b.c9.example']) expect(parseName(n)).toBe(n);
    });

    it.each([
        '', 'localhost', 'Vault.example.org', '-a.example.org', 'a-.example.org', 'a..example.org', '.example.org', 'example.org.',
        'a.example.org ', '192.0.2.10', 'a_b.example.org', 'vault.example.org\n[Network]', `${'a'.repeat(64)}.example.org`,
        `${'a.'.repeat(127)}org`,
    ])('refuses %j', (value) => {
        expect(() => parseName(value)).toThrow(/--name/);
    });

    it('puts another name in Caddy\'s site line and the API\'s hosts, once each, and nothing else changes', () => {
        const f = nameFiles('vault.example.org', caddyfile, apiJson);
        expect(f.caddyfile).toBe(caddyfile.replace('\nvault.beanpool.org {\n', '\nvault.example.org {\n'));
        expect(JSON.parse(f.apiJson)).toEqual({ ...JSON.parse(apiJson), hosts: ['vault.example.org'] });
        expect(f.apiJson.split('\n').length).toBe(apiJson.split('\n').length);
    });

    it('refuses image files that do not hold the default exactly once where expected', () => {
        expect(() => nameFiles('vault.example.org', caddyfile.replace('vault.beanpool.org {', 'other.example {'), apiJson)).toThrow(/Caddyfile/);
        expect(() => nameFiles('vault.example.org', `${caddyfile}\nvault.beanpool.org {\n}\n`, apiJson)).toThrow(/Caddyfile/);
        expect(() => nameFiles('vault.example.org', caddyfile, apiJson.replace('"hosts": ["vault.beanpool.org"],', '"hosts": [],'))).toThrow(/api\.json/);
    });

    it('write-name leaves both files untouched for the default, and writes another', () => {
        const c = path.join(dir, 'Caddyfile');
        const a = path.join(dir, 'api.json');
        writeFileSync(c, caddyfile);
        writeFileSync(a, apiJson);
        expect(run('write-name', DEFAULT_VAULT_NAME, c, a)).toMatchObject({ status: 0, stdout: `${DEFAULT_VAULT_NAME}\n` });
        expect(readFileSync(c, 'utf8')).toBe(caddyfile);
        expect(readFileSync(a, 'utf8')).toBe(apiJson);
        expect(run('write-name', 'keyvault.beanpool.org', c, a)).toMatchObject({ status: 0, stdout: 'keyvault.beanpool.org\n' });
        expect(readFileSync(c, 'utf8')).toContain('\nkeyvault.beanpool.org {\n');
        expect(JSON.parse(readFileSync(a, 'utf8')).hosts).toEqual(['keyvault.beanpool.org']);
        expect(run('write-name', 'Bad Name', c, a).status).toBe(2);
    });
});

describe('--host: the Servury profile and the release host policy', () => {
    it('reads the servury profile: Servury\'s published launch inputs and firmware, and today\'s floor (SNP 29)', () => {
        const p = readHostProfile('servury');
        expect(p).toMatchObject({
            profile: 'servury', platform: 'sev-snp', product: 'Milan', guestPolicy: '0x30000', signer: 'vcek',
            launch: { vcpus: 1, vcpuType: 'EPYC-v4', guestFeatures: '0x1', append: '' },
            firmware: { name: 'OVMF.amdsev.fd', sha256: '8731846cdbcbb6aa5c624238b839544b1553f4c5af874450f043321b3ef8958b', release: '2026.11.3' },
        });
        // The minimum TCB is a setting: SNP 29 until Servury patches AMD-SB-3059 (then 31: the profile's notes say so).
        expect(p.minTcb).toEqual({ bootloader: 4, tee: 0, snp: 29, microcode: 222 });
        expect(p.requireAliasCheck).toBe(true);
        expect(p.notes.join(' ')).toMatch(/Raise snp to 31/);
        expect(readHostProfile('none')).toEqual({ profile: 'none' });
    });

    it('gives the release a sev-snp host policy in the design §2.4 shape: this UKI\'s computed launch, the floor, no chip yet', () => {
        const UKI = 'cd'.repeat(32);
        const policy = hostPolicy(readHostProfile('servury'), MEASUREMENT, UKI);
        expect(policy).toEqual({
            platform: 'sev-snp', signer: 'vcek',
            hosts: [{
                profile: 'servury', product: 'Milan',
                launches: [{ ukiSha256: UKI, firmwareSha256: '8731846cdbcbb6aa5c624238b839544b1553f4c5af874450f043321b3ef8958b', measurement: MEASUREMENT, source: 'computed' }],
                policies: ['0000030000000000'],
                minTcb: { bootloader: 4, tee: 0, snp: 29, microcode: 222 },
                requireAliasCheck: true,
                chipIds: [],
            }],
        });
        expect(parseHostPolicy(policy)).toEqual(policy);
        expect(() => hostPolicy(readHostProfile('servury'), 'ab'.repeat(32), UKI)).toThrow(/48 bytes/);
        expect(() => hostPolicy(readHostProfile('servury'), MEASUREMENT, 'ab')).toThrow(/UKI/);
        expect(() => hostPolicy(readHostProfile('none'), MEASUREMENT, UKI)).toThrow(/no host profile/);
        const cli = run('host-policy', 'servury', MEASUREMENT, UKI);
        expect(cli.status).toBe(0);
        expect(JSON.parse(cli.stdout)).toEqual(policy);
        expect(run('host-policy', 'servury', MEASUREMENT).status).toBe(2);
    });

    // One profile per row, each with one thing wrong.
    interface ProfileFile {
        [field: string]: unknown;
        profile: string; platform: string; product: string; guestPolicy: string; signer: string;
        launch: { append: string; vcpus: number }; firmware: { url: string; sha256: string }; minTcb?: { snp: number };
    }
    const good = JSON.parse(readFileSync(path.join(image, 'host-profiles/servury.json'), 'utf8')) as ProfileFile;
    const rows: [string, (p: ProfileFile) => void, RegExp][] = [
        ['debug allowed', p => { p.guestPolicy = '0xb0000'; }, /debug \(bit 19\)/],
        ['a migration agent allowed', p => { p.guestPolicy = '0x70000'; }, /migration agent \(bit 18\)/],
        ['a host command line', p => { p.launch.append = 'console=ttyS0'; }, /append is empty/],
        ['a cloud\'s signing key', p => { p.signer = 'vlek'; }, /signer is vcek/],
        ['a Turin chip (another TCB layout)', p => { p.product = 'Turin'; }, /Milan or Genoa/],
        ['another platform', p => { p.platform = 'tdx'; }, /platform is sev-snp/],
        ['an unknown field', p => { p.extra = 1; }, /does not know: extra/],
        ['a missing floor', p => { delete p.minTcb; }, /lacks minTcb/],
        ['a TCB level over 255', p => { p.minTcb!.snp = 256; }, /0 to 255/],
        ['no alias-check rule', p => { delete p.requireAliasCheck; }, /lacks requireAliasCheck/],
        ['an alias-check rule that is not true or false', p => { p.requireAliasCheck = 'yes'; }, /requireAliasCheck is true or false/],
        ['a firmware over plain http', p => { p.firmware.url = 'http://example.org/OVMF.fd'; }, /https address/],
        ['a firmware hash that is not one', p => { p.firmware.sha256 = 'abc'; }, /SHA-256/],
        ['no vCPU', p => { p.launch.vcpus = 0; }, /1 to 64/],
        ['another profile\'s file', p => { p.profile = 'other'; }, /names profile "other"/],
    ];
    it.each(rows)('refuses a profile with %s', (_what, change, why) => {
        const d = mkdtempSync(path.join(dir, 'profiles-'));
        const p = structuredClone(good);
        change(p);
        writeFileSync(path.join(d, 'servury.json'), JSON.stringify(p));
        expect(() => readHostProfile('servury', d)).toThrow(why);
        expect(readHostProfile('servury', path.join(image, 'host-profiles')).profile).toBe('servury');
    });

    it('refuses a profile name that is not one, or has no file', () => {
        for (const n of ['', 'Servury', '../servury', 'servury.json', 'nope']) expect(() => readHostProfile(n)).toThrow(/--host/);
        expect(run('host', 'nope', 'profile').status).toBe(2);
        expect(run('host', 'servury', 'firmware-url')).toMatchObject({ status: 0, stdout: 'https://servury.com/downloads/blackbox/2026.11.3/OVMF.amdsev.fd\n' });
        expect(run('host', 'none', 'platform')).toMatchObject({ status: 0, stdout: 'none\n' });
        expect(run('host', 'none', 'firmware-url').status).toBe(2);
        expect(run('host', 'servury', 'constructor').status).toBe(2);
    });
});

describe('image.json with the new settings', () => {
    const base = { version: '0.0.1', ukiSha256: H, roothash: H, imageHash: H, network: parseNetwork('dhcp') };

    it('records each setting only when it is not the default: a default build\'s file is the one it always was', () => {
        expect(imageJson({ ...base, network6: parseNetwork6('ra'), name: DEFAULT_VAULT_NAME, profile: readHostProfile('none'), measurement: '', acpiOff: false }))
            .toBe(imageJson(base));
        expect(run('image-json', '0.0.1', H, H, H, 'dhcp', 'ra', DEFAULT_VAULT_NAME, 'none', '', 'acpi').stdout).toBe(imageJson(base));
    });

    it('the Servury build: network, network6, name, acpi=off and the host\'s launch measurement', () => {
        const out = run('image-json', '0.0.2', H, H, H, 'static:192.0.2.10/23,192.0.2.1', 'static:2001:db8::10/64,fe80::1', 'vault.example.org', 'servury', MEASUREMENT, 'acpi-off');
        expect(out.status).toBe(0);
        expect(out.stdout).toBe(`${JSON.stringify({
            version: '0.0.2', ukiSha256: H, roothash: H, imageHash: H, network: 'static:192.0.2.10/23,192.0.2.1', network6: 'static:2001:db8::10/64,fe80::1',
            name: 'vault.example.org', kernelExtra: 'acpi=off', host: { profile: 'servury', measurement: MEASUREMENT },
        }, null, 2)}\n`);
    });

    it('refuses a host profile without its measurement, and a last field that is not acpi or acpi-off', () => {
        expect(run('image-json', '0.0.1', H, H, H, 'dhcp', 'ra', DEFAULT_VAULT_NAME, 'servury', '', 'acpi').status).toBe(2);
        expect(run('image-json', '0.0.1', H, H, H, 'dhcp', 'ra', DEFAULT_VAULT_NAME, 'none', '', 'yes').status).toBe(2);
        expect(run('image-json', '0.0.1', H, H, H, 'dhcp', 'ra').status).toBe(2);
    });
});

describe('build.sh refuses a bad setting before it does anything', () => {
    const build = (...extra: string[]) => {
        const out = path.join(dir, `out-${extra.join('-').replace(/[^a-z0-9]/gi, '').slice(0, 40)}`);
        const r = spawnSync('bash', [path.join(image, 'build.sh'), '--custodian-keys', path.join(dir, 'keys.json'), '--version', '0.0.1', '--out', out, ...extra],
            { encoding: 'utf8' });
        return { ...r, made: existsSync(out) };
    };
    it.each([
        [['--network6', 'static:2001:db8::10/64,2001:db9::1'], /--network6/],
        [['--network6', 'static:2001:db8::10/64,fe80::1'], /needs --network static/],
        [['--name', 'Vault.Example.org'], /--name/],
        [['--host', 'nope'], /--host "nope"/],
        [['--host', '../host-profiles/servury'], /--host/],
    ])('%j', (extra, why) => {
        const r = build(...extra);
        expect(r.status).toBe(2);
        expect(r.stderr).toMatch(why);
        expect(r.made).toBe(false);
    });
});

describe('build.sh\'s network guard with IPv6 (run on a copied mkosi tree)', () => {
    const buildSh = readFileSync(path.join(image, 'build.sh'), 'utf8');
    const lines = buildSh.split('\n');
    const a = lines.findIndex(l => /^wan="\$\{extra\}\/etc\/systemd\/network\/80-wan\.network"$/.test(l));
    const b = lines.findIndex((l, i) => i > a && /^esac \|\|/.test(l));
    const guard = lines.slice(a, b + 1).join('\n');
    const tree = (name: string) => {
        const t = path.join(dir, name);
        rmSync(t, { recursive: true, force: true });
        spawnSync('cp', ['-R', path.join(image, 'mkosi'), t]);
        return path.join(t, 'mkosi.extra');
    };
    const bash = (env: Record<string, string>) => spawnSync('bash', ['-c', `set -e\n${guard}`], { env: { ...process.env, ...env }, encoding: 'utf8' }).status;
    const V4 = 'static:192.0.2.10/23,192.0.2.1';
    const V6 = 'static:2001:db8:0:39c::1/64,fe80::1';

    it('passes the real module for static IPv4 with static IPv6, and with router advertisements', () => {
        expect(a).toBeGreaterThanOrEqual(0);
        expect(b).toBeGreaterThan(a);
        expect(bash({ here: image, extra: tree('n6-static'), network: V4, network6: V6 })).toBe(0);
        expect(bash({ here: image, extra: tree('n6-ra'), network: V4, network6: 'ra' })).toBe(0);
        expect(readFileSync(path.join(dir, 'n6-static', 'mkosi.extra/etc/systemd/network/80-wan.network'), 'utf8')).toContain('Gateway=fe80::1\n');
    });

    it('refuses a module that writes the IPv6 file with one setting more', () => {
        const stub = path.join(dir, 'n6-stub');
        mkdirSync(stub, { recursive: true });
        spawnSync('cp', ['-R', path.join(image, 'mkosi'), path.join(stub, 'mkosi')]);
        writeFileSync(path.join(stub, 'image-settings.mjs'),
            `import { writeFileSync } from 'node:fs';\n` +
            `import { networkFile, parseNetwork, parseNetwork6 } from ${JSON.stringify(path.join(image, 'image-settings.mjs'))};\n` +
            `const [, , , v, f, v6] = process.argv; writeFileSync(f, networkFile(parseNetwork(v), parseNetwork6(v6)) + 'DNS=2001:db8::66\\n'); console.log(v);\n`);
        expect(bash({ here: stub, extra: tree('n6-bad'), network: V4, network6: V6 })).not.toBe(0);
    });
});
