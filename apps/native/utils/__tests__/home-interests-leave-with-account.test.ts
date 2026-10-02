/**
 * What Home keeps of an account leaves the phone with it (PR #1483 review 4165383582).
 *
 * Found by the deciding review of H2: Home made the Market's For You stars (`bp_fav_categories`) the phone's copy of the
 * account's interests, but Sign Out and a replacing restore left them on the phone. The next account's first Home
 * landing took them for "stars from before Home" and sent them to its community as its own: on a real node, a new
 * person's row read the previous person's ["food"].
 *
 * - Sign Out (account-leaves-phone.ts `signOutOfThisPhone`) and Replace (restore-account.ts `saveRestoredAccount`) go
 *   through the one wipe (identity.ts `wipeIdentityScopedStorage`), which takes the stars with Home's other copies.
 * - The next account's first landing sends nothing of the last one's, and asks it what it is into.
 * - Of everything Home keeps for an account, only the one-time reveal and hint flags stay, each under its own account
 *   (storage-keys.ts): the same account restored here isn't welcomed twice, and no other account reads them.
 *
 * App and secure storage are maps; the one community is a stub that keeps each signer's own preferences row and refuses
 * anything else, so nothing is contacted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

vi.mock('react-native', () => ({ Platform: { OS: 'android' }, DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })), emit: vi.fn() } }));
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
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: vi.fn(), dismissAuthSession: vi.fn() }));
vi.mock('expo-linking', () => ({ addEventListener: vi.fn(() => ({ remove: vi.fn() })) }));
vi.mock('../db', () => ({ clearDB: vi.fn(async () => {}), closeDB: vi.fn(async () => {}) }));
vi.mock('../community-cache', () => ({ removeCommunityCaches: vi.fn(async () => {}) }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { signOutOfThisPhone } from '../account-leaves-phone';
import { draftIdentity, importIdentity, wipeIdentityScopedStorage, type BeanPoolIdentity } from '../identity';
import { saveRestoredAccount } from '../restore-account';
import {
    readHomeFromNode, readPhoneInterests, readPhoneLayout, readStoredHome, reconcileInterests, resetHomeStoreForTests, saveInterests,
    writePhoneLayout,
} from '../home-store';
import { cardsToAsk, type HomeAnswer } from '../home-cards';
import { homeHintStoreKey, homeRevealStoreKey } from '../storage-keys';
import { boundSignatureValid } from './server-signature-check';

const NODE = 'https://mullum.beanpool.org';

/** The community: each signer's own preferences row (routes/community.ts POST /api/members/preferences), and Home. */
const node = { rows: new Map<string, { interests?: string[] }>(), posts: [] as { signer: string; interests?: string[] }[] };

function answerFor(pk: string): HomeAnswer {
    return {
        generatedAt: new Date().toISOString(), profile: 'local', features: { beans: true, escrow: true, invites: true },
        me: { joinedAt: '2026-10-01T00:00:00.000Z', isKeeper: false, probation: null, interests: node.rows.get(pk)?.interests ?? [], area: null, firstOffer: false, standing: 'member' },
        layout: null,
        cards: { community: { name: 'Mullumbimby', members: 81, tradesThisMonth: 23 } },
    };
}

let zara: BeanPoolIdentity;
let yusuf: BeanPoolIdentity;
const signers = () => [zara, yusuf];

beforeEach(async () => {
    mem.async.clear();
    mem.secure.clear();
    node.rows.clear();
    node.posts = [];
    resetHomeStoreForTests();
    zara = await draftIdentity();
    yusuf = await draftIdentity();
    globalThis.fetch = vi.fn(async (input: any, init: any = {}) => {
        const url = String(input);
        const req = { url, method: init.method ?? 'GET', headers: { ...(init.headers ?? {}) } as Record<string, string>, body: typeof init.body === 'string' ? init.body : '' };
        const u = new URL(url);
        const signer = signers().find(s => boundSignatureValid(req, s.publicKey));
        if (u.origin !== NODE || !signer) throw new Error(`No other request may leave the test: ${req.method} ${url}`);
        if (u.pathname === '/api/home' && req.method === 'GET') {
            const a = answerFor(signer.publicKey);
            return new Response(JSON.stringify(a), { status: 200, headers: { ETag: `W/"home-${createHash('sha256').update(JSON.stringify(a.me)).digest('hex').slice(0, 12)}"` } });
        }
        if (u.pathname === '/api/members/preferences' && req.method === 'POST') {
            const { preferences } = JSON.parse(req.body);
            node.posts.push({ signer: signer.publicKey, interests: preferences.interests });
            if (preferences.interests) node.rows.set(signer.publicKey, { ...node.rows.get(signer.publicKey), interests: preferences.interests });
            return new Response(JSON.stringify({ success: true, ...preferences }), { status: 200 });
        }
        throw new Error(`No other request may leave the test: ${req.method} ${url}`);
    }) as any;
});

/** Zara uses Home: her answer, a layout, a star (saved to her row), the reveal and hint seen. */
async function zaraUsesHome() {
    await importIdentity(zara);
    mem.async.set('beanpool_anchor_url', NODE);
    await readHomeFromNode(NODE, zara, cardsToAsk(null), null);
    await writePhoneLayout(zara.publicKey, NODE, { v: 1, order: ['beans'], hidden: ['pulse'], dismissed: {}, updatedAt: '2026-10-02T09:00:00.000Z' });
    expect(await saveInterests(NODE, zara, ['food'])).toBe(true);
    expect(await reconcileInterests(NODE, zara, ['food'])).toEqual(['food']);
    mem.async.set(homeRevealStoreKey(zara.publicKey), '1');
    mem.async.set(homeHintStoreKey(zara.publicKey), '1');
    expect(node.rows.get(zara.publicKey)?.interests).toEqual(['food']);
}

/** Yusuf's first Home landing on this phone, as the screen makes it (app/(tabs)/index.tsx): read, then the interests made one. */
async function yusufLands(): Promise<string[]> {
    const read = await readHomeFromNode(NODE, yusuf, cardsToAsk(null), await readStoredHome(yusuf.publicKey, NODE));
    if (read.kind !== 'answer') throw new Error('no answer');
    return reconcileInterests(NODE, yusuf, read.stored.answer.me!.interests);
}

/**
 * Settings → Sign Out (Device Only). On a phone its last step also wipes the account's app storage (identity.ts
 * `wipeIdentity`), through a lazy `require` of AsyncStorage that can't load under vitest, so the wipe is finished here as
 * the phone does it (as blocklist-per-account.test.ts does).
 */
async function signOut(account: BeanPoolIdentity) {
    await signOutOfThisPhone(account);
    await wipeIdentityScopedStorage(AsyncStorage as never);
}

/** Everything Home keeps that is still on the phone. */
const homeKeys = () => [...mem.async.keys()].filter(k => k.startsWith('beanpool_home') || k === 'bp_fav_categories').sort();

describe('Sign Out', () => {
    it('takes the stars with the account: the next account\'s first landing sends none of them, and is asked what it is into', async () => {
        await zaraUsesHome();
        await signOut(zara);
        expect(mem.async.has('bp_fav_categories')).toBe(false);
        await importIdentity(yusuf);
        mem.async.set('beanpool_anchor_url', NODE);
        expect(await yusufLands()).toEqual([]);
        expect(node.posts.filter(p => p.signer === yusuf.publicKey)).toEqual([]);
        expect(node.rows.get(yusuf.publicKey)?.interests).toBeUndefined();
        expect(await readPhoneInterests()).toEqual([]);
    });

    it('of everything Home kept for the account, only its own reveal and hint flags stay; the next account reads nothing of it', async () => {
        await zaraUsesHome();
        await signOut(zara);
        expect(homeKeys()).toEqual([homeHintStoreKey(zara.publicKey), homeRevealStoreKey(zara.publicKey)].sort());
        expect(await readStoredHome(yusuf.publicKey, NODE)).toBeNull();
        expect(await readPhoneLayout(yusuf.publicKey, NODE)).toBeNull();
    });
});

describe('a restore that replaces the account on the phone', () => {
    it('takes the stars with the replaced account: the restored one\'s first landing sends none of them', async () => {
        await zaraUsesHome();
        await saveRestoredAccount({ identity: yusuf, replacesAnother: true }, NODE);
        expect(mem.async.has('bp_fav_categories')).toBe(false);
        expect(homeKeys()).toEqual([homeHintStoreKey(zara.publicKey), homeRevealStoreKey(zara.publicKey)].sort());
        expect(await yusufLands()).toEqual([]);
        expect(node.posts.filter(p => p.signer === yusuf.publicKey)).toEqual([]);
        expect(node.rows.get(yusuf.publicKey)?.interests).toBeUndefined();
    });

    it('restoring the same account keeps its stars, and its next landing agrees with its row without a save', async () => {
        await zaraUsesHome();
        const posts = node.posts.length;
        await saveRestoredAccount({ identity: zara, replacesAnother: false }, NODE);
        expect(await readPhoneInterests()).toEqual(['food']);
        expect(await reconcileInterests(NODE, zara, ['food'])).toEqual(['food']);
        expect(node.posts.length).toBe(posts);
    });
});
