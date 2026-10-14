import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { combineMnemonics, decodeShare, splitMasterSecret, Slip39Error } from '../keyholder/slip39.js';
import { SLIP39_WORDS } from '../keyholder/slip39-words.js';

/**
 * SLIP-0039 against its 45 official test vectors: the reference implementation's (python-shamir-mnemonic, MIT),
 * as shipped in slip39@0.1.9's test/vectors.json. Each is [description, mnemonics, master secret hex (empty when the
 * set must be refused), xprv]. The passphrase for every vector is "TREZOR".
 */

type Vector = [string, string[], string, string];
const vectors = JSON.parse(readFileSync(new URL('./fixtures/slip39-vectors.json', import.meta.url), 'utf8')) as Vector[];

describe('SLIP-0039', () => {
    it('uses the specification word list', () => {
        expect(SLIP39_WORDS).toHaveLength(1024);
        expect(new Set(SLIP39_WORDS.map(w => w.slice(0, 4))).size).toBe(1024);
        expect(crypto.createHash('sha256').update(`${SLIP39_WORDS.join('\n')}\n`).digest('hex'))
            .toBe('bcc4555340332d169718aed8bf31dd9d5248cb7da6e5d355140ef4f1e601eec3');
    });

    it('has all 45 official vectors', () => {
        expect(vectors).toHaveLength(45);
    });

    for (const [description, mnemonics, secretHex] of vectors) {
        it(description, () => {
            if (secretHex) {
                expect(combineMnemonics(mnemonics, 'TREZOR').toString('hex')).toBe(secretHex);
            } else {
                expect(() => combineMnemonics(mnemonics, 'TREZOR')).toThrow(Slip39Error);
            }
        });
    }

    it('splits a 32-byte secret 2 of 3 into 33-word shares any two of which rebuild it, and one of which does not', () => {
        const secret = crypto.randomBytes(32);
        const shares = splitMasterSecret(secret, { threshold: 2, count: 3 });
        expect(shares).toHaveLength(3);
        for (const s of shares) expect(s.split(' ')).toHaveLength(33);
        for (const [a, b] of [[0, 1], [0, 2], [1, 2], [2, 0]]) {
            expect(combineMnemonics([shares[a], shares[b]]).equals(secret)).toBe(true);
        }
        expect(() => combineMnemonics([shares[0]])).toThrow(/Wrong number of mnemonics/);
        expect(decodeShare(shares[1])).toMatchObject({ groupThreshold: 1, groupCount: 1, memberThreshold: 2, memberIndex: 1, extendable: false });
    });

    it('refuses shares of two different splits', () => {
        const a = splitMasterSecret(crypto.randomBytes(32), { threshold: 2, count: 3 });
        const b = splitMasterSecret(crypto.randomBytes(32), { threshold: 2, count: 3 });
        // Two splits share an identifier one time in 32768; skip that draw rather than assert on it.
        if (decodeShare(a[0]).identifier !== decodeShare(b[1]).identifier) {
            expect(() => combineMnemonics([a[0], b[1]])).toThrow(Slip39Error);
        }
    });
});
