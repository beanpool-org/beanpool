/**
 * The one calm line a tap on a notification the phone can't trust shows (utils/push-notice-check.ts): it didn't come
 * from the member's community, ignore what it said, and BeanPool never asks for the 12 words or a password in one.
 * Mounted once, over every screen, by the root layout. It shows once per such tap, including the tap that launched the
 * app (held until this is drawn), and goes when the member presses OK.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStyles } from '../app/ThemeContext';
import { FORGED_NOTICE_LINE, onNoticeWarning, takeNoticeWarning } from '../utils/push-notice-check';
import { PUSH_NOTICE_WARNING_INSET, PUSH_NOTICE_WARNING_OK, pushNoticeWarningStyleSpec } from '../utils/push-notice-warning-style';

export function PushNoticeWarning() {
    const styles = useStyles(({ colors }) => StyleSheet.create(pushNoticeWarningStyleSpec(colors)));
    const insets = useSafeAreaInsets();
    const [shown, setShown] = useState(false);

    useEffect(() => {
        if (takeNoticeWarning()) setShown(true);
        return onNoticeWarning(() => {
            if (takeNoticeWarning()) setShown(true);
        });
    }, []);

    if (!shown) return null;

    return (
        <View style={[styles.card, { top: insets.top + PUSH_NOTICE_WARNING_INSET }]} accessibilityRole="alert" accessibilityLiveRegion="polite">
            <Text style={styles.line}>{FORGED_NOTICE_LINE}</Text>
            <View style={styles.buttonRow}>
                <Pressable style={styles.okBtn} onPress={() => setShown(false)} accessibilityRole="button">
                    <Text style={styles.okBtnText}>{PUSH_NOTICE_WARNING_OK}</Text>
                </Pressable>
            </View>
        </View>
    );
}
