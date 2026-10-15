// @vitest-environment jsdom
/**
 * Where anyone can join in a minute (features.openMembership, the global node), an event says its spot is the host's to
 * give (scratch/global-node/DESIGN-global-member-privacy-fable.md §4, Marty's call 1, 15 Oct 2026): "Shown to about 1 km.
 * Ask <name> for the spot when you arrange to meet." Drawn for real as event-host-lets-in-render.test.ts draws it, in the
 * light and the dark theme: the line for a member not going and for one still waiting; never for the person let in, the
 * host, or anyone on a local community; the line wraps (no numberOfLines) in the secondary text colour, which reads at
 * 4.5:1 or more on the card in both themes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alerts = vi.hoisted(() => [] as Array<{ title: string; msg?: string }>);
vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, disabled, value, onChangeText } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole === 'button') attrs.role = 'button';
        if (accessibilityState?.selected !== undefined) attrs['aria-selected'] = String(accessibilityState.selected);
        if (accessibilityState?.disabled || disabled) attrs['aria-disabled'] = 'true';
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: any) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        ActivityIndicator: () => createElement('span', null, '…'),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, flatten: (s: unknown) => s },
        Alert: { alert: (title: string, msg?: string) => { alerts.push({ title, msg }); } },
        Linking: { openURL: vi.fn() },
        DeviceEventEmitter: { addListener: () => ({ remove() {} }), emit: vi.fn() },
    };
});
vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: ({ children }: { children?: unknown }) => createElement('div', { 'data-kav': 'padding' }, children as any),
}));
vi.mock('expo-router', () => ({ router: { canGoBack: () => false, back: vi.fn(), replace: vi.fn(), push: vi.fn() } }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
const theme = vi.hoisted(() => ({ dark: false }));
vi.mock('../../app/ThemeContext', async () => {
    const m: any = await import('../../constants/colors');
    const pick = () => (theme.dark ? m.darkColors ?? m.default?.darkColors : m.lightColors ?? m.default?.lightColors);
    return {
        useTheme: () => ({ theme: theme.dark ? 'dark' : 'light', colors: pick() }),
        useStyles: (f: any) => f({ theme: theme.dark ? 'dark' : 'light', colors: pick() }),
    };
});
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: { publicKey: 'me'.repeat(32) } }) }));
const node = vi.hoisted(() => ({ view: null as any, sent: [] as unknown[][] }));
vi.mock('../db', () => ({
    fetchEventDetail: async () => node.view,
    rsvpEvent: vi.fn(), deletePost: vi.fn(), reportAbuse: vi.fn(),
    letInToEvent: async (...a: unknown[]) => { node.sent.push(a); return { success: true, post: node.view }; },
}));
vi.mock('../haptics', () => ({ hapticTick: () => {} }));
vi.mock('../../components/PhotoCarousel', () => ({ PhotoCarousel: () => null }));
vi.mock('../../components/EventCard', () => ({ EVENT_ACCENT: '#0a7' }));
vi.mock('../../components/NewEventModal', () => ({ NewEventModal: () => null }));
vi.mock('../../components/EventExtras', () => ({ EventReminder: () => null, EventShareAndCalendar: () => null }));

import { EventDetail } from '../../components/EventDetail';

let root: Root; let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); alerts.length = 0; node.view = null; node.sent.length = 0; });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const buttons = () => Array.from(host.querySelectorAll('[role=button]')) as HTMLElement[];
const button = (name: string) => buttons().find((b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name || b.textContent?.trim() === name);
const click = async (el: HTMLElement | undefined) => { expect(el).toBeTruthy(); await act(async () => { el!.click(); await new Promise((r) => setTimeout(r, 0)); }); };
const NOTE = 'Blue gate, number 12, code 4321';
const base = { id: 'ev-1', type: 'event', title: 'Garden dinner', description: 'Bring a plate', author_pubkey: 'host'.repeat(16),
    authorPublicKey: 'host'.repeat(16), authorCallsign: 'Hana', eventStartAt: new Date(Date.now() + 86_400_000).toISOString(),
    eventEndAt: new Date(Date.now() + 90_000_000).toISOString(), eventPlaceName: 'Bangalow Hall', photos: [], goingCount: 3, interestedCount: 0 };
const draw = async (view: any, openMembership = true) => {
    node.view = view;
    await act(async () => { root.render(createElement(EventDetail, { post: base, openMembership }) as unknown as Parameters<Root['render']>[0]); await new Promise((r) => setTimeout(r, 0)); });
};


const LINE = 'Shown to about 1 km. Ask Hana for the spot when you arrange to meet.';
/** WCAG contrast of two #rrggbb colours. */
function contrast(a: string, b: string): number {
    const lum = (hex: string) => {
        const [r, g, bl] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    };
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
}

for (const dark of [false, true]) {
    describe(`an event's spot where anyone can join (drawn, ${dark ? 'dark' : 'light'})`, () => {
        beforeEach(() => { theme.dark = dark; });
        it('a member not going, and one Going but still waiting, are told the spot is the host\'s to give', async () => {
            await draw({ ...base, lat: -28.65, lng: 153.56, eventHostLetsIn: true, myRsvp: null, myLetIn: null });
            expect(host.textContent).toContain(LINE);
            await draw({ ...base, lat: -28.65, lng: 153.56, eventHostLetsIn: true, myRsvp: 'going', myLetIn: false });
            expect(host.textContent).toContain(LINE);
        });
        it('never the person let in, the host, a local community, or an event with no pin', async () => {
            await draw({ ...base, lat: -28.6512, lng: 153.5634, eventHostLetsIn: true, myRsvp: 'going', myLetIn: true, eventPrivateNote: NOTE });
            expect(host.textContent).not.toContain('Shown to about 1 km');
            await draw({ ...base, lat: -28.6512, lng: 153.5634, eventHostLetsIn: true, eventRsvps: [] });
            expect(host.textContent).not.toContain('Shown to about 1 km');
            await draw({ ...base, lat: -28.65, lng: 153.56, myRsvp: null }, false);
            expect(host.textContent).not.toContain('Shown to about 1 km');
            await draw({ ...base, lat: null, lng: null, myRsvp: null });
            expect(host.textContent).not.toContain('Shown to about 1 km');
        });
        it('the line wraps, in a colour that reads on the page and the card', async () => {
            const m: any = await import('../../constants/colors');
            const colors = dark ? m.darkColors : m.lightColors;
            await draw({ ...base, lat: -28.65, lng: 153.56, myRsvp: null });
            const el = Array.from(host.querySelectorAll('span')).find(x => x.textContent === LINE);
            expect(el).toBeTruthy();
            // EventDetail draws it in colors.text.secondary (styles.roughPlace), with no line limit, so at 130 % text on a
            // 320 dp screen it wraps rather than cuts off.
            const source = fs.readFileSync(path.join(__dirname, '../../components/EventDetail.tsx'), 'utf8');
            expect(source).toMatch(/roughPlace: \{[^}]*color: colors\.text\.secondary/);
            expect(source).toMatch(/<Text style=\{styles\.roughPlace\} testID="rough-place-line">/);
            for (const ground of [colors.surface.card, colors.surface.page]) {
                expect(contrast(colors.text.secondary, ground), `${colors.text.secondary} on ${ground}`).toBeGreaterThanOrEqual(4.5);
            }
        });
    });
}
