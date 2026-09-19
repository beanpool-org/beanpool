/**
 * One row of "Your groups" (groups decisions 6, 7, 13). The same row in Talk → Groups and Commons → Groups;
 * only Talk passes `showUnread` (decision 7: unread badges live on one tab so nobody clears a count twice).
 *
 * At 320dp and 1.3× text: the name takes one line and truncates, the time never shrinks, the preview takes one
 * line, and the whole row is one ≥48dp target.
 */

import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme, useStyles } from '../app/ThemeContext';
import { chatEmoji, previewLine, rowTime, unreadLabel, isMuted, type YourChat } from '../utils/your-groups';

interface Props {
    item: YourChat;
    myPubkey?: string | null;
    showUnread?: boolean;
    onPress: (item: YourChat) => void;
    /** Inside a list that already pads its sides (Commons). */
    flush?: boolean;
}

export function YourGroupRow({ item, myPubkey, showUnread = false, onPress, flush }: Props) {
    const { colors } = useTheme();
    const styles = useStyles(({ colors, theme }) => StyleSheet.create({
        row: {
            flexDirection: 'row', alignItems: 'center', minHeight: 64, paddingVertical: 10, paddingHorizontal: 12,
            marginHorizontal: 16, marginVertical: 4, borderRadius: 14,
            backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.default,
        },
        icon: {
            width: 46, height: 46, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginRight: 12,
            backgroundColor: colors.surface.subtle, flexShrink: 0,
        },
        iconEnterprise: { backgroundColor: theme === 'dark' ? 'rgba(217,119,6,0.18)' : '#fef3c7' },
        iconEvent: { backgroundColor: theme === 'dark' ? 'rgba(124,58,237,0.18)' : '#f5f3ff' },
        iconText: { fontSize: 24 },
        body: { flex: 1, minWidth: 0 },
        top: { flexDirection: 'row', alignItems: 'center', gap: 6 },
        name: { flex: 1, minWidth: 0, fontSize: 16, fontWeight: '700', color: colors.text.body },
        nameUnread: { fontWeight: '900', color: colors.text.heading },
        time: { flexShrink: 0, fontSize: 12, color: colors.text.muted, fontWeight: '500' },
        timeUnread: { color: colors.accent.primary, fontWeight: '700' },
        bottom: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 },
        kindPill: {
            flexShrink: 0, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6,
            backgroundColor: colors.surface.subtle,
        },
        kindPillText: { fontSize: 11, fontWeight: '700', color: colors.text.secondary },
        preview: { flex: 1, minWidth: 0, fontSize: 14, color: colors.text.secondary },
        previewUnread: { color: colors.text.heading, fontWeight: '700' },
        badge: {
            flexShrink: 0, minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 6,
            backgroundColor: colors.accent.primary, alignItems: 'center', justifyContent: 'center',
        },
        badgeMuted: { backgroundColor: colors.text.muted },
        badgeText: { color: colors.text.inverse, fontSize: 11, fontWeight: '800' },
    }));

    const unread = showUnread ? item.unreadCount : 0;
    const muted = isMuted(item.mute);
    const kindWord = item.kind === 'enterprise' ? 'Enterprise' : item.kind === 'event' ? 'Event' : null;
    const preview = previewLine(item, myPubkey);
    const time = rowTime(item.lastMessage?.timestamp ?? null);

    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${item.name}${kindWord ? `, ${kindWord.toLowerCase()}` : ', group'}${unread ? `, ${unread} unread` : ''}${muted ? ', muted' : ''}. ${preview}`}
            style={[styles.row, flush && { marginHorizontal: 0 }]}
            onPress={() => onPress(item)}
        >
            <View style={[styles.icon, item.kind === 'enterprise' && styles.iconEnterprise, item.kind === 'event' && styles.iconEvent]}>
                <Text style={styles.iconText} allowFontScaling={false}>{chatEmoji(item.kind, item.category)}</Text>
            </View>
            <View style={styles.body}>
                <View style={styles.top}>
                    <Text style={[styles.name, unread > 0 && styles.nameUnread]} numberOfLines={1}>{item.name}</Text>
                    {muted && <MaterialCommunityIcons name="bell-off-outline" size={14} color={colors.text.muted} />}
                    {!!time && <Text style={[styles.time, unread > 0 && styles.timeUnread]} numberOfLines={1}>{time}</Text>}
                </View>
                <View style={styles.bottom}>
                    {kindWord && (
                        <View style={styles.kindPill}>
                            <Text style={styles.kindPillText} maxFontSizeMultiplier={1.2} numberOfLines={1}>{kindWord}</Text>
                        </View>
                    )}
                    <Text style={[styles.preview, unread > 0 && styles.previewUnread]} numberOfLines={1}>{preview}</Text>
                    {unread > 0 && (
                        <View style={[styles.badge, muted && styles.badgeMuted]}>
                            <Text style={styles.badgeText} maxFontSizeMultiplier={1.2}>{unreadLabel(unread)}</Text>
                        </View>
                    )}
                </View>
            </View>
        </Pressable>
    );
}
