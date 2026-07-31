import { describe, it, expect } from 'vitest';
import { createSignableBytes, signPayload } from '../crypto.js';
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys';

describe('beanpool-core crypto', () => {
    it('creates deterministic signable bytes from payload', () => {
        const payload = { peerId: '12D3KooW...', balance: 100 };
        const bytes1 = createSignableBytes(payload);
        const bytes2 = createSignableBytes(payload);

        expect(bytes1).toBeInstanceOf(Uint8Array);
        expect(Array.from(bytes1)).toEqual(Array.from(bytes2));
    });

    it('signs payload and generates base64 signature', async () => {
        const key = await generateKeyPair('Ed25519');
        const privKeyProtobuf = privateKeyToProtobuf(key);

        const payload = { action: 'TRANSFER', amount: 50, timestamp: 1700000000 };
        const signature = await signPayload(privKeyProtobuf, payload);

        expect(typeof signature).toBe('string');
        expect(signature.length).toBeGreaterThan(0);
    });
});
