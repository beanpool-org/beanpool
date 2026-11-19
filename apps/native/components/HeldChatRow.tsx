import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { t } from '@beanpool/core';
import { useTheme, useStyles } from '../app/ThemeContext';
import { MemberAvatar } from './MemberAvatar';
import { rowTime } from '../utils/your-groups';
import type { HeldChatRow as HeldChat } from '../utils/held-chats';

/**
 * A chat in another community this phone holds, in Chat's one list (slice S1, DESIGN-no-switch-messaging-fable.md §1, §6):
 * the other person, the time of the newest line the phone holds, and that community's name in grey with "· Switch", since a
 * tap still moves the phone there and opens the chat (reading it in place is slice S2). No preview of its lines yet (S2
 * opens them with that community's own pins). The photo is that community's (utils/db.ts getHeldConversations), never one
 * from the community in use. Drawn apart from the screen so the render tests draw this very row; at 320 dp with 1.3× text
 * the community's line wraps, never cut.
 */
export function HeldChatRow({ item, busy, onOpen }: { item: HeldChat; busy: boolean; onOpen: (item: HeldChat) => void }) {
    const { colors } = useTheme();
    const styles = useStyles(({ colors: c }) => StyleSheet.create({
        row: {
            flexDirection: 'row', paddingVertical: 10, paddingHorizontal: 12,
            marginHorizontal: 16, marginVertical: 4, borderRadius: 14,
            backgroundColor: c.surface.card, borderWidth: 1, borderColor: c.border.default, alignItems: 'center',
        },
        avatar: { width: 50, height: 50, justifyContent: 'center', alignItems: 'center', marginRight: 16 },
        details: { flex: 1 },
        header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 },
        name: { fontSize: 16, fontWeight: '700', color: c.text.body, flexShrink: 1 },
        time: { fontSize: 12, color: c.text.muted, fontWeight: '500', marginLeft: 8 },
        where: { flexDirection: 'row', alignItems: 'flex-start', gap: 4 },
        whereText: { fontSize: 13, color: c.text.secondary, flexShrink: 1 },
    }));
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('Chat with {name} in {community}. Opens that community.', { name: item.peer, community: item.communityName })}
            testID="held-chat-row"
            style={styles.row}
            disabled={busy}
            onPress={() => onOpen(item)}
        >
            <View style={styles.avatar}>
                <MemberAvatar avatarUrl={item.peerAvatar} pubkey={item.peerPubkey || ''} callsign={item.peer} updatedAt={item.peerUpdatedAt} size={44} />
            </View>
            <View style={styles.details}>
                <View style={styles.header}>
                    <Text style={styles.name} numberOfLines={1}>{item.peer}</Text>
                    <Text style={styles.time}>{rowTime(item.rawTimestamp ?? item.createdAt)}</Text>
                </View>
                <View style={styles.where}>
                    <MaterialCommunityIcons name="home-group" size={14} color={colors.text.secondary} />
                    <Text style={styles.whereText} testID="held-chat-community">{t('{community} · Switch', { community: item.communityName })}</Text>
                </View>
            </View>
        </Pressable>
    );
}

export default HeldChatRow;
