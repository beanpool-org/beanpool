/**
 * What the restore screen says when a sign-in restore at the community stops (community-restore-copy.ts). sso-recovery.ts
 * refuses with a code and its data, never a sentence: it is on the 12 words' key path, which never reaches the words layer
 * (#1944, core recovery-path-files.test.ts).
 *
 * The sentences are the web's for the same answer (recovery S2; design §5: phone and web the same), so each is pinned here
 * to the English apps/pwa/src/lib/web-restore.ts writes (`noAccountMessage`, `findRefusalMessage`, `collectRefusalMessage`)
 * and lib/web-join.ts WRONG_CLOCK, read from those files: a sentence changed on one side fails here. Two are the phone's
 * own: a server older than the find (the web ships with its server, so never meets one, design §4), and the account that
 * came back isn't the one picked (as before S2, byte for byte).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-crypto', () => ({ getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(), deleteItemAsync: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() } }));
// sso-recovery.ts's sign-in and node modules: never reached here, and their native parts can't load under vitest.
vi.mock('../sso-signin', () => ({ signInWithGoogle: vi.fn(), signInWithApple: vi.fn(), signInWithFacebook: vi.fn(), SsoSignInError: class extends Error {} }));
vi.mock('../node-post', () => ({ signedPost: vi.fn() }));

import { setLanguage } from '@beanpool/core';
import { CommunityRestoreRefused, type CommunityRestoreRefusal } from '../sso-recovery';
import { communityRestoreRefusalText, restoreRefusalText } from '../community-restore-copy';

const WEB = fs.readFileSync(path.resolve(__dirname, '../../../pwa/src/lib/web-restore.ts'), 'utf8');
const WEB_JOIN = fs.readFileSync(path.resolve(__dirname, '../../../pwa/src/lib/web-join.ts'), 'utf8');

/** The web writes this sentence (as a template, `${…}` for what it fills in), word for word. */
function webWrites(source: string, template: string) {
    expect(source.includes(template), `the web writes: ${template}`).toBe(true);
}

const said = {
    unreachable: "Can't reach the community right now. Try again in a minute.",
    tooOld: (community: string) => `${community}'s server is older than this app and can't find your account from a sign-in yet. Ask its admin to update, or use your 12 words.`,
    none: (community: string, provider: string) => `No account at ${community} uses this ${provider} account. Try another community, or your 12 words.`,
    notThat: (name: string) => `The account that came back isn't ${name}, so nothing was saved on this phone. Try again, or use your 12 words.`,
    clock: "The community couldn't accept this because this device's date and time look wrong. Check them in this device's settings (set them to automatic), then try again.",
    tooMany: 'Too many tries from this network. Please try again later.',
    notChecked: (provider: string) => `${provider} sign-in couldn't be checked or took too long. Try again.`,
    notNow: (provider: string) => `${provider} sign-in could not be checked right now. Please try again in a minute.`,
    notBack: (status: number) => `The community could not bring the account back (${status}). Please try again.`,
};
/** Names as the screen gives them: plain, Turkish capitals, an apostrophe, a space, another script, braces like a placeholder. */
const NAMES = ['Riverside', 'İrem', "O'Neil Hall", 'Global community', 'Мария', '{community}'];

const refused = (r: Partial<Extract<CommunityRestoreRefusal, { code: 'refused' }>>): CommunityRestoreRefusal =>
    ({ code: 'refused', step: 'find', provider: 'google', status: 500, said: null, coded: false, ...r });

afterEach(() => setLanguage('en'));

describe('the restore screen\'s sentences for a refused sign-in restore at the community', () => {
    it.each(NAMES)('read as the design and the web say them, for the community %s', (community) => {
        expect(communityRestoreRefusalText({ code: 'unreachable' }, community)).toBe(said.unreachable);
        expect(communityRestoreRefusalText({ code: 'server_too_old' }, community)).toBe(said.tooOld(community));
        expect(communityRestoreRefusalText({ code: 'no_account_here', provider: 'google' }, community)).toBe(said.none(community, 'Google'));
        expect(communityRestoreRefusalText({ code: 'no_account_here', provider: 'facebook' }, community)).toBe(said.none(community, 'Facebook'));
        expect(communityRestoreRefusalText({ code: 'not_that_account', name: 'Marty' }, community)).toBe(said.notThat('Marty'));
    });

    it('the web writes the same sentences', () => {
        webWrites(WEB, 'No account at ${community} uses this ${providerLabel(provider)} account. Try another community, or your 12 words.');
        webWrites(WEB, "'Too many tries from this network. Please try again later.'");
        webWrites(WEB, "`${label} sign-in couldn't be checked or took too long. Try again.`");
        webWrites(WEB, '`${label} sign-in could not be checked right now. Please try again in a minute.`');
        webWrites(WEB, '`The community could not bring the account back (${answer.status}). Please try again.`');
        webWrites(WEB_JOIN, `export const WRONG_CLOCK = "${said.clock}";`);
    });

    it('a refused find: the web\'s sentence for each answer, and the community\'s own words where it gave some', () => {
        const at = (r: Partial<Extract<CommunityRestoreRefusal, { code: 'refused' }>>) => communityRestoreRefusalText(refused(r), 'Riverside');
        // A 401 with no code is the signature check's stale time: this phone's clock.
        expect(at({ status: 401 })).toBe(said.clock);
        expect(at({ status: 401, said: 'Request expired.' })).toBe(said.clock);
        expect(at({ status: 401, coded: true })).toBe(said.notChecked('Google'));
        expect(at({ status: 401, coded: true, provider: 'apple' })).toBe(said.notChecked('Apple'));
        expect(at({ status: 429 })).toBe(said.tooMany);
        expect(at({ status: 429, said: 'Slow down.' })).toBe('Slow down.');
        expect(at({ status: 503 })).toBe(said.notNow('Google'));
        expect(at({ status: 503, said: 'Busy finding another account. Wait a minute, then sign in again.', coded: true }))
            .toBe('Busy finding another account. Wait a minute, then sign in again.');
        expect(at({ status: 400, said: 'That sign-in has expired.' })).toBe('That sign-in has expired.');
        expect(at({ status: 500 })).toBe(said.notBack(500));
    });

    it('a refused find nonce (no sign-in yet) and a refused collect: no sign-in sentence, as the web', () => {
        const at = (r: Partial<Extract<CommunityRestoreRefusal, { code: 'refused' }>>) => communityRestoreRefusalText(refused(r), 'Riverside');
        expect(at({ provider: null, status: 401, coded: true })).toBe(said.notBack(401));
        expect(at({ provider: null, status: 503 })).toBe(said.notBack(503));
        expect(at({ provider: null, status: 409, said: 'This server is a standby.', coded: true })).toBe('This server is a standby.');
        expect(at({ step: 'collect', status: 400, said: "Sign in with your account's sign-in first." })).toBe("Sign in with your account's sign-in first.");
        expect(at({ step: 'collect', status: 503, coded: true })).toBe(said.notBack(503));
        expect(at({ step: 'collect', status: 401 })).toBe(said.clock);
        expect(at({ step: 'collect', status: 429 })).toBe(said.tooMany);
    });

    it('a refusal carries its code and data, never a name in its message, and the screen says its sentence', () => {
        const e = new CommunityRestoreRefused({ code: 'not_that_account', name: 'Marty' });
        expect(e).toBeInstanceOf(Error);
        expect(e.refusal).toEqual({ code: 'not_that_account', name: 'Marty' });
        expect(e.message).not.toContain('Marty');
        expect(restoreRefusalText(e, 'Riverside')).toBe(said.notThat('Marty'));
        expect(restoreRefusalText(new CommunityRestoreRefused({ code: 'no_account_here', provider: 'apple' }), 'Riverside'))
            .toBe(said.none('Riverside', 'Apple'));
    });

    it('any other error shows its own message, as the screen always did; nothing to show is undefined', () => {
        expect(restoreRefusalText(new Error('That sign-in is not a way back into Marty.'), 'Riverside')).toBe('That sign-in is not a way back into Marty.');
        expect(restoreRefusalText(new Error(''), 'Riverside')).toBeUndefined();
        expect(restoreRefusalText(null, 'Riverside')).toBeUndefined();
        expect(restoreRefusalText('boom', 'Riverside')).toBeUndefined();
    });

    it('in another language the sentences come from its catalog, with the community and the sign-in in place', () => {
        setLanguage('fr', [{
            'No account at {community} uses this {provider} account. Try another community, or your 12 words.': 'Aucun compte à {community} pour ce compte {provider}.',
        }]);
        expect(communityRestoreRefusalText({ code: 'no_account_here', provider: 'google' }, 'İrem')).toBe('Aucun compte à İrem pour ce compte Google.');
        // No translation yet: the English shows.
        expect(communityRestoreRefusalText({ code: 'unreachable' }, 'Riverside')).toBe(said.unreachable);
    });
});
