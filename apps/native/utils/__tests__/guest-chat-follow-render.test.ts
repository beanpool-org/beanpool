// @vitest-environment jsdom
/**
 * The guest chat follows its newest line (walk of 17 Nov, scratch/walks/walk3-phone-3246 R23, R46, R55): it did not move
 * to a line that arrived, and at 320 dp with 1.3× text the newest line sat cut at the box with its "Sent" hidden. The
 * group chat's list is inverted (components/chat/ChatMessageList) for exactly this; the guest chat's was top-down,
 * scrolled only when its content changed size, so a box that grew or a keyboard that opened left the end below the box.
 *
 * One table over (light, dark) × (what happens): the real screen (app/guest-chat/[id].tsx) rendered into jsdom with React
 * Native's host components as tags, laid out by Yoga (yoga-dom-layout.ts) at 320 dp and 1.3× text, its list a scroll
 * view that keeps its offset as a phone's does (a top-down list from its top, an inverted one from its bottom) and
 * reports a change of content size as React Native does. After each step: is the newest line's end in view above the box,
 * its "Sent" with it, and all of it when the window can hold it; and a member reading older lines is not taken down when
 * a line arrives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, forwardRef, useImperativeHandle } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { GuestChat } from '@beanpool/core';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ME = 'c'.repeat(64);
const ANA = 'a'.repeat(64);
const FONT = 1.3;

/** The list as a phone scrolls it: `offset` from the top (top-down) or from the bottom (inverted), or the end. */
const list = vi.hoisted(() => ({
    props: null as any,
    offset: 0 as number | 'end',
    scrolls: 0,
}));
const kb = vi.hoisted(() => ({ height: 0 }));
const events = vi.hoisted(() => ({ listeners: new Map<string, Set<() => void>>() }));

vi.mock('react-native', async () => {
    const { createElement: h } = await import('react');
    const flat = (style: unknown): Record<string, unknown> => (Array.isArray(style) ? Object.assign({}, ...style.map(flat)) : (style as Record<string, unknown>) ?? {});
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, disabled, testID, style, value, onChangeText } = props;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat(style)) };
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (tag === 'textarea') {
            // A multiline box grows a line at a time, up to its maxHeight (the screen's 140).
            const lines = String(value ?? '').split('\n').length;
            const s = flat(style);
            const grown = Math.min(Number(s.maxHeight ?? Infinity), Math.max(Number(s.minHeight ?? 0), 20 + lines * 15 * 1.25 * FONT));
            attrs['data-style'] = JSON.stringify({ ...s, height: grown });
            attrs.value = value ?? '';
            attrs.onChange = (e: any) => onChangeText?.(e.target.value);
            return h(tag, attrs);
        }
        return h(tag, attrs, children);
    };
    const FlatList = forwardRef((props: any, ref) => {
        list.props = props;
        useImperativeHandle(ref, () => ({
            scrollToOffset: ({ offset }: { offset: number }) => { list.offset = offset; list.scrolls++; },
            scrollToEnd: () => { list.offset = 'end'; list.scrolls++; },
        }));
        const cells = (props.data ?? []).map((item: any, index: number) => h('div', { key: props.keyExtractor(item), 'data-line': item.id, 'data-style': '{}' }, props.renderItem({ item, index })));
        // Drawn in the order a member sees it: an inverted list's footer on top, its data from the last item up.
        const content = props.inverted ? [props.ListFooterComponent, ...cells.reverse()] : [props.ListHeaderComponent, ...cells];
        return h('div', { 'data-testid': 'viewport', 'data-style': JSON.stringify({ flexGrow: 1, flexShrink: 1, flexBasis: 0, overflow: 'scroll', ...flat(props.style) }) },
            h('div', { 'data-testid': 'content', 'data-style': JSON.stringify(flat(props.contentContainerStyle)) }, ...content));
    });
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('div'), TextInput: el('textarea'), FlatList,
        StyleSheet: { create: (s: any) => s, hairlineWidth: 1 },
        DeviceEventEmitter: {
            addListener: (name: string, fn: () => void) => {
                const set = events.listeners.get(name) ?? new Set();
                set.add(fn);
                events.listeners.set(name, set);
                return { remove: () => set.delete(fn) };
            },
            emit: (name: string) => events.listeners.get(name)?.forEach((fn) => fn()),
        },
        Alert: { alert: vi.fn() },
    };
});
vi.mock('react-native-keyboard-controller', async () => {
    const { createElement: h } = await import('react');
    // Padding by the keyboard's height, as the library's KeyboardAvoidingView does with behavior "padding".
    return { KeyboardAvoidingView: (p: any) => h('div', { 'data-style': JSON.stringify({ ...p.style, paddingBottom: kb.height }) }, p.children) };
});
vi.mock('react-native-safe-area-context', async () => {
    const { createElement: h } = await import('react');
    return { SafeAreaView: (p: any) => h('div', { 'data-testid': 'screen', 'data-style': JSON.stringify(p.style ?? {}) }, p.children) };
});
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('expo-router', () => ({ router: { back: vi.fn(), push: vi.fn() }, useLocalSearchParams: () => ({ id: 'grp-seeds@hilltop.example' }), useFocusEffect: () => {} }));
const theme = vi.hoisted(() => ({ ctx: null as any }));
vi.mock('../../app/ThemeContext', () => ({ useTheme: () => theme.ctx, useStyles: (make: (c: any) => unknown) => make(theme.ctx) }));
vi.mock('../keyboard-alert', () => ({ Alert: { alert: vi.fn() } }));
vi.mock('../identity', () => ({ loadIdentity: async () => ({ publicKey: ME, callsign: 'Sol' }) }));
vi.mock('../outside-chat-live', () => ({ outsideErrorWords: () => 'That did not go through.' }));
const live = vi.hoisted(() => ({ chats: {} as Record<string, any> }));
vi.mock('../guest-chat-live', () => ({
    GUEST_CHATS_UPDATED: 'guest_chats_updated',
    loadGuestChats: async () => JSON.parse(JSON.stringify(live.chats)),
    syncGuestMailNow: async () => true,
    answerInvitation: vi.fn(async () => {}),
    // Kept here at once, as the real one keeps a line before the round that sends it.
    sendGuestLineNow: vi.fn(async (id: string, text: string) => {
        live.chats[id].lines.push({ id: `mine-${live.chats[id].lines.length}`, author: ME, text, at: Date.now(), state: 'sent' });
        return true;
    }),
    fetchGroupGuests: async () => ({ guests: [], on: true }),
    inviteGroupGuest: vi.fn(async () => ({})),
}));

import { DeviceEventEmitter } from 'react-native';
import { lightColors, darkColors } from '../../constants/colors';
import GuestChatScreen from '../../app/guest-chat/[id]';
import { layOut } from './yoga-dom-layout';

const ID = 'grp-seeds@hilltop.example';
/** The walk's phone: 480 × 854 px at 1.5, less the status bar and the nav bar (the dump's screen ends at 782 px). */
const SCREEN = { width: 320, height: 521 - 24 };
const KEYBOARD = 250;

function chat(): GuestChat {
    return {
        id: ID, host: 'hilltop.example', group: 'grp-seeds', name: 'Seed swap', invitedBy: { key: ANA, name: 'Ana' }, state: 'in',
        roster: { name: 'Seed swap', members: [{ key: ANA, name: 'Ana' }], guests: [{ key: ME, home: 'riverside.example', name: 'Sol' }], epoch: null },
        keys: {}, epochSent: null, why: null, updatedAt: 1, held: [],
        lines: [
            { id: 'l1', author: ANA, text: 'Welcome to the seed swap. Bring what you saved.', at: 1 },
            { id: 'l2', author: ANA, text: 'We meet on Saturday at the hall.', at: 2 },
            { id: 'l3', author: ME, text: 'I have tomato and bean seeds to swap.', at: 3, state: 'sent' },
        ],
    } as GuestChat;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    list.props = null; list.offset = 0; list.scrolls = 0; kb.height = 0;
    live.chats = { [ID]: chat() };
});
afterEach(() => { act(() => root.unmount()); host.remove(); events.listeners.clear(); });

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
const q = (sel: string) => host.querySelector(sel)!;
let lastContent = -1;

/** Lays the screen out; reports a new content size to the list as React Native does; returns where things are. */
function look() {
    let layout = layOut(q('[data-testid="screen"]'), SCREEN, { fontScale: FONT });
    const content = layout.height(q('[data-testid="content"]'));
    if (content !== lastContent) {
        lastContent = content;
        act(() => { list.props?.onContentSizeChange?.(SCREEN.width, content); });
        layout = layOut(q('[data-testid="screen"]'), SCREEN, { fontScale: FONT });
    }
    const view = layout.height(q('[data-testid="viewport"]'));
    const room = Math.max(0, content - view);
    // A scroll to the end lands on a number, the end as it is now; the phone keeps that number when the window shrinks.
    if (list.offset === 'end') list.offset = room;
    const at = (o: number | 'end') => Math.min(room, Math.max(0, o === 'end' ? room : o));
    // The window's top, in the content's own order (oldest at the top).
    const top = list.props?.inverted ? room - at(list.offset) : at(list.offset);
    const within = (el: Element) => {
        let y = 0;
        for (let e: Element | null = el; e && e.getAttribute('data-testid') !== 'content'; e = e.parentElement) y += layout.box(e).top;
        return { top: y, bottom: y + layout.height(el) };
    };
    const inView = (el: Element) => { const b = within(el); return b.top >= top - 0.5 && b.bottom <= top + view + 0.5; };
    const bottomInView = (el: Element) => { const b = within(el); return b.bottom >= top - 0.5 && b.bottom <= top + view + 0.5; };
    const fits = (el: Element) => layout.height(el) <= view;
    const lines = live.chats[ID].lines;
    const newest = q(`[data-line="${lines[lines.length - 1].id}"]`);
    return { view, content, top, inView, bottomInView, fits, newest };
}

/** Scroll up to the oldest lines, as a member's finger does: the list hears it through onScroll. */
function readHistory() {
    const { content, view } = look();
    list.offset = list.props?.inverted ? Math.max(0, content - view) : 0;
    act(() => { list.props?.onScroll?.({ nativeEvent: { contentOffset: { y: list.offset } } }); });
}
async function arrives(text: string) {
    live.chats[ID].lines.push({ id: `ana-${live.chats[ID].lines.length}`, author: ANA, text, at: Date.now() });
    act(() => { DeviceEventEmitter.emit('guest_chats_updated'); });
    await settle();
}
async function type(text: string) {
    const box = q('[data-testid="guest-chat-input"]') as HTMLTextAreaElement;
    await act(async () => {
        const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
        set.call(box, text);
        box.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

const STEPS: Array<{ name: string; run: () => Promise<void>; newestInView: boolean; readerStays?: boolean }> = [
    { name: 'opened', run: async () => {}, newestInView: true },
    { name: 'a line arrives while the newest is in view', run: async () => { look(); await arrives('Lovely. I have pumpkin seeds for you.'); }, newestInView: true },
    { name: 'the box grows to three lines', run: async () => { look(); await type('Thank you.\nSee you Saturday.\nI will bring bags.'); }, newestInView: true },
    { name: 'the keyboard opens', run: async () => { look(); kb.height = KEYBOARD; await act(async () => { root.render(createElement(GuestChatScreen) as any); }); }, newestInView: true },
    { name: 'I send a line', run: async () => { look(); await type('Thank you, see you Saturday.'); await act(async () => { (q('[data-testid="guest-chat-send"]') as HTMLElement).click(); }); await settle(); }, newestInView: true },
    { name: 'a line arrives while I read older lines', run: async () => { readHistory(); const before = list.scrolls; await arrives('Lovely. I have pumpkin seeds for you.'); expect(list.scrolls).toBe(before); }, newestInView: false, readerStays: true },
];

describe.each([['light', lightColors], ['dark', darkColors]] as const)('the guest chat at 320 dp with 1.3× text follows its newest line, %s', (name, colors) => {
    beforeEach(() => { theme.ctx = { theme: name, colors }; lastContent = -1; });
    for (const step of STEPS) {
        it(`${step.name}: the newest line ${step.newestInView ? 'ends in view above the box, with its state' : 'stays below; the reader is not moved'}`, async () => {
            act(() => root.render(createElement(GuestChatScreen) as any));
            await settle();
            await step.run();
            const r = look();
            // The chat is longer than its window at this size, or nothing here would test anything.
            expect(r.content).toBeGreaterThan(r.view);
            // The newest line's end sits in view above the box, its state with it, and all of it whenever the window
            // can hold it (above a keyboard at 1.3× the window can be shorter than one line).
            expect(r.bottomInView(r.newest)).toBe(step.newestInView);
            if (step.newestInView) {
                if (r.fits(r.newest)) expect(r.inView(r.newest)).toBe(true);
                const state = r.newest.querySelector('[data-testid="guest-line-state"]');
                if (state) expect(r.inView(state)).toBe(true);
            }
            if (step.readerStays) expect(r.inView(r.newest)).toBe(false);
        });
    }
});
