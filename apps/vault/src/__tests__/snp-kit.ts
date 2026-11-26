import crypto, { X509Certificate, type KeyObject } from 'node:crypto';
import { oidBytes } from '../custodian/der.js';
import type { AmdRoot } from '../custodian/amd-roots.js';
import type { SnpCollateral } from '../custodian/snp-checker.js';
import { SNP_REPORT_SIZE, SNP_SIGNED_BYTES, snpEvidence, tcbBytes, type SnpTcb } from '../shared/snp-report.js';

/**
 * A test-only AMD: an ARK, an ASK and a chip's VCEK made the way AMD makes them (RSA-PSS with SHA-384 down to a P-384
 * VCEK carrying AMD's chip and firmware-level extensions), revocation lists, and SEV-SNP reports in the real layout
 * signed by that VCEK. For the rows a real chip would never sign (vault comeback design §6 T7). Nothing here talks to
 * AMD.
 */

// ─── A small DER writer ──────────────────────────────────────────────────────────────────────

function lenBytes(n: number): number[] {
    if (n < 0x80) return [n];
    const out: number[] = [];
    for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
    return [0x80 | out.length, ...out];
}
export const tlv = (tag: number, ...parts: Buffer[]) => {
    const c = Buffer.concat(parts);
    return Buffer.concat([Buffer.from([tag, ...lenBytes(c.length)]), c]);
};
export const seq = (...p: Buffer[]) => tlv(0x30, ...p);
const set = (...p: Buffer[]) => tlv(0x31, ...p);
export const int = (v: number | Buffer) => {
    let b = typeof v === 'number' ? Buffer.from(v.toString(16).padStart(2, '0').replace(/^(.(..)*)$/, '0$1'), 'hex') : v;
    while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
    if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
    return tlv(0x02, b);
};
export const oid = (dotted: string) => tlv(0x06, oidBytes(dotted));
const octet = (b: Buffer) => tlv(0x04, b);
const bits = (b: Buffer) => tlv(0x03, Buffer.from([0]), b);
const explicit = (n: number, inner: Buffer) => tlv(0xa0 + n, inner);
export const utcTime = (ms: number) => tlv(0x17, Buffer.from(`${new Date(ms).toISOString().slice(2, 19).replace(/[-T:]/g, '')}Z`, 'latin1'));
const name = (cn: string) => seq(
    set(seq(oid('2.5.4.11'), tlv(0x0c, Buffer.from('Engineering')))),
    set(seq(oid('2.5.4.10'), tlv(0x0c, Buffer.from('Advanced Micro Devices')))),
    set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn)))),
);
/** AMD's own AlgorithmIdentifier: RSASSA-PSS, SHA-384, MGF1 SHA-384, salt 48 (from the ARK-Milan certificate). */
export const RSA_PSS_SHA384 = Buffer.from('MEYGCSqGSIb3DQEBCjA5oA8wDQYJYIZIAWUDBAICBQChHDAaBgkqhkiG9w0BAQgwDQYJYIZIAWUDBAICBQCiAwIBMKMDAgEB', 'base64');

const pss = (key: KeyObject, data: Buffer) => crypto.sign('sha384', data, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 48 });

const DAY = 86_400_000;
export const NOW = Date.UTC(2026, 10, 26, 6, 0, 0);

interface CertSpec {
    serial: number;
    issuer: string;
    subject: string;
    publicKey: KeyObject;
    signer: KeyObject;
    notBefore?: number;
    notAfter?: number;
    extensions?: Buffer[];
}

function cert(s: CertSpec): Buffer {
    const tbs = seq(
        explicit(0, int(2)),
        int(s.serial),
        RSA_PSS_SHA384,
        name(s.issuer),
        seq(utcTime(s.notBefore ?? NOW - 365 * DAY), utcTime(s.notAfter ?? NOW + 365 * DAY)),
        name(s.subject),
        s.publicKey.export({ type: 'spki', format: 'der' }),
        ...(s.extensions?.length ? [explicit(3, seq(...s.extensions))] : []),
    );
    return seq(tbs, RSA_PSS_SHA384, bits(pss(s.signer, tbs)));
}

const caExtensions = [seq(oid('2.5.29.19'), tlv(0x01, Buffer.from([0xff])), octet(seq(tlv(0x01, Buffer.from([0xff])))))];

export const pem = (der: Buffer) => `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g)?.join('\n')}\n-----END CERTIFICATE-----`;

// ─── The test AMD ────────────────────────────────────────────────────────────────────────────

export interface TestAmd {
    ark: { key: crypto.KeyPairKeyObjectResult; der: Buffer };
    ask: { key: crypto.KeyPairKeyObjectResult; der: Buffer };
    roots: Record<string, AmdRoot>;
    /** A VCEK for this chip and these levels, signed by the test ASK (or `signer`). */
    vcek(chipId: Buffer, tcb: SnpTcb, o?: { key?: KeyObject; signer?: KeyObject; notAfter?: number; notBefore?: number; cn?: string; product?: string; issuer?: string }): Buffer;
    crl(o?: { revoked?: number[]; thisUpdate?: number; nextUpdate?: number | null; signer?: KeyObject }): Buffer;
}

const AMD_EXT = '1.3.6.1.4.1.3704.1';

export function testAmd(): TestAmd {
    const rsa = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const arkKey = rsa();
    const askKey = rsa();
    const arkDer = cert({ serial: 0x10000, issuer: 'ARK-Milan', subject: 'ARK-Milan', publicKey: arkKey.publicKey, signer: arkKey.privateKey, extensions: caExtensions });
    const askDer = cert({ serial: 0x10001, issuer: 'ARK-Milan', subject: 'SEV-Milan', publicKey: askKey.publicKey, signer: arkKey.privateKey, extensions: caExtensions });
    const fp = (der: Buffer) => new X509Certificate(der).fingerprint256;
    return {
        ark: { key: arkKey, der: arkDer },
        ask: { key: askKey, der: askDer },
        roots: { Milan: { arkPem: pem(arkDer), askPem: pem(askDer), arkFingerprint: fp(arkDer), askFingerprint: fp(askDer) } },
        vcek(chipId, tcb, o = {}) {
            const ext = (sub: string, value: Buffer) => seq(oid(`${AMD_EXT}.${sub}`), octet(value));
            return cert({
                serial: 0, issuer: o.issuer ?? 'SEV-Milan', subject: o.cn ?? 'SEV-VCEK',
                publicKey: o.key ?? crypto.createPublicKey(VCEK_KEY), signer: o.signer ?? askKey.privateKey,
                notBefore: o.notBefore, notAfter: o.notAfter ?? NOW + 7 * 365 * DAY,
                extensions: [
                    ext('1', int(0)),
                    ext('2', tlv(0x16, Buffer.from(o.product ?? 'Milan-B0', 'latin1'))),
                    ext('3.1', int(tcb.bootloader)),
                    ext('3.2', int(tcb.tee)),
                    ext('3.3', int(tcb.snp)),
                    ext('3.8', int(tcb.microcode)),
                    ext('4', chipId),
                ],
            });
        },
        crl(o = {}) {
            const revoked = (o.revoked ?? []).map(serial => seq(int(serial), utcTime(NOW - DAY)));
            const next = o.nextUpdate === undefined ? NOW + 40 * DAY : o.nextUpdate;
            const tbs = seq(
                int(1),
                RSA_PSS_SHA384,
                name('ARK-Milan'),
                utcTime(o.thisUpdate ?? NOW - 2 * DAY),
                ...(next === null ? [] : [utcTime(next)]),
                ...(revoked.length ? [seq(...revoked)] : []),
            );
            return seq(tbs, RSA_PSS_SHA384, bits(pss(o.signer ?? arkKey.privateKey, tbs)));
        },
    };
}

/** One P-384 key for every test VCEK unless a test asks for another (key generation is the slow part). */
export const VCEK_KEY = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey;

// ─── Reports ─────────────────────────────────────────────────────────────────────────────────

/** The 26 Nov probe's values (scratch/vault-host/PROBE-servury-2026-11-26.txt): report v5, VMPL 0, policy 0x30000. */
export const PROBE_TCB: SnpTcb = { bootloader: 4, tee: 0, snp: 29, microcode: 222 };

export interface ReportSpec {
    version?: number;
    policy?: bigint;
    vmpl?: number;
    signatureAlgo?: number;
    platformInfo?: bigint;
    signer?: number;
    reportData: Buffer;
    measurement: Buffer;
    reportedTcb?: SnpTcb;
    committedTcb?: SnpTcb;
    launchTcb?: SnpTcb;
    chipId: Buffer;
    cpuid?: [number, number, number];
}

/** A report in the real layout (offsets: go-sev-guest abi.go), unsigned. */
export function reportBytes(s: ReportSpec): Buffer {
    const r = Buffer.alloc(SNP_REPORT_SIZE);
    r.writeUInt32LE(s.version ?? 5, 0x00);
    r.writeBigUInt64LE(s.policy ?? 0x30000n, 0x08);
    r.writeUInt32LE(s.vmpl ?? 0, 0x30);
    r.writeUInt32LE(s.signatureAlgo ?? 1, 0x34);
    tcbBytes(s.reportedTcb ?? PROBE_TCB).copy(r, 0x38);
    // SMT on, alias check complete (bit 5).
    r.writeBigUInt64LE(s.platformInfo ?? 0x21n, 0x40);
    r.writeUInt32LE(s.signer ?? 0, 0x48);
    s.reportData.copy(r, 0x50);
    s.measurement.copy(r, 0x90);
    tcbBytes(s.reportedTcb ?? PROBE_TCB).copy(r, 0x180);
    const [fam, mod, step] = s.cpuid ?? [0x19, 0x01, 0x01];
    r[0x188] = fam;
    r[0x189] = mod;
    r[0x18a] = step;
    s.chipId.copy(r, 0x1a0);
    tcbBytes(s.committedTcb ?? s.reportedTcb ?? PROBE_TCB).copy(r, 0x1e0);
    tcbBytes(s.launchTcb ?? s.reportedTcb ?? PROBE_TCB).copy(r, 0x1f0);
    return r;
}

/** Signs bytes 0x000-0x29F with `key` (P-384, SHA-384), R and S little-endian in their 72-byte fields. */
export function signReport(report: Buffer, key: KeyObject = VCEK_KEY): Buffer {
    const out = Buffer.from(report);
    out.fill(0, SNP_SIGNED_BYTES);
    const sig = crypto.sign('sha384', out.subarray(0, SNP_SIGNED_BYTES), { key, dsaEncoding: 'ieee-p1363' });
    Buffer.from(sig.subarray(0, 48)).reverse().copy(out, SNP_SIGNED_BYTES);
    Buffer.from(sig.subarray(48, 96)).reverse().copy(out, SNP_SIGNED_BYTES + 72);
    return out;
}

/** A host certificate table holding one VCEK. */
export function certTable(vcekDer: Buffer): Buffer {
    const header = Buffer.alloc(48);
    Buffer.from('8d75da6364e66445adc5f4b93be8accd', 'hex').copy(header, 0);
    header.writeUInt32LE(48, 16);
    header.writeUInt32LE(vcekDer.length, 20);
    return Buffer.concat([header, vcekDer]);
}

export const evidenceOf = (report: Buffer, aux: Buffer = Buffer.alloc(0)) => snpEvidence(report, aux);

/** A collateral source from fixed bytes, counting its calls. */
export function fixedCollateral(o: { vcek?: Buffer | Error; crl?: Buffer | Error }): SnpCollateral & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        async vcek(product, chipId, tcb) {
            calls.push(`vcek ${product} ${chipId.toString('hex').slice(0, 8)} ${tcb.snp}`);
            if (!o.vcek || o.vcek instanceof Error) throw o.vcek ?? new Error('no VCEK');
            return o.vcek;
        },
        async crl(product) {
            calls.push(`crl ${product}`);
            if (!o.crl || o.crl instanceof Error) throw o.crl ?? new Error('no list');
            return o.crl;
        },
    };
}
