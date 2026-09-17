/**
 * EventCard — an event in the Market feed (docs/events-on-the-map.md §3 "Card", slice 3).
 *
 * Date and time first and largest; title; place name and distance; Going / Interested counts; the two RSVP
 * buttons with my status on the filled one. CANCELLED or UPDATED is a badge on the first line. The host is on
 * the detail screen, not here. Holds at 320dp with 1.3× text: every row truncates, the buttons share the
 * width and keep a 48dp target.
 */

import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator, Alert } from 'react-native';
import { router } from 'expo-router';
import { useStyles, useTheme, type ThemeContextType } from '../app/ThemeContext';
import { rsvpEvent } from '../utils/db';
import { hapticTick } from '../utils/haptics';
import {
    formatEventWhen, eventBadge, isEventEnded, eventStateOf, nextRsvp, applyRsvp, formatRsvpCounts,
    formatDistance, distanceKm, type EventRsvpStatus, type RsvpCounts,
} from '../utils/events';

export const EVENT_ACCENT = '#7c3aed';

interface EventCardProps {
    post: any;
    currentPubkey?: string | null;
    myLocation?: { lat: number; lng: number } | null;
    onRsvpChanged?: () => void;
}

function countsOf(post: any): RsvpCounts {
    return {
        going: Number(post.goingCount ?? post.event_going_count ?? 0) || 0,
        interested: Number(post.interestedCount ?? post.event_interested_count ?? 0) || 0,
        mine: (post.myRsvp ?? null) as EventRsvpStatus | null,
    };
}

export function EventCard({ post, currentPubkey, myLocation, onRsvpChanged }: EventCardProps) {
    const { colors } = useTheme();
    const styles = useStyles(makeStyles);
    const [counts, setCounts] = useState<RsvpCounts>(() => countsOf(post));
    const [pending, setPending] = useState<EventRsvpStatus | null>(null);

    useEffect(() => {
        if (!pending) setCounts(countsOf(post));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [post.id, post.goingCount, post.interestedCount, post.event_going_count, post.event_interested_count, post.myRsvp]);

    const when = formatEventWhen(post.event_start_at ?? post.eventStartAt, post.event_end_at ?? post.eventEndAt);
    const badge = eventBadge(post);
    const closed = eventStateOf(post) === 'cancelled' || isEventEnded(post);
    const placeName = post.event_place_name ?? post.eventPlaceName ?? '';
    const distance = myLocation && post.lat != null && post.lng != null
        ? formatDistance(distanceKm(myLocation.lat, myLocation.lng, post.lat, post.lng))
        : null;
    const placeLine = [placeName, distance].filter(Boolean).join(' · ');

    const handleRsvp = async (tapped: EventRsvpStatus) => {
        if (pending || closed) return;
        if (!currentPubkey) {
            Alert.alert('Sign in to RSVP', 'Set up your member identity to tell the host you are coming.');
            return;
        }
        const next = nextRsvp(counts.mine, tapped);
        const before = counts;
        hapticTick();
        setCounts(applyRsvp(counts, next));
        setPending(tapped);
        try {
            const res = await rsvpEvent(post.id, next);
            if (res?.post) setCounts(countsOf(res.post));
            onRsvpChanged?.();
        } catch (err: any) {
            setCounts(before);
            Alert.alert('RSVP not saved', err?.message || 'Could not reach the node. Try again when you have signal.');
        } finally {
            setPending(null);
        }
    };

    const rsvpButton = (status: EventRsvpStatus, label: string) => {
        const selected = counts.mine === status;
        return (
            <Pressable
                onPress={() => handleRsvp(status)}
                disabled={closed || !!pending}
                style={[styles.rsvpBtn, selected && styles.rsvpBtnSelected, closed && styles.rsvpBtnDisabled]}
                accessibilityRole="button"
                accessibilityLabel={selected ? `${label}, selected. Tap to clear` : label}
                accessibilityState={{ selected, disabled: closed || !!pending, busy: pending === status }}
            >
                {pending === status ? (
                    <ActivityIndicator size="small" color={selected ? '#fff' : EVENT_ACCENT} />
                ) : (
                    <Text style={[styles.rsvpText, selected && styles.rsvpTextSelected]} numberOfLines={1} maxFontSizeMultiplier={1.3}>
                        {selected ? `${label} ✓` : label}
                    </Text>
                )}
            </Pressable>
        );
    };

    return (
        <Pressable
            style={styles.card}
            onPress={() => router.push(`/post/${post.id}`)}
            accessibilityRole="button"
            accessibilityLabel={`Event: ${post.title}, ${when}${badge ? `, ${badge.toLowerCase()}` : ''}`}
        >
            <View style={styles.whenRow}>
                {badge && (
                    <View style={[styles.badge, badge === 'CANCELLED' ? { backgroundColor: colors.feedback.danger.bg, borderColor: colors.feedback.danger.border } : styles.badgeUpdated]}>
                        <Text style={[styles.badgeText, { color: badge === 'CANCELLED' ? colors.feedback.danger.fg : EVENT_ACCENT }]} numberOfLines={1}>{badge}</Text>
                    </View>
                )}
                <Text style={[styles.when, badge === 'CANCELLED' && styles.whenCancelled]} numberOfLines={2}>📅 {when}</Text>
            </View>
            <Text style={styles.title} numberOfLines={2}>{post.title}</Text>
            {!!placeLine && <Text style={styles.meta} numberOfLines={1}>📍 {placeLine}</Text>}
            <Text style={styles.meta} numberOfLines={1}>👥 {formatRsvpCounts(counts.going, counts.interested)}</Text>
            {!closed && (
                <View style={styles.rsvpRow}>
                    {rsvpButton('going', 'Going')}
                    {rsvpButton('interested', 'Interested')}
                </View>
            )}
        </Pressable>
    );
}

const makeStyles = ({ colors, theme }: ThemeContextType) =>
    StyleSheet.create({
        card: {
            backgroundColor: colors.surface.card,
            borderRadius: 16,
            padding: 14,
            marginBottom: 14,
            borderWidth: 1,
            borderLeftWidth: 4,
            borderColor: theme === 'dark' ? '#374151' : '#e5e7eb',
            borderLeftColor: EVENT_ACCENT,
        },
        whenRow: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            marginBottom: 4,
        },
        when: {
            flex: 1,
            fontSize: 17,
            fontWeight: '800',
            color: colors.text.heading,
        },
        whenCancelled: {
            textDecorationLine: 'line-through',
            color: colors.text.secondary,
        },
        badge: {
            flexShrink: 0,
            paddingHorizontal: 6,
            paddingVertical: 2,
            borderRadius: 6,
            borderWidth: 1,
        },
        badgeUpdated: {
            backgroundColor: theme === 'dark' ? 'rgba(124, 58, 237, 0.2)' : '#f5f3ff',
            borderColor: theme === 'dark' ? '#6d28d9' : '#ddd6fe',
        },
        badgeText: {
            fontSize: 11,
            fontWeight: '800',
            letterSpacing: 0.5,
        },
        title: {
            fontSize: 15,
            fontWeight: '700',
            color: colors.text.body,
            marginBottom: 4,
        },
        meta: {
            fontSize: 13,
            color: colors.text.secondary,
            marginBottom: 2,
        },
        rsvpRow: {
            flexDirection: 'row',
            gap: 8,
            marginTop: 10,
        },
        rsvpBtn: {
            flex: 1,
            minHeight: 48,
            borderRadius: 12,
            borderWidth: 1.5,
            borderColor: EVENT_ACCENT,
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: 6,
            backgroundColor: colors.surface.card,
        },
        rsvpBtnSelected: {
            backgroundColor: EVENT_ACCENT,
        },
        rsvpBtnDisabled: {
            opacity: 0.5,
        },
        rsvpText: {
            fontSize: 14,
            fontWeight: '700',
            color: EVENT_ACCENT,
        },
        rsvpTextSelected: {
            color: '#fff',
        },
    });
