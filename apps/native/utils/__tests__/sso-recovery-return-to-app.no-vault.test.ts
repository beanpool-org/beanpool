/**
 * A sign-in restore at the community that is refused AFTER the sign-in brings the app back to the front, so the member
 * reads why (deciding review of #1951, pre-existing P2). On Android the provider's page (a Custom Tab) can still be in
 * front of the app when the find or the release is refused, the copy doesn't open, or the copy is another account's; the welcome
 * screen showed its sentence behind it. Success and "Replace this phone's account?" already came back to the front.
 *
 * `recoverAccountWithSso` says when the sign-in is done (`onSignedIn`, as the vault's `startSsoRestore` does), and
 * welcome.tsx `handleSsoRecoverAtCommunity` calls `returnToApp()` in its catch when it was. A refusal before the sign-in
 * (no find nonce: the community can't be reached, or its server is too old) has opened no page, and brings nothing
 * forward.
 *
 * Nothing here contacts a node or a provider: the recovery routes are a stubbed signedPost (community-find.ts), Google's
 * sheet a stub.
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
import { CommunityRestoreRefused, recoverAccountWithSso } from '../sso-recovery';
import { restoreRefusalText } from '../community-restore-copy';
import { seedToKeypair } from '../crypto';
import { findAnswer, noNodeContacted } from './community-find';

const NODE = 'https://community.example.org';
const SEED = new Uint8Array(32).fill(42);
const OTHER_SEED = new Uint8Array(32).fill(7);
const SUB = '110169484474386276334';

/** What happened, in order: the sign-in being done, and each recovery route asked. */
let events: string[];

/**
 * Google hands back a token; the node answers each route: its find names Marty, its collect (which releases the copy, by
 * the find's hold) with `releaseStatus`, and the copy of `seed`.
 */
async function node(seed: Uint8Array, releaseStatus = 200) {
    const marty = (await seedToKeypair(SEED)).publicKeyHex;
    const sealed = await sealSeedToSso(seed, 'google', SUB);
    const b64 = (s: string) => Buffer.from(s).toString('base64url');
    vi.mocked(signInWithGoogle).mockResolvedValue({ idToken: `${b64('{"alg":"RS256"}')}.${b64(JSON.stringify({ sub: SUB }))}.sig`, nonce: 'n' });
    vi.mocked(signedPost).mockImplementation(async (_url: string, route: string) => {
        events.push(route);
        const answer = (status: number, body: unknown) => ({ ok: status === 200, status, json: async () => body }) as unknown as Response;
        const found = findAnswer(route, [{ publicKey: marty, callsign: 'Marty' }], 'n');
        if (found) return found;
        if (route === '/api/recovery/collect') {
            return releaseStatus === 200 ? answer(200, { collectionId: 'c1' }) : answer(releaseStatus, { error: 'That sign-in is not a way back into Marty.' });
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
const restore = () => recoverAccountWithSso({ anchorUrl: NODE, provider: 'google', onSignedIn });

const quietError = console.error;

beforeEach(async () => {
    mem.async.clear();
    mem.secure.clear();
    vi.clearAllMocks();
    events = [];
    noNodeContacted();
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
    it('once the provider hands back its token, before the find and the release', async () => {
        await node(SEED);

        await restore();

        expect(onSignedIn).toHaveBeenCalledTimes(1);
        expect(events).toEqual([
            '/api/recovery/find-nonce', 'signed in',
            '/api/recovery/find', '/api/recovery/collect', '/api/recovery/collect/fragments',
        ]);
    });

    it('a copy of another account, refused after the sign-in: the sign-in was said to be done', async () => {
        await node(OTHER_SEED);

        const refused = await restore().catch((e: unknown) => e);
        expect(refused).toBeInstanceOf(CommunityRestoreRefused);
        expect(refused).toMatchObject({ refusal: { code: 'not_that_account', name: 'Marty' } });
        expect(restoreRefusalText(refused, 'Riverside')).toBe("The account that came back isn't Marty, so nothing was saved on this phone. Try again, or use your 12 words.");

        expect(onSignedIn).toHaveBeenCalledTimes(1);
    });

    it('a release the community refuses, after the sign-in: the sign-in was said to be done', async () => {
        await node(SEED, 400);

        const refused = await restore().catch((e: unknown) => e);
        expect(refused).toMatchObject({ refusal: { code: 'refused', step: 'collect', status: 400 } });
        expect(restoreRefusalText(refused, 'Riverside')).toBe('That sign-in is not a way back into Marty.');

        expect(onSignedIn).toHaveBeenCalledTimes(1);
    });

    it('a sign-in that never finished (cancelled at the provider) is never said to be done', async () => {
        await node(SEED);
        vi.mocked(signInWithGoogle).mockRejectedValue(new SsoSignInError('cancelled', 'Sign-in was cancelled.'));

        await expect(restore()).rejects.toThrow('Sign-in was cancelled.');

        expect(onSignedIn).not.toHaveBeenCalled();
    });

    it('a refusal before any sign-in (the find nonce can\'t be had) opens no page and says nothing of one', async () => {
        await node(SEED);
        const answers = vi.mocked(signedPost).getMockImplementation()!;
        vi.mocked(signedPost).mockImplementation(async (...args) => {
            if (args[1] === '/api/recovery/find-nonce') throw new TypeError('Network request failed');
            return answers(...args);
        });

        const refused = await restore().catch((e: unknown) => e);
        expect(refused).toBeInstanceOf(CommunityRestoreRefused);
        expect(refused).toMatchObject({ refusal: { code: 'unreachable' } });
        expect(restoreRefusalText(refused, 'Riverside')).toBe("Can't reach the community right now. Try again in a minute.");

        expect(signInWithGoogle).not.toHaveBeenCalled();
        expect(onSignedIn).not.toHaveBeenCalled();
    });

    it('a server older than the find: no page opens, and the member is told to ask its admin', async () => {
        await node(SEED);
        const answers = vi.mocked(signedPost).getMockImplementation()!;
        vi.mocked(signedPost).mockImplementation(async (...args) => {
            if (args[1] === '/api/recovery/find-nonce') return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
            return answers(...args);
        });

        const refused = await restore().catch((e: unknown) => e);
        expect(refused).toMatchObject({ refusal: { code: 'server_too_old' } });
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
