// @vitest-environment jsdom
/**
 * The place circle on the phone, rendered for real as home-find-not-answering-render.test.ts does (react-dom in jsdom, React
 * Native's host components as plain tags), in both themes: Home's Find card with its count and "I'd help start one here",
 * the circle's three rows, and the empty Market's line. The 320 dp × 1.3 widths are place-circle-render.test.ts's.
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
const push = vi.hoisted(() => vi.fn());
vi.mock('expo-router', () => ({ router: { push, navigate: vi.fn(), replace: vi.fn(), back: vi.fn() } }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) }));
const kept = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async (key: string) => kept.get(key) ?? null), setItem: vi.fn(async (key: string, value: string) => { kept.set(key, value); }), removeItem: vi.fn() },
}));
const sendKnock = vi.hoisted(() => vi.fn());
vi.mock('../knock', () => ({ readKnockStatus: vi.fn(async () => null), cardKnockLines: () => [], sendKnock, rememberKnock: vi.fn(), rememberedKnocks: vi.fn(async () => []) }));
const posted = vi.hoisted(() => [] as { path: string; body: any }[]);
vi.mock('../node-post', () => ({
    signedPost: vi.fn(async (_base: string, path: string, body: unknown) => {
        posted.push({ path, body });
        return new Response(JSON.stringify({ watch: { id: 'w1', lat: 10.5, lng: 76.2, radiusKm: 50, wouldHelp: true } }), { status: 200 });
    }),
    signedDelete: vi.fn(),
}));
const fetchHome = vi.hoisted(() => vi.fn());
vi.mock('../community-directory', async (original) => ({ ...(await original<Record<string, unknown>>()), fetchGlobalHome: fetchHome }));

import { lightColors, darkColors } from '../../constants/colors';
import { FindCommunityBody } from '../../components/home/FindCommunityBody';
import { MarketCircleLine } from '../../components/MarketCircleLine';
import { PlaceCircleCard } from '../../components/PlaceCircleCard';
import { PLACE_CIRCLE_WORDS, t } from '@beanpool/core';
import { circleIntents, setCircleIntent } from '../circle-intent';
import type { GlobalHome } from '../community-directory';

const identity = { publicKey: 'a'.repeat(64), privateKey: '00', callsign: 'Ana' } as never;
const noneNear = (over: Partial<GlobalHome>): GlobalHome => ({
    point: 'request', communities: [], communityCount: 0, nearbyPosts: null, watches: [], directoryFetchedAt: '2026-10-28T08:00:00.000Z', ...over,
});
const openCircle = { id: 'c1', people: 4, starting: null, doneAt: null, community: null };

async function mount(element: unknown): Promise<HTMLElement> {
    const host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => { createRoot(host).render(element as Parameters<Root['render']>[0]); });
    return host;
}
const find = (home: GlobalHome, colors = lightColors) => mount(createElement(FindCommunityBody, { home, knocks: [], identity, nodeUrl: null, point: { lat: 10.52, lng: 76.21 }, colors }));
const by = (host: HTMLElement, id: string) => host.querySelector(`[data-testid="${id}"]`);

beforeEach(() => { document.body.innerHTML = ''; posted.length = 0; push.mockClear(); fetchHome.mockReset(); kept.clear(); sendKnock.mockReset(); });
afterEach(() => { document.body.innerHTML = ''; });

describe.each([['light', lightColors], ['dark', darkColors]])('in the %s theme', (_name, colors) => {
    it('Home says the count and offers to help where nothing is near', async () => {
        const host = await find(noneNear({ demand: { waiting: 7, helping: 4 } }), colors as typeof lightColors);
        expect(by(host, 'home-find-demand')?.textContent).toBe('4 people near you would help start a community.');
        expect(by(host, 'home-find-help')?.textContent).toContain("I'd help start one here");
    });

    it('a member of a circle sees its three rows, and no second count', async () => {
        const host = await find(noneNear({ demand: { waiting: 7, helping: 4 }, circle: openCircle }), colors as typeof lightColors);
        expect(by(host, 'circle-people')?.textContent).toBe('4 people here');
        expect(by(host, 'circle-start')?.textContent).toContain('Start a community');
        expect(by(host, 'circle-starting')?.textContent).toContain("I'm starting one here");
        expect(by(host, 'circle-join-when')?.textContent).toContain('Join when it starts');
        expect(by(host, 'home-find-demand')).toBeNull();
        expect(by(host, 'home-find-help')).toBeNull();
    });

    it('a retired circle says what started and how long its chat stays', async () => {
        const circle = { ...openCircle, doneAt: '2026-11-01T00:00:00.000Z', community: { key: 'k', name: 'Thrissur Commons', url: 'https://t.beanpool.org', acceptingKnocks: true } };
        const host = await find(noneNear({ circle }), colors as typeof lightColors);
        expect(by(host, 'circle-started-line')?.textContent).toBe('A community has started near you: Thrissur Commons.');
        expect(host.textContent).toContain('This circle did its job. Its chat stays for 30 days.');
        expect(by(host, 'circle-starting')).toBeNull();
    });

    it('the empty Market says the count from 3, and Meet them opens the find screen with no circle', async () => {
        fetchHome.mockResolvedValue({ ok: true, value: noneNear({ demand: { waiting: 5, helping: null } }) });
        const host = await mount(createElement(MarketCircleLine, { identity, colors: colors as typeof lightColors }));
        expect(by(host, 'market-circle-line')?.textContent).toContain('5 people near you are waiting for a community too.');
        await act(async () => { (by(host, 'market-meet-them') as HTMLElement).click(); });
        expect(push).toHaveBeenCalledWith('/find-community');
    });
});

describe('the knock a retired circle owes', () => {
    const me = 'a'.repeat(64);
    const retired = (acceptingKnocks: boolean) => ({
        ...openCircle, doneAt: '2026-11-01T00:00:00.000Z', community: { key: 'k', name: 'Thrissur Commons', url: 'https://t.beanpool.org', acceptingKnocks },
    });
    /** Home's Find card, read twice. */
    async function twoReads(first: GlobalHome['circle'], then: GlobalHome['circle']) {
        const onKnocksChange = vi.fn();
        const body = (circle: GlobalHome['circle']) => createElement(FindCommunityBody, {
            home: noneNear({ circle }), knocks: [], identity, nodeUrl: null, point: { lat: 10.52, lng: 76.21 }, colors: lightColors, onKnocksChange,
        }) as Parameters<Root['render']>[0];
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        await act(async () => { root.render(body(first)); });
        const sentAtFirst = sendKnock.mock.calls.length;
        await act(async () => { root.render(body(then)); });
        return { sentAtFirst, onKnocksChange };
    }

    it('waits for a community that takes no requests yet, and goes on the read that says it does', async () => {
        await setCircleIntent(me, 'c1', true);
        sendKnock.mockResolvedValue({ kind: 'waiting', message: '' });
        const { sentAtFirst, onKnocksChange } = await twoReads(retired(false), retired(true));
        expect(sentAtFirst).toBe(0);
        expect(sendKnock).toHaveBeenCalledTimes(1);
        expect(await circleIntents(me)).toEqual([]);
        expect(onKnocksChange).toHaveBeenCalledTimes(1);
    });

    it('tries a community it could not reach again on the next read', async () => {
        await setCircleIntent(me, 'c1', true);
        sendKnock.mockResolvedValueOnce({ kind: 'unreachable', message: '' }).mockResolvedValue({ kind: 'waiting', message: '' });
        await twoReads(retired(true), retired(true));
        expect(sendKnock).toHaveBeenCalledTimes(2);
        expect(await circleIntents(me)).toEqual([]);
    });

    it('a community that answers 503 is asked again on the next read, and the card says so until it goes', async () => {
        await setCircleIntent(me, 'c1', true);
        sendKnock.mockResolvedValueOnce({ kind: 'refused', status: 503, code: null, message: '' }).mockResolvedValue({ kind: 'waiting', message: '' });
        const host = await find(noneNear({ circle: retired(true) }));
        expect(host.querySelector('[data-testid="circle-knock-line"]')?.textContent).toBe(t(PLACE_CIRCLE_WORDS.knockLater));
        expect(await circleIntents(me)).toEqual(['c1']);
        await twoReads(retired(true), retired(true));
        expect(sendKnock).toHaveBeenCalledTimes(2);
        expect(await circleIntents(me)).toEqual([]);
    });

    it('a community that refuses is said on the card', async () => {
        await setCircleIntent(me, 'c1', true);
        sendKnock.mockResolvedValue({ kind: 'refused', status: 403, code: 'account_closed', message: '' });
        const host = await find(noneNear({ circle: retired(true) }));
        expect(host.querySelector('[data-testid="circle-knock-line"]')?.textContent).toBe(t(PLACE_CIRCLE_WORDS.knockRefused));
        expect(await circleIntents(me)).toEqual([]);
    });

    it('still lists the request when a read lands while the knock is out', async () => {
        await setCircleIntent(me, 'c1', true);
        let answer: (r: unknown) => void = () => {};
        sendKnock.mockReturnValue(new Promise(resolve => { answer = resolve; }));
        const { onKnocksChange } = await twoReads(retired(true), retired(true));
        expect(sendKnock).toHaveBeenCalledTimes(1);
        await act(async () => { answer({ kind: 'waiting', message: '' }); });
        expect(onKnocksChange).toHaveBeenCalledTimes(1);
    });
});

describe('what a tap does', () => {
    it('Start a community opens the screen, once a sheet it is drawn in has closed', async () => {
        const home = await mount(createElement(PlaceCircleCard, { id: 'c1', circle: openCircle, identity, colors: lightColors }));
        await act(async () => { (by(home, 'circle-start') as HTMLElement).click(); });
        expect(push).toHaveBeenCalledWith('/start-community');
        push.mockClear();
        const onLeave = vi.fn();
        const sheet = await mount(createElement(PlaceCircleCard, { id: 'c1', circle: openCircle, identity, colors: lightColors, onLeave }));
        await act(async () => { (by(sheet, 'circle-start') as HTMLElement).click(); });
        expect(onLeave).toHaveBeenCalledTimes(1);
        expect(push).toHaveBeenCalledWith('/start-community');
        expect(onLeave.mock.invocationCallOrder[0]).toBeLessThan(push.mock.invocationCallOrder[0]);
    });

    it("I'd help's spoken name is the words on it, so voice control finds it by what it says (WCAG 2.5.3)", async () => {
        const host = await find(noneNear({}));
        const button = host.querySelector('[data-testid="home-find-help"]');
        expect(button?.getAttribute('aria-label')).toBe(t(PLACE_CIRCLE_WORDS.help));
        expect(button?.textContent).toContain(t(PLACE_CIRCLE_WORDS.help));
    });

    it("I'd help sends the rounded cell and the flag, and nothing else", async () => {
        const host = await find(noneNear({}));
        await act(async () => { (by(host, 'home-find-help') as HTMLElement).click(); });
        expect(posted).toEqual([{ path: '/api/global/watches', body: { lat: 10.5, lng: 76.2, wouldHelp: true } }]);
        expect(by(host, 'home-find-watch-note')?.textContent).toContain("Thanks. When three of you are near each other, you'll be introduced.");
    });

    it('in a place with a community near, no helper button and no count', async () => {
        const near = { key: 'k', name: 'Near', url: 'https://n.example.org', lat: null, lng: null, radiusKm: null, memberCount: 5, contactEmail: null, contactPhone: null, distanceKm: 12, lastSeenAt: null };
        const host = await find(noneNear({ communities: [near], communityCount: 1, demand: { waiting: 7, helping: 4 } }));
        expect(by(host, 'home-find-help')).toBeNull();
        expect(by(host, 'home-find-demand')).toBeNull();
    });

    it('the empty Market says nothing below 3, and Meet them opens a circle where there is one', async () => {
        fetchHome.mockResolvedValue({ ok: true, value: noneNear({ demand: { waiting: null, helping: null } }) });
        const quiet = await mount(createElement(MarketCircleLine, { identity, colors: lightColors }));
        expect(quiet.textContent).toBe('');
        fetchHome.mockResolvedValue({ ok: true, value: noneNear({ demand: { waiting: 5, helping: null }, circle: openCircle }) });
        const host = await mount(createElement(MarketCircleLine, { identity, colors: lightColors }));
        await act(async () => { (by(host, 'market-meet-them') as HTMLElement).click(); });
        expect(push).toHaveBeenCalledWith('/group/c1');
    });
});
