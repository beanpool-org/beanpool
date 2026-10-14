// @vitest-environment jsdom
/**
 * The event screen's report (components/EventDetail.tsx + components/ReportReasonBox.tsx), drawn for real: react-dom in
 * jsdom, React Native's host components as plain tags carrying their accessibility props, and a stubbed node behind
 * utils/db. From "Report event" to what reportAbuse is sent, and what the box keeps when the send fails.
 *
 * From the review of #1912 (finding 4: the box and its wiring were only read as source text, and a box that never showed
 * or a Submit that never enabled passed every test; finding 3: a failed send wiped the member's choice and words).
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
const node = vi.hoisted(() => ({ fail: false, sent: [] as unknown[][] }));
vi.mock('../db', () => ({
    fetchEventDetail: async () => null,
    rsvpEvent: vi.fn(), deletePost: vi.fn(),
    reportAbuse: async (...a: unknown[]) => { if (node.fail) throw new Error('Could not reach the node.'); node.sent.push(a); return { success: true }; },
}));
vi.mock('../haptics', () => ({ hapticTick: () => {} }));
vi.mock('../../components/PhotoCarousel', () => ({ PhotoCarousel: () => null }));
vi.mock('../../components/EventCard', () => ({ EVENT_ACCENT: '#0a7' }));
vi.mock('../../components/NewEventModal', () => ({ NewEventModal: () => null }));
vi.mock('../../components/EventExtras', () => ({ EventReminder: () => null, EventShareAndCalendar: () => null }));

import { EventDetail } from '../../components/EventDetail';

let root: Root; let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); alerts.length = 0; node.fail = false; node.sent.length = 0; });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const button = (name: string | RegExp) => Array.from(host.querySelectorAll('[role=button]')).find((b) => (typeof name === 'string' ? (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name : name.test(b.textContent ?? ''))) as HTMLElement | undefined;
const click = async (el: HTMLElement | undefined) => { expect(el).toBeTruthy(); await act(async () => { el!.click(); await new Promise((r) => setTimeout(r, 0)); }); };
const type = async (v: string) => { const i = host.querySelector('input[aria-label="Add a few words (optional)"]') as HTMLInputElement; expect(i).toBeTruthy(); await act(async () => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!; set.call(i, v); i.dispatchEvent(new Event('input', { bubbles: true })); }); };
const post = { id: 'ev-1', type: 'event', title: 'Working bee', description: 'Bring gloves', author_pubkey: 'host'.repeat(16), eventStartAt: new Date(Date.now() + 86_400_000).toISOString(), photos: [] };

describe('the event screen reports through the shared box (drawn)', () => {
    it('Report event opens the box; Child safety with words goes to reportAbuse with the event id; the box closes', async () => {
        await act(async () => { root.render(createElement(EventDetail, { post }) as unknown as Parameters<Root['render']>[0]); });
        expect(host.textContent).not.toContain('WHY ARE YOU REPORTING IT?');
        await click(button('Report event'));
        expect(host.textContent).toContain('WHY ARE YOU REPORTING IT?');
        expect(Array.from(host.querySelectorAll('[aria-selected]')).slice(-5).map((b) => b.textContent)).toEqual(['Spam or scam', 'Offensive content', 'Misleading post', 'Child safety', 'Other']);
        expect(button('Submit report')?.getAttribute('aria-disabled')).toBe('true');
        await click(button('Child safety'));
        await type('  he asked my son for photos ');
        await click(button('Submit report'));
        expect(node.sent).toEqual([['me'.repeat(32), 'host'.repeat(16), 'Child safety: he asked my son for photos', 'ev-1']]);
        expect(alerts.map((a) => a.title)).toEqual(['Reported']);
        expect(host.textContent).not.toContain('WHY ARE YOU REPORTING IT?');
    });

    it('a failed send says "Not sent" and keeps the box open with the choice and the words, ready to send again', async () => {
        await act(async () => { root.render(createElement(EventDetail, { post }) as unknown as Parameters<Root['render']>[0]); });
        await click(button('Report event'));
        await click(button('Child safety'));
        await type('he asked my son for photos');
        node.fail = true;
        await click(button('Submit report'));
        expect(alerts.map((a) => a.title)).toEqual(['Not sent']);
        const input = host.querySelector('input[aria-label="Add a few words (optional)"]') as HTMLInputElement;
        expect(input).toBeTruthy();
        expect(input.value).toBe('he asked my son for photos');
        expect(Array.from(host.querySelectorAll('[aria-selected=true]')).map((b) => b.textContent)).toEqual(['✓ Child safety']);
        expect(button('Submit report')?.getAttribute('aria-disabled')).toBeNull();
        // The node is back: the same box sends what the member chose and wrote, without retyping.
        node.fail = false;
        await click(button('Submit report'));
        expect(node.sent).toEqual([['me'.repeat(32), 'host'.repeat(16), 'Child safety: he asked my son for photos', 'ev-1']]);
        expect(alerts.map((a) => a.title)).toEqual(['Not sent', 'Reported']);
        expect(host.textContent).not.toContain('WHY ARE YOU REPORTING IT?');
    });

    it('the screen moves its content up for the keyboard, so the words box and Submit stay in view (finding 2)', async () => {
        await act(async () => { root.render(createElement(EventDetail, { post }) as unknown as Parameters<Root['render']>[0]); });
        await click(button('Report event'));
        const kav = host.querySelector('[data-kav]');
        expect(kav).toBeTruthy();
        expect(kav!.contains(host.querySelector('input[aria-label="Add a few words (optional)"]'))).toBe(true);
        expect(kav!.contains(button('Submit report')!)).toBe(true);
    });
});
