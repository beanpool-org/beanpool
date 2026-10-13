// @vitest-environment jsdom
/**
 * The tour's bar (components/TourBar.tsx) and the "?"'s sheet (components/HelpSheet.tsx) rendered for real at the floor
 * (320 dp, text at 1.3×; scratch/global-node/DESIGN-getting-started-fable.md §2, §4): react-dom in jsdom, React Native's host
 * components as plain tags carrying their accessibility props and their flattened style, the real light and dark
 * palettes, the real steps and words (@beanpool/core tour.ts) and the bundled guide (utils/guide.ts).
 *
 * Nothing here draws a frame (vitest.config.ts): what is checked is the tree, its words, the style each element is given
 * measured against the palette it is drawn on, and a line model of the bar's height at the floor.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { HELP_MAP, TOUR_STEP_MAX_CHARS, helpSheetFor, phoneHelpKey, tourSteps, type TourNodeFacts } from '@beanpool/core';
import { darkColors, lightColors } from '../../constants/colors';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button' };
    const flat = (style: unknown): Record<string, unknown> => Object.assign({}, ...[style].flat(4).filter(Boolean));
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, disabled, accessibilityLiveRegion, maxFontSizeMultiplier } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (accessibilityLiveRegion) attrs['aria-live'] = accessibilityLiveRegion;
        if (testID) attrs['data-testid'] = testID;
        if (disabled) attrs['aria-disabled'] = 'true';
        if (maxFontSizeMultiplier) attrs['data-max-scale'] = String(maxFontSizeMultiplier);
        const style = typeof props.style === 'function' ? props.style({ pressed: false }) : props.style;
        attrs['data-style'] = JSON.stringify(flat(style));
        return createElement(tag, attrs, typeof children === 'function' ? children({ pressed: false }) : children);
    };
    return {
        View: el('div'), Text: el('span'), Pressable: el('button'),
        Modal: ({ visible, children }: { visible: boolean; children?: ReactNode }) => (visible ? createElement('div', { 'data-modal': 'true' }, children) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 },
    };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
vi.mock('../../components/home/EditHomeSheet', () => ({
    editHomeStyles: { backdrop: {}, sheet: {}, head: {}, title: { fontSize: 18 }, done: { minHeight: 48, minWidth: 48 }, doneText: {} },
}));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() } }));

const { TourBar, TOUR_TARGET_DP } = await import('../../components/TourBar');
const { HelpSheet } = await import('../../components/HelpSheet');
const { getBundledGuide } = await import('../guide');

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
});
function draw(node: ReactNode) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root!.render(node as Parameters<Root['render']>[0]); });
}
const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const styleOf = (e: Element | null) => JSON.parse(e?.getAttribute('data-style') ?? '{}') as Record<string, any>;

/** WCAG contrast of two #rrggbb colours. */
function contrast(fg: string, bg: string): number {
    const lum = (hex: string) => {
        const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
            .map(x => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [a, b] = [lum(fg), lum(bg)];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** The floor: 320 dp wide, the member's text at 1.3×, held by the bar's own cap. */
const FLOOR = { width: 320, fontScale: 1.3 };
/** Lines of `text` in `widthDp` at `fontPt` × scale, at the 0.55 em average a sentence measures (home-layout-320's model). */
const lines = (text: string, widthDp: number, fontPt: number, scale: number) => {
    const perLine = Math.floor(widthDp / (fontPt * scale * 0.55));
    let n = 1, at = 0;
    for (const w of text.split(' ')) {
        if (at > 0 && at + 1 + w.length > perLine) { n++; at = w.length; } else at += (at ? 1 : 0) + w.length;
    }
    return n;
};

const SCHEMES = [['light', lightColors], ['dark', darkColors]] as const;
const NODES: [string, TourNodeFacts][] = [['local', { global: false, beans: true }], ['global', { global: true, beans: false }]];
const home = (on: string[] = []) => ({
    chips: ['steps', 'market', 'beans'], chipName: (t: string) => ({ steps: 'First steps', market: 'New in the Market', beans: 'Your Beans' } as Record<string, string>)[t],
    onHome: (t: string) => on.includes(t), addChip: vi.fn(), moreCards: vi.fn(), end: vi.fn(), restart: vi.fn(),
});

describe('the tour bar at 320 dp × 1.3, light and dark, on every step', () => {
    for (const [scheme, colors] of SCHEMES) {
        for (const [name, node] of NODES) {
            const steps = tourSteps('phone', node);
            it(`${scheme}, ${name}: each of the ${steps.length} steps says "STEP n OF ${steps.length}", its words, Skip and Next (Done last), all readable`, () => {
                steps.forEach((step, i) => {
                    draw(createElement(TourBar, { steps, index: i, home: home(), colors, bottomInset: 0, onNext: vi.fn(), onSkip: vi.fn(), onDone: vi.fn() }));
                    expect(q('tour-step-caption')!.textContent).toBe(`STEP ${i + 1} OF ${steps.length}`);
                    expect(q('tour-words')!.textContent).toBe(step.words);
                    expect(q('tour-words')!.getAttribute('aria-live')).toBe('polite');
                    expect(q('tour-skip')!.getAttribute('aria-label')).toBe('Skip the tour');
                    const last = i === steps.length - 1;
                    expect(q(last ? 'tour-done' : 'tour-next')!.textContent).toBe(last ? 'Done' : 'Next ›');
                    // Readable in both schemes: the words, the caption and Skip on the bar; Next's white on its green.
                    const bar = styleOf(q('tour-bar'));
                    const bg = colors.surface.card;
                    expect(bar.backgroundColor).toBe(bg);
                    expect(contrast(styleOf(q('tour-words')).color, bg)).toBeGreaterThanOrEqual(4.5);
                    expect(contrast(styleOf(q('tour-step-caption')).color, bg)).toBeGreaterThanOrEqual(4.5);
                    expect(contrast(styleOf(q('tour-skip')!.firstElementChild).color, bg)).toBeGreaterThanOrEqual(4.5);
                    const next = q(last ? 'tour-done' : 'tour-next')!;
                    expect(contrast(styleOf(next.firstElementChild).color, styleOf(next).backgroundColor)).toBeGreaterThanOrEqual(3.5);
                    // Every target is the floor's 48 dp.
                    for (const id of ['tour-skip', last ? 'tour-done' : 'tour-next']) expect(styleOf(q(id)).minHeight).toBeGreaterThanOrEqual(TOUR_TARGET_DP);
                    act(() => root?.unmount());
                    host?.remove();
                });
            });
        }
    }

    it('the last step offers the three chips, More cards and Done; a chip already on Home reads "On Home ✓" and is not a button to press', () => {
        const steps = tourSteps('phone', NODES[0][1]);
        const h = home(['market']);
        draw(createElement(TourBar, { steps, index: steps.length - 1, home: h, colors: lightColors, bottomInset: 0, onNext: vi.fn(), onSkip: vi.fn(), onDone: vi.fn() }));
        expect(q('tour-chip-steps')!.textContent).toBe('First steps');
        expect(q('tour-chip-market')!.textContent).toBe('New in the Market · On Home ✓');
        expect(q('tour-chip-market')!.getAttribute('aria-disabled')).toBe('true');
        act(() => { q('tour-chip-beans')!.click(); });
        expect(h.addChip).toHaveBeenCalledWith('beans');
        act(() => { q('tour-more-cards')!.click(); });
        expect(h.moreCards).toHaveBeenCalled();
        for (const id of ['tour-chip-steps', 'tour-chip-beans', 'tour-more-cards']) expect(styleOf(q(id)).minHeight).toBeGreaterThanOrEqual(TOUR_TARGET_DP);
    });

    it('never blocks a tap behind it: one strip at the bottom of the screen, no backdrop, no modal, nothing over the tabs', () => {
        const steps = tourSteps('phone', NODES[0][1]);
        draw(createElement(TourBar, { steps, index: 2, home: home(), colors: lightColors, bottomInset: 0, onNext: vi.fn(), onSkip: vi.fn(), onDone: vi.fn() }));
        const bar = styleOf(q('tour-bar'));
        expect(bar).toMatchObject({ position: 'absolute', left: 0, right: 0, bottom: 0 });
        expect(bar.top).toBeUndefined();
        expect(bar.height).toBeUndefined();
        expect(document.querySelector('[data-modal]')).toBeNull();
    });

    it('at the floor the bar stays short: its words at most four lines, under 200 dp a step (the window is 569 dp)', () => {
        for (const [, node] of NODES) {
            for (const step of tourSteps('phone', node)) {
                expect(step.words.length).toBeLessThanOrEqual(TOUR_STEP_MAX_CHARS);
                const scale = Math.min(FLOOR.fontScale, 1.2);
                const n = lines(step.words, FLOOR.width - 32, 15, scale);
                expect(n, step.words).toBeLessThanOrEqual(4);
                const barDp = 10 + 11 * scale * 1.4 + 4 + n * 21 * scale + 8 + TOUR_TARGET_DP + 8;
                expect(barDp, step.id).toBeLessThan(200);
            }
        }
    });
});

describe('the "?" sheet: the guide page for the screen you are on, light and dark', () => {
    const guide = getBundledGuide();
    const keys = ['/', '/market', '/map', '/chats', '/projects', '/ledger', '/pulse', '/people', '/settings'].map(p => phoneHelpKey(p));

    it('every phone tab has a title and words from the bundled guide (help line, else summary, else section), and a page or section to read', () => {
        for (const key of keys) {
            const sheet = helpSheetFor(guide, key);
            expect(HELP_MAP[key], key).toBeTruthy();
            expect(sheet.title, key).toBeTruthy();
            expect(sheet.text, key).toBeTruthy();
            expect(sheet.slug ?? sheet.section, key).toBeTruthy();
        }
    });

    for (const [scheme, colors] of SCHEMES) {
        it(`${scheme}: title, words and the three rows; Take the tour again (Pick up the tour while one runs); readable`, () => {
            const sheet = helpSheetFor(guide, 'market');
            const on = { onReadPage: vi.fn(), onSearch: vi.fn(), onTour: vi.fn(), onClose: vi.fn() };
            draw(createElement(HelpSheet, { visible: true, sheet, tourOpen: false, canTour: true, colors, ...on }));
            expect(q('help-title')!.textContent).toBe(sheet.title);
            expect(q('help-text')!.textContent).toBe(sheet.text);
            expect(q('help-read-page')!.textContent).toBe('Read the guide page ›');
            expect(q('help-search')!.textContent).toBe('Search the guide');
            expect(q('help-tour')!.textContent).toBe('Take the tour again');
            const bg = colors.surface.card;
            expect(contrast(styleOf(q('help-text')).color, bg)).toBeGreaterThanOrEqual(4.5);
            for (const id of ['help-read-page', 'help-search', 'help-tour']) {
                expect(contrast(styleOf(q(id)!.firstElementChild).color, bg)).toBeGreaterThanOrEqual(4.5);
                expect(styleOf(q(id)).minHeight).toBeGreaterThanOrEqual(48);
            }
            act(() => { q('help-read-page')!.click(); q('help-search')!.click(); q('help-tour')!.click(); });
            expect(on.onReadPage).toHaveBeenCalled();
            expect(on.onSearch).toHaveBeenCalled();
            expect(on.onTour).toHaveBeenCalled();
            act(() => root?.unmount());
            host?.remove();
            draw(createElement(HelpSheet, { visible: true, sheet, tourOpen: true, canTour: true, colors, ...on }));
            expect(q('help-tour')!.textContent).toBe('Pick up the tour');
        });
    }

    it('never dead: with no words for a screen it still has Search and the tour, and never says "no help here"', () => {
        const none = { title: null, text: null, slug: null, section: null };
        draw(createElement(HelpSheet, { visible: true, sheet: none, tourOpen: false, canTour: true, colors: lightColors, onReadPage: vi.fn(), onSearch: vi.fn(), onTour: vi.fn(), onClose: vi.fn() }));
        expect(q('help-read-page')).toBeNull();
        expect(q('help-search')).not.toBeNull();
        expect(q('help-tour')).not.toBeNull();
        expect(document.body.textContent).not.toMatch(/no help/i);
    });
});
