/**
 * Invite people to a group (groups decision 8). Opened from the new group's empty chat ("Who do you want to
 * invite?") and, permanently, from the group chat's header menu. Pick members of this community, then one tap
 * sends each an invitation (POST /api/groups/:id/members, action 'invite'); the server writes the joins into the
 * chat as system lines when they accept.
 *
 * Keyboard: lifted by useModalKeyboardLift from the root provider's state, NO nested KeyboardProvider inside this
 * Modal (memory keyboard-avoidance-pattern); the keyboard is dismissed before any Alert.
 * At 320dp and 1.3× text every row is a 56dp target, names truncate, the Invite button never leaves the screen.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Modal, View, Text, TextInput, Pressable, FlatList, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { KeyboardController } from 'react-native-keyboard-controller';
import { useModalKeyboardLift } from './useModalKeyboardLift';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme, useStyles } from '../app/ThemeContext';
import { getInvitablePeople, inviteGroupMemberApi } from '../utils/db';
import { MemberAvatar } from './MemberAvatar';
import { hapticSuccess, hapticTick } from '../utils/haptics';

interface Props {
    isOpen: boolean;
    groupId: string;
    groupName: string;
    /** Already in the group (or already invited): shown ticked and disabled. */
    existing: ReadonlySet<string>;
    myPubkey?: string | null;
    onClose: () => void;
    onInvited?: (count: number) => void;
}

export function InvitePeopleSheet({ isOpen, groupId, groupName, existing, myPubkey, onClose, onInvited }: Props) {
    const { colors } = useTheme();
    const insets = useSafeAreaInsets();
    const lift = useModalKeyboardLift(insets.top + 8, 0.92);
    const [members, setMembers] = useState<{ publicKey: string; callsign: string; avatarUrl: string | null }[]>([]);
    const [query, setQuery] = useState('');
    const [picked, setPicked] = useState<Set<string>>(new Set());
    const [sending, setSending] = useState(false);

    useEffect(() => {
        if (!isOpen) return;
        setPicked(new Set());
        setQuery('');
        getInvitablePeople().then(setMembers).catch(() => setMembers([]));
    }, [isOpen]);

    const shown = useMemo(() => {
        const q = query.trim().toLowerCase();
        return members
            .filter(m => m.publicKey !== myPubkey)
            .filter(m => !q || (m.callsign || '').toLowerCase().includes(q));
    }, [members, query, myPubkey]);

    const styles = useStyles(({ colors }) => StyleSheet.create({
        backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
        sheet: {
            backgroundColor: colors.surface.card, borderTopLeftRadius: 24, borderTopRightRadius: 24,
            flexShrink: 1,
        },
        header: {
            flexDirection: 'row', alignItems: 'center', paddingLeft: 20, paddingRight: 4, paddingVertical: 6,
            borderBottomWidth: 1, borderBottomColor: colors.border.default,
        },
        titleWrap: { flex: 1, minWidth: 0 },
        title: { fontSize: 18, fontWeight: '800', color: colors.text.heading },
        sub: { fontSize: 13, color: colors.text.secondary, marginTop: 1 },
        closeBtn: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
        search: {
            flexDirection: 'row', alignItems: 'center', margin: 12, paddingHorizontal: 12, minHeight: 48,
            borderRadius: 12, backgroundColor: colors.surface.subtle,
        },
        searchInput: { flex: 1, fontSize: 15, color: colors.text.body, paddingVertical: 8, marginLeft: 6 },
        row: { flexDirection: 'row', alignItems: 'center', minHeight: 56, paddingHorizontal: 16, gap: 12 },
        name: { flex: 1, minWidth: 0, fontSize: 16, fontWeight: '600', color: colors.text.body },
        already: { fontSize: 12, color: colors.text.muted, flexShrink: 0 },
        empty: { padding: 24, textAlign: 'center', color: colors.text.secondary, fontSize: 14 },
        footer: { paddingHorizontal: 16, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border.default },
        inviteBtn: {
            minHeight: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
            backgroundColor: colors.brand.primary, paddingHorizontal: 16,
        },
        inviteBtnDisabled: { opacity: 0.5 },
        inviteText: { color: colors.text.inverse, fontSize: 16, fontWeight: '800' },
    }));

    const toggle = (pk: string) => {
        hapticTick();
        setPicked(prev => {
            const next = new Set(prev);
            if (next.has(pk)) next.delete(pk); else next.add(pk);
            return next;
        });
    };

    const send = async () => {
        if (!picked.size || sending) return;
        setSending(true);
        await Promise.race([KeyboardController.dismiss(), new Promise(r => setTimeout(r, 400))]);
        const keys = [...picked];
        const failed: string[] = [];
        for (const pk of keys) {
            try { await inviteGroupMemberApi(groupId, pk); } catch { failed.push(pk); }
        }
        setSending(false);
        const sent = keys.length - failed.length;
        if (sent > 0) hapticSuccess();
        if (failed.length) {
            const names = members.filter(m => failed.includes(m.publicKey)).map(m => m.callsign).join(', ');
            Alert.alert('Some invitations were not sent', `${sent} sent. Not sent: ${names}. Try again when you have signal.`);
        }
        onInvited?.(sent);
        if (!failed.length) onClose();
    };

    const count = picked.size;

    return (
        <Modal visible={isOpen} animationType="slide" transparent onRequestClose={onClose}>
            <View style={[styles.backdrop, { paddingTop: insets.top + 8 }]}>
                <View style={[styles.sheet, {
                    paddingBottom: Math.max(insets.bottom, 12),
                    maxHeight: lift.maxHeight, marginBottom: lift.lift,
                    // Tall enough to pick from when there is room; never taller than what is left above the keyboard.
                    minHeight: Math.min(lift.maxHeight, 360),
                }]}>
                    <View style={styles.header}>
                        <View style={styles.titleWrap}>
                            <Text style={styles.title} numberOfLines={1}>Invite people</Text>
                            <Text style={styles.sub} numberOfLines={1}>to {groupName}</Text>
                        </View>
                        <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} style={styles.closeBtn}>
                            <MaterialCommunityIcons name="close" size={24} color={colors.text.muted} />
                        </Pressable>
                    </View>
                    <View style={styles.search}>
                        <MaterialCommunityIcons name="magnify" size={20} color={colors.text.muted} />
                        <TextInput
                            style={styles.searchInput}
                            value={query}
                            onChangeText={setQuery}
                            placeholder="Search people in this community"
                            placeholderTextColor={colors.text.muted}
                            accessibilityLabel="Search people"
                        />
                    </View>
                    <FlatList
                        data={shown}
                        style={{ flexShrink: 1 }}
                        keyExtractor={m => m.publicKey}
                        keyboardShouldPersistTaps="handled"
                        ListEmptyComponent={<Text style={styles.empty}>{query ? 'Nobody by that name.' : 'Nobody else is in this community yet.'}</Text>}
                        renderItem={({ item }) => {
                            const already = existing.has(item.publicKey);
                            const on = already || picked.has(item.publicKey);
                            return (
                                <Pressable
                                    style={styles.row}
                                    disabled={already}
                                    onPress={() => toggle(item.publicKey)}
                                    accessibilityRole="checkbox"
                                    accessibilityState={{ checked: on, disabled: already }}
                                    accessibilityLabel={`${item.callsign}${already ? ', already in the group' : ''}`}
                                >
                                    <MemberAvatar avatarUrl={item.avatarUrl} pubkey={item.publicKey} callsign={item.callsign} size={36} />
                                    <Text style={styles.name} numberOfLines={1}>{item.callsign}</Text>
                                    {already && <Text style={styles.already}>In the group</Text>}
                                    <MaterialCommunityIcons
                                        name={on ? 'checkbox-marked-circle' : 'checkbox-blank-circle-outline'}
                                        size={26}
                                        color={already ? colors.text.muted : on ? colors.brand.primary : colors.border.strong}
                                    />
                                </Pressable>
                            );
                        }}
                    />
                    <View style={styles.footer}>
                        <Pressable
                            onPress={send}
                            disabled={!count || sending}
                            style={[styles.inviteBtn, (!count || sending) && styles.inviteBtnDisabled]}
                            accessibilityRole="button"
                            accessibilityState={{ disabled: !count || sending, busy: sending }}
                        >
                            {sending
                                ? <ActivityIndicator color={colors.text.inverse} />
                                : <Text style={styles.inviteText} numberOfLines={1}>{count ? `Invite ${count} ${count === 1 ? 'person' : 'people'}` : 'Pick people to invite'}</Text>}
                        </Pressable>
                    </View>
                </View>
            </View>
        </Modal>
    );
}
