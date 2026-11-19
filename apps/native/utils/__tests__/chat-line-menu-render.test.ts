// @vitest-environment jsdom
/**
 * Every chat's line menu at 320 dp × 1.3 with the most that screen stands over its thread (emulator walk 146, 17 Nov: in the
 * walk's market DM only Copy message showed, Reply and Edit sat above the thread's one line, and dragging the thread to reach
 * them closed the menu, so Replying to and Editing could not be started at all).
 *
 * One table over (light, dark) × screens (DM, group, event chat, outside chat, forum topic) × what stands over the thread ×
 * (phone, text size) × (keyboard down, up) × lines (someone else's with Report and a convenor's Remove, a four-line one, mine
 * with Edit, mine past the edit window with its note). The open line is the real ChatMessageRow with its menu, laid out by
 * Yoga (yoga-dom-layout.ts) at the phone's width and text size; the thread is the room that screen leaves it; the drag is the
 * real ChatMessageList's, fed the thread's and the open line's layouts as the phone hands them. In every row every action the
 * line allows (Reply, React, Edit, Delete, Remove, Copy, Report) is in view, or a scroll away with the menu still open, never
 * dropped; the thread keeps a line while the keyboard is down; and a line whose menu is all in view still closes on a drag.
 *
 * Then where the line is, not only how tall (#3288 review): a menu never stays open on a line the member can't see. Over tall
 * lines (two lines, five, a photo) × keyboard × the emoji row (none, over the line, under it, measured as Yoga places it outside
 * the cell) the thread is dragged until the line leaves, through its bottom (the newest line, dragged back) and through its top
 * (an older line, dragged toward the newest): while part of it is in view the menu stays open, and once none of it is, the menu
 * closes, a fling's resting place included. The newest line whose emoji row reaches past the thread's top keeps its menu on a drag.
 *
 * The outside chat's actions sit under the line in its own list, which no drag closes; the forum's ⋯ is a sheet over the
 * screen, laid out here at the phone's window. A guest chat's lines have no menu (their words are selectable), and the web
 * draws a line's actions in the line itself (MessagesPage, EventChat: wrapping, in the page's scroll), so nothing there opens
 * or closes. (Yoga's text is an estimate: the owed walk checks pixels.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, forwardRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as fs from 'node:fs';
import * as path from 'node:path';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const flat = vi.hoisted(() => ({ props: null as null | Record<string, any>, window: { width: 320, height: 569, fontScale: 1.3 } }));
vi.mock('react-native', async () => {
    const { createElement: h } = await import('react');
    const flatten = (style: unknown): Record<string, unknown> => (Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : (style as Record<string, unknown>) ?? {});
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, disabled, testID, style, numberOfLines } = props;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flatten(style)) };
        if (testID) attrs['data-testid'] = testID;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        return h(tag, attrs, typeof children === 'function' ? children({ pressed: false }) : children);
    };
    // The thread's FlatList: what ChatMessageList hands it is kept, so the table can lay it out and drag it as the phone does.
    const FlatList = forwardRef((props: Record<string, any>, _ref) => { flat.props = props; return h('div', { 'data-testid': 'flat-list' }); });
    return {
        // A Modal is a window of its own: the whole screen, over everything.
        View: el('div'), Text: el('span'), Pressable: el('div'),
        Modal: (p: Record<string, any>) => (p.visible ? el('div')({ children: p.children, style: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } }) : null),
        Image: el('img'), ScrollView: el('div'), FlatList, Linking: {}, StyleSheet: { create: (s: unknown) => s },
        AccessibilityInfo: { announceForAccessibility: () => {} },
        useWindowDimensions: () => ({ ...flat.window, scale: 1.5 }),
    };
});
vi.mock('react-native-keyboard-controller', () => ({ useKeyboardHandler: () => {}, KeyboardController: { dismiss: vi.fn(async () => {}) } }));
vi.mock('react-native-worklets', () => ({ scheduleOnRN: (fn: (...a: unknown[]) => void, ...a: unknown[]) => fn(...a) }));
vi.mock('expo-image-picker', () => ({}));
vi.mock('../../utils/keyboard-alert', () => ({ Alert: { alert: () => {} } }));
vi.mock('../../utils/forum', () => ({ forumPhotoUri: () => '' }));
vi.mock('../../utils/chat-photo', () => ({ chatPhotoDataUri: () => '', withinMs: () => true }));
vi.mock('../../utils/post-photo', () => ({ askPhotoSource: async () => null }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
const theme = vi.hoisted(() => ({ colors: null as any, name: 'light' as 'light' | 'dark' }));
vi.mock('../../app/ThemeContext', () => ({
    useTheme: () => ({ colors: theme.colors, theme: theme.name }),
    useStyles: (make: (c: { colors: unknown; theme: string }) => unknown) => make({ colors: theme.colors, theme: theme.name }),
}));

import { lightColors, darkColors } from '../../constants/colors';
import { ChatMessageRow } from '../../components/chat/ChatMessageRow';
import { ChatMessageList } from '../../components/chat/ChatMessageList';
import { ForumMenu } from '../../components/forum/ForumBits';
import { CHAT_INPUT_MIN_HEIGHT, makeChatStyles } from '../../components/chat/styles';
import { CHAT_THREAD_LINE, chatColumnFit } from '../chat-column-fit';
import type { ChatKind, ChatMessage, MessageActions } from '../chat-actions';
import { layOut } from './yoga-dom-layout';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); flat.props = null; });
afterEach(() => { act(() => root.unmount()); host.remove(); });

/**
 * The column under each screen's header (its bottom to the keyboard view's bottom) and the keyboard: the walk's phone from its
 * dump (480 × 854 px at 1.5), 320 × 533 with a 48-dp nav bar, and a tall phone; the window is what a sheet over it has.
 */
const PHONES = [
    { name: 'the walk\'s 320 × 569', width: 320, window: 569, column: 425, keyboard: 251 },
    { name: '320 × 533, 48-dp nav bar', width: 320, window: 533, column: 397, keyboard: 250 },
    { name: 'a tall phone, 412 × 915', width: 412, window: 915, column: 779, keyboard: 300 },
] as const;
type Phone = (typeof PHONES)[number];
type Scale = 1 | 1.3;

/** A line of text at a size, as the screens' styles set it (a line 1.25× its font unless the style says). */
const textLines = (n: number, size: number, s: Scale) => n * size * 1.25 * s;
/** The composer (components/chat/ChatComposer): 8 over a one-line field, 12 under it with the keyboard down (8 up), its border, and a two-line notice over it. */
const composer = (s: Scale, kbUp: boolean, notice: boolean) =>
    8 + Math.max(CHAT_INPUT_MIN_HEIGHT, Math.round(textLines(1, 16, s)) + 16) + (kbUp ? 8 : 12) + 1 + (notice ? Math.round(6 + textLines(2, 11, s)) : 0);
/** The Replying to / Editing banner on the composer (components/chat/ChatBanners: two lines, a 44-dp ✕). */
const banner = (s: Scale) => Math.max(54, Math.round(16 + textLines(1, 12, s) + textLines(1, 14, s)));

/**
 * What stands over each screen's thread, as it stacks it. The DM's from the walk's dump (the deals strip, the listing's header,
 * the release bar, the About chip) with the rooms chatColumnFit gives them while a line's menu is open; a group's (the key line,
 * the search row, Replying to, the key notice, the composer's notice: nothing gives way) and an event's (the note for people
 * going, the composer's notice) from their styles.
 */
interface Stack { name: string; screen: 'dm' | 'group' | 'event' | 'outside'; thread: (p: Phone, s: Scale, kbUp: boolean) => number }
const DM_BARS = { 1: 114 + 62 + 116, 1.3: 137 + 75 + 160 } as const;
const DM_ABOUT = { 1: 52, 1.3: 65 } as const;
const dmThread = (o: { about: boolean; reply: boolean; edit?: boolean }) => (p: Phone, s: Scale, kbUp: boolean) => {
    const kb = kbUp ? p.keyboard : 0;
    const input = composer(s, kbUp, false);
    const ban = o.reply || o.edit ? banner(s) : 0;
    const about = o.about && !o.edit ? DM_ABOUT[s] : 0;
    const fit = chatColumnFit({ column: p.column, box: input + ban + about, input, banner: ban, windowHeight: p.window, keyboard: kb, paused: false, menu: true });
    const shown = (content: number, room: number) => (content <= room ? content : room);
    return p.column - kb - shown(DM_BARS[s], fit.bars) - shown(about, fit.about) - Math.min(ban, fit.banner) - input;
};
const STACKS: Stack[] = [
    { name: 'DM: the walk\'s bars and the About chip', screen: 'dm', thread: dmThread({ about: true, reply: false }) },
    { name: 'DM: the walk\'s bars, the About chip and Replying to', screen: 'dm', thread: dmThread({ about: true, reply: true }) },
    { name: 'DM: the walk\'s bars and Editing message', screen: 'dm', thread: dmThread({ about: false, reply: false, edit: true }) },
    {
        name: 'group: the key line, the search row, Replying to, the key notice and the composer\'s notice', screen: 'group',
        thread: (p, s, kbUp) => p.column - (kbUp ? p.keyboard : 0) - Math.round(16 + textLines(2, 13, s)) - 48 - banner(s)
            - Math.round(12 + textLines(2, 13, s)) - composer(s, kbUp, true),
    },
    {
        name: 'event chat: a four-line note for people going and the composer\'s notice', screen: 'event',
        thread: (p, s, kbUp) => p.column - (kbUp ? p.keyboard : 0) - Math.round(24 + textLines(1, 11, s) + 4 + 4 * 21 * s) - composer(s, kbUp, true),
    },
];

/** The lines, each with every action it allows (utils/chat-actions decides which a screen offers; here, the most). */
interface Line { name: string; kind: ChatKind; isMe: boolean; text: string; actions: MessageActions; onReport: boolean; photo?: boolean }
const TWO = 'Yes, the trays are ready. Come by after four and bring the twine.';
const FOUR = 'The trays are ready on the back step. Come by after four, bring the twine if you have it, and the pots too; I will leave the gate open for you.';
const LINES: Line[] = [
    { name: 'someone else\'s line in a locked group, a convenor\'s menu', kind: 'group', isMe: false, text: TWO, onReport: true, actions: { reply: true, react: true, edit: false, delete: false, remove: true, report: true, copy: true } },
    { name: 'someone else\'s four-line line', kind: 'dm', isMe: false, text: FOUR, onReport: true, actions: { reply: true, react: true, edit: false, delete: false, remove: false, report: true, copy: true } },
    { name: 'my line', kind: 'dm', isMe: true, text: TWO, onReport: false, actions: { reply: true, react: true, edit: true, delete: true, remove: false, copy: true } },
    { name: 'my line past the edit window', kind: 'group', isMe: true, text: TWO, onReport: false, actions: { reply: true, react: true, edit: false, delete: true, remove: false, editClosed: true, copy: true } },
];
/** Tall lines, for the drag until the line leaves: someone else's of two lines and of five (Copy and Report under it), and a photo. */
const FIVE = 'The trays are ready on the back step by the tank. Come by after four, bring the twine if you have it, and the pots too, the big ones and the small. I will leave the gate open for you and the dog inside, so just let yourself in and take what you need.';
const OTHERS: MessageActions = { reply: true, react: true, edit: false, delete: false, remove: false, report: true, copy: true };
const TALL: Line[] = [
    { name: 'someone else\'s two-line line', kind: 'dm', isMe: false, text: TWO, onReport: true, actions: OTHERS },
    { name: 'someone else\'s five-line line', kind: 'dm', isMe: false, text: FIVE, onReport: true, actions: OTHERS },
    { name: 'someone else\'s photo', kind: 'dm', isMe: false, text: '', photo: true, onReport: true, actions: { ...OTHERS, copy: false } },
];
type EmojiRow = 'top' | 'bottom' | null;
const LABELS: [keyof MessageActions, string][] = [
    ['reply', 'Reply'], ['react', 'React'], ['edit', 'Edit message'], ['delete', 'Delete message'], ['remove', 'Remove this message'],
    ['copy', 'Copy message'], ['report', 'Report message'],
];

/**
 * The open line, laid out at the phone's width inside the list's padding: its height, where each action sits in it, and how far
 * its emoji row (when it is up) reaches past the cell, over it or under it, as Yoga places it (it is absolutely positioned).
 */
function openLine(line: Line, p: Phone, s: Scale, emojiRow: EmojiRow = null) {
    flat.window = { width: p.width, height: p.window, fontScale: s };
    const styles = makeChatStyles({ theme: theme.name, colors: theme.colors } as any) as any;
    const item = { id: 'line-1', text: line.text, senderId: line.isMe ? 'me' : 'ben', timestamp: Date.now(), type: line.photo ? 'image' : 'text' } as unknown as ChatMessage;
    act(() => root.render(createElement('div', { 'data-testid': 'list', 'data-style': JSON.stringify({ width: p.width, paddingHorizontal: 16 }) },
        createElement('div', { 'data-testid': 'cell', 'data-style': '{}' },
            createElement(ChatMessageRow, {
                item, isMe: line.isMe, styles, kind: line.kind, actions: line.actions, showActions: true, showEmojiPicker: !!emojiRow, pickerPosition: emojiRow ?? 'top',
                // A DM's photo is drawn 220 × 220 in its bubble (components/chat/DmChatImage).
                attachment: line.photo ? createElement('div', { 'data-style': JSON.stringify({ width: 220, height: 220 }) }) : undefined,
                onPressBubble: () => {}, onReply: () => {}, onToggleEmojiPicker: () => {}, onEdit: () => {}, onDelete: () => {}, onRemove: () => {},
                onReport: line.onReport ? () => {} : undefined, onPickEmoji: () => {},
            }))) as Parameters<Root['render']>[0]));
    const cell = host.querySelector('[data-testid="cell"]')!;
    const layout = layOut(host.querySelector('[data-testid="list"]')!, { width: p.width, height: 4000 }, { fontScale: s });
    const topIn = (el: Element) => { let y = 0; for (let e: Element | null = el; e && e !== cell; e = e.parentElement) y += layout.box(e).top; return y; };
    const actions = LABELS.filter(([k]) => line.actions[k] && (k !== 'report' || line.onReport)).map(([k, label]) => {
        const el = host.querySelector(`[aria-label="${label}"]`);
        return { k, label, el, top: el ? topIn(el) : NaN, height: el ? layout.height(el) : 0 };
    });
    const height = layout.height(cell);
    // Across the screen, in the list's coordinates (its padding is 16 on each side): the bubble and each round button.
    const list = host.querySelector('[data-testid="list"]')!;
    const across = (el: Element) => { let x = 0; for (let e: Element | null = el; e && e !== list; e = e.parentElement) x += layout.box(e).left; return { left: x, right: x + layout.width(el), top: topIn(el), bottom: topIn(el) + layout.height(el) }; };
    const bubbleEl = Array.from(host.querySelectorAll('[data-style]')).find((e) => { const st = JSON.parse(e.getAttribute('data-style') ?? '{}'); return st.maxWidth === '80%' && st.borderRadius === 12; });
    const bubble = bubbleEl ? across(bubbleEl) : null;
    const round = actions.filter((a) => a.el && ['reply', 'react', 'edit', 'delete', 'remove'].includes(a.k)).map((a) => ({ label: a.label, ...across(a.el!) }));
    const picker = host.querySelector('[aria-label^="React with"]')?.parentElement;
    if (emojiRow) expect(picker, 'the emoji row drawn').toBeTruthy();
    const reach = picker ? { above: Math.max(0, -topIn(picker)), below: Math.max(0, topIn(picker) + layout.height(picker) - height) } : { above: 0, below: 0 };
    return { height, actions, reach, bubble, round };
}
type OpenLine = ReturnType<typeof openLine>;

/** The newest line sits on the list's bottom padding (the list is inverted: its paddingTop is the gap over the composer). */
const LIST_BOTTOM = (makeChatStyles({ theme: 'light', colors: lightColors } as any) as any).listContent.paddingTop as number;

/**
 * The real ChatMessageList with a line's menu open, laid out as the phone lays it out: the thread's height, how far it is
 * scrolled, the open line's cell at `y` (counted up from the bottom of the list's content: the list is inverted) and its emoji
 * row. Then the drag, the scroll and a fling's resting place as the phone hands them, and whether the screen was told to close.
 * Each call is a thread of its own, unless `reopen`: the same thread, its menu closed and then opened again on the same line.
 */
let threadKey = 0;
function openThread(o: { thread: number; y: number; height: number; emojiRow?: EmojiRow; offset?: number; reopen?: boolean }) {
    const close = vi.fn();
    const styles = makeChatStyles({ theme: theme.name, colors: theme.colors } as any) as any;
    const list = (activeId: string | null) => createElement(ChatMessageList, {
        key: threadKey, listRef: { current: null }, items: [{ id: 'line-1' } as any], styles, renderMessage: () => null, activeId,
        activeEmojiRow: o.emojiRow ?? null, onCloseMenu: close, onAtBottomChange: () => {},
    }) as Parameters<Root['render']>[0];
    if (o.reopen) act(() => root.render(list(null)));
    else threadKey++;
    act(() => root.render(list('line-1')));
    const props = flat.props!;
    const at = (y: number) => ({ nativeEvent: { contentOffset: { x: 0, y } } });
    act(() => {
        props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 320, height: Math.max(0, o.thread) } } });
        if (o.offset) props.onScroll?.(at(o.offset));
        const cell = props.CellRendererComponent({ item: { id: 'line-1' }, style: {}, onLayout: () => {}, children: null });
        cell.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: o.y, width: 320, height: o.height } } });
    });
    return {
        closed: () => close.mock.calls.length > 0,
        drag: () => props.onScrollBeginDrag?.(at(0)),
        scrollTo: (offset: number) => props.onScroll?.(at(offset)),
        rest: (offset: number) => props.onMomentumScrollEnd?.(at(offset)),
    };
}

/**
 * The thread dragged from `start` until the open line leaves it, 2 dp a frame: `dir` 1 drags back through older lines (the
 * line leaves through the thread's bottom), -1 toward the newest (through its top). While part of the line, its menu or its
 * emoji row is in view the menu stays open; once none of it is, it is closed. And a fling from the same place whose scroll
 * events thinned out: only where it came to rest is heard, and the menu is closed.
 */
function dragUntilGone(o: { thread: number; y: number; start: number; dir: 1 | -1; open: OpenLine; emojiRow: EmojiRow }) {
    const low = o.y - o.open.reach.below;
    const high = o.y + o.open.height + o.open.reach.above;
    const shown = (offset: number) => Math.min(high, offset + o.thread) - Math.max(low, offset);
    // Half a dp covers the fractions of a measure, as the phone's thread counts it (chatLineInView).
    const all = low >= o.start - 0.5 && high <= o.start + o.thread + 0.5;
    const list = openThread({ thread: o.thread, y: o.y, height: o.open.height, emojiRow: o.emojiRow, offset: o.start });
    expect(list.closed(), 'in view when opened: open').toBe(false);
    list.drag();
    if (all) { expect(list.closed(), 'all of it in view: a drag closes the menu').toBe(true); return; }
    expect(list.closed(), `${shown(o.start).toFixed(0)} of its ${(high - low).toFixed(0)} dp in ${o.thread} dp of thread: a drag keeps the menu`).toBe(false);
    for (let offset = o.start, n = 0; ; offset += 2 * o.dir, n++) {
        list.scrollTo(offset);
        const left = shown(offset);
        if (left > 1) expect(list.closed(), `${left.toFixed(1)} dp of it in view, scrolled to ${offset}: open`).toBe(false);
        if (left <= 0) { expect(list.closed(), `none of it in view, scrolled to ${offset}: closed`).toBe(true); break; }
        expect(n, 'the line leaves').toBeLessThan(5000);
    }
    const fling = openThread({ thread: o.thread, y: o.y, height: o.open.height, emojiRow: o.emojiRow, offset: o.start });
    fling.drag();
    expect(fling.closed()).toBe(false);
    fling.rest(o.dir > 0 ? high + 2000 : low - o.thread - 2000);
    expect(fling.closed(), 'a fling past it: closed').toBe(true);
}

/** The newest line with its menu open, at rest on the thread's bottom, then the thread is dragged: whether the menu closes. */
function dragCloses(thread: number, line: number, emojiRow: EmojiRow = null): boolean {
    const list = openThread({ thread, y: LIST_BOTTOM, height: line, emojiRow });
    if (list.closed()) return true;
    list.drag();
    return list.closed();
}

describe.each([['light', lightColors], ['dark', darkColors]] as const)('every chat\'s line menu, %s: each action in view or a scroll away with the menu open', (name, colors) => {
    beforeEach(() => { theme.colors = colors; theme.name = name; });
    for (const stack of STACKS) for (const p of PHONES) for (const s of [1, 1.3] as const) for (const kbUp of [false, true]) for (const line of LINES) {
        it(`${stack.name}, ${p.name} at ${s}×, keyboard ${kbUp ? 'up' : 'down'}: ${line.name}`, () => {
            const thread = Math.round(stack.thread(p, s, kbUp));
            const open = openLine(line, p, s);
            // Every action the line allows is drawn: none dropped for want of room.
            expect(open.actions.length).toBeGreaterThan(0);
            for (const a of open.actions) expect(a.el, `${a.label} drawn`).not.toBeNull();
            // While the keyboard is down every screen leaves the thread a line, so the line can be tapped and scrolled.
            if (!kbUp) expect(thread, 'a line of thread').toBeGreaterThanOrEqual(CHAT_THREAD_LINE);
            const closes = dragCloses(thread, open.height);
            // The newest line sits on the list's bottom padding (the list is inverted): in view is what is under the thread's top.
            const viewTop = open.height + LIST_BOTTOM - thread;
            // A thread that shows none of the line (the keyboard up and the box's banners on the smallest phone): the member can't
            // see it, so its menu closes, and the bars it folded come back (#3288 review). The keyboard goes down to read.
            if (thread <= LIST_BOTTOM) { expect(kbUp, 'only with the keyboard up').toBe(true); expect(closes, 'none of the line in view: closed').toBe(true); return; }
            for (const a of open.actions) {
                const inView = a.top >= viewTop - 0.5;
                if (inView) continue;
                // Not in view: a scroll of the thread brings it, so the menu stays open while the thread is dragged, and with
                // the keyboard down the thread shows the action whole once scrolled. (With the keyboard up and a banner on the
                // box, the composer and the banner come first and the thread has what is left, less than a line on 320 × 533:
                // the keyboard goes down to read, as #3283 designed.)
                expect(closes, `${a.label} at ${a.top.toFixed(0)} of a ${open.height.toFixed(0)}-dp line in ${thread} dp of thread: a drag must not close the menu`).toBe(false);
                if (!kbUp) expect(thread, 'room to show the action once scrolled').toBeGreaterThanOrEqual(Math.min(a.height, CHAT_THREAD_LINE));
            }
            // A line and its menu all in view: a drag still closes it, as before.
            if (open.height + LIST_BOTTOM <= thread) expect(closes, 'all in view: a drag closes the menu').toBe(true);
        });
    }
});

/**
 * Across the screen (emulator walk 147, 20 Nov 2026, 320 dp at 1.3× text, Light and Dark, a DM in place and one in the
 * community in use): Reply, React, Edit and Delete beside my two-line line pushed it past the screen's right edge, its words
 * cut, because the line kept its width beside them. Now they go to a line of their own over mine (under someone else's) when
 * the two don't fit, and stay beside a short line as before. Every line of the table, every phone, both text sizes: the
 * bubble and each round button lie inside the list's padding, and never over each other.
 */
const SHORT: Line[] = [
    { name: 'my short line', kind: 'dm', isMe: true, text: 'Yes.', onReport: false, actions: { reply: true, react: true, edit: true, delete: true, remove: false, copy: true } },
    { name: 'someone else\'s short line', kind: 'dm', isMe: false, text: 'Yes.', onReport: true, actions: OTHERS },
    { name: 'my one-letter line', kind: 'dm', isMe: true, text: 'k', onReport: false, actions: { reply: true, react: true, edit: true, delete: true, remove: false, copy: true } },
];
describe.each([['light', lightColors], ['dark', darkColors]] as const)('a line and its round buttons stay inside the screen, %s', (name, colors) => {
    beforeEach(() => { theme.colors = colors; theme.name = name; });
    const overlap = (a: { left: number; right: number; top: number; bottom: number }, b: typeof a) =>
        Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
    for (const p of PHONES) for (const s of [1, 1.3] as const) for (const line of [...LINES, ...TALL.slice(0, 2), ...SHORT]) {
        it(`${p.name} at ${s}×: ${line.name}`, () => {
            const open = openLine(line, p, s);
            const inner = { left: 16, right: p.width - 16 };
            expect(open.bubble, 'the bubble drawn').not.toBeNull();
            const b = open.bubble!;
            expect(b.left, 'the line starts inside the list').toBeGreaterThanOrEqual(inner.left - 0.5);
            expect(b.right, `the line ends inside the list (${b.right.toFixed(1)} of ${inner.right})`).toBeLessThanOrEqual(inner.right + 0.5);
            expect(open.round.length, 'round buttons drawn').toBeGreaterThan(0);
            for (const r of open.round) {
                expect(r.left, `${r.label} starts inside the list`).toBeGreaterThanOrEqual(inner.left - 0.5);
                expect(r.right, `${r.label} ends inside the list (${r.right.toFixed(1)} of ${inner.right})`).toBeLessThanOrEqual(inner.right + 0.5);
                expect(overlap(r, b), `${r.label} clear of the line`).toBe(false);
            }
            // Mine stay at the right: my line keeps to the list's right edge.
            if (line.isMe) expect(b.right, 'my line at the right').toBeGreaterThan(inner.right - 1);
            // Beside the line when the two fit in its row (85% of the list, the buttons' 8-dp margin included), as before; else
            // on a line of their own, over mine or under someone else's, never beside it and cut.
            const bar = { left: Math.min(...open.round.map((r) => r.left)), right: Math.max(...open.round.map((r) => r.right)), top: Math.min(...open.round.map((r) => r.top)), bottom: Math.max(...open.round.map((r) => r.bottom)) };
            const fits = (b.right - b.left) + (bar.right - bar.left) + 8 <= 0.85 * (p.width - 32) + 0.5;
            if (fits) {
                expect(bar.top < b.bottom && bar.bottom > b.top, 'beside the line: on its band').toBe(true);
                if (line.isMe) expect(bar.right, 'left of my line').toBeLessThanOrEqual(b.left + 0.5);
                else expect(bar.left, 'right of their line').toBeGreaterThanOrEqual(b.right - 0.5);
            } else if (line.isMe) {
                expect(bar.bottom, 'over my line').toBeLessThanOrEqual(b.top + 0.5);
                // At the right, in from its edge by the buttons' own 8-dp margin (styles actionButtonsMe).
                expect(bar.right, 'at the right, over my line').toBeGreaterThan(inner.right - 8 - 1);
            } else {
                expect(bar.top, 'under their line').toBeGreaterThanOrEqual(b.bottom - 0.5);
            }
        });
    }
});

describe('the outside chat\'s actions and the forum\'s ⋯', () => {
    beforeEach(() => { theme.colors = darkColors; theme.name = 'dark'; });
    it('the outside chat draws a line\'s actions under it in its own list, which no drag closes', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'outside-chat', '[id].tsx'), 'utf8');
        const list = src.slice(src.indexOf('<FlatList'), src.indexOf('renderItem='));
        expect(list).toContain('testID=');
        expect(list).not.toMatch(/onScrollBeginDrag|onScroll=\{[^}]*set/);
        expect(src).toMatch(/\{reactions\}\s*\{actions\}\s*<\/View>/);
    });
    it('a guest chat\'s lines open no menu: their words are selectable', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'guest-chat', '[id].tsx'), 'utf8');
        expect(src).not.toMatch(/onLongPress|activeMessageActionsId|ChatMessageRow/);
        expect(src.match(/selectable>/g)?.length).toBeGreaterThanOrEqual(2);
    });
    // The most a post's ⋯ holds (forum/[id].tsx menuItems): Reply · Copy · Report · Block {name} · Cancel; a topic's writer's:
    // Mute · Close · Link · Make this a Need · Cancel.
    const POST = ['Reply', 'Copy', 'Report', 'Block Bartholomew Riverside-Hilltop', 'Cancel'];
    for (const p of PHONES) for (const s of [1, 1.3] as const) {
        it(`a forum post's ⋯ at ${p.name}, ${s}×: every row in the window, each a 48-dp target`, () => {
            act(() => root.render(createElement('div', { 'data-testid': 'window', 'data-style': JSON.stringify({ width: p.width, height: p.window }) },
                createElement(ForumMenu, { label: 'Close', items: POST.map((w) => [w, () => {}] as any), onClose: () => {} })) as Parameters<Root['render']>[0]));
            const win = host.querySelector('[data-testid="window"]')!;
            const layout = layOut(win, { width: p.width, height: p.window }, { fontScale: s });
            const sheet = host.querySelector('[data-testid="forum-menu"]')!;
            const topIn = (el: Element) => { let y = 0; for (let e: Element | null = el; e && e !== win; e = e.parentElement) y += layout.box(e).top; return y; };
            expect(topIn(sheet)).toBeGreaterThanOrEqual(0);
            const rows = Array.from(sheet.children);
            expect(rows).toHaveLength(POST.length);
            for (const r of rows) {
                expect(topIn(r)).toBeGreaterThanOrEqual(0);
                expect(topIn(r) + layout.height(r)).toBeLessThanOrEqual(p.window);
                expect(layout.height(r)).toBeGreaterThanOrEqual(48);
            }
        });
    }
});

describe('the check can fail', () => {
    beforeEach(() => { theme.colors = darkColors; theme.name = 'dark'; });
    it('the walk\'s line and its menu in a group with its most bars is taller than the thread, and a drag that always closed lost Reply', () => {
        const p = PHONES[0];
        const thread = Math.round(STACKS.find((x) => x.screen === 'group')!.thread(p, 1.3, false));
        const open = openLine(LINES[0], p, 1.3);
        expect(open.height).toBeGreaterThan(thread);
        const reply = open.actions.find((a) => a.k === 'reply')!;
        expect(reply.top).toBeLessThan(open.height + LIST_BOTTOM - thread);
        // Main before this change: ChatMessageList handed every drag to the screen, which closed the menu.
        expect(dragCloses(thread, open.height)).toBe(false);
        expect(dragCloses(open.height + LIST_BOTTOM, open.height)).toBe(true);
    });
    it('a tall line kept open on a drag and dragged until it left: the head of #3288 kept its menu open for good', () => {
        const p = PHONES[0];
        const thread = Math.round(STACKS[1].thread(p, 1.3, true));
        const open = openLine(TALL[1], p, 1.3);
        expect(open.height).toBeGreaterThan(thread);
        const list = openThread({ thread, y: LIST_BOTTOM, height: open.height });
        list.drag();
        expect(list.closed()).toBe(false);
        list.scrollTo(LIST_BOTTOM + open.height + 1);
        expect(list.closed()).toBe(true);
    });
});

describe('a line\'s menu closes once the line has left the thread; a drag keeps it while part of it is out of view (#3288 review)', () => {
    // Where things are doesn't change with the theme: the dark one, as below.
    beforeEach(() => { theme.colors = darkColors; theme.name = 'dark'; });
    for (const stack of STACKS) for (const p of PHONES) for (const s of [1, 1.3] as const) for (const kbUp of [false, true]) for (const line of TALL) {
        for (const emojiRow of [null, 'top', 'bottom'] as const) {
            const row = emojiRow === 'top' ? 'the emoji row over it' : emojiRow === 'bottom' ? 'the emoji row under it' : 'no emoji row';
            it(`${stack.name}, ${p.name} at ${s}×, keyboard ${kbUp ? 'up' : 'down'}: ${line.name}, ${row}`, () => {
                const thread = Math.round(stack.thread(p, s, kbUp));
                const open = openLine(line, p, s, emojiRow);
                if (emojiRow === 'top') expect(open.reach.above, 'the row reaches past the cell\'s top').toBeGreaterThan(30);
                if (emojiRow === 'bottom') expect(open.reach.below, 'the row reaches past the cell\'s bottom').toBeGreaterThan(30);
                if (thread <= LIST_BOTTOM) {
                    // No line of thread to see (the keyboard up, the box's banners, the smallest phone): the menu closes.
                    expect(kbUp).toBe(true);
                    expect(dragCloses(thread, open.height, emojiRow), 'none of the line in view: closed').toBe(true);
                    return;
                }
                // The newest line, on the list's bottom padding, dragged back through older lines until it leaves at the bottom.
                dragUntilGone({ thread, y: LIST_BOTTOM, start: 0, dir: 1, open, emojiRow });
                // An older line with its lowest edge at the thread's middle, dragged toward the newest until it leaves at the top.
                const y = 5000;
                dragUntilGone({ thread, y, start: y - open.reach.below - thread / 2, dir: -1, open, emojiRow });
            });
        }
    }
    it('the newest line whose emoji row reaches past the thread\'s top keeps its menu on a drag, and closes once it has left', () => {
        const p = PHONES[0];
        const open = openLine(TALL[0], p, 1.3, 'top');
        // The line and its menu fit under the thread's top; its emoji row does not (the review's 218-dp line in 240 dp of thread).
        const thread = Math.round(LIST_BOTTOM + open.height + open.reach.above / 2);
        expect(LIST_BOTTOM + open.height).toBeLessThanOrEqual(thread);
        expect(dragCloses(thread, open.height, 'top'), 'its emoji row half out of view: a drag keeps the menu').toBe(false);
        expect(dragCloses(thread, open.height, null), 'the same line without its emoji row, all in view: a drag closes').toBe(true);
        dragUntilGone({ thread, y: LIST_BOTTOM, start: 0, dir: 1, open, emojiRow: 'top' });
    });
    it('a line opened again is placed by its new layout, never where it was the last time it was open', () => {
        const list = openThread({ thread: 240, y: LIST_BOTTOM, height: 120 });
        expect(list.closed()).toBe(false);
        // Closed; new lines pushed it up the thread; the member scrolled to it and opened it again.
        const again = openThread({ thread: 240, y: 900, height: 120, offset: 840, reopen: true });
        expect(again.closed()).toBe(false);
        again.drag();
        expect(again.closed(), 'all of it in view: a drag closes the menu').toBe(true);
    });
});

describe('every chat hands its menu\'s closing to ChatMessageList, which decides', () => {
    it('the DM, the group and the event chat close the menu only through ChatMessageList\'s onCloseMenu, and say where the emoji row is', () => {
        for (const f of [['app', 'chat', '[id].tsx'], ['components', 'GroupChatView.tsx'], ['components', 'EventChatView.tsx']]) {
            const src = fs.readFileSync(path.join(__dirname, '..', '..', ...f), 'utf8');
            expect(src, f.join('/')).toContain('<ChatMessageList');
            expect(src.match(/onCloseMenu=/g), f.join('/')).toHaveLength(1);
            expect(src, f.join('/')).not.toContain('onScrollBeginDrag=');
            // The event chat draws no emoji row (showEmojiPicker={false}); the DM and the group say which side it opens on.
            if (f[1] !== 'EventChatView.tsx') expect(src, f.join('/')).toContain('activeEmojiRow={activeEmojiPickerId ? pickerPosition : null}');
            else expect(src).toContain('showEmojiPicker={false}');
        }
        const list = fs.readFileSync(path.join(__dirname, '..', '..', 'components', 'chat', 'ChatMessageList.tsx'), 'utf8');
        expect(list).toContain('onScrollBeginDrag={onCloseMenu ? onDrag : undefined}');
        expect(list).toContain('onScroll={onAtBottomChange || onCloseMenu ? onScroll : undefined}');
        expect(list).toContain('onMomentumScrollEnd={onCloseMenu ? onScrollEnd : undefined}');
    });
});
