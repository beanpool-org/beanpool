// @vitest-environment jsdom
/**
 * A cancelled event: a member who is Going says "Not going", answered with post:null
 * (the event is no longer theirs to see, PR #2078).
 *
 * Proves that EventDetail shows not going at once and updates the counts (dropping the member from the count they
 * were in), and that the Market's EventCard, which no longer answers (the mark on the card, the buttons on the page),
 * follows the post it is handed: the member's mark while they are going, the honest counts once they are not.
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
    KeyboardAwareScrollView: ({ children, keyboardShouldPersistTaps }: { children?: unknown; keyboardShouldPersistTaps?: string }) => createElement('div', { 'data-kav': 'scroll', 'data-taps': keyboardShouldPersistTaps }, children as any),
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
// The page draws the photo viewer (a Modal with a close icon) only while a photo is open; the icon library cannot load outside a device.
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-avatar': 'true' }) }));
vi.mock('../../components/NewEventModal', () => ({ NewEventModal: () => null }));
// The quiet row's Share, as a button where the page draws it (the real one is EventExtras', with its sheet): the page's order is what is read.
vi.mock('../../components/EventExtras', () => ({ EventReminder: () => null, EventShareAndCalendar: () => createElement('div', { role: 'button', 'aria-label': 'Share this event' }, '🔗 Share') }));

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
    // The card no longer answers (Marty, 4 Nov: Going / Interested on the event's page, the mark on the card): it follows the
    // post it is handed. The page withdraws; the Market's next read hands the card the post as the node now holds it.
    it('a cancelled event, the member Going, then "Not going" on the page → the card follows the post: the mark, then the right counts', async () => {
        const draw = async (post: any) => {
            await act(async () => {
                root.render(createElement(EventCard, {
                    post,
                    currentPubkey: 'me'.repeat(32),
                }) as unknown as Parameters<Root['render']>[0]);
                await new Promise((r) => setTimeout(r, 0));
            });
        };
        await draw(cancelledEvent);

        // Going: the card shows the member's mark, and has no button but itself
        expect(host.textContent).toContain('Going ✓');
        expect(buttons()).toHaveLength(1);
        expect(button('Going, selected. Tap to clear')).toBeUndefined();
        expect(button('Interested')).toBeUndefined();

        // The member said "Not going" on the page; the post comes back without them: 6 going · 3 interested, no mark
        await draw({ ...cancelledEvent, myRsvp: null, goingCount: 6 });
        expect(host.textContent).not.toContain('Going ✓');
        expect(host.textContent).toContain('6 going · 3 interested');
        expect(buttons()).toHaveLength(1);
        // The card never sent an answer of its own
        expect(db.rsvpEvent).not.toHaveBeenCalled();
    });

    it('EventDetail: a cancelled event, the member Going, "Not going" answered with post:null → shows not going and the right counts', async () => {
        vi.mocked(db.rsvpEvent).mockResolvedValueOnce({ success: true, post: null } as any);

        await act(async () => {
            root.render(createElement(EventDetail, {
                post: { ...cancelledEvent, eventPrivateNote: 'Meet at the back gate, code 4411' },
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
        // The note for people who are going goes with the member's place.
        expect(host.textContent).not.toContain('Meet at the back gate');
    });
});

// The page half of DP1 (DESIGN-detail-pages-fable.md §3): the answer comes before Share, and the counts show only once someone has answered.
describe("the event's page: the answer first, the counts only above zero (DP1)", () => {
    const drawPage = async (post: any) => {
        await act(async () => {
            root.render(createElement(EventDetail, { post }) as unknown as Parameters<Root['render']>[0]);
            await new Promise((r) => setTimeout(r, 0));
        });
    };
    const open = { ...cancelledEvent, id: 'ev-open-1', eventState: undefined, myRsvp: null };

    it('Going comes before Share in the page\'s order', async () => {
        await drawPage({ ...open, goingCount: 0, interestedCount: 0 });
        const going = button('Going');
        const share = button('Share this event');
        expect(going).toBeTruthy();
        expect(share).toBeTruthy();
        expect(going!.compareDocumentPosition(share!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('nobody has answered: no counts at all (never "0 going · 0 interested")', async () => {
        await drawPage({ ...open, goingCount: 0, interestedCount: 0 });
        expect(host.textContent).not.toContain('going ·');
        expect(host.textContent).not.toContain('0 going');
    });

    it('three going and one interested: "3 going · 1 interested"', async () => {
        await drawPage({ ...open, goingCount: 3, interestedCount: 1 });
        expect(host.textContent).toContain('3 going · 1 interested');
    });
});
