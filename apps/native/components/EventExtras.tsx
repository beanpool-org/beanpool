/**
 * The three things an event screen offers once it is in your diary: Share, Add to calendar, and Remind me.
 *
 * Share and Add to calendar need no node at all — the link is built from the community's own address and
 * the calendar entry from the event in hand — so they are there whatever the node's age. Remind me DOES
 * need the new routes, and a node that does not have them answers 404; the row then removes itself without
 * a word, because a member on an older community should see an event screen that simply has no reminders,
 * not an error about a feature they never asked for.
 *
 * Add to calendar offers a choice between a calendar file (.ics) for any calendar app, and Google Calendar.
 * On Android, the file option writes the .ics to cache, gets a content URI (FileSystem.getContentUriAsync),
 * and starts ACTION_VIEW with type text/calendar and read permission through expo-intent-launcher (which adds
 * a native module for the 1.2.85 native build). If no calendar app answers, it falls back to expo-sharing so
 * the member can still save or share the file, telling them plainly. On iOS, the file option hands the .ics
 * to expo-sharing, which iOS opens straight into "Add to Calendar". Google Calendar opens its template URL
 * on both platforms.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Share, Alert, Linking, Platform, ActivityIndicator, Modal } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Sharing from 'expo-sharing';
import { useStyles, type ThemeContextType } from '../app/ThemeContext';
import { fetchMemberPreferences, fetchMyEvents, isRouteMissing, setEventReminder } from '../utils/db';
import { eventShareWhen } from '../utils/events';
import {
    DEFAULT_REMINDER_OFFSETS, REMINDER_OFFSETS, REMINDER_PREF_KEY, buildIcs, buildShareText, eventLink,
    googleCalendarUrl, icsFileName, normaliseReminderOffsets, parseReminderOffsets, type ShareableEvent,
} from '../utils/event-extras';
import { t, tn } from '@beanpool/core';
import { EVENT_ACCENT } from './EventCard';
import { Sentence } from './Sentence';
import { ShareOutsideButton } from './SharePost';
import { reminderBeforeWords } from './settings/settings-lines';
import { eventLineWords } from './event-lines';

/** One offset on its own ("1 week"), as utils/event-extras.ts reminderOffsetLabel writes it, in the member's language. */
function offsetWords(minutes: number): string {
    switch (minutes) {
        case 10080: return t('1 week');
        case 1440: return t('1 day');
        case 120: return t('2 hours');
        case 60: return t('1 hour');
        case 30: return t('30 minutes');
        default: return tn(minutes, '{n} minutes', '{n} minutes');
    }
}

/**
 * utils/event-extras.ts formatReminderChoice in the member's language, whole sentences: "Off", "1 day before (your
 * default)", "1 week and 2 hours before", "1 week, 1 day and 30 minutes before". English reads exactly as it does.
 */
export function reminderChoiceWords(offsets: number[] | null, fallback: number[] = DEFAULT_REMINDER_OFFSETS): string {
    const clean = normaliseReminderOffsets(offsets ?? fallback);
    let choice: string;
    if (clean.length === 0) choice = t('Off', undefined, 'reminder');
    else if (clean.length === 1) choice = reminderBeforeWords(clean[0]);
    else {
        const parts = clean.map(offsetWords);
        let list = parts[0];
        for (const item of parts.slice(1, -1)) list = t('{list}, {item}', { list, item });
        choice = t('{list} and {last} before', { list, last: parts[parts.length - 1] });
    }
    return offsets === null ? t('{choice} (your default)', { choice }) : choice;
}

/** The event as the share text and the calendar entry need it, from either row shape. */
export function shareableEvent(post: any): ShareableEvent {
    return {
        id: post.id,
        title: post.title || t('Event'),
        startAt: post.eventStartAt ?? post.event_start_at ?? '',
        endAt: post.eventEndAt ?? post.event_end_at ?? null,
        placeName: post.eventPlaceName ?? post.event_place_name ?? null,
        description: post.description || null,
        tz: post.eventTz ?? post.event_tz ?? null,
    };
}

async function anchorOrThrow(): Promise<string> {
    const url = await AsyncStorage.getItem('beanpool_anchor_url');
    if (!url) throw new Error(t('You are currently offline.'));
    return url;
}

export function EventShareAndCalendar({ post }: { post: any }) {
    const styles = useStyles(makeStyles);
    const event = shareableEvent(post);
    // Labelled with the place's zone ("Sat 17 Oct, 20:50 Lagos time"), so it is right wherever it is pasted (§4).
    const when = eventShareWhen(post);
    const [choiceOpen, setChoiceOpen] = useState(false);

    const share = async () => {
        try {
            const link = eventLink(await anchorOrThrow(), event.id);
            await Share.share({ message: buildShareText(event, when, link), title: event.title });
        } catch (e: any) {
            Alert.alert(t('Not shared'), e?.message || t('Could not share this event.'));
        }
    };

    const addCalendarFile = async () => {
        setChoiceOpen(false);
        try {
            const link = eventLink(await anchorOrThrow(), event.id);
            const path = `${FileSystem.cacheDirectory}${icsFileName(event)}`;
            await FileSystem.writeAsStringAsync(path, buildIcs(event, link), { encoding: FileSystem.EncodingType.UTF8 });
            if (Platform.OS === 'ios') {
                await Sharing.shareAsync(path, { mimeType: 'text/calendar', UTI: 'com.apple.ical.ics', dialogTitle: t('Add to calendar') });
                return;
            }
            try {
                const contentUri = await FileSystem.getContentUriAsync(path);
                await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
                    data: contentUri,
                    type: 'text/calendar',
                    flags: 1,
                });
            } catch {
                Alert.alert(t('No calendar app'), t('Nothing on this phone could open a calendar entry.'));
                await Sharing.shareAsync(path, { mimeType: 'text/calendar', dialogTitle: t('Add to calendar') });
            }
        } catch (e: any) {
            Alert.alert(t('Not added'), e?.message || t('Could not make a calendar entry.'));
        }
    };

    const addGoogleCalendar = async () => {
        setChoiceOpen(false);
        try {
            const link = eventLink(await anchorOrThrow(), event.id);
            const url = googleCalendarUrl(event, link);
            const opened = await Linking.openURL(url).then(() => true).catch(() => false);
            if (!opened) Alert.alert(t('No calendar app'), t('Nothing on this phone could open a calendar entry.'));
        } catch (e: any) {
            Alert.alert(t('Not added'), e?.message || t('Could not make a calendar entry.'));
        }
    };

    return (
        <View>
            <View style={styles.row}>
                <Pressable onPress={share} style={styles.btn} accessibilityRole="button" accessibilityLabel={t('Share this event')}>
                    <Text style={styles.btnText} numberOfLines={1} maxFontSizeMultiplier={1.3} adjustsFontSizeToFit minimumFontScale={0.7}>{t('🔗 Share')}</Text>
                </Pressable>
                <Pressable onPress={() => setChoiceOpen(true)} style={styles.btn} accessibilityRole="button" accessibilityLabel={t('Add this event to your calendar')}>
                    <Text style={styles.btnText} numberOfLines={1} maxFontSizeMultiplier={1.3} adjustsFontSizeToFit minimumFontScale={0.7}>{t('📅 Add to calendar')}</Text>
                </Pressable>
            </View>
            {/* Outside the community (front doors S6): a link to this event alone, for seven days, without names or faces. */}
            <ShareOutsideButton post={post} />

            <Modal
                visible={choiceOpen}
                transparent
                animationType="fade"
                onRequestClose={() => setChoiceOpen(false)}
                statusBarTranslucent
            >
                <View style={styles.sheetBackdrop}>
                    <Pressable
                        style={StyleSheet.absoluteFill}
                        onPress={() => setChoiceOpen(false)}
                        accessibilityRole="button"
                        accessibilityLabel={t('Close calendar choices')}
                    />
                    <View style={styles.sheetCard}>
                        <Text style={styles.sheetTitle} accessibilityRole="header">{t('Add to calendar')}</Text>
                        <Pressable
                            onPress={addCalendarFile}
                            style={({ pressed }) => [styles.sheetItem, pressed && styles.sheetItemPressed]}
                            accessibilityRole="button"
                            accessibilityLabel={t('Calendar file (.ics) for any calendar app')}
                            testID="event-add-calendar-file"
                        >
                            <Text style={styles.sheetItemText} numberOfLines={1} maxFontSizeMultiplier={1.3}>{t('Calendar file (.ics)')}</Text>
                            <Text style={styles.sheetItemSubtext} numberOfLines={1} maxFontSizeMultiplier={1.3}>{t('For any calendar app')}</Text>
                        </Pressable>
                        <Pressable
                            onPress={addGoogleCalendar}
                            style={({ pressed }) => [styles.sheetItem, pressed && styles.sheetItemPressed]}
                            accessibilityRole="button"
                            accessibilityLabel={t('Google Calendar')}
                            testID="event-add-google-calendar"
                        >
                            <Text style={styles.sheetItemText} numberOfLines={1} maxFontSizeMultiplier={1.3}>{t('Google Calendar')}</Text>
                        </Pressable>
                        <Pressable
                            onPress={() => setChoiceOpen(false)}
                            style={({ pressed }) => [styles.sheetCancelBtn, pressed && styles.sheetItemPressed]}
                            accessibilityRole="button"
                            accessibilityLabel={t('Cancel')}
                            testID="event-add-calendar-cancel"
                        >
                            <Text style={styles.sheetCancelText} numberOfLines={1} maxFontSizeMultiplier={1.3}>{t('Cancel')}</Text>
                        </Pressable>
                    </View>
                </View>
            </Modal>
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
            Alert.alert(t('Reminder not saved'), e?.message ? eventLineWords(e.message) : t('Could not reach the node.'));
        } finally {
            setSaving(false);
        }
    };

    return (
        <View style={styles.reminderBox}>
            <View style={styles.reminderHeadRow}>
                <Text style={styles.reminderLine} numberOfLines={3}>
                    <Sentence text={t('⏰ Remind me: {choice}')} parts={{ choice: <Text style={styles.reminderChoice}>{reminderChoiceWords(offsets, defaults)}</Text> }} />
                </Text>
                <Pressable
                    onPress={() => { if (!open) setDraft(offsets ?? defaults); setOpen(o => !o); }}
                    style={styles.smallBtn}
                    accessibilityRole="button"
                    accessibilityLabel={open ? t('Close reminder choices') : t('Change the reminder for this event')}
                    accessibilityState={{ expanded: open }}
                >
                    <Text style={styles.smallBtnText} numberOfLines={1} maxFontSizeMultiplier={1.3}>{open ? t('Close') : t('Change')}</Text>
                </Pressable>
            </View>

            {open && (
                <View>
                    <Text style={styles.reminderHint}>{t('Tell me before it starts. With none ticked you get no reminder for this event.')}</Text>
                    {REMINDER_OFFSETS.map(minutes => {
                        const on = draft.includes(minutes);
                        return (
                            <Pressable
                                key={minutes}
                                onPress={() => setDraft(d => (on ? d.filter(m => m !== minutes) : [...d, minutes]))}
                                style={styles.tickRow}
                                accessibilityRole="checkbox"
                                accessibilityLabel={reminderBeforeWords(minutes)}
                                accessibilityState={{ checked: on }}
                            >
                                <View style={[styles.tickBox, on && styles.tickBoxOn]}>
                                    {on && <Text style={styles.tickMark}>✓</Text>}
                                </View>
                                <Text style={styles.tickLabel} numberOfLines={2}>{reminderBeforeWords(minutes)}</Text>
                            </Pressable>
                        );
                    })}
                    <Pressable
                        onPress={() => save(draft)}
                        disabled={saving}
                        style={styles.saveBtn}
                        accessibilityRole="button"
                        accessibilityLabel={saving ? t('Saving reminder for this event...') : t('Save for this event')}
                        accessibilityState={{ busy: saving, disabled: saving }}
                    >
                        {saving ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.saveBtnText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{t('Save for this event')}</Text>}
                    </Pressable>
                    {offsets !== null && (
                        <Pressable
                            onPress={() => save(null)}
                            disabled={saving}
                            style={styles.resetBtn}
                            accessibilityRole="button"
                            accessibilityLabel={t('Use my default reminder for this event')}
                        >
                            <Text style={styles.resetBtnText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{t('Use my default')}</Text>
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
        sheetBackdrop: {
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.45)',
            justifyContent: 'flex-end',
        },
        sheetCard: {
            backgroundColor: colors.surface.card,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            paddingTop: 16,
            paddingBottom: 28,
            paddingHorizontal: 16,
        },
        sheetTitle: {
            fontSize: 16,
            fontWeight: '800',
            color: colors.text.heading,
            marginBottom: 12,
            paddingHorizontal: 4,
        },
        sheetItem: {
            minHeight: 52,
            justifyContent: 'center',
            paddingVertical: 8,
            paddingHorizontal: 12,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: colors.border.default,
            marginBottom: 8,
            backgroundColor: colors.surface.card,
        },
        sheetItemPressed: {
            backgroundColor: colors.surface.subtle,
        },
        sheetItemText: {
            fontSize: 15,
            fontWeight: '700',
            color: colors.text.heading,
        },
        sheetItemSubtext: {
            fontSize: 13,
            fontWeight: '500',
            color: colors.text.secondary,
            marginTop: 2,
        },
        sheetCancelBtn: {
            minHeight: 48,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 12,
            marginTop: 4,
        },
        sheetCancelText: {
            fontSize: 15,
            fontWeight: '700',
            color: EVENT_ACCENT,
        },
    });
