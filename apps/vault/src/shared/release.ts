import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { isVaultKeyHex } from '@beanpool/core';
import { signStatement, verifyStatement } from './ceremony.js';

/**
 * A release of the vault (key vault design §3; host design §5.1 item 3): a manifest, and two custodian signatures.
 *
 *   {v: 1, version, previous, imageHash, image, apiBundleHash, custodianKeys, hostPolicy, notes?}
 *
 * - `imageHash` names the boot file: the UKI and the dm-verity root hash of the read-only system partition it names
 *   (`image` holds both, so anyone can recompute it, see {@link imageHashOf}). The keyholder reports the image it booted
 *   as `releaseHash` in every hello, and the custodian's tool checks it against this.
 * - `apiBundleHash` is the SHA-256 of `vault-api.mjs`, the one file a release can change without a reboot.
 * - `custodianKeys` are the three Ed25519 keys that sign the NEXT release. A release after a reshare names the new
 *   custodians here, and is itself signed by the old ones.
 * - `hostPolicy` is what the custodian's tool checks the vault's host against before a share goes (`{platform: none}`
 *   on 1984). The tool takes it only from here, never from the vault.
 * - `previous` is the SHA-256 of the manifest before it (null for the first). Releases form one chain.
 *
 * **Signatures.** Ed25519 (RFC 8032, not ZIP-215), the custodian keys the ceremonies use, each over
 * `"beanpool-vault-release/1\n" ‖ hex(SHA-256(manifest file))`. The signatures file is
 * `{v: 1, manifest: <that hex>, signatures: [{key, sig}]}`; signatures from keys outside the trusted set are ignored.
 *
 * **Trust.** Every build pins the vault's genesis custodian keys (the root). The chain is walked from the root: the
 * first release must carry two signatures from the root keys; each next one names its predecessor and carries two
 * signatures from the keys that predecessor named. So a reshare's new custodians come in through a release the old ones
 * signed, and a build made before the reshare still reaches the newest release. Two different releases signed as the
 * child of one release (a fork, which takes two custodians' keys) stop the walk there: nothing after it is trusted,
 * and the fork is reported. So is a release signed by the right keys whose content is malformed.
 */

export const RELEASE_TAG = 'beanpool-vault-release/1';
export const IMAGE_TAG = 'beanpool-vault-image/1';
/** A manifest or signatures file larger than this is not one. */
export const RELEASE_FILE_MAX_BYTES = 64 * 1024;

const HEX64 = /^[0-9a-f]{64}$/;
const VERSION_RE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

export class ReleaseError extends Error {
    constructor(readonly code: string, message: string) {
        super(message);
        this.name = 'ReleaseError';
    }
}

function fail(code: string, message: string): never {
    throw new ReleaseError(code, message);
}

// ─── Host policies (host design §5.1 item 3) ─────────────────────────────────────────────────

export interface HostPolicyNone {
    platform: 'none';
}

/** Intel TDX on Google Cloud (V8, only if D7 moves there): every measurement hex, lower case. */
export interface HostPolicyTdx {
    platform: 'tdx';
    /** Accepted firmware measurements (48 bytes each), each backed by Google's signed launch endorsement. */
    mrtd: string[];
    /** SHA-256 of Google's launch-endorsement root certificate. */
    googleEndorsementRoot: string;
    /** RTMR1 and RTMR2 as computed from this release's UKI (48 bytes each). */
    rtmr1: string;
    rtmr2: string;
    /** TEE_TCB_SVN at or above this (16 bytes). */
    minTeeTcbSvn: string;
    tcbStatus: string[];
    debug: false;
}

/**
 * AMD SEV-SNP (vault comeback design §2.4): the hosts the vault may run on. A chip's report must satisfy one entry
 * whole (no mixing); the custodian's tool checks it (custodian/snp-checker.ts) before anything is sent.
 */
export interface HostPolicySevSnp {
    platform: 'sev-snp';
    /** The chip's own key signs (VCEK). A cloud's key (VLEK) is not accepted. */
    signer: 'vcek';
    hosts: SnpHost[];
}

export interface SnpHost {
    /** The host profile the image was built for (`apps/vault/image/host-profiles/<profile>.json`), e.g. "servury". */
    profile: string;
    /** AMD's name for the chip family (Milan, Genoa, Turin): picks the AMD root the tool pins. */
    product: string;
    /** Launch measurements: one per UKI and firmware; old and new overlap while a new image waits for its restart. */
    launches: SnpLaunch[];
    /** Guest policies accepted, each the report's own 8 bytes in hex. Never debug (bit 19) or a migration agent (bit 18). */
    policies: string[];
    /** Each firmware level (reported, committed and launch TCB) at or above this, part by part. Raising it is a release. */
    minTcb: SnpTcbFloor;
    /** The firmware's alias check (BadRAM, AMD-SB-3015) must have run: platform info bit 5. */
    requireAliasCheck: boolean;
    /** Chips this vault has run on (64 bytes each). Any other needs the custodian's --accept-new-machine. */
    chipIds: string[];
}

export interface SnpLaunch {
    /** SHA-256 of the UKI this measurement launches: it names the release(s) whose image that is. */
    ukiSha256: string;
    /** SHA-256 of the host's firmware the measurement was computed with (the host profile's pinned file). */
    firmwareSha256: string;
    /** The launch digest (48 bytes). */
    measurement: string;
    /**
     * `computed`: by our build from the pinned firmware, the UKI and the host profile's launch values (design §2.5).
     * `observed`: read off the server's own report, because we could not compute it; the tool says so at every unlock.
     */
    source: 'computed' | 'observed';
}

export interface SnpTcbFloor {
    bootloader: number;
    tee: number;
    snp: number;
    microcode: number;
}

const SNP_MAX_HOSTS = 8;
const SNP_MAX_LAUNCHES = 16;
const SNP_MAX_CHIPS = 64;

function parseSnpHost(raw: unknown, i: number): SnpHost {
    const what = `sev-snp hosts[${i}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('malformed', `${what} is not an object.`);
    const h = raw as Record<string, unknown>;
    const keys = ['profile', 'product', 'launches', 'policies', 'minTcb', 'requireAliasCheck', 'chipIds'];
    exactKeys(h, keys, what);
    const missing = keys.filter(k => !(k in h));
    if (missing.length) fail('malformed', `${what} lacks ${missing.join(', ')}.`);
    if (typeof h.profile !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(h.profile)) fail('malformed', `${what}.profile is a profile name.`);
    // Any AMD family name parses, so a later release naming a family this tool lacks still walks the chain; the
    // custodian's tool refuses to send under it (it has no pinned root for it).
    if (typeof h.product !== 'string' || !/^[A-Z][A-Za-z]{1,15}$/.test(h.product)) fail('malformed', `${what}.product is an AMD chip family name.`);
    const list = (v: unknown, max: number, name: string): unknown[] => {
        if (!Array.isArray(v) || v.length > max) fail('malformed', `${what}.${name} is a list of at most ${max}.`);
        return v;
    };
    const launches = list(h.launches, SNP_MAX_LAUNCHES, 'launches');
    if (!launches.length) fail('malformed', `${what}.launches is empty.`);
    for (const l of launches) {
        if (!l || typeof l !== 'object' || Array.isArray(l)) fail('malformed', `${what}.launches holds a non-object.`);
        const o = l as Record<string, unknown>;
        exactKeys(o, ['ukiSha256', 'firmwareSha256', 'measurement', 'source'], `${what} launch`);
        if (!hexOf(32)(o.ukiSha256) || !hexOf(32)(o.firmwareSha256)) fail('malformed', `${what} launch ukiSha256 and firmwareSha256 are SHA-256s.`);
        if (!hexOf(48)(o.measurement)) fail('malformed', `${what} launch measurement is 48 bytes of hex.`);
        if (o.source !== 'computed' && o.source !== 'observed') fail('malformed', `${what} launch source is computed or observed.`);
    }
    const measurements = launches.map(l => (l as SnpLaunch).measurement);
    if (new Set(measurements).size !== measurements.length) fail('malformed', `${what} lists a measurement twice.`);
    const policies = list(h.policies, 8, 'policies');
    if (!policies.length || !policies.every(hexOf(8))) fail('malformed', `${what}.policies is a list of 8-byte hex values.`);
    for (const p of policies as string[]) {
        const v = Buffer.from(p, 'hex').readBigUInt64LE(0);
        if ((v >> 19n) & 1n) fail('malformed', `${what} allows debug (policy bit 19): never.`);
        if ((v >> 18n) & 1n) fail('malformed', `${what} allows a migration agent (policy bit 18): never.`);
    }
    const t = h.minTcb as Record<string, unknown> | undefined;
    if (!t || typeof t !== 'object' || Array.isArray(t)) fail('malformed', `${what}.minTcb is {bootloader, tee, snp, microcode}.`);
    exactKeys(t, ['bootloader', 'tee', 'snp', 'microcode'], `${what}.minTcb`);
    for (const part of ['bootloader', 'tee', 'snp', 'microcode']) {
        const v = t[part];
        if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 255) fail('malformed', `${what}.minTcb.${part} is 0 to 255.`);
    }
    if (typeof h.requireAliasCheck !== 'boolean') fail('malformed', `${what}.requireAliasCheck is true or false.`);
    const chips = list(h.chipIds, SNP_MAX_CHIPS, 'chipIds');
    if (!chips.every(hexOf(64))) fail('malformed', `${what}.chipIds are 64-byte hex values.`);
    if (new Set(chips).size !== chips.length) fail('malformed', `${what} lists a chip twice.`);
    return {
        profile: h.profile, product: h.product, launches: launches as SnpLaunch[], policies: policies as string[],
        minTcb: { bootloader: t.bootloader as number, tee: t.tee as number, snp: t.snp as number, microcode: t.microcode as number },
        requireAliasCheck: h.requireAliasCheck, chipIds: chips as string[],
    };
}

/**
 * A platform this code doesn't know (a later release's). The manifest still parses, so the chain doesn't skip the
 * release; the custodian's tool refuses to send a share under it.
 */
export interface HostPolicyUnknown {
    platform: string;
    [field: string]: unknown;
}

export type HostPolicy = HostPolicyNone | HostPolicyTdx | HostPolicySevSnp;
export const KNOWN_PLATFORMS = ['none', 'tdx', 'sev-snp'] as const;

function hexOf(bytes: number) {
    return (v: unknown): v is string => typeof v === 'string' && v.length === bytes * 2 && /^[0-9a-f]+$/.test(v);
}

function exactKeys(o: Record<string, unknown>, allowed: string[], what: string): void {
    const extra = Object.keys(o).filter(k => !allowed.includes(k));
    if (extra.length) fail('malformed', `${what} has fields this vault does not know: ${extra.join(', ')}.`);
}

/** A host policy as a manifest carries it: known platforms field by field; an unknown one kept as it is. */
export function parseHostPolicy(raw: unknown): HostPolicy | HostPolicyUnknown {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('malformed', 'hostPolicy is not an object.');
    const o = raw as Record<string, unknown>;
    if (typeof o.platform !== 'string' || !/^[a-z0-9-]{1,32}$/.test(o.platform)) fail('malformed', 'hostPolicy.platform is not a platform name.');
    const h48 = hexOf(48);
    if (o.platform === 'none') {
        exactKeys(o, ['platform'], 'A none host policy');
        return { platform: 'none' };
    }
    if (o.platform === 'tdx') {
        exactKeys(o, ['platform', 'mrtd', 'googleEndorsementRoot', 'rtmr1', 'rtmr2', 'minTeeTcbSvn', 'tcbStatus', 'debug'], 'A tdx host policy');
        if (!Array.isArray(o.mrtd) || !o.mrtd.length || !o.mrtd.every(h48)) fail('malformed', 'tdx mrtd is a list of 48-byte hex values.');
        if (!hexOf(32)(o.googleEndorsementRoot)) fail('malformed', 'tdx googleEndorsementRoot is a SHA-256.');
        if (!h48(o.rtmr1) || !h48(o.rtmr2)) fail('malformed', 'tdx rtmr1 and rtmr2 are 48-byte hex values.');
        if (!hexOf(16)(o.minTeeTcbSvn)) fail('malformed', 'tdx minTeeTcbSvn is 16 bytes of hex.');
        if (!Array.isArray(o.tcbStatus) || !o.tcbStatus.length || !o.tcbStatus.every(s => typeof s === 'string')) fail('malformed', 'tdx tcbStatus is a list.');
        if (o.debug !== false) fail('malformed', 'A tdx host policy never allows debug.');
        return o as unknown as HostPolicyTdx;
    }
    if (o.platform === 'sev-snp') {
        exactKeys(o, ['platform', 'signer', 'hosts'], 'A sev-snp host policy');
        if (o.signer !== 'vcek') fail('malformed', 'sev-snp signer is vcek (the chip\'s own key).');
        if (!Array.isArray(o.hosts) || !o.hosts.length || o.hosts.length > SNP_MAX_HOSTS) fail('malformed', `sev-snp hosts is a list of 1 to ${SNP_MAX_HOSTS}.`);
        const hosts = o.hosts.map(parseSnpHost);
        if (new Set(hosts.map(h => h.profile)).size !== hosts.length) fail('malformed', 'sev-snp hosts name a profile twice.');
        return { platform: 'sev-snp', signer: 'vcek', hosts };
    }
    return { ...o } as HostPolicyUnknown;
}

// ─── The manifest ────────────────────────────────────────────────────────────────────────────

export interface ReleaseImage {
    /** SHA-256 of the UKI (kernel, initrd and the command line naming `roothash`). */
    ukiSha256: string;
    /** The dm-verity root hash of the read-only system partition. */
    roothash: string;
}

export interface ReleaseManifest {
    v: 1;
    version: string;
    previous: string | null;
    imageHash: string;
    image: ReleaseImage;
    apiBundleHash: string;
    custodianKeys: string[];
    hostPolicy: HostPolicy | HostPolicyUnknown;
    notes?: string;
}

/** `imageHash = hex(SHA-256("beanpool-vault-image/1\n" ‖ ukiSha256 ‖ "\n" ‖ roothash ‖ "\n"))`, both lower-case hex. */
export function imageHashOf(image: ReleaseImage): string {
    return sha256Hex(`${IMAGE_TAG}\n${image.ukiSha256}\n${image.roothash}\n`);
}

export function sha256Hex(data: string | Uint8Array): string {
    return bytesToHex(sha256(typeof data === 'string' ? utf8ToBytes(data) : data));
}

/** The name of a manifest: the SHA-256 of its file, exactly as published. */
export function manifestHash(text: string): string {
    return sha256Hex(text);
}

export function compareVersions(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
    return 0;
}

/** The manifest in `text`, checked field by field; anything else is refused. */
export function parseManifest(text: string): ReleaseManifest {
    if (typeof text !== 'string' || utf8ToBytes(text).length > RELEASE_FILE_MAX_BYTES) fail('malformed', 'Not a release manifest.');
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        fail('malformed', 'The manifest is not JSON.');
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('malformed', 'The manifest is not an object.');
    const o = raw as Record<string, unknown>;
    exactKeys(o, ['v', 'version', 'previous', 'imageHash', 'image', 'apiBundleHash', 'custodianKeys', 'hostPolicy', 'notes'], 'The manifest');
    if (o.v !== 1) fail('malformed', 'Not a version 1 manifest.');
    if (typeof o.version !== 'string' || !VERSION_RE.test(o.version)) fail('malformed', 'version is MAJOR.MINOR.PATCH.');
    if (o.previous !== null && !(typeof o.previous === 'string' && HEX64.test(o.previous))) fail('malformed', 'previous is a SHA-256 or null.');
    const image = o.image as Record<string, unknown> | undefined;
    if (!image || typeof image !== 'object' || Array.isArray(image)) fail('malformed', 'image is {ukiSha256, roothash}.');
    exactKeys(image, ['ukiSha256', 'roothash'], 'image');
    if (typeof image.ukiSha256 !== 'string' || !HEX64.test(image.ukiSha256)) fail('malformed', 'image.ukiSha256 is a SHA-256.');
    if (typeof image.roothash !== 'string' || !/^[0-9a-f]{64}([0-9a-f]{64})?$/.test(image.roothash)) fail('malformed', 'image.roothash is a dm-verity root hash.');
    if (typeof o.imageHash !== 'string' || o.imageHash !== imageHashOf(image as unknown as ReleaseImage)) {
        fail('malformed', 'imageHash is not the hash of image.ukiSha256 and image.roothash.');
    }
    if (typeof o.apiBundleHash !== 'string' || !HEX64.test(o.apiBundleHash)) fail('malformed', 'apiBundleHash is a SHA-256.');
    if (!Array.isArray(o.custodianKeys) || o.custodianKeys.length !== 3 || !o.custodianKeys.every(isVaultKeyHex) || new Set(o.custodianKeys).size !== 3) {
        fail('malformed', 'custodianKeys is three different custodian keys.');
    }
    const hostPolicy = parseHostPolicy(o.hostPolicy);
    if (o.notes !== undefined && (typeof o.notes !== 'string' || o.notes.length > 4000)) fail('malformed', 'notes is a short text.');
    return {
        v: 1, version: o.version, previous: o.previous as string | null, imageHash: o.imageHash, image: { ukiSha256: image.ukiSha256, roothash: image.roothash },
        apiBundleHash: o.apiBundleHash, custodianKeys: [...o.custodianKeys] as string[], hostPolicy,
        ...(o.notes !== undefined ? { notes: o.notes as string } : {}),
    };
}

/** A manifest file as it is published: two-space JSON and a final newline, fields in the manifest's order. */
export function formatManifest(m: ReleaseManifest): string {
    const ordered = {
        v: m.v, version: m.version, previous: m.previous, imageHash: m.imageHash, image: { ukiSha256: m.image.ukiSha256, roothash: m.image.roothash },
        apiBundleHash: m.apiBundleHash, custodianKeys: m.custodianKeys, hostPolicy: m.hostPolicy, ...(m.notes !== undefined ? { notes: m.notes } : {}),
    };
    return `${JSON.stringify(ordered, null, 2)}\n`;
}

// ─── Signatures ──────────────────────────────────────────────────────────────────────────────

export interface ReleaseSignature {
    key: string;
    sig: string;
}

export interface ReleaseSignatures {
    v: 1;
    manifest: string;
    signatures: ReleaseSignature[];
}

export function releaseStatement(manifestHashHex: string): Uint8Array {
    return utf8ToBytes(`${RELEASE_TAG}\n${manifestHashHex}`);
}

/** One custodian's signature of a manifest (their 32-byte Ed25519 seed). */
export function signRelease(manifestText: string, seed: Uint8Array, publicKey: string): ReleaseSignature {
    return { key: publicKey, sig: signStatement(seed, releaseStatement(manifestHash(manifestText))) };
}

export function parseSignatures(text: string): ReleaseSignatures {
    if (typeof text !== 'string' || utf8ToBytes(text).length > RELEASE_FILE_MAX_BYTES) fail('malformed', 'Not a signatures file.');
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        fail('malformed', 'The signatures file is not JSON.');
    }
    const o = raw as Record<string, unknown>;
    if (!o || typeof o !== 'object' || o.v !== 1 || typeof o.manifest !== 'string' || !HEX64.test(o.manifest) || !Array.isArray(o.signatures)) {
        fail('malformed', 'The signatures file is not {v: 1, manifest, signatures}.');
    }
    const signatures = (o.signatures as unknown[]).filter((s): s is ReleaseSignature => !!s && typeof s === 'object'
        && typeof (s as ReleaseSignature).key === 'string' && typeof (s as ReleaseSignature).sig === 'string');
    return { v: 1, manifest: o.manifest, signatures: signatures.slice(0, 16) };
}

export function formatSignatures(s: ReleaseSignatures): string {
    return `${JSON.stringify({ v: 1, manifest: s.manifest, signatures: s.signatures.map(x => ({ key: x.key, sig: x.sig })) }, null, 2)}\n`;
}

/** Adds (or replaces) one signature. */
export function addSignature(manifestText: string, existing: ReleaseSignatures | null, sig: ReleaseSignature): ReleaseSignatures {
    const hash = manifestHash(manifestText);
    if (existing && existing.manifest !== hash) fail('wrong_manifest', 'Those signatures are for another manifest.');
    const others = (existing?.signatures ?? []).filter(s => s.key !== sig.key);
    return { v: 1, manifest: hash, signatures: [...others, sig] };
}

/** The distinct keys of `trusted` that validly signed this manifest. Two or more is a release. */
export function validSigners(manifestText: string, sigs: ReleaseSignatures, trusted: readonly string[]): string[] {
    const hash = manifestHash(manifestText);
    if (sigs.manifest !== hash) return [];
    const statement = releaseStatement(hash);
    const out = new Set<string>();
    for (const s of sigs.signatures) {
        if (trusted.includes(s.key) && !out.has(s.key) && verifyStatement(s.key, statement, s.sig)) out.add(s.key);
    }
    return [...out];
}

export const RELEASE_THRESHOLD = 2;

// ─── The chain ───────────────────────────────────────────────────────────────────────────────

/** A release as a feed lists it: its two files' text, exactly as published. */
export interface ReleaseFiles {
    manifestText: string;
    signaturesText: string;
    /** Where it came from (a tag name), for messages only. */
    label?: string;
}

export interface TrustedRelease {
    manifest: ReleaseManifest;
    manifestText: string;
    hash: string;
    signers: string[];
    label?: string;
}

export interface ChainProblem {
    label?: string;
    hash?: string;
    reason: string;
}

export interface ReleaseChain {
    /** Every trusted release, oldest first. */
    releases: TrustedRelease[];
    newest: TrustedRelease | null;
    /**
     * `fork`: two releases signed as the next after one. `malformed`: the next release is signed by the right keys but
     * isn't a valid manifest. Either way nothing after that release is trusted (someone holding two custodians' keys
     * has done something this code won't guess about).
     */
    stopped: null | { reason: 'fork' | 'malformed'; after: string | null; detail: string };
    /** Releases not taken, and why (unsigned, signed by the wrong keys, unreadable). */
    problems: ChainProblem[];
}

/**
 * The chain of releases from `rootKeys`: the first signed by two of them, each next one naming the one before and
 * signed by two of the keys it named. Order in `files` doesn't matter.
 */
export function resolveChain(files: ReleaseFiles[], rootKeys: readonly string[]): ReleaseChain {
    const problems: ChainProblem[] = [];
    const byParent = new Map<string, { files: ReleaseFiles; hash: string; sigs: ReleaseSignatures }[]>();
    const seen = new Set<string>();
    for (const f of files) {
        if (typeof f.manifestText !== 'string' || typeof f.signaturesText !== 'string') continue;
        const hash = manifestHash(f.manifestText);
        if (seen.has(hash)) continue;
        seen.add(hash);
        let previous: unknown;
        let sigs: ReleaseSignatures;
        try {
            previous = (JSON.parse(f.manifestText) as { previous?: unknown }).previous;
            sigs = parseSignatures(f.signaturesText);
        } catch (e) {
            problems.push({ label: f.label, hash, reason: `unreadable: ${(e as Error).message}` });
            continue;
        }
        const parent = typeof previous === 'string' ? previous : previous === null ? '' : undefined;
        if (parent === undefined) {
            problems.push({ label: f.label, hash, reason: 'names no previous release' });
            continue;
        }
        const list = byParent.get(parent) ?? [];
        list.push({ files: f, hash, sigs });
        byParent.set(parent, list);
    }

    const releases: TrustedRelease[] = [];
    let parent = '';
    let trust: readonly string[] = rootKeys;
    let parentVersion: string | null = null;
    let stopped: ReleaseChain['stopped'] = null;
    const taken = new Set<string>();
    for (;;) {
        const candidates = byParent.get(parent) ?? [];
        const signed = candidates.filter(c => {
            const signers = validSigners(c.files.manifestText, c.sigs, trust);
            if (signers.length >= RELEASE_THRESHOLD) return true;
            problems.push({ label: c.files.label, hash: c.hash, reason: signers.length ? 'one custodian signature, two are needed' : 'not signed by the custodians of the release before it' });
            return false;
        });
        if (!signed.length) break;
        if (signed.length > 1) {
            stopped = { reason: 'fork', after: parent || null, detail: `${signed.length} releases are signed as the next one: ${signed.map(s => s.files.label ?? s.hash.slice(0, 12)).join(', ')}` };
            break;
        }
        const next = signed[0];
        let manifest: ReleaseManifest;
        try {
            manifest = parseManifest(next.files.manifestText);
            if (parentVersion !== null && compareVersions(manifest.version, parentVersion) <= 0) fail('malformed', `version ${manifest.version} does not come after ${parentVersion}.`);
        } catch (e) {
            stopped = { reason: 'malformed', after: parent || null, detail: `${next.files.label ?? next.hash.slice(0, 12)}: ${(e as Error).message}` };
            break;
        }
        releases.push({ manifest, manifestText: next.files.manifestText, hash: next.hash, signers: validSigners(next.files.manifestText, next.sigs, trust), label: next.files.label });
        taken.add(next.hash);
        parent = next.hash;
        parentVersion = manifest.version;
        trust = manifest.custodianKeys;
    }
    for (const [p, list] of byParent) {
        for (const c of list) {
            if (taken.has(c.hash) || problems.some(x => x.hash === c.hash)) continue;
            if (stopped && (p === (stopped.after ?? ''))) continue;
            problems.push({ label: c.files.label, hash: c.hash, reason: 'not part of the chain from the pinned keys' });
        }
    }
    return { releases, newest: releases.length ? releases[releases.length - 1] : null, stopped, problems };
}
