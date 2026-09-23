/**
 * EventCard — an event in the Market feed (docs/events-on-the-map.md §3 "Card", slice 3).
 *
 * Date and time first and largest; title; place name and distance; Going / Interested counts; the two RSVP
 * buttons with my status on the filled one. CANCELLED or UPDATED is a badge on the first line. The host is on
 * the detail screen, not here. Holds at 320dp with 1.3× text: every row truncates, the buttons share the
 * width and keep a 48dp target.
 *
 * An event with a photo shows it, as the offer cards beside it do — the host put it there, and a feed of
 * pictures with one blank tile among them reads as the event being the lesser thing.
 */

import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator, Alert } from 'react-native';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useStyles, useTheme, type ThemeContextType } from '../app/ThemeContext';
import { rsvpEvent } from '../utils/db';
import { hapticTick } from '../utils/haptics';
import {
    formatEventWhen, eventBadge, isEventEnded, eventStateOf, nextRsvp, applyRsvp, formatRsvpCounts,
    formatDistance, distanceKm, isOwnEvent, eventCoverPhoto, type EventRsvpStatus, type RsvpCounts,
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
        // Re-sync from the post only when its counts or my RSVP change, not on every render of a new post object.
    }, [post.id, post.goingCount, post.interestedCount, post.event_going_count, post.event_interested_count, post.myRsvp]);

    const when = formatEventWhen(post.event_start_at ?? post.eventStartAt, post.event_end_at ?? post.eventEndAt);
    const badge = eventBadge(post);
    const closed = eventStateOf(post) === 'cancelled' || isEventEnded(post);
    const placeName = post.event_place_name ?? post.eventPlaceName ?? '';
    const distance = myLocation && post.lat != null && post.lng != null
        ? formatDistance(distanceKm(myLocation.lat, myLocation.lng, post.lat, post.lng))
        : null;
    const placeLine = [placeName, distance].filter(Boolean).join(' · ');
    const photo = eventCoverPhoto(post);
    // "Your events" is built from /api/events/mine, which carries no counts — and "0 going" on an event the
    // viewer is going to is not a smaller truth, it is a wrong one. A row that does not know keeps quiet.
    const countsKnown = post.goingCount != null || post.interestedCount != null
        || post.event_going_count != null || post.event_interested_count != null;

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
            {/*
              * The host's photo, the same size, crop and cache policy the offer card beside it uses in the list
              * (index.tsx list view): a 96dp square on the left, with the lines beside it. It sits inside the
              * card's own Pressable and has no onPress of its own, so it never becomes a second tap target.
              * Without a photo the card is exactly the stack it has always been.
              */}
            <View style={photo ? styles.photoRow : undefined}>
                {photo && (
                    <Image
                        source={{ uri: photo }}
                        style={styles.photo}
                        accessibilityLabel={post.title}
                        contentFit="cover"
                        cachePolicy="memory-disk"
                        transition={150}
                    />
                )}
                <View style={photo ? styles.photoRowText : undefined}>
                    <View style={styles.whenRow}>
                        {badge && (
                            <View style={[styles.badge, badge === 'CANCELLED' ? { backgroundColor: colors.feedback.danger.bg, borderColor: colors.feedback.danger.border } : styles.badgeUpdated]}>
                                <Text style={[styles.badgeText, { color: badge === 'CANCELLED' ? colors.feedback.danger.fg : EVENT_ACCENT }]} numberOfLines={1}>{badge}</Text>
                            </View>
                        )}
                        <Text style={[styles.when, badge === 'CANCELLED' && styles.whenCancelled]} numberOfLines={2}>{when}</Text>
                    </View>
                    <Text style={styles.title} numberOfLines={2}>{post.title}</Text>
                    {!!placeLine && <Text style={styles.meta} numberOfLines={1}>📍 {placeLine}</Text>}
                    {countsKnown && <Text style={styles.meta} numberOfLines={1}>👥 {formatRsvpCounts(counts.going, counts.interested)}</Text>}
                </View>
            </View>
            {/* The host is running it: no Going / Interested on their own event (round 2, B4). */}
            {isOwnEvent(post, currentPubkey) ? (
                <Text style={styles.hosting} numberOfLines={1}>You're hosting this event</Text>
            ) : !closed && (
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
        // Only used when there is a photo. The RSVP row stays outside it, keeping the card's full width, so at
        // 320dp with 1.3× text the buttons are never squeezed into the column beside the picture.
        photoRow: {
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: 12,
        },
        photoRowText: {
            flex: 1,
            minWidth: 0,
        },
        photo: {
            width: 96,
            height: 96,
            borderRadius: 14,
            flexShrink: 0,
            backgroundColor: colors.surface.subtle,
        },
        when: {
            flex: 1,
            fontSize: 17,
            fontWeight: '800',
            color: colors.text.heading,
        },
        hosting: { fontSize: 14, fontWeight: '700', color: EVENT_ACCENT, marginTop: 8 },
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
