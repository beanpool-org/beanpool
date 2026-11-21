/**
 * The sentence a block made in the web app adds to its confirmation (slice S7b, lib/blocked-here.ts; Marty, 21 Nov 2026,
 * question 2 of DESIGN-s7-blocks-verified-everywhere-fable.md): the community's own name from its card, else the address the
 * page is served from; never a throw, since the block is already done when it is asked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const card = vi.hoisted(() => ({ read: async (): Promise<unknown> => null }));
vi.mock('./join-names', () => ({
    ownCommunityCardOnce: () => card.read(),
    ownCommunityAddress: () => 'riverside.example',
}));

import { blockedHereSentence, blockedHereWords } from './blocked-here';

describe('blocked here (slice S7b)', () => {
    beforeEach(() => { card.read = async () => null; });

    it('names the community and how to block them everywhere', () => {
        expect(blockedHereWords('Riverside')).toBe('Blocked in Riverside. To block them in all your communities, block them in the phone app.');
    });

    it('takes the community\'s own name from its card', async () => {
        card.read = async () => ({ name: 'Riverside', host: 'riverside.example' });
        expect(await blockedHereSentence()).toBe('Blocked in Riverside. To block them in all your communities, block them in the phone app.');
    });

    it('a card with no name, none, or one that can\'t be read: the address the page is served from, and no throw', async () => {
        card.read = async () => ({ name: null, host: 'riverside.example' });
        expect(await blockedHereSentence()).toBe('Blocked in riverside.example. To block them in all your communities, block them in the phone app.');
        card.read = async () => null;
        expect(await blockedHereSentence()).toBe('Blocked in riverside.example. To block them in all your communities, block them in the phone app.');
        card.read = async () => { throw new Error('offline'); };
        expect(await blockedHereSentence()).toBe('Blocked in riverside.example. To block them in all your communities, block them in the phone app.');
    });
});
