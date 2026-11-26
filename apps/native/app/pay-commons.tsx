/**
 * Pay the Commons (#1597 item 4): a member pays Beans they hold to the Commons (POST /api/commons/pay), never more than
 * they hold (the node refuses that). Paying back a debt, they enter the pay-back code an admin shared (the debt record's
 * id; also opened as beanpool://pay-commons?code=…&amount=…, prefilled with what was left when the admin shared it): the
 * node takes the payment off that debt at once (refusing one above what is left now, in its words), and this screen says
 * what is left, or that the debt is settled, as the node's answer says. A member working a debt off (GET
 * /api/commons/repayment) finds their own code filled in, however they came here; a payment without it is said, before and
 * after, not to come off the debt (the node never links one by itself). Asked first; the node's refusals in its
 * own words. Each confirmed payment has one id (utils/payment-request.ts): a lost answer keeps that payment here for Try
 * again with the same id, so it is never paid twice. For a day from its first sending only (core money-retry.ts): the node
 * forgets an id after its 7 days, so past a day Try again is no longer offered for it, the screen says the Ledger shows
 * whether it went through (payAgedLine), and Pay the Commons makes a new payment, asked again, with a new id. One payment
 * at a time (busy before anything is awaited).
 * Styles: the names list's (utils/names-list-style.ts), held to 48dp targets and wrapping at 320dp and 1.3× text.
 */
import React, { useEffect, useReducer, useRef, useState } from 'react';
import { View, Text, StyleSheet, TextInput, Pressable, Share, DeviceEventEmitter } from 'react-native';
import { Alert } from '../utils/keyboard-alert';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams, ErrorBoundary } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { useIdentity } from './IdentityContext';
import { useTheme, useStyles } from './ThemeContext';
import { anchorUrl } from '../utils/node-post';
import { namesListStyleSpec } from '../utils/names-list-style';
import { payTheCommons, fetchMyRepayment, confirmCommonsPayment, unanswered, parseBeans, debtCodeOk, oneAtATime, REPAYMENT_COPY, DEBT_UNREACHABLE, PAY_UNANSWERED_RETRY, type CommonsPayment, type Repayment } from '../utils/names-debts';
import { REPAYMENT_LINES, linkLeftWords, paidWords, payConfirmWords, repaymentLineWords } from '../components/repayment-lines';
import { firstSending, formatHundredths, heldAfterChange, heldAged, heldAgesInMs, heldResend, hundredthsAsDecimalText, payAgedLine, t, type HeldPayment } from '@beanpool/core';
import type { ConfirmedPayment } from '../utils/payment-request';

export { ErrorBoundary };

export default function PayCommonsScreen() {
    const { theme, colors } = useTheme();
    const styles = useStyles(({ colors }) => StyleSheet.create(namesListStyleSpec(colors)));
    const { identity } = useIdentity();
    const params = useLocalSearchParams<{ code?: string; amount?: string }>();
    const linkCode = typeof params.code === 'string' ? params.code.trim().toLowerCase() : '';
    // What was left on the debt when the admin shared the link (a work-off may have lowered it since): for that code only.
    // Whole hundredths (the link writes Beans, "179.50"; parseBeans reads them), prefilled as the same plain figure.
    const linkLeft = linkCode && typeof params.amount === 'string' ? parseBeans(params.amount) : null;
    const [amount, setAmount] = useState(linkLeft !== null ? hundredthsAsDecimalText(linkLeft) : '');
    const [code, setCode] = useState(typeof params.code === 'string' ? params.code : '');
    const [error, setError] = useState<string | null>(null);
    const [paid, setPaid] = useState<{ words: string; ref: string | null } | null>(null);
    const [busy, setBusy] = useState(false);
    const once = useRef(oneAtATime(setBusy)).current;
    // The payment the member confirmed whose answer was lost, stamped with its FIRST sending (core money-retry.ts): Try again
    // sends it with the same id for a day from then, never after. Changing it drops it; an aged one is never sent, and stays
    // only to keep its line up until the next payment goes.
    const [held, setHeld] = useState<HeldPayment<ConfirmedPayment<CommonsPayment>> | null>(null);
    const edit = (set: (v: string) => void) => (v: string) => { set(v); setHeld((h) => heldAfterChange(h, Date.now())); };
    // Drawn again the moment a held payment ages, so a screen left open stops offering Try again (pay() reads the age too).
    const [, redraw] = useReducer((n: number) => n + 1, 0);
    useEffect(() => {
        const left = heldAgesInMs(held, Date.now());
        if (left === null) return;
        const timer = setTimeout(redraw, Math.min(left, 2 ** 31 - 1));
        return () => clearTimeout(timer);
    }, [held]);
    // The debt this member works off (their own, from the node), and whether they typed in the code field: their code goes
    // in only while they haven't, so one they cleared stays cleared.
    const [myDebt, setMyDebt] = useState<Repayment | null>(null);
    const codeTyped = useRef(false);
    useEffect(() => {
        let live = true;
        (async () => {
            const node = await anchorUrl();
            if (!node || !identity) return;
            const r = await fetchMyRepayment(node, identity);
            if (!live || !r.ok || !r.value) return;
            const mine = r.value;
            setMyDebt(mine);
            if (mine.debtId && !codeTyped.current) setCode((c) => (c.trim() ? c : mine.debtId!));
        })();
        return () => { live = false; };
    }, [identity]);

    // `going` is the payment and its first sending's stamp: a fresh one (firstSending) or the held one, stamp kept (heldResend).
    const send = (going: HeldPayment<ConfirmedPayment<CommonsPayment>>) => once(async () => {
        setError(null);
        const node = await anchorUrl();
        if (!node || !identity) { setHeld(going); setError(DEBT_UNREACHABLE); return; }
        const payment = going.payment;
        const r = await payTheCommons(node, identity, payment);
        if (!r.ok && unanswered(r)) { setHeld(going); setError(PAY_UNANSWERED_RETRY); return; }
        setHeld(null);
        if (!r.ok) { setError(r.message); return; }
        DeviceEventEmitter.emit('transaction_completed');
        const forDebt = !!payment.body.debtId;
        // names-debts.ts REPAYMENT_COPY.paid, in the member's language (components/repayment-lines.ts).
        setPaid({ words: paidWords(r.value.amount_c, r.value.transactionId, forDebt, r.value, !forDebt && !!myDebt), ref: forDebt ? null : r.value.transactionId });
    });

    const pay = () => {
        // Sent again only while it is less than a day old; an aged one is never sent: this is a new payment, asked again.
        const again = heldResend(held, Date.now());
        if (again) { send(again); return; }
        setError(null);
        // Whole hundredths of a Bean, read as typed in the member's language (core parseHundredths): "12.50" is 1250.
        const amount_c = parseBeans(amount);
        if (amount_c === null) { setError(REPAYMENT_COPY.badAmount); return; }
        const debt = code.trim();
        if (debt && !debtCodeOk(debt)) { setError(REPAYMENT_COPY.badCode); return; }
        const shared = debt && debt.toLowerCase() === linkCode ? linkLeft : null;
        Alert.alert(t(REPAYMENT_LINES.payTitle), payConfirmWords(amount_c, !!debt, shared, !debt && !!myDebt), [
            { text: t('Cancel'), style: 'cancel' },
            { text: t('Pay'), onPress: () => send(firstSending(confirmCommonsPayment(amount_c, debt || undefined), Date.now())) },
        ]);
    };

    // Read as drawn: Try again only while the held payment may still be sent again. Once it has aged, its lost-answer line
    // (which offers Try again) gives way to the aged line, so it never reads as this payment done or as safe to send again.
    const now = Date.now();
    const tryAgain = heldResend(held, now) !== null;
    const aged = heldAged(held, now) !== null;
    const shownError = aged && (error === PAY_UNANSWERED_RETRY || error === DEBT_UNREACHABLE) ? null : error;

    return (
        <SafeAreaView style={styles.screen} edges={['top', 'left', 'right', 'bottom']}>
            <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
            <View style={styles.header}>
                <Pressable onPress={() => router.back()} style={styles.backButton} accessibilityRole="button" accessibilityLabel={t('Back')}>
                    <MaterialCommunityIcons name="arrow-left" size={24} color={colors.text.heading} />
                </Pressable>
                <Text style={styles.headerTitle} accessibilityRole="header">{t(REPAYMENT_LINES.payTitle)}</Text>
            </View>
            <KeyboardAwareScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" bottomOffset={24}>
                {paid ? (
                    <>
                        <View style={styles.notice} accessibilityLiveRegion="polite"><Text style={styles.noticeText} selectable>{paid.words}</Text></View>
                        <View style={styles.buttonRow}>
                            {paid.ref ? (
                                <Pressable style={styles.primaryBtn} onPress={() => { void Share.share({ message: t('My payment to the Commons: {ref}', { ref: paid.ref! }) }).catch(() => {}); }} accessibilityRole="button">
                                    <Text style={styles.primaryBtnText}>{t('Share the reference')}</Text>
                                </Pressable>
                            ) : null}
                            <Pressable style={styles.secondaryBtn} onPress={() => router.back()} accessibilityRole="button">
                                <Text style={styles.secondaryBtnText}>{t('Done')}</Text>
                            </Pressable>
                        </View>
                    </>
                ) : (
                    <>
                        <Text style={styles.body}>{t(REPAYMENT_LINES.payIntro)}</Text>
                        {linkLeft !== null && code.trim().toLowerCase() === linkCode ? <Text style={styles.body}>{linkLeftWords(linkLeft)}</Text> : null}
                        <Text style={styles.label}>{t('BEANS')}</Text>
                        <TextInput
                            style={styles.input} value={amount} onChangeText={edit(setAmount)} keyboardType="decimal-pad" placeholder={t('For example {amount}', { amount: formatHundredths(1250) })}
                            placeholderTextColor={colors.text.muted} accessibilityLabel={t('How many Beans')} maxLength={12} editable={!busy}
                        />
                        <Text style={styles.label}>{t('PAY-BACK CODE (IF YOU HAVE ONE)')}</Text>
                        <TextInput
                            style={styles.input} value={code} onChangeText={edit((v) => { codeTyped.current = true; setCode(v); })} placeholder={t('From an admin')} autoCapitalize="none" autoCorrect={false}
                            placeholderTextColor={colors.text.muted} accessibilityLabel={t('The pay-back code an admin gave you')} maxLength={64} editable={!busy}
                        />
                        {aged ? <View style={styles.warn} accessibilityLiveRegion="polite"><Text style={styles.warnText}>{payAgedLine()}</Text></View> : null}
                        {shownError ? <View style={styles.error}><Text style={styles.errorText}>{repaymentLineWords(shownError)}</Text></View> : null}
                        <View style={styles.buttonRow}>
                            <Pressable style={[styles.primaryBtn, busy && styles.disabled]} onPress={pay} disabled={busy} accessibilityRole="button" accessibilityState={{ disabled: busy, busy }}>
                                <Text style={styles.primaryBtnText}>{tryAgain ? t('Try again') : t(REPAYMENT_LINES.payTitle)}</Text>
                            </Pressable>
                        </View>
                    </>
                )}
            </KeyboardAwareScrollView>
        </SafeAreaView>
    );
}
