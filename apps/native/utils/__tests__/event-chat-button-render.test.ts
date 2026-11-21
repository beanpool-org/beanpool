// @vitest-environment jsdom
/**
 * The event page's chat button on the phone (Marty, 16 Nov 2026: "the chat should be a little more obvious within the event
 * card ... a slightly more obvious colour? or increase the font size? ... the spacing between the chat icon and open could be
 * a little bigger"), drawn for real as event-host-lets-in-render.test.ts draws it: "Chat with people going" in the brand ink,
 * 16 dp words, 12 dp between the icon and the words, and "N new" from the member's "Your groups" list when lines wait. The
 * web's EventCard.chat-button.test.tsx holds the same. The layout at 320 dp and 1.3× text, light and dark, is
 * event-page-shell-render.test.ts's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, disabled, testID, style } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole === 'button') attrs.role = 'button';
        if (accessibilityState?.disabled || disabled) attrs['aria-disabled'] = 'true';
        if (testID) attrs['data-testid'] = testID;
        if (style) attrs['data-style'] = JSON.stringify([style].flat(Infinity).filter(Boolean).reduce((a: object, s: object) => ({ ...a, ...s }), {}));
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: any) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        ActivityIndicator: () => createElement('span', null, '…'),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => s },
        Alert: { alert: () => {} },
        Linking: { openURL: vi.fn() },
        DeviceEventEmitter: { addListener: () => ({ remove() {} }), emit: vi.fn() },
    };
});
vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
    KeyboardAwareScrollView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
}));
vi.mock('expo-router', () => ({ router: { canGoBack: () => false, back: vi.fn(), replace: vi.fn(), push: vi.fn() } }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
vi.mock('../../app/ThemeContext', async () => {
    const m: any = await import('../../constants/colors');
    const colors = m.lightColors ?? m.default?.lightColors;
    return { useTheme: () => ({ theme: 'light', colors }), useStyles: (f: any) => f({ theme: 'light', colors }) };
});
const ME = 'me'.repeat(32);
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: { publicKey: ME } }) }));
const node = vi.hoisted(() => ({ view: null as any, chats: [] as any[], asked: 0 }));
vi.mock('../db', () => ({
    fetchEventDetail: async () => node.view,
    rsvpEvent: vi.fn(), deletePost: vi.fn(), reportAbuse: vi.fn(), letInToEvent: vi.fn(),
    fetchYourGroups: async () => { node.asked++; return { items: node.chats, totalUnread: node.chats.reduce((n, c) => n + c.unreadCount, 0) }; },
}));
vi.mock('../haptics', () => ({ hapticTick: () => {} }));
vi.mock('../../components/PhotoCarousel', () => ({ PhotoCarousel: () => null }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-avatar': 'true' }) }));
vi.mock('../../components/EventCard', () => ({ EVENT_ACCENT: '#0a7' }));
vi.mock('../../components/NewEventModal', () => ({ NewEventModal: () => null }));
vi.mock('../../components/EventExtras', () => ({ useEventReminderChoice: () => ({ supported: true, offsets: null, defaults: [1440], marketplaceOn: true, known: false, setOffsets: () => {}, setUnsupported: () => {} }), EventReminder: () => null, EventShareAndCalendar: () => null }));

import { EventDetail } from '../../components/EventDetail';
import { yourGroupsStore } from '../../components/useYourGroups';
import { lightColors } from '../../constants/colors';

let root: Root; let host: HTMLDivElement;
beforeEach(() => {
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    node.view = null; node.chats = []; node.asked = 0; yourGroupsStore.reset();
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const chatButton = () => host.querySelector('[data-testid="event-chat-open"]') as HTMLElement | null;
const styleOf = (el: Element | null) => JSON.parse(el?.getAttribute('data-style') ?? '{}');
const base = { id: 'ev-1', type: 'event', title: 'Garden dinner', description: 'Bring a plate', author_pubkey: 'host'.repeat(16),
    authorPublicKey: 'host'.repeat(16), authorCallsign: 'Hana', eventStartAt: new Date(Date.now() + 86_400_000).toISOString(),
    eventEndAt: new Date(Date.now() + 90_000_000).toISOString(), eventPlaceName: 'Riverside Hall', photos: [], goingCount: 3, interestedCount: 0 };
const eventChat = (unreadCount: number, conversationId = 'ev-1') => ({ kind: 'event', badge: '📅', id: conversationId, conversationId, name: 'Garden dinner',
    avatarUrl: null, role: 'going', readOnly: false, lastMessage: null, unreadCount, mute: null, lastActivityAt: new Date().toISOString() });
const draw = async (view: any) => {
    node.view = view;
    await act(async () => { root.render(createElement(EventDetail, { post: view }) as any); await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

describe('the chat button says it is a chat, in the brand colour', () => {
    it('"Chat with people going" in the brand ink, 16 dp words, 12 dp from the icon; no count while nothing waits', async () => {
        await draw({ ...base, myRsvp: 'going' });
        const btn = chatButton()!;
        expect(btn).toBeTruthy();
        expect(btn.getAttribute('aria-label')).toBe('Chat with people going');
        expect(btn.textContent).not.toContain('Open event chat');
        expect(styleOf(btn)).toMatchObject({ borderColor: lightColors.brand.primary, flexDirection: 'row', alignItems: 'center', gap: 12 });
        const [icon, words] = Array.from(btn.querySelectorAll('span'));
        expect(icon.textContent).toBe('💬');
        expect(words.textContent).toBe('Chat with people going');
        expect(styleOf(words)).toMatchObject({ color: lightColors.brand.primary, fontSize: 16 });
        expect(host.querySelector('[data-testid="event-chat-new"]')).toBeNull();
    });
});

describe('a count of the lines not read yet', () => {
    it('3 unread in their list: "3 new" on the brand fill, and in the button\'s name', async () => {
        node.chats = [eventChat(3)];
        await draw({ ...base, myRsvp: 'going' });
        const pill = host.querySelector('[data-testid="event-chat-new"]')!;
        expect(pill.textContent).toBe('3 new');
        expect(styleOf(pill)).toMatchObject({ backgroundColor: lightColors.brand.fill });
        expect(styleOf(pill.querySelector('span'))).toMatchObject({ color: lightColors.text.onBrand });
        expect(chatButton()!.getAttribute('aria-label')).toBe('Chat with people going, 3 new');
    });

    it('1 unread: "1 new"', async () => {
        node.chats = [eventChat(1)];
        await draw({ ...base, myRsvp: 'going' });
        expect(host.querySelector('[data-testid="event-chat-new"]')!.textContent).toBe('1 new');
    });

    it('none unread, or the chat not in their list (nobody has posted): no count', async () => {
        for (const chats of [[eventChat(0)], [eventChat(4, 'other-event')], []]) {
            yourGroupsStore.reset();
            node.chats = chats;
            await draw({ ...base, myRsvp: 'going' });
            expect(host.querySelector('[data-testid="event-chat-new"]'), JSON.stringify(chats.map((c) => c.conversationId))).toBeNull();
        }
    });

    it('the host, who need not have answered, has the button and its count', async () => {
        node.chats = [eventChat(5)];
        await draw({ ...base, myRsvp: null, eventRsvps: [] });
        expect(host.querySelector('[data-testid="event-chat-new"]')!.textContent).toBe('5 new');
    });

    it('Interested or not going: no chat button, and the list is not asked for', async () => {
        node.chats = [eventChat(2)];
        for (const myRsvp of ['interested', null]) {
            await draw({ ...base, myRsvp });
            expect(chatButton()).toBeNull();
        }
        expect(node.asked).toBe(0);
    });
});
