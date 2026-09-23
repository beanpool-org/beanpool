/**
 * EventDetail — `/post/:id` for an event (docs/events-on-the-map.md §3 "Event detail", slice 3).
 *
 * Photo, big date and time, RSVP, place name with "Show on map", description, host line, the private note in
 * a shaded box when the viewer may see it, and for a host the list of who has RSVPd plus Cancel event.
 *
 * What the viewer may see is the node's decision, not this screen's: the local row gives a first paint, then
 * a signed by-id fetch returns my RSVP, the note (host and Going only) and the RSVP list (hosts only). The note
 * lives in component state and is never written to the phone's cache.
 *
 * The event chat (slice 4) is one tap from here, for the host and anyone Going. A host can also edit the event
 * (round 2: NewEventModal in edit mode, every field filled), cancel it, or copy it to a new date (slice 5) —
 * that opens NewEventModal filled from this event with the dates blank. A host has no Going / Interested:
 * they are running it. After cancelling, the host stays here and sees it CANCELLED. "Show on map" opens the
 * phone's maps app, because the in-app map layer for events is the protected-files slice 7.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, Alert, ActivityIndicator, Linking, Platform, DeviceEventEmitter } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, useStyles, type ThemeContextType } from '../app/ThemeContext';
import { useIdentity } from '../app/IdentityContext';
import { fetchEventDetail, rsvpEvent, deletePost, reportAbuse } from '../utils/db';
import { hapticTick } from '../utils/haptics';
import { PhotoCarousel } from './PhotoCarousel';
import { EVENT_ACCENT } from './EventCard';
import { NewEventModal } from './NewEventModal';
import { EventReminder, EventShareAndCalendar } from './EventExtras';
import {
    formatEventWhen, eventBadge, eventStateOf, isEventEnded, nextRsvp, applyRsvp, formatRsvpCounts,
    canOpenEventChat, eventChatEntryLabel, buildEventCopy, isEventHostView, isOwnEvent, eventEditBlockedReason, eventEditValues,
    type EventRsvpStatus, type RsvpCounts, type EventCopy, type EventEditValues,
} from '../utils/events';

interface EventDetailProps {
    post: any;
}

function countsOf(p: any): RsvpCounts {
    return {
        going: Number(p.goingCount ?? p.event_going_count ?? 0) || 0,
        interested: Number(p.interestedCount ?? p.event_interested_count ?? 0) || 0,
        mine: (p.myRsvp ?? null) as EventRsvpStatus | null,
    };
}

export function EventDetail({ post }: EventDetailProps) {
    const insets = useSafeAreaInsets();
    const { colors } = useTheme();
    const styles = useStyles(makeStyles);
    const { identity } = useIdentity();

    // The node's reader view for this member; null until it arrives (or when offline).
    const [view, setView] = useState<any | null>(null);
    const [counts, setCounts] = useState<RsvpCounts>(() => countsOf(post));
    const [pending, setPending] = useState<EventRsvpStatus | null>(null);
    const [showRsvps, setShowRsvps] = useState(false);
    const [cancelling, setCancelling] = useState(false);
    // Non-null while the copy form is open; holding the draft rather than a boolean means NewEventModal
    // applies it once, on the opening it was built for.
    const [copyDraft, setCopyDraft] = useState<EventCopy | null>(null);
    // Non-null while the edit form is open; one object per opening, which NewEventModal applies once.
    const [editOf, setEditOf] = useState<{ id: string; values: EventEditValues; audienceLabel: string } | null>(null);

    const load = useCallback(async () => {
        try {
            const v = await fetchEventDetail(post.id);
            if (v) {
                setView(v);
                setCounts(countsOf(v));
            }
            return v;
        } catch {
            // Offline: the cached row still shows the event; RSVP will say it cannot reach the node.
            return null;
        }
    }, [post.id]);

    useEffect(() => { load(); }, [load]);

    const p = view ? { ...post, ...view } : post;
    const when = formatEventWhen(p.eventStartAt ?? p.event_start_at, p.eventEndAt ?? p.event_end_at);
    const badge = eventBadge(p);
    const cancelled = eventStateOf(p) === 'cancelled';
    const ended = isEventEnded(p);
    const closed = cancelled || ended;
    const placeName = p.eventPlaceName ?? p.event_place_name ?? '';
    const note: string | undefined = view?.eventPrivateNote;
    const rsvps: any[] | undefined = view?.eventRsvps; // present only when the node says this viewer is a host
    // The node's word first: it sends the RSVP list to hosts only. With no node view (offline, or a node that
    // does not serve a cancelled event by id yet), the author is still the host — never offer them Report.
    const hostView = isEventHostView(view);
    const isHost = hostView || (!view && isOwnEvent(p, identity?.publicKey));
    const editBlocked = eventEditBlockedReason(p);
    const hostName = p.authorCallsign || p.author_callsign || (p.author_pubkey || p.authorPublicKey || '').slice(0, 6) || 'Unknown';
    const groupName = p.targetGroupName || p.target_group_name;
    const isGroupOnly = (p.audienceScope || p.audience_scope) === 'group';
    // Photos from the cached row, whose paths getPost has already resolved against the node.
    let photos: string[] = [];
    if (Array.isArray(post.photos)) photos = post.photos;
    else if (typeof post.photos === 'string') { try { photos = JSON.parse(post.photos); } catch { photos = []; } }

    const handleRsvp = async (tapped: EventRsvpStatus) => {
        if (pending || closed) return;
        if (!identity?.publicKey) {
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
            if (res?.post) {
                setView(res.post);
                setCounts(countsOf(res.post));
            }
        } catch (err: any) {
            setCounts(before);
            Alert.alert('RSVP not saved', err?.message || 'Could not reach the node. Try again when you have signal.');
        } finally {
            setPending(null);
        }
    };

    const showOnMap = () => {
        if (p.lat == null || p.lng == null) return;
        const label = encodeURIComponent(placeName || p.title || 'Event');
        const url = Platform.OS === 'ios'
            ? `maps:0,0?q=${label}&ll=${p.lat},${p.lng}`
            : `geo:${p.lat},${p.lng}?q=${p.lat},${p.lng}(${label})`;
        Linking.openURL(url).catch(() => Alert.alert('No maps app', `The event is at ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}.`));
    };

    const cancelEvent = () => {
        Alert.alert('Cancel this event?', 'It leaves the feed and shows CANCELLED to anyone who opens it. This cannot be undone.', [
            { text: 'Keep event', style: 'cancel' },
            {
                text: 'Cancel event', style: 'destructive', onPress: async () => {
                    setCancelling(true);
                    try {
                        await deletePost(post.id);
                        // Stay on the page: the node still serves a cancelled event to its host by id, so the
                        // host sees it marked CANCELLED instead of losing it (events round 2, A4).
                        const after = await load();
                        if (!after) setView((v: any) => ({ ...(v ?? {}), status: 'cancelled', eventState: 'cancelled' }));
                        Alert.alert('Event cancelled', 'It now shows CANCELLED, and everyone going has been told.');
                    } catch (e: any) {
                        Alert.alert('Not cancelled', e?.message || 'Could not reach the node.');
                    } finally {
                        setCancelling(false);
                    }
                },
            },
        ]);
    };

    const report = () => {
        if (!identity?.publicKey) return;
        Alert.alert('Report this event?', "This community's moderators will review it.", [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Report', style: 'destructive', onPress: async () => {
                    try {
                        await reportAbuse(identity.publicKey, p.author_pubkey || p.authorPublicKey, 'Event reported from the event screen', post.id);
                        Alert.alert('Reported', 'Thanks. A moderator will take a look.');
                    } catch (e: any) {
                        Alert.alert('Not sent', e?.message || 'Could not reach the node.');
                    }
                },
            },
        ]);
    };

    const goBack = () => { if (router.canGoBack()) router.back(); else router.replace('/(tabs)'); };

    const rsvpButton = (status: EventRsvpStatus, label: string) => {
        const selected = counts.mine === status;
        return (
            <Pressable
                onPress={() => handleRsvp(status)}
                disabled={closed || !!pending}
                style={[styles.rsvpBtn, selected && styles.rsvpBtnSelected]}
                accessibilityRole="button"
                accessibilityLabel={selected ? `${label}, selected. Tap to clear` : label}
                accessibilityState={{ selected, disabled: closed || !!pending, busy: pending === status }}
            >
                {/*
                  * The label holds the button's width while the RSVP is in flight (the card does the same): the
                  * buttons size to their own labels, so swapping the label out for the spinner would shrink the
                  * button under the finger and re-flow a stacked row mid-tap.
                  */}
                <Text style={[styles.rsvpText, selected && styles.rsvpTextSelected, pending === status && styles.rsvpTextBusy]} numberOfLines={1}>{selected ? `${label} ✓` : label}</Text>
                {pending === status && (
                    <View style={styles.rsvpSpinner} pointerEvents="none">
                        <ActivityIndicator size="small" color={selected ? '#fff' : EVENT_ACCENT} />
                    </View>
                )}
            </Pressable>
        );
    };

    return (
        <View style={[styles.container, { paddingTop: insets.top }]}>
            <View style={styles.header}>
                <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={goBack} style={styles.backButton}>
                    <Text style={styles.backText}>←</Text>
                    <Text style={styles.backLabel} numberOfLines={1}>Back</Text>
                </Pressable>
                <Text style={styles.headerTitle} numberOfLines={1}>Event</Text>
                <View style={{ width: 72 }} />
            </View>

            <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 40 }]}>
                {photos.length > 0 && (
                    <View style={{ marginBottom: 14 }}>
                        <PhotoCarousel photos={photos} height={200} borderRadius={14} />
                    </View>
                )}

                {badge && (
                    <View style={[styles.badge, badge === 'CANCELLED' ? { backgroundColor: colors.feedback.danger.bg, borderColor: colors.feedback.danger.border } : styles.badgeUpdated]}>
                        <Text style={[styles.badgeText, { color: badge === 'CANCELLED' ? colors.feedback.danger.fg : EVENT_ACCENT }]}>{badge}</Text>
                    </View>
                )}
                <Text style={[styles.when, cancelled && styles.whenCancelled]}>{when}</Text>
                <Text style={styles.title}>{p.title}</Text>
                {ended && !cancelled && <Text style={styles.endedNote}>This event has ended.</Text>}

                <Text style={styles.counts} numberOfLines={1}>👥 {formatRsvpCounts(counts.going, counts.interested)}</Text>
                {isHost ? (
                    <Text style={styles.hostingLine} accessibilityRole="text">You're hosting this event</Text>
                ) : !closed && (
                    <View style={styles.rsvpRow}>
                        {rsvpButton('going', 'Going')}
                        {rsvpButton('interested', 'Interested')}
                    </View>
                )}

                {/* Send it on, and put it in a diary. Neither needs the node, so neither depends on its age. */}
                <EventShareAndCalendar post={p} />
                {/* The host is running it and has no RSVP, so they get no reminder line (decision 2). */}
                {!isHost && (
                    <EventReminder post={p} myRsvp={counts.mine} viewerPublicKey={identity?.publicKey} />
                )}

                {canOpenEventChat({ ...p, type: 'event', myRsvp: counts.mine, eventRsvps: rsvps }) && (
                    <Pressable
                        onPress={() => router.push({ pathname: `/chat/${post.id}`, params: { event: '1' } })}
                        style={styles.chatBtn}
                        accessibilityRole="button"
                        accessibilityLabel={eventChatEntryLabel({ ...p, goingCount: counts.going })}
                    >
                        <Text style={styles.chatBtnText} numberOfLines={1}>
                            💬 {eventChatEntryLabel({ ...p, goingCount: counts.going })}
                        </Text>
                    </Pressable>
                )}

                {!!placeName && (
                    <View style={styles.placeRow}>
                        <Text style={styles.place} numberOfLines={2}>📍 {placeName}</Text>
                        {p.lat != null && p.lng != null && (
                            <Pressable onPress={showOnMap} style={styles.linkBtn} accessibilityRole="link" accessibilityLabel={`Show ${placeName} on a map`}>
                                <Text style={styles.link} numberOfLines={1}>Show on map</Text>
                            </Pressable>
                        )}
                    </View>
                )}

                {note ? (
                    <View style={styles.noteBox}>
                        <Text style={styles.noteLabel}>NOTE FOR PEOPLE WHO ARE GOING</Text>
                        <Text style={styles.noteText} selectable>{note}</Text>
                    </View>
                ) : null}

                {!!p.description && <Text style={styles.description}>{p.description}</Text>}

                <Text style={styles.hostLine} numberOfLines={2}>
                    Hosted by {hostName}{isGroupOnly && groupName ? ` · 🔒 only ${groupName} can see this` : ''}
                </Text>

                {isHost && (
                    <View style={styles.hostBox}>
                        {hostView && (<Pressable
                            onPress={() => setShowRsvps(s => !s)}
                            style={styles.hostRowBtn}
                            accessibilityRole="button"
                            accessibilityState={{ expanded: showRsvps }}
                            accessibilityLabel={`Who's going, ${rsvps!.length} replies`}
                        >
                            <Text style={styles.hostRowText} numberOfLines={1}>Who's going ({rsvps!.length})</Text>
                            <Text style={styles.hostRowText}>{showRsvps ? '▲' : '▼'}</Text>
                        </Pressable>)}
                        {hostView && showRsvps && (rsvps!.length === 0
                            ? <Text style={styles.rsvpEmpty}>Nobody has replied yet.</Text>
                            : rsvps!.map((r: any) => (
                                <View key={r.memberPubkey} style={styles.rsvpListRow}>
                                    <Text style={styles.rsvpName} numberOfLines={1}>{r.memberCallsign || r.memberPubkey.slice(0, 8)}</Text>
                                    <Text style={styles.rsvpStatus} numberOfLines={1}>{r.status === 'going' ? 'Going' : 'Interested'}</Text>
                                </View>
                            )))}
                        {editBlocked ? (
                            <Text style={styles.editBlocked}>{editBlocked}</Text>
                        ) : (
                            <Pressable
                                onPress={() => setEditOf({
                                    id: post.id,
                                    // The cached row's photo paths are already resolved against the node.
                                    values: eventEditValues({ ...p, photos }),
                                    audienceLabel: isGroupOnly && groupName ? `🔒 Only ${groupName} can see this.` : 'This community.',
                                })}
                                style={styles.editBtn}
                                accessibilityRole="button"
                                accessibilityLabel="Edit event"
                            >
                                <Text style={styles.editText} numberOfLines={1}>Edit event</Text>
                            </Pressable>
                        )}
                        <Pressable
                            onPress={() => setCopyDraft(buildEventCopy(p, identity?.publicKey))}
                            style={styles.copyBtn}
                            accessibilityRole="button"
                            accessibilityLabel="Copy to a new date"
                        >
                            <Text style={styles.copyText} numberOfLines={1}>Copy to a new date</Text>
                        </Pressable>
                        {!closed && (
                            <Pressable
                                onPress={cancelEvent}
                                disabled={cancelling}
                                style={styles.cancelBtn}
                                accessibilityRole="button"
                                accessibilityLabel="Cancel event"
                                accessibilityState={{ busy: cancelling }}
                            >
                                {cancelling ? <ActivityIndicator size="small" color={colors.feedback.danger.solid} /> : <Text style={styles.cancelText}>Cancel event</Text>}
                            </Pressable>
                        )}
                    </View>
                )}

                {!isHost && identity?.publicKey && (
                    <Pressable onPress={report} style={styles.reportBtn} accessibilityRole="button" accessibilityLabel="Report event">
                        <Text style={styles.reportText}>🚩 Report event</Text>
                    </Pressable>
                )}
            </ScrollView>

            <NewEventModal
                visible={!!copyDraft}
                prefill={copyDraft}
                onClose={() => setCopyDraft(null)}
                onSuccess={() => { setCopyDraft(null); goBack(); }}
            />
            <NewEventModal
                visible={!!editOf}
                editOf={editOf}
                onClose={() => setEditOf(null)}
                onSaved={() => { load(); DeviceEventEmitter.emit('sync_data_updated'); }}
            />
        </View>
    );
}

const makeStyles = ({ colors, theme }: ThemeContextType) =>
    StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.page },
        header: {
            flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
            paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.surface.subtle,
        },
        backButton: { flexDirection: 'row', width: 72, minHeight: 48, alignItems: 'center' },
        backText: { color: colors.text.body, fontSize: 22 },
        backLabel: { color: colors.text.body, fontSize: 15, fontWeight: '700', marginLeft: 4 },
        headerTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '800', color: colors.text.body, letterSpacing: 1, textTransform: 'uppercase' },
        scroll: { padding: 16 },
        badge: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1, marginBottom: 6 },
        badgeUpdated: {
            backgroundColor: theme === 'dark' ? 'rgba(124, 58, 237, 0.2)' : '#f5f3ff',
            borderColor: theme === 'dark' ? '#6d28d9' : '#ddd6fe',
        },
        badgeText: { fontSize: 12, fontWeight: '800', letterSpacing: 0.5 },
        when: { fontSize: 22, fontWeight: '800', color: colors.text.heading, marginBottom: 6 },
        whenCancelled: { textDecorationLine: 'line-through', color: colors.text.secondary },
        title: { fontSize: 18, fontWeight: '700', color: colors.text.body, marginBottom: 8 },
        endedNote: { fontSize: 14, color: colors.text.secondary, marginBottom: 8 },
        counts: { fontSize: 14, color: colors.text.secondary, marginBottom: 8 },
        // Sized to the label, wrapping to a second row rather than ellipsizing it — the same fix the card and the
        // web EventCard carry. This row's text is 15sp, so it runs out of width sooner than the card's 14sp.
        rsvpRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
        rsvpBtn: {
            flexGrow: 1, flexBasis: 'auto', flexShrink: 0, minHeight: 48, borderRadius: 12, borderWidth: 1.5, borderColor: EVENT_ACCENT,
            alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6, backgroundColor: colors.surface.card,
        },
        rsvpBtnSelected: { backgroundColor: EVENT_ACCENT },
        rsvpText: { fontSize: 15, fontWeight: '700', color: EVENT_ACCENT },
        rsvpTextSelected: { color: '#fff' },
        rsvpTextBusy: { opacity: 0 },
        rsvpSpinner: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
        chatBtn: {
            minHeight: 48, justifyContent: 'center', paddingHorizontal: 12, marginBottom: 14,
            borderRadius: 12, borderWidth: 1.5, borderColor: EVENT_ACCENT, backgroundColor: colors.surface.card,
        },
        chatBtnText: { fontSize: 15, fontWeight: '700', color: EVENT_ACCENT },
        placeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
        place: { flex: 1, fontSize: 15, fontWeight: '600', color: colors.text.body },
        linkBtn: { minHeight: 48, justifyContent: 'center', flexShrink: 0 },
        link: { fontSize: 14, fontWeight: '700', color: colors.text.link },
        noteBox: {
            backgroundColor: theme === 'dark' ? 'rgba(124, 58, 237, 0.15)' : '#f5f3ff',
            borderColor: theme === 'dark' ? '#6d28d9' : '#ddd6fe', borderWidth: 1, borderRadius: 12,
            padding: 12, marginBottom: 14,
        },
        noteLabel: { fontSize: 11, fontWeight: '800', letterSpacing: 0.5, color: EVENT_ACCENT, marginBottom: 4 },
        noteText: { fontSize: 15, color: colors.text.body, lineHeight: 21 },
        description: { fontSize: 15, color: colors.text.body, lineHeight: 22, marginBottom: 14 },
        hostLine: { fontSize: 14, color: colors.text.secondary, marginBottom: 14 },
        hostBox: {
            borderWidth: 1, borderColor: colors.border.default, borderRadius: 12, backgroundColor: colors.surface.card,
            paddingHorizontal: 12, paddingVertical: 4, marginBottom: 14,
        },
        hostRowBtn: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
        hostRowText: { fontSize: 15, fontWeight: '700', color: colors.text.body, flexShrink: 1 },
        rsvpEmpty: { fontSize: 14, color: colors.text.secondary, paddingVertical: 8 },
        rsvpListRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.border.default },
        rsvpName: { flex: 1, fontSize: 14, color: colors.text.body },
        rsvpStatus: { fontSize: 13, fontWeight: '700', color: EVENT_ACCENT, flexShrink: 0 },
        hostingLine: { fontSize: 15, fontWeight: '700', color: EVENT_ACCENT, marginBottom: 14 },
        editBtn: {
            minHeight: 48, justifyContent: 'center', alignItems: 'center', borderRadius: 12, backgroundColor: EVENT_ACCENT,
            marginTop: 4, marginBottom: 4, paddingHorizontal: 12,
        },
        editText: { fontSize: 15, fontWeight: '800', color: '#fff' },
        editBlocked: { fontSize: 14, color: colors.text.secondary, paddingVertical: 10 },
        copyBtn: { minHeight: 48, justifyContent: 'center', alignItems: 'center', borderTopWidth: 1, borderTopColor: colors.border.default, marginTop: 4 },
        copyText: { fontSize: 15, fontWeight: '700', color: EVENT_ACCENT },
        cancelBtn: { minHeight: 48, justifyContent: 'center', alignItems: 'center', borderTopWidth: 1, borderTopColor: colors.border.default, marginTop: 4 },
        cancelText: { fontSize: 15, fontWeight: '700', color: colors.feedback.danger.solid },
        reportBtn: { minHeight: 48, justifyContent: 'center', alignSelf: 'flex-start' },
        reportText: { fontSize: 13, fontWeight: '700', color: colors.feedback.danger.solid },
    });
