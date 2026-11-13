import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, AppState } from 'react-native';
import { t } from '@beanpool/core';
import { type AppColors } from '../constants/colors';
import {
    NOTIFICATIONS_OFF_HERE, NOTIFICATION_CARD_WORDS, notificationsOffHere, readOsNotificationPermission, turnOnNotifications,
} from '../utils/notification-permission';

/**
 * The bell sheet's last line while this phone can't buzz (DESIGN-home-default-fable.md §2.5 "How to turn on later"):
 * "Notifications are off on this phone. Turn on". The way back after a "Not now", found where a missed answer is: only a
 * tap on Turn on brings the phone's own question (or, where the phone won't ask again, its settings). Nothing where the
 * phone already allows them or can't load notifications at all. Read again each time the sheet opens and when the app
 * comes back (from the phone's settings).
 */
export function NotificationsOffLine({ publicKey, colors }: { publicKey: string | null | undefined; colors: AppColors }) {
    const [off, setOff] = useState(false);
    const [busy, setBusy] = useState(false);
    const check = useCallback(async () => {
        setOff(notificationsOffHere(await readOsNotificationPermission()));
    }, []);
    useEffect(() => {
        let live = true;
        void readOsNotificationPermission().then(os => { if (live) setOff(notificationsOffHere(os)); });
        const sub = AppState?.addEventListener?.('change', (next) => { if (next === 'active') void check(); });
        return () => { live = false; sub?.remove(); };
    }, [check]);
    if (!off || !publicKey) return null;
    const turnOn = t(NOTIFICATION_CARD_WORDS.turnOn);
    return (
        <View style={s.row} testID="bell-notifications-off">
            <Text style={[s.words, { color: colors.text.secondary }]}>{t(NOTIFICATIONS_OFF_HERE)}</Text>
            <Pressable
                onPress={async () => {
                    if (busy) return;
                    setBusy(true);
                    try {
                        await turnOnNotifications(publicKey);
                        await check();
                    } finally {
                        setBusy(false);
                    }
                }}
                disabled={busy}
                style={({ pressed }) => [s.link, pressed && { backgroundColor: colors.surface.subtle }]}
                accessibilityRole="button"
                accessibilityLabel={turnOn}
                accessibilityState={{ busy, disabled: busy }}
                testID="bell-notifications-turn-on"
            >
                <Text style={[s.linkText, { color: colors.text.link }]}>{turnOn}</Text>
            </Pressable>
        </View>
    );
}

const s = StyleSheet.create({
    // The words and the link wrap onto their own rows at 320 dp and 1.3x text; the link keeps the 44 dp touch floor.
    row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, paddingTop: 4 },
    words: { fontSize: 13, textAlign: 'center' },
    link: { minHeight: 44, paddingHorizontal: 10, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
    linkText: { fontSize: 14, fontWeight: '700' },
});
