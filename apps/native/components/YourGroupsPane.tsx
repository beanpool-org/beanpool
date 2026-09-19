/**
 * The "Your groups" list with its "New group" button — Talk → Groups (with unread badges) and the top half of
 * Commons → Groups (without; groups decision 7). Tapping a row opens the one chat screen; "New group" opens the
 * one Create a Group form (decision 4) and, once created, lands in the new group's chat (decision 8).
 *
 * Presentational: the caller owns the data, so Talk can show the Groups total on its switch while on Messages.
 */

import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme, useStyles } from '../app/ThemeContext';
import { YourGroupRow } from './YourGroupRow';
import { CreateGroupModal } from './CreateGroupModal';
import { chatHref, type YourChat } from '../utils/your-groups';

export function NewGroupButton({ onPress, compact }: { onPress: () => void; compact?: boolean }) {
    const { colors } = useTheme();
    const styles = useStyles(({ colors }) => StyleSheet.create({
        btn: {
            flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 48,
            borderRadius: 14, paddingHorizontal: 16, backgroundColor: colors.brand.primary,
        },
        text: { color: colors.text.inverse, fontSize: 15, fontWeight: '800' },
    }));
    return (
        <Pressable style={[styles.btn, compact && { alignSelf: 'flex-start' }]} onPress={onPress} accessibilityRole="button" accessibilityLabel="New group">
            <MaterialCommunityIcons name="account-multiple-plus" size={20} color={colors.text.inverse} />
            <Text style={styles.text} numberOfLines={1}>New group</Text>
        </Pressable>
    );
}

/** Rows only (no scroll container), for embedding in a parent list's header. */
export function YourGroupsRows({ items, myPubkey, showUnread, flush }: { items: YourChat[]; myPubkey?: string | null; showUnread?: boolean; flush?: boolean }) {
    return (
        <>
            {items.map(item => (
                <YourGroupRow
                    key={`${item.kind}:${item.id}`}
                    item={item}
                    myPubkey={myPubkey}
                    showUnread={showUnread}
                    flush={flush}
                    onPress={(it) => router.push(chatHref(it) as any)}
                />
            ))}
        </>
    );
}

export function useCreateGroupFlow(onCreated?: () => void) {
    const [open, setOpen] = useState(false);
    const modal = (
        <CreateGroupModal
            isOpen={open}
            onClose={() => setOpen(false)}
            onCreated={(group) => {
                onCreated?.();
                // Decision 8: straight into the new group's chat, which asks who to invite.
                router.push(chatHref({ kind: 'group', conversationId: group.id, name: group.name }, { created: true }) as any);
            }}
        />
    );
    return { open: () => setOpen(true), modal };
}

export function YourGroupsEmpty({ onNew, onFindGroups }: { onNew: () => void; onFindGroups?: () => void }) {
    const { colors } = useTheme();
    const styles = useStyles(({ colors }) => StyleSheet.create({
        wrap: { alignItems: 'center', paddingHorizontal: 24, paddingVertical: 40 },
        emoji: { fontSize: 44 },
        title: { fontSize: 18, fontWeight: '800', color: colors.text.heading, marginTop: 10, textAlign: 'center' },
        body: { fontSize: 14, lineHeight: 20, color: colors.text.secondary, marginTop: 6, textAlign: 'center' },
        find: { minHeight: 48, justifyContent: 'center', marginTop: 8, paddingHorizontal: 12 },
        findText: { fontSize: 15, fontWeight: '700', color: colors.brand.primary },
    }));
    return (
        <View style={styles.wrap}>
            <Text style={styles.emoji} allowFontScaling={false}>🌻</Text>
            <Text style={styles.title}>No groups yet</Text>
            <Text style={styles.body}>
                A group is a chat for some people rather than everyone — your street, a garden crew, a choir.
                Enterprises you keep and events you're going to show up here too.
            </Text>
            <View style={{ height: 16 }} />
            <NewGroupButton onPress={onNew} />
            {onFindGroups && (
                <Pressable style={styles.find} onPress={onFindGroups} accessibilityRole="button">
                    <Text style={styles.findText}>Find a group to join →</Text>
                </Pressable>
            )}
        </View>
    );
}

export function YourGroupsLoading() {
    const { colors } = useTheme();
    return <ActivityIndicator style={{ marginTop: 32 }} color={colors.brand.primary} />;
}

export function YourGroupsError({ message }: { message: string }) {
    const { colors } = useTheme();
    return <Text style={{ margin: 16, fontSize: 14, color: colors.text.secondary, textAlign: 'center' }} accessibilityRole="alert">{message}</Text>;
}
