/**
 * An AMD SEV-SNP attestation report and BeanPool's evidence around it (vault comeback design §2.2, §2.3): read by the
 * keyholder's helper (belt and braces, keyholder/snp.ts) and by the custodian's tool (the trust check,
 * custodian/snp-checker.ts). Offsets are from the report layout in the SEV-SNP firmware ABI (as google/go-sev-guest
 * `abi/abi.go` writes them down): 1,184 bytes, little-endian, the signature over bytes 0x000 to 0x29F.
 *
 * Evidence bytes: "BVSN", a version byte (1), the 1,184-byte report, then the host's certificate table (may be empty).
 */

export const SNP_REPORT_SIZE = 0x4a0;
export const SNP_SIGNED_BYTES = 0x2a0;
export const SNP_EVIDENCE_MAGIC = 'BVSN';
export const SNP_EVIDENCE_VERSION = 1;

/** Guest policy bits (ABI "GUEST_POLICY"). */
export const SNP_POLICY_MIGRATE_MA_BIT = 18n;
export const SNP_POLICY_DEBUG_BIT = 19n;
/** Platform info bit 5: the firmware checked for aliased memory at boot (the BadRAM fix, AMD-SB-3015). */
export const SNP_PLATFORM_ALIAS_CHECK_BIT = 5n;
/** SIGNATURE_ALGO 1: ECDSA P-384 with SHA-384. */
export const SNP_SIG_ECDSA_P384_SHA384 = 1;
/** SIGNING_KEY in the signer field: the chip's own key (VCEK), a cloud's (VLEK), none. */
export const SNP_SIGNING_KEY_VCEK = 0;

/** One TCB_VERSION as Milan and Genoa lay it out (Turin's differs: design §2.4; its reader comes with a Turin host). */
export interface SnpTcb {
    bootloader: number;
    tee: number;
    snp: number;
    microcode: number;
}

export const TCB_PARTS = ['bootloader', 'tee', 'snp', 'microcode'] as const;

export interface SnpReport {
    version: number;
    policy: bigint;
    vmpl: number;
    signatureAlgo: number;
    currentTcb: SnpTcb;
    platformInfo: bigint;
    /** Bits 2-4 of the signer field: 0 the chip's own key (VCEK), 1 a cloud's (VLEK). */
    signingKey: number;
    maskChipKey: boolean;
    reportData: Buffer;
    measurement: Buffer;
    reportedTcb: SnpTcb;
    /** Report version 3 and later: the CPU's family, model and stepping (0 in version 2). */
    cpuid: { family: number; model: number; stepping: number };
    chipId: Buffer;
    committedTcb: SnpTcb;
    launchTcb: SnpTcb;
    /** The signature's R and S, each a 72-byte little-endian field of which P-384 uses the first 48. */
    sigR: Buffer;
    sigS: Buffer;
}

function tcbAt(r: Buffer, offset: number): SnpTcb {
    return { bootloader: r[offset], tee: r[offset + 1], snp: r[offset + 6], microcode: r[offset + 7] };
}

/** The fields of a report. Throws on anything that is not 1,184 bytes. */
export function readSnpReport(bytes: Uint8Array): SnpReport {
    const r = Buffer.from(bytes);
    if (r.length !== SNP_REPORT_SIZE) throw new Error(`An SEV-SNP report is ${SNP_REPORT_SIZE} bytes, not ${r.length}.`);
    const signer = r.readUInt32LE(0x48);
    return {
        version: r.readUInt32LE(0x00),
        policy: r.readBigUInt64LE(0x08),
        vmpl: r.readUInt32LE(0x30),
        signatureAlgo: r.readUInt32LE(0x34),
        currentTcb: tcbAt(r, 0x38),
        platformInfo: r.readBigUInt64LE(0x40),
        signingKey: (signer >> 2) & 0x7,
        maskChipKey: (signer & 0x2) !== 0,
        reportData: Buffer.from(r.subarray(0x50, 0x90)),
        measurement: Buffer.from(r.subarray(0x90, 0xc0)),
        reportedTcb: tcbAt(r, 0x180),
        cpuid: { family: r[0x188], model: r[0x189], stepping: r[0x18a] },
        chipId: Buffer.from(r.subarray(0x1a0, 0x1e0)),
        committedTcb: tcbAt(r, 0x1e0),
        launchTcb: tcbAt(r, 0x1f0),
        sigR: Buffer.from(r.subarray(0x2a0, 0x2a0 + 72)),
        sigS: Buffer.from(r.subarray(0x2a0 + 72, 0x2a0 + 144)),
    };
}

/** "BVSN" ‖ version ‖ report ‖ certificate table. */
export function snpEvidence(report: Uint8Array, auxblob: Uint8Array): Buffer {
    if (report.length !== SNP_REPORT_SIZE) throw new Error('Not an SEV-SNP report.');
    return Buffer.concat([Buffer.from(SNP_EVIDENCE_MAGIC, 'ascii'), Buffer.from([SNP_EVIDENCE_VERSION]), Buffer.from(report), Buffer.from(auxblob)]);
}

export function splitSnpEvidence(evidence: Uint8Array): { report: Buffer; auxblob: Buffer } {
    const e = Buffer.from(evidence);
    if (e.length < 5 + SNP_REPORT_SIZE || e.subarray(0, 4).toString('ascii') !== SNP_EVIDENCE_MAGIC || e[4] !== SNP_EVIDENCE_VERSION) {
        throw new Error('Not BeanPool SEV-SNP evidence.');
    }
    return { report: Buffer.from(e.subarray(5, 5 + SNP_REPORT_SIZE)), auxblob: Buffer.from(e.subarray(5 + SNP_REPORT_SIZE)) };
}

/** A TCB as the report's 8 bytes (Milan/Genoa layout), for a test or a policy. */
export function tcbBytes(t: SnpTcb): Buffer {
    return Buffer.from([t.bootloader, t.tee, 0, 0, 0, 0, t.snp, t.microcode]);
}

export function describeTcb(t: SnpTcb): string {
    return `bootloader ${t.bootloader}, tee ${t.tee}, snp ${t.snp}, microcode ${t.microcode}`;
}
