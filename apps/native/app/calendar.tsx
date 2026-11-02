import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { DeviceEventEmitter, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
    buildCalendarMonth,
    calendarDayHeading,
    calendarTitle,
    formatLocalDate,
    parseLocalDate,
    t,
} from '@beanpool/core';
import { useStyles } from './ThemeContext';
import { MonthGrid } from '../components/MonthGrid';
import { MapStackList } from '../components/MapStackList';
import { getPosts } from '../utils/db';
import { eventStateOf } from '../utils/events';

export default function CalendarScreen() {
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
            minWidth: 44,
            minHeight: 44,
            paddingHorizontal: 8,
            alignItems: 'center',
            justifyContent: 'center',
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

    // When viewed month changes, auto-select first active date unless dismissed
    useEffect(() => {
        if (dismissedMonthKey === monthModel.monthKey) return;
        if (monthModel.firstActiveDate) {
            setSelectedDate(monthModel.firstActiveDate);
        } else {
            setSelectedDate(null);
        }
    }, [monthModel.monthKey, monthModel.firstActiveDate, dismissedMonthKey]);

    const handleSelectDate = (date: string) => {
        setSelectedDate(date);
        setDismissedMonthKey(null);
    };

    const handlePrevMonth = () => {
        if (monthModel.isCurrentOrPastMonth) return;
        setYear(monthModel.prevMonth.year);
        setMonth(monthModel.prevMonth.month);
        setDismissedMonthKey(null);
    };

    const handleNextMonth = () => {
        setYear(monthModel.nextMonth.year);
        setMonth(monthModel.nextMonth.month);
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
                    accessibilityLabel={t('Map', undefined, 'tab')}
                    onPress={handleGoBack}
                    style={styles.backButton}
                >
                    <Text style={styles.backButtonText}>‹ {t('Map', undefined, 'tab')}</Text>
                </Pressable>
                <Text style={styles.title} accessibilityRole="header">
                    {calendarTitle()}
                </Text>
            </View>

            <View style={styles.content}>
                <MonthGrid
                    month={monthModel}
                    selectedDate={selectedDate}
                    onSelectDate={handleSelectDate}
                    onPrevMonth={handlePrevMonth}
                    onNextMonth={handleNextMonth}
                    onJumpToDate={handleJumpToDate}
                    onStartEvent={handleStartEvent}
                />
            </View>

            {selectedDate ? (
                <MapStackList
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
