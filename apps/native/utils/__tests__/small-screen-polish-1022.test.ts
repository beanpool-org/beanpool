// @vitest-environment jsdom
/**
 * Spots from the emulator walkthrough of 22 Oct at the floor (320 dp wide, the phone's text at 1.3x), and the welcome
 * screen in dark. Rendered for real: react-dom in jsdom, React Native's host components as plain tags carrying their
 * style and text props, as set-up-server-entry-render.test.ts does; the colours come from the real ThemeProvider, with
 * the stored light/dark choice in a fake AsyncStorage.
 *  1. Market's Location & Radius header: the title was cut to "📍 Location &…" between Cancel and Reset.
 *  2. The group invite sheet's search placeholder: invite-people-sheet-render.test.ts.
 *  3. Chat: "You can edit a message for 15 minutes…" sat straight on the doodle with nothing behind it.
 *  4. Welcome in dark: a member who picked Dark draws the welcome screen dark, and leaving the account keeps the choice.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { randomBytes } from 'node:crypto';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const look = vi.hoisted(() => ({ system: 'light' as 'light' | 'dark' }));
const store = vi.hoisted(() => new Map<string, string>());

vi.mock('react-native', () => {
    const flat = (s: unknown): Record<string, unknown> => Object.assign({}, ...[s].flat(3).filter(Boolean));
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, numberOfLines, adjustsFontSizeToFit, minimumFontScale, style } = props;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat(style)) };
        if (onPress) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole) attrs['data-role'] = accessibilityRole;
        if (numberOfLines) attrs['data-lines'] = numberOfLines;
        if (adjustsFontSizeToFit) attrs['data-fit'] = minimumFontScale ?? 1;
        return createElement(tag, attrs, typeof children === 'function' ? children({ pressed: false }) : children);
    };
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), SafeAreaView: el('div'),
        Modal: ({ visible, children }: { visible: boolean; children?: ReactNode }) => (visible ? createElement('div', null, children) : null),
        StyleSheet: { create: (s: unknown) => s },
        Alert: { alert: vi.fn() },
        Linking: { openSettings: vi.fn() },
        DeviceEventEmitter: { addListener: vi.fn(), emit: vi.fn() },
        useColorScheme: () => look.system,
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('@react-native-async-storage/async-storage', () => {
    const storage = {
        getItem: async (k: string) => store.get(k) ?? null,
        setItem: async (k: string, v: string) => { store.set(k, v); },
        removeItem: async (k: string) => { store.delete(k); },
        getAllKeys: async () => [...store.keys()],
        multiRemove: async (keys: string[]) => { for (const k of keys) store.delete(k); },
    };
    return { default: storage };
});
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: vi.fn(async () => undefined) }));
vi.mock('expo-navigation-bar', () => ({ setStyle: vi.fn() }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('react-native-maps', () => ({ default: () => createElement('div', { 'data-map': 'true' }), Marker: () => null, Circle: () => null, PROVIDER_DEFAULT: null }));
vi.mock('@react-native-community/slider', () => ({ default: () => createElement('div', { 'data-slider': 'true' }) }));
vi.mock('expo-location', () => ({
    getForegroundPermissionsAsync: vi.fn(async () => ({ status: 'denied', canAskAgain: true })),
    requestForegroundPermissionsAsync: vi.fn(async () => ({ status: 'denied' })),
    getCurrentPositionAsync: vi.fn(async () => null),
    Accuracy: { Balanced: 3 },
}));
// What identity.ts's wipe reaches for besides the storage it is handed.
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn((n: number) => new Uint8Array(randomBytes(n))) }));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(async () => undefined), deleteItemAsync: vi.fn(async () => undefined),
}));
vi.mock('../pulse-token-store', () => ({ forgetAllPulseTokens: vi.fn(async () => undefined) }));

import { LANGS, setLanguage, t, type UiLang } from '@beanpool/core';
import { ThemeProvider, useOnboardingColors, useStyles, useTheme } from '../../app/ThemeContext';
import { RadiusPickerModal } from '../../components/RadiusPickerModal';
import { ChatMessageRow } from '../../components/chat/ChatMessageRow';
import { makeChatStyles } from '../../components/chat/styles';
import { onboardingColors } from '../onboarding-colors';
import { contrastRatio } from '../readable-color';
import { THEME_PREFERENCE_KEY } from '../theme-preference';
import { catalogsFor } from '../words-catalogs';
import type { ChatMessage, MessageActions } from '../chat-actions';

// The floor: 320 dp wide, the phone's text at 1.3x, with a generous glyph width (0.62em, a bold Latin face) as
// my-deals-history-320.test.ts does; an emoji counts as 1.2em, and a Chinese, Japanese or Korean character a full 1em.
const WIDTH = 320;
const SCALE = 1.3;
const GLYPH_EM = 0.62;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const textWidth = (text: string, fontSize: number) =>
    [...text].reduce((w, ch) => w + (/\p{Extended_Pictographic}/u.test(ch) ? 1.2 : CJK.test(ch) ? 1 : GLYPH_EM) * fontSize * SCALE, 0);
/** Lines a greedy word wrap needs for `text` in `width` dp; Infinity when one word alone is wider than the line. */
function linesNeeded(text: string, fontSize: number, width: number): number {
    let lines = 1;
    let line = '';
    for (const word of text.split(' ')) {
        if (textWidth(word, fontSize) > width) return Infinity;
        const next = line ? `${line} ${word}` : word;
        if (textWidth(next, fontSize) <= width) line = next;
        else { lines += 1; line = word; }
    }
    return lines;
}
/**
 * Lines Android's StaticLayout draws `text` in: wrapped at spaces, and a word wider than the line goes on a line of its
 * own and is broken by character there, with no hyphen ("Zurücksetze" / "n").
 */
function linesDrawn(text: string, fontSize: number, width: number): number {
    let lines = 1;
    let line = '';
    for (const word of text.split(' ')) {
        const next = line ? `${line} ${word}` : word;
        if (textWidth(next, fontSize) <= width) { line = next; continue; }
        if (line) { lines += 1; line = ''; }
        for (const ch of word) {
            if (line && textWidth(line + ch, fontSize) > width) { lines += 1; line = ''; }
            line += ch;
        }
    }
    return lines;
}
// One pixel at the floor phone's density (1.5, as useWindowDimensions reports below), in style units.
const PIXEL = 1 / (1.5 * SCALE);
/**
 * The size Android draws an adjustsFontSizeToFit label at (RN 0.83, TextLayoutManager.adjustSpannableFontToFit): laid
 * out at full size, then a pixel smaller at a time, but only while it takes more lines than numberOfLines, down to
 * minimumFontScale. A word broken by character that still fits in numberOfLines is never shrunk.
 */
function androidFitSize(text: string, fontSize: number, minScale: number, maxLines: number, width: number): number {
    const floor = fontSize * minScale;
    let size = fontSize;
    while (size > floor && linesDrawn(text, size, width) > maxLines) size = Math.max(floor, size - PIXEL);
    return size;
}
type FlexItem = { el: Element; basis: number };
/**
 * How Yoga places a row's children: in order, by their basis; with flexWrap a child that would run past the row starts
 * a new line (before anything shrinks). Without it they all share one line.
 */
function flexLines(items: FlexItem[], width: number, gap: number, wrap: boolean): FlexItem[][] {
    if (!wrap) return [items];
    const lines: FlexItem[][] = [];
    let line: FlexItem[] = [];
    let used = 0;
    for (const item of items) {
        const next = line.length ? used + gap + item.basis : item.basis;
        if (line.length && next > width) { lines.push(line); line = [item]; used = item.basis; }
        else { line.push(item); used = next; }
    }
    if (line.length) lines.push(line);
    return lines;
}
const lineWidth = (line: FlexItem[], gap: number) => line.reduce((w, i) => w + i.basis, 0) + gap * (line.length - 1);

const style = (el: Element | null) => JSON.parse(el?.getAttribute('data-style') ?? '{}') as Record<string, any>;
const spanWithText = (host: HTMLElement, text: string) =>
    Array.from(host.querySelectorAll('span')).find((s) => s.textContent === text) ?? null;
const withLabel = (host: HTMLElement, label: string) =>
    Array.from(host.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label') === label) ?? null;
// Every language the phone ships, and the pseudo-locale's +35%.
const ALL_LANGS: UiLang[] = ['xx', ...LANGS];

async function render(node: ReactNode): Promise<HTMLElement> {
    const host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => { createRoot(host).render(createElement(ThemeProvider, null, node) as unknown as Parameters<Root['render']>[0]); });
    // The stored light/dark choice is read in an effect.
    await act(async () => {});
    return host;
}

beforeEach(() => {
    document.body.innerHTML = '';
    store.clear();
    look.system = 'light';
    setLanguage('en');
});

describe.each(['light', 'dark'] as const)('at 320 dp and 1.3x, %s', (theme) => {
    beforeEach(() => { store.set(THEME_PREFERENCE_KEY, theme); });

    // Review of #2369: the English words fitted, but in 17 of the 24 other catalogs Cancel and Reset left the title no room.
    it.each(ALL_LANGS)("1. Location & Radius in %s: Cancel and Reset share a line, the title fits its line, never cut; both stay >= 44 dp", async (lang) => {
        setLanguage(lang, catalogsFor(lang));
        const host = await render(createElement(RadiusPickerModal, {
            visible: true, initialRadius: 25, onApply: vi.fn(), onCancel: vi.fn(), onReset: vi.fn(),
        }));
        const title = spanWithText(host, t('📍 Location & Radius'))!;
        expect(title).not.toBeNull();
        const header = title.parentElement!;
        const cancel = withLabel(host, t('Cancel location picker'))!;
        const reset = withLabel(host, t('Reset location and radius'))!;
        expect(cancel.parentElement).toBe(header);
        expect(reset.parentElement).toBe(header);
        if (lang !== 'en') expect(cancel.textContent, 'the words are the language\'s').not.toBe('Cancel');

        for (const button of [cancel, reset]) {
            expect(style(button).minHeight).toBeGreaterThanOrEqual(44);
            expect(style(button).minWidth).toBeGreaterThanOrEqual(44);
        }
        // The title takes what is left of its line, so it is the one that gives way.
        expect(style(title).flex).toBe(1);

        const row = style(header);
        const inner = WIDTH - 2 * row.paddingHorizontal;
        const gap = row.gap ?? 0;
        // A size in % is of the row's inner width, as Yoga resolves it.
        const dp = (v: unknown) => (typeof v === 'string' && v.endsWith('%') ? (parseFloat(v) / 100) * inner : typeof v === 'number' ? v : undefined);
        // Each button as Yoga sizes it: its word plus padding, at least its minWidth, at most its maxWidth.
        const button = (el: Element) => Math.min(dp(style(el).maxWidth) ?? Infinity, Math.max(style(el).minWidth ?? 0,
            textWidth(el.textContent!, style(el.firstElementChild).fontSize) + 2 * (style(el).padding ?? 0)));
        // The title's basis: '100%' asks for a line of its own; flex: 1 alone (basis 0) takes what its line leaves.
        const items = Array.from(header.children).map((el) => ({ el, basis: el === title ? dp(style(title).flexBasis) ?? 0 : button(el) }));
        const lines = flexLines(items, inner, gap, row.flexWrap === 'wrap');
        const lineOf = (el: Element) => lines.find((l) => l.some((i) => i.el === el))!;
        expect(lineOf(cancel), 'Reset is never pushed onto a line of its own').toBe(lineOf(reset));
        for (const line of lines) expect(lineWidth(line, gap), 'nothing runs past the row').toBeLessThanOrEqual(inner);

        // Each button's word fits inside its button, whole, in the lines it may take, at the size Android settles on.
        // Review of #2369: checked only at the 0.7 floor, German "Zurücksetzen" passed, but at full size it breaks into
        // 2 lines, 2 are allowed, so Android never shrinks it and draws "Zurücksetze" / "n".
        for (const el of [cancel, reset]) {
            const word = el.firstElementChild!;
            const allowedLines = Number(word.getAttribute('data-lines') ?? Infinity);
            const box = button(el) - 2 * (style(el).padding ?? 0);
            const size = androidFitSize(word.textContent!, style(word).fontSize, Number(word.getAttribute('data-fit') ?? 1), allowedLines, box);
            expect(linesNeeded(word.textContent!, size, box), `"${word.textContent}" at ${(size * SCALE).toFixed(1)} dp in ${box.toFixed(2)} dp, never cut mid-word`)
                .toBeLessThanOrEqual(allowedLines);
        }

        // Width left for the title: its line less the gaps and whatever else shares it.
        const titleLine = lineOf(title);
        const left = inner - titleLine.reduce((w, i) => w + (i.el === title ? 0 : i.basis), 0) - gap * (titleLine.length - 1);
        expect(left).toBeGreaterThan(0);

        const allowed = Number(title.getAttribute('data-lines') ?? Infinity);
        const smallest = style(title).fontSize * Number(title.getAttribute('data-fit') ?? 1);
        expect(linesNeeded(title.textContent!, smallest, left)).toBeLessThanOrEqual(allowed);
    });

    it('3. the closed-edit note sits on the action bar\'s own backing, readable at >= 4.5:1, not on the doodle', async () => {
        const item: ChatMessage = {
            id: 'm1', senderId: 'me', text: 'HH',
            rawTimestamp: new Date(Date.now() - 16 * 60 * 1000).toISOString(), timestamp: '20:48',
        };
        const actions: MessageActions & { editClosed?: boolean } = {
            reply: true, react: true, edit: false, delete: true, remove: false, editClosed: true,
        };
        let ground = '';
        function Row() {
            const styles = useStyles(makeChatStyles);
            // The chat's doodle is drawn on this ground; with the pattern on, chrome takes the same colour (ThemeContext).
            ground = useTheme().colors.surface.chrome;
            return createElement(ChatMessageRow, {
                item, isMe: true, styles, kind: 'group', actions, showActions: true, showEmojiPicker: false,
                pickerPosition: 'top', onPressBubble: vi.fn(), onReply: vi.fn(), onToggleEmojiPicker: vi.fn(), onEdit: vi.fn(),
                onDelete: vi.fn(), onRemove: vi.fn(), onPickEmoji: vi.fn(), onPressUrl: vi.fn(),
            });
        }
        const host = await render(createElement(Row));
        const note = spanWithText(host, 'You can edit a message for 15 minutes after sending it.')!;
        expect(note).not.toBeNull();

        // What is behind the words: the nearest box with a fill of its own, else the doodle's ground.
        let behind: string | undefined;
        for (let el = note.parentElement; el && el !== host && !behind; el = el.parentElement) behind = style(el).backgroundColor;
        const bg = behind ?? ground;
        expect(bg).toMatch(/^#[0-9a-f]{6}$/i);
        expect(contrastRatio(style(note).color, bg)).toBeGreaterThanOrEqual(4.5);

        // The same fill as the action bar's buttons beside the bubble.
        const reply = host.querySelector('[aria-label="Reply"]')!;
        expect(reply).not.toBeNull();
        expect(behind).toBe(style(reply).backgroundColor);
    });
});

describe('4. the welcome screen in dark', () => {
    function Probe({ out }: { out: { dark?: boolean; page?: string } }) {
        const { colors, dark } = useOnboardingColors();
        out.dark = dark;
        out.page = colors.surface.page;
        return null;
    }

    it('a member who picked Dark gets the dark welcome colours once the choice is read, on a light phone too', async () => {
        store.set(THEME_PREFERENCE_KEY, 'dark');
        const out: { dark?: boolean; page?: string } = {};
        await render(createElement(Probe, { out }));
        expect(out.dark).toBe(true);
        expect(out.page).toBe(onboardingColors('dark').colors.surface.page);
    });

    it('leaving the account keeps the Dark choice for the welcome screen that follows', async () => {
        const { wipeIdentityScopedStorage } = await import('../identity');
        const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
        store.set(THEME_PREFERENCE_KEY, 'dark');
        store.set('beanpool:identity', '{}');
        await wipeIdentityScopedStorage(AsyncStorage as never, { deleteSecret: async () => undefined });
        expect(store.has('beanpool:identity')).toBe(false);
        expect(store.get(THEME_PREFERENCE_KEY)).toBe('dark');

        const out: { dark?: boolean } = {};
        await render(createElement(Probe, { out }));
        expect(out.dark).toBe(true);
    });

    it('a new phone with no choice yet opens light, even when the phone is dark (the default since 20 Sep)', async () => {
        look.system = 'dark';
        const out: { dark?: boolean } = {};
        await render(createElement(Probe, { out }));
        expect(out.dark).toBe(false);
        expect(store.get(THEME_PREFERENCE_KEY)).toBe('light');
    });
});
