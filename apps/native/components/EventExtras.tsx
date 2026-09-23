/**
 * The three things an event screen offers once it is in your diary: Share, Add to calendar, and Remind me.
 *
 * Share and Add to calendar need no node at all — the link is built from the community's own address and
 * the calendar entry from the event in hand — so they are there whatever the node's age. Remind me DOES
 * need the new routes, and a node that does not have them answers 404; the row then removes itself without
 * a word, because a member on an older community should see an event screen that simply has no reminders,
 * not an error about a feature they never asked for.
 *
 * Add to calendar adds NO native module. iOS gets the .ics through expo-sharing, which iOS opens straight
 * into "Add to Calendar"; Android gets Google Calendar's template URL, because Android's share sheet
 * (ACTION_SEND) is not what a calendar app answers for a file — Google Calendar answers ACTION_VIEW — so
 * sharing the .ics there would mostly offer Drive and Gmail. Both are already-installed paths, and the
 * ledger's CSV export uses the same two modules.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Share, Alert, Linking, Platform, ActivityIndicator } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { useStyles, type ThemeContextType } from '../app/ThemeContext';
import { fetchMemberPreferences, fetchMyEvents, isRouteMissing, setEventReminder } from '../utils/db';
import { formatEventWhen } from '../utils/events';
import {
    DEFAULT_REMINDER_OFFSETS, REMINDER_OFFSETS, REMINDER_PREF_KEY, buildIcs, buildShareText, eventLink,
    formatReminderChoice, googleCalendarUrl, icsFileName, normaliseReminderOffsets, parseReminderOffsets,
    reminderOffsetLabel, type ShareableEvent,
} from '../utils/event-extras';
import { EVENT_ACCENT } from './EventCard';

/** The event as the share text and the calendar entry need it, from either row shape. */
export function shareableEvent(post: any): ShareableEvent {
    return {
        id: post.id,
        title: post.title || 'Event',
        startAt: post.eventStartAt ?? post.event_start_at ?? '',
        endAt: post.eventEndAt ?? post.event_end_at ?? null,
        placeName: post.eventPlaceName ?? post.event_place_name ?? null,
        description: post.description || null,
    };
}

async function anchorOrThrow(): Promise<string> {
    const url = await AsyncStorage.getItem('beanpool_anchor_url');
    if (!url) throw new Error('You are currently offline.');
    return url;
}

export function EventShareAndCalendar({ post }: { post: any }) {
    const styles = useStyles(makeStyles);
    const event = shareableEvent(post);
    const when = formatEventWhen(event.startAt, event.endAt);

    const share = async () => {
        try {
            const link = eventLink(await anchorOrThrow(), event.id);
            await Share.share({ message: buildShareText(event, when, link), title: event.title });
        } catch (e: any) {
            Alert.alert('Not shared', e?.message || 'Could not share this event.');
        }
    };

    const addToCalendar = async () => {
        try {
            const link = eventLink(await anchorOrThrow(), event.id);
            if (Platform.OS === 'ios') {
                const path = `${FileSystem.cacheDirectory}${icsFileName(event)}`;
                await FileSystem.writeAsStringAsync(path, buildIcs(event, link), { encoding: FileSystem.EncodingType.UTF8 });
                await Sharing.shareAsync(path, { mimeType: 'text/calendar', UTI: 'com.apple.ical.ics', dialogTitle: 'Add to calendar' });
                return;
            }
            const url = googleCalendarUrl(event, link);
            const opened = await Linking.openURL(url).then(() => true).catch(() => false);
            if (!opened) Alert.alert('No calendar app', 'Nothing on this phone could open a calendar entry.');
        } catch (e: any) {
            Alert.alert('Not added', e?.message || 'Could not make a calendar entry.');
        }
    };

    return (
        <View style={styles.row}>
            <Pressable onPress={share} style={styles.btn} accessibilityRole="button" accessibilityLabel="Share this event">
                <Text style={styles.btnText} numberOfLines={1} maxFontSizeMultiplier={1.3}>🔗 Share</Text>
            </Pressable>
            <Pressable onPress={addToCalendar} style={styles.btn} accessibilityRole="button" accessibilityLabel="Add this event to your calendar">
                <Text style={styles.btnText} numberOfLines={1} maxFontSizeMultiplier={1.3}>📅 Add to calendar</Text>
            </Pressable>
        </View>
    );
}

interface ReminderProps {
    post: any;
    /** Shown only to someone with an RSVP; the host gets no RSVP buttons, so they get no reminders either. */
    myRsvp: 'going' | 'interested' | null | undefined;
    /** Whose default to read, so the closed line can say which it is. */
    viewerPublicKey?: string | null;
}

/**
 * "Remind me": the choice that applies to this event, and a way to change it or hand it back to the
 * member's default.
 *
 * What this event is set to comes from `/api/events/mine`, because that is the one place the contract puts
 * it; the member's default comes from their preferences, so the line can say which it is. A 404 from
 * either takes the whole block away. A member who has just tapped Going may not be in the list yet; they
 * read as "my default", which is exactly what the node will do for them until they choose otherwise.
 */
export function EventReminder({ post, myRsvp, viewerPublicKey }: ReminderProps) {
    const styles = useStyles(makeStyles);
    const [supported, setSupported] = useState(true);
    const [defaults, setDefaults] = useState<number[]>(DEFAULT_REMINDER_OFFSETS);
    const [offsets, setOffsets] = useState<number[] | null>(null);
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState<number[]>([]);
    const [saving, setSaving] = useState(false);

    const load = useCallback(async () => {
        try {
            const mine = await fetchMyEvents();
            const row = mine.find(r => r.postId === post.id);
            setOffsets(row ? parseReminderOffsets(row.reminderOffsets) : null);
        } catch (e) {
            if (isRouteMissing(e)) setSupported(false);
            // Anything else (offline, a node having a bad minute) leaves the line reading "your default",
            // which is what the node would in fact do.
        }
    }, [post.id]);

    useEffect(() => {
        if (!myRsvp) return;
        let cancelled = false;
        (async () => {
            if (!cancelled) await load();
            try {
                if (!viewerPublicKey) return;
                const prefs = await fetchMemberPreferences(viewerPublicKey);
                if (!cancelled) setDefaults(parseReminderOffsets(prefs?.[REMINDER_PREF_KEY]) ?? DEFAULT_REMINDER_OFFSETS);
            } catch {
                // Keep the documented default; it is right for everyone who has not changed it.
            }
        })();
        return () => { cancelled = true; };
    }, [load, myRsvp, viewerPublicKey]);

    if (!supported || !myRsvp) return null;

    const save = async (next: number[] | null) => {
        setSaving(true);
        try {
            const cleaned = next === null ? null : normaliseReminderOffsets(next);
            await setEventReminder(post.id, cleaned);
            setOffsets(cleaned);
            setOpen(false);
        } catch (e: any) {
            if (isRouteMissing(e)) {
                setSupported(false);
                return;
            }
            Alert.alert('Reminder not saved', e?.message || 'Could not reach the node.');
        } finally {
            setSaving(false);
        }
    };

    return (
        <View style={styles.reminderBox}>
            <View style={styles.reminderHeadRow}>
                <Text style={styles.reminderLine} numberOfLines={3}>
                    ⏰ Remind me: <Text style={styles.reminderChoice}>{formatReminderChoice(offsets, defaults)}</Text>
                </Text>
                <Pressable
                    onPress={() => { if (!open) setDraft(offsets ?? defaults); setOpen(o => !o); }}
                    style={styles.smallBtn}
                    accessibilityRole="button"
                    accessibilityLabel={open ? 'Close reminder choices' : 'Change the reminder for this event'}
                    accessibilityState={{ expanded: open }}
                >
                    <Text style={styles.smallBtnText} numberOfLines={1} maxFontSizeMultiplier={1.3}>{open ? 'Close' : 'Change'}</Text>
                </Pressable>
            </View>

            {open && (
                <View>
                    <Text style={styles.reminderHint}>Tell me before it starts. With none ticked you get no reminder for this event.</Text>
                    {REMINDER_OFFSETS.map(minutes => {
                        const on = draft.includes(minutes);
                        return (
                            <Pressable
                                key={minutes}
                                onPress={() => setDraft(d => (on ? d.filter(m => m !== minutes) : [...d, minutes]))}
                                style={styles.tickRow}
                                accessibilityRole="checkbox"
                                accessibilityLabel={`${reminderOffsetLabel(minutes)} before`}
                                accessibilityState={{ checked: on }}
                            >
                                <View style={[styles.tickBox, on && styles.tickBoxOn]}>
                                    {on && <Text style={styles.tickMark}>✓</Text>}
                                </View>
                                <Text style={styles.tickLabel} numberOfLines={2}>{reminderOffsetLabel(minutes)} before</Text>
                            </Pressable>
                        );
                    })}
                    <Pressable
                        onPress={() => save(draft)}
                        disabled={saving}
                        style={styles.saveBtn}
                        accessibilityRole="button"
                        accessibilityLabel="Save this reminder for this event"
                        accessibilityState={{ busy: saving }}
                    >
                        {saving ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.saveBtnText} numberOfLines={1}>Save for this event</Text>}
                    </Pressable>
                    {offsets !== null && (
                        <Pressable
                            onPress={() => save(null)}
                            disabled={saving}
                            style={styles.resetBtn}
                            accessibilityRole="button"
                            accessibilityLabel="Use my default reminder for this event"
                        >
                            <Text style={styles.resetBtnText} numberOfLines={1}>Use my default</Text>
                        </Pressable>
                    )}
                </View>
            )}
        </View>
    );
}

const makeStyles = ({ colors }: ThemeContextType) =>
    StyleSheet.create({
        row: { flexDirection: 'row', gap: 8, marginBottom: 14, flexWrap: 'wrap' },
        btn: {
            flexGrow: 1, flexBasis: 130, minHeight: 48, borderRadius: 12, borderWidth: 1.5, borderColor: EVENT_ACCENT,
            alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8, backgroundColor: colors.surface.card,
        },
        btnText: { fontSize: 14, fontWeight: '700', color: EVENT_ACCENT },
        reminderBox: {
            borderWidth: 1, borderColor: colors.border.default, borderRadius: 12, backgroundColor: colors.surface.card,
            paddingHorizontal: 12, paddingVertical: 8, marginBottom: 14,
        },
        reminderHeadRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
        reminderLine: { flex: 1, flexBasis: 150, fontSize: 14, color: colors.text.body },
        reminderChoice: { fontWeight: '800', color: colors.text.heading },
        reminderHint: { fontSize: 13, color: colors.text.secondary, marginTop: 8 },
        smallBtn: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 8, flexShrink: 0 },
        smallBtnText: { fontSize: 14, fontWeight: '700', color: EVENT_ACCENT },
        tickRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48 },
        tickBox: {
            width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: EVENT_ACCENT,
            alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        },
        tickBoxOn: { backgroundColor: EVENT_ACCENT },
        tickMark: { color: '#fff', fontSize: 14, fontWeight: '900', lineHeight: 16 },
        tickLabel: { flex: 1, fontSize: 15, color: colors.text.body },
        saveBtn: {
            minHeight: 48, borderRadius: 12, backgroundColor: EVENT_ACCENT, alignItems: 'center',
            justifyContent: 'center', marginTop: 8, paddingHorizontal: 12,
        },
        saveBtnText: { fontSize: 15, fontWeight: '800', color: '#fff' },
        resetBtn: { minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
        resetBtnText: { fontSize: 15, fontWeight: '700', color: EVENT_ACCENT },
    });
