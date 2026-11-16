// @vitest-environment jsdom
/**
 * The market DM on a small phone (walk of 17 Nov, scratch/walks/emulator-nov17b/r2 shots 31, 32 and 33; 320 dp, 1.3× text):
 * opened from a listing with a review due and Beans held, the deals strip (137 dp), the listing's header (75), the release
 * bar (160) and the About chip (65) filled the column. The thread had 0 dp, the box went under the navigation bar, and with
 * the keyboard up the box was entirely behind it.
 *
 * One table over (light, dark) × (phone, text size) × (what stands above the composer) × (keyboard down, up): the DM's
 * column as app/chat/[id].tsx stacks it (held by dm-key-pane-fit-render.test.ts's source check and the one at the end
 * here), with the real DmKeyChangedPane, ChatScrollPage, ChatAboutBanner, ChatReplyBanner and ChatEditBanner, laid out by
 * Yoga (yoga-dom-layout.ts), the rooms from chatColumnFit fed by the measures the screen takes (its onLayouts), until they
 * settle as they do on the phone. In every row: the composer (field and Send, and any line over them) is whole above the
 * keyboard; the thread keeps one line (CHAT_THREAD_LINE), or all there is once the composer is in; the banners over the
 * composer and the bars stand whole while they fit and otherwise scroll as a page in their room, the scroll never hidden,
 * every bar in it reachable; a tall phone keeps everything whole. (Yoga's text is an estimate: the owed walk checks pixels.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, forwardRef, useImperativeHandle } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as fs from 'node:fs';
import * as path from 'node:path';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createElement: h } = await import('react');
    const flat = (style: unknown): Record<string, unknown> => (Array.isArray(style) ? Object.assign({}, ...style.map(flat)) : (style as Record<string, unknown>) ?? {});
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, disabled, testID, style, numberOfLines } = props;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat(style)) };
        if (testID) attrs['data-testid'] = testID;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        return h(tag, attrs, typeof children === 'function' ? children({ pressed: false }) : children);
    };
    // A ScrollView: its frame, and inside it the content at its own height (Yoga's overflow scroll leaves the scroll axis
    // open). What the member is shown about scrolling is written out for the table to read, page by page.
    const ScrollView = forwardRef((props: Record<string, any>, ref) => {
        const id = String(props.testID);
        useImperativeHandle(ref, () => ({ flashScrollIndicators: () => { pages.flashed[id] = (pages.flashed[id] ?? 0) + 1; } }));
        pages.onSize[id] = props.onContentSizeChange;
        pages.onLayout[id] = props.onLayout;
        pages.persistTaps[id] = props.keyboardShouldPersistTaps;
        return h('div', {
            'data-testid': props.testID, 'data-style': JSON.stringify({ ...flat(props.style), overflow: 'scroll' }),
            'data-persistent-scrollbar': String(!!props.persistentScrollbar),
            'data-fade': String(props.fadingEdgeLength ?? 0),
        }, h('div', { 'data-testid': `${id}-content`, 'data-style': '{}' }, props.children));
    });
    return { View: el('div'), Text: el('span'), Pressable: el('div'), Modal: el('div'), ScrollView, StyleSheet: { create: (s: unknown) => s } };
});
const pages = vi.hoisted(() => ({
    flashed: {} as Record<string, number>,
    onSize: {} as Record<string, undefined | ((w: number, h: number) => void)>,
    onLayout: {} as Record<string, undefined | ((e: { nativeEvent: { layout: { height: number } } }) => void)>,
    persistTaps: {} as Record<string, unknown>,
}));
vi.mock('react-native-keyboard-controller', () => ({
    useKeyboardState: (pick: (s: { isVisible: boolean; height: number }) => unknown) => pick({ isVisible: false, height: 0 }),
    KeyboardController: { dismiss: vi.fn(async () => {}) },
}));
const theme = vi.hoisted(() => ({ colors: null as any }));
vi.mock('../../app/ThemeContext', () => ({
    useTheme: () => ({ colors: theme.colors }),
    useStyles: (make: (c: { colors: unknown }) => unknown) => make({ colors: theme.colors }),
}));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('../db', () => ({}));
vi.mock('expo-router', () => ({ useIsFocused: () => true }));

import { chatAboutDrafts } from '@beanpool/core';
import { lightColors, darkColors } from '../../constants/colors';
import { DmKeyChangedPane } from '../../components/chat/DmKeyChangedPane';
import { ChatScrollPage } from '../../components/chat/ChatScrollPage';
import { ChatAboutBanner } from '../../components/chat/ChatAbout';
import { ChatEditBanner, ChatReplyBanner } from '../../components/chat/ChatBanners';
import { makeChatStyles } from '../../components/chat/styles';
import { CHAT_PAGE_MIN, CHAT_THREAD_LINE, chatColumnFit } from '../chat-column-fit';
import { layOut } from './yoga-dom-layout';

let host: HTMLDivElement;
let root: Root;
const CONVERSATION = 'dm-riverside-1';
beforeEach(() => {
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    for (const k of Object.keys(pages.flashed)) delete pages.flashed[k];
});
afterEach(() => { act(() => root.unmount()); host.remove(); chatAboutDrafts.drop(CONVERSATION); });

/**
 * The DM's column under the header (header's bottom to the keyboard view's bottom) and the keyboard: the walk's phone from
 * its dump (480 × 854 px at 1.5: the column 94 → 521 dp, the keyboard 405 → 782 px), 320 × 533 with a 48-dp nav bar, and a
 * tall phone.
 */
const PHONES = [
    { name: 'the walk\'s 320 × 569', width: 320, column: 425, keyboard: 251, tall: false },
    { name: '320 × 533, 48-dp nav bar', width: 320, column: 397, keyboard: 250, tall: false },
    { name: 'a tall phone, 412 × 915', width: 412, column: 779, keyboard: 300, tall: true },
] as const;
/** The bars as the walk's dump measured them at 1.3× (shot 31), and at 1× from [id].tsx's styles (a line 1.25× its font). */
const BARS = {
    deals: { 1: 114, 1.3: 137 },
    listing: { 1: 62, 1.3: 75 },
    release: { 1: 116, 1.3: 160 },
} as const;
type Bar = keyof typeof BARS;
/**
 * The composer: its top padding, the field (a line 16 × 1.25 × the scale, 16 of padding, 40 at least) and its bottom padding
 * (8 with the keyboard up, 12 with it down), and its border. A line over it (a refused send's words, a request's) is the
 * composer's own: two lines of 11-sp text at 1.3×.
 */
const composerHeight = (fontScale: 1 | 1.3, kbUp: boolean, lines: number, notice: boolean) =>
    8 + Math.max(40, Math.round(lines * 16 * 1.25 * fontScale) + 16) + (kbUp ? 8 : 12) + 1 + (notice ? Math.round(6 + 2 * 11 * 1.25 * fontScale) : 0);

interface Row { name: string; bars: Bar[]; about?: boolean; reply?: boolean; edit?: boolean; notice?: boolean; draftLines?: number }
const ROWS: Row[] = [
    { name: 'nothing over the thread', bars: [] },
    { name: 'the listing\'s header', bars: ['listing'] },
    { name: 'the deals strip, the listing\'s header and the release bar', bars: ['deals', 'listing', 'release'] },
    { name: 'the walk\'s DM: the deals strip, the listing\'s header, the release bar and the About chip', bars: ['deals', 'listing', 'release'], about: true },
    { name: 'the walk\'s DM and Replying to', bars: ['deals', 'listing', 'release'], about: true, reply: true },
    { name: 'the walk\'s bars and Editing message', bars: ['deals', 'listing', 'release'], edit: true },
    { name: 'the listing\'s header, the About chip and a line over the box', bars: ['listing'], about: true, notice: true },
    { name: 'the walk\'s DM, Replying to and a three-line draft', bars: ['deals', 'listing', 'release'], about: true, reply: true, draftLines: 3 },
];

/** The column as [id].tsx stacks it: the bars' page, then the keyboard view (the thread, then the box: its banners' page and the composer). */
function columnTree(o: { column: number; row: Row; fontScale: 1 | 1.3; kb: number; composer: number; fit: { bars: number; banners: number } }) {
    const chat = makeChatStyles({ theme: theme.colors === darkColors ? 'dark' : 'light', colors: theme.colors } as any) as any;
    const bar = (id: Bar) => createElement('div', { key: id, 'data-testid': id, 'data-style': JSON.stringify({ height: BARS[id][o.fontScale] }) });
    return createElement('div', { 'data-testid': 'column', 'data-style': JSON.stringify({ height: o.column, flexDirection: 'column' }) },
        createElement(DmKeyChangedPane, { card: null, maxHeight: 0, barsRoom: o.fit.bars }, ...o.row.bars.map(bar)),
        createElement('div', { 'data-testid': 'keyboard-view', 'data-style': JSON.stringify({ flex: 1, paddingBottom: o.kb }) },
            createElement('div', { 'data-testid': 'thread', 'data-style': JSON.stringify({ flex: 1 }) }),
            createElement('div', { 'data-testid': 'box', 'data-style': '{}' },
                createElement(ChatScrollPage, { testID: 'chat-box-banners', maxHeight: o.fit.banners },
                    o.row.edit ? createElement(ChatEditBanner, { styles: chat, text: 'Are the trays ready to pick up?', onCancel: () => {} }) : null,
                    !o.row.edit ? createElement(ChatAboutBanner, { conversationId: CONVERSATION }) : null,
                    o.row.reply && !o.row.edit ? createElement(ChatReplyBanner, { styles: chat, author: 'Ben', text: 'Yes, the trays are ready. Come by after four.', onCancel: () => {} }) : null),
                createElement('div', { 'data-testid': 'composer', 'data-style': JSON.stringify({ height: o.composer }) },
                    createElement('div', { 'data-testid': 'send', 'data-style': JSON.stringify({ position: 'absolute', right: 0, bottom: 0, width: 40, height: 40 }) })))));
}

/**
 * Renders the column the way the phone settles it: lay out, hand the screen its measures (the column, the box measured whole,
 * the banners' page as drawn), work out the rooms again, until nothing moves.
 */
function settle(p: (typeof PHONES)[number], fontScale: 1 | 1.3, row: Row, kbUp: boolean) {
    const kb = kbUp ? p.keyboard : 0;
    const composer = composerHeight(fontScale, kbUp, row.draftLines ?? 1, !!row.notice);
    if (row.about) chatAboutDrafts.set(CONVERSATION, { postId: 'post-twine-1', kind: 'offer', title: 'Garden twine, two rolls', price: '0.05 Beans' } as any);
    const measure = { column: 0, box: 0, banners: 0 };
    let fit = chatColumnFit({ column: 0, box: 0, input: 0, windowHeight: p.column + 144, keyboard: kb, paused: false });
    const q = (id: string) => host.querySelector(`[data-testid="${id}"]`)!;
    let layout!: ReturnType<typeof layOut>;
    for (let pass = 0; pass < 6; pass++) {
        act(() => root.render(columnTree({ column: p.column, row, fontScale, kb, composer, fit }) as Parameters<Root['render']>[0]));
        layout = layOut(q('column'), { width: p.width, height: p.column }, { fontScale });
        // The phone reports each page's content once laid out, then the screen's onLayouts.
        act(() => {
            for (const id of ['chat-bars-page', 'chat-box-banners']) if (host.querySelector(`[data-testid="${id}"]`)) pages.onSize[id]?.(p.width, layout.height(q(`${id}-content`)));
        });
        const next = { column: p.column, box: layout.height(q('box')), banners: layout.height(q('chat-box-banners')) };
        const same = next.column === measure.column && next.box === measure.box && next.banners === measure.banners;
        Object.assign(measure, next);
        fit = chatColumnFit({ column: measure.column, box: measure.box, input: Math.max(0, measure.box - measure.banners), windowHeight: p.column + 144, keyboard: kb, paused: false });
        if (same && pass > 0) break;
    }
    const top = (el: Element) => { let y = 0; for (let e: Element | null = el; e && e !== q('column'); e = e.parentElement) y += layout.box(e).top; return y; };
    const page = (id: string) => ({
        height: layout.height(q(id)), content: layout.height(q(`${id}-content`)), el: q(id),
        top: top(q(id)), flashed: pages.flashed[id] ?? 0, persistTaps: pages.persistTaps[id],
    });
    return {
        kb, composer, fit,
        bars: page('chat-bars-page'),
        barTops: row.bars.map((b) => ({ id: b, top: top(q(b)) - top(q('chat-bars-page-content')), height: layout.height(q(b)) })),
        banners: page('chat-box-banners'),
        thread: { top: top(q('thread')), height: layout.height(q('thread')) },
        box: { top: top(q('box')), height: layout.height(q('box')) },
        composerBox: { top: top(q('composer')), bottom: top(q('composer')) + layout.height(q('composer')) },
        send: { bottom: top(q('send')) + layout.height(q('send')) },
    };
}

describe.each([['light', lightColors], ['dark', darkColors]] as const)('the market DM\'s column, %s: the box whole above the keyboard, one line of the thread, the rest a page', (_name, colors) => {
    beforeEach(() => { theme.colors = colors; });
    for (const p of PHONES) for (const fontScale of [1, 1.3] as const) for (const row of ROWS) for (const kbUp of [false, true]) {
        it(`${p.name} at ${fontScale}×, ${row.name}, keyboard ${kbUp ? 'up' : 'down'}`, () => {
            const r = settle(p, fontScale, row, kbUp);
            const above = p.column - r.kb;
            // The composer, its field and Send whole, above the keyboard (the column's bottom with none), under the thread.
            expect(r.composerBox.bottom, 'the composer ends on the keyboard').toBe(above);
            expect(r.composerBox.bottom - r.composerBox.top).toBe(r.composer);
            expect(r.send.bottom).toBeLessThanOrEqual(above);
            expect(r.box.top).toBeGreaterThanOrEqual(r.thread.top + r.thread.height);
            // The thread keeps one line, or everything left once the composer is in.
            expect(r.thread.height, 'one line of the thread').toBeGreaterThanOrEqual(Math.min(CHAT_THREAD_LINE, above - r.composer));
            // Nothing overlaps: the bars' page, the thread, the banners' page and the composer stack down the column.
            expect(r.bars.top).toBe(0);
            expect(r.thread.top).toBe(r.bars.height);
            expect(r.banners.top).toBe(r.box.top);
            expect(r.composerBox.top).toBe(r.banners.top + r.banners.height);
            for (const [name, pg] of [['bars', r.bars], ['banners', r.banners]] as const) {
                if (pg.content > pg.height) {
                    // Taller than its room: it fills the room and scrolls as a page, its scroll never hidden (the bar shown
                    // on Android, its edge fading; a flash on iOS once it has a room to show it in).
                    expect(pg.height, `${name}: fills its room`).toBe(name === 'bars' ? r.fit.bars : r.fit.banners);
                    expect(pg.el.getAttribute('data-persistent-scrollbar')).toBe('true');
                    expect(Number(pg.el.getAttribute('data-fade'))).toBeGreaterThan(0);
                    if (pg.height > 0) expect(pg.flashed).toBe(1);
                    // A page in less than a 44-dp target folds away: no sliver to scroll or tap.
                    expect(pg.height === 0 || pg.height >= CHAT_PAGE_MIN, `${name}: ${pg.height} dp`).toBe(true);
                } else {
                    expect(pg.height, `${name}: stands whole`).toBe(pg.content);
                }
                // Once at most, however the room moves.
                expect(pg.flashed).toBeLessThanOrEqual(1);
                // A ✕ or Release in a page works with the keyboard up.
                expect(pg.persistTaps).toBe('handled');
            }
            // Every bar is in the page, one under the other, so each is reachable by scrolling it.
            let below = 0;
            for (const b of r.barTops) { expect(b.top).toBe(below); below += b.height; }
            expect(below).toBe(r.bars.content);
            // While the keyboard is down every phone shows the thread more than its one line: the bars give way before it.
            if (!kbUp) expect(r.thread.height).toBeGreaterThanOrEqual(CHAT_THREAD_LINE);
            // A tall phone keeps everything whole while the keyboard is down, as before.
            if (p.tall && !kbUp) {
                expect(r.bars.height).toBe(r.bars.content);
                expect(r.banners.height).toBe(r.banners.content);
            }
        });
    }
});

describe('the walk\'s case on the walk\'s phone (320 × 569, 1.3×), the numbers', () => {
    beforeEach(() => { theme.colors = darkColors; });
    const walk = ROWS[3];
    it('keyboard down: the bars scroll as a page above a thread line, and the box with its About chip is whole', () => {
        const r = settle(PHONES[0], 1.3, walk, false);
        // 137 + 75 + 160 dp of bars stood in a 425-dp column above a 128-dp box: the box went under the navigation bar.
        expect(r.bars.content).toBe(372);
        expect(r.bars.content + r.box.height).toBeGreaterThan(PHONES[0].column);
        expect(r.bars.height).toBe(PHONES[0].column - r.box.height - CHAT_THREAD_LINE);
        expect(r.banners.height).toBe(r.banners.content);
    });
    it('keyboard up: the bars fold away, the About chip and the composer are whole on the keyboard, the thread has the rest', () => {
        const r = settle(PHONES[0], 1.3, walk, true);
        expect(r.bars.height).toBe(0);
        expect(r.banners.height).toBe(r.banners.content);
        expect(r.thread.height).toBeGreaterThanOrEqual(CHAT_THREAD_LINE);
        expect(r.composerBox.bottom).toBe(PHONES[0].column - PHONES[0].keyboard);
    });
    it('without the rooms (main before this change) the same column cut the box: the check can fail', () => {
        // The bars standing as they are (no barsRoom) and the banners unbounded: the composer ends past the keyboard's top.
        const kb = PHONES[0].keyboard;
        const composer = composerHeight(1.3, true, 1, false);
        chatAboutDrafts.set(CONVERSATION, { postId: 'post-twine-1', kind: 'offer', title: 'Garden twine, two rolls', price: '0.05 Beans' } as any);
        const tree = createElement('div', { 'data-testid': 'column', 'data-style': JSON.stringify({ height: PHONES[0].column, flexDirection: 'column' }) },
            createElement(DmKeyChangedPane, { card: null, maxHeight: 0 }, ...walk.bars.map((b) => createElement('div', { key: b, 'data-style': JSON.stringify({ height: BARS[b][1.3] }) }))),
            createElement('div', { 'data-style': JSON.stringify({ flex: 1, paddingBottom: kb }) },
                createElement('div', { 'data-testid': 'thread', 'data-style': JSON.stringify({ flex: 1 }) }),
                createElement('div', { 'data-testid': 'box', 'data-style': '{}' },
                    createElement(ChatAboutBanner, { conversationId: CONVERSATION }),
                    createElement('div', { 'data-testid': 'composer', 'data-style': JSON.stringify({ height: composer }) }))));
        act(() => root.render(tree as Parameters<Root['render']>[0]));
        const q = (id: string) => host.querySelector(`[data-testid="${id}"]`)!;
        const layout = layOut(q('column'), { width: 320, height: PHONES[0].column }, { fontScale: 1.3 });
        const top = (el: Element) => { let y = 0; for (let e: Element | null = el; e && e !== q('column'); e = e.parentElement) y += layout.box(e).top; return y; };
        expect(layout.height(q('thread'))).toBe(0);
        expect(top(q('composer')) + composer).toBeGreaterThan(PHONES[0].column - kb);
    });
});

// ---- The screen itself: [id].tsx hands the bars and the banners their rooms from chatColumnFit ----

describe('app/chat/[id].tsx gives the bars and the banners over the composer their rooms (chatColumnFit)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'chat', '[id].tsx'), 'utf8');
    it('the fit is worked out from the column, the box measured whole, the composer alone and the keyboard; paused while the key card is up', () => {
        expect(src).toMatch(/const fit = chatColumnFit\(\{\s*column: column\.column, box: column\.composer, input: Math\.max\(0, column\.composer - bannersShown\),\s*windowHeight, keyboard: keyboardHeight, paused: keyChangePending,\s*\}\);/);
    });
    it('the pane takes the bars\' room beside the card\'s', () => {
        expect(src).toMatch(/maxHeight=\{dmKeyBannerMaxHeight\(\{ \.\.\.column, windowHeight, keyboard: keyboardHeight \}\)\}\s*barsRoom=\{fit\.bars\}\s*>/);
    });
    it('the banners over the composer are one page inside the box measured whole, measured as drawn, before the composer', () => {
        const box = src.indexOf("<View onLayout={measured('composer')}>");
        const page = src.indexOf('<ChatScrollPage testID="chat-box-banners" maxHeight={fit.banners} onLayout={(e) => setBannersShown(Math.round(e.nativeEvent.layout.height))}>', box);
        const end = src.indexOf('</ChatScrollPage>', page);
        expect(box).toBeGreaterThan(-1);
        expect(page).toBeGreaterThan(box);
        expect(src.slice(box, page)).toMatch(/^<View onLayout=\{measured\('composer'\)\}>\s*$/);
        for (const banner of ['<ChatEditBanner', '<ChatAboutBanner', '<ChatReplyBanner']) {
            const at = src.indexOf(banner, page);
            expect(at, banner).toBeGreaterThan(page);
            expect(at, banner).toBeLessThan(end);
        }
        expect(src.indexOf('{isPeerBlocked ? (', box)).toBeGreaterThan(end);
    });
});
