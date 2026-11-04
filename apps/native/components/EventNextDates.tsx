/**
 * A repeating event's "Next dates" on its detail screen (DESIGN-event-times §4, §8): the dates the node sends on a by-id read
 * (`eventNextDates`, cancelled ones marked). For the host, beside each: "Cancel this date" (POST skip) or, for a cancelled one,
 * "Bring it back" (DELETE), and "Change this date only", which cancels the date and opens the copy form with the line "Moved
 * from the regular Friday". Cancelling the current date moves the event on at once, and the screen says so as the node tells
 * those going: "Fri 16 Oct is cancelled. Next: Fri 23 Oct". The node lists a cancelled date the event has passed first, until
 * it has ended, so its "Bring it back" is there after a reload and on every device (the node moves the event back and tells
 * those going "Fri 16 Oct is back on"; the deciding review of #1993, N2, and its confirmation 2, NB2); the screen drops it at
 * its end. Each control's name starts with the words it shows (WCAG 2.5.3). The web app's EventNextDates, the same.
 */

import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, Alert, StyleSheet } from 'react-native';
import { repeatRefusalText, seriesBackOnLine, seriesCancelledLine, seriesDateLabel, seriesDatesShown, seriesPassedDateEndMs, t, tn } from '@beanpool/core';
import { useStyles, type ThemeContextType } from '../app/ThemeContext';
import { setEventDateCancelled } from '../utils/db';
import { eventLineWords } from './event-lines';

/** One of a series' next dates. `endAt` from a node with confirmation 2 of #1993: a cancelled date the event has passed is listed until then. */
export interface EventNextDate { date: string; startLocal: string; startAt: string; endAt?: string; cancelled: boolean }

interface Props {
    /** The node's view of the event (by id): it carries `eventNextDates`. */
    post: any;
    isHost: boolean;
    onChanged?: (post: any) => void;
    onChangeThisDateOnly?: (post: any, date: string) => void;
    /** For the render tests: the confirm step, which is Alert on a phone. */
    confirm?: (title: string, message: string, onYes: () => void) => void;
    /**
     * The event page's form (DESIGN-detail-pages-fable.md: the action on the first screen): the first date and "and 5 more",
     * one button that opens the whole list, where the host's controls are. Six dates in full sit between the title and the
     * photo and push Going / Interested down by about 114 dp at 320 dp and 1.3× text (event-page-shell-render.test.ts).
     */
    compact?: boolean;
}

/** The longest a timer may wait (setTimeout's limit); a later end is checked again then. */
const MAX_WAIT_MS = 2_147_483_647;

function alertConfirm(title: string, message: string, onYes: () => void) {
    Alert.alert(title, message, [
        { text: t('Not now'), style: 'cancel' },
        { text: t('Yes'), style: 'destructive', onPress: onYes },
    ]);
}

export function EventNextDates({ post, isHost, onChanged, onChangeThisDateOnly, confirm = alertConfirm, compact = false }: Props) {
    const styles = useStyles(makeStyles);
    // Compact, the rest waits for a tap; once opened it stays open, so the host's line and controls stay where they acted.
    const [open, setOpen] = useState(!compact);
    const [busy, setBusy] = useState<string | null>(null);
    const [line, setLine] = useState<string | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const current: string | null = (post?.eventStartLocal ?? post?.event_start_local ?? '').slice(0, 10) || null;
    const listed: EventNextDate[] = Array.isArray(post?.eventNextDates) ? post.eventNextDates : [];
    // A cancelled date the event has passed goes from the list at its end: the node no longer takes it back then.
    const [tick, setTick] = useState(0);
    const passedEnd = seriesPassedDateEndMs(listed, current, Date.now());
    useEffect(() => {
        if (passedEnd == null) return;
        const id = setTimeout(() => setTick(n => n + 1), Math.min(MAX_WAIT_MS, passedEnd - Date.now() + 50));
        return () => clearTimeout(id);
    }, [passedEnd, tick]);
    const dates = seriesDatesShown(listed, current, Date.now());
    if (!post?.eventRepeat || dates.length === 0) return null;

    const change = async (date: string, cancel: boolean, thenMove = false) => {
        if (busy) return;
        setBusy(date);
        setProblem(null);
        setLine(null);
        try {
            const res = await setEventDateCancelled(post.id, date, cancel);
            if (cancel && date === current) setLine(seriesCancelledLine(date, res?.post?.eventStartLocal ?? null));
            else if (!cancel && current && date < current) setLine(seriesBackOnLine(date));
            if (res?.post) onChanged?.(res.post);
            if (thenMove) onChangeThisDateOnly?.(res?.post ?? post, date);
        } catch (e: any) {
            setProblem(eventLineWords(repeatRefusalText(e?.message)) || t('Could not change that date.'));
        } finally {
            setBusy(null);
        }
    };

    // Compact: the heading, the first date and how many more, one button that opens the list. One date has no more to open.
    if (!open && dates.length > 1) {
        const first = dates[0];
        return (
            <Pressable testID="event-next-dates-open" style={styles.compact} onPress={() => setOpen(true)}
                accessibilityRole="button" accessibilityState={{ expanded: false }}>
                <Text style={styles.heading}>{t('Next dates')}</Text>
                <View style={styles.listWrap}>
                    <View style={styles.row}>
                        <Text style={[styles.date, first.cancelled && styles.dateCancelled]}>{seriesDateLabel(first.date)}</Text>
                        {first.cancelled && <Text style={styles.cancelledTag}>{t('Cancelled')}</Text>}
                    </View>
                    <Text style={styles.linkText}>{tn(dates.length - 1, 'and {n} more', 'and {n} more')}</Text>
                </View>
            </Pressable>
        );
    }

    return (
        <View testID="event-next-dates" style={styles.box}>
            <Text style={styles.heading} accessibilityRole="header">{t('Next dates')}</Text>
            {!!line && <Text testID="event-date-cancelled-line" style={styles.line} accessibilityLiveRegion="polite">{line}</Text>}
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
        // A loud line's 4 below, as the when and the title have: the 48 dp button carries its own room round the words.
        compact: { minHeight: 48, justifyContent: 'center', marginBottom: 4 },
        heading: { fontSize: 13, fontWeight: '700', color: colors.text.secondary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
        line: { flexShrink: 1, fontSize: 15, fontWeight: '700', color: colors.text.body, marginBottom: 4 },
        listWrap: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 2 },
        listHost: { flexDirection: 'column', rowGap: 2 },
        row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 12, minWidth: 0 },
        date: { fontSize: 15, fontWeight: '700', color: colors.text.body },
        dateCancelled: { textDecorationLine: 'line-through', color: colors.text.secondary },
        cancelledTag: { fontSize: 12, fontWeight: '800', textTransform: 'uppercase', color: colors.feedback.danger.fg },
        // 48, the page's touch target (the 320 harness holds every button to it); drawn only once the list is open.
        link: { minHeight: 48, justifyContent: 'center' },
        linkText: { fontSize: 14, fontWeight: '700', color: colors.text.link, textDecorationLine: 'underline' },
        linkDanger: { fontSize: 14, fontWeight: '700', color: colors.feedback.danger.fg, textDecorationLine: 'underline' },
        problem: { fontSize: 13, fontWeight: '600', color: colors.feedback.danger.fg, marginTop: 4 },
    });
