/**
 * A member's Pulse sign-ins (the TikTok and Instagram tokens a connected channel keeps on the phone) are kept on this
 * phone only, and leave it with the account (utils/pulse-token-store.ts, utils/pulse-oauth.ts, utils/identity.ts).
 *
 * Found by FABLE-sec-native MEDIUM-2, 2026-10-01: each channel's token was written to secure storage with the default
 * setting, which an iPhone carries in an encrypted backup to a new phone, and nothing removed it when the account left.
 * After Sign Out or Replace the long-lived platform token stayed on the phone, and the next account there that landed
 * on the same channel read it straight back.
 *
 * - Written this-phone-only (WHEN_UNLOCKED_THIS_DEVICE_ONLY), and made afresh each time: an iPhone keeps an item's old
 *   setting on a write over it.
 * - Sign Out, the node-mismatch delete and Replace take every one off the phone; Disconnect takes its own.
 * - A token that can't be removed never holds up the account's leaving, and is tried again the next time.
 *
 * Secure storage and app storage are maps here; fetch refuses, so nothing contacts a node.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })) } }));
const mem = vi.hoisted(() => ({
    async: new Map<string, string>(),
    secure: new Map<string, string>(),
    /** The options each secure item was last written with. */
    secureOptions: new Map<string, unknown>(),
    /** Keys whose removal the keychain refuses. */
    stuck: new Set<string>(),
}));
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
    setItemAsync: vi.fn(async (key: string, value: string, options?: unknown) => {
        mem.secure.set(key, value);
        mem.secureOptions.set(key, options);
    }),
    deleteItemAsync: vi.fn(async (key: string) => {
        if (mem.stuck.has(key)) throw new Error('Keystore locked');
        mem.secure.delete(key);
        mem.secureOptions.delete(key);
    }),
}));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) };
});
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: vi.fn(), dismissAuthSession: vi.fn() }));
vi.mock('expo-linking', () => ({ addEventListener: vi.fn(() => ({ remove: vi.fn() })) }));
vi.mock('../db', () => ({ clearDB: vi.fn(async () => {}), closeDB: vi.fn(async () => {}) }));
vi.mock('../community-cache', () => ({ removeCommunityCaches: vi.fn(async () => {}) }));

import * as SecureStore from 'expo-secure-store';
import { deleteAccountFromThisPhone, signOutOfThisPhone } from '../account-leaves-phone';
import { draftIdentity, importIdentity, type BeanPoolIdentity } from '../identity';
import { deleteStoredOAuthToken, getStoredOAuthToken, saveStoredOAuthToken, type PulseOAuthToken } from '../pulse-oauth';
import { saveRestoredAccount } from '../restore-account';

const MULLUM = 'https://mullum.beanpool.org';
const LIST = 'pulse_oauth_channels';

function token(channelId: string, platform: PulseOAuthToken['platform'] = 'tiktok'): PulseOAuthToken {
    return {
        platform,
        channelId,
        accessToken: `access-${channelId}`,
        refreshToken: `refresh-${channelId}`,
        expiresAt: Date.now() + 86_400_000,
        refreshExpiresAt: Date.now() + 365 * 86_400_000,
        platformUsername: 'kims_pottery',
    };
}

/** Every Pulse item in secure storage: the tokens and their list. */
const pulseItems = () => [...mem.secure.keys()].filter((k) => k.startsWith('pulse_oauth_')).sort();

let kim: BeanPoolIdentity;
const quietError = console.error;

beforeEach(async () => {
    mem.async.clear();
    mem.secure.clear();
    mem.secureOptions.clear();
    mem.stuck.clear();
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No node may be contacted from a test'); }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // identity.ts reaches AsyncStorage and the database through `require`, which no vi.mock reaches: quietened, as in
    // account-leaves-phone.test.ts. The Pulse tokens go before that, on their own.
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        if (typeof args[0] === 'string'
            && (args[0].startsWith('Failed to migrate legacy identity') || args[0].startsWith('Failed to fully wipe native identity state')
                || args[0].startsWith('[Pulse] A channel token could not be removed'))) return;
        quietError(...args);
    });
    kim = await draftIdentity('Kim');
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/** Kim's phone: Kim's account, set to Mullum, with a TikTok channel and an Instagram channel connected. */
async function kimsPhoneWithPulse() {
    await importIdentity(kim);
    mem.async.set('beanpool_anchor_url', MULLUM);
    await saveStoredOAuthToken(token('chan_tiktok_1'));
    await saveStoredOAuthToken(token('chan_insta_2', 'instagram'));
    expect(await getStoredOAuthToken('chan_tiktok_1')).toMatchObject({ accessToken: 'access-chan_tiktok_1' });
}

describe('a channel\'s token is kept on this phone only', () => {
    it('written this-device-only, never with the default an iPhone backup carries to another phone', async () => {
        await kimsPhoneWithPulse();

        expect(mem.secureOptions.get('pulse_oauth_token_chan_tiktok_1')).toEqual({ keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
        expect(mem.secureOptions.get('pulse_oauth_token_chan_insta_2')).toEqual({ keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
        for (const [key, , options] of vi.mocked(SecureStore.setItemAsync).mock.calls) {
            if (key.startsWith('pulse_oauth_')) expect(options).toEqual({ keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
        }
    });

    it('made afresh on every write (a refresh too), since an iPhone keeps an item\'s old setting on a write over it', async () => {
        await kimsPhoneWithPulse();
        vi.mocked(SecureStore.deleteItemAsync).mockClear();
        vi.mocked(SecureStore.setItemAsync).mockClear();

        await saveStoredOAuthToken({ ...token('chan_tiktok_1'), accessToken: 'refreshed' });

        const removed = vi.mocked(SecureStore.deleteItemAsync).mock.calls.findIndex(([k]) => k === 'pulse_oauth_token_chan_tiktok_1');
        const written = vi.mocked(SecureStore.setItemAsync).mock.calls.findIndex(([k]) => k === 'pulse_oauth_token_chan_tiktok_1');
        expect(removed).toBeGreaterThan(-1);
        expect(vi.mocked(SecureStore.deleteItemAsync).mock.invocationCallOrder[removed])
            .toBeLessThan(vi.mocked(SecureStore.setItemAsync).mock.invocationCallOrder[written]);
        expect(await getStoredOAuthToken('chan_tiktok_1')).toMatchObject({ accessToken: 'refreshed' });
    });

    it('every key is one secure storage takes: letters, digits, dots, dashes and underscores, never a colon', async () => {
        await kimsPhoneWithPulse();
        for (const key of pulseItems()) expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
    });
});

describe('the tokens leave the phone with the account', () => {
    it('Sign Out takes every one, and the next account on the phone reads nothing for the same channel', async () => {
        await kimsPhoneWithPulse();

        await signOutOfThisPhone(kim);

        expect(pulseItems()).toEqual([]);
        await importIdentity(await draftIdentity('Robin'));
        expect(await getStoredOAuthToken('chan_tiktok_1')).toBeNull();
        expect(await getStoredOAuthToken('chan_insta_2')).toBeNull();
    });

    it('so does the node-mismatch delete', async () => {
        await kimsPhoneWithPulse();

        await deleteAccountFromThisPhone(kim);

        expect(pulseItems()).toEqual([]);
    });

    it('so does Replace, before the restored account is saved', async () => {
        await kimsPhoneWithPulse();
        const robin = await draftIdentity('Robin');

        await saveRestoredAccount({ identity: robin, replacesAnother: true }, MULLUM);

        expect(pulseItems()).toEqual([]);
        expect(await getStoredOAuthToken('chan_tiktok_1')).toBeNull();
    });

    it('restoring the same account onto its own phone keeps them', async () => {
        await kimsPhoneWithPulse();

        await saveRestoredAccount({ identity: kim, replacesAnother: false }, MULLUM);

        expect(pulseItems()).toEqual([LIST, 'pulse_oauth_token_chan_insta_2', 'pulse_oauth_token_chan_tiktok_1']);
    });

    it('Disconnect takes its own token and its place on the list; Sign Out then has the other to take', async () => {
        await kimsPhoneWithPulse();

        await deleteStoredOAuthToken('chan_tiktok_1');

        expect(pulseItems()).toEqual([LIST, 'pulse_oauth_token_chan_insta_2']);
        expect(JSON.parse(mem.secure.get(LIST)!)).toEqual(['chan_insta_2']);
        await signOutOfThisPhone(kim);
        expect(pulseItems()).toEqual([]);
    });

    it('a token the keychain won\'t remove never holds up Sign Out, and stays on the list for the next time', async () => {
        await kimsPhoneWithPulse();
        mem.stuck.add('pulse_oauth_token_chan_insta_2');

        await expect(signOutOfThisPhone(kim)).resolves.toBeUndefined();

        expect(pulseItems()).toEqual([LIST, 'pulse_oauth_token_chan_insta_2']);
        expect(JSON.parse(mem.secure.get(LIST)!)).toEqual(['chan_insta_2']);

        // The next account to leave the phone takes it, once the keychain answers.
        mem.stuck.clear();
        const robin = await draftIdentity('Robin');
        await importIdentity(robin);
        await signOutOfThisPhone(robin);
        expect(pulseItems()).toEqual([]);
    });

    it('a phone with no Pulse channel: the account leaves without secure storage being asked to remove anything of Pulse\'s', async () => {
        await importIdentity(kim);

        await signOutOfThisPhone(kim);

        const pulseRemovals = vi.mocked(SecureStore.deleteItemAsync).mock.calls.filter(([k]) => k.startsWith('pulse_oauth_'));
        expect(pulseRemovals).toEqual([]);
    });
});
