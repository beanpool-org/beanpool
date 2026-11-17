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
 * keyboard, its field giving way only to the banner; the Editing or Replying to banner sits whole on the composer, its
 * words and ✕ in view (deciding review of f4bbcfa4: it folded, or showed the About chip and none of itself); the thread
 * keeps one line (CHAT_THREAD_LINE), or all there is once the composer and the banner are in; the bars and then the About
 * chip give way, the bars' page kept at its end so the deals strip goes first; each page stands whole while it fits and
 * otherwise scrolls in its room, the scroll never hidden, every bar in it reachable; a tall phone keeps everything whole.
 * (Yoga's text is an estimate: the owed walk checks pixels.)
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
    // open). What the member is shown about scrolling, and where the page is scrolled to, is written out for the table.
    const ScrollView = forwardRef((props: Record<string, any>, ref) => {
        const id = String(props.testID);
        useImperativeHandle(ref, () => ({
            flashScrollIndicators: () => { pages.flashed[id] = (pages.flashed[id] ?? 0) + 1; },
            scrollToEnd: () => { pages.atEnd[id] = ++pages.seq; },
        }));
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
    seq: 0,
    flashed: {} as Record<string, number>,
    /** When each page last had its content size and frame reported, and last went to its end, in one running count. */
    sized: {} as Record<string, number>,
    atEnd: {} as Record<string, number>,
    onSize: {} as Record<string, undefined | ((w: number, h: number) => void)>,
    onLayout: {} as Record<string, undefined | (() => void)>,
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
import { CHAT_INPUT_MAX_HEIGHT, CHAT_INPUT_MIN_HEIGHT, makeChatStyles } from '../../components/chat/styles';
import { CHAT_PAGE_MIN, CHAT_THREAD_LINE, chatColumnFit, chatFieldCap } from '../chat-column-fit';
import { layOut } from './yoga-dom-layout';

let host: HTMLDivElement;
let root: Root;
const CONVERSATION = 'dm-riverside-1';
beforeEach(() => {
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    for (const rec of [pages.flashed, pages.sized, pages.atEnd]) for (const k of Object.keys(rec)) delete rec[k];
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
 * The composer (components/chat/ChatComposer): its frame, which is its top padding, its bottom padding (8 with the keyboard
 * up, 12 with it down), its border and any line over the field (a refused send's words, a request's: two lines of 11-sp text
 * at 1.3×); and the field, the draft's own height (a line 16 × 1.25 × the scale, 16 of padding, between 40 and 100), shown
 * at most what the composer's room leaves (chatFieldCap), as ChatComposer does with the frame it measures.
 */
const composerBottom = (kbUp: boolean) => (kbUp ? 8 : 12);
const composerNotice = (fontScale: 1 | 1.3) => Math.round(6 + 2 * 11 * 1.25 * fontScale);
const draftField = (fontScale: 1 | 1.3, lines: number) =>
    Math.min(CHAT_INPUT_MAX_HEIGHT, Math.max(CHAT_INPUT_MIN_HEIGHT, Math.round(lines * 16 * 1.25 * fontScale) + 16));
const composerHeight = (fontScale: 1 | 1.3, kbUp: boolean, lines: number, notice: boolean) =>
    8 + draftField(fontScale, lines) + composerBottom(kbUp) + 1 + (notice ? composerNotice(fontScale) : 0);

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
    // A plain DM (no bars, no About chip) answering or editing with one, two and three lines in the box: on f4bbcfa4 the
    // banner folded away at two lines on 320 × 533 and at three on 320 × 569 (deciding review, finding 1).
    ...[1, 2, 3].flatMap((draftLines): Row[] => [
        { name: `a plain DM, Replying to and a ${draftLines}-line draft`, bars: [], reply: true, draftLines },
        { name: `a plain DM, Editing message and a ${draftLines}-line draft`, bars: [], edit: true, draftLines },
    ]),
    // The walk's DM answering with two lines (finding 2's DM), and editing three lines under the walk's bars.
    { name: 'the walk\'s DM, Replying to and a two-line draft', bars: ['deals', 'listing', 'release'], about: true, reply: true, draftLines: 2 },
    { name: 'the walk\'s bars, Editing message and a three-line draft', bars: ['deals', 'listing', 'release'], edit: true, draftLines: 3 },
    // The most over the field: the About chip, a line over the box and Replying to (on 320 × 533 with the keyboard up the
    // field is down to its line, and the banner's padding is what is cropped).
    { name: 'the listing\'s header, the About chip, a line over the box and Replying to', bars: ['listing'], about: true, notice: true, reply: true },
];

const bannerEls = () => {
    const chat = makeChatStyles({ theme: theme.colors === darkColors ? 'dark' : 'light', colors: theme.colors } as any) as any;
    return {
        edit: createElement(ChatEditBanner, { styles: chat, text: 'Are the trays ready to pick up?', onCancel: () => {} }),
        reply: createElement(ChatReplyBanner, { styles: chat, author: 'Ben', text: 'Yes, the trays are ready. Come by after four.', onCancel: () => {} }),
    };
};
const barEl = (id: Bar, fontScale: 1 | 1.3) => createElement('div', { key: id, 'data-testid': id, 'data-style': JSON.stringify({ height: BARS[id][fontScale] }) });
/** The composer: its frame round the field, Send on the field's row. */
const composerEl = (fontScale: 1 | 1.3, kbUp: boolean, notice: boolean, field: number) =>
    createElement('div', { 'data-testid': 'composer', 'data-style': JSON.stringify({ paddingTop: (notice ? composerNotice(fontScale) : 0) + 8 + 1, paddingBottom: composerBottom(kbUp) }) },
        createElement('div', { 'data-testid': 'field', 'data-style': JSON.stringify({ height: field }) }),
        createElement('div', { 'data-testid': 'send', 'data-style': JSON.stringify({ position: 'absolute', right: 0, bottom: composerBottom(kbUp), width: 40, height: 40 }) }));

/**
 * The column as [id].tsx stacks it: the bars' page, then the keyboard view (the thread, then the box: the About chip's page,
 * the Editing or Replying to banner in its crop, measured whole inside it, and the composer).
 */
function columnTree(o: { column: number; row: Row; fontScale: 1 | 1.3; kb: number; field: number; fit: ReturnType<typeof chatColumnFit> }) {
    const b = bannerEls();
    return createElement('div', { 'data-testid': 'column', 'data-style': JSON.stringify({ height: o.column, flexDirection: 'column' }) },
        createElement(DmKeyChangedPane, { card: null, maxHeight: 0, barsRoom: o.fit.bars }, ...o.row.bars.map((id) => barEl(id, o.fontScale))),
        createElement('div', { 'data-testid': 'keyboard-view', 'data-style': JSON.stringify({ flex: 1, paddingBottom: o.kb }) },
            createElement('div', { 'data-testid': 'thread', 'data-style': JSON.stringify({ flex: 1 }) }),
            createElement('div', { 'data-testid': 'box', 'data-style': '{}' },
                !o.row.edit ? createElement(ChatScrollPage, { testID: 'chat-about-page', maxHeight: o.fit.about }, createElement(ChatAboutBanner, { conversationId: CONVERSATION })) : null,
                createElement('div', { 'data-testid': 'chat-box-banner', 'data-style': JSON.stringify({ maxHeight: o.fit.banner, overflow: 'hidden', justifyContent: 'center' }) },
                    createElement('div', { 'data-testid': 'chat-box-banner-content', 'data-style': '{}' },
                        o.row.edit ? b.edit : null,
                        o.row.reply && !o.row.edit ? b.reply : null)),
                composerEl(o.fontScale, o.kb > 0, !!o.row.notice, o.field))));
}

/** Where an element is in the column (dp from its top). */
const topIn = (layout: ReturnType<typeof layOut>, column: Element, el: Element) => {
    let y = 0;
    for (let e: Element | null = el; e && e !== column; e = e.parentElement) y += layout.box(e).top;
    return y;
};

/**
 * Renders the column the way the phone settles it: lay out, hand the screen its measures (the column, the box measured whole,
 * the composer alone, the banner whole) and the composer its frame, work out the rooms and the field again, until nothing moves.
 */
function settle(p: (typeof PHONES)[number], fontScale: 1 | 1.3, row: Row, kbUp: boolean) {
    const kb = kbUp ? p.keyboard : 0;
    const draft = draftField(fontScale, row.draftLines ?? 1);
    if (row.about) chatAboutDrafts.set(CONVERSATION, { postId: 'post-twine-1', kind: 'offer', title: 'Garden twine, two rolls', price: '0.05 Beans' } as any);
    // What the screen's onLayouts hand it, as they read them: the column, the box, the composer (rounded), the banner (rounded
    // up, so its room never crops a fraction of it); and the frame ChatComposer measures round its field.
    const measure = { column: 0, box: 0, input: 0, banner: 0 };
    let frame = 0;
    let fit = chatColumnFit({ ...measure, windowHeight: p.column + 144, keyboard: kb, paused: false });
    let field = draft;
    const q = (id: string) => host.querySelector(`[data-testid="${id}"]`)!;
    let layout!: ReturnType<typeof layOut>;
    for (let pass = 0; pass < 8; pass++) {
        field = Math.min(draft, chatFieldCap(fit.composer, frame));
        act(() => root.render(columnTree({ column: p.column, row, fontScale, kb, field, fit }) as Parameters<Root['render']>[0]));
        layout = layOut(q('column'), { width: p.width, height: p.column }, { fontScale });
        // The phone reports each page's content and frame once laid out, then the screen's onLayouts.
        act(() => {
            for (const id of ['chat-bars-page', 'chat-about-page']) {
                if (!host.querySelector(`[data-testid="${id}"]`)) continue;
                pages.sized[id] = ++pages.seq;
                pages.onSize[id]?.(p.width, layout.height(q(`${id}-content`)));
                pages.onLayout[id]?.();
            }
        });
        const next = {
            column: p.column, box: Math.round(layout.height(q('box'))), input: Math.round(layout.height(q('composer'))),
            banner: Math.ceil(layout.height(q('chat-box-banner-content'))),
        };
        const nextFrame = Math.max(0, Math.round(layout.height(q('composer'))) - field);
        const same = next.box === measure.box && next.input === measure.input && next.banner === measure.banner && nextFrame === frame;
        Object.assign(measure, next);
        frame = nextFrame;
        fit = chatColumnFit({ ...measure, windowHeight: p.column + 144, keyboard: kb, paused: false });
        if (same && pass > 0) break;
    }
    const top = (el: Element) => topIn(layout, q('column'), el);
    const page = (id: string) => (host.querySelector(`[data-testid="${id}"]`) ? {
        height: layout.height(q(id)), content: layout.height(q(`${id}-content`)), el: q(id),
        top: top(q(id)), flashed: pages.flashed[id] ?? 0, persistTaps: pages.persistTaps[id],
        sized: pages.sized[id] ?? 0, atEnd: pages.atEnd[id] ?? 0,
    } : null);
    const inBanner = (sel: string) => host.querySelector(`[data-testid="chat-box-banner-content"] ${sel}`);
    const span = (el: Element | null) => (el ? { top: top(el), bottom: top(el) + layout.height(el), height: layout.height(el) } : null);
    return {
        kb, draft, field, fit,
        composer: layout.height(q('composer')),
        bars: page('chat-bars-page')!,
        barTops: row.bars.map((b) => ({ id: b, top: top(q(b)) - top(q('chat-bars-page-content')), height: layout.height(q(b)) })),
        about: page('chat-about-page'),
        banner: {
            top: top(q('chat-box-banner')), height: layout.height(q('chat-box-banner')),
            content: layout.height(q('chat-box-banner-content')),
            cancel: span(inBanner('[aria-label="Cancel reply"]') ?? inBanner('[aria-label="Cancel edit"]')),
            words: span(inBanner('span')),
        },
        thread: { top: top(q('thread')), height: layout.height(q('thread')) },
        box: { top: top(q('box')), height: layout.height(q('box')) },
        composerBox: { top: top(q('composer')), bottom: top(q('composer')) + layout.height(q('composer')) },
        send: { bottom: top(q('send')) + layout.height(q('send')) },
    };
}

/** Within a hundredth of a dp: Yoga's text heights are fractions. */
const EPS = 0.01;

describe.each([['light', lightColors], ['dark', darkColors]] as const)('the market DM\'s column, %s: the box whole above the keyboard, the banner whole on it, one line of the thread, the rest pages', (_name, colors) => {
    beforeEach(() => { theme.colors = colors; });
    for (const p of PHONES) for (const fontScale of [1, 1.3] as const) for (const row of ROWS) for (const kbUp of [false, true]) {
        it(`${p.name} at ${fontScale}×, ${row.name}, keyboard ${kbUp ? 'up' : 'down'}`, () => {
            const r = settle(p, fontScale, row, kbUp);
            const above = p.column - r.kb;
            // The composer, its field and Send whole, above the keyboard (the column's bottom with none), under the thread.
            expect(r.composerBox.bottom, 'the composer ends on the keyboard').toBe(above);
            expect(r.send.bottom).toBeLessThanOrEqual(above);
            expect(r.box.top).toBeGreaterThanOrEqual(r.thread.top + r.thread.height);
            // The field keeps its line, and gives way only to the banner: shown shorter than the draft only while the
            // composer and the banner fill all there is above the keyboard.
            expect(r.field).toBeGreaterThanOrEqual(CHAT_INPUT_MIN_HEIGHT);
            if (r.field < r.draft) {
                expect(r.banner.content, 'the field gives way only to a banner').toBeGreaterThan(0);
                expect(r.composer + r.banner.content).toBeGreaterThanOrEqual(above - 1);
            }
            // The Editing or Replying to banner sits on the composer, whole while the field has more than its line to give,
            // and its words and its ✕ always in view: inside its crop, above the keyboard, the ✕ a 44-dp target.
            expect(r.banner.top + r.banner.height, 'the banner sits on the composer').toBeCloseTo(r.composerBox.top, 5);
            if (row.reply || row.edit) {
                const { cancel, words } = r.banner;
                expect(cancel, 'the banner\'s ✕').not.toBeNull();
                expect(words, 'the banner\'s words').not.toBeNull();
                if (r.field > CHAT_INPUT_MIN_HEIGHT || !row.notice) expect(r.banner.height, 'the banner whole').toBeGreaterThanOrEqual(r.banner.content - EPS);
                for (const [what, s] of [['✕', cancel!], ['words', words!]] as const) {
                    expect(s.top, `the banner's ${what} under its top`).toBeGreaterThanOrEqual(r.banner.top - EPS);
                    expect(s.bottom, `the banner's ${what} above its bottom`).toBeLessThanOrEqual(r.banner.top + r.banner.height + EPS);
                    expect(s.bottom, `the banner's ${what} above the keyboard`).toBeLessThanOrEqual(above + EPS);
                }
                expect(cancel!.height).toBeGreaterThanOrEqual(44);
            } else {
                expect(r.banner.height).toBe(0);
            }
            // The thread keeps one line, or everything left once the composer and the banner are in.
            // (Within half a dp: the screen rounds what its onLayouts read, and Yoga's text heights are fractions.)
            expect(r.thread.height, 'one line of the thread').toBeGreaterThanOrEqual(Math.min(CHAT_THREAD_LINE, above - r.composer - r.banner.height) - 0.5);
            // Nothing overlaps: the bars' page, the thread, the About chip's page, the banner and the composer stack down.
            expect(r.bars.top).toBe(0);
            expect(r.thread.top).toBe(r.bars.height);
            expect(r.about === null, 'no About page while editing').toBe(!!row.edit);
            if (r.about) {
                expect(r.about.top).toBe(r.box.top);
                expect(r.banner.top).toBeCloseTo(r.about.top + r.about.height, 5);
            } else {
                expect(r.banner.top).toBe(r.box.top);
            }
            for (const [name, pg] of [['bars', r.bars], ['about', r.about]] as const) {
                if (!pg) continue;
                if (pg.content > pg.height) {
                    // Taller than its room: it fills the room and scrolls as a page, its scroll never hidden (the bar shown
                    // on Android, its edge fading; a flash on iOS once it has a room to show it in).
                    expect(pg.height, `${name}: fills its room`).toBe(name === 'bars' ? r.fit.bars : r.fit.about);
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
            // The bars give way before the About chip: it is cut only once their page has folded away.
            if (r.about && r.about.content > r.about.height) expect(r.bars.height, 'the bars fold before the About chip').toBe(0);
            // A cut bars' page is kept at its end, after every time its size was reported: the deals strip goes first, then
            // the listing's header, then the release bar.
            if (r.bars.content > r.bars.height && r.bars.height > 0) expect(r.bars.atEnd, 'the bars\' page at its end').toBeGreaterThan(r.bars.sized);
            // Every bar is in the page, one under the other, so each is reachable by scrolling it.
            let below = 0;
            for (const b of r.barTops) { expect(b.top).toBe(below); below += b.height; }
            expect(below).toBe(r.bars.content);
            // While the keyboard is down every phone shows the thread more than its one line: the bars give way before it.
            if (!kbUp) expect(r.thread.height).toBeGreaterThanOrEqual(CHAT_THREAD_LINE - 0.5);
            // A tall phone keeps everything whole while the keyboard is down, as before.
            if (p.tall && !kbUp) {
                expect(r.bars.height).toBe(r.bars.content);
                if (r.about) expect(r.about.height).toBe(r.about.content);
                expect(r.field).toBe(r.draft);
            }
        });
    }
});

describe('the walk\'s case on the walk\'s phone (320 × 569, 1.3×), the numbers', () => {
    beforeEach(() => { theme.colors = darkColors; });
    const walk = ROWS[3];
    it('keyboard down: the bars scroll as a page above a thread line, kept at their end, and the box with its About chip is whole', () => {
        const r = settle(PHONES[0], 1.3, walk, false);
        // 137 + 75 + 160 dp of bars stood in a 425-dp column above a 128-dp box: the box went under the navigation bar.
        expect(r.bars.content).toBe(372);
        expect(r.bars.content + r.box.height).toBeGreaterThan(PHONES[0].column);
        expect(r.bars.height).toBe(PHONES[0].column - Math.round(r.box.height) - CHAT_THREAD_LINE);
        expect(r.about!.height).toBe(r.about!.content);
        // In view: the page's end, so the release bar (160) is whole and the deals strip is what scrolled away.
        expect(r.bars.atEnd).toBeGreaterThan(r.bars.sized);
        expect(r.bars.height).toBeGreaterThan(BARS.release[1.3]);
    });
    it('keyboard up: the bars fold away, the About chip and the composer are whole on the keyboard, the thread has the rest', () => {
        const r = settle(PHONES[0], 1.3, walk, true);
        expect(r.bars.height).toBe(0);
        expect(r.about!.height).toBe(r.about!.content);
        expect(r.thread.height).toBeGreaterThanOrEqual(CHAT_THREAD_LINE - 0.5);
        expect(r.composerBox.bottom).toBe(PHONES[0].column - PHONES[0].keyboard);
    });
    it('keyboard up, Replying to (finding 2): Replying to is whole on the composer, the About chip folds, the thread keeps its line', () => {
        const r = settle(PHONES[0], 1.3, ROWS[4], true);
        expect(r.banner.height).toBeGreaterThanOrEqual(r.banner.content - EPS);
        expect(r.banner.top + r.banner.height).toBeCloseTo(r.composerBox.top, 5);
        expect(r.about!.height).toBe(0);
        expect(r.bars.height).toBe(0);
        expect(r.thread.height).toBeGreaterThanOrEqual(CHAT_THREAD_LINE - 0.5);
    });
    it('320 × 533, a plain DM editing three lines, keyboard up (finding 1): the field gives way to the banner, never under its line', () => {
        const r = settle(PHONES[1], 1.3, ROWS.find((x) => x.edit && x.draftLines === 3 && x.bars.length === 0)!, true);
        const above = PHONES[1].column - PHONES[1].keyboard;
        // 111 dp of composer and a 65-dp banner in 147 dp: the field shows less than its three lines and scrolls in itself.
        expect(r.draft + r.composer - r.field + r.banner.content).toBeGreaterThan(above);
        expect(r.field).toBeLessThan(r.draft);
        expect(r.field).toBeGreaterThan(CHAT_INPUT_MIN_HEIGHT);
        expect(r.banner.height).toBeGreaterThanOrEqual(r.banner.content - EPS);
        expect(r.composerBox.bottom).toBe(above);
    });
});

describe('the check can fail', () => {
    beforeEach(() => { theme.colors = darkColors; });
    it('without the rooms (main before this change) the same column cut the box', () => {
        // The bars standing as they are (no barsRoom) and the banners unbounded: the composer ends past the keyboard's top.
        const kb = PHONES[0].keyboard;
        const composer = composerHeight(1.3, true, 1, false);
        chatAboutDrafts.set(CONVERSATION, { postId: 'post-twine-1', kind: 'offer', title: 'Garden twine, two rolls', price: '0.05 Beans' } as any);
        const tree = createElement('div', { 'data-testid': 'column', 'data-style': JSON.stringify({ height: PHONES[0].column, flexDirection: 'column' }) },
            createElement(DmKeyChangedPane, { card: null, maxHeight: 0 }, ...ROWS[3].bars.map((b) => barEl(b, 1.3))),
            createElement('div', { 'data-style': JSON.stringify({ flex: 1, paddingBottom: kb }) },
                createElement('div', { 'data-testid': 'thread', 'data-style': JSON.stringify({ flex: 1 }) }),
                createElement('div', { 'data-testid': 'box', 'data-style': '{}' },
                    createElement(ChatAboutBanner, { conversationId: CONVERSATION }),
                    createElement('div', { 'data-testid': 'composer', 'data-style': JSON.stringify({ height: composer }) }))));
        act(() => root.render(tree as Parameters<Root['render']>[0]));
        const q = (id: string) => host.querySelector(`[data-testid="${id}"]`)!;
        const layout = layOut(q('column'), { width: 320, height: PHONES[0].column }, { fontScale: 1.3 });
        expect(layout.height(q('thread'))).toBe(0);
        expect(topIn(layout, q('column'), q('composer')) + composer).toBeGreaterThan(PHONES[0].column - kb);
    });
    /**
     * f4bbcfa4's box: Editing, About and Replying to in one page opened at its top, in the room the composer and the thread's
     * line left (pageRoom(room − input − 44)), the composer at the draft's height. The table's ✕ check, on that box.
     */
    const before = (p: (typeof PHONES)[number], row: Row) => {
        const b = bannerEls();
        const room = p.column - p.keyboard;
        const composer = composerHeight(1.3, true, row.draftLines ?? 1, false);
        const left = room - composer - CHAT_THREAD_LINE;
        const banners = left < CHAT_PAGE_MIN ? 0 : left;
        if (row.about) chatAboutDrafts.set(CONVERSATION, { postId: 'post-twine-1', kind: 'offer', title: 'Garden twine, two rolls', price: '0.05 Beans' } as any);
        const tree = createElement('div', { 'data-testid': 'column', 'data-style': JSON.stringify({ height: p.column, flexDirection: 'column' }) },
            createElement('div', { 'data-style': JSON.stringify({ flex: 1, paddingBottom: p.keyboard }) },
                createElement('div', { 'data-testid': 'thread', 'data-style': JSON.stringify({ flex: 1 }) }),
                createElement('div', { 'data-testid': 'box', 'data-style': '{}' },
                    createElement(ChatScrollPage, { testID: 'chat-box-banners', maxHeight: banners },
                        row.edit ? b.edit : null,
                        !row.edit ? createElement(ChatAboutBanner, { conversationId: CONVERSATION }) : null,
                        row.reply && !row.edit ? b.reply : null),
                    createElement('div', { 'data-testid': 'composer', 'data-style': JSON.stringify({ height: composer }) }))));
        act(() => root.render(tree as Parameters<Root['render']>[0]));
        const q = (id: string) => host.querySelector(`[data-testid="${id}"]`)!;
        const layout = layOut(q('column'), { width: p.width, height: p.column }, { fontScale: 1.3 });
        const cancel = host.querySelector('[aria-label="Cancel reply"], [aria-label="Cancel edit"]')!;
        const pageTop = topIn(layout, q('column'), q('chat-box-banners'));
        const at = topIn(layout, q('column'), cancel);
        return at >= pageTop - EPS && at + layout.height(cancel) <= pageTop + layout.height(q('chat-box-banners')) + EPS;
    };
    it('f4bbcfa4 folded Editing at two lines on 320 × 533 and Replying to at three on 320 × 569 (finding 1)', () => {
        expect(before(PHONES[1], { name: '', bars: [], edit: true, draftLines: 2 })).toBe(false);
        expect(before(PHONES[0], { name: '', bars: [], reply: true, draftLines: 3 })).toBe(false);
    });
    it('f4bbcfa4 showed the About chip and none of Replying to\'s ✕ in the walk\'s DM (finding 2)', () => {
        expect(before(PHONES[0], ROWS[4])).toBe(false);
    });
});

// ---- The screen itself: [id].tsx hands the bars, the About chip, the banner and the composer their rooms ----

describe('app/chat/[id].tsx gives the bars, the About chip, the banner and the composer their rooms (chatColumnFit)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'chat', '[id].tsx'), 'utf8');
    it('the fit is worked out from the column, the box measured whole, the composer and the banner alone and the keyboard; paused while the key card is up', () => {
        expect(src).toMatch(/const fit = chatColumnFit\(\{\s*column: column\.column, box: column\.composer, input: inputHeight, banner: bannerHeight,\s*windowHeight, keyboard: keyboardHeight, paused: keyChangePending,\s*\}\);/);
    });
    it('the pane takes the bars\' room beside the card\'s, and keeps the bars at their end', () => {
        expect(src).toMatch(/maxHeight=\{dmKeyBannerMaxHeight\(\{ \.\.\.column, windowHeight, keyboard: keyboardHeight \}\)\}\s*barsRoom=\{fit\.bars\}\s*>/);
        const pane = fs.readFileSync(path.join(__dirname, '..', '..', 'components', 'chat', 'DmKeyChangedPane.tsx'), 'utf8');
        expect(pane).toContain('<ChatScrollPage testID="chat-bars-page" maxHeight={barsRoom} anchor="end">');
    });
    it('inside the box measured whole: the About chip\'s page, then the banner whole in its crop, then the composer measured alone with its room', () => {
        const box = src.indexOf("<View onLayout={measured('composer')}>");
        expect(box).toBeGreaterThan(-1);
        const rest = src.slice(box);
        // The box has no style; the About chip's page comes first, while not editing.
        expect(rest).toMatch(/^<View onLayout=\{measured\('composer'\)\}>\s*\{!editingMessage && \(\s*<ChatScrollPage testID="chat-about-page" maxHeight=\{fit\.about\}>\s*<ChatAboutBanner conversationId=\{String\(id\)\} \/>\s*<\/ChatScrollPage>\s*\)\}\s*<View testID="chat-box-banner"/);
        // The banner: a crop at its room, the banner measured whole inside it (rounded up), holding Editing and Replying to.
        const crop = '<View testID="chat-box-banner" style={{ maxHeight: fit.banner, overflow: \'hidden\', justifyContent: \'center\' }}>';
        const measuredBanner = '<View onLayout={(e) => setBannerHeight(Math.ceil(e.nativeEvent.layout.height))}>';
        expect(rest).toContain(`${crop}\n                ${measuredBanner}`);
        const inner = rest.indexOf(measuredBanner);
        const input = rest.indexOf('<View onLayout={(e) => setInputHeight(Math.round(e.nativeEvent.layout.height))}>');
        for (const banner of ['<ChatEditBanner', '<ChatReplyBanner']) {
            const at = rest.indexOf(banner);
            expect(at, banner).toBeGreaterThan(inner);
            expect(at, banner).toBeLessThan(input);
        }
        // The crop and the measured View close straight before the composer's measure; nothing else between.
        expect(rest.slice(rest.indexOf('<ChatReplyBanner'), input)).toMatch(/\}\)\(\)\}\s*<\/View>\s*<\/View>\s*\{\/\*[^*]*\*\/\}\s*$/);
        expect(rest.slice(input + '<View onLayout={(e) => setInputHeight(Math.round(e.nativeEvent.layout.height))}>'.length)).toMatch(/^\s*\{isPeerBlocked \? \(/);
        // The composer has its room.
        const composer = rest.indexOf('<ChatComposer');
        expect(composer).toBeGreaterThan(input);
        expect(rest.slice(composer)).toMatch(/^<ChatComposer\s[^<]*?bottomPadding=\{keyboardVisible \? 8 : Math\.max\(insets\.bottom, 12\)\}\s*maxHeight=\{fit\.composer\}\s/);
        // The composer's View closes, then the box's, then the keyboard view: nothing else under the composer.
        expect(src).toMatch(/<ChatComposer[\s\S]*?\/>\s*\)\}\s*<\/View>\s*<\/View>\s*<\/KeyboardAvoidingView>/);
    });
});
