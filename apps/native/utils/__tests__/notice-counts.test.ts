/**
 * The numbers on the BeanPool sheet's community rows (utils/notice-counts.ts; Marty, 24 Oct: "at the very least the node
 * list should have little numbers if there are notifications on a node"): how many notices each community this phone
 * keeps sent the account since it was last open, counted on the phone from the notices it already holds, the way
 * services/push-notifications.ts counts them (push-notice-check.ts `verifiedNotice`, then `countNotice`).
 *
 * Notices here are signed as a community's server signs them (@beanpool/core's bytes for one recipient, the node key's
 * seed), and the phone's pins are set as push-pins.ts keeps them. Nothing here contacts a node, and nothing may.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import nodeCrypto from 'node:crypto';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(async () => null),
    setItemAsync: vi.fn(async () => {}),
    deleteItemAsync: vi.fn(async () => {}),
}));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) };
});

import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { isPushNoticeKind, PUSH_NOTICE_LIFETIME_SECONDS, pushCommunityTag, pushNoticeBytes, pushNoticeWords, type PushNoticeKind } from '@beanpool/core';
import { checkWhileOpen, followTap, verifiedNotice, type IncomingNotice } from '../push-notice-check';
import {
    clearActiveCount, countNotice, noticeCountFor, NOTICE_COUNTS_STORE_KEY, onNoticeCounts, readNoticeCounts, watchNoticeCounts,
} from '../notice-counts';
import { communitySwitched } from '../community-switch';
import { PUSH_PINS_STORE_KEY, SAVED_NODES_STORE_KEY } from '../storage-keys';

const MULLUM = 'https://mullum.beanpool.org';
const BYRON = 'https://byron.example.net';
const OLDTOWN = 'https://oldtown.example.org';
const ANCHOR = 'beanpool_anchor_url';

const mem = new Map<string, string>();
const storage = {
    getItem: async (key: string) => mem.get(key) ?? null,
    setItem: async (key: string, value: string) => { mem.set(key, value); },
};

type Account = { publicKey: string; privateKey: string };
function account(): Account {
    const seed = nodeCrypto.randomBytes(32);
    return { publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: seed.toString('hex') };
}

/** A community's server, as far as signing goes: its node key's seed, the key the phone pins, the tag its notices carry. */
class Community {
    readonly seed = nodeCrypto.randomBytes(32);
    readonly pushKey = bytesToHex(ed25519.getPublicKey(this.seed));
    readonly tag = pushCommunityTag(this.pushKey);
    constructor(readonly url: string) {}
    notice(recipient: string, opts: { kind?: PushNoticeKind; t?: number } = {}) {
        const fields = { c: this.tag, k: opts.kind ?? 'chat.message', i: nodeCrypto.randomBytes(16).toString('hex'), t: opts.t ?? Math.floor(Date.now() / 1000) };
        return { bp: 1, ...fields, s: bytesToHex(ed25519.sign(pushNoticeBytes(fields, recipient), this.seed)) };
    }
}

/** A push as the phone's push service delivers it, with its kind's fixed words. */
function push(data: unknown): IncomingNotice {
    const k = (data as { k?: unknown })?.k;
    const words = isPushNoticeKind(k) ? pushNoticeWords(k) : { title: 'BeanPool', body: 'Open BeanPool' };
    return { identifier: nodeCrypto.randomUUID(), remote: true, ...words, data };
}

let kim: Account;
let lee: Account;
let mullum: Community;
let byron: Community;
let oldtown: Community;

/** The phone keeps these communities, set to the first, each with its key pinned. */
function keep(...cs: Community[]): void {
    mem.set(ANCHOR, cs[0].url);
    mem.set(SAVED_NODES_STORE_KEY, JSON.stringify(cs.map((c) => ({ url: c.url, alias: new URL(c.url).hostname }))));
    mem.set(PUSH_PINS_STORE_KEY, JSON.stringify(Object.fromEntries(cs.map((c) => [c.url, c.pushKey]))));
}

/** A switch, as every writer of the phone's community makes one: the anchor, then the announcement. */
function switchTo(url: string): void {
    mem.set(ANCHOR, url);
    communitySwitched();
}

/** A notification reaching the phone, counted as services/push-notifications.ts counts it. */
async function receive(n: IncomingNotice, who: Account = kim): Promise<void> {
    const notice = await verifiedNotice(n, { storage, recipient: who.publicKey });
    if (notice) await countNotice(storage, notice.community, notice.id);
}

const counts = () => readNoticeCounts(storage);

let stopWatching: () => void = () => {};
beforeEach(() => {
    mem.clear();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No node may be contacted from a test'); }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    kim = account();
    lee = account();
    mullum = new Community(MULLUM);
    byron = new Community(BYRON);
    oldtown = new Community(OLDTOWN);
    keep(mullum, byron, oldtown);
});

afterEach(async () => {
    stopWatching();
    stopWatching = () => {};
    await counts();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('each community\'s number rises with the notices it sends, counted on the phone', () => {
    it('per community; the community in use never counts while it is open', async () => {
        await receive(push(byron.notice(kim.publicKey)));
        await receive(push(byron.notice(kim.publicKey, { kind: 'market.request' })));
        await receive(push(oldtown.notice(kim.publicKey)));
        await receive(push(mullum.notice(kim.publicKey)));
        await receive(push(mullum.notice(kim.publicKey)));
        expect(await counts()).toEqual({ [BYRON]: 2, [OLDTOWN]: 1 });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('each notice once, however many ways it reaches the phone (shown while open, waiting in the list, tapped, the app\'s own copy)', async () => {
        const data = byron.notice(kim.publicKey);
        await receive(push(data));
        await receive(push(data));
        await receive({ identifier: 'local', remote: false, title: 'x', body: 'y', data: { ...data, bpLocal: 1 } });
        // A tap counts it too (push-notice-switch.ts), by the same id.
        await countNotice(storage, BYRON, data.i);
        expect(await counts()).toEqual({ [BYRON]: 1 });
    });

    it('only a notice its own community signed for this account, in its time: never a forgery, another account\'s, an unsigned push, a stranger\'s, an old one', async () => {
        const forger = new Community(BYRON);
        const forged = forger.notice(kim.publicKey);
        await receive(push({ ...forged, c: byron.tag }));
        await receive(push(byron.notice(lee.publicKey)));
        await receive(push({ type: 'chat', screen: 'chat', title: 'Open now' }));
        await receive(push(new Community('https://stranger.example.com').notice(kim.publicKey)));
        await receive(push(byron.notice(kim.publicKey, { t: Math.floor(Date.now() / 1000) - PUSH_NOTICE_LIFETIME_SECONDS - 60 })));
        // Nor for a phone with no account on it.
        expect(await verifiedNotice(push(byron.notice(kim.publicKey)), { storage, recipient: null })).toBeNull();
        expect(await counts()).toEqual({});
    });

    it('counting notes nothing the checks read: a notice counted from the list still shows while open, and its tap still opens it', async () => {
        const data = byron.notice(kim.publicKey);
        await receive(push(data));
        expect(await checkWhileOpen(push(data), { storage, recipient: kim.publicKey })).toEqual({ kind: 'show' });
        const handed: string[] = [];
        const decision = await followTap(push(data), { storage, account: kim, openIn: async (c) => { handed.push(c); } }, () => {});
        expect(decision).toMatchObject({ kind: 'open', community: BYRON, active: false });
        expect(handed).toEqual([BYRON]);
    });

    it('a screen showing the numbers is told of each change, and only of a change', async () => {
        let told = 0;
        const stop = onNoticeCounts(() => { told++; });
        const data = byron.notice(kim.publicKey);
        await receive(push(data));
        await receive(push(data));
        await clearActiveCount(storage);
        stop();
        expect(told).toBe(1);
    });
});

describe('a community\'s number goes back to nothing as it becomes the one in use', () => {
    it('at every switch, and at start for the one the phone is set to', async () => {
        await receive(push(byron.notice(kim.publicKey)));
        await receive(push(byron.notice(kim.publicKey)));
        await receive(push(oldtown.notice(kim.publicKey)));
        // At start, set to Byron (the app was closed on it): it counts nothing.
        mem.set(ANCHOR, BYRON);
        stopWatching = watchNoticeCounts(storage);
        expect(await counts()).toEqual({ [OLDTOWN]: 1 });
        // Moving on from Byron, it shows nothing for the notices it had: they were read there.
        switchTo(MULLUM);
        expect(await counts()).toEqual({ [OLDTOWN]: 1 });
        switchTo(OLDTOWN);
        expect(await counts()).toEqual({});
        expect(JSON.parse(mem.get(NOTICE_COUNTS_STORE_KEY)!)[OLDTOWN].n).toBe(0);
    });

    it('the community in use\'s notices, still waiting in the phone\'s list, don\'t count once the member moves on; a new one does', async () => {
        stopWatching = watchNoticeCounts(storage);
        const waiting = mullum.notice(kim.publicKey);
        await receive(push(waiting));
        switchTo(BYRON);
        // The list is read again as the app comes back: the same notice is there.
        await receive(push(waiting));
        expect(await counts()).toEqual({});
        await receive(push(mullum.notice(kim.publicKey)));
        expect(await counts()).toEqual({ [MULLUM]: 1 });
    });

    it('a notice counted, then the switch to its community: the count and the clear land in that order, so nothing is left', async () => {
        stopWatching = watchNoticeCounts(storage);
        const data = byron.notice(kim.publicKey);
        const counting = countNotice(storage, BYRON, data.i);
        switchTo(BYRON);
        await counting;
        expect(await counts()).toEqual({});
        // Back on Mullum, the notice still in the list counts no more.
        switchTo(MULLUM);
        await receive(push(data));
        expect(await counts()).toEqual({});
    });
});

describe('the numbers are the phone\'s own, kept in its storage', () => {
    it('survive a restart, and a notice counted before it is not counted again after', async () => {
        const data = byron.notice(kim.publicKey);
        await receive(push(data));
        await receive(push(oldtown.notice(kim.publicKey)));
        vi.resetModules();
        const again = await import('../notice-counts');
        const check = await import('../push-notice-check');
        expect(await again.readNoticeCounts(storage)).toEqual({ [BYRON]: 1, [OLDTOWN]: 1 });
        const notice = await check.verifiedNotice(push(data), { storage, recipient: kim.publicKey });
        await again.countNotice(storage, notice!.community, notice!.id);
        expect(await again.readNoticeCounts(storage)).toEqual({ [BYRON]: 1, [OLDTOWN]: 1 });
    });

    it('a community the phone forgets takes its number with it', async () => {
        await receive(push(byron.notice(kim.publicKey)));
        await receive(push(oldtown.notice(kim.publicKey)));
        mem.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: MULLUM }, { url: OLDTOWN }]));
        expect(await counts()).toEqual({ [OLDTOWN]: 1 });
        await receive(push(oldtown.notice(kim.publicKey)));
        expect(Object.keys(JSON.parse(mem.get(NOTICE_COUNTS_STORE_KEY)!))).toEqual([OLDTOWN]);
    });

    it('numbers that can\'t be read are none, and counting starts again', async () => {
        mem.set(NOTICE_COUNTS_STORE_KEY, '{not json');
        expect(await counts()).toEqual({});
        await receive(push(byron.notice(kim.publicKey)));
        expect(await counts()).toEqual({ [BYRON]: 1 });
        mem.set(NOTICE_COUNTS_STORE_KEY, JSON.stringify({ [BYRON]: { n: -4, seen: 'x' }, 'not an address': { n: 3, seen: {} } }));
        expect(await counts()).toEqual({});
    });

    it('a row finds its number by its saved address, written with or without a trailing slash', async () => {
        await receive(push(byron.notice(kim.publicKey)));
        const read = await counts();
        expect(noticeCountFor(read, `${BYRON}/`)).toBe(1);
        expect(noticeCountFor(read, BYRON)).toBe(1);
        expect(noticeCountFor(read, MULLUM)).toBe(0);
        expect(noticeCountFor(read, 'not an address')).toBe(0);
    });
});
