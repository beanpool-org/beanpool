/**
 * A 12-word restore goes through the same gate as a sign-in restore (utils/restore-account.ts): onto a phone that holds
 * another account it asks first, and Cancel keeps the key, its onboarding record and its community. Onto a phone with
 * no account, or with this same account, it restores as it always did.
 *
 * Replace takes the old account's app storage with it (its guest markers, the communities it asked to join, its sync
 * cursors), as the screen said it would, and a replace this phone then can't save leaves neither account (#1179
 * review 4109902595).
 *
 * Nothing here contacts a node: the node's name for the key is a stub.
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
// A replace takes the old account's cached community copies (community-cache.ts): recorded, never the database.
vi.mock('../community-cache', () => ({ removeCommunityCaches: vi.fn(async () => {}) }));

import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { restoreFromWords, ReplaceNotSaved } from '../restore-account';
import { draftIdentity, importIdentity, loadIdentity, type BeanPoolIdentity } from '../identity';
import { KNOCKS_STORE_KEY, PUSH_REGISTERED_AT_STORE_KEY, PUSH_TOKEN_STORE_KEY, SAVED_NODES_STORE_KEY } from '../storage-keys';
import { decodeBase64, encodeUtf8, hexToBytes, mnemonicToKeypair, verifyData } from '../crypto';
import { getPendingOnboarding, setPendingOnboarding } from '../onboarding-state';
import { removeCommunityCaches } from '../community-cache';

// Test phrase only (a BIP-39 vector), never a real account's.
const WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow'.split(' ');
const NODE = 'https://test.beanpool.org';
const MULLUM = 'https://mullum.beanpool.org';
const BELLINGEN = 'https://bellingen.beanpool.org';
const ANCHOR = 'beanpool_anchor_url';
const INVITE_RECORD = { step: 'profileSetup' as const, inviteCode: 'INV-ABC', anchorUrl: MULLUM, callsign: 'Kim', redeemed: true };
/** What stays through any restore: a setting about the phone, not the member. */
const PHONE_KEPT = { beanpool_light_palette: 'sand' };

/**
 * The app storage an account leaves on the phone: its guest markers, the communities it asked, its sync cursors, its
 * profile (photo, bio, contact) with a photo parked for the next sync, the invite codes it made, an unfinished post,
 * the reports it has yet to send, the communities it saved (the switcher's list, which Sign Out removed and
 * Replace kept until #1183's review 5324593567), and where the phone sent its push token for it.
 */
function accountStorage(publicKey: string): Record<string, string> {
    return {
        beanpool_saved_nodes: JSON.stringify([{ url: MULLUM, name: 'Mullum' }]),
        beanpool_guest_nodes: JSON.stringify(['https://byron.beanpool.org']),
        beanpool_canonical_profile: JSON.stringify({ avatar: 'bundled://koala', bio: 'Grows tomatoes', contactValue: '0400 000 000' }),
        pending_profile_avatar: 'bundled://koala',
        pending_profile_sync: 'true',
        [`bp_offline_invites_${publicKey}`]: JSON.stringify([{ code: 'INV-ABC', intendedFor: 'Robin' }]),
        beanpool_offer_draft: JSON.stringify({ anchorUrl: MULLUM, postTitle: 'Tomatoes', postPhotos: ['bundled://koala'], postLat: -28.55, postLng: 153.5 }),
        beanpool_pending_abuse_reports: JSON.stringify([
            { reporterPubkey: publicKey, targetPubkey: 'cd'.repeat(32), reason: 'User Blocked by Member', timestamp: Date.parse('2026-09-25T00:00:00.000Z') },
        ]),
        [KNOCKS_STORE_KEY]: JSON.stringify({
            pubkey: publicKey,
            knocks: [{ url: 'https://near.example', name: 'Near Home', key: 'k1', sentAt: '2026-09-20T00:00:00.000Z' }],
        }),
        'pillar_sync_beanpool_https___mullum_beanpool_org.db_last-sync': '2026-09-25T00:00:00.000Z',
        'pillar:outbox': '[]',
        // Where the phone sent its push token for this account: Mullum, and Bellingen, which it later dropped from the
        // switcher. Never Byron, where it was only a guest (push-registrations.ts).
        [PUSH_REGISTERED_AT_STORE_KEY]: JSON.stringify([MULLUM, BELLINGEN]),
    };
}

function asyncStorage(): Record<string, string> {
    return Object.fromEntries(mem.async);
}

let phone: BeanPoolIdentity;
let restoredPub: string;
const quietError = console.error;

beforeEach(async () => {
    mem.async.clear();
    mem.secure.clear();
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No node may be contacted from a test'); }));
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        if (typeof args[0] === 'string' && args[0].startsWith('Failed to migrate legacy identity')) return;
        quietError(...args);
    });
    restoredPub = (await mnemonicToKeypair(WORDS)).publicKeyHex;
    phone = await draftIdentity('Kim');
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

async function phoneWithInviteJoin() {
    await importIdentity(phone);
    await setPendingOnboarding(INVITE_RECORD);
    mem.async.set(ANCHOR, MULLUM);
    for (const [k, v] of Object.entries({ ...accountStorage(phone.publicKey), ...PHONE_KEPT })) mem.async.set(k, v);
}

async function expectPhoneKept() {
    expect(await loadIdentity()).toEqual(phone);
    expect(await getPendingOnboarding()).toEqual(INVITE_RECORD);
    expect(mem.async.get(ANCHOR)).toBe(MULLUM);
    expect(asyncStorage()).toMatchObject({ ...accountStorage(phone.publicKey), ...PHONE_KEPT });
}

describe('a 12-word restore onto a phone that holds another account', () => {
    it('asks first, with the account that would go, and Cancel keeps everything (the node is not even asked for a name)', async () => {
        await phoneWithInviteJoin();
        const confirmReplace = vi.fn(async (_outgoing: BeanPoolIdentity) => false);
        const nameOnNode = vi.fn(async () => 'Marty');

        await expect(restoreFromWords(WORDS, NODE, { confirmReplace, nameOnNode })).rejects.toMatchObject({ reason: 'cancelled' });

        expect(confirmReplace).toHaveBeenCalledTimes(1);
        expect(confirmReplace.mock.calls[0][0]).toEqual(phone);
        expect(nameOnNode).not.toHaveBeenCalled();
        await expectPhoneKept();
    });

    it('Replace: the restored account under the node\'s name, the old wizard gone, the new community set', async () => {
        await phoneWithInviteJoin();
        const confirmReplace = vi.fn(async (_outgoing: BeanPoolIdentity) => {
            await expectPhoneKept();
            return true;
        });

        const restored = await restoreFromWords(WORDS, NODE, { confirmReplace, nameOnNode: async () => 'Marty' });

        expect(restored).toMatchObject({ publicKey: restoredPub, callsign: 'Marty', mnemonic: WORDS });
        expect(await loadIdentity()).toMatchObject({ publicKey: restoredPub, callsign: 'Marty', mnemonic: WORDS });
        expect(await getPendingOnboarding()).toBeNull();
        expect(mem.async.get(ANCHOR)).toBe(NODE);
    });

    it('Replace: nothing of the old account stays in app storage, only the new account\'s community and the phone\'s own', async () => {
        await phoneWithInviteJoin();

        await restoreFromWords(WORDS, NODE, { confirmReplace: async () => true, nameOnNode: async () => 'Marty' });

        // Kim's guest markers, the communities Kim asked to join, Kim's sync cursors, Kim's wizard: all gone.
        expect(asyncStorage()).toEqual({ [ANCHOR]: NODE, ...PHONE_KEPT });
        expect(await loadIdentity()).toMatchObject({ publicKey: restoredPub, callsign: 'Marty' });
    });

    it('a replace this phone can\'t save: Kim\'s account is gone as promised, no success is claimed, and trying again works', async () => {
        await phoneWithInviteJoin();
        const confirmReplace = vi.fn(async (_outgoing: BeanPoolIdentity) => true);
        // The key write fails: by then the new community's address has been written.
        vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error('Keystore unavailable'));

        const failed = restoreFromWords(WORDS, NODE, { confirmReplace, nameOnNode: async () => 'Marty' });

        await expect(failed).rejects.toBeInstanceOf(ReplaceNotSaved);
        await expect(failed).rejects.toThrow('Keystore unavailable');
        expect(await loadIdentity()).toBeNull();
        expect(await getPendingOnboarding()).toBeNull();
        expect(asyncStorage()).toEqual(PHONE_KEPT);

        // Again: nothing left to ask about, and the account comes back.
        const restored = await restoreFromWords(WORDS, NODE, { confirmReplace, nameOnNode: async () => 'Marty' });

        expect(confirmReplace).toHaveBeenCalledTimes(1);
        expect(restored).toMatchObject({ publicKey: restoredPub, callsign: 'Marty', mnemonic: WORDS });
        expect(await loadIdentity()).toMatchObject({ publicKey: restoredPub, callsign: 'Marty', mnemonic: WORDS });
        expect(asyncStorage()).toEqual({ [ANCHOR]: NODE, ...PHONE_KEPT });
    });

    it('a replace whose community address can\'t be saved ends the same way: neither account, and nothing of Kim\'s', async () => {
        await phoneWithInviteJoin();
        vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('Disk full'));

        await expect(restoreFromWords(WORDS, NODE, { confirmReplace: async () => true, nameOnNode: async () => 'Marty' }))
            .rejects.toBeInstanceOf(ReplaceNotSaved);

        expect(await loadIdentity()).toBeNull();
        expect(await getPendingOnboarding()).toBeNull();
        expect(asyncStorage()).toEqual(PHONE_KEPT);
    });

    it('a replace that can\'t save, when even Kim\'s key can\'t be removed: still a ReplaceNotSaved, and trying again asks again', async () => {
        await phoneWithInviteJoin();
        const confirmReplace = vi.fn(async (_outgoing: BeanPoolIdentity) => true);
        vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error('Keystore unavailable'));
        vi.mocked(SecureStore.deleteItemAsync).mockRejectedValueOnce(new Error('Keystore locked'));

        const failed = restoreFromWords(WORDS, NODE, { confirmReplace, nameOnNode: async () => 'Marty' });

        // Kim's wizard record and app storage are gone either way. welcome.tsx lets go of the account it holds only on a
        // ReplaceNotSaved: anything else, and _layout.tsx routes Kim, with none of Kim's app storage, into the app.
        await expect(failed).rejects.toBeInstanceOf(ReplaceNotSaved);
        await expect(failed).rejects.toThrow('Keystore unavailable');
        expect(await loadIdentity()).toEqual(phone);
        expect(await getPendingOnboarding()).toBeNull();
        expect(asyncStorage()).toEqual(PHONE_KEPT);

        // Again: Kim's key is still on the phone, so the member is asked again, and a yes restores.
        const restored = await restoreFromWords(WORDS, NODE, { confirmReplace, nameOnNode: async () => 'Marty' });

        expect(confirmReplace).toHaveBeenCalledTimes(2);
        expect(restored).toMatchObject({ publicKey: restoredPub, callsign: 'Marty', mnemonic: WORDS });
        expect(await loadIdentity()).toMatchObject({ publicKey: restoredPub, callsign: 'Marty', mnemonic: WORDS });
        expect(asyncStorage()).toEqual({ [ANCHOR]: NODE, ...PHONE_KEPT });
    });

    it('a caller that cannot ask is refused rather than allowed to replace', async () => {
        await phoneWithInviteJoin();

        await expect(restoreFromWords(WORDS, NODE, { nameOnNode: async () => 'Marty' })).rejects.toThrow(/different BeanPool account/);

        await expectPhoneKept();
    });
});

describe('a 12-word restore with nothing to replace', () => {
    it('the same account (a phone that lost its words): nothing to ask, and the words come back', async () => {
        const keys = await mnemonicToKeypair(WORDS);
        await importIdentity({ publicKey: keys.publicKeyHex, privateKey: keys.privateKeyHex, callsign: 'Marty', createdAt: '2026-01-01T00:00:00.000Z' });
        const confirmReplace = vi.fn(async (_outgoing: BeanPoolIdentity) => false);

        const restored = await restoreFromWords(WORDS, NODE, { confirmReplace, nameOnNode: async () => 'Marty' });

        expect(confirmReplace).not.toHaveBeenCalled();
        expect(restored.mnemonic).toEqual(WORDS);
        expect(await loadIdentity()).toMatchObject({ publicKey: restoredPub, mnemonic: WORDS });
    });

    it('the same account keeps what is its own: its guest markers, the communities it asked, its sync cursors', async () => {
        const keys = await mnemonicToKeypair(WORDS);
        await importIdentity({ publicKey: keys.publicKeyHex, privateKey: keys.privateKeyHex, callsign: 'Marty', createdAt: '2026-01-01T00:00:00.000Z' });
        for (const [k, v] of Object.entries({ [ANCHOR]: MULLUM, ...accountStorage(keys.publicKeyHex), ...PHONE_KEPT })) mem.async.set(k, v);

        await restoreFromWords(WORDS, NODE, { nameOnNode: async () => 'Marty' });

        expect(asyncStorage()).toEqual({ ...accountStorage(keys.publicKeyHex), ...PHONE_KEPT, [ANCHOR]: NODE });
    });

    it('the same account, when this phone can\'t save it: its key stays, and it is not a ReplaceNotSaved', async () => {
        const keys = await mnemonicToKeypair(WORDS);
        const same: BeanPoolIdentity = { publicKey: keys.publicKeyHex, privateKey: keys.privateKeyHex, callsign: 'Marty', createdAt: '2026-01-01T00:00:00.000Z' };
        await importIdentity(same);
        for (const [k, v] of Object.entries(accountStorage(keys.publicKeyHex))) mem.async.set(k, v);
        vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error('Keystore unavailable'));

        const failed = restoreFromWords(WORDS, NODE, { nameOnNode: async () => 'Marty' });

        await expect(failed).rejects.toThrow('Keystore unavailable');
        await expect(failed).rejects.not.toBeInstanceOf(ReplaceNotSaved);
        expect(await loadIdentity()).toEqual(same);
        expect(asyncStorage()).toMatchObject(accountStorage(keys.publicKeyHex));
    });

    it('no account on the phone: restores as it always did, never asking; a node that can\'t say leaves the name empty', async () => {
        const confirmReplace = vi.fn(async (_outgoing: BeanPoolIdentity) => false);

        const restored = await restoreFromWords(WORDS, NODE, { confirmReplace, nameOnNode: async () => null });

        expect(confirmReplace).not.toHaveBeenCalled();
        expect(restored).toMatchObject({ publicKey: restoredPub, callsign: '', mnemonic: WORDS });
        expect(await loadIdentity()).toMatchObject({ publicKey: restoredPub, callsign: '' });
        expect(mem.async.get(ANCHOR)).toBe(NODE);
    });
});

// ── Replace takes the old account's push alerts and communities too (#1183 review 5324593567) ──────────────────────

const BYRON = 'https://byron.beanpool.org';
const PHONE_TOKEN = 'ExponentPushToken[kims-phone]';

interface Sent { url: string; method?: string; headers: Record<string, string>; body: string; keyOnPhone?: string }

/** Every community answers 'ok', or is 'down' (a network error). Records what each was sent and whose key was on the phone. */
function nodes(answer: (url: string) => 'ok' | 'down' = () => 'ok'): Sent[] {
    const sent: Sent[] = [];
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        sent.push({
            url, method: init?.method, headers: init?.headers as Record<string, string>, body: String(init?.body),
            keyOnPhone: (await loadIdentity())?.publicKey,
        });
        if (answer(url) === 'down') throw new TypeError('Network request failed');
        return new Response('{"success":true}', { status: 200 });
    });
    return sent;
}

/** A DELETE /api/push-tokens for the phone's token, signed by this key (the signature checked, not just the name). */
async function unregisters(req: Sent, publicKey: string): Promise<boolean> {
    const h = req.headers;
    const body = JSON.parse(req.body);
    const canonical = `DELETE\n/api/push-tokens\n${h['X-Timestamp']}\n${h['X-Nonce']}\n${req.body}`;
    return req.method === 'DELETE' && h['X-Public-Key'] === publicKey && body.publicKey === publicKey && body.token === PHONE_TOKEN
        && await verifyData(decodeBase64(h['X-Signature']), encodeUtf8(canonical), hexToBytes(publicKey));
}

describe('a 12-word Replace takes the old account\'s push alerts and communities', () => {
    it('Kim\'s push token is unregistered where the phone registered it, signed by Kim\'s key before the restored key is written', async () => {
        await phoneWithInviteJoin();
        mem.secure.set(PUSH_TOKEN_STORE_KEY, PHONE_TOKEN);
        const sent = nodes();

        await restoreFromWords(WORDS, NODE, { confirmReplace: async () => true, nameOnNode: async () => 'Marty' });

        // Mullum and Bellingen had the token. Never Byron, which never had it, and never the restored account's key.
        expect(sent.map((s) => s.url).sort()).toEqual([`${BELLINGEN}/api/push-tokens`, `${MULLUM}/api/push-tokens`]);
        expect(sent.some((s) => s.url.startsWith(BYRON))).toBe(false);
        for (const req of sent) {
            expect(await unregisters(req, phone.publicKey)).toBe(true);
            expect(req.keyOnPhone).toBe(phone.publicKey);
        }
        expect(mem.secure.has(PUSH_TOKEN_STORE_KEY)).toBe(false);
        expect(await loadIdentity()).toMatchObject({ publicKey: restoredPub });
    });

    it('Kim\'s saved communities and their cached copies go', async () => {
        await phoneWithInviteJoin();
        nodes();

        await restoreFromWords(WORDS, NODE, { confirmReplace: async () => true, nameOnNode: async () => 'Marty' });

        expect(mem.async.has(SAVED_NODES_STORE_KEY)).toBe(false);
        expect(removeCommunityCaches).toHaveBeenCalled();
        expect([...vi.mocked(removeCommunityCaches).mock.calls[0][0]].sort()).toEqual([BYRON, MULLUM]);
    });

    it('a community that can\'t be reached neither holds up nor fails the replace', async () => {
        await phoneWithInviteJoin();
        mem.secure.set(PUSH_TOKEN_STORE_KEY, PHONE_TOKEN);
        const sent = nodes(() => 'down');

        const restored = await restoreFromWords(WORDS, NODE, { confirmReplace: async () => true, nameOnNode: async () => 'Marty' });

        expect(sent).toHaveLength(2);
        expect(restored).toMatchObject({ publicKey: restoredPub, callsign: 'Marty' });
        expect(await loadIdentity()).toMatchObject({ publicKey: restoredPub });
        expect(asyncStorage()).toEqual({ [ANCHOR]: NODE, ...PHONE_KEPT });
    });

    it('Cancel: no community is asked, and the token, the saved communities and their copies stay', async () => {
        await phoneWithInviteJoin();
        mem.secure.set(PUSH_TOKEN_STORE_KEY, PHONE_TOKEN);
        nodes();

        await expect(restoreFromWords(WORDS, NODE, { confirmReplace: async () => false, nameOnNode: async () => 'Marty' }))
            .rejects.toMatchObject({ reason: 'cancelled' });

        expect(fetch).not.toHaveBeenCalled();
        expect(mem.secure.get(PUSH_TOKEN_STORE_KEY)).toBe(PHONE_TOKEN);
        expect(removeCommunityCaches).not.toHaveBeenCalled();
        await expectPhoneKept();
    });

    it('the same account: nothing is unregistered, and its saved communities and cached copies stay', async () => {
        const keys = await mnemonicToKeypair(WORDS);
        await importIdentity({ publicKey: keys.publicKeyHex, privateKey: keys.privateKeyHex, callsign: 'Marty', createdAt: '2026-01-01T00:00:00.000Z' });
        for (const [k, v] of Object.entries({ [ANCHOR]: MULLUM, ...accountStorage(keys.publicKeyHex) })) mem.async.set(k, v);
        mem.secure.set(PUSH_TOKEN_STORE_KEY, PHONE_TOKEN);
        nodes();

        await restoreFromWords(WORDS, NODE, { nameOnNode: async () => 'Marty' });

        expect(fetch).not.toHaveBeenCalled();
        expect(mem.secure.get(PUSH_TOKEN_STORE_KEY)).toBe(PHONE_TOKEN);
        expect(mem.async.get(SAVED_NODES_STORE_KEY)).toBe(accountStorage(keys.publicKeyHex).beanpool_saved_nodes);
        expect(removeCommunityCaches).not.toHaveBeenCalled();
    });

    it('onto an empty phone: nothing is unregistered or removed', async () => {
        mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: MULLUM }]));
        mem.secure.set(PUSH_TOKEN_STORE_KEY, PHONE_TOKEN);
        nodes();

        await restoreFromWords(WORDS, NODE, { nameOnNode: async () => 'Marty' });

        expect(fetch).not.toHaveBeenCalled();
        expect(mem.async.get(SAVED_NODES_STORE_KEY)).toBe(JSON.stringify([{ url: MULLUM }]));
        expect(removeCommunityCaches).not.toHaveBeenCalled();
    });
});
