// @vitest-environment jsdom
/**
 * A group invitation in Needs you (tester report 24 Oct, item 6: Marty was invited to two groups and saw only an INVITED
 * badge deep in Commons; "there should have been a red counter on something"). One line for the member's open
 * invitations, in the header's icons and on Home: from Home's answer (the node words it, apps/server routes/home-answer.ts,
 * for an app that asks with lands=invite) or, when the header reads the node itself, from GET /api/your-groups `invites`.
 * A tap opens the invitation's landing (app/group/[id].tsx) as an invitation; several, Commons → Groups.
 *
 * The header's part is rendered with react-dom in jsdom, React Native's host components as plain tags carrying their
 * labels; the phone's database, the node's profile and the node-admin role are stubs, so nothing is contacted.
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
    signedGet: vi.fn(),
}));
vi.mock('../node-profile', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../node-profile')>()),
    getCachedNodeProfile: vi.fn(async () => ({ features: { beans: true, decisions: false } })),
}));

import { NeedsYouIcons } from '../../components/NeedsYouIcons';
import * as db from '../db';
import * as nodePost from '../node-post';
import {
    buildNeedsYou, isOwnInviteChange, needsTargetHref, NEEDS_YOU_PRIORITY, type NeedsYouInputs,
} from '../needs-you';
import { freshHomeForHeader, homePath, loadHome, resetHomeStoreForTests } from '../home-store';
import { createDoorbellDebounce, isHomeDoorbellFor, mergeNeeds } from '../home-cards';
import { inviteLandingPreviewFromParams } from '../your-groups';

const GARDEN = '0f8e2c1a-5b6d-4e7f-9a0b-1c2d3e4f5a6b';
const CHOIR = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const NOW = Date.parse('2026-10-24T09:00:00Z');
const base = (over: Partial<NeedsYouInputs> = {}): NeedsYouInputs => ({
    me: ME, now: NOW, transactions: [], decisions: null, conversations: [], groupChats: [], admin: null, ...over,
});

describe('the invitation line (utils/needs-you.ts buildNeedsYou)', () => {
    it('one open invitation: one line naming the group, landing on its invitation, calm (no accent)', () => {
        const [e] = buildNeedsYou(base({ groupInvites: [{ groupId: GARDEN, name: 'Garden Club' }] }));
        expect(e).toEqual({ kind: 'invite', count: 1, accent: false, label: "You're invited to join Garden Club", target: { to: 'invite', id: GARDEN } });
    });

    it('several: one counted line, landing on the list', () => {
        const entries = buildNeedsYou(base({ groupInvites: [{ groupId: GARDEN, name: 'Garden Club' }, { groupId: CHOIR, name: 'Choir' }] }));
        expect(entries).toEqual([{ kind: 'invite', count: 2, accent: false, label: "You're invited to join 2 groups", target: { to: 'invites' } }]);
    });

    it('none, not read (a node from before it said them) or malformed rows: no line', () => {
        for (const groupInvites of [[], null, undefined, [{ groupId: '', name: 'x' }], [{ name: 'x' }] as never]) {
            expect(buildNeedsYou(base({ groupInvites })).filter(e => e.kind === 'invite')).toEqual([]);
        }
    });

    it('sits after a vote and before messages and group lines', () => {
        expect(NEEDS_YOU_PRIORITY).toEqual(['admin', 'deal', 'vote', 'invite', 'message', 'group']);
        const entries = buildNeedsYou(base({
            groupInvites: [{ groupId: GARDEN, name: 'Garden Club' }],
            conversations: [{ id: 'c1', type: 'dm', unread: 1, peer: 'Bea' }],
            groupChats: [{ kind: 'group', conversationId: CHOIR, name: 'Choir', unreadCount: 2, mute: null }],
        }));
        expect(entries.map(e => e.kind)).toEqual(['invite', 'message', 'group']);
    });

    it("Home's line from the node is drawn as it came (mergeNeeds), beside the phone's own", () => {
        const fromNode = { kind: 'invite' as const, count: 1, accent: false, label: "You're invited to join Garden Club", target: { to: 'invite' as const, id: GARDEN } };
        expect(mergeNeeds([fromNode], null, NOW).map(e => [e.kind, e.label, e.target])).toEqual([['invite', fromNode.label, fromNode.target]]);
    });
});

describe('where the line lands (needsTargetHref)', () => {
    it("one: the group's invite landing, opened as an invitation (Join), as a Commons row opens it", () => {
        const href = needsTargetHref({ to: 'invite', id: GARDEN });
        expect(href).toEqual({ pathname: '/group/[id]', params: { id: GARDEN, invited: '1' } });
        expect(inviteLandingPreviewFromParams(href.params!).invited).toBe(true);
    });

    it('several: Commons → Groups, where each is marked INVITED', () => {
        expect(needsTargetHref({ to: 'invites' })).toEqual({ pathname: '/(tabs)/projects', params: { section: 'groups' } });
    });

    it('Home asks the node for it: lands=invite', () => {
        expect(homePath(['needs'])).toBe('/api/home?cards=needs&lands=enterprise,group,invite');
    });
});

describe('the socket events that change the member\'s own invitation (isOwnInviteChange)', () => {
    const member = (pk: string) => ({ groupId: GARDEN, memberPubkey: pk, status: 'invited' });
    it('made, taken up or declined/withdrawn: theirs counts, anyone else\'s does not', () => {
        expect(isOwnInviteChange({ type: 'group_member_invited', groupId: GARDEN, member: member(ME) }, ME)).toBe(true);
        expect(isOwnInviteChange({ type: 'group_member_updated', groupId: GARDEN, member: member(ME) }, ME)).toBe(true);
        expect(isOwnInviteChange({ type: 'group_member_removed', groupId: GARDEN, memberPubkey: ME }, ME)).toBe(true);
        // A convenor hears of the invitations they and others make; the member invited is someone else.
        expect(isOwnInviteChange({ type: 'group_member_invited', groupId: GARDEN, member: member('c'.repeat(64)) }, ME)).toBe(false);
        expect(isOwnInviteChange({ type: 'group_member_removed', groupId: GARDEN, memberPubkey: 'c'.repeat(64) }, ME)).toBe(false);
        for (const junk of [null, 'group_member_invited', { type: 'new_post' }, { type: 'group_member_invited' }, { type: 'group_member_invited', member: null }]) {
            expect(isOwnInviteChange(junk, ME)).toBe(false);
        }
        expect(isOwnInviteChange({ type: 'group_member_invited', member: member(ME) }, null)).toBe(false);
    });

    it("Home reads again on one, debounced as its other doorbells are", () => {
        expect(isHomeDoorbellFor({ type: 'group_member_invited', member: member(ME) }, ME)).toBe(true);
        expect(isHomeDoorbellFor({ type: 'group_member_removed', memberPubkey: ME }, ME)).toBe(true);
        expect(isHomeDoorbellFor({ type: 'group_member_removed', memberPubkey: 'c'.repeat(64) }, ME)).toBe(false);
        expect(isHomeDoorbellFor({ type: 'new_post' }, ME)).toBe(true);
        const ran = vi.fn();
        let fire: (() => void) | null = null;
        const bell = createDoorbellDebounce(ran, 3000, { set: (fn) => { fire = fn; return 1; }, clear: () => { fire = null; } }, d => isHomeDoorbellFor(d, ME));
        bell.ring({ type: 'group_member_removed', memberPubkey: 'c'.repeat(64) });
        expect(fire).toBeNull();
        bell.ring({ type: 'group_member_invited', member: member(ME) });
        (fire as unknown as () => void)();
        expect(ran).toHaveBeenCalledTimes(1);
    });
});

// ── The header ───────────────────────────────────────────────────────────────────────────────────────────────────

let root: Root | null = null;
let host: HTMLElement | null = null;
const invites = vi.hoisted(() => ({ list: [] as unknown[] }));

beforeEach(() => {
    resetHomeStoreForTests();
    nav.push.mockClear();
    invites.list = [{ groupId: GARDEN, name: 'Garden Club', category: 'social', joinPolicy: 'invite_only', invitedAt: '2026-10-24T08:00:00Z' }];
    vi.mocked(db.signedGet).mockReset();
    vi.mocked(db.signedGet).mockImplementation(async (p: string) => ({
        ok: true,
        json: async () => (String(p) === '/api/your-groups' ? { items: [], totalUnread: 0, invites: invites.list } : {}),
    }) as never);
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

const inviteIcon = () => document.querySelector('[data-icon="account-multiple-plus-outline"]');

describe('the header (components/NeedsYouIcons.tsx)', () => {
    it('reading the node itself: the invitation is an icon, labelled, that opens its landing', async () => {
        await renderHeader();
        expect(inviteIcon()).not.toBeNull();
        const button = inviteIcon()!.closest('button') as HTMLElement;
        expect(button.getAttribute('aria-label')).toBe("You're invited to join Garden Club");
        await act(async () => { button.click(); });
        expect(nav.push).toHaveBeenCalledWith({ pathname: '/group/[id]', params: { id: GARDEN, invited: '1' } });
    });

    it('no open invitation (or a node from before them): no icon', async () => {
        invites.list = [];
        await renderHeader();
        expect(inviteIcon()).toBeNull();
    });

    it("Home's answer from before the invitation: the member's own invite event stops the header drawing from it", async () => {
        // Home's answer, read a moment ago, with nothing in Needs you.
        vi.mocked(nodePost.signedGet).mockImplementation(async () => new Response(JSON.stringify({ profile: 'local', features: {}, cards: { needs: { items: [] } } }), { status: 200 }) as never);
        const read = await loadHome(NODE, IDENTITY as never, ['needs'], null);
        expect(read.kind).toBe('answer');
        expect(freshHomeForHeader(NODE, ME)).not.toBeNull();
        await renderHeader();
        // Drawn from Home's answer: the header asked the node nothing of its own.
        expect(vi.mocked(db.signedGet).mock.calls.map(([p]) => p)).not.toContain('/api/your-groups');

        // Someone else's invitation changes nothing.
        const ws = (data: unknown) => act(async () => { bus.listeners.get('ws_activity')?.forEach(fn => fn(data)); });
        await ws({ type: 'group_member_invited', groupId: CHOIR, member: { memberPubkey: 'c'.repeat(64), status: 'invited' } });
        expect(freshHomeForHeader(NODE, ME)).not.toBeNull();
        // Hers: the header's next read is its own (GET /api/your-groups lists what is open).
        await ws({ type: 'group_member_invited', groupId: GARDEN, member: { memberPubkey: ME, status: 'invited' } });
        expect(freshHomeForHeader(NODE, ME)).toBeNull();
    });
});
