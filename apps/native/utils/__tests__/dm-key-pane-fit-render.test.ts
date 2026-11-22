// @vitest-environment jsdom
/**
 * The verified key-changed card on a small phone (walk of 17 Nov, scratch/walks shots 13, 27 and 29): at 320 dp with
 * 1.3× text the card had 219 dp, its title and part of its body, with the code, the tick and "Continue with the new
 * key" in a scroll inside the card, cut at its edge with no hint; with the keyboard up it had only its title.
 *
 * Under the header the DM screen's column holds two things (app/chat/[id].tsx, held by the source check at the end): the
 * pane (components/chat/DmKeyChangedPane.tsx) and the keyboard view (the thread, then the box). While the key card is
 * up, the pane is one page: the card, then whatever stands between it and the thread (the deals strip, the listing's
 * header, the release bar), scrolling together in the room dmKeyBannerMaxHeight gives it, the column less the box and a
 * keyboard still up. The deciding review of 6775428c (finding 1) measured the box cut by 70 dp in a DM about a listing
 * when those bars stood outside the card's room; no sum of them can stand there either: at 320 × 533 and 1.3× text the
 * listing header, the release bar, the about chip and the box fill the column, and the card would have nothing.
 *
 * One table over (light, dark) × (phone, text size) × (what stands between the card and the thread) × (keyboard down,
 * up): the real card rendered into jsdom with React Native's host components as tags, laid out by Yoga
 * (yoga-dom-layout.ts) in that column. In every row: the box and its paused line are never cut; the card is at the top
 * of the page with at least a button's height of it in view, so Continue and Not now are reachable; a page taller than
 * its room fills the room down to the box (the thread gives way) and scrolls, its scroll bar always shown and its bottom
 * edge fading; a keyboard up when the pause starts is put away, once. A sheet the chat opens over the paused card (its
 * Review and Report sheets) keeps its keyboard (finding 2): one row per sheet, and a check that they are every sheet
 * with a field. (Where words land in pixels is the phone's to show: Yoga's text is an estimate, so the owed walk checks it.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, forwardRef, useImperativeHandle } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createElement: h } = await import('react');
    const flat = (style: unknown): Record<string, unknown> => (Array.isArray(style) ? Object.assign({}, ...style.map(flat)) : (style as Record<string, unknown>) ?? {});
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, disabled, testID, style } = props;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat(style)) };
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        return h(tag, attrs, children);
    };
    // A ScrollView: its frame, and inside it the content at its own height (Yoga's overflow scroll leaves the scroll
    // axis open). What the member is shown about scrolling is written out for the table to read.
    const ScrollView = forwardRef((props: Record<string, any>, ref) => {
        useImperativeHandle(ref, () => ({ flashScrollIndicators: () => scroll.flashed++ }));
        scroll.onSize = props.onContentSizeChange;
        return h('div', {
            'data-testid': props.testID, 'data-style': JSON.stringify({ ...flat(props.style), overflow: 'scroll' }),
            'data-persistent-scrollbar': String(!!props.persistentScrollbar),
            'data-fade': String(props.fadingEdgeLength ?? 0),
        }, h('div', { 'data-testid': 'pane-content', 'data-style': '{}' }, props.children));
    });
    return { View: el('div'), Text: el('span'), Pressable: el('div'), ScrollView, StyleSheet: { create: (s: unknown) => s } };
});
const scroll = vi.hoisted(() => ({ flashed: 0, onSize: undefined as undefined | ((w: number, h: number) => void) }));
const keyboard = vi.hoisted(() => ({ isVisible: false, height: 0, dismiss: vi.fn(async () => {}) }));
vi.mock('react-native-keyboard-controller', () => ({
    useKeyboardState: (pick: (s: { isVisible: boolean; height: number }) => unknown) => pick({ isVisible: keyboard.isVisible, height: keyboard.height }),
    KeyboardController: { dismiss: keyboard.dismiss },
}));
const theme = vi.hoisted(() => ({ colors: null as any }));
vi.mock('../../app/ThemeContext', () => ({
    useTheme: () => ({ colors: theme.colors }),
    useStyles: (make: (c: { colors: unknown }) => unknown) => make({ colors: theme.colors }),
}));
vi.mock('../db', () => ({}));
const screen = vi.hoisted(() => ({ inFront: true }));
vi.mock('expo-router', () => ({ useIsFocused: () => screen.inFront }));

import { lightColors, darkColors } from '../../constants/colors';
import { DmKeyChangedPane } from '../../components/chat/DmKeyChangedPane';
import { dmKeyBannerMaxHeight } from '../dm-key-change';
import { layOut } from './yoga-dom-layout';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); scroll.flashed = 0; keyboard.dismiss.mockClear(); });
afterEach(() => { act(() => root.unmount()); host.remove(); keyboard.isVisible = false; keyboard.height = 0; screen.inFront = true; });

/**
 * The DM screen's column under the header (screen − nav bar − status bar 24 − header 64): the walk's phone from its dump
 * (480 × 854 px at 1.5: the column 96 → 521 dp), 320 × 533 with a 48-dp nav bar, and a tall phone.
 */
const PHONES = [
    { name: 'the walk\'s 320 × 569', width: 320, column: 425 },
    { name: '320 × 533, 48-dp nav bar', width: 320, column: 397 },
    { name: 'a tall phone, 412 × 915, 48-dp nav bar', width: 412, column: 779 },
] as const;
/** The paused composer with its line, as #1873's geometry has it at each text size. */
const COMPOSER = { 1: 101, 1.3: 109 } as const;
/** How much of the composer its paused line takes ("Sending waits until you decide…", up to three lines at 1.3×). */
const LINE = { 1: 40, 1.3: 50 } as const;
/**
 * What can stand between the card and the thread, from [id].tsx's styles with a line 1.25× its font size: the deals strip
 * (a 200-dp card: title, meta, a button row, in 10 dp of padding), the listing's header (title and price in 12 dp of
 * padding), the release bar (its warning, two or three lines of caution and a button row, at 320 dp).
 */
const BARS = {
    deals: { 1: 114, 1.3: 128 },
    listing: { 1: 62, 1.3: 73 },
    release: { 1: 116, 1.3: 174 },
} as const;
type Bar = keyof typeof BARS;
/** The about chip over the composer ("About: Fresh eggs · 6 Beans" and its ✕), inside the box: 20 dp of padding, a 44-dp ✕, its border. */
const ABOUT = 65;
/** The walk's keyboard (shot 27: 405 → 782 px at 1.5). */
const KEYBOARD = 250;

const ROWS: { name: string; bars: Bar[]; about: boolean }[] = [
    { name: 'no listing header', bars: [], about: false },
    { name: 'the listing\'s header', bars: ['listing'], about: false },
    { name: 'the listing\'s header and the release bar', bars: ['listing', 'release'], about: false },
    { name: 'the listing\'s header, the release bar and the about chip', bars: ['listing', 'release'], about: true },
    { name: 'the deals strip, the listing\'s header, the release bar and the about chip', bars: ['deals', 'listing', 'release'], about: true },
];

const card = () => ({
    peerName: 'Ben', change: { offeredPeer: randomBytes(32).toString('hex'), firstSight: false, verified: true },
    onContinue: vi.fn(), onNotNow: vi.fn(),
});

/** The column as [id].tsx stacks it: the pane (the card, then the bars), then the keyboard view (the thread, the box). */
function columnTree(o: { column: number; fontScale: 1 | 1.3; bars: Bar[]; about: boolean; kb: number; maxHeight: number; card: ReturnType<typeof card> | null }) {
    const bar = (id: Bar) => createElement('div', { key: id, 'data-testid': id, 'data-style': JSON.stringify({ height: BARS[id][o.fontScale] }) });
    const composer = COMPOSER[o.fontScale];
    return createElement('div', { 'data-testid': 'column', 'data-style': JSON.stringify({ height: o.column, flexDirection: 'column' }) },
        createElement(DmKeyChangedPane, { maxHeight: o.maxHeight, card: o.card }, ...o.bars.map(bar)),
        // The keyboard view: the thread (flex 1), the box measured whole (the about chip over the composer, its paused
        // line on top), and the keyboard's padding under it.
        createElement('div', { 'data-style': JSON.stringify({ flex: 1, paddingBottom: o.kb }) },
            createElement('div', { 'data-testid': 'thread', 'data-style': JSON.stringify({ flex: 1 }) }),
            createElement('div', { 'data-testid': 'box', 'data-style': '{}' },
                o.about ? createElement('div', { 'data-testid': 'about', 'data-style': JSON.stringify({ height: ABOUT }) }) : null,
                createElement('div', { 'data-testid': 'composer', 'data-style': JSON.stringify({ height: composer }) },
                    createElement('div', { 'data-testid': 'paused-line', 'data-style': JSON.stringify({ height: LINE[o.fontScale] }) })))));
}

function renderColumn(p: (typeof PHONES)[number], fontScale: 1 | 1.3, row: (typeof ROWS)[number], keyboardUp: boolean) {
    const column = p.column;
    keyboard.isVisible = keyboardUp;
    keyboard.height = keyboardUp ? KEYBOARD : 0;
    const kb = keyboardUp ? KEYBOARD : 0;
    // The box as [id].tsx measures it: everything under the thread.
    const box = COMPOSER[fontScale] + (row.about ? ABOUT : 0);
    const maxHeight = dmKeyBannerMaxHeight({ column, composer: box, windowHeight: column + 88, keyboard: kb });
    act(() => root.render(columnTree({ column, fontScale, bars: row.bars, about: row.about, kb, maxHeight, card: card() }) as Parameters<Root['render']>[0]));
    const q = (id: string) => host.querySelector(`[data-testid="${id}"]`)!;
    const layout = layOut(q('column'), { width: p.width, height: column }, { fontScale });
    const top = (el: Element) => { let y = 0; for (let e: Element | null = el; e && e !== q('column'); e = e.parentElement) y += layout.box(e).top; return y; };
    // The phone reports the content's size once laid out (twice here: a second report never flashes again).
    act(() => { scroll.onSize?.(p.width, layout.height(q('pane-content'))); scroll.onSize?.(p.width, layout.height(q('pane-content'))); });
    const within = (el: Element) => ({ top: top(el) - top(q('pane-content')), bottom: top(el) - top(q('pane-content')) + layout.height(el) });
    const button = (label: string) => host.querySelector(`[aria-label="${label}"]`)!;
    return {
        column, box, kb, maxHeight,
        pane: { top: top(q('dm-key-pane')), height: layout.height(q('dm-key-pane')), content: layout.height(q('pane-content')), el: q('dm-key-pane') },
        card: { ...within(q('pane-content').firstElementChild!), margin: Number(JSON.parse(q('pane-content').firstElementChild!.getAttribute('data-style')!).marginTop ?? 0) },
        bars: row.bars.map((b) => within(q(b))),
        continue: within(button('Continue with the new key')),
        notNow: within(button('Not now')),
        thread: layout.height(q('thread')),
        boxTop: top(q('box')), boxBottom: top(q('box')) + layout.height(q('box')),
        line: { top: top(q('paused-line')), bottom: top(q('paused-line')) + layout.height(q('paused-line')) },
    };
}

describe.each([['light', lightColors], ['dark', darkColors]] as const)('the verified key card on a small phone, %s', (_name, colors) => {
    beforeEach(() => { theme.colors = colors; });
    for (const p of PHONES) for (const fontScale of [1, 1.3] as const) for (const row of ROWS) for (const keyboardUp of [false, true]) {
        // With a keyboard up a phone this short has no room for the box over it at all, card or no card (the about chip
        // and the composer over a 250-dp keyboard): the card puts that keyboard away (the rows with it down).
        if (keyboardUp && COMPOSER[fontScale] + (row.about ? ABOUT : 0) + KEYBOARD > p.column) continue;
        it(`${p.name} at ${fontScale}×, ${row.name}, keyboard ${keyboardUp ? 'up' : 'down'}: the box and its paused line are never cut, the card's buttons are reachable`, () => {
            const r = renderColumn(p, fontScale, row, keyboardUp);
            // The box, its paused line on top, sits whole above the keyboard, under the page.
            expect(r.boxBottom - r.boxTop).toBe(r.box);
            expect(r.boxBottom + r.kb).toBeLessThanOrEqual(r.column);
            expect(r.boxTop).toBeGreaterThanOrEqual(r.pane.top + r.pane.height);
            expect(r.line.top).toBeGreaterThanOrEqual(r.boxTop);
            expect(r.line.bottom + r.kb).toBeLessThanOrEqual(r.column);
            // The page starts under the header with the card at its top, then the bars in [id].tsx's order: all of it in
            // the scroll, so Continue, Not now and every bar's buttons are reachable.
            expect(r.pane.top).toBe(0);
            expect(r.card.top).toBe(r.card.margin);
            let below = r.card.bottom;
            for (const b of r.bars) { expect(b.top).toBe(below); below = b.bottom; }
            expect(below).toBe(r.pane.content);
            expect(r.continue.bottom).toBeLessThanOrEqual(r.card.bottom);
            expect(r.notNow.bottom).toBeLessThanOrEqual(r.card.bottom);
            if (!keyboardUp) {
                // At least a button's height (48 dp) of the page in view: scrolling brings each button whole into it.
                expect(r.pane.height).toBeGreaterThanOrEqual(48);
                // The page has the column less the box: no bar is left out of the sum to come off the box instead.
                expect(r.maxHeight).toBe(r.column - r.box);
            }
            if (r.pane.content > r.maxHeight) {
                // Taller than its room: it fills the room down to the box, with no strip of thread under a cut page, and
                // scrolls as the page. Its scroll is never hidden: the bar stays shown (Android), it flashes once on
                // opening (iOS), the edge fades.
                expect(r.pane.height).toBe(r.maxHeight);
                expect(r.thread).toBe(0);
                expect(r.pane.top + r.pane.height).toBe(r.boxTop);
                expect(r.pane.el.getAttribute('data-persistent-scrollbar')).toBe('true');
                expect(Number(r.pane.el.getAttribute('data-fade'))).toBeGreaterThan(0);
                expect(scroll.flashed).toBe(1);
            } else {
                // A page that fits stands whole; the thread has the rest.
                expect(r.pane.height).toBe(r.pane.content);
                expect(r.thread).toBe(r.column - r.kb - r.box - r.pane.content);
                expect(scroll.flashed).toBe(0);
            }
            // A keyboard up when the pause starts is put away: nothing can be typed in the box while the card is up.
            expect(keyboard.dismiss).toHaveBeenCalledTimes(keyboardUp ? 1 : 0);
        });
    }
    it('at 320 × 533 and 1.3×, a page that stood beside the bars would have nothing: they scroll with the card instead', () => {
        // The sum the deciding review asked for, taken whole: the listing's header, the release bar and the box with its
        // about chip leave no room for the card in this column. In the page, the card has all but the box.
        const fixed = BARS.listing[1.3] + BARS.release[1.3] + COMPOSER[1.3] + ABOUT;
        expect(397 - fixed).toBeLessThan(48);
        expect(dmKeyBannerMaxHeight({ column: 397, composer: COMPOSER[1.3] + ABOUT, windowHeight: 397 + 88 })).toBe(223);
    });
    it('with no key change the bars stand as they are under the header, nothing scrolls, and no keyboard is touched', () => {
        keyboard.isVisible = true;
        act(() => root.render(columnTree({ column: 397, fontScale: 1.3, bars: ['deals', 'listing', 'release'], about: false, kb: 0, maxHeight: 0, card: null }) as Parameters<Root['render']>[0]));
        expect(host.querySelector('[data-testid="dm-key-pane"]')).toBeNull();
        const columnEl = host.querySelector('[data-testid="column"]')!;
        expect(Array.from(columnEl.children).slice(0, 3).map((c) => c.getAttribute('data-testid'))).toEqual(['deals', 'listing', 'release']);
        expect(keyboard.dismiss).not.toHaveBeenCalled();
    });
});

// ---- The sheets over the paused chat (deciding review of 6775428c, finding 2) ----

const NATIVE = path.join(__dirname, '..', '..');
const parse = (rel: string) => ts.createSourceFile(rel, fs.readFileSync(path.join(NATIVE, rel), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const tagOf = (n: ts.Node): string | null => (ts.isJsxElement(n) ? n.openingElement.tagName.getText() : ts.isJsxSelfClosingElement(n) ? n.tagName.getText() : null);
function declared(sf: ts.SourceFile, name: string): ts.Node | undefined {
    let found: ts.Node | undefined;
    const visit = (n: ts.Node) => {
        if (found) return;
        if (ts.isFunctionDeclaration(n) && n.name?.text === name) found = n;
        else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) found = n;
        else ts.forEachChild(n, visit);
    };
    visit(sf);
    return found;
}
/** Where a JSX tag in `rel` comes from: a component in this app (a relative import, or declared in the same file), or null. */
function resolveTag(rel: string, sf: ts.SourceFile, tag: string): { rel: string; name: string } | null {
    if (!/^[A-Z]\w*$/.test(tag)) return null;
    if (declared(sf, tag)) return { rel, name: tag };
    for (const st of sf.statements) {
        if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !st.moduleSpecifier.text.startsWith('.')) continue;
        const clause = st.importClause;
        let name: string | null = null;
        if (clause?.name?.text === tag) name = 'default';
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
            for (const el of clause.namedBindings.elements) if (el.name.text === tag) name = (el.propertyName ?? el.name).text;
        }
        if (!name) continue;
        const base = path.join(path.dirname(rel), st.moduleSpecifier.text);
        const file = ['.tsx', '.ts', '/index.tsx', '/index.ts'].map((x) => base + x).find((f) => fs.existsSync(path.join(NATIVE, f)));
        return file ? { rel: file, name } : null;
    }
    return null;
}
function componentNode(rel: string, name: string): { sf: ts.SourceFile; node: ts.Node } | null {
    const sf = parse(rel);
    if (name !== 'default') { const node = declared(sf, name); return node ? { sf, node } : null; }
    const exp = sf.statements.find((s) => ts.isFunctionDeclaration(s) && s.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword));
    return exp ? { sf, node: exp } : null;
}
function tagsIn(node: ts.Node): ts.Node[] {
    const out: ts.Node[] = [];
    const visit = (n: ts.Node) => { if (tagOf(n)) out.push(n); ts.forEachChild(n, visit); };
    visit(node);
    return out;
}
/** Whether a piece of JSX holds a text field: a TextInput, or an app component that holds one. */
function holdsField(rel: string, sf: ts.SourceFile, node: ts.Node, seen: Set<string>): boolean {
    for (const t of tagsIn(node)) {
        const tag = tagOf(t)!;
        if (tag === 'TextInput') return true;
        const c = resolveTag(rel, sf, tag);
        const key = c && `${c.rel}#${c.name}`;
        if (!c || seen.has(key!)) continue;
        seen.add(key!);
        const comp = componentNode(c.rel, c.name);
        if (comp && holdsField(c.rel, comp.sf, comp.node, seen)) return true;
    }
    return false;
}
/** Every component under `name` (in `rel`) that draws a Modal holding a text field: the sheets a member can type in. */
function sheetsWithField(rel: string, name: string, seen = new Set<string>(), out = new Set<string>()): Set<string> {
    const comp = componentNode(rel, name);
    if (!comp) return out;
    for (const t of tagsIn(comp.node)) {
        const tag = tagOf(t)!;
        if (tag === 'Modal' && holdsField(rel, comp.sf, t, new Set())) out.add(name);
        const c = resolveTag(rel, comp.sf, tag);
        const key = c && `${c.rel}#${c.name}`;
        if (!c || seen.has(key!)) continue;
        seen.add(key!);
        sheetsWithField(c.rel, c.name, seen, out);
    }
    return out;
}

/** Every sheet the DM screen opens with a field in it, how a member opens it over the paused card, and the field. */
const SHEETS = [
    { name: 'ReportMessageSheet', how: 'Report on a long-pressed line, or on a request', field: '"Add a few words"' },
    { name: 'ReviewModal', how: '⭐ Review on the deals strip in the page, or a link with triggerReview', field: 'its comment' },
] as const;

describe('a sheet the chat opens over the paused card keeps its keyboard (deciding review of 6775428c, finding 2)', () => {
    beforeEach(() => { theme.colors = lightColors; });
    /** The paused chat at 320 × 533 and 1.3×, as [id].tsx renders it: the room less any keyboard up (keyboardHeight). */
    const paused = (c = card()) => act(() => root.render(columnTree({
        column: 397, fontScale: 1.3, bars: ['deals', 'listing'], about: false, kb: keyboard.isVisible ? KEYBOARD : 0, card: c,
        maxHeight: dmKeyBannerMaxHeight({ column: 397, composer: COMPOSER[1.3], windowHeight: 485, keyboard: keyboard.isVisible ? KEYBOARD : 0 }),
    }) as Parameters<Root['render']>[0]));

    it('these are every sheet under the DM screen (app/chat/[id].tsx ChatScreen) that holds a text field', () => {
        expect([...sheetsWithField('app/chat/[id].tsx', 'ChatScreen')].sort()).toEqual(SHEETS.map((s) => s.name));
    });
    for (const s of SHEETS) {
        it(`${s.name} (${s.how}): ${s.field} keeps the keyboard, every time it is tapped`, () => {
            const c = card();
            paused(c);
            expect(keyboard.dismiss).not.toHaveBeenCalled();
            // The sheet opens over the card (a Modal: the chat stays the screen in front) and its field is tapped. The
            // keyboard's state is the whole app's, so the screen re-renders with the room less the keyboard.
            for (let tap = 0; tap < 3; tap++) {
                keyboard.isVisible = true; keyboard.height = KEYBOARD;
                paused(c);
                keyboard.isVisible = false; keyboard.height = 0;
                paused(c);
            }
            expect(keyboard.dismiss).not.toHaveBeenCalled();
        });
    }
    it('a keyboard up when the pause starts is put away once; a sheet\'s field tapped after that keeps its own', () => {
        keyboard.isVisible = true; keyboard.height = KEYBOARD;
        const c = card();
        paused(c);
        expect(keyboard.dismiss).toHaveBeenCalledTimes(1);
        keyboard.isVisible = false; keyboard.height = 0;
        paused(c);
        keyboard.isVisible = true; keyboard.height = KEYBOARD;
        paused(c);
        expect(keyboard.dismiss).toHaveBeenCalledTimes(1);
    });
    it('a screen opened over the paused chat keeps its keyboard; when the chat comes back in front with one up, it is put away once', () => {
        const c = card();
        paused(c);
        screen.inFront = false;
        keyboard.isVisible = true; keyboard.height = KEYBOARD;
        paused(c);
        expect(keyboard.dismiss).not.toHaveBeenCalled();
        screen.inFront = true;
        paused(c);
        expect(keyboard.dismiss).toHaveBeenCalledTimes(1);
        paused(c);
        expect(keyboard.dismiss).toHaveBeenCalledTimes(1);
    });
});

// ---- The column itself (app/chat/[id].tsx): nothing stands in it beside the page, the thread and the box ----

describe('the DM screen\'s column holds the page and the keyboard view, nothing else (deciding review of 6775428c, finding 1)', () => {
    const sf = parse('app/chat/[id].tsx');
    const screenNode = declared(sf, 'ChatScreen')!;
    const jsxChildren = (n: ts.JsxElement) => n.children.filter((c) => !(ts.isJsxText(c) && !c.text.trim()) && !(ts.isJsxExpression(c) && !c.expression));
    const element = (tag: string) => tagsIn(screenNode).find((n) => tagOf(n) === tag) as ts.JsxElement;
    it('under the header, the column is DmKeyChangedPane then the KeyboardAvoidingView; the deals strip, the listing\'s header and the release bar are the pane\'s children', () => {
        const safe = element('SafeAreaView');
        const kids = jsxChildren(safe);
        const header = kids.findIndex((k) => (ts.isJsxElement(k) || ts.isJsxSelfClosingElement(k)) && k.getText().startsWith("<View style={styles.header} onLayout={measuredEdge('header')}>"));
        const kav = kids.findIndex((k) => tagOf(k) === 'KeyboardAvoidingView');
        expect(header).toBeGreaterThan(-1);
        expect(kids.slice(header + 1, kav).map((k) => tagOf(k) ?? k.getText().slice(0, 40))).toEqual(['DmKeyChangedPane']);
        const pane = kids[header + 1] as ts.JsxElement;
        const inPane = jsxChildren(pane).map((k) => k.getText());
        // In place (slice S6c) the standing deals' panels and the one line that their community didn't answer sit over them,
        // in the same page: neither is drawn in an ordinary chat.
        expect(inPane).toHaveLength(5);
        expect(inPane[0]).toMatch(/^\{standingThere\.map\(d => \(\s*<View key=\{`standing-\$\{d\.txId\}`\} style=\{styles\.standingThere\}>/);
        expect(inPane[1]).toMatch(/^\{!!inPlace && dealsThere\.state === 'failed' && [^\n]* && \(\s*<View style=\{styles\.dealsUnread\}/);
        expect(inPane[2]).toMatch(/^\{visibleDeals\.length > 0 && \(\s*<View style=\{styles\.dealStrip\}>/);
        expect(inPane[3]).toMatch(/^\{postContext && \(\s*<Pressable [^\n]*style=\{styles\.stickyHeader\}>/);
        expect(inPane[4]).toMatch(/^\{showInlineBar && pendingTx && \(\s*<View style=\{\[styles\.inlineActionBar/);
    });
    it('the keyboard view holds the thread and the box measured whole, nothing else', () => {
        const kids = jsxChildren(element('KeyboardAvoidingView'));
        expect(kids).toHaveLength(2);
        expect(kids[0].getText()).toMatch(/^\{shouldShowChatLoadError\(/);
        expect(kids[1].getText()).toMatch(/^<View onLayout=\{measured\('composer'\)\}>/);
    });
});
