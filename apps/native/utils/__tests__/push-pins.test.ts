/**
 * The key each community signs its notices with is kept under its own store key (utils/push-pins.ts), not on the
 * community's saved record, so nodes.ts's writers of the saved list (addSavedNode on every database open,
 * removeSavedNode, recordRequestSigning) can never overwrite a pin, nor a pin write bring back a community the member
 * forgot. The phone's storage here takes the same few milliseconds for every call and applies a write as it resolves,
 * as AsyncStorage does, so two read-modify-writes that overlap really do.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
const mem = vi.hoisted(() => ({ store: new Map<string, string>(), delayMs: 0 }));
vi.mock('@react-native-async-storage/async-storage', () => {
    const later = <T>(fn: () => T) => new Promise<T>((resolve) => setTimeout(() => resolve(fn()), mem.delayMs));
    return {
        default: {
            getItem: vi.fn((key: string) => later(() => mem.store.get(key) ?? null)),
            setItem: vi.fn((key: string, value: string) => later(() => { mem.store.set(key, value); })),
            removeItem: vi.fn((key: string) => later(() => { mem.store.delete(key); })),
        },
    };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import { pushCommunityTag } from '@beanpool/core';
import { addSavedNode, removeSavedNode } from '../nodes';
import { pinPushKey, readPushPins } from '../push-pins';
import { PUSH_PINS_STORE_KEY, PUSH_REGISTERED_AT_STORE_KEY, SAVED_NODES_STORE_KEY } from '../storage-keys';

const MULLUM = 'https://mullum.beanpool.org';
const BYRON = 'https://byron.example.net';
const OLDTOWN = 'http://192.168.1.20:8080';
const ANCHOR = 'beanpool_anchor_url';
const KEY_M = 'a1'.repeat(32);
const KEY_B = 'b2'.repeat(32);
const KEY_O = 'c3'.repeat(32);

const savedUrls = () => (JSON.parse(mem.store.get(SAVED_NODES_STORE_KEY) ?? '[]') as Array<{ url: string }>).map((n) => n.url);
const pinnedAt = async () => (await readPushPins(AsyncStorage)).pinned.map((p) => [p.community, p.pushKey]);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
    mem.store.clear();
    mem.delayMs = 0;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('pins are kept apart from the saved list', () => {
    it('a pin is written under its own key, address → key, and the saved list is not touched', async () => {
        mem.store.set(ANCHOR, MULLUM);
        const list = JSON.stringify([{ url: MULLUM, alias: 'Mullum' }, { url: BYRON }]);
        mem.store.set(SAVED_NODES_STORE_KEY, list);
        await pinPushKey(MULLUM, KEY_M, AsyncStorage);
        await pinPushKey(`${BYRON}/`, KEY_B, AsyncStorage);
        expect(JSON.parse(mem.store.get(PUSH_PINS_STORE_KEY)!)).toEqual({ [MULLUM]: KEY_M, [BYRON]: KEY_B });
        expect(mem.store.get(SAVED_NODES_STORE_KEY)).toBe(list);
        expect(await pinnedAt()).toEqual([[MULLUM, KEY_M], [BYRON, KEY_B]]);
        expect((await readPushPins(AsyncStorage)).pinned[0].tag).toBe(pushCommunityTag(KEY_M));
    });

    it('the community the phone is set to is pinned with no saved record at all', async () => {
        mem.store.set(ANCHOR, `${MULLUM}/`);
        await pinPushKey(MULLUM, KEY_M, AsyncStorage);
        expect(mem.store.has(SAVED_NODES_STORE_KEY)).toBe(false);
        expect(await pinnedAt()).toEqual([[MULLUM, KEY_M]]);
    });

    it('nothing is pinned for an address the phone doesn\'t keep, and an answer with no key takes the pin off', async () => {
        mem.store.set(ANCHOR, MULLUM);
        await pinPushKey(BYRON, KEY_B, AsyncStorage);
        expect(await pinnedAt()).toEqual([]);
        await pinPushKey(MULLUM, KEY_M, AsyncStorage);
        await pinPushKey(MULLUM, null, AsyncStorage);
        expect(await pinnedAt()).toEqual([]);
        expect(JSON.parse(mem.store.get(PUSH_PINS_STORE_KEY)!)).toEqual({});
    });

    it('a forgotten community has no pin: read only for what the phone keeps, and dropped at the next pin write', async () => {
        mem.store.set(ANCHOR, MULLUM);
        mem.store.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: MULLUM }, { url: BYRON }]));
        await pinPushKey(BYRON, KEY_B, AsyncStorage);
        await removeSavedNode(BYRON);
        expect(await pinnedAt()).toEqual([]);
        await pinPushKey(MULLUM, KEY_M, AsyncStorage);
        expect(JSON.parse(mem.store.get(PUSH_PINS_STORE_KEY)!)).toEqual({ [MULLUM]: KEY_M });
    });

    it('a pin store that isn\'t what this module writes is read as no pins: nothing in a bad shape is trusted', async () => {
        mem.store.set(ANCHOR, MULLUM);
        for (const raw of ['nonsense', '[]', JSON.stringify({ [MULLUM]: KEY_M.toUpperCase() }), JSON.stringify({ [MULLUM]: 42 })]) {
            mem.store.set(PUSH_PINS_STORE_KEY, raw);
            expect(await pinnedAt()).toEqual([]);
        }
    });
});

describe('the reviewer\'s two races: every storage call takes 5 ms and a write lands as it resolves', () => {
    beforeEach(() => {
        mem.delayMs = 5;
    });

    it('a pin written as the database opens (addSavedNode) is not lost', async () => {
        mem.store.set(ANCHOR, MULLUM);
        mem.store.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: MULLUM, alias: 'Mullum' }]));
        await Promise.all([pinPushKey(MULLUM, KEY_M, AsyncStorage), addSavedNode(MULLUM)]);
        expect(await pinnedAt()).toEqual([[MULLUM, KEY_M]]);
    });

    it('a community forgotten as a pin is written stays forgotten, and has no pin', async () => {
        mem.store.set(ANCHOR, MULLUM);
        mem.store.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: MULLUM }, { url: BYRON }]));
        mem.delayMs = 0;
        await pinPushKey(BYRON, KEY_B, AsyncStorage);
        mem.delayMs = 5;
        const forget = removeSavedNode(BYRON);
        await wait(6);
        await Promise.all([forget, pinPushKey(MULLUM, KEY_M, AsyncStorage)]);
        expect(savedUrls()).toEqual([MULLUM]);
        expect(await pinnedAt()).toEqual([[MULLUM, KEY_M]]);
    });

    it('many pin writes and saved-list writes at once: each pin lands, and the list keeps what nodes.ts wrote', async () => {
        mem.store.set(ANCHOR, MULLUM);
        mem.store.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: MULLUM }, { url: BYRON }, { url: OLDTOWN }]));
        await Promise.all([
            pinPushKey(MULLUM, KEY_M, AsyncStorage), addSavedNode(MULLUM, 'Mullum'),
            pinPushKey(BYRON, KEY_B, AsyncStorage), pinPushKey(OLDTOWN, KEY_O, AsyncStorage),
        ]);
        expect(await pinnedAt()).toEqual([[MULLUM, KEY_M], [BYRON, KEY_B], [OLDTOWN, KEY_O]]);
        expect(JSON.parse(mem.store.get(SAVED_NODES_STORE_KEY)!)[0]).toMatchObject({ url: MULLUM, alias: 'Mullum' });
    });
});

describe('pins this branch\'s earlier builds kept on saved records are moved once', () => {
    it('read from the saved records until the first pin write, which moves them; never read from there again', async () => {
        mem.store.set(ANCHOR, MULLUM);
        mem.store.set(SAVED_NODES_STORE_KEY, JSON.stringify([
            { url: MULLUM, pushKey: KEY_M }, { url: BYRON, pushKey: KEY_B }, { url: OLDTOWN, pushKey: 'not-a-key' },
        ]));
        mem.store.set(PUSH_REGISTERED_AT_STORE_KEY, JSON.stringify([MULLUM, BYRON, OLDTOWN]));
        expect(await pinnedAt()).toEqual([[MULLUM, KEY_M], [BYRON, KEY_B]]);
        expect((await readPushPins(AsyncStorage)).unpinnedRegistered).toEqual([OLDTOWN]);

        // The first write moves them: Oldtown's answer names its key.
        await pinPushKey(OLDTOWN, KEY_O, AsyncStorage);
        expect(JSON.parse(mem.store.get(PUSH_PINS_STORE_KEY)!)).toEqual({ [MULLUM]: KEY_M, [BYRON]: KEY_B, [OLDTOWN]: KEY_O });

        // Byron's next answer names none: its pin goes, and the old field on its saved record doesn't bring it back.
        await pinPushKey(BYRON, null, AsyncStorage);
        expect(await pinnedAt()).toEqual([[MULLUM, KEY_M], [OLDTOWN, KEY_O]]);
        expect((await readPushPins(AsyncStorage)).unpinnedRegistered).toEqual([BYRON]);
    });

    it('the move never writes the saved list (so it can\'t race nodes.ts either)', async () => {
        mem.store.set(ANCHOR, MULLUM);
        const list = JSON.stringify([{ url: MULLUM, pushKey: KEY_M }]);
        mem.store.set(SAVED_NODES_STORE_KEY, list);
        await pinPushKey(MULLUM, KEY_M, AsyncStorage);
        expect(mem.store.get(SAVED_NODES_STORE_KEY)).toBe(list);
        expect(JSON.parse(mem.store.get(PUSH_PINS_STORE_KEY)!)).toEqual({ [MULLUM]: KEY_M });
    });

    it('a phone with no pins anywhere reads none, and its first write starts the store', async () => {
        mem.store.set(ANCHOR, MULLUM);
        expect(await pinnedAt()).toEqual([]);
        await pinPushKey(MULLUM, null, AsyncStorage);
        expect(JSON.parse(mem.store.get(PUSH_PINS_STORE_KEY)!)).toEqual({});
    });
});
