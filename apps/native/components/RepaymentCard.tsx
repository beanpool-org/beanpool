/**
 * The Ledger's repayment card (#1597 item 4): while the member works a debt off, a banner says what is left and why
 * their incoming Beans go to the Commons (GET /api/commons/repayment, their own only). Under it, always, "Pay the
 * Commons" (app/pay-commons.tsx), where a member paying back a debt enters the pay-back code an admin gave them.
 * Reads on focus; says nothing when the node answers nothing (an older node, no signal): no false state.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import { useFocusEffect, router } from 'expo-router';
import { useIdentity } from '../app/IdentityContext';
import { useTheme } from '../app/ThemeContext';
import { anchorUrl } from '../utils/node-post';
import { fetchMyRepayment, REPAYMENT_COPY, type Repayment } from '../utils/names-debts';

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

    return (
        <View style={{ paddingHorizontal: 16, paddingTop: 8, gap: 8 }}>
            {repayment ? (
                <View
                    accessibilityLiveRegion="polite"
                    style={{ padding: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.feedback.warning.border, backgroundColor: colors.feedback.warning.bg }}
                >
                    <Text style={{ fontSize: 14, lineHeight: 20, color: colors.feedback.warning.fg }}>{REPAYMENT_COPY.banner(repayment)}</Text>
                </View>
            ) : null}
            <Pressable
                onPress={() => router.push('/pay-commons')} accessibilityRole="button" accessibilityHint="Pay Beans you hold to the Commons, or pay back a debt"
                style={{ minHeight: 48, justifyContent: 'center', alignSelf: 'flex-start', paddingHorizontal: 4 }}
            >
                <Text style={{ fontSize: 14, fontWeight: '600', color: colors.brand.primary }}>{REPAYMENT_COPY.payTitle}</Text>
            </Pressable>
        </View>
    );
}
