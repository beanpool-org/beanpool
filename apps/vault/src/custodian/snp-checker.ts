import crypto, { X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { HostPolicySevSnp, SnpHost } from '../shared/release.js';
import {
    describeTcb,
    readSnpReport,
    SNP_PLATFORM_ALIAS_CHECK_BIT,
    SNP_POLICY_DEBUG_BIT,
    SNP_POLICY_MIGRATE_MA_BIT,
    SNP_SIG_ECDSA_P384_SHA384,
    SNP_SIGNED_BYTES,
    SNP_SIGNING_KEY_VCEK,
    splitSnpEvidence,
    TCB_PARTS,
    type SnpReport,
    type SnpTcb,
} from '../shared/snp-report.js';
import { AMD_PRODUCTS, AMD_ROOTS, type AmdRoot } from './amd-roots.js';
import type { CheckContext, EvidenceChecker } from './checker.js';
import { certExtensions, certSubject, certValidity, derSmallUint, DerError, oidBytes, parseCrl, readDerExact, TAG } from './der.js';

/**
 * The chip check (vault comeback design §2.3): whether a vault's hello carries a genuine AMD SEV-SNP report, made for
 * this hello, of exactly the software and firmware the newest two-signed release lists. The custodian's tool runs it
 * before any share, genesis, restore or settings request goes; every failure throws {@link SnpRefused} with the reason,
 * and nothing is sent. There is no "go on anyway". The one acknowledgement the design allows is a chip this vault has
 * not run on before (row 10): the custodian types the chip's first 8 characters, after every other check has passed.
 *
 * In order, cheapest first, so a refusal names the first thing wrong:
 *
 *    1  the evidence: BeanPool's wrapper, a 1,184-byte report, a version this tool reads, signed with ECDSA P-384
 *    2  REPORT_DATA is the bind the tool computed from its own nonce (constant time): fresh and for this session
 *    4  the guest policy never allows debug (bit 19) or a migration agent (bit 18), whatever a release says
 *    5  VMPL 0; signed by the chip's own key (VCEK, not a cloud's VLEK, not masked); chip ID not zeroed
 *    3  the measurement is one the release lists (a host entry's launches); that entry must then pass whole:
 *    4  the guest policy is one that entry lists
 *    6  platform info says the alias check ran, where the entry asks for it
 *    7  reported, committed and launch TCB each at or above the entry's floor, part by part
 *    8  the VCEK chains to AMD's root pinned in this tool (ARK -> ASK -> VCEK), is in date, names this chip and these
 *       firmware levels, and the report's signature verifies under it
 *    9  AMD's revocation list is signed by the pinned root, in date, and does not list the ASK
 *   10  the chip is one the entry lists, or the custodian named it with --accept-new-machine <first 8 characters>
 *   11  the measurement is the launch of the UKI of the release the vault's hello names (the newest, or the one named
 *       with --accept-release)
 *
 * The VCEK comes from the host's certificate table when it has one, or from AMD's key server by chip ID and firmware
 * level ({@link amdKds}, cached); either way only the pinned root is trusted. The revocation list comes from AMD, the
 * cached copy only while it is in date and when AMD can't be reached.
 */

export class SnpRefused extends Error {
    constructor(readonly code: string, message: string) {
        super(message);
        this.name = 'SnpRefused';
    }
}

function refuse(code: string, message: string): never {
    throw new SnpRefused(code, message);
}

export const AMD_KDS = 'https://kdsintf.amd.com';
/** Report versions this tool reads: 2 (the first public format) to 5 (SEV firmware 1.58, the 26 Nov probe's). */
export const SNP_REPORT_VERSIONS = [2, 3, 4, 5] as const;
const VCEK_MAX_BYTES = 16 * 1024;
const CRL_MAX_BYTES = 256 * 1024;
const AUXBLOB_MAX_BYTES = 64 * 1024;

const AMD_OID = '1.3.6.1.4.1.3704.1';
const oidHex = (dotted: string) => oidBytes(dotted).toString('hex');
const EXT = {
    productName: oidHex(`${AMD_OID}.2`),
    bootloader: oidHex(`${AMD_OID}.3.1`),
    tee: oidHex(`${AMD_OID}.3.2`),
    snp: oidHex(`${AMD_OID}.3.3`),
    microcode: oidHex(`${AMD_OID}.3.8`),
    hwid: oidHex(`${AMD_OID}.4`),
} as const;
const RSASSA_PSS = oidBytes('1.2.840.113549.1.1.10');
/** The VCEK's entry in the host's certificate table: GUID 63da758d-e664-4564-adc5-f4b93be8accd as the table writes it. */
const VCEK_GUID = Buffer.from('8d75da6364e66445adc5f4b93be8accd', 'hex');

const hex8 = (b: Buffer) => b.toString('hex').slice(0, 8);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// ─── AMD's pinned keys ───────────────────────────────────────────────────────────────────────

export interface LoadedRoot {
    ark: X509Certificate;
    ask: X509Certificate;
    arkDer: Buffer;
}

/** The pinned pair for `product`, checked: the fingerprints, the ARK self-signed, the ASK signed by the ARK. */
export function loadRoot(product: string, roots: Readonly<Record<string, AmdRoot>> = AMD_ROOTS): LoadedRoot {
    if (!Object.hasOwn(roots, product)) {
        refuse('no_amd_root', `the release names a ${product} chip, and this tool pins AMD's keys for ${roots === AMD_ROOTS ? AMD_PRODUCTS.join(', ') : Object.keys(roots).join(', ')} only: update the tool`);
    }
    const pinned = roots[product];
    const ark = new X509Certificate(pinned.arkPem);
    const ask = new X509Certificate(pinned.askPem);
    if (ark.fingerprint256 !== pinned.arkFingerprint || ask.fingerprint256 !== pinned.askFingerprint
        || !ark.verify(ark.publicKey) || !ask.checkIssued(ark) || !ask.verify(ark.publicKey)) {
        refuse('amd_root_broken', `this tool's pinned AMD keys for ${product} do not check out: the tool itself is damaged; get it again`);
    }
    return { ark, ask, arkDer: Buffer.from(ark.raw) };
}

function inDate(der: Buffer, now: number): boolean {
    const v = certValidity(der);
    return v.notBefore <= now && now <= v.notAfter;
}

// ─── The VCEK and AMD's revocation list ──────────────────────────────────────────────────────

/** The VCEK in the host's certificate table (a list of {GUID, offset, length}, all-zero GUID last), or null. */
export function vcekFromTable(auxblob: Buffer): Buffer | null {
    if (!auxblob.length) return null;
    if (auxblob.length > AUXBLOB_MAX_BYTES) refuse('cert_table', 'the host\'s certificate table is too large to be one');
    for (let at = 0; at + 24 <= auxblob.length; at += 24) {
        const guid = auxblob.subarray(at, at + 16);
        if (guid.every(b => b === 0)) return null;
        if (!guid.equals(VCEK_GUID)) continue;
        const offset = auxblob.readUInt32LE(at + 16);
        const length = auxblob.readUInt32LE(at + 20);
        if (!length || length > VCEK_MAX_BYTES || offset + length > auxblob.length) refuse('cert_table', 'the host\'s certificate table points outside itself');
        return Buffer.from(auxblob.subarray(offset, offset + length));
    }
    refuse('cert_table', 'the host\'s certificate table has no end');
}

/** The VCEK, checked against the pinned ASK and the report: in date, this chip, these firmware levels, P-384. */
function checkVcek(der: Buffer, root: LoadedRoot, r: SnpReport, product: string, now: number): X509Certificate {
    let cert: X509Certificate;
    try {
        cert = new X509Certificate(der);
    } catch {
        refuse('vcek_malformed', 'the chip\'s certificate (VCEK) is not a certificate');
    }
    if (!cert.checkIssued(root.ask) || !cert.verify(root.ask.publicKey)) {
        refuse('vcek_chain', `the chip's certificate (VCEK) is not signed by AMD's ${product} key pinned in this tool: this is not a genuine AMD chip`);
    }
    let dated: boolean;
    try {
        dated = inDate(root.arkDer, now) && inDate(Buffer.from(root.ask.raw), now) && inDate(der, now);
    } catch {
        refuse('vcek_malformed', 'the chip\'s certificate (VCEK) has no dates this tool can read');
    }
    if (!dated) refuse('vcek_expired', 'a certificate in the chain to AMD\'s root is out of date (or this computer\'s clock is wrong)');
    if (!cert.subject.split('\n').includes('CN=SEV-VCEK')) refuse('not_vcek', 'the certificate is not a chip\'s own key (VCEK)');
    const key = cert.publicKey;
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'secp384r1') refuse('vcek_malformed', 'the chip\'s key is not P-384');
    let ext: Map<string, Buffer>;
    let levels: SnpTcb;
    let productName: string;
    try {
        ext = certExtensions(der);
        const int = (oid: string) => {
            const v = ext.get(oid);
            if (!v) throw new DerError('a firmware level is missing');
            return derSmallUint(readDerExact(v));
        };
        levels = { bootloader: int(EXT.bootloader), tee: int(EXT.tee), snp: int(EXT.snp), microcode: int(EXT.microcode) };
        const name = ext.get(EXT.productName);
        const node = name ? readDerExact(name) : null;
        if (!node || node.tag !== TAG.IA5_STRING) throw new DerError('no product name');
        productName = node.content.toString('latin1');
    } catch (e) {
        refuse('vcek_malformed', `the chip's certificate lacks what AMD puts in it (${(e as Error).message})`);
    }
    if (productName !== product && !productName.startsWith(`${product}-`)) refuse('vcek_product', `the chip's certificate is for ${productName}, not ${product}`);
    const hwid = ext.get(EXT.hwid);
    if (!hwid || !hwid.equals(r.chipId)) refuse('vcek_chip', 'the chip\'s certificate is for another chip than the report names');
    for (const part of TCB_PARTS) {
        if (levels[part] !== r.reportedTcb[part]) refuse('vcek_tcb', `the chip's certificate is for other firmware levels (${describeTcb(levels)}) than the report's (${describeTcb(r.reportedTcb)})`);
    }
    return cert;
}

/** AMD's revocation list: signed by the pinned ARK, about it, RSA-PSS with SHA-384. Returns its dates and entries. */
export function checkCrlSignature(der: Buffer, root: LoadedRoot) {
    let crl;
    try {
        crl = parseCrl(der);
    } catch (e) {
        refuse('crl_malformed', `AMD's revocation list is not one (${(e as Error).message})`);
    }
    const pss = (alg: Buffer) => alg.includes(Buffer.concat([Buffer.from([TAG.OID, RSASSA_PSS.length]), RSASSA_PSS]));
    if (!crl.signatureAlgorithm.equals(crl.innerAlgorithm) || !pss(crl.signatureAlgorithm)) refuse('crl_signature', 'AMD\'s revocation list is not signed the way AMD signs it');
    if (!crl.issuer.equals(certSubject(root.arkDer))) refuse('crl_signature', 'the revocation list is not AMD\'s root\'s');
    const ok = crypto.verify('sha384', crl.tbs, { key: root.ark.publicKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 48 }, crl.signature);
    if (!ok) refuse('crl_signature', 'the revocation list is not signed by AMD\'s root pinned in this tool');
    return crl;
}

function checkCrl(der: Buffer, root: LoadedRoot, now: number): { thisUpdate: number; nextUpdate: number } {
    const crl = checkCrlSignature(der, root);
    if (crl.nextUpdate === null || now < crl.thisUpdate || now >= crl.nextUpdate) {
        refuse('crl_stale', `AMD's revocation list is not in date (${day(crl.thisUpdate)} to ${crl.nextUpdate === null ? '?' : day(crl.nextUpdate)}): connect to the internet so the tool can fetch a fresh one`);
    }
    const ask = BigInt(`0x${root.ask.serialNumber}`);
    if (crl.revoked.some(s => BigInt(`0x${s}`) === ask)) refuse('ask_revoked', 'AMD has revoked the signing key (ASK) behind this chip');
    return { thisUpdate: crl.thisUpdate, nextUpdate: crl.nextUpdate };
}

// ─── Where the VCEK and the revocation list come from ───────────────────────────────────────

export interface SnpCollateral {
    /** The VCEK for this chip at these firmware levels (DER). */
    vcek(product: string, chipId: Buffer, tcb: SnpTcb): Promise<Buffer>;
    /** AMD's revocation list for this product (DER). The checker checks its signature and its dates. */
    crl(product: string): Promise<Buffer>;
}

type FetchFn = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

/**
 * AMD's key server, with a cache (design §2.3: "needs the internet once per firmware level"). A VCEK is cached by chip
 * and firmware level once it checks out against the pinned ASK; the revocation list is fetched every time, and the
 * cached copy (kept only when signed by the pinned ARK) is used when AMD can't be reached. The checker checks both
 * again, whatever their source, so a tampered cache can only make the tool refuse.
 */
export function amdKds(opts: {
    cacheDir: string; fetch?: FetchFn; base?: string; timeoutMs?: number; now?: () => number; roots?: Readonly<Record<string, AmdRoot>>;
}): SnpCollateral {
    const base = (opts.base ?? AMD_KDS).replace(/\/$/, '');
    const fetchFn: FetchFn = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
    const get = async (url: string, max: number): Promise<Buffer> => {
        const res = await fetchFn(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000) });
        if (!res.ok) throw new Error(`AMD's key server answered ${res.status}`);
        const body = Buffer.from(await res.arrayBuffer());
        if (!body.length || body.length > max) throw new Error('AMD\'s key server answered something that is not a certificate');
        return body;
    };
    const keep = (file: string, data: Buffer) => {
        mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        writeFileSync(`${file}.tmp`, data);
        renameSync(`${file}.tmp`, file);
    };
    const productDir = (product: string) => {
        if (!/^[A-Z][A-Za-z]{1,15}$/.test(product)) throw new Error('not a product name');
        return path.join(opts.cacheDir, product);
    };
    return {
        async vcek(product, chipId, tcb) {
            const id = chipId.toString('hex');
            const file = path.join(productDir(product), `vcek-${id}-${TCB_PARTS.map(p => tcb[p]).join('-')}.der`);
            if (existsSync(file)) {
                // A cached certificate past its dates is asked for again (AMD reissues them), never served for ever.
                const cached = readFileSync(file);
                try {
                    if (inDate(cached, opts.now?.() ?? Date.now())) return cached;
                } catch {
                    // Unreadable: fetch a fresh one.
                }
            }
            const two = (n: number) => String(n).padStart(2, '0');
            const der = await get(`${base}/vcek/v1/${product}/${id}?blSPL=${two(tcb.bootloader)}&teeSPL=${two(tcb.tee)}&snpSPL=${two(tcb.snp)}&ucodeSPL=${two(tcb.microcode)}`, VCEK_MAX_BYTES);
            const root = loadRoot(product, opts.roots);
            let cert: X509Certificate | null = null;
            try {
                cert = new X509Certificate(der);
            } catch {
                // Not cached: the checker says what is wrong with it.
            }
            if (cert && cert.checkIssued(root.ask) && cert.verify(root.ask.publicKey)) keep(file, der);
            return der;
        },
        async crl(product) {
            const file = path.join(productDir(product), 'crl.der');
            let fetchError: Error;
            try {
                const der = await get(`${base}/vcek/v1/${product}/crl`, CRL_MAX_BYTES);
                checkCrlSignature(der, loadRoot(product, opts.roots));
                keep(file, der);
                return der;
            } catch (e) {
                fetchError = e as Error;
            }
            if (existsSync(file)) return readFileSync(file);
            throw new Error(`AMD's revocation list could not be fetched (${fetchError.message}) and none is cached`);
        },
    };
}

// ─── The check ───────────────────────────────────────────────────────────────────────────────

export interface SnpCheckOptions {
    collateral: SnpCollateral;
    /** ms since the epoch (certificate and revocation-list dates). */
    now?: () => number;
    /** Tests only: a root other than AMD's (design §6 T7: "rows a real chip would never sign use a test-only root"). */
    roots?: Readonly<Record<string, AmdRoot>>;
}

export interface SnpPass {
    profile: string;
    chipId: string;
    newMachine: boolean;
    measurement: string;
    observed: boolean;
    /** What was checked, in plain words, for the custodian to read. */
    lines: string[];
}

/** Rows 1 to 11. Throws {@link SnpRefused}. */
export async function verifySnpEvidence(policy: HostPolicySevSnp, evidence: Uint8Array, bind: Uint8Array, ctx: CheckContext, opts: SnpCheckOptions): Promise<SnpPass> {
    // 1
    let split: { report: Buffer; auxblob: Buffer };
    try {
        split = splitSnpEvidence(evidence);
    } catch {
        refuse('not_snp_evidence', 'the evidence is not an SEV-SNP report in BeanPool\'s wrapper');
    }
    const report = split.report;
    const r = readSnpReport(report);
    if (!(SNP_REPORT_VERSIONS as readonly number[]).includes(r.version)) refuse('report_version', `report version ${r.version} is not one this tool reads (${SNP_REPORT_VERSIONS.join(', ')})`);
    if (r.signatureAlgo !== SNP_SIG_ECDSA_P384_SHA384) refuse('report_signature', `the report is not signed with ECDSA P-384 (algorithm ${r.signatureAlgo})`);
    if (!r.sigR.subarray(48).every(b => b === 0) || !r.sigS.subarray(48).every(b => b === 0)) refuse('report_signature', 'the report\'s signature is not a P-384 signature');
    // 2
    if (bind.length !== 64 || !crypto.timingSafeEqual(r.reportData, Buffer.from(bind))) {
        refuse('report_data', 'the report was not made for this hello (its report data is not this session\'s binding): an old or borrowed report');
    }
    // 4, whatever a release says
    if ((r.policy >> SNP_POLICY_DEBUG_BIT) & 1n) refuse('debug_on', 'the guest policy allows debugging: the host could read the vault\'s memory');
    if ((r.policy >> SNP_POLICY_MIGRATE_MA_BIT) & 1n) refuse('migration_agent', 'the guest policy allows a migration agent: the running vault could be moved');
    // 5
    if (r.vmpl !== 0) refuse('vmpl', `the report was asked for at VMPL ${r.vmpl}, not 0 (not by the vault's own kernel)`);
    if (r.signingKey !== SNP_SIGNING_KEY_VCEK) refuse('not_vcek', `the report is not signed by the chip's own key (VCEK) but by key type ${r.signingKey} (1 is a cloud's VLEK)`);
    if (r.maskChipKey) refuse('chip_key_masked', 'the chip did not sign the report with its own key (MASK_CHIP_KEY)');
    if (r.chipId.every(b => b === 0)) refuse('chip_id_masked', 'the report hides which chip made it (its chip ID is zeroed: MASK_CHIP_ID)');
    // 3
    const measurement = r.measurement.toString('hex');
    const candidates = policy.hosts.filter(h => h.launches.some(l => l.measurement === measurement));
    if (!candidates.length) {
        refuse('measurement', `the measurement ${measurement.slice(0, 16)}… is not one the release lists (${policy.hosts.map(h => h.profile).join(', ')}): this is not our signed software as the release launches it`);
    }
    let first: SnpRefused | null = null;
    for (const host of candidates) {
        try {
            return await checkHostEntry(host, r, report, split.auxblob, measurement, ctx, opts);
        } catch (e) {
            if (!(e instanceof SnpRefused)) throw e;
            first ??= e;
        }
    }
    throw first as SnpRefused;
}

async function checkHostEntry(host: SnpHost, r: SnpReport, report: Buffer, auxblob: Buffer, measurement: string, ctx: CheckContext, opts: SnpCheckOptions): Promise<SnpPass> {
    const now = opts.now?.() ?? Date.now();
    const launch = host.launches.find(l => l.measurement === measurement);
    if (!launch) refuse('measurement', 'the measurement is not one this host lists');
    // 4
    const policyHex = report.subarray(0x08, 0x10).toString('hex');
    if (!host.policies.includes(policyHex)) refuse('guest_policy', `the guest policy 0x${r.policy.toString(16)} is not one the release lists for ${host.profile}`);
    // 6
    if (host.requireAliasCheck && !((r.platformInfo >> SNP_PLATFORM_ALIAS_CHECK_BIT) & 1n)) {
        refuse('alias_check', 'the firmware did not run its check for aliased memory (BadRAM, AMD-SB-3015), which the release requires');
    }
    // 7
    for (const [name, tcb] of [['reported', r.reportedTcb], ['committed', r.committedTcb], ['launch', r.launchTcb]] as const) {
        for (const part of TCB_PARTS) {
            if (tcb[part] < host.minTcb[part]) {
                refuse('tcb_below_floor', `the ${name} firmware level is below the release's floor: ${part} ${tcb[part]}, the floor is ${host.minTcb[part]} (${describeTcb(tcb)})`);
            }
        }
    }
    // 8
    const root = loadRoot(host.product, opts.roots);
    let vcekDer = vcekFromTable(auxblob);
    const vcekFrom = vcekDer ? 'the host\'s certificate table' : 'AMD\'s key server';
    if (!vcekDer) {
        try {
            vcekDer = await opts.collateral.vcek(host.product, r.chipId, r.reportedTcb);
        } catch (e) {
            refuse('vcek_unavailable', `the chip's certificate (VCEK) could not be had from AMD's key server (${(e as Error).message}): connect to the internet and try again`);
        }
    }
    const vcek = checkVcek(vcekDer, root, r, host.product, now);
    const sig = Buffer.concat([Buffer.from(r.sigR.subarray(0, 48)).reverse(), Buffer.from(r.sigS.subarray(0, 48)).reverse()]);
    if (!crypto.verify('sha384', report.subarray(0, SNP_SIGNED_BYTES), { key: vcek.publicKey, dsaEncoding: 'ieee-p1363' }, sig)) {
        refuse('report_signature', 'the report\'s signature does not verify under the chip\'s certificate: it was changed, or not made by this chip');
    }
    // 9
    let crlDer: Buffer;
    try {
        crlDer = await opts.collateral.crl(host.product);
    } catch (e) {
        refuse('crl_unavailable', `${(e as Error).message}: connect to the internet so the tool can fetch it`);
    }
    const crl = checkCrl(crlDer, root, now);
    // 10
    const chipId = r.chipId.toString('hex');
    const known = host.chipIds.includes(chipId);
    if (!known && ctx.acceptNewMachine !== chipId.slice(0, 8)) {
        refuse('new_machine', `this vault has not run on chip ${hex8(r.chipId)}… before (the release lists ${host.chipIds.length ? host.chipIds.map(c => `${c.slice(0, 8)}…`).join(', ') : 'no chip yet'}). `
            + `A new chip is the one sign the vault was moved. If you know why (a first start on this host, or the host told you it moved the server), run again with --accept-new-machine ${hex8(r.chipId)}`);
    }
    // 11
    if (launch.ukiSha256 !== ctx.ukiSha256) {
        refuse('release_measurement', `the chip says the vault launched UKI ${launch.ukiSha256.slice(0, 16)}…, but the release its hello names (${ctx.release}) has UKI ${ctx.ukiSha256.slice(0, 16)}…: it runs another release than it says`);
    }
    const observed = launch.source === 'observed';
    return {
        profile: host.profile, chipId, newMachine: !known, measurement, observed,
        lines: [
            `chip check passed: AMD SEV-SNP, host ${host.profile}`,
            `  chip          ${host.product}, chip ${hex8(r.chipId)}…${known ? ' (one this vault has run on)' : ' (NEW: accepted by you with --accept-new-machine)'}; CPUID family 0x${r.cpuid.family.toString(16)} model 0x${r.cpuid.model.toString(16)}`,
            `  certificates  VCEK from ${vcekFrom}, chained to AMD's ${host.product} root pinned in this tool`,
            `  revocation    AMD's list of ${day(crl.thisUpdate)}, in date to ${day(crl.nextUpdate)}: the signing key is not on it`,
            `  firmware      reported ${describeTcb(r.reportedTcb)} (the release's floor: ${describeTcb(host.minTcb)})`,
            `  guest policy  0x${r.policy.toString(16)}: debug off, no migration agent; VMPL 0`,
            `  measurement   ${measurement}`,
            `                = release ${ctx.release}'s UKI on ${host.profile}'s firmware ${launch.firmwareSha256.slice(0, 16)}…, ${observed
                ? 'OBSERVED on the server and signed into the release as such: NOT computed from our own build'
                : 'computed from our own build'}`,
        ],
    };
}

/** The checker the custodian's tool registers for `sev-snp`. */
export function snpChecker(opts: SnpCheckOptions): EvidenceChecker {
    return {
        platform: 'sev-snp',
        async check(policy, evidence, bind, ctx) {
            if (policy.platform !== 'sev-snp') return { ok: false, reason: 'not an sev-snp policy' };
            try {
                const pass = await verifySnpEvidence(policy, evidence, bind, ctx, opts);
                return { ok: true, lines: pass.lines };
            } catch (e) {
                if (e instanceof SnpRefused) return { ok: false, reason: e.message, code: e.code };
                // Anything unexpected is a refusal too, never a pass.
                return { ok: false, reason: `the check could not finish (${(e as Error).message})`, code: 'check_failed' };
            }
        },
    };
}
