/**
 * The event form's "Repeats" and "Until" (DESIGN-event-times §3, §8), on the phone. The choices are computed from the first
 * date the host picked (@beanpool/core repeatChoicesFor), the same words the web app's select offers; nothing to type. One
 * row per choice (a radio list: no native picker to fight at 320 dp and 1.3× text). Until is optional (blank = until the host
 * cancels it), on or after the first date, at most five years out, shown with its year ("15 Dec 2028", as the caption
 * has it); the date picker opens only when tapped. A date as long as the gap to the next is said here before Save, in the
 * node's sentence. A stored rule the form can't make ('other': every 3 months) is named in a plain line, "Every 3 months on
 * the 16th — kept unless you choose another", with its Until as on the web, and asks for a choice in red only once the date
 * moves (the deciding review of #1993, N3, N4, N7; its confirmation, NB1).
 */

import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import {
    deviceLocalClock, repeatCaption, repeatChoicesFor, repeatLengthProblem, repeatSkipNote, repeatUntilLabel, repeatUntilMax, repeatUntilProblem, t,
    type RepeatChoiceKey, type RepeatPattern,
} from '@beanpool/core';
import { useStyles, type ThemeContextType } from '../app/ThemeContext';
import { eventFormMinutes } from '../utils/events';

interface Props {
    /** The form's Starts (the host's clock in the device getters); null before one is picked. */
    start: Date | null;
    /** The form's Ends (null = the default two hours), for the length check. */
    end?: Date | null;
    repeat: RepeatChoiceKey;
    until: string;
    onRepeatChange: (key: RepeatChoiceKey) => void;
    onUntilChange: (date: string) => void;
    /** On an edit: the rule as stored and the first date it had, so one the form can't make is named and kept (null when creating). */
    kept?: { firstDate: string; rule: Partial<RepeatPattern> | null } | null;
}

function dateAt(date: string): Date {
    return new Date(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), 12, 0);
}

export function EventRepeatFields({ start, end = null, repeat, until, onRepeatChange, onUntilChange, kept = null }: Props) {
    const styles = useStyles(makeStyles);
    const [picking, setPicking] = useState(false);
    const firstDate = start ? deviceLocalClock(start).slice(0, 10) : '';
    const choices = repeatChoicesFor(firstDate);
    // A choice the new first date does not offer stays chosen and says so, rather than turning into "Does not repeat".
    const offered = choices.some(c => c.key === repeat);
    // A rule the form can't make, on its own date: said in words and kept, in plain text; red only once the date moves.
    const keptWords = repeat === 'other' && !!kept && kept.firstDate === firstDate ? repeatCaption(kept.rule) : '';
    const asks = !offered && !keptWords;
    const note = offered ? repeatSkipNote(repeat, firstDate) : null;
    const lengthProblem = offered ? repeatLengthProblem(repeat, firstDate, eventFormMinutes(start, end)) : null;
    const untilProblem = repeat !== 'never' && (offered || !!keptWords) ? repeatUntilProblem(until, firstDate) : null;
    const untilWords = until ? repeatUntilLabel(until) || until : t('Until I cancel it');

    const onPicked = (e: DateTimePickerEvent, d?: Date) => {
        setPicking(Platform.OS === 'ios');
        if (e.type === 'set' && d) onUntilChange(deviceLocalClock(d).slice(0, 10));
    };

    return (
        <View testID="event-repeat-fields" style={styles.box}>
            <Text style={styles.label}>{t('REPEATS')}</Text>
            <View accessibilityRole="radiogroup">
                {choices.map(c => {
                    const on = c.key === repeat;
                    return (
                        <Pressable key={c.key} testID={`event-repeat-${c.key}`} onPress={() => onRepeatChange(c.key)} style={styles.row}
                            accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={c.label}>
                            <View style={[styles.dot, on && styles.dotOn]} />
                            <Text style={[styles.rowText, on && styles.rowTextOn]}>{c.label}</Text>
                        </Pressable>
                    );
                })}
            </View>
            {!!note && <Text testID="event-repeat-note" style={styles.helper}>{note}</Text>}
            {!!keptWords && <Text testID="event-repeat-kept" style={styles.helper}>{t('{repeats} — kept unless you choose another', { repeats: keptWords })}</Text>}
            {asks && <Text testID="event-repeat-problem" style={styles.problem} accessibilityRole="alert">{t('Choose how the event repeats from the list')}</Text>}
            {!!lengthProblem && <Text testID="event-repeat-length-problem" style={styles.problem} accessibilityRole="alert">{lengthProblem}</Text>}
            {repeat !== 'never' && (
                <View style={styles.untilBox}>
                    <Text style={styles.label}>{t('UNTIL')}</Text>
                    <View style={styles.untilRow}>
                        <Pressable testID="event-repeat-until" onPress={() => setPicking(true)} style={styles.untilBtn}
                            accessibilityRole="button" accessibilityLabel={t('Until: {date}. Change', { date: untilWords })}>
                            <Text style={styles.untilText}>{untilWords}</Text>
                        </Pressable>
                        {!!until && (
                            <Pressable testID="event-repeat-until-clear" onPress={() => onUntilChange('')} style={styles.clearBtn}
                                accessibilityRole="button" accessibilityLabel={t('Clear: repeat until I cancel it')}>
                                <Text style={styles.clearText}>{t('Clear')}</Text>
                            </Pressable>
                        )}
                    </View>
                    {!!untilProblem && <Text testID="event-repeat-until-problem" style={styles.problem} accessibilityRole="alert">{untilProblem}</Text>}
                    {picking && (
                        <DateTimePicker
                            value={until ? dateAt(until) : dateAt(firstDate)}
                            mode="date"
                            minimumDate={dateAt(firstDate)}
                            maximumDate={dateAt(repeatUntilMax(firstDate))}
                            onChange={onPicked}
                        />
                    )}
                </View>
            )}
        </View>
    );
}

const makeStyles = ({ colors }: ThemeContextType) =>
    StyleSheet.create({
        box: { marginBottom: 12 },
        label: { fontSize: 13, fontWeight: '700', color: colors.text.secondary, letterSpacing: 0.5, marginBottom: 6 },
        row: { flexDirection: 'row', alignItems: 'center', minHeight: 44, columnGap: 10 },
        dot: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: colors.text.secondary },
        dotOn: { borderColor: colors.accent.primary, backgroundColor: colors.accent.fill },
        rowText: { flex: 1, fontSize: 15, color: colors.text.body },
        rowTextOn: { fontWeight: '700' },
        helper: { fontSize: 14, color: colors.text.secondary, marginTop: 4 },
        problem: { fontSize: 13, fontWeight: '600', color: colors.feedback.danger.fg, marginTop: 4 },
        untilBox: { marginTop: 10 },
        untilRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 12 },
        untilBtn: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 14, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.card },
        untilText: { fontSize: 15, fontWeight: '600', color: colors.text.body },
        clearBtn: { minHeight: 48, justifyContent: 'center' },
        clearText: { fontSize: 15, fontWeight: '700', color: colors.text.link, textDecorationLine: 'underline' },
    });
