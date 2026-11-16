/**
 * X8 part 1, checks (1) and (4).
 *
 * (1) Published vectors. Neither specification publishes test vectors for the ratchet itself (Signal's Double Ratchet document
 * has none; Olm's has none), so the cross-implementation check is vodozemac (ratchet-vodozemac.test.ts). What does have
 * published vectors is checked here as this file uses it: the X25519 key pair and agreement of RFC 7748 §6.1.
 *
 * (4) Key erasure (checkKeyErasure in ratchet-harness.ts): a state taken now opens no message already read, by decrypt or by
 * any key it holds run forward; an old chain key, or a whole state taken before the next changes of direction, opens nothing
 * sent after them. Also: what a stored state holds and refuses to load.
 */
import { describe, expect, it } from 'vitest';
import { x25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import * as ratchet from '../ratchet.js';
import { checkKeyErasure, Pair } from './ratchet-harness.js';

describe('src/ratchet.ts: published vectors (RFC 7748 §6.1)', () => {
    const ALICE_SECRET = '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a';
    const ALICE_PUBLIC = '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a';
    const BOB_SECRET = '5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb';
    const BOB_PUBLIC = 'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f';
    const SHARED = '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742';

    it('ratchetKeyPair makes the RFC public keys from the RFC secrets, and they agree on the RFC secret', () => {
        const alice = ratchet.ratchetKeyPair(() => hexToBytes(ALICE_SECRET));
        const bob = ratchet.ratchetKeyPair(() => hexToBytes(BOB_SECRET));
        expect(bytesToHex(alice.public)).toBe(ALICE_PUBLIC);
        expect(bytesToHex(bob.public)).toBe(BOB_PUBLIC);
        expect(bytesToHex(x25519.getSharedSecret(alice.secret, bob.public))).toBe(SHARED);
    });

    it('a low-order key gives no secret, and is refused rather than used', () => {
        const pair = new Pair(ratchet, 'low-order');
        const zero = new Uint8Array(32);
        expect(() =>
            ratchet.startOutboundRatchet({ myIdentitySecret: hexToBytes(ALICE_SECRET), theirIdentityKey: zero, theirOneTimeKey: hexToBytes(BOB_PUBLIC) }),
        ).toThrow(ratchet.RatchetRefusedError);
        expect(pair.state.A).not.toBeNull();
    });
});

describe('src/ratchet.ts: key erasure', () => {
    for (const macBytes of [8, 32] as const) {
        it(`MAC ${macBytes}: a state opens nothing already read, and an old key nothing sent after the next steps`, () => {
            checkKeyErasure(ratchet, macBytes);
        });
    }

    it('one-time key: Bob refuses a pre-key message made for another of his one-time keys', () => {
        const p = new Pair(ratchet, 'otk');
        p.send('A', 'a0', 'hello');
        const other = ratchet.ratchetKeyPair(p.rng);
        expect(() =>
            ratchet.startInboundRatchet({ myIdentitySecret: other.secret, myOneTimeSecret: other.secret, message: p.sent.get('a0')!.message.body }),
        ).toThrow(expect.objectContaining({ reason: 'session-mismatch' }));
    });

    it('Bob refuses a start from an identity key other than the one he expects, and takes the one he does', () => {
        const p = new Pair(ratchet, 'expected-identity');
        p.send('A', 'a0', 'hello');
        const bob = p as unknown as { bobIdentity: { secret: Uint8Array }; bobOneTime: { secret: Uint8Array } };
        const args = { myIdentitySecret: bob.bobIdentity.secret, myOneTimeSecret: bob.bobOneTime.secret, message: p.sent.get('a0')!.message.body };
        const someoneElse = ratchet.ratchetKeyPair(p.rng).public;
        expect(() => ratchet.startInboundRatchet({ ...args, theirIdentityKey: someoneElse })).toThrow(expect.objectContaining({ reason: 'session-mismatch' }));
        const aliceKey = p.state.A!.sessionKeys.identityKey;
        expect(new TextDecoder().decode(ratchet.startInboundRatchet({ ...args, theirIdentityKey: aliceKey }).plaintext)).toBe('hello');
    });

    it('a stored state goes out and back unchanged, and works after', () => {
        const p = new Pair(ratchet, 'store');
        p.send('A', 'a0', 'one');
        p.send('A', 'a1', 'two');
        expect(p.recv('B', p.sent.get('a1')!.message)).toEqual({ plaintext: 'two' });
        const json = JSON.parse(JSON.stringify(ratchet.exportRatchetState(p.state.B!)));
        const back = ratchet.importRatchetState(json);
        expect(ratchet.exportRatchetState(back)).toEqual(json);
        expect(new TextDecoder().decode(ratchet.ratchetDecrypt(back, p.sent.get('a0')!.message).plaintext)).toBe('one');
    });

    it('a stored state that is not one this module wrote is refused whole', () => {
        const p = new Pair(ratchet, 'store-bad');
        const good = ratchet.exportRatchetState(p.state.A!);
        const bad: Array<[string, unknown]> = [
            ['version', { ...good, v: 2 }],
            ['mac length', { ...good, macBytes: 16 }],
            ['short key', { ...good, rootKey: 'AAAA' }],
            ['loose base64', { ...good, rootKey: good.rootKey.replace(/=$/, '') }],
            ['negative index', { ...good, sending: { ...good.sending!, index: -1 } }],
            ['key pair that does not match', { ...good, sending: { ...good.sending!, ratchetKey: good.sessionKeys.baseKey } }],
            ['nothing to send or receive with', { ...good, sending: null, receiving: [] }],
            ['too many chains', { ...good, receiving: Array(ratchet.RATCHET_MAX_RECEIVING_CHAINS + 1).fill({ ratchetKey: good.rootKey, chainKey: good.rootKey, index: 0 }) }],
        ];
        for (const [why, j] of bad) expect(() => ratchet.importRatchetState(j as ratchet.RatchetStateJson), why).toThrow(/stored state refused/);
    });

    it('the state passed in is never changed, by a send or by a receive', () => {
        const p = new Pair(ratchet, 'immutable');
        const a = p.state.A!;
        const before = JSON.stringify(ratchet.exportRatchetState(a));
        const sent = ratchet.ratchetEncrypt(a, utf8ToBytes('x'), p.rng);
        expect(JSON.stringify(ratchet.exportRatchetState(a))).toBe(before);
        expect(p.recv('B', sent.message)).toEqual({ plaintext: 'x' });
        const b = p.state.B!;
        const bBefore = JSON.stringify(ratchet.exportRatchetState(b));
        const reply = ratchet.ratchetEncrypt(b, utf8ToBytes('y'), p.rng);
        ratchet.ratchetDecrypt(sent.state, reply.message);
        expect(JSON.stringify(ratchet.exportRatchetState(b))).toBe(bBefore);
        expect(JSON.stringify(ratchet.exportRatchetState(sent.state))).not.toBe(before);
    });
});
