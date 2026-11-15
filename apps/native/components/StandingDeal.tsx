/**
 * A standing deal on the phone (DESIGN-standing-deals-fable §2.2; slice S2, with the web's components/StandingDeal.tsx): the
 * take-up screen a payer agrees on, and the panel each side sees while it runs. Every line is core's (standingTakeUpLines,
 * standingPanel, standingStopConfirm), so the two apps say the same thing; these only draw them, from the central colour
 * tokens, wrapping at 320 dp and 1.3× text.
 */
import React, { useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import {
    STANDING_PICK_DAYS, STANDING_PICK_MAX, formatDate, standingChangeId, standingPanel, standingSheet, standingStartAt, standingStopConfirm,
    standingTakeUpLines, standingTypedAmount, t,
    type StandingDealRow, type StandingPeriodUnit, type StandingSheet, type StandingSheetKind,
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
        // A short week (DESIGN-getting-paid-fable §3.2): the quiet link under the status, full width, 48 dp.
        link: { minHeight: 48, justifyContent: 'center', alignSelf: 'stretch' },
        // Body ink, underlined: it sits on the panel's green or amber tint in every theme, where a brand ink could fade.
        linkText: { color: colors.text.body, fontSize: 14, fontWeight: '700', textDecorationLine: 'underline' },
        askLine: { color: colors.text.body, fontSize: 14, lineHeight: 20, fontWeight: '600' },
        sheet: { backgroundColor: colors.surface.card, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: colors.border.default, gap: 10, marginTop: 4 },
        input: { minHeight: 44, borderRadius: 10, borderWidth: 1, borderColor: colors.border.strong, color: colors.text.body, backgroundColor: colors.surface.app, paddingHorizontal: 12, fontSize: 15 },
        refusal: { color: colors.feedback.warning.fg, fontSize: 13, fontWeight: '700', lineHeight: 19 },
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
export function StandingTakeUp({ unit, beans_c, title, payeeName, busy, onCancel, onAgree, now, room }: {
    /** Per period: the listing's price, whole hundredths of a Bean (the figure the authorisation signs). */
    unit: StandingPeriodUnit; beans_c: number; title: string; payeeName: string; busy: boolean;
    onCancel: () => void; onAgree: (choice: StandingChoice) => void; now?: number;
    /**
     * The payer's usable room (balance less their usable floor, whole hundredths: core standingRoomOf), when known: short of
     * the first period, Agree is disabled.
     */
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
    const l = standingTakeUpLines({ unit, beans: beans_c, title, payeeName, startsAt: startAt(), periods, room }, day);
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
                <Text style={s.noteText} testID="standing-ask-lower-hint">{l.askLower}</Text>
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
 * A short week's step as the panel hands it to its screen, which sends it (DESIGN-getting-paid-fable §3.1: the node's
 * POST /api/marketplace/standing/:id/lower, …/lower/:changeId/answer, …/withdraw). It resolves once the node has said yes,
 * or throws an Error whose message is the refusal in words: the panel shows it and says nothing happened that didn't.
 */
export type StandingLowerStep =
    | { move: 'lower'; standingId: string; changeId: string; periodNo: number; beans_c: number }
    | { move: 'answer'; standingId: string; changeId: string; yes: boolean }
    | { move: 'withdraw'; standingId: string; changeId: string };

/**
 * One lowering sheet (design §3.2), drawn from core's lines (standingSheet): the payer's ask and the payee's lowering offer
 * half, 0 and "Another amount"; the payee's answer, Yes or No. A refusal stays on the sheet, which stays open.
 */
function LowerSheet({ sheet, busy, error, onGo, onNo, onCancel, onMessage, messageLabel, s }: {
    sheet: StandingSheet; busy: boolean; error: string | null; onGo: (beans_c: number) => void; onNo: () => void; onCancel: () => void;
    onMessage?: () => void; messageLabel?: string; s: ReturnType<typeof useStandingStyles>;
}) {
    const [pick, setPick] = useState<number | 'other'>(sheet.choices.length ? 0 : 'other');
    const [typed, setTyped] = useState('');
    const typedAmount = standingTypedAmount(typed, sheet.amount_c, sheet.unit);
    const chosen = sheet.kind === 'answer' ? sheet.askBeans_c
        : pick === 'other' ? (typedAmount.ok ? typedAmount.beans_c : null) : sheet.choices[pick]?.beans_c ?? null;
    const off = busy || chosen === null;
    const cancel = (
        <Pressable accessibilityRole="button" testID="standing-sheet-cancel" style={s.quiet} disabled={busy} onPress={onCancel}>
            <Text style={s.quietText}>{sheet.cancel}</Text>
        </Pressable>
    );
    return (
        <View style={s.sheet} testID={`standing-sheet-${sheet.kind}`}>
            <Text style={s.title} accessibilityRole="header">{sheet.title}</Text>
            <Text style={s.summary}>{sheet.about}</Text>
            {!!sheet.instead && <Text style={[s.noteBold, { textAlign: 'center', fontSize: 15 }]} testID="standing-sheet-instead">{sheet.instead}</Text>}
            {sheet.kind !== 'answer' && (
                <View accessibilityRole="radiogroup">
                    {sheet.choices.map((c, i) => (
                        <Radio key={c.beans_c} s={s} on={pick === i} label={c.label} onPress={() => setPick(i)} testID={`standing-choice-${c.beans_c}`} />
                    ))}
                    {!!sheet.otherLabel && <Radio s={s} on={pick === 'other'} label={sheet.otherLabel} onPress={() => setPick('other')} testID="standing-choice-other" />}
                    {pick === 'other' && (
                        <TextInput testID="standing-other-amount" style={s.input} keyboardType="decimal-pad" value={typed} onChangeText={setTyped}
                            accessibilityLabel={sheet.otherLabel || undefined} />
                    )}
                    {pick === 'other' && !typedAmount.ok && !!typedAmount.line && (
                        <Text style={s.refusal} testID="standing-other-refusal" accessibilityLiveRegion="polite">{typedAmount.line}</Text>
                    )}
                </View>
            )}
            <View style={s.note}>
                {sheet.lines.map((line) => <Text key={line} style={s.noteText}>{line}</Text>)}
            </View>
            {!!error && <Text style={s.refusal} accessibilityRole="alert" accessibilityLiveRegion="polite" testID="standing-sheet-refusal">{error}</Text>}
            <View style={s.buttons}>
                {sheet.kind === 'answer' ? (
                    <Pressable accessibilityRole="button" testID="standing-sheet-no" style={s.quiet} disabled={busy} onPress={onNo}>
                        <Text style={s.quietText}>{sheet.no}</Text>
                    </Pressable>
                ) : cancel}
                <Pressable accessibilityRole="button" accessibilityState={{ disabled: off }} testID="standing-sheet-go" style={[s.go, off && { opacity: 0.6 }]}
                    disabled={off} onPress={() => { if (chosen !== null) onGo(chosen); }}>
                    <Text style={s.goText}>{sheet.go(chosen ?? sheet.amount_c)}</Text>
                </Pressable>
            </View>
            {sheet.kind === 'answer' && (
                <View style={s.buttons}>
                    {!!onMessage && !!messageLabel && (
                        <Pressable accessibilityRole="button" style={s.quiet} disabled={busy} onPress={onMessage}>
                            <Text style={s.quietText}>{messageLabel}</Text>
                        </Pressable>
                    )}
                    {cancel}
                </View>
            )}
        </View>
    );
}

/**
 * One standing deal still running, for one of its sides (`actingAs`: the member, or the enterprise they keep): since when and
 * for how much, where it is now (the payer's short-funds banner names the day the grace ends), and Stop and Message where
 * core says so. Stop asks first, in core's words for this side and phase. Nothing of a standing deal is held, so it has no
 * Release, Cancel or Hold back (DESIGN-standing-deals-upfront-fable §3). A short week (DESIGN-getting-paid-fable §3.2): the
 * quiet link under the status opens the payer's ask or the payee's lowering, and the open ask's line carries Take it back or
 * Answer, each from core (standingPanel, standingSheet), only where the screen gives `onLower` and the node takes a lowering.
 */
export function StandingPanel({ tx, actingAs, busy, onStop, onMessage, messageLabel, onLower }: {
    tx: StandingDealRow; actingAs: string; busy: boolean;
    onStop: () => void; onMessage?: () => void; messageLabel?: string;
    onLower?: (step: StandingLowerStep) => Promise<void>;
}) {
    const s = useStandingStyles();
    const [open, setOpen] = useState<{ kind: StandingSheetKind; changeId: string } | null>(null);
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const p = standingPanel(tx, actingAs, day);
    if (!p) return null;
    const ask = () => {
        const c = standingStopConfirm(tx, actingAs, day);
        Alert.alert(c.title, c.body, [{ text: c.no, style: 'cancel' }, { text: c.yes, style: 'destructive', onPress: onStop }]);
    };
    // Worked out again from the row on every draw: a sync that pays the period or closes the ask closes the sheet.
    const sheet = open && onLower ? standingSheet(tx, actingAs, open.kind, day) : null;
    const send = async (step: StandingLowerStep) => {
        if (!onLower || sending) return;
        setSending(true);
        setError(null);
        try {
            await onLower(step);
            setOpen(null);
        } catch (e: any) {
            setError(typeof e?.message === 'string' && e.message ? e.message : t('Try again'));
        } finally {
            setSending(false);
        }
    };
    // One change id per sheet opened, sent again on a retry, so a lost answer never makes a second ask.
    const openSheet = (kind: StandingSheetKind) => { setError(null); setOpen({ kind, changeId: standingChangeId() }); };
    const off = busy || sending;
    const askAction = p.askAction;
    return (
        <View testID={`standing-panel-${tx.id}`} style={[s.panel, p.warning && s.panelShort]}>
            <Text style={s.panelTitle}>{p.title}</Text>
            <Text testID="standing-status" accessibilityRole={p.warning ? 'alert' : undefined} style={[s.panelStatus, p.warning && s.panelWarn]}>{p.status}</Text>
            {!!onLower && !!p.askLine && (
                <View style={{ gap: 4 }}>
                    <Text testID="standing-ask-line" style={s.askLine}>{p.askLine}</Text>
                    {!!askAction && !sheet && (
                        <Pressable accessibilityRole="button" testID={`standing-ask-${askAction.move}`} style={[s.quiet, { alignSelf: 'flex-start', flexGrow: 0 }]} disabled={off}
                            onPress={() => {
                                if (askAction.move === 'answer') openSheet('answer');
                                else if (tx.standingAsk && tx.standingId) send({ move: 'withdraw', standingId: tx.standingId, changeId: tx.standingAsk.id });
                            }}>
                            <Text style={s.quietText}>{askAction.label}</Text>
                        </Pressable>
                    )}
                </View>
            )}
            {!!onLower && !!p.lowerLink && !sheet && (
                <Pressable accessibilityRole="button" testID="standing-lower-link" style={s.link} disabled={off} onPress={() => openSheet(p.role === 'payee' ? 'lower' : 'ask')}>
                    <Text style={s.linkText}>{p.lowerLink}</Text>
                </Pressable>
            )}
            {!!error && !sheet && <Text style={s.refusal} accessibilityRole="alert" accessibilityLiveRegion="polite" testID="standing-step-refusal">{error}</Text>}
            {!!sheet && !!open && (
                <LowerSheet key={open.changeId} s={s} sheet={sheet} busy={off} error={error}
                    onGo={(beans_c) => send(sheet.kind === 'answer'
                        ? { move: 'answer', standingId: sheet.standingId, changeId: sheet.askId!, yes: true }
                        : { move: 'lower', standingId: sheet.standingId, changeId: open.changeId, periodNo: sheet.periodNo, beans_c })}
                    onNo={() => send({ move: 'answer', standingId: sheet.standingId, changeId: sheet.askId!, yes: false })}
                    onCancel={() => { setOpen(null); setError(null); }}
                    onMessage={onMessage} messageLabel={messageLabel} />
            )}
            {!!p.lastLine && <Text style={s.small}>{p.lastLine}</Text>}
            {!!p.periodOf && <Text style={s.small}>{p.periodOf}</Text>}
            {(p.stop || !!onMessage) && !sheet && (
                <View style={[s.buttons, { marginTop: 4 }]}>
                    {p.stop && (
                        <Pressable accessibilityRole="button" testID="standing-stop" style={s.quiet} disabled={off} onPress={ask}>
                            <Text style={s.quietText}>{p.stopLabel}</Text>
                        </Pressable>
                    )}
                    {!!onMessage && !!messageLabel && (
                        <Pressable accessibilityRole="button" style={s.quiet} disabled={off} onPress={onMessage}>
                            <Text style={s.quietText}>{messageLabel}</Text>
                        </Pressable>
                    )}
                </View>
            )}
        </View>
    );
}
