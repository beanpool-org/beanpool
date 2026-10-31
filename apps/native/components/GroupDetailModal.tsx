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
import { MAKE_OBSERVER_MEMBER_FIRST, GROUP_CLOSED_NOTE, groupDescriptionShown, groupNameShown, inCapitalsOf, t, word, bundledGroupEmblem, type GroupPerson, type WordKey } from '@beanpool/core';
import { useIdentity } from '../app/IdentityContext';
import { PlaceCircleCard } from './PlaceCircleCard';
import { MemberAvatar } from './MemberAvatar';
import { AvatarPickerSheet } from './AvatarPickerSheet';
import { GroupSuccessionPanel } from './GroupSuccessionPanel';
import { GroupDecisions } from './EnterpriseDecisions';
import { Sentence } from './Sentence';
import { buildRosterView, rosterHeading } from '../utils/group-roster';
import { hapticSuccess, hapticTick } from '../utils/haptics';
import { KEY_CHANGED_HINT } from '../utils/name-key-memory';
import { chatLineWords } from '../utils/chat-line-words';
import { signedRequestWords } from './signed-request-lines';

/** Sentences marked in core, translated here where they are shown. */
const LINES = { observerFirst: MAKE_OBSERVER_MEMBER_FIRST, closed: GROUP_CLOSED_NOTE };

/**
 * The info pills say the group's category and join rule in the lower-case words they always have; a code this phone
 * does not know yet is shown as it came (it is a code, not words). Marked here, translated where drawn.
 */
const CATEGORY_PILL: Readonly<Record<string, WordKey>> = {
    social: word('social', 'group category'), general: word('general', 'group category'), working_group: word('working group', 'group category'),
    project: word('project', 'group category'), guild: word('guild', 'group category'),
};
const POLICY_WORDS: Readonly<Record<string, WordKey>> = {
    open: word('open', 'join policy'), request_to_join: word('request to join', 'join policy'), invite_only: word('invite only', 'join policy'),
};
/** A roster row's role badge, in capitals in the words themselves (never toUpperCase on a translated word). */
const ROLE_BADGE: Readonly<Record<string, WordKey>> = {
    convenor: word('CONVENOR', 'group role badge'), member: word('MEMBER', 'group role badge'), observer: word('OBSERVER', 'group role badge'),
};

const own = (table: Readonly<Record<string, WordKey>>, code: string) => Object.prototype.hasOwnProperty.call(table, code);
const categoryPill = (code: string) => (own(CATEGORY_PILL, code) ? t(CATEGORY_PILL[code]) : code.replace(/_/g, ' '));
const policyWords = (code: string) => (own(POLICY_WORDS, code) ? t(POLICY_WORDS[code]) : code.replace(/_/g, ' '));
const roleBadge = (code: string) => (own(ROLE_BADGE, code) ? t(ROLE_BADGE[code]) : code.toUpperCase());

interface GroupDetailModalProps {
    group: GroupItem | null;
    isOpen: boolean;
    onClose: () => void;
    myPubkey?: string;
    onMembershipChanged?: () => void;
    onPostToGroup?: (group: GroupItem) => void;
    /** Members whose name this phone saw on another key, with no statement from the new key (utils/name-key-memory.ts). */
    keyChanged?: ReadonlySet<string>;
}

export function GroupDetailModal({
    group,
    isOpen,
    onClose,
    myPubkey,
    onMembershipChanged,
    onPostToGroup,
    keyChanged,
}: GroupDetailModalProps) {
    const { colors } = useTheme();
    const { identity } = useIdentity();
    const [loading, setLoading] = useState(false);
    const [actionLoading, setActionLoading] = useState(false);
    const [members, setMembers] = useState<GroupMemberItem[]>([]);
    const [rosterRefused, setRosterRefused] = useState(false);
    const [groupData, setGroupData] = useState<GroupItem | null>(group);
    const [showPolicyPicker, setShowPolicyPicker] = useState(false);
    const [pickingPicture, setPickingPicture] = useState(false);
    const insets = useSafeAreaInsets();

    const loadDetails = useCallback(async () => {
        if (!group?.id) return;
        setLoading(true);
        try {
            const data = await fetchGroupDetails(group.id);
            if (data) {
                setGroupData(data.group);
                // No roster this time (the node busy, or offline): keep the one on screen.
                if (data.members) setMembers(data.members);
                setRosterRefused(data.rosterRefused === true);
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
            letterSpacing: 0.5,
            marginBottom: 10,
            marginTop: 16,
        },
        memberRow: {
            paddingVertical: 10,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: colors.border.default,
        },
        // The avatar, the name and badge, and the buttons the viewer may use, on one line.
        memberLine: {
            flexDirection: 'row',
            alignItems: 'center',
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
            backgroundColor: colors.brand.fill,
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
            color: colors.feedback.danger.fg,
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
            backgroundColor: colors.brand.fill,
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
            backgroundColor: colors.brand.fill,
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
            color: colors.feedback.danger.fg,
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
        // Under the member's line, indented to the name (the avatar's 36 and memberInfo's 12): the whole sheet's width,
        // whatever buttons the viewer has (review of #1826, confirmation 1, NB4).
        memberKeyChanged: {
            fontSize: 12,
            fontWeight: '600',
            color: colors.text.muted,
            marginTop: 2,
            marginLeft: 48,
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
    const heading = rosterHeading({ refused: rosterRefused, rows: activeMembers.length, memberCount: groupData.memberCount });
    // Who leads the group, and what each row may offer (lead convenor, 2026-09-23). One source of truth, shared
    // with the PWA and with the engine that enforces it: a convenor never sees Role or ✕ on the lead, or on
    // another convenor.
    const roster = buildRosterView(groupData, members, myPubkey);
    // Closed by its members' vote (DESIGN-group-decisions §2.3): it stays to read and takes nothing new.
    const closed = !!groupData.closedAt;
    // Everyone in the group now, for the Decisions block's names and pickers (the lead as 'lead').
    const people: GroupPerson[] = activeMembers.map(m => ({
        pubkey: m.memberPubkey,
        name: m.callsign || m.memberPubkey.slice(0, 10),
        role: m.memberPubkey === groupData.leadPubkey ? 'lead' : m.role,
    }));

    const handleJoin = async () => {
        setActionLoading(true);
        try {
            // Joining lets this member into the chat: their phone makes its next key in the same request (§2.3).
            await joinGroupApi(groupData.id, { joinPolicy: groupData.joinPolicy, viewerStatus: (groupData as any).viewerStatus });
            hapticSuccess();
            await loadDetails();
            if (onMembershipChanged) onMembershipChanged();
        } catch (e: any) {
            Alert.alert(t('Join Failed'), e.message ? signedRequestWords(e.message) : t('Failed to join group'));
        } finally {
            setActionLoading(false);
        }
    };

    /** Hand the lead to one named person. The one path that actually calls the server. */
    const performHandOverLead = async (targetPubkey: string) => {
        setActionLoading(true);
        try {
            await handOverGroupLeadApi(groupData.id, targetPubkey);
            hapticSuccess();
            await loadDetails();
            if (onMembershipChanged) onMembershipChanged();
        } catch (e: any) {
            Alert.alert(t('Hand Over Failed'), e.message ? signedRequestWords(e.message) : t('Could not hand the lead over'));
        } finally {
            setActionLoading(false);
        }
    };

    /**
     * The shield beside a name: hand the lead to that person, after confirming. Same promise as the PWA's
     * "Make lead" button — the person whose row you pressed is the person who gets it, however long the roster.
     */
    const handleHandOverLeadTo = (targetPubkey: string, callsign?: string) => {
        const who = callsign || targetPubkey.slice(0, 10);
        Alert.alert(
            t('Hand Over Lead'),
            t('Make {name} the lead convenor of {group}? They can remove and demote convenors, and you cannot take the lead back.', { name: who, group: groupData.name }),
            [
                { text: t('Cancel'), style: 'cancel' as const },
                { text: t('Make Lead'), onPress: () => { void performHandOverLead(targetPubkey); } },
            ],
        );
    };

    /**
     * The lead convenor hands the lead on, choosing from a list. To another convenor, or to a member who becomes a
     * convenor in the same step — never to an observer, and never to nobody: if the group has no candidate the lead
     * is on their own and can simply leave.
     */
    const handleHandOverLead = () => {
        const candidates = roster.handOverCandidates;
        if (candidates.length === 0) {
            // Observers cannot take the lead, so a roster of only observers is not "nobody" — it is one role
            // change away from a hand-over. Say which.
            Alert.alert(t('Hand Over Lead'), roster.handOverBlockedByObservers
                ? t(LINES.observerFirst)
                : t('There is nobody else in this group to hand the lead to.'));
            return;
        }
        Alert.alert(
            t('Hand Over Lead'),
            candidates.length > 6
                ? t('Who should lead {group}? They can remove and demote convenors, and you cannot take the lead back. For anyone not listed here, use the shield beside their name on the roster.', { group: groupData.name })
                : t('Who should lead {group}? They can remove and demote convenors, and you cannot take the lead back.', { group: groupData.name }),
            [
                // A long roster would overflow an Alert, so it offers the first few; everyone else is reachable by
                // the shield on their own row. 320dp-safe either way: an Alert lays its buttons out vertically.
                ...candidates.slice(0, 6).map(c => ({
                    text: c.callsign || c.memberPubkey.slice(0, 10),
                    onPress: () => { void performHandOverLead(c.memberPubkey); },
                })),
                { text: t('Cancel'), style: 'cancel' as const },
            ],
        );
    };

    const handleLeave = async () => {
        if (!myPubkey) return;
        // A lead cannot leave while anyone else is active: say so here rather than letting the server refuse it.
        if (roster.leaveNeedsHandOver) {
            // Everyone else an observer: offering "Hand Over Lead" here would only lead to the refusal above, so
            // the alert names the one step that unblocks them and offers no dead-end button.
            if (roster.handOverBlockedByObservers) {
                // MAKE_OBSERVER_MEMBER_FIRST's words, after the line that says whose lead it is: one sentence.
                Alert.alert(
                    t('Make an Observer a Member First'),
                    t('You are the lead convenor of {group}. Make one of the observers a member first, then hand the lead to them.', { group: groupData.name }),
                );
                return;
            }
            Alert.alert(
                t('Hand Over the Lead First'),
                t('You are the lead convenor of {group}. Hand the lead to someone else, then you can leave.', { group: groupData.name }),
                [
                    { text: t('Not Now'), style: 'cancel' },
                    { text: t('Hand Over Lead'), onPress: handleHandOverLead },
                ],
            );
            return;
        }
        Alert.alert(
            t('Leave Group'),
            t('Are you sure you want to leave {group}?', { group: groupData.name }),
            [
                { text: t('Cancel'), style: 'cancel' },
                {
                    text: t('Leave'),
                    style: 'destructive',
                    onPress: async () => {
                        setActionLoading(true);
                        try {
                            await leaveGroupApi(groupData.id, myPubkey);
                            hapticSuccess();
                            await loadDetails();
                            if (onMembershipChanged) onMembershipChanged();
                        } catch (e: any) {
                            Alert.alert(t('Leave Failed'), e.message ? signedRequestWords(e.message) : t('Failed to leave group'));
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
            Alert.alert(t('Approval Failed'), e.message ? signedRequestWords(e.message) : t('Failed to approve request'));
        } finally {
            setActionLoading(false);
        }
    };

    // Declining a join request goes through the same API as removing a member, but the dialog must say which one
    // it is: a decline titled "Remove Member" read as throwing out an existing member.
    const handleRemoveMember = async (memberPubkey: string, callsign?: string, kind: 'remove' | 'decline' = 'remove') => {
        const decline = kind === 'decline';
        const group = groupData.name;
        // The member's name as written; with none, each sentence says "this person" / "this member" itself.
        const question = decline
            ? (callsign ? t("Decline {name}'s request to join {group}?", { name: callsign, group }) : t("Decline this person's request to join {group}?", { group }))
            : (callsign ? t('Remove {name} from {group}?', { name: callsign, group }) : t('Remove this member from {group}?', { group }));
        Alert.alert(
            decline ? t('Decline Request') : t('Remove Member'),
            question,
            [
                { text: t('Cancel'), style: 'cancel' },
                {
                    text: decline ? t('Decline') : t('Remove'),
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
                                decline ? t('Decline Failed') : t('Removal Failed'),
                                e.message ? signedRequestWords(e.message) : (decline ? t('Failed to decline the request') : t('Failed to remove member')),
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
            t('Change Role'),
            callsign ? t('Select a role for {name}:', { name: callsign }) : t('Select a role for this member:'),
            [
                {
                    text: t('Convenor', undefined, 'group role'),
                    onPress: async () => {
                        try {
                            await setGroupMemberRoleApi(groupData.id, memberPubkey, 'convenor');
                            hapticSuccess();
                            loadDetails();
                            if (onMembershipChanged) onMembershipChanged();
                        } catch (e: any) {
                            Alert.alert(t('Error'), e.message ? signedRequestWords(e.message) : t('Failed to set role'));
                        }
                    }
                },
                {
                    text: t('Member', undefined, 'group role'),
                    onPress: async () => {
                        try {
                            await setGroupMemberRoleApi(groupData.id, memberPubkey, 'member');
                            hapticSuccess();
                            loadDetails();
                            if (onMembershipChanged) onMembershipChanged();
                        } catch (e: any) {
                            Alert.alert(t('Error'), e.message ? signedRequestWords(e.message) : t('Failed to set role'));
                        }
                    }
                },
                {
                    text: t('Observer', undefined, 'group role'),
                    onPress: async () => {
                        try {
                            await setGroupMemberRoleApi(groupData.id, memberPubkey, 'observer');
                            hapticSuccess();
                            loadDetails();
                            if (onMembershipChanged) onMembershipChanged();
                        } catch (e: any) {
                            Alert.alert(t('Error'), e.message ? signedRequestWords(e.message) : t('Failed to set role'));
                        }
                    }
                },
                { text: t('Cancel'), style: 'cancel' }
            ]
        );
    };

    const handleSetPolicy = (policy: JoinPolicy) => {
        Alert.alert(
            t('Change Join Policy'),
            t('Set join policy to {policy}?', { policy: policyWords(policy) }),
            [
                { text: t('Cancel'), style: 'cancel' },
                {
                    text: t('Confirm'),
                    onPress: async () => {
                        try {
                            await updateGroupApi(groupData.id, { joinPolicy: policy });
                            hapticSuccess();
                            setShowPolicyPicker(false);
                            loadDetails();
                            if (onMembershipChanged) onMembershipChanged();
                        } catch (e: any) {
                            Alert.alert(t('Error'), e.message ? signedRequestWords(e.message) : t('Failed to update policy'));
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
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
                            <MemberAvatar
                                avatarUrl={groupData.avatarUrl || bundledGroupEmblem(groupData.category)}
                                pubkey={groupData.id}
                                callsign={groupData.name}
                                updatedAt={groupData.updatedAt}
                                size={36}
                            />
                            <Text style={styles.title} numberOfLines={1}>{groupNameShown(groupData)}</Text>
                        </View>
                        <Pressable
                            style={styles.closeBtn}
                            onPress={onClose}
                            accessibilityRole="button"
                            accessibilityLabel={t('Close group details')}
                            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                        >
                            <MaterialCommunityIcons name="close" size={22} color={colors.text.muted} />
                        </Pressable>
                    </View>

                    <ScrollView contentContainerStyle={styles.content}>
                        <View style={styles.badgeRow}>
                            <View style={styles.pill}>
                                <MaterialCommunityIcons name="tag-outline" size={14} color={colors.text.secondary} />
                                <Text style={[styles.pillText, { flexShrink: 1 }]}>{categoryPill(groupData.category)}</Text>
                            </View>
                            <View style={styles.pill}>
                                <MaterialCommunityIcons name="door-open" size={14} color={colors.text.secondary} />
                                <Text style={[styles.pillText, { flexShrink: 1 }]}>{policyWords(groupData.joinPolicy)}</Text>
                            </View>
                            {closed && (
                                <View style={styles.pill} accessibilityLabel={t("Closed by its members' vote")}>
                                    <MaterialCommunityIcons name="lock-outline" size={14} color={colors.text.secondary} />
                                    <Text style={styles.pillText}>{t('Closed', undefined, 'a group')}</Text>
                                </View>
                            )}
                            {isConvenor && (
                                <View style={[styles.pill, { backgroundColor: colors.brand.tint, borderColor: colors.brand.primary }]}>
                                    <MaterialCommunityIcons
                                        name={roster.viewerIsLead ? 'shield-star' : 'shield-account'}
                                        size={14}
                                        color={colors.brand.primary}
                                    />
                                    <Text style={[styles.pillText, { color: colors.brand.primary }]}>
                                        {roster.viewerIsLead ? t('Lead convenor', undefined, 'group role') : t('Convenor', undefined, 'group role')}
                                    </Text>
                                </View>
                            )}
                        </View>

                        {isConvenor && !closed && (
                            <Pressable
                                onPress={() => setPickingPicture(true)}
                                accessibilityRole="button"
                                accessibilityLabel={t('Change the picture')}
                                style={{ alignSelf: 'flex-start', marginTop: 8 }}
                            >
                                <Text style={{ fontSize: 13, fontWeight: '700', color: colors.brand.primary }}>
                                    {t('Change the picture')}
                                </Text>
                            </Pressable>
                        )}

                        {/* Group info names the lead convenor. Never "owner" — that is the owner of a node. */}
                        {roster.leadCallsign ? (
                            <Text style={styles.leadLine}>
                                <Sentence
                                    text={roster.viewerIsLead
                                        ? t('Lead convenor: {name} (you). Only the lead can remove or demote a convenor, and nobody can remove the lead.')
                                        : t('Lead convenor: {name}. Only the lead can remove or demote a convenor, and nobody can remove the lead.')}
                                    parts={{ name: <Text style={{ fontWeight: '800', color: colors.text.heading }}>{roster.leadCallsign}</Text> }}
                                />
                            </Text>
                        ) : null}

                        <View style={styles.infoNotice}>
                            <MaterialCommunityIcons name="information-outline" size={16} color={colors.text.secondary} />
                            <Text style={styles.infoNoticeText}>
                                {t('A group is a place to talk to some people rather than everyone. It does not hold beans and does not confer trust.')}
                            </Text>
                        </View>

                        {/* What its members wrote: shown as written. */}
                        {!!groupData.circle && (
                            <PlaceCircleCard id={groupData.id} circle={groupData.circle} identity={identity} colors={colors}
                                onChange={circle => setGroupData(g => (g ? { ...g, circle } : g))} />
                        )}
                        {groupDescriptionShown(groupData) ? (
                            <Text style={styles.description}>{groupDescriptionShown(groupData)}</Text>
                        ) : null}

                        {closed && (
                            <View style={styles.infoNotice}>
                                <MaterialCommunityIcons name="lock-outline" size={16} color={colors.text.secondary} />
                                <Text style={styles.infoNoticeText}>{t(LINES.closed)}</Text>
                            </View>
                        )}

                        {/* The group's votes, high on the sheet: a vote's push and Home's line land here. It draws
                            nothing for someone the node doesn't answer, or when there is no vote and none can open. */}
                        {/* For anyone the node answers: someone removed or made an observer mid-vote still votes (#1784 review B1). */}
                        {(
                            <GroupDecisions
                                groupId={groupData.id}
                                myPubkey={myPubkey ?? null}
                                people={people}
                                joinPolicy={groupData.joinPolicy}
                                onChanged={() => {
                                    // A vote carried out may move the lead, a role or the join rule, or close the group.
                                    void loadDetails();
                                    if (onMembershipChanged) onMembershipChanged();
                                }}
                            />
                        )}

                        {/* Convenor Tools Section */}
                        {isConvenor && !closed && (
                            <View style={styles.convenorCard}>
                                <Text style={styles.convenorTitle}>{inCapitalsOf(t('Convenor Tools'))}</Text>

                                {/* Join Policy Setter */}
                                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                                    <Text style={{ flex: 1, marginRight: 8, fontSize: 13, color: colors.text.secondary }}>
                                        <Sentence
                                            text={t('Join Policy: {policy}')}
                                            parts={{ policy: <Text style={{ fontWeight: '700', color: colors.text.heading }}>{policyWords(groupData.joinPolicy)}</Text> }}
                                        />
                                    </Text>
                                    <Pressable
                                        style={styles.manageBtn}
                                        accessibilityRole="button"
                                        accessibilityLabel={t('Change join policy')}
                                        onPress={() => {
                                            Alert.alert(
                                                t('Set Join Policy'),
                                                t('Choose who can join this group:'),
                                                [
                                                    { text: t('Open (immediate)'), onPress: () => handleSetPolicy('open') },
                                                    { text: t('Request to Join (approval required)'), onPress: () => handleSetPolicy('request_to_join') },
                                                    { text: t('Invite Only'), onPress: () => handleSetPolicy('invite_only') },
                                                    { text: t('Cancel'), style: 'cancel' }
                                                ]
                                            );
                                        }}
                                    >
                                        <Text style={styles.manageBtnText} numberOfLines={2}>{t('Change')}</Text>
                                    </Pressable>
                                </View>

                                {/* Hand over the lead — the lead only, and only when there is somebody to hand to. */}
                                {roster.viewerIsLead && roster.handOverCandidates.length > 0 && (
                                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                                        <Text style={{ flex: 1, marginRight: 8, fontSize: 13, color: colors.text.secondary }}>
                                            {t('You are the lead convenor')}
                                        </Text>
                                        <Pressable
                                            style={styles.manageBtn}
                                            accessibilityRole="button"
                                            accessibilityLabel={t('Hand over lead convenor')}
                                            disabled={actionLoading}
                                            onPress={handleHandOverLead}
                                        >
                                            <Text style={styles.manageBtnText} numberOfLines={2}>{t('Hand over')}</Text>
                                        </Pressable>
                                    </View>
                                )}

                                {/* Pending requests */}
                                {pendingMembers.length > 0 && (
                                    <View style={{ marginTop: 8 }}>
                                        <Text style={{ fontSize: 12, fontWeight: '800', color: colors.text.secondary, marginBottom: 6 }}>
                                            {t('Pending Requests ({n})', { n: pendingMembers.length })}
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
                                                        accessibilityLabel={t('Approve join request from {name}', { name: p.callsign || p.memberPubkey.slice(0, 10) })}
                                                        disabled={actionLoading}
                                                        style={[styles.approveBtn, actionLoading && { opacity: 0.6 }]}
                                                        onPress={() => handleApprove(p.memberPubkey)}
                                                    >
                                                        <Text style={styles.approveBtnText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{t('Approve')}</Text>
                                                    </Pressable>
                                                    <Pressable
                                                        accessibilityRole="button"
                                                        accessibilityLabel={t('Decline join request from {name}', { name: p.callsign || p.memberPubkey.slice(0, 10) })}
                                                        disabled={actionLoading}
                                                        style={[styles.declineBtn, actionLoading && { opacity: 0.6 }]}
                                                        onPress={() => handleRemoveMember(p.memberPubkey, p.callsign, 'decline')}
                                                    >
                                                        <Text style={styles.declineBtnText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{t('Decline')}</Text>
                                                    </Pressable>
                                                </View>
                                            </View>
                                        ))}
                                    </View>
                                )}
                            </View>
                        )}

                        {/* The quiet-lead vote, beside the roster it is about. It draws nothing unless the lead is
                            eligible for replacement or a vote has been held, so a healthy group sees no change. */}
                        {isMember && !closed && (
                            <GroupSuccessionPanel
                                groupId={groupData.id}
                                members={members}
                                myPubkey={myPubkey}
                                onLeadChanged={() => {
                                    // A vote that passes moves the lead: reload so the new LEAD badge and the
                                    // roster's controls are right without a restart.
                                    void loadDetails();
                                    if (onMembershipChanged) onMembershipChanged();
                                }}
                            />
                        )}

                        <Text style={styles.sectionTitle}>
                            {inCapitalsOf(heading.title)}
                        </Text>
                        {heading.note && <Text style={styles.description}>{heading.note}</Text>}

                        {loading ? (
                            <ActivityIndicator size="small" color={colors.brand.primary} style={{ marginVertical: 20 }} />
                        ) : (
                            roster.rows.map(row => {
                                const m = row.member;
                                const highlight = row.isLead || m.role === 'convenor';
                                return (
                                    <View key={m.memberPubkey} style={styles.memberRow}>
                                        <View style={styles.memberLine}>
                                            <MemberAvatar avatarUrl={m.avatarUrl} pubkey={m.memberPubkey} callsign={m.callsign || '?'} size={36} />
                                            <View style={styles.memberInfo}>
                                                <Text style={styles.memberCallsign} numberOfLines={1}>
                                                    {row.isYou
                                                        ? t('{name} (You)', { name: m.callsign || m.memberPubkey.slice(0, 10) })
                                                        : (m.callsign || m.memberPubkey.slice(0, 10))}
                                                </Text>
                                                {/* The badge says LEAD on the one row it belongs to. It wraps rather than
                                                    squeezing the callsign at 320dp with 1.3× text. */}
                                                <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
                                                    <View style={[styles.roleBadge, highlight && styles.roleBadgeConvenor]}>
                                                        <Text style={[styles.roleBadgeText, highlight && styles.roleBadgeConvenorText]} numberOfLines={1}>
                                                            {row.isLead ? t('LEAD', undefined, 'group role badge') : roleBadge(m.role)}
                                                        </Text>
                                                    </View>
                                                    {row.isLead && (
                                                        <Text style={styles.leadNote} numberOfLines={1}>{t('lead convenor', undefined, 'roster note')}</Text>
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
                                                            accessibilityLabel={m.callsign ? t('Make {name} the lead convenor', { name: m.callsign }) : t('Make this member the lead convenor')}
                                                            onPress={() => handleHandOverLeadTo(m.memberPubkey, m.callsign)}
                                                        >
                                                            <MaterialCommunityIcons name="shield-star-outline" size={18} color={colors.text.secondary} />
                                                        </Pressable>
                                                    )}
                                                    {row.canChangeRole && (
                                                        <Pressable
                                                            style={styles.manageBtn}
                                                            accessibilityRole="button"
                                                            accessibilityLabel={m.callsign ? t('Change role for {name}', { name: m.callsign }) : t('Change role for this member')}
                                                            onPress={() => handleChangeRole(m.memberPubkey, m.role, m.callsign)}
                                                        >
                                                            <Text style={styles.manageBtnText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{t('Role')}</Text>
                                                        </Pressable>
                                                    )}
                                                    {row.canRemove && (
                                                        <Pressable
                                                            style={[styles.manageBtn, { borderColor: colors.feedback.danger.solid }]}
                                                            accessibilityRole="button"
                                                            accessibilityLabel={m.callsign ? t('Remove {name} from the group', { name: m.callsign }) : t('Remove this member from the group')}
                                                            onPress={() => handleRemoveMember(m.memberPubkey, m.callsign)}
                                                        >
                                                            <MaterialCommunityIcons name="close" size={18} color={colors.feedback.danger.fg} />
                                                        </Pressable>
                                                    )}
                                                </View>
                                            )}
                                        </View>
                                        {/* Its own line under the member's: beside the name, the one line cut it for
                                            every name on a convenor's roster at 320dp (NB9); inside the name's column,
                                            the lead's three buttons left 66px and "changed)" broke mid-word (NB4). */}
                                        {keyChanged?.has(m.memberPubkey) && (
                                            <Text style={styles.memberKeyChanged}>{chatLineWords(KEY_CHANGED_HINT)}</Text>
                                        )}
                                    </View>
                                );
                            })
                        )}

                        <View style={styles.actionArea}>
                            {isMember && onPostToGroup && !closed && (
                                <Pressable
                                    style={styles.postBtn}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('Post to {name}', { name: groupData.name })}
                                    onPress={() => {
                                        onClose();
                                        onPostToGroup(groupData);
                                    }}
                                >
                                    <MaterialCommunityIcons name="pencil" size={18} color={colors.text.inverse} style={{ flexShrink: 0 }} />
                                    <Text style={styles.postBtnText} numberOfLines={1}>{t('Post to {name}', { name: groupData.name })}</Text>
                                </Pressable>
                            )}

                            {actionLoading ? (
                                <ActivityIndicator size="small" color={colors.brand.primary} />
                            ) : isMember ? (
                                <Pressable
                                    style={styles.leaveBtn}
                                    onPress={handleLeave}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('Leave Group')}
                                    accessibilityState={{ disabled: actionLoading }}
                                >
                                    <Text style={styles.leaveBtnText}>{t('Leave Group')}</Text>
                                </Pressable>
                            ) : closed ? (
                                <View style={[styles.joinBtn, styles.joinBtnDisabled]}>
                                    <Text style={styles.joinBtnText}>{t('Closed', undefined, 'a group')}</Text>
                                </View>
                            ) : isPending ? (
                                <View style={[styles.joinBtn, styles.joinBtnDisabled]}>
                                    <Text style={[styles.joinBtnText, { textAlign: 'center' }]}>{t('Request Pending Approval')}</Text>
                                </View>
                            ) : groupData.joinPolicy === 'invite_only' ? (
                                <View style={[styles.joinBtn, styles.joinBtnDisabled]}>
                                    <Text style={styles.joinBtnText}>{t('Invite Only')}</Text>
                                </View>
                            ) : (
                                <Pressable
                                    style={styles.joinBtn}
                                    onPress={handleJoin}
                                    accessibilityRole="button"
                                    accessibilityLabel={groupData.joinPolicy === 'request_to_join' ? t('Request to Join') : t('Join Group')}
                                    accessibilityState={{ disabled: actionLoading }}
                                >
                                    <Text style={[styles.joinBtnText, { textAlign: 'center' }]}>
                                        {groupData.joinPolicy === 'request_to_join' ? t('Request to Join') : t('Join Group')}
                                    </Text>
                                </Pressable>
                            )}
                        </View>
                    </ScrollView>
                </View>
            </View>
            <AvatarPickerSheet
                visible={pickingPicture}
                title={t('Group Picture')}
                colors={colors}
                onClose={() => setPickingPicture(false)}
                onSelectImage={async (uri) => {
                    setPickingPicture(false);
                    try {
                        setActionLoading(true);
                        await updateGroupApi(groupData.id, { avatarUrl: uri });
                        hapticSuccess();
                        await loadDetails();
                        if (onMembershipChanged) onMembershipChanged();
                    } catch (e: any) {
                        Alert.alert(t('Update Failed'), e?.message ? signedRequestWords(e.message) : t('Failed to update group picture'));
                    } finally {
                        setActionLoading(false);
                    }
                }}
            />
        </Modal>
    );
}
