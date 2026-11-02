// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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
        ScrollView: ({ children, testID, contentContainerStyle }: any) => createElement('div', { 'data-testid': testID, 'data-pad-bottom': contentContainerStyle?.paddingBottom ?? 0 }, children),
        useWindowDimensions: () => ({ width: 320, height: 568 }),
        FlatList: ({ data, renderItem, keyExtractor }: any) => createElement('div', { 'data-testid': 'flat-list' },
            (data || []).map((item: any, idx: number) => {
                const key = keyExtractor ? keyExtractor(item, idx) : (item?.id ?? idx);
                return createElement('div', { key }, renderItem({ item, index: idx }));
            })
        ),
        AccessibilityInfo: { announceForAccessibility: vi.fn() },
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
        expect(backBtn.getAttribute('aria-label')).toBe('Map');
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
});
