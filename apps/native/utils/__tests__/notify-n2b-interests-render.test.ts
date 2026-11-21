// @vitest-environment jsdom
/**
 * Slice N2b (DESIGN-notify-and-backup-asks-fable-amend2.md §12.3): What are you into?'s card (components/home/HomeCardBodies.tsx
 * InterestsBody) drawn for real, in light and dark, at the floor's window (320 dp, text at 1.3x). A star, where the community
 * tells members when a neighbour asks, brings "Hear when a neighbour asks for one of these." [Tell me] under the chips; whether
 * it shows is core's rule through this phone's record (utils/notification-permission.ts offerNamedLine, answered here; its own
 * table in notify-named-lines.test.ts, and Home's real rule in home-screen-render.test.ts).
 *
 * The card is on Home, which stays mounted under every screen opened from it, so the line belongs to one visit: Home covered,
 * then shown again, draws no line (`showing`, Home's useScreenShowing: notify-line-hidden-again.test.ts's class).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(8).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, testID, style } = props;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat(typeof style === 'function' ? style({ pressed: false }) : style)) };
        if (testID) attrs['data-testid'] = testID;
        if (onPress) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        return createElement(tag, attrs, typeof children === 'function' ? children({ pressed: false }) : children);
    };
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), Image: el('img'), TextInput: el('input'),
        ActivityIndicator: () => null,
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, flatten: (s: unknown) => flat(s) },
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
        PixelRatio: { getFontScale: () => 1.3, get: () => 1.5 },
        Alert: { alert: () => {} },
        Linking: { openURL: async () => {} },
    };
});
vi.mock('expo-router', () => ({ router: { push() {}, navigate() {} } }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('expo-image', () => ({ Image: () => null }));
// Modules the card's file reaches through its neighbours (Home's other bodies), which load native code: stand-ins.
vi.mock('expo-crypto', () => ({ getRandomBytes: (n: number) => new Uint8Array(n), randomUUID: () => 'uuid-1' }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }));
vi.mock('expo-local-authentication', () => ({}));
vi.mock('expo-location', () => ({}));
vi.mock('../pulse', () => ({ resolvePulseThumbnailUrl: () => null }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } }));
const theme = vi.hoisted(() => ({ dark: false }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors: light, darkColors: dark } = await import('../../constants/colors');
    const colors = () => (theme.dark ? dark : light);
    return {
        useTheme: () => ({ theme: theme.dark ? 'dark' : 'light', colors: colors() }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: theme.dark ? 'dark' : 'light', colors: colors() }),
    };
});
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => null }));
const rule = vi.hoisted(() => ({ answer: true, asked: [] as string[], turnOns: 0 }));
vi.mock('../notification-permission', () => ({
    offerNamedLine: vi.fn(async (kind: string) => { rule.asked.push(kind); return rule.answer; }),
    turnOnNotifications: vi.fn(async () => { rule.turnOns++; return 'granted'; }),
}));

import { InterestsBody } from '../../components/home/HomeCardBodies';
import { darkColors, lightColors } from '../../constants/colors';

const ASK = { available: true, granted: false, canAskAgain: true };
const NOTE = 'Tap a few. What you star comes first here and in the Market.';
const PROMISE = "Tap a few. What you star comes first here and in the Market, and we'll tell you when a neighbour asks for it.";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    Object.assign(rule, { answer: true, asked: [], turnOns: 0 });
});
afterEach(() => { act(() => root.unmount()); host.remove(); theme.dark = false; });

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
/** The card as Home draws it: the stars held by Home, toggled by its onToggle. */
function Card({ showing, askedPush = true, phone = ASK }: { showing: boolean; askedPush?: boolean; phone?: typeof ASK | null }) {
    const [stars, setStars] = useState<string[]>([]);
    const colors = theme.dark ? (darkColors as unknown as typeof lightColors) : lightColors;
    return createElement(InterestsBody, {
        interests: stars, colors, askedPush, phone, showing,
        onToggle: (id: string) => setStars((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id])),
    });
}
async function draw(props: { showing: boolean; askedPush?: boolean; phone?: typeof ASK | null }) {
    await act(async () => { root.render(createElement(Card, props) as any); });
    await settle();
}
const byTestId = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
async function star(id: string) {
    await act(async () => { byTestId(`home-interest-${id}`)!.click(); });
    await settle();
}

describe("What are you into?'s star line on its own card (slice N2b)", () => {
    for (const dark of [false, true]) {
        it(`${dark ? 'dark' : 'light'}: a star brings the line under the chips; Tell me says so, and the note then promises the push`, async () => {
            theme.dark = dark;
            await draw({ showing: true });
            expect(byTestId('home-interests-note')?.textContent).toBe(NOTE);
            await star('food');
            expect(rule.asked).toEqual(['star']);
            expect(byTestId('notify-line')?.textContent).toContain('Hear when a neighbour asks for one of these.');
            await act(async () => { byTestId('notify-line-tell-me')!.click(); });
            await settle();
            expect(rule.turnOns).toBe(1);
            expect(byTestId('notify-line-done')?.textContent).toContain("You'll hear when a neighbour asks for one of these.");
            expect(byTestId('home-interests-note')?.textContent).toBe(PROMISE);
        });
    }

    it('Home covered by a screen opened from it, then shown again: the line is gone, and the next star brings none', async () => {
        await draw({ showing: true });
        await star('food');
        expect(byTestId('notify-line')).toBeTruthy();
        await draw({ showing: false });
        expect(byTestId('notify-line')).toBeNull();
        await draw({ showing: true });
        expect(byTestId('notify-line')).toBeNull();
        await star('tools');
        expect(byTestId('notify-line')).toBeNull();
        expect(rule.asked).toEqual(['star']);
    });

    it('a community that sends no such push: a star asks nothing and the note promises nothing, whatever the phone says', async () => {
        await draw({ showing: true, askedPush: false, phone: { available: true, granted: true, canAskAgain: true } });
        expect(byTestId('home-interests-note')?.textContent).toBe(NOTE);
        await star('food');
        expect(rule.asked).toEqual([]);
        expect(byTestId('notify-line')).toBeNull();
    });

    it('the phone not read yet: no promise', async () => {
        await draw({ showing: true, phone: null });
        expect(byTestId('home-interests-note')?.textContent).toBe(NOTE);
    });
});
