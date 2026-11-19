// @vitest-environment jsdom
/**
 * Chat's "Message requests" row (components/MessageRequestsRow.tsx, utils/requests-seen.ts), the other-community lines
 * (components/OtherCommunityNotices.tsx) and the list's "In {community}" cards (components/RequestsElsewhereCards.tsx),
 * rendered for real, light and dark (Marty, 19 Nov 2026): the row shows how many wait and a small red dot until the list has
 * been opened since the newest came; with none waiting there is no row. Since S0 (decision 4 of
 * DESIGN-no-switch-messaging-fable.md) the row counts every community the phone holds, each with its own card in the list,
 * and a line about another community is for its messages alone.
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
import { RequestsElsewhereCards } from '../../components/RequestsElsewhereCards';
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

/** A new screen on the same phone (an app start): the hook reads the kept mark again, as Chat does when it mounts. */
function restart() {
    act(() => { root?.unmount(); });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
}

beforeEach(() => {
    store.clear();
    theme.dark = false;
    restart();
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

    it('a cold start before global answers (null) keeps a seen count seen, and a real fall there is still followed (PR #3298 review)', async () => {
        const onGlobal = (n: number | null): RequestsWaiting => ({ here: { count: 0, conversations: [] }, onGlobal: n, outside: [], guestInvites: [] });
        await show(createElement(Screen, { waiting: onGlobal(2), open: true }));
        // Each start: the mark is read first, global not known yet (chats.tsx's useState(null)), then global says the same 2.
        for (let start = 0; start < 2; start++) {
            restart();
            await show(createElement(Screen, { waiting: onGlobal(null), open: false }));
            await show(createElement(Screen, { waiting: onGlobal(2), open: false }));
            expect(row()).not.toBeNull();
            expect(dot()).toBeNull();
        }
        // Answered on global itself (2 → 1): followed, so the next one there (→ 2) shows the dot.
        await show(createElement(Screen, { waiting: onGlobal(1), open: false }));
        expect(dot()).toBeNull();
        await show(createElement(Screen, { waiting: onGlobal(2), open: false }));
        expect(dot()).not.toBeNull();
    });

    it('a late-delivered outside request lights the dot: this phone\'s time for it, never its sender\'s (PR #3298 review)', async () => {
        const T = Date.parse('2026-11-19T10:00:00Z');
        const A = { id: 'a', state: 'request', lastAt: T + 3_600_000, updatedAt: T + 3_900_000 };
        const B = { id: 'b', state: 'request', lastAt: T, updatedAt: T + 7_200_000 };
        const outside = (...cs: Array<typeof A>): RequestsWaiting => ({ here: { count: 0, conversations: [] }, onGlobal: 0, outside: cs, guestInvites: [] });
        await show(createElement(Screen, { waiting: outside(A), open: true }));
        restart();
        await show(createElement(Screen, { waiting: outside(A), open: false }));
        expect(dot()).toBeNull();
        await show(createElement(Screen, { waiting: outside(A, B), open: false }));
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
        { url: 'https://hill.example', name: 'Hillside', count: 1 },
        { url: 'https://vale.example', name: 'Valley', count: 2 },
    ];
    it('is for its messages alone: its requests are the Message requests row\'s (S0)', async () => {
        const opened: string[] = [];
        await show(createElement(OtherCommunityNotices, { notices, busy: false, onOpen: (url: string) => opened.push(url) }));
        expect(host.querySelector('[data-testid="other-community-notice-https://hill.example"]')?.textContent).toBe('1 new message in Hillside · Switch');
        expect(host.querySelector('[data-testid="other-community-notice-https://vale.example"]')?.textContent).toBe('2 new messages in Valley · Switch');
        expect(host.textContent).not.toMatch(/request/i);
        await act(async () => { (host.querySelector('[data-testid="other-community-notice-https://vale.example"]') as HTMLElement).click(); });
        expect(opened).toEqual(['https://vale.example']);
    });
});

describe('requests in the phone\'s other communities (Marty, 19 Nov 2026, S0)', () => {
    const places = [
        { address: 'https://hill.example', url: 'https://hill.example/', name: 'Hillside Neighbours Network', count: 1 },
        { address: 'https://world.example', url: 'https://world.example', name: 'Global community', count: 3 },
    ];
    const card = (address: string) => host.querySelector(`[data-testid="message-requests-in-${address}"]`);

    it('are in the row\'s count, and light its dot until the list is opened, then again for one more there', async () => {
        const away = (hill: number): RequestsWaiting => ({ here: { count: 1, conversations: one.here!.conversations }, onGlobal: null, outside: [], guestInvites: [], elsewhere: { 'https://hill.example': hill, 'https://vale.example': 0 } });
        await show(createElement(Screen, { waiting: away(2), open: false }));
        expect(host.querySelector('[data-testid="message-requests-count"]')?.textContent).toBe('3');
        expect(dot()).not.toBeNull();
        await show(createElement(Screen, { waiting: away(2), open: true }));
        // Back to the chats, and an app start that reads the mark before the counts: no dot.
        await show(createElement(Screen, { waiting: away(2), open: false }));
        expect(dot()).toBeNull();
        restart();
        await show(createElement(Screen, { waiting: { ...away(2), elsewhere: null }, open: false }));
        await show(createElement(Screen, { waiting: away(2), open: false }));
        expect(dot()).toBeNull();
        await show(createElement(Screen, { waiting: away(3), open: false }));
        expect(host.querySelector('[data-testid="message-requests-count"]')?.textContent).toBe('4');
        expect(dot()).not.toBeNull();
    });

    it('each have a card "In {community}" that opens that community\'s requests, light and dark, and wait while a move is under way', async () => {
        for (const dark of [false, true]) {
            theme.dark = dark;
            const opened: string[] = [];
            await show(createElement(RequestsElsewhereCards, { places, busy: false, note: null, onOpen: (p: { url: string }) => opened.push(p.url) }));
            expect(card('https://hill.example')?.textContent).toBe('1 person wants to message youIn Hillside Neighbours NetworkOpen their requests there');
            expect(card('https://world.example')?.textContent).toBe('3 people want to message youIn Global communityOpen their requests there');
            const colors = dark ? darkColors : lightColors;
            expect(style(card('https://hill.example')).backgroundColor).toBe(colors.surface.card);
            expect(style(card('https://hill.example')).borderWidth).toBe(1);
            await act(async () => { (card('https://hill.example') as HTMLElement).click(); });
            expect(opened).toEqual(['https://hill.example/']);
        }
        await show(createElement(RequestsElsewhereCards, { places, busy: true, note: 'Something went wrong. Try again in a moment.', onOpen: () => {} }));
        expect(style(card('https://hill.example')).opacity).toBe(0.7);
        expect(host.querySelector('[data-testid="message-requests-elsewhere-note"]')?.textContent).toBe('Something went wrong. Try again in a moment.');
        await show(createElement(RequestsElsewhereCards, { places: [], busy: false, onOpen: () => {} }));
        expect(host.textContent).toBe('');
    });
});
