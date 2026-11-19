/**
 * Message requests from every community the phone holds (Marty, 19 Nov 2026, "yes to all 5", decision 4 and slice S0 of
 * scratch/fable-design/DESIGN-no-switch-messaging-fable.md): the Message requests row counts what the phone's rounds already
 * heard from each other community (utils/requests-elsewhere.ts), global's door count folded in, a community with alerts off
 * left out; and Message on a contact in a held community moves the phone there and opens the chat with no question
 * (utils/message-after-switch.ts). Nothing here contacts a node, and nothing may.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => { (globalThis as any).__DEV__ = false; });
const mem = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async (k: string) => mem.get(k) ?? null,
        setItem: async (k: string, v: string) => { mem.set(k, v); },
        removeItem: async (k: string) => { mem.delete(k); },
    },
}));

import { requestsRowCount, requestsSeenNext, requestsUnseen } from '@beanpool/core';
import { elsewhereCounts, readHeldRequests, requestsElsewhere, type HeldRequestsRead } from '../requests-elsewhere';
import { noteServerUnread } from '../notice-counts';
import { messageInHeldCommunity, takeMessageAfterSwitch } from '../message-after-switch';
import { NOTICE_LANDING_MS, takeOpenAfterLanding } from '../member-landing';
import { openNoticeIn, type NoticeSwitchDeps } from '../push-notice-switch';
import { PUSH_ALERTS_OFF_STORE_KEY, SAVED_NODES_STORE_KEY } from '../storage-keys';
import { GLOBAL_NODE_URL } from '../global-node-url';

const HOME = 'https://riverside.example';
const HILL = 'https://hillside.example';
const VALE = 'https://valley.example';
const GLOBAL = GLOBAL_NODE_URL;
const ME = 'a'.repeat(64);
const DEE = 'd'.repeat(64);

const storage = {
    getItem: async (k: string) => mem.get(k) ?? null,
    setItem: async (k: string, v: string) => { mem.set(k, v); },
};

/** The phone keeps these, set to the first; `names` the ones it saved a name for. */
function keep(urls: string[], names: Record<string, string> = {}): void {
    mem.set('beanpool_anchor_url', urls[0]);
    mem.set(SAVED_NODES_STORE_KEY, JSON.stringify(urls.map((url) => ({ url, ...(names[url] ? { name: names[url] } : {}) }))));
}

const read = (p: Partial<HeldRequestsRead>): HeldRequestsRead => ({ counts: {}, saved: [], anchor: HOME, off: [], ...p });

beforeEach(() => {
    mem.clear();
});

describe('what the row counts from the phone\'s other communities', () => {
    it('is what each answered its last round, by address, 0 included, with the name the phone saved; null until read', async () => {
        keep([HOME, HILL, `${VALE}/`], { [HILL]: 'Hillside Neighbours' });
        await noteServerUnread(storage, HILL, 0, 0, 2);
        await noteServerUnread(storage, VALE, 4, 4, 0);
        const places = requestsElsewhere(await readHeldRequests(storage), null);
        expect(places).toEqual([
            { address: HILL, url: HILL, name: 'Hillside Neighbours', count: 2 },
            // The address it was saved under (a trailing slash) is the one the switch moves to.
            { address: VALE, url: `${VALE}/`, name: 'valley.example', count: 0 },
        ]);
        expect(elsewhereCounts(places)).toEqual({ [HILL]: 2, [VALE]: 0 });
        expect(requestsElsewhere(null, 3)).toBeNull();
        expect(elsewhereCounts(null)).toBeNull();
        // The row's count: unread messages there are not in it, the requests are.
        expect(requestsRowCount({ here: null, onGlobal: null, outside: [], guestInvites: [], elsewhere: elsewhereCounts(places) })).toBe(2);
    });

    it('leaves out a community whose alerts are off, at once', async () => {
        keep([HOME, HILL, VALE]);
        await noteServerUnread(storage, HILL, 0, 0, 2);
        await noteServerUnread(storage, VALE, 0, 0, 1);
        mem.set(PUSH_ALERTS_OFF_STORE_KEY, JSON.stringify([HILL]));
        expect(requestsElsewhere(await readHeldRequests(storage), null)?.map((p) => p.address)).toEqual([VALE]);
    });

    it('folds in global\'s door count: global\'s card, the larger where the rounds know global too', () => {
        // Global not kept by this phone (a door ticked here, nothing more): its own word for its name, its address to move to.
        expect(requestsElsewhere(read({}), 2)).toEqual([{ address: GLOBAL, url: GLOBAL, name: 'Global community', count: 2 }]);
        // Kept, and its round said 1 a while ago: the door's newer 3 stands; a round's 4 beside a door's 3 stands too.
        const kept = { saved: [{ url: `${GLOBAL}/`, name: 'The world' }] };
        expect(requestsElsewhere(read({ ...kept, counts: { [GLOBAL]: 1 } }), 3)).toEqual([{ address: GLOBAL, url: `${GLOBAL}/`, name: 'The world', count: 3 }]);
        expect(requestsElsewhere(read({ ...kept, counts: { [GLOBAL]: 4 } }), 3)?.[0].count).toBe(4);
    });

    it('takes nothing from a door count of 0 or not known: its 0 also means no door ticked here, which must not read as a fall', () => {
        for (const onGlobal of [0, null, undefined, -1, Number.NaN]) {
            expect(requestsElsewhere(read({}), onGlobal)).toEqual([]);
            expect(requestsElsewhere(read({ counts: { [GLOBAL]: 2 } }), onGlobal)?.[0].count).toBe(2);
        }
        // Seen 2 on global; a start where the door says 0 (no door here) before the round answers: no fall followed.
        const seen = requestsSeenNext({ here: null, onGlobal: null, outside: [], guestInvites: [], elsewhere: { [GLOBAL]: 2 } }, null, true)!;
        const before = elsewhereCounts(requestsElsewhere(read({}), 0));
        expect(requestsSeenNext({ here: null, onGlobal: null, outside: [], guestInvites: [], elsewhere: before }, seen, false)).toBeNull();
        expect(requestsUnseen({ here: null, onGlobal: null, outside: [], guestInvites: [], elsewhere: { [GLOBAL]: 2 } }, seen)).toBe(false);
    });

    it('takes no door count where global\'s alerts are off, or where global is the community in use', () => {
        expect(requestsElsewhere(read({ off: [`${GLOBAL}/`] }), 2)).toEqual([]);
        expect(requestsElsewhere(read({ anchor: GLOBAL }), 2)).toEqual([]);
    });
});

describe('a card\'s tap', () => {
    const switched: string[] = [];
    const deps = (over: Partial<NoticeSwitchDeps> = {}): NoticeSwitchDeps => ({
        storage,
        publicKey: ME,
        joinUnderWay: async () => false,
        switchUnderWay: () => false,
        switchTo: async (url, before) => { switched.push(url); await before(); },
        recheck: async () => 'member',
        ...over,
    });
    beforeEach(() => { switched.length = 0; });

    it('moves the phone to that community, even one it doesn\'t save (global\'s door count), and opens its Message requests there', async () => {
        keep([HOME]);
        expect(await openNoticeIn(GLOBAL, null, async () => '/(tabs)/chats?filter=requests', deps())).toBe('switched');
        expect(switched).toEqual([GLOBAL]);
        expect(takeOpenAfterLanding(ME, GLOBAL)).toBe('/(tabs)/chats?filter=requests');
    });
});

describe('Message on a contact in another community this phone holds', () => {
    const switched: string[] = [];
    const deps = (over: Partial<NoticeSwitchDeps> = {}): NoticeSwitchDeps => ({
        storage,
        publicKey: ME,
        joinUnderWay: async () => false,
        switchUnderWay: () => false,
        switchTo: async (url, before) => { switched.push(url); await before(); },
        recheck: async () => 'member',
        ...over,
    });
    beforeEach(() => {
        switched.length = 0;
        takeMessageAfterSwitch(ME, HILL, DEE, 0);
        takeOpenAfterLanding(ME, HILL);
        keep([HOME, `${HILL}/`]);
    });

    it('moves the phone there with no question, Contacts opens where it lands, and the chat with them opens there once', async () => {
        const T = 1_000_000;
        expect(await messageInHeldCommunity(DEE, HILL, deps(), T)).toBe('switched');
        // The one switch, to the address the phone saved it under.
        expect(switched).toEqual([`${HILL}/`]);
        expect(takeOpenAfterLanding(ME, HILL, T)).toBe(`/contacts?message=${DEE}`);
        // Contacts, landed in another community: nothing.
        expect(takeMessageAfterSwitch(ME, VALE, DEE, T + 1)).toBeNull();
        expect(takeMessageAfterSwitch(ME, HILL, DEE, T + 1)).toBe(DEE);
    });

    it('opens nothing for another account, for Contacts opened by hand, or for a link naming someone no tap left waiting', async () => {
        const T = 1_000_000;
        expect(takeMessageAfterSwitch(ME, HILL, DEE, T)).toBeNull();
        await messageInHeldCommunity(DEE, HILL, deps(), T);
        expect(takeMessageAfterSwitch(ME, HILL, null, T + 1)).toBeNull();
        expect(takeMessageAfterSwitch(ME, HILL, 'e'.repeat(64), T + 1)).toBeNull();
        expect(takeMessageAfterSwitch('b'.repeat(64), HILL, DEE, T + 1)).toBeNull();
        // Another account's ask drops the one waiting: it never opens for this one later either.
        expect(takeMessageAfterSwitch(ME, HILL, DEE, T + 2)).toBeNull();
    });

    it('opens the chat once, in that community only, however its address is spelled', async () => {
        const T = 1_000_000;
        await messageInHeldCommunity(DEE, HILL, deps(), T);
        expect(takeMessageAfterSwitch(ME, `${HILL}/`, DEE, T + 1)).toBe(DEE);
        expect(takeMessageAfterSwitch(ME, HILL, DEE, T + 2)).toBeNull();
    });

    it('opens nothing once the guard\'s time is out (the member was held elsewhere, then came to Contacts later)', async () => {
        const T = 1_000_000;
        await messageInHeldCommunity(DEE, HILL, deps(), T);
        expect(takeMessageAfterSwitch(ME, HILL, DEE, T + NOTICE_LANDING_MS)).toBeNull();
    });

    it('a join or a switch under way moves nothing and keeps nobody waiting; a switch that fails says so', async () => {
        const T = 1_000_000;
        expect(await messageInHeldCommunity(DEE, HILL, deps({ joinUnderWay: async () => true }), T)).toBe('held');
        expect(await messageInHeldCommunity(DEE, HILL, deps({ switchUnderWay: () => true }), T)).toBe('held');
        expect(await messageInHeldCommunity(DEE, HILL, deps({ switchTo: async () => { throw new Error('no'); } }), T)).toBe('failed');
        expect(switched).toEqual([]);
        expect(takeMessageAfterSwitch(ME, HILL, DEE, T + 1)).toBeNull();
    });

    it('where the guard won\'t let the member in there, Contacts is not opened', async () => {
        const T = 1_000_000;
        expect(await messageInHeldCommunity(DEE, HILL, deps({ recheck: async () => 'not-recognised' }), T)).toBe('switched');
        expect(takeOpenAfterLanding(ME, HILL, T)).toBeNull();
    });
});
