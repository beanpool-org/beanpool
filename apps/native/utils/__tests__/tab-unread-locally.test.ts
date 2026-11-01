// @vitest-environment jsdom
/**
 * Test: phone app unread badge clearing on local read (web-unread-badge item 3).
 *
 * The phone's Chat tab, app/(tabs)/_layout.tsx checkUnread, reads local SQLite every 5 s,
 * so today it clears up to 5 s late. Make it clear at once too: after a read is marked locally
 * (utils/db.ts markConversationReadLocally, reached from app/chat/[id].tsx, GroupChatView,
 * EventChatView), the tab count refreshes with no wait. A local read only, no network sync.
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
            emit: vi.fn((name: string, data?: unknown) => {
                rn.listeners.get(name)?.forEach(fn => fn(data));
            }),
        },
    };
});

vi.mock('expo-router', () => {
    const Tabs = ({ children }: { children?: unknown }) => createElement('nav', null, children as any);
    Tabs.Screen = ({ name, options }: { name: string; options: Record<string, any> }) => createElement('button', {
        'data-tab': name,
    }, options?.tabBarIcon ? options.tabBarIcon({ focused: false, color: '#000' }) : null);
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

const dbMock = vi.hoisted(() => ({
    unreadCount: 5,
    runAsync: vi.fn(async () => ({ changes: 1 })),
}));

vi.mock('../db', () => ({
    getGlobalUnreadCount: vi.fn(async () => dbMock.unreadCount),
    syncMessages: vi.fn(async () => true),
    getPosts: vi.fn(async () => []),
    getMarketplaceTransactions: vi.fn(async () => []),
    getDb: vi.fn(async () => ({
        runAsync: dbMock.runAsync,
    })),
    markConversationReadLocally: async (conversationId: string, myPubkey: string) => {
        await dbMock.runAsync(
            'UPDATE conversation_participants SET last_read_at = ? WHERE conversation_id = ? AND public_key = ?',
            [new Date().toISOString(), conversationId, myPubkey] as any,
        );
        const { emitAppEvent, CONVERSATION_READ_LOCALLY_EVENT } = await import('../app-events');
        emitAppEvent(CONVERSATION_READ_LOCALLY_EVENT, { conversationId, myPubkey });
    },
}));

vi.mock('../../services/ws-client', () => ({
    webSocketAliveSince: () => true,
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

import { syncMessages, getGlobalUnreadCount, markConversationReadLocally } from '../db';
import { CONVERSATION_READ_LOCALLY_EVENT, emitAppEvent } from '../app-events';
import { LanguageProvider } from '../../components/LanguageProvider';
import TabLayout from '../../app/(tabs)/_layout';

let root: Root | null = null;
let host: HTMLElement | null = null;

const after = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(async () => {
    vi.useFakeTimers({ now: new Date('2026-11-01T00:00:00Z') });
    dbMock.unreadCount = 5;
    dbMock.runAsync.mockClear();
    vi.mocked(syncMessages).mockClear();
    vi.mocked(getGlobalUnreadCount).mockClear();
    rn.appState.current = 'active';

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root!.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'en' }, createElement(TabLayout)) as any);
    });
    await after(0);
});

afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    vi.useRealTimers();
});

describe('phone app Chat tab unread badge', () => {
    it('shows 5 unread on mount, then clears immediately when conversation is read locally with no wait and no network sync', async () => {
        // Initial state: 5 unread
        expect(host?.textContent).toContain('5');
        const initialSyncs = vi.mocked(syncMessages).mock.calls.length;
        const initialUnreadCalls = vi.mocked(getGlobalUnreadCount).mock.calls.length;
        expect(initialUnreadCalls).toBeGreaterThanOrEqual(1);

        // Mark conversation read locally
        dbMock.unreadCount = 0;
        await act(async () => {
            await markConversationReadLocally('conv-1', 'pk-me');
        });
        await after(0); // Only process pending microtasks/render, 0 ms timer advance

        // Count in tab bar is immediately 0 (the badge "5" is gone)
        expect(host?.textContent).not.toContain('5');
        // Local SQLite was re-read
        expect(vi.mocked(getGlobalUnreadCount).mock.calls.length).toBeGreaterThan(initialUnreadCalls);
        // NO network sync was triggered (local read only)
        expect(vi.mocked(syncMessages).mock.calls.length).toBe(initialSyncs);
    });

    it('ignores conversation_read_locally events for other identities', async () => {
        const unreadCalls = vi.mocked(getGlobalUnreadCount).mock.calls.length;
        dbMock.unreadCount = 2;

        await act(async () => {
            emitAppEvent(CONVERSATION_READ_LOCALLY_EVENT, { conversationId: 'conv-other', myPubkey: 'pk-other' });
        });
        await after(0);

        // getGlobalUnreadCount was not called because myPubkey does not match
        expect(vi.mocked(getGlobalUnreadCount).mock.calls.length).toBe(unreadCalls);
    });

    it('ignores conversation_read_locally events with missing or undefined myPubkey', async () => {
        const unreadCalls = vi.mocked(getGlobalUnreadCount).mock.calls.length;
        dbMock.unreadCount = 2;

        await act(async () => {
            emitAppEvent(CONVERSATION_READ_LOCALLY_EVENT, { conversationId: 'conv-other' } as any);
        });
        await after(0);

        expect(vi.mocked(getGlobalUnreadCount).mock.calls.length).toBe(unreadCalls);
    });
});
