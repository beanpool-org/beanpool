import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';

// Counts every scrypt run, so "caught before scrypt" is measured rather than inferred from timing.
vi.mock('@noble/hashes/scrypt.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('@noble/hashes/scrypt.js')>();
    return { ...real, scryptAsync: vi.fn(real.scryptAsync) };
});
import { scryptAsync } from '@noble/hashes/scrypt.js';

import {
    RECOVERY_CODE_SCRYPT_MAX_N,
    RECOVERY_CODE_SCRYPT_MIN_N,
    RecoveryCodeError,
    SealedEnvelopeError,
    canonicalJson,
    checkRecoveryCode,
    createRecoveryCode,
    formatRecoveryCode,
    openEnvelope,
    openEnvelopeStream,
    parseRecoveryCode,
    readSealedHeader,
    sealEnvelope,
    sealEnvelopeStream,
    verifySealedHeader,
    type RecoveryCodeRecord,
    type SealOptions,
    type SealedEnvelopeHeader,
} from '../sealed-envelope.js';
import { SEALED_ENVELOPE_VECTOR_CHECKS, SEALED_ENVELOPE_VECTORS } from '../sealed-envelope-vectors.js';

const scryptCalls = () => vi.mocked(scryptAsync).mock.calls.length;

function identity() {
    const seed = randomBytes(32);
    return { seed, pub: bytesToHex(ed25519.getPublicKey(seed)) };
}

const node = identity();
const alice = identity();
const bob = identity();
const carol = identity();
const mallory = identity();

function opts(overrides: Partial<SealOptions> = {}): SealOptions {
    return {
        kind: 'backup',
        communityId: 'test-community',
        nodePeerId: '12D3KooWTest',
        signingKey: node.seed,
        recipients: { owners: [{ pubkey: alice.pub, callsign: 'alice' }] },
        chunkSize: 1024,
        ...overrides,
    };
}

const asAlice = { type: 'owner' as const, privateKey: alice.seed };

/** Split an envelope into its header JSON and its ciphertext segments. */
function dissect(env: Uint8Array) {
    const len = new DataView(env.buffer, env.byteOffset, 4).getUint32(0, false);
    const headerJson = env.subarray(4, 4 + len);
    const header = JSON.parse(Buffer.from(headerJson).toString('utf8')) as SealedEnvelopeHeader;
    const body = env.subarray(4 + len);
    const seg = header.chunkSize + 16;
    const segments: Uint8Array[] = [];
    for (let i = 0; i < body.length; i += seg) segments.push(body.subarray(i, i + seg));
    return { header, segments };
}

/** Reassemble with a (possibly edited) header, re-serialised canonically so only the edit differs. */
function assemble(header: SealedEnvelopeHeader, segments: Uint8Array[]): Uint8Array {
    const json = utf8ToBytes(canonicalJson(header));
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, json.length, false);
    return concatBytes(len, json, ...segments);
}

const payload3 = new Uint8Array(2500).map((_, i) => (i * 13 + 5) & 0xff); // 3 chunks at 1024

beforeEach(() => {
    vi.mocked(scryptAsync).mockClear();
});

describe('fixed vectors (the same list runs under native and the PWA)', () => {
    it.each(SEALED_ENVELOPE_VECTOR_CHECKS.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
        await c.run();
    });

    it('the vector code record is exactly what createRecoveryCode would store', () => {
        const rec = SEALED_ENVELOPE_VECTORS.recoveryCode.record;
        expect(Object.keys(rec).sort()).toEqual(['N', 'codeId', 'codePub', 'createdAt', 'p', 'r', 'salt']);
    });
});

describe('round trips', () => {
    it('three owners and a recovery code each open the same envelope', async () => {
        const { code, record } = await createRecoveryCode(1);
        const env = await sealEnvelope(payload3, opts({
            recipients: {
                owners: [
                    { pubkey: alice.pub, callsign: 'alice' },
                    { pubkey: bob.pub, callsign: 'bob' },
                    { pubkey: carol.pub, callsign: 'carol' },
                ],
                codes: [record],
            },
        }));
        expect(readSealedHeader(env).recipients).toHaveLength(4);
        for (const who of [alice, bob, carol]) {
            const { payload } = await openEnvelope(env, { type: 'owner', privateKey: who.seed }, { kind: 'backup' });
            expect(payload).toEqual(payload3);
        }
        const viaCode = await openEnvelope(env, { type: 'code', code }, { kind: 'backup' });
        expect(viaCode.payload).toEqual(payload3);
    });

    it('streams in and out in odd-sized pieces', async () => {
        const pieces: Uint8Array[] = [];
        for (let i = 0; i < payload3.length; i += 7) pieces.push(payload3.subarray(i, i + 7));
        const out: Uint8Array[] = [];
        for await (const part of sealEnvelopeStream(pieces, opts())) out.push(part);
        const env = concatBytes(...out);
        const ragged: Uint8Array[] = [];
        for (let i = 0; i < env.length; i += 333) ragged.push(env.subarray(i, i + 333));
        const { chunks } = await openEnvelopeStream(ragged, asAlice, { kind: 'backup' });
        const got: Uint8Array[] = [];
        for await (const c of chunks) got.push(c);
        expect(got.map((c) => c.length)).toEqual([1024, 1024, 452]);
        expect(concatBytes(...got)).toEqual(payload3);
    });

    it.each([0, 1, 1023, 1024, 2048, 2049])('a %i-byte payload round-trips', async (n) => {
        const p = randomBytes(n);
        const env = await sealEnvelope(p, opts());
        expect((await openEnvelope(env, asAlice, { kind: 'backup' })).payload).toEqual(p);
    });

    it('defaults to 1 MiB chunks, and the header is signed by the node key', async () => {
        const env = await sealEnvelope(utf8ToBytes('bundle'), opts({ chunkSize: undefined, kind: 'takeover' }));
        const header = readSealedHeader(env);
        expect(header.chunkSize).toBe(1_048_576);
        expect(verifySealedHeader(header, node.pub)).toBe(true);
        expect(verifySealedHeader(header, alice.pub)).toBe(false);
    });

    it('a node key in PKCS8 form signs the same way', async () => {
        const pkcs8 = SEALED_ENVELOPE_VECTORS.owners[0].pkcs8Hex;
        const env = await sealEnvelope(utf8ToBytes('x'), opts({ signingKey: pkcs8 }));
        expect(verifySealedHeader(readSealedHeader(env), SEALED_ENVELOPE_VECTORS.owners[0].pubkey)).toBe(true);
    });
});

describe('tampering fails', () => {
    it('an edited header field fails every chunk and the signature', async () => {
        const env = await sealEnvelope(payload3, opts());
        const { header, segments } = dissect(env);
        const edited = { ...header, communityId: 'another-community' };
        expect(verifySealedHeader(edited, node.pub)).toBe(false);
        await expect(openEnvelope(assemble(edited, segments), asAlice, { kind: 'backup' }))
            .rejects.toThrow(/did not open at chunk 0/);
    });

    it('a flipped byte in the header JSON is refused', async () => {
        const env = await sealEnvelope(payload3, opts());
        const bad = env.slice();
        bad[30] ^= 0x01;
        await expect(openEnvelope(bad, asAlice, { kind: 'backup' })).rejects.toThrow(SealedEnvelopeError);
    });

    it('a header that is not canonical is refused', async () => {
        const env = await sealEnvelope(payload3, opts());
        const { header, segments } = dissect(env);
        const json = utf8ToBytes(JSON.stringify(header, null, 1));
        const len = new Uint8Array(4);
        new DataView(len.buffer).setUint32(0, json.length, false);
        await expect(openEnvelope(concatBytes(len, json, ...segments), asAlice, { kind: 'backup' }))
            .rejects.toThrow(/canonical/);
    });

    it('swapped chunks fail', async () => {
        const { header, segments } = dissect(await sealEnvelope(payload3, opts()));
        await expect(openEnvelope(assemble(header, [segments[1], segments[0], segments[2]]), asAlice, { kind: 'backup' }))
            .rejects.toThrow(/did not open at chunk 0/);
    });

    it('a dropped middle chunk fails', async () => {
        const { header, segments } = dissect(await sealEnvelope(payload3, opts()));
        await expect(openEnvelope(assemble(header, [segments[0], segments[2]]), asAlice, { kind: 'backup' }))
            .rejects.toThrow(/did not open at chunk 1/);
    });

    it('a dropped final chunk fails — the last one left was not sealed as final', async () => {
        const { header, segments } = dissect(await sealEnvelope(payload3, opts()));
        await expect(openEnvelope(assemble(header, [segments[0], segments[1]]), asAlice, { kind: 'backup' }))
            .rejects.toThrow(/did not open at chunk 1/);
    });

    it('a body cut back to the header alone fails', async () => {
        const { header } = dissect(await sealEnvelope(payload3, opts()));
        await expect(openEnvelope(assemble(header, []), asAlice, { kind: 'backup' }))
            .rejects.toThrow(/cut short/);
    });

    it.each([1, 5, 16, 500])('a body truncated by %i bytes fails', async (n) => {
        const env = await sealEnvelope(payload3, opts());
        await expect(openEnvelope(env.subarray(0, env.length - n), asAlice, { kind: 'backup' }))
            .rejects.toThrow(SealedEnvelopeError);
    });

    it('a truncated stream yields only authenticated chunks, then throws', async () => {
        const env = await sealEnvelope(payload3, opts());
        const { chunks } = await openEnvelopeStream([env.subarray(0, env.length - 3)], asAlice, { kind: 'backup' });
        const got: Uint8Array[] = [];
        await expect((async () => { for await (const c of chunks) got.push(c); })()).rejects.toThrow(SealedEnvelopeError);
        // Chunks 0 and 1 are whole and authentic; the cut final chunk is what throws.
        expect(got).toHaveLength(2);
    });

    it('bytes appended after the final chunk fail', async () => {
        const env = await sealEnvelope(payload3, opts());
        await expect(openEnvelope(concatBytes(env, new Uint8Array(1)), asAlice, { kind: 'backup' }))
            .rejects.toThrow(SealedEnvelopeError);
    });

    it('a chunk from another envelope with the same key holder fails', async () => {
        const a = dissect(await sealEnvelope(payload3, opts()));
        const b = dissect(await sealEnvelope(payload3, opts()));
        await expect(openEnvelope(assemble(a.header, [a.segments[0], b.segments[1], a.segments[2]]), asAlice, { kind: 'backup' }))
            .rejects.toThrow(/did not open at chunk 1/);
    });
});

describe('recipients and kind', () => {
    it('an owner who is not a recipient is refused', async () => {
        const env = await sealEnvelope(payload3, opts());
        await expect(openEnvelope(env, { type: 'owner', privateKey: mallory.seed }, { kind: 'backup' }))
            .rejects.toThrow(/not one of the owners/);
    });

    it('relabelling a stanza with another pubkey does not let that key open it', async () => {
        const { header, segments } = dissect(await sealEnvelope(payload3, opts()));
        const stanza = { ...header.recipients[0], pubkey: mallory.pub } as SealedEnvelopeHeader['recipients'][0];
        const forged = assemble({ ...header, recipients: [stanza] }, segments);
        await expect(openEnvelope(forged, { type: 'owner', privateKey: mallory.seed }, { kind: 'backup' }))
            .rejects.toThrow(/key is wrong, or the envelope has been altered/);
    });

    it("a stanza lifted from another envelope does not open this one's DEK", async () => {
        const a = dissect(await sealEnvelope(payload3, opts()));
        const b = dissect(await sealEnvelope(payload3, opts()));
        const spliced = assemble({ ...a.header, recipients: b.header.recipients }, a.segments);
        await expect(openEnvelope(spliced, asAlice, { kind: 'backup' }))
            .rejects.toThrow(/key is wrong, or the envelope has been altered/);
    });

    it('opening with the wrong expected kind is refused', async () => {
        const env = await sealEnvelope(payload3, opts({ kind: 'takeover' }));
        await expect(openEnvelope(env, asAlice, { kind: 'backup' })).rejects.toThrow(/'takeover' envelope/);
    });

    it('a header relabelled from backup to takeover fails the stanza tag', async () => {
        const { header, segments } = dissect(await sealEnvelope(payload3, opts({ kind: 'backup' })));
        const relabelled = assemble({ ...header, kind: 'takeover' }, segments);
        await expect(openEnvelope(relabelled, asAlice, { kind: 'takeover' }))
            .rejects.toThrow(/key is wrong, or the envelope has been altered/);
    });

    it('an unknown kind is refused at seal and at open', async () => {
        await expect(sealEnvelope(payload3, opts({ kind: 'secrets' as never }))).rejects.toThrow(SealedEnvelopeError);
        const env = await sealEnvelope(payload3, opts());
        await expect(openEnvelope(env, asAlice, { kind: 'secrets' as never })).rejects.toThrow(SealedEnvelopeError);
    });

    it('no recipients, or a recipient listed twice, is refused', async () => {
        await expect(sealEnvelope(payload3, opts({ recipients: { owners: [] } }))).rejects.toThrow(/at least one/);
        await expect(sealEnvelope(payload3, opts({
            recipients: { owners: [{ pubkey: alice.pub, callsign: 'a' }, { pubkey: alice.pub.toUpperCase(), callsign: 'b' }] },
        }))).rejects.toThrow(/twice/);
    });
});

describe('key formats', () => {
    it('one seed opens its stanza as a 32-byte seed and as 48-byte PKCS8, hex and bytes', async () => {
        const v = SEALED_ENVELOPE_VECTORS.owners[1];
        const env = await sealEnvelope(payload3, opts({ recipients: { owners: [{ pubkey: v.pubkey, callsign: 'bob' }] } }));
        for (const privateKey of [v.seedHex, hexToBytes(v.seedHex), v.pkcs8Hex, hexToBytes(v.pkcs8Hex), v.pkcs8Hex.toUpperCase()]) {
            expect((await openEnvelope(env, { type: 'owner', privateKey }, { kind: 'backup' })).payload).toEqual(payload3);
        }
    });

    it('a wrong-header PKCS8 throws SealedEnvelopeError by name, not a bare Error', async () => {
        const env = await sealEnvelope(payload3, opts());
        const bad = new Uint8Array(48);
        bad.set(hexToBytes(SEALED_ENVELOPE_VECTORS.owners[0].pkcs8Hex).subarray(0, 16));
        bad[0] = 0x31;
        bad.set(alice.seed, 16);
        const err = await openEnvelope(env, { type: 'owner', privateKey: bad }, { kind: 'backup' }).catch((e) => e);
        expect(err).toBeInstanceOf(SealedEnvelopeError);
        expect(err.name).toBe('SealedEnvelopeError');
        expect(err.message).toMatch(/Invalid PKCS8 header/);
    });

    it('a key of any other length is refused by name', async () => {
        const env = await sealEnvelope(payload3, opts());
        await expect(openEnvelope(env, { type: 'owner', privateKey: randomBytes(64) }, { kind: 'backup' }))
            .rejects.toThrow(SealedEnvelopeError);
    });
});

/** Same six points as keeper-crypto.test.ts pins. */
const SMALL_ORDER_KEYS: [string, string][] = [
    ['identity (order 1)', '0100000000000000000000000000000000000000000000000000000000000000'],
    ['order 2', 'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'],
    ['order 4 (a)', '0000000000000000000000000000000000000000000000000000000000000000'],
    ['order 4 (b)', '0000000000000000000000000000000000000000000000000000000000000080'],
    ['order 8 (a)', 'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a'],
    ['order 8 (b)', '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05'],
];

describe('hostile public keys', () => {
    it.each(SMALL_ORDER_KEYS)('refuses to seal to an owner at the %s point', async (_label, hex) => {
        await expect(sealEnvelope(payload3, opts({ recipients: { owners: [{ pubkey: hex, callsign: 'x' }] } })))
            .rejects.toThrow(SealedEnvelopeError);
    });

    it.each(SMALL_ORDER_KEYS)('refuses to seal to a recovery code whose codePub is the Montgomery image of %s', async (_label, hex) => {
        let codePub: Uint8Array;
        try {
            codePub = ed25519.utils.toMontgomery(hexToBytes(hex));
        } catch {
            codePub = new Uint8Array(32); // the identity point does not survive toMontgomery
        }
        const record: RecoveryCodeRecord = {
            codeId: 1, codePub: Buffer.from(codePub).toString('base64'), salt: Buffer.from(randomBytes(32)).toString('base64'),
            N: 16384, r: 8, p: 1, createdAt: '2026-09-19T00:00:00.000Z',
        };
        await expect(sealEnvelope(payload3, opts({ recipients: { owners: [], codes: [record] } })))
            .rejects.toThrow(SealedEnvelopeError);
    });

    it('refuses a small-order ephemeral key on the opening side', async () => {
        const { header, segments } = dissect(await sealEnvelope(payload3, opts()));
        const stanza = { ...header.recipients[0], eph: Buffer.from(new Uint8Array(32)).toString('base64') };
        const hostile = assemble({ ...header, recipients: [stanza] as SealedEnvelopeHeader['recipients'] }, segments);
        await expect(openEnvelope(hostile, asAlice, { kind: 'backup' })).rejects.toThrow(/could not be agreed/);
    });
});

describe('the recovery code', () => {
    const entropy = hexToBytes(SEALED_ENVELOPE_VECTORS.recoveryCode.entropyHex);
    const printed = SEALED_ENVELOPE_VECTORS.recoveryCode.printed;
    const record = SEALED_ENVELOPE_VECTORS.recoveryCode.record as unknown as RecoveryCodeRecord;
    const body = printed.split(/\s+/)[1].replace(/-/g, '');

    it('prints as BPRC-n and 7 groups of four, 26 data + 2 check characters', () => {
        expect(printed).toMatch(/^BPRC-3 {2}([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{4}$/);
        expect(body).toHaveLength(28);
    });

    it('accepts lowercase, no separators, no prefix, and I/L/O for 1/1/0', () => {
        const sloppy = body.toLowerCase().replace(/1/g, 'l').replace(/0/g, 'o');
        expect(parseRecoveryCode(sloppy).entropy).toEqual(entropy);
        expect(parseRecoveryCode(sloppy).codeId).toBeUndefined();
        expect(parseRecoveryCode(`bprc 3 ${body}`).codeId).toBe(3);
    });

    it('catches every single-character substitution in the check characters, before scrypt', async () => {
        for (let pos = 26; pos < 28; pos++) {
            for (const ch of '0123456789ABCDEFGHJKMNPQRSTVWXYZ') {
                if (ch === body[pos]) continue;
                const typo = body.slice(0, pos) + ch + body.slice(pos + 1);
                expect(() => parseRecoveryCode(typo)).toThrow(RecoveryCodeError);
            }
        }
        expect(scryptCalls()).toBe(0);
    });

    it('catches single-character substitutions in the data at the check rate (≥ 99%)', () => {
        let caught = 0;
        let total = 0;
        for (let pos = 0; pos < 26; pos++) {
            for (const ch of '0123456789ABCDEFGHJKMNPQRSTVWXYZ') {
                if (ch === body[pos]) continue;
                total++;
                try { parseRecoveryCode(body.slice(0, pos) + ch + body.slice(pos + 1)); } catch (e) {
                    if (e instanceof RecoveryCodeError) caught++;
                }
            }
        }
        expect(caught / total).toBeGreaterThanOrEqual(0.99);
    });

    it('a mistyped code opening an envelope is a RecoveryCodeError, and no scrypt ran', async () => {
        const env = hexToBytes(SEALED_ENVELOPE_VECTORS.takeover.envelopeHex);
        const typo = body.slice(0, 27) + (body[27] === 'A' ? 'B' : 'A');
        const err = await openEnvelope(env, { type: 'code', code: typo }, { kind: 'takeover' }).catch((e) => e);
        expect(err).toBeInstanceOf(RecoveryCodeError);
        expect(err.name).toBe('RecoveryCodeError');
        await expect(checkRecoveryCode(typo, record)).rejects.toThrow(RecoveryCodeError);
        expect(scryptCalls()).toBe(0);
    });

    it('refuses nonzero pad bits in the last data character', () => {
        const last = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.indexOf(body[25]);
        const padded = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[last ^ 0b01];
        expect(() => parseRecoveryCode(body.slice(0, 25) + padded + body.slice(26))).toThrow(RecoveryCodeError);
    });

    it('refuses the wrong length and letters outside the alphabet', () => {
        expect(() => parseRecoveryCode(body.slice(1))).toThrow(/28 characters/);
        expect(() => parseRecoveryCode(`U${body.slice(1)}`)).toThrow(/not a character/);
    });

    it('a well-formed but different code is "not this code", not a typo', async () => {
        const other = formatRecoveryCode(3, randomBytes(16));
        expect(await checkRecoveryCode(other, record)).toBe(false);
        const err = await openEnvelope(hexToBytes(SEALED_ENVELOPE_VECTORS.takeover.envelopeHex), { type: 'code', code: other }, { kind: 'takeover' })
            .catch((e) => e);
        expect(err).toBeInstanceOf(SealedEnvelopeError);
        expect(err).not.toBeInstanceOf(RecoveryCodeError);
        expect(err.message).toMatch(/not recovery code #3/);
    });

    it('a code with the wrong number says which number it needs', async () => {
        const other = formatRecoveryCode(2, entropy);
        await expect(openEnvelope(hexToBytes(SEALED_ENVELOPE_VECTORS.takeover.envelopeHex), { type: 'code', code: other }, { kind: 'takeover' }))
            .rejects.toThrow(/needs recovery code #3/);
        expect(scryptCalls()).toBe(0);
    });

    it('the server-side record holds nothing that opens: no entropy, no secret', async () => {
        const { code, record: rec } = await createRecoveryCode(7);
        const parsed = parseRecoveryCode(code);
        const stored = JSON.stringify(rec);
        expect(stored).not.toContain(bytesToHex(parsed.entropy));
        expect(stored).not.toContain(Buffer.from(parsed.entropy).toString('base64'));
        expect(parsed.codeId).toBe(7);
        expect(await checkRecoveryCode(code, rec)).toBe(true);
        expect(x25519.getPublicKey(await scryptAsync(parsed.entropy, Buffer.from(rec.salt, 'base64'), { N: 16384, r: 8, p: 1, dkLen: 32 })))
            .toEqual(new Uint8Array(Buffer.from(rec.codePub, 'base64')));
    });
});

describe('scrypt floor and ceiling', () => {
    const record = SEALED_ENVELOPE_VECTORS.recoveryCode.record as unknown as RecoveryCodeRecord;
    const printed = SEALED_ENVELOPE_VECTORS.recoveryCode.printed;

    it.each([
        ['below the floor', RECOVERY_CODE_SCRYPT_MIN_N / 2, 8, 1],
        ['above the ceiling', RECOVERY_CODE_SCRYPT_MAX_N * 2, 8, 1],
        ['not a power of two', 20000, 8, 1],
        ['a different r', 16384, 1, 1],
        ['a different p', 16384, 8, 2],
    ])('an envelope whose code stanza claims N/r/p %s is refused before scrypt', async (_label, N, r, p) => {
        const { header, segments } = dissect(hexToBytes(SEALED_ENVELOPE_VECTORS.takeover.envelopeHex));
        const recipients = header.recipients.map((s) => (s.type === 'code' ? { ...s, N, r, p } : s));
        const env = assemble({ ...header, recipients } as SealedEnvelopeHeader, segments);
        await expect(openEnvelope(env, { type: 'code', code: printed }, { kind: 'takeover' }))
            .rejects.toThrow(/scrypt/);
        expect(scryptCalls()).toBe(0);
    });

    it.each([
        ['below the floor', RECOVERY_CODE_SCRYPT_MIN_N / 2],
        ['above the ceiling', RECOVERY_CODE_SCRYPT_MAX_N * 2],
    ])('sealing to a code record with N %s is refused', async (_label, N) => {
        await expect(sealEnvelope(payload3, opts({ recipients: { owners: [], codes: [{ ...record, N }] } })))
            .rejects.toThrow(/permitted range/);
    });

    it('a code made at the ceiling cost still opens (headroom for raising N later)', async () => {
        const entropy = randomBytes(16);
        const salt = randomBytes(32);
        const secret = await scryptAsync(entropy, salt, { N: RECOVERY_CODE_SCRYPT_MAX_N, r: 8, p: 1, dkLen: 32 });
        const atCeiling: RecoveryCodeRecord = {
            codeId: 4, codePub: Buffer.from(x25519.getPublicKey(secret)).toString('base64'),
            salt: Buffer.from(salt).toString('base64'), N: RECOVERY_CODE_SCRYPT_MAX_N, r: 8, p: 1,
            createdAt: '2026-09-19T00:00:00.000Z',
        };
        const env = await sealEnvelope(payload3, opts({ recipients: { owners: [], codes: [atCeiling] } }));
        const { payload } = await openEnvelope(env, { type: 'code', code: formatRecoveryCode(4, entropy) }, { kind: 'backup' });
        expect(payload).toEqual(payload3);
    });
});

describe('canonical JSON', () => {
    it('sorts keys and refuses non-integers', () => {
        expect(canonicalJson({ b: 1, a: [2, { d: 'x', c: null }] })).toBe('{"a":[2,{"c":null,"d":"x"}],"b":1}');
        expect(() => canonicalJson({ a: 1.5 })).toThrow(SealedEnvelopeError);
    });

    it('hashing the frozen header gives a stable body AAD', () => {
        const env = hexToBytes(SEALED_ENVELOPE_VECTORS.takeover.envelopeHex);
        const { header } = dissect(env);
        expect(canonicalJson(header)).toBe(Buffer.from(env.subarray(4, 4 + new DataView(env.buffer, env.byteOffset).getUint32(0))).toString('utf8'));
        expect(bytesToHex(sha256(utf8ToBytes(canonicalJson(header))))).toHaveLength(64);
    });
});
