import {
    calendarDayHeading,
    calendarMonthEmptyText,
    calendarNextEventLabel,
    calendarNoEventsComingUpText,
    calendarStartOneText,
    formatDate,
    formatNumber,
    t,
    utcOf,
    type CalendarMonth,
} from '@beanpool/core';
import type { MarketplacePost } from '../lib/api';

export type CalendarEventPost = MarketplacePost & { [key: string]: unknown };

export interface MonthGridProps {
    month: CalendarMonth<CalendarEventPost>;
    selectedDate: string | null;
    onSelectDate: (date: string) => void;
    onPrevMonth: () => void;
    onNextMonth: () => void;
    onJumpToDate?: (date: string) => void;
    onStartEvent?: () => void;
}

/**
 * The calendar month grid on the web (DESIGN-map-calendar-fable.md §1, §4, §8 S3).
 * Shows the month heading with prev/next navigation, 7 weekday headers, and either:
 * - A grid of day cells with violet dots on event days, today ringed, past days greyed
 * - An empty month state under the weekday row when totalEvents is 0
 */
export function MonthGrid({
    month,
    selectedDate,
    onSelectDate,
    onPrevMonth,
    onNextMonth,
    onJumpToDate,
    onStartEvent,
}: MonthGridProps) {
    return (
        <section aria-label={month.heading} className="flex flex-col w-full">
            {/* Month navigation header: ‹ Month Year › */}
            <header className="flex items-center justify-between px-3 py-2 border-b border-nature-200 dark:border-nature-800">
                <button
                    type="button"
                    data-testid="month-prev-button"
                    aria-label={t('Previous month')}
                    disabled={month.isCurrentOrPastMonth}
                    onClick={onPrevMonth}
                    className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full text-lg font-bold text-gray-700 dark:text-gray-300 hover:bg-nature-100 dark:hover:bg-nature-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                    ‹
                </button>
                <h2 className="text-base font-extrabold text-gray-900 dark:text-white m-0">
                    {month.heading}
                </h2>
                <button
                    type="button"
                    data-testid="month-next-button"
                    aria-label={t('Next month')}
                    onClick={onNextMonth}
                    className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full text-lg font-bold text-gray-700 dark:text-gray-300 hover:bg-nature-100 dark:hover:bg-nature-800 transition-colors"
                >
                    ›
                </button>
            </header>

            {/* Weekday headers row */}
            <div role="row" className="grid grid-cols-7 gap-1 px-3 py-1.5 border-b border-nature-100 dark:border-nature-800 text-center">
                {month.weekdayHeaders.map((header, idx) => (
                    <span
                        key={idx}
                        role="columnheader"
                        className="text-xs font-bold text-gray-500 dark:text-gray-400 select-none py-1"
                    >
                        {header}
                    </span>
                ))}
            </div>

            {/* Under the weekday row: empty month state OR cell grid */}
            {month.totalEvents === 0 ? (
                <div data-testid="month-empty-state" className="flex flex-col items-center justify-center p-6 text-center">
                    <p className="text-sm font-semibold text-gray-700 dark:text-gray-300 m-0 mb-3">
                        {month.nextEventDate
                            ? calendarMonthEmptyText(month.year, month.month)
                            : calendarNoEventsComingUpText()}
                    </p>
                    {month.nextEventDate ? (
                        <button
                            type="button"
                            data-testid="calendar-next-event-link"
                            onClick={() => onJumpToDate?.(month.nextEventDate!)}
                            className="text-sm font-bold text-violet-700 dark:text-violet-300 hover:underline min-h-[44px] px-3 py-2 flex items-center"
                        >
                            {calendarNextEventLabel(month.nextEventDate)}
                        </button>
                    ) : onStartEvent ? (
                        <button
                            type="button"
                            data-testid="calendar-start-one-link"
                            onClick={onStartEvent}
                            className="text-sm font-bold text-violet-700 dark:text-violet-300 hover:underline min-h-[44px] px-3 py-2 flex items-center"
                        >
                            {calendarStartOneText()}
                        </button>
                    ) : null}
                </div>
            ) : (
                <div role="grid" aria-label={month.heading} className="flex flex-col gap-1 p-2">
                    {month.weeks.map((week, weekIdx) => (
                        <div key={weekIdx} role="row" className="grid grid-cols-7 gap-1">
                            {week.map((cell, cellIdx) => {
                                if (!cell.inMonth || !cell.date || cell.day === null) {
                                    return (
                                        <div
                                            key={cellIdx}
                                            role="gridcell"
                                            aria-hidden="true"
                                            className="min-h-[40px] flex items-center justify-center"
                                        />
                                    );
                                }

                                const isSelected = cell.date === selectedDate;
                                const label = cell.hasEvents
                                    ? calendarDayHeading(cell.date, cell.eventCount)
                                    : formatDate(new Date(utcOf(cell.date)), 'weekday-day-month', { utc: true });

                                return (
                                    <div key={cellIdx} role="gridcell" className="flex items-center justify-center">
                                        <button
                                            type="button"
                                            data-testid="month-day-cell"
                                            data-date={cell.date}
                                            aria-label={label}
                                            aria-selected={isSelected}
                                            aria-current={cell.isToday ? 'date' : undefined}
                                            disabled={cell.isPast}
                                            onClick={() => {
                                                if (!cell.isPast) onSelectDate(cell.date!);
                                            }}
                                            className={`w-full min-h-[40px] max-w-[44px] rounded-xl flex flex-col items-center justify-center relative p-1 transition-colors ${
                                                isSelected
                                                    ? 'bg-violet-700 text-white font-extrabold shadow-sm'
                                                    : cell.isToday
                                                        ? 'border-2 border-violet-600 dark:border-violet-400 font-extrabold text-violet-700 dark:text-violet-300'
                                                        : cell.isPast
                                                            ? 'text-gray-300 dark:text-nature-700 opacity-50 cursor-not-allowed'
                                                            : 'text-gray-900 dark:text-white font-semibold hover:bg-nature-100 dark:hover:bg-nature-800'
                                            }`}
                                        >
                                            <span className="text-sm leading-none">{formatNumber(cell.day)}</span>
                                            {cell.hasEvents && (
                                                <span
                                                    data-testid="event-dot"
                                                    className={`w-1.5 h-1.5 rounded-full mt-1 ${
                                                        isSelected ? 'bg-white' : 'bg-violet-600 dark:bg-violet-400'
                                                    }`}
                                                    aria-hidden="true"
                                                />
                                            )}
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    ))}
                </div>
            )}
        </section>
    );
}
