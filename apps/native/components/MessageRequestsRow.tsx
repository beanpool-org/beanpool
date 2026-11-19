import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { t, tn, requestsPillText } from '@beanpool/core';
import { useTheme, useStyles } from '../app/ThemeContext';

/**
 * Chat's one "Message requests" row (app/(tabs)/chats.tsx), drawn apart so the render tests draw this very row. Marty,
 * 19 Nov 2026 ("I thought that was a heading for the chat not a menu!!!"): it reads as a button, with how many wait in a
 * pill and a small red dot while one came since the member last opened the list (utils/requests-seen.ts). It replaced his
 * 1 Nov 2026 rule (plain: no count and no badge until one is accepted) for this row alone: still no push, and nothing in
 * the app-icon badge, the tab's badge or the unread count, so a stranger's line never rings a phone set to another
 * community. Colours from the theme's tokens only; at 320 dp with 1.3× text the words wrap and the pill stays whole.
 */
export function MessageRequestsRow({ count, unseen, onPress }: { count: number; unseen: boolean; onPress: () => void }) {
    const { colors } = useTheme();
    const styles = useStyles(({ colors: c }) => StyleSheet.create({
        row: {
            flexDirection: 'row',
            alignItems: 'center',
            minHeight: 52,
            marginHorizontal: 16,
            marginBottom: 10,
            paddingHorizontal: 14,
            paddingVertical: 8,
            gap: 10,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: c.border.default,
            backgroundColor: c.surface.card,
        },
        icon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: c.accent.tint },
        dot: {
            position: 'absolute', top: 0, right: 0, width: 10, height: 10, borderRadius: 5,
            backgroundColor: c.feedback.danger.solid, borderWidth: 1.5, borderColor: c.surface.card,
        },
        text: { flex: 1, fontSize: 15, fontWeight: '700', color: c.text.body },
        pill: { minWidth: 26, height: 22, paddingHorizontal: 7, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: c.surface.subtle, borderWidth: 1, borderColor: c.border.default },
        pillText: { fontSize: 13, fontWeight: '800', color: c.text.body },
    }));
    if (count <= 0) return null;
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={tn(count, 'Message requests: {n} waiting', 'Message requests: {n} waiting')}
            accessibilityHint={unseen ? t('New since you last looked') : undefined}
            testID="message-requests-row"
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surface.subtle }]}
            onPress={onPress}
        >
            <View style={styles.icon}>
                <MaterialCommunityIcons name="message-question-outline" size={20} color={colors.accent.primary} />
                {unseen ? <View style={styles.dot} testID="message-requests-dot" /> : null}
            </View>
            <Text style={styles.text}>{t('Message requests')}</Text>
            <View style={styles.pill}>
                <Text style={styles.pillText} testID="message-requests-count">{requestsPillText(count)}</Text>
            </View>
            <MaterialCommunityIcons name="chevron-right" size={22} color={colors.text.muted} />
        </Pressable>
    );
}

export default MessageRequestsRow;
