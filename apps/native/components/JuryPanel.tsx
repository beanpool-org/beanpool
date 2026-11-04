/**
 * A vote a drawn jury decides, on its Decide card (removal jury slice J3; core jury-card.ts has the words, the web app's
 * components/JuryPanel.tsx the same card). While it is open: who decides and by when, the reader's own seat in neutral
 * words, Serve or Step aside for a juror whose answer is due, the vote only for a seated juror, and Check the draw. Once
 * it closes: how it ended, who voted and who didn't serve (never why), and Check the draw over both lists.
 *
 * The seat comes from GET …/jury, so until it answers nobody is offered a vote. Nothing here names a juror to anyone but
 * themselves: while it is open the node names nobody else, and the card counts jurors from the tally's `turnout`.
 */
import React, { useEffect, useState, type ReactNode } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import {
    checkServedJury, juryCheckLine, juryClosedLists, juryCountHiddenLine, juryDecidesLine, juryOffersVote, juryOutcomeLine, juryPoolLine,
    juryRuleLine, jurySeatLines, jurySeatView, juryTurnoutLine, juryTurnoutOf, jurorStepAsideQuestion, t, type JuryCheck, type ServedJury,
} from '@beanpool/core';
import { useStyles } from '../app/ThemeContext';
import { answerJurySeat, getDecisionJury, type DecisionWithTally } from '../utils/db';
import { signedRequestWords } from './signed-request-lines';

export function JuryPanel({ decision, open, me, name, voteButtons, onRefresh }: {
    decision: DecisionWithTally;
    open: boolean;
    me: string | null | undefined;
    /** The member it is about, as the card names them. */
    name: string;
    /** The card's own Yes and No, shown to a seated juror only. */
    voteButtons?: ReactNode;
    onRefresh: () => Promise<void>;
}) {
    const s = useStyles(juryStyles);
    const [jury, setJury] = useState<ServedJury | null | undefined>(undefined);
    const [loadFailed, setLoadFailed] = useState(false);
    const [check, setCheck] = useState<JuryCheck | null>(null);
    const [busy, setBusy] = useState(false);

    const load = async () => {
        setLoadFailed(false);
        try {
            setJury(await getDecisionJury(decision.id));
        } catch {
            setLoadFailed(true);
        }
    };
    // Again when the card's status or turnout moves (a vote cast, the vote closed), so the seat and the lists follow it.
    const turnout = juryTurnoutOf(decision.tally);
    useEffect(() => { void load(); }, [decision.id, decision.status, turnout?.voted]);

    const send = async (to: 'serve' | 'step_aside') => {
        setBusy(true);
        try {
            const res = await answerJurySeat(decision.id, to);
            if (res?.jury) setJury(res.jury);
            await onRefresh();
        } catch (err: any) {
            Alert.alert(t('Error'), err?.message ? signedRequestWords(err.message) : t('Your answer could not be sent.'));
        } finally {
            setBusy(false);
        }
    };
    const stepAside = () => Alert.alert(t('Step aside'), jurorStepAsideQuestion(), [
        { text: t('Cancel'), style: 'cancel' },
        { text: t('Step aside'), style: 'destructive', onPress: () => void send('step_aside') },
    ]);

    const view = jury ? jurySeatView(jury, { isSubject: !!me && decision.subject === me, hasVoted: !!decision.myVote }) : null;
    const lists = jury && !open ? juryClosedLists(jury) : null;
    const outcome = open ? null : juryOutcomeLine(decision, decision.tally, name);
    const size = jury?.size ?? turnout?.size ?? decision.params?.jury?.size;

    return (
        <View style={s.box} testID="jury-panel">
            {open && typeof size === 'number' && <Text style={s.heading} testID="jury-decides-line">{juryDecidesLine(size, decision.closesAt)}</Text>}
            {!!outcome && <Text style={s.heading} testID="jury-outcome">{outcome}</Text>}

            {open && view && (
                <View style={s.lines} testID={`jury-seat-${view}`}>
                    {jurySeatLines(view, { name, answerBy: jury?.answerBy, closesAt: decision.closesAt }).map(line => (
                        <Text key={line} style={s.body}>{line}</Text>
                    ))}
                </View>
            )}

            {open && view === 'ask' && (
                <View style={s.row}>
                    <Pressable accessibilityRole="button" accessibilityLabel={t('Serve')} accessibilityState={{ disabled: busy }} disabled={busy}
                        style={[s.btn, s.serve, busy && s.dim]} onPress={() => void send('serve')}>
                        <Text style={s.serveText}>{t('Serve')}</Text>
                    </Pressable>
                    <Pressable accessibilityRole="button" accessibilityLabel={t('Step aside')} accessibilityState={{ disabled: busy }} disabled={busy}
                        style={[s.btn, s.aside, busy && s.dim]} onPress={stepAside}>
                        <Text style={s.asideText}>{t('Step aside')}</Text>
                    </Pressable>
                </View>
            )}
            {open && view && juryOffersVote(view) && view !== 'ask' && voteButtons}
            {open && view === 'serving' && (
                <Pressable accessibilityRole="button" accessibilityLabel={t('Step aside')} disabled={busy} style={s.link} onPress={stepAside}>
                    <Text style={s.linkText}>{t('Step aside')}</Text>
                </Pressable>
            )}

            {lists && (
                <View style={s.lines} testID="jury-closed-lists">
                    <Text style={s.small} testID="jury-voted">{lists.voted}</Text>
                    <Text style={s.small} testID="jury-did-not-serve">{lists.didNotServe}</Text>
                    <Text style={s.muted}>{lists.note}</Text>
                </View>
            )}

            {loadFailed && (
                <Pressable accessibilityRole="button" style={s.link} onPress={() => void load()}>
                    <Text style={s.warn}>{t("Couldn't load the jury.")} <Text style={s.linkText}>{t('Try again')}</Text></Text>
                </Pressable>
            )}

            {!!jury && (
                <View style={s.lines}>
                    <Pressable accessibilityRole="button" accessibilityLabel={t('Check the draw')} style={[s.btn, s.aside, s.check]} onPress={() => setCheck(checkServedJury(jury))}>
                        <Text style={s.asideText}>{t('Check the draw')}</Text>
                    </Pressable>
                    {!!check && (
                        <Text style={check.ok ? s.ok : s.bad} testID="jury-check-result" accessibilityLiveRegion="polite">{juryCheckLine(check)}</Text>
                    )}
                    <Text style={s.muted}>{juryPoolLine(jury)}</Text>
                </View>
            )}
        </View>
    );
}

/**
 * An open jury vote's numbers, in the card's metrics box: jurors who voted of those seated, how many must vote and what
 * removing takes, and why no Yes or No shows yet. Never a percentage of a split the node didn't send.
 */
export function JuryTurnoutBox({ decision, name }: { decision: DecisionWithTally; name: string }) {
    const s = useStyles(juryStyles);
    const turnout = juryTurnoutOf(decision.tally);
    if (!turnout) return <Text style={s.small} testID="jury-turnout">{juryCountHiddenLine()}</Text>;
    const pct = Math.min(100, Math.round((turnout.voted / Math.max(1, turnout.mustVote)) * 100));
    const met = turnout.voted >= turnout.mustVote;
    return (
        <View testID="jury-turnout" style={s.lines}>
            <View style={s.metricRow}>
                <Text style={s.metricLabel}>{t('Turnout: {line}', { line: juryTurnoutLine(turnout) })}</Text>
                <Text style={met ? s.ok : s.metricLabel}>{met ? t('Met ✅') : t('Pending', undefined, 'quorum not met yet')}</Text>
            </View>
            <View style={s.barBg} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: pct }} accessibilityLabel={t('Quorum progress')}>
                <View style={[s.barFill, met ? s.barMet : s.barOpen, { width: `${pct}%` }]} />
            </View>
            <Text style={s.small}>{juryRuleLine(turnout, decision.tally.minYes, name)}</Text>
            <Text style={s.muted}>{juryCountHiddenLine()}</Text>
        </View>
    );
}

const juryStyles = ({ colors }: { colors: any }) => StyleSheet.create({
    box: { backgroundColor: colors.surface.subtle, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, padding: 12, marginTop: 8, gap: 8 },
    heading: { fontSize: 14, fontWeight: '800', color: colors.text.heading, lineHeight: 20 },
    lines: { gap: 4 },
    body: { fontSize: 13, color: colors.text.heading, lineHeight: 18 },
    small: { fontSize: 12, color: colors.text.secondary, lineHeight: 17 },
    muted: { fontSize: 11, color: colors.text.muted, lineHeight: 15 },
    warn: { fontSize: 12, color: colors.feedback.warning.fg, fontWeight: '700' },
    ok: { fontSize: 12, color: colors.feedback.success.fg, fontWeight: '700', lineHeight: 17 },
    bad: { fontSize: 12, color: colors.feedback.danger.fg, fontWeight: '700', lineHeight: 17 },
    // Wraps: at 320 dp and 1.3x text Serve and Step aside go one under the other rather than past the edge.
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
    btn: { flexGrow: 1, flexShrink: 1, minHeight: 48, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' },
    serve: { backgroundColor: colors.brand.fill },
    serveText: { color: colors.text.inverse, fontSize: 14, fontWeight: '800', textAlign: 'center' },
    aside: { backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.default },
    asideText: { color: colors.text.heading, fontSize: 13, fontWeight: '700', textAlign: 'center' },
    check: { alignSelf: 'flex-start', flexGrow: 0, minHeight: 44 },
    dim: { opacity: 0.5 },
    link: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
    linkText: { fontSize: 13, fontWeight: '800', color: colors.feedback.info.fg, textDecorationLine: 'underline' },
    metricRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', columnGap: 8 },
    metricLabel: { flexShrink: 1, fontSize: 12, color: colors.text.secondary, fontWeight: '600' },
    barBg: { height: 6, backgroundColor: colors.border.default, borderRadius: 3, overflow: 'hidden' },
    barFill: { height: '100%', borderRadius: 3 },
    barMet: { backgroundColor: colors.feedback.success.solid },
    barOpen: { backgroundColor: colors.feedback.info.solid },
});
