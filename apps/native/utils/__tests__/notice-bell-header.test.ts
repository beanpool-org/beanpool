// @vitest-environment jsdom
/**
 * The bell on the phone's header (components/NeedsYouIcons.tsx; scratch/fable-design/DESIGN-web-notifications-fable.md
 * §2.1 and its W0 row of §3; Marty, 9 Nov 2026: the bell takes the needs-you row, and a row leaves only when tapped or when
 * its thing is opened). Damo: "a red alert bell … once it's clicked (and only once it's clicked) should it disappear".
 *
 *   1. the count is the notices not yet opened (GET /api/notices/push?unseen=1), never more than 99+
 *   2. opening the sheet marks nothing: the rows, with their real words, and the count stay
 *   3. a row's tap opens its thing by the push tap's own routes (noticeRoute) and marks it, and only it
 *   4. opening the chat marks its rows: the node marks them and tells the sockets (`bell_activity` here), and the count follows
 *   5. a notice kept: the node's word reads the list again, and the count goes up; nothing else is synced for it
 *
 * Rendered with react-dom in jsdom, React Native's host components as plain tags carrying their labels; the phone's
 * database, the node and the node-admin role are stubs, so nothing is contacted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const bus = vi.hoisted(() => ({ listeners: new Map<string, Set<(d: unknown) => void>>() }));
vi.mock('react-native', async () => {
    const { useEffect } = await import('react');
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, onLayout } = props;
        // The header's row at the floor's width (320 dp less the bean and the right-hand icons).
        useEffect(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 120, height: 48 } } }); }, []);
        const attrs: Record<string, unknown> = {};
        if (onPress) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        return createElement(tag, attrs, typeof children === 'function' ? children({ pressed: false }) : children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'),
        Modal: ({ visible, children }: { visible: boolean; children?: ReactNode }) => (visible ? createElement('div', { role: 'dialog' }, children) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 },
        AppState: { currentState: 'active', addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
        DeviceEventEmitter: {
            addListener: vi.fn((name: string, fn: (d: unknown) => void) => {
                if (!bus.listeners.has(name)) bus.listeners.set(name, new Set());
                bus.listeners.get(name)!.add(fn);
                return { remove: () => bus.listeners.get(name)?.delete(fn) };
            }),
            emit: vi.fn(),
        },
    };
});
const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', () => ({ router: { push: nav.push }, usePathname: () => '/market' }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined), removeItem: vi.fn(async () => undefined) },
}));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(), deleteItemAsync: vi.fn() }));
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn((n: number) => new Uint8Array(n)) }));
const ME = 'a'.repeat(64);
const IDENTITY = { publicKey: ME, privateKey: 'b'.repeat(64), callsign: 'Zara' };
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: IDENTITY }) }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return { useTheme: () => ({ colors: lightColors, theme: 'light' }) };
});
vi.mock('../../components/useManageNode', () => ({ useManageNode: () => ({ start: vi.fn(), dialog: null }) }));
const NODE = 'https://mullum.beanpool.org';
vi.mock('../node-post', () => ({ anchorUrl: vi.fn(async () => NODE), signedGet: vi.fn(), signedPost: vi.fn(async () => ({ ok: true, json: async () => ({ marked: 1 }) })) }));
vi.mock('../node-admin', () => ({
    cachedNodeRole: vi.fn(async () => ({ role: null, communityName: 'Mullumbimby' })),
    canManageNode: () => false,
    fetchAdminQueue: vi.fn(async () => null),
    forgetNodeRole: vi.fn(),
}));
vi.mock('../db', () => ({
    getMarketplaceTransactions: vi.fn(async () => []),
    getUnreadByConversation: vi.fn(async () => []),
    getDecisions: vi.fn(),
    signedGet: vi.fn(),
}));
vi.mock('../node-profile', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../node-profile')>()),
    getCachedNodeProfile: vi.fn(async () => ({ features: { beans: true, decisions: false } })),
}));

import { NeedsYouIcons } from '../../components/NeedsYouIcons';
import * as db from '../db';
import * as nodePost from '../node-post';
import { resetHomeStoreForTests } from '../home-store';
import type { BellNotice } from '@beanpool/core';

const CHAT = '0f8e2c1a-5b6d-4e7f-9a0b-1c2d3e4f5a6b';
const POST = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const node = vi.hoisted(() => ({ notices: [] as unknown[] }));
const notice = (id: string, over: Partial<BellNotice> = {}): BellNotice => ({
    id, kind: 'chat.message', title: '💬 New Message', body: 'Maya sent you a message',
    data: { screen: 'chat', conversationId: CHAT }, sentAt: Math.floor(Date.now() / 1000) - 120, seenAt: null, ...over,
});

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
    resetHomeStoreForTests();
    nav.push.mockClear();
    vi.mocked(nodePost.signedPost).mockClear();
    node.notices = [];
    vi.mocked(db.signedGet).mockReset();
    vi.mocked(db.signedGet).mockImplementation(async (p: string) => ({
        ok: true,
        json: async () => (String(p).startsWith('/api/notices/push') ? { notices: node.notices } : String(p) === '/api/your-groups' ? { items: [], invites: [] } : {}),
    }) as never);
});

afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
});

async function settle() {
    for (let i = 0; i < 10; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}
async function renderHeader() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(createElement(NeedsYouIcons, { sheetTop: 80 }) as unknown as Parameters<Root['render']>[0]); });
    await settle();
}
const bell = () => document.querySelector('[data-icon="bell-outline"]')!.closest('button') as HTMLElement;
const openSheet = async () => { await act(async () => { bell().click(); }); return document.querySelector('[role="dialog"]') as HTMLElement; };
const rows = () => Array.from(document.querySelectorAll('[role="dialog"] button')).filter(b => /sent you a message|asked for/.test(b.getAttribute('aria-label') ?? '')) as HTMLElement[];
const fire = (data: unknown) => act(async () => { bus.listeners.get('bell_activity')?.forEach(fn => fn(data)); });

describe('the bell (components/NeedsYouIcons.tsx)', () => {
    it('the count is the notices not yet opened, read from the node, never more than 99+', async () => {
        node.notices = [notice('n1'), notice('n2'), notice('n3')];
        await renderHeader();
        expect(vi.mocked(db.signedGet).mock.calls.map(([p]) => p)).toContain('/api/notices/push?unseen=1');
        expect(bell().getAttribute('aria-label')).toBe('Notifications: 3 new');
        expect(bell().textContent).toBe('3');
        act(() => root?.unmount());

        node.notices = Array.from({ length: 100 }, (_, i) => notice(`m${i}`));
        root = createRoot(host!);
        await act(async () => { root!.render(createElement(NeedsYouIcons, { sheetTop: 80 }) as unknown as Parameters<Root['render']>[0]); });
        await settle();
        expect(bell().textContent).toBe('99+');
    });

    it('opening the sheet marks nothing: the rows, with their real words and when, and the count stay', async () => {
        node.notices = [notice('n1'), notice('n2', { kind: 'market.request', title: '🤝 Request', body: 'Ben asked for your jam', data: { screen: 'post', postId: POST } })];
        await renderHeader();
        const sheet = await openSheet();
        expect(rows().map(r => r.getAttribute('aria-label'))).toEqual(['💬 New Message. Maya sent you a message', '🤝 Request. Ben asked for your jam']);
        expect(sheet.textContent).toContain('2 minutes ago');
        expect(sheet.textContent).toContain('Older notices are gone after 7 days.');
        const close = Array.from(sheet.parentElement!.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'Close') as HTMLElement;
        await act(async () => { close.click(); });
        expect(nodePost.signedPost).not.toHaveBeenCalled();
        expect(bell().textContent).toBe('2');
    });

    it("a row's tap opens its thing by the push tap's routes and marks it, and only it", async () => {
        node.notices = [notice('n1'), notice('n2', { kind: 'market.request', title: '🤝 Request', body: 'Ben asked for your jam', data: { screen: 'post', postId: POST } })];
        await renderHeader();
        await openSheet();
        await act(async () => { rows()[1].click(); });
        await settle();
        expect(nav.push).toHaveBeenCalledWith(`/post/${POST}`);
        expect(nodePost.signedPost).toHaveBeenCalledWith(NODE, '/api/notices/push/seen', { ids: ['n2'] }, IDENTITY);
        expect(bell().textContent).toBe('1');
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        await openSheet();
        await act(async () => { rows()[0].click(); });
        await settle();
        expect(nav.push).toHaveBeenLastCalledWith(`/chat/${CHAT}`);
        expect(bell().getAttribute('aria-label')).toBe('Notifications');
        expect(bell().textContent).toBe('');
    });

    it("opening the chat marks its rows: the node's word takes them off, and the count follows", async () => {
        node.notices = [notice('n1'), notice('n2', { data: { screen: 'chat', conversationId: POST } })];
        await renderHeader();
        expect(bell().textContent).toBe('2');
        await fire({ type: 'push_notices_seen', ids: ['n1'] });
        expect(bell().textContent).toBe('1');
        await openSheet();
        expect(rows()).toHaveLength(1);
    });

    it('a notice kept: the node\'s word reads the list again, and the count goes up', async () => {
        await renderHeader();
        expect(bell().textContent).toBe('');
        node.notices = [notice('n9')];
        await fire({ type: 'push_notice', id: 'n9', kind: 'chat.message' });
        await act(async () => { await new Promise(r => setTimeout(r, 400)); });
        await settle();
        expect(bell().textContent).toBe('1');
    });
});

describe('the socket (services/ws-client.ts)', () => {
    it("the bell's events go to the bell alone: never a doorbell, never a sync", async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.join(__dirname, '..', '..', 'services', 'ws-client.ts'), 'utf-8');
        const at = src.indexOf("if (data.type === BELL_EVENTS.kept || data.type === BELL_EVENTS.seen) {");
        expect(at).toBeGreaterThan(-1);
        expect(src.slice(at, at + 200)).toMatch(/DeviceEventEmitter\.emit\('bell_activity', data\);\s*return;/);
        // Before the doorbell and the live listing writes.
        expect(at).toBeLessThan(src.indexOf('const change = livePostChange(data);'));
    });
});
