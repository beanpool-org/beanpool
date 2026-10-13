import { describe, it, expect } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { namesKeyCode } from '@beanpool/core';
import { keyCodeOf } from '../key-code';

/**
 * The code worked out a second way (node's own SHA-256, BigInt): SHA-256 of "beanpool-key-code-v1\n" + the lower-case hex
 * key, five 4-byte slices of the digest, each mod 10,000. The names list's "Your code" is the same function.
 */
function oracle(hex: string): string {
    const d = createHash('sha256').update(`beanpool-key-code-v1\n${hex.toLowerCase()}`, 'utf8').digest();
    return [0, 1, 2, 3, 4].map((g) => String(BigInt('0x' + d.subarray(g * 4, g * 4 + 4).toString('hex')) % 10000n).padStart(4, '0')).join(' ');
}

describe('keyCodeOf: the 20-digit code two people compare (Settings → My key code, and the key-changed banner)', () => {
    it('is five groups of four digits, the same as a second way of working it out, for 200 random keys', () => {
        for (let i = 0; i < 200; i++) {
            const hex = randomBytes(32).toString('hex');
            const code = keyCodeOf(hex)!;
            expect(code).toMatch(/^\d{4} \d{4} \d{4} \d{4} \d{4}$/);
            expect(code).toBe(oracle(hex));
        }
    });
    it('one code per key in the app: the names list\'s "Your code" (core namesKeyCode) gives the same digits (#1873 review, finding 1)', () => {
        for (let i = 0; i < 200; i++) {
            const hex = randomBytes(32).toString('hex');
            expect(keyCodeOf(hex)).toBe(namesKeyCode(hex));
            expect(keyCodeOf(hex.toUpperCase())).toBe(namesKeyCode(hex));
        }
    });
    it('a pinned vector: the same key gives the same code on every phone and every version', () => {
        const hex = 'bb'.repeat(32);
        expect(keyCodeOf(hex)).toBe(oracle(hex));
        expect(keyCodeOf(hex)).toMatchInlineSnapshot(`"1479 0507 0978 3849 9965"`);
    });
    it('any capitals or surrounding spaces give the same code; anything that isn\'t a 32-byte key gives none', () => {
        const hex = randomBytes(32).toString('hex');
        expect(keyCodeOf(` ${hex.toUpperCase()} `)).toBe(keyCodeOf(hex));
        for (const bad of [null, undefined, '', 'bb'.repeat(31), 'zz'.repeat(32), 'bb'.repeat(33)]) expect(keyCodeOf(bad as any)).toBeNull();
    });
    it('two keys that differ in one byte give different codes', () => {
        const a = randomBytes(32);
        const b = Buffer.from(a); b[31] ^= 1;
        expect(keyCodeOf(a.toString('hex'))).not.toBe(keyCodeOf(b.toString('hex')));
    });
});
