/**
 * "Give @Rob credit" (DESIGN-credit-list-fable.md §3.3 with its amendments 1 and 2): a sheet over the list, so the list keeps
 * its place. No text field, so no keyboard (and no KeyboardProvider in this Modal). Three ways to give, each the node's own
 * route:
 *
 *   Vouch for @Rob          today's VouchPresetChoice and today's POST /api/vouch, the body exactly
 *                           { memberPubkey, vouchAmount } (a first vouch) or { memberPubkey, raiseTo } (a raise)
 *   Confirm @Rob as known   owners and admins: the names list's one-step form, so the entry key, not-yourself, the second
 *                           admin and the open-debt rule are the list's own; on return the row is read again
 *   Raise their known floor owners and admins, a confirmed member, never their own: POST /api/credit/known-floor, raise only
 *
 * A community that doesn't confirm its members (the node's known-rule answer is null) shows neither known line: Confirm and Raise.
 * Below zero, or unable to be given part of a credit line: the presets are greyed under the node's own sentence and no
 * request is sent (the node still refuses a hand-made one). After a give the person is READ AGAIN from the node (never
 * updated here) and Next › opens the next person. Credit you give can't be taken back, and the sheet says so.
 * Nothing is kept: the person lives in this component's state while the sheet is open.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { formatHundredths, isHundredths, raiseVouchFor, t, vouchFor, vouchMaxFor } from '@beanpool/core';
import { useStyles } from '../app/ThemeContext';
import { VouchPresetChoice } from './VouchPresetChoice';
import { RiskLine } from './CreditRisk';
import { AskForMore } from './AskForMore';
import { bottomSheetLayout } from '../utils/bottom-sheet-layout';
import { fetchKnownRule } from '../utils/known-rule';
import { askMyVouching, vouchFromProfile, type MyVouching } from '../utils/vouchers';
import {
    NOT_ENOUGH_BUDGET_CODE, creditRowText, fetchCreditPerson, floorRaiseSteps, mayGive, presetsGreyedBecause, presetsGreyedWords,
    raiseKnownFloor, type CreditPerson, type CreditSightKind,
} from '../utils/credit-view';
import type { BeanPoolIdentity } from '../utils/identity';

export function GiveCreditSheet({ person: shown, sight, anchorUrl, identity, offersNamesList, hasNext, onClose, onNext, onGiven, onConfirmOpened }: {
    person: CreditPerson;
    sight: CreditSightKind;
    anchorUrl: string;
    identity: BeanPoolIdentity;
    /** Owners and admins on a community with a names list: the Confirm row is offered. */
    offersNamesList: boolean;
    hasNext: boolean;
    onClose: () => void;
    onNext: () => void;
    /** The node's fresh answer for this person after a give: the list replaces the row with it. */
    onGiven: (p: CreditPerson) => void;
    /** The Confirm row opened the names list: the list reads this person again when it is in front again. */
    onConfirmOpened: (memberPubkey: string) => void;
}) {
    const insets = useSafeAreaInsets();
    const { height } = useWindowDimensions();
    const layout = bottomSheetLayout(height, insets);
    const styles = useStyles(({ colors }) => StyleSheet.create({
        backdrop: { flex: 1, backgroundColor: colors.overlay.scrim, justifyContent: 'flex-end' },
        sheet: { backgroundColor: colors.surface.app, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: layout.maxHeight },
        body: { padding: 16, paddingBottom: layout.footerPaddingBottom },
        title: { fontSize: 18, fontWeight: '800', color: colors.text.heading, marginBottom: 6 },
        line: { fontSize: 14, lineHeight: 20, color: colors.text.body, marginBottom: 2 },
        section: { marginTop: 14, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border.default },
        sectionTitle: { fontSize: 15, fontWeight: '800', color: colors.text.heading, marginBottom: 6 },
        grey: { fontSize: 13, lineHeight: 19, color: colors.text.secondary, marginBottom: 8 },
        primary: { minHeight: 48, borderRadius: 12, backgroundColor: colors.brand.fill, paddingHorizontal: 16, paddingVertical: 10, justifyContent: 'center', alignItems: 'center', marginTop: 8 },
        primaryText: { color: colors.text.inverse, fontSize: 15, fontWeight: '700', textAlign: 'center' },
        secondary: { minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card, paddingHorizontal: 16, paddingVertical: 10, justifyContent: 'center', marginTop: 8 },
        secondaryText: { color: colors.brand.primary, fontSize: 15, fontWeight: '700' },
        stepper: { flexDirection: 'row', alignItems: 'center', gap: 12, marginVertical: 6 },
        step: { width: 48, height: 48, borderRadius: 12, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card, alignItems: 'center', justifyContent: 'center' },
        stepText: { fontSize: 22, fontWeight: '700', color: colors.brand.primary },
        stepValue: { fontSize: 17, fontWeight: '800', color: colors.text.heading, minWidth: 80, textAlign: 'center' },
        refusal: { fontSize: 13, lineHeight: 19, color: colors.feedback.danger.fg, marginTop: 6 },
        done: { fontSize: 14, lineHeight: 20, fontWeight: '700', color: colors.feedback.success.fg, marginTop: 6 },
        fine: { fontSize: 12, lineHeight: 18, color: colors.text.muted, marginTop: 12 },
    }));

    const [person, setPerson] = useState<CreditPerson>(shown);
    const [mine, setMine] = useState<MyVouching | null>(null);
    const [preset, setPreset] = useState<number | null>(null);
    const [busy, setBusy] = useState(false);
    const [refusal, setRefusal] = useState<{ message: string; code: string | null } | null>(null);
    const [done, setDone] = useState<{ said: string; line: string | null } | null>(null);
    const [floor, setFloor] = useState<number | null>(null);
    // The node's own word on whether this community confirms its members (the dial): neither known line is shown where it doesn't.
    // A community that confirms carries its known floor in the answer; a Beans node that doesn't still answers (with only
    // `creditSight`), so "an answer" is not the test: the floor is. The floor is also the amount the Confirm row says it adds.
    const [knownFloor, setKnownFloor] = useState<number | null>(null);
    useEffect(() => {
        let alive = true;
        void fetchKnownRule(anchorUrl).then((rule) => { if (alive) setKnownFloor(rule && isHundredths(rule.knownFloor) ? (rule.knownFloor as number) : null); });
        return () => { alive = false; };
    }, [anchorUrl]);
    const confirms = knownFloor !== null;

    // The sheet's own read of the person (a look the node records, once a day for this pair) and of the viewer's budget.
    useEffect(() => {
        setPerson(shown); setPreset(null); setRefusal(null); setDone(null); setFloor(null);
        let alive = true;
        void fetchCreditPerson(anchorUrl, identity, shown.memberPubkey).then((r) => { if (alive && r.ok) setPerson(r.value.person); });
        void askMyVouching(anchorUrl, identity).then((mv) => { if (alive) setMine(mv); });
        return () => { alive = false; };
    }, [shown.memberPubkey, anchorUrl, identity]);

    const text = creditRowText(person, sight);
    const grey = presetsGreyedBecause(person, sight);
    const prior = isHundredths(person.youVouched_c) ? (person.youVouched_c as number) : 0;
    const isRaise = prior > 0;
    const noLimit = mine?.noLimit === true;
    const atMax = prior >= vouchMaxFor(noLimit);
    const confirmed = !!person.standsBehind?.confirmedBy;
    const canConfirm = confirms && offersNamesList && !!person.standsBehind && !confirmed && mayGive(person);
    const knownFrozen = !!(person.frozen && (person.frozen.credit || person.frozen.known));
    const steps = useMemo(() => (confirms && person.parts && confirmed && !knownFrozen && !person.own ? floorRaiseSteps(person.parts.known_c, person.parts.cap_c) : null), [person, confirmed, knownFrozen, confirms]);
    const target = floor ?? steps?.min ?? null;

    /** Read the person again from the node (never updated here), hand it up, and say what the line is now. */
    const afterGive = async (said: string) => {
        const fresh = await fetchCreditPerson(anchorUrl, identity, person.memberPubkey);
        if (fresh.ok) {
            setPerson(fresh.value.person);
            onGiven(fresh.value.person);
            setDone({ said, line: t('Their credit line is now {line}.', { line: formatHundredths(fresh.value.person.line_c) }) });
        } else {
            setDone({ said, line: null });
        }
        setPreset(null); setFloor(null);
    };

    const vouch = async () => {
        if (!preset || busy) return;
        setBusy(true); setRefusal(null); setDone(null);
        const res = await vouchFromProfile(anchorUrl, identity, isRaise ? { memberPubkey: person.memberPubkey, raiseTo: preset } : { memberPubkey: person.memberPubkey, vouchAmount: preset });
        if (res.ok) {
            void askMyVouching(anchorUrl, identity).then(setMine);
            await afterGive(isRaise
                ? t('Raised vouch for @{name} to {total} Beans.', { name: person.callsign, total: formatHundredths(res.total) })
                : t('Vouched {amount} Beans for @{name}.', { name: person.callsign, amount: formatHundredths(preset) }));
        } else {
            setPreset(null);
            setRefusal({ message: res.message, code: res.code ?? null });
        }
        setBusy(false);
    };

    const raise = async () => {
        if (target === null || busy) return;
        setBusy(true); setRefusal(null); setDone(null);
        const res = await raiseKnownFloor(anchorUrl, identity, person.memberPubkey, target);
        if (res.ok) await afterGive(t('Raised the known floor for @{name} to {amount} Beans.', { name: person.callsign, amount: formatHundredths(res.value.knownFloor_c) }));
        else setRefusal({ message: res.offline ? t('Connect to your community to give credit.') : res.message, code: res.code });
        setBusy(false);
    };

    return (
        <Modal visible transparent animationType="slide" onRequestClose={onClose}>
            <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel={t('Close')} accessibilityRole="button">
                <Pressable style={styles.sheet} onPress={() => {}} testID="give-credit-sheet">
                    <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
                        <Text style={styles.title} accessibilityRole="header" maxFontSizeMultiplier={1.3}>{t('Give @{name} credit', { name: person.callsign })}</Text>
                        <Text style={styles.line} maxFontSizeMultiplier={1.3}>{text.credit}</Text>
                        <Text style={styles.line} maxFontSizeMultiplier={1.3} accessibilityLabel={text.balanceSpoken}>{text.balance}</Text>
                        <RiskLine risk={person.risk} word={text.risk} shape={text.riskShape} />

                        {mine?.voucher && !atMax && (
                            <View style={styles.section} testID="give-vouch">
                                <Text style={styles.sectionTitle} maxFontSizeMultiplier={1.3}>{isRaise ? raiseVouchFor(person.callsign) : vouchFor(person.callsign)}</Text>
                                {grey ? <Text style={styles.grey} maxFontSizeMultiplier={1.3} testID="give-greyed">{presetsGreyedWords(grey, person.callsign)}</Text> : null}
                                <View pointerEvents={grey ? 'none' : 'auto'} style={grey ? { opacity: 0.4 } : undefined}>
                                    <VouchPresetChoice
                                        value={preset}
                                        onChange={setPreset}
                                        budgetLeft={mine.budget?.left ?? 0}
                                        budgetTotal={mine.budget?.level ?? 0}
                                        noLimit={noLimit}
                                        raiseFrom={isRaise ? prior : undefined}
                                    />
                                </View>
                                {!grey && (
                                    <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy || !preset, busy }} disabled={busy || !preset} onPress={() => { void vouch(); }} style={[styles.primary, (busy || !preset) && { opacity: 0.5 }]} testID="give-vouch-submit">
                                        <Text style={styles.primaryText} maxFontSizeMultiplier={1.3}>{busy ? t('Saving...') : isRaise ? raiseVouchFor(person.callsign) : vouchFor(person.callsign)}</Text>
                                    </Pressable>
                                )}
                            </View>
                        )}

                        {canConfirm && (
                            <View style={styles.section} testID="give-confirm">
                                {knownFloor ? <Text style={styles.grey} maxFontSizeMultiplier={1.3} testID="give-confirm-adds">{t('Adds the known floor: {amount} Beans', { amount: formatHundredths(knownFloor) })}</Text> : null}
                                <Pressable
                                    accessibilityRole="button"
                                    style={styles.secondary}
                                    onPress={() => {
                                        onConfirmOpened(person.memberPubkey);
                                        onClose();
                                        router.push({ pathname: '/names-list', params: { act: 'add', forMember: person.memberPubkey, forCallsign: person.callsign } });
                                    }}
                                >
                                    <Text style={styles.secondaryText} maxFontSizeMultiplier={1.3}>{t('Confirm @{name} as known ›', { name: person.callsign })}</Text>
                                </Pressable>
                            </View>
                        )}

                        {steps && target !== null && (
                            <View style={styles.section} testID="give-floor">
                                <Text style={styles.sectionTitle} maxFontSizeMultiplier={1.3}>{t('Raise their known floor')}</Text>
                                <View style={styles.stepper}>
                                    <Pressable accessibilityRole="button" accessibilityLabel={t('Lower the amount')} disabled={target <= steps.min} style={[styles.step, target <= steps.min && { opacity: 0.4 }]} onPress={() => setFloor(Math.max(steps.min, target - 10_000))}>
                                        <Text style={styles.stepText}>−</Text>
                                    </Pressable>
                                    <Text style={styles.stepValue} maxFontSizeMultiplier={1.3} testID="give-floor-value">{formatHundredths(target)}</Text>
                                    <Pressable accessibilityRole="button" accessibilityLabel={t('Raise the amount')} disabled={target >= steps.max} style={[styles.step, target >= steps.max && { opacity: 0.4 }]} onPress={() => setFloor(Math.min(steps.max, target + 10_000))}>
                                        <Text style={styles.stepText}>+</Text>
                                    </Pressable>
                                </View>
                                <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy, busy }} disabled={busy} onPress={() => { void raise(); }} style={[styles.primary, busy && { opacity: 0.5 }]} testID="give-floor-submit">
                                    <Text style={styles.primaryText} maxFontSizeMultiplier={1.3}>{t('Raise to {amount}', { amount: formatHundredths(target) })}</Text>
                                </Pressable>
                            </View>
                        )}

                        {!!refusal && (
                            <>
                                <Text style={styles.refusal} accessibilityRole="alert" maxFontSizeMultiplier={1.3} testID="give-refusal">{refusal.message}</Text>
                                {refusal.code === NOT_ENOUGH_BUDGET_CODE && mine?.ask ? <AskForMore anchorUrl={anchorUrl} identity={identity} ask={mine.ask} /> : null}
                            </>
                        )}
                        {!!done && (
                            <>
                                <Text style={styles.done} accessibilityLiveRegion="polite" maxFontSizeMultiplier={1.3} testID="give-done">{done.said}</Text>
                                {done.line ? <Text style={styles.done} maxFontSizeMultiplier={1.3} testID="give-line">{done.line}</Text> : null}
                                {hasNext ? (
                                    <Pressable accessibilityRole="button" style={styles.primary} onPress={onNext} testID="give-next">
                                        <Text style={styles.primaryText} maxFontSizeMultiplier={1.3}>{t('Next ›')}</Text>
                                    </Pressable>
                                ) : null}
                            </>
                        )}
                        <Text style={styles.fine} maxFontSizeMultiplier={1.3}>{t('Credit you give can’t be taken back.')}</Text>
                        <Pressable accessibilityRole="button" style={styles.secondary} onPress={onClose} testID="give-close">
                            <Text style={styles.secondaryText} maxFontSizeMultiplier={1.3}>{t('Close')}</Text>
                        </Pressable>
                    </ScrollView>
                </Pressable>
            </Pressable>
        </Modal>
    );
}
