import { createHash, createHmac, scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CLAIM_SCRYPT, CLAIM_TAG, claimKeyFromCode, claimKeyFromCodeAsync, claimProof, claimProofText, claimText } from '../index.js';

// Fixed vectors, made once with Node's crypto (the server's derivation) and kept as literals.
const CODE = 'claim-a1b2-c3d4-e5f6-7890';
const SALT = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const KEY = '418c61634b782ba89a7feca46fbe1fdc8d68ab2c99995bdc778fe549d9f419e4';
const HOST = 'claim-test.example';
const CODE_ID = '0a1b2c3d';
const PUB = 'ab'.repeat(32);
const PROOF = '2ae732cf2f151472cf4bc8159fef30aabfba7277dbc6d09fca5a33eec22a3373';
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('claim v2', () => {
    it('derives the key the server stores: scrypt(sha256(code), salt) with the parameters it uses', () => {
        expect(CLAIM_SCRYPT).toEqual({ N: 16384, r: 8, p: 1, dkLen: 32 });
        expect(hex(claimKeyFromCode(CODE, SALT))).toBe(KEY);
        const server = scryptSync(createHash('sha256').update(CODE).digest('hex'), SALT, 32, { N: 16384, r: 8, p: 1 });
        expect(hex(claimKeyFromCode(CODE, SALT))).toBe(server.toString('hex'));
    });

    it('reads the code as the server does: trimmed, lower case', async () => {
        expect(hex(claimKeyFromCode(`  ${CODE.toUpperCase()}\n`, SALT))).toBe(KEY);
        expect(hex(await claimKeyFromCodeAsync(CODE, SALT))).toBe(KEY);
    });

    it('proves the code as HMAC-SHA256(K, beanpool-claim-proof/1, host, code id, key)', () => {
        expect(claimProofText(HOST, CODE_ID, PUB)).toBe(`beanpool-claim-proof/1\n${HOST}\n${CODE_ID}\n${PUB}`);
        expect(claimProof(claimKeyFromCode(CODE, SALT), HOST, CODE_ID, PUB)).toBe(PROOF);
        const server = createHmac('sha256', Buffer.from(KEY, 'hex')).update(claimProofText(HOST, CODE_ID, PUB)).digest('hex');
        expect(PROOF).toBe(server);
    });

    it('binds the proof to the host, the code id and the key', () => {
        const k = claimKeyFromCode(CODE, SALT);
        expect(claimProof(k, 'other.example', CODE_ID, PUB)).not.toBe(PROOF);
        expect(claimProof(k, HOST, 'deadbeef', PUB)).not.toBe(PROOF);
        expect(claimProof(k, HOST, CODE_ID, 'cd'.repeat(32))).not.toBe(PROOF);
        expect(claimProof(claimKeyFromCode('claim-0000-0000-0000-0000', SALT), HOST, CODE_ID, PUB)).not.toBe(PROOF);
    });

    it('signs beanpool-claim/2 with the host, the code id, the key and the proof', () => {
        expect(CLAIM_TAG).toBe('beanpool-claim/2');
        expect(claimText(HOST, CODE_ID, PUB, PROOF)).toBe(`beanpool-claim/2\n${HOST}\n${CODE_ID}\n${PUB}\n${PROOF}`);
    });
});
