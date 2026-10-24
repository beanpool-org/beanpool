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
import { sendGroupInvitations } from '../utils/group-invite-send';
import { t, tn } from '@beanpool/core';
import { useNodeProfile } from '../utils/use-node-profile';
import { membersByKey } from '../utils/node-profile';
import { lookUpMembers, searchPath } from '../utils/members-lookup';
import { pickerEmpty } from '../utils/community-list-note';
import { MemberAvatar } from './MemberAvatar';
import { hapticSuccess, hapticTick } from '../utils/haptics';

interface Props {
    isOpen: boolean;
    groupId: string;
    groupName: string;
    /** Already in the group: shown ticked and disabled. */
    existing: ReadonlySet<string>;
    /** Already invited to the group: shown with clock icon and disabled (damo-1021). */
    invited?: ReadonlySet<string>;
    /** Asked to join the group (pending approval): shown disabled. */
    pending?: ReadonlySet<string>;
    myPubkey?: string | null;
    onClose: () => void;
    onInvited?: (count: number) => void;
}

export function InvitePeopleSheet({ isOpen, groupId, groupName, existing, invited, pending, myPubkey, onClose, onInvited }: Props) {
    const { colors } = useTheme();
    const insets = useSafeAreaInsets();
    const lift = useModalKeyboardLift(insets.top + 8, 0.92);
    // null while the people list is on its way: "nobody here" is only said once the node (or the phone's copy) has
    // actually answered with nobody.
    const [members, setMembers] = useState<{ publicKey: string; callsign: string; avatarUrl: string | null }[] | null>(null);
    const [query, setQuery] = useState('');
    const [picked, setPicked] = useState<Set<string>>(new Set());
    const [sending, setSending] = useState(false);
    // On a community that says `membersOnDemand`: the people this member has dealt with, and a search of 2 letters or
    // more asks the node (utils/members-lookup.ts). Anywhere else, the whole list as always.
    const membersOnDemand = membersByKey(useNodeProfile()?.features);
    const [nodeResults, setNodeResults] = useState<{ publicKey: string; callsign: string; avatarUrl: string | null }[]>([]);
    // What became of the node search, for the empty list's words (the New message picker's): never "Nobody else is in
    // this community" over a list that is only the people this member has dealt with (review of #1859, B3).
    const [nodeSearch, setNodeSearch] = useState<'none' | 'answered' | 'unreachable'>('none');

    useEffect(() => {
        if (!isOpen) return;
        setPicked(new Set());
        setQuery('');
        setMembers(null);
        let alive = true;
        getInvitablePeople(membersOnDemand ? { membersOnDemand } : undefined).then(m => { if (alive) setMembers(m); }).catch(() => { if (alive) setMembers([]); });
        return () => { alive = false; };
    }, [isOpen, membersOnDemand]);

    useEffect(() => {
        if (!membersOnDemand) return;
        const path = searchPath(query);
        if (!path) {
            setNodeResults([]);
            setNodeSearch('none');
            return;
        }
        let alive = true;
        const timeout = setTimeout(async () => {
            const rows = await lookUpMembers(path);
            if (!alive) return;
            setNodeResults((rows ?? []).map(r => ({ publicKey: r.public_key, callsign: r.callsign, avatarUrl: r.avatar_url })));
            setNodeSearch(rows === null ? 'unreachable' : 'answered');
        }, 400);
        return () => { alive = false; clearTimeout(timeout); };
    }, [query, membersOnDemand]);

    const shown = useMemo(() => {
        const q = query.trim().toLowerCase();
        const held = (members || [])
            .filter(m => m.publicKey !== myPubkey)
            .filter(m => !q || (m.callsign || '').toLowerCase().includes(q));
        if (nodeResults.length === 0) return held;
        const seen = new Set(held.map(m => m.publicKey));
        return [...held, ...nodeResults.filter(m => m.publicKey !== myPubkey && !seen.has(m.publicKey))];
    }, [members, query, myPubkey, nodeResults]);

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
        nameCol: { flex: 1, minWidth: 0, justifyContent: 'center' },
        name: { fontSize: 16, fontWeight: '600', color: colors.text.body },
        keyPrefix: { fontSize: 12, color: colors.text.muted, marginTop: 1 },
        already: { fontSize: 12, color: colors.text.muted, flexShrink: 0 },
        empty: { padding: 24, textAlign: 'center', color: colors.text.secondary, fontSize: 14 },
        emptyTitle: { paddingTop: 24, paddingHorizontal: 24, textAlign: 'center', color: colors.text.body, fontSize: 15, fontWeight: '700' },
        emptySubtitle: { paddingTop: 4, paddingHorizontal: 24, paddingBottom: 24, textAlign: 'center', color: colors.text.secondary, fontSize: 14 },
        footer: { paddingHorizontal: 16, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border.default },
        inviteBtn: {
            minHeight: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
            backgroundColor: colors.brand.fill, paddingHorizontal: 16,
        },
        inviteBtnDisabled: { opacity: 0.5 },
        inviteText: { color: colors.text.inverse, fontSize: 16, fontWeight: '800' },
    }));

    const toggle = (pk: string) => {
        if (existing.has(pk) || invited?.has(pk) || pending?.has(pk)) return;
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
        const { failed, refusal } = await sendGroupInvitations(keys, pk => inviteGroupMemberApi(groupId, pk));
        setSending(false);
        const sent = keys.length - failed.length;
        if (sent > 0) hapticSuccess();
        if (failed.length) {
            const names = (members || []).filter(m => failed.includes(m.publicKey)).map(m => m.callsign).join(', ');
            // A refusal is said in the node's words (it won't pass when the signal comes back); anything else is the signal.
            Alert.alert(t('Some invitations were not sent'), refusal
                ? t('{sent} sent. Not sent: {names}. {reason}', { sent: String(sent), names, reason: refusal })
                : t('{sent} sent. Not sent: {names}. Try again when you have signal.', { sent: String(sent), names }));
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
                            <Text style={styles.title} numberOfLines={1}>{t('Invite people')}</Text>
                            <Text style={styles.sub} numberOfLines={1}>{t('to {name}', { name: groupName })}</Text>
                        </View>
                        <Pressable accessibilityRole="button" accessibilityLabel={t('Close')} onPress={onClose} style={styles.closeBtn}>
                            <MaterialCommunityIcons name="close" size={24} color={colors.text.muted} />
                        </Pressable>
                    </View>
                    <View style={styles.search}>
                        <MaterialCommunityIcons name="magnify" size={20} color={colors.text.muted} />
                        <TextInput
                            style={styles.searchInput}
                            value={query}
                            onChangeText={setQuery}
                            placeholder={t('Search people')}
                            placeholderTextColor={colors.text.muted}
                            accessibilityLabel={t('Search people')}
                        />
                    </View>
                    <FlatList
                        data={shown}
                        style={{ flexShrink: 1 }}
                        keyExtractor={m => m.publicKey}
                        keyboardShouldPersistTaps="handled"
                        ListEmptyComponent={members === null
                            ? <ActivityIndicator style={{ padding: 24 }} color={colors.brand.primary} accessibilityLabel={t('Loading people')} />
                            : membersOnDemand
                            ? <View>
                                <Text style={styles.emptyTitle}>{pickerEmpty(query, nodeSearch).title}</Text>
                                <Text style={styles.emptySubtitle}>{pickerEmpty(query, nodeSearch).subtitle}</Text>
                              </View>
                            : <Text style={styles.empty}>{query ? t('Nobody by that name.') : t('Nobody else is in this community yet.')}</Text>}
                        renderItem={({ item }) => {
                            const already = existing.has(item.publicKey);
                            const isInvited = !!invited?.has(item.publicKey);
                            const isPending = !!pending?.has(item.publicKey);
                            const disabled = already || isInvited || isPending;
                            const on = already || (!isInvited && !isPending && picked.has(item.publicKey));
                            return (
                                <Pressable
                                    style={styles.row}
                                    disabled={disabled}
                                    onPress={() => toggle(item.publicKey)}
                                    accessibilityRole="checkbox"
                                    accessibilityState={{ checked: already ? true : isInvited || isPending ? false : on, disabled }}
                                    accessibilityLabel={
                                        already
                                            ? t('{name}, already in the group', { name: item.callsign })
                                            : isInvited
                                            ? t('{name}, already invited', { name: item.callsign })
                                            : isPending
                                            ? t('{name}, asked to join', { name: item.callsign })
                                            : item.callsign
                                    }
                                >
                                    <MemberAvatar avatarUrl={item.avatarUrl} pubkey={item.publicKey} callsign={item.callsign} size={36} />
                                    <View style={styles.nameCol}>
                                        <Text style={styles.name} numberOfLines={1}>{item.callsign}</Text>
                                        <Text style={styles.keyPrefix} numberOfLines={1}>{(item.publicKey ?? '').slice(0, 8)}</Text>
                                    </View>
                                    {already && <Text style={styles.already}>{t('In the group')}</Text>}
                                    {isInvited && <Text style={styles.already}>{t('Invited')}</Text>}
                                    {isPending && <Text style={styles.already}>{t('Asked to join')}</Text>}
                                    <MaterialCommunityIcons
                                        name={
                                            already
                                                ? 'checkbox-marked-circle'
                                                : isInvited
                                                ? 'clock-outline'
                                                : on
                                                ? 'checkbox-marked-circle'
                                                : 'checkbox-blank-circle-outline'
                                        }
                                        size={26}
                                        color={disabled ? colors.text.muted : on ? colors.brand.primary : colors.border.strong}
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
                            accessibilityLabel={sending ? t('Sending invitations...') : count ? tn(count, 'Invite {n} person', 'Invite {n} people') : t('Pick people to invite')}
                            accessibilityHint={count && !sending ? tn(count, 'Sends group invitations to {n} selected person', 'Sends group invitations to {n} selected people') : undefined}
                            accessibilityState={{ disabled: !count || sending, busy: sending }}
                        >
                            {sending
                                ? <ActivityIndicator color={colors.text.inverse} />
                                : <Text style={styles.inviteText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{count ? tn(count, 'Invite {n} person', 'Invite {n} people') : t('Pick people to invite')}</Text>}
                        </Pressable>
                    </View>
                </View>
            </View>
        </Modal>
    );
}
