import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, DeviceEventEmitter, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
    buildCalendarMonth,
    calendarDayHeading,
    calendarTitle,
    formatLocalDate,
    parseLocalDate,
    STACK_LIST_SHARE,
    t,
} from '@beanpool/core';
import { useStyles } from './ThemeContext';
import { MONTH_NAV_HEIGHT, MONTH_WEEKDAY_HEIGHT, MONTH_WEEK_HEIGHT, MonthGrid } from '../components/MonthGrid';
import { MapStackList } from '../components/MapStackList';
import { getPosts } from '../utils/db';
import { eventStateOf } from '../utils/events';

/** The screen's own header row (dp): the month sits under it. */
const HEADER_MIN_HEIGHT = 52;

export default function CalendarScreen() {
    const { height: screenHeight } = useWindowDimensions();
    const router = useRouter();
    const insets = useSafeAreaInsets();

    const getToday = () => {
        const d = new Date();
        return formatLocalDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
    };

    const todayStr = useMemo(getToday, []);
    const initialParsed = useMemo(() => parseLocalDate(todayStr)!, [todayStr]);

    const [year, setYear] = useState(initialParsed.year);
    const [month, setMonth] = useState(initialParsed.month);
    const [selectedDate, setSelectedDate] = useState<string | null>(null);
    const [dismissedMonthKey, setDismissedMonthKey] = useState<string | null>(null);
    const [events, setEvents] = useState<any[]>([]);
    const scrollRef = useRef<ScrollView>(null);
    const reduceMotionRef = useRef(false);

    useEffect(() => {
        void AccessibilityInfo.isReduceMotionEnabled?.()
            ?.then(calm => { reduceMotionRef.current = calm; })
            ?.catch?.(() => {});
        const sub = AccessibilityInfo.addEventListener?.('reduceMotionChanged', calm => {
            reduceMotionRef.current = calm;
        });
        return () => sub?.remove?.();
    }, []);

    const styles = useStyles(({ colors }) => StyleSheet.create({
        container: {
            flex: 1,
            backgroundColor: colors.surface.page,
        },
        header: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 8,
            minHeight: HEADER_MIN_HEIGHT,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: colors.border.default,
            backgroundColor: colors.surface.chrome,
        },
        backButton: {
            flexDirection: 'row',
            alignItems: 'center',
            minWidth: 44,
            minHeight: 44,
            paddingHorizontal: 8,
            gap: 4,
        },
        backButtonArrow: {
            fontSize: 22,
            fontWeight: '600',
            color: colors.brand.primary,
            marginTop: -2,
        },
        backButtonText: {
            fontSize: 16,
            fontWeight: '600',
            color: colors.brand.primary,
        },
        title: {
            flex: 1,
            textAlign: 'center',
            fontSize: 18,
            fontWeight: '800',
            color: colors.text.heading,
            marginRight: 44, // Balance back button width to center title
        },
        content: {
            flex: 1,
        },
    }));

    const loadEvents = useCallback(async () => {
        try {
            const raw = await getPosts({ type: 'event' });
            const active = (raw || []).filter((p: any) => {
                if ((p.type || '').toLowerCase() !== 'event') return false;
                if (p.status === 'cancelled' || eventStateOf(p) === 'cancelled') return false;
                if (p.status !== 'active' && p.status !== 'pending' && p.status !== 'completed') return false;
                if (p.active === 0 || p.active === false) return false;
                return true;
            });
            setEvents(active);
        } catch (e) {
            console.error('Failed to load calendar events', e);
        }
    }, []);

    useEffect(() => {
        loadEvents();
        const sub = DeviceEventEmitter.addListener('sync_data_updated', loadEvents);
        return () => sub.remove();
    }, [loadEvents]);

    const monthModel = useMemo(() => {
        return buildCalendarMonth({
            year,
            month,
            now: todayStr,
            events,
        });
    }, [year, month, todayStr, events]);

    // When viewed month changes, auto-select first active date unless dismissed or user already selected a date in this month
    useEffect(() => {
        if (dismissedMonthKey === monthModel.monthKey) return;
        if (selectedDate && selectedDate.startsWith(monthModel.monthKey)) return;
        if (monthModel.firstActiveDate) {
            setSelectedDate(monthModel.firstActiveDate);
        } else {
            setSelectedDate(null);
        }
    }, [monthModel.monthKey, monthModel.firstActiveDate, dismissedMonthKey, selectedDate]);

    const scrollDayClear = useCallback((date: string) => {
        const parsed = parseLocalDate(date);
        if (!parsed) return;
        const firstWeekday = (new Date(Date.UTC(parsed.year, parsed.month - 1, 1)).getUTCDay() + 6) % 7;
        const weekIndex = Math.floor((firstWeekday + parsed.day - 1) / 7);
        // In MonthGrid: the nav row, the weekday row, then a row of MONTH_WEEK_HEIGHT for each week down to this one.
        const dayBottom = MONTH_NAV_HEIGHT + MONTH_WEEKDAY_HEIGHT + (weekIndex + 1) * MONTH_WEEK_HEIGHT;
        const listHeight = Math.ceil(screenHeight * STACK_LIST_SHARE);
        const visibleHeight = screenHeight - listHeight - HEADER_MIN_HEIGHT - insets.top;
        const clearBottom = dayBottom + 24;
        if (clearBottom > visibleHeight) {
            const targetY = clearBottom - visibleHeight;
            requestAnimationFrame(() => {
                scrollRef.current?.scrollTo({ y: targetY, animated: !reduceMotionRef.current });
            });
        }
    }, [screenHeight, insets.top]);

    // However a day came to be selected (a tap, a jump, the next event's day on opening, or ‹ ›), the month scrolls it clear of the list.
    useEffect(() => {
        if (selectedDate) scrollDayClear(selectedDate);
    }, [selectedDate, scrollDayClear]);

    const handleSelectDate = (date: string) => {
        setSelectedDate(date);
        setDismissedMonthKey(null);
    };

    const handlePrevMonth = () => {
        if (monthModel.isCurrentOrPastMonth) return;
        setYear(monthModel.prevMonth.year);
        setMonth(monthModel.prevMonth.month);
        setSelectedDate(null);
        setDismissedMonthKey(null);
    };

    const handleNextMonth = () => {
        setYear(monthModel.nextMonth.year);
        setMonth(monthModel.nextMonth.month);
        setSelectedDate(null);
        setDismissedMonthKey(null);
    };

    const handleJumpToDate = (targetDate: string) => {
        const parsed = parseLocalDate(targetDate);
        if (parsed) {
            setYear(parsed.year);
            setMonth(parsed.month);
            setSelectedDate(targetDate);
            setDismissedMonthKey(null);
        }
    };

    const handleStartEvent = () => {
        router.push({ pathname: '/new-listing', params: { newPost: 'event' } });
    };

    const handleGoBack = () => {
        if (router.canGoBack()) {
            router.back();
        } else {
            router.replace('/(tabs)/map');
        }
    };

    const selectedDayEvents = selectedDate ? (monthModel.eventsByDay[selectedDate] ?? []) : [];

    return (
        <View style={[styles.container, { paddingTop: insets.top }]}>
            <View style={styles.header}>
                <Pressable
                    testID="calendar-back"
                    accessibilityRole="button"
                    accessibilityLabel={t('Back')}
                    onPress={handleGoBack}
                    style={styles.backButton}
                >
                    <Text style={styles.backButtonArrow}>‹</Text>
                    <Text style={styles.backButtonText}>{t('Back')}</Text>
                </Pressable>
                <Text style={styles.title} accessibilityRole="header">
                    {calendarTitle()}
                </Text>
            </View>

            {/* The day's list lies over the bottom of the screen: the month scrolls clear of it, last week included. */}
            <ScrollView
                ref={scrollRef}
                testID="calendar-month-scroll"
                style={styles.content}
                contentContainerStyle={selectedDate ? { paddingBottom: Math.ceil(screenHeight * STACK_LIST_SHARE) } : undefined}
            >
                <MonthGrid
                    month={monthModel}
                    selectedDate={selectedDate}
                    onSelectDate={handleSelectDate}
                    onPrevMonth={handlePrevMonth}
                    onNextMonth={handleNextMonth}
                    onJumpToDate={handleJumpToDate}
                    onStartEvent={handleStartEvent}
                />
            </ScrollView>

            {selectedDate ? (
                <MapStackList
                    key={selectedDate}
                    posts={selectedDayEvents}
                    heading={calendarDayHeading(selectedDate, selectedDayEvents.length)}
                    onOpen={(id) => router.push({ pathname: '/post/[id]', params: { id } })}
                    onClose={() => {
                        setSelectedDate(null);
                        setDismissedMonthKey(monthModel.monthKey);
                    }}
                />
            ) : null}
        </View>
    );
}
