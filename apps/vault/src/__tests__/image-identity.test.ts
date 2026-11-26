import crypto from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { identifyImage, readEfiString, roothashFromCmdline, ukiCmdline, withoutTries } from '../shared/image-identity.js';
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

    // Direct boot (vault comeback design §2.8): the SEV-SNP host's firmware loads the UKI, so no boot loader names it.
    describe('when the host loaded the boot file itself (no LoaderEntrySelected)', () => {
        /** A PE file with a `.linux` and a `.cmdline` section, as ukify lays a UKI out (only the section table matters). */
        function fakeUki(cmd: string): Buffer {
            const body = Buffer.concat([crypto.randomBytes(64), Buffer.from(`${cmd}\0\0`)]);
            const head = Buffer.alloc(0x40 + 24 + 2 * 40);
            head.write('MZ', 0, 'latin1');
            head.writeUInt32LE(0x40, 0x3c);
            head.write('PE\0\0', 0x40, 'latin1');
            head.writeUInt16LE(0x8664, 0x44);
            head.writeUInt16LE(2, 0x46);
            head.writeUInt16LE(0, 0x54); // no optional header: the section table follows the COFF header
            const section = (at: number, name: string, offset: number, size: number) => {
                head.write(name, at, 'latin1');
                head.writeUInt32LE(size, at + 8);
                head.writeUInt32LE(size + 2, at + 16);
                head.writeUInt32LE(offset, at + 20);
            };
            section(0x58, '.linux', head.length, 64);
            section(0x58 + 40, '.cmdline', head.length + 64, Buffer.byteLength(cmd));
            return Buffer.concat([head, body]);
        }

        function directBoot(name: string, ukis: Record<string, Buffer>) {
            const root = path.join(dir, name);
            mkdirSync(path.join(root, 'efivars'), { recursive: true });
            mkdirSync(path.join(root, 'esp', 'EFI', 'Linux'), { recursive: true });
            writeFileSync(path.join(root, 'cmdline'), cmdline);
            for (const [f, b] of Object.entries(ukis)) writeFileSync(path.join(root, 'esp', 'EFI', 'Linux', f), b);
            return { cmdline: path.join(root, 'cmdline'), efivars: path.join(root, 'efivars'), esp: path.join(root, 'esp') };
        }

        it('reads a UKI\'s own command line, and nothing from a file that is not one', () => {
            expect(ukiCmdline(fakeUki(`console=ttyS0 roothash=${roothash}`))).toBe(`console=ttyS0 roothash=${roothash}`);
            expect(ukiCmdline(crypto.randomBytes(500))).toBeNull();
            expect(ukiCmdline(Buffer.from('MZ'))).toBeNull();
        });

        it('names the image by its roothash: the UKI on the ESP whose command line names it', () => {
            const ours = fakeUki(cmdline.trim());
            const paths = directBoot('direct', { 'beanpool-vault_1.0.0.efi': fakeUki(`roothash=${'cd'.repeat(32)}`), 'beanpool-vault_1.1.0.efi': ours, 'notes.txt': Buffer.from('x') });
            const ukiSha256 = crypto.createHash('sha256').update(ours).digest('hex');
            expect(identifyImage(paths)).toEqual({ ok: true, image: { ukiSha256, roothash, imageHash: imageHashOf({ ukiSha256, roothash }), ukiPath: path.join(paths.esp, 'EFI', 'Linux', 'beanpool-vault_1.1.0.efi') } });
            // The same file twice (a copy) is still one answer.
            expect(identifyImage(directBoot('direct-copy', { 'a.efi': ours, 'b.efi': ours })).ok).toBe(true);
        });

        it('two different boot files naming the roothash, or none, is no answer, and says why', () => {
            expect(identifyImage(directBoot('direct-two', { 'a.efi': fakeUki(cmdline.trim()), 'b.efi': fakeUki(cmdline.trim()) })))
                .toEqual({ ok: false, reason: `2 different boot files on the ESP name roothash ${roothash}` });
            expect(identifyImage(directBoot('direct-none', { 'a.efi': fakeUki(`roothash=${'cd'.repeat(32)}`) })))
                .toMatchObject({ ok: false, reason: expect.stringContaining(`no UKI in EFI/Linux on the ESP names roothash ${roothash}`) });
        });
    });
});
