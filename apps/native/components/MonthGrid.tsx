import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
    calendarDayHeading,
    calendarMonthEmptyText,
    calendarNextEventLabel,
    calendarNoEventsComingUpText,
    calendarStartOneText,
    formatNumber,
    t,
    type CalendarMonth,
} from '@beanpool/core';
import { useStyles } from '../app/ThemeContext';

export interface MonthGridProps {
    month: CalendarMonth;
    selectedDate: string | null;
    onSelectDate: (date: string) => void;
    onPrevMonth: () => void;
    onNextMonth: () => void;
    onJumpToDate?: (date: string) => void;
    onStartEvent?: () => void;
}

export function MonthGrid({
    month,
    selectedDate,
    onSelectDate,
    onPrevMonth,
    onNextMonth,
    onJumpToDate,
    onStartEvent,
}: MonthGridProps) {
    const styles = useStyles(({ colors }) => StyleSheet.create({
        container: {
            width: '100%',
        },
        navHeader: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 8,
            minHeight: 48,
        },
        navBtn: {
            width: 44,
            height: 44,
            alignItems: 'center',
            justifyContent: 'center',
        },
        navArrow: {
            fontSize: 24,
            fontWeight: '600',
            color: colors.text.heading,
        },
        navArrowDisabled: {
            color: colors.text.muted,
            opacity: 0.35,
        },
        monthHeading: {
            flex: 1,
            textAlign: 'center',
            fontSize: 17,
            fontWeight: '700',
            color: colors.text.heading,
        },
        weekdayRow: {
            flexDirection: 'row',
            paddingHorizontal: 4,
            minHeight: 28,
            alignItems: 'center',
        },
        weekdayLabel: {
            flex: 1,
            textAlign: 'center',
            fontSize: 13,
            fontWeight: '600',
            color: colors.text.secondary,
        },
        weeksContainer: {
            paddingHorizontal: 4,
        },
        weekRow: {
            flexDirection: 'row',
        },
        dayCellEmpty: {
            flex: 1,
            minWidth: 44,
            minHeight: 44,
        },
        dayCell: {
            flex: 1,
            minWidth: 44,
            minHeight: 44,
            alignItems: 'center',
            justifyContent: 'center',
            paddingVertical: 2,
        },
        dayNumberBox: {
            width: 32,
            height: 32,
            borderRadius: 16,
            alignItems: 'center',
            justifyContent: 'center',
        },
        todayRing: {
            borderWidth: 1.5,
            borderColor: colors.text.heading,
        },
        selectedDay: {
            backgroundColor: colors.surface.subtle,
        },
        dayNumber: {
            fontSize: 15,
            fontWeight: '500',
            color: colors.text.heading,
        },
        dayPast: {
            color: colors.text.muted,
            opacity: 0.4,
        },
        dayHighlighted: {
            fontWeight: '700',
            color: colors.text.heading,
        },
        eventDot: {
            width: 5,
            height: 5,
            borderRadius: 2.5,
            backgroundColor: colors.event.ink,
            marginTop: 2,
        },
        eventDotPlaceholder: {
            width: 5,
            height: 5,
            marginTop: 2,
        },
        emptyContainer: {
            paddingHorizontal: 20,
            paddingVertical: 32,
            alignItems: 'center',
            justifyContent: 'center',
            gap: 16,
        },
        emptyHeading: {
            fontSize: 16,
            fontWeight: '600',
            color: colors.text.heading,
            textAlign: 'center',
        },
        noEventsCol: {
            alignItems: 'center',
            gap: 12,
        },
        noEventsText: {
            fontSize: 15,
            color: colors.text.secondary,
            textAlign: 'center',
        },
        emptyAction: {
            minHeight: 44,
            minWidth: 44,
            paddingHorizontal: 16,
            paddingVertical: 10,
            borderRadius: 22,
            backgroundColor: colors.surface.subtle,
            alignItems: 'center',
            justifyContent: 'center',
        },
        emptyActionPressed: {
            opacity: 0.8,
        },
        emptyActionText: {
            fontSize: 15,
            fontWeight: '700',
            color: colors.event.ink,
        },
    }));

    return (
        <View style={styles.container} testID="month-grid">
            <View style={styles.navHeader}>
                <Pressable
                    testID="month-prev"
                    accessibilityRole="button"
                    accessibilityLabel={t('Back')}
                    disabled={month.isCurrentOrPastMonth}
                    onPress={onPrevMonth}
                    style={styles.navBtn}
                >
                    <Text style={[styles.navArrow, month.isCurrentOrPastMonth && styles.navArrowDisabled]}>‹</Text>
                </Pressable>
                <Text style={styles.monthHeading} accessibilityRole="header" testID="month-heading">
                    {month.heading}
                </Text>
                <Pressable
                    testID="month-next"
                    accessibilityRole="button"
                    accessibilityLabel={t('Next')}
                    onPress={onNextMonth}
                    style={styles.navBtn}
                >
                    <Text style={styles.navArrow}>›</Text>
                </Pressable>
            </View>

            <View style={styles.weekdayRow} accessibilityRole="header">
                {month.weekdayHeaders.map((header, idx) => (
                    <Text key={`weekday-${idx}`} style={styles.weekdayLabel} numberOfLines={1}>
                        {header}
                    </Text>
                ))}
            </View>

            {month.totalEvents === 0 ? (
                <View style={styles.emptyContainer} testID="month-empty">
                    <Text style={styles.emptyHeading}>{calendarMonthEmptyText(month.year, month.month)}</Text>
                    {month.nextEventDate ? (
                        <Pressable
                            testID="month-jump-next"
                            accessibilityRole="button"
                            accessibilityLabel={calendarNextEventLabel(month.nextEventDate)}
                            style={({ pressed }) => [styles.emptyAction, pressed && styles.emptyActionPressed]}
                            onPress={() => onJumpToDate?.(month.nextEventDate!)}
                        >
                            <Text style={styles.emptyActionText}>{calendarNextEventLabel(month.nextEventDate)}</Text>
                        </Pressable>
                    ) : (
                        <View style={styles.noEventsCol}>
                            <Text style={styles.noEventsText}>{calendarNoEventsComingUpText()}</Text>
                            <Pressable
                                testID="month-start-event"
                                accessibilityRole="button"
                                accessibilityLabel={calendarStartOneText()}
                                style={({ pressed }) => [styles.emptyAction, pressed && styles.emptyActionPressed]}
                                onPress={() => onStartEvent?.()}
                            >
                                <Text style={styles.emptyActionText}>{calendarStartOneText()}</Text>
                            </Pressable>
                        </View>
                    )}
                </View>
            ) : (
                <View style={styles.weeksContainer} testID="month-weeks">
                    {month.weeks.map((week, wIdx) => (
                        <View key={`week-${wIdx}`} style={styles.weekRow}>
                            {week.map((cell, cIdx) => {
                                if (!cell.inMonth || !cell.date) {
                                    return <View key={`pad-${wIdx}-${cIdx}`} style={styles.dayCellEmpty} />;
                                }
                                const isSelected = cell.date === selectedDate;
                                const a11yLabel = calendarDayHeading(cell.date, cell.eventCount);

                                return (
                                    <Pressable
                                        key={cell.date}
                                        testID={`month-day-${cell.date}`}
                                        accessibilityRole="button"
                                        accessibilityLabel={a11yLabel}
                                        accessibilityState={{ selected: isSelected, disabled: cell.isPast }}
                                        disabled={cell.isPast}
                                        onPress={() => onSelectDate(cell.date!)}
                                        style={styles.dayCell}
                                    >
                                        <View style={[
                                            styles.dayNumberBox,
                                            cell.isToday && styles.todayRing,
                                            isSelected && styles.selectedDay,
                                        ]}>
                                            <Text style={[
                                                styles.dayNumber,
                                                cell.isPast && styles.dayPast,
                                                (cell.isToday || isSelected) && styles.dayHighlighted,
                                            ]}>
                                                {formatNumber(cell.day!)}
                                            </Text>
                                        </View>
                                        {cell.hasEvents ? (
                                            <View style={styles.eventDot} testID={`month-dot-${cell.date}`} />
                                        ) : (
                                            <View style={styles.eventDotPlaceholder} />
                                        )}
                                    </Pressable>
                                );
                            })}
                        </View>
                    ))}
                </View>
            )}
        </View>
    );
}
