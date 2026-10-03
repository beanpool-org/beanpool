import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error: a plain .mjs build script, no types
import { imageJson, networkFile, parseNetwork } from '../../image/image-settings.mjs';

/**
 * The image build's `--network` setting (image/build.sh, image/image-settings.mjs): `dhcp` (the default, the image as
 * it was) or `static:<ipv4>/<prefix>,<gateway>` for a host without DHCP (1984 VPS #1). Anything else refuses to build.
 * The image itself is built only by the vault-image workflow (Docker, about an hour): this checks the parsing, the
 * file the static form writes and image.json, which a rebuild for the comparison reads the setting from.
 */

const dir = mkdtempSync(path.join(os.tmpdir(), 'bvn-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const image = fileURLToPath(new URL('../../image', import.meta.url));

describe('the image build\'s network setting', () => {
    it('dhcp is the image as it was: no file laid over the DHCP one, and image.json without a network field', () => {
        expect(parseNetwork('dhcp')).toEqual({ kind: 'dhcp', value: 'dhcp' });
        expect(networkFile(parseNetwork('dhcp'))).toBeNull();
        // The exact text build.sh's printf wrote before the setting existed.
        expect(imageJson({ version: '0.0.1', ukiSha256: 'aa', roothash: 'bb', imageHash: 'cc', network: parseNetwork('dhcp') }))
            .toBe('{\n  "version": "0.0.1",\n  "ukiSha256": "aa",\n  "roothash": "bb",\n  "imageHash": "cc"\n}\n');
    });

    it('static: the address, prefix and gateway, recorded in image.json', () => {
        const n = parseNetwork('static:192.0.2.10/24,192.0.2.1');
        expect(n).toEqual({ kind: 'static', value: 'static:192.0.2.10/24,192.0.2.1', address: '192.0.2.10', prefix: 24, gateway: '192.0.2.1' });
        expect(imageJson({ version: '0.0.1', ukiSha256: 'aa', roothash: 'bb', imageHash: 'cc', network: n }))
            .toBe('{\n  "version": "0.0.1",\n  "ukiSha256": "aa",\n  "roothash": "bb",\n  "imageHash": "cc",\n  "network": "static:192.0.2.10/24,192.0.2.1"\n}\n');
        // A point-to-point /31 has no network or broadcast address (RFC 3021).
        expect(parseNetwork('static:192.0.2.10/31,192.0.2.11').kind).toBe('static');
        expect(parseNetwork('static:10.1.2.3/8,10.0.0.1').gateway).toBe('10.0.0.1');
    });

    it('static writes this file over the DHCP one: no [DHCPv4]/[DHCPv6] sections, router advertisements kept', () => {
        expect(networkFile(parseNetwork('static:192.0.2.10/24,192.0.2.1'))).toBe([
            '# Written by build.sh --network static:192.0.2.10/24,192.0.2.1, over the DHCP file: the host has no DHCP (1984 VPS',
            '# #1, measured 2026-10-03). The address is public and part of the image and its hash. The vault\'s own resolver and',
            '# time come from its config, not from the network.',
            '[Match]',
            'Type=ether',
            'Kind=!*',
            '',
            '[Network]',
            'Address=192.0.2.10/24',
            'Gateway=192.0.2.1',
            'IPv6AcceptRA=yes',
            'LinkLocalAddressing=ipv6',
            '',
            '[IPv6AcceptRA]',
            'UseDNS=no',
            '',
        ].join('\n'));
    });

    it.each([
        '', 'DHCP', 'dhcp ', 'static', 'static:', 'static:192.0.2.10', 'static:192.0.2.10/24', 'static:192.0.2.10/24,',
        'static:192.0.2.256/24,192.0.2.1', 'static:192.0.2.010/24,192.0.2.1', 'static:192.0.2/24,192.0.2.1',
        'static:192.0.2.10/0,192.0.2.1', 'static:192.0.2.10/33,192.0.2.1', 'static:192.0.2.10/024,192.0.2.1',
        'static:192.0.2.10/24,192.0.3.1', 'static:192.0.2.10/24,192.0.2.10', 'static:192.0.2.10/32,192.0.2.10',
        'static:192.0.2.0/24,192.0.2.1', 'static:192.0.2.10/24,192.0.2.255', 'static:127.0.0.2/8,127.0.0.1',
        'static:0.0.0.10/24,0.0.0.1', 'static:224.0.0.10/24,224.0.0.1', 'static:2001:db8::10/64,2001:db8::1',
        'static:192.0.2.10/24,192.0.2.1 ', 'static:192.0.2.10/24,192.0.2.1\n[Network]\nDNS=192.0.2.66',
        ' static:192.0.2.10/24,192.0.2.1', 'static:192.0.2.10/ 24,192.0.2.1', 'static:192.0.2.10/24,192.0.2.1,192.0.2.2',
    ])('refuses %j', (value) => {
        expect(() => parseNetwork(value)).toThrow(/--network/);
    });

    it('build.sh refuses a bad --network before it does anything, and says why', () => {
        const out = path.join(dir, 'out');
        const r = spawnSync('bash', [path.join(image, 'build.sh'), '--custodian-keys', path.join(dir, 'keys.json'), '--version', '0.0.1',
            '--out', out, '--network', 'static:192.0.2.10/24,192.0.3.1'], { encoding: 'utf8' });
        expect(r.status).toBe(2);
        expect(r.stderr).toMatch(/--network.*gateway/);
        expect(existsSync(out)).toBe(false);
    });

    it('the module\'s command line, as build.sh calls it: check prints the setting, write lays the file (none for dhcp)', () => {
        const run = (...args: string[]) => spawnSync(process.execPath, [path.join(image, 'image-settings.mjs'), ...args], { encoding: 'utf8' });
        expect(run('check', 'static:192.0.2.10/24,192.0.2.1')).toMatchObject({ status: 0, stdout: 'static:192.0.2.10/24,192.0.2.1\n' });
        expect(run('check', 'dhcp')).toMatchObject({ status: 0, stdout: 'dhcp\n' });
        expect(run('check', 'static:1.2.3.4/24')).toMatchObject({ status: 2 });
        const file = path.join(dir, 'tree', 'etc', 'systemd', 'network', '80-wan.network');
        expect(run('write', 'dhcp', file).status).toBe(0);
        expect(existsSync(file)).toBe(false);
        expect(run('write', 'static:192.0.2.10/24,192.0.2.1', file).status).toBe(0);
        expect(existsSync(file)).toBe(true);
    });

    // build.sh calls the module by its logical path (`here` is a plain pwd), so the repo under a symlink (macOS /tmp is
    // one) must still run the command line: before, it ran nothing and exited 0, and a bad --network built a dhcp image.
    it('through a symlinked directory the command line still runs, and build.sh still refuses a bad --network', () => {
        const link = path.join(dir, 'linked-image');
        symlinkSync(image, link);
        const run = (...args: string[]) => spawnSync(process.execPath, [path.join(link, 'image-settings.mjs'), ...args], { encoding: 'utf8' });
        expect(run('check', 'bogus')).toMatchObject({ status: 2 });
        expect(run('check', 'static:192.0.2.10/24,192.0.2.1')).toMatchObject({ status: 0, stdout: 'static:192.0.2.10/24,192.0.2.1\n' });
        const file = path.join(dir, 'linked-tree', '80-wan.network');
        expect(run('write', 'static:192.0.2.10/24,192.0.2.1', file)).toMatchObject({ status: 0, stdout: 'static:192.0.2.10/24,192.0.2.1\n' });
        expect(readFileSync(file, 'utf8')).toContain('Gateway=192.0.2.1\n');
        expect(run('image-json', '0.0.1', 'aa', 'bb', 'cc', 'dhcp').stdout).toBe(imageJson({ version: '0.0.1', ukiSha256: 'aa', roothash: 'bb', imageHash: 'cc', network: parseNetwork('dhcp') }));
        const out = path.join(dir, 'linked-out');
        const r = spawnSync('bash', [path.join(link, 'build.sh'), '--custodian-keys', path.join(dir, 'keys.json'), '--version', '0.0.1',
            '--out', out, '--network', 'bogus\n[Network]\nDNS=192.0.2.66'], { encoding: 'utf8' });
        expect(r.status).toBe(2);
        expect(existsSync(out)).toBe(false);
    });

    // Belt and braces: build.sh goes on only when `check` answers with exactly the setting it was given, so a module
    // that runs nothing (as above) or answers wrongly stops the build instead of building without the setting.
    it.each([['no answer', ''], ['another answer', 'dhcp\n']])('build.sh refuses when check gives %s', (_name, answer) => {
        const stub = path.join(dir, `stub-${answer.length}`, 'image');
        mkdirSync(stub, { recursive: true });
        copyFileSync(path.join(image, 'build.sh'), path.join(stub, 'build.sh'));
        copyFileSync(path.join(image, 'pins.env'), path.join(stub, 'pins.env'));
        writeFileSync(path.join(stub, 'image-settings.mjs'), `process.stdout.write(${JSON.stringify(answer)});\n`);
        const out = path.join(stub, 'out');
        const r = spawnSync('bash', [path.join(stub, 'build.sh'), '--custodian-keys', path.join(dir, 'keys.json'), '--version', '0.0.1',
            '--out', out, '--network', 'static:192.0.2.10/24,192.0.2.1'], { encoding: 'utf8' });
        expect(r.status).toBe(2);
        expect(r.stderr).toMatch(/image-settings\.mjs check/);
        expect(existsSync(out)).toBe(false);
    });
});
