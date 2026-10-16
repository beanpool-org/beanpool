/**
 * The phone makes a new account's 12 words with core's recoveryWordsFromEntropy, as the web app does (KEY-02): the same
 * entropy is the same words on both, and the words are standard BIP-39.
 */
import { describe, it, expect, vi } from 'vitest';
import { recoveryWordsFromEntropy } from '@beanpool/core';

const entropy = vi.hoisted(() => ({ next: null as Uint8Array | null }));
vi.mock('expo-crypto', async () => {
    const { webcrypto } = await import('node:crypto');
    return { getRandomBytes: (n: number) => entropy.next ?? webcrypto.getRandomValues(new Uint8Array(n)) };
});
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));

describe('the phone\'s new words', () => {
    it('are core\'s words for the entropy the phone drew, and the BIP-39 reference words for a reference entropy', async () => {
        const { generateMnemonic } = await import('../crypto');
        entropy.next = new Uint8Array(16).fill(0x7f);
        expect(generateMnemonic().join(' ')).toBe('legal winner thank year wave sausage worth useful legal winner thank yellow');
        entropy.next = Uint8Array.from({ length: 16 }, (_, i) => (i * 37 + 11) & 0xff);
        expect(generateMnemonic()).toEqual(recoveryWordsFromEntropy(entropy.next));
        entropy.next = null;
        expect(generateMnemonic()).toHaveLength(12);
    });
});
