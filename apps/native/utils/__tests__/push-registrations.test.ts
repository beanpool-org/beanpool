/**
 * The phone records where it sent its push token (utils/push-registrations.ts), and an account leaving the phone asks
 * only those communities to drop it (utils/account-leaves-phone.ts).
 *
 * The token lets whoever holds it push to this phone. Sign Out and Replace used to send it to every community the
 * phone knew, the saved ones and the guest ones too, so a community that never had it was handed it on the way out
 * (#1184 review 4110460184). Now each registration records its community before it goes out, so a node that took the
 * token but whose answer was lost is on the record too, and the leaving account's unregister goes there and nowhere else.
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

import AsyncStorage from '@react-native-async-storage/async-storage';
import { pushRegisteredCommunities, registerPushTokenWithCommunity } from '../push-registrations';
import { signOutOfThisPhone } from '../account-leaves-phone';
import { draftIdentity, importIdentity, type BeanPoolIdentity } from '../identity';
import { decodeBase64, encodeUtf8, hexToBytes, verifyData } from '../crypto';
import { PUSH_REGISTERED_AT_STORE_KEY, PUSH_TOKEN_STORE_KEY, SAVED_NODES_STORE_KEY } from '../storage-keys';

const MULLUM = 'https://mullum.beanpool.org';
const BELLINGEN = 'https://bellingen.beanpool.org';
const BYRON = 'https://byron.beanpool.org';
const ANCHOR = 'beanpool_anchor_url';
const GUESTS = 'beanpool_guest_nodes';
const PHONE_TOKEN = 'ExponentPushToken[kims-phone]';

interface Sent {
    url: string;
    method: string | undefined;
    headers: Record<string, string>;
    body: string;
    /** The record as it stood when the request went out. */
    recordAtSend: string | undefined;
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
            recordAtSend: mem.async.get(PUSH_REGISTERED_AT_STORE_KEY),
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

/** This request, as signed: its signature checked against the key, not just the name. */
async function signedBy(req: Sent, account: BeanPoolIdentity): Promise<boolean> {
    const h = req.headers;
    const canonical = `${req.method}\n/api/push-tokens\n${h['X-Timestamp']}\n${h['X-Nonce']}\n${req.body}`;
    return h['X-Public-Key'] === account.publicKey
        && await verifyData(decodeBase64(h['X-Signature']), encodeUtf8(canonical), hexToBytes(account.publicKey));
}

const record = () => JSON.parse(mem.async.get(PUSH_REGISTERED_AT_STORE_KEY) ?? 'null');

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

describe('registering the push token', () => {
    it('records the community the phone is set to before the token goes out, then sends it there, signed by the account\'s key', async () => {
        mem.async.set(ANCHOR, `${MULLUM}/`);
        const sent = nodes();

        expect(await registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android')).toBe(true);

        expect(sent).toHaveLength(1);
        const [req] = sent;
        expect(req.url).toBe(`${MULLUM}/api/push-tokens`);
        expect(req.method).toBe('POST');
        expect(JSON.parse(req.body)).toEqual({ publicKey: kim.publicKey, token: PHONE_TOKEN, platform: 'android' });
        expect(await signedBy(req, kim)).toBe(true);
        expect(JSON.parse(req.recordAtSend ?? 'null')).toEqual([MULLUM]);
        expect(record()).toEqual([MULLUM]);
    });

    it('a community that can\'t be reached, refuses or never answers stays on the record (it may hold the token), and the caller hears of it', async () => {
        mem.async.set(ANCHOR, MULLUM);
        nodes(() => 'down');
        await expect(registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android')).rejects.toThrow();

        mem.async.set(ANCHOR, BYRON);
        nodes(() => 'refused');
        await expect(registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android')).rejects.toThrow();

        mem.async.set(ANCHOR, BELLINGEN);
        const sent = nodes(() => 'silent');
        const started = Date.now();
        await expect(registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android', 50)).rejects.toThrow();
        expect(Date.now() - started).toBeLessThan(2000);
        expect(sent[0].signal?.aborted).toBe(true);

        expect(record()).toEqual([MULLUM, BYRON, BELLINGEN]);
    });

    it('each community once, in the order the phone sent it the token; a phone set to no community sends and records nothing', async () => {
        const sent = nodes();

        expect(await registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android')).toBe(false);
        expect(sent).toHaveLength(0);
        expect(mem.async.has(PUSH_REGISTERED_AT_STORE_KEY)).toBe(false);

        for (const community of [MULLUM, BYRON, `${MULLUM}/`]) {
            mem.async.set(ANCHOR, community);
            await registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android');
        }

        expect(sent.map((s) => s.url)).toEqual([MULLUM, BYRON, MULLUM].map((c) => `${c}/api/push-tokens`));
        expect(record()).toEqual([MULLUM, BYRON]);
    });

    it('a record that can\'t be read or written is left as it was, and the token still goes: the account\'s recovery alerts come first', async () => {
        mem.async.set(PUSH_REGISTERED_AT_STORE_KEY, JSON.stringify([MULLUM]));
        mem.async.set(ANCHOR, BYRON);
        const sent = nodes();
        const getItem = vi.mocked(AsyncStorage.getItem);
        const setItem = vi.mocked(AsyncStorage.setItem);
        const read = async (key: string) => mem.async.get(key) ?? null;
        const write = async (key: string, value: string) => { mem.async.set(key, value); };
        try {
            getItem.mockImplementation(async (key: string) => {
                if (key === PUSH_REGISTERED_AT_STORE_KEY) throw new Error('storage busy');
                return read(key);
            });
            expect(await registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android')).toBe(true);
            getItem.mockImplementation(read);

            setItem.mockImplementation(async () => { throw new Error('storage full'); });
            expect(await registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android')).toBe(true);
        } finally {
            getItem.mockImplementation(read);
            setItem.mockImplementation(write);
        }

        expect(sent.map((s) => s.url)).toEqual([`${BYRON}/api/push-tokens`, `${BYRON}/api/push-tokens`]);
        expect(record()).toEqual([MULLUM]);
    });

    it('reads the record without writing it, junk and repeats dropped', async () => {
        mem.async.set(PUSH_REGISTERED_AT_STORE_KEY, JSON.stringify([MULLUM, 'not a url', null, `${MULLUM}/`, 7, BYRON]));
        expect(await pushRegisteredCommunities()).toEqual([MULLUM, BYRON]);

        mem.async.set(PUSH_REGISTERED_AT_STORE_KEY, '{not json');
        expect(await pushRegisteredCommunities()).toEqual([]);
        expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    });
});

describe('an account leaving the phone, after it registered', () => {
    it('Sign Out asks exactly the communities the token went to, and a saved one that never had it is never sent it', async () => {
        // Kim's phone: Mullum and Bellingen saved, Byron visited as a guest. The app was opened while set to Mullum and
        // while set to Byron, never while set to Bellingen.
        await importIdentity(kim);
        mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: MULLUM }, { url: BELLINGEN }]));
        mem.async.set(GUESTS, JSON.stringify([BYRON]));
        mem.secure.set(PUSH_TOKEN_STORE_KEY, PHONE_TOKEN);
        const sent = nodes();
        for (const community of [MULLUM, BYRON, MULLUM]) {
            mem.async.set(ANCHOR, community);
            await registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android');
        }

        await signOutOfThisPhone(kim);

        const deletes = sent.filter((s) => s.method === 'DELETE');
        expect(deletes.map((s) => s.url).sort()).toEqual([BYRON, MULLUM].map((c) => `${c}/api/push-tokens`));
        for (const req of deletes) {
            expect(JSON.parse(req.body)).toEqual({ publicKey: kim.publicKey, token: PHONE_TOKEN });
            expect(await signedBy(req, kim)).toBe(true);
        }
        // Bellingen was never sent the token, on the way in or on the way out.
        expect(sent.some((s) => s.url.startsWith(BELLINGEN))).toBe(false);
        expect(mem.async.has(PUSH_REGISTERED_AT_STORE_KEY)).toBe(false);
    });
});
