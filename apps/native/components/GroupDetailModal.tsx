import React, { useState, useEffect, useCallback } from 'react';
import {
    View,
    Text,
    StyleSheet,
    Modal,
    Pressable,
    ScrollView,
    ActivityIndicator,
    Alert
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, useStyles } from '../app/ThemeContext';
import {
    fetchGroupDetails,
    joinGroupApi,
    leaveGroupApi,
    approveGroupMemberApi,
    setGroupMemberRoleApi,
    handOverGroupLeadApi,
    updateGroupApi,
    type GroupItem,
    type GroupMemberItem,
    type GroupRole,
    type JoinPolicy
} from '../utils/db';
import { MemberAvatar } from './MemberAvatar';
import { buildRosterView } from '../utils/group-roster';
import { hapticSuccess, hapticTick } from '../utils/haptics';

interface GroupDetailModalProps {
    group: GroupItem | null;
    isOpen: boolean;
    onClose: () => void;
    myPubkey?: string;
    onMembershipChanged?: () => void;
    onPostToGroup?: (group: GroupItem) => void;
}

export function GroupDetailModal({
    group,
    isOpen,
    onClose,
    myPubkey,
    onMembershipChanged,
    onPostToGroup
}: GroupDetailModalProps) {
    const { colors } = useTheme();
    const [loading, setLoading] = useState(false);
    const [actionLoading, setActionLoading] = useState(false);
    const [members, setMembers] = useState<GroupMemberItem[]>([]);
    const [groupData, setGroupData] = useState<GroupItem | null>(group);
    const [showPolicyPicker, setShowPolicyPicker] = useState(false);
    const insets = useSafeAreaInsets();

    const loadDetails = useCallback(async () => {
        if (!group?.id) return;
        setLoading(true);
        try {
            const data = await fetchGroupDetails(group.id);
            if (data) {
                setGroupData(data.group);
                setMembers(data.members);
            }
        } catch (e) {
            console.warn('[GroupDetail] Failed to load:', e);
        } finally {
            setLoading(false);
        }
    }, [group?.id]);

    useEffect(() => {
        if (isOpen && group?.id) {
            setGroupData(group);
            loadDetails();
        }
    }, [isOpen, group, loadDetails]);

    const styles = useStyles(({ colors }) => StyleSheet.create({
        backdrop: {
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.5)',
            justifyContent: 'flex-end',
        },
        sheet: {
            backgroundColor: colors.surface.card,
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            maxHeight: '90%',
        },
        header: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 20,
            paddingVertical: 16,
            borderBottomWidth: 1,
            borderBottomColor: colors.border.default,
        },
        title: {
            fontSize: 18,
            fontWeight: '800',
            color: colors.text.heading,
            flex: 1,
            marginRight: 8,
        },
        closeBtn: {
            padding: 4,
        },
        // Padding on contentContainerStyle, not the ScrollView's style: on Android, padding on the
        // ScrollView itself is outside the scroll range, which cut "Leave Group" off at the bottom.
        content: {
            padding: 20,
            paddingBottom: 28,
        },
        badgeRow: {
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: 8,
            marginBottom: 12,
        },
        pill: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            paddingHorizontal: 10,
            paddingVertical: 4,
            borderRadius: 12,
            backgroundColor: colors.surface.subtle,
            borderWidth: 1,
            borderColor: colors.border.default,
        },
        pillText: {
            fontSize: 12,
            fontWeight: '700',
            color: colors.text.secondary,
        },
        infoNotice: {
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: 8,
            backgroundColor: colors.surface.subtle,
            borderRadius: 10,
            padding: 10,
            marginBottom: 16,
            borderWidth: 1,
            borderColor: colors.border.default,
        },
        infoNoticeText: {
            flex: 1,
            fontSize: 12,
            color: colors.text.secondary,
            lineHeight: 17,
        },
        description: {
            fontSize: 14,
            color: colors.text.secondary,
            lineHeight: 20,
            marginBottom: 20,
        },
        sectionTitle: {
            fontSize: 12,
            fontWeight: '800',
            color: colors.text.secondary,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            marginBottom: 10,
            marginTop: 16,
        },
        memberRow: {
            flexDirection: 'row',
            alignItems: 'center',
            paddingVertical: 10,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: colors.border.default,
        },
        memberInfo: {
            flex: 1,
            minWidth: 0,
            marginLeft: 12,
            marginRight: 4,
        },
        memberCallsign: {
            fontSize: 14,
            fontWeight: '700',
            color: colors.text.heading,
        },
        // The role badge sits under the name (it replaces a plain-text role line that said the same
        // thing), so the name keeps the row's width instead of breaking mid-word beside it.
        roleBadge: {
            alignSelf: 'flex-start',
            marginTop: 4,
            paddingHorizontal: 8,
            paddingVertical: 3,
            borderRadius: 8,
            backgroundColor: colors.surface.subtle,
        },
        roleBadgeConvenor: {
            backgroundColor: colors.brand.tint,
            borderWidth: 1,
            borderColor: colors.brand.primary,
        },
        roleBadgeConvenorText: {
            color: colors.brand.primary,
            fontSize: 11,
            fontWeight: '800',
        },
        roleBadgeText: {
            color: colors.text.secondary,
            fontSize: 11,
            fontWeight: '700',
        },
        convenorCard: {
            backgroundColor: colors.surface.subtle,
            borderRadius: 14,
            padding: 14,
            marginTop: 12,
            marginBottom: 16,
            borderWidth: 1,
            borderColor: colors.border.default,
        },
        convenorTitle: {
            fontSize: 13,
            fontWeight: '800',
            color: colors.brand.primary,
            marginBottom: 10,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
        },
        // Name on its own line, Approve / Decline on a row beneath: side by side, the two buttons
        // left ~50dp and covered the requester's name at 320dp.
        pendingItem: {
            paddingVertical: 8,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: colors.border.default,
        },
        pendingActions: {
            flexDirection: 'row',
            gap: 8,
            marginTop: 8,
        },
        approveBtn: {
            flex: 1,
            minHeight: 48,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: colors.brand.primary,
            paddingHorizontal: 12,
            borderRadius: 8,
        },
        approveBtnText: {
            color: colors.text.inverse,
            fontSize: 12,
            fontWeight: '800',
        },
        declineBtn: {
            flex: 1,
            minHeight: 48,
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: 12,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: colors.feedback.danger.solid,
        },
        declineBtnText: {
            color: colors.feedback.danger.solid,
            fontSize: 12,
            fontWeight: '700',
        },
        actionArea: {
            marginTop: 20,
            paddingTop: 16,
            borderTopWidth: 1,
            borderTopColor: colors.border.default,
            gap: 10,
        },
        postBtn: {
            backgroundColor: colors.brand.primary,
            borderRadius: 14,
            minHeight: 48,
            paddingVertical: 12,
            paddingHorizontal: 16,
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: 'row',
            gap: 6,
        },
        postBtnText: {
            flexShrink: 1,
            color: colors.text.inverse,
            fontSize: 15,
            fontWeight: '800',
        },
        joinBtn: {
            backgroundColor: colors.brand.primary,
            borderRadius: 14,
            minHeight: 48,
            paddingVertical: 12,
            paddingHorizontal: 16,
            alignItems: 'center',
            justifyContent: 'center',
        },
        joinBtnDisabled: {
            opacity: 0.6,
        },
        joinBtnText: {
            color: colors.text.inverse,
            fontSize: 15,
            fontWeight: '800',
        },
        leaveBtn: {
            backgroundColor: colors.surface.subtle,
            borderRadius: 14,
            minHeight: 48,
            paddingVertical: 12,
            alignItems: 'center',
            justifyContent: 'center',
            borderWidth: 1,
            borderColor: colors.border.default,
        },
        leaveBtnText: {
            color: colors.feedback.danger.solid,
            fontSize: 14,
            fontWeight: '700',
        },
        // 48dp tap targets: Role was ~44x28 and remove ~30x22.
        manageBtn: {
            minWidth: 48,
            minHeight: 48,
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: 8,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: colors.border.default,
            marginLeft: 6,
        },
        manageBtnText: {
            fontSize: 11,
            color: colors.text.secondary,
            fontWeight: '600',
        },
        // "lead convenor" beside the LEAD badge. flexShrink so it gives way before the badge does at 320dp.
        leadNote: {
            fontSize: 11,
            color: colors.text.muted,
            fontWeight: '600',
            flexShrink: 1,
        },
        leadLine: {
            fontSize: 12,
            color: colors.text.secondary,
            marginBottom: 12,
            lineHeight: 18,
        },
    }));

    if (!groupData) return null;

    const myMembership = members.find(m => m.memberPubkey === myPubkey);
    const isConvenor = groupData.viewerRole === 'convenor' || (myMembership?.role === 'convenor' && myMembership?.status === 'active');
    const isMember = (myMembership && myMembership.status === 'active') || groupData.viewerStatus === 'active';
    const isPending = (myMembership && myMembership.status === 'pending_approval') || groupData.viewerStatus === 'pending_approval';

    const pendingMembers = members.filter(m => m.status === 'pending_approval');
    const activeMembers = members.filter(m => m.status === 'active');
    // Who leads the group, and what each row may offer (lead convenor, 2026-09-23). One source of truth, shared
    // with the PWA and with the engine that enforces it: a convenor never sees Role or ✕ on the lead, or on
    // another convenor.
    const roster = buildRosterView(groupData, members, myPubkey);

    const handleJoin = async () => {
        setActionLoading(true);
        try {
            await joinGroupApi(groupData.id);
            hapticSuccess();
            await loadDetails();
            if (onMembershipChanged) onMembershipChanged();
        } catch (e: any) {
            Alert.alert('Join Failed', e.message || 'Failed to join group');
        } finally {
            setActionLoading(false);
        }
    };

    /**
     * The lead convenor hands the lead on. To another convenor, or to a member who becomes a convenor in the same
     * step — never to an observer, and never to nobody: if the group has no candidate the lead is on their own and
     * can simply leave.
     */
    const handleHandOverLead = () => {
        const candidates = roster.handOverCandidates;
        if (candidates.length === 0) {
            Alert.alert('Hand Over Lead', 'There is nobody else in this group to hand the lead to.');
            return;
        }
        Alert.alert(
            'Hand Over Lead',
            `Who should lead ${groupData.name}? They can remove and demote convenors, and you cannot take the lead back.`,
            [
                // A long roster would overflow an Alert, so it offers the first few; the rest are reachable once
                // those have been dealt with. 320dp-safe either way: an Alert lays its buttons out vertically.
                ...candidates.slice(0, 6).map(c => ({
                    text: c.callsign || c.memberPubkey.slice(0, 10),
                    onPress: async () => {
                        setActionLoading(true);
                        try {
                            await handOverGroupLeadApi(groupData.id, c.memberPubkey);
                            hapticSuccess();
                            await loadDetails();
                            if (onMembershipChanged) onMembershipChanged();
                        } catch (e: any) {
                            Alert.alert('Hand Over Failed', e.message || 'Could not hand the lead over');
                        } finally {
                            setActionLoading(false);
                        }
                    },
                })),
                { text: 'Cancel', style: 'cancel' as const },
            ],
        );
    };

    const handleLeave = async () => {
        if (!myPubkey) return;
        // A lead cannot leave while anyone else is active: say so here rather than letting the server refuse it.
        if (roster.leaveNeedsHandOver) {
            Alert.alert(
                'Hand Over the Lead First',
                `You are the lead convenor of ${groupData.name}. Hand the lead to someone else, then you can leave.`,
                [
                    { text: 'Not Now', style: 'cancel' },
                    { text: 'Hand Over Lead', onPress: handleHandOverLead },
                ],
            );
            return;
        }
        Alert.alert(
            'Leave Group',
            `Are you sure you want to leave ${groupData.name}?`,
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Leave',
                    style: 'destructive',
                    onPress: async () => {
                        setActionLoading(true);
                        try {
                            await leaveGroupApi(groupData.id, myPubkey);
                            hapticSuccess();
                            await loadDetails();
                            if (onMembershipChanged) onMembershipChanged();
                        } catch (e: any) {
                            Alert.alert('Leave Failed', e.message || 'Failed to leave group');
                        } finally {
                            setActionLoading(false);
                        }
                    }
                }
            ]
        );
    };

    const handleApprove = async (memberPubkey: string) => {
        setActionLoading(true);
        try {
            await approveGroupMemberApi(groupData.id, memberPubkey);
            hapticSuccess();
            await loadDetails();
            if (onMembershipChanged) onMembershipChanged();
        } catch (e: any) {
            Alert.alert('Approval Failed', e.message || 'Failed to approve request');
        } finally {
            setActionLoading(false);
        }
    };

    // Declining a join request goes through the same API as removing a member, but the dialog must say which one
    // it is: a decline titled "Remove Member" read as throwing out an existing member.
    const handleRemoveMember = async (memberPubkey: string, callsign?: string, kind: 'remove' | 'decline' = 'remove') => {
        const who = callsign || (kind === 'decline' ? 'this person' : 'this member');
        const decline = kind === 'decline';
        Alert.alert(
            decline ? 'Decline Request' : 'Remove Member',
            decline ? `Decline ${who}'s request to join ${groupData.name}?` : `Remove ${who} from ${groupData.name}?`,
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: decline ? 'Decline' : 'Remove',
                    style: 'destructive',
                    onPress: async () => {
                        setActionLoading(true);
                        try {
                            await leaveGroupApi(groupData.id, memberPubkey);
                            hapticSuccess();
                            await loadDetails();
                            if (onMembershipChanged) onMembershipChanged();
                        } catch (e: any) {
                            Alert.alert(
                                decline ? 'Decline Failed' : 'Removal Failed',
                                e.message || (decline ? 'Failed to decline the request' : 'Failed to remove member'),
                            );
                        } finally {
                            setActionLoading(false);
                        }
                    }
                }
            ]
        );
    };

    const handleChangeRole = (memberPubkey: string, currentRole: GroupRole, callsign?: string) => {
        Alert.alert(
            'Change Role',
            `Select a role for ${callsign || 'this member'}:`,
            [
                {
                    text: 'Convenor',
                    onPress: async () => {
                        try {
                            await setGroupMemberRoleApi(groupData.id, memberPubkey, 'convenor');
                            hapticSuccess();
                            loadDetails();
                            if (onMembershipChanged) onMembershipChanged();
                        } catch (e: any) {
                            Alert.alert('Error', e.message || 'Failed to set role');
                        }
                    }
                },
                {
                    text: 'Member',
                    onPress: async () => {
                        try {
                            await setGroupMemberRoleApi(groupData.id, memberPubkey, 'member');
                            hapticSuccess();
                            loadDetails();
                            if (onMembershipChanged) onMembershipChanged();
                        } catch (e: any) {
                            Alert.alert('Error', e.message || 'Failed to set role');
                        }
                    }
                },
                {
                    text: 'Observer',
                    onPress: async () => {
                        try {
                            await setGroupMemberRoleApi(groupData.id, memberPubkey, 'observer');
                            hapticSuccess();
                            loadDetails();
                            if (onMembershipChanged) onMembershipChanged();
                        } catch (e: any) {
                            Alert.alert('Error', e.message || 'Failed to set role');
                        }
                    }
                },
                { text: 'Cancel', style: 'cancel' }
            ]
        );
    };

    const handleSetPolicy = (policy: JoinPolicy) => {
        Alert.alert(
            'Change Join Policy',
            `Set join policy to ${policy.replace(/_/g, ' ')}?`,
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Confirm',
                    onPress: async () => {
                        try {
                            await updateGroupApi(groupData.id, { joinPolicy: policy });
                            hapticSuccess();
                            setShowPolicyPicker(false);
                            loadDetails();
                            if (onMembershipChanged) onMembershipChanged();
                        } catch (e: any) {
                            Alert.alert('Error', e.message || 'Failed to update policy');
                        }
                    }
                }
            ]
        );
    };

    return (
        <Modal
            visible={isOpen}
            animationType="slide"
            transparent
            onRequestClose={onClose}
        >
            <View style={styles.backdrop}>
                <View style={[styles.sheet, { paddingBottom: insets.bottom }]}>
                    <View style={styles.header}>
                        <Text style={styles.title} numberOfLines={1}>{groupData.name}</Text>
                        <Pressable
                            style={styles.closeBtn}
                            onPress={onClose}
                            accessibilityRole="button"
                            accessibilityLabel="Close group details"
                            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                        >
                            <MaterialCommunityIcons name="close" size={22} color={colors.text.muted} />
                        </Pressable>
                    </View>

                    <ScrollView contentContainerStyle={styles.content}>
                        <View style={styles.badgeRow}>
                            <View style={styles.pill}>
                                <MaterialCommunityIcons name="tag-outline" size={14} color={colors.text.secondary} />
                                <Text style={styles.pillText}>{groupData.category.replace(/_/g, ' ')}</Text>
                            </View>
                            <View style={styles.pill}>
                                <MaterialCommunityIcons name="door-open" size={14} color={colors.text.secondary} />
                                <Text style={styles.pillText}>{groupData.joinPolicy.replace(/_/g, ' ')}</Text>
                            </View>
                            {isConvenor && (
                                <View style={[styles.pill, { backgroundColor: colors.brand.tint, borderColor: colors.brand.primary }]}>
                                    <MaterialCommunityIcons
                                        name={roster.viewerIsLead ? 'shield-star' : 'shield-account'}
                                        size={14}
                                        color={colors.brand.primary}
                                    />
                                    <Text style={[styles.pillText, { color: colors.brand.primary }]}>
                                        {roster.viewerIsLead ? 'Lead convenor' : 'Convenor'}
                                    </Text>
                                </View>
                            )}
                        </View>

                        {/* Group info names the lead convenor. Never "owner" — that is the owner of a node. */}
                        {roster.leadCallsign ? (
                            <Text style={styles.leadLine}>
                                Lead convenor: <Text style={{ fontWeight: '800', color: colors.text.heading }}>{roster.leadCallsign}</Text>
                                {roster.viewerIsLead ? ' (you)' : ''}. Only the lead can remove or demote a convenor, and nobody can remove the lead.
                            </Text>
                        ) : null}

                        <View style={styles.infoNotice}>
                            <MaterialCommunityIcons name="information-outline" size={16} color={colors.text.secondary} />
                            <Text style={styles.infoNoticeText}>
                                A group is a place to talk to some people rather than everyone. It does not hold beans and does not confer trust.
                            </Text>
                        </View>

                        {groupData.description ? (
                            <Text style={styles.description}>{groupData.description}</Text>
                        ) : null}

                        {/* Convenor Tools Section */}
                        {isConvenor && (
                            <View style={styles.convenorCard}>
                                <Text style={styles.convenorTitle}>Convenor Tools</Text>
                                
                                {/* Join Policy Setter */}
                                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                                    <Text style={{ flex: 1, marginRight: 8, fontSize: 13, color: colors.text.secondary }}>Join Policy: <Text style={{ fontWeight: '700', color: colors.text.heading }}>{groupData.joinPolicy.replace(/_/g, ' ')}</Text></Text>
                                    <Pressable
                                        style={styles.manageBtn}
                                        accessibilityRole="button"
                                        accessibilityLabel="Change join policy"
                                        onPress={() => {
                                            Alert.alert(
                                                'Set Join Policy',
                                                'Choose who can join this group:',
                                                [
                                                    { text: 'Open (immediate)', onPress: () => handleSetPolicy('open') },
                                                    { text: 'Request to Join (approval required)', onPress: () => handleSetPolicy('request_to_join') },
                                                    { text: 'Invite Only', onPress: () => handleSetPolicy('invite_only') },
                                                    { text: 'Cancel', style: 'cancel' }
                                                ]
                                            );
                                        }}
                                    >
                                        <Text style={styles.manageBtnText}>Change</Text>
                                    </Pressable>
                                </View>

                                {/* Hand over the lead — the lead only, and only when there is somebody to hand to. */}
                                {roster.viewerIsLead && roster.handOverCandidates.length > 0 && (
                                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                                        <Text style={{ flex: 1, marginRight: 8, fontSize: 13, color: colors.text.secondary }}>
                                            You are the lead convenor
                                        </Text>
                                        <Pressable
                                            style={styles.manageBtn}
                                            accessibilityRole="button"
                                            accessibilityLabel="Hand over lead convenor"
                                            disabled={actionLoading}
                                            onPress={handleHandOverLead}
                                        >
                                            <Text style={styles.manageBtnText} numberOfLines={2}>Hand over</Text>
                                        </Pressable>
                                    </View>
                                )}

                                {/* Pending requests */}
                                {pendingMembers.length > 0 && (
                                    <View style={{ marginTop: 8 }}>
                                        <Text style={{ fontSize: 12, fontWeight: '800', color: colors.text.secondary, marginBottom: 6 }}>
                                            Pending Requests ({pendingMembers.length})
                                        </Text>
                                        {pendingMembers.map(p => (
                                            <View key={p.memberPubkey} style={styles.pendingItem}>
                                                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                                    <MemberAvatar avatarUrl={p.avatarUrl} pubkey={p.memberPubkey} callsign={p.callsign || '?'} size={28} />
                                                    <Text style={{ flex: 1, fontSize: 13, fontWeight: '700', color: colors.text.heading, marginLeft: 8 }} numberOfLines={1}>
                                                        {p.callsign || p.memberPubkey.slice(0, 10)}
                                                    </Text>
                                                </View>
                                                <View style={styles.pendingActions}>
                                                    <Pressable
                                                        accessibilityRole="button"
                                                        accessibilityLabel={`Approve join request from ${p.callsign || p.memberPubkey.slice(0, 10)}`}
                                                        disabled={actionLoading}
                                                        style={[styles.approveBtn, actionLoading && { opacity: 0.6 }]}
                                                        onPress={() => handleApprove(p.memberPubkey)}
                                                    >
                                                        <Text style={styles.approveBtnText} numberOfLines={1}>Approve</Text>
                                                    </Pressable>
                                                    <Pressable
                                                        accessibilityRole="button"
                                                        accessibilityLabel={`Decline join request from ${p.callsign || p.memberPubkey.slice(0, 10)}`}
                                                        disabled={actionLoading}
                                                        style={[styles.declineBtn, actionLoading && { opacity: 0.6 }]}
                                                        onPress={() => handleRemoveMember(p.memberPubkey, p.callsign, 'decline')}
                                                    >
                                                        <Text style={styles.declineBtnText} numberOfLines={1}>Decline</Text>
                                                    </Pressable>
                                                </View>
                                            </View>
                                        ))}
                                    </View>
                                )}
                            </View>
                        )}

                        <Text style={styles.sectionTitle}>
                            Roster ({activeMembers.length || groupData.memberCount || 0})
                        </Text>

                        {loading ? (
                            <ActivityIndicator size="small" color={colors.brand.primary} style={{ marginVertical: 20 }} />
                        ) : (
                            roster.rows.map(row => {
                                const m = row.member;
                                const highlight = row.isLead || m.role === 'convenor';
                                return (
                                    <View key={m.memberPubkey} style={styles.memberRow}>
                                        <MemberAvatar avatarUrl={m.avatarUrl} pubkey={m.memberPubkey} callsign={m.callsign || '?'} size={36} />
                                        <View style={styles.memberInfo}>
                                            <Text style={styles.memberCallsign} numberOfLines={1}>
                                                {m.callsign || m.memberPubkey.slice(0, 10)}{row.isYou ? ' (You)' : ''}
                                            </Text>
                                            {/* The badge says LEAD on the one row it belongs to. It wraps rather than
                                                squeezing the callsign at 320dp with 1.3× text. */}
                                            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
                                                <View style={[styles.roleBadge, highlight && styles.roleBadgeConvenor]}>
                                                    <Text style={[styles.roleBadgeText, highlight && styles.roleBadgeConvenorText]} numberOfLines={1}>
                                                        {row.isLead ? 'LEAD' : m.role.toUpperCase()}
                                                    </Text>
                                                </View>
                                                {row.isLead && (
                                                    <Text style={styles.leadNote} numberOfLines={1}>lead convenor</Text>
                                                )}
                                            </View>
                                        </View>
                                        {/* Role and ✕ only where the viewer may actually act: never on the lead, and
                                            never on another convenor unless the viewer IS the lead. */}
                                        {(row.canChangeRole || row.canRemove || row.canHandOverLead) && (
                                            <View style={{ flexDirection: 'row', alignItems: 'center', flexShrink: 0 }}>
                                                {row.canHandOverLead && (
                                                    <Pressable
                                                        style={styles.manageBtn}
                                                        accessibilityRole="button"
                                                        accessibilityLabel={`Make ${m.callsign || 'this member'} the lead convenor`}
                                                        onPress={handleHandOverLead}
                                                    >
                                                        <MaterialCommunityIcons name="shield-star-outline" size={18} color={colors.text.secondary} />
                                                    </Pressable>
                                                )}
                                                {row.canChangeRole && (
                                                    <Pressable
                                                        style={styles.manageBtn}
                                                        accessibilityRole="button"
                                                        accessibilityLabel={`Change role for ${m.callsign || 'this member'}`}
                                                        onPress={() => handleChangeRole(m.memberPubkey, m.role, m.callsign)}
                                                    >
                                                        <Text style={styles.manageBtnText} numberOfLines={1}>Role</Text>
                                                    </Pressable>
                                                )}
                                                {row.canRemove && (
                                                    <Pressable
                                                        style={[styles.manageBtn, { borderColor: colors.feedback.danger.solid }]}
                                                        accessibilityRole="button"
                                                        accessibilityLabel={`Remove ${m.callsign || 'this member'} from the group`}
                                                        onPress={() => handleRemoveMember(m.memberPubkey, m.callsign)}
                                                    >
                                                        <MaterialCommunityIcons name="close" size={18} color={colors.feedback.danger.solid} />
                                                    </Pressable>
                                                )}
                                            </View>
                                        )}
                                    </View>
                                );
                            })
                        )}

                        <View style={styles.actionArea}>
                            {isMember && onPostToGroup && (
                                <Pressable
                                    style={styles.postBtn}
                                    accessibilityRole="button"
                                    accessibilityLabel={`Post to ${groupData.name}`}
                                    onPress={() => {
                                        onClose();
                                        onPostToGroup(groupData);
                                    }}
                                >
                                    <MaterialCommunityIcons name="pencil" size={18} color={colors.text.inverse} style={{ flexShrink: 0 }} />
                                    <Text style={styles.postBtnText} numberOfLines={1}>Post to {groupData.name}</Text>
                                </Pressable>
                            )}

                            {actionLoading ? (
                                <ActivityIndicator size="small" color={colors.brand.primary} />
                            ) : isMember ? (
                                <Pressable
                                    style={styles.leaveBtn}
                                    onPress={handleLeave}
                                    accessibilityRole="button"
                                    accessibilityLabel="Leave Group"
                                    accessibilityState={{ disabled: actionLoading }}
                                >
                                    <Text style={styles.leaveBtnText}>Leave Group</Text>
                                </Pressable>
                            ) : isPending ? (
                                <View style={[styles.joinBtn, styles.joinBtnDisabled]}>
                                    <Text style={styles.joinBtnText}>Request Pending Approval</Text>
                                </View>
                            ) : groupData.joinPolicy === 'invite_only' ? (
                                <View style={[styles.joinBtn, styles.joinBtnDisabled]}>
                                    <Text style={styles.joinBtnText}>Invite Only</Text>
                                </View>
                            ) : (
                                <Pressable
                                    style={styles.joinBtn}
                                    onPress={handleJoin}
                                    accessibilityRole="button"
                                    accessibilityLabel={groupData.joinPolicy === 'request_to_join' ? 'Request to Join' : 'Join Group'}
                                    accessibilityState={{ disabled: actionLoading }}
                                >
                                    <Text style={styles.joinBtnText}>
                                        {groupData.joinPolicy === 'request_to_join' ? 'Request to Join' : 'Join Group'}
                                    </Text>
                                </Pressable>
                            )}
                        </View>
                    </ScrollView>
                </View>
            </View>
        </Modal>
    );
}
