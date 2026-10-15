/**
 * What the restore screen says when a sign-in restore at the community stops (community-restore-copy.ts), now that
 * sso-recovery.ts refuses with a code and the name typed instead of a sentence: it is on the 12 words' key path, which
 * never reaches the words layer (#1944, core recovery-path-files.test.ts).
 *
 * The English is pinned as it read before the move (origin/main 61041a51, sso-recovery.ts `lookupUnreachable`,
 * `noRestorableAccount`, `notThatAccount`; a2317dc2, #1977's `twoAccountsOneName`), byte for byte.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-crypto', () => ({ getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(), deleteItemAsync: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() } }));
// sso-recovery.ts's sign-in and node modules: never reached here, and their native parts can't load under vitest.
vi.mock('../sso-signin', () => ({ signInWithGoogle: vi.fn(), signInWithApple: vi.fn(), signInWithFacebook: vi.fn(), SsoSignInError: class extends Error {} }));
vi.mock('../node-post', () => ({ signedPost: vi.fn() }));

import { setLanguage } from '@beanpool/core';
import { CommunityRestoreRefused } from '../sso-recovery';
import { communityRestoreRefusalText, restoreRefusalText } from '../community-restore-copy';

const BEFORE = {
    unreachable: "Can't reach the community right now. Try again in a minute.",
    noAccount: (name: string) => `No account called ${name} here can come back with a sign-in. Check you've typed your whole name, or use your 12 words.`,
    notThat: (name: string) => `The account that came back isn't ${name}, so nothing was saved on this phone. Try again, or use your 12 words.`,
    /** #1977's sentence (a2317dc2 sso-recovery.ts `twoAccountsOneName`). */
    twoAccounts: "Two accounts here have this name. Use your 12 words, or ask your community's admin.",
};
/** Names as typed: plain, Turkish capitals, an apostrophe, a space, another script, and braces that look like a placeholder. */
const NAMES = ['Marty', '\u0130rem', "O'Neil", 'Kim Lee', 'Мария', '{name}'];

afterEach(() => setLanguage('en'));

describe('the restore screen\'s sentences for a refused sign-in restore', () => {
    it.each(NAMES)('read exactly as before, for the name %s', (name) => {
        expect(communityRestoreRefusalText({ code: 'lookup_unreachable' })).toBe(BEFORE.unreachable);
        expect(communityRestoreRefusalText({ code: 'no_restorable_account', name })).toBe(BEFORE.noAccount(name));
        expect(communityRestoreRefusalText({ code: 'not_that_account', name })).toBe(BEFORE.notThat(name));
        expect(communityRestoreRefusalText({ code: 'two_accounts_one_name' })).toBe(BEFORE.twoAccounts);
    });

    it('a refusal carries its code and the name as data, and the screen says its sentence', () => {
        const refused = new CommunityRestoreRefused({ code: 'not_that_account', name: 'Marty' });
        expect(refused).toBeInstanceOf(Error);
        expect(refused.refusal).toEqual({ code: 'not_that_account', name: 'Marty' });
        expect(refused.message).not.toContain('Marty');
        expect(restoreRefusalText(refused)).toBe(BEFORE.notThat('Marty'));
    });

    it('any other error shows its own message, as the screen always did; nothing to show is undefined', () => {
        expect(restoreRefusalText(new Error('That sign-in is not a way back into Marty.'))).toBe('That sign-in is not a way back into Marty.');
        expect(restoreRefusalText(new Error(''))).toBeUndefined();
        expect(restoreRefusalText(null)).toBeUndefined();
        expect(restoreRefusalText('boom')).toBeUndefined();
    });

    it('in another language the sentences come from its catalog, with the name in place', () => {
        setLanguage('fr', [{
            "No account called {name} here can come back with a sign-in. Check you've typed your whole name, or use your 12 words.": 'Aucun compte {name} ici.',
        }]);
        expect(communityRestoreRefusalText({ code: 'no_restorable_account', name: '\u0130rem' })).toBe('Aucun compte \u0130rem ici.');
        // No translation yet: the English shows.
        expect(communityRestoreRefusalText({ code: 'lookup_unreachable' })).toBe(BEFORE.unreachable);
    });
});
