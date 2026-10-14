// @vitest-environment jsdom
/**
 * The "one way back" card (components/OneWayBackCard.tsx), rendered for real: react-dom in jsdom, React Native's host
 * components as plain tags, the real utils/one-way-back.ts and node-post signing, and a stubbed global community whose
 * `GET /api/community/me` answers as routes/community.ts does. Every request is counted.
 *
 * PR #1452 re-review (03cd9d2a), findings 1-3:
 * 1. A sign-in added after "I still have my 12 words" (here or elsewhere) puts the offer away for good.
 * 2. Where the key vault keeps a copy of the key, the card never says "one way back"; adding a sign-in is still offered
 *    quietly in Settings (it lifts the 12-words limits).
 * 3. The asking is bounded: at most one ask per account every ONE_WAY_BACK_ASK_EVERY_MS, a guest's 403 and `ordinary`
 *    kept like any answer, a done record never asks, and a phone using another community never asks about a done one.
 *    The test prints requests per hour of Market use, a focus every 2 minutes.
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
    // The screen gains focus: mounted focused, and again whenever the test says so.
    useFocusEffect: (cb: () => void) => {
        useEffect(() => { focus.run = cb; cb(); }, [cb]);
    },
}));
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) }));
const mem = vi.hoisted(() => ({ async: new Map<string, string>(), vault: new Set<string>(), anchor: '' }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => mem.async.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { mem.async.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { mem.async.delete(key); }),
    },
}));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(async () => undefined), deleteItemAsync: vi.fn(async () => undefined),
}));
const who = vi.hoisted(() => ({ identity: null as any }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: who.identity }) }));
vi.mock('../db', () => ({ getMyPosts: vi.fn(async () => []) }));
vi.mock('../vault', () => ({ vaultCopyKnown: vi.fn(async (publicKey: string) => mem.vault.has(publicKey)) }));
vi.mock('../node-post', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../node-post')>()),
    anchorUrl: vi.fn(async () => mem.anchor || null),
}));
// The sheet as the real one ends a link: the record says linked, then onLinked.
vi.mock('../../components/LinkSignInSheet', () => ({
    LinkSignInSheet: ({ visible, identity, onLinked, onClose }: any) => visible
        ? createElement('button', {
            onClick: async () => {
                const { finishOneWayBack } = await import('../one-way-back');
                await finishOneWayBack(identity.publicKey, 'linked');
                node.rules = 'ordinary';
                onLinked({ kind: 'linked', provider: 'google', enrolment: null });
                onClose();
            },
        }, 'sheet: Done')
        : null,
}));

import { OneWayBackCard } from '../../components/OneWayBackCard';
import { ONE_WAY_BACK_TEXT, finishOneWayBack, readOneWayBack, startOneWayBack } from '../one-way-back';
import { draftIdentity } from '../identity';

const GLOBAL = 'https://global.beanpool.org';
const OTHER = 'https://mullum.beanpool.org';
const node = { rules: 'words' as 'words' | 'ordinary' | 'guest', asks: 0 };

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(async () => {
    mem.async.clear();
    mem.vault.clear();
    mem.anchor = GLOBAL;
    node.rules = 'words';
    node.asks = 0;
    who.identity = await draftIdentity();
    globalThis.fetch = vi.fn(async (url: any) => {
        const u = new URL(String(url));
        if (u.pathname !== '/api/community/me') throw new TypeError(`unexpected ${u.href}`);
        node.asks++;
        if (node.rules === 'guest') return new Response(JSON.stringify({ error: 'Read access requires a member identity' }), { status: 403 });
        const words = node.rules === 'words';
        const ends = new Date(Date.now() + (words ? 168 : 72) * 3600_000).toISOString();
        return new Response(JSON.stringify({ probation: { rules: node.rules, ageEndsAt: ends, endsWhen: { hours: words ? 168 : 72, keptPosts: 3 } } }), { status: 200 });
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
    for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function render(place: 'landing' | 'settings') {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(createElement(OneWayBackCard, { place }) as unknown as Parameters<Root['render']>[0]); });
    await settle();
}

const text = () => document.body.textContent ?? '';
const warning = () => text().includes(ONE_WAY_BACK_TEXT.body);
const quietOffer = () => text().includes('A sign-in can be a second way back');

function button(label: string): HTMLButtonElement {
    const found = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes(label));
    if (!found) throw new Error(`no button "${label}" in: ${text()}`);
    return found as HTMLButtonElement;
}

/** An hour of Market use: a focus every 2 minutes. The asks it made, all told (the first render included). */
async function anHourOfFocuses(): Promise<number> {
    for (let i = 0; i < 30; i++) {
        vi.setSystemTime(Date.now() + 2 * 60_000);
        await act(async () => { focus.run?.(); });
        await settle();
    }
    return node.asks;
}

describe('finding 1: a sign-in added after "I still have my 12 words" puts the offer away for good', () => {
    it('added from Settings\' quiet offer: gone, and the record says linked', async () => {
        await startOneWayBack(who.identity.publicKey, GLOBAL);
        await finishOneWayBack(who.identity.publicKey, 'checked');
        await render('settings');
        expect(quietOffer()).toBe(true);
        await act(async () => { button(ONE_WAY_BACK_TEXT.addSignIn).click(); });
        await act(async () => { button('sheet: Done').click(); });
        await settle();
        expect((await readOneWayBack(who.identity.publicKey))?.done).toBe('linked');
        expect(quietOffer()).toBe(false);
        // Another focus later changes nothing.
        vi.setSystemTime(Date.now() + 3 * 3600_000);
        await act(async () => { focus.run?.(); });
        await settle();
        expect(quietOffer()).toBe(false);
    });

    it('added elsewhere (the web, another phone): the node says ordinary, and the checked record becomes linked', async () => {
        await startOneWayBack(who.identity.publicKey, GLOBAL);
        await finishOneWayBack(who.identity.publicKey, 'checked');
        node.rules = 'ordinary';
        await render('settings');
        expect((await readOneWayBack(who.identity.publicKey))?.done).toBe('linked');
        expect(quietOffer()).toBe(false);
    });
});

describe('finding 2: the key vault keeps a copy: never "one way back"', () => {
    it('no record here, the node says words, the vault keeps a copy: no card on the Market, no record started', async () => {
        mem.vault.add(who.identity.publicKey);
        await render('landing');
        expect(warning()).toBe(false);
        expect(await readOneWayBack(who.identity.publicKey)).toBeNull();
    });

    it('a 12-words record, then Protect with on a vault build: the warning goes; Settings still offers a sign-in, quietly', async () => {
        await startOneWayBack(who.identity.publicKey, GLOBAL);
        mem.vault.add(who.identity.publicKey);
        await render('landing');
        expect(warning()).toBe(false);
        act(() => root?.unmount());
        await render('settings');
        expect(warning()).toBe(false);
        expect(quietOffer()).toBe(true);
    });

    it('control: no vault copy, the node says words: the warning card', async () => {
        await render('landing');
        expect(warning()).toBe(true);
    });
});

describe('finding 3: the asking is bounded (an hour of Market use, a focus every 2 minutes)', () => {
    const counts: Record<string, number> = {};
    afterEach(() => { console.log(`[one-way-back asks per hour] ${JSON.stringify(counts)}`); });

    it('a guest on global (403): its answer is kept like any other', async () => {
        node.rules = 'guest';
        await render('landing');
        counts.guest = await anHourOfFocuses();
        // Asked at 0, 30 and 60 minutes: once per half hour.
        expect(counts.guest).toBeLessThanOrEqual(3);
    });

    it('a sign-in member of global (ordinary): asked once, then a done record, and never again', async () => {
        node.rules = 'ordinary';
        await render('landing');
        counts.signInMember = await anHourOfFocuses();
        expect(counts.signInMember).toBe(1);
        expect((await readOneWayBack(who.identity.publicKey))?.done).toBe('linked');
    });

    it('a 12-words member with no sign-in yet: at most one ask per half hour', async () => {
        await startOneWayBack(who.identity.publicKey, GLOBAL);
        await render('landing');
        counts.wordsMember = await anHourOfFocuses();
        expect(counts.wordsMember).toBeLessThanOrEqual(3);
        expect(warning()).toBe(true);
    });

    it('a done record ("I still have my 12 words") on a phone using another community: never asks global', async () => {
        await startOneWayBack(who.identity.publicKey, GLOBAL);
        await finishOneWayBack(who.identity.publicKey, 'checked');
        mem.anchor = OTHER;
        await render('landing');
        counts.checkedElsewhere = await anHourOfFocuses();
        expect(counts.checkedElsewhere).toBe(0);
    });

    it('a linked record anywhere: never asks', async () => {
        await startOneWayBack(who.identity.publicKey, GLOBAL);
        await finishOneWayBack(who.identity.publicKey, 'linked');
        await render('settings');
        counts.linked = await anHourOfFocuses();
        expect(counts.linked).toBe(0);
    });

    it('kept across app starts: a new card (a restart) inside the half hour asks nothing', async () => {
        node.rules = 'guest';
        await render('landing');
        expect(node.asks).toBe(1);
        act(() => root?.unmount());
        vi.setSystemTime(Date.now() + 10 * 60_000);
        await render('landing');
        expect(node.asks).toBe(1);
    });
});
