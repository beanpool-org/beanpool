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

import { ThemeProvider, useOnboardingColors, useStyles, useTheme } from '../../app/ThemeContext';
import { RadiusPickerModal } from '../../components/RadiusPickerModal';
import { ChatMessageRow } from '../../components/chat/ChatMessageRow';
import { makeChatStyles } from '../../components/chat/styles';
import { onboardingColors } from '../onboarding-colors';
import { contrastRatio } from '../readable-color';
import { THEME_PREFERENCE_KEY } from '../theme-preference';
import type { ChatMessage, MessageActions } from '../chat-actions';

// The floor: 320 dp wide, the phone's text at 1.3x, with a generous glyph width (0.62em, a bold Latin face) as
// my-deals-history-320.test.ts does; an emoji counts as 1.2em.
const WIDTH = 320;
const SCALE = 1.3;
const GLYPH_EM = 0.62;
const textWidth = (text: string, fontSize: number) =>
    [...text].reduce((w, ch) => w + (/\p{Extended_Pictographic}/u.test(ch) ? 1.2 : GLYPH_EM) * fontSize * SCALE, 0);
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

const style = (el: Element | null) => JSON.parse(el?.getAttribute('data-style') ?? '{}') as Record<string, any>;
const spanWithText = (host: HTMLElement, text: string) =>
    Array.from(host.querySelectorAll('span')).find((s) => s.textContent === text) ?? null;

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
});

describe.each(['light', 'dark'] as const)('at 320 dp and 1.3x, %s', (theme) => {
    beforeEach(() => { store.set(THEME_PREFERENCE_KEY, theme); });

    it("1. Location & Radius: the title wraps or shrinks to fit between Cancel and Reset, never cut; both stay >= 44 dp", async () => {
        const host = await render(createElement(RadiusPickerModal, {
            visible: true, initialRadius: 25, onApply: vi.fn(), onCancel: vi.fn(), onReset: vi.fn(),
        }));
        const title = spanWithText(host, '📍 Location & Radius')!;
        expect(title).not.toBeNull();
        const header = title.parentElement!;
        const cancel = host.querySelector('[aria-label="Cancel location picker"]')!;
        const reset = host.querySelector('[aria-label="Reset location and radius"]')!;
        expect(cancel.parentElement).toBe(header);
        expect(reset.parentElement).toBe(header);

        for (const button of [cancel, reset]) {
            expect(style(button).minHeight).toBeGreaterThanOrEqual(44);
            expect(style(button).minWidth).toBeGreaterThanOrEqual(44);
        }
        // The title takes what is left of the row, so it is the one that gives way.
        expect(style(title).flex).toBe(1);

        // Width left for the title: the row less its padding, the two gaps and each button (its word plus padding).
        const button = (el: Element) => Math.max(style(el).minWidth ?? 0,
            textWidth(el.textContent!, style(el.firstElementChild).fontSize) + 2 * (style(el).padding ?? 0));
        const row = style(header);
        const left = WIDTH - 2 * row.paddingHorizontal - 2 * (row.gap ?? 0) - button(cancel) - button(reset);
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
