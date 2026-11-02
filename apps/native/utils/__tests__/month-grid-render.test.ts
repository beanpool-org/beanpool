// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { buildCalendarMonth } from '@beanpool/core';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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
        FlatList: ({ data, renderItem, ListHeaderComponent }: any) => createElement('div', { 'data-testid': 'flat-list' },
            ListHeaderComponent ? createElement(ListHeaderComponent) : null,
            (data || []).map((item: any, idx: number) => renderItem({ item, index: idx }))
        ),
        AccessibilityInfo: { announceForAccessibility: vi.fn() },
        StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => flat(s), hairlineWidth: 1 },
        DeviceEventEmitter: { addListener: () => ({ remove: () => {} }) },
    };
});

vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: any) => make({ theme: 'light', colors: lightColors }),
    };
});

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

import { MonthGrid } from '../../components/MonthGrid';

describe('MonthGrid component', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    it('renders month heading, weekday headers, and day cells with event dots', async () => {
        const events = [
            { id: 'ev1', eventStartLocal: '2026-11-07T09:00', eventEndLocal: '2026-11-07T12:00' },
            { id: 'ev2', eventStartLocal: '2026-11-14T14:00', eventEndLocal: '2026-11-14T16:00' },
        ];
        const month = buildCalendarMonth({
            year: 2026,
            month: 11,
            now: '2026-11-03',
            events,
        });

        const onSelectDate = vi.fn();
        const onPrevMonth = vi.fn();
        const onNextMonth = vi.fn();

        await act(async () => {
            root.render(
                createElement(MonthGrid, {
                    month,
                    selectedDate: '2026-11-07',
                    onSelectDate,
                    onPrevMonth,
                    onNextMonth,
                }) as any
            );
        });

        const heading = container.querySelector('[data-testid="month-heading"]');
        expect(heading?.textContent).toBe('November 2026');

        // Check weekday headers (7 columns)
        const weekdayRow = container.querySelector('[role="heading"]:not([data-testid="month-heading"])');
        expect(weekdayRow).toBeTruthy();

        // ‹ button is disabled on current month
        const prevBtn = container.querySelector('[data-testid="month-prev"]') as HTMLButtonElement;
        expect(prevBtn.disabled).toBe(true);

        // › button is enabled
        const nextBtn = container.querySelector('[data-testid="month-next"]') as HTMLButtonElement;
        expect(nextBtn.disabled).toBe(false);
        act(() => nextBtn.click());
        expect(onNextMonth).toHaveBeenCalledTimes(1);

        // Day 7 has an event dot
        const dot7 = container.querySelector('[data-testid="month-dot-2026-11-07"]');
        expect(dot7).toBeTruthy();

        // Day 14 has an event dot
        const dot14 = container.querySelector('[data-testid="month-dot-2026-11-14"]');
        expect(dot14).toBeTruthy();

        // Day 10 has NO event dot
        const dot10 = container.querySelector('[data-testid="month-dot-2026-11-10"]');
        expect(dot10).toBeNull();

        // Tap day 14 calls onSelectDate('2026-11-14')
        const day14Btn = container.querySelector('[data-testid="month-day-2026-11-14"]') as HTMLButtonElement;
        expect(day14Btn.getAttribute('data-min-height')).toBe('44');
        expect(day14Btn.getAttribute('data-min-width')).toBe('44');
        act(() => day14Btn.click());
        expect(onSelectDate).toHaveBeenCalledWith('2026-11-14');

        // Past days (e.g. 2026-11-01) are disabled
        const day1Btn = container.querySelector('[data-testid="month-day-2026-11-01"]') as HTMLButtonElement;
        expect(day1Btn.disabled).toBe(true);
    });

    it('renders empty month with next upcoming event jump link', async () => {
        const events = [
            // Next event in December
            { id: 'ev-dec', eventStartLocal: '2026-12-06T10:00', eventEndLocal: '2026-12-06T12:00' },
        ];
        const month = buildCalendarMonth({
            year: 2026,
            month: 11,
            now: '2026-11-03',
            events,
        });

        const onJumpToDate = vi.fn();

        await act(async () => {
            root.render(
                createElement(MonthGrid, {
                    month,
                    selectedDate: null,
                    onSelectDate: vi.fn(),
                    onPrevMonth: vi.fn(),
                    onNextMonth: vi.fn(),
                    onJumpToDate,
                }) as any
            );
        });

        const emptyBox = container.querySelector('[data-testid="month-empty"]');
        expect(emptyBox).toBeTruthy();
        expect(emptyBox?.textContent).toContain('Nothing on in November.');
        expect(emptyBox?.textContent).toContain('Next: Sun 6 Dec ›');

        const jumpBtn = container.querySelector('[data-testid="month-jump-next"]') as HTMLButtonElement;
        expect(jumpBtn).toBeTruthy();
        expect(jumpBtn.getAttribute('data-min-height')).toBe('44');
        act(() => jumpBtn.click());
        expect(onJumpToDate).toHaveBeenCalledWith('2026-12-06');
    });

    it('renders empty month with Start one › link when no events at all', async () => {
        const month = buildCalendarMonth({
            year: 2026,
            month: 11,
            now: '2026-11-03',
            events: [],
        });

        const onStartEvent = vi.fn();

        await act(async () => {
            root.render(
                createElement(MonthGrid, {
                    month,
                    selectedDate: null,
                    onSelectDate: vi.fn(),
                    onPrevMonth: vi.fn(),
                    onNextMonth: vi.fn(),
                    onStartEvent,
                }) as any
            );
        });

        const emptyBox = container.querySelector('[data-testid="month-empty"]');
        expect(emptyBox).toBeTruthy();
        expect(emptyBox?.textContent).toContain('Nothing on in November.');
        expect(emptyBox?.textContent).toContain('No events coming up yet.');
        expect(emptyBox?.textContent).toContain('Start one ›');

        const startBtn = container.querySelector('[data-testid="month-start-event"]') as HTMLButtonElement;
        expect(startBtn).toBeTruthy();
        expect(startBtn.getAttribute('data-min-height')).toBe('44');
        act(() => startBtn.click());
        expect(onStartEvent).toHaveBeenCalledTimes(1);
    });
});
