// @vitest-environment jsdom
/**
 * Chat's "Message requests" row (components/MessageRequestsRow.tsx, utils/requests-seen.ts) and the other-community lines
 * (components/OtherCommunityNotices.tsx), rendered for real, light and dark (Marty, 19 Nov 2026): the row shows how many
 * wait and a small red dot until the list has been opened since the newest came; with none waiting there is no row. A line
 * about another community says "message request" when that is what waits there, and a real message keeps its wording.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const flat = (s: unknown): Record<string, unknown> => Object.assign({}, ...[s].flat(3).filter(Boolean));
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, testID, style, accessibilityLabel, accessibilityHint, onPress } = props;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat(typeof style === 'function' ? style({ pressed: false }) : style)) };
        if (testID) attrs['data-testid'] = testID;
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityHint) attrs['data-hint'] = accessibilityHint;
        if (onPress) attrs.onClick = onPress;
        return createElement(tag, attrs, children);
    };
    return { View: el('div'), Text: el('span'), Pressable: el('button'), StyleSheet: { create: (s: unknown) => s } };
});
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
const theme = vi.hoisted(() => ({ dark: false }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors, darkColors } = await import('../../constants/colors');
    const colors = () => (theme.dark ? darkColors : lightColors);
    return {
        useTheme: () => ({ theme: theme.dark ? 'dark' : 'light', colors: colors() }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: theme.dark ? 'dark' : 'light', colors: colors() }),
    };
});
const store = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.delete(k); }),
    },
}));

import type { RequestsWaiting } from '@beanpool/core';
import { requestsRowCount } from '@beanpool/core';
import { MessageRequestsRow } from '../../components/MessageRequestsRow';
import { OtherCommunityNotices } from '../../components/OtherCommunityNotices';
import { useRequestsUnseen } from '../requests-seen';
import { lightColors, darkColors } from '../../constants/colors';

const ME = 'a'.repeat(64);
const NODE = 'https://riverside.example';

/** The screen's part: the row from what waits, the dot from the kept mark (app/(tabs)/chats.tsx). */
function Screen({ waiting, open }: { waiting: RequestsWaiting; open: boolean }) {
    const unseen = useRequestsUnseen(ME, NODE, waiting, open);
    return open ? null : createElement(MessageRequestsRow, { count: requestsRowCount(waiting), unseen, onPress: () => {} });
}

let root: Root | null = null;
let host: HTMLElement;
async function show(el: unknown): Promise<HTMLElement> {
    await act(async () => { root!.render(el as Parameters<Root['render']>[0]); });
    await act(async () => {});
    await act(async () => {});
    return host;
}
const req = (at: string) => ({ request: { at } });
const one: RequestsWaiting = { here: { count: 1, conversations: [req('2026-11-19T10:00:00Z')] }, onGlobal: 0, outside: [], guestInvites: [] };
const row = () => host.querySelector('[data-testid="message-requests-row"]');
const dot = () => host.querySelector('[data-testid="message-requests-dot"]');
const style = (el: Element | null) => JSON.parse(el?.getAttribute('data-style') ?? '{}');

beforeEach(() => {
    store.clear();
    theme.dark = false;
    root?.unmount();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});

describe('the Message requests row', () => {
    it('shows the count in a pill and the red dot while a request is unopened, light and dark', async () => {
        for (const dark of [false, true]) {
            theme.dark = dark;
            store.clear();
            const two: RequestsWaiting = { ...one, here: { count: 1, conversations: one.here!.conversations }, onGlobal: 1 };
            await show(createElement(Screen, { waiting: two, open: false }));
            expect(row()?.textContent).toContain('Message requests');
            expect(host.querySelector('[data-testid="message-requests-count"]')?.textContent).toBe('2');
            expect(row()?.getAttribute('aria-label')).toBe('Message requests: 2 waiting');
            expect(dot()).not.toBeNull();
            expect(row()?.getAttribute('data-hint')).toBe('New since you last looked');
            const colors = dark ? darkColors : lightColors;
            expect(style(dot()).backgroundColor).toBe(colors.feedback.danger.solid);
            // A card with a border: it reads as something to tap, not a heading.
            expect(style(row()).backgroundColor).toBe(colors.surface.card);
            expect(style(row()).borderWidth).toBe(1);
        }
    });

    it('loses the dot once the list has been opened, and gets it back for a newer request', async () => {
        await show(createElement(Screen, { waiting: one, open: false }));
        expect(dot()).not.toBeNull();
        // The member opens the list: the row goes while it shows, and the mark is kept.
        await show(createElement(Screen, { waiting: one, open: true }));
        expect(row()).toBeNull();
        expect([...store.keys()].some((k) => k.startsWith('beanpool_message_requests_seen:'))).toBe(true);
        // Back to the chats: the row, the count, no dot.
        await show(createElement(Screen, { waiting: one, open: false }));
        expect(row()).not.toBeNull();
        expect(dot()).toBeNull();
        expect(row()?.getAttribute('data-hint')).toBeNull();
        // A newer request comes.
        const newer: RequestsWaiting = { ...one, here: { count: 2, conversations: [req('2026-11-19T11:00:00Z'), ...one.here!.conversations] } };
        await show(createElement(Screen, { waiting: newer, open: false }));
        expect(host.querySelector('[data-testid="message-requests-count"]')?.textContent).toBe('2');
        expect(dot()).not.toBeNull();
    });

    it('is not there with no request waiting, as before', async () => {
        await show(createElement(Screen, { waiting: { here: { count: 0, conversations: [] }, onGlobal: 0, outside: [], guestInvites: [] }, open: false }));
        expect(row()).toBeNull();
        expect(host.textContent).toBe('');
    });
});

describe('the line about another community', () => {
    const notices = [
        { url: 'https://hill.example', name: 'Hillside', count: 0, requests: 1 },
        { url: 'https://vale.example', name: 'Valley', count: 2, requests: 3 },
    ];
    it('says message request when a request waits there, and a real message keeps its wording', async () => {
        const opened: string[] = [];
        await show(createElement(OtherCommunityNotices, { notices, busy: false, onOpen: (url: string, what: string) => opened.push(`${what} ${url}`) }));
        expect(host.querySelector('[data-testid="other-community-requests-https://hill.example"]')?.textContent).toBe('1 message request in Hillside · Switch');
        expect(host.querySelector('[data-testid="other-community-notice-https://hill.example"]')).toBeNull();
        expect(host.querySelector('[data-testid="other-community-notice-https://vale.example"]')?.textContent).toBe('2 new messages in Valley · Switch');
        expect(host.querySelector('[data-testid="other-community-requests-https://vale.example"]')?.textContent).toBe('3 message requests in Valley · Switch');
        await act(async () => { (host.querySelector('[data-testid="other-community-requests-https://hill.example"]') as HTMLElement).click(); });
        await act(async () => { (host.querySelector('[data-testid="other-community-notice-https://vale.example"]') as HTMLElement).click(); });
        expect(opened).toEqual(['requests https://hill.example', 'messages https://vale.example']);
    });
});
