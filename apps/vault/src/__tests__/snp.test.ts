import crypto from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { vaultUnb64 } from '@beanpool/core';
import { Keyholder } from '../keyholder/keyholder.js';
import {
    attestorFrom,
    describeSnpReport,
    listenAttest,
    readSnpReport,
    requestSnpEvidence,
    snpAttestor,
    snpEvidence,
    splitSnpEvidence,
    SNP_REPORT_SIZE,
    tsmReport,
    type TsmFs,
} from '../keyholder/snp.js';
import { unlockBind } from '../shared/ceremony.js';

/**
 * The SEV-SNP attestor and its root helper (vault comeback design §2.2), against a FAKE configfs-tsm: the Mac and CI
 * have no SNP. The fake behaves as the kernel's ABI says (Documentation/ABI/testing/configfs-tsm): a directory made
 * under tsm/report has `provider`, `privlevel` and `generation`; a write to `inblob` raises `generation` by one; `outblob`
 * is the report over that inblob, `auxblob` the host's certificate table.
 *
 * The report the fake returns is laid out field by field with the values the 26 Nov probe of the Servury host read
 * off its real report (scratch/vault-host/PROBE-servury-2026-11-26.txt: version 5, VMPL 0, policy 0x30000, reported
 * TCB bootloader 4, tee 0, SNP 29, microcode 222). The probe kept no raw report, and no public repository holds one,
 * so this is not a recorded one: the real report is recorded at the design's test T2 on the server and replaces this.
 * Nothing here checks a signature (that is the custodian tool's, next lane).
 */

const dir = mkdtempSync(path.join(os.tmpdir(), 'bvsnp-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const closers: { close(): Promise<void> }[] = [];
afterEach(async () => {
    while (closers.length) await closers.pop()!.close();
});

const MEASUREMENT = Buffer.alloc(48, 0x5a);
const CHIP_ID = Buffer.from(crypto.createHash('sha512').update('a chip').digest());

/** A report shaped as the probe's: offsets from go-sev-guest abi.go. */
function probeShapedReport(reportData: Uint8Array, over: { vmpl?: number; size?: number } = {}): Buffer {
    const r = Buffer.alloc(SNP_REPORT_SIZE);
    r.writeUInt32LE(5, 0x00); // version
    r.writeBigUInt64LE(0x30000n, 0x08); // policy: SMT allowed, debug off, no migration agent
    r.writeUInt32LE(over.vmpl ?? 0, 0x30);
    r.writeUInt32LE(1, 0x34); // ECDSA P-384 with SHA-384
    const tcb = Buffer.from([4, 0, 0, 0, 0, 0, 29, 222]);
    tcb.copy(r, 0x38); // current
    r.writeBigUInt64LE(0x1n, 0x40); // platform info: SMT enabled
    Buffer.from(reportData).copy(r, 0x50);
    MEASUREMENT.copy(r, 0x90);
    tcb.copy(r, 0x180); // reported
    CHIP_ID.copy(r, 0x1a0);
    tcb.copy(r, 0x1e0); // committed
    tcb.copy(r, 0x1f0); // launch
    return over.size === undefined ? r : r.subarray(0, over.size);
}

/** configfs-tsm as the kernel keeps it, in memory. */
function fakeTsm(opts: { provider?: string; privlevel?: string | null; extraWrites?: number; report?: (inblob: Buffer) => Buffer; aux?: Buffer } = {}) {
    const entries = new Map<string, { gen: number; inblob: Buffer | null }>();
    const made: string[] = [];
    const removed: string[] = [];
    const fs: TsmFs = {
        mkdir: p => {
            if (path.dirname(p) !== '/tsm/report' || entries.has(p)) throw new Error('EEXIST or not in tsm/report');
            entries.set(p, { gen: 0, inblob: null });
            made.push(p);
        },
        rmdir: p => {
            entries.delete(p);
            removed.push(p);
        },
        read: p => {
            const e = entries.get(path.dirname(p));
            if (!e) return null;
            switch (path.basename(p)) {
                case 'provider': return Buffer.from(`${opts.provider ?? 'sev_guest'}\n`);
                case 'privlevel': return opts.privlevel === null ? null : Buffer.from(`${opts.privlevel ?? '0'}\n`);
                case 'generation': return Buffer.from(`${e.gen}\n`);
                case 'outblob': return e.inblob ? (opts.report ?? (i => probeShapedReport(i)))(e.inblob) : null;
                case 'auxblob': return opts.aux ?? null;
                default: return null;
            }
        },
        write: (p, data) => {
            const e = entries.get(path.dirname(p));
            if (!e || path.basename(p) !== 'inblob') throw new Error('EACCES');
            e.inblob = Buffer.from(data);
            e.gen += 1 + (opts.extraWrites ?? 0);
        },
    };
    return { fs, made, removed, entries };
}

describe('a report from configfs-tsm (root\'s helper)', () => {
    it('writes the 64 bytes, reads the report and the certificate table, and removes its entry', () => {
        const t = fakeTsm({ aux: Buffer.from('certificate table') });
        const data = crypto.randomBytes(64);
        const { report, auxblob } = tsmReport(data, { dir: '/tsm/report', fs: t.fs });
        const r = readSnpReport(report);
        expect(r.reportData.equals(data)).toBe(true);
        expect(r).toMatchObject({ version: 5, policy: 0x30000n, vmpl: 0, signatureAlgo: 1, signingKey: 0, maskChipKey: false });
        expect(r.reportedTcb).toEqual({ bootloader: 4, tee: 0, snp: 29, microcode: 222 });
        expect(r.measurement.equals(MEASUREMENT)).toBe(true);
        expect(r.chipId.equals(CHIP_ID)).toBe(true);
        expect(auxblob.toString()).toBe('certificate table');
        expect(t.made).toHaveLength(1);
        expect(t.removed).toEqual(t.made);
        expect(t.entries.size).toBe(0);
    });

    it('no certificate table is an empty one; no privlevel attribute is level 0', () => {
        const t = fakeTsm({ privlevel: null });
        expect(tsmReport(crypto.randomBytes(64), { dir: '/tsm/report', fs: t.fs }).auxblob.length).toBe(0);
    });

    // Each row: what is wrong, and the refusal. The entry is removed every time.
    it.each([
        ['another provider', { provider: 'tdx_guest' }, /provider is tdx_guest, not sev_guest/],
        ['privilege level 1', { privlevel: '1' }, /privilege level 1, not 0/],
        ['another writer between (generation moved by two)', { extraWrites: 1 }, /generation went from 0 to 2/],
        ['a short report', { report: (i: Buffer) => probeShapedReport(i, { size: SNP_REPORT_SIZE - 1 }) }, /1184 bytes, not 1183/],
        ['a report over other data', { report: () => probeShapedReport(crypto.randomBytes(64)) }, /does not carry the report data/],
        ['a report asked for at VMPL 1', { report: (i: Buffer) => probeShapedReport(i, { vmpl: 1 }) }, /VMPL 1, not 0/],
        ['no report at all', { report: () => null as unknown as Buffer }, /gave no report/],
    ])('refuses %s', (_what, opts, why) => {
        const t = fakeTsm(opts);
        expect(() => tsmReport(crypto.randomBytes(64), { dir: '/tsm/report', fs: t.fs })).toThrow(why);
        expect(t.removed).toEqual(t.made);
    });

    it('refuses report data that is not 64 bytes, before it touches configfs', () => {
        const t = fakeTsm();
        expect(() => tsmReport(crypto.randomBytes(32), { dir: '/tsm/report', fs: t.fs })).toThrow(/64 bytes/);
        expect(t.made).toHaveLength(0);
    });

    it('a real directory that is not configfs (no provider file) is refused', () => {
        expect(() => tsmReport(crypto.randomBytes(64), { dir })).toThrow(/provider is missing/);
    });
});

describe('the evidence bytes and the boot check\'s lines', () => {
    it('"BVSN", version 1, the report, then the certificate table', () => {
        const report = probeShapedReport(Buffer.alloc(64, 1));
        const e = snpEvidence(report, Buffer.from('xyz'));
        expect(e.subarray(0, 5)).toEqual(Buffer.from([0x42, 0x56, 0x53, 0x4e, 1]));
        expect(e.length).toBe(5 + SNP_REPORT_SIZE + 3);
        expect(splitSnpEvidence(e)).toEqual({ report, auxblob: Buffer.from('xyz') });
        expect(() => splitSnpEvidence(e.subarray(0, 100))).toThrow(/Not BeanPool SEV-SNP evidence/);
        expect(() => snpEvidence(report.subarray(1), Buffer.alloc(0))).toThrow();
    });

    it('prints the public values: policy with debug and migration, VMPL, signer, the TCBs', () => {
        const lines = describeSnpReport(readSnpReport(probeShapedReport(Buffer.alloc(64))));
        expect(lines[0]).toBe('report version 5, policy 0x30000 (debug off, migration agent off), VMPL 0');
        expect(lines[1]).toBe('signer VCEK (the chip\'s own key)');
        expect(lines[2]).toBe('reported TCB bootloader 4, tee 0, snp 29, microcode 222');
        const debug = probeShapedReport(Buffer.alloc(64));
        debug.writeBigUInt64LE(0x30000n | (1n << 19n) | (1n << 18n), 0x08);
        expect(describeSnpReport(readSnpReport(debug))[0]).toContain('debug ON, migration agent ON');
    });
});

describe('the helper\'s socket and the keyholder\'s attestor', () => {
    it('the keyholder gets fresh evidence over each hello\'s bind; the socket is 0660', async () => {
        const t = fakeTsm();
        const sock = path.join(dir, 'attest', 'attest.sock');
        closers.push(await listenAttest(sock, { report: d => tsmReport(d, { dir: '/tsm/report', fs: t.fs }) }));
        expect(statSync(sock).mode & 0o777).toBe(0o660);
        expect(statSync(path.dirname(sock)).mode & 0o777).toBe(0o750);
        const kh = new Keyholder({ stateDir: mkdtempSync(path.join(dir, 'kh-')), genesisCustodians: [], attestor: snpAttestor(sock) });
        const nonce = crypto.randomBytes(32);
        const hello = await kh.hello(vaultB64url(nonce));
        expect(hello.platform).toBe('sev-snp');
        expect(kh.status().platform).toBe('sev-snp');
        const { report } = splitSnpEvidence(Buffer.from(unb64(hello.evidence!)));
        const bind = unlockBind(unb64(hello.helloPub), unb64(hello.bootId), nonce);
        expect(readSnpReport(report).reportData.equals(Buffer.from(bind))).toBe(true);
        // Another nonce, another report.
        const again = await kh.hello(vaultB64url(crypto.randomBytes(32)));
        expect(again.evidence).not.toBe(hello.evidence);
        kh.lock();
    });

    it('never falls back to no evidence: a helper that fails, refuses or is not there fails the hello', async () => {
        const failing = path.join(dir, 'failing.sock');
        closers.push(await listenAttest(failing, { report: () => { throw new Error('no /dev/sev-guest'); } }));
        const kh = new Keyholder({ stateDir: mkdtempSync(path.join(dir, 'kh-')), genesisCustodians: [], attestor: snpAttestor(failing) });
        await expect(kh.hello(vaultB64url(crypto.randomBytes(32)))).rejects.toThrow(/refused: no \/dev\/sev-guest/);
        const absent = new Keyholder({ stateDir: mkdtempSync(path.join(dir, 'kh-')), genesisCustodians: [], attestor: snpAttestor(path.join(dir, 'none.sock')) });
        await expect(absent.hello(vaultB64url(crypto.randomBytes(32)))).rejects.toThrow(/not reachable/);
        kh.lock();
        absent.lock();
    });

    it('a helper whose report is over other data is refused by the client', async () => {
        const liar = path.join(dir, 'liar.sock');
        closers.push(await listenAttest(liar, { report: () => ({ report: probeShapedReport(crypto.randomBytes(64)), auxblob: Buffer.alloc(0) }) }));
        await expect(requestSnpEvidence(liar, crypto.randomBytes(64))).rejects.toThrow(/not over our report data/);
    });

    it('the helper refuses a request that is not 64 bytes of report data', async () => {
        const sock = path.join(dir, 'strict.sock');
        closers.push(await listenAttest(sock, { report: d => ({ report: probeShapedReport(d), auxblob: Buffer.alloc(0) }) }));
        await expect(requestSnpEvidence(sock, crypto.randomBytes(63))).rejects.toThrow(/reportData is 64 bytes/);
    });

    it('the config names the attestor: none (or absent), sev-snp, and anything else refuses to start', () => {
        expect(attestorFrom({}).platform).toBe('none');
        expect(attestorFrom({ attestor: 'none' }).platform).toBe('none');
        expect(attestorFrom({ attestor: 'sev-snp' }).platform).toBe('sev-snp');
        expect(attestorFrom({ attestor: 'sev-snp', attestSocket: '/x.sock' }).platform).toBe('sev-snp');
        expect(() => attestorFrom({ attestor: 'SEV-SNP' })).toThrow(/not one this keyholder knows/);
        expect(() => attestorFrom({ attestor: 'tdx' })).toThrow(/not one this keyholder knows/);
        expect(() => attestorFrom({ attestor: 'sev-snp', attestSocket: 5 })).toThrow(/attestSocket/);
    });
});

function unb64(s: string): Uint8Array {
    const b = vaultUnb64(s);
    if (!b) throw new Error(`not base64url: ${s}`);
    return b;
}

function vaultB64url(b: Uint8Array): string {
    return Buffer.from(b).toString('base64url');
}
