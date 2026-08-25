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
import { useTheme, useStyles } from '../app/ThemeContext';
import {
    fetchGroupDetails,
    joinGroupApi,
    leaveGroupApi,
    setGroupMemberRoleApi,
    type GroupItem,
    type GroupMemberItem
} from '../utils/db';
import { MemberAvatar } from './MemberAvatar';
import { hapticSuccess, hapticTick } from '../utils/haptics';

interface GroupDetailModalProps {
    group: GroupItem | null;
    isOpen: boolean;
    onClose: () => void;
    myPubkey?: string;
    onMembershipChanged?: () => void;
}

export function GroupDetailModal({
    group,
    isOpen,
    onClose,
    myPubkey,
    onMembershipChanged
}: GroupDetailModalProps) {
    const { colors } = useTheme();
    const [loading, setLoading] = useState(false);
    const [actionLoading, setActionLoading] = useState(false);
    const [members, setMembers] = useState<GroupMemberItem[]>([]);
    const [groupData, setGroupData] = useState<GroupItem | null>(group);

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
            maxHeight: '85%',
            paddingBottom: 32,
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
        content: {
            padding: 20,
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
        pillOfficial: {
            backgroundColor: colors.brand.tint,
            borderColor: colors.brand.primary,
        },
        pillText: {
            fontSize: 12,
            fontWeight: '700',
            color: colors.text.secondary,
        },
        pillTextOfficial: {
            color: colors.brand.primary,
        },
        description: {
            fontSize: 14,
            color: colors.text.secondary,
            lineHeight: 20,
            marginBottom: 20,
        },
        sectionTitle: {
            fontSize: 13,
            fontWeight: '800',
            color: colors.text.secondary,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            marginBottom: 10,
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
            marginLeft: 12,
        },
        memberCallsign: {
            fontSize: 14,
            fontWeight: '700',
            color: colors.text.heading,
        },
        memberRoleText: {
            fontSize: 12,
            color: colors.text.muted,
            marginTop: 2,
            textTransform: 'capitalize',
        },
        roleBadge: {
            paddingHorizontal: 8,
            paddingVertical: 2,
            borderRadius: 8,
            backgroundColor: colors.surface.subtle,
        },
        roleBadgeSteward: {
            backgroundColor: colors.brand.tint,
        },
        roleBadgeStewardText: {
            color: colors.brand.primary,
            fontSize: 11,
            fontWeight: '800',
        },
        roleBadgeText: {
            color: colors.text.secondary,
            fontSize: 11,
            fontWeight: '600',
        },
        actionArea: {
            marginTop: 20,
            paddingTop: 16,
            borderTopWidth: 1,
            borderTopColor: colors.border.default,
        },
        joinBtn: {
            backgroundColor: colors.brand.primary,
            borderRadius: 14,
            paddingVertical: 14,
            alignItems: 'center',
            justifyContent: 'center',
        },
        joinBtnText: {
            color: colors.text.inverse,
            fontSize: 15,
            fontWeight: '800',
        },
        leaveBtn: {
            backgroundColor: colors.surface.subtle,
            borderRadius: 14,
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
    }));

    if (!groupData) return null;

    const myMembership = members.find(m => m.memberPubkey === myPubkey);
    const isSteward = myMembership?.role === 'steward' || groupData.myRole === 'steward';
    const isMember = !!myMembership || !!groupData.myRole;

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

    const handleLeave = async () => {
        if (!myPubkey) return;
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

    return (
        <Modal
            visible={isOpen}
            animationType="slide"
            transparent
            onRequestClose={onClose}
        >
            <View style={styles.backdrop}>
                <View style={styles.sheet}>
                    <View style={styles.header}>
                        <Text style={styles.title} numberOfLines={1}>{groupData.name}</Text>
                        <Pressable style={styles.closeBtn} onPress={onClose}>
                            <MaterialCommunityIcons name="close" size={22} color={colors.text.muted} />
                        </Pressable>
                    </View>

                    <ScrollView style={styles.content}>
                        <View style={styles.badgeRow}>
                            {groupData.isOfficial && (
                                <View style={[styles.pill, styles.pillOfficial]}>
                                    <MaterialCommunityIcons name="shield-check" size={14} color={colors.brand.primary} />
                                    <Text style={[styles.pillText, styles.pillTextOfficial]}>Official Enterprise</Text>
                                </View>
                            )}
                            <View style={styles.pill}>
                                <MaterialCommunityIcons name="tag-outline" size={14} color={colors.text.secondary} />
                                <Text style={styles.pillText}>{groupData.category.replace('_', ' ')}</Text>
                            </View>
                            <View style={styles.pill}>
                                <MaterialCommunityIcons name="door-open" size={14} color={colors.text.secondary} />
                                <Text style={styles.pillText}>{groupData.joinPolicy.replace(/_/g, ' ')}</Text>
                            </View>
                            {groupData.treasuryPubkey && (
                                <View style={styles.pill}>
                                    <Text style={{ fontSize: 12 }}>🏛️ Treasury Attached</Text>
                                </View>
                            )}
                        </View>

                        {groupData.description && (
                            <Text style={styles.description}>{groupData.description}</Text>
                        )}

                        <Text style={styles.sectionTitle}>
                            Roster ({members.length || groupData.memberCount || 0})
                        </Text>

                        {loading ? (
                            <ActivityIndicator size="small" color={colors.brand.primary} style={{ marginVertical: 20 }} />
                        ) : (
                            members.map(m => {
                                const isUserSteward = m.role === 'steward';
                                return (
                                    <View key={m.memberPubkey} style={styles.memberRow}>
                                        <MemberAvatar avatarUrl={m.avatarUrl} pubkey={m.memberPubkey} callsign={m.callsign || '?'} size={36} />
                                        <View style={styles.memberInfo}>
                                            <Text style={styles.memberCallsign}>
                                                {m.callsign || m.memberPubkey.slice(0, 10)}
                                            </Text>
                                            <Text style={styles.memberRoleText}>
                                                {m.role} · {m.status.replace('_', ' ')}
                                            </Text>
                                        </View>
                                        <View style={[styles.roleBadge, isUserSteward && styles.roleBadgeSteward]}>
                                            <Text style={[styles.roleBadgeText, isUserSteward && styles.roleBadgeStewardText]}>
                                                {m.role.toUpperCase()}
                                            </Text>
                                        </View>
                                    </View>
                                );
                            })
                        )}

                        <View style={styles.actionArea}>
                            {actionLoading ? (
                                <ActivityIndicator size="small" color={colors.brand.primary} />
                            ) : isMember ? (
                                <Pressable style={styles.leaveBtn} onPress={handleLeave}>
                                    <Text style={styles.leaveBtnText}>Leave Group</Text>
                                </Pressable>
                            ) : (
                                <Pressable style={styles.joinBtn} onPress={handleJoin}>
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
