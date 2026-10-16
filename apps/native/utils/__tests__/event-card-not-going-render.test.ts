// @vitest-environment jsdom
/**
 * A cancelled event: a member who is Going says "Not going", answered with post:null
 * (the event is no longer theirs to see, PR #2078).
 *
 * Proves that both the phone's EventCard and EventDetail show not going at once
 * and update the counts (dropping the member from the count they were in).
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
        View: el('div'), Text: el('span'), Pressable: el('div'), ScrollView: el('div'), TextInput: el('input'),
        ActivityIndicator: () => createElement('span', null, '…'),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => s },
        Alert: { alert: (title: string, msg?: string) => { alerts.push({ title, msg }); } },
        Linking: { openURL: vi.fn() },
        DeviceEventEmitter: { addListener: () => ({ remove() {} }), emit: vi.fn() },
    };
});
vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: ({ children }: { children?: unknown }) => createElement('div', { 'data-kav': 'padding' }, children as any),
}));
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('expo-router', () => ({ router: { canGoBack: () => false, back: vi.fn(), replace: vi.fn(), push: vi.fn() } }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
vi.mock('../../app/ThemeContext', async () => {
    const m: any = await import('../../constants/colors');
    const colors = m.lightColors ?? m.default?.lightColors;
    return { useTheme: () => ({ theme: 'light', colors }), useStyles: (f: any) => f({ theme: 'light', colors }) };
});
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: { publicKey: 'me'.repeat(32) } }) }));
vi.mock('../db', () => ({
    rsvpEvent: vi.fn(),
    fetchEventDetail: vi.fn(),
    deletePost: vi.fn(),
    reportAbuse: vi.fn(),
    letInToEvent: vi.fn(),
}));
vi.mock('../haptics', () => ({ hapticTick: () => {} }));
vi.mock('../../components/PhotoCarousel', () => ({ PhotoCarousel: () => null }));
vi.mock('../../components/NewEventModal', () => ({ NewEventModal: () => null }));
vi.mock('../../components/EventExtras', () => ({ EventReminder: () => null, EventShareAndCalendar: () => null }));

import { EventCard } from '../../components/EventCard';
import { EventDetail } from '../../components/EventDetail';
import * as db from '../db';

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    alerts.length = 0;
    vi.mocked(db.rsvpEvent).mockReset();
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

const buttons = () => Array.from(host.querySelectorAll('[role=button]')) as HTMLElement[];
const button = (name: string) => buttons().find((b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name || b.textContent?.trim() === name);
const click = async (el: HTMLElement | undefined) => {
    expect(el).toBeTruthy();
    await act(async () => {
        el!.click();
        await new Promise((r) => setTimeout(r, 0));
    });
};

const cancelledEvent: any = {
    id: 'ev-cancelled-1',
    type: 'event',
    title: 'Bush care day',
    description: 'Planting trees',
    author_pubkey: 'host'.repeat(16),
    authorPublicKey: 'host'.repeat(16),
    authorCallsign: 'Hazel',
    status: 'active',
    eventState: 'cancelled',
    eventStartAt: new Date(Date.now() + 86_400_000).toISOString(),
    eventEndAt: new Date(Date.now() + 90_000_000).toISOString(),
    eventPlaceName: 'Mullumbimby Creek',
    photos: [],
    goingCount: 7,
    interestedCount: 3,
    myRsvp: 'going',
};

describe('cancelled event RSVP withdrawal on native (PR #2078 gap)', () => {
    it('a cancelled event, the member Going, "Not going" answered with post:null → the card shows not going and the right counts', async () => {
        vi.mocked(db.rsvpEvent).mockResolvedValueOnce({ success: true, post: null } as any);
        const onRsvpChanged = vi.fn();

        await act(async () => {
            root.render(createElement(EventCard, {
                post: cancelledEvent,
                currentPubkey: 'me'.repeat(32),
                onRsvpChanged,
            }) as unknown as Parameters<Root['render']>[0]);
            await new Promise((r) => setTimeout(r, 0));
        });

        // Initially shows 7 going · 3 interested, with Going button selected
        expect(host.textContent).toContain('7 going · 3 interested');
        const goingBtn = button('Going, selected. Tap to clear');
        expect(goingBtn).toBeTruthy();
        expect(goingBtn?.getAttribute('aria-disabled')).toBeNull();

        // Interested button is disabled because joining a cancelled event is blocked
        const interestedBtn = button('Interested');
        expect(interestedBtn?.getAttribute('aria-disabled')).toBe('true');

        // Tap Going to withdraw ("Not going")
        await click(goingBtn);
        expect(db.rsvpEvent).toHaveBeenCalledWith('ev-cancelled-1', null);

        // Shows not going and honest counts: 6 going · 3 interested
        expect(host.textContent).toContain('6 going · 3 interested');
        expect(button('Going, selected. Tap to clear')).toBeUndefined();
        const goingAfter = button('Going');
        expect(goingAfter).toBeTruthy();
        // Once not going, both buttons are disabled on the cancelled event
        expect(goingAfter?.getAttribute('aria-disabled')).toBe('true');
        expect(interestedBtn?.getAttribute('aria-disabled')).toBe('true');
        expect(onRsvpChanged).toHaveBeenCalled();
    });

    it('EventDetail: a cancelled event, the member Going, "Not going" answered with post:null → shows not going and the right counts', async () => {
        vi.mocked(db.rsvpEvent).mockResolvedValueOnce({ success: true, post: null } as any);

        await act(async () => {
            root.render(createElement(EventDetail, {
                post: cancelledEvent,
            }) as unknown as Parameters<Root['render']>[0]);
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(host.textContent).toContain('7 going · 3 interested');
        const goingBtn = button('Going, selected. Tap to clear');
        expect(goingBtn).toBeTruthy();
        expect(goingBtn?.getAttribute('aria-disabled')).toBeNull();

        // Tap Going to withdraw
        await click(goingBtn);
        expect(db.rsvpEvent).toHaveBeenCalledWith('ev-cancelled-1', null);

        // Shows not going and 6 going · 3 interested
        expect(host.textContent).toContain('6 going · 3 interested');
        expect(button('Going, selected. Tap to clear')).toBeUndefined();
        const goingAfter = button('Going');
        expect(goingAfter).toBeTruthy();
        expect(goingAfter?.getAttribute('aria-disabled')).toBe('true');
    });
});
