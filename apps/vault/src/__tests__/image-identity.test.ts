import crypto from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { identifyImage, readEfiString, roothashFromCmdline, withoutTries } from '../shared/image-identity.js';
import { imageHashOf } from '../shared/release.js';

/**
 * Which image the machine booted (image-identity.ts), from files laid out as on the image: /proc/cmdline with
 * roothash=, systemd-boot's LoaderEntrySelected, and the UKI in the ESP's EFI/Linux.
 */

const dir = mkdtempSync(path.join(os.tmpdir(), 'bvi-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const GUID = '4a67b082-0a4c-41cf-b6c7-440b29bb8c4f';

function machine(name: string, entry: string | null, onDisk: string, cmdline: string) {
    const root = path.join(dir, name);
    mkdirSync(path.join(root, 'efivars'), { recursive: true });
    mkdirSync(path.join(root, 'esp', 'EFI', 'Linux'), { recursive: true });
    writeFileSync(path.join(root, 'cmdline'), cmdline);
    const uki = crypto.randomBytes(1000);
    writeFileSync(path.join(root, 'esp', 'EFI', 'Linux', onDisk), uki);
    if (entry !== null) {
        writeFileSync(path.join(root, 'efivars', `LoaderEntrySelected-${GUID}`), Buffer.concat([Buffer.from([6, 0, 0, 0]), Buffer.from(`${entry}\0`, 'utf16le')]));
    }
    return { paths: { cmdline: path.join(root, 'cmdline'), efivars: path.join(root, 'efivars'), esp: path.join(root, 'esp') }, uki };
}

describe('the image this machine booted', () => {
    const roothash = 'ab'.repeat(32);
    const cmdline = `console=ttyS0 roothash=${roothash} lockdown=confidentiality\n`;

    it('the UKI systemd-boot started and the root hash on the command line give the release\'s imageHash', () => {
        const m = machine('plain', 'beanpool-vault_1.0.0.efi', 'beanpool-vault_1.0.0.efi', cmdline);
        const r = identifyImage(m.paths);
        const ukiSha256 = crypto.createHash('sha256').update(m.uki).digest('hex');
        expect(r).toEqual({ ok: true, image: { ukiSha256, roothash, imageHash: imageHashOf({ ukiSha256, roothash }), ukiPath: path.join(m.paths.esp, 'EFI', 'Linux', 'beanpool-vault_1.0.0.efi') } });
    });

    it('finds the file when boot counting renamed it after the boot (blessed), or before', () => {
        expect(identifyImage(machine('blessed', 'beanpool-vault_1.1.0+3-0.efi', 'beanpool-vault_1.1.0.efi', cmdline).paths).ok).toBe(true);
        expect(identifyImage(machine('counting', 'beanpool-vault_1.1.0.efi', 'beanpool-vault_1.1.0+2-1.efi', cmdline).paths).ok).toBe(true);
        expect(withoutTries('beanpool-vault_1.1.0+3-0.efi')).toBe('beanpool-vault_1.1.0.efi');
        expect(withoutTries('beanpool-vault_1.1.0+3.efi')).toBe('beanpool-vault_1.1.0.efi');
    });

    it('says why when it can\'t tell: no roothash, no boot entry, the entry not on the ESP', () => {
        expect(identifyImage(machine('noroot', 'a.efi', 'a.efi', 'console=ttyS0').paths)).toEqual({ ok: false, reason: 'no roothash= on the kernel command line' });
        expect(identifyImage(machine('noentry', null, 'a.efi', cmdline).paths)).toMatchObject({ ok: false, reason: expect.stringContaining('no LoaderEntrySelected') });
        expect(identifyImage(machine('elsewhere', 'b.efi', 'a.efi', cmdline).paths)).toMatchObject({ ok: false, reason: 'the booted entry b.efi is not in EFI/Linux on the ESP' });
    });

    it('reads systemd-boot\'s variable and the kernel command line exactly', () => {
        expect(readEfiString(Buffer.concat([Buffer.from([6, 0, 0, 0]), Buffer.from('x.efi\0', 'utf16le')]))).toBe('x.efi');
        expect(roothashFromCmdline(`a usrhash=${'cd'.repeat(32)} b`)).toBe('cd'.repeat(32));
        expect(roothashFromCmdline(`roothash=${'cd'.repeat(31)}`)).toBeNull();
    });
});
