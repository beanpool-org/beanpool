/**
 * Group invite landing (groups slice 2): what someone sees when they open a group invitation — the push, the
 * in-app notice, or a `beanpool://group/<id>` link. Enough to decide in one look: what the group is, who asked
 * them, who is in it, that its chat is node-readable, and one button whose words follow the join policy and their
 * standing (utils/your-groups inviteLandingAction). Joining lands in the group's chat.
 *
 * An invite-only group answers 404 to anyone without an invitation (#828), which shows here as "not available"
 * without saying whether the group exists.
 *
 * At 320dp and 1.3× text everything is one scrolling column; the buttons are full-width 56dp targets.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, ActivityIndicator, Alert } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme, useStyles, type ThemeContextType } from '../ThemeContext';
import { useIdentity } from '../IdentityContext';
import { fetchGroupDetails, joinGroupApi, type GroupItem, type GroupMemberItem } from '../../utils/db';
import { chatEmoji, chatHref, inviteLandingAction } from '../../utils/your-groups';
import { MemberAvatar } from '../../components/MemberAvatar';
import { hapticSuccess } from '../../utils/haptics';

const CATEGORY_WORDS: Record<string, string> = {
    social: 'Social Circle', general: 'General', working_group: 'Working Group', project: 'Project Team', guild: 'Guild',
};
const POLICY_WORDS: Record<string, string> = {
    open: 'Anyone can join', request_to_join: 'Ask to join', invite_only: 'Invite only',
};

export default function GroupInviteLanding() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const insets = useSafeAreaInsets();
    const { colors } = useTheme();
    const styles = useStyles(makeStyles);
    const { identity } = useIdentity();
    const [group, setGroup] = useState<GroupItem | null>(null);
    const [members, setMembers] = useState<GroupMemberItem[]>([]);
    const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading');
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        const res = await fetchGroupDetails(String(id));
        if (!res) { setState('missing'); return; }
        setGroup(res.group);
        setMembers(res.members);
        setState('ready');
    }, [id]);
    useEffect(() => { load(); }, [load]);

    const close = () => { if (router.canGoBack()) router.back(); else router.replace('/(tabs)/chats'); };

    const me = identity?.publicKey;
    const mine = members.find(m => m.memberPubkey === me);
    const viewerStatus = group?.viewerStatus ?? mine?.status ?? null;
    const active = members.filter(m => m.status === 'active');
    const inviter = mine?.invitedBy ? members.find(m => m.memberPubkey === mine.invitedBy) : null;
    const convenor = active.find(m => m.role === 'convenor');
    const action = group ? inviteLandingAction({ joinPolicy: group.joinPolicy, viewerStatus }) : null;

    const act = async () => {
        if (!group || !action?.enabled || busy) return;
        if (viewerStatus === 'active') {
            router.replace(chatHref({ kind: 'group', conversationId: group.id, name: group.name }) as any);
            return;
        }
        setBusy(true);
        try {
            await joinGroupApi(group.id);
            hapticSuccess();
            if (group.joinPolicy === 'request_to_join' && viewerStatus !== 'invited') {
                await load();
            } else {
                router.replace(chatHref({ kind: 'group', conversationId: group.id, name: group.name }) as any);
            }
        } catch (e: any) {
            Alert.alert('Could not join', e?.message || 'Could not reach the node. Try again when you have signal.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <View style={[styles.container, { paddingTop: insets.top }]}>
            <View style={styles.topBar}>
                <Pressable onPress={close} style={styles.closeBtn} accessibilityRole="button" accessibilityLabel="Close">
                    <MaterialCommunityIcons name="close" size={26} color={colors.text.body} />
                </Pressable>
            </View>
            {state === 'loading' && <ActivityIndicator style={{ marginTop: 40 }} color={colors.brand.primary} />}
            {state === 'missing' && (
                <View style={styles.missing}>
                    <Text style={styles.bigEmoji} allowFontScaling={false}>🔒</Text>
                    <Text style={styles.title}>This group isn't available</Text>
                    <Text style={styles.body}>It may be private, or it may have closed. If someone invited you, ask them to send the invitation again.</Text>
                    <Pressable style={styles.secondaryBtn} onPress={close} accessibilityRole="button">
                        <Text style={styles.secondaryText}>Close</Text>
                    </Pressable>
                </View>
            )}
            {state === 'ready' && group && action && (
                <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
                    {viewerStatus === 'invited' && (
                        <View style={styles.invitedBy}>
                            {inviter && <MemberAvatar pubkey={inviter.memberPubkey} callsign={inviter.callsign || ''} avatarUrl={inviter.avatarUrl ?? undefined} size={28} />}
                            <Text style={styles.invitedText} numberOfLines={2}>
                                <Text style={styles.invitedName}>{inviter?.callsign || 'A convenor'}</Text> invited you to join
                            </Text>
                        </View>
                    )}
                    <View style={styles.tile}>
                        <Text style={styles.tileEmoji} allowFontScaling={false}>{chatEmoji('group', group.category)}</Text>
                    </View>
                    <Text style={styles.title}>{group.name}</Text>
                    <Text style={styles.meta}>
                        {CATEGORY_WORDS[group.category] || 'Group'} · {active.length || group.memberCount || 0} {(active.length || group.memberCount) === 1 ? 'member' : 'members'} · {POLICY_WORDS[group.joinPolicy] || ''}
                    </Text>
                    {!!group.description && <Text style={styles.body}>{group.description}</Text>}

                    {active.length > 0 && (
                        <View style={styles.people}>
                            <View style={styles.faces}>
                                {active.slice(0, 5).map((m, i) => (
                                    <View key={m.memberPubkey} style={[styles.face, i > 0 && { marginLeft: -10 }]}>
                                        <MemberAvatar pubkey={m.memberPubkey} callsign={m.callsign || ''} avatarUrl={m.avatarUrl ?? undefined} size={34} />
                                    </View>
                                ))}
                            </View>
                            <Text style={styles.peopleText}>
                                {active.slice(0, 3).map(m => m.callsign || m.memberPubkey.slice(0, 6)).join(', ')}
                                {active.length > 3 ? ` and ${active.length - 3} more` : ''}
                                {convenor ? `\nConvenor: ${convenor.callsign || convenor.memberPubkey.slice(0, 6)}` : ''}
                            </Text>
                        </View>
                    )}

                    <View style={styles.notice}>
                        <MaterialCommunityIcons name="eye-outline" size={18} color={colors.text.secondary} />
                        <Text style={styles.noticeText}>
                            The group chat is visible to its members and this node's operator. Private things belong in a direct message.
                        </Text>
                    </View>

                    <Pressable
                        style={[styles.primaryBtn, (!action.enabled || busy) && styles.btnDisabled]}
                        onPress={act}
                        disabled={!action.enabled || busy}
                        accessibilityRole="button"
                        accessibilityState={{ disabled: !action.enabled || busy, busy }}
                    >
                        {busy ? <ActivityIndicator color={colors.text.inverse} /> : <Text style={styles.primaryText} numberOfLines={1}>{action.label}</Text>}
                    </Pressable>
                    {!!action.note && <Text style={styles.note}>{action.note}</Text>}
                    <Pressable style={styles.secondaryBtn} onPress={close} accessibilityRole="button">
                        <Text style={styles.secondaryText}>Not now</Text>
                    </Pressable>
                </ScrollView>
            )}
        </View>
    );
}

const makeStyles = ({ colors, theme }: ThemeContextType) => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.surface.app },
    topBar: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: 4 },
    closeBtn: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
    content: { paddingHorizontal: 20, alignItems: 'stretch' },
    missing: { padding: 24, alignItems: 'center' },
    bigEmoji: { fontSize: 44 },
    invitedBy: {
        flexDirection: 'row', alignItems: 'center', gap: 10, alignSelf: 'center', paddingHorizontal: 14, paddingVertical: 8,
        borderRadius: 20, backgroundColor: colors.brand.tint, marginBottom: 18, maxWidth: '100%',
    },
    invitedText: { flexShrink: 1, fontSize: 14, color: colors.text.body },
    invitedName: { fontWeight: '800' },
    tile: {
        width: 96, height: 96, borderRadius: 28, alignSelf: 'center', alignItems: 'center', justifyContent: 'center',
        backgroundColor: theme === 'dark' ? colors.surface.card : colors.surface.subtle,
    },
    tileEmoji: { fontSize: 52 },
    title: { fontSize: 26, fontWeight: '800', color: colors.text.heading, textAlign: 'center', marginTop: 14 },
    meta: { fontSize: 14, color: colors.text.secondary, textAlign: 'center', marginTop: 6 },
    body: { fontSize: 15, lineHeight: 22, color: colors.text.body, textAlign: 'center', marginTop: 14 },
    people: { alignItems: 'center', marginTop: 20 },
    faces: { flexDirection: 'row' },
    face: { borderWidth: 2, borderColor: colors.surface.app, borderRadius: 20 },
    peopleText: { fontSize: 13, lineHeight: 19, color: colors.text.secondary, textAlign: 'center', marginTop: 8 },
    notice: {
        flexDirection: 'row', gap: 10, alignItems: 'flex-start', marginTop: 22, padding: 12, borderRadius: 12,
        backgroundColor: colors.surface.subtle,
    },
    noticeText: { flex: 1, fontSize: 13, lineHeight: 19, color: colors.text.secondary },
    primaryBtn: {
        minHeight: 56, borderRadius: 16, marginTop: 20, alignItems: 'center', justifyContent: 'center',
        backgroundColor: colors.brand.primary, paddingHorizontal: 16,
    },
    btnDisabled: { opacity: 0.55 },
    primaryText: { color: colors.text.inverse, fontSize: 18, fontWeight: '800' },
    note: { fontSize: 13, color: colors.text.secondary, textAlign: 'center', marginTop: 8 },
    secondaryBtn: { minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: 6 },
    secondaryText: { fontSize: 16, fontWeight: '700', color: colors.text.secondary },
});
