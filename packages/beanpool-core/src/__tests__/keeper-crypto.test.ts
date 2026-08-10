import { describe, it, expect } from 'vitest';
import { runInNewContext } from 'node:vm';
import { ed25519 } from '@noble/curves/ed25519.js';
import { randomBytes } from '@noble/hashes/utils.js';
import {
    KEEPER_ALG_MEMBER,
    KEEPER_ALG_PLAINTEXT,
    KEEPER_ALG_SSO,
    KeeperCryptoError,
    openRewrappedShare,
    openShareAsMember,
    openShareFromSso,
    readHubShare,
    recordShareForHub,
    rewrapShareToDevice,
    sealShareToMember,
    sealShareToSso,
    type SealedShare,
} from '../keeper-crypto.js';
import { RECOVERY_THRESHOLD, combineRecoveryPhrase, splitRecoveryPhrase } from '../recovery-split.js';

const PHRASE = 'abandon ability able about above absent absorb abstract absurd abuse access accident';

/** An Ed25519 identity, in the hex form the apps hold keys in. */
function identity(): { priv: string; pub: string } {
    const priv = randomBytes(32);
    return {
        priv: Buffer.from(priv).toString('hex'),
        pub: Buffer.from(ed25519.getPublicKey(priv)).toString('hex'),
    };
}

/** Flip one bit of a base64 field, the cheapest possible tamper. */
function corrupt(value: string): string {
    const bytes = Buffer.from(value, 'base64');
    bytes[0] ^= 0x01;
    return bytes.toString('base64');
}

describe('member keeper (K4, K5+)', () => {
    it('round-trips a fragment to the keeper who holds it', () => {
        const keeper = identity();
        const share = randomBytes(64);
        const sealed = sealShareToMember(share, keeper.pub);
        expect(openShareAsMember(sealed, keeper.priv)).toEqual(share);
    });

    it('refuses to open for anyone but that keeper', () => {
        const keeper = identity();
        const stranger = identity();
        const sealed = sealShareToMember(randomBytes(64), keeper.pub);
        expect(() => openShareAsMember(sealed, stranger.priv)).toThrow(KeeperCryptoError);
    });

    it('opens with a PKCS8-wrapped key as well as a raw seed', () => {
        // The two platforms store the same key in different shapes (PWA writes 48-byte PKCS8,
        // native writes the 32-byte seed). A keeper who enrolled on one and approves on the
        // other must still be able to open their own fragment — the failure would otherwise be
        // a tag mismatch with nothing to suggest the key was merely wrapped.
        const keeper = identity();
        const PKCS8_PREFIX = '302e020100300506032b657004220420';
        const wrapped = PKCS8_PREFIX + keeper.priv;
        const sealed = sealShareToMember(randomBytes(64), keeper.pub);
        expect(openShareAsMember(sealed, wrapped)).toEqual(openShareAsMember(sealed, keeper.priv));
    });

    it('detects tampering with the ciphertext, the nonce, or the tag', () => {
        const keeper = identity();
        const sealed = sealShareToMember(randomBytes(64), keeper.pub);
        for (const field of ['encryptedShare', 'shareIv', 'shareTag', 'ephemeralPubkey'] as const) {
            const altered: SealedShare = { ...sealed, [field]: corrupt(sealed[field]!) };
            expect(() => openShareAsMember(altered, keeper.priv),
                `altering ${field} must fail the AEAD, not return wrong bytes`).toThrow(KeeperCryptoError);
        }
    });

    it('draws a fresh ephemeral key every time, so two seals of one fragment do not match', () => {
        // Reusing the ephemeral key across keepers would put every fragment under one shared
        // secret, and reusing the nonce under one key would break XChaCha outright.
        const keeper = identity();
        const share = randomBytes(64);
        const a = sealShareToMember(share, keeper.pub);
        const b = sealShareToMember(share, keeper.pub);
        expect(a.ephemeralPubkey).not.toBe(b.ephemeralPubkey);
        expect(a.shareIv).not.toBe(b.shareIv);
        expect(a.encryptedShare).not.toBe(b.encryptedShare);
    });

    it('rejects a public key that is not a usable Ed25519 point', () => {
        expect(() => sealShareToMember(randomBytes(64), 'ff'.repeat(32))).toThrow(KeeperCryptoError);
        expect(() => sealShareToMember(randomBytes(64), 'ab'.repeat(16))).toThrow(/32 bytes/);
        expect(() => sealShareToMember(randomBytes(64), 'not-hex')).toThrow(/hex or raw bytes/);
    });
});

/**
 * The six small-order Ed25519 points. A hostile key here would make the shared secret
 * predictable, so the fragment sealed under it would be readable by whoever supplied the key.
 */
const SMALL_ORDER_KEYS: [string, string][] = [
    ['identity (order 1)', '0100000000000000000000000000000000000000000000000000000000000000'],
    ['order 2',            'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'],
    ['order 4 (a)',        '0000000000000000000000000000000000000000000000000000000000000000'],
    ['order 4 (b)',        '0000000000000000000000000000000000000000000000000000000000000080'],
    ['order 8 (a)',        'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a'],
    ['order 8 (b)',        '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05'],
];

describe('hostile public keys', () => {
    // The protection is @noble/curves' own RFC 7748 §6.1 all-zero check, not code in this module.
    // That makes it a dependency behaviour holding up a security property, which is precisely the
    // kind of thing that disappears in a version bump without anyone noticing. These tests are the
    // tripwire: if a future noble stops refusing these, this fails rather than the property
    // silently going missing.
    it.each(SMALL_ORDER_KEYS)('refuses to seal a fragment to a %s point', (_label, hex) => {
        expect(() => sealShareToMember(randomBytes(64), hex)).toThrow(KeeperCryptoError);
    });

    it.each(SMALL_ORDER_KEYS)('refuses to re-wrap to a %s device key', (_label, hex) => {
        // The worse of the two: this key arrives from an unauthenticated device mid-recovery,
        // so it is genuinely attacker-chosen rather than merely attacker-influenced.
        expect(() => rewrapShareToDevice(randomBytes(64), hex)).toThrow(KeeperCryptoError);
    });

    it('reports a hostile key as a KeeperCryptoError, not a raw curve error', () => {
        // The actual defect the review found. noble throws a bare Error, so a caller matching on
        // KeeperCryptoError to decide what to tell a frightened member would not catch this at all.
        let caught: unknown;
        try { rewrapShareToDevice(randomBytes(64), SMALL_ORDER_KEYS[3][1]); } catch (e) { caught = e; }
        expect(caught).toBeInstanceOf(KeeperCryptoError);
        expect((caught as Error).name).toBe('KeeperCryptoError');
    });

    it('reports a corrupt ephemeral key on the opening side as a KeeperCryptoError too', () => {
        const device = identity();
        const released = rewrapShareToDevice(randomBytes(64), device.pub);
        const hostile = {
            ...released,
            ephemeralPubkey: Buffer.from(SMALL_ORDER_KEYS[2][1], 'hex').toString('base64'),
        };
        expect(() => openRewrappedShare(hostile, device.priv)).toThrow(KeeperCryptoError);
    });
});

describe('key material as bytes', () => {
    it('accepts a byte array from another realm', () => {
        // A plain `instanceof Uint8Array` fails across a realm boundary — a worker, a vm context,
        // a test harness — and would send a perfectly good key down the hex branch to be refused.
        // A genuine second realm, not a lookalike: `ArrayBuffer.isView` reads an internal slot,
        // so an object shaped like a typed array does not exercise this at all.
        const keeper = identity();
        const foreign = runInNewContext('new Uint8Array(32)') as Uint8Array;
        foreign.set(Buffer.from(keeper.pub, 'hex'));
        expect(foreign instanceof Uint8Array).toBe(false);
        expect(ArrayBuffer.isView(foreign)).toBe(true);

        const sealed = sealShareToMember(randomBytes(64), foreign);
        expect(openShareAsMember(sealed, keeper.priv)).toBeInstanceOf(Uint8Array);
    });

    it('refuses a typed array that is not bytes, rather than reinterpreting it', () => {
        // The wider `ArrayBuffer.isView` check suggested in review would accept this and read
        // eight floats as thirty-two bytes of key material — encrypting happily under nonsense.
        const floats = new Float32Array(8);
        expect(() => sealShareToMember(randomBytes(64), floats as unknown as Uint8Array))
            .toThrow(/hex or raw bytes/);
    });
});

describe('sign-in keeper (K3)', () => {
    it('round-trips against the same provider subject', async () => {
        const share = randomBytes(64);
        const sealed = await sealShareToSso(share, 'apple', '001234.abcdef.5678');
        expect(await openShareFromSso(sealed, 'apple', '001234.abcdef.5678')).toEqual(share);
    });

    it('will not open with a different sub, or the same sub at a different provider', async () => {
        const sealed = await sealShareToSso(randomBytes(64), 'apple', '001234.abcdef.5678');
        await expect(openShareFromSso(sealed, 'apple', '009999.abcdef.5678')).rejects.toThrow(KeeperCryptoError);
        // Provider is mixed into the key material because `sub` is only unique WITHIN a provider —
        // two providers could in principle issue the same string to different people.
        await expect(openShareFromSso(sealed, 'google', '001234.abcdef.5678')).rejects.toThrow(KeeperCryptoError);
    });

    it('carries its own salt, distinct per seal', async () => {
        // The salt cannot be the node's lookup salt: the node generates that after verifying the
        // id_token, by which time the client has already encrypted. If this ever regresses to
        // reusing a fixed salt, two members with the same sub would share a key.
        const a = JSON.parse((await sealShareToSso(randomBytes(32), 'apple', 'sub-1')).kdfParams);
        const b = JSON.parse((await sealShareToSso(randomBytes(32), 'apple', 'sub-1')).kdfParams);
        expect(a.alg).toBe(KEEPER_ALG_SSO);
        expect(typeof a.salt).toBe('string');
        expect(a.salt).not.toBe(b.salt);
    });

    it('records the scrypt cost it used, so raising it later does not strand fragments', async () => {
        const params = JSON.parse((await sealShareToSso(randomBytes(32), 'apple', 'sub-1')).kdfParams);
        expect(params.N).toBe(16384);
        expect(params.r).toBe(8);
        expect(params.p).toBe(1);
    });

    it('refuses a fragment claiming a cheaper cost than anything we ever wrote', async () => {
        // The downgrade this guards is not exotic: N travels in kdfParams so the cost can be
        // raised later, and nothing else in the pipeline inspects it. A fragment rewritten to N:2
        // would fail on the tag anyway — but as "the fragment has been altered", which sends the
        // reader after the ciphertext instead of the number that was actually changed.
        const sealed = await sealShareToSso(randomBytes(32), 'apple', 'sub-1');
        const weakened = {
            ...sealed,
            kdfParams: JSON.stringify({ ...JSON.parse(sealed.kdfParams), N: 2 }),
        };
        await expect(openShareFromSso(weakened, 'apple', 'sub-1'))
            .rejects.toThrow(/below the minimum/);
    });

    it('refuses a fragment with no cost recorded at all', async () => {
        // The pre-2026-08-10 HKDF fragments have no N. None were ever deposited — no client could
        // produce one — but an opener that treated a missing cost as "use the default" is exactly
        // how a weak fragment gets accepted years later by code that has forgotten why.
        const sealed = await sealShareToSso(randomBytes(32), 'apple', 'sub-1');
        const { N, ...withoutN } = JSON.parse(sealed.kdfParams);
        await expect(openShareFromSso({ ...sealed, kdfParams: JSON.stringify(withoutN) }, 'apple', 'sub-1'))
            .rejects.toThrow(/below the minimum/);
    });

    it('refuses to seal without a provider or a sub', async () => {
        await expect(sealShareToSso(randomBytes(32), '', 'sub')).rejects.toThrow(KeeperCryptoError);
        await expect(sealShareToSso(randomBytes(32), 'apple', '')).rejects.toThrow(KeeperCryptoError);
    });

    it('refuses to OPEN without a provider or a sub, rather than blaming the fragment', async () => {
        // Without this the empty case derives a key from ":" and fails on the tag, reporting a
        // corrupt fragment when what actually happened is that the sign-in returned nothing —
        // sending whoever is debugging a failed restore after the wrong thing entirely.
        const sealed = await sealShareToSso(randomBytes(64), 'apple', 'sub-1');
        await expect(openShareFromSso(sealed, '', 'sub-1')).rejects.toThrow(/provider and a subject claim/);
        await expect(openShareFromSso(sealed, 'apple', '')).rejects.toThrow(/provider and a subject claim/);
    });
});

describe('hub keeper (K2)', () => {
    it('is stored in the clear, and the test says so on purpose', () => {
        // Not an oversight to be tidied up later: /api/recovery/collect/hub hands this to a
        // device holding no key of the owner's, so the node has to be able to read it. If this
        // test ever fails because K2 became encrypted, check that the recovering device can
        // still open it — otherwise recovery has silently dropped to needing one more human.
        const share = randomBytes(64);
        const recorded = recordShareForHub(share);
        expect(Buffer.from(recorded.encryptedShare, 'base64')).toEqual(Buffer.from(share));
        expect(JSON.parse(recorded.kdfParams).alg).toBe(KEEPER_ALG_PLAINTEXT);
        expect(readHubShare(recorded)).toEqual(share);
    });

    it('has no ephemeral key, because nothing was agreed with anyone', () => {
        expect(recordShareForHub(randomBytes(32)).ephemeralPubkey).toBeUndefined();
    });
});

describe('scheme markers', () => {
    it('refuses a fragment sealed under a different scheme rather than guessing', () => {
        const keeper = identity();
        const sealed = sealShareToMember(randomBytes(64), keeper.pub);
        const mislabelled = { ...sealed, kdfParams: JSON.stringify({ alg: KEEPER_ALG_SSO }) };
        expect(() => openShareAsMember(mislabelled, keeper.priv)).toThrow(/expected/);
    });

    it('refuses unreadable or absent kdfParams', () => {
        const keeper = identity();
        const sealed = sealShareToMember(randomBytes(64), keeper.pub);
        expect(() => openShareAsMember({ ...sealed, kdfParams: 'not json' }, keeper.priv)).toThrow(/unreadable/);
        // Cast rather than `any`: an older client that predates kdfParams sends no such field,
        // and the type system cannot describe that while the interface requires it.
        const absent = { ...sealed, kdfParams: undefined as unknown as string };
        expect(() => openShareAsMember(absent, keeper.priv)).toThrow(/unreadable/);
    });

    it('names the member scheme in what it writes', () => {
        const sealed = sealShareToMember(randomBytes(64), identity().pub);
        expect(JSON.parse(sealed.kdfParams).alg).toBe(KEEPER_ALG_MEMBER);
    });
});

describe('release to a recovering device', () => {
    it('re-wraps an opened fragment so only that device can read it', () => {
        const keeper = identity();
        const device = identity();
        const eavesdropper = identity();
        const share = randomBytes(64);

        const held = sealShareToMember(share, keeper.pub);
        const opened = openShareAsMember(held, keeper.priv);
        const released = rewrapShareToDevice(opened, device.pub);

        expect(openRewrappedShare(released, device.priv)).toEqual(share);
        expect(() => openRewrappedShare(released, eavesdropper.priv)).toThrow(KeeperCryptoError);
    });

    it('opens without kdfParams, which the collect route does not return', () => {
        // /api/recovery/collect/fragments returns payload/payloadIv/payloadTag/ephemeralPubkey
        // and nothing else, so the scheme has to be fixed by construction rather than read off
        // the wire. This is that contract, asserted in the shape the route actually sends.
        const device = identity();
        const share = randomBytes(64);
        const released = rewrapShareToDevice(share, device.pub);
        const asTheRouteSendsIt = {
            encryptedShare: released.encryptedShare,
            shareIv: released.shareIv,
            shareTag: released.shareTag,
            ephemeralPubkey: released.ephemeralPubkey,
        };
        expect(openRewrappedShare(asTheRouteSendsIt, device.priv)).toEqual(share);
    });
});

describe('the whole path a real recovery takes', () => {
    it('splits, seals to four keepers, opens any three, and rebuilds the phrase', async () => {
        // The point of the model end to end: device + hub + inviter + sign-in, and the member
        // gets their phrase back from whichever three answered. Each fragment goes through the
        // encryption its keeper type actually uses, because that is where a mismatch would hide.
        const inviter = identity();
        const device = identity();
        const sub = '001234.abcdef.5678';

        const fragments = await splitRecoveryPhrase(PHRASE, 4);
        const [k1, k2, k3, k4] = fragments;

        const stored = {
            device: k1,                                          // K1 never leaves the phone
            hub: recordShareForHub(k2),
            member: sealShareToMember(k3, inviter.pub),
            sso: await sealShareToSso(k4, 'apple', sub),
        };

        // The inviter approves: opens their own fragment, re-wraps it to the new device.
        const releasedToDevice = rewrapShareToDevice(
            openShareAsMember(stored.member, inviter.priv), device.pub,
        );

        const recovered = [
            readHubShare(stored.hub),
            openRewrappedShare(releasedToDevice, device.priv),
            await openShareFromSso(stored.sso, 'apple', sub),
        ];
        expect(recovered).toHaveLength(RECOVERY_THRESHOLD);
        expect(await combineRecoveryPhrase(recovered)).toBe(PHRASE);
    });

    it('rebuilds from the phone backup plus any two others', async () => {
        const inviter = identity();
        const fragments = await splitRecoveryPhrase(PHRASE, 4);
        const [k1, k2, k3] = fragments;
        const rebuilt = await combineRecoveryPhrase([
            k1,                                                   // K1, straight from the backup
            readHubShare(recordShareForHub(k2)),
            openShareAsMember(sealShareToMember(k3, inviter.pub), inviter.priv),
        ]);
        expect(rebuilt).toBe(PHRASE);
    });

    it('still refuses two fragments, however correctly each one opened', async () => {
        // Sealing correctly is not the same as being enough. Two opened fragments must fail at
        // the checksum rather than produce a stranger's phrase — the failure this whole model
        // exists to avoid, checked here at the layer a client will actually assemble them in.
        const inviter = identity();
        const fragments = await splitRecoveryPhrase(PHRASE, 4);
        await expect(combineRecoveryPhrase([
            readHubShare(recordShareForHub(fragments[0])),
            openShareAsMember(sealShareToMember(fragments[1], inviter.pub), inviter.priv),
        ])).rejects.toThrow();
    });
});
