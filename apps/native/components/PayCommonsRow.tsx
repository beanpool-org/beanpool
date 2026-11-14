/**
 * The Wallet's row, for everyone (credit bar amendment §7b, slice R3, Marty's pick 2 of 14 Nov 2026): "Pay the Commons" with
 * its line and an arrow, opening the pay screen (app/pay-commons.tsx). A member working a debt off finds their own code
 * filled in there (pay-commons.tsx reads their repayment), as from the notice above the tabs (RepaymentCard.tsx).
 */
import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { router } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { t } from '@beanpool/core';
import { useTheme } from '../app/ThemeContext';
import { REPAYMENT_LINES } from './repayment-lines';

export function PayCommonsRow() {
    const { colors } = useTheme();
    return (
        <Pressable
            testID="ledger-pay-commons-row"
            onPress={() => router.push('/pay-commons')}
            accessibilityRole="button"
            accessibilityLabel={t(REPAYMENT_LINES.payTitle)}
            accessibilityHint={t(REPAYMENT_LINES.payRowLine)}
            style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 14, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.card }}
        >
            <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: '800', color: colors.text.heading }}>{t(REPAYMENT_LINES.payTitle)}</Text>
                <Text style={{ fontSize: 12, lineHeight: 16, marginTop: 2, color: colors.text.secondary }}>{t(REPAYMENT_LINES.payRowLine)}</Text>
            </View>
            <MaterialCommunityIcons name="chevron-right" size={20} color={colors.text.muted} />
        </Pressable>
    );
}
