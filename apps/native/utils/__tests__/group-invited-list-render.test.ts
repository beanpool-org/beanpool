// @vitest-environment jsdom
/**
 * "Invited, not joined yet" on the phone's group page (components/GroupInvitedList.tsx; Rob via Marty, 11 Nov 2026:
 * "Invitations should show whether they have been used"). The node decides who may see what (GET
 * /api/groups/:id/invitations); the phone draws what it is given, says when and by whom, offers Withdraw on a pending row
 * only, asks first, reads again after, and draws nothing when the node says nothing. The web's twin is
 * apps/pwa/src/components/GroupInvitedList.test.tsx; 320 dp at 1.3× is e2e/group-invited-list-320.mjs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Alert } from 'react-native';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button' };
    const flat = (s: unknown): Record<string, unknown> => Object.assign({}, ...[s].flat(3).filter(Boolean));
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, disabled, style, testID } = props;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat(style)) };
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (disabled) attrs['aria-disabled'] = 'true';
        return createElement(tag, attrs, typeof children === 'function' ? children({ pressed: false }) : (children as ReactNode));
    };
    return {
        View: el('div'), Text: el('span'), Pressable: el('button'),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 },
        Alert: { alert: vi.fn() },
    };
});

vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = { theme: 'light', colors: lightColors };
    return { useTheme: () => ctx, useStyles: (make: (c: typeof ctx) => unknown) => make(ctx) };
});

vi.mock('../haptics', () => ({ hapticSuccess: vi.fn(), hapticTick: vi.fn(), hapticWarning: vi.fn() }));

vi.mock('../../components/MemberAvatar', () => ({
    MemberAvatar: ({ callsign }: { callsign: string }) => createElement('span', { 'data-avatar': callsign }),
}));

const node = vi.hoisted(() => ({ answer: null as unknown, withdraw: null as null | ((g: string, pk: string) => Promise<boolean>) }));
vi.mock('../db', () => ({
    fetchGroupInvitations: vi.fn(async () => {
        const { readGroupInvitations } = await import('@beanpool/core');
        return readGroupInvitations(node.answer);
    }),
    withdrawGroupInvitationApi: vi.fn(async (g: string, pk: string) => (node.withdraw ? node.withdraw(g, pk) : true)),
}));

import { GroupInvitedList } from '../../components/GroupInvitedList';
import { fetchGroupInvitations, withdrawGroupInvitationApi } from '../db';

const ME = 'pk-cleo';
const DAYS_AGO = (d: number) => new Date(Date.now() - d * 86400_000).toISOString();
const convenorAnswer = () => ({
    view: 'convenor', pendingTotal: 2,
    pending: [
        { memberPubkey: 'pk-mia', callsign: 'Mia', invitedAt: DAYS_AGO(2), invitedBy: { pubkey: ME, callsign: 'Cleo' } },
        { memberPubkey: 'pk-nat', callsign: 'Nat', invitedAt: DAYS_AGO(1), invitedBy: { pubkey: 'pk-cas', callsign: 'Cas' } },
    ],
    declined: [],
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    vi.clearAllMocks();
    node.answer = convenorAnswer();
    node.withdraw = null;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});

afterEach(async () => {
    await act(async () => { root?.unmount(); });
    host?.remove();
});

async function settle() {
    for (let i = 0; i < 6; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}
async function show(props: Record<string, unknown> = {}) {
    await act(async () => {
        root.render(createElement(GroupInvitedList as any, { groupId: 'g-1', myPubkey: ME, ...props }) as unknown as Parameters<Root['render']>[0]);
    });
    await settle();
}
const rows = (id: string) => Array.from(host.querySelectorAll(`[data-testid="${id}"]`)) as HTMLElement[];
const alertCall = () => vi.mocked(Alert.alert).mock.calls[0] as unknown as [string, string, Array<{ text: string; style?: string; onPress?: () => void | Promise<void> }>];

describe('Invited, not joined yet (the phone)', () => {
    it('lists each name with when they were invited and by whom, "you" for a convenor\'s own', async () => {
        await show();
        const list = rows('group-invited-row');
        expect(list).toHaveLength(2);
        expect(host.textContent).toContain('INVITED, NOT JOINED YET (2)');
        expect(list[0].textContent).toContain('Mia');
        expect(list[0].textContent).toContain('Invited 2 days ago by you');
        expect(list[1].textContent).toContain('Invited 1 day ago by Cas');
        expect(fetchGroupInvitations).toHaveBeenCalledWith('g-1');
    });

    it("a member's own view says when, and names no one else", async () => {
        node.answer = { view: 'sender', pendingTotal: 1, pending: [{ memberPubkey: 'pk-ola', callsign: 'Ola', invitedAt: DAYS_AGO(3) }], declined: [] };
        await show({ myPubkey: 'pk-hal' });
        const [row] = rows('group-invited-row');
        expect(row.textContent).toContain('Invited 3 days ago');
        expect(row.textContent).not.toContain(' by ');
    });

    it('shows a declined invitation as Declined, dated, with no Withdraw, and says only the sender sees it', async () => {
        node.answer = {
            view: 'convenor', pendingTotal: 0, pending: [],
            declined: [{ memberPubkey: 'pk-mia', callsign: 'Mia', invitedAt: DAYS_AGO(5), declinedAt: DAYS_AGO(4) }],
        };
        await show();
        const [row] = rows('group-declined-row');
        expect(row.textContent).toContain('Mia');
        expect(row.textContent).toContain('Declined 4 days ago');
        expect(row.querySelector('button')).toBeNull();
        expect(rows('group-invited-row')).toHaveLength(0);
        expect(host.textContent).toContain('DECLINED INVITATIONS YOU SENT');
        expect(host.textContent).toContain('Nobody else in the group sees these.');
    });

    it('draws nothing when the node says nothing, or there is nothing to say', async () => {
        node.answer = { error: 'Not found' };
        await show();
        expect(host.querySelector('[data-testid="group-invited-list"]')).toBeNull();
        node.answer = { view: 'sender', pendingTotal: 0, pending: [], declined: [] };
        await show({ reloadKey: 1 });
        expect(host.querySelector('[data-testid="group-invited-list"]')).toBeNull();
    });

    it('says how many more there are than the page holds', async () => {
        node.answer = { ...convenorAnswer(), pendingTotal: 230 };
        await show();
        expect(host.textContent).toContain('INVITED, NOT JOINED YET (230)');
        expect(host.textContent).toContain('and 228 more');
    });

    it('asks first, and withdraws only when agreed to; then reads again and tells the page around it', async () => {
        const changed = vi.fn();
        await show({ onChanged: changed });
        const [mia] = rows('group-invited-withdraw');
        expect(mia.getAttribute('aria-label')).toBe('Withdraw the invitation to Mia');
        await act(async () => { mia.click(); });
        expect(withdrawGroupInvitationApi).not.toHaveBeenCalled();
        const [title, question, buttons] = alertCall();
        expect(title).toBe('Withdraw the invitation?');
        expect(question).toBe('The invitation to Mia is taken back. You can invite them again.');
        expect(buttons.map(b => b.text)).toEqual(['Cancel', 'Withdraw']);
        // Agreed to: the node takes it back, and what it answers next has no Mia.
        node.answer = { ...convenorAnswer(), pendingTotal: 1, pending: [convenorAnswer().pending[1]] };
        await act(async () => { await buttons[1].onPress?.(); });
        await settle();
        expect(withdrawGroupInvitationApi).toHaveBeenCalledWith('g-1', 'pk-mia');
        expect(rows('group-invited-row')).toHaveLength(1);
        expect(host.textContent).not.toContain('Mia');
        expect(changed).toHaveBeenCalledTimes(1);
    });

    it("says the node's words when a withdrawal is refused, and keeps the row", async () => {
        node.withdraw = async () => { throw new Error('Only a group convenor can remove members, or a member may leave themselves'); };
        await show();
        await act(async () => { rows('group-invited-withdraw')[0].click(); });
        const [, , buttons] = alertCall();
        vi.mocked(Alert.alert).mockClear();
        await act(async () => { await buttons[1].onPress?.(); });
        await settle();
        const [failedTitle, failedBody] = alertCall();
        expect(failedTitle).toBe('Could not withdraw the invitation');
        expect(String(failedBody)).toContain('Only a group convenor can remove members');
        expect(rows('group-invited-row')).toHaveLength(2);
    });
});
