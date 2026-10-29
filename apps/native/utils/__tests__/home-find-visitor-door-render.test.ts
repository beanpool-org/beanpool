// @vitest-environment jsdom
/**
 * The visitors' Home on the global node (its `find` card is one of VISITOR_CARDS, apps/server/src/routes/home-answer.ts)
 * with no key on the phone: Communities near you, or type your town, and Tell me when one starts here open the door
 * (utils/look-around.ts LOOK_DOOR), as the root guard sent them before slice S3. Since S3 a phone with no account may open
 * Find a community, to ask by an address, and there it shows neither the list, nor a town, nor a watch: these three taps,
 * left on Find, landed on a screen without what they said (PR #2604's review, comment 4411405761). The "no key" tests fail
 * before (each pushed /find-community). With a key, each still opens Find a community, as home-screen-render pins.
 *
 * Rendered for real, as home-find-not-answering-render.test.ts does: react-dom in jsdom, React Native's host components as
 * plain tags, the knock reads stubbed at their module.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { randomBytes } from 'node:crypto';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, testID, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (testID) attrs['data-testid'] = testID;
        return createElement(tag, attrs, typeof children === 'function' ? children({ pressed: false }) : children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFillObject: {} },
    };
});
const nav = vi.hoisted(() => ({ pushed: [] as unknown[] }));
vi.mock('expo-router', () => ({ router: { push: (to: unknown) => nav.pushed.push(to), navigate: vi.fn(), replace: vi.fn(), back: vi.fn() } }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() } }));
vi.mock('../knock', () => ({ readKnockStatus: vi.fn(async () => null), cardKnockLines: () => [] }));
const watches = vi.hoisted(() => [] as unknown[]);
vi.mock('../community-directory', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../community-directory')>()),
    watchPlace: async (...args: unknown[]) => { watches.push(args); return { ok: true, value: { id: 'w1' } }; },
}));

import { lightColors } from '../../constants/colors';
import { FindCommunityBody } from '../../components/home/FindCommunityBody';
import type { DirectoryCommunity, GlobalHome, Point } from '../community-directory';
import type { BeanPoolIdentity } from '../identity';
import { LOOK_DOOR } from '../look-around';

const community = (key: string, distanceKm: number): DirectoryCommunity => ({
    key, name: `Lismore ${key}`, url: `https://${key}.example.org`, lat: null, lng: null, radiusKm: null, memberCount: 12,
    contactEmail: null, contactPhone: null, distanceKm, lastSeenAt: null,
});
const HOME: GlobalHome = {
    point: 'request', communities: [community('a', 4)], communityCount: 1, nearbyPosts: null, watches: [], directoryFetchedAt: '2026-10-28T08:00:00.000Z',
};
const KEY = { publicKey: 'c'.repeat(64), privateKey: 'd'.repeat(64), callsign: 'Damo' } as BeanPoolIdentity;

async function render(identity: BeanPoolIdentity | null, point: Point | null): Promise<HTMLElement> {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const card = createElement(FindCommunityBody, { home: HOME, knocks: [], identity, nodeUrl: null, point, colors: lightColors });
    await act(async () => { createRoot(host).render(card as unknown as Parameters<Root['render']>[0]); });
    return host;
}
async function tap(host: HTMLElement, testId: string): Promise<void> {
    const el = host.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
    expect(el, testId).not.toBeNull();
    await act(async () => { el!.click(); });
}

beforeEach(() => { document.body.innerHTML = ''; nav.pushed.length = 0; watches.length = 0; });
afterEach(() => { document.body.innerHTML = ''; });

describe("the visitors' Home with no key: the find card's ways to the list open the door, as before S3", () => {
    it('Communities near you opens the door, not Find a community (fails before: /find-community)', async () => {
        const host = await render(null, { lat: -28.65, lng: 153.6 });
        await tap(host, 'home-find-near');
        expect(nav.pushed).toEqual([LOOK_DOOR]);
    });

    it('or type your town opens the door, not Find with a town box it does not draw (fails before: /find-community town=1)', async () => {
        const host = await render(null, null);
        await tap(host, 'home-find-type-town');
        expect(nav.pushed).toEqual([LOOK_DOOR]);
    });

    it('Tell me when one starts here opens the door, place known or not, and keeps no watch (fails before: /find-community)', async () => {
        for (const point of [null, { lat: -28.65, lng: 153.6 }]) {
            nav.pushed.length = 0;
            document.body.innerHTML = '';
            const host = await render(null, point);
            await tap(host, 'home-find-watch');
            expect(nav.pushed, JSON.stringify(point)).toEqual([LOOK_DOOR]);
        }
        expect(watches).toEqual([]);
    });

    it('Start a community still opens its screen, which a visitor may look at', async () => {
        const host = await render(null, null);
        await tap(host, 'home-find-start');
        expect(nav.pushed).toEqual(['/start-community']);
    });
});

describe('with a key, each opens Find a community as before', () => {
    it('Communities near you, or type your town (its town box open), and Tell me with no place', async () => {
        const host = await render(KEY, null);
        await tap(host, 'home-find-near');
        await tap(host, 'home-find-type-town');
        await tap(host, 'home-find-watch');
        expect(nav.pushed).toEqual(['/find-community', { pathname: '/find-community', params: { town: '1' } }, '/find-community']);
        expect(watches).toEqual([]);
    });

    it('Tell me with a place keeps the watch where Home is', async () => {
        const host = await render(KEY, { lat: -28.65, lng: 153.6 });
        await tap(host, 'home-find-watch');
        expect(nav.pushed).toEqual([]);
        expect(watches).toHaveLength(1);
    });
});
