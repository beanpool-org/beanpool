import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { router } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { t } from '@beanpool/core';
import { useStyles, useTheme } from '../app/ThemeContext';
import { CLAIM_NEW_SERVER_ROUTE } from '../utils/claim-link';

/**
 * "Set up a new community server": the way in for someone who has just installed BeanPool on a server, where they look
 * for one (Find a community, Start a community). It opens the claim screen with no server yet (app/claim-community.tsx),
 * whose Scan the code reads the QR `beanpool claim` shows. Before it, only the phone's camera (the QR's beanpool://claim
 * link) or Settings → Link a device reached that scanner (Marty's claim, 17 Oct).
 *
 * A row as Find a community's others: icon, title, a line under it, chevron; the words wrap at 320 dp and 1.3×.
 */
export function SetUpServerRow({ divider = false }: { divider?: boolean }) {
    const { colors } = useTheme();
    const styles = useStyles(({ colors }) => StyleSheet.create({
        row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 10 },
        divider: { borderTopWidth: 1, borderTopColor: colors.border.default },
        rowText: { flex: 1, minWidth: 0 },
        rowTitle: { fontSize: 16, fontWeight: '600', color: colors.text.heading },
        rowSub: { fontSize: 13, color: colors.text.secondary, marginTop: 2, lineHeight: 18 },
    }));
    return (
        <Pressable style={[styles.row, divider && styles.divider]} onPress={() => router.push(CLAIM_NEW_SERVER_ROUTE)} accessibilityRole="button" testID="set-up-server">
            <MaterialCommunityIcons name="server-plus" size={24} color={colors.brand.primary} />
            <View style={styles.rowText}>
                <Text style={styles.rowTitle}>{t('Set up a new community server')}</Text>
                <Text style={styles.rowSub}>{t('Installed BeanPool on a server? Scan the code it shows to become its owner.')}</Text>
            </View>
            <MaterialCommunityIcons name="chevron-right" size={22} color={colors.text.muted} />
        </Pressable>
    );
}
