import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, FlatList, Pressable, Alert, DeviceEventEmitter, RefreshControl, ScrollView } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { getBalance, getTreasuries, getDecisions, getAllCommunityMembers, fetchGroups, type DecisionWithTally, type MyPoolVoting, type TreasurySummary, type GroupItem } from '../../utils/db';
import { loadIdentity } from '../../utils/identity';
import { CurrencyDisplay } from '../../components/CurrencyDisplay';
import { useReaderFeatures } from '../../utils/use-reader-features';
import { beansOn, showcaseMode } from '../../utils/node-profile';
import { CommonsPreview } from '../../components/showcase/Previews';
import { commonsSections, commonsSectionFor, commonsHeading, groupKindChips, commonsGroupRows, commonsGroupsEmpty, commonsPlusStartsProject, isProject, enterprisesOn, type CommonsSection, type CommonsGroupRow, type GroupKind } from '../../utils/commons-sections';
import { CommonsInfoModal } from '../../components/CommonsInfoModal';
import { DecideSection } from '../../components/DecideSection';
import { ProposeDecisionModal } from '../../components/ProposeDecisionModal';
import { YourGroupsRows, YourGroupsLoading, YourGroupsError, useCreateGroupFlow } from '../../components/YourGroupsPane';
import { useYourGroups, yourGroupsStore } from '../../components/useYourGroups';
import { chatEmoji, inviteLandingHref, yourGroupsPaneState } from '../../utils/your-groups';
import { GroupDetailModal } from '../../components/GroupDetailModal';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme, useStyles } from '../ThemeContext';
import { palette } from '../../constants/colors';
import { EnterpriseCard, commonsCardStyles } from '../../components/EnterpriseCard';
import { PageTitle, useTabRetapScrollTop } from '../../components/PageTitle';
import { sampleDecisions, samplePoolVoting } from '../../components/showcase/sample-screens';
import { LocalCommunitySheet } from '../../components/showcase/LocalCommunityMark';
import { Sentence } from '../../components/Sentence';
import { formatNumber, inCapitalsOf, t, tn, word, type WordKey } from '@beanpool/core';
import { memberShelves, phoneTools } from '../../tools/index';
import { ToolRow } from '../../tools/ui';

/** A group's own role, kind and join policy as the node names them: word() keys, shown through t(). Any other name is
 *  shown as the node wrote it. The tables' own names only (a "constructor" is not one). */
const ROLE_WORDS: Readonly<Record<string, WordKey>> = {
    convenor: word('CONVENOR'), member: word('MEMBER'), observer: word('OBSERVER'),
};
const CATEGORY_WORDS: Readonly<Record<string, WordKey>> = {
    social: word('social', 'group category'), general: word('general', 'group category'), working_group: word('working group', 'group category'),
    project: word('project', 'group category'), guild: word('guild', 'group category'),
};
const JOIN_POLICY_WORDS: Readonly<Record<string, WordKey>> = {
    open: word('open', 'join policy'), request_to_join: word('request to join', 'join policy'), invite_only: word('invite only', 'join policy'),
};
const own = (table: object, name: string) => Object.prototype.hasOwnProperty.call(table, name);
const named = (table: Readonly<Record<string, WordKey>>, name: string, asWritten: string) => (own(table, name) ? t(table[name]) : asWritten);

/** The question the + and Decide's button ask before a Decision can be proposed: whole, in the member's language. */
function proposeRefusal(canPropose: boolean, hasOpenDecision: boolean): boolean {
    if (!canPropose) {
        Alert.alert(t('Complete a Trade First'), t('You can propose a Decision once you have completed a trade.'));
        return true;
    }
    if (hasOpenDecision) {
        Alert.alert(t('Limit Reached'), t('You already have an open decision (limit 1 open decision per author).'));
        return true;
    }
    return false;
}

export default function ProjectsScreen() {
    const { theme, colors } = useTheme();
    const listRef = useRef<FlatList>(null);
    useTabRetapScrollTop(listRef);
    const [enterprises, setEnterprises] = useState<TreasurySummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [identity, setIdentity] = useState<any>(null);
    // A community with Beans off (the worldwide one) hides this tab, but a link still opens it (Talk's "Find groups",
    // the header's vote icon): there it draws no pool balance, no voice credits and no pool info, which are all Beans.
    // The reader's own features (the node's, narrowed by this account's on /api/community/me: design §4).
    const reader = useReaderFeatures();
    const showsBeans = beansOn(reader.effective);
    // Commons → Groups = "Your groups" (the same rows and chats as Talk — the same copy, without unread badges) +
    // "Groups you could join" (decision 7).
    const yourGroupsLive = useYourGroups(identity?.publicKey);
    const yourGroups = useMemo(() => {
        const all = yourGroupsLive.items || [];
        if (!enterprisesOn(reader.effective)) {
            return all.filter(g => g.kind !== 'enterprise');
        }
        return all;
    }, [yourGroupsLive.items, reader.effective]);
    const yourGroupsState = yourGroupsPaneState(
        yourGroupsLive.items === null ? null : yourGroups,
        yourGroupsLive.error
    );
    const [balanceState, setBalanceState] = useState<any>({ earnedCredit: 0, commons: 0 });
    // Commons → Tools (DESIGN-tool-template-fable.md §1.5): drawn only where this build has a tool this community can
    // have, so the row never leads to an empty screen. From the reader's features this screen already has: no read of its
    // own (the Tools screen asks each tool with the community's profile too).
    const toolsHere = memberShelves({ features: (reader.effective ?? {}) as Record<string, unknown> }, phoneTools().map(x => x.manifest)).length > 0;
    // Enterprises and Decide previewed from Example Valley where the node shows its switched-off features (§1 row 6).
    const enterprisesPreview = showcaseMode('enterprises', reader.node, reader.reader) === 'preview';
    // What the screen asks the node for, per feature: nothing until the phone's copy of the node's profile is read (a
    // moment, no network), then only what is not in preview. The pool and voice credits are Beans, the members list is
    // the Decision form's: a preview reads Example Valley and never asks for the reader's own (as the Ledger).
    const beansPreview = showcaseMode('beans', reader.node, reader.reader) === 'preview';
    const decisionsPreview = showcaseMode('decisions', reader.node, reader.reader) === 'preview';
    const modesKnown = reader.known;
    // Each load's answers land only while it is the latest: one begun under another mode never lands over the preview.
    const loadGen = useRef(0);
    // Decide only where formal Decisions are on; Groups is one list of projects, enterprises and chat groups, with
    // projects and enterprises only where the node has them (utils/commons-sections.ts). With Groups all that is left
    // (the worldwide community, reached from Talk's "Find groups"), this is its groups list.
    const sections = commonsSections(reader.effective, { decisionsPreview });
    const showsDecide = sections.includes('decide');
    const heading = commonsHeading(reader.effective);
    const kindChips = groupKindChips(reader.effective);
    const [showCommonsInfo, setShowCommonsInfo] = useState(false);
    const [showDecisionsSheet, setShowDecisionsSheet] = useState(false);
    const [membersList, setMembersList] = useState<Array<{ publicKey: string; callsign?: string; balance?: number }>>([]);
    const [pickedSection, setActiveSection] = useState<CommonsSection | null>(null);
    // The kind chip over the one Groups list: projects, enterprises, chat groups, or all of them.
    const [groupKind, setGroupKind] = useState<GroupKind>('all');
    // The one drawn: the section picked (or linked to), where this node shows it, else its first. So a section the
    // node's profile takes away is never drawn, not even before the profile has arrived and been acted on.
    const activeSection = commonsSectionFor(
        pickedSection ?? (decisionsPreview ? 'groups' : undefined),
        reader.effective,
        { decisionsPreview },
    );
    // The header's vote icon lands here with section=decide. Commons may already be open on another section,
    // so switch to Decide, on its Open list (the vote is there, not in History), and show it from the top, then
    // clear the param so a later visit keeps its place.
    const sectionParam = useLocalSearchParams<{ section?: string }>().section;
    useEffect(() => {
        // Talk's "Find a group to join" lands on Groups (decision 7). Enterprises are in Groups now: a link that
        // asks for them opens Groups on its Enterprises chip.
        if (sectionParam === 'enterprises') {
            setActiveSection('groups');
            setGroupKind('enterprises');
            router.setParams({ section: '' });
            return;
        }
        if (sectionParam === 'groups') {
            setActiveSection('groups');
            router.setParams({ section: '' });
            return;
        }
        if (sectionParam !== 'decide') return;
        setActiveSection('decide');
        setActiveDecideView('open');
        listRef.current?.scrollToOffset({ offset: 0, animated: false });
        router.setParams({ section: '' });
    }, [sectionParam]);
    const [decisions, setDecisions] = useState<DecisionWithTally[]>([]);
    // The signer's voice credits for votes on community money — the number the node checks (answer H).
    const [myPoolVoting, setMyPoolVoting] = useState<MyPoolVoting | null>(null);
    const [nodeSaysCanPropose, setNodeSaysCanPropose] = useState<boolean | null>(null);
    const [showProposeDecision, setShowProposeDecision] = useState<boolean>(false);
    const [activeDecideView, setActiveDecideView] = useState<'open' | 'history'>('open');

    // Groups states
    const [groups, setGroups] = useState<GroupItem[]>([]);
    const [loadingGroups, setLoadingGroups] = useState(false);
    const [selectedGroupForDetail, setSelectedGroupForDetail] = useState<GroupItem | null>(null);

    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        safeArea: { flex: 1, backgroundColor: colors.surface.page },
        headerContainer: { marginBottom: 16 },
        headerInfo: { marginBottom: 16 },
        headerDesc: { fontSize: 14, color: colors.text.secondary, lineHeight: 20 },
        infoBtn: { padding: 4 },
        toolsCard: { backgroundColor: colors.surface.card, borderRadius: 14, borderWidth: 1, borderColor: colors.border.default, paddingHorizontal: 12, marginBottom: 16 },

        // Labels in capitals are written so by inCapitalsOf (the language's way), never a textTransform (the phone's).
        statCardRow: { flexDirection: 'row', gap: 10, marginBottom: 12 },
        statCard: { flex: 1, minWidth: 0, backgroundColor: colors.surface.card, borderRadius: 14, padding: 12, borderWidth: 1, borderColor: colors.border.default },
        statCardLabel: { fontSize: 11, color: colors.text.secondary, fontWeight: '700', letterSpacing: 0.5, marginBottom: 6 },
        statCardValueRow: { flexDirection: 'row', alignItems: 'center' },
        statCardAmount: { fontSize: 20, color: colors.text.heading, fontWeight: '800' },
        statCardHint: { fontSize: 11, color: colors.text.muted, marginTop: 4, lineHeight: 15 },

        // Two equal pills share ~288dp at 320dp wide. The icon sits ABOVE the label and the label caps its scale,
        // as when there were three (Decide · Enterprises · Groups, before Groups held enterprises too).
        sectionTabsRow: { flexDirection: 'row', gap: 8, marginBottom: 16 },
        sectionTabBtn: { flex: 1, minWidth: 0, minHeight: 56, alignItems: 'center', justifyContent: 'center', gap: 2, paddingVertical: 8, paddingHorizontal: 4, borderRadius: 14, backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.default },
        sectionTabBtnActive: { backgroundColor: colors.brand.tint, borderColor: colors.brand.primary },
        sectionTabText: { fontSize: 13, fontWeight: '700', color: colors.text.secondary },
        sectionTabTextActive: { color: colors.brand.primary },
        sectionBadge: { position: 'absolute', top: 4, right: 6, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 10, backgroundColor: colors.brand.fill },
        sectionBadgeText: { color: colors.text.inverse, fontSize: 11, fontWeight: '800' },


        filterRow: { flexDirection: 'row', gap: 8, marginTop: 4, marginBottom: 4 },
        groupsHeading: { fontSize: 13, fontWeight: '800', color: colors.text.secondary, letterSpacing: 0.5, marginTop: 8 },
        groupsNone: { fontSize: 14, color: colors.text.secondary, lineHeight: 20 },
        filterBtn: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 16, backgroundColor: colors.surface.subtle, borderWidth: 1, borderColor: colors.border.default },
        filterBtnActive: { backgroundColor: colors.brand.fill, borderColor: colors.brand.dark },
        filterBtnText: { fontSize: 12, color: colors.text.secondary, fontWeight: '600' },
        filterBtnTextActive: { color: colors.text.inverse },

        listContainer: { paddingHorizontal: 16, paddingTop: 0, paddingBottom: 100 },
        // The Commons cards (components/EnterpriseCard.tsx): one style block for the enterprise card and the group card.
        ...commonsCardStyles({ theme, colors }),

        emptyState: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, paddingHorizontal: 32 },
        emptyEmoji: { fontSize: 48, opacity: 0.4, marginBottom: 16 },
        emptyTitle: { fontSize: 18, fontWeight: '700', color: colors.text.heading, marginBottom: 8, textAlign: 'center' },
        emptyDesc: { fontSize: 14, color: colors.text.muted, textAlign: 'center', lineHeight: 20, marginBottom: 24 },
        emptyBtn: { backgroundColor: colors.brand.fill, paddingVertical: 12, paddingHorizontal: 24, borderRadius: 12, shadowColor: colors.brand.dark, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4, elevation: 3 },
        emptyBtnText: { color: colors.text.inverse, fontSize: 14, fontWeight: '700' },

        skeletonCard: { backgroundColor: colors.surface.card, borderRadius: 16, marginBottom: 16, borderWidth: 1, borderColor: colors.border.default, padding: 16, gap: 12 },
        skeletonLineTitle: { height: 18, width: '60%', borderRadius: 6, backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.grayAlt100 },
        skeletonLineDesc: { height: 14, width: '90%', borderRadius: 4, backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.grayAlt100 },
        skeletonLineProgress: { height: 8, width: '100%', borderRadius: 4, backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.grayAlt100, marginTop: 4 },

        fab: {
            position: 'absolute',
            bottom: 24,
            right: 24,
            width: 60,
            height: 60,
            borderRadius: 30,
            backgroundColor: colors.brand.fill,
            justifyContent: 'center',
            alignItems: 'center',
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 4 },
            shadowOpacity: 0.3,
            shadowRadius: 5,
            elevation: 6
        }
    }));

    const loadData = useCallback(async () => {
        const gen = ++loadGen.current;
        const latest = () => gen === loadGen.current;
        try {
            const id = await loadIdentity();
            setIdentity(id);
            if (modesKnown && !beansPreview && id?.publicKey) {
                getBalance(id.publicKey).then(b => { if (latest()) setBalanceState(b); }).catch(console.error);
            }
        } catch (e) {
            console.error('[Commons] Failed loading identity:', e);
        }
        if (!modesKnown || !latest()) return;
        if (beansPreview) setBalanceState({ earnedCredit: 0, commons: 0 });

        if (enterprisesPreview) {
            setEnterprises([]);
            setLoading(false);
        } else {
            try {
                const list = await getTreasuries();
                if (!latest()) return;
                setEnterprises(list);
                setLoading(false);
            } catch (err) {
                console.error('[Commons] Failed loading enterprises:', err);
                if (latest()) setLoading(false);
            }
        }

        if (decisionsPreview) {
            setDecisions(sampleDecisions());
            setMyPoolVoting(samplePoolVoting());
            setNodeSaysCanPropose(null);
            setMembersList([]);
        } else {
            try {
                const decData = await getDecisions();
                if (!latest()) return;
                setDecisions(decData.decisions || []);
                setMyPoolVoting(decData.myPoolVoting ?? null);
                setNodeSaysCanPropose(decData.canPropose);
            } catch (err) {
                console.error('[Projects] Failed loading decisions:', err);
            }

            try {
                const mems = await getAllCommunityMembers();
                if (!latest()) return;
                setMembersList(mems || []);
            } catch (err) {
                console.error('[Projects] Failed loading members:', err);
            }
        }

        yourGroupsStore.refresh();

        try {
            setLoadingGroups(true);
            const g = await fetchGroups();
            if (!latest()) return;
            setGroups(g || []);
            setLoadingGroups(false);
        } catch (err) {
            console.error('[Projects] Failed loading groups:', err);
            if (latest()) setLoadingGroups(false);
        }
    }, [modesKnown, beansPreview, enterprisesPreview, decisionsPreview]);

    // The node's rule (a completed trade, or a node admin); earned credit only when the node hasn't said.
    const canProposeDecision = nodeSaysCanPropose ?? (balanceState.earnedCredit || 0) > 0;
    const hasOpenDecision = useMemo(() => {
        if (!identity?.publicKey) return false;
        return decisions.some(d => d.authorPubkey === identity.publicKey && d.status === 'open');
    }, [decisions, identity]);
    const openDecisionsCount = useMemo(() => {
        return decisions.filter(d => d.status === 'open').length;
    }, [decisions]);

    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        try {
            const { requestSync } = await import('../../services/pillar-sync');
            await requestSync();
        } catch (e) {
            console.warn('[Commons] Sync error during refresh:', e);
        }
        await loadData();
        setRefreshing(false);
    }, [loadData]);

    useFocusEffect(
        useCallback(() => {
            loadData();
        }, [loadData])
    );

    useEffect(() => {
        const sub = DeviceEventEmitter.addListener('sync_data_updated', loadData);
        return () => sub.remove();
    }, [loadData]);

    const createGroup = useCreateGroupFlow(() => loadData());

    // Projects first (a goal to reach), then by live offers; then the one list for the chip (commonsGroupRows).
    const groupRows = useMemo(() => {
        const sorted = [...enterprises].sort((a, b) => {
            if (isProject(a) && !isProject(b)) return -1;
            if (!isProject(a) && isProject(b)) return 1;
            return (b.liveOffers || 0) - (a.liveOffers || 0);
        });
        return commonsGroupRows(groupKind, groups, sorted, yourGroups, reader.effective);
    }, [groups, enterprises, yourGroups, groupKind, reader.effective]);
    const groupsEmpty = commonsGroupsEmpty(groupKind, reader.effective);
    // The + on Groups: a project or enterprise on those chips, otherwise the create form (which offers both, with Beans).
    const startsProject = commonsPlusStartsProject(activeSection, groupKind, reader.effective);
    const openProposeProject = async () => {
        const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
        if (!anchorUrl) {
            Alert.alert(t('Not Connected'), t('Connect to a community first.'), [
                { text: t('Cancel'), style: 'cancel' },
                { text: t('Connect'), onPress: () => router.push({ pathname: '/(tabs)/settings', params: { section: 'advanced' } }) }
            ]);
            return;
        }
        router.push('/propose-project');
    };

    const renderEnterpriseItem = ({ item }: { item: TreasurySummary }) => <EnterpriseCard item={item} />;

    const renderGroupItem = ({ item }: { item: GroupItem }) => {
        const isConvenor = item.viewerRole === 'convenor';
        const isMember = item.viewerRole === 'member';
        const isObserver = item.viewerRole === 'observer';
        const isPending = item.viewerStatus === 'pending_approval';
        // An open invitation is not a membership yet: say so, and open the invite landing rather than the detail.
        const isInvited = item.viewerStatus === 'invited';

        return (
            <Pressable
                accessibilityRole="button"
                style={styles.card}
                onPress={() => isInvited ? router.push(inviteLandingHref(item) as any) : setSelectedGroupForDetail(item)}
            >
                <View style={styles.cardHeader}>
                    <View style={[styles.avatar, styles.avatarPlaceholder]}>
                        <Text style={{ fontSize: 20 }}>{chatEmoji('group', item.category)}</Text>
                    </View>
                    <View style={styles.cardTitleCol}>
                        <Text style={styles.cardTitle} numberOfLines={2}>{item.name}</Text>
                        {isInvited ? (
                            <View style={styles.badgeRow}>
                                <View style={[styles.badge, { backgroundColor: colors.brand.fill }]}>
                                    <Text style={styles.badgeFundedText} numberOfLines={1}>{t('INVITED')}</Text>
                                </View>
                            </View>
                        ) : item.viewerRole ? (
                            <View style={styles.badgeRow}>
                                <View style={[styles.badge, isConvenor ? styles.badgeFunded : styles.badgeOngoing]}>
                                    <Text style={[styles.badgeFundedText, !isConvenor && styles.badgeOngoingText]} numberOfLines={1}>
                                        {named(ROLE_WORDS, item.viewerRole, item.viewerRole.toUpperCase())}
                                    </Text>
                                </View>
                            </View>
                        ) : isPending ? (
                            <View style={styles.badgeRow}>
                                <View style={[styles.badge, { backgroundColor: colors.feedback.warning.solid }]}>
                                    <Text style={[styles.badgeFundedText, { color: colors.text.onGold }]} numberOfLines={1}>{t('PENDING')}</Text>
                                </View>
                            </View>
                        ) : null}
                        <Text style={styles.cardMeta} numberOfLines={2}>
                            {tn(item.memberCount || 0, '🏷️ {category} · {n} member · {policy}', '🏷️ {category} · {n} members · {policy}', {
                                category: named(CATEGORY_WORDS, item.category, item.category.replace(/_/g, ' ')),
                                policy: named(JOIN_POLICY_WORDS, item.joinPolicy, item.joinPolicy.replace(/_/g, ' ')),
                            })}
                        </Text>
                    </View>
                </View>

                <View style={styles.cardBody}>
                    {item.description ? (
                        <Text style={styles.purposeText} numberOfLines={2}>
                            {item.description}
                        </Text>
                    ) : (
                        <Text style={[styles.purposeText, styles.purposeTextPlaceholder]}>
                            {t('No description provided.')}
                        </Text>
                    )}

                    {/* Wraps: in a longer language "View Details" goes under the join policy rather than cutting it. */}
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', columnGap: 8, rowGap: 4, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.border.default }}>
                        <Text style={{ fontSize: 11, color: colors.text.muted, flexShrink: 1 }} numberOfLines={2}>
                            {t('Join policy: {policy}', { policy: named(JOIN_POLICY_WORDS, item.joinPolicy, item.joinPolicy.replace(/_/g, ' ')) })}
                        </Text>
                        <Text style={{ fontSize: 12, fontWeight: '700', color: colors.brand.primary, flexShrink: 0 }} numberOfLines={1}>{t('View Details →')}</Text>
                    </View>
                </View>
            </Pressable>
        );
    };

    return (
        <View style={styles.safeArea}>
            <FlatList
                ref={listRef}
                data={activeSection === 'decide' ? [] : groupRows}
                keyExtractor={(row: CommonsGroupRow<TreasurySummary>) => row.key}
                renderItem={({ item: row }: { item: CommonsGroupRow<TreasurySummary> }) => (
                    row.kind === 'group' ? renderGroupItem({ item: row.item }) : renderEnterpriseItem({ item: row.item })
                )}
                contentContainerStyle={styles.listContainer}
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={onRefresh}
                        tintColor={colors.brand.primary}
                        colors={[colors.brand.primary]}
                    />
                }
                ListHeaderComponent={
                    <View style={styles.headerContainer}>
                        <View style={styles.headerInfo}>
                            {/* The page's one large title, first thing in the list, so it scrolls away with it.
                                The list pads the sides, hence inset 0. */}
                            <PageTitle title={t(heading.title)} inset={0} testID="page-title-commons" right={showsBeans ? (
                                <Pressable
                                    accessibilityRole="button"
                                    accessibilityLabel={t('About the Commons Pool')}
                                    onPress={() => setShowCommonsInfo(true)}
                                    hitSlop={10}
                                    style={styles.infoBtn}
                                >
                                    <MaterialCommunityIcons name="information-outline" size={22} color={colors.text.secondary} />
                                </Pressable>
                            ) : undefined} />
                            <Text style={styles.headerDesc}>{t(heading.description)}</Text>
                        </View>

                        {/* In preview, Example Valley's Commons first, its strip across the top, so a newcomer meets the
                            marker on arrival; the real groups follow (design §1 row 6, §2; review of #1852, finding 5). The
                            preview's cards carry their own 16 dp sides; the negative margin undoes the list's, so at 320 dp
                            they line up with the groups below rather than sitting 32 dp in. Drawn only on Groups (where
                            enterprises live on a local node), so Decide opens at its own content. */}
                        {enterprisesPreview && activeSection === 'groups' && <View style={{ marginHorizontal: -16 }}><CommonsPreview /></View>}

                        {/* Commons → Tools (DESIGN-tool-template-fable.md §1.5): above the pool and the Decide · Groups pills. */}
                        {toolsHere ? (
                            <View style={styles.toolsCard}>
                                <ToolRow icon="🧰" title={t('Tools')} state={t('Things you can do on your own')} onPress={() => router.push('/tools')} testID="commons-tools-row" />
                            </View>
                        ) : null}

                        {/* Commons Pool + My Governance Credits */}
                        {showsBeans && (
                        <View style={styles.statCardRow}>
                            <View style={styles.statCard}>
                                <Text style={styles.statCardLabel} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.75}>{inCapitalsOf(t('Commons Pool'))}</Text>
                                <View style={styles.statCardValueRow}>
                                    <CurrencyDisplay amount={formatNumber(balanceState.commons || 0, 2)} style={styles.statCardAmount} />
                                </View>
                            </View>
                            {showsDecide && !decisionsPreview && (
                            <View style={styles.statCard} testID="voice-credits-card">
                                {/* Half-width card: at 320dp and 1.3x text the label has ~110dp, room for two short words.
                                    What the credits are for goes in the hint, which wraps freely. */}
                                <Text style={styles.statCardLabel} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.75}>{inCapitalsOf(t('Voice credits'))}</Text>
                                <Text style={styles.statCardAmount} numberOfLines={1}>{formatNumber(Math.floor(myPoolVoting?.voiceCredits ?? 0))}</Text>
                                <Text style={styles.statCardHint}>
                                    {myPoolVoting && !myPoolVoting.hasCompletedTrade
                                        ? t('For money votes · opens after your first completed trade')
                                        : t('For money votes · from completed trades · N votes cost N×N')}
                                </Text>
                            </View>
                            )}
                        </View>
                        )}

                        {/* Section Switcher: Decide vs Groups, where this node shows both; none for Groups alone */}
                        {sections.length > 1 && (
                        <View style={styles.sectionTabsRow}>
                            {showsDecide && (
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={t('Decide Section')}
                                style={[styles.sectionTabBtn, activeSection === 'decide' && styles.sectionTabBtnActive]}
                                onPress={() => {
                                    setActiveSection('decide');
                                    // In preview Groups holds the sample's cards and Decide does not: start Decide at its top.
                                    if (enterprisesPreview) listRef.current?.scrollToOffset({ offset: 0, animated: false });
                                }}
                            >
                                <MaterialCommunityIcons
                                    name="vote"
                                    size={18}
                                    color={activeSection === 'decide' ? colors.brand.primary : colors.text.secondary}
                                />
                                <Text
                                    style={[styles.sectionTabText, activeSection === 'decide' && styles.sectionTabTextActive]}
                                    numberOfLines={1}
                                    adjustsFontSizeToFit
                                    minimumFontScale={0.8}
                                    maxFontSizeMultiplier={1.1}
                                >
                                    {t('Decide')}
                                </Text>
                                {openDecisionsCount > 0 && (
                                    <View style={styles.sectionBadge}>
                                        <Text style={styles.sectionBadgeText} maxFontSizeMultiplier={1}>{formatNumber(openDecisionsCount)}</Text>
                                    </View>
                                )}
                            </Pressable>
                            )}

                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={t('Groups Section')}
                                style={[styles.sectionTabBtn, activeSection === 'groups' && styles.sectionTabBtnActive]}
                                onPress={() => {
                                    setActiveSection('groups');
                                    if (enterprisesPreview) listRef.current?.scrollToOffset({ offset: 0, animated: false });
                                }}
                            >
                                <MaterialCommunityIcons
                                    name="account-group"
                                    size={18}
                                    color={activeSection === 'groups' ? colors.brand.primary : colors.text.secondary}
                                />
                                <Text
                                    style={[styles.sectionTabText, activeSection === 'groups' && styles.sectionTabTextActive]}
                                    numberOfLines={1}
                                    adjustsFontSizeToFit
                                    minimumFontScale={0.8}
                                    maxFontSizeMultiplier={1.1}
                                >
                                    {t('Groups')}
                                </Text>
                            </Pressable>
                        </View>
                        )}

                        {activeSection === 'decide' ? (
                            <DecideSection
                                decisions={decisions}
                                myPoolVoting={myPoolVoting}
                                identity={identity}
                                balanceState={balanceState}
                                onRefresh={loadData}
                                onOpenPropose={() => {
                                    if (proposeRefusal(canProposeDecision, hasOpenDecision)) return;
                                    setShowProposeDecision(true);
                                }}
                                canPropose={canProposeDecision}
                                hasOpenDecision={hasOpenDecision}
                                activeView={activeDecideView}
                                onChangeView={setActiveDecideView}
                                preview={decisionsPreview}
                            />
                        ) : (
                            <View style={{ gap: 12 }}>
                                <View style={{ backgroundColor: colors.surface.subtle, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: colors.border.default }}>
                                    <Text style={{ fontSize: 12, color: colors.text.secondary, lineHeight: 18 }}>
                                        <Sentence
                                            text={kindChips.length > 0
                                                ? t('👥 {label} A group is a place for some people rather than everyone. Projects and enterprises hold Beans; chat groups hold none. Being in a group does not change your trust or your vote.')
                                                : t('👥 {label} A group is a place for some people rather than everyone. Being in a group does not change your trust or your vote.')}
                                            parts={{ label: <Text style={{ fontWeight: '700', color: colors.text.heading }}>{t('Groups:')}</Text> }}
                                        />
                                    </Text>
                                </View>

                                <Text style={styles.groupsHeading}>{inCapitalsOf(t('Your groups'))}</Text>
                                {yourGroupsState === 'loading' && <YourGroupsLoading flush />}
                                {yourGroupsState === 'error' && (
                                    <YourGroupsError message={yourGroupsLive.error || t('Could not load your groups.')} onRetry={yourGroupsLive.refresh} />
                                )}
                                {yourGroupsState === 'list' && (
                                    <View style={{ marginHorizontal: 0 }}>
                                        <YourGroupsRows items={yourGroups} myPubkey={identity?.publicKey} flush />
                                    </View>
                                )}
                                {yourGroupsState === 'empty' && (
                                    <Text style={styles.groupsNone}>{t("You're not in any groups yet. Join one below, or start one with +.")}</Text>
                                )}

                                <Text style={styles.groupsHeading}>{inCapitalsOf(t('Groups you could join'))}</Text>
                                {/* The kind chips (pick 7): one list of projects, enterprises and chat groups. None where the
                                    node has no projects or enterprises: there every group is a chat group. */}
                                {kindChips.length > 0 && (
                                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 4 }} testID="group-kind-chips">
                                    {kindChips.map(option => (
                                        <Pressable
                                            key={option.key}
                                            accessibilityRole="button"
                                            accessibilityState={{ selected: groupKind === option.key }}
                                            style={[styles.filterBtn, groupKind === option.key && styles.filterBtnActive]}
                                            onPress={() => setGroupKind(option.key)}
                                        >
                                            <Text style={[styles.filterBtnText, groupKind === option.key && styles.filterBtnTextActive]}>
                                                {t(option.label)}
                                            </Text>
                                        </Pressable>
                                    ))}
                                </ScrollView>
                                )}
                                {/* The enterprises are the list's own rows below (EnterpriseCard), as on the web's Commons. */}
                            </View>
                        )}
                    </View>
                }
                ListEmptyComponent={
                    activeSection === 'decide' ? null : (loadingGroups || loading) ? (
                        <View style={{ gap: 16 }}>
                            <View style={styles.skeletonCard}>
                                <View style={styles.skeletonLineTitle} />
                                <View style={styles.skeletonLineDesc} />
                            </View>
                            <View style={styles.skeletonCard}>
                                <View style={styles.skeletonLineTitle} />
                                <View style={styles.skeletonLineDesc} />
                            </View>
                        </View>
                    ) : (
                        <View style={styles.emptyState}>
                            <Text style={styles.emptyEmoji}>{groupsEmpty.action === 'project' ? '🌱' : '👥'}</Text>
                            <Text style={styles.emptyTitle}>{t(groupsEmpty.title)}</Text>
                            <Text style={styles.emptyDesc}>{t(groupsEmpty.desc)}</Text>
                            <Pressable
                                accessibilityRole="button"
                                style={styles.emptyBtn}
                                onPress={groupsEmpty.action === 'project' ? openProposeProject : createGroup.open}
                            >
                                <Text style={styles.emptyBtnText}>
                                    {groupsEmpty.action === 'project' ? (groupKind === 'enterprises' ? t('+ Start an enterprise') : t('+ Start a project')) : t('+ Create a Group')}
                                </Text>
                            </Pressable>
                        </View>
                    )
                }
            />
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={activeSection === 'decide' ? t('Propose a decision') : startsProject ? t('Start a project or an enterprise') : t('Create a group')}
                style={styles.fab}
                onPress={async () => {
                    if (startsProject) {
                        await openProposeProject();
                        return;
                    }
                    if (activeSection === 'groups') {
                        createGroup.open();
                        return;
                    }
                    if (decisionsPreview && activeSection === 'decide') {
                        setShowDecisionsSheet(true);
                        return;
                    }
                    const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
                    if (!anchorUrl) {
                        Alert.alert(t('Not Connected'), t('Connect to a community before proposing a decision.'), [
                            { text: t('Cancel'), style: 'cancel' },
                            { text: t('Connect'), onPress: () => router.push({ pathname: '/(tabs)/settings', params: { section: 'advanced' } }) }
                        ]);
                        return;
                    }
                    if (proposeRefusal(canProposeDecision, hasOpenDecision)) return;
                    setShowProposeDecision(true);
                }}
            >
                <MaterialCommunityIcons name="plus" size={30} color={colors.text.inverse} />
            </Pressable>

            <CommonsInfoModal
                isOpen={showCommonsInfo}
                onClose={() => setShowCommonsInfo(false)}
                commonsBalance={balanceState.commons || 0}
            />

            {showsDecide && !decisionsPreview && (
                <ProposeDecisionModal
                    isOpen={showProposeDecision}
                    onClose={() => setShowProposeDecision(false)}
                    onCreated={loadData}
                    identity={identity}
                    commonsBalance={balanceState.commons || 0}
                    treasuries={enterprises}
                    members={membersList}
                />
            )}

            {decisionsPreview && (
                <LocalCommunitySheet
                    feature="decisions"
                    visible={showDecisionsSheet}
                    onClose={() => setShowDecisionsSheet(false)}
                />
            )}

            {createGroup.modal}

            <GroupDetailModal
                group={selectedGroupForDetail}
                isOpen={!!selectedGroupForDetail}
                onClose={() => setSelectedGroupForDetail(null)}
                myPubkey={identity?.publicKey}
                onMembershipChanged={() => loadData()}
                onPostToGroup={(group) => {
                    setSelectedGroupForDetail(null);
                    router.push({
                        pathname: '/group-post',
                        params: {
                            groupId: group.id,
                            groupName: group.name,
                        }
                    });
                }}
            />
        </View>
    );
}
