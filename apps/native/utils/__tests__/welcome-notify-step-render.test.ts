// @vitest-environment jsdom
/**
 * The join's last screen drawn (components/welcome/NotifyStep.tsx; DESIGN-notify-and-backup-asks-fable-amend2.md §4, slice
 * N1j): in every colour set, light and dark, at 320 dp with 1.3x text and on a roomy phone; with and without the bell band; on
 * an iPhone, on Android 13+, and its absence on Android 8 to 12 (core's rule, which the join reads before it draws anything).
 *
 * What is checked: the words (core's notifyJoinWords) for each kind of join, both buttons in the fixed foot ("Turn on
 * notifications" first, its line under it, then "Later", a 48 dp target), the step bar's 4 of 4 (3 of 3 on a claim), the band
 * gone on a small screen, colours from the central tokens readable (words 4.5:1), and in every language and the pseudo one
 * that no word is wider than the card's line at 320 dp with 1.3x text. A tap only calls the screen's two handlers: the
 * screen itself never asks the phone.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { COLOUR_SETS, type AppColors } from '../../constants/colors';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const win = vi.hoisted(() => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }));
const platform = vi.hoisted(() => ({ OS: 'android' as 'android' | 'ios' }));

vi.mock('react-native', () => {
    const roles: Record<string, string> = { button: 'button', header: 'heading' };
    const flat = (style: unknown): Record<string, unknown> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (testID) attrs['data-testid'] = testID;
        if (disabled) attrs['aria-disabled'] = 'true';
        attrs['data-style'] = JSON.stringify(flat(props.style));
        return createElement(tag, attrs, children);
    };
    return {
        Platform: platform,
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('section'), SafeAreaView: el('main'),
        ActivityIndicator: () => createElement('span', { 'data-testid': 'spinner' }),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 },
        useWindowDimensions: () => win,
    };
});
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('@expo/vector-icons', () => ({
    MaterialCommunityIcons: ({ name, color }: { name: string; color: string }) => createElement('i', { 'data-icon': name, 'data-color': color }),
}));
vi.mock('react-native-keyboard-controller', () => ({ KeyboardStickyView: ({ children }: { children?: unknown }) => createElement('footer', null, children as any) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 34, left: 0, right: 0 }) }));
const theme = vi.hoisted(() => ({ set: 'light' as string }));
vi.mock('../../app/ThemeContext', async () => {
    const { COLOUR_SETS: sets } = await import('../../constants/colors');
    const { onboardingColors } = await import('../onboarding-colors');
    return {
        useTheme: () => ({ colors: (sets as any)[theme.set] }),
        useOnboardingColors: () => onboardingColors(theme.set as never),
    };
});
vi.mock('../../components/LanguageProvider', async () => {
    const { t } = await import('@beanpool/core');
    return { useWords: () => ({ t }) };
});

const { NotifyStep, notifyBandFits, NOTIFY_BAND_MIN_HEIGHT } = await import('../../components/welcome/NotifyStep');
const { LANGS, PSEUDO_LANG, notifyJoinStep, notifyJoinWords, pseudoLocalise, setLanguage } = await import('@beanpool/core');
const { onboardingColors } = await import('../onboarding-colors');

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    Object.assign(win, { width: 320, height: 569, fontScale: 1.3 });
    theme.set = 'light';
    setLanguage('en');
});
function draw(node: ReactNode) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root!.render(node as Parameters<Root['render']>[0]); });
}
const q = (id: string) => host!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const styleOf = (e: Element | null) => JSON.parse(e?.getAttribute('data-style') ?? '{}') as Record<string, any>;

function contrast(fg: string, bg: string): number {
    const lum = (hex: string) => {
        const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
            .map(x => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [a, b] = [lum(fg), lum(bg)];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
const hex = (c: unknown): c is string => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);

const ASHA = notifyJoinWords({ kind: 'community', community: 'Riverside', inviter: 'Asha' });
function screen(over: Partial<Parameters<typeof NotifyStep>[0]> = {}) {
    const onTurnOn = vi.fn();
    const onLater = vi.fn();
    const onBack = vi.fn();
    draw(createElement(NotifyStep, { words: ASHA, flow: 'invite', wayBack: true, busy: false, onBack, onTurnOn, onLater, ...over }));
    return { onTurnOn, onLater, onBack };
}

const ASK = { available: true, granted: false, canAskAgain: true };
const PHONES = {
    // An iPhone and Android 13+ start the same: not asked yet, the pop-up still to come.
    iPhone: ASK,
    'Android 13+': ASK,
    // Android 8 to 12: notifications are on from the start, nothing to ask.
    'Android 8-12': { available: true, granted: true, canAskAgain: true },
};

describe('the join\'s last screen, at 320 dp with 1.3x text', () => {
    for (const [name, phone] of Object.entries(PHONES)) {
        it(`${name}: ${phone.granted ? 'no screen (the join goes straight to Home)' : 'the screen, step 4 of 4'}`, () => {
            const shows = notifyJoinStep('invite', { record: {}, phone, now: Date.now() });
            expect(shows).toBe(!phone.granted);
            if (!shows) return;
            platform.OS = name === 'iPhone' ? 'ios' : 'android';
            screen();
            expect(q('notify-step-title')?.textContent).toBe('Hear from Riverside');
            expect(host!.textContent).toContain('BeanPool never emails or texts you.');
            expect(host!.textContent).toContain('Notifications are the only way it can reach you.');
            expect(q('notify-step-arrives')?.textContent).toBe("When Asha writes, someone answers you, or an event you're going to changes. Never ads.");
            expect(host!.querySelector('[data-testid="step-dots-steps"]')?.getAttribute('aria-label')).toBe('Step 4 of 4');
        });
    }

    it('both buttons in the fixed foot: Turn on notifications, its line, then Later (a 48 dp target); each tap calls only its own', () => {
        const { onTurnOn, onLater } = screen();
        const foot = q('step-footer-notify')!;
        const turnOn = q('notify-step-turn-on')!;
        const later = q('notify-step-later')!;
        expect(foot.contains(turnOn) && foot.contains(later)).toBe(true);
        expect(host!.querySelector('section')!.contains(turnOn)).toBe(false);
        expect(foot.textContent).toBe('Turn on notificationsYour phone will ask you to confirm.Later');
        expect(styleOf(turnOn).minHeight).toBeGreaterThanOrEqual(52);
        expect(styleOf(later).minHeight).toBe(48);
        act(() => { turnOn.click(); });
        expect(onTurnOn).toHaveBeenCalledTimes(1);
        expect(onLater).not.toHaveBeenCalled();
        act(() => { later.click(); });
        expect(onLater).toHaveBeenCalledTimes(1);
        expect(onTurnOn).toHaveBeenCalledTimes(1);
    });

    it('while the answer is kept, both buttons wait: no second tap lands', () => {
        const { onTurnOn, onLater } = screen({ busy: true });
        act(() => { q('notify-step-turn-on')!.click(); q('notify-step-later')!.click(); });
        expect(onTurnOn).not.toHaveBeenCalled();
        expect(onLater).not.toHaveBeenCalled();
        expect(q('spinner')).toBeTruthy();
    });

    it('the bell band drops at 320 dp with 1.3x text, and shows on a roomy phone', () => {
        screen();
        expect(q('notify-step-band')).toBeNull();
        act(() => root?.unmount()); host?.remove();
        Object.assign(win, { width: 393, height: 852, fontScale: 1 });
        screen();
        const band = q('notify-step-band');
        expect(band).toBeTruthy();
        expect(band!.querySelector('i')?.getAttribute('data-icon')).toBe('bell-ring');
        // The same phone at 1.3x text: still room (852 / 1.3 = 655).
        expect(notifyBandFits({ height: 852, fontScale: 1.3 })).toBe(true);
        expect(notifyBandFits({ height: 569, fontScale: 1.3 })).toBe(false);
        expect(notifyBandFits({ height: 640, fontScale: 1 })).toBe(true);
        expect(notifyBandFits({ height: NOTIFY_BAND_MIN_HEIGHT * 1.15 - 1, fontScale: 1.15 })).toBe(false);
    });

    it('a claim: step 3 of 3 and the owner\'s line; a way back skipped: one dot fewer; the global community: its own line', () => {
        screen({ flow: 'claim', words: notifyJoinWords({ kind: 'owner', community: 'Beans' }) });
        expect(host!.querySelector('[data-testid="step-dots-steps"]')?.getAttribute('aria-label')).toBe('Step 3 of 3');
        expect(q('notify-step-arrives')?.textContent).toBe('When someone asks to join, a member writes, or your server needs you. Never ads.');
        act(() => root?.unmount()); host?.remove();
        screen({ flow: 'global', wayBack: false, words: notifyJoinWords({ kind: 'global' }) });
        expect(host!.querySelector('[data-testid="step-dots-steps"]')?.getAttribute('aria-label')).toBe('Step 3 of 3');
        expect(q('notify-step-title')?.textContent).toBe('Hear from your community');
        expect(q('notify-step-arrives')?.textContent).toBe('When someone writes to you, or a community answers your request to join. Never ads.');
        act(() => root?.unmount()); host?.remove();
        screen({ words: notifyJoinWords({ kind: 'community', community: null, inviter: null }) });
        expect(q('notify-step-arrives')?.textContent).toBe("When a neighbour writes, someone answers you, or an event you're going to changes. Never ads.");
    });

    for (const set of Object.keys(COLOUR_SETS)) {
        it(`${set}: every word readable on its ground (4.5:1), from the central tokens`, () => {
            theme.set = set;
            Object.assign(win, { width: 393, height: 852, fontScale: 1 });
            screen();
            const { colors } = onboardingColors(set as never);
            const card = styleOf(q('notify-step-title')!.parentElement).backgroundColor;
            expect(card).toBe(colors.surface.card);
            for (const span of Array.from(host!.querySelectorAll('section span')) as HTMLElement[]) {
                const fg = styleOf(span).color;
                if (hex(fg) && hex(card)) expect(contrast(fg, card), `${set}: "${span.textContent}"`).toBeGreaterThanOrEqual(4.5);
            }
            const turnOn = q('notify-step-turn-on')!;
            expect(styleOf(turnOn).backgroundColor).toBe(colors.action.cta);
            const label = styleOf(turnOn.querySelector('span')).color;
            expect(label).toBe(colors.text.onBrand);
            if (hex(label) && hex(colors.action.cta)) expect(contrast(label, colors.action.cta), `${set}: Turn on`).toBeGreaterThanOrEqual(4.5);
            const chrome = (COLOUR_SETS as any)[set].surface.chrome as string;
            for (const id of ['notify-step-later']) {
                const fg = styleOf(q(id)!.querySelector('span')).color;
                if (hex(fg) && hex(chrome)) expect(contrast(fg, chrome), `${set}: ${id}`).toBeGreaterThanOrEqual(4.5);
            }
            const band = q('notify-step-band')!;
            expect(styleOf(band).backgroundColor).toBe(colors.brand.fill);
            expect(band.querySelector('i')?.getAttribute('data-color')).toBe(colors.text.onBrand);
            // Not one colour written here: every one is a token.
            const src = fs.readFileSync(path.resolve(__dirname, '../../components/welcome/NotifyStep.tsx'), 'utf8');
            expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
        });
    }
});

// ── Every language, and the pseudo one, at 320 dp with 1.3x text ─────────────────────────────────────────────────────
const FONT_SCALE = 1.3;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u;
const glyphEm = (c: string) => (/\p{M}/u.test(c) || /[\ufe0f\u200c\u200d]/.test(c) ? 0 : /\p{Extended_Pictographic}/u.test(c) ? 1.25 : CJK.test(c) ? 1 : 0.62);
const widthOf = (text: string, size: number) => Array.from(text).reduce((w, c) => w + glyphEm(c) * size * FONT_SCALE, 0);
const widest = (text: string) => text.split(/[\s~]+/).flatMap((w) => (CJK.test(w) ? Array.from(w) : [w])).reduce((a, w) => (widthOf(w, 1) > widthOf(a, 1) ? w : a), '');
/** The card's line: 320 less the scroll's 24 and the card's 24 a side; the foot's: less its 24 a side and the button's 16. */
const CARD_LINE = 320 - 2 * 24 - 2 * 24;
const BUTTON_LINE = 320 - 2 * 24 - 2 * 16;
const CORE_WORDS = path.resolve(__dirname, '../../../../packages/beanpool-core/words');

describe('in every language and the pseudo one, no word is wider than its line at 320 dp with 1.3x text', () => {
    for (const lang of [PSEUDO_LANG, ...LANGS.filter((l) => l !== 'en')]) {
        it(lang, () => {
            const catalog = lang === PSEUDO_LANG ? {} : JSON.parse(fs.readFileSync(path.join(CORE_WORDS, `${lang}.json`), 'utf8'));
            setLanguage(lang as never, lang === PSEUDO_LANG ? [] : [catalog]);
            for (const kind of ['community', 'global', 'owner'] as const) {
                const w = notifyJoinWords({ kind, community: 'Riverside', inviter: 'Asha' });
                // The pseudo-locale's guard: every sentence came through t() (accented and padded), the names placed as given.
                if (lang === PSEUDO_LANG) {
                    expect(w.title).not.toBe('Hear from Riverside');
                    expect(w.title).toContain('Riverside');
                    expect(pseudoLocalise('Hear from {community}')).toContain('{community}');
                    for (const v of Object.values(w)) expect(v).toMatch(/~/);
                }
                // Each sentence is the language's own: every key is in its catalog.
                else for (const v of Object.values(w)) expect(typeof v === 'string' && v.length > 0).toBe(true);
                const sized: Array<[string, number, number]> = [
                    [w.title, 22, CARD_LINE], [w.never, 16, CARD_LINE], [w.only, 16, CARD_LINE], [`${w.arrives} ${w.ads}`, 15, CARD_LINE],
                    [w.turnOn, 16, BUTTON_LINE], [w.confirm, 13, BUTTON_LINE], [w.later, 16, BUTTON_LINE],
                ];
                for (const [text, size, line] of sized) {
                    const piece = widest(text);
                    expect(widthOf(piece, size), `"${piece}" (${lang}) at ${size}`).toBeLessThanOrEqual(line);
                }
            }
            if (lang !== PSEUDO_LANG) {
                for (const key of ['Hear from {community}', 'Hear from your community', 'BeanPool never emails or texts you.', 'Notifications are the only way it can reach you.', 'Never ads.', 'Turn on notifications', 'Your phone will ask you to confirm.', 'Later']) {
                    expect(typeof catalog[key], `${lang}: ${key}`).toBe('string');
                }
            }
        });
    }
});
