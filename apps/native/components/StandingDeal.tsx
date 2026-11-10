/**
 * A standing deal on the phone (DESIGN-standing-deals-fable §2.2; slice S2, with the web's components/StandingDeal.tsx): the
 * take-up screen a payer agrees on, and the panel each side sees while it runs. Every line is core's (standingTakeUpLines,
 * standingPanel, standingStopConfirm), so the two apps say the same thing; these only draw them, from the central colour
 * tokens, wrapping at 320 dp and 1.3× text.
 */
import React, { useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import {
    STANDING_PICK_DAYS, STANDING_PICK_MAX, formatDate, standingPanel, standingStartAt, standingStopConfirm, standingTakeUpLines, t,
    type StandingDealRow, type StandingPeriodUnit,
} from '@beanpool/core';
import { useTheme } from '../app/ThemeContext';

const day = (iso: string) => formatDate(new Date(iso), 'day-month');

/** What the payer chose: a count of periods (null: until one of them stops it) and when the first period starts (ms). */
export interface StandingChoice { periods: number | null; startsAt: number }

function useStandingStyles() {
    const { colors } = useTheme();
    return useMemo(() => StyleSheet.create({
        box: { backgroundColor: colors.surface.card, borderRadius: 16, padding: 16, marginTop: 8, borderWidth: 1, borderColor: colors.border.default, gap: 12 },
        title: { color: colors.text.body, fontSize: 15, fontWeight: '800', textAlign: 'center' },
        summary: { color: colors.text.secondary, fontSize: 14, textAlign: 'center' },
        label: { color: colors.text.muted, fontSize: 11, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase' },
        row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
        radio: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, flexShrink: 1 },
        dot: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: colors.brand.primary, alignItems: 'center', justifyContent: 'center' },
        dotOn: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.brand.primary },
        radioText: { color: colors.text.body, fontSize: 14, flexShrink: 1 },
        step: { width: 44, height: 44, borderRadius: 10, borderWidth: 1, borderColor: colors.border.strong, alignItems: 'center', justifyContent: 'center' },
        stepText: { color: colors.text.body, fontSize: 20, fontWeight: '800' },
        note: { backgroundColor: colors.surface.app, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, padding: 12, gap: 8 },
        noteBold: { color: colors.text.body, fontSize: 13, fontWeight: '700' },
        noteText: { color: colors.text.secondary, fontSize: 13, lineHeight: 19 },
        buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
        quiet: { flexGrow: 1, flexBasis: 120, minHeight: 44, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.card, alignItems: 'center', justifyContent: 'center' },
        quietText: { color: colors.text.secondary, fontSize: 14, fontWeight: '700', textAlign: 'center' },
        go: { flexGrow: 1, flexBasis: 140, minHeight: 44, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12, backgroundColor: colors.brand.fill, alignItems: 'center', justifyContent: 'center' },
        goText: { color: colors.text.inverse, fontSize: 14, fontWeight: '800', textAlign: 'center' },
        panel: { marginTop: 12, borderRadius: 16, padding: 14, borderWidth: 1, gap: 6, backgroundColor: colors.feedback.success.bg, borderColor: colors.feedback.success.border },
        panelShort: { backgroundColor: colors.feedback.warning.bg, borderColor: colors.feedback.warning.border },
        panelTitle: { color: colors.text.body, fontSize: 14, fontWeight: '800' },
        panelStatus: { color: colors.text.secondary, fontSize: 14, lineHeight: 20 },
        panelWarn: { color: colors.feedback.warning.fg, fontWeight: '800' },
        small: { color: colors.text.muted, fontSize: 12, lineHeight: 17 },
    }), [colors]);
}

function Radio({ on, label, onPress, testID, s }: { on: boolean; label: string; onPress: () => void; testID?: string; s: ReturnType<typeof useStandingStyles> }) {
    return (
        <Pressable accessibilityRole="radio" accessibilityState={{ checked: on }} style={s.radio} onPress={onPress} testID={testID}>
            <View style={s.dot}>{on && <View style={s.dotOn} />}</View>
            <Text style={s.radioText}>{label}</Text>
        </Pressable>
    );
}

function Step({ label, glyph, disabled, onPress, s }: { label: string; glyph: string; disabled: boolean; onPress: () => void; s: ReturnType<typeof useStandingStyles> }) {
    return (
        <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={[s.step, disabled && { opacity: 0.4 }]}>
            <Text style={s.stepText} aria-hidden={true} accessibilityElementsHidden={true} importantForAccessibility="no">{glyph}</Text>
        </Pressable>
    );
}

/**
 * Take this up? (§2.2): how long (until stopped, or for k periods) and when it starts (today, or up to 30 days ahead), what is
 * held now and how it runs, then Agree. `now` is for tests.
 */
export function StandingTakeUp({ unit, beans, title, payeeName, busy, onCancel, onAgree, now, room }: {
    unit: StandingPeriodUnit; beans: number; title: string; payeeName: string; busy: boolean;
    onCancel: () => void; onAgree: (choice: StandingChoice) => void; now?: number;
    /** The payer's usable room (balance less their usable floor), when known: short of the first period, Agree is disabled. */
    room?: number | null;
}) {
    const s = useStandingStyles();
    const [untilStopped, setUntilStopped] = useState(true);
    const [periods, setPeriods] = useState(6);
    const [later, setLater] = useState(false);
    const [daysAhead, setDaysAhead] = useState(1);
    // The start is worked out again at Agree: the node refuses one more than 10 minutes old (checkStandingStart), and a member
    // may come back to this screen from the background long after it opened. The lines show the start as of now.
    const startAt = () => standingStartAt(now ?? Date.now(), later ? daysAhead : 0);
    const l = standingTakeUpLines({ unit, beans, title, payeeName, startsAt: startAt(), periods, room }, day);
    const off = busy || !!l.noRoom;
    return (
        <View style={s.box} testID="standing-take-up">
            <Text style={s.title}>{l.title}</Text>
            <Text style={s.summary}>{l.summary}</Text>
            <View>
                <Text style={s.label}>{l.howLong}</Text>
                <Radio s={s} on={untilStopped} label={l.untilStopped} onPress={() => setUntilStopped(true)} />
                <View style={s.row}>
                    <Radio s={s} on={!untilStopped} label={l.forPeriods} onPress={() => setUntilStopped(false)} testID="standing-periods" />
                    {!untilStopped && (
                        <View style={s.row}>
                            <Step s={s} label={l.fewer} glyph="−" disabled={periods <= 1} onPress={() => setPeriods(p => Math.max(1, p - 1))} />
                            <Step s={s} label={l.more} glyph="+" disabled={periods >= STANDING_PICK_MAX} onPress={() => setPeriods(p => Math.min(STANDING_PICK_MAX, p + 1))} />
                        </View>
                    )}
                </View>
            </View>
            <View>
                <Text style={s.label}>{l.startLabel}</Text>
                <Radio s={s} on={!later} label={l.startToday} onPress={() => setLater(false)} />
                <View style={s.row}>
                    <Radio s={s} on={later} label={later ? l.startOn : l.startAhead} onPress={() => setLater(true)} testID="standing-start-on" />
                    {later && (
                        <View style={s.row}>
                            <Step s={s} label={l.earlier} glyph="−" disabled={daysAhead <= 1} onPress={() => setDaysAhead(d => Math.max(1, d - 1))} />
                            <Step s={s} label={l.later} glyph="+" disabled={daysAhead >= STANDING_PICK_DAYS} onPress={() => setDaysAhead(d => Math.min(STANDING_PICK_DAYS, d + 1))} />
                        </View>
                    )}
                </View>
            </View>
            <View style={s.note}>
                <Text style={s.noteBold} testID="standing-held-now">{l.paidNow}</Text>
                <Text style={s.noteText}>{l.howItRuns}</Text>
                <Text style={s.noteText}>{l.shortAhead}</Text>
            </View>
            {l.noRoom && <Text style={[s.noteBold, s.panelWarn, { textAlign: 'center' }]} testID="standing-no-room" accessibilityLiveRegion="polite">{l.noRoom}</Text>}
            <View style={s.buttons}>
                <Pressable accessibilityRole="button" style={s.quiet} onPress={onCancel} disabled={busy}>
                    <Text style={s.quietText}>{t('Cancel')}</Text>
                </Pressable>
                <Pressable accessibilityRole="button" accessibilityState={{ disabled: off }} testID="standing-agree" style={[s.go, off && { opacity: 0.6 }]} disabled={off}
                    onPress={() => onAgree({ periods: untilStopped ? null : periods, startsAt: startAt() })}>
                    <Text style={s.goText}>{l.agree}</Text>
                </Pressable>
            </View>
        </View>
    );
}

/**
 * One standing deal still running, for one of its sides (`actingAs`: the member, or the enterprise they keep): since when and
 * for how much, where it is now (the payer's short-funds banner names the day the grace ends), and Stop and Message where
 * core says so. Stop asks first, in core's words for this side and phase. Nothing of a standing deal is held, so it has no
 * Release, Cancel or Hold back (DESIGN-standing-deals-upfront-fable §3).
 */
export function StandingPanel({ tx, actingAs, busy, onStop, onMessage, messageLabel }: {
    tx: StandingDealRow; actingAs: string; busy: boolean;
    onStop: () => void; onMessage?: () => void; messageLabel?: string;
}) {
    const s = useStandingStyles();
    const p = standingPanel(tx, actingAs, day);
    if (!p) return null;
    const ask = () => {
        const c = standingStopConfirm(tx, actingAs, day);
        Alert.alert(c.title, c.body, [{ text: c.no, style: 'cancel' }, { text: c.yes, style: 'destructive', onPress: onStop }]);
    };
    return (
        <View testID={`standing-panel-${tx.id}`} style={[s.panel, p.warning && s.panelShort]}>
            <Text style={s.panelTitle}>{p.title}</Text>
            <Text testID="standing-status" accessibilityRole={p.warning ? 'alert' : undefined} style={[s.panelStatus, p.warning && s.panelWarn]}>{p.status}</Text>
            {!!p.lastLine && <Text style={s.small}>{p.lastLine}</Text>}
            {!!p.periodOf && <Text style={s.small}>{p.periodOf}</Text>}
            {(p.stop || !!onMessage) && (
                <View style={[s.buttons, { marginTop: 4 }]}>
                    {p.stop && (
                        <Pressable accessibilityRole="button" testID="standing-stop" style={s.quiet} disabled={busy} onPress={ask}>
                            <Text style={s.quietText}>{p.stopLabel}</Text>
                        </Pressable>
                    )}
                    {!!onMessage && !!messageLabel && (
                        <Pressable accessibilityRole="button" style={s.quiet} disabled={busy} onPress={onMessage}>
                            <Text style={s.quietText}>{messageLabel}</Text>
                        </Pressable>
                    )}
                </View>
            )}
        </View>
    );
}
