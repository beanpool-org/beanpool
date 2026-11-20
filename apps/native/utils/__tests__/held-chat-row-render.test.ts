// @vitest-environment jsdom
/**
 * Chat's row for a chat held in another community (components/HeldChatRow.tsx, slices S1 and S2), rendered for real in
 * light and dark: the other person, that community's name in grey, the photo from that community's server as the row was
 * given it, and a tap handing the row itself back (app/(tabs)/chats.tsx openHeldChat). A direct chat opens in place (S2): its
 * row says the community's name alone and nothing of a switch. Any other chat still moves the phone there (S1): "· Switch",
 * and the screen reader's sentence saying so. Busy: no tap.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const flat = (s: unknown): Record<string, unknown> => Object.assign({}, ...[s].flat(3).filter(Boolean));
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, testID, style, accessibilityLabel, accessibilityHint, onPress, disabled } = props;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat(style)) };
        if (testID) attrs['data-testid'] = testID;
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityHint) attrs['aria-description'] = accessibilityHint;
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
    peer: 'Kai', peerAvatar: 'https://hilltop.example/uploads/kai.jpg', peerUpdatedAt: null, peerPubkey: 'b2'.repeat(32), peerKeys: ['b2'.repeat(32)], keyChanged: false,
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

/** A held chat that isn't a direct one (a kind S2 doesn't open in place): its tap still moves the phone there. */
const NOT_DIRECT: HeldChat = { ...ROW, id: 'b-other', key: 'held:community_hilltop.example_x.db:b-other', type: 'marketplace' };

describe('a chat held in another community, in Chat\'s list', () => {
    for (const dark of [false, true]) {
        const colors = dark ? darkColors : lightColors;
        it(`${dark ? 'dark' : 'light'}: a direct chat (opened in place, S2): the person, that community's name alone in grey, no switch said`, async () => {
            theme.dark = dark;
            await render(createElement(HeldChatRow, { item: ROW, busy: false, onOpen: () => {} }));
            const row = host.querySelector('[data-testid="held-chat-row"]')!;
            expect(row.textContent).toContain('Kai');
            const where = host.querySelector('[data-testid="held-chat-community"]')!;
            expect(where.textContent).toBe('Hilltop');
            expect(row.textContent).not.toContain('Switch');
            expect(styleOf(where).color).toBe(colors.text.secondary);
            // No label of its own: the name is the words the row shows (WCAG 2.5.3); no sentence of a switch it doesn't make.
            expect(row.getAttribute('aria-label')).toBeNull();
            expect(row.getAttribute('aria-description')).toBeNull();
            expect(seen.avatars).toEqual(['https://hilltop.example/uploads/kai.jpg']);
        });

        it(`${dark ? 'dark' : 'light'}: any other chat (S1): the person, that community's name in grey with "· Switch", and the screen reader hears both`, async () => {
            theme.dark = dark;
            await render(createElement(HeldChatRow, { item: NOT_DIRECT, busy: false, onOpen: () => {} }));
            const row = host.querySelector('[data-testid="held-chat-row"]')!;
            expect(row.textContent).toContain('Kai');
            const where = host.querySelector('[data-testid="held-chat-community"]')!;
            expect(where.textContent).toBe('Hilltop · Switch');
            // Grey: the theme's secondary text, never the body's or a raw colour.
            expect(styleOf(where).color).toBe(colors.text.secondary);
            // No label of its own: the name is the words the row shows (WCAG 2.5.3), "Switch" included; the longer sentence is the hint.
            expect(row.getAttribute('aria-label')).toBeNull();
            expect(row.getAttribute('aria-description')).toBe('Chat with Kai in Hilltop. Opens that community.');
            // The row's own photo, an address on that community's server, as getHeldConversations made it.
            expect(seen.avatars).toEqual(['https://hilltop.example/uploads/kai.jpg']);
        });
    }

    for (const dark of [false, true]) {
        const colors = dark ? darkColors : lightColors;
        it(`${dark ? 'dark' : 'light'}: S7c, a held direct chat waiting for the member there shows Chat's "key changed" tag in the warning colours; none otherwise`, async () => {
            theme.dark = dark;
            await render(createElement(HeldChatRow, { item: ROW, busy: false, onOpen: () => {} }));
            expect(host.querySelector('[data-testid="held-chat-key-changed"]')).toBeNull();
            await render(createElement(HeldChatRow, { item: { ...ROW, keyChanged: true }, busy: false, onOpen: () => {} }));
            const tag = host.querySelector('[data-testid="held-chat-key-changed"]')!;
            expect(tag.textContent).toBe('key changed');
            expect(styleOf(tag).backgroundColor).toBe(colors.feedback.warning.bg);
            expect(styleOf(tag.firstElementChild).color).toBe(colors.feedback.warning.fg);
            // Its words are part of the row's spoken name (no label of its own), so the row stays one button.
            expect(host.querySelector('[data-testid="held-chat-row"]')!.textContent).toContain('key changed');
            expect(tag.getAttribute('aria-label')).toBeNull();
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
