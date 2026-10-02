// @vitest-environment jsdom
/**
 * The header's Needs you icons (components/NeedsYouIcons.tsx) when they read the node themselves: a vote shows only
 * where it lands on a screen the node shows, Commons → Decide, by the one rule Home's lines follow too
 * (home-cards.ts `decideOnNode`: Decisions on and Beans on). PR #1483 review 4166559525.
 *
 * Found by the cold re-review of H2: drawn from Home's answer, the header left a vote out where Commons is hidden; drawn
 * from its own reads (Home's answer older than two minutes), it asked for Decisions on `decisionsOn` alone. On a local
 * node with Beans off and Decisions on, its vote then opened the Commons tab the strip hides, and the icon came and went
 * with the age of Home's answer.
 *
 * Rendered with react-dom in jsdom, React Native's host components as plain tags carrying their labels; the phone's
 * database, the node's profile and the node-admin role are stubs, so nothing is contacted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { useEffect } = await import('react');
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, onLayout } = props;
        // The header's row at the floor's width (320 dp less the bean and the right-hand icons): room for every icon.
        useEffect(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 240, height: 48 } } }); }, []);
        const attrs: Record<string, unknown> = {};
        if (onPress) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        return createElement(tag, attrs, typeof children === 'function' ? children({ pressed: false }) : children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'),
        Modal: ({ visible, children }: { visible: boolean; children?: ReactNode }) => (visible ? createElement('div', null, children) : null),
        StyleSheet: { create: (s: unknown) => s },
        AppState: { currentState: 'active', addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
        DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })), emit: vi.fn() },
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
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: { publicKey: ME, privateKey: 'b'.repeat(64), callsign: 'Zara' } }) }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return { useTheme: () => ({ colors: lightColors, theme: 'light' }) };
});
vi.mock('../../components/useManageNode', () => ({ useManageNode: () => ({ start: vi.fn(), dialog: null }) }));
const NODE = 'https://mullum.beanpool.org';
vi.mock('../node-post', () => ({ anchorUrl: vi.fn(async () => NODE), signedGet: vi.fn(), signedPost: vi.fn() }));
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
    signedGet: vi.fn(async () => ({ ok: true, json: async () => ({ items: [] }) })),
}));
const profile = vi.hoisted(() => ({ features: {} as Record<string, unknown> }));
vi.mock('../node-profile', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../node-profile')>()),
    getCachedNodeProfile: vi.fn(async () => ({ features: profile.features })),
}));

import { NeedsYouIcons } from '../../components/NeedsYouIcons';
import * as db from '../db';
import { resetHomeStoreForTests } from '../home-store';
import { decideOnNode, mergeNeeds } from '../home-cards';
import { hiddenTabsFor } from '../node-profile';

const H = 3600_000;

/** One open Decision the member hasn't voted on, closing in five hours, as GET /api/commons/decisions?status=open signs it. */
function openVote() {
    const now = Date.now();
    return {
        decisions: [{ opensAt: new Date(now - H).toISOString(), closesAt: new Date(now + 5 * H).toISOString(), myVote: null, franchise: 'one_member_one_vote' }],
        myPoolVoting: null,
        canPropose: true,
    };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
    resetHomeStoreForTests();
    nav.push.mockClear();
    vi.mocked(db.getDecisions).mockReset();
    vi.mocked(db.getDecisions).mockImplementation(async () => openVote() as never);
});

afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
});

async function renderHeader() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(createElement(NeedsYouIcons, { sheetTop: 80 }) as unknown as Parameters<Root['render']>[0]); });
    for (let i = 0; i < 10; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

const voteIcon = () => document.querySelector('[data-icon="vote-outline"]');

describe('the header reading the node itself (Home\'s answer not fresh): one rule for votes (PR #1483 review 4166559525)', () => {
    it('a local node with Beans off and Decisions on (Commons hidden): no Decisions asked, no vote icon, nothing opens the hidden tab', async () => {
        profile.features = { beans: false, decisions: true };
        expect(hiddenTabsFor(profile.features)).toContain('projects');
        await renderHeader();
        expect(db.getDecisions).not.toHaveBeenCalled();
        expect(voteIcon()).toBeNull();
        // Every icon there is, pressed: none opens a tab the strip hides.
        for (const b of Array.from(document.querySelectorAll('button'))) await act(async () => { (b as HTMLElement).click(); });
        expect(nav.push.mock.calls.map(([to]) => to.pathname).filter((p: string) => p.startsWith('/(tabs)/projects'))).toEqual([]);
    });

    it('the same node, drawn from Home\'s answer or from its own read: the same icons, so none comes and goes with the answer\'s age', async () => {
        profile.features = { beans: false, decisions: true };
        const vote = { kind: 'vote' as const, count: 1, accent: true, label: 'Vote closes in 5 hours', target: { to: 'decide' as const } };
        const fromHome = mergeNeeds([vote], null, Date.now(), profile.features).map(e => e.kind);
        await renderHeader();
        const own = Array.from(document.querySelectorAll('[data-icon]')).map(i => i.getAttribute('data-icon'));
        expect(fromHome).toEqual([]);
        expect(own).not.toContain('vote-outline');
    });

    it('a local node with Beans and Decisions on: the vote is asked for, shown, and opens Commons → Decide', async () => {
        profile.features = { beans: true, decisions: true };
        expect(decideOnNode(profile.features)).toBe(true);
        await renderHeader();
        expect(db.getDecisions).toHaveBeenCalledWith('open');
        expect(voteIcon()).not.toBeNull();
        await act(async () => { (voteIcon()!.closest('button') as HTMLElement).click(); });
        expect(nav.push).toHaveBeenCalledWith({ pathname: '/(tabs)/projects', params: { section: 'decide' } });
    });

    it('the global node (Decisions off): no Decisions asked, no vote icon', async () => {
        profile.features = { beans: false, decisions: false };
        await renderHeader();
        expect(db.getDecisions).not.toHaveBeenCalled();
        expect(voteIcon()).toBeNull();
    });
});
