// @vitest-environment jsdom
/**
 * Home's once card drawn (components/home/NotifyAskCard.tsx; DESIGN-notify-and-backup-asks-fable-amend2.md §7, mockup state
 * 5, slice N1h), through Home's real card frame (components/home/HomeParts.tsx HomeCard), in each of the phone's colour sets
 * (light and dark among them), at the floor's window (320 dp, text at 1.3x).
 *
 * What is checked: the sky band "NOTIFICATIONS"; the join's words with "a neighbour" for the name (core's notifyOnceWords),
 * the global community's line on its Home; "Turn on notifications", its line under it, then "Later" (each a 48 dp target);
 * a tap calls only its own handler, and neither while the answer is kept; every word readable on its ground (4.5:1) from the
 * central tokens; in every language and the pseudo one, no word wider than the card's line at 320 dp with 1.3x text.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as fs from 'node:fs';
import * as path from 'node:path';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const flat = (s: unknown): Record<string, unknown> => Object.assign({}, ...[s].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, disabled, style } = props;
        const resolved = typeof style === 'function' ? style({ pressed: false }) : style;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat(resolved)) };
        if (onPress && !disabled) attrs.onClick = () => onPress({ stopPropagation() {} });
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole) attrs['data-role'] = accessibilityRole;
        if (testID) attrs['data-testid'] = testID;
        if (disabled) attrs['aria-disabled'] = 'true';
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, flatten: (s: unknown) => flat(s) },
        View: el('div'), Text: el('span'), Pressable: el('button'),
        ActivityIndicator: () => createElement('span', { 'data-testid': 'spinner' }),
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));

const { NotifyAskCard, notifyAskCardStyles } = await import('../../components/home/NotifyAskCard');
const { HOME_CARD_PADDING_DP, HOME_GUTTER_DP, HOME_TARGET_DP } = await import('../../components/home/HomeParts');
const { COLOUR_SETS } = await import('../../constants/colors');
const { LANGS, PSEUDO_LANG, contrastRatio, notifyOnceWords, setLanguage } = await import('@beanpool/core');
type Catalog = Parameters<typeof setLanguage>[1] extends readonly (infer C)[] | undefined ? C : never;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    setLanguage('en');
});
const q = (id: string) => host!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const styleOf = (e: Element | null) => JSON.parse(e?.getAttribute('data-style') ?? '{}') as Record<string, any>;
const hex = (c: unknown): c is string => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);

function card(over: { set?: string; busy?: boolean; global?: boolean } = {}) {
    const onTurnOn = vi.fn();
    const onLater = vi.fn();
    const colors = (COLOUR_SETS as Record<string, any>)[over.set ?? 'light'];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const words = notifyOnceWords({ global: !!over.global, community: 'Riverside' });
    act(() => { root!.render(createElement(NotifyAskCard, { words, colors, busy: !!over.busy, onTurnOn, onLater })); });
    return { onTurnOn, onLater, colors };
}

describe("Home's once card, at 320 dp with 1.3x text", () => {
    it('the sky band, "Hear from Riverside", the reason, what arrives with "a neighbour", Never ads, then the two buttons', () => {
        card();
        expect(q('card-band-notify-once')?.textContent).toBe('Notifications');
        expect(q('notify-once-title')?.textContent).toBe('Hear from Riverside');
        expect(host!.textContent).toContain('BeanPool never emails or texts you. Notifications are the only way it can reach you.');
        expect(q('notify-once-arrives')?.textContent).toBe("When a neighbour writes, someone answers you, or an event you're going to changes. Never ads.");
        const text = host!.textContent!;
        const order = ['Hear from Riverside', 'Never ads.', 'Turn on notifications', 'Your phone will ask you to confirm.', 'Later'].map((w) => text.indexOf(w));
        expect(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1]))).toBe(true);
        // No ×: its two answers are its only ways off (untouched, it folds by itself after 7 days).
        expect(text).not.toContain('✕');
    });

    it("the global community's Home: the global join's line, and no community's name", () => {
        card({ global: true });
        expect(q('notify-once-title')?.textContent).toBe('Hear from your community');
        expect(q('notify-once-arrives')?.textContent).toBe('When someone writes to you, or a community answers your request to join. Never ads.');
    });

    it('each tap calls only its own; while the answer is kept both wait and no second tap lands', () => {
        const { onTurnOn, onLater } = card();
        act(() => { q('notify-once-turn-on')!.click(); });
        expect(onTurnOn).toHaveBeenCalledTimes(1);
        expect(onLater).not.toHaveBeenCalled();
        act(() => { q('notify-once-later')!.click(); });
        expect(onLater).toHaveBeenCalledTimes(1);
        expect(onTurnOn).toHaveBeenCalledTimes(1);
        act(() => root?.unmount()); host?.remove();
        const busy = card({ busy: true });
        act(() => { q('notify-once-turn-on')!.click(); q('notify-once-later')!.click(); });
        expect(busy.onTurnOn).not.toHaveBeenCalled();
        expect(busy.onLater).not.toHaveBeenCalled();
        expect(q('spinner')).toBeTruthy();
    });

    it('both buttons are 48 dp targets that fill the card\'s width and wrap their words; nothing has a fixed width', () => {
        card();
        expect(styleOf(q('notify-once-turn-on')).minHeight).toBeGreaterThanOrEqual(HOME_TARGET_DP);
        expect(styleOf(q('notify-once-later')).minHeight).toBeGreaterThanOrEqual(HOME_TARGET_DP);
        for (const s of Object.values(notifyAskCardStyles) as Record<string, unknown>[]) {
            for (const k of ['width', 'height', 'maxWidth']) expect(s[k], k).toBeUndefined();
        }
        // Sits in Home's gutters, as every card.
        expect(styleOf(q('home-notify-once')).marginHorizontal).toBe(HOME_GUTTER_DP);
    });

    for (const set of Object.keys(COLOUR_SETS)) {
        it(`${set}: every word readable on its ground (4.5:1), every colour a central token`, () => {
            const { colors } = card({ set });
            const ground = styleOf(q('home-notify-once')).backgroundColor;
            expect(ground).toBe(colors.surface.card);
            const band = q('card-band-notify-once')!;
            expect(styleOf(band).backgroundColor).toBe(colors.card.sky.tint);
            const caption = band.querySelector('span')!;
            expect(contrastRatio(styleOf(caption).color, colors.card.sky.tint), `${set}: the band`).toBeGreaterThanOrEqual(4.5);
            for (const id of ['notify-once-title', 'notify-once-arrives']) {
                const fg = styleOf(q(id)).color;
                if (hex(fg) && hex(ground)) expect(contrastRatio(fg, ground), `${set}: ${id}`).toBeGreaterThanOrEqual(4.5);
            }
            for (const span of Array.from(q('notify-once-later')!.parentElement!.querySelectorAll(':scope > span')) as HTMLElement[]) {
                const fg = styleOf(span).color;
                if (hex(fg) && hex(ground)) expect(contrastRatio(fg, ground), `${set}: "${span.textContent}"`).toBeGreaterThanOrEqual(4.5);
            }
            const later = styleOf(q('notify-once-later')!.querySelector('span')).color;
            expect(contrastRatio(later, ground), `${set}: Later`).toBeGreaterThanOrEqual(4.5);
            const turnOn = q('notify-once-turn-on')!;
            expect(styleOf(turnOn).backgroundColor).toBe(colors.action.cta);
            const label = styleOf(turnOn.querySelector('span')).color;
            expect(label).toBe(colors.text.onBrand);
            expect(contrastRatio(label, colors.action.cta), `${set}: Turn on notifications`).toBeGreaterThanOrEqual(4.5);
        });
    }

    it('not one colour written in the card itself: every one is a token', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../../components/home/NotifyAskCard.tsx'), 'utf8');
        expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    });

    // A word wider than its line would run off the side at 320 dp. The card's line is the screen less Home's two gutters, the
    // card's padding and its border; a button's, less its own padding too. The glyph model is the join screen's
    // (welcome-notify-step-render.test.ts): 0.62em a letter, 1em a CJK character (which breaks anywhere), at 1.3x.
    const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u;
    const glyphEm = (c: string) => (/\p{M}/u.test(c) || /[\ufe0f\u200c\u200d]/.test(c) ? 0 : /\p{Extended_Pictographic}/u.test(c) ? 1.25 : CJK.test(c) ? 1 : 0.62);
    const widthOf = (text: string, size: number) => Array.from(text).reduce((w, c) => w + glyphEm(c) * size * 1.3, 0);
    const widest = (text: string) => text.split(/[\s~]+/).flatMap((w) => (CJK.test(w) ? Array.from(w) : [w])).reduce((a, w) => (widthOf(w, 1) > widthOf(a, 1) ? w : a), '');
    const LINE = 320 - 2 * HOME_GUTTER_DP - 2 * HOME_CARD_PADDING_DP - 2;
    const catalog = (lang: string): Catalog => JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../../../packages/beanpool-core/words/${lang}.json`), 'utf8'));
    for (const lang of [...LANGS, PSEUDO_LANG]) {
        it(`${lang}: no word of the card is wider than its line at 320 dp with 1.3x text`, () => {
            setLanguage(lang as never, lang === 'en' || lang === PSEUDO_LANG ? [] : [catalog(lang)]);
            const s = notifyAskCardStyles as unknown as Record<string, { fontSize: number; paddingHorizontal?: number }>;
            const inButton = (k: 'turnOn' | 'later') => LINE - 2 * (s[k].paddingHorizontal ?? 0);
            for (const global of [false, true]) {
                const w = notifyOnceWords({ global, community: 'Riverside' });
                const sized: Array<[string, number, number]> = [
                    [w.band.toUpperCase(), 11, LINE], [w.title, s.title.fontSize, LINE], [`${w.never} ${w.only}`, s.body.fontSize, LINE],
                    [`${w.arrives} ${w.ads}`, s.arrives.fontSize, LINE], [w.turnOn, s.turnOnText.fontSize, inButton('turnOn')],
                    [w.confirm, s.confirm.fontSize, LINE], [w.later, s.laterText.fontSize, inButton('later')],
                ];
                for (const [text, size, line] of sized) {
                    const piece = widest(text);
                    expect(widthOf(piece, size), `"${piece}" (${lang}) at ${size}`).toBeLessThanOrEqual(line);
                }
            }
        });
    }
});
