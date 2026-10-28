// @vitest-environment jsdom
/**
 * The tabs' unread doorbell (app/(tabs)/_layout.tsx), rendered for real as tab-bar-words-render.test.ts renders it, with
 * the clock faked and the member's socket alive, so the message backstop is 120 s away (slice L0).
 *
 * A `ws_activity` within 10 s of the last network read of the messages doesn't read at once. That read may already have
 * passed the doorbell's line, so the held doorbell reads once when the 10 s is up, unless a read has started since it
 * rang (review of #2558). Before, the line waited for the backstop: about two minutes with the socket alive.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import * as ReactAll from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = ReactAll;

const rn = vi.hoisted(() => {
    const listeners = new Map<string, Set<(data?: unknown) => void>>();
    const appStateListeners = new Set<(state: string) => void>();
    return { listeners, appStateListeners, appState: { current: 'active' } };
});

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => createElement(tag, null, props.children);
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {} },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: vi.fn(), forceRTL: vi.fn() },
        NativeModules: {},
        AppState: {
            get currentState() { return rn.appState.current; },
            addEventListener: vi.fn((_: string, fn: (state: string) => void) => {
                rn.appStateListeners.add(fn);
                return { remove: () => rn.appStateListeners.delete(fn) };
            }),
        },
        DeviceEventEmitter: {
            addListener: vi.fn((name: string, fn: (data?: unknown) => void) => {
                if (!rn.listeners.has(name)) rn.listeners.set(name, new Set());
                rn.listeners.get(name)!.add(fn);
                return { remove: () => rn.listeners.get(name)?.delete(fn) };
            }),
            emit: vi.fn(),
        },
    };
});
vi.mock('expo-router', () => {
    const Tabs = ({ children }: { children?: unknown }) => createElement('nav', null, children as any);
    Tabs.Screen = () => null;
    return { Tabs, ErrorBoundary: () => null, usePathname: () => '/', router: { navigate: vi.fn(), push: vi.fn() } };
});
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => 'true'), setItem: vi.fn(async () => undefined), removeItem: vi.fn(async () => undefined) },
}));
vi.mock('../../components/GlobalHeader', () => ({ GlobalHeader: () => null, HEADER_ROW_HEIGHT: 56 }));
vi.mock('../../components/TourBar', () => ({ TourBar: () => null, tourSceneInset: () => 0 }));
vi.mock('../../components/HelpSheet', () => ({ HelpSheet: () => null }));
vi.mock('../use-guide', () => ({ useGuide: () => ({ guide: null, source: 'bundled' }) }));
vi.mock('../tour-store', () => ({
    OPEN_HELP_EVENT: 'open_help', helpContext: () => null, useTour: () => ({ run: null, home: null }),
    closeTour: vi.fn(), moveTour: vi.fn(), startTour: vi.fn(),
}));
vi.mock('../db', () => ({
    getGlobalUnreadCount: vi.fn(async () => 0), syncMessages: vi.fn(async () => undefined), getPosts: vi.fn(async () => []), getMarketplaceTransactions: vi.fn(async () => []),
}));
// The member's socket is alive, open since before the first read: the backstop reads only once its last read is 120 s old
// (@beanpool/core messageBackstopDue). A test drops and reopens it by moving `openedAt` (ws-client.ts isAliveSince).
const socket = vi.hoisted(() => ({ openedAt: null as number | null }));
vi.mock('../../services/ws-client', () => ({
    webSocketAliveSince: (readAt: number) => socket.openedAt !== null && socket.openedAt <= readAt,
}));
vi.mock('../node-profile', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../node-profile')>()),
    fetchNodeProfile: vi.fn(async () => null), getCachedNodeProfile: vi.fn(async () => null),
}));
const IDENTITY = { publicKey: 'pk-me', createdAt: '2026-01-01T00:00:00.000Z' };
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: IDENTITY }) }));
vi.mock('../../app/NodeStatusContext', () => ({ useNodeStatus: () => ({ nodeUrl: null }) }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return { useTheme: () => ({ colors: lightColors, theme: 'light' }) };
});

import { syncMessages } from '../db';
import { LanguageProvider } from '../../components/LanguageProvider';
import TabLayout from '../../app/(tabs)/_layout';

let root: Root | null = null;
let host: HTMLElement | null = null;

const reads = () => vi.mocked(syncMessages).mock.calls.length;
const ring = () => act(() => { rn.listeners.get('ws_activity')?.forEach(fn => fn({ type: 'new_message' })); });
const after = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const appGoes = (state: string) => act(() => { rn.appState.current = state; rn.appStateListeners.forEach(fn => fn(state)); });

beforeEach(async () => {
    vi.useFakeTimers({ now: new Date('2026-10-28T06:00:00Z') });
    vi.mocked(syncMessages).mockClear();
    rn.appState.current = 'active';
    socket.openedAt = Date.now() - 60_000;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'en' }, createElement(TabLayout)) as any); });
    await after(0);
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    vi.useRealTimers();
});

describe('the tabs\' unread doorbell, with the socket alive', () => {
    it('reads at the start, and at once for a doorbell over 10 s after the last read', async () => {
        expect(reads()).toBe(1);
        await after(12_000);
        await ring();
        expect(reads()).toBe(2);
    });

    it('a doorbell 4 s after a read is read when the 10 s is up, not at the 120 s backstop', async () => {
        await after(12_000);
        await ring();                 // t=12 s: read 2
        await after(4_000);
        await ring();                 // t=16 s: within 10 s of read 2, held
        expect(reads()).toBe(2);
        await after(5_000);           // t=21 s
        expect(reads()).toBe(2);
        await after(2_000);           // t=23 s: 10 s after read 2, 7 s after the doorbell
        expect(reads()).toBe(3);
        await after(60_000);          // nothing more until the backstop (120 s from read 3)
        expect(reads()).toBe(3);
    });

    it('a burst of doorbells within the 10 s reads once more, not once each', async () => {
        await after(12_000);
        await ring();                 // read 2
        for (let i = 0; i < 4; i++) { await after(1_000); await ring(); }
        expect(reads()).toBe(2);
        await after(20_000);
        expect(reads()).toBe(3);
    });

    it('a held doorbell reads nothing more when a read started after it rang', async () => {
        await after(12_000);
        await ring();                 // t=12 s: read 2
        await after(2_000);
        await ring();                 // t=14 s: held
        await after(1_000);
        await appGoes('background');
        await after(1_000);
        await appGoes('active');      // t=16 s: the return reads (read 3), after the doorbell rang
        expect(reads()).toBe(3);
        await after(20_000);
        expect(reads()).toBe(3);
    });

    it('a held doorbell reads nothing while the app is in the background', async () => {
        await after(12_000);
        await ring();
        await after(2_000);
        await ring();                 // held
        await appGoes('background');
        await after(20_000);
        expect(reads()).toBe(2);
    });

    it('a socket that dropped and reopened since the last read: the next tick reads, not the 120 s backstop (review of #2558)', async () => {
        expect(reads()).toBe(1);      // t=0
        await after(20_000);
        socket.openedAt = null;       // t=20 s: the socket drops, and a line sent now rings no doorbell
        await after(1_000);
        socket.openedAt = Date.now(); // t=21 s: the retry reopens it, and the reopening reads no messages
        await after(20_000);          // t=41 s: the tick at 24–36 s reads, not one ~105 s after the read at t=0
        expect(reads()).toBe(2);
        await after(40_000);          // t=81 s: that read started after the socket opened, so the backstop is 120 s again
        expect(reads()).toBe(2);
    });

    it('a held doorbell goes with the tabs', async () => {
        await after(12_000);
        await ring();
        await after(2_000);
        await ring();                 // held
        act(() => root?.unmount());
        root = null;
        await after(20_000);
        expect(reads()).toBe(2);
    });
});
