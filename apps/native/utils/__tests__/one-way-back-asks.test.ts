// @vitest-environment jsdom
/**
 * The "one way back" card's asks of the community (components/OneWayBackCard.tsx, utils/one-way-back.ts), rendered for
 * real as one-way-back-card.test.ts renders it, on two phones the bounded asking (PR #1452 re-review, finding 3) didn't
 * hold for:
 *
 * 1. Storage that throws on every call (a full or broken AsyncStorage): the ask was never recorded, so every focus asked
 *    the node again. The ask is now kept in memory for the run as well (`askedThisRun`).
 * 2. Two refreshes that overlap (a focus and a re-render meeting): each decided to ask, and two requests went out. They
 *    now share one (`askOneWayBackStandingShared`).
 *
 * And Home's own answer carrying the community's word: the card uses it and asks nothing (a landing costs one request).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { randomBytes } from 'node:crypto';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const el = (tag: string) => ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
        createElement(tag, onPress ? { onClick: onPress } : null, children);
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'), TouchableOpacity: el('button'),
        StyleSheet: { create: (s: unknown) => s },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
        DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })), emit: vi.fn() },
    };
});
const focus = vi.hoisted(() => ({ run: null as null | (() => void) }));
vi.mock('expo-router', () => ({
    router: { push: vi.fn() },
    useFocusEffect: (cb: () => void) => {
        useEffect(() => { focus.run = cb; cb(); }, [cb]);
    },
}));
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) }));
const mem = vi.hoisted(() => ({ async: new Map<string, string>(), broken: false, anchor: '' }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => { if (mem.broken) throw new Error('storage is broken'); return mem.async.get(key) ?? null; }),
        setItem: vi.fn(async (key: string, value: string) => { if (mem.broken) throw new Error('storage is broken'); mem.async.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { mem.async.delete(key); }),
    },
}));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(async () => undefined), deleteItemAsync: vi.fn(async () => undefined),
}));
const who = vi.hoisted(() => ({ identity: null as any }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: who.identity }) }));
vi.mock('../db', () => ({ getMyPosts: vi.fn(async () => []) }));
vi.mock('../vault', () => ({ vaultCopyKnown: vi.fn(async () => false) }));
vi.mock('../node-post', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../node-post')>()),
    anchorUrl: vi.fn(async () => mem.anchor || null),
}));
vi.mock('../../components/LinkSignInSheet', () => ({ LinkSignInSheet: () => null }));

import { OneWayBackCard } from '../../components/OneWayBackCard';
import { ONE_WAY_BACK_TEXT, startOneWayBack } from '../one-way-back';
import * as oneWayBack from '../one-way-back';
import { draftIdentity } from '../identity';

const GLOBAL = 'https://global.beanpool.org';
const node = { asks: 0, slow: null as null | Promise<void> };

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(async () => {
    mem.async.clear();
    mem.broken = false;
    mem.anchor = GLOBAL;
    node.asks = 0;
    node.slow = null;
    (oneWayBack as { resetOneWayBackAsksForTests?: () => void }).resetOneWayBackAsksForTests?.();
    who.identity = await draftIdentity();
    globalThis.fetch = vi.fn(async (url: any) => {
        const u = new URL(String(url));
        if (u.pathname !== '/api/community/me') throw new TypeError(`unexpected ${u.href}`);
        node.asks++;
        if (node.slow) await node.slow;
        const ends = new Date(Date.now() + 168 * 3600_000).toISOString();
        return new Response(JSON.stringify({ probation: { rules: 'words', ageEndsAt: ends, endsWhen: { hours: 168, keptPosts: 3 } } }), { status: 200 });
    }) as any;
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-02T08:00:00Z') });
});

afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    vi.useRealTimers();
});

async function settle() {
    for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function render(props: Record<string, unknown> = {}) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(createElement(OneWayBackCard, { place: 'landing', ...props }) as unknown as Parameters<Root['render']>[0]); });
    await settle();
}

describe('storage that throws on every call: the ask is still remembered for the run', () => {
    it('ten focuses over twenty minutes ask the community once, not ten times', async () => {
        mem.broken = true;
        await render();
        expect(node.asks).toBe(1);
        for (let i = 0; i < 9; i++) {
            vi.setSystemTime(Date.now() + 2 * 60_000);
            await act(async () => { focus.run?.(); });
            await settle();
        }
        expect(node.asks).toBe(1);
        // After the 30 minutes the bound allows, one more.
        vi.setSystemTime(Date.now() + 30 * 60_000);
        await act(async () => { focus.run?.(); });
        await settle();
        expect(node.asks).toBe(2);
    });

    it('control: storage that works asks once as before', async () => {
        await render();
        for (let i = 0; i < 5; i++) {
            vi.setSystemTime(Date.now() + 2 * 60_000);
            await act(async () => { focus.run?.(); });
            await settle();
        }
        expect(node.asks).toBe(1);
    });
});

describe('two refreshes that overlap share one ask', () => {
    it('a focus while the first ask is still out: one request', async () => {
        let release!: () => void;
        node.slow = new Promise<void>(r => { release = r; });
        await startOneWayBack(who.identity.publicKey, GLOBAL);
        await render();
        expect(node.asks).toBe(1);
        // Another focus (and another) before the node has answered.
        await act(async () => { focus.run?.(); });
        await act(async () => { focus.run?.(); });
        await settle();
        release();
        await settle();
        expect(node.asks).toBe(1);
        expect(document.body.textContent).toContain(ONE_WAY_BACK_TEXT.body);
    });
});

describe('on Home: the community\'s word from Home\'s answer, and no ask of the card\'s own', () => {
    it('the answer says 12 words: the card is up, and the card asked nothing', async () => {
        const ups: boolean[] = [];
        await render({ homeWord: { url: GLOBAL, standing: { words: true, joinedAt: Date.now() - 3600_000 } }, onUp: (up: boolean) => ups.push(up) });
        expect(node.asks).toBe(0);
        expect(document.body.textContent).toContain(ONE_WAY_BACK_TEXT.body);
        expect(ups.at(-1)).toBe(true);
    });

    it('the answer says a sign-in was added (not 12 words): done, no card, nothing asked', async () => {
        await startOneWayBack(who.identity.publicKey, GLOBAL);
        await render({ homeWord: { url: GLOBAL, standing: { words: false, joinedAt: null } } });
        expect(node.asks).toBe(0);
        expect(document.body.textContent).not.toContain(ONE_WAY_BACK_TEXT.body);
    });

    it('a word about another community is not taken: the card asks the one it is about', async () => {
        await startOneWayBack(who.identity.publicKey, GLOBAL);
        mem.anchor = 'https://mullum.beanpool.org';
        await render({ homeWord: { url: 'https://mullum.beanpool.org', standing: { words: false, joinedAt: null } } });
        expect(node.asks).toBe(1);
        expect(document.body.textContent).toContain(ONE_WAY_BACK_TEXT.body);
    });

    it('put away on Home: the phone\'s record and the account\'s get the same moment', async () => {
        const dismissed: number[] = [];
        await render({ homeWord: { url: GLOBAL, standing: { words: true, joinedAt: Date.now() } }, onDismiss: (at: number) => dismissed.push(at) });
        const close = Array.from(document.querySelectorAll('button')).find(b => b.textContent === '✕')!;
        await act(async () => { close.click(); });
        await settle();
        expect(dismissed).toEqual([Date.now()]);
        const record = JSON.parse(mem.async.get(`beanpool_one_way_back:${who.identity.publicKey.toLowerCase()}`)!);
        expect(record.dismissedAt).toBe(dismissed[0]);
        expect(document.body.textContent).not.toContain(ONE_WAY_BACK_TEXT.body);
    });

    it('put away on another phone (the account\'s dismissal): not up here either', async () => {
        await startOneWayBack(who.identity.publicKey, GLOBAL);
        await render({ homeWord: { url: GLOBAL, standing: { words: true, joinedAt: Date.now() } }, accountDismissedAt: new Date(Date.now() - 60_000).toISOString() });
        expect(document.body.textContent).not.toContain(ONE_WAY_BACK_TEXT.body);
    });
});
