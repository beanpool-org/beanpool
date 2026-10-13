// @vitest-environment jsdom
/**
 * The phone's refused-chat screen (components/GroupChatView.tsx, its `error && !view` branch) rendered for real: the
 * real utils/db reading a stubbed node over fetch, the real GroupDecisions block, react-dom in jsdom with React
 * Native's host components as plain tags (as enterprise-decisions-render.test.ts does).
 *
 * Someone removed from a group mid-vote reads no chat, but is still on the vote's roll: a vote's push or Home's line
 * lands them here with info=1 (#1784 review B1). The line over the votes says "you can still vote" only when a vote
 * still takes theirs, and only when the node refused the chat (403 or 404), never on a read that just failed (#1794,
 * the review's "related gap on the phone"). This replaces group-decisions-roll.test.ts's check of the source text.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ScopedDecisionCard, ScopedDecisionList } from '@beanpool/core';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', radio: 'radio', alert: 'alert' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        FlatList: () => null,
        ActivityIndicator: () => createElement('span', null, '…'),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', null, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {} },
        Alert: { alert: vi.fn() },
        Linking: { openURL: vi.fn() },
        AppState: { currentState: 'active', addEventListener: () => ({ remove: () => { } }) },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('react-native-keyboard-controller', () => ({
    useKeyboardState: (pick: (s: { height: number; isVisible: boolean }) => unknown) => pick({ height: 0, isVisible: false }),
    KeyboardAvoidingView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
    KeyboardController: { dismiss: async () => { }, setInputMode: () => { } },
    AndroidSoftInputModes: {},
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('expo-router', () => ({ router: { canGoBack: () => true, back: vi.fn(), replace: vi.fn(), push: vi.fn() }, useFocusEffect: () => { } }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = { theme: 'light', colors: lightColors };
    return { useTheme: () => ctx, useStyles: (make: (c: typeof ctx) => unknown) => make(ctx) };
});
const ME = 'c'.repeat(64);
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: { publicKey: ME, callsign: 'Me' } }) }));
// The poll's first tick is immediate (utils/chat-poll): one read on the way in, nothing on a timer.
vi.mock('../../components/chat/useChatPoll', async () => {
    const { useEffect } = await import('react');
    return { useChatPoll: (load: () => unknown) => { useEffect(() => { load(); }, [load]); } };
});
vi.mock('../../components/chat/useChatSoftInputMode', () => ({ useChatSoftInputMode: () => { } }));
vi.mock('../../components/useYourGroups', () => ({
    yourGroupsStore: { getState: () => ({ items: [] }), markRead: vi.fn(), setMute: vi.fn() },
}));
vi.mock('../haptics', () => ({ hapticTick: vi.fn(), hapticSuccess: vi.fn(), hapticWarning: vi.fn() }));
// The chat's own pieces never draw on this screen (no chat to show); the info sheet stays shut (no group read).
vi.mock('../../components/chat/ChatMessageList', () => ({ ChatMessageList: () => null, scrollChatToBottom: () => { } }));
vi.mock('../../components/chat/ChatMessageRow', () => ({ ChatMessageRow: () => null }));
vi.mock('../../components/chat/ChatComposer', () => ({ ChatComposer: () => null }));
vi.mock('../../components/chat/ChatBanners', () => ({ ChatEditBanner: () => null, ChatMenuSheet: () => null, ChatReplyBanner: () => null }));
vi.mock('../../components/InvitePeopleSheet', () => ({ InvitePeopleSheet: () => null }));
vi.mock('../../components/GroupDetailModal', () => ({ GroupDetailModal: () => null }));

// utils/db's device modules, stubbed at the boundary (the same set as check-invite-ticket.test.ts).
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => (k === 'beanpool_anchor_url' ? 'https://test.beanpool.org' : null)),
        setItem: vi.fn(async () => { }),
        removeItem: vi.fn(async () => { }),
        getAllKeys: vi.fn(async () => []),
    },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid' }));
vi.mock('expo-file-system/legacy', () => ({ cacheDirectory: '/tmp/cache/' }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => null) }));
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn(), addSavedNode: vi.fn() }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(), saveCanonicalProfile: vi.fn() }));

import { GroupChatView } from '../../components/GroupChatView';

const G = 'b78da72e-773f-4425-914a-8bfbd4e4130a';
const ANN = 'a'.repeat(64), BOB = 'b'.repeat(64);
const REFUSED = 'Only members of this group can open its chat.';

function card(over: Partial<ScopedDecisionCard> = {}): ScopedDecisionCard {
    return {
        id: 'd1', authorPubkey: ANN, title: 'Make Bob the lead convenor', description: 'Ann is stepping back.',
        effect: 'replace_lead', subject: BOB, params: null, status: 'open',
        opensAt: new Date(Date.now() - 3600_000).toISOString(), closesAt: new Date(Date.now() + 6 * 86400_000).toISOString(),
        tally: { voted: 1, roll: 4, quorumRequired: 3, thresholdRequired: 0.6 }, myVote: null,
        names: { [ANN]: 'Ann', [BOB]: 'Bob' }, ...over,
    } as ScopedDecisionCard;
}

/** What the stubbed node answers: the chat (a status, or a dropped connection) and the votes. */
const node = vi.hoisted(() => ({ chat: 403 as number | 'offline', decisions: null as unknown }));

function reply(status: number, body: unknown) {
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

beforeEach(() => {
    node.chat = 403;
    node.decisions = { decisions: [card({ canVote: true })], canPropose: false, rollSize: 4, onRoll: true, watching: false, nameable: [], closedAt: null } satisfies ScopedDecisionList;
    (globalThis as any).fetch = vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === `/api/groups/${G}/chat`) {
            if (node.chat === 'offline') throw new TypeError('Network request failed');
            return reply(node.chat, { error: node.chat === 500 ? 'Something went wrong.' : REFUSED });
        }
        if (path === `/api/groups/${G}/decisions`) return reply(node.decisions ? 200 : 404, node.decisions ?? { error: 'Not found' });
        // The group itself: refused to someone not in it, so the info sheet never opens over the landing.
        return reply(403, { error: REFUSED });
    });
});

let host: HTMLDivElement;
let root: Root;

afterEach(async () => {
    await act(async () => { root?.unmount(); });
    host?.remove();
});

async function render(props: { openInfo?: boolean } = { openInfo: true }) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root.render(createElement(GroupChatView, { kind: 'group', id: G, initialName: 'Bakers', ...props }) as unknown as Parameters<Root['render']>[0]);
    });
    for (let i = 0; i < 12; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

const text = () => host.textContent || '';
const yes = () => Array.from(host.querySelectorAll('button')).find(b => /Vote Yes|^Yes$/.test(b.getAttribute('aria-label') || b.textContent || ''));
const CAN = "You're not in this group now, but you were when these votes opened, so you can still vote on them.";
const PART = "You're not in this group now. These are the votes you were part of.";

describe('the refused-chat screen, landed on from a vote (info=1)', () => {
    it('someone removed mid-vote: the node\'s refusal, then the votes, with "you can still vote" and Yes / No', async () => {
        await render();
        expect(text()).toContain(REFUSED);
        expect(host.querySelector('[aria-label="Decisions"]'), 'the votes block').toBeTruthy();
        expect(text()).toContain(CAN);
        expect(text()).not.toContain(PART);
        expect(text()).toContain('Make Bob the lead convenor');
        expect(yes(), 'Yes / No for a vote that still takes theirs').toBeTruthy();
    });

    it('a 404 (the node does not show them the group now) reads the same', async () => {
        node.chat = 404;
        await render();
        expect(text()).toContain(CAN);
    });

    it('no vote still takes theirs (they left mid-vote, or the votes closed): only what is true, and no Yes / No', async () => {
        node.decisions = { decisions: [card({ canVote: false })], canPropose: false, rollSize: 4, onRoll: false, watching: false, nameable: [], closedAt: null };
        await render();
        expect(text()).toContain(PART);
        expect(text()).not.toMatch(/can still vote/);
        expect(yes()).toBeFalsy();
    });

    it('no votes to show: no line about them either', async () => {
        node.decisions = null;
        await render();
        expect(text()).toContain(REFUSED);
        expect(host.querySelector('[aria-label="Decisions"]')).toBeNull();
        expect(text()).not.toContain("You're not in this group now");
    });
});

describe('only a refusal says "not in this group"', () => {
    for (const [what, chat] of [['the node failed the read (500)', 500], ['the connection dropped', 'offline']] as const) {
        it(`${what}: the votes the node answers show, with no line about who is in the group`, async () => {
            node.chat = chat;
            await render();
            expect(host.querySelector('[aria-label="Decisions"]'), 'the votes block').toBeTruthy();
            expect(text()).not.toContain("You're not in this group now");
        });
    }
});

describe('the votes show only on a vote\'s landing', () => {
    it('opened from the chat list (no info=1): the refusal and Try again, and no votes', async () => {
        await render({ openInfo: false });
        expect(text()).toContain(REFUSED);
        expect(text()).toContain('Try again');
        expect(host.querySelector('[aria-label="Decisions"]')).toBeNull();
    });
});
