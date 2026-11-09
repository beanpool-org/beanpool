// @vitest-environment jsdom
/**
 * The yes shows itself on the phone's Home Find card (components/home/FindCommunityBody.tsx; Damo, 9 Nov 2026: the yes only
 * showed after a manual refresh). Before: each request's answer was read once, when the card opened. Now the card asks again
 * by itself, on the schedule of @beanpool/core's knock-status-watch.ts, while the app is in front and Home is the screen
 * shown: a yes comes in as "said yes. Join now." in a polite region that was already on the card. Fake timers; the community
 * is a stubbed read; AppState is a switch the test turns.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { randomBytes } from 'node:crypto';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const app = vi.hoisted(() => ({ state: 'active', listeners: new Set<(s: string) => void>() }));
const { readKnockStatusMock } = vi.hoisted(() => ({ readKnockStatusMock: vi.fn() }));

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, testID, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (props.accessibilityLiveRegion) attrs['aria-live'] = props.accessibilityLiveRegion;
        if (testID) attrs['data-testid'] = testID;
        return createElement(tag, attrs, typeof children === 'function' ? children({ pressed: false }) : children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFillObject: {} },
        Alert: { alert: vi.fn() },
        AppState: {
            get currentState() { return app.state; },
            addEventListener: (_type: string, cb: (s: string) => void) => {
                app.listeners.add(cb);
                return { remove() { app.listeners.delete(cb); } };
            },
        },
    };
});
vi.mock('expo-router', () => ({ router: { push: vi.fn(), navigate: vi.fn(), replace: vi.fn(), back: vi.fn() } }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() } }));
vi.mock('../../utils/knock', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../utils/knock')>()),
    readKnockStatus: (...args: unknown[]) => readKnockStatusMock(...args),
}));

import { setLanguage } from '@beanpool/core';
import { lightColors } from '../../constants/colors';
import { FindCommunityBody } from '../../components/home/FindCommunityBody';
import type { DirectoryCommunity, GlobalHome } from '../community-directory';
import type { RememberedKnock } from '../knock';
import type { BeanPoolIdentity } from '../identity';

const ME: BeanPoolIdentity = { publicKey: 'a'.repeat(64), privateKey: '00'.repeat(32), callsign: 'Ana', createdAt: '2026-01-01T00:00:00.000Z' } as BeanPoolIdentity;
const comm: DirectoryCommunity = {
    key: 'byron', name: 'Byron Shire BeanPool', url: 'https://byron.example.org',
    lat: -28.6, lng: 153.6, radiusKm: 20, memberCount: 40, contactEmail: null, contactPhone: null, distanceKm: 12, answers: 'week',
};
const home: GlobalHome = { point: 'request', communities: [comm], communityCount: 38, nearbyPosts: null, watches: [], directoryFetchedAt: '2026-10-28T08:00:00.000Z' };
const BYRON: RememberedKnock = { url: 'https://byron.example.org', name: 'Byron Shire BeanPool', key: 'byron', sentAt: '2026-11-08T00:00:00.000Z' };
const SLEEPY: RememberedKnock = { url: 'https://sleepy.example.org', name: 'Sleepy Hollow', key: null, sentAt: '2026-11-08T00:00:00.000Z' };
const PENDING = { ok: true, value: { status: 'pending' } };
const YES = { ok: true, value: { status: 'approved', invite: 'BP-YES1', expiresAt: null } };

let root: Root | null = null;
let host: HTMLElement | null = null;
const tid = (id: string) => host!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const asked = (url: string) => readKnockStatusMock.mock.calls.filter(c => c[0] === url).length;

function card(knocks: RememberedKnock[], extra: Record<string, unknown> = {}) {
    return createElement(FindCommunityBody, { home, knocks, identity: ME, nodeUrl: null, point: { lat: -28.65, lng: 153.6 }, colors: lightColors, ...extra } as any);
}
async function mount(knocks: RememberedKnock[], extra: Record<string, unknown> = {}) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(card(knocks, extra) as any); });
    await pass(0);
    return (nextKnocks: RememberedKnock[], nextExtra: Record<string, unknown> = {}) => act(async () => { root!.render(card(nextKnocks, nextExtra) as any); });
}
async function pass(ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
function go(state: 'active' | 'background') {
    app.state = state;
    act(() => { for (const cb of [...app.listeners]) cb(state); });
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-09T10:00:00Z'));
    document.body.innerHTML = '';
    app.state = 'active';
    app.listeners.clear();
    readKnockStatusMock.mockReset();
    readKnockStatusMock.mockResolvedValue(PENDING);
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null; host = null;
    setLanguage('en');
    vi.useRealTimers();
});

describe('a yes while Home is open', () => {
    it('shows itself with no refresh: "said yes. Join now." in a region that was already there, and the waiting card goes (fails before: one read at open)', async () => {
        await mount([BYRON]);
        expect(asked(BYRON.url)).toBe(1);
        expect(tid(`home-find-waiting-${BYRON.url}`)).not.toBeNull();
        const live = tid('home-find-yes-live')!;
        expect(live.getAttribute('aria-live')).toBe('polite');
        expect(live.textContent).toBe('');

        await pass(30_000);
        readKnockStatusMock.mockResolvedValue(YES);
        await pass(20_000); // the next read is by 48 s at the latest

        const yes = tid(`home-find-invited-${BYRON.url}`)!;
        expect(yes.textContent).toContain('said yes');
        expect(tid('home-find-yes-live')).toBe(live);
        expect(live.contains(yes)).toBe(true);
        expect(tid(`home-find-waiting-${BYRON.url}`)).toBeNull();
    });

    it('asks about every 20 s at first (16 to 24 s) and not again once there is a yes', async () => {
        await mount([BYRON]);
        await pass(15_999);
        expect(asked(BYRON.url)).toBe(1);
        await pass(8_001);
        expect(asked(BYRON.url)).toBe(2);
        readKnockStatusMock.mockResolvedValue(YES);
        await pass(25_000);
        const withYes = asked(BYRON.url);
        await pass(30 * 60_000);
        expect(asked(BYRON.url)).toBe(withYes);
    });

    it('two requests: the one with its answer is left alone, the other carries on', async () => {
        readKnockStatusMock.mockImplementation(async (url: string) => (url === BYRON.url ? YES : PENDING));
        await mount([BYRON, SLEEPY]);
        await pass(10 * 60_000);
        expect(asked(BYRON.url)).toBe(1);
        expect(asked(SLEEPY.url)).toBeGreaterThan(20);
    });
});

describe('only while it is in front', () => {
    it('the app in the background asks nothing; back in front reads at once', async () => {
        await mount([BYRON]);
        readKnockStatusMock.mockClear();
        go('background');
        await pass(30 * 60_000);
        expect(readKnockStatusMock).not.toHaveBeenCalled();
        go('active');
        await pass(0);
        expect(readKnockStatusMock).toHaveBeenCalledTimes(1);
    });

    it('Home covered by another screen asks nothing; shown again reads at once', async () => {
        const update = await mount([BYRON], { shown: true });
        readKnockStatusMock.mockClear();
        await update([BYRON], { shown: false });
        await pass(30 * 60_000);
        expect(readKnockStatusMock).not.toHaveBeenCalled();
        await update([BYRON], { shown: true });
        await pass(0);
        expect(readKnockStatusMock).toHaveBeenCalledTimes(1);
    });
});

describe('a community that is struggling', () => {
    it('a 429 with Retry-After: 300 is waited out, and the card says nothing alarming meanwhile', async () => {
        readKnockStatusMock.mockResolvedValueOnce({ ok: false, kind: 'refused', status: 429, code: null, message: 'Slow down.', retryAfterSeconds: 300 });
        await mount([BYRON]);
        expect(asked(BYRON.url)).toBe(1);
        await pass(299_000);
        expect(asked(BYRON.url)).toBe(1);
        await pass(1_000);
        expect(asked(BYRON.url)).toBe(2);
    });

    it('a new request on the card is read at once', async () => {
        const update = await mount([BYRON]);
        readKnockStatusMock.mockClear();
        await update([BYRON, SLEEPY]);
        await pass(0);
        expect(asked(SLEEPY.url)).toBe(1);
    });
});
