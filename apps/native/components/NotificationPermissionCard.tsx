/**
 * Front doors S3: notification permission at the tap, never at account creation (Fable design §0, §1.9, §3.9, §7).
 *
 * "Turn on notifications?" card shown on Home until answered (and at the end of How it Works).
 * Asks with the app's one-line reason first:
 * - Title: "Turn on notifications?"
 * - Body: "So you hear when someone answers you, messages you, or asks to join. Nothing else."
 * - Buttons: "Turn on" · "Not now"
 */
import React, { useCallback, useState } from 'react';
import { View, Text, Pressable, StyleSheet, AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { t } from '@beanpool/core';
import { type AppColors } from '../constants/colors';
import { useIdentity } from '../app/IdentityContext';
import {
    checkOsNotificationPermission,
    declineNotifications,
    readNotificationPermissionRecord,
    shouldShowNotificationCard,
    turnOnNotifications,
} from '../utils/notification-permission';

export function NotificationPermissionCard({ colors, onAnswered }: { colors: AppColors; onAnswered?: () => void }) {
    const { identity } = useIdentity();
    const [visible, setVisible] = useState(false);
    const [busy, setBusy] = useState(false);

    useFocusEffect(
        useCallback(() => {
            let live = true;
            const check = async () => {
                const [record, osGranted] = await Promise.all([
                    readNotificationPermissionRecord(),
                    checkOsNotificationPermission(),
                ]);
                if (live) {
                    setVisible(shouldShowNotificationCard(record, osGranted));
                }
            };
            void check();
            // Back from the phone's settings (Turn on when the phone won't ask again): the card goes once they allow it.
            const sub = AppState?.addEventListener?.('change', (next) => { if (next === 'active') void check(); });
            return () => { live = false; sub?.remove(); };
        }, []),
    );

    if (!visible) return null;

    const handleTurnOn = async () => {
        if (busy) return;
        setBusy(true);
        try {
            const result = await turnOnNotifications(identity?.publicKey);
            // 'settings': the phone's settings opened; nothing is answered yet, so the card stays.
            if (result !== 'settings') {
                setVisible(false);
                onAnswered?.();
            }
        } finally {
            setBusy(false);
        }
    };

    const handleNotNow = async () => {
        if (busy) return;
        setBusy(true);
        try {
            await declineNotifications();
            setVisible(false);
            onAnswered?.();
        } finally {
            setBusy(false);
        }
    };

    return (
        <View style={[styles.card, { backgroundColor: colors.surface.card, borderColor: colors.border.default }]} testID="notification-permission-card">
            <Text style={[styles.title, { color: colors.text.heading }]} accessibilityRole="header">
                {t('Turn on notifications?')}
            </Text>
            <Text style={[styles.body, { color: colors.text.body }]}>
                {t('So you hear when someone answers you, messages you, or asks to join. Nothing else.')}
            </Text>
            <Pressable
                onPress={() => { handleTurnOn().catch(() => {}); }}
                disabled={busy}
                style={[styles.primaryBtn, { backgroundColor: colors.brand.fill }, busy && { opacity: 0.6 }]}
                accessibilityRole="button"
                accessibilityState={{ busy, disabled: busy }}
                testID="notification-card-turn-on"
            >
                <Text style={[styles.primaryText, { color: colors.text.inverse }]}>{t('Turn on')}</Text>
            </Pressable>
            <Pressable
                onPress={() => { handleNotNow().catch(() => {}); }}
                disabled={busy}
                style={[styles.secondaryBtn, busy && { opacity: 0.6 }]}
                accessibilityRole="button"
                accessibilityState={{ busy, disabled: busy }}
                testID="notification-card-not-now"
            >
                <Text style={[styles.secondaryText, { color: colors.text.secondary }]}>{t('Not now')}</Text>
            </Pressable>
        </View>
    );
}

const styles = StyleSheet.create({
    card: { borderWidth: 1, borderRadius: 16, padding: 16, gap: 10, marginBottom: 12 },
    title: { fontSize: 17, lineHeight: 23, fontWeight: '800' },
    body: { fontSize: 15, lineHeight: 21 },
    primaryBtn: { minHeight: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 10 },
    primaryText: { fontSize: 15, fontWeight: '800', textAlign: 'center' },
    secondaryBtn: { minHeight: 48, alignItems: 'center', justifyContent: 'center' },
    secondaryText: { fontSize: 15, fontWeight: '700', textAlign: 'center' },
});
