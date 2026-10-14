import crypto from 'node:crypto';
import { SLIP39_WORDS } from './slip39-words.js';

/**
 * SLIP-0039, Shamir's secret sharing for mnemonic codes (SatoshiLabs), for the vault's master secret `M` (key vault
 * design §2.1): one group, 2 of 3 members, each share a list of 33 words a custodian can keep in a file and on paper.
 *
 * Written from the specification rather than taken from a package, because this is the one piece of the keyholder a
 * mistake in would lock every copy away for good, and a dependency here would be code nobody reviewed running next to
 * `M`. It is checked against all 45 official test vectors (__tests__/slip39.test.ts), so its shares work with any
 * SLIP-0039 tool (python-shamir-mnemonic, a Trezor) and theirs with it: a custodian can check a share, or rebuild `M`
 * in an emergency, without BeanPool's code.
 *
 * `combineMnemonics` accepts everything the specification allows (several groups, the extendable flag, a passphrase).
 * `splitMasterSecret` makes what the vault uses: one group, `threshold` of `count`, no passphrase (each custodian's
 * file is protected by its own passphrase instead, design §2.1), not extendable (so every SLIP-0039 reader, old ones
 * included, takes them).
 *
 * Buffers holding secrets are zeroed once used. Words are strings, which JavaScript can't wipe: a mnemonic lives in
 * the keyholder only as long as a request, and the keyholder never writes one down.
 */

const RADIX_BITS = 10;
const ID_LENGTH_BITS = 15;
const EXTENDABLE_FLAG_BITS = 1;
const ITERATION_EXP_BITS = 4;
const ID_EXP_WORDS = 2;
const MAX_SHARE_COUNT = 16;
const CHECKSUM_WORDS = 3;
const DIGEST_LENGTH = 4;
const METADATA_WORDS = ID_EXP_WORDS + 2 + CHECKSUM_WORDS;
const MIN_STRENGTH_BITS = 128;
const MIN_MNEMONIC_WORDS = METADATA_WORDS + Math.ceil(MIN_STRENGTH_BITS / RADIX_BITS);
const BASE_ITERATION_COUNT = 10000;
const ROUND_COUNT = 4;
const SECRET_INDEX = 255;
const DIGEST_INDEX = 254;
const CUSTOMIZATION = Buffer.from('shamir');
const CUSTOMIZATION_EXTENDABLE = Buffer.from('shamir_extendable');

export class Slip39Error extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'Slip39Error';
    }
}

const WORD_INDEX = new Map(SLIP39_WORDS.map((w, i) => [w, i]));

// ─── GF(256), the field AES uses (x^8 + x^4 + x^3 + x + 1) ──────────────────────────────────

const EXP = new Uint8Array(255);
const LOG = new Uint8Array(256);
{
    let poly = 1;
    for (let i = 0; i < 255; i++) {
        EXP[i] = poly;
        LOG[poly] = i;
        poly = (poly << 1) ^ poly;
        if (poly & 0x100) poly ^= 0x11b;
    }
}

interface RawShare {
    x: number;
    data: Buffer;
}

function interpolate(shares: RawShare[], x: number): Buffer {
    const xs = new Set(shares.map(s => s.x));
    if (xs.size !== shares.length) throw new Slip39Error('Invalid set of shares. Share indices must be unique.');
    const lengths = new Set(shares.map(s => s.data.length));
    if (lengths.size !== 1) throw new Slip39Error('Invalid set of shares. All share values must have the same length.');
    const same = shares.find(s => s.x === x);
    if (same) return Buffer.from(same.data);
    let logProd = 0;
    for (const s of shares) logProd += LOG[s.x ^ x];
    const result = Buffer.alloc(shares[0].data.length);
    for (const s of shares) {
        let logBasis = logProd - LOG[s.x ^ x];
        for (const o of shares) logBasis -= LOG[s.x ^ o.x];
        logBasis = ((logBasis % 255) + 255) % 255;
        for (let i = 0; i < result.length; i++) {
            const v = s.data[i];
            if (v !== 0) result[i] ^= EXP[(LOG[v] + logBasis) % 255];
        }
    }
    return result;
}

function createDigest(randomPart: Buffer, secret: Buffer): Buffer {
    return crypto.createHmac('sha256', randomPart).update(secret).digest().subarray(0, DIGEST_LENGTH);
}

function splitSecret(threshold: number, count: number, secret: Buffer): RawShare[] {
    if (threshold < 1) throw new Slip39Error('The requested threshold must be a positive integer.');
    if (threshold > count) throw new Slip39Error('The requested threshold must not exceed the number of shares.');
    if (count > MAX_SHARE_COUNT) throw new Slip39Error(`The requested number of shares must not exceed ${MAX_SHARE_COUNT}.`);
    if (threshold === 1) return Array.from({ length: count }, (_, i) => ({ x: i, data: Buffer.from(secret) }));
    const randomCount = threshold - 2;
    const shares: RawShare[] = Array.from({ length: randomCount }, (_, i) => ({ x: i, data: crypto.randomBytes(secret.length) }));
    const randomPart = crypto.randomBytes(secret.length - DIGEST_LENGTH);
    const base: RawShare[] = [
        ...shares,
        { x: DIGEST_INDEX, data: Buffer.concat([createDigest(randomPart, secret), randomPart]) },
        { x: SECRET_INDEX, data: secret },
    ];
    for (let i = randomCount; i < count; i++) shares.push({ x: i, data: interpolate(base, i) });
    base[base.length - 2].data.fill(0);
    randomPart.fill(0);
    return shares;
}

function recoverSecret(threshold: number, shares: RawShare[]): Buffer {
    if (threshold === 1) return Buffer.from(shares[0].data);
    const secret = interpolate(shares, SECRET_INDEX);
    const digestShare = interpolate(shares, DIGEST_INDEX);
    const ok = crypto.timingSafeEqual(digestShare.subarray(0, DIGEST_LENGTH), createDigest(digestShare.subarray(DIGEST_LENGTH), secret));
    digestShare.fill(0);
    if (!ok) {
        secret.fill(0);
        throw new Slip39Error('Invalid digest of the shared secret.');
    }
    return secret;
}

// ─── The Feistel cipher over the master secret ──────────────────────────────────────────────

function salt(identifier: number, extendable: boolean): Buffer {
    if (extendable) return Buffer.alloc(0);
    return Buffer.concat([CUSTOMIZATION, Buffer.from([identifier >> 8, identifier & 0xff])]);
}

function roundFunction(i: number, passphrase: Buffer, e: number, s: Buffer, r: Buffer): Buffer {
    return crypto.pbkdf2Sync(Buffer.concat([Buffer.from([i]), passphrase]), Buffer.concat([s, r]),
        (BASE_ITERATION_COUNT << e) / ROUND_COUNT, r.length, 'sha256');
}

function xor(a: Buffer, b: Buffer): Buffer {
    const out = Buffer.alloc(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
    return out;
}

function feistel(input: Buffer, passphrase: Buffer, e: number, identifier: number, extendable: boolean, decrypt: boolean): Buffer {
    const half = input.length / 2;
    let l: Buffer = Buffer.from(input.subarray(0, half));
    let r: Buffer = Buffer.from(input.subarray(half));
    const s = salt(identifier, extendable);
    for (let k = 0; k < ROUND_COUNT; k++) {
        const i = decrypt ? ROUND_COUNT - 1 - k : k;
        const f = roundFunction(i, passphrase, e, s, r);
        const next = xor(l, f);
        f.fill(0);
        l.fill(0);
        l = r;
        r = next;
    }
    const out = Buffer.concat([r, l]);
    l.fill(0);
    r.fill(0);
    return out;
}

// ─── Words ─────────────────────────────────────────────────────────────────────────────────

function rs1024Polymod(values: number[]): number {
    const GEN = [0xe0e040, 0x1c1c080, 0x3838100, 0x7070200, 0xe0e0009, 0x1c0c2412, 0x38086c24, 0x3090fc48, 0x21b1f890, 0x3f3f120];
    let chk = 1;
    for (const v of values) {
        const b = chk >>> 20;
        chk = (((chk & 0xfffff) << 10) ^ v) >>> 0;
        for (let i = 0; i < 10; i++) if ((b >>> i) & 1) chk = (chk ^ GEN[i]) >>> 0;
    }
    return chk;
}

function customization(extendable: boolean): number[] {
    return [...(extendable ? CUSTOMIZATION_EXTENDABLE : CUSTOMIZATION)];
}

function createChecksum(data: number[], extendable: boolean): number[] {
    const polymod = rs1024Polymod([...customization(extendable), ...data, 0, 0, 0]) ^ 1;
    return [2, 1, 0].map(i => (polymod >>> (10 * i)) & 1023);
}

/** Big-endian bytes as `count` indices of `bits` bits each. */
function bytesToIndices(bytes: Buffer, count: number, bits: number): number[] {
    let n = BigInt(`0x${bytes.toString('hex') || '0'}`);
    const out: number[] = new Array(count);
    const mask = (1n << BigInt(bits)) - 1n;
    for (let i = count - 1; i >= 0; i--) {
        out[i] = Number(n & mask);
        n >>= BigInt(bits);
    }
    return out;
}

function indicesToBigInt(indices: number[], bits: number): bigint {
    let n = 0n;
    for (const i of indices) n = (n << BigInt(bits)) | BigInt(i);
    return n;
}

export interface Slip39Share {
    identifier: number;
    extendable: boolean;
    iterationExponent: number;
    groupIndex: number;
    groupThreshold: number;
    groupCount: number;
    memberIndex: number;
    memberThreshold: number;
    value: Buffer;
}

export function encodeShare(s: Slip39Share): string {
    const idExp = (s.identifier << (EXTENDABLE_FLAG_BITS + ITERATION_EXP_BITS)) | ((s.extendable ? 1 : 0) << ITERATION_EXP_BITS) | s.iterationExponent;
    const params = (s.groupIndex << 16) | ((s.groupThreshold - 1) << 12) | ((s.groupCount - 1) << 8)
        | (s.memberIndex << 4) | (s.memberThreshold - 1);
    const valueWords = Math.ceil((s.value.length * 8) / RADIX_BITS);
    const data = [
        ...bytesToIndices(Buffer.from([idExp >> 16, (idExp >> 8) & 0xff, idExp & 0xff]), ID_EXP_WORDS, RADIX_BITS),
        ...bytesToIndices(Buffer.from([params >> 16, (params >> 8) & 0xff, params & 0xff]), 2, RADIX_BITS),
        ...bytesToIndices(s.value, valueWords, RADIX_BITS),
    ];
    return [...data, ...createChecksum(data, s.extendable)].map(i => SLIP39_WORDS[i]).join(' ');
}

export function decodeShare(mnemonic: string): Slip39Share {
    const words = String(mnemonic).trim().toLowerCase().split(/\s+/).filter(Boolean);
    const data = words.map(w => {
        const i = WORD_INDEX.get(w);
        if (i === undefined) throw new Slip39Error(`Invalid mnemonic word ${JSON.stringify(w)}.`);
        return i;
    });
    if (data.length < MIN_MNEMONIC_WORDS) {
        throw new Slip39Error(`Invalid mnemonic length. The length of each mnemonic must be at least ${MIN_MNEMONIC_WORDS} words.`);
    }
    const paddingLen = (RADIX_BITS * (data.length - METADATA_WORDS)) % 16;
    if (paddingLen > 8) throw new Slip39Error('Invalid mnemonic length.');
    const idExp = Number(indicesToBigInt(data.slice(0, ID_EXP_WORDS), RADIX_BITS));
    const identifier = idExp >> (EXTENDABLE_FLAG_BITS + ITERATION_EXP_BITS);
    const extendable = ((idExp >> ITERATION_EXP_BITS) & 1) === 1;
    const iterationExponent = idExp & ((1 << ITERATION_EXP_BITS) - 1);
    if (rs1024Polymod([...customization(extendable), ...data]) !== 1) throw new Slip39Error('Invalid mnemonic checksum.');
    const params = Number(indicesToBigInt(data.slice(ID_EXP_WORDS, ID_EXP_WORDS + 2), RADIX_BITS));
    const groupIndex = (params >> 16) & 15;
    const groupThreshold = ((params >> 12) & 15) + 1;
    const groupCount = ((params >> 8) & 15) + 1;
    const memberIndex = (params >> 4) & 15;
    const memberThreshold = (params & 15) + 1;
    if (groupCount < groupThreshold) throw new Slip39Error('Invalid mnemonic. Group threshold cannot be greater than group count.');
    const valueData = data.slice(ID_EXP_WORDS + 2, data.length - CHECKSUM_WORDS);
    const valueBytes = (RADIX_BITS * valueData.length - paddingLen) / 8;
    const n = indicesToBigInt(valueData, RADIX_BITS);
    if (n >> BigInt(valueBytes * 8) !== 0n) throw new Slip39Error('Invalid mnemonic padding.');
    const value = Buffer.from(n.toString(16).padStart(valueBytes * 2, '0'), 'hex');
    return { identifier, extendable, iterationExponent, groupIndex, groupThreshold, groupCount, memberIndex, memberThreshold, value };
}

// ─── Split and combine ─────────────────────────────────────────────────────────────────────

export interface SplitOptions {
    threshold: number;
    count: number;
    /** Defaults to 1: 20,000 PBKDF2 rounds, the reference implementation's default. */
    iterationExponent?: number;
    /** Defaults to empty. The vault uses none (design §2.1). */
    passphrase?: string;
}

/** `masterSecret` (16 to 32 bytes, an even number) as `count` mnemonics, any `threshold` of which rebuild it. */
export function splitMasterSecret(masterSecret: Uint8Array, opts: SplitOptions): string[] {
    const ms = Buffer.from(masterSecret);
    try {
        if (ms.length * 8 < MIN_STRENGTH_BITS || ms.length % 2 !== 0 || ms.length > 32) {
            throw new Slip39Error('The master secret must be 16 to 32 bytes, an even number.');
        }
        if (opts.threshold === 1 && opts.count > 1) {
            throw new Slip39Error('Creating multiple member shares with member threshold 1 is not allowed.');
        }
        const e = opts.iterationExponent ?? 1;
        const identifier = crypto.randomInt(0, 1 << ID_LENGTH_BITS);
        const ems = feistel(ms, Buffer.from(opts.passphrase ?? '', 'utf8'), e, identifier, false, false);
        const members = splitSecret(opts.threshold, opts.count, ems);
        ems.fill(0);
        return members.map(m => {
            const words = encodeShare({
                identifier, extendable: false, iterationExponent: e, groupIndex: 0, groupThreshold: 1, groupCount: 1,
                memberIndex: m.x, memberThreshold: opts.threshold, value: m.data,
            });
            m.data.fill(0);
            return words;
        });
    } finally {
        ms.fill(0);
    }
}

/** Rebuild the master secret from exactly the threshold number of shares in each of the threshold number of groups. */
export function combineMnemonics(mnemonics: string[], passphrase = ''): Buffer {
    if (!mnemonics.length) throw new Slip39Error('The list of mnemonics is empty.');
    const shares = mnemonics.map(decodeShare);
    const first = shares[0];
    const common = (s: Slip39Share) => `${s.identifier}/${s.extendable}/${s.iterationExponent}/${s.groupThreshold}/${s.groupCount}`;
    if (shares.some(s => common(s) !== common(first))) {
        throw new Slip39Error('Invalid set of mnemonics. All mnemonics must begin with the same 2 words, '
            + 'must have the same group threshold and the same group count.');
    }
    const groups = new Map<number, Slip39Share[]>();
    for (const s of shares) {
        const group = groups.get(s.groupIndex) ?? [];
        if (group.length && group[0].memberThreshold !== s.memberThreshold) {
            throw new Slip39Error('Invalid set of mnemonics. All mnemonics in a group must have the same member threshold.');
        }
        // The same mnemonic twice is one share.
        if (!group.some(g => g.memberIndex === s.memberIndex && g.value.equals(s.value))) group.push(s);
        groups.set(s.groupIndex, group);
    }
    if (groups.size < first.groupThreshold) {
        throw new Slip39Error(`Insufficient number of mnemonic groups. The required number of groups is ${first.groupThreshold}.`);
    }
    if (groups.size !== first.groupThreshold) {
        throw new Slip39Error(`Wrong number of mnemonic groups. Expected ${first.groupThreshold} groups, but ${groups.size} were provided.`);
    }
    const groupShares: RawShare[] = [];
    try {
        for (const [groupIndex, group] of groups) {
            if (group.length !== group[0].memberThreshold) {
                throw new Slip39Error(`Wrong number of mnemonics. Expected ${group[0].memberThreshold} mnemonics, but ${group.length} were provided.`);
            }
            groupShares.push({ x: groupIndex, data: recoverSecret(group[0].memberThreshold, group.map(s => ({ x: s.memberIndex, data: s.value }))) });
        }
        const ems = recoverSecret(first.groupThreshold, groupShares);
        try {
            return feistel(ems, Buffer.from(passphrase, 'utf8'), first.iterationExponent, first.identifier, first.extendable, true);
        } finally {
            ems.fill(0);
        }
    } finally {
        for (const g of groupShares) g.data.fill(0);
        for (const s of shares) s.value.fill(0);
    }
}
