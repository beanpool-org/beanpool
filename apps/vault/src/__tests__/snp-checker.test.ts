import crypto, { X509Certificate } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AMD_ROOTS } from '../custodian/amd-roots.js';
import type { CheckContext } from '../custodian/checker.js';
import { amdKds, checkCrlSignature, loadRoot, snpChecker, SnpRefused, verifySnpEvidence, type SnpCheckOptions } from '../custodian/snp-checker.js';
import { parseHostPolicy, type HostPolicySevSnp, type SnpHost } from '../shared/release.js';
import { readSnpReport, SNP_REPORT_SIZE, type SnpTcb } from '../shared/snp-report.js';
import { certTable, evidenceOf, fixedCollateral, NOW, PROBE_TCB, reportBytes, signReport, testAmd, VCEK_KEY, type ReportSpec, type TestAmd } from './snp-kit.js';

/**
 * The chip check (vault comeback design §2.3, test T7): one table, one change per row, each refused with its reason;
 * the right report accepted. Real AMD data where it exists (a public Milan report and its VCEK, AMD's Milan revocation
 * list, AMD's pinned keys); a test-only chain for the rows a real chip would never sign. No call reaches AMD.
 */

const fixtures = path.join(import.meta.dirname, 'fixtures', 'snp');
const UKI = 'ab'.repeat(32);
const FIRMWARE = '8731846cdbcbb6aa5c624238b839544b1553f4c5af874450f043321b3ef8958b';
const DAY = 86_400_000;

let amd: TestAmd;
beforeAll(() => {
    amd = testAmd();
});

const ctx = (o: Partial<CheckContext> = {}): CheckContext => ({ release: '1.0.0', ukiSha256: UKI, ...o });

function hostEntry(o: Partial<SnpHost> & { measurement: Buffer; chipId?: Buffer }): SnpHost {
    const { measurement, chipId, ...rest } = o;
    return {
        profile: 'servury', product: 'Milan',
        launches: [{ ukiSha256: UKI, firmwareSha256: FIRMWARE, measurement: measurement.toString('hex'), source: 'computed' }],
        policies: ['0000030000000000'], minTcb: { ...PROBE_TCB }, requireAliasCheck: true,
        chipIds: chipId ? [chipId.toString('hex')] : [],
        ...rest,
    };
}

const policyOf = (...hosts: SnpHost[]): HostPolicySevSnp => parseHostPolicy({ platform: 'sev-snp', signer: 'vcek', hosts }) as HostPolicySevSnp;

// ─── AMD's real keys and data ────────────────────────────────────────────────────────────────

describe('AMD\'s pinned keys and a real Milan report', () => {
    it('the pinned ARK is self-signed, the ASK signed by it, and their fingerprints are the pinned ones', () => {
        const root = loadRoot('Milan');
        expect(root.ark.subject).toContain('CN=ARK-Milan');
        expect(root.ask.subject).toContain('CN=SEV-Milan');
        expect(root.ark.fingerprint256).toBe(AMD_ROOTS.Milan.arkFingerprint);
        expect(root.ask.verify(root.ark.publicKey)).toBe(true);
        // The ARK is RSA-4096, as AMD's is.
        expect(root.ark.publicKey.asymmetricKeyDetails?.modulusLength).toBe(4096);
    });

    it('a damaged pin is refused (the tool itself is damaged), and a product with no pin is refused by name', () => {
        const broken = { Milan: { ...AMD_ROOTS.Milan, askFingerprint: AMD_ROOTS.Milan.arkFingerprint } };
        expect(() => loadRoot('Milan', broken)).toThrow(expect.objectContaining({ code: 'amd_root_broken' }));
        expect(() => loadRoot('Genoa')).toThrow(expect.objectContaining({ code: 'no_amd_root', message: expect.stringMatching(/Genoa.*Milan only/) }));
        expect(() => loadRoot('constructor')).toThrow(expect.objectContaining({ code: 'no_amd_root' }));
    });

    it('AMD\'s real Milan revocation list (24 Nov 2026) verifies under the pinned ARK and lists nothing', () => {
        const crl = checkCrlSignature(readFileSync(path.join(fixtures, 'milan-crl-2026-11-24.der')), loadRoot('Milan'));
        expect(crl.revoked).toEqual([]);
        expect(new Date(crl.thisUpdate).toISOString()).toBe('2026-11-24T04:01:38.000Z');
        expect(new Date(crl.nextUpdate as number).toISOString()).toBe('2027-01-09T01:00:00.000Z');
    });

    const realReport = Buffer.from(readFileSync(path.join(fixtures, 'milan-report.hex'), 'utf8').trim(), 'hex');
    const realVcek = readFileSync(path.join(fixtures, 'milan-vcek.der'));
    const realCrl = readFileSync(path.join(fixtures, 'milan-crl-2026-11-24.der'));
    const real = readSnpReport(realReport);
    const realHost = (o: Partial<SnpHost> = {}) => hostEntry({
        measurement: real.measurement, chipId: real.chipId, requireAliasCheck: false,
        minTcb: { bootloader: 3, tee: 0, snp: 8, microcode: 115 }, ...o,
    });
    const realOpts = (o: Partial<SnpCheckOptions> = {}): SnpCheckOptions => ({
        collateral: fixedCollateral({ vcek: realVcek, crl: realCrl }), now: () => NOW, ...o,
    });

    it('accepts the real report with AMD\'s real chain, its own binding, and a policy naming its measurement and firmware', async () => {
        expect(real).toMatchObject({ version: 2, policy: 0x30000n, vmpl: 0, signingKey: 0, maskChipKey: false });
        const pass = await verifySnpEvidence(policyOf(realHost()), evidenceOf(realReport), real.reportData, ctx(), realOpts());
        expect(pass).toMatchObject({ profile: 'servury', newMachine: false, observed: false, measurement: real.measurement.toString('hex') });
        expect(pass.lines.join('\n')).toMatch(/chip check passed[\s\S]*Milan, chip d49554ec…[\s\S]*computed from our own build/);
    });

    it('... and with AMD\'s current certificate for that chip (reissued 25 Nov 2026: same key, new serial and dates)', async () => {
        const current = readFileSync(path.join(fixtures, 'milan-vcek-reissued-2026-11-25.der'));
        expect(new X509Certificate(current).publicKey.export({ format: 'jwk' })).toEqual(new X509Certificate(realVcek).publicKey.export({ format: 'jwk' }));
        await expect(verifySnpEvidence(policyOf(realHost()), evidenceOf(realReport), real.reportData, ctx(), realOpts({ collateral: fixedCollateral({ vcek: current, crl: realCrl }) })))
            .resolves.toMatchObject({ profile: 'servury' });
    });

    it('refuses the same real report the moment one thing about it is wrong', async () => {
        const v = (o: { report?: Buffer; bind?: Buffer; host?: Partial<SnpHost>; opts?: Partial<SnpCheckOptions>; ctx?: Partial<CheckContext> }) =>
            verifySnpEvidence(policyOf(realHost(o.host)), evidenceOf(o.report ?? realReport), o.bind ?? real.reportData, ctx(o.ctx), realOpts(o.opts));
        const flipped = Buffer.from(realReport);
        flipped[0x90] ^= 1;
        await expect(v({ report: flipped, host: { launches: [{ ukiSha256: UKI, firmwareSha256: FIRMWARE, measurement: flipped.subarray(0x90, 0xc0).toString('hex'), source: 'computed' }] } }))
            .rejects.toMatchObject({ code: 'report_signature' });
        await expect(v({ bind: crypto.randomBytes(64) })).rejects.toMatchObject({ code: 'report_data' });
        await expect(v({ host: { minTcb: { bootloader: 3, tee: 0, snp: 9, microcode: 115 } } })).rejects.toMatchObject({ code: 'tcb_below_floor' });
        await expect(v({ host: { requireAliasCheck: true } })).rejects.toMatchObject({ code: 'alias_check' });
        await expect(v({ opts: { now: () => Date.UTC(2027, 0, 10) } })).rejects.toMatchObject({ code: 'crl_stale' });
        await expect(v({ opts: { now: () => Date.UTC(2030, 4, 1) } })).rejects.toMatchObject({ code: 'vcek_expired' });
        // The real chip under a test root: not AMD's, so not genuine.
        await expect(v({ opts: { roots: amd.roots } })).rejects.toMatchObject({ code: 'vcek_chain' });
    });
});

// ─── The table ───────────────────────────────────────────────────────────────────────────────

const CHIP = crypto.createHash('sha512').update('a test chip').digest();
const MEASUREMENT = crypto.createHash('sha384').update('a test launch').digest();

interface Case {
    spec: ReportSpec;
    bind: Buffer;
    report: Buffer;
    host: SnpHost;
    policy: HostPolicySevSnp;
    vcek: Buffer;
    crl: Buffer;
    aux: Buffer;
    evidence: Buffer | null;
    ctx: CheckContext;
    collateral: { vcek?: Buffer | Error; crl?: Buffer | Error } | null;
    now: number;
}

/** The right report from the probe's shape, signed by the test chip; then `change` breaks one thing. */
function makeCase(change: (c: Case) => void = () => {}): Case {
    const bind = crypto.randomBytes(64);
    const spec: ReportSpec = { reportData: bind, measurement: MEASUREMENT, chipId: CHIP };
    const host = hostEntry({ measurement: MEASUREMENT, chipId: CHIP });
    const c: Case = {
        spec, bind, report: Buffer.alloc(0), host, policy: policyOf(host),
        vcek: amd.vcek(CHIP, PROBE_TCB), crl: amd.crl(), aux: Buffer.alloc(0), evidence: null, ctx: ctx(), collateral: null, now: NOW,
    };
    change(c);
    if (!c.report.length) c.report = signReport(reportBytes(c.spec));
    return c;
}

async function run(c: Case) {
    return verifySnpEvidence(c.policy, c.evidence ?? evidenceOf(c.report, c.aux), c.bind, c.ctx, {
        collateral: fixedCollateral(c.collateral ?? { vcek: c.vcek, crl: c.crl }), now: () => c.now, roots: amd.roots,
    });
}

const tcb = (o: Partial<SnpTcb>): SnpTcb => ({ ...PROBE_TCB, ...o });
const resign = (c: Case, edit: (r: Buffer) => void) => {
    const r = reportBytes(c.spec);
    edit(r);
    c.report = signReport(r);
};

const ROWS: [string, string, (c: Case) => void][] = [
    // 1: the evidence
    ['not BeanPool\'s wrapper', 'not_snp_evidence', c => { c.evidence = Buffer.concat([Buffer.from('XXXX\x01'), signReport(reportBytes(c.spec))]); }],
    ['a short report', 'not_snp_evidence', c => { c.evidence = evidenceOf(signReport(reportBytes(c.spec))).subarray(0, 5 + SNP_REPORT_SIZE - 1); }],
    ['an evidence version this tool does not know', 'not_snp_evidence', c => { c.evidence = evidenceOf(signReport(reportBytes(c.spec))); c.evidence[4] = 2; }],
    ['report version 1', 'report_version', c => { c.spec.version = 1; }],
    ['report version 6', 'report_version', c => { c.spec.version = 6; }],
    ['a signature algorithm other than ECDSA P-384', 'report_signature', c => { c.spec.signatureAlgo = 2; }],
    ['a signature wider than P-384', 'report_signature', c => { resign(c, () => {}); c.report[0x2a0 + 60] = 1; }],
    ['extra bytes after the certificate table that are not one', 'cert_table', c => { c.aux = Buffer.alloc(30, 7); }],
    // 2: fresh and for this session
    ['another nonce (the report is over another hello\'s binding)', 'report_data', c => { c.spec.reportData = crypto.randomBytes(64); }],
    ['a replayed old report (made for an earlier hello)', 'report_data', c => { c.report = signReport(reportBytes(c.spec)); c.bind = crypto.randomBytes(64); }],
    // 4 and 5, whatever a release says
    ['debug allowed (policy bit 19)', 'debug_on', c => { c.spec.policy = 0x30000n | (1n << 19n); }],
    ['a migration agent allowed (policy bit 18)', 'migration_agent', c => { c.spec.policy = 0x30000n | (1n << 18n); }],
    ['VMPL 1', 'vmpl', c => { c.spec.vmpl = 1; }],
    ['a cloud\'s key (VLEK) signs', 'not_vcek', c => { c.spec.signer = 1 << 2; }],
    ['the chip key masked (MASK_CHIP_KEY)', 'chip_key_masked', c => { c.spec.signer = 0x2; }],
    ['the chip ID zeroed (MASK_CHIP_ID)', 'chip_id_masked', c => { c.spec.chipId = Buffer.alloc(64); }],
    // 3: our software
    ['a measurement the release does not list', 'measurement', c => { c.spec.measurement = crypto.randomBytes(48); }],
    ['the release\'s measurement listed for another host only', 'measurement', c => {
        c.policy = policyOf({ ...c.host, profile: 'spare', launches: [{ ...c.host.launches[0], measurement: 'cd'.repeat(48) }] });
    }],
    // 4: the release's guest policy
    ['a guest policy the release does not list (single socket, bit 20)', 'guest_policy', c => { c.spec.policy = 0x30000n | (1n << 20n); }],
    // 6
    ['no alias check, which the release requires', 'alias_check', c => { c.spec.platformInfo = 0x1n; }],
    // 7: firmware at or above the floor, part by part, in all three TCBs
    ['reported SNP firmware 28 (floor 29)', 'tcb_below_floor', c => { c.spec.reportedTcb = tcb({ snp: 28 }); c.vcek = amd.vcek(CHIP, tcb({ snp: 28 })); }],
    ['reported microcode below the floor', 'tcb_below_floor', c => { c.spec.reportedTcb = tcb({ microcode: 221 }); }],
    ['reported bootloader below the floor', 'tcb_below_floor', c => { c.spec.reportedTcb = tcb({ bootloader: 3 }); }],
    ['committed TCB below the floor', 'tcb_below_floor', c => { c.spec.committedTcb = tcb({ snp: 28 }); }],
    ['launch TCB below the floor', 'tcb_below_floor', c => { c.spec.launchTcb = tcb({ snp: 20 }); }],
    // 8: a genuine AMD chip
    ['a VCEK chained to a root that is not AMD\'s', 'vcek_chain', c => { c.vcek = testAmd().vcek(CHIP, PROBE_TCB); }],
    ['a VCEK signed by the ARK directly, not the ASK', 'vcek_chain', c => { c.vcek = amd.vcek(CHIP, PROBE_TCB, { signer: amd.ark.key.privateKey }); }],
    ['an expired VCEK', 'vcek_expired', c => { c.vcek = amd.vcek(CHIP, PROBE_TCB, { notBefore: NOW - 400 * DAY, notAfter: NOW - DAY }); }],
    ['a VCEK not valid yet (or a wrong clock)', 'vcek_expired', c => { c.vcek = amd.vcek(CHIP, PROBE_TCB, { notBefore: NOW + DAY }); }],
    ['a VCEK for another chip', 'vcek_chip', c => { c.vcek = amd.vcek(crypto.randomBytes(64), PROBE_TCB); }],
    ['a VCEK for other firmware levels', 'vcek_tcb', c => { c.vcek = amd.vcek(CHIP, tcb({ snp: 30 })); }],
    ['a VCEK for another product', 'vcek_product', c => { c.vcek = amd.vcek(CHIP, PROBE_TCB, { product: 'Genoa-B1' }); }],
    ['a VLEK in the VCEK\'s place', 'not_vcek', c => { c.vcek = amd.vcek(CHIP, PROBE_TCB, { cn: 'SEV-VLEK' }); }],
    ['a VCEK that is not a certificate', 'vcek_malformed', c => { c.vcek = Buffer.from('not a certificate'); }],
    ['a report signed by another key', 'report_signature', c => { c.report = signReport(reportBytes(c.spec), crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey); }],
    ['a report changed after it was signed', 'report_signature', c => { c.report = signReport(reportBytes(c.spec)); c.report[0x140] ^= 0xff; }],
    ['no VCEK to be had (AMD unreachable, none cached)', 'vcek_unavailable', c => { c.collateral = { vcek: new Error('offline'), crl: c.crl }; }],
    // 9: revocation
    ['AMD\'s list revokes the ASK', 'ask_revoked', c => { c.crl = amd.crl({ revoked: [0x10001] }); }],
    ['a stale list (its next update has passed)', 'crl_stale', c => { c.crl = amd.crl({ thisUpdate: NOW - 60 * DAY, nextUpdate: NOW - DAY }); }],
    ['a list not yet in date', 'crl_stale', c => { c.crl = amd.crl({ thisUpdate: NOW + DAY }); }],
    ['a list with no next update', 'crl_stale', c => { c.crl = amd.crl({ nextUpdate: null }); }],
    ['a list signed by another key', 'crl_signature', c => { c.crl = amd.crl({ signer: amd.ask.key.privateKey }); }],
    ['a list that is not one', 'crl_malformed', c => { c.crl = Buffer.from([0x30, 0x03, 0x02, 0x01, 0x01]); }],
    ['no list to be had', 'crl_unavailable', c => { c.collateral = { vcek: c.vcek, crl: new Error('offline') }; }],
    // 10: a chip this vault has run on
    ['a chip the release does not list', 'new_machine', c => { c.host = { ...c.host, chipIds: ['ee'.repeat(64)] }; c.policy = policyOf(c.host); }],
    ['a release that lists no chip yet', 'new_machine', c => { c.host = { ...c.host, chipIds: [] }; c.policy = policyOf(c.host); }],
    ['--accept-new-machine naming another chip', 'new_machine', c => { c.host = { ...c.host, chipIds: [] }; c.policy = policyOf(c.host); c.ctx = ctx({ acceptNewMachine: 'eeeeeeee' }); }],
    // 11: the release the hello names
    ['the launch of another release\'s UKI', 'release_measurement', c => { c.ctx = ctx({ ukiSha256: 'cd'.repeat(32), release: '1.1.0' }); }],
    // The policy's chip family has no pinned root here.
    ['a chip family this tool pins no root for', 'no_amd_root', c => { c.host = { ...c.host, product: 'Genoa' }; c.policy = policyOf(c.host); }],
];

describe('the chip check refuses, one thing wrong at a time, and says what', () => {
    it('accepts the right report (the probe\'s shape: v5, policy 0x30000, VMPL 0, TCB 4/0/29/222)', async () => {
        const c = makeCase();
        const pass = await run(c);
        expect(pass).toMatchObject({ profile: 'servury', newMachine: false, observed: false, chipId: CHIP.toString('hex') });
        expect(pass.lines.join('\n')).toMatch(/reported bootloader 4, tee 0, snp 29, microcode 222 \(the release's floor: bootloader 4, tee 0, snp 29, microcode 222\)/);
    });

    it.each(ROWS)('refuses %s (%s)', async (_what, code, change) => {
        const c = makeCase(change);
        const err = await run(c).then(() => null, e => e as Error);
        expect(err).toBeInstanceOf(SnpRefused);
        expect((err as SnpRefused).code).toBe(code);
        expect(err?.message.length).toBeGreaterThan(20);
    });

    it('every refusal code in the checker has a row', () => {
        const src = readFileSync(path.join(import.meta.dirname, '..', 'custodian', 'snp-checker.ts'), 'utf8');
        const codes = new Set([...src.matchAll(/refuse\('([a-z_]+)'/g)].map(m => m[1]));
        const covered = new Set(ROWS.map(r => r[1]));
        // amd_root_broken is covered above against the real pins.
        covered.add('amd_root_broken');
        expect([...codes].filter(code => !covered.has(code))).toEqual([]);
    });
});

describe('what may pass', () => {
    it('a new chip passes only when the custodian named its first 8 characters, after every other check', async () => {
        const fresh = (accept?: string) => makeCase(c => { c.host = { ...c.host, chipIds: [] }; c.policy = policyOf(c.host); c.ctx = ctx({ acceptNewMachine: accept }); });
        const pass = await run(fresh(CHIP.toString('hex').slice(0, 8)));
        expect(pass.newMachine).toBe(true);
        expect(pass.lines.join('\n')).toMatch(/NEW: accepted by you/);
        // The refusal names the chip, so the custodian can type it.
        await expect(run(fresh())).rejects.toThrow(`--accept-new-machine ${CHIP.toString('hex').slice(0, 8)}`);
        // The flag overrides nothing else: a new chip with debug on is refused for debug.
        const debug = makeCase(c => { c.host = { ...c.host, chipIds: [] }; c.policy = policyOf(c.host); c.ctx = ctx({ acceptNewMachine: CHIP.toString('hex').slice(0, 8) }); c.spec.policy = 0x30000n | (1n << 19n); });
        await expect(run(debug)).rejects.toMatchObject({ code: 'debug_on' });
    });

    it('the VCEK may come from the host\'s certificate table instead of AMD (only the pinned root decides)', async () => {
        const c = makeCase(x => { x.aux = certTable(x.vcek); x.collateral = { vcek: new Error('must not be asked'), crl: x.crl }; });
        expect((await run(c)).lines.join('\n')).toMatch(/VCEK from the host's certificate table/);
        const bad = makeCase(x => { x.aux = certTable(testAmd().vcek(CHIP, PROBE_TCB)); });
        await expect(run(bad)).rejects.toMatchObject({ code: 'vcek_chain' });
    });

    describe('a host\'s certificate table whose VCEK does not fit the report: AMD\'s key server is asked instead', () => {
        // Servury patches to SNP 31 (AMD-SB-3059) but its certificate table still holds the SNP 29 VCEK.
        const SNP31 = tcb({ snp: 31 });
        const patched = (table: Buffer, change: (c: Case) => void = () => {}) => makeCase(x => {
            x.spec.reportedTcb = SNP31;
            x.aux = certTable(table);
            x.vcek = amd.vcek(CHIP, SNP31);
            change(x);
        });
        const runCounting = async (c: Case) => {
            const collateral = fixedCollateral(c.collateral ?? { vcek: c.vcek, crl: c.crl });
            const result = await verifySnpEvidence(c.policy, evidenceOf(c.report, c.aux), c.bind, c.ctx, { collateral, now: () => c.now, roots: amd.roots })
                .then(pass => ({ pass, err: null }), (err: unknown) => ({ pass: null, err: err as SnpRefused }));
            return { ...result, calls: collateral.calls };
        };

        it.each([
            ['AMD\'s VCEK for this chip at the old firmware levels (SNP 29; the report says 31)', 'vcek_tcb', () => amd.vcek(CHIP, PROBE_TCB)],
            ['another chip\'s VCEK', 'vcek_chip', () => amd.vcek(crypto.randomBytes(64), SNP31)],
            ['a VCEK past its dates', 'vcek_expired', () => amd.vcek(CHIP, SNP31, { notBefore: NOW - 400 * DAY, notAfter: NOW - DAY })],
        ])('the table holds %s: AMD\'s VCEK at the reported levels verifies, and the check passes saying so', async (_what, tableCode, table) => {
            const { pass, err, calls } = await runCounting(patched(table()));
            expect(err).toBeNull();
            expect(calls).toEqual([`vcek Milan ${CHIP.toString('hex').slice(0, 8)} 31`, 'crl Milan']);
            const certificates = pass?.lines.find(l => l.trimStart().startsWith('certificates')) ?? '';
            expect(certificates).toMatch(/VCEK from AMD's key server \(the host's certificate table holds one that does not fit: /);
            expect(certificates).toMatch(/chained to AMD's Milan root pinned in this tool/);
            // The same table alone (AMD unreachable) is refused for exactly what is wrong with it.
            const offline = await runCounting(patched(table(), x => { x.collateral = { vcek: new Error('offline'), crl: x.crl }; }));
            expect(offline.err).toBeInstanceOf(SnpRefused);
            expect(offline.err?.code).toBe(tableCode);
            expect(offline.err?.message).toMatch(/host's certificate table, and the chip's certificate \(VCEK\) could not be had from AMD's key server \(offline\): connect to the internet/);
        });

        it('AMD\'s answer that does not fit either is refused with its own reason, and the table\'s beside it', async () => {
            const stale = amd.vcek(CHIP, PROBE_TCB);
            const same = await runCounting(patched(stale, x => { x.vcek = amd.vcek(CHIP, PROBE_TCB); }));
            expect(same.err?.code).toBe('vcek_tcb');
            expect(same.err?.message).toMatch(/from AMD's key server; the host's certificate table's did not fit either: the chip's certificate is for other firmware levels/);
            const otherChip = await runCounting(patched(stale, x => { x.vcek = amd.vcek(crypto.randomBytes(64), SNP31); }));
            expect(otherChip.err?.code).toBe('vcek_chip');
        });

        it('never a VCEK that does not chain to the pinned root, from either place', async () => {
            // AMD's "answer" (a hostile network, a tampered cache) is signed by another root: refused, never accepted.
            const forgedAnswer = await runCounting(patched(amd.vcek(CHIP, PROBE_TCB), x => { x.vcek = testAmd().vcek(CHIP, SNP31); }));
            expect(forgedAnswer.err?.code).toBe('vcek_chain');
            // A table whose VCEK is not AMD's at all is a refusal by itself: the table is no reason to ask AMD.
            const forgedTable = await runCounting(patched(testAmd().vcek(CHIP, SNP31)));
            expect(forgedTable.err?.code).toBe('vcek_chain');
            expect(forgedTable.calls).toEqual([]);
            // A table VCEK that fits is used as it is: AMD is not asked.
            const fits = await runCounting(patched(amd.vcek(CHIP, SNP31), x => { x.collateral = { vcek: new Error('must not be asked'), crl: x.crl }; }));
            expect(fits.err).toBeNull();
            expect(fits.calls).toEqual(['crl Milan']);
        });

        it('AMD\'s VCEK that verifies is no pass for a report it did not sign', async () => {
            const other = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey;
            const { err } = await runCounting(patched(amd.vcek(CHIP, PROBE_TCB), x => { x.report = signReport(reportBytes(x.spec), other); }));
            expect(err?.code).toBe('report_signature');
        });
    });

    it('an older release\'s launch passes when the vault runs that release (the overlap while a new image waits)', async () => {
        const OLD_UKI = 'ef'.repeat(32);
        const c = makeCase(x => {
            x.host = { ...x.host, launches: [{ ...x.host.launches[0], ukiSha256: OLD_UKI }, { ukiSha256: UKI, firmwareSha256: FIRMWARE, measurement: '12'.repeat(48), source: 'computed' }] };
            x.policy = policyOf(x.host);
            x.ctx = ctx({ release: '0.9.0', ukiSha256: OLD_UKI });
        });
        await expect(run(c)).resolves.toMatchObject({ profile: 'servury' });
    });

    it('a measurement signed into the release as observed passes, and every unlock says it was not computed', async () => {
        const c = makeCase(x => { x.host = { ...x.host, launches: [{ ...x.host.launches[0], source: 'observed' }] }; x.policy = policyOf(x.host); });
        const pass = await run(c);
        expect(pass.observed).toBe(true);
        expect(pass.lines.join('\n')).toMatch(/OBSERVED on the server .*NOT computed from our own build/);
    });

    it('two hosts: the report must satisfy one entry whole (the spare\'s looser floor does not lend itself to the main)', async () => {
        const c = makeCase(x => {
            x.spec.reportedTcb = tcb({ snp: 28 });
            x.vcek = amd.vcek(CHIP, tcb({ snp: 28 }));
            const spare: SnpHost = { ...x.host, profile: 'spare', launches: [{ ...x.host.launches[0], measurement: 'cd'.repeat(48) }], minTcb: tcb({ snp: 1 }) };
            x.policy = policyOf(x.host, spare);
        });
        await expect(run(c)).rejects.toMatchObject({ code: 'tcb_below_floor' });
    });

    it('the registered checker answers ok with the summary, or the reason; an unexpected error is a refusal, never a pass', async () => {
        const c = makeCase();
        const opts = { collateral: fixedCollateral({ vcek: c.vcek, crl: c.crl }), now: () => NOW, roots: amd.roots };
        await expect(snpChecker(opts).check(c.policy, evidenceOf(c.report), c.bind, c.ctx)).resolves.toMatchObject({ ok: true, lines: expect.any(Array) });
        await expect(snpChecker(opts).check(c.policy, evidenceOf(c.report), crypto.randomBytes(64), c.ctx)).resolves.toMatchObject({ ok: false, code: 'report_data' });
        const throwing = { ...opts, collateral: { vcek: () => { throw new TypeError('boom'); }, crl: async () => c.crl } as never };
        await expect(snpChecker(throwing).check(c.policy, evidenceOf(c.report), c.bind, c.ctx)).resolves.toMatchObject({ ok: false, code: 'vcek_unavailable' });
        await expect(snpChecker({ ...opts, now: () => { throw new TypeError('no clock'); } }).check(c.policy, evidenceOf(c.report), c.bind, c.ctx))
            .resolves.toMatchObject({ ok: false, code: 'check_failed' });
    });
});

// ─── The release's policy ────────────────────────────────────────────────────────────────────

describe('the sev-snp host policy in a release (design §2.4)', () => {
    const good = () => ({ platform: 'sev-snp', signer: 'vcek', hosts: [hostEntry({ measurement: MEASUREMENT, chipId: CHIP })] }) as unknown as Record<string, unknown> & { hosts: Record<string, unknown>[] };
    it('parses the day-zero shape', () => {
        expect(parseHostPolicy(good())).toEqual(good());
    });
    const rows: [string, (p: ReturnType<typeof good>) => void, RegExp][] = [
        ['the old one-measurement shape', p => { Object.assign(p, { measurement: 'ab'.repeat(48), minReportedTcb: '00'.repeat(8), policy: '00'.repeat(8) }); delete (p as Record<string, unknown>).hosts; }, /does not know/],
        ['a cloud\'s signer', p => { p.signer = 'vlek'; }, /signer is vcek/],
        ['no host', p => { p.hosts = []; }, /1 to 8/],
        ['a policy allowing debug', p => { p.hosts[0].policies = ['00000b0000000000']; }, /debug/],
        ['a policy allowing a migration agent', p => { p.hosts[0].policies = ['0000070000000000']; }, /migration agent/],
        ['no launch', p => { p.hosts[0].launches = []; }, /launches is empty/],
        ['a launch without its UKI', p => { delete (p.hosts[0].launches as Record<string, unknown>[])[0].ukiSha256; }, /SHA-256/],
        ['a launch neither computed nor observed', p => { (p.hosts[0].launches as Record<string, unknown>[])[0].source = 'guessed'; }, /computed or observed/],
        ['a measurement listed twice', p => { p.hosts[0].launches = [(p.hosts[0].launches as unknown[])[0], (p.hosts[0].launches as unknown[])[0]]; }, /twice/],
        ['a floor over 255', p => { (p.hosts[0].minTcb as Record<string, number>).snp = 256; }, /0 to 255/],
        ['a floor without microcode', p => { delete (p.hosts[0].minTcb as Record<string, number>).microcode; }, /0 to 255/],
        ['no alias-check rule', p => { delete p.hosts[0].requireAliasCheck; }, /lacks requireAliasCheck/],
        ['no chip list', p => { delete p.hosts[0].chipIds; }, /lacks chipIds/],
        ['a chip that is not 64 bytes', p => { p.hosts[0].chipIds = ['ab']; }, /64-byte/],
        ['two hosts of one profile', p => { p.hosts = [p.hosts[0], p.hosts[0]]; }, /profile twice/],
        ['a field nobody knows', p => { p.hosts[0].extra = 1; }, /does not know: extra/],
    ];
    it.each(rows)('refuses %s', (_what, change, why) => {
        const p = good();
        change(p);
        expect(() => parseHostPolicy(p)).toThrow(why);
    });
    it('a chip family the tool lacks still parses (the chain walks on; the tool refuses at the unlock)', () => {
        const p = good();
        p.hosts[0].product = 'Turin';
        expect(parseHostPolicy(p)).toMatchObject({ hosts: [{ product: 'Turin' }] });
    });
});

// ─── AMD's key server and the cache ──────────────────────────────────────────────────────────

describe('amdKds: AMD\'s key server, cached (no real AMD call)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bv-kds-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    function fakeAmd(answers: Record<string, Buffer | number>) {
        const asked: string[] = [];
        const fetch = async (url: string) => {
            asked.push(url);
            const key = Object.keys(answers).find(k => url.includes(k));
            const a = key === undefined ? 404 : answers[key];
            return typeof a === 'number'
                ? { ok: false, status: a, arrayBuffer: async () => new ArrayBuffer(0) }
                : { ok: true, status: 200, arrayBuffer: async () => a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength) as ArrayBuffer };
        };
        return { fetch, asked };
    }

    it('asks AMD for the VCEK by chip and firmware level once, caches it, then works offline', async () => {
        const cacheDir = mkdtempSync(path.join(dir, 'c-'));
        const vcek = amd.vcek(CHIP, PROBE_TCB);
        const online = fakeAmd({ [`/vcek/v1/Milan/${CHIP.toString('hex')}`]: vcek });
        const kds = amdKds({ cacheDir, fetch: online.fetch, roots: amd.roots });
        expect(await kds.vcek('Milan', CHIP, PROBE_TCB)).toEqual(vcek);
        expect(online.asked).toEqual([`https://kdsintf.amd.com/vcek/v1/Milan/${CHIP.toString('hex')}?blSPL=04&teeSPL=00&snpSPL=29&ucodeSPL=222`]);
        const offline = fakeAmd({});
        expect(await amdKds({ cacheDir, fetch: offline.fetch, roots: amd.roots }).vcek('Milan', CHIP, PROBE_TCB)).toEqual(vcek);
        expect(offline.asked).toEqual([]);
    });

    it('asks again for a cached VCEK that is past its dates (AMD reissues them)', async () => {
        const cacheDir = mkdtempSync(path.join(dir, 'c-'));
        const old = amd.vcek(CHIP, PROBE_TCB, { notBefore: NOW - 400 * DAY, notAfter: NOW + DAY });
        const fresh = amd.vcek(CHIP, PROBE_TCB);
        await amdKds({ cacheDir, fetch: fakeAmd({ '/vcek/v1/Milan/': old }).fetch, roots: amd.roots, now: () => NOW }).vcek('Milan', CHIP, PROBE_TCB);
        const later = fakeAmd({ '/vcek/v1/Milan/': fresh });
        expect(await amdKds({ cacheDir, fetch: later.fetch, roots: amd.roots, now: () => NOW + 2 * DAY }).vcek('Milan', CHIP, PROBE_TCB)).toEqual(fresh);
        expect(later.asked.length).toBe(1);
    });

    it('does not cache a VCEK that is not signed by the pinned ASK', async () => {
        const cacheDir = mkdtempSync(path.join(dir, 'c-'));
        const forged = testAmd().vcek(CHIP, PROBE_TCB);
        const kds = amdKds({ cacheDir, fetch: fakeAmd({ '/vcek/v1/Milan/': forged }).fetch, roots: amd.roots });
        await kds.vcek('Milan', CHIP, PROBE_TCB);
        expect(readdirSync(cacheDir)).toEqual([]);
    });

    it('fetches the revocation list every time; a cached one only when AMD can\'t be reached; none at all: an error', async () => {
        const cacheDir = mkdtempSync(path.join(dir, 'c-'));
        const first = amd.crl();
        const second = amd.crl({ thisUpdate: NOW - DAY });
        expect(await amdKds({ cacheDir, fetch: fakeAmd({ '/crl': first }).fetch, roots: amd.roots }).crl('Milan')).toEqual(first);
        expect(await amdKds({ cacheDir, fetch: fakeAmd({ '/crl': second }).fetch, roots: amd.roots }).crl('Milan')).toEqual(second);
        expect(await amdKds({ cacheDir, fetch: fakeAmd({ '/crl': 503 }).fetch, roots: amd.roots }).crl('Milan')).toEqual(second);
        // A list from the network that is not signed by the pinned ARK neither replaces the cached one nor is used.
        expect(await amdKds({ cacheDir, fetch: fakeAmd({ '/crl': amd.crl({ signer: amd.ask.key.privateKey }) }).fetch, roots: amd.roots }).crl('Milan')).toEqual(second);
        const empty = mkdtempSync(path.join(dir, 'c-'));
        await expect(amdKds({ cacheDir: empty, fetch: fakeAmd({ '/crl': 503 }).fetch, roots: amd.roots }).crl('Milan')).rejects.toThrow(/could not be fetched.*none is cached/);
    });

    it('a cached file that was tampered with only makes the check refuse', async () => {
        const cacheDir = mkdtempSync(path.join(dir, 'c-'));
        const c = makeCase();
        const kds = amdKds({ cacheDir, fetch: fakeAmd({ '/vcek/v1/Milan/': c.vcek, '/crl': c.crl }).fetch, roots: amd.roots });
        await kds.vcek('Milan', CHIP, PROBE_TCB);
        const [file] = readdirSync(path.join(cacheDir, 'Milan')).filter(f => f.startsWith('vcek-'));
        writeFileSync(path.join(cacheDir, 'Milan', file), testAmd().vcek(CHIP, PROBE_TCB));
        await expect(verifySnpEvidence(c.policy, evidenceOf(c.report), c.bind, c.ctx, { collateral: kds, now: () => NOW, roots: amd.roots }))
            .rejects.toMatchObject({ code: 'vcek_chain' });
    });
});

// Keeps the test key's public half honest: the VCEK the kit makes carries VCEK_KEY.
it('the kit\'s VCEK carries the kit\'s chip key', () => {
    const cert = new X509Certificate(amd.vcek(CHIP, PROBE_TCB));
    expect(cert.publicKey.export({ format: 'jwk' })).toEqual(crypto.createPublicKey(VCEK_KEY).export({ format: 'jwk' }));
});
