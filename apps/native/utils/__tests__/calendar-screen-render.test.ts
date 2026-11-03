// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, forwardRef, useImperativeHandle } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { STACK_LIST_SHARE } from '@beanpool/core';
import { MONTH_NAV_HEIGHT, MONTH_WEEKDAY_HEIGHT } from '../../components/MonthGrid';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mockScrollTo = vi.fn();
// What the phone says about reduced motion: the screen asks for it and listens for a change.
const motion = vi.hoisted(() => ({ calm: false }));

const mockRouter = {
    back: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
    canGoBack: vi.fn(() => true),
};

vi.mock('expo-router', () => ({
    useRouter: () => mockRouter,
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

const eventListeners = vi.hoisted(() => ({
    listeners: {} as Record<string, ((...args: any[]) => void)[]>,
    emit(event: string, ...args: any[]) {
        (this.listeners[event] || []).forEach((fn) => fn(...args));
    },
    reset() {
        this.listeners = {};
    },
}));

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, accessible, testID, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress({ stopPropagation() {} });
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (accessible) attrs['data-accessible'] = 'true';
        if (testID) attrs['data-testid'] = testID;
        if (disabled) attrs['disabled'] = true;
        const s = flat(typeof props.style === 'function' ? props.style({ pressed: false }) : props.style);
        if (typeof s.minHeight === 'number') attrs['data-min-height'] = String(s.minHeight);
        if (typeof s.minWidth === 'number') attrs['data-min-width'] = String(s.minWidth);
        return createElement(tag, attrs, children);
    };
    return {
        View: el('div'),
        Text: el('span'),
        Pressable: el('button'),
        ScrollView: forwardRef(({ children, testID, contentContainerStyle }: any, ref: any) => {
            useImperativeHandle(ref, () => ({ scrollTo: mockScrollTo }));
            return createElement('div', { 'data-testid': testID, 'data-pad-bottom': contentContainerStyle?.paddingBottom ?? 0 }, children);
        }),
        useWindowDimensions: () => ({ width: 320, height: 568 }),
        FlatList: ({ data, renderItem, keyExtractor }: any) => createElement('div', { 'data-testid': 'flat-list' },
            (data || []).map((item: any, idx: number) => {
                const key = keyExtractor ? keyExtractor(item, idx) : (item?.id ?? idx);
                return createElement('div', { key }, renderItem({ item, index: idx }));
            })
        ),
        AccessibilityInfo: {
            announceForAccessibility: vi.fn(),
            isReduceMotionEnabled: vi.fn(async () => motion.calm),
            addEventListener: vi.fn(() => ({ remove() {} })),
        },
        StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => flat(s), hairlineWidth: 1 },
        DeviceEventEmitter: {
            addListener: (event: string, fn: (...args: any[]) => void) => {
                (eventListeners.listeners[event] = eventListeners.listeners[event] || []).push(fn);
                return {
                    remove: () => {
                        eventListeners.listeners[event] = (eventListeners.listeners[event] || []).filter((l) => l !== fn);
                    },
                };
            },
            emit: (event: string, ...args: any[]) => eventListeners.emit(event, ...args),
        },
    };
});

vi.mock('expo-modules-core', () => ({
    requireNativeModule: vi.fn(() => ({})),
    requireOptionalNativeModule: vi.fn(() => null),
    EventEmitter: vi.fn(() => ({ addListener: vi.fn(), removeListener: vi.fn() })),
    NativeModulesProxy: {},
    ProxyNativeModule: {},
}));

vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: any) => make({ theme: 'light', colors: lightColors }),
    };
});

const fakeDb = vi.hoisted(() => ({
    events: [] as any[],
}));

vi.mock('../db', () => ({
    getPosts: vi.fn(async () => fakeDb.events),
}));

vi.mock('../../components/MarketCardPicture', () => ({
    MarketCardPicture: () => createElement('div', { 'data-testid': 'mock-picture' }),
}));

import CalendarScreen from '../../app/calendar';

describe('CalendarScreen route component', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        vi.clearAllMocks();
        motion.calm = false;
        fakeDb.events = [];
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    it('navigates back to map on back button tap', async () => {
        await act(async () => {
            root.render(createElement(CalendarScreen) as any);
        });

        const backBtn = container.querySelector('[data-testid="calendar-back"]') as HTMLButtonElement;
        expect(backBtn).toBeTruthy();
        // It says Back, not Map: a member may have come from Home or the Market, where Back returns them.
        expect(backBtn.getAttribute('aria-label')).toBe('Back');
        expect(backBtn.textContent).toContain('Back');
        act(() => backBtn.click());
        expect(mockRouter.back).toHaveBeenCalledTimes(1);
    });

    it('auto-selects first active date, opens MapStackList with heading, and swaps on date selection', async () => {
        // Today is relative to local clock when running; let's use dates relative to now
        const now = new Date();
        const y = now.getFullYear();
        const m = now.getMonth() + 1;
        const d1 = now.getDate() + 1 <= 28 ? now.getDate() + 1 : now.getDate();
        const d2 = d1 + 2 <= 28 ? d1 + 2 : d1;
        const pad = (n: number) => String(n).padStart(2, '0');
        const date1 = `${y}-${pad(m)}-${pad(d1)}`;
        const date2 = `${y}-${pad(m)}-${pad(d2)}`;

        fakeDb.events = [
            {
                id: 'ev-1',
                type: 'event',
                title: 'Community Garden Bee',
                status: 'active',
                active: 1,
                event_start_local: `${date1}T09:00`,
                event_end_local: `${date1}T12:00`,
                event_start_at: `${date1}T09:00:00.000Z`,
                event_end_at: `${date1}T12:00:00.000Z`,
            },
            {
                id: 'ev-2',
                type: 'event',
                title: 'Repair Café',
                status: 'active',
                active: 1,
                event_start_local: `${date1}T14:00`,
                event_end_local: `${date1}T16:00`,
                event_start_at: `${date1}T14:00:00.000Z`,
                event_end_at: `${date1}T16:00:00.000Z`,
            },
            {
                id: 'ev-3',
                type: 'event',
                title: 'Seed Swap',
                status: 'active',
                active: 1,
                event_start_local: `${date2}T10:00`,
                event_end_local: `${date2}T11:30`,
                event_start_at: `${date2}T10:00:00.000Z`,
                event_end_at: `${date2}T11:30:00.000Z`,
            },
        ];

        await act(async () => {
            root.render(createElement(CalendarScreen) as any);
        });

        // MapStackList should be open for date1
        const stackPanel = container.querySelector('[data-testid="map-stack-list"]');
        expect(stackPanel).toBeTruthy();
        expect(stackPanel?.textContent).toContain('2 events');
        expect(stackPanel?.textContent).toContain('Community Garden Bee');
        expect(stackPanel?.textContent).toContain('Repair Café');

        // Swap to date2 by tapping day cell
        if (date1 !== date2) {
            const day2Btn = container.querySelector(`[data-testid="month-day-${date2}"]`) as HTMLButtonElement;
            expect(day2Btn).toBeTruthy();
            act(() => day2Btn.click());

            const swappedPanel = container.querySelector('[data-testid="map-stack-list"]');
            expect(swappedPanel?.textContent).toContain('1 event');
            expect(swappedPanel?.textContent).toContain('Seed Swap');
        }

        // Tap ✕ on MapStackList closes the panel
        const activePanel = container.querySelector('[data-testid="map-stack-list"]');
        const closeBtn = activePanel?.querySelector('[aria-label="Close"]') as HTMLButtonElement;
        expect(closeBtn).toBeTruthy();
        // The month leaves room for the day's list, so its last week can be reached, and takes it back when the list goes.
        const monthScroll = () => container.querySelector('[data-testid="calendar-month-scroll"]')!;
        expect(monthScroll().getAttribute('data-pad-bottom')).toBe(String(Math.ceil(568 / 3)));
        act(() => closeBtn.click());
        expect(monthScroll().getAttribute('data-pad-bottom')).toBe('0');

        // Now MapStackList is closed
        expect(container.querySelector('[data-testid="map-stack-list"]')).toBeNull();
    });

    it('Start one › opens new-listing with newPost=event', async () => {
        fakeDb.events = [];

        await act(async () => {
            root.render(createElement(CalendarScreen) as any);
        });

        const startBtn = container.querySelector('[data-testid="month-start-event"]') as HTMLButtonElement;
        expect(startBtn).toBeTruthy();
        act(() => startBtn.click());
        expect(mockRouter.push).toHaveBeenCalledWith({
            pathname: '/new-listing',
            params: { newPost: 'event' },
        });
    });

    it('preserves active user date selection across background sync updates', async () => {
        const now = new Date();
        const y = now.getFullYear();
        const m = now.getMonth() + 1;
        const d1 = now.getDate() + 1 <= 28 ? now.getDate() + 1 : now.getDate();
        const d2 = d1 + 2 <= 28 ? d1 + 2 : d1;
        const pad = (n: number) => String(n).padStart(2, '0');
        const date1 = `${y}-${pad(m)}-${pad(d1)}`;
        const date2 = `${y}-${pad(m)}-${pad(d2)}`;

        fakeDb.events = [
            {
                id: 'ev-2',
                type: 'event',
                title: 'Later Event',
                status: 'active',
                active: 1,
                event_start_local: `${date2}T14:00`,
                event_end_local: `${date2}T16:00`,
                event_start_at: `${date2}T14:00:00.000Z`,
                event_end_at: `${date2}T16:00:00.000Z`,
            },
        ];

        await act(async () => {
            root.render(createElement(CalendarScreen) as any);
        });

        // Initially date2 is active
        const stackPanel = container.querySelector('[data-testid="map-stack-list"]');
        expect(stackPanel).toBeTruthy();
        expect(stackPanel?.textContent).toContain('Later Event');

        // Background sync introduces an earlier event (date1)
        fakeDb.events = [
            {
                id: 'ev-1',
                type: 'event',
                title: 'Earlier New Event',
                status: 'active',
                active: 1,
                event_start_local: `${date1}T09:00`,
                event_end_local: `${date1}T11:00`,
                event_start_at: `${date1}T09:00:00.000Z`,
                event_end_at: `${date1}T11:00:00.000Z`,
            },
            ...fakeDb.events,
        ];

        await act(async () => {
            eventListeners.emit('sync_data_updated');
        });

        // The user's active selection (date2) should still be selected, NOT overwritten by date1
        const updatedPanel = container.querySelector('[data-testid="map-stack-list"]');
        expect(updatedPanel?.textContent).toContain('Later Event');
        expect(updatedPanel?.textContent).not.toContain('Earlier New Event');
    });

    it('clears selected date immediately upon month navigation', async () => {
        const now = new Date();
        const y = now.getFullYear();
        const m = now.getMonth() + 1;
        const d1 = now.getDate() + 1 <= 28 ? now.getDate() + 1 : now.getDate();
        const pad = (n: number) => String(n).padStart(2, '0');
        const date1 = `${y}-${pad(m)}-${pad(d1)}`;

        fakeDb.events = [
            {
                id: 'ev-1',
                type: 'event',
                title: 'Current Month Event',
                status: 'active',
                active: 1,
                event_start_local: `${date1}T09:00`,
                event_end_local: `${date1}T11:00`,
                event_start_at: `${date1}T09:00:00.000Z`,
                event_end_at: `${date1}T11:00:00.000Z`,
            },
        ];

        await act(async () => {
            root.render(createElement(CalendarScreen) as any);
        });

        expect(container.querySelector('[data-testid="map-stack-list"]')).toBeTruthy();

        // Navigate to next month
        const nextBtn = container.querySelector('[data-testid="month-next"]') as HTMLButtonElement;
        expect(nextBtn).toBeTruthy();
        act(() => nextBtn.click());

        // Panel should be closed immediately during transition
        expect(container.querySelector('[data-testid="map-stack-list"]')).toBeNull();
    });

    // The y the screen scrolls to for a day: counted from the heights the component renders (the header's, the week
    // cell's) and the grid's own exported measures, not from numbers restated here.
    function expectedClearY(date: string): number {
        const [y, m, d] = date.split('-').map(Number);
        const header = Number((container.querySelector('[data-testid="calendar-back"]')!.parentElement as HTMLElement).getAttribute('data-min-height'));
        const weekHeight = Number((container.querySelector(`[data-testid="month-day-${date}"]`) as HTMLElement).getAttribute('data-min-height'));
        const firstWeekday = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
        const weekIndex = Math.floor((firstWeekday + d - 1) / 7);
        const dayBottom = MONTH_NAV_HEIGHT + MONTH_WEEKDAY_HEIGHT + (weekIndex + 1) * weekHeight;
        const visible = 568 - Math.ceil(568 * STACK_LIST_SHARE) - header - 44; // insets.top is 44
        return dayBottom + 24 - visible;
    }

    const lateEvent = (date: string) => ({
        id: `ev-${date}`,
        type: 'event',
        title: 'A late event',
        status: 'active',
        active: 1,
        event_start_local: `${date}T10:00`,
        event_end_local: `${date}T12:00`,
        event_start_at: `${date}T10:00:00.000Z`,
        event_end_at: `${date}T12:00:00.000Z`,
    });

    // The scroll waits one animation frame, after the effect that asks for it: advance the clock once the change has rendered.
    async function settle() {
        await act(async () => { vi.advanceTimersByTime(50); });
    }

    // Nov 2026 starts on a Sunday, so the 30th is in week 6; today is the 3rd.
    function pinToday() {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-11-03T10:00:00'));
    }

    it('scrolls a tapped last-week day clear of the list', async () => {
        pinToday();
        fakeDb.events = [lateEvent('2026-11-05')];

        await act(async () => { root.render(createElement(CalendarScreen) as any); });
        mockScrollTo.mockClear();

        const dayBtn = container.querySelector('[data-testid="month-day-2026-11-30"]') as HTMLButtonElement;
        expect(dayBtn).toBeTruthy();
        expect(Number(dayBtn.getAttribute('data-min-height'))).toBe(44); // the real week row is 44, not 48
        await act(async () => { dayBtn.click(); });
        await settle();

        const y = expectedClearY('2026-11-30');
        expect(y).toBeGreaterThan(0);
        expect(mockScrollTo).toHaveBeenCalledWith({ y, animated: true });
        vi.useRealTimers();
    });

    it('scrolls the next event\'s day clear when the screen opens on it, with no tap', async () => {
        pinToday();
        fakeDb.events = [lateEvent('2026-11-30')];

        await act(async () => { root.render(createElement(CalendarScreen) as any); });
        await settle();

        expect(container.querySelector('[data-testid="map-stack-list"]')).toBeTruthy();
        expect(mockScrollTo).toHaveBeenCalledWith({ y: expectedClearY('2026-11-30'), animated: true });
        vi.useRealTimers();
    });

    it('scrolls the auto-selected day clear after ‹ ›', async () => {
        pinToday();
        // December 2026 starts on a Tuesday: the 31st is in week 5.
        fakeDb.events = [lateEvent('2026-11-05'), lateEvent('2026-12-31')];

        await act(async () => { root.render(createElement(CalendarScreen) as any); });
        mockScrollTo.mockClear();

        const nextBtn = container.querySelector('[data-testid="month-next"]') as HTMLButtonElement;
        await act(async () => { nextBtn.click(); });
        await settle();

        expect(mockScrollTo).toHaveBeenCalledWith({ y: expectedClearY('2026-12-31'), animated: true });
        vi.useRealTimers();
    });

    it('scrolls clear when jumping to a cross-month date in a late week', async () => {
        pinToday();
        fakeDb.events = [lateEvent('2027-01-29')];

        await act(async () => { root.render(createElement(CalendarScreen) as any); });
        mockScrollTo.mockClear();

        const jumpBtn = container.querySelector('[data-testid="month-jump-next"]') as HTMLButtonElement;
        expect(jumpBtn).toBeTruthy();
        await act(async () => { jumpBtn.click(); });
        await settle();

        expect(mockScrollTo).toHaveBeenCalledWith({ y: expectedClearY('2027-01-29'), animated: true });
        vi.useRealTimers();
    });

    it('jumps, with no glide, when the phone asks for reduced motion', async () => {
        pinToday();
        motion.calm = true;
        fakeDb.events = [lateEvent('2026-11-30')];

        await act(async () => { root.render(createElement(CalendarScreen) as any); });
        mockScrollTo.mockClear();

        const dayBtn = container.querySelector('[data-testid="month-day-2026-11-30"]') as HTMLButtonElement;
        // Tapped again after the screen has heard the setting: scrolls, animated: false.
        await act(async () => { dayBtn.click(); });
        await settle();
        const other = container.querySelector('[data-testid="month-day-2026-11-29"]') as HTMLButtonElement;
        await act(async () => { other.click(); });
        await settle();

        const calls = mockScrollTo.mock.calls.map(c => c[0]);
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.every(c => c.animated === false)).toBe(true);
        vi.useRealTimers();
    });

    it('glides when the phone does not ask for reduced motion', async () => {
        pinToday();
        motion.calm = false;
        fakeDb.events = [lateEvent('2026-11-30')];

        await act(async () => { root.render(createElement(CalendarScreen) as any); });
        await settle();

        const calls = mockScrollTo.mock.calls.map(c => c[0]);
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.every(c => c.animated === true)).toBe(true);
        vi.useRealTimers();
    });
});
