import { useEffect, useMemo, useState } from 'react';
import {
    buildCalendarMonth,
    calendarDayHeading,
    calendarTitle,
    copyFromLine,
    eventCopyOf,
    listPhotoUrl,
    STACK_LIST_SHARE,
    t,
    type CalendarOccurrence,
} from '@beanpool/core';
import type { MarketplacePost } from '../lib/api';
import { formatEventWhen } from '../lib/events';
import { MARKETPLACE_CATEGORIES_BY_ID } from '../lib/marketplace';
import type { StackPin } from '../lib/map-stack';
import { MapStackList } from './MapStackList';
import { MonthGrid, type CalendarEventPost } from './MonthGrid';

export interface MapCalendarProps {
    posts: readonly MarketplacePost[];
    covered?: boolean;
    onClose: () => void;
    onOpenPost?: (post: MarketplacePost) => void;
    onStartEvent?: () => void;
}

/** Convert a calendar occurrence to a StackPin row for MapStackList. */
function occurrenceToStackPin(
    occ: CalendarOccurrence<CalendarEventPost>,
    onOpen?: (post: MarketplacePost) => void,
): StackPin {
    const base = occ.baseEvent;
    const copy = eventCopyOf(base);
    const copyFrom = copy?.from ? copyFromLine(copy.from) : null;
    const typeLabel = copyFrom ? t('Event · {from}', { from: copyFrom }) : t('Event');
    return {
        key: `event:${base.id}:${occ.date}`,
        title: base.title,
        type: typeLabel,
        when: formatEventWhen(occ) || null,
        photo: base.photos?.[0] ? listPhotoUrl(base.photos[0]) : null,
        emoji: MARKETPLACE_CATEGORIES_BY_ID.get(base.category)?.emoji || '📌',
        eventStartMs: occ.eventStartAt ? Date.parse(occ.eventStartAt) : null,
        createdMs: Date.parse(base.createdAt ?? ''),
        open: () => onOpen?.(base),
    };
}

/**
 * MapCalendar — Event calendar on the web map (DESIGN-map-calendar-fable.md §1, §4, §8 S3).
 * Sits over the map's right third on wide screens (>= 768px), or as an overlay on narrow ones.
 * Hidden when `covered` (e.g. while another screen or modal is over it).
 * Reuses MapStackList for a selected day's events.
 */
export function MapCalendar({
    posts,
    covered = false,
    onClose,
    onOpenPost,
    onStartEvent,
}: MapCalendarProps) {
    const now = useMemo(() => new Date(), []);
    const [viewYear, setViewYear] = useState(() => now.getFullYear());
    const [viewMonth, setViewMonth] = useState(() => now.getMonth() + 1);

    // Active event posts only (ended and cancelled events never show)
    const eventPosts = useMemo(() => {
        return posts.filter((p) =>
            p.type === 'event' &&
            p.status !== 'cancelled' &&
            p.eventState !== 'cancelled' &&
            (!p.status || p.status === 'active'),
        );
    }, [posts]);

    // Calendar model for current month
    const month = useMemo(() => {
        return buildCalendarMonth<CalendarEventPost>({
            year: viewYear,
            month: viewMonth,
            now,
            events: eventPosts as CalendarEventPost[],
        });
    }, [viewYear, viewMonth, now, eventPosts]);

    // Selected date: opens with the first active date with events in this month, or null
    const [selectedDate, setSelectedDate] = useState<string | null>(() => month.firstActiveDate);
    const [selectedByTap, setSelectedByTap] = useState(false);

    useEffect(() => {
        if (!selectedByTap) {
            setSelectedDate(month.firstActiveDate);
        }
    }, [month.firstActiveDate, selectedByTap]);

    // Keyboard accessibility: Escape closes the calendar overlay
    useEffect(() => {
        if (covered) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                onClose();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [onClose, covered]);

    // Selected day's pins for MapStackList
    const selectedPins = useMemo<StackPin[]>(() => {
        if (!selectedDate) return [];
        const occurrences = month.eventsByDay[selectedDate] ?? [];
        return occurrences.map((occ) => occurrenceToStackPin(occ, onOpenPost));
    }, [selectedDate, month.eventsByDay, onOpenPost]);

    return (
        <aside
            data-testid="map-calendar"
            aria-label={calendarTitle()}
            className="absolute top-0 bottom-0 left-0 right-0 md:left-auto md:right-0 md:w-1/3 md:min-w-[320px] md:max-w-[480px] z-[120] flex flex-col bg-white dark:bg-nature-900 md:border-l md:border-nature-200 md:dark:border-nature-800 shadow-2xl overflow-hidden"
            style={covered ? { display: 'none' } : undefined}
        >
            {/* Header: Calendar title and close button */}
            <header className="flex items-center justify-between pl-4 pr-1 min-h-[52px] flex-shrink-0 border-b border-nature-200 dark:border-nature-800">
                <h1 className="text-base font-extrabold text-gray-900 dark:text-white m-0">
                    {calendarTitle()}
                </h1>
                <button
                    type="button"
                    onClick={onClose}
                    aria-label={t('Close')}
                    className="flex-shrink-0 min-h-[44px] min-w-[44px] bg-transparent border-none text-sm font-extrabold text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white flex items-center justify-center cursor-pointer"
                >
                    ✕
                </button>
            </header>

            {/* Scrollable grid area */}
            <div
                className="flex-1 overflow-y-auto overscroll-contain"
                style={{
                    paddingBottom: selectedDate
                        ? `calc((100% - var(--bottom-nav-offset, 0px)) * ${STACK_LIST_SHARE} + var(--bottom-nav-offset, 0px))`
                        : undefined,
                }}
            >
                <MonthGrid
                    month={month}
                    selectedDate={selectedDate}
                    onSelectDate={(date) => {
                        setSelectedDate(date);
                        setSelectedByTap(true);
                    }}
                    onPrevMonth={() => {
                        const p = month.prevMonth;
                        setViewYear(p.year);
                        setViewMonth(p.month);
                        setSelectedByTap(false);
                    }}
                    onNextMonth={() => {
                        const n = month.nextMonth;
                        setViewYear(n.year);
                        setViewMonth(n.month);
                        setSelectedByTap(false);
                    }}
                    onJumpToDate={(targetDate) => {
                        const y = +targetDate.slice(0, 4);
                        const m = +targetDate.slice(5, 7);
                        setViewYear(y);
                        setViewMonth(m);
                        setSelectedDate(targetDate);
                        setSelectedByTap(true);
                    }}
                    onStartEvent={onStartEvent}
                />
            </div>

            {/* The same list a stacked bubble opens, with day heading */}
            {selectedDate && (
                <MapStackList
                    key={selectedDate}
                    pins={selectedPins}
                    covered={covered}
                    takeFocus={selectedByTap}
                    heading={calendarDayHeading(selectedDate, selectedPins.length)}
                    onClose={() => {
                        setSelectedDate(null);
                        setSelectedByTap(true);
                    }}
                />
            )}
        </aside>
    );
}
