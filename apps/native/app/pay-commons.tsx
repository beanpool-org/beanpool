/**
 * Pay the Commons (#1597 item 4): a member pays Beans they hold to the Commons (POST /api/commons/pay), never more than
 * they hold (the node refuses that). Paying back a debt, they enter the pay-back code an admin shared (the debt record's
 * id; also opened as beanpool://pay-commons?code=…&amount=…, the amount left, prefilled): the node links the payment to that
 * debt, and this screen shows the payment's reference to give the admin. The node settles a debt only with one payment of
 * at least what is left, so the screen promises a settle only then. Asked first; the node's refusals in its own words; a
 * lost answer says the payment may have gone through. One payment at a time (busy before anything is awaited).
 * Styles: the names list's (utils/names-list-style.ts), held to 48dp targets and wrapping at 320dp and 1.3× text.
 */
import React, { useRef, useState } from 'react';
import { View, Text, StyleSheet, TextInput, Pressable, Alert, Share, DeviceEventEmitter } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams, ErrorBoundary } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { useIdentity } from './IdentityContext';
import { useTheme, useStyles } from './ThemeContext';
import { anchorUrl } from '../utils/node-post';
import { namesListStyleSpec } from '../utils/names-list-style';
import { payTheCommons, parseBeans, debtCodeOk, oneAtATime, REPAYMENT_COPY, DEBT_UNREACHABLE } from '../utils/names-debts';

export { ErrorBoundary };

export default function PayCommonsScreen() {
    const { theme, colors } = useTheme();
    const styles = useStyles(({ colors }) => StyleSheet.create(namesListStyleSpec(colors)));
    const { identity } = useIdentity();
    const params = useLocalSearchParams<{ code?: string; amount?: string }>();
    const linkCode = typeof params.code === 'string' ? params.code.trim().toLowerCase() : '';
    // What is left on the debt, from the admin's link: known only for the code the link carried.
    const linkLeft = linkCode && typeof params.amount === 'string' ? parseBeans(params.amount) : null;
    const [amount, setAmount] = useState(linkLeft !== null ? String(linkLeft) : '');
    const [code, setCode] = useState(typeof params.code === 'string' ? params.code : '');
    const [error, setError] = useState<string | null>(null);
    const [paid, setPaid] = useState<{ words: string; ref: string | null } | null>(null);
    const [busy, setBusy] = useState(false);
    const once = useRef(oneAtATime(setBusy)).current;

    const pay = () => {
        setError(null);
        const beans = parseBeans(amount);
        if (beans === null) { setError(REPAYMENT_COPY.badAmount); return; }
        const debt = code.trim();
        if (debt && !debtCodeOk(debt)) { setError(REPAYMENT_COPY.badCode); return; }
        const left = debt && debt.toLowerCase() === linkCode ? linkLeft : null;
        Alert.alert(REPAYMENT_COPY.payTitle, REPAYMENT_COPY.payConfirm(beans, !!debt, left), [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Pay', onPress: () => once(async () => {
                    const node = await anchorUrl();
                    if (!node || !identity) { setError(DEBT_UNREACHABLE); return; }
                    const r = await payTheCommons(node, identity, beans, debt || undefined);
                    if (!r.ok) { setError(r.message); return; }
                    DeviceEventEmitter.emit('transaction_completed');
                    setPaid({ words: REPAYMENT_COPY.paid(r.value.amount, r.value.transactionId, !!debt, left), ref: debt ? r.value.transactionId : null });
                }),
            },
        ]);
    };

    return (
        <SafeAreaView style={styles.screen} edges={['top', 'left', 'right', 'bottom']}>
            <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
            <View style={styles.header}>
                <Pressable onPress={() => router.back()} style={styles.backButton} accessibilityRole="button" accessibilityLabel="Back">
                    <MaterialCommunityIcons name="arrow-left" size={24} color={colors.text.heading} />
                </Pressable>
                <Text style={styles.headerTitle} accessibilityRole="header">{REPAYMENT_COPY.payTitle}</Text>
            </View>
            <KeyboardAwareScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" bottomOffset={24}>
                {paid ? (
                    <>
                        <View style={styles.notice} accessibilityLiveRegion="polite"><Text style={styles.noticeText} selectable>{paid.words}</Text></View>
                        <View style={styles.buttonRow}>
                            {paid.ref ? (
                                <Pressable style={styles.primaryBtn} onPress={() => { void Share.share({ message: `My payment to the Commons for my debt: ${paid.ref}` }).catch(() => {}); }} accessibilityRole="button">
                                    <Text style={styles.primaryBtnText}>Share the reference</Text>
                                </Pressable>
                            ) : null}
                            <Pressable style={styles.secondaryBtn} onPress={() => router.back()} accessibilityRole="button">
                                <Text style={styles.secondaryBtnText}>Done</Text>
                            </Pressable>
                        </View>
                    </>
                ) : (
                    <>
                        <Text style={styles.body}>{REPAYMENT_COPY.payIntro}</Text>
                        <Text style={styles.label}>BEANS</Text>
                        <TextInput
                            style={styles.input} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="For example 12.50"
                            placeholderTextColor={colors.text.muted} accessibilityLabel="How many Beans" maxLength={12} editable={!busy}
                        />
                        <Text style={styles.label}>PAY-BACK CODE (IF YOU HAVE ONE)</Text>
                        <TextInput
                            style={styles.input} value={code} onChangeText={setCode} placeholder="From an admin" autoCapitalize="none" autoCorrect={false}
                            placeholderTextColor={colors.text.muted} accessibilityLabel="The pay-back code an admin gave you" maxLength={64} editable={!busy}
                        />
                        {error ? <View style={styles.error}><Text style={styles.errorText}>{error}</Text></View> : null}
                        <View style={styles.buttonRow}>
                            <Pressable style={[styles.primaryBtn, busy && styles.disabled]} onPress={pay} disabled={busy} accessibilityRole="button" accessibilityState={{ disabled: busy, busy }}>
                                <Text style={styles.primaryBtnText}>{REPAYMENT_COPY.payTitle}</Text>
                            </Pressable>
                        </View>
                    </>
                )}
            </KeyboardAwareScrollView>
        </SafeAreaView>
    );
}
