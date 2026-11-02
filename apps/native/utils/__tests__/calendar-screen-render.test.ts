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
        FlatList: ({ data, renderItem }: any) => createElement('div', { 'data-testid': 'flat-list' },
            (data || []).map((item: any, idx: number) => renderItem({ item, index: idx }))
        ),
        AccessibilityInfo: { announceForAccessibility: vi.fn() },
        StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => flat(s), hairlineWidth: 1 },
        DeviceEventEmitter: { addListener: () => ({ remove: () => {} }) },
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
            root.render(createElement(CalendarScreen));
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
            root.render(createElement(CalendarScreen));
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

            expect(stackPanel?.textContent).toContain('1 event');
            expect(stackPanel?.textContent).toContain('Seed Swap');
        }

        // Tap ✕ on MapStackList closes the panel
        const closeBtn = stackPanel?.querySelector('[aria-label="Close"]') as HTMLButtonElement;
        expect(closeBtn).toBeTruthy();
        act(() => closeBtn.click());

        // Now MapStackList is closed
        expect(container.querySelector('[data-testid="map-stack-list"]')).toBeNull();
    });

    it('Start one › opens new-listing with newPost=event', async () => {
        fakeDb.events = [];

        await act(async () => {
            root.render(createElement(CalendarScreen));
        });

        const startBtn = container.querySelector('[data-testid="month-start-event"]') as HTMLButtonElement;
        expect(startBtn).toBeTruthy();
        act(() => startBtn.click());
        expect(mockRouter.push).toHaveBeenCalledWith({
            pathname: '/new-listing',
            params: { newPost: 'event' },
        });
    });
});
