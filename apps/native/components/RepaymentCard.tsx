/**
 * The Ledger's repayment card (#1597 item 4; credit bar amendment §7b, slice R3, Marty's pick 2 of 14 Nov 2026): only while
 * the member works a debt off, a notice says what is left and why their incoming Beans go to the Commons (GET
 * /api/commons/repayment, their own only), with a real button, Pay back now, that opens Pay the Commons (app/pay-commons.tsx)
 * with their own pay-back code filled in (the repayment's debtId), so what they pay comes off it at once. Nothing at all
 * otherwise: everyone's way in is PayCommonsRow.tsx, the Wallet's row with its line. An admin's link
 * (beanpool://pay-commons?code=…) opens the pay screen on its own. Reads on focus; says nothing when the node answers
 * nothing (an older node, no signal): no false state.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import { useFocusEffect, router } from 'expo-router';
import { useIdentity } from '../app/IdentityContext';
import { useTheme } from '../app/ThemeContext';
import { anchorUrl } from '../utils/node-post';
import { fetchMyRepayment, type Repayment } from '../utils/names-debts';
import { t } from '@beanpool/core';
import { REPAYMENT_LINES, repaymentBannerWords } from './repayment-lines';

export function RepaymentCard() {
    const { identity } = useIdentity();
    const { colors } = useTheme();
    const [repayment, setRepayment] = useState<Repayment | null>(null);

    useFocusEffect(useCallback(() => {
        let live = true;
        (async () => {
            const node = await anchorUrl();
            if (!node || !identity) return;
            const r = await fetchMyRepayment(node, identity);
            if (live && r.ok) setRepayment(r.value);
        })();
        return () => { live = false; };
    }, [identity]));

    // Nothing about the Commons at the top unless they work a debt off.
    if (!repayment) return null;
    return (
        <View style={{ paddingHorizontal: 16, paddingTop: 8 }} testID="ledger-repayment">
            <View style={{ padding: 12, gap: 10, borderRadius: 12, borderWidth: 1, borderColor: colors.feedback.warning.border, backgroundColor: colors.feedback.warning.bg }}>
                <Text accessibilityLiveRegion="polite" style={{ fontSize: 14, lineHeight: 20, color: colors.feedback.warning.fg }}>{repaymentBannerWords(repayment)}</Text>
                <Pressable
                    testID="ledger-pay-back-now"
                    onPress={() => router.push(repayment.debtId ? { pathname: '/pay-commons', params: { code: repayment.debtId } } : '/pay-commons')}
                    accessibilityRole="button"
                    style={{ minHeight: 48, justifyContent: 'center', alignSelf: 'flex-start', paddingHorizontal: 16, borderRadius: 12, backgroundColor: colors.brand.fill }}
                >
                    <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text.onBrand }}>{t(REPAYMENT_LINES.payBackNow)}</Text>
                </Pressable>
            </View>
        </View>
    );
}
