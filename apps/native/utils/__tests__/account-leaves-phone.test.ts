/**
 * An account that leaves this phone takes its push alerts with it, and, at Sign Out, its saved communities and their
 * cached copies (utils/account-leaves-phone.ts).
 *
 * The phone registered its push token with the account's communities. Nothing unregistered it: Sign Out and the
 * node-mismatch delete took the key off the phone and the node went on sending the old account's chat, escrow and
 * recovery alerts to it (#1183 review 5324593567). Now each community the phone knows is asked to drop the token,
 * signed by the old key while the phone still holds it, best effort: a node that can't be reached never holds up or
 * fails the flow. Replace is covered where the restores are (restore-from-words, sso-recovery-replace).
 *
 * Nothing here contacts a node: fetch is a stub that records what would have been sent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
    getItemAsync: vi.fn(async (key: string) => mem.secure.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => { mem.secure.set(key, value); }),
    deleteItemAsync: vi.fn(async (key: string) => { mem.secure.delete(key); }),
}));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) };
});
vi.mock('../db', () => ({ clearDB: vi.fn(async () => {}), closeDB: vi.fn(async () => {}) }));
vi.mock('../community-cache', () => ({ removeCommunityCaches: vi.fn(async () => {}) }));
// For the real community-cache below.
vi.mock('expo-sqlite', () => ({ defaultDatabaseDirectory: '/data/user/0/org.beanpool.app/files/SQLite' }));
vi.mock('expo-file-system/legacy', () => ({ deleteAsync: vi.fn(async () => {}) }));
vi.mock('../../services/pillar-sync', () => ({ resetSyncFingerprints: vi.fn() }));

import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import {
    communitiesOnThisPhone, deleteAccountFromThisPhone, signOutOfThisPhone, unregisterPushToken, UNREGISTER_TIMEOUT_MS,
} from '../account-leaves-phone';
import { removeCommunityCaches } from '../community-cache';
import { clearDB, closeDB } from '../db';
import { resetSyncFingerprints } from '../../services/pillar-sync';
import { draftIdentity, importIdentity, loadIdentity, type BeanPoolIdentity } from '../identity';
import { decodeBase64, encodeUtf8, hexToBytes, verifyData } from '../crypto';
import { PUSH_TOKEN_STORE_KEY, SAVED_NODES_STORE_KEY } from '../storage-keys';

const MULLUM = 'https://mullum.beanpool.org';
const BELLINGEN = 'https://bellingen.beanpool.org';
const BYRON = 'https://byron.beanpool.org';
const ANCHOR = 'beanpool_anchor_url';
const GUESTS = 'beanpool_guest_nodes';
const PHONE_TOKEN = 'ExponentPushToken[kims-phone]';
const IDENTITY_KEY = 'sovereign-identity';

interface Sent {
    url: string;
    method: string | undefined;
    headers: Record<string, string>;
    body: string;
    /** The key the phone held when the request went out. */
    keyOnPhone: string | undefined;
    signal: AbortSignal | undefined;
}

/** Each community's answer: 'ok', 'refused' (a 500), 'down' (a network error), or 'silent' (never answers). */
type Answer = 'ok' | 'refused' | 'down' | 'silent';

function nodes(answer: (url: string) => Answer = () => 'ok'): Sent[] {
    const sent: Sent[] = [];
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        sent.push({
            url,
            method: init?.method,
            headers: init?.headers as Record<string, string>,
            body: String(init?.body),
            keyOnPhone: (await loadIdentity())?.publicKey,
            signal: init?.signal ?? undefined,
        });
        const a = answer(url);
        if (a === 'down') throw new TypeError('Network request failed');
        if (a === 'silent') {
            return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
            });
        }
        return new Response(JSON.stringify(a === 'ok' ? { success: true } : { error: 'nope' }), { status: a === 'ok' ? 200 : 500 });
    });
    return sent;
}

/** A DELETE /api/push-tokens for this token, signed by this key (checked against the key, not just named). */
async function unregisters(req: Sent, account: BeanPoolIdentity, token = PHONE_TOKEN): Promise<boolean> {
    const h = req.headers;
    const canonical = `DELETE\n/api/push-tokens\n${h['X-Timestamp']}\n${h['X-Nonce']}\n${req.body}`;
    const body = JSON.parse(req.body);
    return req.method === 'DELETE'
        && h['X-Public-Key'] === account.publicKey
        && body.publicKey === account.publicKey && body.token === token
        && await verifyData(decodeBase64(h['X-Signature']), encodeUtf8(canonical), hexToBytes(account.publicKey));
}

const pushTokensAt = (...communities: string[]) => communities.map((c) => `${c}/api/push-tokens`).sort();

let kim: BeanPoolIdentity;
const quietError = console.error;

beforeEach(async () => {
    mem.async.clear();
    mem.secure.clear();
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No node may be contacted from a test'); }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // identity.ts reaches AsyncStorage and the database through `require`, which no vi.mock reaches: quietened.
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        if (typeof args[0] === 'string'
            && (args[0].startsWith('Failed to migrate legacy identity') || args[0].startsWith('Failed to fully wipe native identity state'))) return;
        quietError(...args);
    });
    kim = await draftIdentity('Kim');
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/** Kim's phone: set to Mullum, Mullum and Bellingen saved, Byron visited as a guest, and a push token. */
async function kimsPhone() {
    await importIdentity(kim);
    mem.async.set(ANCHOR, MULLUM);
    mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: MULLUM, alias: 'Mullum' }, { url: BELLINGEN }]));
    mem.async.set(GUESTS, JSON.stringify([BYRON]));
    mem.async.set('beanpool_light_palette', 'sand');
    mem.secure.set(PUSH_TOKEN_STORE_KEY, PHONE_TOKEN);
}

function callOrder(fn: unknown, index = 0): number {
    return vi.mocked(fn as (...a: unknown[]) => unknown).mock.invocationCallOrder[index];
}

function identityRemovedAt(): number {
    const i = vi.mocked(SecureStore.deleteItemAsync).mock.calls.findIndex(([key]) => key === IDENTITY_KEY);
    return vi.mocked(SecureStore.deleteItemAsync).mock.invocationCallOrder[i];
}

describe('Sign Out (Device Only)', () => {
    it('unregisters the phone\'s push token on each of Kim\'s communities, signed by Kim\'s key while the phone still holds it', async () => {
        await kimsPhone();
        const sent = nodes();

        await signOutOfThisPhone(kim);

        // Mullum is both the community the phone is set to and a saved one: asked once.
        expect(sent.map((s) => s.url).sort()).toEqual(pushTokensAt(MULLUM, BELLINGEN, BYRON));
        for (const req of sent) {
            expect(await unregisters(req, kim)).toBe(true);
            expect(req.keyOnPhone).toBe(kim.publicKey);
        }
        const lastRequest = Math.max(...vi.mocked(fetch).mock.invocationCallOrder);
        expect(identityRemovedAt()).toBeGreaterThan(lastRequest);
        expect(mem.secure.has(PUSH_TOKEN_STORE_KEY)).toBe(false);
    });

    it('then the key, the saved communities and each one\'s cached copy go; the phone\'s own settings stay', async () => {
        await kimsPhone();
        nodes();

        await signOutOfThisPhone(kim);

        expect(await loadIdentity()).toBeNull();
        expect(mem.async.has(SAVED_NODES_STORE_KEY)).toBe(false);
        expect(mem.async.get('beanpool_light_palette')).toBe('sand');
        expect(removeCommunityCaches).toHaveBeenCalledTimes(1);
        expect([...vi.mocked(removeCommunityCaches).mock.calls[0][0]].sort()).toEqual([MULLUM, BELLINGEN, BYRON].sort());
        // The open community's tables are dropped first, as before; the cached copies go after the unregister.
        expect(callOrder(clearDB)).toBeLessThan(callOrder(fetch));
        expect(callOrder(removeCommunityCaches)).toBeGreaterThan(Math.max(...vi.mocked(fetch).mock.invocationCallOrder));
    });

    it('a community that can\'t be reached, refuses, or never answers neither holds up nor fails Sign Out', async () => {
        await kimsPhone();
        const sent = nodes((url) => (url.startsWith(MULLUM) ? 'down' : url.startsWith(BELLINGEN) ? 'silent' : 'refused'));
        const started = Date.now();

        await expect(signOutOfThisPhone(kim)).resolves.toBeUndefined();

        expect(Date.now() - started).toBeLessThan(UNREGISTER_TIMEOUT_MS + 2000);
        expect(sent).toHaveLength(3);
        expect(sent.find((s) => s.url.startsWith(BELLINGEN))?.signal?.aborted).toBe(true);
        expect(await loadIdentity()).toBeNull();
        expect(mem.async.has(SAVED_NODES_STORE_KEY)).toBe(false);
        expect(removeCommunityCaches).toHaveBeenCalledTimes(1);
    }, UNREGISTER_TIMEOUT_MS + 10_000);

    it('a phone that never got a push token (a simulator, Expo Go, notifications refused) asks no node', async () => {
        await kimsPhone();
        mem.secure.delete(PUSH_TOKEN_STORE_KEY);

        await signOutOfThisPhone(kim);

        expect(fetch).not.toHaveBeenCalled();
        expect(await loadIdentity()).toBeNull();
        expect(mem.async.has(SAVED_NODES_STORE_KEY)).toBe(false);
    });
});

describe('Delete this account from this phone (a community that doesn\'t recognise it)', () => {
    it('unregisters with Kim\'s key on each community before the key goes; the saved communities stay to recover on', async () => {
        await kimsPhone();
        const sent = nodes();

        await deleteAccountFromThisPhone(kim);

        expect(sent.map((s) => s.url).sort()).toEqual(pushTokensAt(MULLUM, BELLINGEN, BYRON));
        for (const req of sent) {
            expect(await unregisters(req, kim)).toBe(true);
            expect(req.keyOnPhone).toBe(kim.publicKey);
        }
        expect(identityRemovedAt()).toBeGreaterThan(Math.max(...vi.mocked(fetch).mock.invocationCallOrder));
        expect(await loadIdentity()).toBeNull();
        expect(JSON.parse(mem.async.get(SAVED_NODES_STORE_KEY) ?? '[]').map((n: { url: string }) => n.url)).toEqual([MULLUM, BELLINGEN]);
        expect(removeCommunityCaches).not.toHaveBeenCalled();
    });

    it('a community that can\'t be reached doesn\'t stop the delete', async () => {
        await kimsPhone();
        nodes(() => 'down');

        await expect(deleteAccountFromThisPhone(kim)).resolves.toBeUndefined();

        expect(await loadIdentity()).toBeNull();
    });
});

describe('the unregister itself', () => {
    it('gives up on a community that never answers at the deadline, and the others are still asked', async () => {
        await kimsPhone();
        const sent = nodes((url) => (url.startsWith(BELLINGEN) ? 'silent' : 'ok'));
        const started = Date.now();

        await unregisterPushToken(kim, [BELLINGEN, BYRON], 50);

        expect(Date.now() - started).toBeLessThan(2000);
        expect(sent.map((s) => s.url).sort()).toEqual(pushTokensAt(BELLINGEN, BYRON));
        expect(sent.find((s) => s.url.startsWith(BELLINGEN))?.signal?.aborted).toBe(true);
    });

    it('lists each community once, reading only: trailing slashes, the anchor inside the saved list, junk ignored', async () => {
        mem.async.set(ANCHOR, `${MULLUM}/`);
        mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: MULLUM }, { url: 'not a url' }, null, { alias: 'no url' }, { url: BELLINGEN }]));
        mem.async.set(GUESTS, '{not json');

        expect(await communitiesOnThisPhone()).toEqual([MULLUM, BELLINGEN]);
        expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    });
});

describe('each community\'s cached copy', () => {
    it('closes the open copy, then removes each database with its WAL, index and journal from expo-sqlite\'s directory', async () => {
        const real = await vi.importActual<typeof import('../community-cache')>('../community-cache');
        vi.mocked(FileSystem.deleteAsync).mockImplementation(async (uri: string) => {
            if (uri.endsWith('-shm') && uri.includes('bellingen')) throw new Error('busy');
        });

        await real.removeCommunityCaches([MULLUM, BELLINGEN, MULLUM]);

        expect(resetSyncFingerprints).toHaveBeenCalledTimes(1);
        expect(callOrder(closeDB)).toBeLessThan(callOrder(FileSystem.deleteAsync));
        const dir = 'file:///data/user/0/org.beanpool.app/files/SQLite';
        const removed = vi.mocked(FileSystem.deleteAsync).mock.calls.map(([uri]) => uri);
        const files = (name: string) => ['', '-wal', '-shm', '-journal'].map((s) => `${dir}/${name}${s}`);
        // Each community once, and a file that can't be removed doesn't stop the rest.
        expect(removed).toEqual([
            ...files('beanpool_https___mullum_beanpool_org.db'),
            ...files('beanpool_https___bellingen_beanpool_org.db'),
        ]);
        for (const [, options] of vi.mocked(FileSystem.deleteAsync).mock.calls) expect(options).toEqual({ idempotent: true });
    });
});
