/**
 * A sign-in restore at the community that is refused AFTER the sign-in brings the app back to the front, so the member
 * reads why (deciding review of #1951, pre-existing P2). On Android the provider's page (a Custom Tab) can still be in
 * front of the app when the release is refused, the copy doesn't open, or the copy is another account's; the welcome
 * screen showed its sentence behind it. Success and "Replace this phone's account?" already came back to the front.
 *
 * `recoverAccountWithSso` says when the sign-in is done (`onSignedIn`, as the vault's `startSsoRestore` does), and
 * welcome.tsx `handleSsoRecoverAtCommunity` calls `returnToApp()` in its catch when it was. A refusal before the sign-in
 * (no lookup, no such account) has opened no page, and brings nothing forward.
 *
 * Nothing here contacts a node or a provider: the lookup is a stubbed fetch (community-lookup.ts), the recovery routes a
 * stubbed signedPost, Google's sheet a stub.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
const mem = vi.hoisted(() => ({ async: new Map<string, string>(), secure: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => mem.async.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { mem.async.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { mem.async.delete(key); }),
        getAllKeys: vi.fn(async () => [...mem.async.keys()]),
        multiRemove: vi.fn(async (keys: string[]) => { keys.forEach((k) => mem.async.delete(k)); }),
    },
}));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(async (key: string) => mem.secure.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => { mem.secure.set(key, value); }),
    deleteItemAsync: vi.fn(async (key: string) => { mem.secure.delete(key); }),
}));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) };
});
vi.mock('../sso-signin', () => {
    class SsoSignInError extends Error {
        constructor(readonly reason: string, message: string) {
            super(message);
        }
    }
    return { signInWithGoogle: vi.fn(), signInWithApple: vi.fn(), signInWithFacebook: vi.fn(), SsoSignInError };
});
vi.mock('../node-post', () => ({ signedPost: vi.fn() }));

import { sealSeedToSso } from '@beanpool/core';
import { signedPost } from '../node-post';
import { signInWithGoogle, SsoSignInError } from '../sso-signin';
import { LOOKUP_UNREACHABLE, notThatAccount, recoverAccountWithSso } from '../sso-recovery';
import { seedToKeypair } from '../crypto';
import { stubCommunityLookup } from './community-lookup';

const NODE = 'https://community.example.org';
const SEED = new Uint8Array(32).fill(42);
const OTHER_SEED = new Uint8Array(32).fill(7);
const SUB = '110169484474386276334';

/** What happened, in order: the sign-in being done, and each recovery route asked. */
let events: string[];

/** Google hands back a token; the node answers each route, the release with `releaseStatus`, the copy of `seed`. */
async function node(seed: Uint8Array, releaseStatus = 200) {
    const sealed = await sealSeedToSso(seed, 'google', SUB);
    const b64 = (s: string) => Buffer.from(s).toString('base64url');
    vi.mocked(signInWithGoogle).mockResolvedValue({ idToken: `${b64('{"alg":"RS256"}')}.${b64(JSON.stringify({ sub: SUB }))}.sig`, nonce: 'n' });
    vi.mocked(signedPost).mockImplementation(async (_url: string, route: string) => {
        events.push(route);
        const answer = (status: number, body: unknown) => ({ ok: status === 200, status, json: async () => body }) as unknown as Response;
        if (route === '/api/recovery/collect') return answer(200, { collectionId: 'c1' });
        if (route === '/api/recovery/collect/sso-nonce') return answer(200, { nonce: 'n' });
        if (route === '/api/recovery/collect/sso') {
            return releaseStatus === 200 ? answer(200, { collected: 1 }) : answer(releaseStatus, { error: 'That sign-in is not a way back into Marty.' });
        }
        if (route === '/api/recovery/collect/fragments') {
            return answer(200, { fragments: [{
                holderType: 'sso', shareIndex: 1,
                payload: sealed.encryptedShare, payloadIv: sealed.shareIv, payloadTag: sealed.shareTag, kdfParams: sealed.kdfParams,
            }] });
        }
        throw new Error(`Unexpected route: ${route}`);
    });
}

const onSignedIn = vi.fn(() => { events.push('signed in'); });
const restore = () => recoverAccountWithSso({ callsign: 'Marty', anchorUrl: NODE, provider: 'google', onSignedIn });

const quietError = console.error;

beforeEach(async () => {
    mem.async.clear();
    mem.secure.clear();
    vi.clearAllMocks();
    events = [];
    stubCommunityLookup(NODE, [{ publicKey: (await seedToKeypair(SEED)).publicKeyHex, callsign: 'Marty' }]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        if (typeof args[0] === 'string' && args[0].startsWith('Failed to migrate legacy identity')) return;
        quietError(...args);
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('the restore says when the sign-in is done, so the screen knows a page may be in front of it', () => {
    it('once the provider hands back its token, before the release', async () => {
        await node(SEED);

        await restore();

        expect(onSignedIn).toHaveBeenCalledTimes(1);
        expect(events).toEqual([
            '/api/recovery/collect', '/api/recovery/collect/sso-nonce', 'signed in',
            '/api/recovery/collect/sso', '/api/recovery/collect/fragments',
        ]);
    });

    it('a copy of another account, refused after the sign-in: the sign-in was said to be done', async () => {
        await node(OTHER_SEED);

        await expect(restore()).rejects.toThrow(notThatAccount('Marty'));

        expect(onSignedIn).toHaveBeenCalledTimes(1);
    });

    it('a release the community refuses, after the sign-in: the sign-in was said to be done', async () => {
        await node(SEED, 400);

        await expect(restore()).rejects.toThrow('That sign-in is not a way back into Marty.');

        expect(onSignedIn).toHaveBeenCalledTimes(1);
    });

    it('a sign-in that never finished (cancelled at the provider) is never said to be done', async () => {
        await node(SEED);
        vi.mocked(signInWithGoogle).mockRejectedValue(new SsoSignInError('cancelled', 'Sign-in was cancelled.'));

        await expect(restore()).rejects.toThrow('Sign-in was cancelled.');

        expect(onSignedIn).not.toHaveBeenCalled();
    });

    it('a refusal before any sign-in (the lookup can\'t be had) opens no page and says nothing of one', async () => {
        await node(SEED);
        stubCommunityLookup('https://elsewhere.example.org', []);

        await expect(restore()).rejects.toThrow(LOOKUP_UNREACHABLE);

        expect(signInWithGoogle).not.toHaveBeenCalled();
        expect(onSignedIn).not.toHaveBeenCalled();
    });
});

describe('the welcome screen brings the app back to the front when a restore is refused after the sign-in', () => {
    const welcome = fs.readFileSync(path.resolve(__dirname, '../../app/welcome.tsx'), 'utf8');
    const start = welcome.indexOf('async function handleSsoRecoverAtCommunity(');
    const handler = welcome.slice(start, welcome.indexOf('\n    }\n', start));
    const caught = handler.slice(handler.indexOf('} catch (e: any) {'), handler.indexOf('} finally {'));

    it('the restore is told to record the moment the sign-in is done', () => {
        expect(start).toBeGreaterThan(0);
        expect(handler).toMatch(/let signedIn = false;/);
        expect(handler).toMatch(/onSignedIn: \(\) => \{\s*signedIn = true;\s*\}/);
    });

    it('its catch brings the app back first when it was, whatever the error, and only then shows the sentence', () => {
        expect(caught).toMatch(/^\} catch \(e: any\) \{\n(\s*\/\/.*\n)*\s*if \(signedIn\) await returnToApp\(\);\n/);
        expect(caught.indexOf('await returnToApp()')).toBeLessThan(caught.indexOf('setError('));
    });
});
