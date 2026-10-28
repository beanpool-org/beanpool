/**
 * Looking around as a visitor, on a phone with no account yet (slice S12, utils/look-around.ts): one line that says
 * nothing is kept, and Join, which opens the door (utils/look-door.ts). On Home and at the top of the Market, as the web
 * lobby's Join card is (apps/pwa GuestLobby.tsx). The header's Join pill leads to the same door.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { t } from '@beanpool/core';
import { type AppColors } from '../constants/colors';
import { openLookDoor } from '../utils/look-door';

export function LookAroundCard({ colors }: { colors: AppColors }) {
    return (
        <View style={[styles.card, { backgroundColor: colors.surface.card, borderColor: colors.border.default }]} testID="look-around-card">
            <Text style={[styles.body, { color: colors.text.body }]}>
                {t("You're looking around as a visitor. Nothing is saved until you join.")}
            </Text>
            <Pressable
                onPress={openLookDoor}
                style={[styles.primaryBtn, { backgroundColor: colors.brand.fill }]}
                accessibilityRole="button"
                testID="look-around-join"
            >
                <Text style={[styles.primaryText, { color: colors.text.inverse }]}>{t('Join')}</Text>
            </Pressable>
        </View>
    );
}

const styles = StyleSheet.create({
    card: { borderWidth: 1, borderRadius: 16, padding: 16, gap: 10, marginBottom: 12 },
    body: { fontSize: 15, lineHeight: 21 },
    primaryBtn: { minHeight: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 10 },
    primaryText: { fontSize: 15, fontWeight: '800', textAlign: 'center' },
});
