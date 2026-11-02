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
import { MonthGrid } from '../components/MonthGrid';
import { MapStackList } from '../components/MapStackList';
import { getPosts } from '../utils/db';
import { eventStateOf } from '../utils/events';

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
            minHeight: 52,
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
        const weekIndex = monthModel.weeks.findIndex(w => w.some(c => c.date === date));
        if (weekIndex < 0) return;
        // In MonthGrid: navHeader (minHeight 48) + weekdayRow (minHeight 28) + weekRows (minHeight 44-48dp each with scaling).
        const dayBottom = 48 + 28 + (weekIndex + 1) * 48;
        const listHeight = Math.ceil(screenHeight * STACK_LIST_SHARE);
        const visibleHeight = screenHeight - listHeight - 52;
        const clearBottom = dayBottom + 24;
        if (clearBottom > visibleHeight) {
            const targetY = clearBottom - visibleHeight;
            requestAnimationFrame(() => {
                scrollRef.current?.scrollTo({ y: targetY, animated: !reduceMotionRef.current });
            });
        }
    }, [monthModel.weeks, screenHeight]);

    const handleSelectDate = (date: string) => {
        setSelectedDate(date);
        setDismissedMonthKey(null);
        scrollDayClear(date);
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
            scrollDayClear(targetDate);
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
                    accessibilityLabel={t('Map', undefined, 'tab')}
                    onPress={handleGoBack}
                    style={styles.backButton}
                >
                    <Text style={styles.backButtonArrow}>‹</Text>
                    <Text style={styles.backButtonText}>{t('Map', undefined, 'tab')}</Text>
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
