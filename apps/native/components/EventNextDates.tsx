/**
 * A repeating event's "Next dates" on its detail screen (DESIGN-event-times §4, §8): the dates the node sends on a by-id read
 * (`eventNextDates`, the current one first, cancelled ones marked). For the host, beside each: "Cancel this date" (POST skip)
 * or, for a cancelled one, "Bring it back" (DELETE), and "Change this date only", which cancels the date and opens the copy
 * form with the line "Moved from the regular Friday". Cancelling the current date moves the event on at once, and the screen
 * says so as the node tells those going: "Fri 16 Oct is cancelled. Next: Fri 23 Oct", with "Bring it back" on that line until
 * the date has ended (the node moves the event back and tells those going "Fri 16 Oct is back on"; the deciding review of
 * #1993, N2). Each control's name starts with the words it shows (WCAG 2.5.3). The web app's EventNextDates, the same.
 */

import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, Alert, StyleSheet } from 'react-native';
import { repeatRefusalText, seriesBackOnLine, seriesCancelledLine, seriesDateLabel, t } from '@beanpool/core';
import { useStyles, type ThemeContextType } from '../app/ThemeContext';
import { setEventDateCancelled } from '../utils/db';

export interface EventNextDate { date: string; startLocal: string; startAt: string; cancelled: boolean }

interface Props {
    /** The node's view of the event (by id): it carries `eventNextDates`. */
    post: any;
    isHost: boolean;
    onChanged?: (post: any) => void;
    onChangeThisDateOnly?: (post: any, date: string) => void;
    /** For the render tests: the confirm step, which is Alert on a phone. */
    confirm?: (title: string, message: string, onYes: () => void) => void;
}

/** The longest a timer may wait (setTimeout's limit); a later end is checked again then. */
const MAX_WAIT_MS = 2_147_483_647;

/** The line after a change, and for a cancelled current date the date and when it ends: Bring it back until then. */
interface Line { text: string; restore?: { date: string; endsAtMs: number } }

function alertConfirm(title: string, message: string, onYes: () => void) {
    Alert.alert(title, message, [
        { text: t('Not now'), style: 'cancel' },
        { text: t('Yes'), style: 'destructive', onPress: onYes },
    ]);
}

export function EventNextDates({ post, isHost, onChanged, onChangeThisDateOnly, confirm = alertConfirm }: Props) {
    const styles = useStyles(makeStyles);
    const [busy, setBusy] = useState<string | null>(null);
    const [line, setLine] = useState<Line | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    // The cancelled date's Bring it back goes when the date ends: the node no longer takes it back then.
    const [tick, setTick] = useState(0);
    const endsAtMs = line?.restore?.endsAtMs;
    useEffect(() => {
        if (endsAtMs == null || Date.now() >= endsAtMs) return;
        const id = setTimeout(() => setTick(n => n + 1), Math.min(MAX_WAIT_MS, endsAtMs - Date.now() + 50));
        return () => clearTimeout(id);
    }, [endsAtMs, tick]);
    const dates: EventNextDate[] = Array.isArray(post?.eventNextDates) ? post.eventNextDates : [];
    if (!post?.eventRepeat || dates.length === 0) return null;
    const current: string | null = (post.eventStartLocal ?? post.event_start_local ?? '').slice(0, 10) || null;
    const restoreOpen = !!line?.restore && Date.now() < line.restore.endsAtMs;

    const change = async (date: string, cancel: boolean, thenMove = false) => {
        if (busy) return;
        setBusy(date);
        setProblem(null);
        setLine(null);
        // The current date's end, before the node moves the event on: until then it can be brought back.
        const endsAtMs = Date.parse(post.eventEndAt ?? post.event_end_at ?? '');
        try {
            const res = await setEventDateCancelled(post.id, date, cancel);
            if (cancel && date === current) {
                setLine({ text: seriesCancelledLine(date, res?.post?.eventStartLocal ?? null), ...(Number.isFinite(endsAtMs) ? { restore: { date, endsAtMs } } : {}) });
            } else if (!cancel && current && date < current) {
                setLine({ text: seriesBackOnLine(date) });
            }
            if (res?.post) onChanged?.(res.post);
            if (thenMove) onChangeThisDateOnly?.(res?.post ?? post, date);
        } catch (e: any) {
            setProblem(repeatRefusalText(e?.message) || t('Could not change that date.'));
        } finally {
            setBusy(null);
        }
    };

    return (
        <View testID="event-next-dates" style={styles.box}>
            <Text style={styles.heading} accessibilityRole="header">{t('Next dates')}</Text>
            {!!line && (
                <View style={styles.row}>
                    <Text testID="event-date-cancelled-line" style={styles.line} accessibilityLiveRegion="polite">{line.text}</Text>
                    {isHost && restoreOpen && !!line.restore && (
                        <Pressable testID="event-date-restore-current" disabled={!!busy} style={styles.link}
                            accessibilityRole="button" accessibilityLabel={t('Bring it back: {date}', { date: seriesDateLabel(line.restore.date) })}
                            onPress={() => { void change(line.restore!.date, false); }}>
                            <Text style={styles.linkText}>{t('Bring it back')}</Text>
                        </Pressable>
                    )}
                </View>
            )}
            <View style={isHost ? styles.listHost : styles.listWrap}>
                {dates.map(d => {
                    const label = seriesDateLabel(d.date);
                    return (
                        <View key={d.date} testID="event-next-date" style={styles.row}>
                            <Text style={[styles.date, d.cancelled && styles.dateCancelled]}>{label}</Text>
                            {d.cancelled && <Text style={styles.cancelledTag}>{t('Cancelled')}</Text>}
                            {isHost && !d.cancelled && (
                                <>
                                    <Pressable testID="event-date-cancel" disabled={!!busy} style={styles.link}
                                        accessibilityRole="button" accessibilityLabel={t('Cancel this date: {date}', { date: label })}
                                        onPress={() => confirm(t('Cancel this date'), t('Cancel {date}? Everyone going that day is told.', { date: label }), () => { void change(d.date, true); })}>
                                        <Text style={styles.linkDanger}>{t('Cancel this date')}</Text>
                                    </Pressable>
                                    {onChangeThisDateOnly && (
                                        <Pressable testID="event-date-move" disabled={!!busy} style={styles.link}
                                            accessibilityRole="button" accessibilityLabel={t('Change this date only: {date}', { date: label })}
                                            onPress={() => confirm(t('Change this date only'), t('Cancel {date} and make a one-off on another date?', { date: label }), () => { void change(d.date, true, true); })}>
                                            <Text style={styles.linkText}>{t('Change this date only')}</Text>
                                        </Pressable>
                                    )}
                                </>
                            )}
                            {isHost && d.cancelled && (
                                <Pressable testID="event-date-restore" disabled={!!busy} style={styles.link}
                                    accessibilityRole="button" accessibilityLabel={t('Bring it back: {date}', { date: label })}
                                    onPress={() => { void change(d.date, false); }}>
                                    <Text style={styles.linkText}>{t('Bring it back')}</Text>
                                </Pressable>
                            )}
                        </View>
                    );
                })}
            </View>
            {!!problem && <Text testID="event-next-dates-problem" style={styles.problem} accessibilityRole="alert">{problem}</Text>}
        </View>
    );
}

const makeStyles = ({ colors }: ThemeContextType) =>
    StyleSheet.create({
        box: { marginBottom: 12 },
        heading: { fontSize: 13, fontWeight: '700', color: colors.text.secondary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
        line: { flexShrink: 1, fontSize: 15, fontWeight: '700', color: colors.text.body, marginBottom: 4 },
        listWrap: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 2 },
        listHost: { flexDirection: 'column', rowGap: 2 },
        row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 12, minWidth: 0 },
        date: { fontSize: 15, fontWeight: '700', color: colors.text.body },
        dateCancelled: { textDecorationLine: 'line-through', color: colors.text.secondary },
        cancelledTag: { fontSize: 12, fontWeight: '800', textTransform: 'uppercase', color: colors.feedback.danger.fg },
        link: { minHeight: 44, justifyContent: 'center' },
        linkText: { fontSize: 14, fontWeight: '700', color: colors.text.link, textDecorationLine: 'underline' },
        linkDanger: { fontSize: 14, fontWeight: '700', color: colors.feedback.danger.fg, textDecorationLine: 'underline' },
        problem: { fontSize: 13, fontWeight: '600', color: colors.feedback.danger.fg, marginTop: 4 },
    });
