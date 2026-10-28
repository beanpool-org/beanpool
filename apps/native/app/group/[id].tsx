/**
 * Group invite landing (groups slice 2): what someone sees when they open a group invitation — today from a
 * Commons card marked INVITED, or a `beanpool://group/<id>` link. Enough to decide in one look: what the group is,
 * who asked them, who is in it, that its chat is node-readable, and one button whose words follow the join policy
 * and their standing (utils/your-groups inviteLandingAction). Joining lands in the group's chat.
 *
 * Never a blank spinner (review of the mock: 2 of 4 screenshots caught one). The page's outline is drawn on the
 * first frame from what the tap already knew (name, category, policy, member count travel as route params); the
 * group's own answer — with who invited you — fills it in the moment it arrives; the members' faces arrive on
 * their own and never hold the page up. Two requests, sent together; neither waits on the other.
 *
 * An open invitation can also be declined (Decline invitation, under Not now): the member's own row goes, as leaving does,
 * and with it the invitation's line in Needs you. Whoever invited them can invite them again.
 *
 * States (utils/your-groups inviteLandingPhase, unit tested): skeleton → ready, or error (no signal; Try again),
 * unavailable (not found), expired (opened as an invitation that is no longer open, with no other way in).
 *
 * At 320dp and 1.3× text everything is one scrolling column; the buttons are full-width 56dp targets.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, ActivityIndicator, Alert } from 'react-native';
import { router, useLocalSearchParams, ErrorBoundary } from 'expo-router';

export { ErrorBoundary };
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme, useStyles, type ThemeContextType } from '../ThemeContext';
import { getGroupForLanding, getGroupActiveMembers, joinGroupApi, leaveGroupApi, type GroupItem, type GroupMemberItem } from '../../utils/db';
import { useIdentity } from '../IdentityContext';
import {
    chatEmoji, chatHref, inviteLandingAction, inviteLandingConvenor, inviteLandingPhase, inviteLandingFacts, inviteLandingPreviewFromParams,
} from '../../utils/your-groups';
import { yourGroupsStore } from '../../components/useYourGroups';
import { MemberAvatar } from '../../components/MemberAvatar';
import { hapticSuccess } from '../../utils/haptics';
import { chatLineWords } from '../../utils/chat-line-words';
import { t, tn } from '@beanpool/core';
import { richWords } from '../../components/info-content/rich-words';

export default function GroupInviteLanding() {
    const params = useLocalSearchParams<{
        id?: string | string[];
        name?: string | string[];
        category?: string | string[];
        joinPolicy?: string | string[];
        memberCount?: string | string[];
        invited?: string | string[];
    }>();
    const rawId = Array.isArray(params.id) ? params.id[0] : params.id;
    const id = rawId || '';
    const preview = React.useMemo(() => inviteLandingPreviewFromParams(params), [params.name, params.category, params.joinPolicy, params.memberCount, params.invited]);
    const insets = useSafeAreaInsets();
    const { identity } = useIdentity();
    const { colors, theme } = useTheme();
    const styles = useStyles(makeStyles);
    // undefined = still asking; null = the node said not found.
    const [group, setGroup] = useState<GroupItem | null | undefined>(undefined);
    const [error, setError] = useState<string | null>(null);
    // null = still asking (or could not load them: the faces row is simply left out).
    const [members, setMembers] = useState<GroupMemberItem[] | null>(null);
    const [membersFailed, setMembersFailed] = useState(false);
    // Which of the two is on its way, so the spinner shows on the button that was tapped; both are held meanwhile.
    const [busy, setBusy] = useState<false | 'join' | 'decline'>(false);
    const alive = useRef(true);
    useEffect(() => () => { alive.current = false; }, []);

    const load = useCallback(() => {
        setError(null);
        // Sent together; each fills its part of the page when it lands.
        getGroupForLanding(id)
            .then(g => { if (alive.current) setGroup(g); })
            .catch((e: any) => { if (alive.current) setError(e?.message || t('Could not reach the node.')); });
        setMembersFailed(false);
        getGroupActiveMembers(id)
            .then(m => { if (alive.current) setMembers(m); })
            .catch(() => { if (alive.current) setMembersFailed(true); });
    }, [id]);
    useEffect(() => { load(); }, [load]);

    const phase = inviteLandingPhase({ group, error, openedAsInvite: !!preview.invited });
    const close = () => { if (router.canGoBack()) router.back(); else router.replace('/(tabs)/chats'); };

    const g = group || null;
    const viewerStatus = g?.viewerStatus ?? null;
    const inviter = g?.viewerInvitedBy;
    const active = members || [];
    const convenor = inviteLandingConvenor(active, g);
    const action = g ? inviteLandingAction({ joinPolicy: g.joinPolicy, viewerStatus }) : null;
    const name = g?.name || preview.name || '';
    const category = g?.category || preview.category || null;
    const facts = inviteLandingFacts({
        category,
        memberCount: members ? members.length : (g?.memberCount ?? preview.memberCount ?? null),
        joinPolicy: g?.joinPolicy || preview.joinPolicy || null,
    });

    const act = async () => {
        if (!g || !action?.enabled || busy) return;
        if (viewerStatus === 'active') {
            router.replace(chatHref({ kind: 'group', conversationId: g.id, name: g.name }) as any);
            return;
        }
        setBusy('join');
        try {
            await joinGroupApi(g.id, { joinPolicy: g.joinPolicy, viewerStatus });
            hapticSuccess();
            yourGroupsStore.refresh();
            if (g.joinPolicy === 'request_to_join' && viewerStatus !== 'invited') {
                load();
            } else {
                router.replace(chatHref({ kind: 'group', conversationId: g.id, name: g.name }) as any);
            }
        } catch (e: any) {
            // The node's own words as it sent them (slice S4); the group-key code's own (a refusal with no words, a roster or
            // key store it couldn't read) in the member's language.
            Alert.alert(t('Could not join'), e?.message ? chatLineWords(e.message) : t('Could not reach the node. Try again when you have signal.'));
        } finally {
            if (alive.current) setBusy(false);
        }
    };

    // Declining an open invitation: asked once, then the member's own row goes (server engine removeGroupMember).
    const decline = () => {
        if (!g || viewerStatus !== 'invited' || busy || !identity?.publicKey) return;
        const me = identity.publicKey;
        Alert.alert(t('Decline the invitation?'), t('You will not join {name}. Whoever invited you can invite you again.', { name: g.name }), [
            { text: t('Cancel'), style: 'cancel' },
            {
                text: t('Decline'), style: 'destructive', onPress: async () => {
                    setBusy('decline');
                    const failed = (e?: any) => Alert.alert(t('Could not decline'),
                        e?.message ? chatLineWords(e.message) : t('Could not reach the node. Try again when you have signal.'));
                    try {
                        if (await leaveGroupApi(g.id, me)) {
                            yourGroupsStore.refresh();
                            close();
                        } else failed();
                    } catch (e: any) {
                        failed(e);
                    } finally {
                        if (alive.current) setBusy(false);
                    }
                },
            },
        ]);
    };

    const topBar = (
        <View style={styles.topBar}>
            <Pressable onPress={close} style={styles.closeBtn} accessibilityRole="button" accessibilityLabel={t('Close')}>
                <MaterialCommunityIcons name="close" size={26} color={colors.text.body} />
            </Pressable>
        </View>
    );

    const message = (emoji: string, title: string, body: string, retry?: boolean) => (
        <ScrollView contentContainerStyle={[styles.content, styles.missing, { paddingBottom: insets.bottom + 24 }]}>
            <Text style={styles.bigEmoji} allowFontScaling={false}>{emoji}</Text>
            <Text style={styles.title}>{title}</Text>
            <Text style={styles.body}>{body}</Text>
            {retry && (
                <Pressable style={styles.primaryBtn} onPress={load} accessibilityRole="button">
                    <Text style={styles.primaryText} numberOfLines={1}>{t('Try again')}</Text>
                </Pressable>
            )}
            <Pressable style={styles.secondaryBtn} onPress={close} accessibilityRole="button">
                <Text style={styles.secondaryText}>{t('Close')}</Text>
            </Pressable>
        </ScrollView>
    );

    let page: React.ReactNode;
    if (phase === 'error') {
        page = message('📶', t("Couldn't open this group"), t("The node didn't answer. Check your signal and try again."), true);
    } else if (phase === 'unavailable') {
        page = message('🔒', t("This group isn't available"), t('It may be private, or it may have closed. If someone invited you, ask them to send the invitation again.'));
    } else if (phase === 'expired') {
        page = message('✉️', t('This invitation is no longer open'), g
            ? t('{name} is invite only, and your invitation was withdrawn. Ask whoever invited you to invite you again.', { name: g.name })
            : t('The group may have closed, or the invitation was withdrawn. Ask whoever invited you to invite you again.'));
    } else {
        // skeleton or ready: one page, filled in as answers land.
        const loadingGroup = phase === 'skeleton';
        const showInvitedBy = loadingGroup ? !!preview.invited : viewerStatus === 'invited';
        page = (
            <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
                {showInvitedBy && (
                    <View style={styles.invitedBy} accessibilityLiveRegion="polite">
                        {inviter
                            ? <MemberAvatar pubkey={inviter.pubkey} callsign={inviter.callsign || ''} avatarUrl={inviter.avatarUrl} size={28} />
                            : <View style={[styles.faceGhost, { width: 28, height: 28 }]} />}
                        {loadingGroup
                            ? <View style={[styles.ghostLine, { width: 150 }]} />
                            : (
                                <Text style={styles.invitedText} numberOfLines={2}>
                                    {/* One sentence with the name in bold inside it; with no name, its own words in bold. */}
                                    {inviter?.callsign
                                        ? richWords(t('**{name}** invited you to join'), styles.invitedName, { name: inviter.callsign })
                                        : richWords(t('**A convenor** invited you to join'), styles.invitedName)}
                                </Text>
                            )}
                    </View>
                )}
                <View style={styles.tile}>
                    <Text style={styles.tileEmoji} allowFontScaling={false}>{chatEmoji('group', category)}</Text>
                </View>
                {name
                    ? <Text style={styles.title}>{name}</Text>
                    : <View style={[styles.ghostLine, styles.ghostTitle]} />}
                {facts
                    ? <Text style={styles.meta}>{facts}</Text>
                    : <View style={[styles.ghostLine, { width: 180, alignSelf: 'center', marginTop: 10 }]} />}
                {!!g?.description && <Text style={styles.body}>{g.description}</Text>}
                {loadingGroup && (
                    <View style={{ marginTop: 16, gap: 8, alignItems: 'center' }}>
                        <View style={[styles.ghostLine, { width: '90%' }]} />
                        <View style={[styles.ghostLine, { width: '70%' }]} />
                    </View>
                )}

                {members === null && !membersFailed && (
                    <View style={styles.people} accessibilityLabel={t('Loading members')}>
                        <View style={styles.faces}>
                            {[0, 1, 2].map(i => <View key={i} style={[styles.faceGhost, i > 0 && { marginLeft: -10 }]} />)}
                        </View>
                        <View style={[styles.ghostLine, { width: 160, marginTop: 10 }]} />
                    </View>
                )}
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
                            {(() => {
                                // The first names as members wrote them; the rest and the convenor in one sentence with them.
                                const names = active.slice(0, 3).map(m => m.callsign || m.memberPubkey.slice(0, 6)).join(', ');
                                const more = active.length - 3;
                                if (more > 0) {
                                    return convenor
                                        ? tn(more, '{names} and {n} more\nConvenor: {name}', '{names} and {n} more\nConvenor: {name}', { names, name: convenor })
                                        : tn(more, '{names} and {n} more', '{names} and {n} more', { names });
                                }
                                return convenor ? t('{names}\nConvenor: {name}', { names, name: convenor }) : names;
                            })()}
                        </Text>
                    </View>
                )}
                {/* No faces (an invitee where the roster is its members', #1939 review N4): the card still names its convenor. */}
                {active.length === 0 && (membersFailed || members !== null) && !!convenor && <Text style={styles.peopleText}>{t('Convenor: {name}', { name: convenor })}</Text>}

                <View style={styles.notice}>
                    <MaterialCommunityIcons name="eye-outline" size={18} color={colors.text.secondary} />
                    <Text style={styles.noticeText}>
                        {t("The group chat is visible to its members and this node's operator. Private things belong in a direct message.")}
                    </Text>
                </View>

                <Pressable
                    style={[styles.primaryBtn, (!action?.enabled || !!busy) && styles.btnDisabled]}
                    onPress={act}
                    disabled={!action?.enabled || !!busy}
                    accessibilityRole="button"
                    accessibilityLabel={busy === 'join' ? t('Joining group...') : action ? action.label : t('Loading')}
                    accessibilityHint={action?.note || (viewerStatus === 'active' ? t('Opens the group chat') : t('Joins the group and opens its chat'))}
                    accessibilityState={{ disabled: !action?.enabled || !!busy, busy: busy === 'join' || loadingGroup }}
                    testID="invite-landing-join"
                >
                    {busy === 'join' || !action
                        ? <ActivityIndicator color={colors.text.inverse} />
                        : <Text style={styles.primaryText} numberOfLines={1}>{action.label}</Text>}
                </Pressable>
                {!!action?.note && <Text style={styles.note}>{action.note}</Text>}
                <Pressable style={styles.secondaryBtn} onPress={close} accessibilityRole="button">
                    <Text style={styles.secondaryText}>{t('Not now')}</Text>
                </Pressable>
                {viewerStatus === 'invited' && (
                    <Pressable style={[styles.secondaryBtn, !!busy && styles.btnDisabled]} onPress={decline} disabled={!!busy} accessibilityRole="button"
                        accessibilityLabel={t('Decline invitation')}
                        accessibilityState={{ disabled: !!busy, busy: busy === 'decline' }} testID="invite-landing-decline">
                        {busy === 'decline'
                            ? <ActivityIndicator color={colors.text.muted} />
                            : <Text style={styles.declineText}>{t('Decline invitation')}</Text>}
                    </Pressable>
                )}
            </ScrollView>
        );
    }

    return (
        <View style={[styles.container, { paddingTop: insets.top }]}>
            <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
            {topBar}
            {page}
        </View>
    );
}

const makeStyles = ({ colors, theme }: ThemeContextType) => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.surface.page },
    topBar: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: 4 },
    closeBtn: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
    content: { paddingHorizontal: 20, alignItems: 'stretch' },
    missing: { alignItems: 'center', paddingTop: 8 },
    ghostLine: { height: 14, borderRadius: 7, backgroundColor: theme === 'dark' ? colors.surface.card : colors.surface.subtle },
    ghostTitle: { width: 200, height: 26, borderRadius: 10, alignSelf: 'center', marginTop: 18 },
    faceGhost: { width: 34, height: 34, borderRadius: 17, borderWidth: 2, borderColor: colors.surface.app, backgroundColor: theme === 'dark' ? colors.surface.card : colors.surface.subtle },
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
        backgroundColor: colors.brand.fill, paddingHorizontal: 16, alignSelf: 'stretch',
    },
    btnDisabled: { opacity: 0.55 },
    primaryText: { color: colors.text.inverse, fontSize: 18, fontWeight: '800' },
    note: { fontSize: 13, color: colors.text.secondary, textAlign: 'center', marginTop: 8 },
    secondaryBtn: { minHeight: 48, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', marginTop: 6 },
    secondaryText: { fontSize: 16, fontWeight: '700', color: colors.text.secondary },
    declineText: { fontSize: 15, fontWeight: '600', color: colors.text.muted, textAlign: 'center' },
});
