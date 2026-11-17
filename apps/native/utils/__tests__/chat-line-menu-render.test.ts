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
interface Line { name: string; kind: ChatKind; isMe: boolean; text: string; actions: MessageActions; onReport: boolean }
const TWO = 'Yes, the trays are ready. Come by after four and bring the twine.';
const FOUR = 'The trays are ready on the back step. Come by after four, bring the twine if you have it, and the pots too; I will leave the gate open for you.';
const LINES: Line[] = [
    { name: 'someone else\'s line in a locked group, a convenor\'s menu', kind: 'group', isMe: false, text: TWO, onReport: true, actions: { reply: true, react: true, edit: false, delete: false, remove: true, report: true, copy: true } },
    { name: 'someone else\'s four-line line', kind: 'dm', isMe: false, text: FOUR, onReport: true, actions: { reply: true, react: true, edit: false, delete: false, remove: false, report: true, copy: true } },
    { name: 'my line', kind: 'dm', isMe: true, text: TWO, onReport: false, actions: { reply: true, react: true, edit: true, delete: true, remove: false, copy: true } },
    { name: 'my line past the edit window', kind: 'group', isMe: true, text: TWO, onReport: false, actions: { reply: true, react: true, edit: false, delete: true, remove: false, editClosed: true, copy: true } },
];
const LABELS: [keyof MessageActions, string][] = [
    ['reply', 'Reply'], ['react', 'React'], ['edit', 'Edit message'], ['delete', 'Delete message'], ['remove', 'Remove this message'],
    ['copy', 'Copy message'], ['report', 'Report message'],
];

/** The open line, laid out at the phone's width inside the list's padding: its height and where each action sits in it. */
function openLine(line: Line, p: Phone, s: Scale) {
    flat.window = { width: p.width, height: p.window, fontScale: s };
    const styles = makeChatStyles({ theme: theme.name, colors: theme.colors } as any) as any;
    const item = { id: 'line-1', text: line.text, senderId: line.isMe ? 'me' : 'ben', timestamp: Date.now(), type: 'text' } as unknown as ChatMessage;
    act(() => root.render(createElement('div', { 'data-testid': 'list', 'data-style': JSON.stringify({ width: p.width, paddingHorizontal: 16 }) },
        createElement('div', { 'data-testid': 'cell', 'data-style': '{}' },
            createElement(ChatMessageRow, {
                item, isMe: line.isMe, styles, kind: line.kind, actions: line.actions, showActions: true, showEmojiPicker: false, pickerPosition: 'top',
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
    return { height: layout.height(cell), actions };
}

/** The real ChatMessageList with the line's menu open: the phone lays out the thread and the open line, then the thread is dragged. */
function dragCloses(thread: number, line: number): boolean {
    const close = vi.fn();
    const styles = makeChatStyles({ theme: theme.name, colors: theme.colors } as any) as any;
    act(() => root.render(createElement(ChatMessageList, {
        listRef: { current: null }, items: [{ id: 'line-1' } as any], styles, renderMessage: () => null, activeId: 'line-1', onScrollBeginDrag: close,
    }) as Parameters<Root['render']>[0]));
    const props = flat.props!;
    act(() => {
        props.onLayout?.({ nativeEvent: { layout: { height: thread } } });
        const cell = props.CellRendererComponent({ item: { id: 'line-1' }, style: {}, onLayout: () => {}, children: null });
        cell.props.onLayout?.({ nativeEvent: { layout: { height: line } } });
    });
    act(() => props.onScrollBeginDrag?.());
    return close.mock.calls.length > 0;
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
            // The newest line sits on the thread's bottom (the list is inverted): in view is what is under the thread's top.
            const viewTop = open.height - thread;
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
            if (open.height <= thread) expect(closes, 'all in view: a drag closes the menu').toBe(true);
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
        expect(reply.top).toBeLessThan(open.height - thread);
        // Main before this change: ChatMessageList handed every drag to the screen, which closed the menu.
        expect(dragCloses(thread, open.height)).toBe(false);
        expect(dragCloses(open.height, open.height)).toBe(true);
    });
});

describe('every chat hands its drag to ChatMessageList, which decides', () => {
    it('the DM, the group and the event chat close the menu only through ChatMessageList\'s onScrollBeginDrag', () => {
        for (const f of [['app', 'chat', '[id].tsx'], ['components', 'GroupChatView.tsx'], ['components', 'EventChatView.tsx']]) {
            const src = fs.readFileSync(path.join(__dirname, '..', '..', ...f), 'utf8');
            expect(src, f.join('/')).toContain('<ChatMessageList');
            expect(src.match(/onScrollBeginDrag=/g), f.join('/')).toHaveLength(1);
        }
        const list = fs.readFileSync(path.join(__dirname, '..', '..', 'components', 'chat', 'ChatMessageList.tsx'), 'utf8');
        expect(list).toContain('onScrollBeginDrag={onScrollBeginDrag ? onDrag : undefined}');
        expect(list).toContain('if (chatMenuClosesOnDrag({ thread: threadHeight.current, line })) onScrollBeginDrag?.();');
    });
});
