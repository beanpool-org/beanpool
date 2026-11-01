// @vitest-environment jsdom
/**
 * The place circle on the phone, rendered for real as home-find-not-answering-render.test.ts does (react-dom in jsdom, React
 * Native's host components as plain tags), in both themes: Home's Find card with its count and "I'd help start one here",
 * the circle's three rows, the empty Market's line, and a retired circle: nothing goes to the community until Ask to join is
 * tapped, and the tap sends one knock. The 320 dp × 1.3 widths are place-circle-render.test.ts's.
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
const readKnockStatus = vi.hoisted(() => vi.fn(async () => null));
/** What this phone remembers of its requests. */
const knocksHeld = vi.hoisted(() => ({ open: [] as { url: string; name: string | null; key: string | null; sentAt: string }[], cancelled: {} as Record<string, number> }));
vi.mock('../knock', () => ({
    KNOCK_CALLSIGN_CHARS: 20, readKnockStatus, cardKnockLines: () => [], sendKnock,
    rememberKnock: vi.fn(async (_pk: string, c: { url: string; name: string | null; key: string | null }) => { knocksHeld.open.push({ ...c, sentAt: '2026-11-01T00:00:00.000Z' }); }),
    rememberedKnocks: vi.fn(async () => [...knocksHeld.open]),
    cancelledKnocks: vi.fn(async () => knocksHeld.cancelled),
}));
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

beforeEach(() => { document.body.innerHTML = ''; posted.length = 0; push.mockClear(); fetchHome.mockReset(); kept.clear(); sendKnock.mockReset(); readKnockStatus.mockClear(); knocksHeld.open = []; knocksHeld.cancelled = {}; });
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
        expect(by(host, 'circle-join-when')?.textContent).toContain('Remind me to join when it starts');
        expect(by(host, 'home-find-demand')).toBeNull();
        expect(by(host, 'home-find-help')).toBeNull();
    });

    it('a retired circle says what started and how long its chat stays, with one Ask to join', async () => {
        const circle = { ...openCircle, doneAt: '2026-11-01T00:00:00.000Z', community: { key: 'k', name: 'Thrissur Commons', url: 'https://t.beanpool.org', acceptingKnocks: true } };
        const host = await find(noneNear({ circle }), colors as typeof lightColors);
        expect(by(host, 'circle-started-line')?.textContent).toBe('A community has started near you: Thrissur Commons.');
        expect(host.textContent).toContain('This circle did its job. Its chat stays for 30 days.');
        expect(by(host, 'circle-ask-join')?.textContent).toContain('Ask to join');
        expect(by(host, 'circle-card-done')?.querySelectorAll('button')).toHaveLength(1);
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

describe('a retired circle', () => {
    const me = 'a'.repeat(64);
    const retired = (acceptingKnocks: boolean) => ({
        ...openCircle, doneAt: '2026-11-01T00:00:00.000Z', community: { key: 'k', name: 'Thrissur Commons', url: 'https://t.beanpool.org', acceptingKnocks },
    });
    const tapAsk = async (host: HTMLElement) => { await act(async () => { (by(host, 'circle-ask-join') as HTMLElement).click(); }); };
    /** Home's Find card, ready to be read again. */
    async function home(first: GlobalHome['circle']) {
        const onKnocksChange = vi.fn();
        const body = (circle: GlobalHome['circle']) => createElement(FindCommunityBody, {
            home: noneNear({ circle }), knocks: [], identity, nodeUrl: null, point: { lat: 10.52, lng: 76.21 }, colors: lightColors, onKnocksChange,
        }) as Parameters<Root['render']>[0];
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        await act(async () => { root.render(body(first)); });
        return { host, onKnocksChange, read: (circle: GlobalHome['circle']) => act(async () => { root.render(body(circle)); }) };
    }

    it('sends nothing on any read: no knock, no status read, though the member set the reminder', async () => {
        await setCircleIntent(me, 'c1', true);
        const { host, read } = await home(retired(true));
        await read({ ...retired(true) });
        expect(by(host, 'circle-ask-join')).not.toBeNull();
        expect(sendKnock).not.toHaveBeenCalled();
        expect(readKnockStatus).not.toHaveBeenCalled();
        expect(await circleIntents(me)).toEqual(['c1']);
    });

    it('a community that takes no requests yet has no button, and has one on the read that says it does: still nothing is sent', async () => {
        await setCircleIntent(me, 'c1', true);
        const { host, read } = await home(retired(false));
        expect(by(host, 'circle-ask-join')).toBeNull();
        expect(by(host, 'circle-reminded')).toBeNull();
        await read(retired(true));
        expect(by(host, 'circle-ask-join')).not.toBeNull();
        expect(sendKnock).not.toHaveBeenCalled();
    });

    it('one tap sends one knock, to that community, and Home hears of the request', async () => {
        await setCircleIntent(me, 'c1', true);
        sendKnock.mockResolvedValue({ kind: 'waiting', message: '' });
        const { host, onKnocksChange } = await home(retired(true));
        await tapAsk(host);
        expect(sendKnock).toHaveBeenCalledTimes(1);
        expect(sendKnock.mock.calls[0][0]).toBe('https://t.beanpool.org');
        expect(await circleIntents(me)).toEqual([]);
        expect(onKnocksChange).toHaveBeenCalledTimes(1);
        expect(by(host, 'circle-ask-join')).toBeNull();
    });

    it('the reminder line is for someone who set it', async () => {
        const without = await home(retired(true));
        expect(by(without.host, 'circle-reminded')).toBeNull();
        await setCircleIntent(me, 'c1', true);
        const withIt = await home(retired(true));
        expect(by(withIt.host, 'circle-reminded')?.textContent).toBe(t(PLACE_CIRCLE_WORDS.reminded));
    });

    it('a member who never set the reminder asks with the same tap', async () => {
        sendKnock.mockResolvedValue({ kind: 'waiting', message: '' });
        const { host } = await home(retired(true));
        await tapAsk(host);
        expect(sendKnock).toHaveBeenCalledTimes(1);
    });

    it('a community that answers 503 keeps the button, the card says so, and the next read sends nothing: only another tap does', async () => {
        await setCircleIntent(me, 'c1', true);
        sendKnock.mockResolvedValueOnce({ kind: 'refused', status: 503, code: null, message: '' }).mockResolvedValue({ kind: 'waiting', message: '' });
        const { host, read } = await home(retired(true));
        await tapAsk(host);
        expect(by(host, 'circle-knock-line')?.textContent).toBe(t(PLACE_CIRCLE_WORDS.knockLater));
        expect(await circleIntents(me)).toEqual(['c1']);
        await read({ ...retired(true) });
        expect(sendKnock).toHaveBeenCalledTimes(1);
        await tapAsk(host);
        expect(sendKnock).toHaveBeenCalledTimes(2);
        expect(await circleIntents(me)).toEqual([]);
        expect(by(host, 'circle-knock-line')).toBeNull();
    });

    it('a community that could not be reached is the same', async () => {
        sendKnock.mockResolvedValue({ kind: 'unreachable', message: '' });
        const { host } = await home(retired(true));
        await tapAsk(host);
        expect(by(host, 'circle-knock-line')?.textContent).toBe(t(PLACE_CIRCLE_WORDS.knockLater));
        expect(by(host, 'circle-ask-join')).not.toBeNull();
    });

    it('a community that refuses is said on the card, with no button, and stays said on a later visit', async () => {
        await setCircleIntent(me, 'c1', true);
        sendKnock.mockResolvedValue({ kind: 'refused', status: 403, code: 'account_closed', message: '' });
        const { host } = await home(retired(true));
        await tapAsk(host);
        expect(by(host, 'circle-knock-line')?.textContent).toBe(t(PLACE_CIRCLE_WORDS.knockRefused));
        expect(by(host, 'circle-ask-join')).toBeNull();
        expect(await circleIntents(me)).toEqual([]);
        const later = await home(retired(true));
        expect(by(later.host, 'circle-knock-line')?.textContent).toBe(t(PLACE_CIRCLE_WORDS.knockRefused));
        expect(by(later.host, 'circle-ask-join')).toBeNull();
        expect(sendKnock).toHaveBeenCalledTimes(1);
    });

    it('someone already a member there hears so, and has nothing left to tap', async () => {
        sendKnock.mockResolvedValue({ kind: 'member', message: 'You are already a member of this community.' });
        const { host } = await home(retired(true));
        await tapAsk(host);
        expect(by(host, 'circle-knock-said')?.textContent).toBe('You are already a member of this community.');
        expect(by(host, 'circle-ask-join')).toBeNull();
    });

    it('still lists the request when a read lands while the knock is out', async () => {
        await setCircleIntent(me, 'c1', true);
        let answer: (r: unknown) => void = () => {};
        sendKnock.mockReturnValue(new Promise(resolve => { answer = resolve; }));
        const { host, read, onKnocksChange } = await home(retired(true));
        await tapAsk(host);
        await read({ ...retired(true) });
        expect(sendKnock).toHaveBeenCalledTimes(1);
        await act(async () => { answer({ kind: 'waiting', message: '' }); });
        expect(onKnocksChange).toHaveBeenCalledTimes(1);
    });

    it('no button for a request already open, or one cancelled within the day', async () => {
        knocksHeld.open = [{ url: 'https://t.beanpool.org', name: 'Thrissur Commons', key: 'k', sentAt: '2026-11-01T00:00:00.000Z' }];
        const open = await home(retired(true));
        expect(by(open.host, 'circle-ask-join')).toBeNull();
        knocksHeld.open = [];
        knocksHeld.cancelled = { 'https://t.beanpool.org': Date.now() };
        const cancelled = await home(retired(true));
        expect(by(cancelled.host, 'circle-ask-join')).toBeNull();
    });

    it('no button for a community gone from the directory', async () => {
        const { host } = await home({ ...retired(true), community: null });
        expect(by(host, 'circle-started-line')?.textContent).toBe('A community has started near you.');
        expect(by(host, 'circle-ask-join')).toBeNull();
    });

    it('where Home draws the request the card adds no line; on the sheet it says where to look', async () => {
        knocksHeld.open = [{ url: 'https://t.beanpool.org', name: 'Thrissur Commons', key: 'k', sentAt: '2026-11-01T00:00:00.000Z' }];
        const sheet = await mount(createElement(PlaceCircleCard, { id: 'c1', circle: retired(true), identity, colors: lightColors }));
        expect(by(sheet, 'circle-asked')?.textContent).toBe(t(PLACE_CIRCLE_WORDS.asked));
        const { host } = await home(retired(true));
        expect(by(host, 'circle-asked')).toBeNull();
    });

    it("says nothing about 30 days once its group has closed: the sheet's closed note is the one true thing", async () => {
        const open = await mount(createElement(PlaceCircleCard, { id: 'c1', circle: retired(true), identity, colors: lightColors }));
        expect(by(open, 'circle-chat-stays')?.textContent).toBe(t(PLACE_CIRCLE_WORDS.done));
        const closed = await mount(createElement(PlaceCircleCard, { id: 'c1', circle: retired(true), identity, colors: lightColors, closed: true }));
        expect(by(closed, 'circle-chat-stays')).toBeNull();
        expect(closed.textContent).not.toContain(t(PLACE_CIRCLE_WORDS.done));
        expect(by(closed, 'circle-ask-join')).not.toBeNull();
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
