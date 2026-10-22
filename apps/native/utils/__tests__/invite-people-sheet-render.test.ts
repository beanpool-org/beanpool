// @vitest-environment jsdom
/**
 * Render test for phone InvitePeopleSheet mirroring web's InvitePeopleSheet.test.tsx:
 * - Active members say "In the group" (checked, disabled)
 * - Invited members say "Invited" (disabled, clock icon)
 * - Pending members say "Asked to join" (disabled)
 * - Accessible names for each state
 * - None of active, invited, or pending are selectable
 * - Uninvited members are selectable
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, Fragment, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', checkbox: 'checkbox' };
    const flat = (s: unknown): Record<string, unknown> => Object.assign({}, ...[s].flat(3).filter(Boolean));
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, disabled, placeholder, style } = props;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat(style)) };
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (disabled) attrs['aria-disabled'] = 'true';
        if (placeholder) attrs.placeholder = placeholder;
        return createElement(tag, attrs, typeof children === 'function' ? children({ pressed: false }) : children);
    };
    const FlatList = ({ data, renderItem, keyExtractor }: Record<string, any>) =>
        createElement('div', { 'data-list': 'true' },
            (data ?? []).map((item: any, index: number) =>
                createElement(Fragment, { key: keyExtractor ? keyExtractor(item, index) : String(index) }, renderItem({ item, index }))
            )
        );
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), TextInput: el('input'),
        FlatList,
        ActivityIndicator: () => createElement('span', null, '…'),
        Modal: ({ visible, children }: { visible: boolean; children?: ReactNode }) => (visible ? createElement('div', { 'data-modal': 'true' }, children) : null),
        StyleSheet: { create: (s: unknown) => s },
        Alert: { alert: vi.fn() },
    };
});

vi.mock('react-native-keyboard-controller', () => ({
    KeyboardController: { dismiss: vi.fn(async () => {}) },
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@expo/vector-icons', () => ({
    MaterialCommunityIcons: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }),
}));

vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = { theme: 'light', colors: lightColors };
    return { useTheme: () => ctx, useStyles: (make: (c: typeof ctx) => unknown) => make(ctx) };
});

vi.mock('../haptics', () => ({
    hapticTick: vi.fn(),
    hapticSuccess: vi.fn(),
    hapticWarning: vi.fn(),
}));

vi.mock('../use-node-profile', () => ({
    useNodeProfile: () => ({ features: {} }),
}));

vi.mock('../node-profile', () => ({
    membersByKey: () => false,
}));

vi.mock('../members-lookup', () => ({
    lookUpMembers: vi.fn(async () => []),
    searchPath: () => null,
}));

vi.mock('../community-list-note', () => ({
    pickerEmpty: () => ({ title: 'No one here yet', subtitle: '' }),
}));

vi.mock('../../components/MemberAvatar', () => ({
    MemberAvatar: ({ callsign }: { callsign: string }) => createElement('span', { 'data-avatar': callsign }),
}));

vi.mock('../../components/useModalKeyboardLift', () => ({
    useModalKeyboardLift: () => ({ lift: 0, maxHeight: 600 }),
}));

const ME = 'pk-me';
const ALICE = 'pk-alice';
const BOB = 'pk-bob';
const CHARLIE = 'pk-charlie';
const DAVE = 'pk-dave';

vi.mock('../db', () => ({
    getInvitablePeople: vi.fn(async () => [
        { publicKey: ME, callsign: 'Me', avatarUrl: null },
        { publicKey: ALICE, callsign: 'Alice', avatarUrl: null },
        { publicKey: BOB, callsign: 'Bob', avatarUrl: null },
        { publicKey: CHARLIE, callsign: 'Charlie', avatarUrl: null },
        { publicKey: DAVE, callsign: 'Dave', avatarUrl: null },
    ]),
    inviteGroupMemberApi: vi.fn(async () => ({ success: true })),
}));

vi.mock('../group-invite-send', () => ({
    sendGroupInvitations: vi.fn(async () => ({ sent: [], failed: [] })),
}));

import { InvitePeopleSheet } from '../../components/InvitePeopleSheet';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});

afterEach(async () => {
    await act(async () => { root?.unmount(); });
    host?.remove();
});

async function renderSheet(props: any) {
    await act(async () => {
        root.render(createElement(InvitePeopleSheet, props) as unknown as Parameters<Root['render']>[0]);
    });
    for (let i = 0; i < 6; i++) {
        await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    }
}

const text = () => host.textContent || '';
const buttonFor = (name: string) => Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes(name));
const press = async (el: Element) => {
    await act(async () => {
        (el as HTMLElement).click();
    });
    for (let i = 0; i < 4; i++) {
        await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    }
};

describe('InvitePeopleSheet member statuses and accessibility', () => {
    it('shows active, invited, and pending members with their three labels, none selectable', async () => {
        await renderSheet({
            isOpen: true,
            groupId: 'g-test',
            groupName: 'Test Group',
            existing: new Set([ALICE]),
            invited: new Set([BOB]),
            pending: new Set([CHARLIE]),
            myPubkey: ME,
            onClose: () => {},
        });

        // 1. Labels
        expect(text()).toContain('In the group');
        expect(text()).toContain('Invited');
        expect(text()).toContain('Asked to join');

        const aliceBtn = buttonFor('Alice');
        const bobBtn = buttonFor('Bob');
        const charlieBtn = buttonFor('Charlie');
        const daveBtn = buttonFor('Dave');

        expect(aliceBtn).toBeDefined();
        expect(bobBtn).toBeDefined();
        expect(charlieBtn).toBeDefined();
        expect(daveBtn).toBeDefined();

        // 2. Accessibility labels for each state
        expect(aliceBtn?.getAttribute('aria-label')).toBe('Alice, already in the group');
        expect(bobBtn?.getAttribute('aria-label')).toBe('Bob, already invited');
        expect(charlieBtn?.getAttribute('aria-label')).toBe('Charlie, asked to join');
        expect(daveBtn?.getAttribute('aria-label')).toBe('Dave');

        // 3. None selectable: clicking input/pressable does not select them
        await press(aliceBtn!);
        await press(bobBtn!);
        await press(charlieBtn!);

        expect(text()).toContain('Pick people to invite');

        // 4. Dave is invitable and selectable
        await press(daveBtn!);
        expect(text()).toContain('Invite 1 person');
    });

    // Walkthrough of 22 Oct at 320 dp with the text at 1.3x: "Search people in this community" showed as "Search people in this commu".
    it('uses the short placeholder "Search people", whole on one line at 320 dp and 1.3x', async () => {
        await renderSheet({
            isOpen: true,
            groupId: 'g-test',
            groupName: 'Test Group',
            existing: new Set(),
            myPubkey: ME,
            onClose: () => {},
        });
        const input = host.querySelector('input');
        expect(input?.getAttribute('placeholder')).toBe('Search people');

        // The box is the sheet's full 320 dp less its margin and padding, the magnifier (20 dp) and the gap before the
        // field. Glyphs at a generous 0.62em, as my-deals-history-320.test.ts measures.
        const style = (el: Element | null) => JSON.parse(el?.getAttribute('data-style') ?? '{}') as Record<string, number>;
        const box = style(input!.parentElement);
        const field = style(input);
        const room = 320 - 2 * box.margin - 2 * box.paddingHorizontal - 20 - field.marginLeft;
        const needed = input!.getAttribute('placeholder')!.length * field.fontSize * 1.3 * 0.62;
        expect(needed).toBeLessThanOrEqual(room);
    });
});
