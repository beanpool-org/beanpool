// @vitest-environment jsdom
/**
 * Who votes on a group's vote, on the phone (#1784 review B1, N1, N2, N3): the vote's own roll as the node sends it
 * (each card's canVote), never who is in the group now. Someone removed or made an observer mid-vote still votes; someone
 * who joined since is not offered it. The node's half is test-decisions-group section 7; the web's is
 * GroupDetailModal.votes.test.tsx; the refused-chat landing's is group-chat-refused-render.test.ts.
 *
 * Rendered for real (#1794 N9: this file used to match the source text, which caught a rename but not a wrong gate):
 * the real GroupDecisions block and GroupDetailModal sheet, react-dom in jsdom with React Native's host components as
 * plain tags (as enterprise-decisions-render.test.ts does), and a stubbed node behind utils/db.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ScopedDecisionCard, ScopedDecisionList } from '@beanpool/core';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', radio: 'radio' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, disabled, testID, value, onChangeText } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        ActivityIndicator: () => createElement('span', null, '…'),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', null, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {} },
        Alert: { alert: vi.fn() },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('react-native-keyboard-controller', () => ({
    useKeyboardState: (pick: (s: { height: number; isVisible: boolean }) => unknown) => pick({ height: 0, isVisible: false }),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = { theme: 'light', colors: lightColors };
    return { useTheme: () => ctx, useStyles: (make: (c: typeof ctx) => unknown) => make(ctx) };
});
vi.mock('../haptics', () => ({ hapticTick: vi.fn(), hapticSuccess: vi.fn() }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => null }));
// The quiet-lead panel is its own component with its own reads: here only whether the sheet draws it.
vi.mock('../../components/GroupSuccessionPanel', () => ({ GroupSuccessionPanel: () => createElement('div', { 'data-testid': 'succession' }) }));
const node = vi.hoisted(() => ({ decisions: null as ScopedDecisionList | null, group: null as unknown, members: [] as unknown[] }));
vi.mock('../db', () => ({
    getGroupDecisions: vi.fn(async () => node.decisions),
    proposeGroupDecision: vi.fn(async () => ({})),
    voteGroupDecision: vi.fn(async () => ({})),
    getEnterpriseDecisions: vi.fn(), proposeEnterpriseDecision: vi.fn(), voteEnterpriseDecision: vi.fn(),
    fetchGroupDetails: vi.fn(async () => ({ group: node.group, members: node.members })),
    joinGroupApi: vi.fn(), leaveGroupApi: vi.fn(), approveGroupMemberApi: vi.fn(), setGroupMemberRoleApi: vi.fn(),
    handOverGroupLeadApi: vi.fn(), updateGroupApi: vi.fn(),
}));

import { GroupDecisions } from '../../components/EnterpriseDecisions';
import { GroupDetailModal } from '../../components/GroupDetailModal';

const G = 'b78da72e-773f-4425-914a-8bfbd4e4130a';
const ANN = 'a'.repeat(64), BOB = 'b'.repeat(64), SUE = '5'.repeat(64), ME = 'c'.repeat(64);

function card(over: Partial<ScopedDecisionCard> = {}): ScopedDecisionCard {
    return {
        id: 'd1', authorPubkey: ANN, title: 'Close the group', description: 'We have done what we met for.',
        effect: 'close_group', subject: null, params: null, status: 'open',
        opensAt: new Date(Date.now() - 3600_000).toISOString(), closesAt: new Date(Date.now() + 6 * 86400_000).toISOString(),
        tally: { voted: 1, roll: 5, quorumRequired: 3, thresholdRequired: 0.6 }, myVote: null, ...over,
    } as ScopedDecisionCard;
}
const list = (over: Partial<ScopedDecisionList> & Record<string, unknown> = {}): ScopedDecisionList =>
    ({ decisions: [card()], canPropose: false, rollSize: 5, onRoll: true, watching: false, nameable: [ANN, BOB, ME], closedAt: null, ...over }) as ScopedDecisionList;

const PEOPLE = [
    { pubkey: ANN, name: 'Ann', role: 'lead' },
    { pubkey: BOB, name: 'Bob', role: 'member' },
    { pubkey: SUE, name: 'Sue', role: 'member' },
    { pubkey: ME, name: 'Me', role: 'convenor' },
] as const;

let host: HTMLDivElement;
let root: Root;

async function settle() {
    for (let i = 0; i < 10; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}
async function mount(element: unknown) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root.render(element as Parameters<Root['render']>[0]); });
    await settle();
}
const block = () => mount(createElement(GroupDecisions, { groupId: G, myPubkey: ME, people: [...PEOPLE] }));
const text = () => host.textContent || '';
const yes = () => host.querySelector('button[aria-label^="Vote Yes"]');
const button = (re: RegExp) => Array.from(host.querySelectorAll('button')).find(b => re.test(b.getAttribute('aria-label') || b.textContent || ''));
const radios = () => Array.from(host.querySelectorAll('[role=radio]')).map(r => r.textContent || '');
async function press(el: Element | null | undefined) {
    expect(el, 'the control is there').toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle();
}

beforeEach(() => {
    node.decisions = list();
    node.group = null;
    node.members = [];
});
afterEach(async () => {
    await act(async () => { root?.unmount(); });
    host?.remove();
});

describe("a group's votes follow each vote's own roll", () => {
    it("Yes / No from the card's canVote, never the list's onRoll: someone removed mid-vote still votes", async () => {
        node.decisions = list({ decisions: [card({ canVote: true })], onRoll: false });
        await block();
        expect(yes(), 'Yes / No for a vote whose roll they are on').toBeTruthy();
    });

    it('someone who joined since the vote opened is not offered it, though on the roll of the group now', async () => {
        node.decisions = list({ decisions: [card({ canVote: false })], onRoll: true });
        await block();
        expect(text()).toContain('Close the group');
        expect(yes()).toBeNull();
    });

    it('"You watch" only for an observer the node says watches (none of the open votes takes theirs)', async () => {
        node.decisions = list({ decisions: [card({ canVote: false })], onRoll: false, watching: true });
        await block();
        expect(text()).toContain("You watch this group, so you see its votes but don't vote.");
    });

    it('no "You watch" for someone made an observer mid-vote, who still votes on it', async () => {
        node.decisions = list({ decisions: [card({ canVote: true })], onRoll: false, watching: false });
        await block();
        expect(text()).not.toContain('You watch this group');
        expect(yes()).toBeTruthy();
    });

    it('no "You watch" in a closed group', async () => {
        node.decisions = list({ decisions: [card({ status: 'passed' as ScopedDecisionCard['status'], canVote: false })], watching: true, closedAt: new Date().toISOString() });
        await block();
        expect(text()).not.toContain('You watch this group');
    });
});

describe('the pickers offer only the people the node names (#1784 review N2: no suspended member)', () => {
    for (const choice of ['Remove someone', 'Choose a new lead convenor']) {
        it(`${choice}: Bob, never Sue (suspended)`, async () => {
            node.decisions = list({ canPropose: true, nameable: [ANN, BOB, ME] });
            await block();
            await press(button(/^Propose a vote$/));
            await press(Array.from(host.querySelectorAll('[role=radio]')).find(r => r.textContent === choice));
            expect(radios()).toContain('Bob');
            expect(radios()).not.toContain('Sue');
        });
    }

    it('a node that names nobody (no nameable): everyone in the group now', async () => {
        node.decisions = list({ canPropose: true, nameable: undefined });
        await block();
        await press(button(/^Propose a vote$/));
        await press(Array.from(host.querySelectorAll('[role=radio]')).find(r => r.textContent === 'Remove someone'));
        expect(radios()).toEqual(expect.arrayContaining(['Bob', 'Sue']));
    });
});

describe("the group's info sheet", () => {
    const group = (over: Record<string, unknown> = {}) => ({
        id: G, name: 'Bakers', slug: 'bakers', description: null, avatarUrl: null, category: 'guild', createdBy: ANN,
        joinPolicy: 'open', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z', memberCount: 3,
        leadPubkey: ANN, closedAt: null, viewerStatus: 'active', viewerRole: 'member', ...over,
    });
    const row = (pk: string, callsign: string, role: string) => ({ groupId: G, memberPubkey: pk, callsign, role, status: 'active', joinedAt: '2026-08-01T00:00:00Z', invitedBy: null });
    const roster = [row(ANN, 'Ann', 'convenor'), row(BOB, 'Bob', 'member')];
    const sheet = () => mount(createElement(GroupDetailModal, { group: node.group as any, isOpen: true, onClose: () => { }, myPubkey: ME }));

    it('draws the votes for anyone the node answers: someone removed mid-vote sees them, with Yes / No', async () => {
        node.group = group({ viewerStatus: 'removed', viewerRole: null });
        node.members = roster;
        node.decisions = list({ decisions: [card({ canVote: true })], onRoll: true });
        await sheet();
        expect(host.querySelector('[aria-label="Decisions"]'), 'the votes block').toBeTruthy();
        expect(yes()).toBeTruthy();
    });

    it('the quiet-lead vote panel for a member of an open group', async () => {
        node.group = group();
        node.members = [...roster, row(ME, 'Me', 'member')];
        await sheet();
        expect(host.querySelector('[data-testid="succession"]')).toBeTruthy();
    });

    it('no quiet-lead vote panel in a closed group (#1784 review N3)', async () => {
        node.group = group({ closedAt: new Date().toISOString() });
        node.members = [...roster, row(ME, 'Me', 'member')];
        await sheet();
        expect(text()).toContain('Bakers');
        expect(host.querySelector('[data-testid="succession"]')).toBeNull();
    });
});
