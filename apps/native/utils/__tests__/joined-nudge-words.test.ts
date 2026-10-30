/**
 * People's "You're in …" after joining a second community, in the member's language (utils/joined-nudge-words.ts). The
 * English is join-another-community.ts joinedNudge's, which stays off the words layer: held to it here in both kinds of
 * build, so a sentence changed there fails this test rather than quietly showing English in every other language.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } }));

import { pseudoLocalise, setLanguage } from '@beanpool/core';
import { joinedNudge } from '../join-another-community';
import { joinedNudgeWords } from '../joined-nudge-words';
import { noVault, useVault } from './fake-vault';

afterEach(() => { noVault(); setLanguage('en'); });

describe('the joined nudge in the member\'s language', () => {
    for (const [build, setUp] of [['with a key vault', useVault], ['without one', noVault]] as const) {
        it(`${build}: English exactly as joinedNudge writes it, the same answers offered`, () => {
            setUp();
            const english = joinedNudge('Mullumbimby');
            expect(joinedNudgeWords(english, 'Mullumbimby')).toEqual(english);
        });

        it(`${build}: in another language every part through t(), the community's name kept`, () => {
            setUp();
            setLanguage('xx');
            const words = joinedNudgeWords(joinedNudge('Mullumbimby'), 'Mullumbimby');
            for (const part of [words.title, words.body, words.later, words.protect].filter((p): p is string => !!p)) {
                expect(part.startsWith('['), part).toBe(true);
            }
            expect(words.title).toBe(pseudoLocalise("You're in {name}").replace('{name}', 'Mullumbimby'));
        });
    }

    // Vault rethink VR2: the new community's rule picks the nudge, in any build.
    for (const copies of ['vault', 'community', 'none'] as const) {
        it(`by the new community's rule (${copies}): English exactly as joinedNudge writes it, and through t() in another language`, () => {
            useVault();
            const english = joinedNudge('Mullumbimby', copies);
            expect(english.kind).toBe(copies);
            expect(joinedNudgeWords(english, 'Mullumbimby')).toEqual(english);
            setLanguage('xx');
            const words = joinedNudgeWords(english, 'Mullumbimby');
            for (const part of [words.title, words.body, words.later, words.protect].filter((p): p is string => !!p)) {
                expect(part.startsWith('['), part).toBe(true);
            }
            expect(!!words.protect).toBe(copies === 'community');
        });
    }
});
