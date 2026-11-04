// @vitest-environment jsdom
/**
 * The person on an item's own screen is where its profile opens (Marty, 4 Nov 2026: "Once they are in the item and then they
 * click on the person that is a good time to go to the profile"). The small cards that lead here open the event and never its
 * host; on the event's screen "Hosted by {name}" is the tap that opens the host's profile, as the web's event page does. Drawn
 * for real as event-tag-chips-render.test.ts draws the screen.
 *
 * A member's copy of an event has no host to open, and a visitors' view that hides who posted offers no profile.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const push = vi.hoisted(() => vi.fn());
vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, disabled, testID } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole === 'button') attrs.role = 'button';
        if (testID) attrs['data-testid'] = testID;
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: any) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        ActivityIndicator: () => null,
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, flatten: (s: unknown) => s },
        Alert: { alert: vi.fn() },
        Linking: { openURL: vi.fn() },
        DeviceEventEmitter: { addListener: () => ({ remove() {} }), emit: vi.fn() },
        AppState: { addEventListener: () => ({ remove() {} }) },
    };
});
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAvoidingView: ({ children }: { children?: unknown }) => createElement('div', null, children as any), KeyboardAwareScrollView: ({ children }: { children?: unknown }) => createElement('div', null, children as any), KeyboardStickyView: ({ children }: { children?: unknown }) => createElement('div', null, children as any) }));
vi.mock('expo-router', () => ({ router: { canGoBack: () => false, back: vi.fn(), replace: vi.fn(), push, dismissTo: vi.fn() } }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
vi.mock('../../app/ThemeContext', async () => {
    const m: any = await import('../../constants/colors');
    const colors = m.lightColors ?? m.default?.lightColors;
    return { useTheme: () => ({ theme: 'light', colors }), useStyles: (f: any) => f({ theme: 'light', colors }) };
});
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: { publicKey: 'me'.repeat(32) } }) }));
vi.mock('../db', () => ({ fetchEventDetail: async () => null, rsvpEvent: vi.fn(), deletePost: vi.fn(), reportAbuse: vi.fn(), letInToEvent: vi.fn() }));
vi.mock('../haptics', () => ({ hapticTick: () => {} }));
vi.mock('../../components/PhotoCarousel', () => ({ PhotoCarousel: () => null }));
vi.mock('../../components/EventCard', () => ({ EVENT_ACCENT: '#0a7' }));
vi.mock('../../components/NewEventModal', () => ({ NewEventModal: () => null }));
vi.mock('../../components/EventExtras', () => ({ EventReminder: () => null, EventShareAndCalendar: () => null }));

import { EventDetail } from '../../components/EventDetail';
import { HIDDEN_AUTHOR } from '../posts-view';

let root: Root; let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); push.mockClear(); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const HOST_KEY = 'host'.repeat(16);
const event = { id: 'ev-1', type: 'event', title: 'Working bee', description: 'Bring gloves', author_pubkey: HOST_KEY, author_callsign: 'Hana', eventStartAt: new Date(Date.now() + 86_400_000).toISOString(), photos: [] };
const draw = async (more: Record<string, unknown> = {}) => { await act(async () => { root.render(createElement(EventDetail, { post: { ...event, ...more } }) as any); }); };
const hostButton = () => host.querySelector('[data-testid="event-host-open"]') as HTMLElement | null;

describe('an event\'s own screen: the host is the way to their profile', () => {
    it('"Hosted by Hana" is a button named for the profile it opens, and a tap opens it', async () => {
        await draw();
        const button = hostButton();
        expect(button, 'the host line').toBeTruthy();
        expect(button!.textContent).toBe('Hosted by Hana');
        expect(button!.getAttribute('role')).toBe('button');
        expect(button!.getAttribute('aria-label')).toBe("View Hana's profile");
        await act(async () => { button!.click(); });
        expect(push).toHaveBeenCalledTimes(1);
        expect(push).toHaveBeenCalledWith({ pathname: '/public-profile', params: { publicKey: HOST_KEY, callsign: 'Hana' } });
    });

    it('a member\'s copy of an event has no host to open: the line is plain', async () => {
        await draw({ shown_from: JSON.stringify({ host: 'byron.example', name: 'Byron', url: 'https://byron.example', door: 'ask', price: { amount: 0, unit: 'fixed' } }) });
        expect(hostButton()).toBeNull();
    });

    it('a visitors\' view that hides who posted offers no profile', async () => {
        await draw({ author_pubkey: HIDDEN_AUTHOR });
        expect(hostButton()).toBeNull();
        expect(push).not.toHaveBeenCalled();
    });
});
