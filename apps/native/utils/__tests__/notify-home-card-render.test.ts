// @vitest-environment jsdom
/**
 * Home's card while something of the member's is live drawn (components/home/NotifyHomeCard.tsx; the first
 * design §4.3, amend1 §4.3, amend2 §12.3 slice N3), through Home's real card frame (components/home/HomeParts.tsx HomeCard),
 * in each of the phone's colour sets (light and dark among them), at the floor's window (320 dp, text at 1.3x).
 *
 * What is checked: the sky band "NOTIFICATIONS" with its ×; "You have 1 offer up." then "This phone won't tell you when
 * someone answers." then Turn on (a 48 dp target, as is the ×); an event's "This phone won't remind you."; a tap calls only
 * its own handler, neither while the answer is kept, and the × does nothing in Arrange; every word readable on its ground
 * (4.5:1) from the central tokens; in every language and the pseudo one, no word wider than its line at 320 dp with 1.3x text.
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

const { NotifyHomeCard, notifyHomeCardStyles } = await import('../../components/home/NotifyHomeCard');
const { HOME_CARD_PADDING_DP, HOME_GUTTER_DP, HOME_TARGET_DP } = await import('../../components/home/HomeParts');
const { COLOUR_SETS } = await import('../../constants/colors');
const { LANGS, PSEUDO_LANG, contrastRatio, notifyHomeWords, setLanguage } = await import('@beanpool/core');
type Catalog = Parameters<typeof setLanguage>[1] extends readonly (infer C)[] | undefined ? C : never;
type Live = Parameters<typeof notifyHomeWords>[0];

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

function card(over: { set?: string; busy?: boolean; quiet?: boolean; live?: Live } = {}) {
    const onTurnOn = vi.fn();
    const onAway = vi.fn();
    const colors = (COLOUR_SETS as Record<string, any>)[over.set ?? 'light'];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const words = notifyHomeWords(over.live ?? { kind: 'offers', n: 1 });
    act(() => { root!.render(createElement(NotifyHomeCard, { words, colors, busy: !!over.busy, quiet: over.quiet, onTurnOn, onAway }) as unknown as Parameters<Root['render']>[0]); });
    return { onTurnOn, onAway, colors };
}

describe("Home's card while something is live, at 320 dp with 1.3x text", () => {
    it('the sky band with its ×, "You have 1 offer up.", what this phone won\'t do, then Turn on', () => {
        card();
        expect(q('card-band-notify-home')?.textContent).toContain('Notifications');
        expect(q('notify-home-fact')?.textContent).toBe('You have 1 offer up.');
        expect(q('notify-home-wont')?.textContent).toBe("This phone won't tell you when someone answers.");
        expect(q('notify-home-turn-on')?.textContent).toBe('Turn on');
        expect(q('notify-home-away')?.getAttribute('aria-label')).toBe('Put this card away');
        const text = host!.textContent!;
        const order = ['You have 1 offer up.', "This phone won't tell you", 'Turn on'].map((w) => text.indexOf(w));
        expect(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1]))).toBe(true);
        // One button: no "Later", no "Not now" (× is the way off).
        expect(text).not.toContain('Later');
        expect(text).not.toContain('Not now');
    });

    it("an event they marked: its name, and that this phone won't remind them", () => {
        card({ live: { kind: 'event', title: 'Saturday market', going: true } });
        expect(q('notify-home-fact')?.textContent).toBe("You're going to Saturday market.");
        expect(q('notify-home-wont')?.textContent).toBe("This phone won't remind you.");
    });

    it('each tap calls only its own; while the answer is kept neither lands; in Arrange the × is quiet', () => {
        const { onTurnOn, onAway } = card();
        act(() => { q('notify-home-turn-on')!.click(); });
        expect(onTurnOn).toHaveBeenCalledTimes(1);
        expect(onAway).not.toHaveBeenCalled();
        act(() => { q('notify-home-away')!.click(); });
        expect(onAway).toHaveBeenCalledTimes(1);
        expect(onTurnOn).toHaveBeenCalledTimes(1);
        act(() => root?.unmount()); host?.remove();
        const busy = card({ busy: true });
        act(() => { q('notify-home-turn-on')!.click(); q('notify-home-away')!.click(); });
        expect(busy.onTurnOn).not.toHaveBeenCalled();
        expect(busy.onAway).not.toHaveBeenCalled();
        expect(q('spinner')).toBeTruthy();
        act(() => root?.unmount()); host?.remove();
        const quiet = card({ quiet: true });
        act(() => { q('notify-home-away')!.click(); });
        expect(quiet.onAway).not.toHaveBeenCalled();
    });

    it('Turn on and the × are 48 dp targets; Turn on fills the card\'s width; nothing has a fixed width', () => {
        card();
        expect(styleOf(q('notify-home-turn-on')).minHeight).toBeGreaterThanOrEqual(HOME_TARGET_DP);
        expect(styleOf(q('notify-home-away')).minHeight).toBeGreaterThanOrEqual(HOME_TARGET_DP);
        expect(styleOf(q('notify-home-away')).minWidth).toBeGreaterThanOrEqual(HOME_TARGET_DP);
        for (const s of Object.values(notifyHomeCardStyles) as Record<string, unknown>[]) {
            for (const k of ['width', 'height', 'maxWidth']) expect(s[k], k).toBeUndefined();
        }
        expect(styleOf(q('home-notify-live')).marginHorizontal).toBe(HOME_GUTTER_DP);
    });

    for (const set of Object.keys(COLOUR_SETS)) {
        it(`${set}: every word readable on its ground (4.5:1), every colour a central token`, () => {
            const { colors } = card({ set });
            const ground = styleOf(q('home-notify-live')).backgroundColor;
            expect(ground).toBe(colors.surface.card);
            const band = q('card-band-notify-home')!;
            expect(styleOf(band).backgroundColor).toBe(colors.card.sky.tint);
            const caption = band.querySelector('span')!;
            expect(contrastRatio(styleOf(caption).color, colors.card.sky.tint), `${set}: the band`).toBeGreaterThanOrEqual(4.5);
            const x = styleOf(q('notify-home-away')!.querySelector('span')).color;
            expect(contrastRatio(x, colors.card.sky.tint), `${set}: the ×`).toBeGreaterThanOrEqual(4.5);
            for (const id of ['notify-home-fact', 'notify-home-wont']) {
                const fg = styleOf(q(id)).color;
                if (hex(fg) && hex(ground)) expect(contrastRatio(fg, ground), `${set}: ${id}`).toBeGreaterThanOrEqual(4.5);
            }
            const turnOn = q('notify-home-turn-on')!;
            expect(styleOf(turnOn).backgroundColor).toBe(colors.action.cta);
            const label = styleOf(turnOn.querySelector('span')).color;
            expect(label).toBe(colors.text.onBrand);
            expect(contrastRatio(label, colors.action.cta), `${set}: Turn on`).toBeGreaterThanOrEqual(4.5);
        });
    }

    it('not one colour written in the card itself: every one is a token', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../../components/home/NotifyHomeCard.tsx'), 'utf8');
        expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    });

    const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;
    const glyphEm = (c: string) => (/\p{M}/u.test(c) || /[️‌‍]/.test(c) ? 0 : /\p{Extended_Pictographic}/u.test(c) ? 1.25 : CJK.test(c) ? 1 : 0.62);
    const widthOf = (text: string, size: number) => Array.from(text).reduce((w, c) => w + glyphEm(c) * size * 1.3, 0);
    const widest = (text: string) => text.split(/[\s~]+/).flatMap((w) => (CJK.test(w) ? Array.from(w) : [w])).reduce((a, w) => (widthOf(w, 1) > widthOf(a, 1) ? w : a), '');
    const LINE = 320 - 2 * HOME_GUTTER_DP - 2 * HOME_CARD_PADDING_DP - 2;
    const catalog = (lang: string): Catalog => JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../../../packages/beanpool-core/words/${lang}.json`), 'utf8'));
    const LIVES: Live[] = [
        { kind: 'offers', n: 1 }, { kind: 'offers', n: 12 }, { kind: 'listings', n: 3 }, { kind: 'deals', n: 2 }, { kind: 'waiting' },
        { kind: 'event', title: 'Market', going: true }, { kind: 'event', title: 'Market', going: false },
    ];
    for (const lang of [...LANGS, PSEUDO_LANG]) {
        it(`${lang}: no word of the card is wider than its line at 320 dp with 1.3x text`, () => {
            setLanguage(lang as never, lang === 'en' || lang === PSEUDO_LANG ? [] : [catalog(lang)]);
            const s = notifyHomeCardStyles as unknown as Record<string, { fontSize: number; paddingHorizontal?: number }>;
            for (const live of LIVES) {
                const w = notifyHomeWords(live);
                const sized: Array<[string, number, number]> = [
                    // The band's caption shares its line with the ×.
                    [w.band.toUpperCase(), 11, LINE - HOME_TARGET_DP], [w.fact, s.fact.fontSize, LINE], [w.wont, s.wont.fontSize, LINE],
                    [w.turnOn, s.turnOnText.fontSize, LINE - 2 * (s.turnOn.paddingHorizontal ?? 0)],
                ];
                for (const [text, size, line] of sized) {
                    const piece = widest(text);
                    expect(widthOf(piece, size), `"${piece}" (${lang}) at ${size}`).toBeLessThanOrEqual(line);
                }
            }
        });
    }
});
