// @vitest-environment jsdom
/**
 * Chat's row for a chat held in another community (components/HeldChatRow.tsx, slice S1), rendered for real in light and
 * dark: the other person, that community's name in grey with "· Switch" (a tap still moves the phone there), the screen
 * reader's words naming both, the photo from that community's server as the row was given it, and a tap handing the row
 * itself back, so the screen moves to that row's community and chat (app/(tabs)/chats.tsx openHeldChat). Busy: no tap.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const flat = (s: unknown): Record<string, unknown> => Object.assign({}, ...[s].flat(3).filter(Boolean));
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, testID, style, accessibilityLabel, onPress, disabled } = props;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat(style)) };
        if (testID) attrs['data-testid'] = testID;
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (onPress) attrs.onClick = disabled ? undefined : onPress;
        if (disabled) attrs.disabled = true;
        return createElement(tag, attrs, children);
    };
    return { View: el('div'), Text: el('span'), Pressable: el('button'), StyleSheet: { create: (s: unknown) => s } };
});
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
const seen = vi.hoisted(() => ({ avatars: [] as Array<string | null | undefined> }));
vi.mock('../../components/MemberAvatar', async () => {
    const { createElement: ce } = await import('react');
    return { MemberAvatar: (p: { avatarUrl: string | null }) => { seen.avatars.push(p.avatarUrl); return ce('i', { 'data-avatar': p.avatarUrl ?? '' }); } };
});
const theme = vi.hoisted(() => ({ dark: false }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors, darkColors } = await import('../../constants/colors');
    const colors = () => (theme.dark ? darkColors : lightColors);
    return {
        useTheme: () => ({ theme: theme.dark ? 'dark' : 'light', colors: colors() }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: theme.dark ? 'dark' : 'light', colors: colors() }),
    };
});

import { HeldChatRow } from '../../components/HeldChatRow';
import type { HeldChatRow as HeldChat } from '../held-chats';
import { lightColors, darkColors } from '../../constants/colors';

const ROW: HeldChat = {
    id: 'b-dm', key: 'held:community_hilltop.example_x.db:b-dm', held: true, type: 'dm', postId: null, postTitle: null, postPhoto: null,
    peer: 'Kai', peerAvatar: 'https://hilltop.example/uploads/kai.jpg', peerUpdatedAt: null, peerPubkey: 'b2'.repeat(32), peerKeys: ['b2'.repeat(32)],
    rawTimestamp: '2026-11-18T10:00:00.000Z', createdAt: null, community: 'https://hilltop.example', communityName: 'Hilltop',
};

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    host = document.createElement('div');
    document.body.innerHTML = '';
    document.body.appendChild(host);
    root = createRoot(host);
    seen.avatars.length = 0;
});
const render = async (el: unknown) => { await act(async () => { root.render(el as any); }); };
const styleOf = (el: Element | null) => JSON.parse(el?.getAttribute('data-style') ?? '{}');

describe('a chat held in another community, in Chat\'s list', () => {
    for (const dark of [false, true]) {
        const colors = dark ? darkColors : lightColors;
        it(`${dark ? 'dark' : 'light'}: the person, that community's name in grey with "· Switch", and the screen reader hears both`, async () => {
            theme.dark = dark;
            await render(createElement(HeldChatRow, { item: ROW, busy: false, onOpen: () => {} }));
            const row = host.querySelector('[data-testid="held-chat-row"]')!;
            expect(row.textContent).toContain('Kai');
            const where = host.querySelector('[data-testid="held-chat-community"]')!;
            expect(where.textContent).toBe('Hilltop · Switch');
            // Grey: the theme's secondary text, never the body's or a raw colour.
            expect(styleOf(where).color).toBe(colors.text.secondary);
            expect(row.getAttribute('aria-label')).toBe('Chat with Kai in Hilltop. Opens that community.');
            // The row's own photo, an address on that community's server, as getHeldConversations made it.
            expect(seen.avatars).toEqual(['https://hilltop.example/uploads/kai.jpg']);
        });
    }

    it('a tap hands back the row itself (its community and its chat), and none while a switch is under way', async () => {
        const opened: HeldChat[] = [];
        await render(createElement(HeldChatRow, { item: ROW, busy: false, onOpen: (c: HeldChat) => opened.push(c) }));
        await act(async () => { (host.querySelector('[data-testid="held-chat-row"]') as HTMLButtonElement).click(); });
        expect(opened).toEqual([ROW]);
        await render(createElement(HeldChatRow, { item: ROW, busy: true, onOpen: (c: HeldChat) => opened.push(c) }));
        await act(async () => { (host.querySelector('[data-testid="held-chat-row"]') as HTMLButtonElement).click(); });
        expect(opened).toEqual([ROW]);
    });
});
