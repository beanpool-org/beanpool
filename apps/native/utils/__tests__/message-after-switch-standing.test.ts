// @vitest-environment jsdom
/**
 * Message after the phone moved to another community (#3360 review, F1 and F2): a switch may ask the community now in use
 * nothing of how the account stands there (Settings' Advanced switch, Reconnect), or ask it in the background (the one switch:
 * the BeanPool sheet's row, Contacts' Switch, Find's row, utils/recognition-afresh.ts), so Message asks at the tap, before it
 * opens or makes a chat across; and what a community last said is its own, so a late answer from the one left changes nothing
 * of the one in use.
 *
 * Every way into another community x what was heard of it before x how the account stands there now x the chat there. Real: the
 * app's own ask (NodeStatusContext.tsx), each switch (use-communities.ts, reconnect.ts, the move lock and the writes Settings
 * makes), Message (message-anyone.ts) down to the chat it makes, and the probe. In memory: the phone's storage, the database
 * module, the router, and each community's server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const who = vi.hoisted(() => ({ publicKey: 'e5'.repeat(32), privateKey: 'f0'.repeat(32), callsign: 'Me' }));
const ME = who.publicKey;
const K = 'a1'.repeat(32);
const RIVERSIDE = 'https://riverside.example';
const HILLSIDE = 'https://hillside.example';
const FARAWAY = 'https://faraway.example';

const phone = vi.hoisted(() => ({
    store: new Map<string, string>(),
    /** The across chats of each community's file. */
    files: new Map<string, Map<string, any>>(),
    toFront: null as null | (() => void),
    /** What was asked of a server how the account stands there, and each chat made, in order. */
    log: [] as string[],
}));
vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    Alert: { alert: vi.fn() },
    DeviceEventEmitter: { addListener: () => ({ remove() {} }), emit() {} },
    AppState: { addEventListener: (_event: string, fn: (next: string) => void) => { phone.toFront = () => fn('active'); return { remove() {} }; } },
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async (k: string) => phone.store.get(k) ?? null,
        setItem: async (k: string, v: string) => { phone.store.set(k, v); },
        removeItem: async (k: string) => { phone.store.delete(k); },
    },
}));
vi.mock('expo-router', () => ({ router: { canDismiss: () => true, dismissAll() {}, replace() {}, push() {} } }));
vi.mock('expo-crypto', async () => ({ randomUUID: (await import('node:crypto')).randomUUID, getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('../crypto', async (importOriginal) => ({ ...(await importOriginal<typeof import('../crypto')>()), buildSignedHeaders: async () => ({}) }));
vi.mock('../identity', () => ({ loadIdentity: async () => who }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: who }) }));
vi.mock('../../services/pillar-sync', () => ({ getLastSyncTime: async () => null }));
vi.mock('../blocklist', () => ({
    getBlockedUsers: async () => [], isUserBlocked: async () => false,
    readBlockLists: async () => ({ onPhone: new Set<string>(), once: new Set<string>(), seenThere: new Set<string>() }),
    blocksAtMember: async () => {}, communityKeepsNoBlocks: async () => {}, blocksOwedAt: async () => false, blockUser: async () => true, syncBlocksAt: async () => {},
}));
vi.mock('../db', () => {
    const file = (community: string) => {
        const key = community.replace(/\/+$/, '');
        if (!phone.files.has(key)) phone.files.set(key, new Map());
        return phone.files.get(key)!;
    };
    const storeOf = (community: string) => ({
        chats: async () => [...file(community).values()],
        openChat: async (_me: string, id: string, peer: { key: string; home: string; name: string | null }) => {
            phone.log.push(`made in ${community}`);
            file(community).set(id, { id, peerKey: peer.key, peerHome: peer.home, peerName: peer.name, state: 'open' });
        },
        getMeta: async () => null,
        setMeta: async () => {},
    });
    return {
        closeDB: async () => {}, initDB: async () => {}, clearDB: async () => {},
        getConversations: async () => [], getHeldConversations: async () => [], getHeldOutsideChats: async () => [],
        getMemberProfile: async () => null, isHeldMember: async () => false, closeHeldCopies: async () => {},
        outsideStore: storeOf, outsideStoreOf: storeOf,
    };
});

import { relayConversationId } from '@beanpool/core';
import { NodeStatusProvider, useNodeStatus } from '../../app/NodeStatusContext';
import { resetCommunityIndexForTests } from '../community-index';
import { whileCommunityMoves, writeCommunityAddress } from '../community-move-lock';
import { communitySwitched } from '../community-switch';
import * as db from '../db';
import { fetchMembership } from '../membership-probe';
import { messagePathOnPhone, openAcrossChat } from '../message-anyone';
import { switchPhoneTo } from '../reconnect';
import { resetStandingHereForTests, suspendedHere } from '../standing-here';
import { switchCommunity, useCommunities } from '../use-communities';

// ── each community's server ──────────────────────────────────────────────────────────────────────────────────────────
type Stands = 'member' | 'suspended' | 'no member' | 'closed' | 'no answer';
let stands: Record<string, Stands>;
/** A server whose next answer to the probe is held until it is let go: what it answers is how the account stood when asked. */
let holdNext: { at: string; until: Promise<void> } | null;
const MEMBERSHIP = '/api/community/membership/';
const answerOf = (how: Stands): Response => {
    if (how === 'closed') return new Response(JSON.stringify({ code: 'account_closed' }), { status: 403 });
    if (how === 'no member') return new Response(JSON.stringify({ isMember: false, isRecovering: false }), { status: 200 });
    return new Response(JSON.stringify({ isMember: true, callsign: 'Me', standing: how }), { status: 200 });
};
async function served(url: string): Promise<Response> {
    const { origin, pathname } = new URL(url);
    const how = stands[origin];
    if (!how || how === 'no answer') throw new Error('no answer');
    if (pathname.startsWith(MEMBERSHIP)) {
        phone.log.push(`asked ${origin}`);
        if (holdNext?.at === origin) {
            const { until } = holdNext;
            holdNext = null;
            await until;
        }
        return answerOf(how);
    }
    if (pathname === '/api/community/info') {
        return new Response(JSON.stringify({
            profile: 'local', features: { outsideMessages: true }, addresses: [new URL(origin).host], primaryAddress: new URL(origin).host, formerAddresses: [], formerExcludesLost: true,
        }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
}

// ── the app ──────────────────────────────────────────────────────────────────────────────────────────────────────────
let root: Root;
let sheetKey = 0;
let sheet: ReturnType<typeof useCommunities>;
let status: ReturnType<typeof useNodeStatus>;
function Status() {
    status = useNodeStatus();
    return null;
}
function Sheet() {
    sheet = useCommunities();
    return null;
}
const settled = () => act(async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); });
const inApp = (run: () => unknown): Promise<void> => act(async () => { await run(); });
/** The app on screen; with `openSheet`, the BeanPool sheet's list too, opened anew. */
function draw(openSheet = false): void {
    act(() => root.render(createElement(NodeStatusProvider, null, createElement(Status), openSheet ? createElement(Sheet, { key: ++sheetKey }) : null) as any));
}
async function launchedIn(community: string): Promise<void> {
    phone.store.set('beanpool_anchor_url', community);
    draw();
    await settled();
}

/** Each way a member moves the phone to another community it keeps. `asks`: the app then asks it how the account stands there. */
const WAYS: Array<{ way: string; asks: boolean; move: (to: string) => Promise<void> }> = [
    // The one switch asks the community now in use afresh before its bounce through Welcome (utils/recognition-afresh.ts), so the
    // root guard never holds a member on Welcome with the answer of the community left (27 Nov): it notes how the account stands.
    { way: 'the BeanPool sheet\'s row', asks: true, move: async (to) => {
        draw(true);
        await settled();
        await inApp(() => sheet.switchTo(to));
        draw();
    } },
    { way: 'Contacts\' Switch, and Find\'s row', asks: true, move: (to) => inApp(() => switchCommunity(to)) },
    { way: 'Settings\' Advanced switch', asks: false, move: (to) => inApp(async () => {
        // settings.tsx handleUpdateAnchor: the move, then its own probe, which reads only whether the account is a member.
        await whileCommunityMoves(async (held) => {
            await db.closeDB();
            await writeCommunityAddress(held, to);
            await db.initDB();
        });
        communitySwitched();
        await fetchMembership(to, who).then((r) => r.json()).catch(() => null);
    }) },
    { way: 'Reconnect, and the update screen\'s own switch', asks: false, move: (to) => inApp(() => switchPhoneTo(to)) },
    { way: 'a tapped notice', asks: true, move: (to) => inApp(() => switchCommunity(to, async () => { await status.recheck(); })) },
];
async function moved(way: (typeof WAYS)[number], to: string): Promise<void> {
    await way.move(to);
    await settled();
    expect(phone.store.get('beanpool_anchor_url')).toBe(to);
}

/** Message on a contact in a community the phone doesn't hold, as Contacts and New message do it. */
async function message(): Promise<string> {
    const held = [RIVERSIDE, HILLSIDE].filter((c) => c !== phone.store.get('beanpool_anchor_url'));
    const path = await messagePathOnPhone(ME, [{ community: FARAWAY, key: K, name: 'Ana' }], held);
    if (path.open === 'existing') return `existing ${path.chat.kind}`;
    if (path.open !== 'across') return path.open;
    const opened = await openAcrossChat(path);
    return 'chatId' in opened ? 'made' : 'here' in opened ? 'here' : opened.refused;
}
const ACROSS_ID = relayConversationId(ME, K);
const acrossIn = (community: string) => phone.files.set(community, new Map([[ACROSS_ID, { id: ACROSS_ID, peerKey: K, peerHome: 'faraway.example', peerName: 'Ana', state: 'open' }]]));
const chatsIn = (community: string) => [...(phone.files.get(community)?.values() ?? [])];
const madeAnywhere = () => phone.log.filter((l) => l.startsWith('made'));

beforeEach(() => {
    phone.store.clear(); phone.files.clear(); phone.log = []; phone.toFront = null;
    phone.store.set('beanpool_saved_nodes', JSON.stringify([{ url: RIVERSIDE, alias: 'Riverside' }, { url: HILLSIDE, alias: 'Hillside' }]));
    // As the phone last heard each: it takes messages from other communities.
    phone.store.set('beanpool_node_profiles', JSON.stringify(Object.fromEntries([RIVERSIDE, HILLSIDE].map((at) => [at, {
        profile: 'local', features: { outsideMessages: true }, checkedAt: '2026-11-22T00:00:00.000Z', addresses: [new URL(at).host], primaryAddress: new URL(at).host,
    }]))));
    stands = { [RIVERSIDE]: 'member', [HILLSIDE]: 'member' };
    holdNext = null;
    resetCommunityIndexForTests();
    resetStandingHereForTests();
    vi.stubGlobal('fetch', (url: string) => served(String(url)));
    root = createRoot(document.createElement('div'));
});
afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
});

describe.each(WAYS)('into another community by $way', (way) => {
    /**
     * `before`: what the app heard when it started in Hillside, before it left (null: it started in Riverside). `now`: how the
     * account stands in Hillside once the phone is there. `goes`: whether a line across goes from there.
     */
    const HEARD: Array<{ heard: string; before: Stands | null; now: Stands; goes: boolean }> = [
        { heard: 'never asked there; suspended', before: null, now: 'suspended', goes: false },
        { heard: 'never asked there; a member', before: null, now: 'member', goes: true },
        { heard: 'never asked there; no member', before: null, now: 'no member', goes: false },
        { heard: 'never asked there; closed', before: null, now: 'closed', goes: false },
        { heard: 'a member there earlier; suspended since', before: 'member', now: 'suspended', goes: false },
        { heard: 'a member there earlier, and still', before: 'member', now: 'member', goes: true },
        { heard: 'suspended there earlier, and still', before: 'suspended', now: 'suspended', goes: false },
        { heard: 'suspended there earlier; lifted since', before: 'suspended', now: 'member', goes: true },
        { heard: 'suspended there earlier; it doesn\'t answer now', before: 'suspended', now: 'no answer', goes: false },
        { heard: 'a member there earlier; it doesn\'t answer now', before: 'member', now: 'no answer', goes: true },
    ];
    it.each(HEARD.flatMap((h) => [false, true].map((chat) => ({ ...h, chat }))))('$heard, a chat across there already: $chat', async ({ before, now, goes, chat }) => {
        if (chat) acrossIn(HILLSIDE);
        if (before === null) {
            await launchedIn(RIVERSIDE);
        } else {
            stands[HILLSIDE] = before;
            await launchedIn(HILLSIDE);
            expect(phone.log).toEqual([`asked ${HILLSIDE}`]);
            await moved(way, RIVERSIDE);
        }
        stands[HILLSIDE] = now;
        await moved(way, HILLSIDE);
        const kept = JSON.stringify(chatsIn(HILLSIDE));
        phone.log = [];
        expect(await message()).toBe(!goes ? 'not-member' : chat ? 'existing across' : 'made');
        // The community in use is asked, and asked before anything is opened or made; refused, its file is as it was.
        if (now !== 'no answer') expect(phone.log[0]).toBe(`asked ${HILLSIDE}`);
        expect(madeAnywhere()).toEqual(goes && !chat ? [`made in ${HILLSIDE}`] : []);
        if (!goes || chat) expect(JSON.stringify(chatsIn(HILLSIDE))).toBe(kept);
        // The community left is asked nothing.
        expect(phone.log).not.toContain(`asked ${RIVERSIDE}`);
    });

    it('out of the one that suspended it: from the next one a line goes across', async () => {
        stands[HILLSIDE] = 'suspended';
        await launchedIn(HILLSIDE);
        expect(await message()).toBe('not-member');
        await moved(way, RIVERSIDE);
        expect(suspendedHere(ME, HILLSIDE)).toBe(true);
        expect(await message()).toBe('made');
        expect(madeAnywhere()).toEqual([`made in ${RIVERSIDE}`]);
    });

    it('what the app itself asks, so what the note alone would have had', async () => {
        await launchedIn(RIVERSIDE);
        stands[HILLSIDE] = 'suspended';
        await moved(way, HILLSIDE);
        expect(suspendedHere(ME, HILLSIDE)).toBe(way.asks);
    });

    it('moved between the two halves of a tap: the community the chat would be made in is the one asked', async () => {
        await launchedIn(RIVERSIDE);
        const path = await messagePathOnPhone(ME, [{ community: FARAWAY, key: K, name: 'Ana' }], [HILLSIDE]);
        stands[HILLSIDE] = 'suspended';
        await moved(way, HILLSIDE);
        expect(path.open === 'across' && await openAcrossChat(path)).toEqual({ refused: 'not-member' });
        expect(madeAnywhere()).toEqual([]);
    });
});

describe('a late answer from the community left', () => {
    /** To the front in Riverside, its answer held (it says how the account stands as `left`); then into Hillside, which says `inUse`, by a tapped notice. */
    async function leftWithAnAskOut(left: Stands, inUse: Stands): Promise<() => Promise<void>> {
        await launchedIn(RIVERSIDE);
        let go = () => {};
        stands[RIVERSIDE] = left;
        holdNext = { at: RIVERSIDE, until: new Promise<void>((r) => { go = r; }) };
        await inApp(() => phone.toFront!());
        await settled();
        stands[HILLSIDE] = inUse;
        await moved(WAYS.find((w) => w.asks)!, HILLSIDE);
        return async () => { go(); await settled(); };
    }

    it.each([
        { left: 'member', inUse: 'suspended' }, { left: 'suspended', inUse: 'suspended' }, { left: 'closed', inUse: 'suspended' }, { left: 'no member', inUse: 'suspended' },
        { left: 'member', inUse: 'member' }, { left: 'suspended', inUse: 'member' },
    ] as Array<{ left: Stands; inUse: Stands }>)('$left there, $inUse in the one in use: each has its own', async ({ left, inUse }) => {
        const lands = await leftWithAnAskOut(left, inUse);
        expect(suspendedHere(ME, HILLSIDE)).toBe(inUse === 'suspended');
        await lands();
        expect(suspendedHere(ME, HILLSIDE)).toBe(inUse === 'suspended');
        expect(suspendedHere(ME, RIVERSIDE)).toBe(left === 'suspended');
        // The one in use doesn't answer the tap: what it last said stands.
        stands[HILLSIDE] = 'no answer';
        expect(await message()).toBe(inUse === 'suspended' ? 'not-member' : 'made');
        expect(madeAnywhere()).toEqual(inUse === 'suspended' ? [] : [`made in ${HILLSIDE}`]);
    });

    it('its answer to a tap there, come after the phone moved: noted as its own, and the one in use is asked', async () => {
        acrossIn(RIVERSIDE);
        await launchedIn(RIVERSIDE);
        let go = () => {};
        stands[RIVERSIDE] = 'member';
        holdNext = { at: RIVERSIDE, until: new Promise<void>((r) => { go = r; }) };
        phone.log = [];
        const tap = message();
        await vi.waitFor(() => expect(phone.log).toEqual([`asked ${RIVERSIDE}`]));
        stands[HILLSIDE] = 'suspended';
        await moved(WAYS.find((w) => w.asks)!, HILLSIDE);
        go();
        expect(await tap).toBe('existing across');
        expect(suspendedHere(ME, HILLSIDE)).toBe(true);
        expect(await message()).toBe('not-member');
        expect(madeAnywhere()).toEqual([]);
    });
});
