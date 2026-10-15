// @vitest-environment jsdom
/**
 * The event screen where the host lets people in (scratch/global-node/DESIGN-global-member-privacy-fable.md §2.3, §7 slice 3),
 * drawn for real as event-report-render.test.ts draws it: react-dom in jsdom, React Native's host components as plain
 * tags carrying their accessibility props, and a stubbed node behind utils/db.
 *
 * The member's three states (before Going, Going and waiting, let in) and the host's panel (the waiting count, Let in /
 * Let in ✓ beside each Going row, Let everyone in with its question), and what the host's taps send.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
vi.mock('../../app/ThemeContext', async () => {
    const m: any = await import('../../constants/colors');
    const colors = m.lightColors ?? m.default?.lightColors;
    return { useTheme: () => ({ theme: 'light', colors }), useStyles: (f: any) => f({ theme: 'light', colors }) };
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
const draw = async (view: any) => {
    node.view = view;
    await act(async () => { root.render(createElement(EventDetail, { post: base }) as unknown as Parameters<Root['render']>[0]); await new Promise((r) => setTimeout(r, 0)); });
};

describe('a member, where the host lets people in (drawn)', () => {
    it('before Going: told the host lets people in; no note, no chat entry', async () => {
        await draw({ ...base, eventHostLetsIn: true, myRsvp: null, myLetIn: null });
        expect(host.textContent).toContain('The host lets people in. Tap Going, and the note and the chat open once they do.');
        expect(host.textContent).not.toContain(NOTE);
        expect(button('Open event chat')).toBeUndefined();
    });
    it('Going and waiting: the waiting words, and the chat entry disabled with its own words', async () => {
        await draw({ ...base, eventHostLetsIn: true, myRsvp: 'going', myLetIn: false });
        expect(host.textContent).toContain("You're going. The host hasn't let you in yet: the note and the chat open when they do.");
        const entry = button('Chat opens when the host lets you in.');
        expect(entry?.getAttribute('aria-disabled')).toBe('true');
        expect(button('Open event chat')).toBeUndefined();
        expect(host.textContent).not.toContain('Only the host and people going');
        expect(host.textContent).not.toContain(NOTE);
    });
    it('let in: the note and the chat, no waiting words', async () => {
        await draw({ ...base, eventHostLetsIn: true, myRsvp: 'going', myLetIn: true, eventPrivateNote: NOTE });
        expect(host.textContent).toContain(NOTE);
        expect(button('Open event chat')).toBeTruthy();
        expect(host.textContent).not.toContain("hasn't let you in");
    });
    it('where the host does not let people in, Going opens it as before', async () => {
        await draw({ ...base, myRsvp: 'going', eventPrivateNote: NOTE });
        expect(host.textContent).toContain(NOTE);
        expect(button('Open event chat')).toBeTruthy();
        expect(host.textContent).not.toContain('The host lets people in');
    });
});

describe("the host's panel (drawn)", () => {
    const rsvps = [
        { memberPubkey: 'a'.repeat(64), memberCallsign: 'Sam', status: 'going', updatedAt: '2026-10-15T00:00:00.000Z', letInAt: null },
        { memberPubkey: 'b'.repeat(64), memberCallsign: 'Tia', status: 'going', updatedAt: '2026-10-15T00:00:00.000Z', letInAt: null },
        { memberPubkey: 'c'.repeat(64), memberCallsign: 'Fred', status: 'going', updatedAt: '2026-10-15T00:00:00.000Z', letInAt: '2026-10-15T01:00:00.000Z' },
        { memberPubkey: 'd'.repeat(64), memberCallsign: 'Uma', status: 'interested', updatedAt: '2026-10-15T00:00:00.000Z', letInAt: null },
    ];
    it('the waiting count; Let in beside each Going row, Let in ✓ for the ones let in; Let everyone in asks first', async () => {
        await draw({ ...base, eventHostLetsIn: true, eventRsvps: rsvps, eventPrivateNote: NOTE, myRsvp: null });
        expect(host.textContent).toContain('2 waiting to be let in');
        expect(host.textContent).not.toContain('The host lets people in');
        await click(button("Who's going, 4 replies"));
        expect(button('Let Sam in')?.textContent).toBe('Let in');
        expect(button('Let Tia in')?.textContent).toBe('Let in');
        expect(button('Let in. Tap to take it back from Fred')?.textContent).toBe('Let in ✓');
        expect(button('Let Uma in')).toBeUndefined();
        await click(button('Let Sam in'));
        expect(node.sent).toEqual([['ev-1', { memberPublicKey: 'a'.repeat(64) }, true]]);
        await click(button('Let in. Tap to take it back from Fred'));
        expect(node.sent[1]).toEqual(['ev-1', { memberPublicKey: 'c'.repeat(64) }, false]);
        await click(button('Let everyone in'));
        expect(alerts.at(-1)).toEqual({ title: 'Let everyone in', msg: 'Let all 2 in? People who tap Going later still wait.' });
    });
    it('where the host does not let people in, the rows show Going and Interested as before', async () => {
        await draw({ ...base, eventRsvps: rsvps.map(({ letInAt: _l, ...r }) => r), myRsvp: null });
        expect(host.textContent).not.toContain('waiting to be let in');
        await click(button("Who's going, 4 replies"));
        expect(button('Let Sam in')).toBeUndefined();
        expect(host.textContent).toContain('Going');
    });
});
