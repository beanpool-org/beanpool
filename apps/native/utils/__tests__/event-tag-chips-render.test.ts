// @vitest-environment jsdom
/**
 * An event's tags on the phone's event screen (components/EventDetail.tsx, DESIGN-owner-seeding-tags-fable.md §4.4), drawn for
 * real as event-report-render.test.ts draws it. The composers offer tags on events, and app/post/[id].tsx returns EventDetail
 * before its own chips, so this screen draws them: in the member's language, each opening the Market filtered by it, an id
 * the library can't label as nothing (review of #2663, the phone's half; the web's is in EventCard.test.tsx).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { resolveHref } from 'expo-router/build/link/href';
import { parseQueryParams } from 'expo-router/build/fork/getStateFromPath-forks';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const push = vi.hoisted(() => vi.fn());
const dismissTo = vi.hoisted(() => vi.fn());
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
    };
});
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAvoidingView: ({ children }: { children?: unknown }) => createElement('div', null, children as any) }));
vi.mock('expo-router', () => ({ router: { canGoBack: () => false, back: vi.fn(), replace: vi.fn(), push, dismissTo } }));
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

let root: Root; let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); push.mockClear(); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const event = { id: 'ev-1', type: 'event', title: 'Working bee', description: 'Bring gloves', author_pubkey: 'host'.repeat(16), eventStartAt: new Date(Date.now() + 86_400_000).toISOString(), photos: [] };
const draw = async (tags: unknown, more: Record<string, unknown> = {}) => { await act(async () => { root.render(createElement(EventDetail, { post: { ...event, tags, ...more } }) as any); }); };
const row = () => host.querySelector('[data-testid="detail-tags-row"]');
/** What the Market's `params.free` reads after a chip's dismissTo: the router's own href and query parser, then useLocalSearchParams, which decodes once more (expo-router build/hooks.js). */
const arrivesAs = (to: { pathname: string; params: Record<string, string> }) => {
    const free = parseQueryParams(resolveHref(to), {} as never)?.free as string;
    try { return decodeURIComponent(free); } catch { return free; }
};

describe('an event\'s tags on the phone', () => {
    it('as the phone keeps them (space-separated): the chips, each opening the Market on that tag', async () => {
        await draw('food.fruit.lemon food.from-a-newer-library');
        const chips = Array.from(row()!.querySelectorAll('[role=button]')) as HTMLElement[];
        expect(chips.map((c) => c.textContent)).toEqual(['Lemon']);
        expect(chips[0].getAttribute('aria-label')).toBe('Filter marketplace by tag Lemon');
        await act(async () => { chips[0].click(); });
        expect(dismissTo).toHaveBeenCalledWith({ pathname: '/(tabs)/market', params: { tag: 'food.fruit.lemon' } });
        expect(push).not.toHaveBeenCalled();
    });

    it('a typed tag shows as #word and opens the Market with exactly it, by dismissTo: a push from this modal would leave no way back', async () => {
        for (const more of [{ free_tags: '["2nd hand"]' }, { freeTags: ['2nd hand'] }]) {
            dismissTo.mockClear();
            await draw('', more);
            const chip = row()!.querySelector('[role=button]') as HTMLElement;
            expect(chip.textContent).toBe('#2nd hand');
            expect(chip.getAttribute('aria-label')).toBe('Filter marketplace by tag #2nd hand');
            await act(async () => { chip.click(); });
            expect(dismissTo).toHaveBeenCalledTimes(1);
            expect(dismissTo.mock.calls[0][0].pathname).toBe('/(tabs)/market');
            expect(arrivesAs(dismissTo.mock.calls[0][0])).toBe('2nd hand');
        }
        expect(push).not.toHaveBeenCalled();
    });

    it('a typed tag reaches the Market letter for letter, whatever it spells: through the router itself, not a copy of it', async () => {
        // "a%20b" is a tag the rule lets through. Sent as it stands it arrives as "a b", a tag nobody typed, and the Market is empty.
        for (const tag of ['a%20b', '5%20 off', '50%25', '100% wool', 'r&b', '24/7', 'what?', 'limón', '二手 笔记本']) {
            dismissTo.mockClear();
            await draw('', { freeTags: [tag] });
            await act(async () => { (row()!.querySelector('[role=button]') as HTMLElement).click(); });
            expect(arrivesAs(dismissTo.mock.calls[0][0])).toBe(tag);
        }
    });

    it('no tags, or only ones it can\'t label: no row', async () => {
        await draw('');
        expect(row()).toBeNull();
        await draw('food.from-a-newer-library');
        expect(row()).toBeNull();
    });
});
